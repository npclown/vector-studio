import type {
  DiagnosticInput,
  DiagnosticListener,
  DiagnosticSource,
  Disposable,
  RendererDiagnostic,
} from '@vector-studio/contracts';

export type DiagnosticClock = () => number;
export type DiagnosticListenerErrorHandler = (error: unknown) => void;

export interface DiagnosticChannelOptions {
  readonly clock?: DiagnosticClock;
  readonly onListenerError?: DiagnosticListenerErrorHandler;
}

interface SubscriptionState {
  disposed: boolean;
  readonly listener: DiagnosticListener;
}

export class DiagnosticChannel implements DiagnosticSource {
  readonly #clock: DiagnosticClock;
  readonly #subscriptions = new Map<number, SubscriptionState>();
  readonly #onListenerError: DiagnosticListenerErrorHandler;
  #sequence = 0;
  #subscriptionId = 0;

  constructor(options: DiagnosticChannelOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#onListenerError = options.onListenerError ?? (() => undefined);
  }

  subscribe(listener: DiagnosticListener): Disposable {
    const id = this.#subscriptionId;
    const state: SubscriptionState = { disposed: false, listener };
    this.#subscriptionId += 1;
    this.#subscriptions.set(id, state);

    return {
      get disposed() {
        return state.disposed;
      },
      dispose: () => {
        if (state.disposed) {
          return;
        }

        state.disposed = true;
        this.#subscriptions.delete(id);
      },
    };
  }

  emit(input: DiagnosticInput): RendererDiagnostic {
    const { context, ...fields } = input;
    const diagnostic: RendererDiagnostic = Object.freeze({
      ...fields,
      ...(context === undefined ? {} : { context: Object.freeze({ ...context }) }),
      sequence: this.#sequence,
      timestampMs: this.#clock(),
    });
    this.#sequence += 1;

    const listeners = [...this.#subscriptions.values()].map(({ listener }) => listener);
    for (const listener of listeners) {
      try {
        listener(diagnostic);
      } catch (error: unknown) {
        try {
          this.#onListenerError(error);
        } catch {
          // Diagnostic listener failures must not prevent other listeners from receiving the event.
        }
      }
    }

    return diagnostic;
  }

  clear(): void {
    for (const state of this.#subscriptions.values()) {
      state.disposed = true;
    }
    this.#subscriptions.clear();
  }

  get listenerCount(): number {
    return this.#subscriptions.size;
  }
}
