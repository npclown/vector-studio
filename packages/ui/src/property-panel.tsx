import {
  useActivePage,
  useEditorCommands,
  useEditorQuery,
  useEditorSelector,
  useSelection,
  type Command,
  type Constraints,
  type DocumentV7,
  type KeyBinding,
  type NodeV7,
  type TextEditState,
  type TextNodeV7,
} from '@vector-studio/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { colorHex, parseNumber, type Common } from './appearance-model.js';
import { booleanActions } from './boolean-model.js';
import {
  addEffectCommand,
  effectColorCommand,
  effectLabel,
  effectNumberCommand,
  effectRows,
  effectOpacityCommand,
  isMaskSource,
  opacityText,
  removeEffectCommand,
  toggleEffectCommand,
  type EffectNumberKey,
  type EffectRow,
} from './effects-model.js';
import { withShortcut } from './editor-toolbar-model.js';
import { AppearancePanel } from './appearance-panel.js';
import { ColorWell, Swatches } from './color-controls.js';
import { Choice, Row, TextField } from './fields.js';
import {
  ARROWS,
  CONSTRAINTS,
  LETTER_SPACING_RANGE,
  LINE_HEIGHT_RANGE,
  TEXT_ALIGNS,
  TEXT_SIZINGS,
  TRANSFORM_FIELDS,
  commonOf,
  commonText,
  constrainedNodes,
  constraintsCommand,
  lineNodes,
  nameCommand,
  visibleCommand,
  arrowCommand,
  fieldIdentity,
  parseFamily,
  parseFontSize,
  parseTransform,
  refusalText,
  runPropertyAction,
  textRunStyle,
  selectedNodes,
  symbolSection,
  textNodes,
  textPropsCommand,
  textRange,
  textStyleCommand,
  pickedColorCommand,
  runColor,
  targetCommand,
  targetEditable,
  targetText,
  transformTarget,
  type PropertyAction,
  type TransformKey,
  type TransformTarget,
} from './property-model.js';
import { countRender } from './render-probe.js';

// MVP M8 contract, section 7.3 (M8-R1 to M8-R5, M8-U5): the property panel. Under the moved M4
// appearance panel come the transform, layer (name and visibility), line, constraint, text and
// symbol sections, each shown when a selected node has its fields. A field shows the common
// value or "mixed"; it is editable for one selected node only and read-only (disabled) for
// several, except the transform fields (V-25 slice 9, below). One committed edit is one command (one undo step); text that cannot be a value marks
// the field `aria-invalid` and sends nothing; a refused command also marks it and shows its code
// (`property-refusal`). The section 7.3 buttons carry no test ID (M8-R5). V-25 slice 9 amends
// M8-R2: the transform fields show the selection box and edit several nodes too.

/** Runs one command; false when the editor refused it (the panel shows its code). */
type Run = (command: Command) => boolean;

/** `Row`'s style, for a row that is also a named group. */
const ROW_STYLE = { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' } as const;

const Section = ({ legend, children }: { legend: string; children: ReactNode }) => (
  <fieldset>
    <legend>{legend}</legend>
    {children}
  </fieldset>
);

/** A common value of a select, or null when mixed or absent. */
const choiceOf = <T,>(value: Common<T>): T | null => (value.state === 'one' ? value.value : null);

/** A field's input fills its grid cell. */
const GRID_INPUT = { width: '100%', minWidth: 0, boxSizing: 'border-box' } as const;

/** The short visible label before each transform field (the accessible name stays the label). */
const TRANSFORM_PREFIX: Readonly<Record<TransformKey, string>> = {
  x: 'X',
  y: 'Y',
  width: 'W',
  height: 'H',
  rotation: '°',
};

function TransformSection({
  nodes,
  target,
  run,
}: {
  nodes: readonly NodeV7[];
  target: TransformTarget | null;
  run: Run;
}) {
  // V-25 slice 9: X and Y, W and H, then the rotation, in a two-column grid (Figma), each with a
  // short visible label; values are the selection box's, editable for several nodes too.
  return (
    <Section legend="Transform">
      <div
        data-testid="transform-grid"
        style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, alignItems: 'center' }}
      >
        {TRANSFORM_FIELDS.map(({ key, label }) => (
          <label
            key={key}
            style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}
            title={label === 'Rotation' ? 'Rotation (degrees)' : label}
          >
            <span aria-hidden="true" style={{ width: 12, opacity: 0.6, textAlign: 'center' }}>
              {TRANSFORM_PREFIX[key]}
            </span>
            <TextField
              identity={fieldIdentity(nodes)}
              label={label}
              value={target === null ? null : targetText(target, key)}
              disabled={target === null || !targetEditable(target, key)}
              inputStyle={GRID_INPUT}
              commit={(text) => {
                const value = parseTransform(key, text);
                const command =
                  value === null || target === null ? null : targetCommand(target, key, value);
                return command !== null && run(command);
              }}
            />
          </label>
        ))}
      </div>
    </Section>
  );
}

function LayerSection({ nodes, run }: { nodes: readonly NodeV7[]; run: Run }) {
  const only = nodes.length === 1 ? nodes[0]! : null;
  const name = commonOf(nodes, (node) => node.name);
  const visible = commonOf(nodes, (node) => node.visible);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current !== null) box.current.indeterminate = visible.state === 'mixed';
  }, [visible.state]);
  return (
    <Section legend="Name and visibility">
      <Row>
        <TextField
          identity={fieldIdentity(nodes)}
          label="Name"
          value={name.state === 'one' ? name.value : null}
          disabled={only === null}
          commit={(text) => only !== null && run(nameCommand(only, text))}
        />
        <label>
          <input
            ref={box}
            type="checkbox"
            aria-label="Visible"
            checked={visible.state === 'one' && visible.value}
            disabled={only === null}
            onChange={() => {
              if (only !== null) {
                void run(visibleCommand(only));
              }
            }}
          />{' '}
          visible
        </label>
      </Row>
    </Section>
  );
}

function LineSection({ nodes, run }: { nodes: readonly NodeV7[]; run: Run }) {
  const lines = lineNodes(nodes);
  const only = nodes.length === 1 ? lines[0] : undefined;
  return (
    <Section legend="Line">
      <Row>
        {(['startArrow', 'endArrow'] as const).map((key) => (
          <Choice
            key={key}
            label={key === 'startArrow' ? 'Start arrow' : 'End arrow'}
            value={choiceOf(commonOf(lines, (line) => line[key]))}
            options={ARROWS}
            disabled={only === undefined}
            onChange={(arrow) => {
              if (only !== undefined) {
                void run(arrowCommand(only, key, arrow));
              }
            }}
          />
        ))}
      </Row>
    </Section>
  );
}

function ConstraintSection({
  nodes,
  editable,
  run,
}: {
  /** The selected nodes whose constraints take effect. */
  nodes: readonly NodeV7[];
  /** One node is selected, and it is this node. */
  editable: boolean;
  run: Run;
}) {
  const only = editable ? nodes[0] : undefined;
  return (
    <Section legend="Constraints">
      <Row>
        {(['horizontal', 'vertical'] as const satisfies readonly (keyof Constraints)[]).map(
          (axis) => (
            <Choice
              key={axis}
              label={axis === 'horizontal' ? 'Horizontal constraint' : 'Vertical constraint'}
              value={choiceOf(commonOf(nodes, (node) => node.constraints[axis]))}
              options={CONSTRAINTS}
              disabled={only === undefined}
              onChange={(value) => {
                if (only !== undefined) void run(constraintsCommand(only, axis, value));
              }}
            />
          ),
        )}
      </Row>
    </Section>
  );
}

function TextSection({
  texts,
  editable,
  textEdit,
  run,
  exitTextEdit,
}: {
  texts: readonly TextNodeV7[];
  /** One node is selected, and it is this text node. */
  editable: boolean;
  textEdit: TextEditState | null;
  run: Run;
  /** Ends text edit mode when focus leaves a run field for outside the canvas (M8-R4). */
  exitTextEdit: () => void;
}) {
  const only = editable ? texts[0]! : null;
  // The run fields edit the text edit selection, the whole text without one, and are disabled
  // for a collapsed caret, where they show the caret's run (M8-Q9 (a)).
  const range = only === null ? null : textRange(only, textEdit);
  const { family, size, color } = textRunStyle(texts, textEdit);
  const runsDisabled = only === null || range === null;
  // The run fields' draft also resets when the text edit selection moves, since a canvas press
  // that commits a typed value can leave the caret on a run showing the old value (M8-R4).
  const runIdentity = `${fieldIdentity(texts)} ${textEdit?.anchor ?? ''}-${textEdit?.focus ?? ''}`;
  const setStyle = (style: Parameters<typeof textStyleCommand>[2]) =>
    only !== null && range !== null && run(textStyleCommand(only, range, style));
  // V-25 slice 5: the hex field, the colour picker and the swatches write the run colour with
  // the shown colour's alpha (opaque when mixed), one `setTextStyle` each.
  const colorValue = color.state === 'one' ? colorHex(color.value) : null;
  const setColor = (hex: string) => {
    const value = runColor(hex, color);
    return value !== null && setStyle({ color: value });
  };
  // The picker commits to the range it was opened on (review r1): Chrome queues its `change`
  // after the click that closes the popup, which may first end edit mode or move the caret.
  const picked = useRef<Parameters<typeof pickedColorCommand>[0] | null>(null);
  const openPicker = () => {
    picked.current =
      only !== null && range !== null ? { id: only.id, ...range, shown: color } : null;
  };
  const pickColor = (hex: string) => {
    const target = picked.current;
    const command = target === null ? null : pickedColorCommand(target, hex);
    return command !== null && run(command);
  };
  return (
    <Section legend="Text">
      <Row>
        <Choice
          label="Text sizing"
          value={choiceOf(commonOf(texts, (node) => node.sizing))}
          options={TEXT_SIZINGS}
          disabled={only === null}
          onChange={(sizing) => {
            if (only !== null) void run(textPropsCommand(only, { sizing }));
          }}
        />
        <Choice
          label="Text align"
          value={choiceOf(commonOf(texts, (node) => node.align))}
          options={TEXT_ALIGNS}
          disabled={only === null}
          onChange={(align) => {
            if (only !== null) void run(textPropsCommand(only, { align }));
          }}
        />
      </Row>
      <Row>
        <TextField
          identity={fieldIdentity(texts)}
          label="Letter spacing"
          value={commonText(commonOf(texts, (node) => node.letterSpacing))}
          disabled={only === null}
          commit={(text) => {
            const letterSpacing = parseNumber(text, ...LETTER_SPACING_RANGE);
            if (letterSpacing === null || only === null) return false;
            return run(textPropsCommand(only, { letterSpacing }));
          }}
        />
        <TextField
          identity={fieldIdentity(texts)}
          label="Line height"
          value={commonText(commonOf(texts, (node) => node.lineHeight))}
          disabled={only === null}
          commit={(text) => {
            const lineHeight = parseNumber(text, ...LINE_HEIGHT_RANGE);
            if (lineHeight === null || only === null) return false;
            return run(textPropsCommand(only, { lineHeight }));
          }}
        />
      </Row>
      <Row>
        <TextField
          identity={runIdentity}
          label="Font family"
          value={family.state === 'one' ? family.value : null}
          disabled={runsDisabled}
          onLeaveTextEdit={exitTextEdit}
          commit={(text) => {
            const value = parseFamily(text);
            return value !== null && setStyle({ family: value });
          }}
        />
        <TextField
          identity={runIdentity}
          label="Font size"
          value={commonText(size)}
          disabled={runsDisabled}
          onLeaveTextEdit={exitTextEdit}
          commit={(text) => {
            const value = parseFontSize(text);
            return value !== null && setStyle({ size: value });
          }}
        />
        <TextField
          identity={runIdentity}
          label="Text colour"
          value={colorValue}
          disabled={runsDisabled}
          onLeaveTextEdit={exitTextEdit}
          commit={setColor}
        />
        <ColorWell
          label="Text colour picker"
          testId="text-colour-picker"
          value={colorValue}
          disabled={runsDisabled}
          textEdit={{ onLeave: exitTextEdit }}
          onOpen={openPicker}
          commit={pickColor}
        />
      </Row>
      <Swatches
        name="Text"
        testId="text"
        current={colorValue}
        disabled={runsDisabled}
        textEdit={{ onLeave: exitTextEdit }}
        pick={(hex) => void setColor(hex)}
      />
    </Section>
  );
}

function ActionButton({ action, onRun }: { action: PropertyAction; onRun: () => void }) {
  return (
    <button type="button" onClick={onRun}>
      {action.label}
    </button>
  );
}

function SymbolSection({
  document,
  selection,
  runAction,
}: {
  document: DocumentV7;
  selection: readonly string[];
  runAction: (action: PropertyAction) => void;
}) {
  const section = symbolSection(document, selection);
  if (section === null) return null;
  if (section.kind === 'source') {
    return (
      <Section legend="Symbol">
        <Row>
          <ActionButton action={section.create} onRun={() => runAction(section.create)} />
        </Row>
      </Section>
    );
  }
  return (
    <Section legend="Instance">
      <Row>
        <ActionButton action={section.detach} onRun={() => runAction(section.detach)} />
      </Row>
      {section.resets.map((reset) => (
        <div key={reset.node} role="group" aria-label={reset.name} style={ROW_STYLE}>
          <span>{reset.name}</span>
          <ActionButton action={reset} onRun={() => runAction(reset)} />
        </div>
      ))}
    </Section>
  );
}

const EFFECT_FIELDS: readonly Readonly<{ key: EffectNumberKey; label: string; shadow: boolean }>[] =
  [
    { key: 'offsetX', label: 'X', shadow: true },
    { key: 'offsetY', label: 'Y', shadow: true },
    { key: 'radius', label: 'Blur', shadow: false },
  ];

/** One effect row: visible, colour and opacity (shadows), X, Y (shadows), blur, remove. */
function EffectRowFields({
  nodes,
  row,
  disabled,
  run,
}: {
  nodes: readonly NodeV7[];
  row: EffectRow;
  disabled: boolean;
  run: Run;
}) {
  const name = `Effect ${row.index + 1}`;
  const box = useRef<HTMLInputElement>(null);
  // Set on every render: a refused toggle lets the browser clear the mark while the state
  // stays 'mixed'.
  useEffect(() => {
    if (box.current !== null) box.current.indeterminate = row.visible.state === 'mixed';
  });
  const colorValue = row.color.state === 'one' ? colorHex(row.color.value) : null;
  const setColor = (hex: string) => {
    const command = effectColorCommand(nodes, row, hex);
    return command !== null && run(command);
  };
  // The kind and each holder's effect are part of what a field edits, so a removal that moves
  // another effect to this index resets the draft and its invalid mark.
  const identity = `${fieldIdentity(nodes)} ${row.index} ${JSON.stringify(
    nodes.map((node) => node.effects[row.index] ?? null),
  )}`;
  return (
    <div
      role="group"
      aria-label={`${name} ${effectLabel(row.kind)}`}
      data-testid={`effect-${row.index}`}
      data-kind={row.kind}
      style={{ ...ROW_STYLE, marginBottom: 4 }}
    >
      <label>
        <input
          ref={box}
          type="checkbox"
          aria-label={`${name} visible`}
          data-testid={`effect-${row.index}-visible`}
          checked={row.visible.state === 'one' && row.visible.value}
          disabled={disabled}
          onChange={() => void run(toggleEffectCommand(nodes, row))}
        />{' '}
        {effectLabel(row.kind)}
      </label>
      {row.shadow && (
        <>
          <TextField
            identity={identity}
            label={`${name} colour`}
            value={colorValue}
            disabled={disabled}
            commit={setColor}
          />
          <ColorWell
            label={`${name} colour picker`}
            testId={`effect-${row.index}-colour-picker`}
            value={colorValue}
            disabled={disabled}
            commit={setColor}
          />
          <TextField
            identity={identity}
            label={`${name} opacity`}
            value={opacityText(row.color)}
            disabled={disabled || row.color.state !== 'one'}
            commit={(text) => {
              const command = effectOpacityCommand(nodes, row, text);
              return command !== null && run(command);
            }}
          />
        </>
      )}
      {EFFECT_FIELDS.filter((field) => row.shadow || !field.shadow).map(({ key, label }) => (
        <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <span aria-hidden="true" style={{ opacity: 0.6 }}>
            {label}
          </span>
          <TextField
            identity={identity}
            label={`${name} ${label}`}
            value={commonText(row[key])}
            disabled={disabled}
            commit={(text) => {
              const command = effectNumberCommand(nodes, row, key, text);
              return command !== null && run(command);
            }}
          />
        </label>
      ))}
      <button
        type="button"
        aria-label={`Remove ${name}`}
        title={`Remove ${name.toLowerCase()}`}
        data-testid={`effect-${row.index}-remove`}
        disabled={disabled}
        onClick={() => void run(removeEffectCommand(nodes, row.index))}
      >
        −
      </button>
    </div>
  );
}

/**
 * E41-U7 (E41 contract, section 6): add a drop shadow or a layer blur to each selected node, and
 * per effect index a visible toggle, colour, X, Y, blur and remove, "mixed" where the selected
 * nodes differ. A mask source's effects do not render (section 3): the section shows them
 * disabled with a note.
 */
function EffectsSection({
  document,
  nodes,
  run,
}: {
  document: DocumentV7;
  nodes: readonly NodeV7[];
  run: Run;
}) {
  const masked = nodes.some((node) => isMaskSource(document, node));
  const rows = effectRows(nodes);
  return (
    <Section legend="Effects">
      <Row>
        <button
          type="button"
          data-testid="effects-add-shadow"
          disabled={masked}
          onClick={() => void run(addEffectCommand(nodes, 'dropShadow'))}
        >
          + Drop shadow
        </button>
        <button
          type="button"
          data-testid="effects-add-blur"
          disabled={masked}
          onClick={() => void run(addEffectCommand(nodes, 'layerBlur'))}
        >
          + Layer blur
        </button>
      </Row>
      {masked && (
        <p data-testid="effects-mask-note" style={{ margin: '4px 0', opacity: 0.7 }}>
          A mask uses its shape only, so its effects do not show
        </p>
      )}
      {rows.map((row) => (
        <EffectRowFields key={row.index} nodes={nodes} row={row} disabled={masked} run={run} />
      ))}
    </Section>
  );
}

/**
 * E41-U3b (E41 contract, section 6): union, subtract, intersect and exclude for a qualifying
 * selection (section 2.1), each `property-boolean-<op>`; the command selects its result.
 */
function BooleanSection({
  document,
  selection,
  keymap,
  run,
}: {
  document: DocumentV7;
  selection: readonly string[];
  keymap: readonly KeyBinding[];
  run: Run;
}) {
  const actions = booleanActions(document, selection, keymap);
  if (actions.length === 0) return null;
  return (
    <Section legend="Boolean">
      <Row>
        {actions.map((action) => (
          <button
            key={action.op}
            type="button"
            data-testid={`property-boolean-${action.op}`}
            title={withShortcut(action.label, action.shortcut)}
            onClick={() => run(action.command)}
          >
            {action.label}
          </button>
        ))}
      </Row>
    </Section>
  );
}

/**
 * The transform, layer, line, constraint, text and symbol sections of the property panel
 * (MVP M8 contract, M8-R2 to M8-R5), without the appearance panel. Each section shows when a
 * selected node has its fields; a field is editable for one selected node and shows the common
 * value or "mixed", read-only, for several (the transform fields, V-25 slice 9, edit several); one committed edit is one command; a refused command
 * shows its code (`property-refusal`).
 */
export function PropertySections() {
  const execute = useEditorCommands();
  const selection = useSelection();
  const document = useEditorSelector((snapshot) => snapshot.document);
  const keymap = useEditorSelector((snapshot) => snapshot.keymap);
  const textEdit = useEditorSelector((snapshot) => snapshot.textEdit);
  const handles = useEditorQuery({ type: 'handles' });
  const page = useActivePage();
  // A refusal shows only while the selection it was made on stays selected.
  const [refusal, setRefusal] = useState({ selection: '', text: '' });
  const nodes = selectedNodes(document, selection);
  if (nodes.length === 0) return null;
  const key = JSON.stringify(selection);
  const setStatus = (text: string) => setRefusal({ selection: key, text });
  const status = refusal.selection === key ? refusal.text : '';
  const run: Run = (command) => {
    const result = execute(command);
    setStatus(refusalText(result));
    return result.ok;
  };
  // M8-R4: a run field keeps the text edit selection while focused; leaving it for anything but
  // the canvas, another run field or the window (Alt+Tab keeps edit mode, as M6b-H2) exits.
  const exitTextEdit = () => {
    if (textEdit !== null && globalThis.document?.hasFocus() === true) {
      execute({ type: 'exitTextEdit' });
    }
  };
  const constrained = constrainedNodes(document, nodes);
  const texts = textNodes(nodes);
  return (
    <div style={{ fontSize: 13 }}>
      <TransformSection nodes={nodes} target={transformTarget(nodes, handles, page)} run={run} />
      <LayerSection nodes={nodes} run={run} />
      {lineNodes(nodes).length > 0 && <LineSection nodes={nodes} run={run} />}
      {constrained.length > 0 && (
        <ConstraintSection nodes={constrained} editable={nodes.length === 1} run={run} />
      )}
      {texts.length > 0 && (
        <TextSection
          texts={texts}
          editable={nodes.length === 1}
          textEdit={textEdit}
          run={run}
          exitTextEdit={exitTextEdit}
        />
      )}
      <EffectsSection document={document} nodes={nodes} run={run} />
      <BooleanSection document={document} selection={selection} keymap={keymap} run={run} />
      <SymbolSection
        document={document}
        selection={selection}
        runAction={(action) => setStatus(refusalText(runPropertyAction(execute, action)))}
      />
      {status !== '' && (
        <p data-testid="property-refusal" role="status" style={{ color: '#b00' }}>
          {status}
        </p>
      )}
    </div>
  );
}

/**
 * The property panel (MVP M8 contract, section 7.3): the appearance panel as a section of the
 * right column (M8-R1, `AppearancePanel` with `layout="section"`), then `PropertySections`
 * (M8-R2 to M8-R5). A host that needs the appearance panel alone, as `?bench=1` does (M8-N5),
 * renders `AppearancePanel`.
 */
export function PropertyPanel() {
  countRender('properties');
  return (
    <section aria-label="Properties" data-testid="property-panel">
      <AppearancePanel layout="section" />
      <PropertySections />
    </section>
  );
}
