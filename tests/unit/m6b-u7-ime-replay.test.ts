import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Command } from '../../packages/editor-core/src/index.js';
import { textHost, type TextHost } from '../support/m6b-text-host.js';

// MVP M6b-U7, M6b-A10 (docs/plans/mvp-m6b-text-editing-contract.md, section 6 and appendix A):
// every trace under tests/fixtures/m6-text/ime/ replays through the host mapping (the textarea
// listeners, CanvasInput's keydown and press, M6b-H2 to H5) into its committed text, caret,
// history depth, focus and textarea value. The traces are in the M6-S0 recorder's event format
// (apps/playground/src/m6-s0-ime-recorder.ts). The driver reads:
// - `beforeMessage`: the recorder's task grouping; when it changes, the posted M6b-H4 messages
//   run first, as the event loop runs them between tasks;
// - `keydown` and `keyup` (`key`, `code`, `keyCode`, `isComposing`, `repeat`, `mods`) through
//   `CanvasInput`; `beforeinput` (`inputType`, `data`, `cancelable`) and the composition events
//   (`data`; on an update or an end, the textarea `value` the IME wrote, when given) on the
//   textarea;
// - `pointerdown` and `pointerup` on the canvas (`clientX`, `clientY`); an unprevented press
//   lets the browser's default focus the canvas;
// - `blur` on the textarea (`relatedTarget` "null", "canvas" or "#panel"; `documentHasFocus`,
//   default true; any other non-null name is a focusable host control, the panel) and on the
//   window; `focus` on the window and the textarea;
// - synthetic-only: `replay-command` (a host command, `command`), `during: "host-blur"` (the
//   browser fires the event synchronously inside the host's own `blur()`, and the replay fails
//   unless the host blurred), `expectPrevented` and `expectTextarea` (checked after the event).
// Recorder-only types (`input`, `selectionchange`, `select`, `m6s0-*`) need nothing from the
// host and are skipped.

const DIR = path.resolve(import.meta.dirname, '../fixtures/m6-text/ime');

type TraceEvent = Readonly<{
  seq: number;
  beforeMessage: number;
  type: string;
  target: string;
  key?: string;
  code?: string;
  keyCode?: number;
  isComposing?: boolean;
  repeat?: boolean;
  mods?: Readonly<{ alt: boolean; ctrl: boolean; meta: boolean; shift: boolean }>;
  inputType?: string;
  data?: string | null;
  cancelable?: boolean;
  value?: string;
  relatedTarget?: string;
  documentHasFocus?: boolean;
  clientX?: number;
  clientY?: number;
  command?: Command;
  during?: 'host-blur';
  expectPrevented?: boolean;
  expectTextarea?: string;
}>;

type Trace = Readonly<{
  kind: string;
  version: number;
  synthetic: boolean;
  source: string;
  appendixCase: number;
  title: string;
  assumes: string;
  replay: Readonly<{
    start:
      | Readonly<{ edit: string; anchor: number; focus: number }>
      | Readonly<{ pending: Readonly<{ x: number; y: number }> }>;
    expect: Readonly<{
      node: string;
      text?: string;
      anchor?: number;
      focus?: number;
      undoDepth: number;
      textEdit: boolean;
      focused: string;
      textarea: string;
    }>;
  }>;
  events: readonly TraceEvent[];
}>;

const files = readdirSync(DIR)
  .filter((name) => name.endsWith('.json'))
  .sort();
const traces = files.map(
  (name) => [name, JSON.parse(readFileSync(path.join(DIR, name), 'utf8')) as Trace] as const,
);

function start(host: TextHost, trace: Trace): readonly string[] {
  const { editor } = host;
  const at = trace.replay.start;
  if ('edit' in at) {
    expect(
      editor.execute({ type: 'enterTextEdit', id: at.edit, anchor: at.anchor, focus: at.focus }),
    ).toEqual({ ok: true, ids: [] });
  } else {
    // The text tool's click (section 3.2) at a page point, through the editor.
    const none = { shift: false, alt: false, meta: false, ctrl: false };
    expect(editor.execute({ type: 'setTool', tool: 'text' }).ok).toBe(true);
    for (const kind of ['pointerdown', 'pointerup'] as const) {
      editor.execute({ type: 'input', event: { kind, point: at.pending, modifiers: none } });
    }
    expect(editor.getSnapshot().textEdit?.pending).not.toBeNull();
  }
  expect(host.focused()).toBe('textarea');
  return editor.query({ type: 'document' }).pages[0]!.children;
}

/** Replays `trace`'s events through the host; returns the failures of the per-event checks. */
function replay(host: TextHost, trace: Trace): string[] {
  const failures: string[] = [];
  const related = (name: string | undefined) =>
    name === undefined || name === 'null' ? null : name === 'canvas' ? host.canvas : host.panel;
  let group: number | null = null;
  const events = trace.events;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.during === 'host-blur') continue;
    if (group !== null && event.beforeMessage !== group) host.flush();
    group = event.beforeMessage;
    // Events the browser fires inside the host's blur() during this one.
    let next = index + 1;
    while (next < events.length && events[next]!.during === 'host-blur') {
      host.textarea.duringBlur.push([events[next]!.type, events[next]!.data ?? '']);
      next += 1;
    }
    // The IME writes the textarea on an update or an end only; a start never does, so the
    // M6b-H4 empty (or its cancel by that start) is what `expectTextarea` sees.
    if (
      event.value !== undefined &&
      (event.type === 'compositionupdate' || event.type === 'compositionend')
    ) {
      host.textarea.value = event.value;
    }
    let prevented: boolean | null = null;
    const mods = event.mods ?? { alt: false, ctrl: false, meta: false, shift: false };
    switch (event.type) {
      case 'keydown':
      case 'keyup':
        prevented = host.key(event.type, {
          key: event.key ?? '',
          code: event.code ?? '',
          repeat: event.repeat ?? false,
          isComposing: event.isComposing ?? false,
          ...(event.keyCode === undefined ? {} : { keyCode: event.keyCode }),
          shiftKey: mods.shift,
          altKey: mods.alt,
          metaKey: mods.meta,
          ctrlKey: mods.ctrl,
        });
        break;
      case 'beforeinput':
        prevented = host.beforeInput(
          event.inputType ?? '',
          event.data ?? null,
          event.cancelable ?? false,
        );
        break;
      case 'compositionstart':
      case 'compositionupdate':
      case 'compositionend':
        host.composition(event.type, event.data ?? '');
        break;
      case 'pointerdown':
      case 'pointerup':
        prevented = host.press(event.clientX ?? 0, event.clientY ?? 0, event.type);
        break;
      case 'blur':
        if (event.target === 'window') {
          host.doc.hasFocus = false;
          host.view.fire('blur', {});
        } else {
          host.doc.hasFocus = event.documentHasFocus ?? true;
          host.textarea.browserBlur(related(event.relatedTarget));
        }
        break;
      case 'focus':
        if (event.target === 'window') host.doc.hasFocus = true;
        else host.doc.active = host.textarea;
        break;
      case 'replay-command':
        host.editor.execute(event.command!);
        break;
      default:
        break;
    }
    if (host.textarea.duringBlur.length > 0) {
      failures.push(`#${event.seq}: the host did not blur the textarea`);
      host.textarea.duringBlur = [];
    }
    if (event.expectPrevented !== undefined && prevented !== event.expectPrevented) {
      failures.push(`#${event.seq} ${event.type}: prevented ${String(prevented)}`);
    }
    if (event.expectTextarea !== undefined && host.textarea.value !== event.expectTextarea) {
      failures.push(`#${event.seq} ${event.type}: textarea ${JSON.stringify(host.textarea.value)}`);
    }
  }
  host.flush();
  return failures;
}

describe('M6b-A10 synthetic IME traces replay through the host mapping', () => {
  it('lists one trace or more for every appendix A case, each labelled synthetic', () => {
    expect(
      [...new Set(traces.map(([, trace]) => trace.appendixCase))].sort((a, b) => a - b),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const [, trace] of traces) {
      expect(trace.kind).toBe('vector-studio/m6-s0-ime-trace');
      expect(trace.version).toBe(1);
      expect(trace.synthetic).toBe(true);
      expect(trace.source).toMatch(/Hand-authored/u);
      expect(trace.assumes.length).toBeGreaterThan(0);
    }
  });

  it.each(traces)('%s', (_name, trace) => {
    const host = textHost();
    const before = start(host, trace);
    const failures = replay(host, trace);
    expect(failures).toEqual([]);
    const { editor } = host;
    const want = trace.replay.expect;
    const state = editor.getSnapshot().textEdit;
    const children = editor.query({ type: 'document' }).pages[0]!.children;
    let id: string;
    if (want.node === 'pending') {
      expect(state?.pending).not.toBeNull();
      expect(state?.id).toBeNull();
      expect(children).toEqual(before);
    } else {
      id = want.node === 'created' ? state!.id! : want.node;
      if (want.node === 'created') expect(children).toEqual([...before, id]);
      else expect(children).toEqual(before);
      expect(host.textOf(id)).toBe(want.text);
    }
    expect(state !== null).toBe(want.textEdit);
    if (want.anchor !== undefined) {
      expect({ anchor: state?.anchor, focus: state?.focus }).toEqual({
        anchor: want.anchor,
        focus: want.focus,
      });
    }
    expect(state?.composition ?? null).toBeNull();
    expect(editor.getSnapshot().history.undoDepth).toBe(want.undoDepth);
    expect(host.focused()).toBe(want.focused);
    expect(host.textarea.value).toBe(want.textarea);
  });
});
