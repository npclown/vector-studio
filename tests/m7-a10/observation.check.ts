// MVP M7-A10 (M7 contract, section 9): an observation only, no claim (MVP plan, section 8). On
// the generated page of 100 instances of a 100-node source (./document.ts) it times, per run on
// a fresh editor and recording renderer:
//   - parse: `parseDocument` of the JSON text,
//   - construct: `createEditor` with the parsed document (validation, load and the expansion
//     validity and cap checks of every instance),
//   - project: `projectPage` of the page alone with a fresh expansion cache (no renderer),
//   - attach: `attachRenderer`, the first projection and the scene mirror's `replaceSnapshot`,
//   - source edit: one `setNodeProps` fill of a leaf inside the source, a commit that reaches the
//     source and all 100 instances,
//   - source drag: one select-tool drag of a group inside the source (down, five moves, up), the
//     up being the commit; each move is a gesture update that re-expands every instance,
//   - instance move: one `setFrames` of an instance (M7-U3 review M5 asked where it goes),
//   - detach: one `detachInstances` of a scaled instance.
// After each step the scene mirror must hold exactly the projection. Manual, never CI:
//
//   pnpm observe:m7-a10
//
// which writes .tools/m7-a10/record.json. M7_A10_RUNS (default 5) sets the run count.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { RenderChangeSet } from '@vector-studio/contracts';
import { parseDocument, type DocumentV4 } from '@vector-studio/model';
import { expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
  type Modifiers,
} from '../../packages/editor-core/src/index.js';
import { boundsOf } from '../../packages/editor-core/src/hit-test.js';
import { expandedId, projectPage } from '../../packages/editor-core/src/projector.js';
import { RecordingRenderer } from '../support/p5-recording-renderer.js';
import {
  generateM7A10Document,
  M7_A10_INSTANCES,
  M7_A10_PAGE,
  M7_A10_SOURCE,
  M7_A10_SOURCE_NODES,
} from './document.js';

const root = path.resolve(import.meta.dirname, '../..');
const RUNS = Number(process.env.M7_A10_RUNS ?? 5);
const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };
const noCustom = () => null;
/** The leaf whose fill the source edit changes, the group the drag moves and its pressed leaf. */
const EDITED = 'G0-0';
const DRAGGED = 'G0';
const PRESSED = 'G0-1';
/** An instance at the source's size, moved, and a scaled one, detached. */
const MOVED = 'I0';
const DETACHED = 'I1';
const NEW_FILL = { r: 0, g: 1, b: 0, a: 1 };

/** The recording renderer, summing the time spent in its scene calls (the mirror's validation). */
class TimedRenderer extends RecordingRenderer {
  sceneMs = 0;
  override replaceSnapshot(...args: Parameters<RecordingRenderer['replaceSnapshot']>) {
    const start = performance.now();
    try {
      return super.replaceSnapshot(...args);
    } finally {
      this.sceneMs += performance.now() - start;
    }
  }
  override applyChanges(...args: Parameters<RecordingRenderer['applyChanges']>) {
    const start = performance.now();
    try {
      return super.applyChanges(...args);
    } finally {
      this.sceneMs += performance.now() - start;
    }
  }
}

function ok(target: Editor, command: Command): void {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
}

function timed<T>(run: () => T): [T, number] {
  const start = performance.now();
  const value = run();
  return [value, performance.now() - start];
}

/** The mirror holds exactly the projection of the active page, nothing excluded. */
function expectSynchronized(target: Editor, renderer: RecordingRenderer): number {
  const document = target.query({ type: 'document' });
  const page = target.query({ type: 'activePage' });
  const projection = projectPage(document, page, noCustom);
  expect(projection.invalid).toEqual([]);
  const scene = renderer.mirror.readRetainedScene();
  expect(scene).not.toBeNull();
  expect(scene!.version.identity).toEqual({ documentId: document.id, pageId: page });
  expect(scene!.rootOrder).toEqual(projection.rootOrder);
  expect(scene!.nodes.length).toBe(projection.nodes.size);
  for (const [id, snapshot] of projection.nodes) expect(scene!.getNode(id)).toEqual(snapshot);
  return projection.nodes.size;
}

/** The change sets the renderer accepted since call `first`, summed. */
function changesSince(renderer: RecordingRenderer, first: number) {
  const sets: RenderChangeSet[] = [];
  for (const call of renderer.calls.slice(first)) {
    if (call.method === 'applyChanges') sets.push(call.input);
  }
  const sum = (pick: (set: RenderChangeSet) => number) =>
    sets.reduce((total, set) => total + pick(set), 0);
  return {
    sets: sets.length,
    inserted: sum((set) => set.inserted.length),
    updated: sum((set) => set.updated.length),
    removed: sum((set) => set.removed.length),
  };
}

function summary(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    medianMs: round(median),
    minMs: round(sorted[0]!),
    maxMs: round(sorted.at(-1)!),
    runsMs: values.map(round),
  };
}

function cpuModel(): string {
  try {
    const line = readFileSync('/proc/cpuinfo', 'utf8')
      .split('\n')
      .find((entry) => entry.startsWith('model name'));
    if (line !== undefined) return line.split(':')[1]!.trim();
  } catch {
    // Not Linux: fall back to Node's report.
  }
  return os.cpus()[0]?.model ?? 'unknown';
}

it('M7-A10 observation: load, projection, source edits, instance move and detach', () => {
  const [generated, generateMs] = timed(() => generateM7A10Document());
  const text = JSON.stringify(generated);
  const steps: Record<string, number[]> = {
    parse: [],
    construct: [],
    project: [],
    attach: [],
    sourceEdit: [],
    dragPointerDown: [],
    dragPointerMoves: [],
    dragCommit: [],
    instanceMove: [],
    detach: [],
    // The part of a step spent inside the renderer's scene calls.
    attachRenderer: [],
    sourceEditRenderer: [],
    dragPointerMovesRenderer: [],
    dragCommitRenderer: [],
    instanceMoveRenderer: [],
    detachRenderer: [],
  };
  let sceneNodes = 0;
  let sceneNodesAfterDetach = 0;
  const changes: Record<string, ReturnType<typeof changesSince>> = {};

  for (let run = 0; run < RUNS; run += 1) {
    const [parsed, parseMs] = timed(() => parseDocument(text));
    if (!parsed.ok) throw new Error(`parse: ${parsed.code} ${parsed.path}`);
    const document: DocumentV4 = parsed.document;
    expect(Object.keys(document.nodes)).toHaveLength(M7_A10_SOURCE_NODES + M7_A10_INSTANCES);

    const [target, constructMs] = timed(() =>
      createEditor({ ids: createCounterIdSource('n'), document }),
    );
    const [projection, projectMs] = timed(() =>
      projectPage(target.query({ type: 'document' }), M7_A10_PAGE, noCustom),
    );
    const renderer = new TimedRenderer();
    const [detachRenderer, attachMs] = timed(() => target.attachRenderer(renderer));
    const attachRendererMs = renderer.sceneMs;
    expect(renderer.calls.filter((call) => call.method === 'replaceSnapshot')).toHaveLength(1);
    sceneNodes = expectSynchronized(target, renderer);
    expect(sceneNodes).toBe(projection.nodes.size);

    // Source edit: one fill command on a leaf of the source.
    let first = renderer.calls.length;
    let before = renderer.sceneMs;
    const [, editMs] = timed(() =>
      ok(target, { type: 'setNodeProps', id: EDITED, props: { fill: NEW_FILL } }),
    );
    const editRendererMs = renderer.sceneMs - before;
    changes.sourceEdit = changesSince(renderer, first);
    const mirror = renderer.mirror.readRetainedScene()!;
    for (let index = 0; index < M7_A10_INSTANCES; index += 1) {
      const node = mirror.getNode(expandedId(`I${index}`, EDITED));
      expect(node).toMatchObject({ style: { fill: NEW_FILL } });
    }
    expectSynchronized(target, renderer);

    // Source drag: the press inside the top-level source selects its child group (artboard
    // target, M7 contract section 1.2); five gesture updates, then the commit.
    const pressed = boundsOf(target.query({ type: 'document' }), [PRESSED])!;
    const from = { x: pressed.x + pressed.width / 2, y: pressed.y + pressed.height / 2 };
    const startFrame = target.query({ type: 'document' }).nodes[DRAGGED]!.frame;
    const input = (kind: 'pointerdown' | 'pointermove' | 'pointerup', dx: number, dy: number) =>
      ok(target, {
        type: 'input',
        event: { kind, point: { x: from.x + dx, y: from.y + dy }, modifiers: none },
      });
    ok(target, { type: 'setSnapping', enabled: false });
    const [, downMs] = timed(() => input('pointerdown', 0, 0));
    expect(target.getSnapshot().selection).toEqual([DRAGGED]);
    before = renderer.sceneMs;
    const [, movesMs] = timed(() => {
      for (let i = 1; i <= 5; i += 1) input('pointermove', 2 * i, 3 * i);
    });
    const movesRendererMs = renderer.sceneMs - before;
    before = renderer.sceneMs;
    first = renderer.calls.length;
    const [, commitMs] = timed(() => input('pointerup', 10, 15));
    const commitRendererMs = renderer.sceneMs - before;
    changes.dragCommit = changesSince(renderer, first);
    const endFrame = target.query({ type: 'document' }).nodes[DRAGGED]!.frame;
    expect(endFrame.x - startFrame.x).toBeCloseTo(10, 9);
    expect(endFrame.y - startFrame.y).toBeCloseTo(15, 9);
    expect(target.query({ type: 'history' }).undoDepth).toBe(2);
    expectSynchronized(target, renderer);

    // Instance move: one instance's own frame.
    const moved = target.query({ type: 'document' }).nodes[MOVED]!.frame;
    first = renderer.calls.length;
    before = renderer.sceneMs;
    const [, moveMs] = timed(() =>
      ok(target, {
        type: 'setFrames',
        frames: [{ id: MOVED, frame: { ...moved, x: moved.x + 10 } }],
      }),
    );
    const moveRendererMs = renderer.sceneMs - before;
    changes.instanceMove = changesSince(renderer, first);
    expectSynchronized(target, renderer);

    // Detach: a scaled instance becomes a frame with 99 new children (M7 section 5.2).
    first = renderer.calls.length;
    before = renderer.sceneMs;
    const [, detachMs] = timed(() => ok(target, { type: 'detachInstances', ids: [DETACHED] }));
    const detachRendererMs = renderer.sceneMs - before;
    changes.detach = changesSince(renderer, first);
    const detached = target.query({ type: 'document' });
    expect(detached.nodes[DETACHED]!.type).toBe('frame');
    expect(Object.keys(detached.nodes)).toHaveLength(
      M7_A10_SOURCE_NODES + M7_A10_INSTANCES + M7_A10_SOURCE_NODES - 1,
    );
    sceneNodesAfterDetach = expectSynchronized(target, renderer);

    steps.parse!.push(parseMs);
    steps.construct!.push(constructMs);
    steps.project!.push(projectMs);
    steps.attach!.push(attachMs);
    steps.sourceEdit!.push(editMs);
    steps.dragPointerDown!.push(downMs);
    steps.dragPointerMoves!.push(movesMs);
    steps.dragCommit!.push(commitMs);
    steps.instanceMove!.push(moveMs);
    steps.detach!.push(detachMs);
    steps.attachRenderer!.push(attachRendererMs);
    steps.sourceEditRenderer!.push(editRendererMs);
    steps.dragPointerMovesRenderer!.push(movesRendererMs);
    steps.dragCommitRenderer!.push(commitRendererMs);
    steps.instanceMoveRenderer!.push(moveRendererMs);
    steps.detachRenderer!.push(detachRendererMs);
    detachRenderer();
    renderer.dispose();
  }

  const record = {
    acceptance: 'M7-A10',
    kind: 'observation (no claim)',
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    worktree: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).trim()
      ? 'dirty'
      : 'clean',
    environment: {
      node: process.version,
      platform: `${process.platform} ${os.release()}`,
      cpu: cpuModel(),
      logicalCpus: os.cpus().length,
    },
    document: {
      documentNodes: Object.keys(generated.nodes).length,
      source: M7_A10_SOURCE,
      sourceNodes: M7_A10_SOURCE_NODES,
      instances: M7_A10_INSTANCES,
      jsonBytes: Buffer.byteLength(text),
      sceneNodes,
      sceneNodesAfterDetach,
      edited: EDITED,
      dragged: DRAGGED,
      moved: MOVED,
      detached: DETACHED,
    },
    // The renderer change sets of the last run, per step.
    changes,
    runs: RUNS,
    generateMs: Math.round(generateMs * 100) / 100,
    steps: Object.fromEntries(
      Object.entries(steps).map(([name, values]) => [name, summary(values)]),
    ),
  };
  const out = path.join(root, '.tools/m7-a10');
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record, null, 2));
});
