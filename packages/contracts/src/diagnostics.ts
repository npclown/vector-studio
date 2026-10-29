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
   * A path the renderer cannot mesh, or draws without its fringe: the P3 path mesh failure
   * behavior (docs/requirements.md, "Path rendering failures"; D9 E11-U4 addendum, which
   * replaced the interim code of the P3 V3 contract, section h).
   */
  PATH_MESH_FAILURE: 'render.path-mesh-failure',
  /**
   * Mask levels beyond the mask-texture budget are not drawn (P4 contract, section 4,
   * docs/plans/p4-clip-mask.md); reserved by unit U1, reported from unit U4.
   */
  CLIP_RESOURCE_LIMIT: 'render.clip-resource-limit',
  /**
   * The source draws clips but the renderer came up without its clip pipelines, so clipped and
   * masked content is not drawn (E22 contract, E22-K4, docs/plans/d9-e22-clip-follow-ups-contract.md).
   */
  CLIP_UNAVAILABLE: 'render.clip-unavailable',
  /**
   * The source draws gradient paints but the renderer came up without its paint pipelines, so
   * gradient-painted draws are not drawn (E23 contract, section 4,
   * docs/plans/d9-e23-gradient-paint-contract.md); reserved by unit U1, reported from unit U3.
   */
  PAINT_UNAVAILABLE: 'render.paint-unavailable',
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
