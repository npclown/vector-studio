import type { RendererDiagnostic } from './diagnostics.js';
import type { ResourceAccountingSnapshot } from './resources.js';

export const RENDERER_LIFECYCLE_STATES = Object.freeze([
  'idle',
  'initializing',
  'ready',
  'unsupported',
  'lost',
  'recovering',
  'failed',
  'disposed',
] as const);

export type RendererLifecycleState = (typeof RENDERER_LIFECYCLE_STATES)[number];

export interface PixelSize {
  readonly width: number;
  readonly height: number;
}

export interface RendererSurfaceSize {
  readonly css: PixelSize;
  readonly physical: PixelSize;
  readonly devicePixelRatio: number;
  readonly suspended: boolean;
}

export const INVALIDATION_REASONS = Object.freeze([
  'initialization',
  'resize',
  'scene',
  'viewport',
  'interaction',
  'continuous',
  'recovery',
] as const);

export type InvalidationReason = (typeof INVALIDATION_REASONS)[number];

export interface RendererInvalidation {
  readonly reason: InvalidationReason;
  readonly sourceRevision?: number;
}

export type RendererMode = 'on-demand' | 'continuous';

export interface RendererInvalidationTarget {
  invalidate(invalidation: RendererInvalidation): void;
  setMode(mode: RendererMode): void;
}

export interface RendererAdapterInfo {
  readonly name?: string;
  readonly vendor?: string;
  readonly architecture?: string;
  readonly description?: string;
}

export interface RendererCapabilities {
  readonly backend: 'webgpu';
  readonly adapter: RendererAdapterInfo;
  readonly selectedFeatures: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
  readonly sampleCount: 1 | 4;
}

export type RendererCapabilityResult =
  | {
      readonly supported: true;
      readonly capabilities: RendererCapabilities;
    }
  | {
      readonly supported: false;
      readonly diagnostic: RendererDiagnostic;
    };

export interface RendererStatistics {
  readonly lifecycle: RendererLifecycleState;
  readonly generation: number;
  readonly mode: RendererMode;
  readonly invalidationsRequested: number;
  readonly framesSubmitted: number;
  readonly framesPresented: number;
  readonly pendingFrameCallbacks: number;
  readonly shaderModulesCreated: number;
  readonly pipelinesCreated: number;
  readonly resources: ResourceAccountingSnapshot;
}

export interface RendererStatisticsSource {
  getStatistics(): RendererStatistics;
}

export interface RendererLifecycle<Surface> {
  readonly state: RendererLifecycleState;
  readonly generation: number;
  initialize(surface: Surface): Promise<RendererCapabilityResult>;
  dispose(): void;
}
