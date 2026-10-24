import {
  DIAGNOSTIC_CODES,
  type DiagnosticCode,
  type DiagnosticContext,
  type DiagnosticListener,
  type Disposable,
  type PixelSize,
  type RendererCapabilities,
  type RendererCapabilityResult,
  type RendererDiagnostic,
  type RendererInvalidation,
  type RendererInvalidationTarget,
  type RendererLifecycle,
  type RendererLifecycleState,
  type RendererStatistics,
  type RendererMode,
  type RendererSurfaceSize,
} from '@vector-studio/contracts';
import {
  DiagnosticChannel,
  FrameScheduler,
  ResourceAccounting,
  pathMeshNoticeDiagnostic,
  type AnimationFrameClock,
  type DiagnosticClock,
  type PathMeshNotice,
  type PrimitiveFrameSource,
  type PrimitiveTarget,
} from '@vector-studio/renderer-core';

import { CaptureError } from './frame-capture.js';
import { TestHookCreationError } from './native-primitive-scene.js';
import { computeSurfaceSize } from './surface-size.js';
import {
  FoundationExperiment,
  type FoundationFixture,
  type FoundationBindingSource,
  type FoundationExperimentSnapshot,
} from './foundation-experiment.js';
import {
  createBrowserWebGpuPlatform,
  type WebGpuCanvasContextPort,
  type WebGpuDevicePort,
  type WebGpuDeviceError,
  type WebGpuDeviceLoss,
  type WebGpuFoundationScenePort,
  type WebGpuFoundationSceneCreationPort,
  type WebGpuPlatform,
  type WebGpuPrimitiveSceneCreationPort,
  type WebGpuPrimitiveScenePort,
  type WebGpuSceneCaptureForTesting,
} from './webgpu-platform.js';

export interface WebGpuSurface {
  readonly canvas: HTMLCanvasElement;
  readonly cssSize: PixelSize;
  readonly devicePixelRatio: number;
}

export interface WebGpuBackendOptions {
  readonly animationFrameClock?: AnimationFrameClock;
  readonly clock?: DiagnosticClock;
  readonly now?: () => number;
  readonly platform?: WebGpuPlatform;
  readonly foundationFixture?: FoundationFixture;
  /**
   * @internal Tests only (E10 contract, section 3.2): a forced sample count for the primitive
   * scene. 4 fails initialization when 4x is unavailable; it never falls back.
   */
  readonly sampleCountForTesting?: 1 | 4;
  /** @internal Tests only (E10 contract, section 3.2): COPY_SRC on the canvas and captures. */
  readonly frameCaptureForTesting?: boolean;
  /** @internal Tests only (E10 contract, section 5): count pipelines; needs frame capture. */
  readonly countPassForTesting?: boolean;
}

/** @internal Tests only (E10 contract, section 3.2): one captured frame. */
export interface WebGpuFrameCaptureForTesting extends WebGpuSceneCaptureForTesting {
  readonly devicePixelRatio: number;
  /** The backend's framesSubmitted statistic after this frame. */
  readonly framesSubmitted: number;
}

/** @internal Tests only (E10 contract, section 3.2). */
export interface WebGpuFrameCaptureOptionsForTesting {
  readonly counts?: boolean;
  /** From arming to encoding; default 5,000 ms. */
  readonly timeoutMs?: number;
}

interface ArmedCapture {
  readonly counts: boolean;
  readonly generation: number;
  readonly resolve: (capture: WebGpuFrameCaptureForTesting) => void;
  readonly reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  handed: boolean;
  /** Set once the captured frame is counted; 0 until then. */
  framesSubmitted: number;
  /** The surface DPR when the capture was encoded. */
  devicePixelRatio: number;
}

export interface WebGpuFrameMeasurements {
  readonly active: boolean;
  readonly capacity: number;
  readonly encodeAndSubmitMs: readonly number[];
  readonly frameIntervalsMs: readonly number[];
  readonly droppedSamples: Readonly<{
    encodeAndSubmitMs: number;
    frameIntervalsMs: number;
  }>;
  readonly startedAtMs?: number;
  readonly endedAtMs?: number;
}

const DEFAULT_MEASUREMENT_CAPACITY = 4096;
const DEFAULT_CAPTURE_TIMEOUT_MS = 5000;
/** E10 contract, section 3.2: the canvas usage that a frame capture needs. */
const CAPTURE_CANVAS_USAGE = 0x10 | 0x01;
const COPY_SOURCE_USAGE = 0x01;
/** A packet carries at most this many path mesh failure notices (P3 V3 contract, section h). */
const NOTICES_PER_PACKET = 32;

/** An array check that does not narrow a typed value to any[]. */
function isList(value: unknown): boolean {
  return Array.isArray(value);
}

/** A test hook's creation failure carries its section 3.2 context (E10 contract). */
function hookErrorContext(error: unknown): DiagnosticContext {
  return error instanceof TestHookCreationError
    ? Object.freeze({ ...error.context })
    : errorContext(error);
}

function errorContext(error: unknown): DiagnosticContext {
  if (error instanceof Error) {
    return Object.freeze({ errorName: error.name, errorMessage: error.message });
  }
  return Object.freeze({ errorMessage: String(error) });
}

export class WebGpuBackend implements RendererLifecycle<WebGpuSurface>, RendererInvalidationTarget {
  readonly #diagnostics: DiagnosticChannel;
  readonly #platform: WebGpuPlatform;
  readonly #resources = new ResourceAccounting();
  readonly #scheduler: FrameScheduler;
  readonly #now: () => number;
  readonly #foundationFixture: FoundationFixture | undefined;
  #primitiveFrameSource: PrimitiveFrameSource | undefined;
  /** P3 V3 section f: read once when the source is attached, before any device exists. */
  #meshPipelineRequired = false;
  #primitiveMode = false;
  #primitiveCreation: WebGpuPrimitiveSceneCreationPort | undefined;
  #primitiveScene: WebGpuPrimitiveScenePort | undefined;
  #capabilityResult: RendererCapabilityResult | undefined;
  #canvas: HTMLCanvasElement | undefined;
  #context: WebGpuCanvasContextPort | undefined;
  #device: WebGpuDevicePort | undefined;
  #deviceErrorSubscription: Disposable | undefined;
  #experiment: FoundationExperiment | undefined;
  #foundationCreation: WebGpuFoundationSceneCreationPort | undefined;
  #foundationBinding: FoundationBindingSource | undefined;
  #pendingAttemptRelease: (() => void) | undefined;
  #scene: WebGpuFoundationScenePort | undefined;
  #invalidationsRequested = 0;
  #framesSubmitted = 0;
  #framesPresented = 0;
  #shaderModulesCreated = 0;
  #pipelinesCreated = 0;
  #recoveryAttempts = 0;
  #staleGenerationSubmissions = 0;
  #measurementActive = false;
  #measurementCapacity = DEFAULT_MEASUREMENT_CAPACITY;
  #measurementStartedAtMs: number | undefined;
  #measurementEndedAtMs: number | undefined;
  #encodeAndSubmitMs: number[] = [];
  #frameIntervalsMs: number[] = [];
  #droppedEncodeAndSubmitSamples = 0;
  #droppedFrameIntervalSamples = 0;
  #lastFrameTimestampMs: number | undefined;
  #generation = 0;
  #initialization: Promise<RendererCapabilityResult> | undefined;
  #terminalRecoveryResult: RendererCapabilityResult | undefined;
  #operationToken = 0;
  #presentationFormat: string | undefined;
  #state: RendererLifecycleState = 'idle';
  #surfaceRevision = 0;
  #surfaceSize: RendererSurfaceSize | undefined;
  readonly #sampleCountForTesting: 1 | 4 | undefined;
  readonly #frameCapture: boolean;
  readonly #countPass: boolean;
  #capture: ArmedCapture | undefined;

  constructor(options: WebGpuBackendOptions = {}) {
    if (
      options.foundationFixture !== undefined &&
      options.foundationFixture !== 'camera-triangle-v1'
    ) {
      throw new RangeError(`Unsupported foundation fixture: ${String(options.foundationFixture)}.`);
    }
    this.#diagnostics = new DiagnosticChannel(
      options.clock === undefined ? {} : { clock: options.clock },
    );
    this.#platform = options.platform ?? createBrowserWebGpuPlatform();
    this.#foundationFixture = options.foundationFixture;
    this.#now = options.now ?? (() => performance.now());
    const forced = options.sampleCountForTesting;
    if (forced !== undefined && forced !== 1 && forced !== 4) {
      throw new RangeError('sampleCountForTesting must be 1 or 4.');
    }
    this.#sampleCountForTesting = forced;
    this.#frameCapture = options.frameCaptureForTesting === true;
    this.#countPass = options.countPassForTesting === true;
    if (this.#countPass && !this.#frameCapture) {
      throw new RangeError('countPassForTesting needs frameCaptureForTesting.');
    }
    this.#scheduler = new FrameScheduler({
      ...(options.animationFrameClock === undefined ? {} : { clock: options.animationFrameClock }),
      render: (timestampMs) => this.#render(timestampMs),
    });
  }

  get state(): RendererLifecycleState {
    return this.#state;
  }

  get generation(): number {
    return this.#generation;
  }

  get capabilityResult(): RendererCapabilityResult | undefined {
    return this.#capabilityResult;
  }

  get presentationFormat(): string | undefined {
    return this.#presentationFormat;
  }

  get surfaceRevision(): number {
    return this.#surfaceRevision;
  }

  get surfaceSize(): RendererSurfaceSize | undefined {
    return this.#surfaceSize;
  }

  getFoundationExperimentSnapshot(): FoundationExperimentSnapshot | undefined {
    return this.#experiment?.snapshot();
  }

  subscribeDiagnostics(listener: DiagnosticListener): Disposable {
    return this.#diagnostics.subscribe(listener);
  }

  attachPrimitiveFrameSource(source: PrimitiveFrameSource): Disposable {
    if (this.#state !== 'idle') {
      throw new Error('A primitive frame source must be attached before initialization.');
    }
    if (this.#primitiveFrameSource !== undefined) {
      throw new Error('A primitive frame source is already attached.');
    }
    this.#primitiveFrameSource = source;
    this.#meshPipelineRequired = source.requiresMeshPipeline === true;
    let disposed = false;
    return {
      get disposed() {
        return disposed;
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.#primitiveFrameSource === source) {
          this.#primitiveFrameSource = undefined;
          this.#meshPipelineRequired = false;
        }
      },
    };
  }

  initialize(surface: WebGpuSurface): Promise<RendererCapabilityResult> {
    if (this.#state === 'disposed') {
      return Promise.resolve(
        this.#failure(
          DIAGNOSTIC_CODES.INITIALIZATION_AFTER_DISPOSE,
          'Initialization was requested after disposal.',
          'error',
          this.#generation,
        ),
      );
    }
    if (this.#state === 'ready' && this.#capabilityResult) {
      return Promise.resolve(this.#capabilityResult);
    }
    if (this.#terminalRecoveryResult) {
      return Promise.resolve(this.#terminalRecoveryResult);
    }
    if (this.#initialization) {
      return this.#initialization;
    }

    this.#state = 'initializing';
    this.#primitiveMode = this.#primitiveFrameSource !== undefined;
    const token = ++this.#operationToken;
    const generation = this.#generation + 1;
    const initialization = this.#initializeAttempt(surface, token, generation);
    this.#initialization = initialization;
    void initialization.then(() => {
      if (this.#initialization === initialization) {
        this.#initialization = undefined;
      }
    });
    return initialization;
  }

  resize(cssSize: PixelSize, devicePixelRatio: number): RendererSurfaceSize {
    if (this.#state !== 'ready' || !this.#canvas || !this.#surfaceSize) {
      throw new Error('The backend must be ready before resize.');
    }

    const maxDimension = this.#capabilityResult?.supported
      ? this.#capabilityResult.capabilities.limits.maxTextureDimension2D
      : undefined;
    if (maxDimension === undefined) {
      throw new Error('The device did not report maxTextureDimension2D.');
    }

    const previousRevision = this.#surfaceRevision;
    const size = this.#applySurfaceSize(this.#canvas, cssSize, devicePixelRatio, maxDimension);
    if (this.#surfaceRevision !== previousRevision) {
      this.#resizeScene(size.physical);
      this.invalidate({ reason: 'resize', sourceRevision: this.#surfaceRevision });
    }
    return size;
  }

  invalidate(invalidation: RendererInvalidation): void {
    void invalidation;
    if (this.#state !== 'ready') {
      return;
    }
    this.#invalidationsRequested += 1;
    this.#scheduler.invalidate();
  }

  setMode(mode: RendererMode): void {
    this.#scheduler.setMode(mode);
  }

  triggerValidationErrorForTesting(): void {
    if (this.#state !== 'ready' || !this.#device) {
      throw new Error('The backend must be ready before triggering a validation error.');
    }
    this.#device.triggerValidationErrorForTesting();
  }

  destroyDeviceForTesting(): void {
    if (this.#state !== 'ready' || !this.#device) {
      throw new Error('The backend must be ready before destroying the device.');
    }
    this.#device.destroy();
  }

  /**
   * @internal Tests only (E10 contract, section 4): arms one capture and invalidates. The next
   * render copies the presented texture, and with counts the count pass, in its own submission.
   */
  captureFrameForTesting(
    options: WebGpuFrameCaptureOptionsForTesting = {},
  ): Promise<WebGpuFrameCaptureForTesting> {
    const counts = options.counts === true;
    const fail = (code: string, detail: string) =>
      Promise.reject<WebGpuFrameCaptureForTesting>(new CaptureError(code, detail));
    if (!this.#frameCapture || (counts && !this.#countPass)) {
      return fail('capture-disabled', 'the backend was created without the capture options');
    }
    if (this.#state === 'disposed') return fail('disposed', 'the backend is disposed');
    if (this.#capture !== undefined) return fail('capture-pending', 'a capture is armed');
    if (this.#state !== 'ready') return fail('not-ready', `the backend is ${this.#state}`);
    if (!this.#primitiveMode) return fail('foundation-mode', 'no primitive scene');
    if (this.#primitiveScene?.captureNextSubmissionForTesting === undefined) {
      return fail('capture-unsupported', 'the scene port cannot capture');
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
    return new Promise<WebGpuFrameCaptureForTesting>((resolve, reject) => {
      const armed: ArmedCapture = {
        counts,
        generation: this.#generation,
        resolve,
        reject,
        timer: undefined,
        handed: false,
        framesSubmitted: 0,
        devicePixelRatio: 1,
      };
      armed.timer = setTimeout(
        () =>
          this.#settleCapture(
            armed,
            new CaptureError('timeout', `no render encoded the capture in ${timeoutMs} ms`),
          ),
        timeoutMs,
      );
      this.#capture = armed;
      this.invalidate({ reason: 'scene' });
    });
  }

  #settleCapture(armed: ArmedCapture, result: Error | WebGpuFrameCaptureForTesting): void {
    if (this.#capture !== armed) return;
    this.#capture = undefined;
    if (armed.timer !== undefined) clearTimeout(armed.timer);
    if (result instanceof Error) armed.reject(result);
    else armed.resolve(result);
  }

  waitForSubmittedWork(): Promise<void> {
    if (this.#state !== 'ready' || !this.#device) {
      return Promise.reject(new Error('The backend must be ready before waiting for GPU work.'));
    }
    return this.#device.waitForSubmittedWork();
  }

  startFrameMeasurements(capacity = DEFAULT_MEASUREMENT_CAPACITY): void {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError('Measurement capacity must be a positive safe integer.');
    }
    this.#resetFrameMeasurementState();
    this.#measurementCapacity = capacity;
    this.#measurementActive = true;
    this.#measurementStartedAtMs = this.#now();
  }

  stopFrameMeasurements(): WebGpuFrameMeasurements {
    if (this.#measurementActive) {
      this.#measurementActive = false;
      this.#measurementEndedAtMs = this.#now();
      this.#lastFrameTimestampMs = undefined;
    }
    return this.getFrameMeasurements();
  }

  resetFrameMeasurements(): void {
    this.#resetFrameMeasurementState();
  }

  #resetFrameMeasurementState(): void {
    this.#measurementActive = false;
    this.#measurementCapacity = DEFAULT_MEASUREMENT_CAPACITY;
    this.#measurementStartedAtMs = undefined;
    this.#measurementEndedAtMs = undefined;
    this.#encodeAndSubmitMs = [];
    this.#frameIntervalsMs = [];
    this.#droppedEncodeAndSubmitSamples = 0;
    this.#droppedFrameIntervalSamples = 0;
    this.#lastFrameTimestampMs = undefined;
  }

  getFrameMeasurements(): WebGpuFrameMeasurements {
    return Object.freeze({
      active: this.#measurementActive,
      capacity: this.#measurementCapacity,
      encodeAndSubmitMs: Object.freeze([...this.#encodeAndSubmitMs]),
      frameIntervalsMs: Object.freeze([...this.#frameIntervalsMs]),
      droppedSamples: Object.freeze({
        encodeAndSubmitMs: this.#droppedEncodeAndSubmitSamples,
        frameIntervalsMs: this.#droppedFrameIntervalSamples,
      }),
      ...(this.#measurementStartedAtMs === undefined
        ? {}
        : { startedAtMs: this.#measurementStartedAtMs }),
      ...(this.#measurementEndedAtMs === undefined
        ? {}
        : { endedAtMs: this.#measurementEndedAtMs }),
    });
  }

  getStatistics(): RendererStatistics {
    return Object.freeze({
      lifecycle: this.#state,
      generation: this.#generation,
      mode: this.#scheduler.mode,
      invalidationsRequested: this.#invalidationsRequested,
      framesSubmitted: this.#framesSubmitted,
      framesPresented: this.#framesPresented,
      pendingFrameCallbacks: this.#scheduler.pendingCallbacks,
      recoveryAttempts: this.#recoveryAttempts,
      staleGenerationSubmissions: this.#staleGenerationSubmissions,
      diagnosticListeners: this.#diagnostics.listenerCount,
      deviceListeners: this.#deviceErrorSubscription?.disposed === false ? 2 : 0,
      shaderModulesCreated: this.#shaderModulesCreated,
      pipelinesCreated: this.#pipelinesCreated,
      resources: this.#resources.snapshot(),
    });
  }

  dispose(): void {
    if (this.#state === 'disposed') {
      return;
    }

    this.#operationToken += 1;
    this.#state = 'disposed';
    this.#scheduler.dispose();

    const pendingAttemptRelease = this.#pendingAttemptRelease;
    this.#pendingAttemptRelease = undefined;
    pendingAttemptRelease?.();
    this.#releaseDeviceGeneration(true);
    this.#experiment?.dispose();

    this.#context = undefined;
    this.#canvas = undefined;
    this.#surfaceSize = undefined;
    this.#presentationFormat = undefined;
    this.#capabilityResult = undefined;
    this.#primitiveFrameSource = undefined;
    this.#resetFrameMeasurementState();
    this.#resources.clear();
    this.#emit(
      DIAGNOSTIC_CODES.DISPOSAL_COMPLETED,
      'WebGPU backend disposal completed.',
      'info',
      this.#generation,
    );
    this.#diagnostics.clear();
  }

  async #initializeAttempt(
    surface: WebGpuSurface,
    token: number,
    generation: number,
    scheduleInitialFrame = true,
  ): Promise<RendererCapabilityResult> {
    if (!this.#platform.secureContext) {
      return this.#unsupported(
        DIAGNOSTIC_CODES.INSECURE_CONTEXT,
        'WebGPU requires a secure context.',
        token,
        generation,
      );
    }
    if (!this.#platform.apiAvailable) {
      return this.#unsupported(
        DIAGNOSTIC_CODES.API_UNAVAILABLE,
        'The WebGPU API is unavailable.',
        token,
        generation,
      );
    }

    let context: WebGpuCanvasContextPort | null;
    try {
      context = this.#platform.getCanvasContext(surface.canvas);
    } catch (error: unknown) {
      return this.#failed(
        DIAGNOSTIC_CODES.SURFACE_CONFIGURATION_FAILED,
        'The canvas context request failed.',
        token,
        generation,
        errorContext(error),
      );
    }
    if (!context) {
      return this.#unsupported(
        DIAGNOSTIC_CODES.CANVAS_CONTEXT_UNAVAILABLE,
        'The canvas did not provide a WebGPU context.',
        token,
        generation,
      );
    }

    let adapter;
    try {
      adapter = await this.#platform.requestAdapter();
    } catch (error: unknown) {
      return this.#failed(
        DIAGNOSTIC_CODES.ADAPTER_REQUEST_FAILED,
        'The WebGPU adapter request failed.',
        token,
        generation,
        errorContext(error),
      );
    }
    if (!this.#isCurrent(token)) {
      return this.#stale(generation);
    }
    if (!adapter) {
      return this.#unsupported(
        DIAGNOSTIC_CODES.ADAPTER_UNAVAILABLE,
        'No WebGPU adapter is available.',
        token,
        generation,
      );
    }

    let device: WebGpuDevicePort;
    try {
      device = await adapter.requestDevice();
    } catch (error: unknown) {
      return this.#failed(
        DIAGNOSTIC_CODES.DEVICE_REQUEST_FAILED,
        'The WebGPU device request failed.',
        token,
        generation,
        errorContext(error),
      );
    }
    if (!this.#isCurrent(token)) {
      device.destroy();
      return this.#stale(generation);
    }

    const maxTextureDimension2D = device.limits.maxTextureDimension2D;
    if (maxTextureDimension2D === undefined) {
      device.destroy();
      return this.#failed(
        DIAGNOSTIC_CODES.DEVICE_REQUEST_FAILED,
        'The device did not expose maxTextureDimension2D.',
        token,
        generation,
      );
    }

    let creation: WebGpuFoundationSceneCreationPort | undefined;
    let primitiveCreation: WebGpuPrimitiveSceneCreationPort | undefined;
    let binding: FoundationBindingSource | undefined;
    let contextConfigured = false;
    let attemptReleased = false;
    const releaseAttempt = () => {
      if (attemptReleased) return;
      attemptReleased = true;
      const actions: readonly (() => void)[] = [
        () => creation?.dispose(),
        () => primitiveCreation?.dispose(),
        () => binding?.detach(),
        ...(contextConfigured ? [() => context.unconfigure()] : []),
        () => device.destroy(),
      ];
      for (const action of actions) {
        try {
          action();
        } catch (releaseError: unknown) {
          this.#emit(
            DIAGNOSTIC_CODES.DISPOSAL_FAILED,
            'A pending WebGPU initialization resource failed during release.',
            'error',
            generation,
            errorContext(releaseError),
          );
        }
      }
    };
    this.#pendingAttemptRelease = releaseAttempt;

    let format: string;
    try {
      format = this.#platform.getPreferredCanvasFormat();
      this.#applySurfaceSize(
        surface.canvas,
        surface.cssSize,
        surface.devicePixelRatio,
        maxTextureDimension2D,
      );
      contextConfigured = true;
      context.configure({
        device,
        format,
        alphaMode: 'premultiplied',
        ...(this.#frameCapture ? { usage: CAPTURE_CANVAS_USAGE } : {}),
      });
      // E10 contract, section 3.2: a platform that drops the usage is refused, never copied.
      if (this.#frameCapture && ((context.configuredUsage ?? 0) & COPY_SOURCE_USAGE) === 0) {
        throw new TestHookCreationError('The canvas was configured without COPY_SRC.', {
          captureUsage: 'missing',
        });
      }
    } catch (error: unknown) {
      releaseAttempt();
      if (this.#pendingAttemptRelease === releaseAttempt) this.#pendingAttemptRelease = undefined;
      if (!this.#isCurrent(token)) return this.#stale(generation);
      return this.#failed(
        DIAGNOSTIC_CODES.SURFACE_CONFIGURATION_FAILED,
        'The WebGPU canvas configuration failed.',
        token,
        generation,
        hookErrorContext(error),
      );
    }
    if (!this.#isCurrent(token)) {
      releaseAttempt();
      if (this.#pendingAttemptRelease === releaseAttempt) this.#pendingAttemptRelease = undefined;
      return this.#stale(generation);
    }

    let foundation;
    let primitive;
    try {
      if (!this.#primitiveMode) {
        const experiment =
          this.#experiment ?? new FoundationExperiment(generation, this.#foundationFixture);
        if (this.#experiment === undefined) {
          this.#experiment = experiment;
        }
        const size = this.#surfaceSize;
        if (size === undefined) {
          throw new Error('The foundation surface size is unavailable.');
        }
        binding = experiment.createBinding(generation, size.physical, size.devicePixelRatio);
        creation = device.createFoundationScene(format, binding);
        foundation = await creation.result;
        binding.creationSettled();
      } else {
        if (
          (format !== 'bgra8unorm' && format !== 'rgba8unorm') ||
          device.createPrimitiveScene === undefined
        ) {
          throw new Error('The device cannot create the required primitive scene.');
        }
        const tracker = {
          track: (id: string, descriptor: Parameters<ResourceAccounting['track']>[1]) => {
            this.#resources.track(id, descriptor);
          },
          release: (id: string) => {
            this.#resources.release(id);
          },
        };
        // The mesh pipeline is requested only for a source that sets requiresMeshPipeline.
        const hooks = {
          ...(this.#sampleCountForTesting === undefined
            ? {}
            : { sampleCount: this.#sampleCountForTesting }),
          ...(this.#countPass && this.#meshPipelineRequired ? { countPass: true } : {}),
        };
        primitiveCreation =
          this.#meshPipelineRequired || Object.keys(hooks).length > 0
            ? device.createPrimitiveScene(context, format, generation, tracker, {
                ...(this.#meshPipelineRequired ? { meshPipeline: true } : {}),
                ...hooks,
              })
            : device.createPrimitiveScene(context, format, generation, tracker);
        primitive = await primitiveCreation.result;
        // E10 contract, section 3.2: under a backend hook, a missing mesh path fails the
        // generation instead of drawing primitives only.
        if (
          this.#hooksSet() &&
          this.#meshPipelineRequired &&
          primitive.scene.meshPipelineAvailable !== true
        ) {
          throw new TestHookCreationError('The mesh pipeline is unavailable.', {
            meshPipeline: 'unavailable',
          });
        }
      }
    } catch (error: unknown) {
      binding?.creationSettled();
      releaseAttempt();
      if (this.#pendingAttemptRelease === releaseAttempt) this.#pendingAttemptRelease = undefined;
      if (!this.#isCurrent(token)) return this.#stale(generation);
      this.#abortExperimentAttempt(generation);
      return this.#failed(
        DIAGNOSTIC_CODES.FOUNDATION_SCENE_FAILED,
        'The WebGPU render scene could not be created.',
        token,
        generation,
        hookErrorContext(error),
      );
    }
    if (!this.#isCurrent(token)) {
      releaseAttempt();
      if (this.#pendingAttemptRelease === releaseAttempt) this.#pendingAttemptRelease = undefined;
      return this.#stale(generation);
    }

    try {
      if (primitive !== undefined) {
        this.#primitiveCreation = primitiveCreation;
        this.#primitiveScene = primitive.scene;
        this.#setPrimitiveTarget(primitive.scene, generation, format);
        this.#shaderModulesCreated += primitive.scene.shaderModulesCreated;
        this.#pipelinesCreated += primitive.scene.pipelinesCreated;
      } else if (foundation !== undefined) {
        this.#foundationCreation = creation;
        this.#scene = foundation.scene;
        this.#foundationBinding = binding;
        this.#resizeScene(this.#surfaceSize?.physical ?? { width: 0, height: 0 });
        this.#shaderModulesCreated += foundation.scene.shaderModulesCreated;
        this.#pipelinesCreated += foundation.scene.pipelinesCreated;
        for (const resource of foundation.scene.staticResources) {
          this.#resources.track(`${generation}/${resource.id}`, resource.descriptor);
        }
      } else {
        throw new Error('Render scene creation returned no scene.');
      }
    } catch (error: unknown) {
      releaseAttempt();
      this.#scene = undefined;
      this.#primitiveScene = undefined;
      if (this.#primitiveCreation === primitiveCreation) this.#primitiveCreation = undefined;
      this.#foundationBinding = undefined;
      if (this.#foundationCreation === creation) this.#foundationCreation = undefined;
      if (this.#pendingAttemptRelease === releaseAttempt) this.#pendingAttemptRelease = undefined;
      if (!this.#isCurrent(token)) return this.#stale(generation);
      this.#abortExperimentAttempt(generation);
      this.#resources.clear();
      return this.#failed(
        DIAGNOSTIC_CODES.ALLOCATION_FAILED,
        'The WebGPU foundation resources could not be allocated.',
        token,
        generation,
        errorContext(error),
      );
    }
    const fellBackFrom4x = foundation?.fellBackFrom4x ?? primitive?.fellBackFrom4x ?? false;
    if (fellBackFrom4x) {
      this.#emit(
        DIAGNOSTIC_CODES.MSAA_FALLBACK,
        '4x MSAA was unavailable; the render scene uses 1x sampling.',
        'warning',
        generation,
        Object.freeze({ requestedSampleCount: 4, selectedSampleCount: 1 }),
      );
      if (!this.#isCurrent(token)) {
        releaseAttempt();
        if (this.#pendingAttemptRelease === releaseAttempt) {
          this.#pendingAttemptRelease = undefined;
        }
        return this.#stale(generation);
      }
    }

    if (
      primitive !== undefined &&
      this.#meshPipelineRequired &&
      primitive.scene.meshPipelineAvailable !== true
    ) {
      // P3 V3 section f: once per generation, outside the notice queue and its caps.
      this.#diagnostics.emit(
        pathMeshNoticeDiagnostic(
          Object.freeze({
            nodeId: null,
            failureScope: 'renderer',
            failureCode: 'mesh-pipeline-unavailable',
            toleranceExponent: null,
            // B2 stroke contract, section 9.8: this renderer-wide code carries no paint.
            paint: null,
          }),
          generation,
        ),
      );
      if (!this.#isCurrent(token)) {
        releaseAttempt();
        if (this.#pendingAttemptRelease === releaseAttempt) {
          this.#pendingAttemptRelease = undefined;
        }
        return this.#stale(generation);
      }
    }

    const capabilities: RendererCapabilities = Object.freeze({
      backend: 'webgpu',
      adapter: Object.freeze({ ...adapter.info }),
      selectedFeatures: Object.freeze([...device.features]),
      limits: Object.freeze({ ...device.limits }),
      sampleCount: primitive?.scene.sampleCount ?? foundation?.scene.sampleCount ?? 1,
    });
    const result: RendererCapabilityResult = Object.freeze({ supported: true, capabilities });

    if (this.#pendingAttemptRelease === releaseAttempt) this.#pendingAttemptRelease = undefined;
    this.#canvas = surface.canvas;
    this.#context = context;
    this.#device = device;
    this.#generation = generation;
    this.#presentationFormat = format;
    this.#capabilityResult = result;
    this.#state = 'ready';
    this.#attachDeviceObservers(device, generation);
    if (scheduleInitialFrame) {
      this.invalidate({ reason: 'initialization' });
    }
    return result;
  }

  #attachDeviceObservers(device: WebGpuDevicePort, generation: number): void {
    this.#deviceErrorSubscription?.dispose();
    this.#deviceErrorSubscription = device.subscribeErrors((error) =>
      this.#handleDeviceError(device, generation, error),
    );
    void device.lost.then((loss) => this.#handleDeviceLoss(device, generation, loss));
  }

  #handleDeviceError(device: WebGpuDevicePort, generation: number, error: WebGpuDeviceError): void {
    if (this.#state !== 'ready' || this.#device !== device || this.#generation !== generation) {
      return;
    }
    const code =
      error.type === 'validation'
        ? DIAGNOSTIC_CODES.VALIDATION_ERROR
        : error.type === 'out-of-memory'
          ? DIAGNOSTIC_CODES.OUT_OF_MEMORY
          : DIAGNOSTIC_CODES.RENDER_SUBMISSION_FAILED;
    this.#emit(code, 'An uncaptured WebGPU device error occurred.', 'error', generation, {
      errorType: error.type,
      errorMessage: error.message,
    });
  }

  async #handleDeviceLoss(
    device: WebGpuDevicePort,
    lostGeneration: number,
    loss: WebGpuDeviceLoss,
  ): Promise<void> {
    if (this.#state !== 'ready' || this.#device !== device || this.#generation !== lostGeneration) {
      return;
    }

    this.#scheduler.setActive(false);
    this.#state = 'lost';
    const token = ++this.#operationToken;
    let resolveRecovery!: (result: RendererCapabilityResult) => void;
    const recovery = new Promise<RendererCapabilityResult>((resolve) => {
      resolveRecovery = resolve;
    });
    this.#initialization = recovery;
    const canvas = this.#canvas;
    const surfaceSize = this.#surfaceSize;
    this.#emit(
      DIAGNOSTIC_CODES.DEVICE_LOST,
      'The active WebGPU device was lost.',
      'error',
      lostGeneration,
      { reason: loss.reason, message: loss.message },
    );

    if (!this.#isCurrent(token)) {
      resolveRecovery(this.#stale(lostGeneration + 1));
      if (this.#initialization === recovery) this.#initialization = undefined;
      return;
    }

    this.#releaseDeviceGeneration(false);
    if (!this.#isCurrent(token)) {
      resolveRecovery(this.#stale(lostGeneration + 1));
      if (this.#initialization === recovery) this.#initialization = undefined;
      return;
    }
    if (!canvas || !surfaceSize) {
      this.#state = 'failed';
      const diagnostic = this.#emit(
        DIAGNOSTIC_CODES.RECOVERY_FAILED,
        'WebGPU device recovery failed because the surface was unavailable.',
        'error',
        lostGeneration + 1,
      );
      const result = Object.freeze({ supported: false as const, diagnostic });
      if (!this.#isCurrent(token)) {
        resolveRecovery(this.#stale(lostGeneration + 1));
        if (this.#initialization === recovery) this.#initialization = undefined;
        return;
      }
      this.#terminalRecoveryResult = result;
      resolveRecovery(result);
      if (this.#initialization === recovery) this.#initialization = undefined;
      return;
    }

    const recoveryGeneration = lostGeneration + 1;
    try {
      this.#experiment?.advanceGeneration(recoveryGeneration);
    } catch (error: unknown) {
      this.#state = 'failed';
      const diagnostic = this.#emit(
        DIAGNOSTIC_CODES.RECOVERY_FAILED,
        'WebGPU device recovery could not advance foundation ownership.',
        'error',
        recoveryGeneration,
        errorContext(error),
      );
      const result = Object.freeze({ supported: false as const, diagnostic });
      if (!this.#isCurrent(token)) {
        resolveRecovery(this.#stale(recoveryGeneration));
        if (this.#initialization === recovery) this.#initialization = undefined;
        return;
      }
      this.#terminalRecoveryResult = result;
      resolveRecovery(result);
      if (this.#initialization === recovery) this.#initialization = undefined;
      return;
    }
    this.#generation = recoveryGeneration;
    this.#state = 'recovering';
    this.#recoveryAttempts += 1;
    this.#emit(
      DIAGNOSTIC_CODES.RECOVERY_STARTED,
      'WebGPU device recovery started.',
      'info',
      recoveryGeneration,
      { lostGeneration },
    );

    if (!this.#isCurrent(token)) {
      resolveRecovery(this.#stale(recoveryGeneration));
      if (this.#initialization === recovery) this.#initialization = undefined;
      return;
    }

    const attempt = this.#initializeAttempt(
      {
        canvas,
        cssSize: surfaceSize.css,
        devicePixelRatio: surfaceSize.devicePixelRatio,
      },
      token,
      recoveryGeneration,
      false,
    );
    const result = await attempt;
    if (!this.#isCurrent(token)) {
      resolveRecovery(result);
      if (this.#initialization === recovery) this.#initialization = undefined;
      return;
    }
    if (!result.supported || !this.#isReady()) {
      this.#state = 'failed';
      this.#emit(
        DIAGNOSTIC_CODES.RECOVERY_FAILED,
        'WebGPU device recovery failed.',
        'error',
        recoveryGeneration,
        result.supported ? undefined : { diagnosticCode: result.diagnostic.code },
      );
      this.#terminalRecoveryResult = result;
      resolveRecovery(result);
      if (this.#initialization === recovery) this.#initialization = undefined;
      return;
    }

    this.#scheduler.setActive(true);
    this.#emit(
      DIAGNOSTIC_CODES.RECOVERY_SUCCEEDED,
      'WebGPU device recovery succeeded.',
      'info',
      recoveryGeneration,
      { lostGeneration },
    );
    this.invalidate({ reason: 'recovery' });
    resolveRecovery(result);
    if (this.#initialization === recovery) this.#initialization = undefined;
  }

  #abortExperimentAttempt(generation: number): void {
    const experiment = this.#experiment;
    if (experiment === undefined || this.#state === 'disposed') return;
    try {
      experiment.abortAttempt(generation);
    } catch (error: unknown) {
      this.#emit(
        DIAGNOSTIC_CODES.DISPOSAL_FAILED,
        'An aborted foundation attempt could not reset its device-local cache.',
        'error',
        generation,
        errorContext(error),
      );
    }
  }

  #releaseDeviceGeneration(destroyDevice: boolean): void {
    this.#deviceErrorSubscription?.dispose();
    this.#deviceErrorSubscription = undefined;
    const creation = this.#foundationCreation;
    const primitiveCreation = this.#primitiveCreation;
    const scene = this.#scene;
    const primitiveScene = this.#primitiveScene;
    const binding = this.#foundationBinding;
    this.#foundationCreation = undefined;
    this.#primitiveCreation = undefined;
    this.#scene = undefined;
    this.#primitiveScene = undefined;
    this.#foundationBinding = undefined;
    const actions: readonly (() => void)[] = [
      () => (creation === undefined ? scene?.dispose() : creation.dispose()),
      () =>
        primitiveCreation === undefined ? primitiveScene?.dispose() : primitiveCreation.dispose(),
      () => binding?.detach(),
      () => this.#context?.unconfigure(),
      ...(destroyDevice ? [() => this.#device?.destroy()] : []),
    ];
    for (const action of actions) {
      try {
        action();
      } catch (error: unknown) {
        this.#emit(
          DIAGNOSTIC_CODES.DISPOSAL_FAILED,
          'A WebGPU resource failed during release.',
          'error',
          this.#generation,
          errorContext(error),
        );
      }
    }
    this.#context = undefined;
    this.#device = undefined;
    this.#capabilityResult = undefined;
    this.#presentationFormat = undefined;
    this.#resources.clear();
    // E10 contract, section 4: after the scene released a submitted capture's objects, a capture
    // still pending settles with the reason its generation ended.
    if (this.#capture !== undefined) {
      this.#settleCapture(
        this.#capture,
        this.#state === 'disposed'
          ? new CaptureError('disposed', 'the backend was disposed')
          : new CaptureError('device-lost', 'the generation ended'),
      );
    }
  }

  #isReady(): boolean {
    return this.#state === 'ready';
  }

  #hooksSet(): boolean {
    return this.#sampleCountForTesting !== undefined || this.#frameCapture;
  }

  #render(timestampMs: number): void {
    // E10 contract, section 4: every render after arming settles a capture it did not submit.
    const armed = this.#capture !== undefined && !this.#capture.handed ? this.#capture : undefined;
    if (armed !== undefined && armed.generation !== this.#generation) {
      this.#settleCapture(armed, new CaptureError('device-lost', 'the generation changed'));
      return this.#renderFrame(timestampMs, undefined);
    }
    this.#renderFrame(timestampMs, armed);
    if (armed !== undefined && !armed.handed) {
      this.#settleCapture(armed, new CaptureError('no-submission', 'the render did not submit'));
    }
  }

  #renderFrame(timestampMs: number, armed: ArmedCapture | undefined): void {
    if (
      this.#state !== 'ready' ||
      (!this.#scene && !this.#primitiveScene) ||
      !this.#context ||
      this.#surfaceSize?.suspended !== false
    ) {
      return;
    }

    if (this.#measurementActive) {
      if (this.#lastFrameTimestampMs !== undefined) {
        if (this.#frameIntervalsMs.length < this.#measurementCapacity) {
          this.#frameIntervalsMs.push(timestampMs - this.#lastFrameTimestampMs);
        } else {
          this.#droppedFrameIntervalSamples += 1;
        }
      }
      this.#lastFrameTimestampMs = timestampMs;
    }

    const startedMs = this.#now();
    try {
      if (this.#primitiveScene !== undefined) {
        const scene = this.#primitiveScene;
        const source = this.#primitiveFrameSource;
        const generation = this.#generation;
        if (source === undefined) return;
        const target = this.#primitiveTarget();
        scene.setTarget(target);
        let packet;
        try {
          packet = source.prepare(target);
        } catch (error: unknown) {
          this.#emit(
            DIAGNOSTIC_CODES.RENDER_SUBMISSION_FAILED,
            'Primitive packet preparation failed.',
            'error',
            this.#generation,
            errorContext(error),
          );
          return;
        }
        if (packet === null) return;
        // P3 V3 section h: notices describe CPU state, so they are emitted right after a
        // non-null prepare, before the generation and submission checks.
        this.#emitPathMeshNotices(packet.mesh?.notices, generation);
        if (
          this.#state !== 'ready' ||
          this.#primitiveScene !== scene ||
          this.#primitiveFrameSource !== source ||
          this.#generation !== generation
        ) {
          return;
        }
        if (armed !== undefined) this.#handCapture(scene, armed);
        const submission = scene.submitPrimitivePacket(packet);
        if (submission.status !== 'submitted') {
          this.#reportPrimitiveSubmission(submission);
          return;
        }
        if (
          this.#state !== 'ready' ||
          this.#primitiveScene !== scene ||
          this.#primitiveFrameSource !== source ||
          this.#generation !== generation
        ) {
          return;
        }
        source.acknowledge(submission.receipt);
      } else {
        this.#scene?.render(this.#context);
      }
      this.#framesSubmitted += 1;
      this.#framesPresented += 1;
      if (armed?.handed === true) armed.framesSubmitted = this.#framesSubmitted;
      if (this.#measurementActive) {
        if (this.#encodeAndSubmitMs.length < this.#measurementCapacity) {
          this.#encodeAndSubmitMs.push(this.#now() - startedMs);
        } else {
          this.#droppedEncodeAndSubmitSamples += 1;
        }
      }
    } catch (error: unknown) {
      this.#emit(
        DIAGNOSTIC_CODES.RENDER_SUBMISSION_FAILED,
        'The foundation frame submission failed.',
        'error',
        this.#generation,
        errorContext(error),
      );
    }
  }

  #handCapture(scene: WebGpuPrimitiveScenePort, armed: ArmedCapture): void {
    armed.handed = true;
    scene.captureNextSubmissionForTesting!({
      counts: armed.counts,
      encoded: () => {
        if (armed.timer !== undefined) clearTimeout(armed.timer);
        armed.timer = undefined;
        armed.devicePixelRatio = this.#surfaceSize?.devicePixelRatio ?? 1;
      },
      resolve: (capture) => {
        if (capture.generation !== this.#generation || this.#state !== 'ready') {
          this.#settleCapture(armed, new CaptureError('device-lost', 'the generation changed'));
          return;
        }
        if (armed.framesSubmitted === 0) {
          // The submission went through but the render failed before counting the frame.
          this.#settleCapture(
            armed,
            new CaptureError('no-submission', 'the frame was not counted'),
          );
          return;
        }
        this.#settleCapture(
          armed,
          Object.freeze({
            ...capture,
            devicePixelRatio: armed.devicePixelRatio,
            framesSubmitted: armed.framesSubmitted,
          }),
        );
      },
      reject: (error) =>
        this.#settleCapture(
          armed,
          // A scene disposed by a device loss reports the loss.
          this.#state === 'lost' || armed.generation !== this.#generation
            ? new CaptureError('device-lost', error.message)
            : error,
        ),
    });
  }

  #emitPathMeshNotices(notices: readonly PathMeshNotice[] | undefined, generation: number): void {
    if (notices === undefined || !isList(notices)) return;
    for (const notice of notices.slice(0, NOTICES_PER_PACKET)) {
      this.#diagnostics.emit(pathMeshNoticeDiagnostic(notice, generation));
    }
  }

  #resizeScene(size: PixelSize): void {
    if (this.#primitiveScene !== undefined) {
      if (this.#presentationFormat === undefined) {
        throw new Error('Primitive target format is unavailable.');
      }
      this.#setPrimitiveTarget(this.#primitiveScene, this.#generation, this.#presentationFormat);
      return;
    }
    if (!this.#scene) {
      return;
    }
    this.#resources.release('foundation-attachment');
    this.#scene.resize(size, this.#surfaceSize?.devicePixelRatio ?? 1);
    if (this.#scene.attachmentBytes > 0 && size.width > 0 && size.height > 0) {
      this.#resources.track('foundation-attachment', {
        category: 'texture',
        dimension: '2d',
        width: size.width,
        height: size.height,
        depthOrArrayLayers: 1,
        mipLevelCount: 1,
        sampleCount: this.#scene.sampleCount,
        bytesPerTexel: 4,
      });
    }
  }

  #primitiveTarget(): PrimitiveTarget {
    const size = this.#surfaceSize;
    const format = this.#presentationFormat;
    const scene = this.#primitiveScene;
    if (
      size === undefined ||
      format === undefined ||
      scene === undefined ||
      (format !== 'bgra8unorm' && format !== 'rgba8unorm')
    ) {
      throw new Error('Primitive target metadata is unavailable.');
    }
    return Object.freeze({
      generation: this.#generation,
      surfaceRevision: this.#surfaceRevision,
      width: size.physical.width,
      height: size.physical.height,
      devicePixelRatio: size.devicePixelRatio,
      sampleCount: scene.sampleCount,
      targetFormat: format,
    });
  }

  #setPrimitiveTarget(scene: WebGpuPrimitiveScenePort, generation: number, format: string): void {
    const size = this.#surfaceSize;
    if (size === undefined || (format !== 'bgra8unorm' && format !== 'rgba8unorm')) {
      throw new Error('Primitive target metadata is unavailable.');
    }
    scene.setTarget(
      Object.freeze({
        generation,
        surfaceRevision: this.#surfaceRevision,
        width: size.physical.width,
        height: size.physical.height,
        devicePixelRatio: size.devicePixelRatio,
        sampleCount: scene.sampleCount,
        targetFormat: format,
      }),
    );
  }

  #reportPrimitiveSubmission(
    result: Exclude<
      ReturnType<WebGpuPrimitiveScenePort['submitPrimitivePacket']>,
      { status: 'submitted' }
    >,
  ): void {
    if (result.status === 'not-ready') return;
    if (result.status === 'stale-generation') {
      this.#staleGenerationSubmissions += 1;
      this.#emit(
        DIAGNOSTIC_CODES.STALE_GENERATION_SKIPPED,
        'A stale primitive packet was skipped.',
        'warning',
        this.#generation,
      );
      return;
    }
    if (result.status !== 'failed') return;
    const code =
      result.reason === 'allocation-failed'
        ? DIAGNOSTIC_CODES.ALLOCATION_FAILED
        : DIAGNOSTIC_CODES.RENDER_SUBMISSION_FAILED;
    this.#emit(code, 'Primitive packet submission failed.', 'error', this.#generation, {
      reason: result.reason,
    });
  }

  #applySurfaceSize(
    canvas: HTMLCanvasElement,
    cssSize: PixelSize,
    devicePixelRatio: number,
    maxTextureDimension2D: number,
  ): RendererSurfaceSize {
    const size = computeSurfaceSize(cssSize, devicePixelRatio, maxTextureDimension2D);
    const previous = this.#surfaceSize;
    const changed =
      previous === undefined ||
      previous.physical.width !== size.physical.width ||
      previous.physical.height !== size.physical.height ||
      previous.devicePixelRatio !== size.devicePixelRatio ||
      previous.css.width !== size.css.width ||
      previous.css.height !== size.css.height;

    if (changed) {
      canvas.width = size.physical.width;
      canvas.height = size.physical.height;
      this.#surfaceRevision += 1;
    }
    this.#surfaceSize = size;
    return size;
  }

  #isCurrent(token: number): boolean {
    return this.#state !== 'disposed' && this.#operationToken === token;
  }

  #unsupported(
    code: DiagnosticCode,
    message: string,
    token: number,
    generation: number,
  ): RendererCapabilityResult {
    const result = this.#failure(code, message, 'error', generation);
    if (this.#isCurrent(token)) {
      this.#state = 'unsupported';
      this.#capabilityResult = result;
    }
    return result;
  }

  #failed(
    code: DiagnosticCode,
    message: string,
    token: number,
    generation: number,
    context?: DiagnosticContext,
  ): RendererCapabilityResult {
    const result = this.#failure(code, message, 'error', generation, context);
    if (this.#isCurrent(token)) {
      this.#state = 'failed';
      this.#capabilityResult = result;
    }
    return result;
  }

  #stale(generation: number): RendererCapabilityResult {
    return this.#failure(
      DIAGNOSTIC_CODES.STALE_INITIALIZATION_IGNORED,
      'A stale initialization completion was ignored.',
      'warning',
      generation,
    );
  }

  #failure(
    code: DiagnosticCode,
    message: string,
    severity: 'warning' | 'error',
    generation: number,
    context?: DiagnosticContext,
  ): RendererCapabilityResult {
    return Object.freeze({
      supported: false,
      diagnostic: this.#emit(code, message, severity, generation, context),
    });
  }

  #emit(
    code: DiagnosticCode,
    message: string,
    severity: 'info' | 'warning' | 'error',
    generation: number,
    context?: DiagnosticContext,
  ): RendererDiagnostic {
    return this.#diagnostics.emit({
      code,
      message,
      severity,
      generation,
      ...(context === undefined ? {} : { context }),
    });
  }
}
