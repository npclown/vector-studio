export interface PipelineCacheKey {
  readonly shaderKey: string;
  readonly layoutKey: string;
  readonly vertexLayoutKey: string;
  readonly targetFormat: string;
  readonly renderStateKey: string;
  readonly sampleCount: 1 | 4;
}

export interface PipelineCacheSnapshot {
  readonly generation: number;
  readonly disposed: boolean;
  readonly pendingEntries: number;
  readonly readyEntries: number;
  readonly successfulCreations: number;
}

export interface PipelineCacheOptions<T> {
  readonly release?: (value: T) => void;
}

export type PipelineFactory<T> = (key: PipelineCacheKey, generation: number) => T | Promise<T>;

interface Entry<T> {
  readonly generation: number;
  readonly identity: string;
  readonly key: PipelineCacheKey;
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
  active: boolean;
  state: 'pending' | 'ready';
  value?: T;
  released: boolean;
}

function requireGeneration(generation: number, field: string): void {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new RangeError(`${field} must be a positive safe integer.`);
  }
}

function snapshotKey(key: PipelineCacheKey): PipelineCacheKey {
  if (typeof key !== 'object' || key === null) {
    throw new TypeError('key must be an object.');
  }

  const fields = [
    'shaderKey',
    'layoutKey',
    'vertexLayoutKey',
    'targetFormat',
    'renderStateKey',
  ] as const;
  const copy: Record<(typeof fields)[number], string> = {
    shaderKey: '',
    layoutKey: '',
    vertexLayoutKey: '',
    targetFormat: '',
    renderStateKey: '',
  };

  for (const field of fields) {
    const value = key[field];
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`key.${field} must be a non-empty string.`);
    }
    copy[field] = value;
  }

  if (key.sampleCount !== 1 && key.sampleCount !== 4) {
    throw new RangeError('key.sampleCount must be 1 or 4.');
  }

  return Object.freeze({ ...copy, sampleCount: key.sampleCount });
}

function keyIdentity(key: PipelineCacheKey): string {
  return JSON.stringify([
    key.shaderKey,
    key.layoutKey,
    key.vertexLayoutKey,
    key.targetFormat,
    key.renderStateKey,
    key.sampleCount,
  ]);
}

/** An internal cache for generation-bound, reconstructible pipeline resources. */
export class PipelineCache<T> {
  readonly #release: ((value: T) => void) | undefined;
  readonly #entries = new Map<string, Entry<T>>();
  #generation: number;
  #disposed = false;
  #successfulCreations = 0;

  constructor(generation: number, options: PipelineCacheOptions<T> = {}) {
    requireGeneration(generation, 'generation');
    if (typeof options !== 'object' || options === null) {
      throw new TypeError('options must be an object.');
    }
    if (options.release !== undefined && typeof options.release !== 'function') {
      throw new TypeError('options.release must be a function.');
    }
    this.#release = options.release;

    this.#generation = generation;
  }

  getOrCreate(key: PipelineCacheKey, factory: PipelineFactory<T>): Promise<T> {
    if (this.#disposed) {
      return Promise.reject(new Error('PipelineCache has been disposed.'));
    }
    if (typeof factory !== 'function') {
      throw new TypeError('factory must be a function.');
    }

    const keyCopy = snapshotKey(key);
    const identity = keyIdentity(keyCopy);
    const existing = this.#entries.get(identity);
    if (existing !== undefined) {
      return existing.state === 'ready' ? Promise.resolve(existing.value as T) : existing.promise;
    }

    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const entry: Entry<T> = {
      generation: this.#generation,
      identity,
      key: keyCopy,
      promise,
      resolve,
      reject,
      active: true,
      state: 'pending',
      released: false,
    };
    this.#entries.set(identity, entry);

    queueMicrotask(() => {
      if (!this.#isCurrent(entry)) {
        entry.reject(new Error('Pipeline creation was invalidated before it started.'));
        return;
      }

      let creation: T | Promise<T>;
      try {
        creation = factory(entry.key, entry.generation);
      } catch (error) {
        this.#fail(entry, error);
        return;
      }

      Promise.resolve(creation).then(
        (value) => this.#succeed(entry, value),
        (error: unknown) => this.#fail(entry, error),
      );
    });

    return promise;
  }

  advanceGeneration(nextGeneration: number): void {
    this.#requireActive();
    requireGeneration(nextGeneration, 'nextGeneration');
    if (nextGeneration <= this.#generation) {
      throw new RangeError('nextGeneration must be greater than the current generation.');
    }

    this.#generation = nextGeneration;
    this.#invalidateEntries();
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#invalidateEntries();
  }

  snapshot(): PipelineCacheSnapshot {
    let pendingEntries = 0;
    let readyEntries = 0;
    for (const entry of this.#entries.values()) {
      if (entry.state === 'pending') {
        pendingEntries += 1;
      } else {
        readyEntries += 1;
      }
    }
    return Object.freeze({
      generation: this.#generation,
      disposed: this.#disposed,
      pendingEntries,
      readyEntries,
      successfulCreations: this.#successfulCreations,
    });
  }

  #invalidateEntries(): void {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    for (const entry of entries) {
      entry.active = false;
      if (entry.state === 'ready') {
        this.#releaseEntry(entry, entry.value as T);
      }
    }
  }

  #succeed(entry: Entry<T>, value: T): void {
    this.#successfulCreations += 1;
    if (!this.#isCurrent(entry)) {
      this.#releaseEntry(entry, value);
      entry.reject(new Error('Pipeline creation completed for a stale generation.'));
      return;
    }

    entry.state = 'ready';
    entry.value = value;
    entry.resolve(value);
  }

  #fail(entry: Entry<T>, reason: unknown): void {
    if (this.#entries.get(entry.identity) === entry) {
      this.#entries.delete(entry.identity);
    }
    entry.active = false;
    entry.reject(
      reason instanceof Error ? reason : new Error('Pipeline creation failed.', { cause: reason }),
    );
  }

  #releaseEntry(entry: Entry<T>, value: T): void {
    if (entry.released) {
      return;
    }
    entry.released = true;
    this.#release?.(value);
  }

  #isCurrent(entry: Entry<T>): boolean {
    return (
      !this.#disposed &&
      entry.active &&
      entry.generation === this.#generation &&
      this.#entries.get(entry.identity) === entry
    );
  }

  #requireActive(): void {
    if (this.#disposed) {
      throw new Error('PipelineCache has been disposed.');
    }
  }
}
