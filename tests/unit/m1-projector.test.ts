import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  RenderChangeSet,
  RenderNodeSnapshot,
  SceneApplyResult,
  ScenePathGeometry,
} from '@vector-studio/contracts';
import type { DocumentV2, NodeV2 } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  starExtension,
  type Command,
  type Editor,
  type EditorEvent,
} from '../../packages/editor-core/src/index.js';
import {
  lineContent,
  projectPage,
  type CustomProjection,
} from '../../packages/editor-core/src/projector.js';
import { RecordingRenderer } from '../support/p5-recording-renderer.js';

// MVP M1-U3 (M1 contract, section 5): the projector maps nested containers, frames, ellipses and
// lines onto the scene surface, keeps page identity and isolates rejected subtrees. M1-A09.

const root = path.resolve(import.meta.dirname, '../..');
const START = { horizontal: 'start', vertical: 'start' } as const;
const black = { r: 0, g: 0, b: 0, a: 1 };
const white = { r: 1, g: 1, b: 1, a: 1 };
const red = { r: 1, g: 0, b: 0, a: 1 };
const C = '\u0000content';
const BG = '\u0000background';
const BD = '\u0000border';

const star = starExtension.nodeTypes![0]!;
/** The star extension's geometry, as the editor's registry gives it to the projector. */
const custom: CustomProjection = (node) =>
  node.type === 'custom' && node.customType === 'ext.star'
    ? star.toScene(node.data, node.frame)
    : null;

function editor(document?: unknown): Editor {
  return createEditor({ ids: createCounterIdSource('n'), document, extensions: [starExtension] });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function documentOf(target: Editor): DocumentV2 {
  return target.query({ type: 'document' });
}

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(root, 'tests/fixtures/m1-model', name), 'utf8'));
}

type Fields = Record<string, unknown>;

/** A v2 node with defaults; `extra` holds the type's fields. */
function node(id: string, parent: string, type: NodeV2['type'], extra: Fields = {}): Fields {
  return {
    id,
    name: id,
    parent,
    frame: { x: 0, y: 0, width: 10, height: 10 },
    rotation: 0,
    constraints: START,
    opacity: 1,
    visible: true,
    type,
    ...(type === 'rectangle' ? { cornerRadii: [0, 0, 0, 0], fill: red, stroke: null } : {}),
    ...(type === 'ellipse' ? { fill: red, stroke: null } : {}),
    ...(type === 'frame' ? { fill: white, stroke: null } : {}),
    ...(type === 'path'
      ? {
          path: {
            verbs: ['move', 'line', 'line', 'close'],
            points: [0, 0, 1, 0, 0, 1],
            fillRule: 'nonzero',
          },
          fill: black,
          stroke: null,
        }
      : {}),
    ...extra,
  };
}

function doc(children: readonly string[], nodes: readonly Fields[], pages: Fields[] = []) {
  return {
    schemaVersion: 2,
    id: 'doc',
    pages: [{ id: 'p', name: 'Page 1', children }, ...pages],
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id as string, entry])),
  };
}

/** The renderer holds exactly the projection of the active page minus the `omit` subtrees. */
function expectSynchronized(
  target: Editor,
  renderer: RecordingRenderer,
  omit: readonly string[] = [],
) {
  const document = documentOf(target);
  const page = target.query({ type: 'activePage' });
  const projection = projectPage(document, page, custom, new Set(omit));
  const scene = renderer.mirror.readRetainedScene();
  expect(scene).not.toBeNull();
  expect(scene!.version.identity).toEqual({ documentId: document.id, pageId: page });
  expect(scene!.rootOrder).toEqual(projection.rootOrder);
  expect(scene!.nodes.length).toBe(projection.nodes.size);
  for (const [id, snapshot] of projection.nodes) expect(scene!.getNode(id)).toEqual(snapshot);
}

function attached(
  document?: unknown,
  renderer = new RecordingRenderer(),
): { target: Editor; renderer: RecordingRenderer; events: EditorEvent[] } {
  const target = editor(document);
  const events: EditorEvent[] = [];
  target.subscribe((event) => events.push(event));
  target.attachRenderer(renderer);
  return { target, renderer, events };
}

function diagnostics(events: readonly EditorEvent[]) {
  return events.filter((event) => event.type === 'diagnostic');
}

function sceneNode(renderer: RecordingRenderer, id: string): RenderNodeSnapshot {
  const found = renderer.mirror.readRetainedScene()!.getNode(id);
  if (found === undefined) throw new Error(`no scene node ${JSON.stringify(id)}`);
  return found;
}

/** Scene calls (no camera) from index `from` on. */
function sceneCalls(renderer: RecordingRenderer, from = 0) {
  return renderer.calls.slice(from).filter((call) => call.method !== 'setCamera');
}

/** Rejects, while `when` holds, every change set that inserts or updates a matching node. */
function rejecting(
  renderer: RecordingRenderer,
  match: (node: RenderNodeSnapshot) => boolean,
): { block: boolean } {
  const state = { block: true };
  const apply = renderer.applyChanges.bind(renderer);
  renderer.applyChanges = (changes: RenderChangeSet): SceneApplyResult => {
    if (state.block && [...changes.inserted, ...changes.updated].some(match)) {
      const result: SceneApplyResult = {
        status: 'invalid-scene',
        reason: 'invalid-value',
        current: renderer.getSynchronizationState().current,
      };
      renderer.calls.push({ method: 'applyChanges', input: changes, result });
      return result;
    }
    return apply(changes);
  };
  return state;
}

/** Subpaths of a path as point lists (control points included). */
function subpaths(geometry: ScenePathGeometry): number[][][] {
  const out: number[][][] = [];
  let index = 0;
  for (const verb of geometry.verbs) {
    const count = verb === 'cubic' ? 3 : verb === 'close' ? 0 : 1;
    if (verb === 'move') out.push([]);
    for (let i = 0; i < count; i += 1) {
      out.at(-1)!.push([geometry.points[index]!, geometry.points[index + 1]!]);
      index += 2;
    }
  }
  return out;
}

/** The shoelace area of a closed control polygon (positive counter-clockwise on screen, y down). */
function area(points: readonly number[][]): number {
  let sum = 0;
  points.forEach(([x, y], i) => {
    const [nx, ny] = points[(i + 1) % points.length]!;
    sum += x! * ny! - nx! * y!;
  });
  return sum / 2;
}

function expectPoints(actual: readonly number[], expected: readonly number[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) =>
    expect(Math.abs(value - expected[index]!)).toBeLessThanOrEqual(
      1e-12 * Math.max(1, Math.abs(expected[index]!)),
    ),
  );
}

/** A line node from (0, 0) to (100, 0) in its frame, stroke width 2. */
function line(
  startArrow: string,
  endArrow: string,
  cap: 'butt' | 'round' | 'square' = 'butt',
  overrides: Fields = {},
): NodeV2 {
  return node('l', 'p', 'line', {
    frame: { x: 0, y: 0, width: 100, height: 0 },
    points: [0, 0, 1, 0],
    stroke: { color: black, width: 2, cap, join: 'miter', miterLimit: 4 },
    startArrow,
    endArrow,
    ...overrides,
  }) as unknown as NodeV2;
}

describe('M1-A09 projection of the v2 fixtures', () => {
  it('every v2 fixture and page is accepted by the scene mirror as its projection', async () => {
    for (const name of ['empty.v2.json', 'shapes.v2.json', 'ext-star.v2.json', 'containers.json']) {
      const { target, renderer, events } = attached(await fixture(name));
      for (const page of documentOf(target).pages) {
        ok(target, { type: 'setActivePage', id: page.id });
        expectSynchronized(target, renderer);
      }
      expect(diagnostics(events)).toEqual([]);
      expect(sceneCalls(renderer).every((call) => call.result.status === 'applied')).toBe(true);
    }
  });

  it('θ = 0 transforms are exactly the P5 translation, others follow section 5', async () => {
    const { target, renderer } = attached(await fixture('containers.json'));
    const document = documentOf(target);
    const page = projectPage(document, 'page-1', custom).units;
    for (const entry of page.map((id) => document.nodes[id]!)) {
      const scene = sceneNode(renderer, entry.id);
      const { x, y, width: w, height: h } = entry.frame;
      if (entry.rotation === 0) {
        [1, 0, 0, 1, x, y].forEach((value, i) =>
          expect(Object.is(scene.transform[i], value)).toBe(true),
        );
      } else {
        const t = entry.rotation;
        expect(scene.transform).toEqual([
          Math.cos(t),
          Math.sin(t),
          -Math.sin(t),
          Math.cos(t),
          x + w / 2 - ((w / 2) * Math.cos(t) - (h / 2) * Math.sin(t)),
          y + h / 2 - ((w / 2) * Math.sin(t) + (h / 2) * Math.cos(t)),
        ]);
      }
    }
    // Parent-local composition: r3 (0.5) inside g1 (−1.5) turns by −1 on the page.
    const [ga, gb, gc, gd] = sceneNode(renderer, 'g1').transform;
    const [ra, rb] = sceneNode(renderer, 'r3').transform;
    expect(Math.atan2(gb * ra + gd * rb, ga * ra + gc * rb)).toBeCloseTo(-1, 12);
    expect(sceneNode(renderer, 'r3').parentId).toBe('g1');
    expect(sceneNode(renderer, 'g1').parentId).toBeNull();
  });

  it('a frame is an outer container, a clipped content container, a background and a border', () => {
    const { renderer } = attached(
      doc(
        ['f'],
        [
          node('f', 'p', 'frame', {
            frame: { x: 10, y: 20, width: 100, height: 50 },
            children: ['r'],
            stroke: { color: black, width: 2 },
          }),
          node('r', 'f', 'rectangle', { frame: { x: 5, y: 5, width: 10, height: 10 } }),
        ],
      ),
    );
    const scene = renderer.mirror.readRetainedScene()!;
    expect(scene.rootOrder).toEqual(['f']);
    const identity = { transform: [1, 0, 0, 1, 0, 0], visible: true, opacity: 1 };
    const rectangle = { kind: 'rectangle', width: 100, height: 50, cornerRadii: [0, 0, 0, 0] };
    expect(scene.nodes.map((entry) => entry.id).sort()).toEqual([
      'f',
      `f${BG}`,
      `f${BD}`,
      `f${C}`,
      'r',
    ]);
    expect(scene.getNode('f')).toEqual({
      id: 'f',
      parentId: null,
      transform: [1, 0, 0, 1, 10, 20],
      visible: true,
      opacity: 1,
      kind: 'container',
      children: [`f${C}`, `f${BD}`],
      clip: null,
    });
    expect(scene.getNode(`f${C}`)).toEqual({
      id: `f${C}`,
      parentId: 'f',
      ...identity,
      kind: 'container',
      children: [`f${BG}`, 'r'],
      clip: { kind: 'rect', x: 0, y: 0, width: 100, height: 50 },
    });
    expect(scene.getNode(`f${BG}`)).toEqual({
      id: `f${BG}`,
      parentId: `f${C}`,
      ...identity,
      kind: 'primitive',
      geometry: rectangle,
      style: { fill: white, stroke: null },
    });
    expect(scene.getNode(`f${BD}`)).toEqual({
      id: `f${BD}`,
      parentId: 'f',
      ...identity,
      kind: 'primitive',
      geometry: rectangle,
      style: { fill: null, stroke: { color: black, width: 2 } },
    });
    expect(scene.getNode('r')).toMatchObject({ parentId: `f${C}`, transform: [1, 0, 0, 1, 5, 5] });
  });

  it('an unfilled, unstroked frame has neither background nor border', () => {
    const { renderer } = attached(
      doc(['f'], [node('f', 'p', 'frame', { fill: null, children: [] })]),
    );
    const scene = renderer.mirror.readRetainedScene()!;
    expect(scene.nodes.map((entry) => entry.id).sort()).toEqual(['f', `f${C}`]);
    expect(scene.getNode('f')).toMatchObject({ children: [`f${C}`] });
    expect(scene.getNode(`f${C}`)).toMatchObject({ children: [] });
  });

  it('groups and mask groups are containers with null and mask clips, the source first', () => {
    const { renderer } = attached(
      doc(
        ['g'],
        [
          node('g', 'p', 'group', {
            frame: { x: 0, y: 0, width: 50, height: 50 },
            children: ['m'],
          }),
          node('m', 'g', 'maskGroup', {
            frame: { x: 10, y: 10, width: 10, height: 10 },
            children: ['s', 'e'],
          }),
          node('s', 'm', 'path'),
          node('e', 'm', 'ellipse', { frame: { x: 0, y: 0, width: 10, height: 5 } }),
        ],
      ),
    );
    const scene = renderer.mirror.readRetainedScene()!;
    expect(scene.getNode('g')).toMatchObject({ kind: 'container', children: ['m'], clip: null });
    expect(scene.getNode('m')).toMatchObject({
      kind: 'container',
      parentId: 'g',
      transform: [1, 0, 0, 1, 10, 10],
      children: ['s', 'e'],
      clip: { kind: 'mask' },
    });
    expect(scene.getNode('s')).toMatchObject({ kind: 'path', parentId: 'm' });
    expect(scene.getNode('e')).toEqual({
      id: 'e',
      parentId: 'm',
      transform: [1, 0, 0, 1, 0, 0],
      visible: true,
      opacity: 1,
      kind: 'primitive',
      geometry: { kind: 'ellipse', width: 10, height: 5 },
      style: { fill: red, stroke: null },
    });
  });

  it('clamps rectangle corner radii by the section 5 factor', () => {
    const { renderer } = attached(
      doc(
        ['r'],
        [
          node('r', 'p', 'rectangle', {
            frame: { x: 0, y: 0, width: 40, height: 10 },
            cornerRadii: [10, 30, 0, 0],
          }),
        ],
      ),
    );
    // f = min(1, 40/40, 40/0 skipped, 10/10, 10/30) = 1/3.
    expect(sceneNode(renderer, 'r')).toMatchObject({
      geometry: { cornerRadii: [10 * (10 / 30), 30 * (10 / 30), 0, 0] },
    });
  });
});

describe('M1-A09 line projection', () => {
  it('stroke mode: the segment, then each line arrow as an open polyline, P0 end first', () => {
    const content = lineContent(line('line', 'line') as never);
    expect(content.style).toEqual({
      fill: null,
      stroke: { color: black, width: 2, cap: 'butt', join: 'miter', miterLimit: 4 },
    });
    expect(content.geometry).toEqual({
      kind: 'path',
      verbs: ['move', 'line', 'move', 'line', 'line', 'move', 'line', 'line'],
      points: [0, 0, 100, 0, 8, 4, 0, 0, 8, -4, 92, 4, 100, 0, 92, -4],
      fillRule: 'nonzero',
    });
    expect(lineContent(line('none', 'line') as never).geometry.points).toEqual([
      0, 0, 100, 0, 92, 4, 100, 0, 92, -4,
    ]);
  });

  it('no stroke, width 0 or zero length: stroke mode without arrowheads', () => {
    const plain = (overrides: Fields) =>
      lineContent(line('triangle', 'triangle', 'butt', overrides) as never);
    const segment = {
      kind: 'path',
      verbs: ['move', 'line'],
      points: [0, 0, 100, 0],
      fillRule: 'nonzero',
    };
    expect(plain({ stroke: null })).toEqual({
      geometry: segment,
      style: { fill: null, stroke: null },
    });
    const thin = { color: black, width: 0, cap: 'butt', join: 'miter', miterLimit: 4 };
    expect(plain({ stroke: thin })).toEqual({
      geometry: segment,
      style: { fill: null, stroke: thin },
    });
    expect(plain({ points: [0.5, 0, 0.5, 0] }).geometry).toEqual({
      ...segment,
      points: [50, 0, 50, 0],
    });
  });

  it('fill mode: square cap shaft, line-head rectangles, then the triangle head', () => {
    const content = lineContent(line('line', 'triangle', 'square') as never);
    expect(content.style).toEqual({ fill: black, stroke: null });
    const g = content.geometry;
    expect(g.fillRule).toBe('nonzero');
    const quad = ['move', 'line', 'line', 'line', 'close'];
    expect(g.verbs).toEqual([...quad, ...quad, ...quad, 'move', 'line', 'line', 'close']);
    // Line head rectangles for the base corners C = (8, ±4): m = (2, ±1)/√5, q = (∓1, 2)/√5.
    const r = Math.sqrt(5);
    const rect = (cx: number, cy: number, sign: number) => {
      const q = [(-sign * 1) / r, 2 / r];
      return [-q[0]!, -q[1]!, cx - q[0]!, cy - q[1]!, cx + q[0]!, cy + q[1]!, q[0]!, q[1]!];
    };
    expectPoints(g.points, [
      // Shaft from S0 = P0 extended by w/2 to S1 = B1 = (92, 0).
      -1,
      -1,
      92,
      -1,
      92,
      1,
      -1,
      1,
      ...rect(8, 4, 1),
      ...rect(8, -4, -1),
      // Triangle at P1: T, B + 2w·n, B − 2w·n.
      100,
      0,
      92,
      4,
      92,
      -4,
    ]);
    for (const piece of subpaths(g)) expect(area(piece)).toBeGreaterThan(0);
  });

  it('fill mode: triangle at P0, round cap half disc at P1 with κ = 0.5523', () => {
    const g = lineContent(line('triangle', 'none', 'round') as never).geometry;
    expect(g.verbs).toEqual([
      'move',
      'line',
      'line',
      'line',
      'close',
      'move',
      'cubic',
      'cubic',
      'close',
      'move',
      'line',
      'line',
      'close',
    ]);
    const k = 0.5523;
    expectPoints(g.points, [
      8,
      -1,
      100,
      -1,
      100,
      1,
      8,
      1,
      // E = (100, 0), u = (1, 0), N = −n = (0, −1), w/2 = 1.
      100,
      -1,
      100 + k,
      -1,
      101,
      -k,
      101,
      0,
      101,
      k,
      100 + k,
      1,
      100,
      1,
      // Triangle at P0: T, B − 2w·n, B + 2w·n.
      0,
      0,
      8,
      -4,
      8,
      4,
    ]);
    for (const piece of subpaths(g)) expect(area(piece)).toBeGreaterThan(0);
  });

  it('fill mode: round caps at both non-triangle ends, line head at P1', () => {
    const g = lineContent(line('none', 'line', 'round') as never).geometry;
    // Stroke mode: a line head alone keeps the stroke.
    expect(g.verbs).toEqual(['move', 'line', 'move', 'line', 'line']);
    const both = lineContent(
      line('none', 'triangle', 'round', { points: [0, 0, 1, 0] }) as never,
    ).geometry;
    // Shaft, then the P0 half disc (N = n = (0, 1), u = (−1, 0)), then the P1 triangle.
    const k = 0.5523;
    expectPoints(both.points.slice(8, 22), [0, 1, -k, 1, -1, k, -1, 0, -1, -k, -k, -1, 0, -1]);
    for (const piece of subpaths(both)) expect(area(piece)).toBeGreaterThan(0);
  });

  it('fill mode omits the shaft and its caps when the heads overlap', () => {
    const g = lineContent(
      line('triangle', 'triangle', 'round', {
        frame: { x: 0, y: 0, width: 10, height: 0 },
      }) as never,
    ).geometry;
    expect(g.verbs).toEqual(['move', 'line', 'line', 'close', 'move', 'line', 'line', 'close']);
    expect(g.points).toEqual([0, 0, 8, -4, 8, 4, 10, 0, 2, 4, 2, -4]);
  });

  it('a projected line carries its transform, visibility and opacity', () => {
    const { renderer } = attached(
      doc(
        ['l'],
        [
          {
            ...line('none', 'triangle'),
            frame: { x: 5, y: 6, width: 100, height: 0 },
            opacity: 0.5,
          },
        ],
      ),
    );
    expect(sceneNode(renderer, 'l')).toMatchObject({
      kind: 'path',
      parentId: null,
      transform: [1, 0, 0, 1, 5, 6],
      opacity: 0.5,
      style: { fill: black, stroke: null },
    });
  });
});

describe('M1-A09 synchronization', () => {
  it('moveNodes into a rotated group sends a set the mirror accepts', async () => {
    const { target, renderer, events } = attached(await fixture('containers.json'));
    const from = renderer.calls.length;
    ok(target, { type: 'moveNodes', ids: ['e1', 'l1'], parent: 'g1', index: 1 });
    const calls = sceneCalls(renderer, from);
    expect(calls.map((call) => [call.method, call.result.status])).toEqual([
      ['applyChanges', 'applied'],
    ]);
    expect(sceneNode(renderer, 'e1').parentId).toBe('g1');
    expectSynchronized(target, renderer);
    expect(diagnostics(events)).toEqual([]);
  });

  it('a frame stroke toggle with a visibility change in one command is one accepted set', async () => {
    const { target, renderer } = attached(await fixture('containers.json'));
    const stroke = { color: black, width: 1 };
    let from = renderer.calls.length;
    ok(target, { type: 'setNodeProps', id: 'f1', props: { stroke: null, visible: false } });
    let [call] = sceneCalls(renderer, from);
    expect(call!.result.status).toBe('applied');
    if (call!.method !== 'applyChanges') throw new Error('expected a change set');
    expect(call!.input.removed).toEqual([`f1${BD}`]);
    expect(call!.input.updated.map((entry) => entry.id)).toEqual(['f1']);
    expect(call!.input.updated[0]).toMatchObject({ visible: false, children: [`f1${C}`] });
    expect(call!.input.orders).toEqual([]);
    expectSynchronized(target, renderer);

    from = renderer.calls.length;
    ok(target, {
      type: 'setNodeProps',
      id: 'f1',
      props: { stroke, visible: true, fill: null },
    });
    [call] = sceneCalls(renderer, from);
    expect(call!.result.status).toBe('applied');
    if (call!.method !== 'applyChanges') throw new Error('expected a change set');
    expect(call!.input.inserted.map((entry) => entry.id)).toEqual([`f1${BD}`]);
    expect(call!.input.removed).toEqual([`f1${BG}`]);
    expect(call!.input.updated.map((entry) => entry.id)).toEqual(['f1', `f1${C}`]);
    expectSynchronized(target, renderer);
  });

  it('a renderer without a fill port rejects the mask source: its mask group is left out', async () => {
    const renderer = new RecordingRenderer('supported', { pathFills: 'unsupported' });
    const { target, events } = attached(await fixture('containers.json'), renderer);
    // The fill-mode arrow and the star are filled paths too.
    expectSynchronized(target, renderer, ['mg1', 'l1', 'star']);
    expect(diagnostics(events)).toEqual([
      {
        type: 'diagnostic',
        code: 'editor.renderer-unsupported',
        reason: 'unsupported-feature',
        nodeIds: ['l1', 'm-src', 'star'],
      },
    ]);
    expect(sceneNode(renderer, `f1${C}`)).toMatchObject({ children: [`f1${BG}`, 'r1', 'g2'] });

    // Grouping into a new mask group: the source is rejected, the group removed and left out.
    const shapes = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line', 'close'],
      points: [400, 400, 460, 400, 430, 440],
      fill: null,
      stroke: null,
    });
    const r = ok(target, {
      type: 'createRectangle',
      frame: { x: 400, y: 400, width: 30, height: 30 },
    });
    expectSynchronized(target, renderer, ['mg1', 'l1', 'star']);
    const from = renderer.calls.length;
    const [mask] = ok(target, { type: 'groupNodes', ids: [shapes[0]!, r[0]!], kind: 'maskGroup' });
    expectSynchronized(target, renderer, ['mg1', 'l1', 'star', mask!]);
    expect(diagnostics(events).at(-1)).toEqual({
      type: 'diagnostic',
      code: 'editor.renderer-unsupported',
      reason: 'unsupported-feature',
      nodeIds: [shapes[0]],
    });
    // Every set after the empty snapshot is accepted, except the source's own.
    const calls = sceneCalls(renderer, from);
    const rejected = calls.filter((call) => call.result.status !== 'applied');
    expect(rejected).toHaveLength(2);
    expect(
      rejected[1]!.method === 'applyChanges' && rejected[1]!.input.inserted.map((n) => n.id),
    ).toEqual([shapes[0]]);
  });

  it('synthetic IDs map back to the frame in diagnostics', async () => {
    const renderer = new RecordingRenderer('supported', { clips: 'unsupported' });
    const { events } = attached(await fixture('containers.json'), renderer);
    expect(diagnostics(events)).toEqual([
      {
        type: 'diagnostic',
        code: 'editor.renderer-unsupported',
        reason: 'unsupported-feature',
        nodeIds: ['f1'],
      },
    ]);
    expect(renderer.mirror.readRetainedScene()!.rootOrder).toEqual(['g1', 'e1', 'l1']);
  });

  it('isolation sends an empty snapshot, then one unit per set in pre-order with its scene parent order', async () => {
    const { target, renderer } = attached(await fixture('containers.json'));
    const from = renderer.calls.length;
    renderer.overrides.applyChanges = {
      status: 'invalid-scene',
      reason: 'invalid-value',
      current: renderer.getSynchronizationState().current,
    };
    ok(target, {
      type: 'setFrames',
      frames: [
        { id: 'e1', frame: { x: 0, y: 0, width: 10, height: 10 } },
        { id: 'r2', frame: { x: 0, y: 0, width: 5, height: 5 } },
        { id: 'l1', frame: { x: 0, y: 0, width: 10, height: 10 } },
      ],
    });
    const calls = sceneCalls(renderer, from);
    expect(calls[0]!.method).toBe('applyChanges');
    expect(calls[1]).toMatchObject({
      method: 'replaceSnapshot',
      input: { nodes: [], rootOrder: [] },
    });
    const units = calls.slice(2).map((call) => {
      if (call.method !== 'applyChanges') throw new Error('expected change sets');
      expect(call.result.status).toBe('applied');
      expect(call.input.updated).toEqual([]);
      expect(call.input.orders).toHaveLength(1);
      return { ids: call.input.inserted.map((n) => n.id), order: call.input.orders[0]! };
    });
    expect(units.map((unit) => unit.ids[0])).toEqual([
      'f1',
      'r1',
      'mg1',
      'm-src',
      'm-r',
      'g2',
      'star',
      'g1',
      'e2',
      'r3',
      'e1',
      'l1',
    ]);
    expect(units[0]!.ids).toEqual(['f1', `f1${C}`, `f1${BG}`, `f1${BD}`]);
    expect(units[0]!.order).toEqual({ parentId: null, children: ['f1'] });
    expect(units[1]!.order).toEqual({ parentId: `f1${C}`, children: [`f1${BG}`, 'r1'] });
    expect(units[3]!.order).toEqual({ parentId: 'mg1', children: ['m-src'] });
    expectSynchronized(target, renderer);
  });

  it('after a rejected moveNodes into a mask group, the subtree is left out and later retried whole', () => {
    const { target, renderer, events } = attached(
      doc(
        ['m', 'g', 'c'],
        [
          node('m', 'p', 'maskGroup', {
            frame: { x: 0, y: 0, width: 10, height: 10 },
            children: ['s', 'r1'],
          }),
          node('s', 'm', 'path'),
          node('r1', 'm', 'rectangle'),
          node('g', 'p', 'group', {
            frame: { x: 20, y: 0, width: 30, height: 10 },
            children: ['a', 'b'],
          }),
          node('a', 'g', 'rectangle'),
          node('b', 'g', 'ellipse', { frame: { x: 20, y: 0, width: 10, height: 10 } }),
          node('c', 'p', 'rectangle', { frame: { x: 60, y: 0, width: 10, height: 10 } }),
        ],
      ),
    );
    const gate = rejecting(renderer, (entry) => entry.id === 'g' && entry.parentId === 'm');
    ok(target, { type: 'moveNodes', ids: ['g'], parent: 'm', index: 1 });
    expect(documentOf(target).nodes.m).toMatchObject({ children: ['s', 'g', 'r1'] });
    expectSynchronized(target, renderer, ['g']);
    expect(diagnostics(events)).toEqual([
      {
        type: 'diagnostic',
        code: 'editor.scene-rejected',
        reason: 'invalid-value',
        nodeIds: ['g'],
      },
    ]);

    // An edit inside the excluded subtree while the renderer still rejects: excluded again, no
    // new isolation (no snapshot).
    let from = renderer.calls.length;
    ok(target, { type: 'setNodeProps', id: 'a', props: { opacity: 0.5 } });
    expect(sceneCalls(renderer, from).map((call) => call.method)).toEqual(['applyChanges']);
    expectSynchronized(target, renderer, ['g']);
    expect(diagnostics(events)).toHaveLength(2);

    // Once the renderer accepts it, the next edit inside retries the subtree whole, in pre-order.
    gate.block = false;
    from = renderer.calls.length;
    ok(target, { type: 'setNodeProps', id: 'b', props: { opacity: 0.5 } });
    const calls = sceneCalls(renderer, from);
    expect(
      calls.map((call) => call.method === 'applyChanges' && call.input.inserted.map((n) => n.id)),
    ).toEqual([['g'], ['a'], ['b']]);
    expect(calls[0]!.method === 'applyChanges' && calls[0]!.input.orders).toEqual([
      { parentId: 'm', children: ['s', 'g', 'r1'] },
    ]);
    expectSynchronized(target, renderer);
    expect(diagnostics(events)).toHaveLength(2);
  });

  it('after a rejected ungroup, isolation leaves the rejected node out until it is edited', () => {
    const { target, renderer, events } = attached(
      doc(
        ['u', 'z'],
        [
          node('u', 'p', 'group', {
            frame: { x: 0, y: 0, width: 30, height: 10 },
            rotation: 0.5,
            children: ['x', 'y'],
          }),
          node('x', 'u', 'rectangle'),
          node('y', 'u', 'ellipse', { frame: { x: 20, y: 0, width: 10, height: 10 } }),
          node('z', 'p', 'rectangle', { frame: { x: 60, y: 0, width: 10, height: 10 } }),
        ],
      ),
    );
    const gate = rejecting(renderer, (entry) => entry.id === 'y' && entry.parentId === null);
    ok(target, { type: 'ungroupNodes', id: 'u' });
    expectSynchronized(target, renderer, ['y']);
    expect(renderer.mirror.readRetainedScene()!.rootOrder).toEqual(['x', 'z']);
    expect(diagnostics(events)).toMatchObject([{ nodeIds: ['y'] }]);
    gate.block = false;
    ok(target, { type: 'setNodeProps', id: 'y', props: { name: 'kept' } });
    expectSynchronized(target, renderer);
  });

  it('after every M1 command, undo, redo and page switch the mirror holds the projection', async () => {
    const { target, renderer, events } = attached(await fixture('containers.json'));
    const check = () => expectSynchronized(target, renderer);
    const steps: Command[] = [
      { type: 'createEllipse', frame: { x: 300, y: 300, width: 40, height: 20 }, rotation: 0.3 },
      { type: 'createLine', start: { x: 0, y: 400 }, end: { x: 80, y: 420 }, endArrow: 'triangle' },
      {
        type: 'createFrame',
        frame: { x: 400, y: 0, width: 100, height: 100 },
        stroke: { color: black, width: 1 },
      },
      {
        type: 'createRectangle',
        frame: { x: 30, y: 30, width: 20, height: 20 },
        parent: 'f1',
        cornerRadii: [2, 2, 2, 2],
      },
      { type: 'createPath', verbs: ['move', 'line'], points: [0, 0, 10, 10], parent: 'g1' },
      {
        type: 'createCustomNode',
        customType: 'ext.star',
        frame: { x: 0, y: 500, width: 40, height: 40 },
      },
      { type: 'groupNodes', ids: ['e1', 'l1'], kind: 'group' },
      { type: 'moveNodes', ids: ['g1'], parent: 'f1', index: 0 },
      {
        type: 'setFrames',
        frames: [{ id: 'f1', frame: { x: 0, y: 0, width: 300, height: 200 }, rotation: -0.4 }],
      },
      { type: 'setNodeProps', id: 'mg1', props: { visible: false } },
      { type: 'setNodeProps', id: 'f1', props: { fill: null } },
      { type: 'ungroupNodes', id: 'g2' },
      { type: 'deleteNodes', ids: ['m-r'] },
      { type: 'deleteNodes', ids: ['f1'] },
      { type: 'addPage', name: 'Third' },
      { type: 'renamePage', id: 'page-2', name: 'Second' },
      { type: 'movePage', id: 'page-2', index: 0 },
    ];
    for (const step of steps) {
      ok(target, step);
      check();
    }
    for (let i = 0; i < steps.length; i += 1) {
      ok(target, { type: 'undo' });
      check();
    }
    for (let i = 0; i < steps.length; i += 1) {
      ok(target, { type: 'redo' });
      check();
    }
    // Page switches send a snapshot under the new identity.
    const from = renderer.calls.length;
    ok(target, { type: 'setActivePage', id: 'page-2' });
    const [call] = sceneCalls(renderer, from);
    expect(call).toMatchObject({
      method: 'replaceSnapshot',
      input: { identity: { documentId: 'doc-containers', pageId: 'page-2' }, rootOrder: ['r2'] },
    });
    check();
    ok(target, { type: 'createEllipse', frame: { x: 0, y: 0, width: 5, height: 5 } });
    check();
    ok(target, { type: 'removePage', id: 'page-2' });
    check();
    ok(target, { type: 'undo' });
    check();
    ok(target, { type: 'setActivePage', id: 'page-1' });
    check();
    expect(diagnostics(events)).toEqual([]);
    expect(sceneCalls(renderer).every((entry) => entry.result.status === 'applied')).toBe(true);
  });
});
