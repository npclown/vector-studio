import type { BindingKey, Command, NodeV8, Paint } from '@vector-studio/react';
import { useEffect, useRef, useState, type FocusEvent } from 'react';
import {
  bindCommand,
  bindingState,
  createStyleCommand,
  numberOptions,
  paintOptions,
  type BindOption,
  type BindingLabel,
  type BindingState,
  type StyleTables,
} from './styles-model.js';

// V-39 contract (docs/plans/viz-v39-styles-variables-contract.md), section 5: the controls the
// appearance and property panels add to a bindable row. U2: a Style button (four dots) opens a
// menu of the colour styles and colour variables, "Create style" and "Detach"; U3: a bind
// button with the number variables and "Detach". A bound row shows a chip with the binding's
// name and swatch or value; mixed bindings show `Mixed`.

const SWATCH_STYLE = {
  display: 'inline-block',
  width: 14,
  height: 14,
  borderRadius: 3,
  border: '1px solid rgba(128, 128, 128, 0.6)',
  flex: 'none',
} as const;

function Swatch({ css }: { css: string | null }) {
  return css === null ? null : (
    <span aria-hidden="true" style={{ ...SWATCH_STYLE, background: css }} />
  );
}

function labelText(label: BindingLabel): string {
  return label.swatch === null && label.value !== ''
    ? `${label.name} = ${label.value}`
    : label.name;
}

/**
 * The chip of a bound row (U2, U3): the shared binding's swatch and name (and a number's value),
 * or `Mixed`; nothing when the row is not bound. Test ID `<testId>-binding`.
 */
export function BindingChip({ testId, state }: { testId: string; state: BindingState }) {
  if (state.state === 'none') return null;
  const text = state.state === 'mixed' ? 'Mixed' : labelText(state.label);
  return (
    <span
      data-testid={`${testId}-binding`}
      data-state={state.state}
      title={text}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 6px',
        borderRadius: 4,
        background: 'rgba(13, 153, 255, 0.12)',
        maxWidth: 160,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis',
      }}
    >
      {state.state === 'one' && <Swatch css={state.label.swatch} />}
      {text}
    </span>
  );
}

/**
 * The Style or bind button and its menu (U2, U3): a click opens a list of `options`, then
 * `Create style` when `create` is given and `Detach` when the row is bound; a choice runs once
 * and closes the menu, as does Escape or focus leaving it. Test IDs `<testId>-bind` (the
 * button), `<testId>-menu`, `<testId>-option-<n>` (from 1), `<testId>-create`, `<testId>-detach`.
 */
export function BindMenu({
  label,
  testId,
  options,
  bound,
  disabled = false,
  bind,
  create,
}: {
  /** The button's name: `Fill style`, `Opacity variable`, … */
  label: string;
  testId: string;
  options: readonly BindOption[];
  /** Whether some written node is bound, so `Detach` is offered. */
  bound: boolean;
  disabled?: boolean;
  /** Binds the row to a choice, or with null detaches it. */
  bind: (ref: BindOption['ref'] | null) => void;
  /** Creates a style from the row's paint and binds it (paint rows only). */
  create?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const first = box.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    first?.focus();
  }, [open]);
  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };
  const leave = (event: FocusEvent<HTMLSpanElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next === null || !box.current?.contains(next)) setOpen(false);
  };
  const empty = options.length === 0 && create === undefined && !bound;
  return (
    <span
      ref={box}
      style={{ position: 'relative', display: 'inline-flex' }}
      onBlur={leave}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={`${testId}-bind`}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        style={{ padding: '0 4px', lineHeight: 1 }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <circle cx="3" cy="3" r="1.5" fill="currentColor" />
          <circle cx="9" cy="3" r="1.5" fill="currentColor" />
          <circle cx="3" cy="9" r="1.5" fill="currentColor" />
          <circle cx="9" cy="9" r="1.5" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          data-testid={`${testId}-menu`}
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            zIndex: 10,
            minWidth: 180,
            maxHeight: 280,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            padding: 4,
            background: 'var(--vs-bg, #fff)',
            color: 'inherit',
            border: '1px solid rgba(128, 128, 128, 0.5)',
            borderRadius: 6,
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.2)',
          }}
        >
          {empty && <span style={{ padding: 4, opacity: 0.7 }}>No variables</span>}
          {options.map((option, index) => (
            <button
              key={'style' in option.ref ? `s${option.ref.style}` : `v${option.ref.variable}`}
              type="button"
              role="menuitem"
              data-testid={`${testId}-option-${index + 1}`}
              data-kind={option.kind}
              onClick={() => choose(() => bind(option.ref))}
              style={{ display: 'flex', alignItems: 'center', gap: 6, textAlign: 'left' }}
            >
              <Swatch css={option.label.swatch} />
              {labelText(option.label)}
            </button>
          ))}
          {create !== undefined && (
            <button
              type="button"
              role="menuitem"
              data-testid={`${testId}-create`}
              onClick={() => choose(create)}
              style={{ textAlign: 'left' }}
            >
              Create style
            </button>
          )}
          {bound && (
            <button
              type="button"
              role="menuitem"
              data-testid={`${testId}-detach`}
              onClick={() => choose(() => bind(null))}
              style={{ textAlign: 'left' }}
            >
              Detach
            </button>
          )}
        </div>
      )}
    </span>
  );
}

/** Runs one command for a panel, which shows a refusal's code; its IDs on success. */
export type BindRun = (command: Command) => Readonly<{ ok: boolean; ids: readonly string[] }>;

/** What a row needs to bind (U2, U3): the tables and a command runner. */
export type Binder = Readonly<{ tables: StyleTables; run: BindRun }>;

/**
 * The binding chip and the Style or bind menu of one row (U2, U3) over `nodes`, the nodes
 * the row writes. A paint row offers Create style from `paint` when it has one.
 */
export function RowBinding({
  binder,
  nodes,
  bindingKey,
  label,
  testId,
  paint,
}: {
  binder: Binder;
  nodes: readonly NodeV8[];
  bindingKey: BindingKey;
  label: string;
  testId: string;
  paint?: Paint | null;
}) {
  const { tables, run } = binder;
  const ids = nodes.map((node) => node.id);
  const state = bindingState(tables, nodes, bindingKey);
  const paintRow = paint !== undefined;
  const create =
    paint === undefined || paint === null
      ? undefined
      : () => {
          const created = run(createStyleCommand(tables, paint));
          const id = created.ids[0];
          if (created.ok && id !== undefined) run(bindCommand(ids, bindingKey, { style: id }));
        };
  return (
    <>
      <BindingChip testId={testId} state={state} />
      <BindMenu
        label={label}
        testId={testId}
        options={paintRow ? paintOptions(tables, bindingKey) : numberOptions(tables, bindingKey)}
        bound={state.state !== 'none'}
        disabled={ids.length === 0}
        bind={(ref) => void run(bindCommand(ids, bindingKey, ref))}
        {...(create === undefined ? {} : { create })}
      />
    </>
  );
}
