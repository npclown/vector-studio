export interface PlaygroundStatistics {
  readonly framesSubmitted: number;
  readonly framesPresented: number;
  readonly invalidationsRequested: number;
  readonly pendingFrameCallbacks: number;
  readonly pipelinesCreated: number;
  readonly shaderModulesCreated: number;
  readonly mode: 'on-demand' | 'continuous';
  readonly resources: { readonly peakLiveBytes: number };
}

export interface PlaygroundSnapshot {
  readonly capability: {
    readonly supported: boolean;
    readonly capabilities?: {
      readonly adapter: Record<string, string>;
      readonly limits: Record<string, number>;
      readonly sampleCount: 1 | 4;
    };
    readonly diagnostic?: { readonly code: string };
  };
  readonly diagnostics: readonly { readonly severity?: string }[];
  readonly presentationFormat?: string;
  readonly state: string;
  readonly surfaceRevision: number;
  readonly surfaceSize?: {
    readonly physical: { readonly width: number; readonly height: number };
    readonly suspended: boolean;
  };
  readonly statistics: PlaygroundStatistics;
}

declare global {
  interface Window {
    __p0LongTasks: number[];
    __vectorStudioP0: {
      dispose(): void;
      getFrameMeasurements(): {
        readonly encodeAndSubmitMs: readonly number[];
        readonly frameIntervalsMs: readonly number[];
      };
      invalidate(): void;
      resetFrameMeasurements(): void;
      resize(width: number, height: number, devicePixelRatio: number): unknown;
      setMode(mode: 'on-demand' | 'continuous'): void;
      snapshot(): PlaygroundSnapshot;
    };
  }
}
