import type { RenderCamera, RendererSceneSynchronization } from '@vector-studio/contracts';
import { DOCUMENT_ERROR_CODES, validateDocument, type DocumentV1 } from '@vector-studio/model';
import { applyEdit, deepFreeze } from './edits.js';
import { ExtensionRegistry, extensionApi } from './extensions.js';
import { createCounterIdSource } from './ids.js';
import { SceneProjector } from './projector.js';
import { createPathTool, createRectangleTool, createSelectTool } from './tools.js';
import type {
  Command,
  CommandResult,
  DocumentChangeCause,
  DocumentCommand,
  Editor,
  EditorErrorCode,
  EditorEvent,
  EditorSnapshot,
  Extension,
  IdSource,
  InputEvent,
  Query,
  QueryResult,
  ToolName,
  ToolOverlay,
} from './types.js';

// Editor core (P5 plan, section 4): commands, transactions, history, gestures and session.

export type EditorOptions = Readonly<{
  /** A document value; it is validated like `loadDocument`. Defaults to an empty document. */
  document?: unknown;
  /** Defaults to a counter, `node-1`, `node-2`, ... */
  ids?: IdSource;
  /** Registered once; a malformed or conflicting registration throws (P5 plan, section 5). */
  extensions?: readonly Extension[];
}>;

/** A tool receives input and acts only through the editor's commands and the gesture API. */
export interface Tool {
  input(event: InputEvent, context: ToolContext): void;
  /** Drops drag and overlay state, for example when the tool is switched away. Must issue no command. */
  reset(): void;
  overlay(): ToolOverlay | null;
}

export interface ToolContext {
  execute(command: Command): CommandResult;
  query<Q extends Query>(query: Q): QueryResult<Q>;
  gesture: GestureControl;
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
  update(command: DocumentCommand): CommandResult;
  commit(): void;
  cancel(): void;
}

type HistoryEntry = Readonly<{
  before: DocumentV1;
  after: DocumentV1;
  touched: readonly string[];
}>;

type Gesture = { base: DocumentV1; touched: Set<string>; updated: boolean };

const TOOLS: readonly ToolName[] = ['select', 'rectangle', 'path'];
const DEFAULT_VIEWPORT: RenderCamera = deepFreeze({ position: { x: 0, y: 0 }, zoom: 1 });
const DOCUMENT_COMMANDS = new Set([
  'createRectangle',
  'createPath',
  'createCustomNode',
  'setFrames',
  'setNodeProps',
  'deleteNodes',
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
]);

/**
 * A frozen copy of an extension command's result, or null when it is not a `CommandResult`
 * with a known code and, on success, IDs of nodes in `document`.
 */
function extensionResult(value: unknown, document: DocumentV1): CommandResult | null {
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

function isInputEvent(value: unknown): value is InputEvent {
  const event = value as InputEvent | null;
  if (typeof event !== 'object' || event === null) return false;
  const modifiers = event.modifiers as Record<string, unknown> | null;
  if (
    typeof modifiers !== 'object' ||
    modifiers === null ||
    !['shift', 'alt', 'meta', 'ctrl'].every((key) => typeof modifiers[key] === 'boolean')
  ) {
    return false;
  }
  if (event.kind === 'keydown') return typeof event.key === 'string';
  return (
    (event.kind === 'pointerdown' || event.kind === 'pointermove' || event.kind === 'pointerup') &&
    Number.isFinite(event.point?.x) &&
    Number.isFinite(event.point?.y)
  );
}

function copyInput(event: InputEvent): InputEvent {
  const { shift, alt, meta, ctrl } = event.modifiers;
  const modifiers = { shift, alt, meta, ctrl };
  return deepFreeze(
    event.kind === 'keydown'
      ? { kind: event.kind, key: event.key, modifiers }
      : { kind: event.kind, point: { x: event.point.x, y: event.point.y }, modifiers },
  );
}

function sorted(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Validated by the caller like any initial document, so a bad ID source fails at creation. */
function emptyDocument(ids: IdSource): DocumentV1 {
  return {
    schemaVersion: 1,
    id: ids(),
    pages: [{ id: ids(), name: 'Page 1', children: [] }],
    nodes: {},
  };
}

class EditorCore implements Editor {
  private document: DocumentV1;
  private revision = 0;
  private selection: readonly string[] = Object.freeze([]);
  private tool: ToolName = 'select';
  private viewport: RenderCamera = DEFAULT_VIEWPORT;
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
    const result = this.validate(
      options.document === undefined ? emptyDocument(this.ids) : options.document,
    );
    if (!result.ok) throw new Error(`createEditor: ${result.code} at ${result.path}`);
    this.document = deepFreeze(result.document);
    this.snapshot = this.buildSnapshot();
    this.tools.set(
      'select',
      createSelectTool((node) => this.extensions.geometry(node)),
    );
    this.tools.set('rectangle', createRectangleTool());
    this.tools.set('path', createPathTool());
    const isActive = () => this.gestureState !== null;
    this.gesture = {
      get active() {
        return isActive();
      },
      begin: () => this.beginGesture(),
      update: (command) => this.updateGesture(command),
      commit: () => this.commitGesture(),
      cancel: () => this.cancelGesture(),
    };
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
      const result = applyEdit(base, command as DocumentCommand, this.ids, this.extensions);
      if (!result.ok) return result;
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
        const ids = [...new Set(command.ids)];
        if (ids.some((id) => typeof id !== 'string' || !Object.hasOwn(this.document.nodes, id))) {
          return failure('editor.unknown-node');
        }
        this.setSelectionState(ids);
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
        const event = copyInput(command.event);
        this.tools.get(this.tool)?.input(event, {
          execute: (next) => this.execute(next),
          query: (query) => this.query(query),
          gesture: this.gesture,
        });
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

  /** The model's rules, then each custom node against its extension (plan section 3.3). */
  private validate(value: unknown): ReturnType<typeof validateDocument> | CommandFailure {
    const result = validateDocument(value);
    if (!result.ok) return result;
    // Frozen before any extension sees it, so `validate` cannot change what is stored.
    const rejected = this.extensions.checkDocument(deepFreeze(result.document));
    return rejected === null ? result : { ok: false, ...rejected };
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
    this.withProjector((attached) => attached.replace(this.document), diagnostics);
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

  private beginGesture(): boolean {
    if (this.gestureState !== null) return false;
    this.gestureState = { base: this.document, touched: new Set(), updated: false };
    return true;
  }

  private updateGesture(command: DocumentCommand): CommandResult {
    const gesture = this.gestureState;
    if (gesture === null) return failure('editor.invalid-command');
    const result = applyEdit(this.document, command, this.ids, this.extensions);
    if (!result.ok) return result;
    result.touched.forEach((id) => gesture.touched.add(id));
    gesture.updated = true;
    this.changeDocument(result.document, 'gesture-update', result.touched);
    return { ok: true, ids: result.created };
  }

  private commitGesture(): void {
    const gesture = this.gestureState;
    if (gesture === null) return;
    this.gestureState = null;
    // A gesture with no update (a click) creates no step and no change.
    if (!gesture.updated) return;
    const touched = sorted(gesture.touched);
    this.undoStack.push({ before: gesture.base, after: this.document, touched });
    this.redoStack = [];
    this.changeDocument(this.document, 'gesture-commit', touched);
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

  private cancelGesture(): void {
    const gesture = this.gestureState;
    if (gesture === null) return;
    this.gestureState = null;
    if (gesture.updated) this.changeDocument(gesture.base, 'gesture-cancel', gesture.touched);
  }

  private changeDocument(
    document: DocumentV1,
    cause: DocumentChangeCause,
    touched: Iterable<string>,
  ): void {
    this.document = document;
    this.revision += 1;
    const ids = sorted(touched);
    // The renderer follows before any listener runs; its diagnostics follow the change event.
    const diagnostics: EditorEvent[] = [];
    this.withProjector((projector) => {
      if (cause === 'load') projector.replace(document);
      else projector.change(document, ids);
    }, diagnostics);
    // Deleting or undoing away a selected node removes it from the selection.
    const kept = this.selection.filter((id) => Object.hasOwn(document.nodes, id));
    const selectionChanged = kept.length !== this.selection.length;
    if (selectionChanged) this.selection = Object.freeze(kept);
    this.refresh({ type: 'document', cause, revision: this.revision, touched: ids });
    if (selectionChanged) this.emit({ type: 'session', field: 'selection' });
    diagnostics.forEach((event) => this.emit(event));
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

  private buildSnapshot(): EditorSnapshot {
    return deepFreeze({
      document: this.document,
      revision: this.revision,
      selection: this.selection,
      tool: this.tool,
      viewport: this.viewport,
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
