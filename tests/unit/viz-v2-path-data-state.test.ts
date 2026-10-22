import type {
  RenderChangeSet,
  RenderNodeSnapshot,
  SceneApplyResult,
} from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PATH_TEXT,
  FILL_COLOR,
  INITIAL_APPEARANCE,
  NODE_ID,
  PathDataEditor,
  PathStatusTracker,
  STROKE_COLOR,
  V2_CONTROL_IDS,
  controlApplies,
  fitCamera,
  interpretControl,
  nodeFor,
  pathDataEqual,
  pathSnapshot,
  singleNodeChange,
  type AppearanceState,
  type EditorSync,
  type V2ControlId,
} from '../../apps/playground/src/viz-v2-path-data-state.js';
import { parsePathData } from '../../apps/playground/src/viz-v2-path-data-parse.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';

// Visualization track V-2 (docs/plans/viz-v2-path-data-contract.md), acceptance criteria V2-A8
// (the edit flow with a plain fake synchronization) and V2-A13 (the fit rule, unit part), plus the
// controls and the derived status. Functional evidence only: precision is UNVERIFIED.

const supported = {
  pathNodes: 'supported',
  pathFills: 'supported',
  pathStrokes: 'supported',
} as const;

type Harness = {
  editor: PathDataEditor;
  changes: RenderChangeSet[];
  snapshots: number[];
  queue: Array<() => void>;
  mirror: RetainedSceneMirror;
  runQueue: () => void;
};

function harness(override?: Partial<EditorSync>, options: { initialText?: string } = {}): Harness {
  const mirror = new RetainedSceneMirror(undefined, supported);
  const changes: RenderChangeSet[] = [];
  const snapshots: number[] = [];
  const queue: Array<() => void> = [];
  const sync: EditorSync = {
    replaceSnapshot: (snapshot) => {
      snapshots.push(snapshot.revision);
      return mirror.replaceSnapshot(snapshot);
    },
    applyChanges: (change) => {
      changes.push(change);
      return mirror.applyChanges(change);
    },
    ...override,
  };
  const editor = new PathDataEditor({
    sync,
    schedule: (run) => queue.push(run),
    ...options,
  });
  return {
    editor,
    changes,
    snapshots,
    queue,
    mirror,
    runQueue: () => {
      for (const run of queue.splice(0)) run();
    },
  };
}

const patch = (id: V2ControlId, raw: string | boolean) => {
  const result = interpretControl(id, raw);
  if (!result.ok) throw new Error(result.message);
  return result.patch;
};

const pathNode = (node: RenderNodeSnapshot) => {
  if (node.kind !== 'path') throw new Error('not a path node');
  return node;
};

describe('V-2 initial state and scene mapping', () => {
  it('starts with the default path applied at revision 1 and the section 3.2 initial state', () => {
    const { editor, snapshots } = harness();
    expect(editor.start().status).toBe('applied');
    expect(editor.revision).toBe(1);
    expect(snapshots).toEqual([1]);
    expect(editor.appliedText).toBe(DEFAULT_PATH_TEXT);
    expect(DEFAULT_PATH_TEXT).toBe('M 40 40 H 280 V 200 Q 160 280 40 200 Z');
    expect(editor.appearance).toEqual({
      fillOn: true,
      fillRule: 'nonzero',
      strokeOn: false,
      strokeWidth: 4,
      cap: 'butt',
      join: 'miter',
    });
    expect(editor.geometry.verbs).toEqual(['move', 'line', 'line', 'cubic', 'close']);
    // Q 160 280 40 200 from (280, 200): c1 = (280 + 320) / 3 = 200, (200 + 560) / 3; c2 = (40 + 320) / 3 = 120.
    expect(editor.geometry.points).toEqual([
      40,
      40,
      280,
      40,
      280,
      200,
      (280 + 2 * 160) / 3,
      (200 + 2 * 280) / 3,
      (40 + 2 * 160) / 3,
      (200 + 2 * 280) / 3,
      40,
      200,
    ]);
  });

  it('builds the node of section 1.3: v2-path under world, identity, opacity 1, fixed paints', () => {
    const parsed = parsePathData('M 0 0 L 10 0 L 10 10 Z');
    if (parsed.status !== 'ok') throw new Error('parse');
    const on = pathNode(
      nodeFor(parsed, {
        ...INITIAL_APPEARANCE,
        strokeOn: true,
        strokeWidth: 12.5,
        cap: 'round',
        join: 'bevel',
        fillRule: 'evenodd',
      }),
    );
    expect(on.id).toBe('v2-path');
    expect(NODE_ID).toBe('v2-path');
    expect(on.parentId).toBe('world');
    expect(on.transform).toEqual([1, 0, 0, 1, 0, 0]);
    expect(on.visible).toBe(true);
    expect(on.opacity).toBe(1);
    expect(on.geometry.fillRule).toBe('evenodd');
    expect(on.style.fill).toEqual({ r: 0.86, g: 0.2, b: 0.2, a: 1 });
    expect(on.style.stroke).toEqual({
      color: { r: 0.2, g: 0.4, b: 0.9, a: 1 },
      width: 12.5,
      cap: 'round',
      join: 'bevel',
      miterLimit: 4,
    });
    expect(FILL_COLOR).toEqual(on.style.fill);
    expect(STROKE_COLOR).toEqual(on.style.stroke?.color);
    const off = pathNode(nodeFor(parsed, { ...INITIAL_APPEARANCE, fillOn: false }));
    expect(off.style).toEqual({ fill: null, stroke: null });
    const snapshot = pathSnapshot(parsed, INITIAL_APPEARANCE, 3);
    expect(snapshot.nodes.map((node) => node.id)).toEqual(['world', 'v2-path']);
    expect(snapshot.rootOrder).toEqual(['world']);
  });

  it('keeps the state as plain JSON data', () => {
    const { editor } = harness();
    editor.start();
    const round = JSON.parse(
      JSON.stringify({ geometry: editor.geometry, appearance: editor.appearance }),
    ) as { geometry: { points: number[] } };
    expect(round.geometry.points).toEqual(editor.geometry.points);
  });
});

describe('V2-A8 controls and the commit rule', () => {
  it('applies radios and checkboxes live and the width number on commit only', () => {
    for (const id of ['fill-on', 'fill-rule', 'stroke-on', 'cap', 'join'] as const) {
      expect(controlApplies(id, 'input')).toBe(true);
      expect(controlApplies(id, 'blur')).toBe(false);
    }
    expect(controlApplies('stroke-width-number', 'input')).toBe(false);
    for (const event of ['change', 'enter', 'blur'] as const) {
      expect(controlApplies('stroke-width-number', event)).toBe(true);
    }
    expect(V2_CONTROL_IDS).toHaveLength(6);
  });

  it('parses the width as a finite value from 0 to 1,024 and refuses anything else', () => {
    const apply = (raw: string) => interpretControl('stroke-width-number', raw);
    for (const raw of ['0', '1024', '12.3456', '1e2', ' 8 ']) expect(apply(raw).ok, raw).toBe(true);
    for (const raw of ['', '-1', '1024.01', 'abc', 'NaN', 'Infinity', '1e400', '1,5']) {
      const result = apply(raw);
      expect(result.ok, raw).toBe(false);
      if (!result.ok) expect(result.message).toContain('0 to 1024');
    }
    const value = apply('300');
    if (value.ok) expect(value.patch(INITIAL_APPEARANCE).strokeWidth).toBe(300);
  });

  it('maps each control to its appearance field', () => {
    const base = INITIAL_APPEARANCE;
    expect(patch('fill-on', false)(base).fillOn).toBe(false);
    expect(patch('stroke-on', true)(base).strokeOn).toBe(true);
    expect(patch('fill-rule', 'evenodd')(base).fillRule).toBe('evenodd');
    expect(patch('cap', 'square')(base).cap).toBe('square');
    expect(patch('join', 'round')(base).join).toBe('round');
    expect(interpretControl('fill-rule', 'sideways').ok).toBe(false);
    expect(interpretControl('cap', 'flat').ok).toBe(false);
    expect(interpretControl('join', 'sharp').ok).toBe(false);
    expect(interpretControl('fill-on', 'yes').ok).toBe(false);
  });
});

describe('V2-A8 edit flow with a plain fake synchronization', () => {
  it('sends one change with one updated node and revision = baseRevision + 1 on a successful Apply', () => {
    const { editor, changes } = harness();
    editor.start();
    const outcome = editor.apply('M 0 0 L 100 0 L 100 100 Z');
    expect(outcome.status).toBe('applied');
    expect(changes).toHaveLength(1);
    const change = changes[0]!;
    expect(change.revision).toBe(change.baseRevision + 1);
    expect(change.baseRevision).toBe(1);
    expect(change.updated).toHaveLength(1);
    expect(change.inserted).toEqual([]);
    expect(change.removed).toEqual([]);
    expect(change.orders).toEqual([]);
    expect(pathNode(change.updated[0]!).id).toBe('v2-path');
    expect(editor.revision).toBe(2);
    expect(editor.generation).toBe(2);
    expect(editor.appliedText).toBe('M 0 0 L 100 0 L 100 100 Z');
  });

  it('sends no change for equal data (other whitespace) and reports unchanged', () => {
    const { editor, changes } = harness();
    editor.start();
    editor.apply('M 0 0 L 10 10');
    const before = changes.length;
    const revision = editor.revision;
    const generation = editor.generation;
    const outcome = editor.apply('  M0,0\nL 10,10  ');
    expect(outcome.status).toBe('unchanged');
    expect(changes).toHaveLength(before);
    expect(editor.revision).toBe(revision);
    expect(editor.generation).toBe(generation);
    expect(editor.appliedText).toBe('  M0,0\nL 10,10  ');
  });

  it('sends no change and keeps the state on a parse error', () => {
    const { editor, changes } = harness();
    editor.start();
    editor.apply('M 0 0 L 10 10');
    const state = {
      revision: editor.revision,
      generation: editor.generation,
      geometry: editor.geometry,
      text: editor.appliedText,
      appearance: editor.appearance,
    };
    const before = changes.length;
    const outcome = editor.apply('M 10 10 L 20');
    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.error.code).toBe('expected-number');
      expect(outcome.error.offset).toBe(12);
    }
    expect(changes).toHaveLength(before);
    expect({
      revision: editor.revision,
      generation: editor.generation,
      geometry: editor.geometry,
      text: editor.appliedText,
      appearance: editor.appearance,
    }).toEqual(state);
  });

  it('never parses or sends on typing or blur: only apply() reaches the parser', () => {
    // The editor has no text-input method; typing, input and blur events cannot reach it. A fake
    // synchronization records that nothing happens between start and an explicit apply.
    const { editor, changes, queue } = harness();
    editor.start();
    expect(changes).toHaveLength(0);
    expect(queue).toHaveLength(0);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(editor))).not.toContain('setText');
  });

  it('coalesces appearance edits to one change per scheduled run, with the latest values', () => {
    const { editor, changes, runQueue, queue } = harness();
    editor.start();
    expect(editor.edit(patch('stroke-on', true))).toBe(true);
    expect(editor.edit(patch('cap', 'round'))).toBe(true);
    expect(editor.edit(patch('join', 'bevel'))).toBe(true);
    expect(queue).toHaveLength(1);
    expect(changes).toHaveLength(0);
    runQueue();
    expect(changes).toHaveLength(1);
    const node = pathNode(changes[0]!.updated[0]!);
    expect(node.style.stroke).toMatchObject({ cap: 'round', join: 'bevel', width: 4 });
    expect(editor.revision).toBe(2);
    // The geometry did not change, so the generation did not either.
    expect(editor.generation).toBe(1);
  });

  it('returns false for an edit that changes nothing', () => {
    const { editor, changes, runQueue } = harness();
    editor.start();
    expect(editor.edit(patch('fill-on', true))).toBe(false);
    expect(editor.edit(patch('fill-rule', 'nonzero'))).toBe(false);
    runQueue();
    expect(changes).toHaveLength(0);
  });

  it('includes a pending appearance edit in the Apply change and sends one change', () => {
    const { editor, changes, runQueue } = harness();
    editor.start();
    editor.edit(patch('stroke-on', true));
    editor.apply('M 0 0 L 5 5');
    runQueue();
    expect(changes).toHaveLength(1);
    expect(pathNode(changes[0]!.updated[0]!).style.stroke).not.toBeNull();
  });

  it('answers resync-required with one replaceSnapshot of the whole current state', () => {
    let first = true;
    const { editor, snapshots, mirror } = harness({
      applyChanges: () => {
        if (first) {
          first = false;
          return {
            status: 'resync-required',
            current: { revision: 7 },
          } as unknown as SceneApplyResult;
        }
        return { status: 'applied', current: { revision: 99 } } as unknown as SceneApplyResult;
      },
    });
    editor.start();
    editor.apply('M 0 0 L 9 9');
    expect(snapshots).toEqual([1, 8]);
    expect(editor.revision).toBe(8);
    expect(mirror.getSynchronizationState().current?.revision).toBe(8);
  });

  it('reverts on invalid-scene and lists the reason', () => {
    const { editor } = harness({
      applyChanges: () =>
        ({ status: 'invalid-scene', reason: 'invalid-value' }) as SceneApplyResult,
    });
    editor.start();
    const before = editor.geometry;
    editor.apply('M 0 0 L 9 9');
    expect(editor.geometry).toBe(before);
    expect(editor.errors.join('\n')).toContain('invalid-scene (invalid-value)');
  });

  it('stops edits after disposed', () => {
    const { editor, changes } = harness({
      applyChanges: () => ({ status: 'disposed' }),
    });
    editor.start();
    editor.apply('M 0 0 L 9 9');
    expect(editor.stopped).toBe(true);
    expect(editor.edit(patch('fill-on', false))).toBe(false);
    expect(editor.apply('M 1 1').status).toBe('not-applied');
    expect(changes).toHaveLength(0);
  });

  it('disables the controls when a replaceSnapshot fails, with no retry', () => {
    let calls = 0;
    const { editor } = harness({
      applyChanges: () =>
        ({ status: 'resync-required', current: null }) as unknown as SceneApplyResult,
      replaceSnapshot: () => {
        calls += 1;
        return calls === 1
          ? ({ status: 'applied', current: { revision: 1 } } as unknown as SceneApplyResult)
          : ({ status: 'invalid-scene', reason: 'invalid-value' } as SceneApplyResult);
      },
    });
    editor.start();
    editor.apply('M 0 0 L 9 9');
    expect(calls).toBe(2);
    expect(editor.disabledReason).toContain('replaceSnapshot (resync)');
    expect(editor.edit(patch('fill-on', false))).toBe(false);
    expect(editor.apply('M 5 5').status).toBe('not-applied');
    expect(calls).toBe(2);
  });

  it('applies a mapped change through a real mirror, including a zero-verb path', () => {
    const { editor, mirror } = harness();
    editor.start();
    expect(editor.apply('M 0 0 C 1 1 2 2 3 3 Z').status).toBe('applied');
    expect(editor.apply('').status).toBe('applied');
    expect(editor.geometry.verbs).toEqual([]);
    expect(editor.revision).toBe(3);
    expect(mirror.getSynchronizationState().current?.revision).toBe(3);
  });

  it('compares path data under the replay rule (element by element, ===)', () => {
    expect(
      pathDataEqual({ verbs: ['move'], points: [1, 2] }, { verbs: ['move'], points: [1, 2] }),
    ).toBe(true);
    expect(
      pathDataEqual({ verbs: ['move'], points: [1, 2] }, { verbs: ['move'], points: [1, 3] }),
    ).toBe(false);
    expect(pathDataEqual({ verbs: ['move'], points: [0] }, { verbs: ['line'], points: [0] })).toBe(
      false,
    );
    expect(
      singleNodeChange(nodeFor({ verbs: [], points: [] }, INITIAL_APPEARANCE), 4).revision,
    ).toBe(5);
  });
});

describe('V2-A13 fit rule', () => {
  const geometry = (points: number[]) => ({ verbs: ['move'] as const, points });
  const none = { ...INITIAL_APPEARANCE, strokeOn: false };

  it('fits the box with the margin of 24 CSS px on a 720 x 600 surface', () => {
    const camera = fitCamera(geometry([0, 0, 100, 50]), none);
    // hx = 50, hy = 25: zx = 336 / 50 = 6.72, zy = 276 / 25 = 11.04.
    expect(camera.zoom).toBe(336 / 50);
    expect(camera.position).toEqual({ x: 50 - 360 / (336 / 50), y: 25 - 300 / (336 / 50) });
  });

  it('adds the half stroke width after the half extent only when the stroke is on with width above 0', () => {
    const on = { ...INITIAL_APPEARANCE, strokeOn: true, strokeWidth: 20 };
    expect(fitCamera(geometry([0, 0, 100, 50]), on).zoom).toBe(336 / (50 + 10));
    expect(fitCamera(geometry([0, 0, 100, 50]), { ...on, strokeWidth: 0 }).zoom).toBe(336 / 50);
    expect(fitCamera(geometry([0, 0, 100, 50]), { ...on, strokeOn: false }).zoom).toBe(336 / 50);
  });

  it('uses the y axis when it is the tighter one', () => {
    const camera = fitCamera(geometry([0, 0, 10, 100]), none);
    expect(camera.zoom).toBe(276 / 50);
  });

  it('includes control points in the box', () => {
    const cubic = { verbs: ['move', 'cubic'] as const, points: [0, 0, 0, -100, 100, -100, 100, 0] };
    expect(fitCamera(cubic, none).zoom).toBe(Math.min(336 / 50, 276 / 50));
  });

  it('gives zoom 1 for an empty path and for a one-point path', () => {
    expect(fitCamera({ verbs: [], points: [] }, none)).toEqual({
      position: { x: -360, y: -300 },
      zoom: 1,
    });
    expect(fitCamera(geometry([5, 5]), none)).toEqual({
      position: { x: 5 - 360, y: 5 - 300 },
      zoom: 1,
    });
    // A one-point path with a stroke fits to the stroke's extent.
    expect(fitCamera(geometry([5, 5]), { ...none, strokeOn: true, strokeWidth: 4 }).zoom).toBe(
      Math.min(336 / 2, 276 / 2),
    );
  });

  it('gives 2^20 for a subnormal extent, not 1', () => {
    const parsed = parsePathData('M 0 0 H 1e-323');
    if (parsed.status !== 'ok') throw new Error('parse');
    expect(parsed.points[2]).toBe(1e-323);
    // hx = 5e-324 * 2 / 2: 336 / hx overflows to Infinity and the clamp turns it into 2^20.
    expect(fitCamera(parsed, none).zoom).toBe(2 ** 20);
  });

  it('clamps quotients below 2^-20 and above 2^20', () => {
    expect(fitCamera(geometry([0, 0, 2 ** 24, 2 ** 24]), none).zoom).toBe(276 / 2 ** 23);
    expect(fitCamera(geometry([0, 0, 1e-300, 1e-300]), none).zoom).toBe(2 ** 20);
    const huge = fitCamera(geometry([-(2 ** 24), -(2 ** 24), 2 ** 24, 2 ** 24]), {
      ...none,
      strokeOn: true,
      strokeWidth: 1024,
    });
    expect(huge.zoom).toBeGreaterThanOrEqual(2 ** -20);
    expect(huge.zoom).toBeLessThanOrEqual(2 ** 20);
    // A quotient below 2^-20 (hx > 336 * 2^20) cannot arise under the page limits: pin the clamp.
    expect(fitCamera(geometry([0, 0, 4e9, 0]), none).zoom).toBe(2 ** -20);
  });

  it('computes the center as (min + max) / 2 and the position as center - half surface / zoom', () => {
    const camera = fitCamera(geometry([10, 20, 110, 70]), none);
    const zoom = Math.min(336 / 50, 276 / 25);
    expect(camera).toEqual({ position: { x: 60 - 360 / zoom, y: 45 - 300 / zoom }, zoom });
  });
});

describe('V2-A8 derived status', () => {
  const notice = (
    sequence: number,
    paint: 'fill' | 'stroke',
    failureCode: string,
    toleranceExponent: number | null = 0,
    nodeId: string | null = NODE_ID,
  ) => ({ sequence, nodeId, paint, failureCode, toleranceExponent });
  const stroked: AppearanceState = { ...INITIAL_APPEARANCE, strokeOn: true };

  it('shows each paint only while it is on, the stroke only with width above 0', () => {
    const tracker = new PathStatusTracker(1, INITIAL_APPEARANCE);
    expect(tracker.status().fill.shown).toBe(true);
    expect(tracker.status().stroke.shown).toBe(false);
    tracker.setState(1, stroked);
    expect(tracker.status().stroke.shown).toBe(true);
    tracker.setState(1, { ...stroked, strokeWidth: 0 });
    expect(tracker.status().stroke.shown).toBe(false);
  });

  it('reports a fill failure as not drawn, and drops it when the geometry generation changes', () => {
    const tracker = new PathStatusTracker(1, INITIAL_APPEARANCE);
    tracker.addNotice(notice(1, 'fill', 'work-limit'));
    expect(tracker.status().fill.outcome).toBe('not drawn');
    expect(tracker.status().pathDrawn).toBe(false);
    tracker.setState(2, INITIAL_APPEARANCE);
    expect(tracker.status().fill.outcome).toBe('drawn');
    expect(tracker.status().pathDrawn).toBe(true);
  });

  it('keys the fill by (generation, rule) and the stroke by (generation, width, cap, join, miter limit)', () => {
    const tracker = new PathStatusTracker(1, stroked);
    tracker.addNotice(notice(1, 'fill', 'work-limit'));
    tracker.addNotice(notice(2, 'stroke', 'work-limit'));
    // The fill off and on again with the same rule keeps the record.
    tracker.setState(1, { ...stroked, fillOn: false });
    tracker.setState(1, stroked);
    expect(tracker.status().fill.code).toBe('work-limit');
    // A width change drops the stroke record only.
    tracker.setState(1, { ...stroked, strokeWidth: 9 });
    expect(tracker.status().stroke.code).toBeNull();
    expect(tracker.status().fill.code).toBe('work-limit');
    // A rule change drops the fill record only.
    tracker.setState(1, { ...stroked, strokeWidth: 9, fillRule: 'evenodd' });
    expect(tracker.status().fill.code).toBeNull();
    // A new generation drops both even when a paint is off.
    tracker.addNotice(notice(3, 'stroke', 'work-limit'));
    tracker.setState(2, { ...stroked, strokeWidth: 9, fillRule: 'evenodd' });
    expect(tracker.status().stroke.code).toBeNull();
  });

  it('keeps a record when the generation does not change (an Apply reported Unchanged)', () => {
    const tracker = new PathStatusTracker(3, INITIAL_APPEARANCE);
    tracker.addNotice(notice(1, 'fill', 'work-limit'));
    tracker.setState(3, INITIAL_APPEARANCE);
    expect(tracker.status().fill.code).toBe('work-limit');
  });

  it('keeps per-exponent records and shows the most recent notice', () => {
    const tracker = new PathStatusTracker(1, INITIAL_APPEARANCE);
    tracker.addNotice(notice(1, 'fill', 'work-limit', 2));
    tracker.addNotice(notice(2, 'fill', 'work-limit', 3));
    const fill = tracker.status().fill;
    expect(fill.perExponent).toEqual(['e=2 work-limit', 'e=3 work-limit']);
    expect(fill.text).toBe('not drawn (work-limit)');
  });

  it('shows fringe-work-cap as drawn without fringe and ignores other nodes', () => {
    const tracker = new PathStatusTracker(1, stroked);
    tracker.addNotice(notice(1, 'stroke', 'fringe-work-cap'));
    expect(tracker.status().stroke.outcome).toBe('drawn without fringe');
    expect(tracker.status().pathDrawn).toBe(true);
    tracker.addNotice(notice(2, 'fill', 'work-limit', 0, 'other-node'));
    expect(tracker.status().fill.outcome).toBe('drawn');
  });

  it('adds "may differ" after a zoom change, and a geometry-changing Apply clears it', () => {
    const tracker = new PathStatusTracker(1, INITIAL_APPEARANCE);
    expect(tracker.status().label).toBe('derived from notices; the notice log is authoritative');
    tracker.zoomChanged();
    expect(tracker.status().label).toBe(
      'derived from notices; may differ; the notice log is authoritative',
    );
    tracker.setState(1, { ...INITIAL_APPEARANCE, fillOn: false });
    expect(tracker.status().label).toContain('may differ');
    tracker.setState(2, INITIAL_APPEARANCE);
    expect(tracker.status().label).toBe('derived from notices; the notice log is authoritative');
  });

  it('shows state failures as may have cleared and clears them on a zoom change', () => {
    const tracker = new PathStatusTracker(1, INITIAL_APPEARANCE);
    tracker.addNotice(notice(1, 'fill', 'tolerance-range', 5));
    expect(tracker.status().fill.mayHaveCleared).toBe(true);
    expect(tracker.status().fill.text).toContain('may have cleared');
    tracker.zoomChanged();
    expect(tracker.status().fill.outcome).toBe('drawn');
  });
});
