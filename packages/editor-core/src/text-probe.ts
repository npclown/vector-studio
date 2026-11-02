// V-21 contract, V21-U1: a package-internal probe of the text relayout for the bench. The E26
// bench page (`?bench=1` only, M9-A03's rule) installs `globalThis.__vsTextProbe`; the editor
// reports one record per port dispatch it handles. Without the bench the global is absent, the
// editor checks it once per dispatch and measures nothing. Not exported from the package entry,
// so it is no part of the public API.

/** One port dispatch the editor handled, with the relayout's split. */
export type TextDispatchRecord = {
  kind: 'editor-dispatch';
  /** `performance.now()` at the listener's start. */
  atMs: number;
  generation: number;
  /** Whether the cache reported a new generation (false: the listener returned at once). */
  handled: boolean;
  /** Deferred to the end of a projector action (`reportTo` set), so not timed here. */
  deferred: boolean;
  totalMs: number;
  notifyMs: number;
  relayoutMs: number;
  /** `textLayout` and the diagnostics after the relayout. */
  emitMs: number;
  /** Port `layout` calls inside the relayout and their summed time. */
  layoutCalls: number;
  layoutMs: number;
  /** New layouts deep-equal (lines, clusters, width, height) to the previous generation's. */
  equalLayouts: number;
  /** Of those layouts, how many had a previous result to compare with. */
  comparedLayouts: number;
  /** The page projection (`project`), the change-set diff and the renderer's `applyChanges`. */
  projectMs: number;
  diffMs: number;
  applyMs: number;
  /** How the relayout's change was sent: whole page, scoped, snapshot, or not at all. */
  path: 'whole-page' | 'scoped' | 'snapshot' | 'none';
  /** Nodes in the change set (inserted, updated, removed) and text units on the page. */
  inserted: number;
  updated: number;
  removed: number;
  textUnits: number;
};

/**
 * text-dom's record of the bump that caused a dispatch (its own type there, kept in step by
 * hand; the editor only passes the editor's records).
 */
export type PortBumpRecord = {
  kind: 'port-bump';
  atMs: number;
  source: 'add' | 'settle' | 'settle-error' | 'loadingdone' | 'loadingerror' | 'resolution';
  generation: number;
  dispatchMs: number;
};

export type TextProbeRecord = TextDispatchRecord | PortBumpRecord;

export type TextProbe = (record: TextProbeRecord) => void;

/** The bench's probe, if one is installed. */
export function textProbe(): TextProbe | undefined {
  return (globalThis as { __vsTextProbe?: TextProbe }).__vsTextProbe;
}

/** The relayout's split while a probe is installed; the projector and cache fill it. */
export type RelayoutSplit = {
  layoutCalls: number;
  layoutMs: number;
  equalLayouts: number;
  comparedLayouts: number;
  projectMs: number;
  diffMs: number;
  applyMs: number;
  path: TextDispatchRecord['path'];
  inserted: number;
  updated: number;
  removed: number;
  textUnits: number;
};

export function emptySplit(): RelayoutSplit {
  return {
    layoutCalls: 0,
    layoutMs: 0,
    equalLayouts: 0,
    comparedLayouts: 0,
    projectMs: 0,
    diffMs: 0,
    applyMs: 0,
    path: 'none',
    inserted: 0,
    updated: 0,
    removed: 0,
    textUnits: 0,
  };
}

/** The clock the probe times with; the package's lib has no DOM, so it is read off the global. */
export function probeNow(): number {
  return (globalThis as unknown as { performance: { now(): number } }).performance.now();
}
