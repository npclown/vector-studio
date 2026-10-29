import type { TextLayoutRequest } from '@vector-studio/contracts';
import { SCENE_TEXT_MAX_LANG, SCENE_TEXT_MAX_SIZE } from '@vector-studio/contracts';

// Input checks of the M6a contract (docs/plans/mvp-m6a-text-model-contract.md, sections 2 and 4).

const MAX_FAMILY_LENGTH = 128;
const LANG = new RegExp(`^[A-Za-z0-9-]{1,${SCENE_TEXT_MAX_LANG}}$`, 'u');

/** E28-S1's `lang` syntax, by syntax only (no ICU): 1 to 35 ASCII letters, digits and `-`. */
export function isValidLang(value: unknown): value is string {
  return typeof value === 'string' && LANG.test(value);
}

/**
 * M6a-S3: one family name of 1 to 128 UTF-16 units with no C0 or C1 control (U+0000 to U+001F,
 * U+0080 to U+009F) and no lone surrogate. U+2028, U+2029 and bidi controls are allowed.
 */
export function isValidFamily(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_FAMILY_LENGTH) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x1f || (unit >= 0x80 && unit <= 0x9f)) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const ALIGNS = new Set(['left', 'center', 'right']);

/**
 * Throws `TypeError` for a request no valid text node builds (M6a-L2 covers only those): no runs,
 * a run that is not `{ text, family, size }` with M6a-S3's family and size, a width that is not
 * null or finite and non-negative, an unknown alignment, a non-finite letter spacing or a line
 * height that is not finite and positive.
 */
export function checkRequest(request: TextLayoutRequest): void {
  if (typeof request !== 'object' || request === null) {
    throw new TypeError('text-dom: the request is not an object');
  }
  const { runs, width, align, letterSpacing, lineHeight } = request;
  if (!Array.isArray(runs) || runs.length === 0) throw new TypeError('text-dom: no runs');
  for (const run of runs as readonly unknown[]) {
    if (typeof run !== 'object' || run === null) throw new TypeError('text-dom: invalid run');
    const { text, family, size } = run as Record<string, unknown>;
    if (typeof text !== 'string') throw new TypeError('text-dom: invalid run text');
    if (!isValidFamily(family)) throw new TypeError('text-dom: invalid run family');
    if (typeof size !== 'number' || !(size > 0 && size <= SCENE_TEXT_MAX_SIZE)) {
      throw new TypeError('text-dom: invalid run size');
    }
  }
  if (width !== null && !(typeof width === 'number' && Number.isFinite(width) && width >= 0)) {
    throw new TypeError('text-dom: invalid width');
  }
  if (!ALIGNS.has(align)) throw new TypeError('text-dom: invalid align');
  if (typeof letterSpacing !== 'number' || !Number.isFinite(letterSpacing)) {
    throw new TypeError('text-dom: invalid letter spacing');
  }
  if (typeof lineHeight !== 'number' || !(Number.isFinite(lineHeight) && lineHeight > 0)) {
    throw new TypeError('text-dom: invalid line height');
  }
}
