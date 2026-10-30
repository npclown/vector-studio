// MVP M4-A13 (M4 contract, section 9): an observation only, no claim (MVP plan, section 8). On
// the generated page of 10,000 stroked rectangles (./document.ts), once with a `round` join
// (P1 primitives) and once with a `miter` join (M4-P4 outline paths), it times, per run on a
// fresh editor and recording renderer:
//   - parse: `parseDocument` of the JSON text,
//   - construct: `createEditor` with the parsed document,
//   - project: `projectPage` of the page alone (no renderer),
//   - attach: `attachRenderer`, the first projection and the scene mirror's `replaceSnapshot`,
//   - setStyle width: one `setStyle` of the stroke width over all 10,000 (same scene kinds),
//   - setStyle join: one `setStyle` of the other join over all 10,000 (every snapshot switches
//     between primitive and path).
// After each step the scene mirror must hold exactly the projection. The frame time is the
// headed spec's `M4-A13` test. Manual, never CI:
//
//   pnpm observe:m4-a13
//
// which writes .tools/m4-a13/record.json. M4_A13_RUNS (default 5) sets the run count.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { RenderChangeSet } from '@vector-studio/contracts';
import { parseDocument } from '@vector-studio/model';
import { expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
} from '../../packages/editor-core/src/index.js';
import { projectPage } from '../../packages/editor-core/src/projector.js';
import { RecordingRenderer } from '../support/p5-recording-renderer.js';
import { generateM4A13Document, M4_A13_COUNT, M4_A13_PAGE, type M4A13Join } from './document.js';

const root = path.resolve(import.meta.dirname, '../..');
const RUNS = Number(process.env.M4_A13_RUNS ?? 5);
const noCustom = () => null;

/** The recording renderer with M4's features on, summing the time spent in its scene calls. */
class TimedRenderer extends RecordingRenderer {
  sceneMs = 0;
  constructor() {
    super('supported', {
      pathFills: 'supported',
      paints: 'gradient',
      dashes: 'supported',
      groupOpacity: 'supported',
    });
  }
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

/** The mirror holds exactly the projection of the page; returns its node kinds. */
function expectSynchronized(target: Editor, renderer: RecordingRenderer) {
  const document = target.query({ type: 'document' });
  const projection = projectPage(document, M4_A13_PAGE, noCustom);
  const scene = renderer.mirror.readRetainedScene();
  expect(scene).not.toBeNull();
  expect(scene!.rootOrder).toEqual(projection.rootOrder);
  expect(scene!.nodes.length).toBe(projection.nodes.size);
  const kinds: Record<string, number> = {};
  for (const [id, snapshot] of projection.nodes) {
    expect(scene!.getNode(id)).toEqual(snapshot);
    kinds[snapshot.kind] = (kinds[snapshot.kind] ?? 0) + 1;
  }
  return kinds;
}

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

function observe(join: M4A13Join) {
  const text = JSON.stringify(generateM4A13Document(join));
  const other: M4A13Join = join === 'round' ? 'miter' : 'round';
  const steps: Record<string, number[]> = {
    parse: [],
    construct: [],
    project: [],
    attach: [],
    attachRenderer: [],
    setStyleWidth: [],
    setStyleWidthRenderer: [],
    setStyleJoin: [],
    setStyleJoinRenderer: [],
  };
  let kinds: Record<string, number> = {};
  let kindsAfterJoin: Record<string, number> = {};
  const changes: Record<string, ReturnType<typeof changesSince>> = {};
  for (let run = 0; run < RUNS; run += 1) {
    const [parsed, parseMs] = timed(() => parseDocument(text));
    if (!parsed.ok) throw new Error(`parse: ${parsed.code} ${parsed.path}`);
    const [target, constructMs] = timed(() =>
      createEditor({ ids: createCounterIdSource('n'), document: parsed.document }),
    );
    const [, projectMs] = timed(() =>
      projectPage(target.query({ type: 'document' }), M4_A13_PAGE, noCustom),
    );
    const renderer = new TimedRenderer();
    const [detach, attachMs] = timed(() => target.attachRenderer(renderer));
    const attachRendererMs = renderer.sceneMs;
    kinds = expectSynchronized(target, renderer);
    const ids = target.query({ type: 'document' }).pages[0]!.children;
    expect(ids).toHaveLength(M4_A13_COUNT);

    let first = renderer.calls.length;
    let before = renderer.sceneMs;
    const [, widthMs] = timed(() =>
      ok(target, { type: 'setStyle', ids, style: { stroke: { width: 2 } } }),
    );
    const widthRendererMs = renderer.sceneMs - before;
    changes.setStyleWidth = changesSince(renderer, first);
    expect(expectSynchronized(target, renderer)).toEqual(kinds);

    first = renderer.calls.length;
    before = renderer.sceneMs;
    const [, joinMs] = timed(() =>
      ok(target, { type: 'setStyle', ids, style: { stroke: { join: other } } }),
    );
    const joinRendererMs = renderer.sceneMs - before;
    changes.setStyleJoin = changesSince(renderer, first);
    kindsAfterJoin = expectSynchronized(target, renderer);
    expect(target.query({ type: 'history' }).undoDepth).toBe(2);

    steps.parse!.push(parseMs);
    steps.construct!.push(constructMs);
    steps.project!.push(projectMs);
    steps.attach!.push(attachMs);
    steps.attachRenderer!.push(attachRendererMs);
    steps.setStyleWidth!.push(widthMs);
    steps.setStyleWidthRenderer!.push(widthRendererMs);
    steps.setStyleJoin!.push(joinMs);
    steps.setStyleJoinRenderer!.push(joinRendererMs);
    detach();
    renderer.dispose();
  }
  return {
    join,
    jsonBytes: Buffer.byteLength(text),
    sceneKinds: kinds,
    sceneKindsAfterJoin: kindsAfterJoin,
    changes,
    steps: Object.fromEntries(
      Object.entries(steps).map(([name, values]) => [name, summary(values)]),
    ),
  };
}

it('M4-A13 observation: 10,000 stroked rectangles, round (primitives) and miter (paths)', () => {
  const variants = [observe('round'), observe('miter')];
  const record = {
    acceptance: 'M4-A13',
    kind: 'observation (no claim)',
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    worktree: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).trim()
      ? 'dirty'
      : 'clean',
    environment: {
      node: process.version,
      platform: process.platform,
      logicalCpus: os.cpus().length,
    },
    rectangles: M4_A13_COUNT,
    runs: RUNS,
    variants,
  };
  const out = path.join(root, '.tools/m4-a13');
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record, null, 2));
});
