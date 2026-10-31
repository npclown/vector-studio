import { isValidLang } from './validate.js';

// The styles text-dom measures with (docs/plans/mvp-m6a-text-model-contract.md, section 4, with
// the M6a-U4 amendments), in one place: the measurement block (measure.ts) and its run spans
// (tree.ts) are built from these declarations, and `referenceStyle` returns them for a DOM
// reference that must paint what text-dom measures (MVP M6c contract, section 6.1, M6c-Q6 (a):
// the placed DOM cluster and the flowed DOM block of the agreement spec). DOM-only: the port's
// interface is unchanged.

/** CSS declarations as `[property, value]` pairs, in the order they are set. */
export type StyleDeclarations = readonly (readonly [property: string, value: string])[];

const freeze = (declarations: (readonly [string, string])[]): StyleDeclarations =>
  Object.freeze(declarations.map((declaration) => Object.freeze(declaration)));

/**
 * The block's own declarations after `all: initial` and `display: block`: it resets every
 * inherited property but `direction` and `unicode-bidi`, which are set explicitly. `font-size: 0`
 * is the zero-size strut (M6a-Q2): sizes, letter spacing and line height are set on the run spans.
 * The block is laid out start-aligned; text-dom applies M6a-L1's alignment itself. Disclosed
 * (M6c-U3, contract U3 notes): in Chromium `all: initial` also resets `-webkit-locale`, the style
 * the block's `lang` attribute sets, and the run spans' `unicode-bidi: bidi-override` drops a
 * locale's `locl` forms as well, so text-dom shapes with the font's default forms, while the
 * canvas glyph raster port draws each cluster with the context's `lang`. Kept as M6a measures.
 */
const BLOCK_TYPOGRAPHY: readonly (readonly [string, string])[] = [
  ['direction', 'ltr'],
  ['unicode-bidi', 'isolate'],
  ['white-space', 'pre-wrap'],
  ['word-break', 'keep-all'],
  ['overflow-wrap', 'anywhere'],
  ['hyphens', 'none'],
  ['font-variant-ligatures', 'none'],
  ['text-spacing-trim', 'space-all'],
  ['text-autospace', 'no-autospace'],
  ['text-align', 'left'],
  ['font-size', '0'],
];

/** The block a reference paints in: the measurement block, visible. */
const REFERENCE_BLOCK = freeze([['all', 'initial'], ['display', 'block'], ...BLOCK_TYPOGRAPHY]);

/** The measurement block: the reference block, hidden. */
export const MEASUREMENT_BLOCK_DECLARATIONS: StyleDeclarations = freeze([
  ['all', 'initial'],
  ['display', 'block'],
  ['visibility', 'hidden'],
  ...BLOCK_TYPOGRAPHY,
]);

/**
 * The measurement host's own reset, first in its style: `all: initial`, so nothing the page sets
 * reaches the block by inheritance. A reference host takes it too.
 */
export const HOST_RESET: StyleDeclarations = freeze([['all', 'initial']]);

/**
 * Added to a run span that holds text between LFs (an LF's own span goes without, M6a-U4 review
 * r1 S2).
 */
export const TEXT_DECLARATIONS: StyleDeclarations = freeze([
  ['direction', 'ltr'],
  ['unicode-bidi', 'bidi-override'],
]);

/** One run's measured style: its font list (M6-F2) at a size in px, and the node's spacing. */
export type RunStyle = Readonly<{
  fontList: string;
  /** In px, as laid out. */
  size: number;
  /** In em (M6a-S2). */
  letterSpacing: number;
  /** Unitless, a multiple of the size. */
  lineHeight: number;
}>;

/** A run span's declarations: font list, size, letter spacing and line height. */
export function runDeclarations(style: RunStyle): StyleDeclarations {
  return freeze([
    ['font-family', style.fontList],
    ['font-size', `${style.size}px`],
    ['letter-spacing', `${style.letterSpacing}em`],
    ['line-height', String(style.lineHeight)],
  ]);
}

/** `declarations` as a `style` attribute value, `property: value` joined by `; `. */
export function cssText(declarations: StyleDeclarations): string {
  return declarations.map(([property, value]) => `${property}: ${value}`).join('; ');
}

export type ReferenceStyleInput = RunStyle &
  Readonly<{
    /** The layout's `lang` (BCP 47 by E28-S1's syntax), set as the block's `lang` attribute. */
    lang: string;
  }>;

/**
 * M6c-Q6 (a): what a DOM reference sets to paint one run as text-dom measures it. `host` is the
 * reset of the element the block's shadow root hangs from (`all: initial`, first; the caller adds
 * its own position and size), `block` the measurement block's declarations without `visibility:
 * hidden` (`all: initial` first; the caller adds its own position, width and paint), `lang` the
 * block's `lang` attribute (set as text-dom sets it; see `BLOCK_TYPOGRAPHY` on its effect), `run` a
 * run span's declarations at `size`, and `text` those of a span that holds text between LFs (`run`
 * plus `direction: ltr; unicode-bidi: bidi-override`). The run tree puts every span directly in
 * the block, an LF in a span of its own with `run`. Throws `TypeError` for a style no measurement
 * could have used.
 */
export type ReferenceStyle = Readonly<{
  lang: string;
  host: StyleDeclarations;
  block: StyleDeclarations;
  run: StyleDeclarations;
  text: StyleDeclarations;
}>;

export function referenceStyle(input: ReferenceStyleInput): ReferenceStyle {
  if (!isValidLang(input.lang)) throw new TypeError('text-dom: invalid lang');
  if (typeof input.fontList !== 'string' || input.fontList.length === 0) {
    throw new TypeError('text-dom: empty font list');
  }
  if (!(Number.isFinite(input.size) && input.size > 0)) {
    throw new TypeError('text-dom: size is not a positive finite number');
  }
  if (!Number.isFinite(input.letterSpacing)) {
    throw new TypeError('text-dom: letter spacing is not finite');
  }
  if (!(Number.isFinite(input.lineHeight) && input.lineHeight > 0)) {
    throw new TypeError('text-dom: line height is not a positive finite number');
  }
  const run = runDeclarations(input);
  return Object.freeze({
    lang: input.lang,
    host: HOST_RESET,
    block: REFERENCE_BLOCK,
    run,
    text: freeze([...run, ...TEXT_DECLARATIONS]),
  });
}
