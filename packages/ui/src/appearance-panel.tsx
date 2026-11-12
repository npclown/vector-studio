import {
  useEditorCommands,
  useEditorSelector,
  type BlendMode,
  type Command,
  type ContainerBlendMode,
  type Fill,
  type NodeV8,
  type Paint,
  type Gradient,
  type Stroke,
  type StrokePatch,
  type StyleProps,
} from '@vector-studio/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  addStop,
  colorHex,
  common,
  dashPatch,
  dashText,
  idsTaking,
  isGradient,
  leadGradient,
  linearAngle,
  linearTransform,
  numberText,
  PANEL_MAX_STOPS,
  paintForKind,
  paintKind,
  parseDash,
  parseHex,
  parseNumber,
  radiiFor,
  removeStop,
  solidFromHex,
  strokeOf,
  styleCommand,
  toDegrees,
  toRadians,
  withSpread,
  withStop,
  type Common,
  type PaintKind,
} from './appearance-model.js';
import { ColorWell, Swatches } from './color-controls.js';
import { Choice, Row, TextField } from './fields.js';
import {
  addFillCommand,
  BLEND_GROUPS,
  blendCommand,
  blendCommon,
  blendLabel,
  fillHolders,
  fillView,
  modelIndex,
  moveFillCommand,
  offersPassThrough,
  PANEL_MAX_FILLS,
  parsePercent,
  percentText,
  removeFillCommand,
  replaceFillsCommand,
  rowPrefix,
  setFillCommand,
} from './fill-model.js';
import { countRender } from './render-probe.js';
import { RowBinding, type Binder, type BindRun } from './style-controls.js';
import { bindingState, tablesOfDocument } from './styles-model.js';

// MVP M8 contract, M8-R1 (M8-U5): the M4 appearance panel, moved from next-host's
// `src/m4-appearance-panel.tsx` with its behavior, roles, names and test IDs unchanged (M8-Q11
// (a)); its field controls are in fields.tsx. `layout` only chooses the outer box: the 17a2b0a
// aside (300 px wide, `maxHeight` 640, scrolling), which `?bench=1` keeps (M8-N5), or a section
// of the right column without its own size or scroller (M8-N3).
//
// M4-U4 (MVP M4 contract, section 8): the appearance panel beside the canvas. It acts on the
// selection through public commands only: one committed change is one `setStyle` command and one
// undo step. Text fields commit on Enter and blur, the opacity slider on `change`, with no live
// preview during a drag (M4-Q13 (a)); selects, the stroke checkbox and the buttons commit on
// their one action. Mixed values show as "mixed" and are replaced by the edited value. Invalid
// input marks the field `aria-invalid` and sends nothing. Every control is found by its role and
// its accessible name (`aria-label`).

/** Runs one `setStyle`; false when the editor refused it (the panel shows its code). */
type Commit = (style: StyleProps, ids?: readonly string[]) => boolean;

/**
 * The paint controls of the fill or the stroke paint: kind, then the colour and alpha of a solid,
 * or the stops, the linear angle and the spread of a gradient.
 */
function PaintControls({
  prefix,
  paints,
  kinds,
  write,
  binder,
  nodes,
}: {
  /** 'Fill', 'Stroke', or a fill row's 'Fill 2' and so on (labels use it, test IDs its slug). */
  prefix: string;
  /** The paints of the nodes the controls write. */
  paints: readonly (Paint | null)[];
  kinds: readonly PaintKind[];
  write: (paint: Paint | null) => boolean;
  /**
   * The style and variable binder (V-39 U2); absent for a lower fill row, since a `fill` binding
   * holds the top fill's paint (V-35 with V-39).
   */
  binder?: Binder;
  /** The nodes the controls write, in `paints` order (V-39 U2). */
  nodes: readonly NodeV8[];
}) {
  const kindValue = useMemo(() => {
    const values = new Set(paints.map(paintKind));
    return values.size === 1 ? [...values][0]! : null;
  }, [paints]);
  const sameText = (read: (paint: Paint | null) => string | null) => {
    const values = new Set(paints.map(read));
    return values.size === 1 ? [...values][0]! : null;
  };
  const lower = prefix.toLowerCase().replaceAll(' ', '-');
  const lead = leadGradient(paints);
  const kind = kindValue;
  const hexValue = sameText((paint) =>
    paint === null || isGradient(paint) ? null : colorHex(paint),
  );
  const bindingKey = prefix.startsWith('Fill') ? 'fill' : 'stroke';
  // U2: a row bound to one style or variable shows it in place of the hex and alpha fields.
  const bound =
    binder !== undefined && bindingState(binder.tables, nodes, bindingKey).state === 'one';
  return (
    <>
      <Row>
        <Choice
          label={`${prefix} type`}
          value={kind}
          options={kinds}
          onChange={(next) => {
            const first = paints.find((paint) => paint !== null) ?? null;
            void write(paintForKind(next, first));
          }}
        />
        {binder !== undefined && (
          <RowBinding
            binder={binder}
            nodes={nodes}
            bindingKey={bindingKey}
            label={`${prefix} style`}
            testId={lower}
            paint={paints.find((paint) => paint !== null) ?? null}
          />
        )}
      </Row>
      {kind === 'solid' && (
        <Row>
          <ColorWell
            label={`${prefix} colour picker`}
            testId={`${lower}-colour-picker`}
            value={hexValue}
            commit={(hex) => {
              const color = solidFromHex(hex, paints);
              return color !== null && write(color);
            }}
          />
          {!bound && (
            <>
              <TextField
                label={`${prefix} colour`}
                value={hexValue}
                commit={(text) => {
                  const first = paints.find((paint) => paint !== null && !isGradient(paint));
                  const alpha =
                    first !== undefined && first !== null && !isGradient(first) ? first.a : 1;
                  const color = parseHex(text, alpha);
                  if (color === null) return false;
                  return write(color);
                }}
              />
              <TextField
                label={`${prefix} alpha`}
                value={sameText((paint) =>
                  paint === null || isGradient(paint) ? null : numberText(paint.a),
                )}
                commit={(text) => {
                  const a = parseNumber(text, 0, 1);
                  const first = paints.find((paint) => paint !== null && !isGradient(paint));
                  if (a === null || first === undefined || first === null || isGradient(first))
                    return false;
                  return write({ ...first, a });
                }}
              />
            </>
          )}
        </Row>
      )}
      {!paints.some(isGradient) && (
        <Swatches
          name={prefix}
          testId={lower}
          current={kind === 'solid' ? hexValue : null}
          pick={(hex) => {
            const color = solidFromHex(hex, paints);
            if (color !== null) void write(color);
          }}
        />
      )}
      {(kind === 'linear' || kind === 'radial') && lead !== null && (
        <GradientControls
          prefix={prefix}
          lower={prefix.toLowerCase()}
          lead={lead}
          paints={paints}
          write={write}
        />
      )}
    </>
  );
}

function GradientControls({
  prefix,
  lower,
  lead,
  paints,
  write,
}: {
  prefix: string;
  lower: string;
  lead: Gradient;
  paints: readonly (Paint | null)[];
  write: (paint: Paint) => boolean;
}) {
  // A field shows its common value over the selected gradients, or mixed.
  const gradients = paints.filter(isGradient);
  const same = (read: (gradient: Gradient) => string) => {
    const values = new Set(gradients.map(read));
    return values.size === 1 ? [...values][0]! : null;
  };
  const sameCount = new Set(gradients.map((gradient) => gradient.stops.length)).size === 1;
  return (
    <>
      {sameCount &&
        lead.stops.map((stop, index) => {
          const n = index + 1;
          return (
            <Row key={index}>
              <TextField
                label={`${prefix} stop ${n} offset`}
                value={same((gradient) => numberText(gradient.stops[index]!.offset))}
                commit={(text) => {
                  const offset = parseNumber(text, 0, 1);
                  if (offset === null) return false;
                  return write(withStop(lead, index, { offset }));
                }}
              />
              <TextField
                label={`${prefix} stop ${n} colour`}
                value={same((gradient) => colorHex(gradient.stops[index]!.color))}
                commit={(text) => {
                  const color = parseHex(text, stop.color.a);
                  if (color === null) return false;
                  return write(withStop(lead, index, { color }));
                }}
              />
              <TextField
                label={`${prefix} stop ${n} alpha`}
                value={same((gradient) => numberText(gradient.stops[index]!.color.a))}
                commit={(text) => {
                  const a = parseNumber(text, 0, 1);
                  if (a === null) return false;
                  return write(withStop(lead, index, { color: { ...stop.color, a } }));
                }}
              />
              <button
                type="button"
                aria-label={`Remove ${lower} stop ${n}`}
                disabled={lead.stops.length <= 1}
                onClick={() => void write(removeStop(lead, index))}
              >
                −
              </button>
            </Row>
          );
        })}
      <Row>
        <button
          type="button"
          aria-label={`Add ${lower} stop`}
          disabled={lead.stops.length >= PANEL_MAX_STOPS}
          onClick={() => void write(addStop(lead))}
        >
          add stop
        </button>
        {lead.kind === 'linear' && (
          <TextField
            label={`${prefix} angle`}
            value={same((gradient) =>
              gradient.kind === 'linear'
                ? numberText(toDegrees(linearAngle(gradient.transform)))
                : '',
            )}
            commit={(text) => {
              const degrees = parseNumber(text);
              if (degrees === null) return false;
              return write({ ...lead, transform: linearTransform(toRadians(degrees)) });
            }}
          />
        )}
        <Choice
          label={`${prefix} spread`}
          value={same((gradient) => gradient.spread) as Gradient['spread'] | null}
          options={['pad', 'reflect', 'repeat'] as const}
          onChange={(spread) => void write(withSpread(lead, spread))}
        />
      </Row>
    </>
  );
}

/** The stroke controls (section 8): on and off, paint, width, cap, join, miter limit and dash. */
function StrokeControls({
  nodes,
  commit,
  binder,
}: {
  nodes: readonly NodeV8[];
  commit: Commit;
  binder: Binder;
}) {
  const takers = nodes.filter((node) => idsTaking([node], 'stroke').length > 0);
  const stroked = takers.filter((node) => strokeOf(node) !== null);
  const strokes = stroked.map((node) => strokeOf(node)!);
  const strokedIds = stroked.map((node) => node.id);
  const on = stroked.length === takers.length ? true : stroked.length === 0 ? false : null;
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current !== null) box.current.indeterminate = on === null;
  }, [on]);
  const patch = (value: StrokePatch) => commit({ stroke: value }, strokedIds);
  const same = (read: (stroke: Stroke) => string) => {
    const values = new Set(strokes.map(read));
    return values.size === 1 ? [...values][0]! : null;
  };
  const lead = strokes[0] ?? null;
  return (
    <fieldset>
      <legend>Stroke</legend>
      <Row>
        <label>
          <input
            ref={box}
            type="checkbox"
            aria-label="Stroke"
            checked={on === true}
            onChange={() => void commit({ stroke: on === true ? null : {} })}
          />{' '}
          stroke
        </label>
      </Row>
      {lead !== null && (
        <>
          <PaintControls
            prefix="Stroke"
            paints={strokes.map((stroke) => stroke.color)}
            kinds={['solid', 'linear', 'radial']}
            write={(paint) => paint !== null && patch({ color: paint })}
            binder={binder}
            nodes={stroked}
          />
          <Row>
            <TextField
              label="Stroke width"
              value={same((stroke) => numberText(stroke.width))}
              commit={(text) => {
                const width = parseNumber(text, 0);
                if (width === null) return false;
                return patch({ width });
              }}
            />
            <RowBinding
              binder={binder}
              nodes={stroked}
              bindingKey="strokeWidth"
              label="Stroke width variable"
              testId="stroke-width"
            />
            <Choice
              label="Stroke cap"
              value={same((stroke) => stroke.cap) as Stroke['cap'] | null}
              options={['butt', 'round', 'square'] as const}
              onChange={(cap) => patch({ cap })}
            />
            <Choice
              label="Stroke join"
              value={same((stroke) => stroke.join) as Stroke['join'] | null}
              options={['miter', 'round', 'bevel'] as const}
              onChange={(join) => patch({ join })}
            />
            <TextField
              label="Miter limit"
              value={same((stroke) => numberText(stroke.miterLimit))}
              commit={(text) => {
                const miterLimit = parseNumber(text, 1);
                if (miterLimit === null) return false;
                return patch({ miterLimit });
              }}
            />
          </Row>
          <Row>
            <TextField
              label="Dash pattern"
              value={same((stroke) => dashText(stroke.dash?.pattern ?? null))}
              commit={(text) => {
                const parsed = parseDash(text);
                if (parsed === null) return false;
                return patch(dashPatch(lead.dash, { pattern: parsed.pattern }));
              }}
            />
            <TextField
              label="Dash phase"
              value={same((stroke) => (stroke.dash === null ? '' : numberText(stroke.dash.phase)))}
              disabled={lead.dash === null}
              commit={(text) => {
                const phase = parseNumber(text);
                if (phase === null || lead.dash === null) return false;
                return patch(dashPatch(lead.dash, { phase }));
              }}
            />
          </Row>
        </>
      )}
    </fieldset>
  );
}

/** A blend-mode menu (V35-C3): optgroups in Figma's order; a mixed value shows a disabled "mixed". */
function BlendSelect({
  label,
  value,
  passThrough,
  testId,
  onChange,
}: {
  label: string;
  /** The shared mode, or null when mixed. */
  value: ContainerBlendMode | null;
  /** Whether `Pass through` is offered (containers only). */
  passThrough: boolean;
  testId?: string;
  onChange: (mode: ContainerBlendMode) => void;
}) {
  return (
    <select
      aria-label={label}
      data-testid={testId}
      data-mixed={value === null ? 'true' : undefined}
      value={value ?? ''}
      onChange={(event) => onChange(event.currentTarget.value as ContainerBlendMode)}
    >
      {value === null && (
        <option value="" disabled>
          mixed
        </option>
      )}
      {passThrough && <option value="passThrough">{blendLabel('passThrough')}</option>}
      {BLEND_GROUPS.map((group) =>
        group.label === 'Normal' ? (
          <option key={group.label} value="normal">
            {blendLabel('normal')}
          </option>
        ) : (
          <optgroup key={group.label} label={group.label}>
            {group.modes.map((mode) => (
              <option key={mode} value={mode}>
                {blendLabel(mode)}
              </option>
            ))}
          </optgroup>
        ),
      )}
    </select>
  );
}

/**
 * One row of the fill list (V35-C2): visibility, paint (swatch and editor), opacity in percent,
 * blend mode, move up and down, and remove. `position` is the display position, 0 on top.
 */
function FillRow({
  nodes,
  fills,
  position,
  run,
  binder,
}: {
  nodes: readonly NodeV8[];
  fills: readonly Fill[];
  position: number;
  run: (command: Command | null) => boolean;
  binder?: Binder;
}) {
  const index = modelIndex(fills.length, position);
  const fill = fills[index]!;
  const prefix = rowPrefix(position);
  const lower = prefix.toLowerCase();
  return (
    <div role="group" aria-label={`Fill ${position + 1}`} data-testid={`fill-row-${position}`}>
      <Row>
        <label>
          <input
            type="checkbox"
            aria-label={`${prefix} visible`}
            data-testid={`fill-${position}-visible`}
            checked={fill.visible}
            onChange={() => void run(setFillCommand(nodes, index, { visible: !fill.visible }))}
          />{' '}
          visible
        </label>
        <TextField
          label={`${prefix} opacity`}
          value={percentText(fill.opacity)}
          commit={(text) => {
            const opacity = parsePercent(text);
            return opacity !== null && run(setFillCommand(nodes, index, { opacity }));
          }}
        />
        <span>%</span>
        <BlendSelect
          label={`${prefix} blend mode`}
          testId={`fill-${position}-blend`}
          value={fill.blendMode}
          passThrough={false}
          onChange={(mode) =>
            void run(setFillCommand(nodes, index, { blendMode: mode as BlendMode }))
          }
        />
        <button
          type="button"
          aria-label={`Move ${lower} up`}
          data-testid={`fill-${position}-up`}
          disabled={position === 0}
          onClick={() => void run(moveFillCommand(nodes, fills.length, position, 'up'))}
        >
          ↑
        </button>
        <button
          type="button"
          aria-label={`Move ${lower} down`}
          data-testid={`fill-${position}-down`}
          disabled={position === fills.length - 1}
          onClick={() => void run(moveFillCommand(nodes, fills.length, position, 'down'))}
        >
          ↓
        </button>
        <button
          type="button"
          aria-label={`Remove ${lower}`}
          data-testid={`fill-${position}-remove`}
          onClick={() => void run(removeFillCommand(nodes, index))}
        >
          −
        </button>
      </Row>
      <PaintControls
        prefix={prefix}
        paints={[fill.paint]}
        kinds={['none', 'solid', 'linear', 'radial']}
        // "none" removes the fill (a fill always has a paint); any other kind patches its paint.
        write={(paint) =>
          run(
            paint === null
              ? removeFillCommand(nodes, index)
              : setFillCommand(nodes, index, { paint }),
          )
        }
        nodes={nodes}
        {...(binder === undefined ? {} : { binder })}
      />
    </div>
  );
}

/**
 * The Fill section (V35-C2): the fills top first, with `+` to add and a row each; "Mixed" when
 * the selected nodes' fills differ, where `+` replaces every selected node's fills by one fill.
 * A node with no fill keeps the single "none" paint control, which makes its first fill.
 */
function FillSection({
  nodes,
  run,
  commit,
  binder,
}: {
  nodes: readonly NodeV8[];
  run: (command: Command | null) => boolean;
  commit: Commit;
  binder: Binder;
}) {
  const holders = fillHolders(nodes);
  const view = fillView(holders);
  const full = view.state === 'list' && view.fills.length >= PANEL_MAX_FILLS;
  return (
    <fieldset>
      <legend>Fill</legend>
      <Row>
        <button
          type="button"
          aria-label="Add fill"
          title={view.state === 'mixed' ? 'Replace the fills by one fill' : 'Add a fill'}
          aria-description={
            view.state === 'mixed' ? "Replaces every selected node's fills by one fill" : undefined
          }
          data-testid="fill-add"
          disabled={full}
          onClick={() =>
            void run(
              view.state === 'mixed' ? replaceFillsCommand(holders) : addFillCommand(holders),
            )
          }
        >
          +
        </button>
      </Row>
      {view.state === 'mixed' ? (
        <p data-testid="fill-mixed" style={{ margin: '4px 0' }}>
          Mixed <small>(+ replaces the fills by one fill)</small>
        </p>
      ) : view.state === 'single' ? (
        <PaintControls
          prefix="Fill"
          paints={holders.map((node) => node.fills.at(-1)?.paint ?? null)}
          kinds={['none', 'solid', 'linear', 'radial']}
          // Each node's one fill takes the paint (its opacity and mode kept); a node without a
          // fill, or "none", goes through `setStyle { fill }`.
          write={(paint) =>
            paint !== null && holders.every((node) => node.fills.length === 1)
              ? run(setFillCommand(holders, 0, { paint }))
              : commit({ fill: paint })
          }
          binder={binder}
          nodes={holders}
        />
      ) : view.fills.length === 0 ? (
        <PaintControls
          prefix="Fill"
          paints={[null]}
          kinds={['none', 'solid', 'linear', 'radial']}
          write={(fill) => commit({ fill })}
          binder={binder}
          nodes={holders}
        />
      ) : (
        [...view.fills].reverse().map((_, position) => (
          <FillRow
            key={position}
            nodes={holders}
            fills={view.fills}
            position={position}
            run={run}
            // V-39: the top row binds the `fill` binding (the top fill's paint).
            {...(position === 0 ? { binder } : {})}
          />
        ))
      )}
    </fieldset>
  );
}

/** Opacity as a slider that commits on its `change` event only (no live preview, M4-Q13 (a)). */
function OpacitySlider({
  value,
  commit,
  binder,
  nodes,
}: {
  value: Common<number>;
  commit: Commit;
  binder: Binder;
  nodes: readonly NodeV8[];
}) {
  const slider = useRef<HTMLInputElement>(null);
  const shown = value.state === 'one' ? value.value : 1;
  const latest = useRef(commit);
  latest.current = commit;
  useEffect(() => {
    const element = slider.current;
    if (element === null) return;
    // React's onChange on a range input follows `input`; the commit listens to `change` itself.
    const changed = () => {
      const opacity = Number(element.value);
      if (Number.isFinite(opacity)) void latest.current({ opacity });
    };
    element.addEventListener('change', changed);
    return () => element.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    if (slider.current !== null) slider.current.value = String(shown);
  }, [shown]);
  return (
    <Row>
      <input
        ref={slider}
        type="range"
        aria-label="Opacity"
        aria-valuetext={value.state === 'mixed' ? 'mixed' : numberText(shown)}
        data-mixed={value.state === 'mixed' ? 'true' : undefined}
        min={0}
        max={1}
        step={0.01}
        defaultValue={shown}
      />
      <output aria-label="Opacity value">
        {value.state === 'mixed' ? 'mixed' : numberText(shown)}
      </output>
      <RowBinding
        binder={binder}
        nodes={nodes}
        bindingKey="opacity"
        label="Opacity variable"
        testId="opacity"
      />
    </Row>
  );
}

const CORNERS = ['top left', 'top right', 'bottom right', 'bottom left'] as const;

function RadiiControls({
  nodes,
  commit,
  binder,
}: {
  nodes: readonly NodeV8[];
  commit: Commit;
  binder: Binder;
}) {
  const [linked, setLinked] = useState(true);
  const rectangles = nodes.filter((node) => node.type === 'rectangle');
  const lead = rectangles[0]!.cornerRadii;
  return (
    <fieldset>
      <legend>Corner radii</legend>
      <Row>
        <button
          type="button"
          aria-label="Link corner radii"
          aria-pressed={linked}
          onClick={() => setLinked((value) => !value)}
        >
          link
        </button>
        {CORNERS.map((corner, index) => {
          const values = new Set(rectangles.map((node) => node.cornerRadii[index]!));
          return (
            <TextField
              key={corner}
              label={`Corner radius ${corner}`}
              value={values.size === 1 ? numberText([...values][0]!) : null}
              commit={(text) => {
                const radius = parseNumber(text, 0);
                if (radius === null) return false;
                return commit({ cornerRadii: radiiFor(lead, index, radius, linked) });
              }}
            />
          );
        })}
        <RowBinding
          binder={binder}
          nodes={rectangles}
          bindingKey="cornerRadius"
          label="Corner radius variable"
          testId="corner-radius"
        />
      </Row>
    </fieldset>
  );
}

/** Props of `AppearancePanel` (MVP M8 contract, M8-R1). */
export type AppearancePanelProps = Readonly<{
  /**
   * The outer box: `'aside'` (the default) is next-host's 17a2b0a panel, 300 px wide with
   * `maxHeight` 640 and its own vertical scroller, as `?bench=1` keeps it (M8-N5); `'section'`
   * fills its container's width with neither, for the right column that scrolls itself (M8-N3).
   */
  layout?: 'aside' | 'section';
}>;

/** The aside's 17a2b0a style, and the right column's section style (M8-N3, M8-N5). */
const ASIDE_STYLE = { width: 300, maxHeight: 640, overflowY: 'auto', fontSize: 13 } as const;
const SECTION_STYLE = { fontSize: 13 } as const;

/**
 * The appearance panel (MVP M8 contract, M8-R1; M4 contract, section 8), the `complementary`
 * landmark named "Appearance" (test ID `appearance-panel`): fill, stroke, opacity and corner
 * radii of the selection, each section shown when some selected node takes its key. One
 * committed edit is one `setStyle` command over the selected nodes (one undo step); text fields
 * commit on Enter and blur, the opacity slider on `change`; a mixed value shows "mixed"; input
 * that cannot be a value marks the field `aria-invalid` and sends nothing; a refused command
 * shows its code (`appearance-error`).
 */
export function AppearancePanel({ layout = 'aside' }: AppearancePanelProps) {
  countRender(layout === 'aside' ? 'aside' : 'appearance');
  const execute = useEditorCommands();
  const selection = useEditorSelector((snapshot) => snapshot.selection);
  const content = useEditorSelector((snapshot) => snapshot.document);
  const nodes = useMemo(
    () =>
      selection.flatMap((id) =>
        Object.hasOwn(content.nodes, id) ? [content.nodes[id] as NodeV8] : [],
      ),
    [selection, content],
  );
  const [status, setStatus] = useState('');
  const commit: Commit = (style, ids = selection) => {
    if (ids.length === 0) return false;
    const result = execute(styleCommand(ids, style));
    setStatus(result.ok ? '' : `${result.code} ${result.path ?? ''}`.trimEnd());
    return result.ok;
  };
  const tables = useMemo(() => tablesOfDocument(content), [content]);
  const run: BindRun = (command) => {
    const result = execute(command);
    setStatus(result.ok ? '' : `${result.code} ${result.path ?? ''}`.trimEnd());
    return result.ok ? { ok: true, ids: result.ids } : { ok: false, ids: [] };
  };
  const binder: Binder = { tables, run };
  const runCommand = (command: Command | null): boolean => {
    if (command === null) return false;
    const result = execute(command);
    setStatus(result.ok ? '' : `${result.code} ${result.path ?? ''}`.trimEnd());
    return result.ok;
  };
  const blend = blendCommon(nodes);
  const fillTakers = nodes.filter((node) => idsTaking([node], 'fill').length > 0);
  const opacity = common(nodes, 'opacity', (node) => node.opacity);
  return (
    <aside
      aria-label="Appearance"
      data-testid="appearance-panel"
      style={layout === 'aside' ? ASIDE_STYLE : SECTION_STYLE}
    >
      {nodes.length === 0 ? (
        <p>no selection</p>
      ) : (
        <>
          {fillTakers.length > 0 && (
            <FillSection nodes={nodes} run={runCommand} commit={commit} binder={binder} />
          )}
          {nodes.some((node) => idsTaking([node], 'stroke').length > 0) && (
            <StrokeControls nodes={nodes} commit={commit} binder={binder} />
          )}
          <fieldset>
            <legend>Layer</legend>
            <OpacitySlider value={opacity} commit={commit} binder={binder} nodes={nodes} />
            <Row>
              <BlendSelect
                label="Blend mode"
                testId="layer-blend"
                value={blend.state === 'one' ? blend.value : null}
                passThrough={offersPassThrough(nodes)}
                onChange={(mode) => void runCommand(blendCommand(nodes, mode))}
              />
            </Row>
          </fieldset>
          {nodes.some((node) => node.type === 'rectangle') && (
            <RadiiControls nodes={nodes} commit={commit} binder={binder} />
          )}
        </>
      )}
      {status !== '' && (
        <p data-testid="appearance-error" role="status" style={{ color: '#b00' }}>
          {status}
        </p>
      )}
    </aside>
  );
}
