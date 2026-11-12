import { useEffect, useRef, useState, type FocusEvent } from 'react';
import { PANEL_SWATCHES } from './appearance-model.js';
import { Icon } from './icons.js';

// V-25 colour controls, shared by the appearance panel's solid paints (slice 3) and the text
// section's run colour (slice 5): the browser colour picker and the one-click swatches.

/**
 * A text run control (M8-R4): it carries `data-text-edit-focus`, so moving focus to it from the
 * canvas keeps the text edit selection, and `onLeave` ends text edit mode when focus leaves it
 * for an element outside that target (as the run `TextField`s).
 */
export type TextEditFocus = Readonly<{ onLeave: () => void }>;

/** Whether focus moved to an element of the canvas's text edit focus target (M8-R4). */
function inTextEditFocus(node: EventTarget | null): boolean {
  const element = node as { closest?: (selector: string) => unknown } | null;
  return (
    element !== null &&
    typeof element.closest === 'function' &&
    element.closest('[data-text-edit-focus]') != null
  );
}

/**
 * The browser's colour picker beside a hex field. It shows the colour live while the picker is
 * open but commits once, on the input's native `change` (the picker closes or the choice is
 * confirmed), so one pick is one command and one undo step (M4-Q13 (a): no live preview in the
 * document). A mixed value shows black; a new document value drops the shown draft, but the
 * pick itself (`pending`) still commits when `change` comes.
 */
export function ColorWell({
  label,
  testId,
  value,
  disabled = false,
  textEdit,
  onOpen,
  commit,
}: {
  label: string;
  testId: string;
  /** `#rrggbb`, or null when mixed. */
  value: string | null;
  disabled?: boolean;
  textEdit?: TextEditFocus;
  /** Called as the picker takes focus or is clicked, before it opens, to capture its target. */
  onOpen?: () => void;
  commit: (hex: string) => boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const latest = useRef(commit);
  useEffect(() => {
    latest.current = commit;
  });
  // Review r2: the pick is kept apart from the shown value. Closing Chrome's popup by a click
  // outside it queues `change` after that click, whose blur or caret move can change `value`
  // first, and React then writes the new value into the element; so the last `input` value is
  // kept in `pending` and compared with the value shown when the picker opened.
  const pending = useRef<string | null>(null);
  const opened = useRef<string | null>(value);
  // Focus starts a pick; a click (which also reopens a focused picker by keyboard) only
  // records the target again, so a click on the picker that closes its popup keeps the pick.
  const focus = () => {
    opened.current = value;
    pending.current = null;
    onOpen?.();
  };
  const click = () => {
    if (pending.current === null) opened.current = value;
    onOpen?.();
  };
  // Between picks the opening value follows the document (an undo, another selection).
  useEffect(() => {
    if (pending.current === null) opened.current = value;
  }, [value]);
  useEffect(() => {
    const element = input.current;
    if (element === null) return;
    // React's onChange follows every `input` event while the picker is open; the native
    // `change` fires once, when the choice is made.
    const onChange = () => {
      // Only a value the user picked commits: a popup closed without a pick may still fire
      // `change` with the value React wrote in meanwhile (review r3).
      const hex = pending.current;
      pending.current = null;
      setDraft(null);
      if (hex !== null && hex !== opened.current) {
        opened.current = hex;
        void latest.current(hex);
      }
    };
    element.addEventListener('change', onChange);
    return () => element.removeEventListener('change', onChange);
  }, []);
  const [source, setSource] = useState(value);
  if (source !== value) {
    setSource(value);
    setDraft(null);
  }
  // V-39 contract, V39-U1: the browser's screen eyedropper where it has one (Chromium), found
  // after mount so the server markup stays the same.
  const [screenPicker, setScreenPicker] = useState(false);
  useEffect(() => {
    setScreenPicker(eyeDropperConstructor() !== null);
  }, []);
  const pickFromScreen = () => {
    const EyeDropper = eyeDropperConstructor();
    if (EyeDropper === null) return;
    onOpen?.();
    new EyeDropper()
      .open()
      .then((result) => {
        const hex = result.sRGBHex.toLowerCase();
        if (/^#[0-9a-f]{6}$/u.test(hex)) void latest.current(hex);
      })
      .catch(() => {
        // Escape or a lost focus cancels the pick; nothing changes.
      });
  };
  const well = (
    <input
      ref={input}
      type="color"
      aria-label={label}
      data-testid={testId}
      title={label}
      disabled={disabled}
      value={draft ?? value ?? '#000000'}
      onChange={(event) => {
        pending.current = event.target.value;
        setDraft(event.target.value);
      }}
      onFocus={focus}
      onClick={click}
      onBlur={(event: FocusEvent<HTMLInputElement>) => {
        if (textEdit !== undefined && !inTextEditFocus(event.relatedTarget)) textEdit.onLeave();
      }}
      data-text-edit-focus={textEdit === undefined ? undefined : ''}
      style={{ width: 28, height: 24, padding: 0, border: 'none', background: 'none' }}
    />
  );
  if (!screenPicker) return well;
  return (
    <>
      {well}
      <button
        type="button"
        className="vs-icon-button"
        aria-label={`${label}: pick from screen`}
        title="Pick from screen"
        data-testid={`${testId}-screen-pick`}
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={pickFromScreen}
        data-text-edit-focus={textEdit === undefined ? undefined : ''}
        style={{ width: 24, height: 24, padding: 0 }}
      >
        <Icon name="eyedropper" />
      </button>
    </>
  );
}

type EyeDropperLike = new () => { open(): Promise<{ sRGBHex: string }> };

/** The browser's `EyeDropper` constructor, or null where there is none (or no window). */
function eyeDropperConstructor(): EyeDropperLike | null {
  const scope = globalThis as { EyeDropper?: unknown };
  return typeof scope.EyeDropper === 'function' ? (scope.EyeDropper as EyeDropperLike) : null;
}

/**
 * One-click colours (`PANEL_SWATCHES`): a click calls `pick` with the swatch's `#rrggbb`. A press
 * never takes focus, so the canvas keeps it (and a text edit selection stays as it is).
 */
export function Swatches({
  name,
  testId,
  current,
  disabled = false,
  textEdit,
  pick,
}: {
  /** The group's name prefix, as "Fill" in "Fill swatches" and "Fill swatch #000000". */
  name: string;
  /** The test ID prefix, as `fill` in `fill-swatches` and `fill-swatch-000000`. */
  testId: string;
  /** The shared colour, or null when there is none. */
  current: string | null;
  disabled?: boolean;
  /** Text run swatches: in the text edit focus target, so keyboard focus keeps edit mode. */
  textEdit?: TextEditFocus;
  pick: (hex: string) => void;
}) {
  return (
    <div
      role="group"
      aria-label={`${name} swatches`}
      data-testid={`${testId}-swatches`}
      style={{ display: 'flex', flexWrap: 'wrap', gap: 4, margin: '4px 0' }}
    >
      {PANEL_SWATCHES.map((hex) => (
        <button
          key={hex}
          type="button"
          aria-label={`${name} swatch ${hex}`}
          aria-pressed={current === hex}
          data-testid={`${testId}-swatch-${hex.slice(1)}`}
          title={hex}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => pick(hex)}
          onBlur={(event: FocusEvent<HTMLButtonElement>) => {
            if (textEdit !== undefined && !inTextEditFocus(event.relatedTarget)) textEdit.onLeave();
          }}
          data-text-edit-focus={textEdit === undefined ? undefined : ''}
          style={{
            width: 18,
            height: 18,
            padding: 0,
            borderRadius: 3,
            border: current === hex ? '2px solid #0d99ff' : '1px solid rgba(128, 128, 128, 0.6)',
            background: hex,
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.4 : 1,
          }}
        />
      ))}
    </div>
  );
}
