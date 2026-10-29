// M6a-L3 listeners: run synchronously after each generation increase, in registration order.
// As in `EventTarget` dispatch, a listener unsubscribed during a dispatch is not called later in
// it, and one subscribed during it first runs on the next increase. A listener that throws does
// not stop the others; its error is reported as an uncaught error, as `EventTarget` does.

export interface Listeners {
  /** Adds an entry; one function subscribed twice runs twice. The returned function is idempotent. */
  add(listener: () => void): () => void;
  dispatch(): void;
  clear(): void;
}

export function reportListenerError(error: unknown): void {
  if (typeof globalThis.reportError === 'function') {
    globalThis.reportError(error);
  } else {
    queueMicrotask(() => {
      throw error;
    });
  }
}

export function createListeners(report: (error: unknown) => void = reportListenerError): Listeners {
  let entries: (() => void)[] = [];
  return {
    add(listener) {
      const entry = (): void => listener();
      entries.push(entry);
      return () => {
        const index = entries.indexOf(entry);
        if (index !== -1) entries.splice(index, 1);
      };
    },
    dispatch() {
      for (const entry of [...entries]) {
        if (!entries.includes(entry)) continue;
        try {
          entry();
        } catch (error) {
          report(error);
        }
      }
    },
    clear() {
      entries = [];
    },
  };
}
