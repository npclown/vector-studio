import {
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

// MVP M8 contract, section 7 (M8-U5): the field controls of the property panel, moved with the M4
// appearance panel (M4 contract, section 8) and shared by its sections. A text field commits on
// Enter and on blur; when `commit` returns false (input that cannot be a value, or a refused
// command) the field is marked `aria-invalid`. A mixed value shows as "mixed".

/** A text field that commits its text on Enter and on blur; `commit` returns false when invalid. */
export function TextField({
  label,
  value,
  disabled = false,
  identity,
  commit,
  onLeaveTextEdit,
  inputStyle,
}: {
  label: string;
  /** The input's own style (V-25 slice 9: the transform grid's fields fill their cells). */
  inputStyle?: CSSProperties;
  /**
   * What the field edits (the property panel passes the node IDs): a change resets the draft
   * and its invalid mark even when the shown value stays the same. The appearance panel passes
   * none, as at M4.
   */
  identity?: string;
  /** The shown text, or null when mixed. */
  value: string | null;
  disabled?: boolean;
  commit: (text: string) => boolean;
  /**
   * MVP M8 contract, M8-R4: given for the text run fields, which then belong to the canvas's
   * text edit focus target (`data-text-edit-focus`, `@vector-studio/react`'s `EditorCanvas`), so
   * focusing one from the canvas keeps the text edit selection. Called after the blur's commit
   * when focus leaves for an element outside that target.
   */
  onLeaveTextEdit?: () => void;
}) {
  const shown = value ?? '';
  const [draft, setDraft] = useState(shown);
  const [invalid, setInvalid] = useState(false);
  // A new document value replaces the draft (after a commit, an undo or a selection change). It
  // is adjusted during render (React's "previous render" state pattern), not in an effect: an
  // effect's update is a further commit per change, and a drag changes the transform fields on
  // every move, so with moves queued behind a busy main thread each input-driven commit left that
  // update pending and React stopped the chain with error #185 (M9-U1 pre-run).
  const [source, setSource] = useState({ shown, identity });
  if (source.shown !== shown || source.identity !== identity) {
    setSource({ shown, identity });
    setDraft(shown);
    setInvalid(false);
  }
  const send = () => {
    if (draft === shown) {
      setInvalid(false);
      return;
    }
    const ok = commit(draft);
    setInvalid(!ok);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') send();
  };
  const onBlur = (event: FocusEvent<HTMLInputElement>) => {
    send();
    if (onLeaveTextEdit !== undefined && !inTextEditFocus(event.relatedTarget)) onLeaveTextEdit();
  };
  return (
    <input
      type="text"
      aria-label={label}
      aria-invalid={invalid}
      data-mixed={value === null ? 'true' : undefined}
      placeholder={value === null ? 'mixed' : undefined}
      value={draft}
      disabled={disabled}
      size={8}
      style={inputStyle}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      data-text-edit-focus={onLeaveTextEdit === undefined ? undefined : ''}
    />
  );
}

/** Whether focus moved to an element of the canvas's text edit focus target (M8-R4). */
function inTextEditFocus(node: EventTarget | null): boolean {
  const element = node as { closest?: (selector: string) => unknown } | null;
  return (
    element !== null &&
    typeof element.closest === 'function' &&
    element.closest('[data-text-edit-focus]') != null
  );
}

/** A select; a mixed value shows a disabled "mixed" option. */
export function Choice<T extends string>({
  label,
  value,
  options,
  disabled = false,
  onChange,
}: {
  label: string;
  value: T | null;
  options: readonly T[];
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <select
      aria-label={label}
      data-mixed={value === null ? 'true' : undefined}
      value={value ?? ''}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value as T)}
    >
      {value === null && (
        <option value="" disabled>
          mixed
        </option>
      )}
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

export const Row = ({ children }: { children: ReactNode }) => (
  <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>{children}</div>
);
