import type { TextLayoutRequest } from '@vector-studio/contracts';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// Source imports: the caret model is internal to editor-core until M6b-U2 wires it.
import {
  caretAfterInsertion,
  clampCaret,
  createCaretModel,
  deletionRange,
  moveCaret,
  selectAll,
  textEditKeyAction,
  type CaretModel,
  type TextAffinity,
  type TextCaret,
} from '../../packages/editor-core/src/text-caret.js';
import type { Modifiers, Platform } from '../../packages/editor-core/src/types.js';
import { createFakeTextLayout } from '../support/fake-text-layout.js';

// MVP M6b contract (docs/plans/mvp-m6b-text-editing-contract.md), section 4 and M6b-U1:
// M6b-A01 (stops, words, caret segments, selection rectangles, the composition underline and
// point to offset) and M6b-A02 (the movement and deletion table of section 4.2, the goal x and
// the no-op cases), from the committed caret scripts under tests/fixtures/m6-text/edit/ on the
// fake port, plus the clamp rules of section 4.1 and the key table's edges.

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures/m6-text/edit');

type CaretTuple = [number, number, TextAffinity?];
type Point = [number, number];

type Fixture = Readonly<{
  description: string;
  request: TextLayoutRequest;
  stops: number[];
  words?: [number, number, boolean][];
  wordAt?: { offset: number; range: [number, number] }[];
  carets: { offset: number; affinity: TextAffinity; line: number; segment: [Point, Point] }[];
  selections?: { range: [number, number]; rects: [number, number, number, number][] }[];
  composition?: { range: [number, number]; segments: [Point, Point][] }[];
  points?: { point: Point; offset: number; affinity: TextAffinity }[];
  scripts?: {
    platform: Platform;
    caret: CaretTuple;
    steps: { key: string; caret: CaretTuple; goalX?: number | null }[];
  }[];
  deletions?: {
    platform: Platform;
    caret: CaretTuple;
    key: string;
    range: [number, number] | null;
  }[];
}>;

const EXPECTED_FIXTURES = [
  'align-center.json',
  'align-right.json',
  'clusters.json',
  'empty-pending.json',
  'hangul-soft-wrap.json',
  'letter-spacing-negative.json',
  'letter-spacing-tie.json',
  'lf-empty-lines.json',
  'long-grapheme.json',
  'mixed-sizes.json',
  'rtl-logical.json',
  'words-wrapped.json',
];

function readFixture(name: string): Fixture {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as Fixture;
}

function modelOf(request: TextLayoutRequest): CaretModel {
  return createCaretModel(request, createFakeTextLayout().layout(request));
}

function caret([anchor, focus, affinity]: CaretTuple): TextCaret {
  return { anchor, focus, affinity: affinity ?? 'downstream' };
}

function chord(value: string): { key: string; modifiers: Modifiers } {
  const parts = value.split('+');
  const key = parts.pop()!;
  const has = (name: string): boolean => parts.includes(name);
  for (const part of parts) {
    if (!['Shift', 'Alt', 'Meta', 'Ctrl'].includes(part)) throw new Error(`bad chord ${value}`);
  }
  return {
    key,
    modifiers: { shift: has('Shift'), alt: has('Alt'), meta: has('Meta'), ctrl: has('Ctrl') },
  };
}

const NONE: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };

describe('M6b-A01 caret scripts: fixture set', () => {
  it('commits exactly the listed caret scripts', () => {
    const names = readdirSync(FIXTURES)
      .filter((name) => name.endsWith('.json'))
      .sort();
    expect(names).toEqual(EXPECTED_FIXTURES);
  });
});

for (const name of EXPECTED_FIXTURES) {
  const fixture = readFixture(name);
  const model = modelOf(fixture.request);

  describe(`M6b-A01 caret model: ${name}`, () => {
    it('gives the committed stops, and no other offset is a stop', () => {
      expect(model.stops).toEqual(fixture.stops);
      for (let offset = -1; offset <= model.length + 1; offset += 1) {
        expect(model.isStop(offset)).toBe(fixture.stops.includes(offset));
      }
    });

    if (fixture.words !== undefined) {
      it('gives the committed word segments', () => {
        expect(model.words.map((word) => [word.start, word.end, word.wordLike])).toEqual(
          fixture.words,
        );
      });
    }

    if (fixture.wordAt !== undefined) {
      it('gives the committed double-click words', () => {
        for (const { offset, range } of fixture.wordAt!) {
          const word = model.wordAt(offset);
          expect([word.start, word.end], `offset ${offset}`).toEqual(range);
        }
      });
    }

    it('gives the committed lines and caret segments', () => {
      for (const { offset, affinity, line, segment } of fixture.carets) {
        const label = `${offset} ${affinity}`;
        expect(model.lineOf(offset, affinity), label).toBe(line);
        const [from, to] = model.caretSegment({ offset, affinity });
        expect(
          [
            [from.x, from.y],
            [to.x, to.y],
          ],
          label,
        ).toEqual(segment);
      }
    });

    if (fixture.selections !== undefined) {
      it('gives the committed selection rectangles', () => {
        for (const { range, rects } of fixture.selections!) {
          const actual = model
            .selectionRects(range[0], range[1])
            .map((rect) => [rect.x, rect.y, rect.width, rect.height]);
          expect(actual, `[${range.join(', ')}]`).toEqual(rects);
        }
      });
    }

    if (fixture.composition !== undefined) {
      it('gives the committed composition underline', () => {
        for (const { range, segments } of fixture.composition!) {
          const actual = model.compositionSegments(range[0], range[1]).map(([from, to]) => [
            [from.x, from.y],
            [to.x, to.y],
          ]);
          expect(actual, `[${range.join(', ')}]`).toEqual(segments);
        }
      });
    }

    if (fixture.points !== undefined) {
      it('maps the committed points to offsets', () => {
        for (const { point, offset, affinity } of fixture.points!) {
          expect(model.pointToOffset({ x: point[0], y: point[1] }), `${point.join(', ')}`).toEqual({
            offset,
            affinity,
          });
        }
      });
    }
  });

  if (fixture.scripts !== undefined || fixture.deletions !== undefined) {
    describe(`M6b-A02 movement and deletion: ${name}`, () => {
      fixture.scripts?.forEach((script, index) => {
        it(`runs script ${index} (${script.platform}) step by step`, () => {
          let state = caret(script.caret);
          let goalX: number | null = null;
          script.steps.forEach((step, stepIndex) => {
            const { key, modifiers } = chord(step.key);
            const action = textEditKeyAction({ key, modifiers }, script.platform);
            const label = `step ${stepIndex} ${step.key}`;
            if (action?.type === 'move') {
              const result = moveCaret(model, state, action.movement, action.extend, goalX);
              state = result.caret;
              goalX = result.goalX;
            } else if (action?.type === 'selectAll') {
              state = selectAll(model);
              goalX = null;
            } else {
              throw new Error(`${label}: not a movement`);
            }
            expect(state, label).toEqual(caret(step.caret));
            if (step.goalX !== undefined) expect(goalX, label).toBe(step.goalX);
          });
        });
      });

      if (fixture.deletions !== undefined) {
        it('gives the committed deletion ranges', () => {
          for (const deletion of fixture.deletions!) {
            const { key, modifiers } = chord(deletion.key);
            const action = textEditKeyAction({ key, modifiers }, deletion.platform);
            const label = `${deletion.key} at ${deletion.caret.join(', ')}`;
            if (action?.type !== 'delete') throw new Error(`${label}: not a deletion`);
            const range = deletionRange(model, caret(deletion.caret), action.movement);
            expect(range === null ? null : [range.start, range.end], label).toEqual(deletion.range);
          }
        });
      }
    });
  }
}

describe('M6b-A01 stops and the clamp rules of section 4.1', () => {
  const plain = (text: string, size = 10): TextLayoutRequest => ({
    runs: [{ text, family: 'Fake', size }],
    width: null,
    align: 'left',
    letterSpacing: 0,
    lineHeight: 1,
  });

  it('never stops inside a surrogate pair or a grapheme', () => {
    const model = modelOf(plain('a😀é'));
    expect(model.stops).toEqual([0, 1, 3, 5]);
    expect(model.isStop(2)).toBe(false);
    expect(model.isStop(4)).toBe(false);
    expect(model.stopAtOrBefore(2)).toBe(1);
    expect(model.stopAtOrAfter(2)).toBe(3);
    expect(model.stopAtOrBefore(4)).toBe(3);
    expect(model.stopAtOrAfter(4)).toBe(5);
  });

  it('makes run boundaries stops, segmenting each run as the layout does', () => {
    // A mark alone in its run is its own cluster (M6a-L1), so 1 is a stop.
    const split: TextLayoutRequest = {
      ...plain(''),
      runs: [
        { text: 'e', family: 'Fake', size: 10 },
        { text: '́x', family: 'Fake', size: 20 },
      ],
    };
    expect(modelOf(split).stops).toEqual([0, 1, 2, 3]);
    // Regional indicators split across runs: whole-text pairs would put a stop at 4, inside
    // the layout's second cluster [2, 6); per-run segmentation agrees with the clusters.
    const flags: TextLayoutRequest = {
      ...plain(''),
      runs: [
        { text: '🇰', family: 'Fake', size: 10 },
        { text: '🇷🇰🇷', family: 'Fake', size: 10 },
      ],
    };
    const layout = createFakeTextLayout().layout(flags);
    expect(layout.clusters.map((cluster) => [cluster.start, cluster.end])).toEqual([
      [0, 2],
      [2, 6],
      [6, 8],
    ]);
    expect(createCaretModel(flags, layout).stops).toEqual([0, 2, 6, 8]);
  });

  it('moves the caret after an insertion up to the next stop', () => {
    // Typing `e` before an existing U+0301: the insertion ends at 1, inside `é`.
    const model = modelOf(plain('éx'));
    expect(caretAfterInsertion(model, 1)).toEqual({
      anchor: 2,
      focus: 2,
      affinity: 'downstream',
    });
    expect(caretAfterInsertion(model, 3)).toEqual({
      anchor: 3,
      focus: 3,
      affinity: 'downstream',
    });
  });

  it('clamps offsets after any other change to the length, then down to a stop', () => {
    const model = modelOf(plain('a😀'));
    expect(clampCaret(model, { anchor: 9, focus: 2, affinity: 'upstream' })).toEqual({
      anchor: 3,
      focus: 1,
      affinity: 'downstream',
    });
    const kept: TextCaret = { anchor: 1, focus: 3, affinity: 'upstream' };
    expect(clampCaret(model, kept)).toBe(kept);
  });

  it('reads the size of the run at an offset, the last run at the length', () => {
    const model = modelOf({
      ...plain(''),
      runs: [
        { text: 'ab', family: 'Fake', size: 10 },
        { text: 'c', family: 'Fake', size: 30 },
      ],
    });
    expect([0, 1, 2, 3].map((offset) => model.sizeAt(offset))).toEqual([10, 10, 30, 30]);
  });

  it('is pure: frozen inputs, a new caret per movement', () => {
    const request = plain('ab cd');
    const layout = createFakeTextLayout().layout(request);
    const model = createCaretModel(deepFrozen(request), deepFrozen(layout));
    const start = Object.freeze<TextCaret>({ anchor: 1, focus: 1, affinity: 'downstream' });
    const moved = moveCaret(model, start, 'right', false, null);
    expect(moved.caret).not.toBe(start);
    expect(start).toEqual({ anchor: 1, focus: 1, affinity: 'downstream' });
    expect(moveCaret(model, start, 'right', false, null)).toEqual(moved);
  });
});

function deepFrozen<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== 'object') return;
    Object.freeze(item);
    for (const child of Object.values(item)) freeze(child);
  };
  freeze(copy);
  return copy;
}

describe('M6b-A02 the key table of section 4.2 and M6b-Q12 (a)', () => {
  const mods = (value: Partial<Modifiers>): Modifiers => ({ ...NONE, ...value });

  it('maps every row on `other`', () => {
    const table: [string, unknown][] = [
      ['ArrowLeft', { type: 'move', movement: 'left', extend: false }],
      ['Shift+ArrowRight', { type: 'move', movement: 'right', extend: true }],
      ['ArrowUp', { type: 'move', movement: 'up', extend: false }],
      ['Shift+ArrowDown', { type: 'move', movement: 'down', extend: true }],
      ['Home', { type: 'move', movement: 'lineStart', extend: false }],
      ['Shift+End', { type: 'move', movement: 'lineEnd', extend: true }],
      ['Ctrl+ArrowLeft', { type: 'move', movement: 'previousWordStart', extend: false }],
      ['Shift+Ctrl+ArrowRight', { type: 'move', movement: 'nextWordStart', extend: true }],
      ['Ctrl+Home', { type: 'move', movement: 'textStart', extend: false }],
      ['Shift+Ctrl+End', { type: 'move', movement: 'textEnd', extend: true }],
      ['Ctrl+a', { type: 'selectAll' }],
      ['Ctrl+A', { type: 'selectAll' }],
      ['Backspace', { type: 'delete', movement: 'left' }],
      ['Delete', { type: 'delete', movement: 'right' }],
      ['Shift+Backspace', { type: 'delete', movement: 'left' }],
      ['Ctrl+Backspace', { type: 'delete', movement: 'previousWordStart' }],
      ['Ctrl+Delete', { type: 'delete', movement: 'nextWordStart' }],
      ['Enter', { type: 'lineBreak' }],
      ['Shift+Enter', { type: 'lineBreak' }],
    ];
    for (const [value, action] of table) {
      const { key, modifiers } = chord(value);
      expect(textEditKeyAction({ key, modifiers }, 'other'), value).toEqual(action);
    }
  });

  it('maps the macOS keys on `mac`', () => {
    const table: [string, unknown][] = [
      ['ArrowLeft', { type: 'move', movement: 'left', extend: false }],
      ['Alt+ArrowLeft', { type: 'move', movement: 'previousWordStart', extend: false }],
      ['Shift+Alt+ArrowRight', { type: 'move', movement: 'nextWordEnd', extend: true }],
      ['Meta+ArrowLeft', { type: 'move', movement: 'lineStart', extend: false }],
      ['Meta+ArrowRight', { type: 'move', movement: 'lineEnd', extend: false }],
      ['Shift+Meta+ArrowUp', { type: 'move', movement: 'textStart', extend: true }],
      ['Meta+ArrowDown', { type: 'move', movement: 'textEnd', extend: false }],
      ['Meta+Home', { type: 'move', movement: 'textStart', extend: false }],
      ['Meta+End', { type: 'move', movement: 'textEnd', extend: false }],
      ['Meta+a', { type: 'selectAll' }],
      ['Alt+Backspace', { type: 'delete', movement: 'previousWordStart' }],
      ['Alt+Delete', { type: 'delete', movement: 'nextWordEnd' }],
      ['Backspace', { type: 'delete', movement: 'left' }],
      ['Shift+Backspace', { type: 'delete', movement: 'left' }],
      ['Meta+Backspace', { type: 'delete', movement: 'lineStart' }],
      ['Enter', { type: 'lineBreak' }],
    ];
    for (const [value, action] of table) {
      const { key, modifiers } = chord(value);
      expect(textEditKeyAction({ key, modifiers }, 'mac'), value).toEqual(action);
    }
  });

  it('leaves keys outside the table to the key routing', () => {
    const other = [
      'Ctrl+Alt+ArrowLeft',
      'Meta+ArrowLeft',
      'Alt+ArrowLeft',
      'Ctrl+ArrowUp',
      'Shift+Delete',
      'Shift+Ctrl+Delete',
      'Shift+Ctrl+A',
      'Ctrl+Enter',
      'Meta+a',
      'Tab',
      'Escape',
      'a',
    ];
    for (const value of other) {
      const { key, modifiers } = chord(value);
      expect(textEditKeyAction({ key, modifiers }, 'other'), value).toBeNull();
    }
    const mac = ['Ctrl+ArrowLeft', 'Ctrl+a', 'Shift+Delete', 'Alt+ArrowUp', 'Alt+Home'];
    for (const value of mac) {
      const { key, modifiers } = chord(value);
      expect(textEditKeyAction({ key, modifiers }, 'mac'), value).toBeNull();
    }
    expect(textEditKeyAction({ key: 'toString', modifiers: mods({}) }, 'other')).toBeNull();
  });

  it('matches Mod+A by the keymap token, so a non-Latin layout selects all', () => {
    const russian = { key: '\u0444', code: 'KeyA' };
    expect(textEditKeyAction({ ...russian, modifiers: mods({ ctrl: true }) }, 'other')).toEqual({
      type: 'selectAll',
    });
    expect(textEditKeyAction({ ...russian, modifiers: mods({ meta: true }) }, 'mac')).toEqual({
      type: 'selectAll',
    });
    expect(
      textEditKeyAction({ key: '\u0444', code: 'KeyS', modifiers: mods({ ctrl: true }) }, 'other'),
    ).toBeNull();
  });

  it('deletes to the line start with Meta+Backspace on mac', () => {
    const request: TextLayoutRequest = {
      runs: [{ text: 'ab cd', family: 'Fake', size: 10 }],
      width: 20,
      align: 'left',
      letterSpacing: 0,
      lineHeight: 1,
    };
    // Lines [0, 3) and [3, 5): from 4 the line start is 3.
    const model = modelOf(request);
    expect(deletionRange(model, caret([4, 4]), 'lineStart')).toEqual({ start: 3, end: 4 });
    expect(deletionRange(model, caret([3, 3]), 'lineStart')).toBeNull();
  });
});

describe('M6b-A01 a 16,384-unit line (correctness only)', () => {
  const length = 16_384;
  const request: TextLayoutRequest = {
    runs: [{ text: 'a'.repeat(length), family: 'Fake', size: 10 }],
    width: null,
    align: 'left',
    letterSpacing: 0,
    lineHeight: 1,
  };
  const model = modelOf(request);

  it('gives caret x, point to offset and rectangles over the whole line', () => {
    expect(model.stops.length).toBe(length + 1);
    expect(model.caretX(0, 0)).toBe(0);
    expect(model.caretX(8000, 0)).toBe(40_000);
    expect(model.caretX(length, 0)).toBe(5 * length);
    expect(model.pointToOffset({ x: 40_001, y: 5 })).toEqual({
      offset: 8000,
      affinity: 'downstream',
    });
    expect(model.pointToOffset({ x: 40_002.5, y: 5 })).toEqual({
      offset: 8000,
      affinity: 'downstream',
    });
    expect(model.pointToOffset({ x: 1e9, y: 5 })).toEqual({
      offset: length,
      affinity: 'downstream',
    });
    expect(model.selectionRects(100, 16_000)).toEqual([
      { x: 500, y: 0, width: 79_500, height: 10 },
    ]);
    for (let offset = 0; offset <= length; offset += 1) {
      expect(model.caretSegment({ offset, affinity: 'downstream' })[0].x).toBe(5 * offset);
    }
  });
});
