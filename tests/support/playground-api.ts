export interface PlaygroundStatistics {
  readonly lifecycle: string;
  readonly generation: number;
  readonly framesSubmitted: number;
  readonly framesPresented: number;
  readonly invalidationsRequested: number;
  readonly pendingFrameCallbacks: number;
  readonly recoveryAttempts: number;
  readonly staleGenerationSubmissions: number;
  readonly diagnosticListeners: number;
  readonly deviceListeners: number;
  readonly pipelinesCreated: number;
  readonly shaderModulesCreated: number;
  readonly mode: 'on-demand' | 'continuous';
  readonly resources: {
    readonly live: number;
    readonly liveBytes: number;
    readonly peakLiveBytes: number;
    readonly byCategory: Readonly<
      Record<
        string,
        {
          readonly live: number;
          readonly liveBytes: number;
          readonly peakLiveBytes: number;
        }
      >
    >;
  };
}

export interface PlaygroundSnapshot {
  readonly backendInstance: number;
  readonly capability: {
    readonly supported: boolean;
    readonly capabilities?: {
      readonly adapter: Record<string, string>;
      readonly limits: Record<string, number>;
      readonly selectedFeatures: readonly string[];
      readonly sampleCount: 1 | 4;
    };
    readonly diagnostic?: { readonly code: string };
  };
  readonly diagnostics: readonly {
    readonly code?: string;
    readonly severity?: string;
    readonly generation?: number;
    readonly timestampMs?: number;
    readonly context?: Record<string, unknown>;
  }[];
  readonly presentationFormat?: string;
  readonly state: string;
  readonly surfaceRevision: number;
  readonly surfaceSize?: {
    readonly devicePixelRatio: number;
    readonly physical: { readonly width: number; readonly height: number };
    readonly suspended: boolean;
  };
  readonly statistics: PlaygroundStatistics;
}

export interface PlaygroundFrameMeasurements {
  readonly active: boolean;
  readonly capacity: number;
  readonly encodeAndSubmitMs: readonly number[];
  readonly frameIntervalsMs: readonly number[];
  readonly droppedSamples: {
    readonly encodeAndSubmitMs: number;
    readonly frameIntervalsMs: number;
  };
  readonly startedAtMs?: number;
  readonly endedAtMs?: number;
}

export interface PlaygroundInitializationTiming {
  readonly timeOrigin: number;
  readonly initializationStartedAtMs: number;
  readonly readyAtMs: number;
  readonly navigationToReadyMs: number;
  readonly initializationToReadyMs: number;
  readonly firstSubmissionAtMs?: number;
  readonly firstSubmissionMs?: number;
  readonly gpuCompletionAtMs?: number;
  readonly gpuCompletionMs?: number;
}

declare global {
  interface Window {
    __p0LongTasks: number[];
    __p0LongTaskObserverAvailable: boolean;
    __vectorStudioP0: {
      dispose(): void;
      destroyDeviceForTesting(): void;
      getFrameMeasurements(): PlaygroundFrameMeasurements;
      getInitializationTiming(): PlaygroundInitializationTiming | undefined;
      invalidate(): void;
      reinitialize(): Promise<unknown>;
      resetFrameMeasurements(): void;
      startFrameMeasurements(capacity?: number): void;
      stopFrameMeasurements(): PlaygroundFrameMeasurements;
      resize(width: number, height: number, devicePixelRatio: number): unknown;
      resizeStorm(): Promise<void>;
      setMode(mode: 'on-demand' | 'continuous'): void;
      snapshot(): PlaygroundSnapshot;
      triggerValidationErrorForTesting(): void;
      waitForInitializationMilestones(): Promise<void>;
      waitForSubmittedWork(): Promise<void>;
    };
  }
}
