// MVP M1-A13 (M1 contract, section 8): an observation only, no claim (MVP plan, section 8). On
// the generated 10,000-node mixed v2 document (./document.ts) it times, per run on a fresh
// editor and recording renderer:
//   - parse: `parseDocument` of the JSON text,
//   - construct: `createEditor` with the parsed document (validation and load),
//   - project: `projectPage` of the active page alone (no renderer),
//   - attach: `attachRenderer`, the first projection and the scene mirror's `replaceSnapshot`,
//   - move: one select-tool drag of a nested selection (down, five moves, up), the up being the
//     commit, through `input`,
//   - isolation: one `setFrames` of two leaves whose change set the renderer rejects once, so the
//     projector isolates the whole active page (contract section 5, E26-U3 batching).
// After each step the scene mirror must hold exactly the projection. Manual, never CI:
//
//   pnpm observe:m1-a13
//
// which writes .tools/m1-a13/record.json. M1_A13_RUNS (default 5) and M1_A13_ISOLATION_RUNS
// (default 3) set the run counts.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseDocument, type DocumentV6 } from '@vector-studio/model';
import { expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
  type Modifiers,
} from '../../packages/editor-core/src/index.js';
import { boundsOf } from '../../packages/editor-core/src/hit-test.js';
import { projectPage } from '../../packages/editor-core/src/projector.js';
import { RecordingRenderer } from '../support/p5-recording-renderer.js';
import { generateM1A13Document, M1_A13_SEED, m1A13MoveSelection } from './document.js';

const root = path.resolve(import.meta.dirname, '../..');
const RUNS = Number(process.env.M1_A13_RUNS ?? 5);
const ISOLATION_RUNS = Number(process.env.M1_A13_ISOLATION_RUNS ?? 3);
const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };
const noCustom = () => null;

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
  const scene = renderer.mirror.readRetainedScene();
  expect(scene).not.toBeNull();
  expect(scene!.version.identity).toEqual({ documentId: document.id, pageId: page });
  expect(scene!.rootOrder).toEqual(projection.rootOrder);
  expect(scene!.nodes.length).toBe(projection.nodes.size);
  for (const [id, snapshot] of projection.nodes) expect(scene!.getNode(id)).toEqual(snapshot);
  return projection.nodes.size;
}

/**
 * The isolation units of a page, counted from the document: one per node in its subtrees, a
 * frame and its synthetic scene nodes being one unit (projector, section 5).
 */
function pageUnitCount(document: DocumentV6, pageId: string): number {
  const page = document.pages.find((candidate) => candidate.id === pageId)!;
  let count = 0;
  const visit = (id: string) => {
    count += 1;
    const node = document.nodes[id]!;
    if ('children' in node) for (const child of node.children) visit(child);
  };
  for (const id of page.children) visit(id);
  return count;
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

it('M1-A13 observation: load, projection, one move commit and one forced isolation', () => {
  const [generated, generateMs] = timed(() => generateM1A13Document());
  const text = JSON.stringify(generated);
  const selection = m1A13MoveSelection(generated);
  const steps: Record<string, number[]> = {
    parse: [],
    construct: [],
    project: [],
    attach: [],
    movePointerDown: [],
    movePointerMoves: [],
    moveCommit: [],
    isolation: [],
    // The part of a step spent inside the renderer's scene calls.
    attachRenderer: [],
    movePointerMovesRenderer: [],
    moveCommitRenderer: [],
    isolationRenderer: [],
  };
  let sceneNodes = 0;
  let isolationSets = 0;
  let isolationUnits = 0;

  for (let run = 0; run < Math.max(RUNS, ISOLATION_RUNS); run += 1) {
    const [parsed, parseMs] = timed(() => parseDocument(text));
    if (!parsed.ok) throw new Error(`parse: ${parsed.code} ${parsed.path}`);
    const document: DocumentV6 = parsed.document;
    expect(Object.keys(document.nodes)).toHaveLength(10_000);
    expect(document.pages).toHaveLength(2);

    const [target, constructMs] = timed(() =>
      createEditor({ ids: createCounterIdSource('n'), document }),
    );
    const [projection, projectMs] = timed(() =>
      projectPage(target.query({ type: 'document' }), 'page-1', noCustom),
    );
    const renderer = new TimedRenderer();
    const [detach, attachMs] = timed(() => target.attachRenderer(renderer));
    const attachRendererMs = renderer.sceneMs;
    expect(renderer.calls.filter((call) => call.method === 'replaceSnapshot')).toHaveLength(1);
    sceneNodes = expectSynchronized(target, renderer);
    expect(sceneNodes).toBe(projection.nodes.size);

    // One select-tool move of a nested, rotated two-node selection inside a frame. Snapping (M2,
    // on by default) is off, so the move is exactly the pointer's 10/15.
    ok(target, { type: 'setSnapping', enabled: false });
    ok(target, { type: 'setSelection', ids: selection.ids });
    const before = boundsOf(target.query({ type: 'document' }), selection.ids)!;
    const press = boundsOf(target.query({ type: 'document' }), [selection.ids[0]])!;
    const from = { x: press.x + press.width / 2, y: press.y + press.height / 2 };
    const input = (kind: 'pointerdown' | 'pointermove' | 'pointerup', dx: number, dy: number) =>
      ok(target, {
        type: 'input',
        event: { kind, point: { x: from.x + dx, y: from.y + dy }, modifiers: none },
      });
    const [, downMs] = timed(() => input('pointerdown', 0, 0));
    const beforeMoves = renderer.sceneMs;
    const [, movesMs] = timed(() => {
      for (let i = 1; i <= 5; i += 1) input('pointermove', 2 * i, 3 * i);
    });
    const beforeCommit = renderer.sceneMs;
    const movesRendererMs = beforeCommit - beforeMoves;
    const [, commitMs] = timed(() => input('pointerup', 10, 15));
    const commitRendererMs = renderer.sceneMs - beforeCommit;
    const after = boundsOf(target.query({ type: 'document' }), selection.ids)!;
    expect(after.x - before.x).toBeCloseTo(10, 9);
    expect(after.y - before.y).toBeCloseTo(15, 9);
    expect(target.query({ type: 'history' }).undoDepth).toBe(1);
    expectSynchronized(target, renderer);

    if (run < RUNS) {
      steps.parse!.push(parseMs);
      steps.construct!.push(constructMs);
      steps.project!.push(projectMs);
      steps.attach!.push(attachMs);
      steps.movePointerDown!.push(downMs);
      steps.movePointerMoves!.push(movesMs);
      steps.moveCommit!.push(commitMs);
      steps.attachRenderer!.push(attachRendererMs);
      steps.movePointerMovesRenderer!.push(movesRendererMs);
      steps.moveCommitRenderer!.push(commitRendererMs);
    }

    if (run < ISOLATION_RUNS) {
      // The next change set is rejected once; isolation then rebuilds the page.
      const first = renderer.calls.length;
      renderer.overrides.applyChanges = {
        status: 'invalid-scene',
        reason: 'invalid-value',
        current: renderer.getSynchronizationState().current,
      };
      // Two units in one set: a one-unit set is that unit's own rejection (U3 note 1), with no
      // isolation, so the set moves two loose leaves.
      const nodes = target.query({ type: 'document' }).nodes;
      const frames = generated.pages[0]!.children.slice(-2).map((id) => {
        const frame = nodes[id]!.frame;
        return { id, frame: { ...frame, x: frame.x + 1 } };
      });
      const beforeIsolation = renderer.sceneMs;
      const [, isolationMs] = timed(() => ok(target, { type: 'setFrames', frames }));
      const calls = renderer.calls.slice(first).filter((call) => call.method !== 'setCamera');
      expect(calls[0]).toMatchObject({
        method: 'applyChanges',
        result: { status: 'invalid-scene' },
      });
      expect(calls[1]).toMatchObject({
        method: 'replaceSnapshot',
        input: { nodes: [], rootOrder: [] },
        result: { status: 'applied' },
      });
      for (const call of calls.slice(2)) {
        expect(call.method).toBe('applyChanges');
        expect(call.result.status).toBe('applied');
      }
      isolationSets = calls.length - 2;
      const document = target.query({ type: 'document' });
      isolationUnits = pageUnitCount(document, target.query({ type: 'activePage' }));
      // E26-U3: a one-time rejection is isolated in one batched set of every unit.
      expect(isolationSets).toBe(1);
      expectSynchronized(target, renderer);
      steps.isolation!.push(isolationMs);
      steps.isolationRenderer!.push(renderer.sceneMs - beforeIsolation);
    }
    detach();
    renderer.dispose();
  }

  const record = {
    acceptance: 'M1-A13',
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
      seed: M1_A13_SEED,
      nodes: Object.keys(generated.nodes).length,
      jsonBytes: Buffer.byteLength(text),
      pageRoots: generated.pages.map((page) => page.children.length),
      activePageSceneNodes: sceneNodes,
      moveSelection: selection.ids,
      isolationUnits,
      isolationSets,
    },
    runs: RUNS,
    isolationRuns: ISOLATION_RUNS,
    generateMs: Math.round(generateMs * 100) / 100,
    steps: Object.fromEntries(
      Object.entries(steps).map(([name, values]) => [name, summary(values)]),
    ),
  };
  const out = path.join(root, '.tools/m1-a13');
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record, null, 2));
});
