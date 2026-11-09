import {
  extensionCommand,
  useEditorCommands,
  useNode,
  useSelection,
  type Command,
  type CommandResult,
  type NodeV7,
  type PanelContribution,
  type StarCreateArgs,
  type UiExtension,
} from '@vector-studio/ui';
import { useState, type KeyboardEvent } from 'react';

// MVP M8 contract, M8-N2 (M8-U6, M8-Q13 (a)): the sample extension panel of `ext.star`. It
// imports `@vector-studio/ui` and `react` only (checked by the M8-B3 public-import check in
// `tooling/boundary-policy.mjs` and by tests/unit/m8-u6-next-host.test.ts), so it reads and writes
// through the public hooks and commands alone (M8-P4). One selected star shows its points and
// inner ratio, each committed on Enter or blur through one `setNodeProps data` (one undo step);
// input the star extension would refuse marks the field `aria-invalid` and sends nothing. "Create
// star" runs `ext.star.create` through the typed builder (M8-X2) and selects the new star.

/** The typed `ext.star.create` builder (M8-X2). */
export const CREATE_STAR = extensionCommand<StarCreateArgs>('ext.star.create');
/** Where "Create star" puts its star; the host's `star` button keeps its own frame. */
export const PANEL_STAR_FRAME = { x: 120, y: 120, width: 120, height: 120 } as const;

/** A star's data as the `ext.star` extension stores it. */
export type StarData = Readonly<{ points: number; innerRatio: number }>;
/** A star panel field. */
export type StarField = 'points' | 'innerRatio';

/** The data of a node that is an `ext.star` star, else null. */
export function starData(node: NodeV7 | null): StarData | null {
  if (node === null || node.type !== 'custom' || node.customType !== 'ext.star') return null;
  const data = node.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const { points, innerRatio } = data as Record<string, unknown>;
  return typeof points === 'number' && typeof innerRatio === 'number'
    ? { points, innerRatio }
    : null;
}

/**
 * The command for one committed field: null when the text is unchanged, invalid when the star
 * extension's validator would refuse it (points an integer from 3 to 32, inner ratio in (0, 1)).
 */
export function starFieldEdit(
  id: string,
  data: StarData,
  field: StarField,
  text: string,
): Readonly<{ invalid: boolean; command: Command | null }> {
  const trimmed = text.trim();
  const value = trimmed === '' ? Number.NaN : Number(trimmed);
  const valid =
    field === 'points'
      ? Number.isInteger(value) && value >= 3 && value <= 32
      : Number.isFinite(value) && value > 0 && value < 1;
  if (!valid) return { invalid: true, command: null };
  if (value === data[field]) return { invalid: false, command: null };
  return {
    invalid: false,
    command: { type: 'setNodeProps', id, props: { data: { ...data, [field]: value } } },
  };
}

const LABELS: Readonly<Record<StarField, string>> = { points: 'Points', innerRatio: 'Inner ratio' };
const ROW = { display: 'flex', gap: 8, alignItems: 'center' } as const;

function StarFieldInput({
  id,
  data,
  field,
  onResult,
}: Readonly<{
  id: string;
  data: StarData;
  field: StarField;
  onResult: (result: CommandResult) => void;
}>) {
  const execute = useEditorCommands();
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const commit = () => {
    if (draft === null) return;
    const edit = starFieldEdit(id, data, field, draft);
    if (edit.invalid) {
      setInvalid(true);
      return;
    }
    setDraft(null);
    setInvalid(false);
    if (edit.command !== null) onResult(execute(edit.command));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') commit();
  };
  return (
    <label style={ROW}>
      {LABELS[field]}
      <input
        type="text"
        aria-label={LABELS[field]}
        aria-invalid={invalid}
        size={6}
        value={draft ?? String(data[field])}
        onChange={(event) => {
          setDraft(event.target.value);
          setInvalid(false);
        }}
        onKeyDown={onKeyDown}
        onBlur={commit}
      />
    </label>
  );
}

/** The `ext.star` panel body (M8-N2); a panel component takes no props (M8-P4). */
export function StarPanel() {
  const execute = useEditorCommands();
  const selection = useSelection();
  const node = useNode(selection.length === 1 ? selection[0]! : '');
  const data = selection.length === 1 ? starData(node) : null;
  const [refusal, setRefusal] = useState('');
  const show = (result: CommandResult) =>
    setRefusal(result.ok ? '' : `${result.code} ${result.path ?? ''}`.trimEnd());
  const create = () => {
    const result = execute(CREATE_STAR.command({ frame: { ...PANEL_STAR_FRAME } }));
    show(result);
    if (result.ok) execute({ type: 'setSelection', ids: result.ids });
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
      <button type="button" onClick={create}>
        Create star
      </button>
      {data === null || node === null ? (
        <p style={{ margin: 0 }}>select one star</p>
      ) : (
        // Keyed by node, so a draft does not carry over to another star.
        <div key={node.id} role="group" aria-label="star" style={ROW}>
          <StarFieldInput id={node.id} data={data} field="points" onResult={show} />
          <StarFieldInput id={node.id} data={data} field="innerRatio" onResult={show} />
        </div>
      )}
      {refusal !== '' && (
        <p role="status" data-testid="star-refusal" style={{ margin: 0, color: '#b00' }}>
          {refusal}
        </p>
      )}
    </div>
  );
}

/** The star panel's contribution, owned by `ext.star` (M8-P2). */
export const STAR_PANEL: PanelContribution = Object.freeze({
  id: 'ext.star',
  title: 'Star',
  component: StarPanel,
});

/** The host's UI extension for `ext.star`, passed to `PanelProvider` (M8-P1). */
export const starUiExtension: UiExtension = Object.freeze({
  extension: 'ext.star',
  panels: Object.freeze([STAR_PANEL]),
});
