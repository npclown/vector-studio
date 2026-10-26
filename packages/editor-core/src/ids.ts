import type { IdSource } from './types.js';

/** A deterministic ID source: `${prefix}1`, `${prefix}2`, ... */
export function createCounterIdSource(prefix: string): IdSource {
  let count = 0;
  return () => {
    count += 1;
    return `${prefix}${count}`;
  };
}
