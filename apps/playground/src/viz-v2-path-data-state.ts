import type {
  RenderCamera,
  RenderChangeSet,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  RendererSceneSynchronization,
  SceneApplyResult,
  SceneColor,
  SceneFillRule,
  SceneIdentity,
  ScenePathVerb,
  SceneStrokeCap,
  SceneStrokeJoin,
} from '@vector-studio/contracts';
import {
  CONTROL_KINDS,
  appliesOn,
  noticeMeaning,
  parseBoundedNumber,
  type ControlEvent,
  type ParsedNotice,
} from './viz-v1-appearance-state.js';
import { parsePathData, type PathDataError } from './viz-v2-path-data-parse.js';

// Visualization track V-2 (docs/plans/viz-v2-path-data-contract.md, sections 3.2 to 3.5): pure
// state, the edit flow, the fit rule and the derived status. This module has no DOM, GPU or WASM
// import, so unit tests can load it. The state is plain JSON data: no DOM node, GPU object or
// WASM handle (ARCHITECTURE.md, state classification). Reuse of V-1 is read-only (V2-Q9 (a)).

export const VIZ_V2_EVIDENCE_LABEL =
  'UNVERIFIED: functional V-2 path-data page evidence only; precision is UNVERIFIED against the 0.25 physical-pixel target until B4 has A04 evidence, and no Q4 coverage threshold is claimed. work-limit paths are not drawn (product outcome O1); fringe-work-cap paints draw without a fringe while the TypeScript builder ships (O2).';

/** The CSS px size of the surface; the same 720 x 600 as the V-1 page. */
export const VIZ_V2_SURFACE = Object.freeze({ width: 720, height: 600 });

export const DEFAULT_PATH_TEXT = 'M 40 40 H 280 V 200 Q 160 280 40 200 Z';

export const NODE_ID = 'v2-path';

export const VIZ_V2_IDENTITY: SceneIdentity = Object.freeze({
  documentId: 'viz-v2-path-data',
  pageId: 'page-1',
});

/** Fixed paint colors and miter limit (section 3.2). */
export const FILL_COLOR: SceneColor = Object.freeze({ r: 0.86, g: 0.2, b: 0.2, a: 1 });
export const STROKE_COLOR: SceneColor = Object.freeze({ r: 0.2, g: 0.4, b: 0.9, a: 1 });
export const MITER_LIMIT = 4;
export const BACKDROP_COLOR: SceneColor = Object.freeze({ r: 0.1, g: 0.12, b: 0.17, a: 1 });

export const MAX_STROKE_WIDTH = 1024;
export const MIN_ZOOM = 2 ** -20;
export const MAX_ZOOM = 2 ** 20;

// ---------------------------------------------------------------------------------------------
// Appearance state and controls (section 3.2)
// ---------------------------------------------------------------------------------------------

export type AppearanceState = Readonly<{
  fillOn: boolean;
  fillRule: SceneFillRule;
  strokeOn: boolean;
  /** Stroke width in node-local units; the off-paint default is kept while the stroke is off. */
  strokeWidth: number;
  cap: SceneStrokeCap;
  join: SceneStrokeJoin;
}>;

export const INITIAL_APPEARANCE: AppearanceState = Object.freeze({
  fillOn: true,
  fillRule: 'nonzero',
  strokeOn: false,
  strokeWidth: 4,
  cap: 'butt',
  join: 'miter',
});

/** The controls of this page, named by V-1's control ids so its commit rule applies unchanged. */
export type V2ControlId =
  'fill-on' | 'fill-rule' | 'stroke-on' | 'stroke-width-number' | 'cap' | 'join';

export const V2_CONTROL_IDS: readonly V2ControlId[] = [
  'fill-on',
  'fill-rule',
  'stroke-on',
  'stroke-width-number',
  'cap',
  'join',
];

/** V-1's commit rule (section 3.3 step 3): radios and checkboxes live, the number on commit. */
export function controlApplies(id: V2ControlId, event: ControlEvent): boolean {
  return appliesOn(CONTROL_KINDS[id], event);
}

export type ControlResult =
  | Readonly<{ ok: true; patch: (state: AppearanceState) => AppearanceState }>
  | Readonly<{ ok: false; message: string }>;

const invalid = (message: string): ControlResult => ({ ok: false, message });

/** Parses one control's raw value into a patch, or into a message when it is not applicable. */
export function interpretControl(control: V2ControlId, raw: string | boolean): ControlResult {
  switch (control) {
    case 'fill-on':
      return typeof raw === 'boolean'
        ? { ok: true, patch: (state) => ({ ...state, fillOn: raw }) }
        : invalid('Fill is on or off.');
    case 'stroke-on':
      return typeof raw === 'boolean'
        ? { ok: true, patch: (state) => ({ ...state, strokeOn: raw }) }
        : invalid('Stroke is on or off.');
    case 'fill-rule':
      return raw === 'nonzero' || raw === 'evenodd'
        ? { ok: true, patch: (state) => ({ ...state, fillRule: raw }) }
        : invalid('Fill rule is nonzero or evenodd.');
    case 'cap':
      return raw === 'butt' || raw === 'round' || raw === 'square'
        ? { ok: true, patch: (state) => ({ ...state, cap: raw }) }
        : invalid('Cap is butt, round or square.');
    case 'join':
      return raw === 'miter' || raw === 'round' || raw === 'bevel'
        ? { ok: true, patch: (state) => ({ ...state, join: raw }) }
        : invalid('Join is miter, round or bevel.');
    case 'stroke-width-number': {
      const value = typeof raw === 'string' ? parseBoundedNumber(raw, 0, MAX_STROKE_WIDTH) : null;
      return value === null
        ? invalid(`Enter a number from 0 to ${MAX_STROKE_WIDTH}.`)
        : { ok: true, patch: (state) => ({ ...state, strokeWidth: value }) };
    }
  }
}

export const cloneAppearance = (state: AppearanceState): AppearanceState => ({ ...state });
export const appearanceEqual = (a: AppearanceState, b: AppearanceState): boolean =>
  a.fillOn === b.fillOn &&
  a.fillRule === b.fillRule &&
  a.strokeOn === b.strokeOn &&
  a.strokeWidth === b.strokeWidth &&
  a.cap === b.cap &&
  a.join === b.join;

// ---------------------------------------------------------------------------------------------
// State to scene (sections 1.3 and 3.3)
// ---------------------------------------------------------------------------------------------

export type PathGeometryData = Readonly<{
  verbs: readonly ScenePathVerb[];
  points: readonly number[];
}>;

const copyColor = (color: SceneColor): SceneColor => ({
  r: color.r,
  g: color.g,
  b: color.b,
  a: color.a,
});

/** The `v2-path` node for the applied geometry and the appearance. Opacity is fixed at 1. */
export function nodeFor(geometry: PathGeometryData, state: AppearanceState): RenderNodeSnapshot {
  return {
    id: NODE_ID,
    parentId: 'world',
    transform: [1, 0, 0, 1, 0, 0],
    visible: true,
    opacity: 1,
    kind: 'path',
    geometry: {
      kind: 'path',
      verbs: geometry.verbs,
      points: geometry.points,
      fillRule: state.fillRule,
    },
    style: {
      fill: state.fillOn ? copyColor(FILL_COLOR) : null,
      stroke: state.strokeOn
        ? {
            color: copyColor(STROKE_COLOR),
            width: state.strokeWidth,
            cap: state.cap,
            join: state.join,
            miterLimit: MITER_LIMIT,
          }
        : null,
    },
  };
}

/** The whole scene: one container `world` at identity and the one path node. */
export function pathSnapshot(
  geometry: PathGeometryData,
  state: AppearanceState,
  revision: number,
): RenderSceneSnapshot {
  return {
    identity: VIZ_V2_IDENTITY,
    revision,
    nodes: [
      {
        id: 'world',
        parentId: null,
        transform: [1, 0, 0, 1, 0, 0],
        visible: true,
        opacity: 1,
        kind: 'container',
        clip: null,
        children: [NODE_ID],
      },
      nodeFor(geometry, state),
    ],
    rootOrder: ['world'],
  };
}

/** The one-node change of every Apply and control flush (section 3.3 step 4). */
export function singleNodeChange(node: RenderNodeSnapshot, baseRevision: number): RenderChangeSet {
  return {
    identity: VIZ_V2_IDENTITY,
    revision: baseRevision + 1,
    baseRevision,
    inserted: [],
    updated: [node],
    removed: [],
    orders: [],
  };
}

/** The replay rule of the mirror (`pathDataEquals`): element by element under `===`. */
export function pathDataEqual(a: PathGeometryData, b: PathGeometryData): boolean {
  return (
    a.verbs.length === b.verbs.length &&
    a.points.length === b.points.length &&
    a.verbs.every((verb, index) => verb === b.verbs[index]) &&
    a.points.every((value, index) => value === b.points[index])
  );
}

// ---------------------------------------------------------------------------------------------
// Fit rule (section 3.4), every step in binary64 and in this order
// ---------------------------------------------------------------------------------------------

export function fitCamera(geometry: PathGeometryData, state: AppearanceState): RenderCamera {
  const { points } = geometry;
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  if (points.length > 0) {
    minX = Infinity;
    maxX = -Infinity;
    minY = Infinity;
    maxY = -Infinity;
    for (let index = 0; index < points.length; index += 2) {
      const x = points[index]!;
      const y = points[index + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const h = state.strokeOn && state.strokeWidth > 0 ? state.strokeWidth / 2 : 0;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const hx = (maxX - minX) / 2 + h;
  const hy = (maxY - minY) / 2 + h;
  const clamp = (value: number) => Math.min(Math.max(value, MIN_ZOOM), MAX_ZOOM);
  const zx = hx > 0 ? clamp(336 / hx) : Infinity;
  const zy = hy > 0 ? clamp(276 / hy) : Infinity;
  let zoom = Math.min(zx, zy);
  if (zoom === Infinity) zoom = 1;
  return { position: { x: cx - 360 / zoom, y: cy - 300 / zoom }, zoom };
}

// ---------------------------------------------------------------------------------------------
// Edit flow (section 3.3)
// ---------------------------------------------------------------------------------------------

export type EditorSync = Pick<RendererSceneSynchronization, 'replaceSnapshot' | 'applyChanges'>;

export type EditorOptions = Readonly<{
  sync: EditorSync;
  /** Runs `run` later, at most once per animation frame in the page. */
  schedule: (run: () => void) => void;
  /** The text applied at start; defaults to the page's default path. */
  initialText?: string;
}>;

export type ApplyOutcome =
  | Readonly<{ status: 'error'; error: PathDataError }>
  | Readonly<{ status: 'unchanged' }>
  | Readonly<{ status: 'applied'; geometryChanged: true }>
  | Readonly<{ status: 'not-applied'; reason: string }>;

export class PathDataEditor {
  readonly #sync: EditorSync;
  readonly #schedule: (run: () => void) => void;
  readonly #listeners = new Set<() => void>();
  #geometry: PathGeometryData = { verbs: [], points: [] };
  #appliedText = '';
  #appearance: AppearanceState = cloneAppearance(INITIAL_APPEARANCE);
  /** The geometry and appearance the renderer holds (the last applied state). */
  #appliedGeometry: PathGeometryData = { verbs: [], points: [] };
  #appliedAppearance: AppearanceState = cloneAppearance(INITIAL_APPEARANCE);
  #generation = 0;
  #revision = 0;
  #dirty = false;
  #scheduled = false;
  #disabled: string | null = null;
  #stopped = false;
  readonly #errors: string[] = [];
  readonly #initialText: string;

  public constructor(options: EditorOptions) {
    this.#sync = options.sync;
    this.#schedule = options.schedule;
    this.#initialText = options.initialText ?? DEFAULT_PATH_TEXT;
  }

  /** Installs the initial scene at revision 1 with the default path applied. */
  public start(): SceneApplyResult {
    const parsed = parsePathData(this.#initialText);
    if (parsed.status !== 'ok') {
      throw new Error(`The initial path data is invalid: ${parsed.message}`);
    }
    this.#geometry = { verbs: parsed.verbs, points: parsed.points };
    this.#appliedText = this.#initialText;
    this.#generation = 1;
    const result = this.#sync.replaceSnapshot(pathSnapshot(this.#geometry, this.#appearance, 1));
    if (result.status === 'applied' || result.status === 'replayed') {
      this.#revision = 1;
      this.#markApplied();
    } else this.#fail('start', result);
    this.#notify();
    return result;
  }

  public get revision(): number {
    return this.#revision;
  }
  public get geometry(): PathGeometryData {
    return this.#geometry;
  }
  public get appearance(): AppearanceState {
    return this.#appearance;
  }
  /** Increases on every Apply that changes the geometry; keys the status records. */
  public get generation(): number {
    return this.#generation;
  }
  public get appliedText(): string {
    return this.#appliedText;
  }
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
    return this.#dirty;
  }

  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Parses `text` and, on success with new data, sends one scene change at once. The parse is
   * the only parse: typing, `input` and blur never reach this method. On an error nothing in the
   * state changes.
   */
  public apply(text: string): ApplyOutcome {
    if (this.#disabled !== null || this.#stopped) {
      return { status: 'not-applied', reason: this.#disabled ?? 'the renderer was disposed' };
    }
    const parsed = parsePathData(text);
    if (parsed.status === 'error') return { status: 'error', error: parsed };
    const next: PathGeometryData = { verbs: parsed.verbs, points: parsed.points };
    if (pathDataEqual(next, this.#geometry)) {
      this.#appliedText = text;
      this.#notify();
      return { status: 'unchanged' };
    }
    this.#geometry = next;
    this.#appliedText = text;
    this.#generation += 1;
    this.#dirty = true;
    // The change is sent now, so that the fit that follows runs before the next frame.
    this.flush();
    return { status: 'applied', geometryChanged: true };
  }

  /** Applies `patch` to the appearance. Returns false when nothing changes or edits stopped. */
  public edit(patch: (state: AppearanceState) => AppearanceState): boolean {
    if (this.#disabled !== null || this.#stopped) return false;
    const next = patch(this.#appearance);
    if (appearanceEqual(this.#appearance, next)) return false;
    this.#appearance = next;
    this.#dirty = true;
    if (!this.#scheduled) {
      this.#scheduled = true;
      this.#schedule(() => this.flush());
    }
    this.#notify();
    return true;
  }

  /** Sends the pending change, if any: one scene change per call. */
  public flush(): void {
    this.#scheduled = false;
    if (!this.#dirty || this.#disabled !== null || this.#stopped) return;
    this.#dirty = false;
    const node = nodeFor(this.#geometry, this.#appearance);
    const result = this.#sync.applyChanges(singleNodeChange(node, this.#revision));
    switch (result.status) {
      case 'applied':
        this.#revision += 1;
        this.#markApplied();
        break;
      case 'replayed':
        this.#revision = result.current.revision;
        this.#markApplied();
        break;
      case 'resync-required':
        // One replaceSnapshot with the whole current state, one revision after the renderer's.
        this.#replace('resync', (result.current?.revision ?? this.#revision) + 1);
        break;
      case 'invalid-scene':
        // Unreachable for parsed values (sections 1.3 and 1.5): it signals a defect. Revert.
        this.#revert();
        this.#errors.push(`invalid-scene (${result.reason}) for ${NODE_ID}; change reverted`);
        break;
      case 'disposed':
        this.#stopped = true;
        break;
    }
    this.#notify();
  }

  #markApplied(): void {
    this.#appliedGeometry = this.#geometry;
    this.#appliedAppearance = cloneAppearance(this.#appearance);
  }

  /** Back to the last applied state; the generation is not reused (records stay keyed). */
  #revert(): void {
    this.#geometry = this.#appliedGeometry;
    this.#appearance = cloneAppearance(this.#appliedAppearance);
    this.#generation += 1;
  }

  #replace(label: string, revision: number): void {
    const result = this.#sync.replaceSnapshot(
      pathSnapshot(this.#geometry, this.#appearance, revision),
    );
    if (result.status === 'applied' || result.status === 'replayed') {
      this.#revision = revision;
      this.#markApplied();
    } else if (result.status === 'disposed') {
      this.#stopped = true;
    } else {
      // No retry: the controls are disabled until reload.
      this.#fail(label, result);
    }
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
// Notices and the derived status (section 3.5)
// ---------------------------------------------------------------------------------------------

/** State failures notify on entering the state only and clear with no notice (as on V-1). */
const STATE_FAILURES = new Set([
  'tolerance-range',
  'fringe-range',
  'packing-range',
  'port-version',
]);

type PaintRecord = {
  key: string | null;
  byExponent: Map<number | null, ParsedNotice>;
  latest: ParsedNotice | null;
};

export type PaintStatus = Readonly<{
  shown: boolean;
  text: string;
  code: string | null;
  outcome: 'off' | 'drawn' | 'not drawn' | 'drawn without fringe';
  mayHaveCleared: boolean;
  perExponent: readonly string[];
}>;

export type PathStatus = Readonly<{
  fill: PaintStatus;
  stroke: PaintStatus;
  pathDrawn: boolean;
  label: string;
}>;

/** The fill key is (generation, fill rule). */
const fillKeyOf = (generation: number, state: AppearanceState): string =>
  `${generation}|${state.fillRule}`;
/** The stroke key is (generation, width, cap, join, miter limit); null without a stroke. */
const strokeKeyOf = (generation: number, state: AppearanceState): string | null =>
  state.strokeOn && state.strokeWidth > 0
    ? `${generation}|${state.strokeWidth}|${state.cap}|${state.join}|${MITER_LIMIT}`
    : null;

/**
 * Page bookkeeping over the renderer's re-notify and silent rules, for the one node `v2-path`:
 * the latest notice for the current key per paint, kept per tolerance exponent. The status is
 * derived from notices; the log is authoritative.
 */
export class PathStatusTracker {
  readonly #fill: PaintRecord = { key: null, byExponent: new Map(), latest: null };
  readonly #stroke: PaintRecord = { key: null, byExponent: new Map(), latest: null };
  #state: AppearanceState;
  #generation: number;
  #zoomChanged = false;

  public constructor(generation: number, state: AppearanceState) {
    this.#generation = generation;
    this.#state = state;
    this.#fill.key = fillKeyOf(generation, state);
    this.#stroke.key = strokeKeyOf(generation, state);
  }

  /** A key change rebuilds and re-notifies, so the old records are dropped. */
  public setState(generation: number, state: AppearanceState): void {
    const geometryChanged = generation !== this.#generation;
    const fillKey = fillKeyOf(generation, state);
    const strokeKey = strokeKeyOf(generation, state);
    if (this.#fill.key !== fillKey) this.#reset(this.#fill, fillKey);
    if (this.#stroke.key !== strokeKey) this.#reset(this.#stroke, strokeKey);
    // A geometry-changing Apply clears the "may differ" label (the fit is part of that Apply).
    if (geometryChanged) this.#zoomChanged = false;
    this.#generation = generation;
    this.#state = state;
  }

  #reset(record: PaintRecord, key: string | null): void {
    record.key = key;
    record.byExponent.clear();
    record.latest = null;
  }

  /** Records a notice for the current key of its paint. Other nodes are ignored. */
  public addNotice(notice: ParsedNotice): void {
    if (notice.nodeId !== NODE_ID || notice.paint === null) return;
    const record = notice.paint === 'fill' ? this.#fill : this.#stroke;
    record.byExponent.set(notice.toleranceExponent, notice);
    record.latest = notice;
  }

  /** The Fit button, the wheel and the zoom buttons: state failures may clear. */
  public zoomChanged(): void {
    this.#zoomChanged = true;
    for (const record of [this.#fill, this.#stroke]) {
      const latest = record.latest;
      if (latest !== null && STATE_FAILURES.has(latest.failureCode)) {
        record.byExponent.delete(latest.toleranceExponent);
        record.latest = [...record.byExponent.values()].reduce<ParsedNotice | null>(
          (newest, notice) =>
            newest === null || notice.sequence > newest.sequence ? notice : newest,
          null,
        );
      }
    }
  }

  public status(): PathStatus {
    const fill = this.#paintStatus(this.#fill, this.#state.fillOn);
    const strokeShown = this.#state.strokeOn && this.#state.strokeWidth > 0;
    const stroke = this.#paintStatus(this.#stroke, strokeShown);
    const failed = (paint: PaintStatus) => paint.shown && paint.outcome === 'not drawn';
    return {
      fill,
      stroke,
      pathDrawn: !failed(fill) && !failed(stroke),
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
