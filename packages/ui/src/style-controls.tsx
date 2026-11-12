import type { BindingKey, Command, NodeV8, Paint } from '@vector-studio/react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
} from 'react';
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

/** The menu's largest height, in CSS px. */
const MENU_HEIGHT = 280;

/**
 * Where an open menu sits: fixed to the viewport under its button's right edge, or above the
 * button when the space below is short and the space above is larger. Fixed positioning lets the
 * menu escape a scrolling panel (`overflow: auto` clips an absolute child, and the panel then
 * takes the menu's clicks).
 */
export function menuPlacement(
  button: Readonly<{ top: number; bottom: number; right: number }>,
  viewport: Readonly<{ width: number; height: number }>,
): CSSProperties {
  const below = viewport.height - button.bottom;
  const up = below < MENU_HEIGHT + 8 && button.top > below;
  return {
    position: 'fixed',
    right: Math.max(0, viewport.width - button.right),
    ...(up ? { bottom: viewport.height - button.top } : { top: button.bottom }),
    maxHeight: Math.max(80, Math.min(MENU_HEIGHT, (up ? button.top : below) - 8)),
  };
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
  const trigger = useRef<HTMLButtonElement>(null);
  const buttonId = useId();
  const [place, setPlace] = useState<CSSProperties | null>(null);
  /** Measures the button against the viewport without its scrollbars, as fixed boxes are. */
  const measure = () => {
    const rect = trigger.current?.getBoundingClientRect();
    const root = globalThis.document?.documentElement;
    if (rect === undefined || root === undefined) return;
    const next = menuPlacement(rect, { width: root.clientWidth, height: root.clientHeight });
    setPlace((last) => (JSON.stringify(last) === JSON.stringify(next) ? last : next));
  };
  // Every render while open: a re-render (a new selection, say) can move the button.
  useLayoutEffect(() => {
    if (open) measure();
  });
  // A scroll moves the button: the menu follows it while the button stays inside the scrolled
  // element and the viewport, and closes (keeping focus where the user put it) once the button
  // leaves them, so it never floats detached. A resize places it again.
  useEffect(() => {
    if (!open) return;
    const scrolled = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && box.current?.contains(target)) return;
      const button = trigger.current?.getBoundingClientRect();
      const root = globalThis.document?.documentElement;
      if (button === undefined || root === undefined) return;
      const area =
        target instanceof Element
          ? target.getBoundingClientRect()
          : { top: 0, bottom: root.clientHeight };
      const inside =
        button.bottom > Math.max(0, area.top) &&
        button.top < Math.min(root.clientHeight, area.bottom);
      if (inside) measure();
      else setOpen(false);
    };
    window.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('resize', measure);
    };
  }, [open]);
  /** Closes the menu and gives focus back to its button, so keyboard users keep their place. */
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  /** Arrow keys move between the menu's items (the ARIA menu pattern), wrapping around. */
  const move = (step: number) => {
    const items = [
      ...(box.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
    ];
    if (items.length === 0) return;
    const at = items.indexOf(globalThis.document?.activeElement as HTMLButtonElement);
    items[(at + step + items.length) % items.length]!.focus();
  };
  useEffect(() => {
    if (!open) return;
    const first = box.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    first?.focus();
  }, [open]);
  const choose = (action: () => void) => {
    close();
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
        if (!open) return;
        if (event.key === 'Escape') {
          event.stopPropagation();
          close();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          move(event.key === 'ArrowDown' ? 1 : -1);
        }
      }}
    >
      <button
        ref={trigger}
        id={buttonId}
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
          aria-labelledby={buttonId}
          data-testid={`${testId}-menu`}
          style={{
            // Before the first measurement (and in server markup) it sits under the button.
            ...(place ?? { position: 'absolute', top: '100%', right: 0, maxHeight: MENU_HEIGHT }),
            zIndex: 1000,
            minWidth: 180,
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
          // Two commands, two undo steps: the style's ID is known only once it exists. A first
          // undo drops the binding and keeps the style; a refused bind leaves the style. On a
          // mixed row the new style takes the first paint and binds every node to it.
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
