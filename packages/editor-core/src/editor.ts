import type {
  RenderCamera,
  RendererSceneSynchronization,
  TextLayoutPort,
} from '@vector-studio/contracts';
import {
  DOCUMENT_ERROR_CODES,
  isValidId,
  validateAnyDocument,
  type DocumentV6,
  type ParseResult,
} from '@vector-studio/model';
import { copyFragment } from './clipboard.js';
import { ExpansionCache, expansionFailure } from './expansion.js';
import {
  applyEdit,
  applyGestureEdit,
  deepFreeze,
  refitGesture,
  type EditResult,
  type GestureEdit,
} from './edits.js';
import {
  ExtensionRegistry,
  extensionApi,
  owned,
  toolOverlay,
  type RegisteredTool,
} from './extensions.js';
import { boundsOf } from './hit-test.js';
import { createCounterIdSource } from './ids.js';
import {
  allAnchors,
  canonicalRefs,
  editablePath,
  pathEditOverlay,
  sameStructure,
} from './path-edit.js';
import { badRef, readAnchorModel, refListShape } from './paths.js';
import {
  DEFAULT_KEYMAP,
  effectiveKeymap,
  eventChord,
  isSpaceKey,
  validateLayer,
  type CanonicalBinding,
} from './keymap.js';
import { SceneProjector } from './projector.js';
import { TextLayoutCache, type TextLayouter } from './text.js';
import {
  createBoxTool,
  createLineTool,
  createPathTool,
  createSelectTool,
  selectionHandles,
} from './tools.js';
import {
  ancestors,
  childrenOf,
  documentClipViolation,
  documentTree,
  isContainer,
  isFrameLike,
  isGroup,
  nodePath,
  pageOf,
} from './tree.js';
import type {
  AlignEdge,
  Command,
  CommandResult,
  DocumentChangeCause,
  DistributeAxis,
  DocumentCommand,
  Editor,
  EditorErrorCode,
  EditorEvent,
  EditorSnapshot,
  Extension,
  IdSource,
  InputEvent,
  KeyBinding,
  PagePoint,
  PathAnchorRef,
  PathEditState,
  Platform,
  Query,
  QueryResult,
  ReorderOp,
  SnapOverlay,
  ToolApi,
  ToolGesture,
  ToolId,
  ToolOverlay,
  ViewportSize,
} from './types.js';

// Editor core (P5 plan, section 4): commands, transactions, history, gestures and session; the
// pages, active page and selection rules of the MVP M1 contract (sections 3 and 6).

export type EditorOptions = Readonly<{
  /** A document value; it is validated like `loadDocument`. Defaults to an empty document. */
  document?: unknown;
  /** Defaults to a counter, `node-1`, `node-2`, ... */
  ids?: IdSource;
  /** Registered once; a malformed or conflicting registration throws (P5 plan, section 5). */
  extensions?: readonly Extension[];
  /** The host keymap layer (M2 contract, section 7); an invalid layer throws. Defaults to empty. */
  keymap?: readonly KeyBinding[];
  /** What `Mod` resolves to: `Meta` on `'mac'`, else `Ctrl`. Defaults to `'other'`. */
  platform?: Platform;
  /**
   * The text layout port (M6a contract, section 5), subscribed once for the editor's lifetime;
   * a port whose `portVersion` is not 0 throws. Without it, edits that need a layout fail with
   * `editor.no-text-layout` and `textLayout` is null.
   */
  textLayout?: TextLayoutPort;
}>;

/** A tool receives input and acts only through the editor's commands and the gesture API. */
export interface Tool {
  /**
   * Returns whether the tool consumed the event (M2-I2, M2-I3): a key it has state for, or a
   * pointer event it acted on. Tools receive no wheel or `pointercancel` event.
   */
  input(event: InputEvent, context: ToolContext): boolean;
  /** Drops drag and overlay state, for example when the tool is switched away. Must issue no command. */
  reset(): void;
  overlay(): ToolOverlay | null;
}

export interface ToolContext {
  execute(command: Command): CommandResult;
  query<Q extends Query>(query: Q): QueryResult<Q>;
  gesture: GestureControl;
  /**
   * Sets the snap overlay of the active gesture (M2 contract, section 4.2); ignored without one.
   * The editor clears it when the gesture commits or cancels.
   */
  snap(overlay: SnapOverlay | null): void;
}

/**
 * A pointer drag (plan section 4.2). Updates change the live document without history; commit
 * records one undo step from the pre-gesture state; cancel restores that state. Events are held
 * during `input`, so a tool's drag cannot end under it; a caller outside `input` checks `active`
 * after `update`, because a listener's command can end the drag.
 */
export interface GestureControl {
  readonly active: boolean;
  /** Returns false while another gesture is active. */
  begin(): boolean;
  /**
   * Applies an absolute command to the live document, so updates accumulate. A relative command
   * (`rotateNodes`, M2 section 4) fails with `editor.invalid-command`: it goes through `replace`.
   */
  update(command: DocumentCommand): CommandResult;
  /**
   * Restores the pre-gesture document, applies `commands` in order and makes the result the live
   * document, discarding every earlier update and replace of this gesture (M2 contract, S1). A
   * failing command leaves the live document as it was.
   */
  replace(commands: readonly DocumentCommand[]): CommandResult;
  /**
   * Package-internal: an update no public command expresses (a multi-selection resize from the
   * pre-gesture state, a line drag), applied like `update`.
   */
  edit(edit: GestureEdit): CommandResult;
  commit(): void;
  cancel(): void;
}

type HistoryEntry = Readonly<{
  before: DocumentV6;
  after: DocumentV6;
  touched: readonly string[];
  /**
   * The IDs the ID source returned for the step (M7 contract, section 6): an undo or redo
   * replaces the nodes under them, so they leave the rule (1) link set as a new draw does.
   */
  drawn: readonly string[];
}>;

type Gesture = {
  base: DocumentV6;
  touched: Set<string>;
  updated: boolean;
  /** The selection when the gesture began, restored on cancel (M2 contract, section 2). */
  selection: readonly string[];
  /** Path edit mode when the gesture began; its anchor selection is restored on cancel. */
  pathEdit: PathEditState | null;
  /**
   * The IDs the gesture's updates and replaces accepted, each judged against the document its
   * draw ran on (M7 contract, section 6), discarded steps included.
   */
  accepted: string[];
};

/** The zoom range (M2-Q2). */
export const ZOOM_MIN = 1 / 64;
export const ZOOM_MAX = 256;
/** The zoom-to-fit padding: 32 CSS px on each side (M2-Q2). */
const FIT_PADDING = 64;
const DEFAULT_VIEWPORT: RenderCamera = deepFreeze({ position: { x: 0, y: 0 }, zoom: 1 });
const DOCUMENT_COMMANDS = new Set([
  'createRectangle',
  'createEllipse',
  'createLine',
  'createFrame',
  'createPath',
  'createCustomNode',
  'setFrames',
  'setNodeProps',
  'deleteNodes',
  'groupNodes',
  'ungroupNodes',
  'moveNodes',
  'createSymbol',
  'createInstance',
  'detachInstances',
  'setInstanceText',
  'clearInstanceText',
  'addPage',
  'removePage',
  'renamePage',
  'movePage',
  'rotateNodes',
  'alignNodes',
  'distributeNodes',
  'reorderNodes',
  'nudgeNodes',
  'duplicateNodes',
  'paste',
  'movePathAnchors',
  'setPathHandle',
  'insertPathAnchor',
  'removePathAnchors',
  'closePathSubpath',
  'openPathSubpath',
  'createText',
  'setText',
  'setTextStyle',
  'setTextProps',
  'refitText',
]);

/**
 * Relative commands (M2 contract, section 4, S1): inside a gesture they go through `replace`,
 * and `update` rejects them so a drag never compounds. Later M2 units add their commands here.
 */
const RELATIVE_COMMANDS: ReadonlySet<string> = new Set([
  'rotateNodes',
  'nudgeNodes',
  'alignNodes',
  'distributeNodes',
  'reorderNodes',
  // MVP M3 contract, section 3 (M3-Q10).
  'movePathAnchors',
  'setPathHandle',
  'insertPathAnchor',
  'removePathAnchors',
  'closePathSubpath',
  'openPathSubpath',
]);

/** Extension commands may nest this deep through `runCommand` (P5-U5). */
const MAX_EXTENSION_DEPTH = 16;

const ERROR_CODES: ReadonlySet<string> = new Set<EditorErrorCode>([
  ...DOCUMENT_ERROR_CODES,
  'editor.invalid-command',
  'editor.unknown-node',
  'editor.unknown-tool',
  'editor.duplicate-id',
  'editor.nothing-to-undo',
  'editor.nothing-to-redo',
  'editor.invalid-camera',
  'editor.unknown-command',
  'editor.extension-failed',
  'editor.unknown-page',
  'editor.invalid-index',
  'editor.last-page',
  'editor.invalid-parent',
  'editor.not-siblings',
  'editor.not-a-group',
  'editor.invalid-mask-source',
  'editor.clip-depth',
  'editor.no-viewport-size',
  'editor.too-few-nodes',
  'editor.invalid-scope',
  'editor.invalid-keymap',
  'editor.empty-clipboard',
  'editor.invalid-clipboard',
  'editor.unsupported-clipboard',
  'editor.not-a-path',
  'editor.invalid-path-ref',
  'editor.too-few-anchors',
  'editor.empty-path',
  'editor.no-path-edit',
  'editor.not-a-symbol',
  'editor.not-an-instance',
  'editor.nested-symbol',
  'editor.invalid-expansion',
  'editor.expansion-limit',
  'editor.not-a-text-node',
  'editor.invalid-text-range',
  'editor.no-text-layout',
]);

/**
 * A frozen copy of an extension command's result, or null when it is not a `CommandResult`
 * with a known code and, on success, IDs of nodes in `document`.
 */
function extensionResult(value: unknown, document: DocumentV6): CommandResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.ok === true) {
    if (!Array.isArray(record.ids)) return null;
    const ids = [...(record.ids as unknown[])];
    const real = ids.every((id) => typeof id === 'string' && Object.hasOwn(document.nodes, id));
    return real ? deepFreeze({ ok: true, ids: ids as string[] }) : null;
  }
  if (record.ok !== false || typeof record.code !== 'string' || !ERROR_CODES.has(record.code)) {
    return null;
  }
  const code = record.code as EditorErrorCode;
  return deepFreeze(
    typeof record.path === 'string' ? { ok: false, code, path: record.path } : { ok: false, code },
  );
}

type CommandFailure = Extract<CommandResult, { ok: false }> & Readonly<{ path: string }>;

function failure(code: EditorErrorCode, path?: string): CommandResult {
  return path === undefined ? { ok: false, code } : { ok: false, code, path };
}

function isCamera(value: unknown): value is RenderCamera {
  const camera = value as RenderCamera | null;
  return (
    typeof camera === 'object' &&
    camera !== null &&
    typeof camera.position === 'object' &&
    camera.position !== null &&
    Number.isFinite(camera.position.x) &&
    Number.isFinite(camera.position.y) &&
    Number.isFinite(camera.zoom) &&
    camera.zoom > 0
  );
}

function isPoint(value: unknown): value is PagePoint {
  const point = value as PagePoint | null;
  return (
    typeof point === 'object' &&
    point !== null &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y)
  );
}

const optional = (value: unknown, type: 'string' | 'boolean') =>
  value === undefined || typeof value === type;

/** The M2-I1 input kinds; any other shape is malformed (`editor.invalid-command` at `/event`). */
function isInputEvent(value: unknown): value is InputEvent {
  const event = value as Record<string, unknown> | null;
  if (typeof event !== 'object' || event === null) return false;
  const modifiers = event.modifiers as Record<string, unknown> | null;
  if (
    typeof modifiers !== 'object' ||
    modifiers === null ||
    !['shift', 'alt', 'meta', 'ctrl'].every((key) => typeof modifiers[key] === 'boolean')
  ) {
    return false;
  }
  switch (event.kind) {
    case 'keydown':
      return (
        typeof event.key === 'string' &&
        optional(event.code, 'string') &&
        optional(event.repeat, 'boolean') &&
        optional(event.composing, 'boolean')
      );
    case 'keyup':
      return typeof event.key === 'string' && optional(event.code, 'string');
    case 'pointerdown':
      return isPoint(event.point) && (event.button === undefined || Number.isInteger(event.button));
    case 'pointermove':
    case 'pointerup':
    case 'doubleclick':
      return isPoint(event.point);
    case 'wheel':
      return isPoint(event.point) && Number.isFinite(event.deltaX) && Number.isFinite(event.deltaY);
    case 'pointercancel':
      return true;
    default:
      return false;
  }
}

/** A frozen copy with only the fields of its kind, never the host's objects. */
function copyInput(event: InputEvent): InputEvent {
  const { shift, alt, meta, ctrl } = event.modifiers;
  const modifiers = { shift, alt, meta, ctrl };
  const point = (at: PagePoint) => ({ x: at.x + 0, y: at.y + 0 });
  const copy = ((): InputEvent => {
    switch (event.kind) {
      case 'keydown':
        return {
          kind: event.kind,
          key: event.key,
          ...(event.code === undefined ? {} : { code: event.code }),
          repeat: event.repeat ?? false,
          composing: event.composing ?? false,
          modifiers,
        };
      case 'keyup':
        return {
          kind: event.kind,
          key: event.key,
          ...(event.code === undefined ? {} : { code: event.code }),
          modifiers,
        };
      case 'pointerdown':
        return {
          kind: event.kind,
          point: point(event.point),
          button: event.button ?? 0,
          modifiers,
        };
      case 'wheel':
        return {
          kind: event.kind,
          point: point(event.point),
          deltaX: event.deltaX + 0,
          deltaY: event.deltaY + 0,
          modifiers,
        };
      case 'pointercancel':
        return { kind: event.kind, modifiers };
      default:
        return { kind: event.kind, point: point(event.point), modifiers };
    }
  })();
  return deepFreeze(copy);
}

/** A copy of a snap overlay with plain points, never the tool's objects. */
function structuredCopy(overlay: SnapOverlay): SnapOverlay {
  const segment = (s: SnapOverlay['guides'][number]) => ({
    a: { x: s.a.x + 0, y: s.a.y + 0 },
    b: { x: s.b.x + 0, y: s.b.y + 0 },
  });
  return {
    guides: overlay.guides.map(segment),
    gaps: overlay.gaps.map(segment),
    angle: overlay.angle,
  };
}

const clampZoom = (zoom: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));

function nodeIn(document: DocumentV6, id: string) {
  return Object.hasOwn(document.nodes, id) ? document.nodes[id] : undefined;
}

/** Whether node `id` differs between two documents; a node in only one of them differs. */
function nodeDiffers(a: DocumentV6, b: DocumentV6, id: string): boolean {
  const x = nodeIn(a, id);
  const y = nodeIn(b, id);
  if (x === y) return false;
  return x === undefined || y === undefined || JSON.stringify(x) !== JSON.stringify(y);
}

/** Whether two documents have the same pages, children orders included. */
function samePages(a: DocumentV6, b: DocumentV6): boolean {
  return a.pages === b.pages || JSON.stringify(a.pages) === JSON.stringify(b.pages);
}

/** The rule (1) links of a clipboard copied in an earlier generation: none (M7, section 6). */
const NO_LINKS: ReadonlySet<string> = new Set();

function sorted(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Validated by the caller like any initial document, so a bad ID source fails at creation. */
function emptyDocument(ids: IdSource): DocumentV6 {
  return {
    schemaVersion: 6,
    id: ids(),
    pages: [{ id: ids(), name: 'Page 1', children: [] }],
    nodes: {},
  };
}

/**
 * The selection rule of section 6: nodes of `page` only, in order, without repeats, and a node
 * whose ancestor is also listed is dropped (the ancestor wins).
 */
function normalizeSelection(
  document: DocumentV6,
  page: string,
  ids: readonly string[],
): string[] | null {
  const tree = documentTree(document);
  const unique = [...new Set(ids)];
  if (unique.some((id) => typeof id !== 'string' || pageOf(tree, id) !== page)) return null;
  const listed = new Set(unique);
  return unique.filter((id) => !ancestors(tree, id).some((node) => listed.has(node.id)));
}

class EditorCore implements Editor {
  private document: DocumentV6;
  private activePage: string;
  private revision = 0;
  private selection: readonly string[] = Object.freeze([]);
  private tool: ToolId = 'select';
  private viewport: RenderCamera = DEFAULT_VIEWPORT;
  private viewportSize: ViewportSize | null = null;
  /** Navigation state (M2 contract, section 3): Space held, and the grabbed page point of a pan. */
  private spaceHeld = false;
  private pan: { grab: PagePoint } | null = null;
  private readonly platform: Platform;
  /** The defaults and extension layers, fixed at creation, and the host layer. */
  private readonly fixedLayers: readonly (readonly CanonicalBinding[])[];
  private hostLayer: readonly CanonicalBinding[];
  private keymap: readonly CanonicalBinding[] = Object.freeze([]);
  private keymapKey = '[]';
  private bindings = new Map<string, CanonicalBinding>();
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private gestureState: Gesture | null = null;
  private snapshot: EditorSnapshot;
  private readonly listeners = new Set<(event: EditorEvent) => void>();
  private readonly pending: EditorEvent[] = [];
  private draining = false;
  private projector: SceneProjector | null = null;
  private reportTo: EditorEvent[] | null = null;
  private renderer: RendererSceneSynchronization | null = null;
  private holding = false;
  private overlay: ToolOverlay | null = null;
  private overlayKey = 'null';
  /** The snap overlay (M2 contract, section 4.2) and whether snapping is on. */
  private snap: SnapOverlay | null = null;
  private snapKey = 'null';
  private snapping = true;
  /** The entered container of the active page (M2 contract, section 5), or null. */
  private scope: string | null = null;
  /**
   * The in-memory clipboard (M2 contract, section 6): fragment text, or null. Session state with
   * no snapshot field or event; it survives loads and page switches.
   */
  private clipboard: string | null = null;
  /**
   * The clipboard generation (M7 contract, section 6): a session counter, 0 at construction,
   * that each successful `loadDocument` increments; `copy` and `cut` record it with the text in
   * `clipboardCopiedIn`. A paste links an instance by its carried source's ID alone only while
   * the two are equal (rule (1)).
   */
  private clipboardGenerationValue = 0;
  private clipboardCopiedIn: number | null = null;
  /**
   * The clipboard's carried source IDs that rule (1) of section 6 may still link: recorded by
   * `copy` and `cut`, less every ID the ID source has returned since (a freed ID can be drawn
   * again for an unrelated node). Empty with a host-supplied ID source.
   */
  private clipboardLinks = new Set<string>();
  /** The IDs drawn since the current command or gesture began, for its history entry. */
  private drawing: string[] = [];
  /** Whether the host supplied the ID source, which rule (1) of section 6 cannot rely on. */
  private readonly hostIds: boolean;
  /**
   * Path edit mode (M3 contract, section 4): while set, the selection is exactly `[id]` and the
   * tool is `select`; every change that breaks either ends it.
   */
  private pathEdit: PathEditState | null = null;
  /**
   * The edited path whose edit mode a scope change ended; the exit is raised at the next
   * selection change or when the top-level command ends, so a frame entry keeps its scope and
   * selection events together before `pathEdit` (M2-U5 note 7).
   */
  private scopeExit: string | null = null;
  private extensionDepth = 0;
  private readonly ids: IdSource;
  private readonly extensions: ExtensionRegistry;
  /**
   * The editor's one expansion cache (M7 contract, M7-X4), shared by the load and command
   * checks, the projector and hit testing.
   */
  readonly expansions: ExpansionCache;
  /**
   * The text layout cache in front of the port (M6a contract, section 5), or null without one;
   * `layout` lays a node out through it.
   */
  readonly textLayouts: TextLayoutCache | null;
  private readonly layout: TextLayouter | undefined;

  /**
   * The IDs of `returned` that a draw on `drawnOn` accepted: `drawIds` and `freshId` skip only
   * IDs that the document they draw on holds (or that are invalid), so an ID `drawnOn` does not
   * hold was taken (M7 contract, section 6).
   */
  private static taken(returned: readonly string[], drawnOn: DocumentV6): string[] {
    return returned.filter(
      (id) =>
        isValidId(id) &&
        !Object.hasOwn(drawnOn.nodes, id) &&
        !drawnOn.pages.some((p) => p.id === id),
    );
  }

  /** Removes a recorded step's accepted IDs from the rule (1) link set and returns them. */
  private unlink(taken: readonly string[]): readonly string[] {
    for (const id of taken) this.clipboardLinks.delete(id);
    return taken;
  }

  /** Runs one gesture step drawing on `drawnOn`, recording the IDs it accepted. */
  private gestureStep<T>(gesture: Gesture, drawnOn: DocumentV6, step: () => T): T {
    this.drawing = [];
    const result = step();
    gesture.accepted.push(...EditorCore.taken(this.drawing, drawnOn));
    this.drawing = [];
    return result;
  }

  /** The clipboard generation (M7 contract, section 6), for tests through `internalsOf`. */
  get clipboardGeneration(): number {
    return this.clipboardGenerationValue;
  }
  /** The built-in tools by name, then the extension tools by ID in registration order. */
  readonly tools = new Map<string, Tool>();
  readonly gesture: GestureControl;
  /** What extension commands receive: `execute` and `query`, nothing else. */
  private readonly api = extensionApi({
    execute: (command) => this.execute(command),
    query: (query) => this.query(query),
  });

  constructor(options: EditorOptions) {
    const source = options.ids ?? createCounterIdSource('node-');
    // Every ID the source returns is noted; those a step accepts leave the rule (1) link set
    // (section 6) when the step is recorded (`accepted`).
    this.ids = () => {
      const id = source();
      if (typeof id === 'string') this.drawing.push(id);
      return id;
    };
    this.hostIds = options.ids !== undefined;
    this.extensions = new ExtensionRegistry(options.extensions ?? []);
    this.expansions = new ExpansionCache((node) => this.extensions.check(node));
    const platform: unknown = options.platform ?? 'other';
    if (platform !== 'mac' && platform !== 'other') {
      throw new Error(`createEditor: invalid platform ${String(platform)}`);
    }
    this.platform = platform;
    const port: unknown = options.textLayout;
    if (port === undefined) {
      this.textLayouts = null;
    } else {
      const candidate = (typeof port === 'object' ? port : null) as Partial<TextLayoutPort> | null;
      if (
        candidate === null ||
        typeof candidate.layout !== 'function' ||
        typeof candidate.subscribe !== 'function'
      ) {
        throw new Error('createEditor: invalid textLayout');
      }
      if (candidate.portVersion !== 0) {
        throw new Error(`createEditor: textLayout portVersion ${String(candidate.portVersion)}`);
      }
      this.textLayouts = new TextLayoutCache(port as TextLayoutPort);
    }
    const cache = this.textLayouts;
    this.layout = cache === null ? undefined : (node) => cache.layout(node);
    this.fixedLayers = this.extensionLayers(options.extensions ?? []);
    const host = validateLayer(
      options.keymap ?? [],
      platform,
      (id) => this.isCommand(id),
      (id) => this.extensions.tool(id) !== undefined,
    );
    if (!host.ok) throw new Error(`createEditor: editor.invalid-keymap at /keymap${host.path}`);
    this.hostLayer = host.bindings;
    this.updateKeymap();
    const result = this.validate(
      options.document === undefined ? emptyDocument(this.ids) : options.document,
    );
    if (!result.ok) throw new Error(`createEditor: ${result.code} at ${result.path}`);
    this.document = deepFreeze(result.document);
    this.activePage = this.document.pages[0]!.id;
    this.snapshot = this.buildSnapshot();
    this.tools.set(
      'select',
      createSelectTool((node) => this.extensions.geometry(node), this.expansions),
    );
    this.tools.set('rectangle', createBoxTool('createRectangle'));
    this.tools.set('ellipse', createBoxTool('createEllipse'));
    this.tools.set('frame', createBoxTool('createFrame'));
    this.tools.set('line', createLineTool());
    this.tools.set('path', createPathTool());
    const isActive = () => this.gestureState !== null;
    this.gesture = {
      get active() {
        return isActive();
      },
      begin: () => this.beginGesture(),
      update: (command) => this.updateGesture(command),
      replace: (commands) => this.replaceGesture(commands),
      edit: (edit) => this.editGesture(edit),
      commit: () => this.commitGesture(),
      cancel: () => this.cancelGesture(),
    };
    for (const tool of this.extensions.tools) this.tools.set(tool.id, this.extensionTool(tool));
    // One subscription for the editor's lifetime (M6a-Q20 (a)). A generation change drops the
    // cache and raises one `textLayout` session event: no document event, step or frame change.
    cache?.port.subscribe(() => {
      if (cache.notify()) this.emit({ type: 'session', field: 'textLayout' });
    });
  }

  /**
   * An extension tool as the editor drives it (M2 contract, section 7): it receives a frozen
   * `ToolApi` (execute, query and the gesture API without `edit`), and only `true` from `input`
   * consumes the event. Its gesture API acts only while it is the active tool, and the whole
   * `ToolApi` except `query` is inert while its `reset` runs (a reset must issue no command), so
   * a reset during a tool switch, page switch or load cannot open a gesture or change the
   * document. A throw from `input` or `reset` is the extension's defect: it is rethrown
   * asynchronously, as for an extension command; after a throw from `input` the event counts as
   * not consumed and the editor cancels any open gesture and resets the tool, so a broken tool
   * cannot hold a gesture (and the keyboard) open. `input` re-entered through
   * `execute({ type: 'input' })` shares the extension command depth limit. A throwing or
   * malformed `overlay` gives no overlay.
   */
  private extensionTool(registered: RegisteredTool): Tool {
    const control = this.gesture;
    let resetting = false;
    const own = () => !resetting && this.tool === registered.id;
    const gesture: ToolGesture = Object.freeze({
      get active() {
        return control.active;
      },
      begin: () => own() && control.begin(),
      update: (command: DocumentCommand) =>
        own() ? control.update(command) : failure('editor.invalid-command'),
      replace: (commands: readonly DocumentCommand[]) =>
        own() ? control.replace(commands) : failure('editor.invalid-command'),
      commit: () => {
        if (own()) control.commit();
      },
      cancel: () => {
        if (own()) control.cancel();
      },
    });
    const api: ToolApi = Object.freeze({
      execute: (command: Command) =>
        resetting ? failure('editor.invalid-command') : this.execute(command),
      query: <Q extends Query>(query: Q) => this.query(query),
      gesture,
    });
    const rethrow = (error: unknown) => {
      void Promise.resolve().then(() => {
        throw error;
      });
    };
    return {
      input: (event) => {
        // Re-entry through `execute({ type: 'input' })` stops at the extension depth limit.
        if (this.extensionDepth >= MAX_EXTENSION_DEPTH) return false;
        this.extensionDepth += 1;
        try {
          return registered.input(event, api) === true;
        } catch (error) {
          rethrow(error);
          try {
            this.interrupt(true);
          } catch (inner) {
            rethrow(inner);
          }
          return false;
        } finally {
          this.extensionDepth -= 1;
        }
      },
      reset: () => {
        // Nested resets (a reset that triggers another) keep the outer flag.
        const outer = resetting;
        resetting = true;
        try {
          registered.reset();
        } catch (error) {
          rethrow(error);
        } finally {
          resetting = outer;
        }
      },
      overlay: () => {
        if (registered.overlay === null) return null;
        try {
          return toolOverlay(registered.overlay());
        } catch {
          return null;
        }
      },
    };
  }

  /**
   * The defaults, then each extension's bindings in registration order (M2 contract, section 7).
   * An extension may bind built-in actions and its own commands only, and two extensions may not
   * bind one canonical chord; either is a host programming error that throws.
   */
  private extensionLayers(extensions: readonly Extension[]): (readonly CanonicalBinding[])[] {
    const defaults = validateLayer(DEFAULT_KEYMAP, this.platform, () => false);
    if (!defaults.ok) throw new Error(`createEditor: editor.invalid-keymap in the defaults`);
    const layers = [defaults.bindings];
    const owners = new Map<string, string>();
    extensions.forEach((extension, index) => {
      const { id, bindings = [] } = extension;
      // Its own commands, and in `setTool` its own tools (built-in tools are always allowed).
      const ownCommand = (command: string) => owned(id, command) && this.isCommand(command);
      const ownTool = (tool: string) => this.extensions.tool(tool)?.owner === id;
      const layer = validateLayer(bindings, this.platform, ownCommand, ownTool);
      if (!layer.ok) {
        throw new Error(
          `createEditor: editor.invalid-keymap at /extensions/${index}/bindings${layer.path}`,
        );
      }
      for (const binding of layer.bindings) {
        const other = owners.get(binding.chord);
        if (other !== undefined) {
          throw new Error(
            `createEditor: editor.invalid-keymap: ${id} and ${other} both bind ${binding.chord}`,
          );
        }
        owners.set(binding.chord, id);
      }
      layers.push(layer.bindings);
    });
    return layers;
  }

  private isCommand(id: string): boolean {
    return this.extensions.command(id) !== undefined;
  }

  /** Recomputes the effective keymap; true when it changed. */
  private updateKeymap(): boolean {
    const keymap = effectiveKeymap([...this.fixedLayers, this.hostLayer]);
    const key = JSON.stringify(keymap);
    if (key === this.keymapKey) return false;
    this.keymap = keymap;
    this.keymapKey = key;
    this.bindings = new Map(keymap.map((binding) => [binding.chord, binding]));
    return true;
  }

  /**
   * Events raised while a top-level command runs are held until it has fully committed, so a
   * listener that executes a command never lands inside another command's change.
   */
  execute(command: Command): CommandResult {
    if (this.holding) return this.run(command);
    this.holding = true;
    try {
      return this.run(command);
    } finally {
      if (this.scopeExit !== null) this.syncPathEdit();
      this.refreshOverlay();
      this.holding = false;
      this.flush();
    }
  }

  private run(command: Command): CommandResult {
    if (typeof command !== 'object' || command === null) return failure('editor.invalid-command');
    if (DOCUMENT_COMMANDS.has(command.type)) {
      // A host command during a drag would leave the gesture's base stale, so it applies to the
      // pre-gesture document and, only if it succeeds, cancels the drag first.
      const base = this.gestureState?.base ?? this.document;
      // The command's own draws, apart from those of a gesture it may interrupt.
      const outer = this.drawing;
      this.drawing = [];
      const result = applyEdit(base, command as DocumentCommand, this.context(true));
      const returned = this.drawing;
      this.drawing = outer;
      if (!result.ok) return result;
      // A relative command that changes nothing records no step and no event (M2 section 4).
      if (result.document === base) return { ok: true, ids: [] };
      // A command's draws all run on `base`.
      const drawn = this.unlink(EditorCore.taken(returned, base));
      this.interrupt();
      const entry = { before: base, after: result.document, touched: result.touched, drawn };
      this.undoStack.push(entry);
      this.redoStack = [];
      this.changeDocument(result.document, 'command', result.touched);
      // The pasted roots become the selection (section 6).
      if (command.type === 'paste') this.setSelectionState(result.created);
      return { ok: true, ids: result.ids ?? result.created };
    }
    switch (command.type) {
      case 'undo':
      case 'redo': {
        const from = command.type === 'undo' ? this.undoStack : this.redoStack;
        const to = command.type === 'undo' ? this.redoStack : this.undoStack;
        // An empty stack fails before anything changes, so the drag goes on.
        if (from.length === 0) {
          return failure(
            command.type === 'undo' ? 'editor.nothing-to-undo' : 'editor.nothing-to-redo',
          );
        }
        this.interrupt();
        const entry = from.pop()!;
        to.push(entry);
        // The step's IDs now name other nodes, or none (section 6, rule (1)).
        for (const id of entry.drawn) this.clipboardLinks.delete(id);
        const target = command.type === 'undo' ? entry.before : entry.after;
        this.changeDocument(target, command.type, entry.touched);
        return { ok: true, ids: [] };
      }
      case 'loadDocument': {
        const result = this.validate(command.document);
        if (!result.ok) return failure(result.code, result.path);
        this.interrupt(true);
        const touched = [
          ...Object.keys(this.document.nodes),
          ...Object.keys(result.document.nodes),
        ];
        this.undoStack = [];
        this.redoStack = [];
        // The clipboard survives a load, but its IDs may name other nodes now (section 6).
        this.clipboardGenerationValue += 1;
        this.changeDocument(deepFreeze(result.document), 'load', touched);
        return { ok: true, ids: [] };
      }
      case 'setSelection': {
        if (!Array.isArray(command.ids)) return failure('editor.invalid-command', '/ids');
        // Nodes of the active page at any depth; the ancestor of a listed descendant wins.
        const ids = normalizeSelection(this.document, this.activePage, command.ids);
        if (ids === null) return failure('editor.unknown-node');
        this.setSelectionState(ids);
        return { ok: true, ids: [] };
      }
      case 'setActivePage': {
        if (typeof command.id !== 'string') return failure('editor.invalid-command', '/id');
        if (!this.document.pages.some((page) => page.id === command.id)) {
          return failure('editor.unknown-page');
        }
        // Like setTool, it first cancels an active gesture (M1 contract, section 3). A real
        // switch resets the tool once, in switchPage.
        if (command.id === this.activePage) this.interrupt();
        else this.cancelGesture();
        if (command.id !== this.activePage) {
          const hadSelection = this.selection.length > 0;
          const hadScope = this.scope !== null;
          this.switchPage(command.id);
          // A new page is a new scene identity: the renderer gets a full snapshot.
          const diagnostics: EditorEvent[] = [];
          this.withProjector(
            (projector) => projector.replace(this.document, this.activePage),
            diagnostics,
          );
          this.refresh({ type: 'session', field: 'activePage' });
          if (hadSelection) this.emit({ type: 'session', field: 'selection' });
          if (hadScope) this.emit({ type: 'session', field: 'scope' });
          diagnostics.forEach((event) => this.emit(event));
          // The cleared selection ends path edit mode.
          this.syncPathEdit();
        }
        return { ok: true, ids: [] };
      }
      case 'setTool': {
        // A built-in name or a registered extension tool ID (section 7).
        if (typeof command.tool !== 'string' || !this.tools.has(command.tool)) {
          return failure('editor.unknown-tool');
        }
        this.interrupt(true);
        if (command.tool !== this.tool) {
          this.tool = command.tool;
          this.refresh({ type: 'session', field: 'tool' });
          // Another tool ends path edit mode (M3 contract, section 4).
          this.syncPathEdit();
        }
        return { ok: true, ids: [] };
      }
      case 'setViewport': {
        if (!isCamera(command.camera)) return failure('editor.invalid-camera');
        const { position, zoom } = command.camera;
        const camera = deepFreeze({ position: { x: position.x + 0, y: position.y + 0 }, zoom });
        // The renderer's camera check is the last word; on invalid-camera nothing changes.
        if (!this.applyCamera(camera)) return failure('editor.invalid-camera');
        this.viewport = camera;
        this.refresh({ type: 'session', field: 'viewport' });
        return { ok: true, ids: [] };
      }
      case 'input': {
        if (!isInputEvent(command.event)) return failure('editor.invalid-command', '/event');
        // Tools keep points, so they get a frozen copy, never the host's objects.
        return this.dispatch(copyInput(command.event));
      }
      case 'setViewportSize': {
        const { width, height } = command;
        if (!(Number.isFinite(width) && width > 0))
          return failure('editor.invalid-command', '/width');
        if (!(Number.isFinite(height) && height > 0)) {
          return failure('editor.invalid-command', '/height');
        }
        const size = this.viewportSize;
        if (size === null || size.width !== width || size.height !== height) {
          this.viewportSize = deepFreeze({ width: width + 0, height: height + 0 });
          this.refresh({ type: 'session', field: 'viewportSize' });
        }
        return { ok: true, ids: [] };
      }
      case 'zoomBy': {
        const { factor, about } = command;
        if (!(Number.isFinite(factor) && factor > 0)) {
          return failure('editor.invalid-command', '/factor');
        }
        if (about !== undefined && !isPoint(about))
          return failure('editor.invalid-command', '/about');
        const point = about ?? this.viewportCentre();
        if (point === null) return failure('editor.no-viewport-size');
        return this.zoomAbout(point, clampZoom(this.viewport.zoom * factor));
      }
      case 'zoomTo': {
        const { target } = command;
        if (target !== 'fit' && target !== 'selection' && target !== 'actual') {
          return failure('editor.invalid-command', '/target');
        }
        const centre = this.viewportCentre();
        if (centre === null) return failure('editor.no-viewport-size');
        if (target === 'actual') return this.zoomAbout(centre, 1);
        return this.zoomToBounds(target);
      }
      case 'setKeymap': {
        if (!Array.isArray(command.bindings)) return failure('editor.invalid-command', '/bindings');
        const layer = validateLayer(
          command.bindings,
          this.platform,
          (id) => this.isCommand(id),
          (id) => this.extensions.tool(id) !== undefined,
        );
        if (!layer.ok) return failure('editor.invalid-keymap', `/bindings${layer.path}`);
        this.hostLayer = layer.bindings;
        if (this.updateKeymap()) this.refresh({ type: 'session', field: 'keymap' });
        return { ok: true, ids: [] };
      }
      case 'setSnapping': {
        if (typeof command.enabled !== 'boolean') {
          return failure('editor.invalid-command', '/enabled');
        }
        if (command.enabled !== this.snapping) {
          this.snapping = command.enabled;
          this.refresh({ type: 'session', field: 'snapping' });
          // Snapping turned off mid-gesture: the overlay clears at once (M2-U3).
          if (!command.enabled) this.setSnap(null);
        }
        return { ok: true, ids: [] };
      }
      case 'setScope': {
        const { id } = command;
        if (id !== null && typeof id !== 'string') return failure('editor.invalid-command', '/id');
        if (id !== null) {
          // A node of the active page at any depth (section 4.4: unknown-node before
          // invalid-scope).
          const tree = documentTree(this.document);
          if (pageOf(tree, id) !== this.activePage) return failure('editor.unknown-node');
          if (!isContainer(tree.node(id))) return failure('editor.invalid-scope');
        }
        this.setScopeState(id);
        return { ok: true, ids: [] };
      }
      case 'copy':
      case 'cut': {
        const ids: unknown = command.ids;
        // The selection by default; an empty one changes nothing (section 6).
        if (ids === undefined && this.selection.length === 0) return { ok: true, ids: [] };
        // A cut is a document change: during a drag it applies to the pre-gesture document, as
        // any host command does; a copy reads the live document and leaves the drag alone.
        const source =
          command.type === 'cut' ? (this.gestureState?.base ?? this.document) : this.document;
        // Only an omitted `ids` means the selection; any other value is checked (`null` fails).
        const listed = ids === undefined ? this.selection : ids;
        const copied = copyFragment(source, listed, this.activePage);
        if ('ok' in copied) return copied;
        if (command.type === 'cut') {
          // One transaction; a failed delete leaves the clipboard as it was.
          const result = this.run({ type: 'deleteNodes', ids: copied.roots });
          if (!result.ok) return result;
        }
        this.clipboard = copied.text;
        this.clipboardCopiedIn = this.clipboardGenerationValue;
        this.clipboardLinks = new Set(this.hostIds ? [] : copied.sources);
        // The copied roots in paint order, so a host can tell a copy from an empty one.
        return { ok: true, ids: copied.roots };
      }
      case 'enterPathEdit': {
        const { id } = command;
        if (typeof id !== 'string') return failure('editor.invalid-command', '/id');
        // Checked on the pre-gesture document, which the gesture's cancel restores.
        const base = this.gestureState?.base ?? this.document;
        const node = Object.hasOwn(base.nodes, id) ? base.nodes[id] : undefined;
        if (node === undefined || pageOf(documentTree(base), id) !== this.activePage) {
          return failure('editor.unknown-node');
        }
        if (node.type !== 'path') return failure('editor.not-a-path');
        if (this.pathEdit?.id === id) {
          // Entering the edited path again cancels an exit a scope change deferred.
          if (this.scopeExit === id) this.scopeExit = null;
          return { ok: true, ids: [] };
        }
        this.interrupt();
        if (this.tool !== 'select') this.run({ type: 'setTool', tool: 'select' });
        // Set first, so the selection change to `[id]` keeps it; the event follows the
        // selection's (section 4).
        this.pathEdit = deepFreeze({ id, anchors: [] });
        this.scopeExit = null;
        this.setSelectionState([id]);
        this.refresh({ type: 'session', field: 'pathEdit' });
        return { ok: true, ids: [] };
      }
      case 'exitPathEdit':
        this.setPathEditState(null);
        return { ok: true, ids: [] };
      case 'setPathSelection': {
        const refs: unknown = command.anchors;
        const shape = refListShape(refs, true);
        if (shape !== null) return shape;
        const edit = this.pathEdit;
        if (edit === null) return failure('editor.no-path-edit');
        const model = readAnchorModel(editablePath(this.document, this.activePage, edit.id)!.path);
        const list = refs as readonly PathAnchorRef[];
        const bad = badRef(model, list);
        if (bad !== null) return bad;
        this.setPathEditState({ id: edit.id, anchors: canonicalRefs(list) });
        return { ok: true, ids: [] };
      }
      case 'runCommand': {
        const extension =
          typeof command.id === 'string' ? this.extensions.command(command.id) : undefined;
        if (extension === undefined) return failure('editor.unknown-command');
        if (this.extensionDepth >= MAX_EXTENSION_DEPTH) return failure('editor.extension-failed');
        // The extension composes public commands; events stay held until it returns. A throw
        // or a malformed result is the extension's defect: the commands it already ran stay,
        // and the error is rethrown asynchronously, as for listeners.
        this.extensionDepth += 1;
        try {
          const result = extensionResult(extension.run(command.args, this.api), this.document);
          return result ?? failure('editor.extension-failed');
        } catch (error) {
          void Promise.resolve().then(() => {
            throw error;
          });
          return failure('editor.extension-failed');
        } finally {
          this.extensionDepth -= 1;
        }
      }
      default:
        return failure('editor.invalid-command', '/type');
    }
  }

  /**
   * The model's rules (a v1 value is migrated), then each custom node against its extension
   * wherever it is nested (plan section 3.3), then the clip depth (M1 contract, section 4.3;
   * through each expansion, M7-S5), then each expansion's validity and the expansion caps (M7
   * contract, M7-X3 and section 4.1).
   */
  private validate(value: unknown): ParseResult | CommandFailure {
    const result = validateAnyDocument(value);
    if (!result.ok) return result;
    // Frozen before any extension sees it, so `validate` cannot change what is stored.
    const rejected = this.extensions.checkDocument(deepFreeze(result.document));
    if (rejected !== null) return { ok: false, ...rejected };
    const deep = documentClipViolation(result.document);
    if (deep !== null) {
      return { ok: false, code: 'editor.clip-depth', path: nodePath(deep, '/parent') };
    }
    const expansion = expansionFailure(result.document, this.expansions);
    return expansion === null ? result : { ok: false, code: expansion.code, path: expansion.path! };
  }

  private context(refit: boolean) {
    return {
      ids: this.ids,
      custom: this.extensions,
      activePage: this.activePage,
      refit,
      clipboard: this.clipboard,
      clipboardLinks:
        this.clipboardCopiedIn === this.clipboardGenerationValue ? this.clipboardLinks : NO_LINKS,
      scope: this.scope,
      selection: this.selection,
      expansions: this.expansions,
      layout: this.layout,
    };
  }

  query<Q extends Query>(query: Q): QueryResult<Q> {
    const value = ((): unknown => {
      switch (query.type) {
        case 'document':
          return this.document;
        case 'committedDocument':
          // The pre-gesture document during a gesture (M5 contract, M5-S3); both are frozen.
          return this.gestureState?.base ?? this.document;
        case 'node':
          return Object.hasOwn(this.document.nodes, query.id)
            ? this.document.nodes[query.id]
            : null;
        case 'selection':
          return this.selection;
        case 'tool':
          return this.tool;
        case 'viewport':
          return this.viewport;
        case 'history':
          return this.snapshot.history;
        case 'revision':
          return this.revision;
        case 'overlay':
          return this.tools.get(this.tool)?.overlay() ?? null;
        case 'activePage':
          return this.activePage;
        case 'pages':
          return this.document.pages;
        case 'handles':
          // Null in path edit mode (M3 contract, section 4).
          return this.pathEdit === null
            ? selectionHandles(this.document, this.activePage, this.selection)
            : null;
        case 'viewportSize':
          return this.viewportSize;
        case 'keymap':
          return this.keymap;
        case 'snap':
          return this.snap;
        case 'snapping':
          return this.snapping;
        case 'scope':
          return this.scope;
        case 'clipboard':
          return this.clipboard;
        case 'pathEdit':
          return this.pathEdit;
        case 'pathOverlay':
          return this.pathEdit === null ? null : pathEditOverlay(this.document, this.pathEdit);
        case 'textLayout': {
          const id: unknown = query.id;
          const node =
            typeof id === 'string' && Object.hasOwn(this.document.nodes, id)
              ? this.document.nodes[id]
              : undefined;
          return this.layout === undefined || node?.type !== 'text' ? null : this.layout(node);
        }
      }
    })();
    return value as QueryResult<Q>;
  }

  subscribe(listener: (event: EditorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): EditorSnapshot {
    return this.snapshot;
  }

  attachRenderer(renderer: RendererSceneSynchronization): () => void {
    const projector = new SceneProjector(
      renderer,
      (node) => this.extensions.geometry(node),
      (event) => (this.reportTo ?? this.pending).push(event),
      this.expansions,
    );
    this.projector = projector;
    this.renderer = renderer;
    const diagnostics: EditorEvent[] = [];
    this.withProjector((attached) => attached.replace(this.document, this.activePage), diagnostics);
    // The editor's viewport is already valid; a renderer that rejects it keeps its own camera
    // until the next `setViewport`.
    this.applyCamera(this.viewport);
    diagnostics.forEach((event) => this.emit(event));
    return () => {
      if (this.projector === projector) {
        this.projector = null;
        this.renderer = null;
      }
    };
  }

  /** Sends the camera to the attached renderer; false only when it rejects the camera. */
  private applyCamera(camera: RenderCamera): boolean {
    if (this.renderer === null) return true;
    const result = this.renderer.setCamera(camera);
    if (result.status === 'disposed') {
      this.projector = null;
      this.renderer = null;
      return true;
    }
    return result.status !== 'invalid-camera';
  }

  /**
   * One `input` event in the M2-I2 order: navigation, `pointercancel`, the active tool during a
   * gesture, then the tool and the keymap for a key-down. The result carries `consumed` (M2-I3).
   */
  private dispatch(event: InputEvent): CommandResult {
    const done = (consumed: boolean): CommandResult => ({ ok: true, ids: [], consumed });
    // (1) Navigation: wheel, Space, middle-button drags and drags begun while Space is held.
    switch (event.kind) {
      case 'wheel':
        return { ...this.wheel(event), consumed: true };
      case 'keydown':
      case 'keyup':
        if (isSpaceKey(event)) {
          this.spaceHeld = event.kind === 'keydown';
          return done(true);
        }
        break;
      case 'pointerdown': {
        if (this.pan !== null) return done(true);
        const button = event.button ?? 0;
        // Space pressed during a tool gesture starts no pan until that gesture ends.
        if (this.gestureState === null && (button === 1 || (button === 0 && this.spaceHeld))) {
          this.pan = { grab: event.point };
          return done(true);
        }
        // Other buttons are ignored (M2-I1).
        if (button !== 0) return done(false);
        break;
      }
      case 'pointermove':
      case 'pointerup':
        if (this.pan !== null) {
          const { grab } = this.pan;
          if (event.kind === 'pointerup') this.pan = null;
          const { position, zoom } = this.viewport;
          const result = this.setCamera(
            { x: position.x + (grab.x - event.point.x), y: position.y + (grab.y - event.point.y) },
            zoom,
          );
          return { ...result, consumed: true };
        }
        break;
      case 'pointercancel': {
        // (2) It ends a pan, releases Space, cancels a gesture and resets the tool; never keymap.
        const consumed =
          this.pan !== null ||
          this.spaceHeld ||
          this.gestureState !== null ||
          (this.tools.get(this.tool)?.overlay() ?? null) !== null;
        this.pan = null;
        this.spaceHeld = false;
        this.interrupt(true);
        return done(consumed);
      }
      default:
        break;
    }
    // Ctrl or Meta pressed during a gesture disables snapping, so the overlay clears at once;
    // the document follows on the next update (M2-U3).
    if (
      event.kind === 'keydown' &&
      this.gestureState !== null &&
      (event.modifiers.ctrl ||
        event.modifiers.meta ||
        event.key === 'Control' ||
        event.key === 'Meta')
    ) {
      this.setSnap(null);
    }
    const tool = this.tools.get(this.tool);
    const consumed =
      tool?.input(event, {
        execute: (next) => this.execute(next),
        query: (query) => this.query(query),
        gesture: this.gesture,
        snap: (overlay) => this.setSnap(overlay),
      }) ?? false;
    // (3) During a gesture only the tool sees events; (4) an unconsumed key-down goes to the
    // keymap; (5) a key-up, double-click and pointer events go to the tool only.
    if (consumed || this.gestureState !== null || event.kind !== 'keydown') return done(consumed);
    const chord = eventChord(event, event.modifiers);
    const binding = chord === null ? undefined : this.bindings.get(chord);
    if (binding === undefined) return done(false);
    // A copy or cut with an empty selection is not consumed, so the host leaves the browser's
    // clipboard event alone (section 6).
    const clipboardAction = binding.action === 'copy' || binding.action === 'cut';
    if (clipboardAction && this.selection.length === 0) return done(false);
    return { ...this.runAction(binding), consumed: true };
  }

  /**
   * A bound action (M2 contract, section 7). Selection actions run their command on the current
   * selection and do nothing on an empty one; any other action is an extension command.
   */
  private runAction(binding: CanonicalBinding): CommandResult {
    const nothing: CommandResult = { ok: true, ids: [] };
    const selection = this.selection;
    const edit = this.pathEdit;
    if (edit !== null) {
      const result = this.runPathEditAction(binding, edit);
      if (result !== null) return result;
    }
    switch (binding.action) {
      case 'setTool':
        return this.run({
          type: 'setTool',
          tool: (binding.args as { tool: ToolId }).tool,
        });
      case 'undo':
        return this.run({ type: 'undo' });
      case 'redo':
        return this.run({ type: 'redo' });
      case 'delete':
        return selection.length === 0 ? nothing : this.run({ type: 'deleteNodes', ids: selection });
      case 'selectAll': {
        // The scope's children, or the page's (section 7).
        const ids = childrenOf(documentTree(this.document), this.scope ?? this.activePage);
        return this.run({ type: 'setSelection', ids });
      }
      case 'enterScope': {
        // A single selected container is entered and its children selected (section 5), and a
        // single selected path enters edit mode (M3 contract, section 4); any other selection
        // does nothing (still consumed).
        const node = selection.length === 1 ? this.document.nodes[selection[0]!] : undefined;
        if (node?.type === 'path') return this.run({ type: 'enterPathEdit', id: node.id });
        if (!isContainer(node)) return nothing;
        this.run({ type: 'setScope', id: node.id });
        return this.run({ type: 'setSelection', ids: node.children });
      }
      case 'exitScope': {
        // Without a scope, Escape clears the selection. With one, the scope node is selected and
        // the scope moves to its nearest container ancestor that is not a top-level frame or
        // symbol (their children are targets at the page already, M7 section 1.2), or the page.
        const scope = this.scope;
        if (scope === null) return this.run({ type: 'setSelection', ids: [] });
        const tree = documentTree(this.document);
        const up = ancestors(tree, scope).find(
          (node) => !(isFrameLike(node) && tree.page(node.parent) !== undefined),
        );
        this.run({ type: 'setSelection', ids: [scope] });
        return this.run({ type: 'setScope', id: up?.id ?? null });
      }
      case 'group':
      case 'maskGroup': {
        if (selection.length === 0) return nothing;
        // As the next-host toolbar does, the new group becomes the selection.
        const result = this.run({
          type: 'groupNodes',
          ids: selection,
          kind: binding.action === 'group' ? 'group' : 'maskGroup',
        });
        if (result.ok) this.run({ type: 'setSelection', ids: result.ids });
        return result;
      }
      case 'ungroup': {
        // `ungroupNodes` takes one group; any other selection does nothing (still consumed).
        const node = selection.length === 1 ? this.document.nodes[selection[0]!] : undefined;
        if (!isGroup(node)) return nothing;
        const released = node.children;
        const result = this.run({ type: 'ungroupNodes', id: node.id });
        if (result.ok) this.run({ type: 'setSelection', ids: released });
        return result;
      }
      case 'duplicate': {
        if (selection.length === 0) return nothing;
        const offset = (binding.args as { offset?: PagePoint } | undefined)?.offset;
        const result = this.run({
          type: 'duplicateNodes',
          ids: selection,
          ...(offset === undefined ? {} : { offset }),
        });
        // As for `group`, the copies become the selection, so a nudge moves them.
        if (result.ok) this.run({ type: 'setSelection', ids: result.ids });
        return result;
      }
      case 'nudge': {
        if (selection.length === 0) return nothing;
        const { dx, dy } = binding.args as { dx: number; dy: number };
        return this.run({ type: 'nudgeNodes', ids: selection, dx, dy });
      }
      case 'reorder': {
        if (selection.length === 0) return nothing;
        const { op } = binding.args as { op: ReorderOp };
        return this.run({ type: 'reorderNodes', ids: selection, op });
      }
      case 'align': {
        if (selection.length === 0) return nothing;
        const { edge } = binding.args as { edge: AlignEdge };
        return this.run({ type: 'alignNodes', ids: selection, edge });
      }
      case 'distribute': {
        if (selection.length === 0) return nothing;
        const { axis } = binding.args as { axis: DistributeAxis };
        return this.run({ type: 'distributeNodes', ids: selection, axis });
      }
      case 'zoomIn':
        return this.run({ type: 'zoomBy', factor: 2 });
      case 'zoomOut':
        return this.run({ type: 'zoomBy', factor: 0.5 });
      case 'zoomToFit':
        return this.run({ type: 'zoomTo', target: 'fit' });
      case 'zoomToSelection':
        return this.run({ type: 'zoomTo', target: 'selection' });
      case 'zoomTo100':
        return this.run({ type: 'zoomTo', target: 'actual' });
      // The in-memory clipboard (section 6); the dispatch leaves an empty-selection copy or
      // cut unconsumed before it gets here.
      case 'copy':
        return this.run({ type: 'copy', ids: selection });
      case 'cut':
        return this.run({ type: 'cut', ids: selection });
      case 'paste':
        return this.run({ type: 'paste' });
      // Outside path edit mode (M3 contract, section 4).
      case 'togglePathClosed':
        return nothing;
      default: {
        const command = { type: 'runCommand', id: binding.action! } as const;
        return this.run(binding.args === undefined ? command : { ...command, args: binding.args });
      }
    }
  }

  /**
   * The built-in actions that act on anchors in path edit mode (M3 contract, section 4), or null
   * for an action that keeps its M2 meaning. `nudge` moves the anchor selection, `selectAll`
   * selects every anchor, `enterScope` and `exitScope` end edit mode with the path still
   * selected, and `togglePathClosed` closes or opens the subpath of the anchor selection.
   * `delete` removes the anchor selection, or deletes the node when no subpath would remain.
   * With an empty anchor selection `delete`, `nudge` and `togglePathClosed` are consumed no-ops.
   */
  private runPathEditAction(binding: CanonicalBinding, edit: PathEditState): CommandResult | null {
    const nothing: CommandResult = { ok: true, ids: [] };
    switch (binding.action) {
      case 'delete': {
        if (edit.anchors.length === 0) return nothing;
        const result = this.run({ type: 'removePathAnchors', id: edit.id, anchors: edit.anchors });
        if (result.ok || result.code !== 'editor.empty-path') return result;
        // Removing every anchor deletes the node instead, in one step (M3-Q4); edit mode ends.
        return this.run({ type: 'deleteNodes', ids: [edit.id] });
      }
      case 'togglePathClosed':
        return this.togglePathClosed(edit);
      case 'nudge': {
        if (edit.anchors.length === 0) return nothing;
        const { dx, dy } = binding.args as { dx: number; dy: number };
        return this.run({ type: 'movePathAnchors', id: edit.id, anchors: edit.anchors, dx, dy });
      }
      case 'selectAll': {
        const node = editablePath(this.document, this.activePage, edit.id)!;
        return this.run({ type: 'setPathSelection', anchors: allAnchors(node.path) });
      }
      case 'enterScope':
      case 'exitScope':
        this.setPathEditState(null);
        return nothing;
      default:
        return null;
    }
  }

  /**
   * `togglePathClosed` in edit mode (M3 contract, section 4): when the selected anchors lie in
   * one subpath it closes an open one, and opens a closed one at segment `k` when exactly the two
   * ends of segment `k` are selected (the lowest such `k`), else at its closing segment; any
   * other anchor selection is a consumed no-op.
   */
  private togglePathClosed(edit: PathEditState): CommandResult {
    const { id, anchors } = edit;
    const subpath = anchors[0]?.subpath;
    if (subpath === undefined || anchors.some((ref) => ref.subpath !== subpath)) {
      return { ok: true, ids: [] };
    }
    const model = readAnchorModel(editablePath(this.document, this.activePage, id)!.path)[subpath]!;
    if (!model.closed) return this.run({ type: 'closePathSubpath', id, subpath });
    const n = model.anchors.length;
    const selected = new Set(anchors.map((ref) => ref.anchor));
    const segment = model.segments.findIndex((_, k) => {
      const ends = new Set([k, (k + 1) % n]);
      return ends.size === selected.size && [...ends].every((a) => selected.has(a));
    });
    return this.run({
      type: 'openPathSubpath',
      id,
      subpath,
      ...(segment < 0 ? {} : { segment }),
    });
  }

  /** A wheel event (M2 contract, section 3): Ctrl or Meta zooms about the point, else it pans. */
  private wheel(event: Extract<InputEvent, { kind: 'wheel' }>): CommandResult {
    const { position, zoom } = this.viewport;
    const { modifiers, deltaX, deltaY } = event;
    if (modifiers.ctrl || modifiers.meta) {
      return this.zoomAbout(event.point, clampZoom(zoom * 2 ** (-deltaY / 100)));
    }
    // Shift with no horizontal delta turns a vertical scroll into a horizontal pan.
    const [dx, dy] = modifiers.shift && deltaX === 0 ? [deltaY, 0] : [deltaX, deltaY];
    return this.setCamera({ x: position.x + dx / zoom, y: position.y + dy / zoom }, zoom);
  }

  /** The viewport centre in page space, or null before `setViewportSize`. */
  private viewportCentre(): PagePoint | null {
    const size = this.viewportSize;
    if (size === null) return null;
    const { position, zoom } = this.viewport;
    return { x: position.x + size.width / (2 * zoom), y: position.y + size.height / (2 * zoom) };
  }

  /** Zooms to `z1` keeping the page point `p` under the same screen pixel. */
  private zoomAbout(p: PagePoint, z1: number): CommandResult {
    const { position, zoom: z0 } = this.viewport;
    // An unchanged zoom keeps the camera as is (p − (p − position) need not round back).
    if (z1 === z0) return { ok: true, ids: [] };
    return this.setCamera(
      { x: p.x - (p.x - position.x) * (z0 / z1), y: p.y - (p.y - position.y) * (z0 / z1) },
      z1,
    );
  }

  /** `zoomTo` `fit` or `selection` (M2 contract, section 3); no bounds changes nothing. */
  private zoomToBounds(target: 'fit' | 'selection'): CommandResult {
    const { width: W, height: H } = this.viewportSize!;
    let ids: readonly string[] = this.selection;
    if (target === 'fit') {
      const page = this.document.pages.find((entry) => entry.id === this.activePage)!;
      ids = page.children.filter((id) => this.document.nodes[id]?.visible !== false);
    }
    const b = boundsOf(this.document, ids);
    if (b === null) return { ok: true, ids: [] };
    const scales: number[] = [];
    if (b.width > 0) scales.push((W > FIT_PADDING ? W - FIT_PADDING : W) / b.width);
    if (b.height > 0) scales.push((H > FIT_PADDING ? H - FIT_PADDING : H) / b.height);
    const z = scales.length === 0 ? this.viewport.zoom : clampZoom(Math.min(...scales));
    return this.setCamera(
      { x: b.x + b.width / 2 - W / (2 * z), y: b.y + b.height / 2 - H / (2 * z) },
      z,
    );
  }

  /**
   * Every computed viewport change (M2 contract, section 3): a camera equal to the current one
   * sends nothing and raises no event; otherwise it takes the `setViewport` path.
   */
  private setCamera(position: PagePoint, zoom: number): CommandResult {
    const current = this.viewport;
    const camera = { position: { x: position.x + 0, y: position.y + 0 }, zoom };
    if (!isCamera(camera)) return failure('editor.invalid-camera');
    if (
      camera.zoom === current.zoom &&
      camera.position.x === current.position.x &&
      camera.position.y === current.position.y
    ) {
      return { ok: true, ids: [] };
    }
    const frozen = deepFreeze(camera);
    if (!this.applyCamera(frozen)) return failure('editor.invalid-camera');
    this.viewport = frozen;
    this.refresh({ type: 'session', field: 'viewport' });
    return { ok: true, ids: [] };
  }

  private beginGesture(): boolean {
    if (this.gestureState !== null) return false;
    this.gestureState = {
      base: this.document,
      touched: new Set(),
      updated: false,
      accepted: [],
      selection: this.selection,
      pathEdit: this.pathEdit,
    };
    return true;
  }

  private updateGesture(command: DocumentCommand): CommandResult {
    const gesture = this.gestureState;
    if (gesture === null) return failure('editor.invalid-command');
    if (typeof command !== 'object' || command === null) return failure('editor.invalid-command');
    const type = (command as { type?: unknown }).type;
    if (typeof type === 'string' && RELATIVE_COMMANDS.has(type)) {
      return failure('editor.invalid-command', '/type');
    }
    // Groups refit only at commit (M1 contract, section 4.2). Its draws run on the live document.
    const live = this.document;
    const result = this.gestureStep(gesture, live, () =>
      applyEdit(live, command, { ...this.context(false), resizeBase: gesture.base }),
    );
    return this.applyGestureResult(gesture, result);
  }

  /**
   * `replace` (M2 contract, S1): the commands apply in order to the pre-gesture document, with
   * the same rules as `update` (groups refit at commit; a resized container restores its
   * subtree from the pre-gesture state); the result replaces the live document as a whole.
   */
  private replaceGesture(commands: readonly DocumentCommand[]): CommandResult {
    const gesture = this.gestureState;
    if (gesture === null) return failure('editor.invalid-command');
    if (!Array.isArray(commands)) return failure('editor.invalid-command', '/commands');
    let document = gesture.base;
    const touched = new Set<string>();
    const created: string[] = [];
    for (const [index, command] of (commands as readonly DocumentCommand[]).entries()) {
      if (typeof command !== 'object' || command === null) {
        return failure('editor.invalid-command', `/commands/${index}`);
      }
      // Each step draws on the document the steps before it made.
      const on = document;
      const result = this.gestureStep(gesture, on, () =>
        applyEdit(on, command, { ...this.context(false), resizeBase: gesture.base }),
      );
      if (!result.ok) return result;
      document = result.document;
      result.touched.forEach((id) => touched.add(id));
      created.push(...result.created);
    }
    // Nodes an earlier update or replace changed return to their pre-gesture state, so they are
    // part of this change too; the event lists the nodes that differ from the live document.
    gesture.touched.forEach((id) => touched.add(id));
    touched.forEach((id) => gesture.touched.add(id));
    gesture.updated = true;
    const previous = this.document;
    if (document !== previous) {
      const changed = [...touched].filter((id) => nodeIn(previous, id) !== nodeIn(document, id));
      this.changeDocument(document, 'gesture-update', changed);
    }
    return { ok: true, ids: created };
  }

  private editGesture(edit: GestureEdit): CommandResult {
    const gesture = this.gestureState;
    if (gesture === null) return failure('editor.invalid-command');
    const result = applyGestureEdit(
      this.document,
      gesture.base,
      edit,
      this.extensions,
      this.expansions,
      this.layout,
    );
    return this.applyGestureResult(gesture, result);
  }

  private applyGestureResult(gesture: Gesture, result: EditResult): CommandResult {
    if (!result.ok) return result;
    result.touched.forEach((id) => gesture.touched.add(id));
    gesture.updated = true;
    this.changeDocument(result.document, 'gesture-update', result.touched);
    return { ok: true, ids: result.created };
  }

  /**
   * The snap overlay of the active gesture; a value equal to the current one raises no event.
   * Outside a gesture only clearing is accepted.
   */
  private setSnap(overlay: SnapOverlay | null): void {
    if (overlay !== null && this.gestureState === null) return;
    const key = JSON.stringify(overlay);
    if (key === this.snapKey) return;
    this.snapKey = key;
    this.snap = overlay === null ? null : deepFreeze(structuredCopy(overlay));
    this.refresh({ type: 'session', field: 'snap' });
  }

  private commitGesture(): void {
    try {
      this.commitGestureState();
    } finally {
      // The overlay ends with the gesture (M2 contract, section 4.2).
      this.setSnap(null);
    }
  }

  private commitGestureState(): void {
    const gesture = this.gestureState;
    if (gesture === null) return;
    this.gestureState = null;
    // A gesture with no update (a click), or one replaced back to the pre-gesture document,
    // creates no step and no change.
    if (!gesture.updated || this.document === gesture.base) return;
    const refit = refitGesture(
      gesture.base,
      this.document,
      gesture.touched,
      this.extensions,
      this.expansions,
    );
    // A refit that fails the model's rules (binary64 overflow) leaves the live document as is.
    const after = refit.ok ? refit.document : this.document;
    // The step lists only nodes that differ between the pre-gesture and committed documents,
    // added or removed ones included, so an ID an earlier update touched and a later replace
    // discarded is not listed. The commit event adds the nodes the refit changed from the live
    // document, so the renderer follows every change.
    const live = this.document;
    const candidates = [...gesture.touched, ...(refit.ok ? refit.touched : [])];
    const touched = sorted(candidates.filter((id) => nodeDiffers(gesture.base, after, id)));
    const changed = sorted(
      candidates.filter(
        (id) => nodeDiffers(gesture.base, after, id) || nodeDiffers(live, after, id),
      ),
    );
    // A commit byte-identical to the pre-gesture document (a move or resize snapped back to its
    // origin) records no step; the live document returns to the pre-gesture one, and the commit
    // event, listing every node the gesture touched, lets the renderer resync (M2-U3).
    if (touched.length === 0 && samePages(gesture.base, after)) {
      if (live !== gesture.base) {
        this.changeDocument(gesture.base, 'gesture-commit', sorted(gesture.touched));
      }
      return;
    }
    // Including IDs of updates the commit discarded, which errs on the safe side.
    const drawn = this.unlink([...new Set(gesture.accepted)]);
    this.undoStack.push({ before: gesture.base, after, touched, drawn });
    this.redoStack = [];
    this.changeDocument(after, 'gesture-commit', changed);
  }

  /**
   * Ends any drag before a command that replaces its base, and tells the active tool, so its
   * drag or overlay state does not outlive the change. `always` resets the tool even without a
   * drag (load and tool switches drop overlay state).
   */
  private interrupt(always = false): void {
    const active = this.gestureState !== null;
    this.cancelGesture();
    if (active || always) this.tools.get(this.tool)?.reset();
  }

  /**
   * Restores the pre-gesture document and the selection recorded at `begin`, filtered to nodes
   * of the active page (M2 contract, section 2).
   */
  private cancelGesture(): void {
    const gesture = this.gestureState;
    if (gesture === null) return;
    this.gestureState = null;
    if (gesture.updated && this.document !== gesture.base) {
      this.changeDocument(gesture.base, 'gesture-cancel', gesture.touched);
    }
    const tree = documentTree(this.document);
    const kept = gesture.selection.filter((id) => pageOf(tree, id) === this.activePage);
    this.setSelectionState(normalizeSelection(this.document, this.activePage, kept) ?? []);
    // The anchor selection recorded at `begin` comes back while the same path is in edit mode
    // (M3 contract, section 4).
    if (gesture.pathEdit !== null && this.pathEdit?.id === gesture.pathEdit.id) {
      this.setPathEditState(gesture.pathEdit);
    }
    this.setSnap(null);
  }

  private changeDocument(
    document: DocumentV6,
    cause: DocumentChangeCause,
    touched: Iterable<string>,
  ): void {
    const previous = this.document;
    this.document = document;
    this.revision += 1;
    const ids = sorted(touched);
    // A load activates the first page; removing or undoing away the active page activates the
    // page now at its index, else the last one (M1 contract, section 3).
    const index = previous.pages.findIndex((page) => page.id === this.activePage);
    const page =
      cause === 'load'
        ? document.pages[0]!.id
        : document.pages.some((entry) => entry.id === this.activePage)
          ? this.activePage
          : document.pages[Math.min(index, document.pages.length - 1)]!.id;
    const pageChanged = page !== this.activePage;
    let selectionChanged: boolean;
    // A load clears the scope; so does deleting or undoing away the scoped node (section 5).
    const scope = this.scope;
    const scopeChanged =
      scope !== null &&
      (cause === 'load' || pageChanged || pageOf(documentTree(document), scope) !== page);
    if (scopeChanged) this.scope = null;
    if (pageChanged) {
      selectionChanged = this.selection.length > 0;
      // A load has already reset the tool (interrupt), so it is reset once.
      this.switchPage(page, cause !== 'load');
    } else {
      // Deleting or undoing away a selected node removes it from the selection, and a node
      // whose ancestor is selected too gives way to it.
      const kept = this.selection.filter(
        (id) => Object.hasOwn(document.nodes, id) && pageOf(documentTree(document), id) === page,
      );
      const normalized = normalizeSelection(document, page, kept) ?? [];
      selectionChanged = normalized.length !== this.selection.length;
      if (selectionChanged) this.selection = Object.freeze(normalized);
    }
    // The renderer follows before any listener runs; its diagnostics follow the change event.
    const diagnostics: EditorEvent[] = [];
    this.withProjector((projector) => {
      if (cause === 'load' || pageChanged) projector.replace(document, page, ids);
      else projector.change(document, page, ids);
    }, diagnostics);
    this.refresh({ type: 'document', cause, revision: this.revision, touched: ids });
    if (selectionChanged) this.emit({ type: 'session', field: 'selection' });
    if (pageChanged) this.emit({ type: 'session', field: 'activePage' });
    if (scopeChanged) this.emit({ type: 'session', field: 'scope' });
    diagnostics.forEach((event) => this.emit(event));
    this.syncPathEdit(cause === 'load' ? null : previous);
  }

  /**
   * Activates `page`: the selection and the scope are cleared and the active tool reset (it
   * stays selected). The caller raises the events and updates the renderer.
   */
  private switchPage(page: string, reset = true): void {
    this.activePage = page;
    this.selection = Object.freeze([]);
    this.scope = null;
    if (reset) this.tools.get(this.tool)?.reset();
  }

  /** Runs `action` on the attached projector, collecting its diagnostics into `into`. */
  private withProjector(action: (projector: SceneProjector) => void, into: EditorEvent[]): void {
    const projector = this.projector;
    if (projector === null) return;
    this.reportTo = into;
    try {
      action(projector);
    } finally {
      this.reportTo = null;
    }
    if (!projector.active && this.projector === projector) {
      this.projector = null;
      this.renderer = null;
    }
  }

  private setSelectionState(ids: readonly string[]): void {
    const same =
      ids.length === this.selection.length && ids.every((id, i) => id === this.selection[i]);
    if (same) return;
    this.selection = Object.freeze([...ids]);
    this.refresh({ type: 'session', field: 'selection' });
    // A selection other than `[id]` ends path edit mode.
    this.syncPathEdit();
  }

  /** A scope equal to the current one raises no event (section 2); another one ends edit mode. */
  private setScopeState(scope: string | null): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.refresh({ type: 'session', field: 'scope' });
    if (this.pathEdit !== null) {
      this.scopeExit = this.pathEdit.id;
      if (!this.holding) this.syncPathEdit();
    }
  }

  /** A path edit state equal to the current one raises no event (M3 contract, section 4). */
  private setPathEditState(next: PathEditState | null): void {
    const current = this.pathEdit;
    const same =
      next === null || current === null
        ? next === current
        : next.id === current.id &&
          next.anchors.length === current.anchors.length &&
          next.anchors.every(
            (ref, i) =>
              ref.subpath === current.anchors[i]!.subpath &&
              ref.anchor === current.anchors[i]!.anchor,
          );
    if (next === null) this.scopeExit = null;
    if (same) return;
    this.pathEdit =
      next === null
        ? null
        : deepFreeze({ id: next.id, anchors: next.anchors.map((r) => ({ ...r })) });
    this.refresh({ type: 'session', field: 'pathEdit' });
  }

  /**
   * Ends path edit mode when its rules no longer hold (M3 contract, section 4): the tool is not
   * `select`, the selection is not `[id]`, the scope changed, or the node is no longer a `path`
   * of the active page.
   * After a document change from `previous` (null for a load, which always ends it), the anchor
   * selection is kept when the path's structure is unchanged, else cleared.
   */
  private syncPathEdit(previous?: DocumentV6 | null): void {
    const edit = this.pathEdit;
    if (edit === null) return;
    const node = editablePath(this.document, this.activePage, edit.id);
    const kept =
      previous !== null &&
      this.scopeExit !== edit.id &&
      node !== undefined &&
      this.tool === 'select' &&
      this.selection.length === 1 &&
      this.selection[0] === edit.id;
    if (!kept) {
      this.setPathEditState(null);
      return;
    }
    if (previous === undefined || edit.anchors.length === 0) return;
    const before = nodeIn(previous, edit.id);
    if (before?.type !== 'path' || !sameStructure(before.path, node.path)) {
      this.setPathEditState({ id: edit.id, anchors: [] });
    }
  }

  /** Tool overlays change without a document change; hosts learn of it through the snapshot. */
  private refreshOverlay(): void {
    const overlay = this.tools.get(this.tool)?.overlay() ?? null;
    const key = JSON.stringify(overlay);
    if (key === this.overlayKey) return;
    this.overlayKey = key;
    this.overlay = overlay;
    this.refresh({ type: 'session', field: 'overlay' });
  }

  private buildSnapshot(): EditorSnapshot {
    return deepFreeze({
      overlay: this.overlay,
      document: this.document,
      activePage: this.activePage,
      revision: this.revision,
      selection: this.selection,
      tool: this.tool,
      viewport: this.viewport,
      viewportSize: this.viewportSize,
      keymap: this.keymap,
      snap: this.snap,
      snapping: this.snapping,
      scope: this.scope,
      pathEdit: this.pathEdit,
      history: { undoDepth: this.undoStack.length, redoDepth: this.redoStack.length },
    });
  }

  private refresh(event: EditorEvent): void {
    this.snapshot = this.buildSnapshot();
    this.emit(event);
  }

  private emit(event: EditorEvent): void {
    this.pending.push(event);
    if (!this.holding) this.flush();
  }

  /**
   * Delivers events in the order the changes happened: an event raised by a listener waits until
   * every listener has seen the current one, so the snapshot a listener reads may already be
   * newer than its event. A listener that throws does not stop delivery; its error is rethrown
   * as a rejected promise, after the change has been committed.
   */
  private flush(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let next = this.pending.shift(); next !== undefined; next = this.pending.shift()) {
        for (const listener of [...this.listeners]) {
          try {
            listener(next);
          } catch (error) {
            void Promise.resolve().then(() => {
              throw error;
            });
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

export function createEditor(options: EditorOptions = {}): Editor {
  return new EditorCore(options);
}

/** Package-internal access for tools (P5-U3) and tests; not exported from the package. */
export function internalsOf(
  editor: Editor,
): Pick<EditorCore, 'tools' | 'gesture' | 'expansions' | 'clipboardGeneration' | 'textLayouts'> {
  if (!(editor instanceof EditorCore)) throw new Error('not an editor-core editor');
  return editor;
}
