import type { EnvelopeErrorCode, ModelErrorCode } from '@vector-studio/model';

// MVP M5 contract, section 4.2: the adapter's own codes. A store failure carries one of these or
// a code of the model's envelope and document parse.

export const PERSISTENCE_ERROR_CODES = [
  'persistence.unavailable',
  'persistence.read-failed',
  'persistence.write-failed',
] as const;

export type PersistenceErrorCode = (typeof PERSISTENCE_ERROR_CODES)[number];

/** `path` is a JSON Pointer into the envelope text for a model code, else `''`. */
export type StoreFailure = Readonly<{
  ok: false;
  code: PersistenceErrorCode | EnvelopeErrorCode | ModelErrorCode;
  path: string;
}>;
