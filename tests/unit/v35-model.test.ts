// V-35 contract (docs/plans/viz-v35-fills-blend-contract.md), V35-A01: `fills` and `blendMode`
// in schema v8: the v7 to v8 migration, the defaults, the v8 reader's legacy `fill`, the round
// trip and the S3 rejections.
import {
  MAX_FILLS,
  migrateV7toV8,
  parseDocument,
  serializeDocument,
  validateAnyDocument,
  validateDocument,
  validateNode,
  type DocumentV7,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';

type Json = Record<string, unknown>;

const START = { horizontal: 'start', vertical: 'start' };
const red = { r: 1, g: 0, b: 0, a: 1 };
const blue = { r: 0, g: 0, b: 1, a: 1 };
const frame = { x: 0, y: 0, width: 10, height: 10 };

function base(id: string, parent: string, type: string): Json {
  return {
    id,
    name: id,
    parent,
    frame,
    rotation: 0,
    constraints: START,
    opacity: 1,
    visible: true,
    type,
  };
}

/** A v7 document: a rectangle with a fill, an ellipse without, a group, a mask group and a frame. */
function v7(): Json {
  const nodes: Record<string, Json> = {
    r: { ...base('r', 'p', 'rectangle'), cornerRadii: [0, 0, 0, 0], fill: red, stroke: null },
    e: { ...base('e', 'g', 'ellipse'), fill: null, stroke: null },
    g: { ...base('g', 'p', 'group'), children: ['e'] },
    m: { ...base('m', 'p', 'maskGroup'), children: ['k', 'l'] },
    k: {
      ...base('k', 'm', 'path'),
      path: {
        verbs: ['move', 'line', 'line', 'close'],
        points: [0, 0, 1, 0, 1, 1],
        fillRule: 'nonzero',
      },
      fill: red,
      stroke: null,
    },
    l: {
      ...base('l', 'm', 'line'),
      points: [0, 0, 1, 1],
      stroke: { color: red, width: 1, cap: 'butt', join: 'miter', miterLimit: 4, dash: null },
      startArrow: 'none',
      endArrow: 'none',
    },
    f: { ...base('f', 'p', 'frame'), children: [], fill: blue, stroke: null },
  };
  for (const node of Object.values(nodes)) node.effects = [];
  return {
    schemaVersion: 7,
    id: 'd',
    pages: [{ id: 'p', name: 'P', children: ['r', 'g', 'm', 'f'] }],
    nodes,
  };
}

const fill = (paint: unknown, extra: Json = {}) => ({
  paint,
  visible: true,
  opacity: 1,
  blendMode: 'normal',
  ...extra,
});

function parsed(value: unknown) {
  const result = validateAnyDocument(value);
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}

function v8(): Json {
  return JSON.parse(serializeDocument(parsed(v7()))) as Json;
}

function failsAt(value: unknown, path: string): void {
  expect(validateDocument(value)).toEqual({ ok: false, code: 'document.invalid-field', path });
}

describe('V35-A01 migration and defaults (V35-S1)', () => {
  it('turns `fill` into `fills` and sets each type’s default mode', () => {
    for (const result of [
      validateAnyDocument(v7()),
      parseDocument(JSON.stringify(v7())),
      migrateV7toV8(v7() as unknown as DocumentV7),
    ]) {
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const nodes = result.document.nodes as Record<string, Json>;
      expect(nodes.r!.fills).toEqual([fill(red)]);
      expect(nodes.e!.fills).toEqual([]);
      expect(nodes.f!.fills).toEqual([fill(blue)]);
      expect('fill' in nodes.r!).toBe(false);
      expect('fills' in nodes.l!).toBe(false);
      expect(
        Object.fromEntries(Object.entries(nodes).map(([id, node]) => [id, node.blendMode])),
      ).toEqual({
        r: 'normal',
        e: 'normal',
        g: 'passThrough',
        m: 'passThrough',
        k: 'normal',
        l: 'normal',
        f: 'passThrough',
      });
    }
  });

  it('writes `fills` in `fill`’s place and `blendMode` before `effects`, and round trips', () => {
    const document = parsed(v7());
    const text = serializeDocument(document);
    const raw = JSON.parse(text) as { nodes: Record<string, Json> };
    expect(Object.keys(raw.nodes.r!)).toEqual([
      'id',
      'name',
      'parent',
      'frame',
      'rotation',
      'constraints',
      'opacity',
      'visible',
      'type',
      'cornerRadii',
      'fills',
      'stroke',
      'blendMode',
      'effects',
    ]);
    expect(Object.keys((raw.nodes.r!.fills as Json[])[0]!)).toEqual([
      'paint',
      'visible',
      'opacity',
      'blendMode',
    ]);
    const again = parseDocument(text);
    expect(again.ok && serializeDocument(again.document)).toBe(text);
  });

  it('reads a legacy `fill` and a missing `blendMode` at v8 until release', () => {
    const value = v8();
    const nodes = value.nodes as Record<string, Json>;
    const { fills: _fills, blendMode: _mode, ...legacy } = nodes.r!;
    void _fills;
    void _mode;
    nodes.r = { ...legacy, fill: red };
    const document = parsed(value);
    expect((document.nodes.r as Json).fills).toEqual([fill(red)]);
    expect((document.nodes.r as Json).blendMode).toBe('normal');
  });

  it('rejects `fill` together with `fills`, at `fill`', () => {
    const value = v8();
    (value.nodes as Record<string, Json>).r!.fill = red;
    failsAt(value, '/nodes/r/fill');
  });
});

describe('V35-A01 the S3 rules', () => {
  const at = (edit: (nodes: Record<string, Json>) => void, path: string) => {
    const value = v8();
    edit(value.nodes as Record<string, Json>);
    failsAt(value, path);
  };

  it('accepts 16 fills, every mode on a leaf fill, and passThrough on containers', () => {
    const value = v8();
    const nodes = value.nodes as Record<string, Json>;
    nodes.r!.fills = Array.from({ length: MAX_FILLS }, (_, i) =>
      fill(red, { opacity: i / 15, visible: i % 2 === 0 }),
    );
    nodes.r!.blendMode = 'colorDodge';
    nodes.g!.blendMode = 'normal';
    nodes.f!.blendMode = 'multiply';
    expect(validateDocument(value).ok).toBe(true);
  });

  it('rejects 17 fills, a bad opacity, an unknown mode, and passThrough on a leaf or a fill', () => {
    at(
      (n) => (n.r!.fills = Array.from({ length: MAX_FILLS + 1 }, () => fill(red))),
      '/nodes/r/fills',
    );
    at((n) => (n.r!.fills = [fill(red, { opacity: 1.5 })]), '/nodes/r/fills/0/opacity');
    at((n) => (n.r!.fills = [fill(red, { opacity: Number.NaN })]), '/nodes/r/fills/0/opacity');
    at((n) => (n.r!.fills = [fill(red, { visible: 1 })]), '/nodes/r/fills/0/visible');
    at(
      (n) => (n.r!.fills = [fill(red, { blendMode: 'passThrough' })]),
      '/nodes/r/fills/0/blendMode',
    );
    at((n) => (n.r!.fills = [fill({ ...red, a: 2 })]), '/nodes/r/fills/0/paint/a');
    at((n) => (n.r!.fills = [{ ...fill(red), extra: 1 }]), '/nodes/r/fills/0/extra');
    at((n) => (n.r!.blendMode = 'passThrough'), '/nodes/r/blendMode');
    at((n) => (n.r!.blendMode = 'plusLighter'), '/nodes/r/blendMode');
    at((n) => (n.g!.blendMode = 'linearBurn'), '/nodes/g/blendMode');
  });

  it('rejects `fills` on a type without fills', () => {
    at((n) => (n.l!.fills = []), '/nodes/l/fills');
    at((n) => (n.g!.fills = []), '/nodes/g/fills');
  });

  it('validateNode reads one node with the same rules', () => {
    const nodes = v8().nodes as Record<string, Json>;
    expect(validateNode(nodes.r!)).toEqual({ ok: true, node: nodes.r });
    expect(validateNode({ ...nodes.r!, blendMode: 'passThrough' })).toMatchObject({
      ok: false,
      path: '/blendMode',
    });
  });
});
