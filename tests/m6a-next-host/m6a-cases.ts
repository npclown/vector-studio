import type { TextLayoutRequest, TextLayoutRun } from '@vector-studio/contracts';

// M6a-U6: the layout requests of the headed spec. Every run names the committed test font
// (`Noto Sans KR`, registered by `?fixture=text`) or `SECOND`, the same file registered again
// under another family by the spec, so the structure is the same on every machine; scripts the
// subset does not map (Hebrew, emoji, U+200B) take a fallback face (U5 note 2). The (a) to (g)
// groups are the M6a-U4 review r3 carry list (contract section 16), taken from the U4 review
// probe scripts; the (U4b) group checks line detection by baseline (M6a-U4b, review N1) with
// `TALL`; the others are A11's fixtures.

export const FAMILY = 'Noto Sans KR';
/** The test font registered again under another family, for runs split across families. */
export const SECOND = 'M6a Second';
/**
 * The test font registered once more by the spec with `ascentOverride` `TALL_ASCENT`, so its runs
 * have another ascent than `FAMILY`'s at the same size (M6a-U4b review N1), on every machine.
 */
export const TALL = 'M6a Tall';
export const TALL_ASCENT = '80%';

export const run = (text: string, size = 20, family = FAMILY): TextLayoutRun => ({
  text,
  family,
  size,
});

export const request = (
  runs: readonly TextLayoutRun[],
  extra: Partial<Omit<TextLayoutRequest, 'runs'>> = {},
): TextLayoutRequest => ({
  runs,
  width: null,
  align: 'left',
  letterSpacing: 0,
  lineHeight: 1.2,
  ...extra,
});

/** A 40-unit grapheme with a surrogate pair across unit 32 (M6a-A05), then `b`. */
export const GRAPHEME_40 = `a${'\u0301'.repeat(30)}\u{1d167}${'\u0301'.repeat(7)}`;
/** A 70-unit grapheme: pieces of 32, 32 and 6 units. */
export const GRAPHEME_70 = `a${'\u0301'.repeat(69)}`;
/** M6a-A05's emoji: a ZWJ family, a modifier, a flag and a presentation form. */
export const EMOJI =
  '\u{1f469}\u200d\u{1f469}\u200d\u{1f467}\u{1f44d}\u{1f3fd}\u{1f1f0}\u{1f1f7}\u2764\ufe0f';
/** CJK punctuation around Hangul and Latin, for `text-spacing-trim` and `text-autospace`. */
export const CJK_PUNCTUATION = '「한글」、가。a가（나）';

export type Case = Readonly<{
  name: string;
  request: TextLayoutRequest;
}>;

const c = (
  name: string,
  runs: readonly TextLayoutRun[],
  extra: Partial<Omit<TextLayoutRequest, 'runs'>> = {},
): Case => ({ name, request: request(runs, extra) });

/** A11's fixtures. */
export const A11_CASES: readonly Case[] = [
  c('one line', [run('Hello world')]),
  c('soft wrap', [run('Hello wonderful world of text layout')], { width: 120 }),
  c('Hangul keep-all wrap', [run('한글 편집기 벡터 안녕하세요')], { width: 90 }),
  // M6-S0's `mixed-sizes` (docs/evidence/m6-s0/ink-boxes.mjs) in the test font.
  c('mixed sizes (M6-S0)', [run('Ab', 24), run('한글', 40), run('xy', 16)]),
  c('empty text', [run('')]),
  c('final LF (sentinel)', [run('ab\n')]),
  c('empty middle line', [run('a\n\nb')]),
  c('lineHeight 0.5', [run('line one two three four')], { width: 60, lineHeight: 0.5 }),
  c('CJK punctuation', [run(CJK_PUNCTUATION)]),
  c('RTL', [run('abc אבג def')]),
  c('40-unit grapheme', [run(`${GRAPHEME_40}b`)]),
  c('70-unit grapheme', [run(GRAPHEME_70)]),
  c('emoji ZWJ sequences', [run(EMOJI)]),
  c('right aligned', [run('ab cd ef')], { width: 50, align: 'right' }),
  c('centred', [run('ab cd ef')], { width: 50, align: 'center' }),
  c('negative letter spacing', [run('abc')], { letterSpacing: -0.8 }),
  // M6c-U3 review r2: a node of Common characters only is measured without the bidi override
  // (M6a-L1 amendment, 2026-10-31), so runs may shape across their boundary; A11 checks it.
  c('Common only, mixed sizes', [run('3.14 ', 20), run('100%', 40)]),
  c('Common only, letter spacing', [run('3.14 ', 20), run('100%', 20)], { letterSpacing: 0.3 }),
];

/** The M6a-U4 review r3 carry list, (a) to (e) and (g); (f) and (h) are tests of their own. */
export const CARRY_CASES: readonly Case[] = [
  // (a) soft wraps on a run boundary, both directions.
  c('(a) small then big', [run('aaaa bbbb ', 10), run('CCCC', 40)], { width: 60 }),
  c('(a) big then small', [run('CC ', 40), run('aaaaaaaa', 10)], { width: 70 }),
  c('(a) three runs', [run('aaaa ', 10), run('bbbb ', 20), run('CCCC', 40)], { width: 40 }),
  c('(a) run end space', [run('aaaa', 10), run(' bbbb', 10, SECOND)], { width: 30 }),
  // (b) one-grapheme lines.
  c('(b) width 0', [run('abcd')], { width: 0 }),
  c('(b) width 1', [run('abcd')], { width: 1 }),
  c('(b) narrow CJK', [run('가나다라마바')], { width: 25 }),
  c('(b) two runs at width 0', [run('ab', 10), run('CD', 40)], { width: 0 }),
  c('(b) two per line', [run('abcdef')], { width: 26 }),
  c('(b) LF at width 0', [run('ab\ncdef')], { width: 0 }),
  c('(b) runs and LF at width 0', [run('aa', 10), run('bb\ncc', 40), run('dd', 10)], {
    width: 0,
  }),
  // (c) mixed-size LF cases.
  c('(c) LF ending a big run', [run('a\n', 40), run('b', 10)]),
  c('(c) LF ending a big run, width 200', [run('a\n', 40), run('b', 10)], { width: 200 }),
  c('(c) LF starting a small run', [run('a', 40), run('\nb', 10)]),
  c('(c) title and wrapped body', [run('Title\n', 40), run('body text here wraps around', 12)], {
    width: 80,
  }),
  c('(c) empty middle line, mixed', [run('a\n', 10), run('\n', 40), run('b', 10)]),
  c('(c) two LFs in a big run', [run('a', 10), run('\n\n', 40), run('b', 10)]),
  c('(c) final LF in a big run', [run('ab', 10), run('\n', 40)]),
  c('(c) LFs in big runs', [run('x', 10), run('\n', 40), run('y', 10), run('\n', 40)]),
  c('(c) LF run then wrap', [run('aaaa bbbb', 10), run('\ncccc', 40)], { width: 30 }),
  c(
    '(c) LF inside a wrapped big run',
    [run('aaaa ', 10), run('bbbb\n', 40), run('cccc dddd', 10)],
    {
      width: 30,
    },
  ),
  c('(c) LF only', [run('\n')]),
  c('(c) spaces before LF, right', [run('aaaa   \nbb')], { width: 50, align: 'right' }),
  // (d) the pen anchor at run starts under negative letter spacing.
  c('(d) anchor', [run('ii', 40), run('ii', 40, SECOND)], { letterSpacing: -0.5 }),
  c('(d) anchor, LF in the second run', [run('ii', 40), run('ii\nii', 40, SECOND)], {
    letterSpacing: -0.5,
  }),
  c('(d) anchor, LF in the first run', [run('a\nii', 40), run('ii', 40, SECOND)], {
    letterSpacing: -0.5,
  }),
  c('(d) anchor, LF in both runs', [run('ii\nii', 40), run('ii\nii', 40, SECOND)], {
    letterSpacing: -0.5,
  }),
  c('(d) anchor, wrapped', [run('ii ii', 40), run('ii ii', 40, SECOND)], {
    letterSpacing: -0.5,
    width: 5,
  }),
  c('(d) one-cluster negative run', [run('i', 40), run('ab', 10)], { letterSpacing: -0.5 }),
  // A disclosed fallback until M6a-U4b (U4 note 4, superseded): now compared in full.
  c('(d) mixed sizes at -1 em', [run('il', 40), run('ab', 10)], { letterSpacing: -1 }),
  // (e) RTL across split spans.
  c('(e) RTL run broken by an LF', [run('אב\nגד', 20), run('הו', 30)]),
  c('(e) RTL over two runs', [run('אב', 20), run('גד', 30)]),
  c('(e) mixed RTL, LF and wrap', [run('abc אב', 20), run('גד\nef', 30)], { width: 60 }),
  // (g) low lineHeight pitches.
  c('(g) lineHeight 0.1', [run('aaaa bbbb cccc dddd')], { width: 50, lineHeight: 0.1 }),
  c('(g) lineHeight 0.3', [run('aaaa bbbb cccc dddd')], { width: 50, lineHeight: 0.3 }),
  c('(g) lineHeight 0.5', [run('aaaa bbbb cccc dddd')], { width: 50, lineHeight: 0.5 }),
  // (U4b) two families of one size with other ascents (review N1): one line shares a baseline,
  // and at width 0 each line starts at the previous line's left.
  c('(U4b) other ascents on one line', [run('ab'), run('cd', 20, TALL), run('ef')]),
  c('(U4b) other ascents at width 0', [run('ab'), run('cd', 20, TALL), run('ef')], { width: 0 }),
  c('(U4b) other ascents and sizes, wrapped', [run('ab cd', 40, TALL), run(' ef gh', 10)], {
    width: 60,
  }),
];

/** Every case laid out at each DPR and checked for size linearity (A12). */
export const A12_CASES: readonly Case[] = [...A11_CASES, ...CARRY_CASES];

/** `request` with every size and the width multiplied by `k` (section 3.2, size linearity). */
export function scaled(value: TextLayoutRequest, k: number): TextLayoutRequest {
  return {
    ...value,
    runs: value.runs.map((r) => ({ ...r, size: r.size * k })),
    width: value.width === null ? null : value.width * k,
  };
}
