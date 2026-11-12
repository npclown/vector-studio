import {
  useActivePage,
  useEditor,
  useEditorCommands,
  useEditorQuery,
  useEditorSelector,
  useSelection,
  type Command,
  type Constraints,
  type DocumentV8,
  type Effect,
  type KeyBinding,
  type NodeV8,
  type TextEditState,
  type TextNodeV8,
} from '@vector-studio/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { colorHex, fillOf, parseNumber, type Common } from './appearance-model.js';
import { booleanActions } from './boolean-model.js';
import {
  addEffectCommand,
  effectKindCommand,
  effectColorCommand,
  effectLabel,
  effectNumberCommand,
  effectRows,
  kindOptions,
  effectOpacityCommand,
  isMaskSource,
  opacityText,
  removeEffectCommand,
  toggleEffectCommand,
  type EffectNumberKey,
  type EffectRow,
} from './effects-model.js';
import { withShortcut } from './editor-toolbar-model.js';
import {
  GRID_ALIGNS,
  GRID_NUMBER_LABELS,
  GRID_TYPES,
  addGridCommand,
  gridAlignCommand,
  gridColorCommand,
  gridNumberCommand,
  gridNumberKeys,
  gridNumberText,
  gridOpacityCommand,
  gridOpacityText,
  gridTypeCommand,
  layoutGridTarget,
  removeGridCommand,
  toggleGridCommand,
  type GridHolder,
} from './layout-grid-model.js';
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
import {
  setInstanceFocus,
  targetInstance,
  useInstanceFocus,
  type InstanceFocus,
} from './instance-focus.js';
import { countRender } from './render-probe.js';
import {
  addPropertyCommand,
  addVariantAction,
  combineAction,
  effectOverrideCommand,
  fillOverrideCommand,
  fillText,
  instanceLayers,
  instanceVariantCommand,
  layerControls,
  opacityOverrideCommand,
  opacityPercent,
  removePropertyCommand,
  renamePropertyCommand,
  resetAllAction,
  resetLayerAction,
  selectedSet,
  setProperties,
  strokeOverrideCommand,
  variantDropdowns,
  variantFields,
  variantValueCommand,
  visibleOverrideCommand,
} from './variant-model.js';

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
  nodes: readonly NodeV8[];
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

function LayerSection({ nodes, run }: { nodes: readonly NodeV8[]; run: Run }) {
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

function LineSection({ nodes, run }: { nodes: readonly NodeV8[]; run: Run }) {
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
  nodes: readonly NodeV8[];
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
  texts: readonly TextNodeV8[];
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
  document: DocumentV8;
  selection: readonly string[];
  runAction: (action: PropertyAction) => void;
}) {
  const section = symbolSection(document, selection);
  if (section === null) return null;
  const resetAll = resetAllAction(selection[0]!);
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
        <ActionButton action={resetAll} onRun={() => runAction(resetAll)} />
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

type Kind = Effect['kind'];

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
  offered,
  disabled,
  run,
}: {
  nodes: readonly NodeV8[];
  row: EffectRow;
  offered: readonly Kind[];
  disabled: boolean;
  run: Run;
}) {
  const name = `Effect ${row.index + 1}`;
  const kinds = kindOptions(row, offered);
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
      <input
        ref={box}
        type="checkbox"
        aria-label={`${name} visible`}
        data-testid={`effect-${row.index}-visible`}
        checked={row.visible.state === 'one' && row.visible.value}
        disabled={disabled}
        onChange={() => void run(toggleEffectCommand(nodes, row))}
      />
      <select
        aria-label={`${name} kind`}
        data-testid={`effect-${row.index}-kind`}
        value={row.kind}
        disabled={disabled || kinds.length < 2}
        onChange={(event) => void run(effectKindCommand(nodes, row, event.target.value as Kind))}
      >
        {row.kind === 'mixed' && <option value="mixed">{effectLabel('mixed')}</option>}
        {(kinds.length === 0 && row.kind !== 'mixed' ? [row.kind] : kinds).map((kind) => (
          <option key={kind} value={kind}>
            {effectLabel(kind)}
          </option>
        ))}
      </select>
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

/** The add buttons' test IDs (V-36 contract, section 6). */
const ADD_TEST_IDS: Readonly<Record<Kind, string>> = {
  dropShadow: 'effects-add-shadow',
  innerShadow: 'effects-add-inner-shadow',
  layerBlur: 'effects-add-blur',
  backgroundBlur: 'effects-add-background-blur',
};

/**
 * E41-U7 (E41 contract, section 6) and V-36 (section 6): add each kind the host projects to each
 * selected node, and per effect index a visible toggle, a kind select within the row's family,
 * colour, X, Y, blur and remove, "mixed" where the selected nodes differ. A mask source's
 * effects do not render (section 3): the section shows them disabled with a note.
 */
function EffectsSection({
  document,
  nodes,
  run,
  legend = 'Effects',
}: {
  document: DocumentV8;
  nodes: readonly NodeV8[];
  run: Run;
  /** V-37: "Layer effects" for the focused layer of an instance. */
  legend?: string;
}) {
  const masked = nodes.some((node) => isMaskSource(document, node));
  const rows = effectRows(nodes);
  // The kinds the host projects (V-36 contract, section 6). Background blur joins the list when
  // the renderer draws it (V-36 U3).
  const offered = useEditorQuery({ type: 'effectKinds' }).filter(
    (kind) => kind !== 'backgroundBlur',
  );
  return (
    <Section legend={legend}>
      <Row>
        {offered.map((kind) => (
          <button
            key={kind}
            type="button"
            data-testid={ADD_TEST_IDS[kind]}
            disabled={masked}
            onClick={() => void run(addEffectCommand(nodes, kind))}
          >
            + {effectLabel(kind)}
          </button>
        ))}
      </Row>
      {masked && (
        <p data-testid="effects-mask-note" style={{ margin: '4px 0', opacity: 0.7 }}>
          A mask uses its shape only, so its effects do not show
        </p>
      )}
      {rows.map((row) => (
        <EffectRowFields
          key={row.index}
          nodes={nodes}
          row={row}
          offered={offered}
          disabled={masked}
          run={run}
        />
      ))}
    </Section>
  );
}

/** V-37 section 6.1: a selected set's properties, and "Add variant". */
function SetSection({
  document,
  set,
  run,
  runAction,
}: {
  document: DocumentV8;
  set: NonNullable<ReturnType<typeof selectedSet>>;
  run: Run;
  runAction: (action: PropertyAction) => void;
}) {
  const properties = setProperties(document, set);
  const addVariant = addVariantAction(document, set);
  // A rename or a removal rewrites the variants, so the field drafts reset with their values.
  const identity = `${set.id} ${JSON.stringify(properties)}`;
  return (
    <Section legend="Properties">
      {properties.map((property, index) => (
        <div
          key={property.name}
          role="group"
          aria-label={`Property ${property.name}`}
          style={{ ...ROW_STYLE, marginBottom: 4 }}
        >
          <TextField
            identity={identity}
            label={`Property ${index + 1} name`}
            value={property.name}
            commit={(text) => {
              const command = renamePropertyCommand(document, set, property.name, text);
              return command !== null && run(command);
            }}
          />
          <span data-testid={`property-values-${index}`} style={{ opacity: 0.7 }}>
            {property.values.join(', ')}
          </span>
          <button
            type="button"
            aria-label={`Remove property ${property.name}`}
            disabled={properties.length < 2}
            onClick={() => {
              const command = removePropertyCommand(document, set, property.name);
              if (command !== null) void run(command);
            }}
          >
            −
          </button>
        </div>
      ))}
      <Row>
        <button type="button" onClick={() => void run(addPropertyCommand(document, set))}>
          Add property
        </button>
        {addVariant !== null && (
          <ActionButton action={addVariant} onRun={() => runAction(addVariant)} />
        )}
      </Row>
    </Section>
  );
}

/** V-37 section 6.1: one value field per property of a selected variant. */
function VariantFieldsSection({
  document,
  selection,
  run,
}: {
  document: DocumentV8;
  selection: readonly string[];
  run: Run;
}) {
  const section = variantFields(document, selection);
  if (section === null) return null;
  return (
    <Section legend="Variant properties">
      {section.fields.map((field) => (
        <label key={field.name} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ minWidth: 60 }}>{field.name}</span>
          <TextField
            identity={section.id}
            label={`Variant ${field.name}`}
            value={field.value}
            commit={(text) => {
              const command = variantValueCommand(document, section.id, field.name, text);
              return command !== null && run(command);
            }}
          />
        </label>
      ))}
    </Section>
  );
}

/** V-37 section 6.2: one dropdown per property of an instance whose source is in a set. */
function InstanceVariantSection({
  document,
  id,
  run,
}: {
  document: DocumentV8;
  id: string;
  run: Run;
}) {
  const dropdowns = variantDropdowns(document, id);
  if (dropdowns === null) return null;
  return (
    <Section legend="Variant">
      {dropdowns.map((dropdown) => (
        <label key={dropdown.name} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ minWidth: 60 }}>{dropdown.name}</span>
          <select
            aria-label={`Variant ${dropdown.name}`}
            value={dropdown.value}
            onChange={(event) =>
              void run(instanceVariantCommand(id, dropdown.name, event.currentTarget.value))
            }
          >
            {dropdown.options.map((option) => (
              <option key={option.value} value={option.value} disabled={option.disabled}>
                {option.value}
              </option>
            ))}
          </select>
        </label>
      ))}
    </Section>
  );
}

/** V-37 section 6.2: the source subtree of an instance; a row focuses its layer. */
function InstanceLayersSection({
  document,
  id,
  focus,
}: {
  document: DocumentV8;
  id: string;
  focus: InstanceFocus | null;
}) {
  const editor = useEditor();
  const rows = instanceLayers(document, id);
  if (rows.length === 0) return null;
  return (
    <Section legend="Layers">
      <div data-testid="instance-layers" style={{ display: 'flex', flexDirection: 'column' }}>
        {rows.map((row) => {
          const focused = focus?.instance === id && focus.layer === row.id;
          return (
            <button
              key={row.id}
              type="button"
              data-testid={`instance-layer-${row.id}`}
              data-overridden={row.overridden ? 'true' : undefined}
              aria-pressed={focused}
              aria-label={row.overridden ? `${row.name} (overridden)` : row.name}
              style={{ textAlign: 'left', paddingLeft: 4 + row.depth * 12 }}
              onClick={() => setInstanceFocus(editor, id, row.id)}
            >
              {row.name}
              {row.overridden ? ' •' : ''}
            </button>
          );
        })}
      </div>
    </Section>
  );
}

/**
 * V-37 section 6.2: the focused layer's controls: fill and stroke colour, opacity, visibility,
 * the effects list and "Reset". Each writes `setInstanceOverride`; opacity, visibility and
 * effects do not apply to the source itself (V37-S3).
 */
function LayerControlsSection({
  document,
  id,
  layer,
  run,
  runAction,
}: {
  document: DocumentV8;
  id: string;
  layer: string;
  run: Run;
  runAction: (action: PropertyAction) => void;
}) {
  const controls = layerControls(document, id, layer);
  if (controls === null) return null;
  const { node } = controls;
  const fillShown = fillOf(node);
  const strokeShown = 'stroke' in node ? node.stroke : null;
  const fill = fillText(fillShown);
  const strokeText = strokeShown === null ? '' : fillText(strokeShown.color);
  const identity = `${id}/${layer}`;
  const reset = resetLayerAction(id, layer);
  const setFill = (hex: string) => {
    const command = fillOverrideCommand(id, layer, fillShown, hex);
    return command !== null && run(command);
  };
  const setStroke = (hex: string) => {
    const command = strokeOverrideCommand(id, layer, strokeShown, hex);
    return command !== null && run(command);
  };
  // The effects rows build node-level effect commands; they become overrides of the layer.
  const effectRun: Run = (command) => {
    const override = effectOverrideCommand(id, layer, node.effects, command);
    return override !== null && run(override);
  };
  return (
    <>
      <Section legend="Layer overrides">
        <div role="group" aria-label={`Layer ${node.name}`} data-testid="layer-controls">
          <p style={{ margin: '0 0 4px' }}>{node.name}</p>
          {controls.fill && (
            <Row>
              <TextField
                identity={`${identity} ${fill ?? ''}`}
                label="Layer fill colour"
                value={fill}
                commit={setFill}
              />
              <ColorWell
                label="Layer fill colour picker"
                testId="layer-fill-picker"
                value={fill === null || fill === '' ? null : fill}
                commit={setFill}
              />
            </Row>
          )}
          {controls.stroke && (
            <Row>
              <TextField
                identity={`${identity} ${strokeText ?? ''}`}
                label="Layer stroke colour"
                value={strokeText}
                commit={setStroke}
              />
              <ColorWell
                label="Layer stroke colour picker"
                testId="layer-stroke-picker"
                value={strokeText === '' ? null : strokeText}
                commit={setStroke}
              />
            </Row>
          )}
          {controls.inner && (
            <Row>
              <TextField
                identity={`${identity} ${node.opacity}`}
                label="Layer opacity"
                value={opacityPercent(node.opacity)}
                commit={(text) => {
                  const command = opacityOverrideCommand(id, layer, text);
                  return command !== null && run(command);
                }}
              />
              <label>
                <input
                  type="checkbox"
                  aria-label="Layer visible"
                  checked={node.visible}
                  onChange={() => void run(visibleOverrideCommand(id, layer, node.visible))}
                />{' '}
                visible
              </label>
            </Row>
          )}
          <Row>
            <ActionButton action={reset} onRun={() => runAction(reset)} />
          </Row>
        </div>
      </Section>
      {controls.inner && (
        <EffectsSection document={document} nodes={[node]} run={effectRun} legend="Layer effects" />
      )}
    </>
  );
}

/**
 * V-37 sections 6.1 and 6.2: "Combine as variants", a set's properties, a variant's value
 * fields and, for the target instance (the one selected, or under the selected group's focus),
 * its Variant dropdowns, Layers list and focused layer controls.
 */
function VariantSections({
  document,
  selection,
  focus,
  run,
  runAction,
}: {
  document: DocumentV8;
  selection: readonly string[];
  focus: InstanceFocus | null;
  run: Run;
  runAction: (action: PropertyAction) => void;
}) {
  const combine = combineAction(document, selection);
  const set = selectedSet(document, selection);
  const target = targetInstance(document, selection, focus);
  const layer = target !== null && focus?.instance === target ? focus.layer : null;
  return (
    <>
      {combine !== null && (
        <Section legend="Component">
          <Row>
            <ActionButton action={combine} onRun={() => runAction(combine)} />
          </Row>
        </Section>
      )}
      {set !== null && <SetSection document={document} set={set} run={run} runAction={runAction} />}
      <VariantFieldsSection document={document} selection={selection} run={run} />
      {target !== null && !(selection.length === 1 && selection[0] === target) && (
        // A selected group: the focused instance inside it is shown as the target.
        <SymbolSection document={document} selection={[target]} runAction={runAction} />
      )}
      {target !== null && <InstanceVariantSection document={document} id={target} run={run} />}
      {target !== null && <InstanceLayersSection document={document} id={target} focus={focus} />}
      {target !== null && layer !== null && (
        <LayerControlsSection
          document={document}
          id={target}
          layer={layer}
          run={run}
          runAction={runAction}
        />
      )}
    </>
  );
}

/**
 * V-38 (contract, V38-U1): the layout grids of one selected frame or symbol: add a grid, columns
 * or rows, and per grid a visible checkbox, type, colour, opacity, its numbers and remove; each
 * edit is one `setNodeProps` of the whole list.
 */
function LayoutGridSection({ node, run }: { node: GridHolder; run: Run }) {
  const grids = node.layoutGrids ?? [];
  const send = (command: Command | null) => command !== null && run(command);
  return (
    <Section legend="Layout grid">
      <Row>
        {GRID_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            data-testid={`layout-grid-add-${type}`}
            onClick={() => void run(addGridCommand(node, type))}
          >
            + {type === 'grid' ? 'Grid' : type === 'columns' ? 'Columns' : 'Rows'}
          </button>
        ))}
      </Row>
      {grids.map((grid, index) => {
        const name = `Layout grid ${index + 1}`;
        const identity = `${node.id} ${index} ${JSON.stringify(grid)}`;
        const colour = colorHex(grid.color);
        return (
          <div
            key={index}
            role="group"
            aria-label={name}
            data-testid={`layout-grid-${index}`}
            data-type={grid.type}
            style={{ ...ROW_STYLE, marginBottom: 4 }}
          >
            <input
              type="checkbox"
              aria-label={`${name} visible`}
              data-testid={`layout-grid-${index}-visible`}
              checked={grid.visible}
              onChange={() => void send(toggleGridCommand(node, index))}
            />
            <Choice
              label={`${name} type`}
              value={grid.type}
              options={GRID_TYPES}
              onChange={(type) => void send(gridTypeCommand(node, index, type))}
            />
            {grid.type !== 'grid' && (
              <Choice
                label={`${name} alignment`}
                value={grid.align}
                options={GRID_ALIGNS}
                onChange={(align) => void send(gridAlignCommand(node, index, align))}
              />
            )}
            {gridNumberKeys(grid).map((key) => (
              <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <span aria-hidden="true" style={{ opacity: 0.6 }}>
                  {GRID_NUMBER_LABELS[key]}
                </span>
                <TextField
                  identity={identity}
                  label={`${name} ${GRID_NUMBER_LABELS[key].toLowerCase()}`}
                  value={gridNumberText(grid, key)}
                  commit={(text) => send(gridNumberCommand(node, index, key, text))}
                />
              </label>
            ))}
            <TextField
              identity={identity}
              label={`${name} colour`}
              value={colour}
              commit={(hex) => send(gridColorCommand(node, index, hex))}
            />
            <ColorWell
              label={`${name} colour picker`}
              testId={`layout-grid-${index}-colour-picker`}
              value={colour}
              commit={(hex) => send(gridColorCommand(node, index, hex))}
            />
            <TextField
              identity={identity}
              label={`${name} opacity`}
              value={gridOpacityText(grid)}
              commit={(text) => send(gridOpacityCommand(node, index, text))}
            />
            <button
              type="button"
              aria-label={`Remove ${name}`}
              title={`Remove ${name.toLowerCase()}`}
              data-testid={`layout-grid-${index}-remove`}
              onClick={() => void run(removeGridCommand(node, index))}
            >
              −
            </button>
          </div>
        );
      })}
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
  document: DocumentV8;
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
  const focus = useInstanceFocus();
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
  const gridHolder = layoutGridTarget(nodes);
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
      {gridHolder !== null && <LayoutGridSection node={gridHolder} run={run} />}
      <BooleanSection document={document} selection={selection} keymap={keymap} run={run} />
      <SymbolSection
        document={document}
        selection={selection}
        runAction={(action) => setStatus(refusalText(runPropertyAction(execute, action)))}
      />
      <VariantSections
        document={document}
        selection={selection}
        focus={focus}
        run={run}
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
