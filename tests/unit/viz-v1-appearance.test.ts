import type {
  RenderChangeSet,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  SceneApplyResult,
  SceneVersion,
} from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import { B2_PATHS } from '../../apps/playground/src/p3-b2-strokes-scene.js';
import { V4_PATHS } from '../../apps/playground/src/p3-v4-paths-scene.js';
import {
  DEFAULT_TARGET_ID,
  VIZ_V1_TARGETS,
  targetById,
} from '../../apps/playground/src/viz-v1-appearance-scene.js';
import {
  AppearanceEditor,
  CONTROL_KINDS,
  TargetStatusTracker,
  VIZ_V1_IDENTITY,
  appearanceSnapshot,
  appliesOn,
  cloneState,
  initialStates,
  interpretControl,
  nodeFor,
  parseBoundedNumber,
  parseHexColor,
  parseNotice,
  toHex,
  type ControlEvent,
  type ControlId,
  type EditorSync,
} from '../../apps/playground/src/viz-v1-appearance-state.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';

// Visualization track V-1 (docs/plans/viz-v1-path-appearance-contract.md), acceptance criteria
// V1-A3 to V1-A6: the state-to-scene mapping, the change shape and its acceptance by the mirror,
// the edit flow with a plain fake synchronization, and input validation. Functional evidence
// only: precision is UNVERIFIED against the 0.25 physical-pixel target.

/** Literal copies of the reused path data, so a change to B2_PATHS or V4_PATHS fails here first. */
const PINNED_PATHS: Readonly<Record<string, { verbs: string[]; points: number[] }>> = {
  'v1-square': {
    verbs: ['move', 'line', 'line', 'line', 'close'],
    points: [-30, -30, 30, -30, 30, 30, -30, 30],
  },
  'v1-star': {
    verbs: ['move', 'line', 'line', 'line', 'line', 'close'],
    points: [
      2.7554552980815448e-15, -45, 26.45033635316129, 36.405764746872634, -42.797543233281914,
      -13.905764746872627, 42.79754323328191, -13.905764746872643, -26.45033635316128,
      36.40576474687264,
    ],
  },
  'v1-zigzag': {
    verbs: ['move', 'line', 'line', 'line'],
    points: [-50, 22, -18, -22, 14, 22, 46, -22],
  },
  'v1-chevron': {
    verbs: ['move', 'line', 'line'],
    points: [-15.529142706151244, 27.9555495773441, 0, -30, 15.529142706151244, 27.9555495773441],
  },
  'v1-circle': {
    verbs: ['move', 'cubic', 'cubic', 'cubic', 'cubic', 'close'],
    points: [
      30, 0, 30, 16.568542494923808, 16.568542494923808, 30, 0, 30, -16.568542494923808, 30, -30,
      16.568542494923808, -30, 0, -30, -16.568542494923808, -16.568542494923808, -30, 0, -30,
      16.568542494923808, -30, 30, -16.568542494923808, 30, 0,
    ],
  },
};

const square = () => targetById('v1-square')!;
const edit = (id: ControlId, raw: string | boolean) => {
  const result = interpretControl(id, raw);
  if (!result.ok) throw new Error(result.message);
  return result.patch;
};
const pathNode = (id: string, state = initialStates()[id]!) =>
  nodeFor(targetById(id)!, state) as Extract<RenderNodeSnapshot, { kind: 'path' }>;

describe('V1-A3 state to scene mapping', () => {
  it('maps every control to the expected PathStyle, fillRule and opacity', () => {
    const start = initialStates()['v1-square']!;
    const apply = (id: ControlId, raw: string | boolean) =>
      pathNode('v1-square', edit(id, raw)(start));
    expect(apply('fill-color', '#336699').style.fill).toEqual({
      r: 0x33 / 255,
      g: 0x66 / 255,
      b: 0x99 / 255,
      a: 1,
    });
    expect(apply('fill-alpha', '0.25').style.fill).toEqual({ ...start.fill, a: 0.25 });
    expect(apply('fill-rule', 'evenodd').geometry.fillRule).toBe('evenodd');
    expect(apply('stroke-color', '#ff0000').style.stroke?.color).toEqual({
      r: 1,
      g: 0,
      b: 0,
      a: 1,
    });
    expect(apply('stroke-alpha', '0.5').style.stroke?.color.a).toBe(0.5);
    expect(apply('stroke-width-number', '12.3456').style.stroke?.width).toBe(12.3456);
    expect(apply('stroke-width-slider', '24').style.stroke?.width).toBe(24);
    expect(apply('cap', 'round').style.stroke?.cap).toBe('round');
    expect(apply('join', 'bevel').style.stroke?.join).toBe('bevel');
    expect(apply('miter-number', '7.25').style.stroke?.miterLimit).toBe(7.25);
    expect(apply('miter-slider', '2.5').style.stroke?.miterLimit).toBe(2.5);
    expect(apply('opacity-slider', '0.5').opacity).toBe(0.5);
    expect(apply('opacity-number', '0.33').opacity).toBe(0.33);
    // The untouched fields stay as they were.
    const widthOnly = apply('stroke-width-number', '3');
    expect(widthOnly.style.fill).toEqual(start.fill);
    expect(widthOnly.geometry.fillRule).toBe('nonzero');
    expect(widthOnly.opacity).toBe(1);
  });

  it('maps #rrggbb to channel / 255 exactly for 0, 1, 127, 128 and 255', () => {
    for (const channel of [0, 1, 127, 128, 255]) {
      const hex = channel.toString(16).padStart(2, '0');
      expect(parseHexColor(`#${hex}${hex}${hex}`)).toEqual({
        r: channel / 255,
        g: channel / 255,
        b: channel / 255,
      });
    }
    expect(toHex({ r: 1 / 255, g: 127 / 255, b: 128 / 255 })).toBe('#017f80');
  });

  it('fill off gives fill null, stroke off gives stroke null, and width 0 stays a stroke of width 0', () => {
    const start = initialStates()['v1-square']!;
    expect(pathNode('v1-square', edit('fill-on', false)(start)).style.fill).toBeNull();
    expect(pathNode('v1-square', edit('stroke-on', false)(start)).style.stroke).toBeNull();
    const zero = pathNode('v1-square', edit('stroke-width-number', '0')(start));
    expect(zero.style.stroke).not.toBeNull();
    expect(zero.style.stroke?.width).toBe(0);
    // Turning the stroke off and on restores its last fields; the page never sends null fields.
    const off = edit('stroke-on', false)(edit('stroke-width-number', '9')(start));
    const on = pathNode('v1-square', edit('stroke-on', true)(off));
    expect(on.style.stroke).toEqual({ ...start.stroke, width: 9 });
  });

  it('reuses the initial scene verbs and points by reference', () => {
    const states = initialStates();
    const snapshot = appearanceSnapshot(states, 1);
    for (const target of VIZ_V1_TARGETS) {
      const initialNode = snapshot.nodes.find((node) => node.id === target.id) as Extract<
        RenderNodeSnapshot,
        { kind: 'path' }
      >;
      const changed = pathNode(target.id, edit('opacity-number', '0.5')(states[target.id]!));
      expect(changed.geometry.verbs).toBe(initialNode.geometry.verbs);
      expect(changed.geometry.points).toBe(initialNode.geometry.points);
    }
  });

  it('round-trips the state through JSON unchanged', () => {
    const states = initialStates();
    expect(JSON.parse(JSON.stringify(states))).toEqual(states);
    const edited = edit('stroke-width-number', '17.5')(states['v1-zigzag']!);
    expect(JSON.parse(JSON.stringify(edited))).toEqual(edited);
    expect(cloneState(edited)).toEqual(edited);
  });

  it('pins each target path to a literal copy of the reused B2 and V4 data', () => {
    expect(VIZ_V1_TARGETS.map((target) => target.id)).toEqual(Object.keys(PINNED_PATHS));
    for (const target of VIZ_V1_TARGETS) {
      const pinned = PINNED_PATHS[target.id]!;
      expect(target.data.verbs, target.id).toEqual(pinned.verbs);
      expect(target.data.points, target.id).toEqual(pinned.points);
    }
    // And the sources are the exported specs the table of section 3.1 names.
    const b2 = (id: string) => B2_PATHS.find((path) => path.id === id)!;
    expect(square().data).toBe(b2('fill-stroke-square').data);
    expect(targetById('v1-zigzag')!.data).toBe(b2('cap-butt').data);
    expect(targetById('v1-chevron')!.data).toBe(b2('miter-limit-keeps').data);
    expect(targetById('v1-circle')!.data).toBe(b2('fill-stroke-circle').data);
    expect(targetById('v1-star')!.data).toBe(V4_PATHS.find((p) => p.id === 'star-nonzero')!.data);
  });

  it('starts every target with the initial appearance and off-paint defaults of section 3.1', () => {
    expect(DEFAULT_TARGET_ID).toBe('v1-square');
    const states = initialStates();
    expect(states['v1-square']).toMatchObject({ fillOn: true, strokeOn: true });
    expect(states['v1-square']!.stroke).toMatchObject({ width: 10, cap: 'butt', join: 'miter' });
    expect(states['v1-star']).toMatchObject({ fillOn: true, strokeOn: false, fillRule: 'nonzero' });
    expect(states['v1-star']!.stroke).toMatchObject({ width: 4, cap: 'butt', join: 'miter' });
    expect(states['v1-star']!.stroke.color).toEqual({ r: 0.25, g: 0.6, b: 1, a: 1 });
    expect(states['v1-zigzag']).toMatchObject({ fillOn: false, strokeOn: true });
    expect(states['v1-zigzag']!.stroke.width).toBe(14);
    expect(states['v1-chevron']).toMatchObject({ fillOn: false, strokeOn: true });
    expect(states['v1-chevron']!.stroke).toMatchObject({ width: 12, miterLimit: 4 });
    expect(states['v1-circle']).toMatchObject({ fillOn: true, strokeOn: false });
    expect(states['v1-circle']!.stroke).toMatchObject({ width: 8, cap: 'butt', join: 'round' });
    // Off paints map to null in the initial scene.
    expect(pathNode('v1-star').style.stroke).toBeNull();
    expect(pathNode('v1-zigzag').style.fill).toBeNull();
  });
});

const supported = {
  pathNodes: 'supported',
  pathFills: 'supported',
  pathStrokes: 'supported',
} as const;

describe('V1-A4 change shape and acceptance', () => {
  it('sends one one-node change set per flush, and the mirror applies every mapped change', () => {
    const mirror = new RetainedSceneMirror(undefined, supported);
    const changes: RenderChangeSet[] = [];
    const queue: Array<() => void> = [];
    const editor = new AppearanceEditor({
      sync: {
        replaceSnapshot: (snapshot) => mirror.replaceSnapshot(snapshot),
        applyChanges: (change) => {
          changes.push(change);
          return mirror.applyChanges(change);
        },
      },
      schedule: (run) => queue.push(run),
    });
    expect(editor.start().status).toBe('applied');
    const run = () => queue.splice(0).forEach((job) => job());
    const geometryRevision = () => mirror.readRetainedScene()!.getGeometryRevision('v1-square');
    const before = geometryRevision();
    const steps: Array<[ControlId, string | boolean]> = [
      ['fill-color', '#112233'],
      ['fill-alpha', '0.5'],
      ['fill-rule', 'evenodd'],
      ['stroke-color', '#445566'],
      ['stroke-alpha', '0.75'],
      ['stroke-width-number', '0'],
      ['stroke-width-number', '33'],
      ['cap', 'square'],
      ['join', 'round'],
      ['miter-number', '99.5'],
      ['opacity-number', '0.4'],
      ['fill-on', false],
      ['stroke-on', false],
    ];
    for (const [id, raw] of steps) {
      expect(editor.edit('v1-square', edit(id, raw)), id).toBe(true);
      run();
      expect(mirror.getSynchronizationState().status).toBe('synchronized');
    }
    expect(changes).toHaveLength(steps.length);
    changes.forEach((change, index) => {
      expect(change.updated).toHaveLength(1);
      expect(change.inserted).toEqual([]);
      expect(change.removed).toEqual([]);
      expect(change.orders).toEqual([]);
      expect(change.revision).toBe(change.baseRevision + 1);
      expect(change.baseRevision).toBe(index + 1);
      expect(change.identity).toEqual(VIZ_V1_IDENTITY);
    });
    expect(editor.revision).toBe(steps.length + 1);
    expect(mirror.readRetainedScene()!.version.revision).toBe(steps.length + 1);
    // Fill-rule, style and opacity changes leave the geometry revision unchanged.
    expect(geometryRevision()).toBe(before);
  });

  it('applies the one-node "Reset target" change', () => {
    const mirror = new RetainedSceneMirror(undefined, supported);
    const changes: RenderChangeSet[] = [];
    const queue: Array<() => void> = [];
    const editor = new AppearanceEditor({
      sync: {
        replaceSnapshot: (snapshot) => mirror.replaceSnapshot(snapshot),
        applyChanges: (change) => {
          changes.push(change);
          return mirror.applyChanges(change);
        },
      },
      schedule: (run) => queue.push(run),
    });
    editor.start();
    editor.edit('v1-circle', edit('stroke-on', true));
    queue.splice(0).forEach((job) => job());
    expect(editor.resetTarget('v1-circle')).toBe(true);
    queue.splice(0).forEach((job) => job());
    expect(changes).toHaveLength(2);
    expect(changes[1]!.updated).toHaveLength(1);
    expect(changes[1]!.updated[0]).toEqual(
      nodeFor(targetById('v1-circle')!, targetById('v1-circle')!.initial),
    );
    expect(editor.states['v1-circle']).toEqual(targetById('v1-circle')!.initial);
  });
});

type Call =
  | { kind: 'replace'; revision: number; snapshot: RenderSceneSnapshot }
  | { kind: 'apply'; change: RenderChangeSet };

const version = (revision: number): SceneVersion => ({ identity: VIZ_V1_IDENTITY, revision });

function fake(script: {
  apply?: (change: RenderChangeSet) => SceneApplyResult;
  replace?: (snapshot: RenderSceneSnapshot) => SceneApplyResult;
}) {
  const calls: Call[] = [];
  const sync: EditorSync = {
    replaceSnapshot: (snapshot) => {
      calls.push({ kind: 'replace', revision: snapshot.revision, snapshot });
      return (
        script.replace?.(snapshot) ?? { status: 'applied', current: version(snapshot.revision) }
      );
    },
    applyChanges: (change) => {
      calls.push({ kind: 'apply', change });
      return script.apply?.(change) ?? { status: 'applied', current: version(change.revision) };
    },
  };
  const queue: Array<() => void> = [];
  const editor = new AppearanceEditor({ sync, schedule: (run) => queue.push(run) });
  editor.start();
  calls.length = 0;
  return { calls, queue, editor, run: () => queue.splice(0).forEach((job) => job()) };
}

describe('V1-A5 edit flow', () => {
  it('coalesces several edits before one flush into one change with the latest values', () => {
    const { calls, queue, editor, run } = fake({});
    editor.edit('v1-square', edit('opacity-slider', '0.9'));
    editor.edit('v1-square', edit('opacity-slider', '0.7'));
    editor.edit('v1-square', edit('opacity-slider', '0.5'));
    editor.edit('v1-square', edit('cap', 'round'));
    expect(queue).toHaveLength(1);
    expect(calls).toHaveLength(0);
    run();
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.kind).toBe('apply');
    if (call.kind !== 'apply') return;
    const node = call.change.updated[0] as ReturnType<typeof pathNode>;
    expect(node.opacity).toBe(0.5);
    expect(node.style.stroke?.cap).toBe('round');
    expect(editor.revision).toBe(2);
  });

  it('drops an edit that changes nothing', () => {
    const { calls, queue, editor, run } = fake({});
    expect(editor.edit('v1-square', edit('fill-rule', 'nonzero'))).toBe(false);
    expect(queue).toHaveLength(0);
    run();
    expect(calls).toHaveLength(0);
  });

  it('sends one change for an edit sequence that targets two paths, one node each', () => {
    const { calls, editor, run } = fake({});
    editor.edit('v1-square', edit('opacity-slider', '0.5'));
    editor.edit('v1-star', edit('fill-rule', 'evenodd'));
    run();
    const applies = calls.filter((call) => call.kind === 'apply');
    expect(applies).toHaveLength(2);
    for (const call of applies) {
      if (call.kind === 'apply') expect(call.change.updated).toHaveLength(1);
    }
  });

  it('answers resync-required with exactly one replaceSnapshot of the whole current state', () => {
    const { calls, editor, run } = fake({
      apply: () => ({ status: 'resync-required', current: version(7) }),
    });
    editor.edit('v1-square', edit('opacity-slider', '0.5'));
    run();
    expect(calls.map((call) => call.kind)).toEqual(['apply', 'replace']);
    const replace = calls[1]!;
    if (replace.kind !== 'replace') throw new Error('expected a replace');
    expect(replace.revision).toBe(8);
    expect(replace.snapshot).toEqual(appearanceSnapshot(editor.states, 8));
    expect(editor.revision).toBe(8);
    // A resync with no renderer version resyncs at the page's revision + 1.
    const second = fake({ apply: () => ({ status: 'resync-required', current: null }) });
    second.editor.edit('v1-square', edit('opacity-slider', '0.5'));
    second.run();
    const replaced = second.calls[1]!;
    expect(replaced.kind === 'replace' && replaced.revision).toBe(2);
  });

  it('disables further edits after a failing replaceSnapshot and does not retry', () => {
    let failing = false;
    const { calls, editor, run } = fake({
      apply: () => ({ status: 'resync-required', current: null }),
      replace: (snapshot) =>
        failing
          ? { status: 'invalid-scene', reason: 'invalid-value', current: null }
          : { status: 'applied', current: version(snapshot.revision) },
    });
    failing = true;
    editor.edit('v1-square', edit('opacity-slider', '0.5'));
    run();
    expect(calls.map((call) => call.kind)).toEqual(['apply', 'replace']);
    expect(editor.disabledReason).not.toBeNull();
    expect(editor.errors).toHaveLength(1);
    expect(editor.edit('v1-square', edit('opacity-slider', '0.25'))).toBe(false);
    expect(editor.resetTarget('v1-square')).toBe(false);
    editor.resetAll();
    run();
    expect(calls).toHaveLength(2);
  });

  it('"Reset all" is one replaceSnapshot of the initial scene at the next revision', () => {
    const { calls, editor, run } = fake({});
    editor.edit('v1-square', edit('opacity-slider', '0.5'));
    run();
    calls.length = 0;
    editor.edit('v1-circle', edit('stroke-on', true));
    editor.resetAll();
    run();
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.kind).toBe('replace');
    if (call.kind !== 'replace') return;
    expect(call.revision).toBe(3);
    expect(call.snapshot).toEqual(appearanceSnapshot(initialStates(), 3));
    expect(editor.states).toEqual(initialStates());
  });

  it('reverts to the last applied state on invalid-scene and records the reason', () => {
    let reject = false;
    const { calls, editor, run } = fake({
      apply: (change) =>
        reject
          ? {
              status: 'invalid-scene',
              reason: 'invalid-value',
              current: version(change.baseRevision),
            }
          : { status: 'applied', current: version(change.revision) },
    });
    editor.edit('v1-square', edit('opacity-slider', '0.5'));
    run();
    reject = true;
    editor.edit('v1-square', edit('opacity-slider', '0.25'));
    run();
    expect(calls).toHaveLength(2);
    expect(editor.states['v1-square']!.opacity).toBe(0.5);
    expect(editor.revision).toBe(2);
    expect(editor.errors).toHaveLength(1);
    expect(editor.errors[0]).toContain('invalid-value');
    expect(editor.disabledReason).toBeNull();
  });

  it('stops further calls after disposed', () => {
    const { calls, editor, run } = fake({ apply: () => ({ status: 'disposed' }) });
    editor.edit('v1-square', edit('opacity-slider', '0.5'));
    run();
    expect(editor.stopped).toBe(true);
    expect(editor.edit('v1-square', edit('opacity-slider', '0.25'))).toBe(false);
    run();
    expect(calls).toHaveLength(1);
  });

  it('applies the commit rule to every control', () => {
    const live: ControlId[] = [];
    const commitOnly: ControlId[] = [];
    for (const id of Object.keys(CONTROL_KINDS) as ControlId[]) {
      const kind = CONTROL_KINDS[id];
      if (appliesOn(kind, 'input')) live.push(id);
      else commitOnly.push(id);
    }
    // `input` alone produces a change only for the opacity slider, radios, checkboxes and colors.
    expect(live.sort()).toEqual(
      [
        'cap',
        'fill-color',
        'fill-on',
        'fill-rule',
        'join',
        'opacity-slider',
        'stroke-color',
        'stroke-on',
      ].sort(),
    );
    // The width and miter-limit sliders and every number field apply on commit only.
    expect(commitOnly.sort()).toEqual(
      [
        'fill-alpha',
        'miter-number',
        'miter-slider',
        'opacity-number',
        'stroke-alpha',
        'stroke-width-number',
        'stroke-width-slider',
      ].sort(),
    );
    expect(appliesOn(CONTROL_KINDS['stroke-width-slider'], 'change')).toBe(true);
    expect(appliesOn(CONTROL_KINDS['miter-slider'], 'change')).toBe(true);
    for (const id of [
      'fill-alpha',
      'stroke-alpha',
      'stroke-width-number',
      'miter-number',
      'opacity-number',
    ] as const) {
      for (const event of ['change', 'enter', 'blur'] as const) {
        expect(appliesOn(CONTROL_KINDS[id], event), `${id} ${event}`).toBe(true);
      }
      expect(appliesOn(CONTROL_KINDS[id], 'input'), id).toBe(false);
    }
    expect(appliesOn(CONTROL_KINDS['opacity-slider'], 'input')).toBe(true);
  });

  it('drives the controls through the rule: input alone changes nothing for width, miter and numbers; the commit event produces exactly one change', () => {
    const { calls, editor, run } = fake({});
    const fire = (id: ControlId, event: ControlEvent, raw: string | boolean) => {
      if (!appliesOn(CONTROL_KINDS[id], event)) return;
      const result = interpretControl(id, raw);
      if (result.ok) editor.edit('v1-zigzag', result.patch);
    };
    for (let step = 0; step < 20; step += 1)
      fire('stroke-width-slider', 'input', String(15 + step * 0.5));
    run();
    expect(calls).toHaveLength(0);
    fire('stroke-width-slider', 'change', '24.5');
    run();
    expect(calls).toHaveLength(1);
    for (let step = 0; step < 20; step += 1) fire('miter-slider', 'input', String(1 + step * 0.1));
    run();
    expect(calls).toHaveLength(1);
    fire('miter-slider', 'change', '2.9');
    run();
    expect(calls).toHaveLength(2);
    for (const id of ['stroke-alpha', 'opacity-number'] as const) {
      fire(id, 'input', '0.3');
      run();
      expect(calls.length).toBe(2);
    }
    // Change, Enter and blur all commit the same value: only the first alters the state.
    fire('opacity-number', 'change', '0.3');
    fire('opacity-number', 'enter', '0.3');
    fire('opacity-number', 'blur', '0.3');
    run();
    expect(calls).toHaveLength(3);
    // The opacity slider applies live; 20 input events in one task give one change.
    for (let step = 0; step < 20; step += 1)
      fire('opacity-slider', 'input', String(0.9 - step * 0.01));
    run();
    expect(calls).toHaveLength(4);
    const last = calls[3]!;
    if (last.kind === 'apply') {
      expect((last.change.updated[0] as ReturnType<typeof pathNode>).opacity).toBeCloseTo(0.71, 10);
    }
  });
});

describe('V1-A6 input validation', () => {
  const rejected: Array<[ControlId, string]> = [
    ['stroke-width-number', '-1'],
    ['stroke-width-number', '64.5'],
    ['stroke-width-number', 'NaN'],
    ['stroke-width-number', ''],
    ['stroke-width-number', 'Infinity'],
    ['stroke-width-number', '1e999'],
    ['stroke-width-number', '12px'],
    ['stroke-width-slider', '65'],
    ['miter-number', '0.99'],
    ['miter-number', '100.01'],
    ['miter-slider', ''],
    ['opacity-number', '-0.01'],
    ['opacity-number', '1.01'],
    ['opacity-slider', 'abc'],
    ['fill-alpha', '1.5'],
    ['stroke-alpha', '-0.1'],
    ['fill-color', '#12345'],
    ['stroke-color', '#12345g'],
    ['fill-color', 'red'],
    ['fill-color', ''],
  ];

  it('does not apply empty, NaN, out-of-range and malformed values', () => {
    for (const [id, raw] of rejected) {
      const result = interpretControl(id, raw);
      expect(result.ok, `${id} ${raw}`).toBe(false);
      if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
    }
    const { calls, queue, editor, run } = fake({});
    for (const [id, raw] of rejected) {
      const result = interpretControl(id, raw);
      if (result.ok) editor.edit('v1-square', result.patch);
    }
    run();
    expect(queue).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(editor.states).toEqual(initialStates());
  });

  it('applies every value inside the range, including values that are not step multiples', () => {
    const accepted: Array<[ControlId, string, number]> = [
      ['stroke-width-number', '0', 0],
      ['stroke-width-number', '64', 64],
      ['stroke-width-number', '12.3456', 12.3456],
      ['stroke-width-number', ' 7 ', 7],
      ['miter-number', '1', 1],
      ['miter-number', '100', 100],
      ['miter-number', '3.14159', 3.14159],
      ['opacity-number', '0', 0],
      ['opacity-number', '1', 1],
      ['opacity-number', '.005', 0.005],
    ];
    for (const [id, raw, value] of accepted) {
      const result = interpretControl(id, raw);
      expect(result.ok, `${id} ${raw}`).toBe(true);
      const state = result.ok ? result.patch(initialStates()['v1-square']!) : null;
      const mapped = state === null ? null : pathNode('v1-square', state);
      const seen =
        id === 'stroke-width-number'
          ? mapped?.style.stroke?.width
          : id === 'miter-number'
            ? mapped?.style.stroke?.miterLimit
            : mapped?.opacity;
      expect(seen, `${id} ${raw}`).toBe(value);
    }
    expect(parseBoundedNumber('1e-2', 0, 1)).toBe(0.01);
  });
});

describe('V-1 target status (contract section 3.4)', () => {
  const notice = (
    nodeId: string,
    paint: 'fill' | 'stroke' | null,
    failureCode: string,
    toleranceExponent: number | null,
    sequence = 1,
  ) => ({ sequence, nodeId, paint, failureCode, toleranceExponent });

  it('parses only the D8-interim diagnostic', () => {
    expect(parseNotice({ code: 'render.other', sequence: 1 })).toBeNull();
    expect(
      parseNotice({
        code: 'render.path-mesh-interim-failure',
        sequence: 4,
        context: {
          nodeId: 'v1-circle',
          paint: 'stroke',
          failureCode: 'work-limit',
          toleranceExponent: -3,
        },
      }),
    ).toEqual(notice('v1-circle', 'stroke', 'work-limit', -3, 4));
  });

  it('shows a record only while its paint is on and drops it when its key changes', () => {
    const states = { ...initialStates() };
    const tracker = new TargetStatusTracker(states);
    const circle = (
      patch: (
        s: ReturnType<typeof initialStates>[string],
      ) => ReturnType<typeof initialStates>[string],
    ) => patch(states['v1-circle']!);
    const strokeOn = circle(edit('stroke-on', true));
    tracker.setState('v1-circle', strokeOn);
    tracker.addNotice(notice('v1-circle', 'stroke', 'work-limit', -3));
    let status = tracker.status('v1-circle');
    expect(status.stroke.outcome).toBe('not drawn');
    expect(status.pathDrawn).toBe(false);
    expect(status.fill.outcome).toBe('drawn');
    // Stroke off: no stroke key, the entries are deleted, and the record is not shown.
    tracker.setState('v1-circle', edit('stroke-on', false)(strokeOn));
    status = tracker.status('v1-circle');
    expect(status.stroke.shown).toBe(false);
    expect(status.pathDrawn).toBe(true);
    // Turned on once more: the stroke is rebuilt, so the old record is gone until a new notice.
    tracker.setState('v1-circle', strokeOn);
    expect(tracker.status('v1-circle').stroke.outcome).toBe('drawn');
    tracker.addNotice(notice('v1-circle', 'stroke', 'work-limit', -3, 2));
    expect(tracker.status('v1-circle').stroke.outcome).toBe('not drawn');
    // Another stroke key makes the record empty.
    tracker.setState('v1-circle', edit('stroke-width-number', '9')(strokeOn));
    expect(tracker.status('v1-circle').stroke.outcome).toBe('drawn');
    // A width of 0 has no stroke key and shows nothing.
    tracker.setState('v1-circle', edit('stroke-width-number', '0')(strokeOn));
    expect(tracker.status('v1-circle').stroke.shown).toBe(false);
  });

  it('keeps the fill record across fill off and on with an unchanged rule only', () => {
    const states = { ...initialStates() };
    const tracker = new TargetStatusTracker(states);
    const start = states['v1-square']!;
    tracker.addNotice(notice('v1-square', 'fill', 'work-limit', -2));
    expect(tracker.status('v1-square').fill.outcome).toBe('not drawn');
    const off = edit('fill-on', false)(start);
    tracker.setState('v1-square', off);
    expect(tracker.status('v1-square').fill.shown).toBe(false);
    tracker.setState('v1-square', start);
    expect(tracker.status('v1-square').fill.outcome).toBe('not drawn');
    tracker.setState('v1-square', edit('fill-rule', 'evenodd')(start));
    expect(tracker.status('v1-square').fill.outcome).toBe('drawn');
  });

  it('labels fringe-work-cap as drawn without its fringe and keeps records per exponent', () => {
    const tracker = new TargetStatusTracker(initialStates());
    tracker.addNotice(notice('v1-zigzag', 'stroke', 'fringe-work-cap', -3));
    tracker.addNotice(notice('v1-zigzag', 'stroke', 'fringe-work-cap', -5, 2));
    const status = tracker.status('v1-zigzag');
    expect(status.stroke.outcome).toBe('drawn without fringe');
    expect(status.pathDrawn).toBe(true);
    expect(status.stroke.perExponent).toEqual(['e=-3 fringe-work-cap', 'e=-5 fringe-work-cap']);
  });

  it('shows overlay-unsupported only while 0 < opacity < 1 with both paints on', () => {
    const states = { ...initialStates() };
    const tracker = new TargetStatusTracker(states);
    const start = states['v1-square']!;
    const half = edit('opacity-slider', '0.5')(start);
    tracker.setState('v1-square', half);
    tracker.addNotice(notice('v1-square', null, 'overlay-unsupported', null));
    expect(tracker.status('v1-square').overlay.notDrawn).toBe(true);
    expect(tracker.status('v1-square').pathDrawn).toBe(false);
    // The mark persists across opacity edits but is not shown at opacity 1, 0 or one paint off.
    tracker.setState('v1-square', start);
    expect(tracker.status('v1-square').overlay.notDrawn).toBe(false);
    expect(tracker.status('v1-square').pathDrawn).toBe(true);
    tracker.setState('v1-square', edit('opacity-slider', '0')(start));
    expect(tracker.status('v1-square').overlay.notDrawn).toBe(false);
    tracker.setState('v1-square', half);
    expect(tracker.status('v1-square').overlay.notDrawn).toBe(true);
    tracker.setState('v1-square', edit('fill-on', false)(half));
    expect(tracker.status('v1-square').overlay.notDrawn).toBe(false);
  });

  it('marks state failures "may have cleared" and labels the status after a zoom change', () => {
    const tracker = new TargetStatusTracker(initialStates());
    tracker.addNotice(notice('v1-square', 'fill', 'tolerance-range', -9));
    let status = tracker.status('v1-square');
    expect(status.fill.mayHaveCleared).toBe(true);
    expect(status.fill.text).toContain('may have cleared');
    expect(status.label).not.toContain('may differ');
    tracker.zoomChanged();
    status = tracker.status('v1-square');
    expect(status.fill.outcome).toBe('drawn');
    expect(status.label).toContain('may differ');
    expect(status.label).toContain('the notice log is authoritative');
  });
});
