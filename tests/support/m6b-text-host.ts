import type { Color, DocumentV6, Frame, TextRun } from '@vector-studio/model';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type CommandResult,
  type Editor,
} from '../../packages/editor-core/src/index.js';
import {
  CanvasInput,
  attachCanvasListeners,
  type ClipboardWriter,
  type KeyLike,
  type ListenerTarget,
  type PointerLike,
} from '../../packages/react/src/canvas-input.js';
import { TextInputHost, type TextareaLike } from '../../packages/react/src/text-input.js';
import { createFakeTextLayout } from './fake-text-layout.js';

// MVP M6b-U7 (docs/plans/mvp-m6b-text-editing-contract.md, section 6): a fake DOM for
// `EditorCanvas`'s hidden textarea host. The canvas, the textarea, a panel input and the window
// record their listeners; `focus()` and `blur()` move a fake `document.activeElement` and fire
// `blur` with its `relatedTarget` the way a browser does (synchronously, the active element
// already left during the handler). The host is wired exactly as the component wires it
// (`attachCanvasListeners` with the textarea, `TextInputHost.attach`), with M6b-H4's posted
// message as a queue the test flushes.

const START = { horizontal: 'start', vertical: 'start' } as const;
const black: Color = { r: 0, g: 0, b: 0, a: 1 };
const f = (x: number, y: number, width: number, height: number): Frame => ({ x, y, width, height });

type Loose = Record<string, unknown> & { id: string };

function base(id: string, frame: Frame, rotation = 0) {
  return {
    id,
    name: id,
    parent: 'p1',
    frame,
    rotation,
    constraints: START,
    opacity: 1,
    visible: true,
  };
}

function text(id: string, frame: Frame, runs: TextRun[], rotation = 0): Loose {
  return {
    ...base(id, frame, rotation),
    type: 'text',
    runs,
    sizing: 'autoWidth',
    align: 'left',
    letterSpacing: 0,
    lineHeight: 1.2,
  };
}

const run = (value: string, size = 10): TextRun => ({
  text: value,
  family: 'Test',
  size,
  color: black,
});

/**
 * Page `p1`: `t` "ab cd" at (10, 20) (size 10: a to z 5 wide, a space 2.5, Hangul 10 on the
 * fake port), `rot` "ab" rotated a quarter turn (π / 2) at (200, 300), and a rectangle `r` at (400, 400).
 */
export function textHostDocument(): DocumentV6 {
  const nodes: Loose[] = [
    text('t', f(10, 20, 22.5, 12), [run('ab cd')]),
    text('rot', f(200, 300, 10, 12), [run('ab')], Math.PI / 2),
    {
      ...base('r', f(400, 400, 10, 10)),
      type: 'rectangle',
      cornerRadii: [0, 0, 0, 0],
      fill: black,
      stroke: null,
    },
  ];
  return {
    schemaVersion: 6,
    id: 'doc',
    pages: [{ id: 'p1', name: 'Page 1', children: nodes.map((node) => node.id) }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
  } as unknown as DocumentV6;
}

type Listener = (event: Event) => void;

class FakeTarget implements ListenerTarget {
  readonly listeners: { type: string; listener: Listener }[] = [];
  addEventListener(type: string, listener: Listener): void {
    this.listeners.push({ type, listener });
  }
  removeEventListener(type: string, listener: Listener): void {
    const index = this.listeners.findIndex((e) => e.type === type && e.listener === listener);
    if (index >= 0) this.listeners.splice(index, 1);
  }
  fire(type: string, event: object): void {
    for (const entry of this.listeners.filter((e) => e.type === type)) {
      entry.listener(event as Event);
    }
  }
  types(): string[] {
    return this.listeners.map((entry) => entry.type);
  }
}

export type FakeDocument = { active: unknown; hasFocus: boolean };

class FakeElement extends FakeTarget {
  focusCalls: unknown[] = [];
  constructor(
    readonly name: string,
    protected readonly doc: FakeDocument,
    protected readonly log: string[],
  ) {
    super();
  }
  focus(options?: unknown): void {
    this.focusCalls.push(options);
    this.log.push(`focus:${this.name}`);
    const previous = this.doc.active;
    if (previous === this) return;
    this.doc.active = this;
    if (previous instanceof FakeElement) previous.fire('blur', { relatedTarget: this });
  }
  /** A browser-made blur: focus moves to `next` (null: to the body). */
  browserBlur(next: FakeElement | null): void {
    if (this.doc.active !== this) return;
    this.doc.active = next;
    this.fire('blur', { relatedTarget: next });
  }
  blur(): void {
    this.log.push(`blur:${this.name}`);
    if (this.doc.active !== this) return;
    this.doc.active = null;
    this.onBlur();
    this.fire('blur', { relatedTarget: null });
  }
  protected onBlur(): void {}
}

export class FakeTextarea extends FakeElement implements TextareaLike {
  value = '';
  selection: [number, number] = [0, 0];
  readonly style = { left: '', top: '', fontSize: '', height: '' };
  /**
   * Events the browser fires synchronously inside the host's `blur()` (Chrome commits an IME
   * composition there), as `[type, data]`.
   */
  duringBlur: [string, string][] = [];
  setSelectionRange(start: number, end: number): void {
    this.selection = [start, end];
  }
  protected override onBlur(): void {
    const queued = this.duringBlur;
    this.duringBlur = [];
    for (const [type, data] of queued) {
      this.log.push(`${type}:during-blur`);
      this.fire(type, { data });
    }
  }
}

export class FakeCanvas extends FakeElement {
  readonly clientLeft = 1;
  readonly clientTop = 1;
  readonly offsetLeft = 0;
  readonly offsetTop = 0;
  readonly clientWidth = 600;
  readonly clientHeight = 400;
  captured: number[] = [];
  getBoundingClientRect() {
    return { left: 10, top: 20 };
  }
  setPointerCapture(id: number): void {
    this.captured.push(id);
  }
}

const keys = { shiftKey: false, altKey: false, metaKey: false, ctrlKey: false };

export type KeyInit = Partial<Omit<KeyLike, 'preventDefault'>> & { key: string };

export type TextHost = ReturnType<typeof textHost>;

/**
 * The host over `textHostDocument`, the fake port, a 600 × 400 viewport and the fake DOM;
 * `writer` stands in for `navigator.clipboard`.
 */
export function textHost(document: DocumentV6 = textHostDocument(), writer?: ClipboardWriter) {
  const editor: Editor = createEditor({
    document,
    ids: createCounterIdSource('n'),
    textLayout: createFakeTextLayout(),
  });
  editor.execute({ type: 'setViewportSize', width: 600, height: 400 });
  const log: string[] = [];
  const doc: FakeDocument = { active: null, hasFocus: true };
  const canvas = new FakeCanvas('canvas', doc, log);
  const textarea = new FakeTextarea('textarea', doc, log);
  const panel = new FakeElement('panel', doc, log);
  const view = new FakeTarget();
  const commands: Command[] = [];
  const execute = editor.execute.bind(editor);
  editor.execute = (command: Command): CommandResult => {
    commands.push(command);
    if (command.type === 'input') log.push(`input:${command.event.kind}`);
    else log.push(`command:${command.type}`);
    return execute(command);
  };
  const input = new CanvasInput(
    editor,
    () => 400,
    () => canvas,
    () => writer,
  );
  const host = new TextInputHost(editor, {
    textarea: () => textarea,
    canvas: () => canvas,
    documentHasFocus: () => doc.hasFocus,
    activeElement: () => doc.active,
  });
  input.text = host;
  const detachListeners = attachCanvasListeners(
    canvas,
    view,
    input,
    (node) => node === canvas || node === textarea,
    textarea,
  );
  const tasks: (() => void)[] = [];
  const detachHost = host.attach((task) => tasks.push(task));
  canvas.focus();
  log.length = 0;

  /** Runs the posted messages (M6b-H4), as the event loop does between tasks. */
  const flush = () => {
    while (tasks.length > 0) tasks.shift()!();
  };
  const key = (type: 'keydown' | 'keyup', init: KeyInit) => {
    let prevented = false;
    const event: KeyLike = {
      ...keys,
      code: '',
      repeat: false,
      isComposing: false,
      ...init,
      preventDefault: () => {
        prevented = true;
      },
    };
    if (type === 'keydown') input.keyDown(event);
    else input.keyUp(event);
    return prevented;
  };
  const beforeInput = (inputType: string, data: string | null = null, cancelable = true) => {
    let prevented = false;
    textarea.fire('beforeinput', {
      inputType,
      data,
      cancelable,
      preventDefault: () => {
        prevented = true;
      },
    });
    return prevented;
  };
  const composition = (type: string, data = '') => textarea.fire(type, { data });
  /** A primary press and release at a client point; the browser's default focuses the canvas. */
  const press = (clientX: number, clientY: number, kind: 'pointerdown' | 'pointerup') => {
    if (kind === 'pointerup') {
      input.pointerUp({ ...keys, clientX, clientY, currentTarget: canvas });
      return false;
    }
    let prevented = false;
    const event: PointerLike = {
      ...keys,
      button: 0,
      clientX,
      clientY,
      pointerId: 1,
      currentTarget: canvas,
      preventDefault: () => {
        prevented = true;
      },
    };
    input.pointerDown(event);
    if (!prevented) canvas.focus();
    return prevented;
  };
  const textOf = (id: string): string => {
    const node = editor.query({ type: 'node', id });
    if (node?.type !== 'text') throw new Error(`not a text node: ${id}`);
    return node.runs.map((r) => r.text).join('');
  };
  const focused = (): string =>
    doc.active instanceof FakeElement ? doc.active.name : String(doc.active);
  const detach = () => {
    detachHost();
    detachListeners();
  };
  return {
    editor,
    input,
    host,
    canvas,
    textarea,
    panel,
    view,
    doc,
    log,
    commands,
    tasks,
    flush,
    key,
    beforeInput,
    composition,
    press,
    textOf,
    focused,
    detach,
  };
}
