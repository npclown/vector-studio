import type { RendererMode } from '@vector-studio/contracts';

export interface AnimationFrameClock {
  request(callback: (timestampMs: number) => void): number;
  cancel(handle: number): void;
}

export interface FrameSchedulerOptions {
  readonly clock?: AnimationFrameClock;
  readonly render: (timestampMs: number) => void;
}

function browserAnimationFrameClock(): AnimationFrameClock {
  const host = globalThis as typeof globalThis & {
    requestAnimationFrame?: (callback: (timestampMs: number) => void) => number;
    cancelAnimationFrame?: (handle: number) => void;
    setTimeout(callback: () => void, delayMs: number): number;
    clearTimeout(handle: number): void;
    performance: { now(): number };
  };
  if (host.requestAnimationFrame === undefined || host.cancelAnimationFrame === undefined) {
    return {
      request: (callback) => host.setTimeout(() => callback(host.performance.now()), 16),
      cancel: (handle) => host.clearTimeout(handle),
    };
  }
  return {
    request: (callback) => host.requestAnimationFrame?.(callback) ?? 0,
    cancel: (handle) => host.cancelAnimationFrame?.(handle),
  };
}

export class FrameScheduler {
  readonly #clock: AnimationFrameClock;
  readonly #render: (timestampMs: number) => void;
  #disposed = false;
  #mode: RendererMode = 'on-demand';
  #pendingHandle: number | undefined;

  constructor(options: FrameSchedulerOptions) {
    this.#clock = options.clock ?? browserAnimationFrameClock();
    this.#render = options.render;
  }

  get mode(): RendererMode {
    return this.#mode;
  }

  get pendingCallbacks(): number {
    return this.#pendingHandle === undefined ? 0 : 1;
  }

  invalidate(): void {
    if (!this.#disposed) {
      this.#schedule();
    }
  }

  setMode(mode: RendererMode): void {
    if (this.#disposed || mode === this.#mode) {
      return;
    }

    this.#mode = mode;
    if (mode === 'continuous') {
      this.#schedule();
    }
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    if (this.#pendingHandle !== undefined) {
      this.#clock.cancel(this.#pendingHandle);
      this.#pendingHandle = undefined;
    }
  }

  #schedule(): void {
    if (this.#pendingHandle !== undefined) {
      return;
    }
    this.#pendingHandle = this.#clock.request((timestampMs) => {
      this.#pendingHandle = undefined;
      if (this.#disposed) {
        return;
      }
      this.#render(timestampMs);
      if (this.#mode === 'continuous') {
        this.#schedule();
      }
    });
  }
}
