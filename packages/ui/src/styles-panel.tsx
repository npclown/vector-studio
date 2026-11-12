import {
  useEditorCommands,
  useEditorSelector,
  type Color,
  type Command,
  type Variable,
} from '@vector-studio/react';
import { useMemo, useState } from 'react';
import { colorHex, isGradient, numberText, parseHex, parseNumber } from './appearance-model.js';
import { ColorWell } from './color-controls.js';
import { Row, TextField } from './fields.js';
import {
  NEW_STYLE_PAINT,
  nextModeName,
  nextStyleName,
  nextVariableName,
  paintCss,
  tablesOfDocument,
} from './styles-model.js';

// V-39 contract (docs/plans/viz-v39-styles-variables-contract.md), U4: the Local styles panel.
// It lists the document's colour styles and variables and edits them through the section 3
// table commands only (one command, one undo step each); a refused command shows its code.

const SWATCH = {
  display: 'inline-block',
  width: 18,
  height: 18,
  borderRadius: 3,
  border: '1px solid rgba(128, 128, 128, 0.6)',
  flex: 'none',
} as const;

/** The value control of one variable in one mode: a colour well or a number field. */
function ValueField({
  variable,
  mode,
  modeName,
  index,
  run,
}: {
  variable: Variable;
  mode: string;
  modeName: string;
  index: number;
  run: (command: Command) => boolean;
}) {
  const value = variable.values[mode];
  const label = `Variable ${index} ${modeName} value`;
  const set = (next: Color | number) =>
    run({ type: 'updateVariable', id: variable.id, values: { [mode]: next } });
  if (variable.type === 'color') {
    const color = value as Color;
    return (
      <ColorWell
        label={label}
        testId={`variable-${index}-value-${mode}`}
        value={colorHex(color)}
        commit={(hex) => {
          const next = parseHex(hex, color.a);
          return next !== null && set(next);
        }}
      />
    );
  }
  return (
    <TextField
      label={label}
      value={numberText(value as number)}
      commit={(text) => {
        const next = parseNumber(text);
        return next !== null && set(next);
      }}
    />
  );
}

/**
 * The Local styles panel (V-39 U4), the `region` named "Local styles" (test ID `styles-panel`):
 * the colour styles (swatch, inline rename, a colour well for a solid style, delete) and `+` (a
 * new `#D9D9D9` style named `Color <n>`); the variables with an active-mode selector, add,
 * rename and remove mode, a row per variable (name, type, one value per mode, delete), and add
 * colour or number variable. next-host's studio mounts it in its right column when nothing is
 * selected.
 */
export function StylesPanel() {
  const execute = useEditorCommands();
  const document = useEditorSelector((snapshot) => snapshot.document);
  const tables = useMemo(() => tablesOfDocument(document), [document]);
  const [status, setStatus] = useState('');
  const run = (command: Command): boolean => {
    const result = execute(command);
    setStatus(result.ok ? '' : `${result.code} ${result.path ?? ''}`.trimEnd());
    return result.ok;
  };
  const styles = tables.colorStyles ?? [];
  const set = tables.variables;
  const modes = set?.modes ?? [];
  const active = modes.find((mode) => mode.id === set?.mode);
  return (
    <section aria-label="Local styles" data-testid="styles-panel" style={{ fontSize: 13 }}>
      <h2 style={{ fontSize: 13, margin: '8px 0 4px' }}>Local styles</h2>
      <fieldset>
        <legend>Colour styles</legend>
        {styles.length === 0 && <p style={{ margin: 0, opacity: 0.7 }}>No styles</p>}
        {styles.map((style, i) => {
          const n = i + 1;
          return (
            <Row key={style.id}>
              <span
                aria-hidden="true"
                data-testid={`style-${n}-swatch`}
                style={{ ...SWATCH, background: paintCss(style.paint) }}
              />
              <TextField
                identity={style.id}
                label={`Style ${n} name`}
                value={style.name}
                commit={(name) => run({ type: 'updateColorStyle', id: style.id, name })}
              />
              {!isGradient(style.paint) && (
                <ColorWell
                  label={`Style ${n} colour`}
                  testId={`style-${n}-colour`}
                  value={colorHex(style.paint)}
                  commit={(hex) => {
                    const paint = isGradient(style.paint) ? null : parseHex(hex, style.paint.a);
                    return paint !== null && run({ type: 'updateColorStyle', id: style.id, paint });
                  }}
                />
              )}
              <button
                type="button"
                aria-label={`Delete style ${n}`}
                onClick={() => void run({ type: 'removeColorStyle', id: style.id })}
              >
                ×
              </button>
            </Row>
          );
        })}
        <Row>
          <button
            type="button"
            aria-label="Add colour style"
            data-testid="add-style"
            onClick={() =>
              void run({
                type: 'createColorStyle',
                name: nextStyleName(tables),
                paint: NEW_STYLE_PAINT,
              })
            }
          >
            +
          </button>
        </Row>
      </fieldset>
      <fieldset>
        <legend>Variables</legend>
        {set !== undefined && (
          <Row>
            <select
              aria-label="Active mode"
              value={set.mode}
              onChange={(event) =>
                void run({ type: 'setVariableMode', id: event.currentTarget.value })
              }
            >
              {modes.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.name}
                </option>
              ))}
            </select>
            {active !== undefined && (
              <TextField
                identity={active.id}
                label="Mode name"
                value={active.name}
                commit={(name) => run({ type: 'renameVariableMode', id: active.id, name })}
              />
            )}
            <button
              type="button"
              aria-label="Add mode"
              onClick={() => void run({ type: 'addVariableMode', name: nextModeName(tables) })}
            >
              + mode
            </button>
            <button
              type="button"
              aria-label="Remove mode"
              disabled={modes.length <= 1}
              onClick={() => void run({ type: 'removeVariableMode', id: set.mode })}
            >
              − mode
            </button>
          </Row>
        )}
        {(set?.items ?? []).map((variable, i) => {
          const n = i + 1;
          return (
            <Row key={variable.id}>
              <TextField
                identity={variable.id}
                label={`Variable ${n} name`}
                value={variable.name}
                commit={(name) => run({ type: 'updateVariable', id: variable.id, name })}
              />
              <span data-testid={`variable-${n}-type`} style={{ opacity: 0.7 }}>
                {variable.type}
              </span>
              {modes.map((mode) => (
                <ValueField
                  key={mode.id}
                  variable={variable}
                  mode={mode.id}
                  modeName={mode.name}
                  index={n}
                  run={run}
                />
              ))}
              <button
                type="button"
                aria-label={`Delete variable ${n}`}
                onClick={() => void run({ type: 'removeVariable', id: variable.id })}
              >
                ×
              </button>
            </Row>
          );
        })}
        <Row>
          <button
            type="button"
            aria-label="Add colour variable"
            data-testid="add-colour-variable"
            onClick={() =>
              void run({
                type: 'createVariable',
                name: nextVariableName(tables, 'color'),
                kind: 'color',
                value: NEW_STYLE_PAINT,
              })
            }
          >
            + colour
          </button>
          <button
            type="button"
            aria-label="Add number variable"
            data-testid="add-number-variable"
            onClick={() =>
              void run({
                type: 'createVariable',
                name: nextVariableName(tables, 'number'),
                kind: 'number',
                value: 1,
              })
            }
          >
            + number
          </button>
        </Row>
      </fieldset>
      {status !== '' && (
        <p data-testid="styles-error" role="status" style={{ color: '#b00' }}>
          {status}
        </p>
      )}
    </section>
  );
}
