import type { TextLayoutRequest } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import * as textDom from '../../packages/text-dom/src/index.js';
import { MEASUREMENT_BLOCK_STYLE } from '../../packages/text-dom/src/measure.js';
import {
  cssText,
  MEASUREMENT_BLOCK_DECLARATIONS,
  needsBidiOverride,
  referenceStyle,
} from '../../packages/text-dom/src/style.js';
import { buildRunTree, runSpan } from '../../packages/text-dom/src/tree.js';

// MVP M6c-U3 (docs/plans/mvp-m6c-gpu-text-contract.md, section 6.1, M6c-Q6 (a)): text-dom
// exports the styles it measures with, so the placed DOM cluster and the flowed DOM block of the
// agreement spec cannot drift from what text-dom measures. The export is DOM-only: the port's
// interface (`TextLayoutPort`, `createTextDom`) is unchanged. These tests pin that the measurement
// block and run spans are built from the same declarations the export returns.

/** A node tree just large enough for `buildRunTree` and `runSpan`. */
class FakeElement {
  lang = '';
  readonly properties = new Map<string, string>();
  readonly children: unknown[] = [];
  readonly style = {
    setProperty: (name: string, value: string) => void this.properties.set(name, value),
  };
  append(...nodes: unknown[]): void {
    this.children.push(...nodes);
  }
}
const fakeDocument = {
  createElement: () => new FakeElement(),
  createTextNode: (data: string) => ({ data }),
} as unknown as Document;

const request = (letterSpacing: number, lineHeight: number): TextLayoutRequest => ({
  runs: [
    { text: 'Ab\nc', family: 'A', size: 24 },
    { text: '한', family: 'B', size: 40 },
  ],
  width: null,
  align: 'left',
  letterSpacing,
  lineHeight,
});

const entries = (element: unknown) => [...(element as FakeElement).properties.entries()];

describe('M6c-U3 reference style export (M6c-Q6 (a))', () => {
  it('is exported from the package root beside createTextDom, with the port unchanged', () => {
    expect(typeof textDom.referenceStyle).toBe('function');
    expect(typeof textDom.createTextDom).toBe('function');
    expect(Object.keys(textDom).sort()).toEqual(['createTextDom', 'referenceStyle']);
  });

  it('gives the run declarations a measurement run span sets, in the same order', () => {
    const style = referenceStyle({
      lang: 'ko',
      nodeText: 'Ab\nc한',
      fontList: '"A", sans-serif',
      size: 24,
      letterSpacing: -0.2,
      lineHeight: 1.5,
    });
    const span = runSpan(fakeDocument, request(-0.2, 1.5), ['"A", sans-serif', '"B"'], 0, 'ko');
    expect(entries(span)).toEqual(style.run);
    expect((span as unknown as FakeElement).lang).toBe(style.lang);
    expect(style.run).toEqual([
      ['font-family', '"A", sans-serif'],
      ['font-size', '24px'],
      ['letter-spacing', '-0.2em'],
      ['line-height', '1.5'],
    ]);
  });

  it('gives the text declarations of a run tree span that holds text, and LF spans the run ones', () => {
    const fontLists = ['"A", sans-serif', '"B", serif'];
    const tree = buildRunTree(fakeDocument, request(0.3, 1.2), fontLists, 'ko');
    // 'Ab' | LF | 'c' of run 0, then '한' of run 1.
    const [ab, lf, c, han] = tree.elements;
    const run0 = referenceStyle({
      lang: 'ko',
      nodeText: 'Ab\nc한',
      fontList: fontLists[0]!,
      size: 24,
      letterSpacing: 0.3,
      lineHeight: 1.2,
    });
    const run1 = referenceStyle({
      lang: 'ko',
      nodeText: 'Ab\nc한',
      fontList: fontLists[1]!,
      size: 40,
      letterSpacing: 0.3,
      lineHeight: 1.2,
    });
    expect(entries(ab)).toEqual(run0.text);
    expect(entries(c)).toEqual(run0.text);
    expect(entries(lf)).toEqual(run0.run);
    expect(entries(han)).toEqual(run1.text);
    // Every span carries the layout's `lang` itself (M6c-U3 follow-up): the block's
    // `all: initial` resets the locale its own `lang` attribute sets, so only a span's own
    // attribute reaches shaping, and with it the font's `locl` forms the glyph raster port draws.
    for (const span of tree.elements) expect((span as unknown as FakeElement).lang).toBe('ko');
    expect(run0.text.slice(-2)).toEqual([
      ['direction', 'ltr'],
      ['unicode-bidi', 'bidi-override'],
    ]);
  });

  it('puts the lang on the sentinel span too', () => {
    const tree = buildRunTree(
      fakeDocument,
      { ...request(0, 1.2), runs: [{ text: 'a\n', family: 'A', size: 10 }] },
      ['"A"'],
      'ja',
    );
    expect(tree.sentinel).not.toBeNull();
    expect((tree.sentinel as unknown as FakeElement).lang).toBe('ja');
    for (const span of tree.elements) expect((span as unknown as FakeElement).lang).toBe('ja');
  });

  it('gives the measurement block typography, visible, and the measurement block uses it', () => {
    const style = referenceStyle({
      lang: 'en-US',
      nodeText: 'Ab\nc한',
      fontList: '"A"',
      size: 9,
      letterSpacing: 0,
      lineHeight: 1.2,
    });
    expect(style.lang).toBe('en-US');
    // The measurement block is the reference block plus `visibility: hidden`, nothing else.
    const hidden = MEASUREMENT_BLOCK_DECLARATIONS.filter(([property]) => property !== 'visibility');
    expect(style.block).toEqual(hidden);
    expect(MEASUREMENT_BLOCK_DECLARATIONS).toContainEqual(['visibility', 'hidden']);
    expect(style.block.map(([property]) => property)).not.toContain('visibility');
    expect(MEASUREMENT_BLOCK_STYLE).toBe(cssText(MEASUREMENT_BLOCK_DECLARATIONS));
    // `all: initial` first on the block, so it cannot reset a later declaration, and on the host.
    expect(style.block[0]).toEqual(['all', 'initial']);
    expect(style.host).toEqual([['all', 'initial']]);
    for (const declaration of [
      ['font-variant-ligatures', 'none'],
      ['text-spacing-trim', 'space-all'],
      ['text-autospace', 'no-autospace'],
      ['white-space', 'pre-wrap'],
      ['word-break', 'keep-all'],
      ['overflow-wrap', 'anywhere'],
      ['font-size', '0'],
    ] as const) {
      expect(style.block).toContainEqual(declaration);
    }
  });

  it('formats the measurement block as before the export, `all: initial` first', () => {
    expect(MEASUREMENT_BLOCK_STYLE).toBe(
      [
        'all: initial',
        'display: block',
        'visibility: hidden',
        'direction: ltr',
        'unicode-bidi: isolate',
        'white-space: pre-wrap',
        'word-break: keep-all',
        'overflow-wrap: anywhere',
        'hyphens: none',
        'font-variant-ligatures: none',
        'text-spacing-trim: space-all',
        'text-autospace: no-autospace',
        'text-align: left',
        'font-size: 0',
      ].join('; '),
    );
  });

  it('drops the bidi override for a node of Common and Inherited characters only (M6a-L1 amendment)', () => {
    // A whole node of Common-script characters in an override span shapes without the locale's
    // `locl` forms in Chromium; without strong RTL, AN or bidi controls the override changes no
    // order, so such a node is laid out without it.
    for (const text of ['3.14', '100%', '.', '1,234.5 + 6', '\u00a0.', 'a\u0301'.slice(1), '']) {
      expect(needsBidiOverride([{ text }]), JSON.stringify(text)).toBe(false);
    }
    for (const text of [
      'Ty.',
      '한.',
      'a',
      '\u05d0',
      '\u061f',
      '\u0640',
      '\u200f.',
      '\u202e1',
      '1\u2067',
    ]) {
      expect(needsBidiOverride([{ text }]), JSON.stringify(text)).toBe(true);
    }
    // Over the whole node: one run with a letter keeps the override on every run.
    expect(needsBidiOverride([{ text: '3.14' }, { text: '한' }])).toBe(true);
    const tree = buildRunTree(
      fakeDocument,
      { ...request(0, 1.2), runs: [{ text: '3.1\n4', family: 'A', size: 10 }] },
      ['"A"'],
      'ko',
    );
    const run = referenceStyle({
      lang: 'ko',
      nodeText: '3.1\n4',
      fontList: '"A"',
      size: 10,
      letterSpacing: 0,
      lineHeight: 1.2,
    });
    expect(run.text).toEqual(run.run);
    for (const span of tree.elements) expect(entries(span)).toEqual(run.run);
  });

  it('returns frozen values', () => {
    const style = referenceStyle({
      lang: 'ko',
      nodeText: 'Ab\nc한',
      fontList: '"A"',
      size: 12,
      letterSpacing: 0,
      lineHeight: 1.2,
    });
    expect(Object.isFrozen(style)).toBe(true);
    expect(Object.isFrozen(style.block)).toBe(true);
    expect(Object.isFrozen(style.host)).toBe(true);
    expect(Object.isFrozen(style.run)).toBe(true);
    expect(Object.isFrozen(style.text)).toBe(true);
    expect(style.text.every((declaration) => Object.isFrozen(declaration))).toBe(true);
  });

  it('rejects inputs no measurement could have used', () => {
    const base = {
      lang: 'ko',
      nodeText: 'a',
      fontList: '"A"',
      size: 12,
      letterSpacing: 0,
      lineHeight: 1.2,
    };
    for (const bad of [
      { ...base, lang: 'not a tag' },
      { ...base, lang: '' },
      { ...base, fontList: '' },
      { ...base, size: 0 },
      { ...base, size: Number.NaN },
      { ...base, size: Number.POSITIVE_INFINITY },
      { ...base, letterSpacing: Number.NaN },
      { ...base, lineHeight: 0 },
      { ...base, lineHeight: Number.POSITIVE_INFINITY },
      { ...base, nodeText: 1 as unknown as string },
    ]) {
      expect(() => referenceStyle(bad), JSON.stringify(bad)).toThrow(TypeError);
    }
  });
});
