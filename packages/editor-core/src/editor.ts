import type { RenderCamera } from '@vector-studio/contracts';
import { validateDocument, type DocumentV1 } from '@vector-studio/model';
import { applyEdit } from './edits.js';
import { createCounterIdSource } from './ids.js';
import type {
  Command,
  CommandResult,
  DocumentChangeCause,
  DocumentCommand,
  Editor,
  EditorErrorCode,
  EditorEvent,
  EditorSnapshot,
  IdSource,
  InputEvent,
  Query,
  QueryResult,
  ToolName,
} from './types.js';

// Editor core (P5 plan, section 4): commands, transactions, history, gestures and session.

export type EditorOptions = Readonly<{
  /** A document value; it is validated like `loadDocument`. Defaults to an empty document. */
  document?: unknown;
  /** Defaults to a counter, `node-1`, `node-2`, ... */
  ids?: IdSource;
}>;

/** A tool receives input and acts only through the editor's commands and the gesture API. */
export interface Tool {
  input(event: InputEvent, context: ToolContext): void;
  /** Drops overlay state, for example when the tool is switched away. */
  reset(): void;
}

export interface ToolContext {
  execute(command: Command): CommandResult;
  query<Q extends Query>(query: Q): QueryResult<Q>;
  gesture: GestureControl;
}

/**
 * A pointer drag (plan section 4.2). Updates change the live document without history; commit
 * records one undo step from the pre-gesture state; cancel restores that state.
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
const DEFAULT_VIEWPORT: RenderCamera = { position: { x: 0, y: 0 }, zoom: 1 };
const DOCUMENT_COMMANDS = new Set([
  'createRectangle',
  'createPath',
  'setFrames',
  'setNodeProps',
  'deleteNodes',
]);

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
  if (typeof event !== 'object' || event === null || typeof event.modifiers !== 'object') {
    return false;
  }
  if (event.kind === 'keydown') return typeof event.key === 'string';
  return (
    (event.kind === 'pointerdown' || event.kind === 'pointermove' || event.kind === 'pointerup') &&
    Number.isFinite(event.point?.x) &&
    Number.isFinite(event.point?.y)
  );
}

function sorted(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

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
  private selection: readonly string[] = [];
  private tool: ToolName = 'select';
  private viewport: RenderCamera = DEFAULT_VIEWPORT;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private gestureState: Gesture | null = null;
  private snapshot: EditorSnapshot;
  private readonly listeners = new Set<(event: EditorEvent) => void>();
  private readonly ids: IdSource;
  readonly tools = new Map<ToolName, Tool>();
  readonly gesture: GestureControl;

  constructor(options: EditorOptions) {
    this.ids = options.ids ?? createCounterIdSource('node-');
    if (options.document === undefined) {
      this.document = emptyDocument(this.ids);
    } else {
      const result = validateDocument(options.document);
      if (!result.ok) throw new Error(`createEditor: ${result.code} at ${result.path}`);
      this.document = result.document;
    }
    this.snapshot = this.buildSnapshot();
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

  execute(command: Command): CommandResult {
    if (typeof command !== 'object' || command === null) return failure('editor.invalid-command');
    if (DOCUMENT_COMMANDS.has(command.type)) {
      // A host command during a drag would leave the gesture's base stale, so it cancels first.
      this.cancelGesture();
      const result = applyEdit(this.document, command as DocumentCommand, this.ids);
      if (!result.ok) return result;
      const entry = { before: this.document, after: result.document, touched: result.touched };
      this.undoStack.push(entry);
      this.redoStack = [];
      this.changeDocument(result.document, 'command', result.touched);
      return { ok: true, ids: result.created };
    }
    switch (command.type) {
      case 'undo':
      case 'redo': {
        this.cancelGesture();
        const from = command.type === 'undo' ? this.undoStack : this.redoStack;
        const to = command.type === 'undo' ? this.redoStack : this.undoStack;
        const entry = from.pop();
        if (entry === undefined) {
          return failure(
            command.type === 'undo' ? 'editor.nothing-to-undo' : 'editor.nothing-to-redo',
          );
        }
        to.push(entry);
        const target = command.type === 'undo' ? entry.before : entry.after;
        this.changeDocument(target, command.type, entry.touched);
        return { ok: true, ids: [] };
      }
      case 'loadDocument': {
        const result = validateDocument(command.document);
        if (!result.ok) return failure(result.code, result.path);
        this.cancelGesture();
        const touched = [
          ...Object.keys(this.document.nodes),
          ...Object.keys(result.document.nodes),
        ];
        this.undoStack = [];
        this.redoStack = [];
        this.changeDocument(result.document, 'load', touched);
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
        this.cancelGesture();
        if (command.tool !== this.tool) {
          this.tools.get(this.tool)?.reset();
          this.tool = command.tool;
          this.refresh({ type: 'session', field: 'tool' });
        }
        return { ok: true, ids: [] };
      }
      case 'setViewport': {
        if (!isCamera(command.camera)) return failure('editor.invalid-camera');
        const { position, zoom } = command.camera;
        this.viewport = { position: { x: position.x, y: position.y }, zoom };
        this.refresh({ type: 'session', field: 'viewport' });
        return { ok: true, ids: [] };
      }
      case 'input': {
        if (!isInputEvent(command.event)) return failure('editor.invalid-command', '/event');
        this.tools.get(this.tool)?.input(command.event, {
          execute: (next) => this.execute(next),
          query: (query) => this.query(query),
          gesture: this.gesture,
        });
        return { ok: true, ids: [] };
      }
      default:
        return failure('editor.invalid-command', '/type');
    }
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

  private beginGesture(): boolean {
    if (this.gestureState !== null) return false;
    this.gestureState = { base: this.document, touched: new Set(), updated: false };
    return true;
  }

  private updateGesture(command: DocumentCommand): CommandResult {
    const gesture = this.gestureState;
    if (gesture === null) return failure('editor.invalid-command');
    const result = applyEdit(this.document, command, this.ids);
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
    // Deleting or undoing away a selected node removes it from the selection.
    const kept = this.selection.filter((id) => Object.hasOwn(document.nodes, id));
    const selectionChanged = kept.length !== this.selection.length;
    if (selectionChanged) this.selection = kept;
    this.refresh({ type: 'document', cause, revision: this.revision, touched: sorted(touched) });
    if (selectionChanged) this.emit({ type: 'session', field: 'selection' });
  }

  private setSelectionState(ids: readonly string[]): void {
    const same =
      ids.length === this.selection.length && ids.every((id, i) => id === this.selection[i]);
    if (same) return;
    this.selection = ids;
    this.refresh({ type: 'session', field: 'selection' });
  }

  private buildSnapshot(): EditorSnapshot {
    return {
      document: this.document,
      revision: this.revision,
      selection: this.selection,
      tool: this.tool,
      viewport: this.viewport,
      history: { undoDepth: this.undoStack.length, redoDepth: this.redoStack.length },
    };
  }

  private refresh(event: EditorEvent): void {
    this.snapshot = this.buildSnapshot();
    this.emit(event);
  }

  private emit(event: EditorEvent): void {
    for (const listener of [...this.listeners]) listener(event);
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
