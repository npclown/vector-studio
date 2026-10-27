import type {
  RenderChangeSet,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  RendererSceneSynchronization,
  SceneApplyResult,
  SceneColor,
  SceneIdentity,
} from '@vector-studio/contracts';
import { PATH_NOTICE_CODE } from './path-notices.js';
import {
  VIZ_V1_BACKGROUND,
  VIZ_V1_TARGETS,
  targetById,
  type AppearanceState,
  type VizTarget,
} from './viz-v1-appearance-scene.js';

// Visualization track V-1 (docs/plans/viz-v1-path-appearance-contract.md, sections 3.2 to 3.4):
// pure state, value parsing, the state-to-scene mapping, the edit flow and the derived target
// status. This module has no DOM, GPU or WASM import, so unit tests can load it. The state is
// plain JSON data: no DOM node, GPU object or WASM handle (ARCHITECTURE.md, state classification).

// ---------------------------------------------------------------------------------------------
// Value ranges and parsing (section 3.2)
// ---------------------------------------------------------------------------------------------

export const RANGES = Object.freeze({
  alpha: { min: 0, max: 1 },
  width: { min: 0, max: 64 },
  miterLimit: { min: 1, max: 100 },
  opacity: { min: 0, max: 1 },
});

const NUMBER_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * A finite number inside [min, max], or null for empty, NaN, out-of-range or malformed text. The
 * number input accepts any value inside the range, not only step multiples.
 */
export function parseBoundedNumber(text: string, min: number, max: number): number | null {
  const trimmed = text.trim();
  if (!NUMBER_PATTERN.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

/** `#rrggbb` to channels / 255 exactly; null for anything else. */
export function parseHexColor(text: string): Pick<SceneColor, 'r' | 'g' | 'b'> | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(text)) return null;
  const channel = (offset: number) => Number.parseInt(text.slice(offset, offset + 2), 16) / 255;
  return { r: channel(1), g: channel(3), b: channel(5) };
}

/** The color picker value of a scene color: channels rounded to eight bits. */
export function toHex(color: Pick<SceneColor, 'r' | 'g' | 'b'>): string {
  const byte = (value: number) =>
    Math.round(value * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}`;
}

// ---------------------------------------------------------------------------------------------
// Controls and the commit rule (section 3.3 step 2)
// ---------------------------------------------------------------------------------------------

export type ControlId =
  | 'fill-on'
  | 'fill-color'
  | 'fill-alpha'
  | 'fill-rule'
  | 'stroke-on'
  | 'stroke-color'
  | 'stroke-alpha'
  | 'stroke-width-slider'
  | 'stroke-width-number'
  | 'cap'
  | 'join'
  | 'miter-slider'
  | 'miter-number'
  | 'opacity-slider'
  | 'opacity-number';

export type ControlKind = 'toggle' | 'live-slider' | 'commit-slider' | 'number';
export type ControlEvent = 'input' | 'change' | 'enter' | 'blur';

/**
 * Sliders apply live on `input`, except the width and miter-limit sliders, which apply on
 * `change`. Every number field, including the alpha and opacity number fields, applies on commit:
 * `change`, Enter or blur. Radios, checkboxes and color pickers apply live.
 */
export const CONTROL_KINDS: Readonly<Record<ControlId, ControlKind>> = Object.freeze({
  'fill-on': 'toggle',
  'fill-color': 'toggle',
  'fill-alpha': 'number',
  'fill-rule': 'toggle',
  'stroke-on': 'toggle',
  'stroke-color': 'toggle',
  'stroke-alpha': 'number',
  'stroke-width-slider': 'commit-slider',
  'stroke-width-number': 'number',
  cap: 'toggle',
  join: 'toggle',
  'miter-slider': 'commit-slider',
  'miter-number': 'number',
  'opacity-slider': 'live-slider',
  'opacity-number': 'number',
});

/** Whether `event` on a control of this kind applies an edit (rather than only displaying it). */
export function appliesOn(kind: ControlKind, event: ControlEvent): boolean {
  switch (kind) {
    case 'toggle':
      // Radios, checkboxes and color pickers are live: `input` carries the new value.
      return event === 'input';
    case 'live-slider':
      return event === 'input' || event === 'change';
    case 'commit-slider':
      return event === 'change';
    case 'number':
      return event === 'change' || event === 'enter' || event === 'blur';
  }
}

export type ControlResult =
  | Readonly<{ ok: true; patch: (state: AppearanceState) => AppearanceState }>
  | Readonly<{ ok: false; message: string }>;

const invalid = (message: string): ControlResult => ({ ok: false, message });
const rangeMessage = (min: number, max: number) => `Enter a number from ${min} to ${max}.`;

function bounded(
  raw: string | boolean,
  range: { min: number; max: number },
  apply: (state: AppearanceState, value: number) => AppearanceState,
): ControlResult {
  const value = typeof raw === 'string' ? parseBoundedNumber(raw, range.min, range.max) : null;
  return value === null
    ? invalid(rangeMessage(range.min, range.max))
    : { ok: true, patch: (state) => apply(state, value) };
}

/** Parses one control's raw value into a patch, or into a message when it is not applicable. */
export function interpretControl(control: ControlId, raw: string | boolean): ControlResult {
  switch (control) {
    case 'fill-on':
      return typeof raw === 'boolean'
        ? { ok: true, patch: (state) => ({ ...state, fillOn: raw }) }
        : invalid('Fill is on or off.');
    case 'stroke-on':
      return typeof raw === 'boolean'
        ? { ok: true, patch: (state) => ({ ...state, strokeOn: raw }) }
        : invalid('Stroke is on or off.');
    case 'fill-color':
    case 'stroke-color': {
      const rgb = typeof raw === 'string' ? parseHexColor(raw) : null;
      if (rgb === null) return invalid('Enter a color as #rrggbb.');
      return control === 'fill-color'
        ? { ok: true, patch: (state) => ({ ...state, fill: { ...rgb, a: state.fill.a } }) }
        : {
            ok: true,
            patch: (state) => ({
              ...state,
              stroke: { ...state.stroke, color: { ...rgb, a: state.stroke.color.a } },
            }),
          };
    }
    case 'fill-alpha':
      return bounded(raw, RANGES.alpha, (state, a) => ({ ...state, fill: { ...state.fill, a } }));
    case 'stroke-alpha':
      return bounded(raw, RANGES.alpha, (state, a) => ({
        ...state,
        stroke: { ...state.stroke, color: { ...state.stroke.color, a } },
      }));
    case 'fill-rule':
      return raw === 'nonzero' || raw === 'evenodd'
        ? { ok: true, patch: (state) => ({ ...state, fillRule: raw }) }
        : invalid('Fill rule is nonzero or evenodd.');
    case 'cap':
      return raw === 'butt' || raw === 'round' || raw === 'square'
        ? {
            ok: true,
            patch: (state) => ({
              ...state,
              stroke: { ...state.stroke, cap: raw },
            }),
          }
        : invalid('Cap is butt, round or square.');
    case 'join':
      return raw === 'miter' || raw === 'round' || raw === 'bevel'
        ? {
            ok: true,
            patch: (state) => ({
              ...state,
              stroke: { ...state.stroke, join: raw },
            }),
          }
        : invalid('Join is miter, round or bevel.');
    case 'stroke-width-slider':
    case 'stroke-width-number':
      return bounded(raw, RANGES.width, (state, width) => ({
        ...state,
        stroke: { ...state.stroke, width },
      }));
    case 'miter-slider':
    case 'miter-number':
      return bounded(raw, RANGES.miterLimit, (state, miterLimit) => ({
        ...state,
        stroke: { ...state.stroke, miterLimit },
      }));
    case 'opacity-slider':
    case 'opacity-number':
      return bounded(raw, RANGES.opacity, (state, opacity) => ({ ...state, opacity }));
  }
}

// ---------------------------------------------------------------------------------------------
// State to scene (section 3.3 step 4)
// ---------------------------------------------------------------------------------------------

export const VIZ_V1_IDENTITY: SceneIdentity = Object.freeze({
  documentId: 'viz-v1-appearance',
  pageId: 'page-1',
});

const copyColor = (color: SceneColor): SceneColor => ({
  r: color.r,
  g: color.g,
  b: color.b,
  a: color.a,
});

/**
 * The target's full node for `state`. `verbs` and `points` are the target's initial arrays,
 * reused unchanged. Fill off gives `fill: null`, stroke off gives `stroke: null`, and a stroke
 * of width 0 is kept as a stroke of width 0. The page never sends a stroke of null fields.
 */
export function nodeFor(target: VizTarget, state: AppearanceState): RenderNodeSnapshot {
  return {
    id: target.id,
    parentId: 'world',
    transform: [1, 0, 0, 1, target.center[0], target.center[1]],
    visible: true,
    opacity: state.opacity,
    kind: 'path',
    geometry: {
      kind: 'path',
      verbs: target.data.verbs,
      points: target.data.points,
      fillRule: state.fillRule,
    },
    style: {
      fill: state.fillOn ? copyColor(state.fill) : null,
      stroke: state.strokeOn
        ? {
            color: copyColor(state.stroke.color),
            width: state.stroke.width,
            cap: state.stroke.cap,
            join: state.stroke.join,
            miterLimit: state.stroke.miterLimit,
          }
        : null,
    },
  };
}

export type AppearanceStates = Readonly<Record<string, AppearanceState>>;

export function initialStates(): AppearanceStates {
  return Object.fromEntries(
    VIZ_V1_TARGETS.map((target) => [target.id, cloneState(target.initial)]),
  );
}

export function cloneState(state: AppearanceState): AppearanceState {
  return JSON.parse(JSON.stringify(state)) as AppearanceState;
}

export function statesEqual(a: AppearanceState, b: AppearanceState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The whole scene for `states`: a container at identity, the backdrop and the targets. */
export function appearanceSnapshot(
  states: AppearanceStates,
  revision: number,
): RenderSceneSnapshot {
  const nodes: RenderNodeSnapshot[] = [
    {
      id: 'world',
      parentId: null,
      transform: [1, 0, 0, 1, 0, 0],
      visible: true,
      opacity: 1,
      kind: 'container',
      clip: null,
      children: [VIZ_V1_BACKGROUND.id, ...VIZ_V1_TARGETS.map((target) => target.id)],
    },
    {
      id: VIZ_V1_BACKGROUND.id,
      parentId: 'world',
      transform: [1, 0, 0, 1, 20, 20],
      visible: true,
      opacity: 1,
      kind: 'primitive',
      geometry: { kind: 'rectangle', width: 680, height: 560, cornerRadii: [16, 16, 16, 16] },
      style: { fill: VIZ_V1_BACKGROUND.color, stroke: null },
    },
    ...VIZ_V1_TARGETS.map((target) => nodeFor(target, states[target.id]!)),
  ];
  return { identity: VIZ_V1_IDENTITY, revision, nodes, rootOrder: ['world'] };
}

/** The one-node change set of every control flush and of "Reset target". */
export function singleNodeChange(node: RenderNodeSnapshot, baseRevision: number): RenderChangeSet {
  return {
    identity: VIZ_V1_IDENTITY,
    revision: baseRevision + 1,
    baseRevision,
    inserted: [],
    updated: [node],
    removed: [],
    orders: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Edit flow (section 3.3)
// ---------------------------------------------------------------------------------------------

export type EditorSync = Pick<RendererSceneSynchronization, 'replaceSnapshot' | 'applyChanges'>;

export type EditorOptions = Readonly<{
  sync: EditorSync;
  /** Runs `run` later, at most once per animation frame in the page. */
  schedule: (run: () => void) => void;
}>;

/**
 * Holds the page's appearance state and sends it to the renderer. Applied edits are coalesced to
 * at most one scene change per scheduled run; the change carries the latest values.
 */
export class AppearanceEditor {
  readonly #sync: EditorSync;
  readonly #schedule: (run: () => void) => void;
  readonly #listeners = new Set<() => void>();
  #states: Record<string, AppearanceState> = { ...initialStates() };
  #applied: Record<string, AppearanceState> = { ...initialStates() };
  #revision = 0;
  /** Targets with an edit not yet sent, oldest first; one is sent per scheduled run. */
  readonly #pending: string[] = [];
  #scheduled = false;
  #disabled: string | null = null;
  #stopped = false;
  readonly #errors: string[] = [];

  public constructor(options: EditorOptions) {
    this.#sync = options.sync;
    this.#schedule = options.schedule;
  }

  /** Installs the initial scene at revision 1. */
  public start(): SceneApplyResult {
    const result = this.#sync.replaceSnapshot(appearanceSnapshot(this.#states, 1));
    if (result.status === 'applied' || result.status === 'replayed') this.#revision = 1;
    else this.#fail('start', result);
    this.#notify();
    return result;
  }

  public get revision(): number {
    return this.#revision;
  }
  public get states(): AppearanceStates {
    return this.#states;
  }
  /** The states last sent to the renderer; queued edits are not in it until their flush. */
  public get applied(): AppearanceStates {
    return this.#applied;
  }
  /** The reason the controls are disabled, or null. */
  public get disabledReason(): string | null {
    return this.#disabled;
  }
  public get stopped(): boolean {
    return this.#stopped;
  }
  public get errors(): readonly string[] {
    return this.#errors;
  }
  public get hasPending(): boolean {
    return this.#pending.length > 0;
  }

  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Applies `patch` to the target's state. Returns false when nothing changes or edits stopped. */
  public edit(targetId: string, patch: (state: AppearanceState) => AppearanceState): boolean {
    const current = this.#states[targetId];
    if (current === undefined || this.#disabled !== null || this.#stopped) return false;
    const next = patch(current);
    if (statesEqual(current, next)) return false;
    this.#queue(targetId, next);
    return true;
  }

  /** "Reset target": one one-node flush of the target's initial appearance. */
  public resetTarget(targetId: string): boolean {
    const target = targetById(targetId);
    if (target === undefined || this.#disabled !== null || this.#stopped) return false;
    this.#queue(targetId, cloneState(target.initial));
    return true;
  }

  /** "Reset all": one `replaceSnapshot` of the initial scene at the next revision. */
  public resetAll(): void {
    if (this.#disabled !== null || this.#stopped) return;
    this.#pending.length = 0;
    this.#states = { ...initialStates() };
    this.#replaceWith('reset-all', this.#revision + 1);
  }

  /** Sends the coalesced edit, if any. The scheduled run calls it. */
  public flush(): void {
    this.#scheduled = false;
    const targetId = this.#pending.shift();
    if (targetId === undefined || this.#disabled !== null || this.#stopped) return;
    // At most one scene change per scheduled run: another target's edit waits for the next run.
    if (this.#pending.length > 0) this.#scheduleFlush();
    const target = targetById(targetId)!;
    const node = nodeFor(target, this.#states[targetId]!);
    const result = this.#sync.applyChanges(singleNodeChange(node, this.#revision));
    switch (result.status) {
      case 'applied':
        this.#revision += 1;
        this.#applied[targetId] = cloneState(this.#states[targetId]!);
        break;
      case 'replayed':
        this.#revision = result.current.revision;
        this.#applied[targetId] = cloneState(this.#states[targetId]!);
        break;
      case 'resync-required':
        // One replaceSnapshot with the whole current state, one revision after the renderer's.
        this.#replaceWith('resync', (result.current?.revision ?? this.#revision) + 1);
        break;
      case 'invalid-scene':
        // Unreachable for parsed values: it signals a defect. Revert and list the reason.
        this.#states[targetId] = cloneState(this.#applied[targetId]!);
        this.#errors.push(`invalid-scene (${result.reason}) for ${targetId}; edit reverted`);
        break;
      case 'disposed':
        this.#stopped = true;
        break;
    }
    this.#notify();
  }

  #queue(targetId: string, next: AppearanceState): void {
    if (this.#disabled !== null || this.#stopped) return;
    this.#states[targetId] = next;
    if (!this.#pending.includes(targetId)) this.#pending.push(targetId);
    this.#scheduleFlush();
    this.#notify();
  }

  #scheduleFlush(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.#schedule(() => this.flush());
  }

  #replaceWith(label: string, revision: number): void {
    const result = this.#sync.replaceSnapshot(appearanceSnapshot(this.#states, revision));
    if (result.status === 'applied' || result.status === 'replayed') {
      this.#revision = revision;
      this.#applied = {
        ...Object.fromEntries(
          Object.entries(this.#states).map(([id, state]) => [id, cloneState(state)]),
        ),
      };
    } else if (result.status === 'disposed') {
      this.#stopped = true;
    } else {
      // No retry: the controls are disabled until reload.
      this.#fail(label, result);
    }
    this.#notify();
  }

  #fail(label: string, result: SceneApplyResult): void {
    this.#errors.push(`replaceSnapshot (${label}) returned ${JSON.stringify(result)}`);
    this.#disabled = `replaceSnapshot (${label}) was not applied: ${result.status}`;
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

// ---------------------------------------------------------------------------------------------
// Notices and the derived target status (section 3.4)
// ---------------------------------------------------------------------------------------------

export type ParsedNotice = Readonly<{
  sequence: number;
  nodeId: string | null;
  paint: 'fill' | 'stroke' | null;
  failureCode: string;
  toleranceExponent: number | null;
}>;

export const NOTICE_CODE = PATH_NOTICE_CODE;

/** Reads a path mesh failure diagnostic; null for any other event. */
export function parseNotice(event: {
  code: string;
  sequence: number;
  context?: unknown;
}): ParsedNotice | null {
  if (event.code !== NOTICE_CODE) return null;
  const context = (event.context ?? {}) as {
    nodeId?: string | null;
    paint?: string | null;
    failureCode?: string;
    toleranceExponent?: number | null;
  };
  return {
    sequence: event.sequence,
    nodeId: context.nodeId ?? null,
    paint: context.paint === 'fill' || context.paint === 'stroke' ? context.paint : null,
    failureCode: context.failureCode ?? 'unknown',
    toleranceExponent: context.toleranceExponent ?? null,
  };
}

/** `pathMeshNoticeDiagnostic`: fringe-work-cap means drawn without its fringe, others not drawn. */
export function noticeMeaning(code: string): 'drawn without fringe' | 'not drawn' {
  return code === 'fringe-work-cap' ? 'drawn without fringe' : 'not drawn';
}

/** State failures notify on entering the state only and clear with no notice. */
const STATE_FAILURES = new Set([
  'tolerance-range',
  'fringe-range',
  'packing-range',
  'port-version',
]);

type PaintRecord = {
  /** The paint key the records belong to; null while the paint has no key. */
  key: string | null;
  /** Latest notice per tolerance exponent (null key for a notice without one). */
  byExponent: Map<number | null, ParsedNotice>;
  latest: ParsedNotice | null;
};

export type PaintStatus = Readonly<{
  /** Whether the paint is on (the stroke only with a width above 0). */
  shown: boolean;
  text: string;
  code: string | null;
  /** 'drawn', 'not drawn', 'drawn without fringe' or 'off'. */
  outcome: 'off' | 'drawn' | 'not drawn' | 'drawn without fringe';
  mayHaveCleared: boolean;
  /** Notices kept per tolerance exponent, as `e=<n> <code>`. */
  perExponent: readonly string[];
}>;

export type TargetStatus = Readonly<{
  targetId: string;
  fill: PaintStatus;
  stroke: PaintStatus;
  overlay: Readonly<{ applies: boolean; text: string; notDrawn: boolean }>;
  pathDrawn: boolean;
  /** The label the status always carries. */
  label: string;
}>;

const fillKeyOf = (state: AppearanceState): string => state.fillRule;
const strokeKeyOf = (state: AppearanceState): string | null =>
  state.strokeOn && state.stroke.width > 0
    ? `${state.stroke.width}|${state.stroke.cap}|${state.stroke.join}|${state.stroke.miterLimit}`
    : null;

/**
 * Page bookkeeping over the renderer's re-notify and silent rules (contract section 2): the
 * latest notice for the current key per paint, kept per tolerance exponent, with `overlay-
 * unsupported` kept per fill rule and stroke key. The status is derived from notices; the log is
 * authoritative.
 */
export class TargetStatusTracker {
  readonly #fill = new Map<string, PaintRecord>();
  readonly #stroke = new Map<string, PaintRecord>();
  readonly #overlay = new Map<string, Set<string>>();
  readonly #states = new Map<string, AppearanceState>();
  #zoomChanged = false;

  public constructor(initial: AppearanceStates) {
    for (const [id, state] of Object.entries(initial)) {
      this.#states.set(id, state);
      this.#fill.set(id, { key: fillKeyOf(state), byExponent: new Map(), latest: null });
      this.#stroke.set(id, { key: strokeKeyOf(state), byExponent: new Map(), latest: null });
      this.#overlay.set(id, new Set());
    }
  }

  /** A key change rebuilds and re-notifies, so the old records and marks are dropped. */
  public setState(targetId: string, state: AppearanceState): void {
    const fill = this.#fill.get(targetId);
    const stroke = this.#stroke.get(targetId);
    if (fill === undefined || stroke === undefined) return;
    const fillKey = fillKeyOf(state);
    const strokeKey = strokeKeyOf(state);
    let keysChanged = false;
    // Turning the fill off and on with an unchanged rule keeps the fill entry and its record.
    if (fill.key !== fillKey) {
      this.#reset(fill, fillKey);
      keysChanged = true;
    }
    // A stroke turned off or set to width 0 has no key, so its entries are deleted.
    if (stroke.key !== strokeKey) {
      this.#reset(stroke, strokeKey);
      keysChanged = true;
    }
    if (keysChanged) this.#overlay.get(targetId)!.clear();
    this.#states.set(targetId, state);
  }

  #reset(record: PaintRecord, key: string | null): void {
    record.key = key;
    record.byExponent.clear();
    record.latest = null;
  }

  /** Records a notice for the current key of its paint. Other nodes are ignored. */
  public addNotice(notice: ParsedNotice): void {
    const id = notice.nodeId;
    if (id === null || !this.#states.has(id)) return;
    if (notice.failureCode === 'overlay-unsupported') {
      this.#overlay.get(id)!.add(this.#overlayKey(this.#states.get(id)!));
      return;
    }
    if (notice.paint === null) return;
    const record = (notice.paint === 'fill' ? this.#fill : this.#stroke).get(id)!;
    record.byExponent.set(notice.toleranceExponent, notice);
    record.latest = notice;
  }

  /** Any zoom or view change: the serving entry cannot be observed, and state failures may clear. */
  public zoomChanged(): void {
    this.#zoomChanged = true;
    for (const records of [this.#fill, this.#stroke]) {
      for (const record of records.values()) {
        // Every state failure is shown only until the next zoom change (section 3.4), not only
        // the latest one.
        let removed = false;
        for (const [exponent, notice] of record.byExponent) {
          if (!STATE_FAILURES.has(notice.failureCode)) continue;
          record.byExponent.delete(exponent);
          removed = true;
        }
        if (removed && record.latest !== null && STATE_FAILURES.has(record.latest.failureCode)) {
          // The newest remaining notice by sequence number, not by map insertion order.
          record.latest = [...record.byExponent.values()].reduce<ParsedNotice | null>(
            (newest, notice) =>
              newest === null || notice.sequence > newest.sequence ? notice : newest,
            null,
          );
        }
      }
    }
  }

  #overlayKey(state: AppearanceState): string {
    return `${fillKeyOf(state)}#${strokeKeyOf(state) ?? ''}`;
  }

  public status(targetId: string): TargetStatus {
    const state = this.#states.get(targetId)!;
    const fill = this.#paintStatus(this.#fill.get(targetId)!, state.fillOn);
    const strokeShown = state.strokeOn && state.stroke.width > 0;
    const stroke = this.#paintStatus(this.#stroke.get(targetId)!, strokeShown);
    // Joint condition: both paints drawable and 0 < o < 1. At o = 1, at o = 0 or with one paint
    // off, the path draws through the ordinary draws, so the mark is not shown.
    const applies = state.fillOn && strokeShown && state.opacity > 0 && state.opacity < 1;
    const marked = this.#overlay.get(targetId)!.has(this.#overlayKey(state));
    const overlayNotDrawn = applies && marked;
    const failed = (paint: PaintStatus) => paint.shown && paint.outcome === 'not drawn';
    const pathDrawn = !failed(fill) && !failed(stroke) && !overlayNotDrawn;
    return {
      targetId,
      fill,
      stroke,
      overlay: {
        applies,
        notDrawn: overlayNotDrawn,
        text: !applies
          ? 'joint overlay: not in use'
          : overlayNotDrawn
            ? 'joint overlay: not drawn (overlay-unsupported)'
            : 'joint overlay: no notice',
      },
      pathDrawn,
      label: this.#zoomChanged
        ? 'derived from notices; may differ; the notice log is authoritative'
        : 'derived from notices; the notice log is authoritative',
    };
  }

  #paintStatus(record: PaintRecord, shown: boolean): PaintStatus {
    if (!shown) {
      return {
        shown: false,
        text: 'off',
        code: null,
        outcome: 'off',
        mayHaveCleared: false,
        perExponent: [],
      };
    }
    const latest = record.latest;
    const perExponent = [...record.byExponent.values()].map(
      (notice) => `e=${notice.toleranceExponent ?? '-'} ${notice.failureCode}`,
    );
    if (latest === null) {
      return {
        shown: true,
        text: 'drawn (no notice)',
        code: null,
        outcome: 'drawn',
        mayHaveCleared: false,
        perExponent,
      };
    }
    const outcome = noticeMeaning(latest.failureCode);
    const mayHaveCleared = STATE_FAILURES.has(latest.failureCode);
    return {
      shown: true,
      text: `${outcome} (${latest.failureCode}${mayHaveCleared ? '; may have cleared' : ''})`,
      code: latest.failureCode,
      outcome,
      mayHaveCleared,
      perExponent,
    };
  }
}
