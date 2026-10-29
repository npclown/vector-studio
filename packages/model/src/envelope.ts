import { MAX_DEPTH, scanJson } from './json-scan.js';
import { isValidId, validateAnyDocument, type ModelErrorCode } from './parse.js';
import { orderedDocument } from './serialize.js';
import type { DocumentV3 } from './types.js';

// MVP M5 contract, section 2: the persistence envelope wraps a document beside, not inside, it
// (M5-E1). Its text form has its own version (M5-E2) and embeds the document as an object in the
// key order of `serializeDocument` (M5-E3, M5-Q1 (a)).

/** The `envelopeVersion` of the text form (M5-E2); the in-memory envelope has no version. */
export const ENVELOPE_VERSION = 1;

/** Section 2.1 codes. They are not editor codes: the editor never sees an envelope. */
export const ENVELOPE_ERROR_CODES = [
  'envelope.malformed-json',
  'envelope.unsupported-version',
  'envelope.invalid-field',
  'envelope.unknown-page',
] as const;

export type EnvelopeErrorCode = (typeof ENVELOPE_ERROR_CODES)[number];

export type PersistenceEnvelope = Readonly<{ document: DocumentV3; lastOpenPageId: string }>;

/** `path` is a JSON Pointer (RFC 6901) into the envelope text; `''` is the whole envelope. */
export type EnvelopeResult =
  | Readonly<{ ok: true; envelope: PersistenceEnvelope }>
  | Readonly<{ ok: false; code: EnvelopeErrorCode | ModelErrorCode; path: string }>;

const KEYS = ['envelopeVersion', 'lastOpenPageId', 'document'] as const;

/**
 * Emits the envelope text (M5-E3): `envelopeVersion`, `lastOpenPageId`, `document` in that order,
 * two-space indentation and a final newline. It validates nothing, as `serializeDocument`.
 */
export function serializeEnvelope(envelope: PersistenceEnvelope): string {
  const ordered = {
    envelopeVersion: ENVELOPE_VERSION,
    lastOpenPageId: envelope.lastOpenPageId,
    document: orderedDocument(envelope.document),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Parses envelope text (M5-E4) in the order of section 2.1 and returns the first failure; no
 * partial envelope is ever returned. A v1 or v2 document inside is migrated to v3.
 */
export function parseEnvelope(text: string): EnvelopeResult {
  // (1) JSON.
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: 'envelope.malformed-json', path: '' };
  }
  // (2) A plain object.
  if (!isPlainObject(value)) return { ok: false, code: 'envelope.invalid-field', path: '' };
  // (3) The envelope version: missing or not exactly 1.
  if (value.envelopeVersion !== ENVELOPE_VERSION) {
    return { ok: false, code: 'envelope.unsupported-version', path: '/envelopeVersion' };
  }
  // (4) The scan, one level deeper than a document alone, so a document accepted alone is
  // accepted inside an envelope.
  const finding = scanJson(text, { maxDepth: MAX_DEPTH + 1 });
  if (finding !== null) {
    const path = pointer(finding.path);
    if (finding.path.length >= 2 && finding.path[0] === 'document') {
      const nodeKey =
        finding.kind === 'duplicate-key' &&
        finding.path.length === 3 &&
        finding.path[1] === 'nodes';
      return {
        ok: false,
        code: nodeKey ? 'document.duplicate-id' : 'document.invalid-field',
        path,
      };
    }
    return { ok: false, code: 'envelope.invalid-field', path };
  }
  // (5) Exactly the three keys, a missing key before an unknown one, then the page ID.
  for (const key of KEYS) {
    if (!Object.hasOwn(value, key))
      return { ok: false, code: 'envelope.invalid-field', path: pointer([key]) };
  }
  for (const key of Object.keys(value)) {
    if (!(KEYS as readonly string[]).includes(key)) {
      return { ok: false, code: 'envelope.invalid-field', path: pointer([key]) };
    }
  }
  const lastOpenPageId = value.lastOpenPageId;
  if (!isValidId(lastOpenPageId)) {
    return { ok: false, code: 'envelope.invalid-field', path: '/lastOpenPageId' };
  }
  // (6) The document, v1, v2 or v3, with its path under `/document`.
  const result = validateAnyDocument(value.document);
  if (!result.ok) return { ok: false, code: result.code, path: `/document${result.path}` };
  // (7) The page.
  if (!result.document.pages.some((page) => page.id === lastOpenPageId)) {
    return { ok: false, code: 'envelope.unknown-page', path: '/lastOpenPageId' };
  }
  return { ok: true, envelope: { document: result.document, lastOpenPageId } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function pointer(path: readonly (string | number)[]): string {
  return path
    .map((part) => `/${String(part).replaceAll('~', '~0').replaceAll('/', '~1')}`)
    .join('');
}
