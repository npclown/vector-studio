import type { RenderCamera, RendererSceneSynchronization } from '@vector-studio/contracts';
import {
  DOCUMENT_ERROR_CODES,
  validateAnyDocument,
  type DocumentV2,
  type ParseResult,
} from '@vector-studio/model';
import {
  applyEdit,
  applyGestureEdit,
  deepFreeze,
  refitGesture,
  type EditResult,
  type GestureEdit,
} from './edits.js';
import { ExtensionRegistry, extensionApi } from './extensions.js';
import { boundsOf } from './hit-test.js';
import { createCounterIdSource } from './ids.js';
import {
  DEFAULT_KEYMAP,
  TOOL_NAMES,
  effectiveKeymap,
  eventChord,
  isSpaceKey,
  validateLayer,
  type CanonicalBinding,
} from './keymap.js';
import { SceneProjector } from './projector.js';
import {
  createBoxTool,
  createLineTool,
  createPathTool,
  createSelectTool,
  selectionHandles,
} from './tools.js';
import {
  ancestors,
  documentClipViolation,
  documentTree,
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
  Platform,
  Query,
  QueryResult,
  ReorderOp,
  SnapOverlay,
  ToolName,
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
  before: DocumentV2;
  after: DocumentV2;
  touched: readonly string[];
}>;

type Gesture = {
  base: DocumentV2;
  touched: Set<string>;
  updated: boolean;
  /** The selection when the gesture began, restored on cancel (M2 contract, section 2). */
  selection: readonly string[];
};

const TOOLS: readonly ToolName[] = TOOL_NAMES;
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
  'editor.invalid-keymap',
]);

/**
 * A frozen copy of an extension command's result, or null when it is not a `CommandResult`
 * with a known code and, on success, IDs of nodes in `document`.
 */
function extensionResult(value: unknown, document: DocumentV2): CommandResult | null {
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

function nodeIn(document: DocumentV2, id: string) {
  return Object.hasOwn(document.nodes, id) ? document.nodes[id] : undefined;
}

/** Whether node `id` differs between two documents; a node in only one of them differs. */
function nodeDiffers(a: DocumentV2, b: DocumentV2, id: string): boolean {
  const x = nodeIn(a, id);
  const y = nodeIn(b, id);
  if (x === y) return false;
  return x === undefined || y === undefined || JSON.stringify(x) !== JSON.stringify(y);
}

/** Whether two documents have the same pages, children orders included. */
function samePages(a: DocumentV2, b: DocumentV2): boolean {
  return a.pages === b.pages || JSON.stringify(a.pages) === JSON.stringify(b.pages);
}

function sorted(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Validated by the caller like any initial document, so a bad ID source fails at creation. */
function emptyDocument(ids: IdSource): DocumentV2 {
  return {
    schemaVersion: 2,
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
  document: DocumentV2,
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
  private document: DocumentV2;
  private activePage: string;
  private revision = 0;
  private selection: readonly string[] = Object.freeze([]);
  private tool: ToolName = 'select';
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
  private extensionDepth = 0;
  private readonly ids: IdSource;
  private readonly extensions: ExtensionRegistry;
  readonly tools = new Map<ToolName, Tool>();
  readonly gesture: GestureControl;
  /** What extension commands receive: `execute` and `query`, nothing else. */
  private readonly api = extensionApi({
    execute: (command) => this.execute(command),
    query: (query) => this.query(query),
  });

  constructor(options: EditorOptions) {
    this.ids = options.ids ?? createCounterIdSource('node-');
    this.extensions = new ExtensionRegistry(options.extensions ?? []);
    const platform: unknown = options.platform ?? 'other';
    if (platform !== 'mac' && platform !== 'other') {
      throw new Error(`createEditor: invalid platform ${String(platform)}`);
    }
    this.platform = platform;
    this.fixedLayers = this.extensionLayers(options.extensions ?? []);
    const host = validateLayer(options.keymap ?? [], platform, (id) => this.isCommand(id));
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
      createSelectTool((node) => this.extensions.geometry(node)),
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
      const own = (command: string) =>
        (command === id || command.startsWith(`${id}.`)) && this.isCommand(command);
      const layer = validateLayer(bindings, this.platform, own);
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
      const result = applyEdit(base, command as DocumentCommand, this.context(true));
      if (!result.ok) return result;
      // A relative command that changes nothing records no step and no event (M2 section 4).
      if (result.document === base) return { ok: true, ids: [] };
      this.interrupt();
      const entry = { before: base, after: result.document, touched: result.touched };
      this.undoStack.push(entry);
      this.redoStack = [];
      this.changeDocument(result.document, 'command', result.touched);
      return { ok: true, ids: result.created };
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
        // Like setTool, it first cancels an active gesture (M1 contract, section 3).
        this.interrupt();
        if (command.id !== this.activePage) {
          const hadSelection = this.selection.length > 0;
          this.switchPage(command.id);
          // A new page is a new scene identity: the renderer gets a full snapshot.
          const diagnostics: EditorEvent[] = [];
          this.withProjector(
            (projector) => projector.replace(this.document, this.activePage),
            diagnostics,
          );
          this.refresh({ type: 'session', field: 'activePage' });
          if (hadSelection) this.emit({ type: 'session', field: 'selection' });
          diagnostics.forEach((event) => this.emit(event));
        }
        return { ok: true, ids: [] };
      }
      case 'setTool': {
        if (!TOOLS.includes(command.tool)) return failure('editor.unknown-tool');
        this.interrupt(true);
        if (command.tool !== this.tool) {
          this.tool = command.tool;
          this.refresh({ type: 'session', field: 'tool' });
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
        const layer = validateLayer(command.bindings, this.platform, (id) => this.isCommand(id));
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
   * wherever it is nested (plan section 3.3), then the clip depth (M1 contract, section 4.3).
   */
  private validate(value: unknown): ParseResult | CommandFailure {
    const result = validateAnyDocument(value);
    if (!result.ok) return result;
    // Frozen before any extension sees it, so `validate` cannot change what is stored.
    const rejected = this.extensions.checkDocument(deepFreeze(result.document));
    if (rejected !== null) return { ok: false, ...rejected };
    const deep = documentClipViolation(result.document);
    return deep === null
      ? result
      : { ok: false, code: 'editor.clip-depth', path: nodePath(deep, '/parent') };
  }

  private context(refit: boolean) {
    return { ids: this.ids, custom: this.extensions, activePage: this.activePage, refit };
  }

  query<Q extends Query>(query: Q): QueryResult<Q> {
    const value = ((): unknown => {
      switch (query.type) {
        case 'document':
          return this.document;
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
          return selectionHandles(this.document, this.activePage, this.selection);
        case 'viewportSize':
          return this.viewportSize;
        case 'keymap':
          return this.keymap;
        case 'snap':
          return this.snap;
        case 'snapping':
          return this.snapping;
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
    return { ...this.runAction(binding), consumed: true };
  }

  /**
   * A bound action (M2 contract, section 7). Selection actions run their command on the current
   * selection and do nothing on an empty one; any other action is an extension command.
   */
  private runAction(binding: CanonicalBinding): CommandResult {
    const nothing: CommandResult = { ok: true, ids: [] };
    const selection = this.selection;
    switch (binding.action) {
      case 'setTool':
        return this.run({
          type: 'setTool',
          tool: (binding.args as { tool: ToolName }).tool,
        });
      case 'undo':
        return this.run({ type: 'undo' });
      case 'redo':
        return this.run({ type: 'redo' });
      case 'delete':
        return selection.length === 0 ? nothing : this.run({ type: 'deleteNodes', ids: selection });
      case 'selectAll': {
        const page = this.document.pages.find((entry) => entry.id === this.activePage)!;
        return this.run({ type: 'setSelection', ids: page.children });
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
      default: {
        const command = { type: 'runCommand', id: binding.action! } as const;
        return this.run(binding.args === undefined ? command : { ...command, args: binding.args });
      }
    }
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
      selection: this.selection,
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
    // Groups refit only at commit (M1 contract, section 4.2).
    const result = applyEdit(this.document, command, {
      ...this.context(false),
      resizeBase: gesture.base,
    });
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
      const result = applyEdit(document, command, {
        ...this.context(false),
        resizeBase: gesture.base,
      });
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
    const result = applyGestureEdit(this.document, gesture.base, edit, this.extensions);
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
    const refit = refitGesture(gesture.base, this.document, gesture.touched, this.extensions);
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
    this.undoStack.push({ before: gesture.base, after, touched });
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
    this.setSnap(null);
  }

  private changeDocument(
    document: DocumentV2,
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
    if (pageChanged) {
      selectionChanged = this.selection.length > 0;
      this.switchPage(page);
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
    diagnostics.forEach((event) => this.emit(event));
  }

  /**
   * Activates `page`: the selection is cleared and the active tool reset (it stays selected).
   * The caller raises the events and updates the renderer.
   */
  private switchPage(page: string): void {
    this.activePage = page;
    this.selection = Object.freeze([]);
    this.tools.get(this.tool)?.reset();
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
export function internalsOf(editor: Editor): Pick<EditorCore, 'tools' | 'gesture'> {
  if (!(editor instanceof EditorCore)) throw new Error('not an editor-core editor');
  return editor;
}
