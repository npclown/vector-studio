export const DIAGNOSTIC_CODES = Object.freeze({
  INSECURE_CONTEXT: 'capability.insecure-context',
  API_UNAVAILABLE: 'capability.api-unavailable',
  ADAPTER_UNAVAILABLE: 'capability.adapter-unavailable',
  CANVAS_CONTEXT_UNAVAILABLE: 'capability.canvas-context-unavailable',
  ADAPTER_REQUEST_FAILED: 'initialization.adapter-request-failed',
  DEVICE_REQUEST_FAILED: 'initialization.device-request-failed',
  SURFACE_CONFIGURATION_FAILED: 'initialization.surface-configuration-failed',
  FOUNDATION_SCENE_FAILED: 'initialization.foundation-scene-failed',
  MSAA_FALLBACK: 'capability.msaa-fallback',
  STALE_INITIALIZATION_IGNORED: 'initialization.stale-completion-ignored',
  INITIALIZATION_AFTER_DISPOSE: 'initialization.after-dispose',
  VALIDATION_ERROR: 'validation.uncaptured-error',
  OUT_OF_MEMORY: 'validation.out-of-memory',
  DEVICE_LOST: 'device-loss.detected',
  RECOVERY_STARTED: 'recovery.started',
  RECOVERY_SUCCEEDED: 'recovery.succeeded',
  RECOVERY_FAILED: 'recovery.failed',
  ALLOCATION_FAILED: 'allocation.failed',
  ALLOCATION_ACCOUNTING_ERROR: 'allocation.accounting-error',
  RENDER_SUBMISSION_FAILED: 'render.submission-failed',
  STALE_GENERATION_SKIPPED: 'render.stale-generation-skipped',
  /**
   * D8-interim (P3 V3 contract, section h; extended to path strokes by the B2 stroke contract,
   * section 9.8, and to the joint fill and stroke overlay, `overlay-unsupported`, by the ST-U7
   * addendum); removed or replaced before P3 acceptance.
   */
  PATH_MESH_INTERIM_FAILURE: 'render.path-mesh-interim-failure',
  DISPOSAL_COMPLETED: 'disposal.completed',
  DISPOSAL_FAILED: 'disposal.failed',
} as const);

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[keyof typeof DIAGNOSTIC_CODES];

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export type DiagnosticContextValue = string | number | boolean | null;

export type DiagnosticContext = Readonly<Record<string, DiagnosticContextValue>>;

export interface DiagnosticInput {
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly generation?: number;
  readonly context?: DiagnosticContext;
}

export interface RendererDiagnostic extends DiagnosticInput {
  readonly sequence: number;
  readonly timestampMs: number;
}

export interface Disposable {
  readonly disposed: boolean;
  dispose(): void;
}

export type DiagnosticListener = (diagnostic: RendererDiagnostic) => void;

export interface DiagnosticSource {
  subscribe(listener: DiagnosticListener): Disposable;
}
