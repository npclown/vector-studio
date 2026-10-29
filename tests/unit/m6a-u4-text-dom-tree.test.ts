import type { TextLayoutRequest } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import {
  assignLines,
  isHangingSpace,
  type Grapheme,
} from '../../packages/text-dom/src/assemble.js';
import { buildRunTree, planInsertions, RunText } from '../../packages/text-dom/src/tree.js';

// MVP M6a-U4 review r1 S3: where the measurement block's nodes go, over a small fake node tree
// that records the structure. Covers the run tree (LF outside the bidi-override spans, S2), the
// pass-2 plan (a `<br>` between runs at a run boundary, inside the text otherwise, B1) and the
// insertions themselves (text node splits and both sides).

class FakeNode {
  parentNode: FakeElement | null = null;
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
}

class FakeText extends FakeNode {
  constructor(public data: string) {
    super();
  }
  splitText(offset: number): FakeText {
    const rest = new FakeText(this.data.slice(offset));
    this.data = this.data.slice(0, offset);
    this.parentNode!.insertBefore(rest, this.nextSibling);
    return rest;
  }
}

class FakeElement extends FakeNode {
  readonly childNodes: FakeNode[] = [];
  readonly properties = new Map<string, string>();
  readonly style = {
    setProperty: (name: string, value: string) => void this.properties.set(name, value),
  };
  constructor(readonly tag: string) {
    super();
  }
  append(...nodes: FakeNode[]): void {
    for (const node of nodes) this.insertBefore(node, null);
  }
  insertBefore(node: FakeNode, reference: FakeNode | null): void {
    if (node.parentNode)
      node.parentNode.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
    const index = reference === null ? this.childNodes.length : this.childNodes.indexOf(reference);
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
  }
}

const fakeDocument = {
  createElement: (tag: string) => new FakeElement(tag),
  createTextNode: (data: string) => new FakeText(data),
} as unknown as Document;

/** A compact picture: `[...]` an outer span, `{...}` a bidi-override span, `|` a `<br>`. */
function picture(node: FakeNode): string {
  if (node instanceof FakeText) return JSON.stringify(node.data);
  const element = node as FakeElement;
  const inside = element.childNodes.map(picture).join(' ');
  if (element.tag === 'br') return '|';
  if (element.tag === 'probe') return 'P';
  if (element.properties.get('unicode-bidi') === 'bidi-override') return `{${inside}}`;
  return `[${inside}]`;
}

/** The block's children, without the block's own brackets. */
function contents(root: FakeElement): string {
  return root.childNodes.map(picture).join(' ');
}

const request = (runs: TextLayoutRequest['runs']): TextLayoutRequest => ({
  runs,
  width: 60,
  align: 'left',
  letterSpacing: 0,
  lineHeight: 1.2,
});

function block(tree: ReturnType<typeof buildRunTree>): FakeElement {
  const root = new FakeElement('div');
  root.append(...(tree.elements as unknown as FakeElement[]));
  if (tree.sentinel) root.append(tree.sentinel as unknown as FakeElement);
  return root;
}

/** Graphemes with fake rects, one row per entry of `rows` (the grapheme indices of each row). */
function graphemes(runs: TextLayoutRequest['runs'], rowOf: (index: number) => number): Grapheme[] {
  const result: Grapheme[] = [];
  let offset = 0;
  let index = 0;
  runs.forEach((run, runIndex) => {
    for (const character of run.text) {
      const lf = character === '\n';
      result.push({
        start: offset,
        end: offset + character.length,
        run: runIndex,
        lf,
        space: isHangingSpace(character),
        rect: lf ? null : { left: index, top: rowOf(index) * 20, width: 1, height: 10 },
      });
      offset += character.length;
      index += 1;
    }
  });
  return result;
}

function apply(
  runs: TextLayoutRequest['runs'],
  rowOf: (index: number) => number,
): { plan: ReturnType<typeof planInsertions>; picture: string } {
  const tree = buildRunTree(
    fakeDocument,
    request(runs),
    runs.map(() => '"F"'),
  );
  const root = block(tree);
  const measured = graphemes(runs, rowOf);
  const lines = assignLines(measured, tree.textLength);
  const lfRuns = new Map(measured.filter((g) => g.lf).map((g) => [g.start, g.run] as const));
  const plan = planInsertions(measured, lines, tree.runStarts, tree.textLength, lfRuns);
  for (const insertion of plan) {
    if (insertion.kind === 'br-after-run') {
      const last = tree.runLast[insertion.run] as unknown as FakeElement;
      last.parentNode!.insertBefore(new FakeElement('br'), last.nextSibling);
    } else if (insertion.kind === 'br') {
      tree.texts[insertion.run]!.insertAt(
        insertion.offset,
        [new FakeElement('br') as unknown as Node],
        'end',
      );
    } else if (insertion.run === 'sentinel') {
      (tree.sentinel as unknown as FakeElement).append(new FakeElement('probe'));
    } else {
      tree.texts[insertion.run]!.insertAt(
        insertion.offset,
        [new FakeElement('probe') as unknown as Node],
        insertion.side,
      );
    }
  }
  return { plan, picture: contents(root) };
}

describe('M6a-U4 run tree (review r1 S2, review r2)', () => {
  it('gives each LF its own span without the override, all spans siblings', () => {
    const tree = buildRunTree(
      fakeDocument,
      request([
        { text: 'a\n\nb', family: 'A', size: 40 },
        { text: 'c\n', family: 'B', size: 10 },
      ]),
      ['"A"', '"B"'],
    );
    expect(contents(block(tree))).toBe('{"a"} ["\\n"] ["\\n"] {"b"} {"c"} ["\\n"] ["​"]');
    const style = {
      'font-family': '"A"',
      'font-size': '40px',
      'letter-spacing': '0em',
      'line-height': '1.2',
    };
    const [text, lf] = tree.elements as unknown as FakeElement[];
    expect(Object.fromEntries(text!.properties)).toEqual({
      ...style,
      direction: 'ltr',
      'unicode-bidi': 'bidi-override',
    });
    expect(Object.fromEntries(lf!.properties)).toEqual(style);
    expect(tree.runLast.map((last) => tree.elements.indexOf(last!))).toEqual([3, 5]);
    expect(tree.runStarts).toEqual([0, 4]);
    expect(tree.textLength).toBe(6);
  });

  it('gives an empty text only the sentinel', () => {
    const tree = buildRunTree(fakeDocument, request([{ text: '', family: 'A', size: 10 }]), [
      '"A"',
    ]);
    expect(contents(block(tree))).toBe('["​"]');
  });
});

describe('M6a-U4 pass-2 insertions (review r1 B1, S3)', () => {
  it('puts the <br> between the run spans when a soft wrap falls on a run boundary', () => {
    // The B1 repro: "aaaa bbbb " (10) then "CCCC" (40), wrapping before "CCCC" and inside it.
    const runs = [
      { text: 'aaaa bbbb ', family: 'A', size: 10 },
      { text: 'CCCC', family: 'C', size: 40 },
    ];
    const { plan, picture: tree } = apply(runs, (index) => (index < 10 ? 0 : index < 12 ? 1 : 2));
    expect(plan).toEqual([
      { kind: 'br-after-run', run: 0 },
      { kind: 'br', run: 1, offset: 2, side: 'end' },
      { kind: 'probes', line: 0, run: 0, offset: 1, side: 'end' },
      { kind: 'probes', line: 1, run: 1, offset: 1, side: 'end' },
      { kind: 'probes', line: 2, run: 1, offset: 3, side: 'end' },
    ]);
    expect(tree).toBe('{"a" P "aaa bbbb "} | {"C" P "C" | "C" P "C"}');
  });

  it('puts the <br> inside the text for a wrap within a run', () => {
    const runs = [{ text: 'ab cd', family: 'A', size: 10 }];
    const { plan, picture: tree } = apply(runs, (index) => (index < 3 ? 0 : 1));
    expect(plan).toEqual([
      { kind: 'br', run: 0, offset: 3, side: 'end' },
      { kind: 'probes', line: 0, run: 0, offset: 1, side: 'end' },
      { kind: 'probes', line: 1, run: 0, offset: 4, side: 'end' },
    ]);
    expect(tree).toBe('{"a" P "b " | "c" P "d"}');
  });

  it('keeps the probes of a one-grapheme line before its <br> (review r2 B1)', () => {
    // `abcd` at width 0: one grapheme per line, so each line's probes and the next line's
    // `<br>` share an offset; the probes must stay on their own line.
    const { plan, picture: tree } = apply([{ text: 'abcd', family: 'A', size: 20 }], (i) => i);
    expect(plan.filter((insertion) => insertion.kind === 'br')).toHaveLength(3);
    expect(tree).toBe('{"a" P | "b" P | "c" P | "d" P}');
    // Narrow CJK: the same shape, one grapheme per line.
    const cjk = apply([{ text: '가나다', family: 'A', size: 20 }], (i) => i);
    expect(cjk.picture).toBe('{"가" P | "나" P | "다" P}');
    // Mixed runs at width 0: one-grapheme lines at a run boundary and inside runs.
    const mixed = apply(
      [
        { text: 'ab', family: 'A', size: 10 },
        { text: 'CD', family: 'C', size: 40 },
      ],
      (i) => i,
    );
    expect(mixed.picture).toBe('{"a" P | "b" P} | {"C" P | "D" P}');
  });

  it('puts an empty line probe before its LF and the last probe in the sentinel', () => {
    const runs = [{ text: 'a\n\n', family: 'A', size: 10 }];
    const { plan, picture: tree } = apply(runs, () => 0);
    expect(plan).toEqual([
      { kind: 'probes', line: 0, run: 0, offset: 1, side: 'end' },
      { kind: 'probes', line: 1, run: 0, offset: 2, side: 'start' },
      { kind: 'probes', line: 2, run: 'sentinel' },
    ]);
    expect(tree).toBe('{"a" P} ["\\n"] [P "\\n"] ["​" P]');
  });
});

describe('M6a-U4 RunText', () => {
  it('locates graphemes across splits and inserts on either side', () => {
    const span = new FakeElement('span');
    const node = new FakeText('abcd');
    span.append(node);
    const text = new RunText();
    text.add(node as unknown as Text, 0);
    text.insertAt(2, [new FakeElement('probe') as unknown as Node], 'end');
    expect(picture(span)).toBe('["ab" P "cd"]');
    expect(text.locate(2, 3)).toMatchObject({ local: 0 });
    expect((text.locate(1, 2).node as unknown as FakeText).data).toBe('ab');
    text.insertAt(2, [new FakeElement('br') as unknown as Node], 'end');
    text.insertAt(2, [new FakeElement('probe') as unknown as Node], 'start');
    // `end` inserts right after the text node, `start` right before the next one.
    expect(picture(span)).toBe('["ab" | P P "cd"]');
    expect(() => text.insertAt(0, [], 'end')).toThrow(Error);
    expect(() => text.locate(3, 5)).toThrow(Error);
  });
});
