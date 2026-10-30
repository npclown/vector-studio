import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  SCENE_MAX_DASH_ENTRIES,
  SCENE_MAX_GRADIENT_STOPS,
  type RenderNodeSnapshot,
} from '@vector-studio/contracts';
import {
  MAX_DASH_ENTRIES,
  MAX_GRADIENT_STOPS,
  migrateV5toV6,
  parseDocument,
  parseEnvelope,
  serializeDocument,
  serializeEnvelope,
  validateAnyDocument,
  validateDocument,
  validateFragmentTree,
  validateNode,
  type DocumentV5,
  type DocumentV6,
  type PathData,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createEditor,
  DEFAULT_PATH_STROKE,
  DEFAULT_SHAPE_STROKE,
  starExtension,
  type Command,
  type CommandResult,
  type Editor,
  type EditorEvent,
  type IdSource,
} from '../../packages/editor-core/src/index.js';
import { documentIdOf, projectPage } from '../../packages/editor-core/src/projector.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';
import { RecordingRenderer } from '../support/p5-recording-renderer.js';

// MVP M4-U1 (M4 contract, sections 2, 3 M4-P2, 4.1 and 7): schema v6 with paints, gradients, the
// one stroke type and dashes; the M4-S rules with their literal paths (M4-A01); the migration
// v5 -> v6 of every committed v5 fixture, the moved unsupported version, M4-L1 and the round
// trips (M4-A02); fragments written at v6 and older fragments read with the v5 rules and migrated
// in `readFields`, `nodes` and `sourceNodes` (M4-A03); the commands' v6 input and defaults; and
// the M4-P2 stroke narrowing in the projector (the M4-A05 narrowing part). The committed
// fixtures are under tests/fixtures/m4-appearance: `appearance.v6.json` holds every paint,
// stroke and dash variant on every node type with paint, a text node and an instance;
// `appearance.envelope.v6.json` is its `serializeEnvelope` text; `migrated/` holds the v6
// migration of every committed v5 fixture; `malformed/` one fixture per rule.

const root = path.resolve(import.meta.dirname, '../..');
const fixtures = path.join(root, 'tests/fixtures');
const read = (file: string) => readFileSync(path.join(fixtures, file), 'utf8');
const APPEARANCE = read('m4-appearance/appearance.v6.json');

const START = { horizontal: 'start', vertical: 'start' } as const;
const black = { r: 0, g: 0, b: 0, a: 1 };
const blue = { r: 0, g: 0, b: 1, a: 1 };
const LINEAR = {
  kind: 'linear',
  transform: [1, 0, 0, 1, 0, 0],
  stops: [
    { offset: 0, color: black },
    { offset: 1, color: blue },
  ],
  spread: 'pad',
} as const;
const DASHED = {
  color: black,
  width: 2,
  cap: 'butt',
  join: 'round',
  miterLimit: 4,
  dash: { pattern: [4, 2], phase: 0 },
} as const;

type Loose = Record<string, unknown>;
type Json = { schemaVersion: number; id: string; pages: Loose[]; nodes: Record<string, Loose> };

function parsed(text: string): DocumentV6 {
  const result = parseDocument(text);
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}

const base = (id: string, parent: string) => ({
  id,
  name: id,
  parent,
  frame: { x: 0, y: 0, width: 100, height: 50 },
  rotation: 0,
  constraints: START,
  opacity: 1,
  visible: true,
});
const rect = (id: string, parent: string, extra: Loose = {}): Loose => ({
  ...base(id, parent),
  type: 'rectangle',
  cornerRadii: [0, 0, 0, 0],
  fill: LINEAR,
  stroke: DASHED,
  ...extra,
});
const one = (node: Loose, version = 6): Json => ({
  schemaVersion: version,
  id: 'd',
  pages: [{ id: 'p', name: 'P', children: [node.id] }],
  nodes: { [node.id as string]: node },
});

type Failed = { code: string; path: string };

/** The document entry points at once, each failure path relative to the document. */
function everyEntryPoint(value: Json): Failed[] {
  const pick = (result: { ok: boolean; code?: string; path?: string }) => {
    expect(result.ok).toBe(false);
    return { code: result.code ?? '', path: result.path ?? '' };
  };
  const envelope = pick(
    parseEnvelope(JSON.stringify({ envelopeVersion: 1, lastOpenPageId: 'p', document: value })),
  );
  const results = [
    pick(parseDocument(JSON.stringify(value))),
    pick(validateAnyDocument(value)),
    { code: envelope.code, path: envelope.path.replace(/^\/document/, '') },
  ];
  if (value.schemaVersion === 6) {
    results.push(pick(validateDocument(value)), pick(validateFragmentTree(value)));
  }
  return results;
}

/** Every committed document or envelope fixture of `version` outside `malformed/` directories. */
function fixturesAt(version: number): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(fixtures, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path
      .relative(fixtures, path.join(entry.parentPath, entry.name))
      .split(path.sep)
      .join('/');
    if (file.split('/').includes('malformed')) continue;
    let value: unknown;
    try {
      value = JSON.parse(read(file));
    } catch {
      continue;
    }
    const record = value as { schemaVersion?: unknown; document?: { schemaVersion?: unknown } };
    if (record.schemaVersion === version || record.document?.schemaVersion === version) {
      out.push(file);
    }
  }
  return out.sort();
}

const SHAPE_TYPES = new Set(['rectangle', 'ellipse', 'frame', 'symbol']);
const PATH_TYPES = new Set(['line', 'path', 'custom']);

/** M4-M1 written out independently of the model: a v5 document value at v6. */
function migratedByHand(value: Json): Json {
  const nodes = Object.fromEntries(
    Object.entries(value.nodes).map(([key, node]) => {
      const stroke = node.stroke as Loose | null | undefined;
      if (stroke === null || stroke === undefined) return [key, node];
      if (SHAPE_TYPES.has(node.type as string)) {
        const added = { cap: 'butt', join: 'round', miterLimit: 4, dash: null };
        return [key, { ...node, stroke: { color: stroke.color, width: stroke.width, ...added } }];
      }
      if (PATH_TYPES.has(node.type as string))
        return [key, { ...node, stroke: { ...stroke, dash: null } }];
      return [key, node];
    }),
  );
  return { ...value, schemaVersion: 6, nodes };
}

describe('M4-A01 schema v6 rules (M4-S1 to M4-S5)', () => {
  it('mirrors the scene constants', () => {
    expect(MAX_GRADIENT_STOPS).toBe(SCENE_MAX_GRADIENT_STOPS);
    expect(MAX_DASH_ENTRIES).toBe(SCENE_MAX_DASH_ENTRIES);
    expect([MAX_GRADIENT_STOPS, MAX_DASH_ENTRIES]).toEqual([16, 16]);
  });

  const at = (rest: string) => `/nodes/r${rest}`;
  const MALFORMED: Record<string, [string, string]> = {
    'paint-mixed-keys': ['document.invalid-field', at('/fill')],
    'paint-color-missing-key': ['document.invalid-field', at('/fill')],
    'transform-singular': ['document.invalid-field', at('/fill/transform')],
    'transform-determinant-non-finite': ['document.invalid-field', at('/fill/transform')],
    'transform-inverse-non-finite': ['document.invalid-field', at('/fill/transform')],
    'transform-five-entries': ['document.invalid-field', at('/fill/transform')],
    'stops-0': ['document.invalid-field', at('/fill/stops')],
    'stops-17': ['document.invalid-field', at('/fill/stops')],
    'offset-decreasing': ['document.invalid-field', at('/fill/stops/1/offset')],
    'offset-out-of-range': ['document.invalid-field', at('/fill/stops/0/offset')],
    'kind-unknown': ['document.invalid-field', at('/fill/kind')],
    'spread-unknown': ['document.invalid-field', at('/fill/spread')],
    'stroke-paint-invalid': ['document.invalid-field', at('/stroke/color/stops')],
    'stroke-v5-shape': ['document.invalid-field', at('/stroke/cap')],
    'dash-0-entries': ['document.invalid-field', at('/stroke/dash/pattern')],
    'dash-17-entries': ['document.invalid-field', at('/stroke/dash/pattern')],
    'dash-negative-entry': ['document.invalid-field', at('/stroke/dash/pattern/1')],
    'dash-non-finite-entry': ['document.invalid-field', at('/stroke/dash/pattern/1')],
    'dash-all-zero': ['document.invalid-field', at('/stroke/dash/pattern')],
    'dash-odd-period-overflow': ['document.invalid-field', at('/stroke/dash/pattern')],
    'dash-non-finite-phase': ['document.invalid-field', at('/stroke/dash/phase')],
    'opacity-1.5': ['document.invalid-field', at('/opacity')],
    'container-opacity': ['document.invalid-field', at('/opacity')],
    'gradient-in-v5': ['document.invalid-field', at('/fill/r')],
    'v6-stroke-in-v5': ['document.invalid-field', at('/stroke/cap')],
    'unsupported-version': ['document.unsupported-version', '/schemaVersion'],
  };

  it('has one committed malformed fixture per case', () => {
    const names = readdirSync(path.join(fixtures, 'm4-appearance/malformed')).map((file) =>
      file.replace(/\.json$/, ''),
    );
    expect(names.sort()).toEqual(Object.keys(MALFORMED).sort());
  });

  it.each(Object.entries(MALFORMED))(
    '%s fails with its code and path at every entry point',
    (name, [code, p]) => {
      const text = read(`m4-appearance/malformed/${name}.json`);
      const value = JSON.parse(text) as Json;
      const expected = everyEntryPoint(value);
      expect(expected).toEqual(Array(expected.length).fill({ code, path: p }));
      // The editor refuses it on load.
      expect(() => createEditor({ document: value })).toThrow(`${code} at ${p}`);
      // validateNode applies the field rules alone, at the node-relative path.
      if (value.schemaVersion === 6) {
        expect(validateNode(value.nodes.r)).toEqual({
          ok: false,
          code: 'document.invalid-field',
          path: p.slice('/nodes/r'.length),
        });
      }
    },
  );

  it('reads non-finite JSON numbers in the dash fixtures (1e999 is Infinity)', () => {
    const value = JSON.parse(read('m4-appearance/malformed/dash-non-finite-phase.json')) as Json;
    expect((value.nodes.r!.stroke as { dash: { phase: number } }).dash.phase).toBe(Infinity);
  });

  it('reads a paint by its exact key set, anything else at the paint itself (M4-S1)', () => {
    const fails = (fill: unknown, p: string) =>
      expect(validateNode(rect('r', 'p', { fill }))).toEqual({
        ok: false,
        code: 'document.invalid-field',
        path: p,
      });
    fails(5, '/fill');
    fails([], '/fill');
    fails({}, '/fill');
    fails({ ...black, extra: 1 }, '/fill');
    fails({ ...LINEAR, r: 0 }, '/fill');
    fails({ kind: 'linear', transform: LINEAR.transform, stops: LINEAR.stops }, '/fill');
    // Exactly the colour keys: the colour rules, at the channel.
    fails({ ...black, a: 2 }, '/fill/a');
    // The stroke paint follows the same rule under `color`.
    expect(validateNode(rect('r', 'p', { stroke: { ...DASHED, color: { r: 0 } } }))).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/stroke/color',
    });
  });

  it('checks a gradient in key order: kind, transform, stops, spread (M4-S2)', () => {
    const fails = (over: Loose, p: string) =>
      expect(validateNode(rect('r', 'p', { fill: { ...LINEAR, ...over } }))).toMatchObject({
        path: p,
      });
    fails({ kind: 'conic', transform: [0, 0, 0, 0, 0, 0], spread: 'x' }, '/fill/kind');
    fails({ transform: [1, 0, 0, Infinity, 0, 0], stops: [] }, '/fill/transform/3');
    fails({ transform: [1, 0, 0, 'a', 0, 0] }, '/fill/transform/3');
    fails({ transform: [0, 0, 0, 0, 0, 0], stops: [] }, '/fill/transform');
    fails({ stops: [], spread: 'x' }, '/fill/stops');
    // The count is checked before the entries.
    fails(
      { stops: Array.from({ length: 17 }, () => ({ offset: 2, color: black })) },
      '/fill/stops',
    );
    fails({ stops: [{ offset: 0, color: black, extra: 1 }] }, '/fill/stops/0/extra');
    fails({ stops: [{ color: black }] }, '/fill/stops/0/offset');
    fails(
      { stops: [{ offset: 0, color: { ...black, a: -1 } }], spread: 'x' },
      '/fill/stops/0/color/a',
    );
    fails({ spread: 'x' }, '/fill/spread');
  });

  it('accepts 1 and 16 stops, equal offsets, every kind and spread, and a skewed transform', () => {
    const accepts = (over: Loose) =>
      expect(validateNode(rect('r', 'p', { fill: { ...LINEAR, ...over } })).ok).toBe(true);
    accepts({ stops: [{ offset: 0.5, color: black }] });
    accepts({ stops: Array.from({ length: 16 }, (_, i) => ({ offset: i / 15, color: black })) });
    accepts({
      stops: [
        { offset: 0.5, color: black },
        { offset: 0.5, color: blue },
      ],
    });
    for (const kind of ['linear', 'radial']) accepts({ kind });
    for (const spread of ['pad', 'reflect', 'repeat']) accepts({ spread });
    accepts({ transform: [2, 0.5, -0.25, 1, -0.5, 0] });
  });

  it('checks a stroke in key order with its dash (M4-S3, M4-S4)', () => {
    const fails = (stroke: unknown, p: string) =>
      expect(validateNode(rect('r', 'p', { stroke }))).toMatchObject({ path: p });
    const { dash, ...noDash } = DASHED;
    expect(dash).not.toBeNull();
    fails(noDash, '/stroke/dash');
    fails({ ...DASHED, extra: 1 }, '/stroke/extra');
    fails({ ...DASHED, width: -1, cap: 'x' }, '/stroke/width');
    fails({ ...DASHED, cap: 'x', join: 'x' }, '/stroke/cap');
    fails({ ...DASHED, join: 'x' }, '/stroke/join');
    fails({ ...DASHED, miterLimit: 0.5 }, '/stroke/miterLimit');
    fails({ ...DASHED, dash: 5 }, '/stroke/dash');
    fails({ ...DASHED, dash: { pattern: [1] } }, '/stroke/dash/phase');
    fails({ ...DASHED, dash: { pattern: [1], phase: 0, extra: 1 } }, '/stroke/dash/extra');
    fails({ ...DASHED, dash: { pattern: 'a', phase: 0 } }, '/stroke/dash/pattern');
    // An entry rule before the all-zero and period rules, and before the phase.
    fails({ ...DASHED, dash: { pattern: [0, -1], phase: Infinity } }, '/stroke/dash/pattern/1');
    fails({ ...DASHED, dash: { pattern: [0, 0], phase: Infinity } }, '/stroke/dash/pattern');
    // An even pattern's period is not doubled; an odd one's is (E24-S1).
    expect(
      validateNode(
        rect('r', 'p', { stroke: { ...DASHED, dash: { pattern: [1e308, 0], phase: 0 } } }),
      ).ok,
    ).toBe(true);
    fails({ ...DASHED, dash: { pattern: [1e308, 1e308], phase: 0 } }, '/stroke/dash/pattern');
    fails({ ...DASHED, dash: { pattern: [1e308], phase: 0 } }, '/stroke/dash/pattern');
  });

  it('accepts a zero entry, 16 entries, any phase and a dash on every stroked type', () => {
    const accepts = (dash: unknown) =>
      expect(validateNode(rect('r', 'p', { stroke: { ...DASHED, dash } })).ok).toBe(true);
    accepts(null);
    accepts({ pattern: [0, 8], phase: -1e300 });
    accepts({ pattern: Array(16).fill(1), phase: 1e300 });
    const value = parsed(APPEARANCE);
    const dashed = Object.values(value.nodes).filter(
      (node) => 'stroke' in node && node.stroke !== null && node.stroke.dash !== null,
    );
    expect(dashed.map((node) => node.type).sort()).toEqual(
      ['custom', 'frame', 'line', 'path', 'rectangle', 'rectangle', 'symbol'].sort(),
    );
  });

  it('normalizes negative zero in transforms, offsets and dashes', () => {
    const node = validateNode(
      rect('r', 'p', {
        fill: {
          ...LINEAR,
          transform: [1, -0, -0, 1, -0, 0],
          stops: [{ offset: -0, color: black }],
        },
        stroke: { ...DASHED, dash: { pattern: [-0, 1], phase: -0 } },
      }),
    );
    expect(node.ok).toBe(true);
    // JSON.stringify writes -0 as 0, so each value is checked with Object.is.
    const read = (node.ok ? node.node : null) as unknown as {
      fill: { transform: number[]; stops: { offset: number }[] };
      stroke: { dash: { pattern: number[]; phase: number } };
    };
    for (const index of [1, 2, 4]) expect(Object.is(read.fill.transform[index], 0)).toBe(true);
    expect(Object.is(read.fill.stops[0]!.offset, 0)).toBe(true);
    expect(Object.is(read.stroke.dash.pattern[0], 0)).toBe(true);
    expect(Object.is(read.stroke.dash.phase, 0)).toBe(true);
  });

  it('keeps text run colours as colours: a gradient in a run fails at the run colour', () => {
    const value = JSON.parse(APPEARANCE) as Json;
    (value.nodes.t1!.runs as Loose[])[0]!.color = LINEAR;
    expect(everyEntryPoint(value)).toEqual(
      Array(5).fill({ code: 'document.invalid-field', path: '/nodes/t1/runs/0/color/r' }),
    );
  });
});

describe('M4-A02 migration v5 to v6, versions and round trips (section 2.1)', () => {
  const v5Fixtures = fixturesAt(5);
  const v6Of = (file: string) =>
    `m4-appearance/migrated/${path.basename(file).replace(/\.v5\.json$/, '')}.v6.json`;

  it('finds every committed v5 fixture, each with a committed v6 migration', () => {
    expect(v5Fixtures).toContain('m7-symbols/text-symbols.v5.json');
    expect(v5Fixtures).toContain('m7-symbols/migrated/containers.envelope.v5.json');
    expect(v5Fixtures).toHaveLength(16);
    const migrated = readdirSync(path.join(fixtures, 'm4-appearance/migrated'));
    expect(migrated.sort()).toEqual(v5Fixtures.map((file) => path.basename(v6Of(file))).sort());
    // The only v6 fixtures are the migrations and the appearance fixture with its envelope.
    expect(fixturesAt(6)).toEqual(
      [
        'm4-appearance/appearance.envelope.v6.json',
        'm4-appearance/appearance.v6.json',
        ...v5Fixtures.map(v6Of),
      ].sort(),
    );
  });

  it.each(v5Fixtures)('migrates %s byte for byte to its committed v6 text', (file) => {
    const v5 = read(file);
    const v6 = read(v6Of(file));
    if (file.includes('.envelope.')) {
      const result = parseEnvelope(v5);
      expect(result.ok && serializeEnvelope(result.envelope)).toBe(v6);
      const value = JSON.parse(v5) as { document: Json };
      expect((JSON.parse(v6) as { document: unknown }).document).toEqual(
        migratedByHand(value.document),
      );
    } else {
      expect(serializeDocument(parsed(v5))).toBe(v6);
      const migrated = migrateV5toV6(JSON.parse(v5) as DocumentV5);
      expect(migrated.ok && serializeDocument(migrated.document)).toBe(v6);
      // M4-M1 written out by hand gives the same value, key order included.
      expect(JSON.stringify(JSON.parse(v6))).toBe(
        JSON.stringify(migratedByHand(JSON.parse(v5) as Json)),
      );
    }
  });

  it('rewrites only strokes: fills, other fields and the node map are unchanged (M4-M1)', () => {
    const v5 = JSON.parse(read('m7-symbols/migrated/containers.v5.json')) as Json;
    const migrated = migrateV5toV6(v5 as unknown as DocumentV5);
    expect(migrated.ok).toBe(true);
    const nodes = (migrated.ok ? migrated.document.nodes : {}) as Record<string, Loose>;
    expect(Object.keys(nodes).sort()).toEqual(Object.keys(v5.nodes).sort());
    let rewritten = 0;
    for (const [id, node] of Object.entries(v5.nodes)) {
      const { stroke, ...rest } = nodes[id]!;
      const { stroke: before, ...restBefore } = node;
      expect(rest).toEqual(restBefore);
      if (before === null || before === undefined) {
        expect(stroke).toEqual(before);
        continue;
      }
      rewritten += 1;
      expect(stroke).toEqual(
        SHAPE_TYPES.has(node.type as string)
          ? { ...before, cap: 'butt', join: 'round', miterLimit: 4, dash: null }
          : { ...before, dash: null },
      );
    }
    expect(rewritten).toBeGreaterThan(3);
  });

  it('restores the M5 envelope fixtures through migration to the v6 envelope texts', () => {
    for (const name of ['empty', 'shapes', 'ext-star', 'containers']) {
      const want = read(`m4-appearance/migrated/${name}.envelope.v6.json`);
      for (const source of [
        `m5-persistence/${name}.envelope.json`,
        `m7-symbols/migrated/${name}.envelope.v3.json`,
        `m6-text/migrated/${name}.envelope.v4.json`,
        `m7-symbols/migrated/${name}.envelope.v5.json`,
      ]) {
        const result = parseEnvelope(read(source));
        expect(result.ok && serializeEnvelope(result.envelope)).toBe(want);
      }
    }
  });

  it('round-trips the appearance envelope, written by serializeEnvelope, byte for byte', () => {
    const text = read('m4-appearance/appearance.envelope.v6.json');
    const document = parsed(APPEARANCE);
    expect(serializeEnvelope({ document, lastOpenPageId: 'page-2' })).toBe(text);
    const result = parseEnvelope(text);
    expect(result).toEqual({ ok: true, envelope: { document, lastOpenPageId: 'page-2' } });
    expect(result.ok && serializeEnvelope(result.envelope)).toBe(text);
  });

  it.each([
    'm4-appearance/appearance.v6.json',
    ...fixturesAt(6).filter((f) => !f.includes('.envelope.')),
  ])('parse(serialize(d)) is byte-identical for %s, also through the envelope', (file) => {
    const text = read(file);
    const value = parsed(text);
    expect(serializeDocument(value)).toBe(text);
    expect(parsed(serializeDocument(value))).toEqual(value);
    for (const page of value.pages) {
      const envelope = { document: value, lastOpenPageId: page.id };
      const envelopeText = serializeEnvelope(envelope);
      const result = parseEnvelope(envelopeText);
      expect(result).toEqual({ ok: true, envelope });
      expect(result.ok && serializeEnvelope(result.envelope)).toBe(envelopeText);
      expect(result.ok && serializeDocument(result.envelope.document)).toBe(text);
    }
  });

  it('writes a gradient, a stop, a stroke and a dash in the fixed key order', () => {
    const raw = JSON.parse(APPEARANCE) as Json;
    const r1 = raw.nodes.r1 as {
      fill: Loose & { stops: Loose[] };
      stroke: Loose & { dash: Loose };
    };
    expect(Object.keys(r1.fill)).toEqual(['kind', 'transform', 'stops', 'spread']);
    expect(Object.keys(r1.fill.stops[0]!)).toEqual(['offset', 'color']);
    expect(Object.keys(r1.stroke)).toEqual(['color', 'width', 'cap', 'join', 'miterLimit', 'dash']);
    expect(Object.keys(r1.stroke.dash)).toEqual(['pattern', 'phase']);
    // An in-memory value in other key orders serializes to the same text.
    const value = parsed(APPEARANCE);
    const node = value.nodes.r1 as Extract<DocumentV6['nodes'][string], { type: 'rectangle' }>;
    const fill = node.fill as Extract<typeof node.fill, { kind: string }>;
    const stroke = node.stroke!;
    const shuffled = {
      ...value,
      nodes: {
        ...value.nodes,
        r1: {
          ...node,
          fill: {
            spread: fill.spread,
            stops: fill.stops.map((stop) => ({ color: stop.color, offset: stop.offset })),
            transform: fill.transform,
            kind: fill.kind,
          },
          stroke: {
            dash: { phase: stroke.dash!.phase, pattern: stroke.dash!.pattern },
            miterLimit: stroke.miterLimit,
            join: stroke.join,
            cap: stroke.cap,
            width: stroke.width,
            color: stroke.color,
          },
        },
      },
    } as DocumentV6;
    expect(serializeDocument(shuffled)).toBe(APPEARANCE);
  });

  it('covers every paint, stroke and dash variant on every node type with paint', () => {
    const value = parsed(APPEARANCE);
    const paints = Object.values(value.nodes).flatMap((node) => [
      ...('fill' in node && node.fill !== null ? [node.fill] : []),
      ...('stroke' in node && node.stroke !== null ? [node.stroke.color] : []),
    ]);
    const kinds = new Set(paints.map((paint) => ('kind' in paint ? paint.kind : 'color')));
    expect(kinds).toEqual(new Set(['color', 'linear', 'radial']));
    const spreads = new Set(paints.flatMap((paint) => ('kind' in paint ? [paint.spread] : [])));
    expect(spreads).toEqual(new Set(['pad', 'reflect', 'repeat']));
    const counts = new Set(
      paints.flatMap((paint) => ('kind' in paint ? [paint.stops.length] : [])),
    );
    expect([...counts].sort((a, b) => a - b)).toEqual([1, 2, 3, 16]);
    const strokes = Object.values(value.nodes).flatMap((node) =>
      'stroke' in node && node.stroke !== null ? [node.stroke] : [],
    );
    expect(new Set(strokes.map((stroke) => stroke.cap))).toEqual(
      new Set(['butt', 'round', 'square']),
    );
    expect(new Set(strokes.map((stroke) => stroke.join))).toEqual(
      new Set(['miter', 'round', 'bevel']),
    );
    const types = new Set(Object.values(value.nodes).map((node) => node.type));
    for (const type of ['rectangle', 'ellipse', 'line', 'path', 'custom', 'frame', 'symbol']) {
      expect(types.has(type as never), type).toBe(true);
    }
    expect(types.has('text') && types.has('instance') && types.has('group')).toBe(true);
  });

  it('accepts versions 1 to 6, validateDocument only 6, and fails 7', () => {
    const v6 = JSON.parse(APPEARANCE) as Json;
    expect(validateDocument(v6).ok).toBe(true);
    const v5 = JSON.parse(read('m7-symbols/migrated/shapes.v5.json')) as Json;
    expect(validateAnyDocument(v5).ok).toBe(true);
    const unsupported = { ok: false, code: 'document.unsupported-version', path: '/schemaVersion' };
    for (const version of [1, 2, 3, 4, 5, 7]) {
      expect(validateDocument({ ...v6, schemaVersion: version })).toEqual(unsupported);
      expect(validateFragmentTree({ ...v6, schemaVersion: version })).toEqual(unsupported);
    }
    expect(parseDocument(JSON.stringify({ ...v6, schemaVersion: 7 }))).toEqual(unsupported);
  });

  it.each([
    'p5-model/malformed/unsupported-version.json',
    'm1-model/malformed/unsupported-version.json',
    'm7-symbols/malformed/unsupported-version.json',
    'm6-text/malformed/unsupported-version.json',
    'm4-appearance/malformed/unsupported-version.json',
  ])('fails %s at schemaVersion 7', (file) => {
    const text = read(file);
    expect((JSON.parse(text) as Json).schemaVersion).toBe(7);
    expect(parseDocument(text)).toEqual({
      ok: false,
      code: 'document.unsupported-version',
      path: '/schemaVersion',
    });
  });

  it.each(['document-unsupported-version', 'order-5-6'])(
    'holds document schemaVersion 7 in the M5 envelope %s',
    (name) => {
      const value = JSON.parse(read(`m5-persistence/malformed/${name}.json`)) as { document: Json };
      expect(value.document.schemaVersion).toBe(7);
    },
  );

  it('still fails a container or instance at opacity 0.5 at every version (M4-L1)', () => {
    const frame = {
      ...base('f', 'p'),
      opacity: 0.5,
      type: 'frame',
      children: [],
      fill: null,
      stroke: null,
    };
    const group = { ...base('g', 'p'), opacity: 0.5, type: 'group', children: ['k'] };
    const leaf = { ...rect('k', 'g'), fill: black, stroke: null };
    for (const version of [2, 3, 4, 5, 6]) {
      expect(validateAnyDocument(one(frame, version))).toEqual({
        ok: false,
        code: 'document.invalid-field',
        path: '/nodes/f/opacity',
      });
      expect(
        validateAnyDocument({
          schemaVersion: version,
          id: 'd',
          pages: [{ id: 'p', name: 'P', children: ['g'] }],
          nodes: { g: group, k: leaf },
        }),
      ).toEqual({ ok: false, code: 'document.invalid-field', path: '/nodes/g/opacity' });
    }
    // An instance at 0.5 from v3, where symbols and instances start (M7-U1), to v6; v5 added
    // `textOverrides` (M7-U7). At v2 the instance type itself is unknown.
    const instanceAt = (version: number): Json => ({
      schemaVersion: version,
      id: 'd',
      pages: [
        { id: 'p', name: 'P', children: ['i'] },
        { id: 'q', name: 'Q', children: ['s'] },
      ],
      nodes: {
        s: { ...base('s', 'q'), type: 'symbol', children: [], fill: null, stroke: null },
        i: {
          ...base('i', 'p'),
          opacity: 0.5,
          type: 'instance',
          symbol: 's',
          ...(version >= 5 ? { textOverrides: {} } : {}),
        },
      },
    });
    for (const version of [3, 4, 5, 6]) {
      expect(validateAnyDocument(instanceAt(version)), `v${version}`).toEqual({
        ok: false,
        code: 'document.invalid-field',
        path: '/nodes/i/opacity',
      });
      const opaque = instanceAt(version);
      opaque.nodes.i!.opacity = 1;
      expect(validateAnyDocument(opaque).ok, `v${version} at opacity 1`).toBe(true);
    }
    expect(validateAnyDocument(instanceAt(2)).ok).toBe(false);
    const symbols = JSON.parse(APPEARANCE) as Json;
    symbols.nodes.i1!.opacity = 0.5;
    expect(validateDocument(symbols)).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/nodes/i1/opacity',
    });
    expect(validateNode({ ...symbols.nodes.s1, opacity: 0.5 })).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/opacity',
    });
  });

  it('rejects v6 values in an older input, also through migrateV5toV6', () => {
    const gradient = JSON.parse(read('m4-appearance/malformed/gradient-in-v5.json')) as DocumentV5;
    expect(migrateV5toV6(gradient)).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/nodes/r/fill/r',
    });
    const stroke = JSON.parse(read('m4-appearance/malformed/v6-stroke-in-v5.json')) as DocumentV5;
    expect(migrateV5toV6(stroke)).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/nodes/r/stroke/cap',
    });
    // A v5 path stroke with a dash fails at the dash, as v5 reads it.
    const path5 = one(
      {
        ...base('l', 'p'),
        type: 'line',
        points: [0, 0, 1, 1],
        stroke: { ...DASHED, color: black },
        startArrow: 'none',
        endArrow: 'none',
      },
      5,
    );
    expect(validateAnyDocument(path5)).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/nodes/l/stroke/dash',
    });
    for (const version of [2, 3, 4]) {
      expect(validateAnyDocument({ ...path5, schemaVersion: version })).toMatchObject({
        path: '/nodes/l/stroke/dash',
      });
    }
  });

  it('leaves text nodes and instance overrides unchanged; an instance carries no paint', () => {
    const v5 = JSON.parse(read('m7-symbols/text-symbols.v5.json')) as Json;
    const v6 = JSON.parse(read('m4-appearance/migrated/text-symbols.v6.json')) as Json;
    for (const [id, node] of Object.entries(v5.nodes)) {
      if (node.type === 'text' || node.type === 'instance') expect(v6.nodes[id]).toEqual(node);
    }
    const instance = JSON.parse(APPEARANCE) as Json;
    instance.nodes.i1!.fill = null;
    expect(validateDocument(instance)).toMatchObject({ path: '/nodes/i1/fill' });
  });
});

describe('M4-A03 fragments at v6, older fragments migrated (section 7)', () => {
  const MARKER = 'vector-studio/fragment\n';
  type Body = {
    fragmentVersion: number;
    schemaVersion: number;
    roots: string[];
    nodes: Record<string, Loose>;
    sources: string[];
    sourceNodes: Record<string, Loose>;
  };
  const marked = (body: unknown) => MARKER + JSON.stringify(body);

  function counted(document: unknown = JSON.parse(APPEARANCE)) {
    let count = 0;
    const ids: IdSource = () => `n${++count}`;
    const target = createEditor({ document, ids, extensions: [starExtension] });
    return { target, drawn: () => count };
  }
  const text = (target: Editor) => serializeDocument(target.query({ type: 'document' }));
  function ok(target: Editor, command: Command): readonly string[] {
    const result: CommandResult = target.execute(command);
    if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
    expect(validateDocument(JSON.parse(text(target))).ok).toBe(true);
    return result.ids;
  }
  const empty = () =>
    counted({
      schemaVersion: 6,
      id: 'e',
      pages: [{ id: 'q', name: 'Q', children: [] }],
      nodes: {},
    });

  it('writes the literal fragment text with a gradient and a dash at schema v6', () => {
    const { target } = counted();
    ok(target, { type: 'copy', ids: ['r1'] });
    expect(target.query({ type: 'clipboard' })).toBe(
      MARKER +
        '{"fragmentVersion":2,"schemaVersion":6,"roots":["r1"],"nodes":{"r1":{"id":"r1",' +
        '"name":"r1","parent":"","frame":{"x":20,"y":20,"width":200,"height":120},' +
        '"rotation":0,"constraints":{"horizontal":"start","vertical":"start"},"opacity":1,' +
        '"visible":true,"type":"rectangle","cornerRadii":[8,0,8,0],"fill":{"kind":"linear",' +
        '"transform":[1,0,0,1,0,0],"stops":[{"offset":0,"color":{"r":1,"g":0,"b":0,"a":1}},' +
        '{"offset":1,"color":{"r":0,"g":0,"b":1,"a":1}}],"spread":"pad"},"stroke":{"color":' +
        '{"r":0,"g":0,"b":0,"a":1},"width":4,"cap":"butt","join":"miter","miterLimit":4,' +
        '"dash":{"pattern":[12,6],"phase":0}}}},"sources":[],"sourceNodes":{}}',
    );
  });

  it('pastes and duplicates paints and dashes unchanged, one undo step each', () => {
    const { target } = counted();
    const before = target.query({ type: 'document' });
    ok(target, { type: 'copy', ids: ['r1', 'p1', 'l1', 'e1', 'c1', 'f1', 'i1'] });
    const start = text(target);
    const pasted = ok(target, { type: 'paste' });
    const after = text(target);
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 1, redoDepth: 0 });
    const document = target.query({ type: 'document' });
    const style = (id: string) => {
      const { fill, stroke } = document.nodes[id] as Loose;
      return { fill, stroke };
    };
    const originals = ['r1', 'e1', 'l1', 'p1', 'c1', 'f1', 'i1'];
    expect(pasted).toHaveLength(originals.length);
    originals.forEach((id, i) => {
      const { fill, stroke } = before.nodes[id] as Loose;
      expect(style(pasted[i]!)).toEqual({ fill, stroke });
    });
    ok(target, { type: 'undo' });
    expect(text(target)).toBe(start);
    ok(target, { type: 'redo' });
    expect(text(target)).toBe(after);
    const duplicated = ok(target, { type: 'duplicateNodes', ids: ['r1', 'f1'] });
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 2, redoDepth: 0 });
    const twice = target.query({ type: 'document' });
    expect((twice.nodes[duplicated[0]!] as Loose).fill).toEqual((before.nodes.r1 as Loose).fill);
    expect((twice.nodes[duplicated[0]!] as Loose).stroke).toEqual(
      (before.nodes.r1 as Loose).stroke,
    );
  });

  // Older nodes, each in its v5 form; the paste migrates them as the document chain does.
  const OLDER: Record<string, Loose> = {
    rectangle: { ...rect('r', ''), fill: black, stroke: { color: blue, width: 3 } },
    ellipse: {
      ...base('e', ''),
      type: 'ellipse',
      fill: null,
      stroke: { color: blue, width: 1 },
    },
    frame: {
      ...base('f', ''),
      type: 'frame',
      children: [],
      fill: black,
      stroke: { color: blue, width: 2 },
    },
    line: {
      ...base('l', ''),
      type: 'line',
      points: [0, 0, 1, 1],
      stroke: { color: blue, width: 2, cap: 'round', join: 'bevel', miterLimit: 2 },
      startArrow: 'none',
      endArrow: 'line',
    },
    path: {
      ...base('h', ''),
      type: 'path',
      path: { verbs: ['move', 'line'], points: [0, 0, 1, 1], fillRule: 'nonzero' },
      fill: null,
      stroke: { color: blue, width: 2, cap: 'square', join: 'miter', miterLimit: 4 },
    },
  };

  /** The document chain's reading of `node` (written with parent `""`) at `schemaVersion`. */
  function holderRead(node: Loose, schemaVersion: number) {
    const id = node.id as string;
    return validateAnyDocument({
      schemaVersion,
      id: 'holder',
      pages: [{ id: 'hp', name: '', children: [id] }],
      nodes: { [id]: { ...node, parent: 'hp' } },
    });
  }

  function fragmentAt(node: Loose, schemaVersion: number): string {
    const id = node.id as string;
    return schemaVersion === 2
      ? marked({ fragmentVersion: 1, schemaVersion, roots: [id], nodes: { [id]: node } })
      : marked({
          fragmentVersion: 2,
          schemaVersion,
          roots: [id],
          nodes: { [id]: node },
          sources: [],
          sourceNodes: {},
        });
  }

  it.each([2, 3, 4, 5])(
    'pastes a fragment at schema v%i migrated, as the document chain migrates it',
    (schemaVersion) => {
      for (const [type, node] of Object.entries(OLDER)) {
        const { target } = empty();
        const [copy] = ok(target, { type: 'paste', text: fragmentAt(node, schemaVersion) });
        const pastedNode = target.query({ type: 'document' }).nodes[copy!] as Loose;
        const chain = holderRead(node, schemaVersion);
        expect(chain.ok, type).toBe(true);
        const migrated = (chain.ok ? chain.document.nodes[node.id as string] : {}) as Loose;
        expect([type, pastedNode.fill, pastedNode.stroke]).toEqual([
          type,
          migrated.fill,
          migrated.stroke,
        ]);
        const before = node.stroke as Loose;
        expect(pastedNode.stroke).toEqual(
          SHAPE_TYPES.has(type)
            ? { ...before, cap: 'butt', join: 'round', miterLimit: 4, dash: null }
            : { ...before, dash: null },
        );
      }
    },
  );

  // Malformed older nodes: `readFields` reports what the v5 rules report, in their order.
  const OLDER_FAILURES: [string, Loose, string][] = [
    ['a gradient fill', { ...OLDER.rectangle, fill: LINEAR }, '/fill/r'],
    ['a v6 rectangle stroke', { ...OLDER.rectangle, stroke: DASHED }, '/stroke/cap'],
    [
      'a missing stroke key before an unknown one',
      { ...OLDER.rectangle, stroke: { color: blue, cap: 'butt' } },
      '/stroke/width',
    ],
    [
      'a fill value before a stroke key',
      { ...OLDER.rectangle, fill: { ...black, a: 2 }, stroke: DASHED },
      '/fill/a',
    ],
    [
      'a field before the fill',
      { ...OLDER.rectangle, cornerRadii: [-1, 0, 0, 0], fill: LINEAR },
      '/cornerRadii/0',
    ],
    [
      'a node key before the appearance',
      { ...OLDER.rectangle, extra: 1, stroke: DASHED },
      '/extra',
    ],
    [
      'a missing stroke',
      Object.fromEntries(Object.entries(OLDER.rectangle!).filter(([key]) => key !== 'stroke')),
      '/stroke',
    ],
    ['a stroke that is not an object', { ...OLDER.ellipse, stroke: 5 }, '/stroke'],
    [
      'a gradient stroke colour',
      { ...OLDER.path, stroke: { ...(OLDER.path!.stroke as Loose), color: LINEAR } },
      '/stroke/color/r',
    ],
    [
      'a stroke colour key',
      { ...OLDER.frame, stroke: { color: { r: 0, g: 0, b: 0 }, width: 1 } },
      '/stroke/color/a',
    ],
    ['a stroke value', { ...OLDER.frame, stroke: { color: blue, width: -1 } }, '/stroke/width'],
    [
      'a line stroke dash before its arrows',
      { ...OLDER.line, stroke: { ...(OLDER.line!.stroke as Loose), dash: null }, startArrow: 'x' },
      '/stroke/dash',
    ],
    ['a line arrow after a valid stroke', { ...OLDER.line, startArrow: 'x' }, '/startArrow'],
  ];

  it.each(OLDER_FAILURES)(
    'fails %s at the path the document chain reports, at each older schema',
    (_name, node, at) => {
      for (const schemaVersion of [2, 3, 4, 5]) {
        const chain = holderRead(node, schemaVersion);
        expect(chain).toMatchObject({ ok: false, path: `/nodes/${node.id as string}${at}` });
        const { target, drawn } = empty();
        const before = text(target);
        expect(target.execute({ type: 'paste', text: fragmentAt(node, schemaVersion) })).toEqual({
          ok: false,
          code: chain.ok ? 'none' : chain.code,
          path: `/nodes/${node.id as string}${at}`,
        });
        expect(text(target)).toBe(before);
        expect(drawn()).toBe(0);
      }
    },
  );

  it('accepts the v6 forms at schema v6 and migrates sourceNodes too', () => {
    const { target } = empty();
    const v6 = { ...rect('r', ''), stroke: DASHED };
    expect(ok(target, { type: 'paste', text: fragmentAt(v6, 6) })).toHaveLength(1);
    // A copied instance with its carried source, written at v5: the carried symbol's v5 stroke
    // is migrated, and its v6 stroke fails at the key, at its `sourceNodes` path.
    const source = counted();
    ok(source.target, { type: 'copy', ids: ['i1'] });
    const body = JSON.parse(
      source.target.query({ type: 'clipboard' })!.slice(MARKER.length),
    ) as Body;
    expect(body.sources).toEqual(['s1']);
    const older: Body = {
      ...body,
      schemaVersion: 5,
      sourceNodes: {
        ...body.sourceNodes,
        s1: { ...body.sourceNodes.s1!, fill: black, stroke: { color: blue, width: 3 } },
        r3: { ...body.sourceNodes.r3!, fill: null, stroke: null },
      },
    };
    const into = empty();
    const [frame] = ok(into.target, { type: 'paste', text: marked(older) });
    const pastedFrame = into.target.query({ type: 'document' }).nodes[frame!] as Loose;
    expect(pastedFrame.type).toBe('frame');
    expect(pastedFrame.stroke).toEqual({
      color: blue,
      width: 3,
      cap: 'butt',
      join: 'round',
      miterLimit: 4,
      dash: null,
    });
    const failing = { ...older, sourceNodes: { ...older.sourceNodes, s1: body.sourceNodes.s1! } };
    const other = empty();
    expect(other.target.execute({ type: 'paste', text: marked(failing) })).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/sourceNodes/s1/fill/r',
    });
    expect(other.drawn()).toBe(0);
  });

  it('rejects schema v7 fragments and a fragment version 1 above schema v2', () => {
    const { target } = empty();
    const unsupported = { ok: false, code: 'document.unsupported-version', path: '/schemaVersion' };
    expect(target.execute({ type: 'paste', text: fragmentAt(rect('r', ''), 7) })).toEqual(
      unsupported,
    );
    expect(
      target.execute({
        type: 'paste',
        text: marked({
          fragmentVersion: 1,
          schemaVersion: 6,
          roots: ['r'],
          nodes: { r: rect('r', '') },
        }),
      }),
    ).toEqual(unsupported);
  });
});

describe('M4-U1 commands: v6 input and defaults (section 4.1)', () => {
  const editor = () =>
    createEditor({ document: JSON.parse(APPEARANCE), extensions: [starExtension] });

  it('defines DEFAULT_SHAPE_STROKE with a round join and DEFAULT_PATH_STROKE with dash null', () => {
    expect(DEFAULT_SHAPE_STROKE).toEqual({
      color: black,
      width: 1,
      cap: 'butt',
      join: 'round',
      miterLimit: 4,
      dash: null,
    });
    expect(DEFAULT_PATH_STROKE).toEqual({
      color: black,
      width: 1,
      cap: 'butt',
      join: 'miter',
      miterLimit: 4,
      dash: null,
    });
    expect(
      Object.isFrozen(DEFAULT_SHAPE_STROKE) && Object.isFrozen(DEFAULT_SHAPE_STROKE.color),
    ).toBe(true);
  });

  it('creates with paints and strokes, defaults the path stroke, and rejects the old shapes', () => {
    const target = editor();
    const created = target.execute({
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 10, height: 10 },
      fill: LINEAR,
      stroke: DEFAULT_SHAPE_STROKE,
    });
    expect(created.ok).toBe(true);
    const line = target.execute({ type: 'createLine', start: { x: 0, y: 0 }, end: { x: 5, y: 5 } });
    const document = target.query({ type: 'document' });
    expect(created.ok && document.nodes[created.ids[0]!]).toMatchObject({
      fill: LINEAR,
      stroke: DEFAULT_SHAPE_STROKE,
    });
    expect(line.ok && document.nodes[line.ids[0]!]).toMatchObject({ stroke: DEFAULT_PATH_STROKE });
    const oldShape = { color: black, width: 1 };
    const oldPath = { color: black, width: 1, cap: 'butt', join: 'miter', miterLimit: 4 };
    const frame = { x: 0, y: 0, width: 10, height: 10 };
    for (const [command, at] of [
      [{ type: 'createRectangle', frame, stroke: oldShape }, '/stroke/cap'],
      [{ type: 'createEllipse', frame, stroke: oldShape }, '/stroke/cap'],
      [{ type: 'createFrame', frame, stroke: oldShape }, '/stroke/cap'],
      [
        { type: 'createPath', verbs: ['move', 'line'], points: [0, 0, 1, 1], stroke: oldPath },
        '/stroke/dash',
      ],
      [
        { type: 'createLine', start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, stroke: oldPath },
        '/stroke/dash',
      ],
      [{ type: 'setNodeProps', id: 'r1', props: { stroke: oldShape } }, '/nodes/r1/stroke/cap'],
      [
        { type: 'setNodeProps', id: 'r1', props: { fill: { ...LINEAR, stops: [] } } },
        '/nodes/r1/fill/stops',
      ],
    ] as const) {
      expect(target.execute(command as unknown as Command)).toEqual({
        ok: false,
        code: 'document.invalid-field',
        path: at,
      });
    }
  });

  it('sets a gradient fill and a dashed stroke with setNodeProps as one undo step', () => {
    const target = editor();
    const before = serializeDocument(target.query({ type: 'document' }));
    const result = target.execute({
      type: 'setNodeProps',
      id: 'e1',
      props: { fill: LINEAR, stroke: DASHED },
    });
    expect(result).toEqual({ ok: true, ids: [] });
    const after = serializeDocument(target.query({ type: 'document' }));
    expect(target.query({ type: 'node', id: 'e1' })).toMatchObject({
      fill: LINEAR,
      stroke: DASHED,
    });
    expect(target.execute({ type: 'undo' }).ok).toBe(true);
    expect(serializeDocument(target.query({ type: 'document' }))).toBe(before);
    expect(target.execute({ type: 'redo' }).ok).toBe(true);
    expect(serializeDocument(target.query({ type: 'document' }))).toBe(after);
  });

  it('keeps container and instance opacity at 1 and gives text and instances no paint', () => {
    const target = editor();
    for (const id of ['f1', 'g1', 's1', 'i1']) {
      expect(target.execute({ type: 'setNodeProps', id, props: { opacity: 0.5 } })).toEqual({
        ok: false,
        code: 'document.invalid-field',
        path: `/nodes/${id}/opacity`,
      });
    }
    for (const id of ['t1', 'i1']) {
      for (const prop of ['fill', 'stroke']) {
        expect(target.execute({ type: 'setNodeProps', id, props: { [prop]: null } })).toEqual({
          ok: false,
          code: 'editor.invalid-command',
          path: `/props/${prop}`,
        });
      }
    }
  });
});

describe('M4-P2 stroke narrowing in the projector (the M4-A05 narrowing part)', () => {
  const unitTriangle: PathData = {
    verbs: ['move', 'line', 'line', 'close'],
    points: [0, 0, 1, 0, 0.5, 1],
    fillRule: 'nonzero',
  };
  const custom = () => unitTriangle;
  type Styled = Extract<RenderNodeSnapshot, { kind: 'primitive' | 'path' }>;
  const styled = (snapshots: Iterable<RenderNodeSnapshot>) =>
    [...snapshots].filter((node): node is Styled => node.kind !== 'container');

  it('writes primitive strokes as exactly { color, width } and path strokes with dash only when set', () => {
    const document = parsed(APPEARANCE);
    const nodes = projectPage(document, 'page-1', custom).nodes;
    const style = (id: string) => (nodes.get(id) as Styled).style;
    // From M4-U2, r1 (miter join, dash) is a path (M4-P3); r2 and the solid e1 stay primitives.
    expect(style('r2').stroke).toEqual({ color: black, width: 1 });
    expect(Object.keys(style('r2').stroke!)).toEqual(['color', 'width']);
    expect(Object.keys(style('e1').stroke!)).toEqual(['color', 'width']);
    expect(nodes.get('r1')!.kind).toBe('path');
    // A dashed path stroke keeps its dash; a solid one has no `dash` key (M4-Q14 (a)). From
    // M4-U2 its gradient is composed in the 100 × 100 box (M4-P1).
    const p1Color = (document.nodes.p1 as { stroke: { color: object } }).stroke.color;
    expect(style('p1').stroke).toEqual({
      color: { ...p1Color, transform: [50, 0, 0, 50, 50, 50] },
      width: 3,
      cap: 'square',
      join: 'bevel',
      miterLimit: 1,
      dash: { pattern: [0, 8], phase: 100 },
    });
    expect(style('c1').stroke).toMatchObject({ dash: { pattern: [4], phase: 2 } });
    // l1 has a triangle head: fill mode, one outline in the stroke paint (M4-P5 is U2 work).
    expect(style('l1')).toMatchObject({ fill: { r: 0, g: 0, b: 1, a: 1 }, stroke: null });
    // Every frame and instance border is a primitive with a two-key stroke.
    for (const node of styled(nodes.values())) {
      if (node.kind === 'primitive' && node.style.stroke !== null) {
        expect(Object.keys(node.style.stroke), node.id).toEqual(['color', 'width']);
      }
    }
    const borders = styled(nodes.values()).filter(
      (node) => node.id.endsWith('\u0000border') && node.style.stroke !== null,
    );
    expect(borders.map((node) => node.id.split('\u0000')[0]).sort()).toEqual(['f1', 'i1']);
    // The instance border takes its source's stroke; its miter join and dash make it a path
    // from M4-U2 (M4-P3), with the full stroke.
    expect(nodes.get('i1\u0000border')!.kind).toBe('path');
    expect(style('i1\u0000border').stroke).toEqual({
      color: { r: 0, g: 0.5, b: 0, a: 1 },
      width: 3,
      cap: 'butt',
      join: 'miter',
      miterLimit: 4,
      dash: { pattern: [6, 3], phase: 1.5 },
    });
  });

  it('keeps a dashed line without a head in stroke mode with its dash', () => {
    const value = JSON.parse(APPEARANCE) as Json;
    value.nodes.l1!.endArrow = 'none';
    const nodes = projectPage(parsed(JSON.stringify(value)), 'page-1', custom).nodes;
    expect((nodes.get('l1') as Styled).style.stroke).toEqual({
      color: blue,
      width: 6,
      cap: 'round',
      join: 'miter',
      miterLimit: 10,
      dash: { pattern: [12, 18, 6], phase: -3.5 },
    });
  });

  it('isolates a gradient frame with its children and a gradient source with every instance (note 7)', () => {
    // Every renderer feature but gradients, so only the paints are rejected (U2 and U4 lift it).
    const renderer = new RecordingRenderer('supported', {
      dashes: 'supported',
      groupOpacity: 'supported',
      textNodes: 'supported',
    });
    const target = createEditor({ document: JSON.parse(APPEARANCE), extensions: [starExtension] });
    const events: EditorEvent[] = [];
    target.subscribe((event) => events.push(event));
    target.attachRenderer(renderer);
    const diagnostics = () => events.filter((event) => event.type === 'diagnostic');
    expect(diagnostics()).toEqual([
      {
        type: 'diagnostic',
        code: 'editor.renderer-unsupported',
        reason: 'unsupported-feature',
        nodeIds: ['e1', 'e2', 'f1', 'i1', 'p1', 'r1'],
      },
    ]);
    const held = new Set(
      renderer.mirror.readRetainedScene()!.nodes.map((node) => documentIdOf(node.id)),
    );
    // The frame is one isolation unit: its solid child r2 and text t1 go with it; a gradient
    // anywhere in the source s1 (its fill, r3) leaves out the whole instance i1.
    for (const id of ['f1', 'r2', 't1', 'i1']) expect(held.has(id), id).toBe(false);
    for (const id of ['l1', 'c1', 'g1']) expect(held.has(id), id).toBe(true);
    // Each move of an excluded gradient node releases it, and it is sent and rejected again:
    // one rejected set and one diagnostic per move (S2, until U4 enables gradients).
    for (const step of [1, 2]) {
      events.length = 0;
      const sets = renderer.calls.length;
      expect(target.execute({ type: 'nudgeNodes', ids: ['r1'], dx: step, dy: 0 }).ok).toBe(true);
      expect(diagnostics(), `move ${step}`).toEqual([
        {
          type: 'diagnostic',
          code: 'editor.renderer-unsupported',
          reason: 'unsupported-feature',
          nodeIds: ['r1'],
        },
      ]);
      const rejected = renderer.calls
        .slice(sets)
        .filter((call) => call.method === 'applyChanges' && call.result.status === 'invalid-scene');
      expect(rejected, `move ${step}`).toHaveLength(1);
    }
  });

  it('applies every page of appearance.v6.json and every v6 migration with every renderer feature on', () => {
    const files = [
      'm4-appearance/appearance.v6.json',
      ...fixturesAt(6).filter(
        (file) => file.includes('/migrated/') && !file.includes('.envelope.'),
      ),
    ];
    const statuses = files.flatMap((file) => {
      const document = parsed(read(file));
      return document.pages.map((page) => {
        const projection = projectPage(document, page.id, custom);
        const mirror = new RetainedSceneMirror(undefined, {
          pathNodes: 'supported',
          pathFills: 'supported',
          pathStrokes: 'supported',
          clips: 'supported',
          paints: 'gradient',
          dashes: 'supported',
          groupOpacity: 'supported',
          textNodes: 'supported',
        });
        const result = mirror.replaceSnapshot({
          identity: { documentId: document.id, pageId: page.id },
          revision: 1,
          nodes: [...projection.nodes.values()],
          rootOrder: projection.rootOrder,
        });
        const reason = result.status === 'invalid-scene' ? ` ${result.reason}` : '';
        return `${file} ${page.id} ${result.status}${reason}`;
      });
    });
    // clip-33 is the known exception: its expansion nests one clip past the renderer's clip
    // depth (M7-S5), which editor-core isolates (M7-U2).
    expect(statuses.filter((line) => !line.endsWith(' applied'))).toEqual([
      'm4-appearance/migrated/clip-33.v6.json p invalid-scene unsupported-feature',
    ]);
    expect(statuses.length).toBeGreaterThan(files.length);
  });

  it.each(
    fixturesAt(6).filter((file) => file.includes('/migrated/') && !file.includes('.envelope.')),
  )('projects the migrated %s with no dash key and two-key primitive strokes', (file) => {
    const document = parsed(read(file));
    for (const page of document.pages) {
      const nodes = projectPage(document, page.id, custom).nodes;
      for (const node of styled(nodes.values())) {
        const stroke = node.style.stroke as Loose | null;
        if (stroke === null) continue;
        expect(Object.hasOwn(stroke, 'dash'), node.id).toBe(false);
        if (node.kind === 'primitive') expect(Object.keys(stroke)).toEqual(['color', 'width']);
        else expect(Object.keys(stroke)).toEqual(['color', 'width', 'cap', 'join', 'miterLimit']);
      }
    }
  });
});
