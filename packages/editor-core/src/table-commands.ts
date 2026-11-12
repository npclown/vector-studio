import {
  BINDING_KEYS,
  MAX_COLOR_STYLES,
  MAX_TABLE_NAME_LENGTH,
  MAX_VARIABLE_MODES,
  MAX_VARIABLES,
  bindingKeyAllowed,
  bindingRange,
  bindingRangeFits,
  bindingTarget,
  bindingTypeFits,
  isColor,
  isValidId,
  isValidRunText,
  bindingHolds,
  resolvedValue,
  validatePaint,
  withBoundValue,
  type BindingKey,
  type BindingRef,
  type BindingTables,
  type Bindings,
  type Color,
  type ColorStyle,
  type DocumentV8,
  type NodeV8,
  type Variable,
} from '@vector-studio/model';
import { Draft, fail, type Failure } from './draft.js';
import {
  drawIds,
  freshId,
  success,
  uniqueIds,
  type EditContext,
  type EditResult,
} from './edit-support.js';
import { documentTree, pageOf } from './tree.js';
import type { DocumentCommand } from './types.js';

// V-39 contract (docs/plans/viz-v39-styles-variables-contract.md), section 3: the colour style,
// variable, mode and binding commands. Each runs in an edit draft; a change of a style's paint,
// a variable's value or the active mode rewrites every bound node (E1 resync), and the draft's
// finish then drops bindings that no longer hold (E4).

export type TableCommand = Extract<
  DocumentCommand,
  {
    type:
      | 'createColorStyle'
      | 'updateColorStyle'
      | 'removeColorStyle'
      | 'createVariable'
      | 'updateVariable'
      | 'removeVariable'
      | 'addVariableMode'
      | 'renameVariableMode'
      | 'removeVariableMode'
      | 'setVariableMode'
      | 'bindProperty';
  }
>;

export const TABLE_COMMANDS: ReadonlySet<string> = new Set([
  'createColorStyle',
  'updateColorStyle',
  'removeColorStyle',
  'createVariable',
  'updateVariable',
  'removeVariable',
  'addVariableMode',
  'renameVariableMode',
  'removeVariableMode',
  'setVariableMode',
  'bindProperty',
]);

type Finish = (draft: Draft) => DocumentV8 | Failure;
type DefaultStroke = (node: NodeV8) => Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TABLE_NAME_LENGTH &&
    isValidRunText(value)
  );
}

/** A colour (exactly `r, g, b, a` in range) or null. */
function validColor(value: unknown): Color | null {
  const paint = validatePaint(value);
  return paint !== null && isColor(paint) ? paint : null;
}

function validNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value + 0 : null;
}

/** A variable value of `kind`, normalized, or null. */
function validValue(kind: Variable['type'], value: unknown): Color | number | null {
  return kind === 'color' ? validColor(value) : validNumber(value);
}

/** The bindings with `key` set to `ref` (or removed), in BINDING_KEYS order; undefined if none. */
function withBinding(
  bindings: Bindings | undefined,
  key: BindingKey,
  ref: BindingRef | null,
): Bindings | undefined {
  const out: Partial<Record<BindingKey, BindingRef>> = {};
  for (const name of BINDING_KEYS) {
    const value = name === key ? ref : (bindings?.[name] ?? null);
    if (value !== null) out[name] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function setBindings(node: NodeV8, bindings: Bindings | undefined): NodeV8 {
  const { bindings: _old, ...rest } = node;
  void _old;
  return bindings === undefined ? rest : { ...rest, bindings };
}

/**
 * E1: rewrites every bound property to its resolved value against the draft's tables; a binding
 * whose target is gone or no longer fits is dropped (V39-Q7). Returns the IDs it changed.
 */
function resync(draft: Draft, defaultStroke: DefaultStroke): void {
  const tables = draft.tables;
  for (const id of draft.nodeIds()) {
    const node = draft.node(id)!;
    if (node.bindings === undefined) continue;
    let next: NodeV8 = node;
    for (const key of BINDING_KEYS) {
      const ref = node.bindings[key];
      // Untouched when it still holds (review r1 nit 7): no new object, no touched ID.
      if (ref === undefined || bindingHolds(next, key, ref, tables)) continue;
      const target = bindingTarget(tables, ref);
      const value =
        target === null || !bindingTypeFits(target, key)
          ? undefined
          : resolvedValue(target, tables.variables?.mode);
      const rewritten =
        value === undefined ? null : withBoundValue(next, key, value, defaultStroke);
      next =
        rewritten === null ? setBindings(next, withBinding(next.bindings, key, null)) : rewritten;
    }
    if (next !== node) draft.set(next);
  }
}

/** Every node of the draft whose binding names `ref`, with its keys. */
function users(draft: Draft, matches: (ref: BindingRef) => boolean): [NodeV8, BindingKey[]][] {
  const out: [NodeV8, BindingKey[]][] = [];
  for (const id of draft.nodeIds()) {
    const node = draft.node(id)!;
    if (node.bindings === undefined) continue;
    const keys = BINDING_KEYS.filter((key) => {
      const ref = node.bindings![key];
      return ref !== undefined && matches(ref);
    });
    if (keys.length > 0) out.push([node, keys]);
  }
  return out;
}

const styleRef = (id: string) => (ref: BindingRef) => 'style' in ref && ref.style === id;
const variableRef = (id: string) => (ref: BindingRef) => 'variable' in ref && ref.variable === id;

function done(document: DocumentV8, draft: Draft, finish: Finish, ids: readonly string[] = []) {
  const result = success(finish(draft), draft, []);
  if (!result.ok) return result;
  return { ...result, ids, document: same(document, result.document) };
}

/** The base document when nothing changed, so the editor records no step. */
function same(base: DocumentV8, next: DocumentV8): DocumentV8 {
  return JSON.stringify(base) === JSON.stringify(next) ? base : next;
}

export function tableCommand(
  document: DocumentV8,
  command: TableCommand,
  context: EditContext,
  finish: Finish,
  defaultStroke: DefaultStroke,
): EditResult {
  const draft = new Draft(document);
  const tables = draft.tables;
  const styles = tables.colorStyles ?? [];
  const set = tables.variables;
  const fresh = (): string | Failure =>
    freshId(document, context.ids) ?? fail('editor.duplicate-id');
  switch (command.type) {
    case 'createColorStyle': {
      if (!validName(command.name)) return fail('editor.invalid-command', '/name');
      const paint = validatePaint(command.paint);
      if (paint === null) return fail('editor.invalid-command', '/paint');
      if (styles.length >= MAX_COLOR_STYLES) return fail('editor.table-limit');
      const id = fresh();
      if (typeof id !== 'string') return id;
      draft.setTables({ ...tables, colorStyles: [...styles, { id, name: command.name, paint }] });
      return done(document, draft, finish, [id]);
    }
    case 'updateColorStyle': {
      if (command.name !== undefined && !validName(command.name)) {
        return fail('editor.invalid-command', '/name');
      }
      const paint = command.paint === undefined ? undefined : validatePaint(command.paint);
      if (paint === null) return fail('editor.invalid-command', '/paint');
      const index = styles.findIndex((style) => style.id === command.id);
      if (index < 0) return fail('editor.unknown-style');
      // B2: a gradient cannot recolour a text binding.
      if (
        paint !== undefined &&
        !isColor(paint) &&
        users(draft, styleRef(command.id)).some(([, keys]) => keys.includes('text'))
      ) {
        return fail('editor.binding-type');
      }
      const style = styles[index]!;
      const next: ColorStyle = {
        id: style.id,
        name: command.name ?? style.name,
        paint: paint ?? style.paint,
      };
      draft.setTables({ ...tables, colorStyles: styles.map((s, i) => (i === index ? next : s)) });
      resync(draft, defaultStroke);
      return done(document, draft, finish);
    }
    case 'removeColorStyle': {
      const remaining = styles.filter((style) => style.id !== command.id);
      if (remaining.length === styles.length) return fail('editor.unknown-style');
      const { colorStyles: _old, ...rest } = tables;
      void _old;
      draft.setTables(remaining.length === 0 ? rest : { ...rest, colorStyles: remaining });
      resync(draft, defaultStroke);
      return done(document, draft, finish);
    }
    case 'createVariable': {
      if (!validName(command.name)) return fail('editor.invalid-command', '/name');
      const kind = command.kind;
      if (kind !== 'color' && kind !== 'number') return fail('editor.invalid-command', '/kind');
      const value = validValue(kind, command.value);
      if (value === null) return fail('editor.invalid-command', '/value');
      if ((set?.items.length ?? 0) >= MAX_VARIABLES) return fail('editor.table-limit');
      // The mode (when the set is new) and the variable in one draw, so they differ.
      const drawn = drawIds(document, context.ids, set === undefined ? 2 : 1);
      if (drawn === null) return fail('editor.duplicate-id');
      const id = drawn[drawn.length - 1]!;
      const modes = set?.modes ?? [{ id: drawn[0]!, name: 'Mode 1' }];
      const mode = set?.mode ?? drawn[0]!;
      const values = Object.fromEntries(modes.map((entry) => [entry.id, value]));
      const variable = { id, name: command.name, type: kind, values } as Variable;
      draft.setTables({
        ...tables,
        variables: { modes, mode, items: [...(set?.items ?? []), variable] },
      });
      return done(document, draft, finish, [id]);
    }
    case 'updateVariable': {
      if (command.name !== undefined && !validName(command.name)) {
        return fail('editor.invalid-command', '/name');
      }
      const values: unknown = command.values;
      if (values !== undefined && !isRecord(values)) {
        return fail('editor.invalid-command', '/values');
      }
      const index = set?.items.findIndex((item) => item.id === command.id) ?? -1;
      if (set === undefined || index < 0) return fail('editor.unknown-variable');
      const variable = set.items[index]!;
      const merged: Record<string, Color | number> = { ...variable.values };
      const entries = Object.entries(values ?? {});
      // E3: every malformed value before an unknown mode key.
      const checked = entries.map(([key, raw]) => [key, validValue(variable.type, raw)] as const);
      const bad = checked.find(([, value]) => value === null);
      if (bad !== undefined)
        return fail(
          'editor.invalid-command',
          `/values/${bad[0].replaceAll('~', '~0').replaceAll('/', '~1')}`,
        );
      for (const [key, value] of checked) {
        if (!Object.hasOwn(merged, key)) return fail('editor.unknown-mode');
        merged[key] = value!;
      }
      const next = {
        ...variable,
        name: command.name ?? variable.name,
        values: merged,
      } as Variable;
      // E3: every mode's value in the range of every property bound to it.
      for (const [, keys] of users(draft, variableRef(variable.id))) {
        for (const key of keys) {
          if (!bindingRangeFits({ kind: 'variable', variable: next }, key)) {
            return fail('editor.binding-range');
          }
        }
      }
      const items = set.items.map((item, i) => (i === index ? next : item));
      draft.setTables({ ...tables, variables: { ...set, items } });
      resync(draft, defaultStroke);
      return done(document, draft, finish);
    }
    case 'removeVariable': {
      if (set === undefined || !set.items.some((item) => item.id === command.id)) {
        return fail('editor.unknown-variable');
      }
      const items = set.items.filter((item) => item.id !== command.id);
      const { variables: _old, ...rest } = tables;
      void _old;
      draft.setTables(items.length === 0 ? rest : { ...rest, variables: { ...set, items } });
      resync(draft, defaultStroke);
      return done(document, draft, finish);
    }
    case 'addVariableMode': {
      if (!validName(command.name)) return fail('editor.invalid-command', '/name');
      if (set === undefined) return fail('editor.unknown-mode');
      if (set.modes.length >= MAX_VARIABLE_MODES) return fail('editor.table-limit');
      const id = fresh();
      if (typeof id !== 'string') return id;
      const items = set.items.map(
        (item) =>
          ({ ...item, values: { ...item.values, [id]: item.values[set.mode]! } }) as Variable,
      );
      draft.setTables({
        ...tables,
        variables: { ...set, modes: [...set.modes, { id, name: command.name }], items },
      });
      return done(document, draft, finish, [id]);
    }
    case 'renameVariableMode': {
      if (!validName(command.name)) return fail('editor.invalid-command', '/name');
      if (set === undefined || !set.modes.some((mode) => mode.id === command.id)) {
        return fail('editor.unknown-mode');
      }
      const modes = set.modes.map((mode) =>
        mode.id === command.id ? { id: mode.id, name: command.name } : mode,
      );
      draft.setTables({ ...tables, variables: { ...set, modes } });
      return done(document, draft, finish);
    }
    case 'removeVariableMode': {
      if (set === undefined || !set.modes.some((mode) => mode.id === command.id)) {
        return fail('editor.unknown-mode');
      }
      if (set.modes.length === 1) return fail('editor.last-mode');
      const modes = set.modes.filter((mode) => mode.id !== command.id);
      const items = set.items.map((item) => {
        const { [command.id]: _old, ...values } = item.values as Record<string, Color | number>;
        void _old;
        return { ...item, values } as Variable;
      });
      const mode = set.mode === command.id ? modes[0]!.id : set.mode;
      draft.setTables({ ...tables, variables: { modes, mode, items } });
      resync(draft, defaultStroke);
      return done(document, draft, finish);
    }
    case 'setVariableMode': {
      if (set === undefined || !set.modes.some((mode) => mode.id === command.id)) {
        return fail('editor.unknown-mode');
      }
      draft.setTables({ ...tables, variables: { ...set, mode: command.id } });
      resync(draft, defaultStroke);
      return done(document, draft, finish);
    }
    case 'bindProperty':
      return bindProperty(document, draft, command, context, finish, defaultStroke);
  }
}

function bindProperty(
  document: DocumentV8,
  draft: Draft,
  command: Extract<TableCommand, { type: 'bindProperty' }>,
  context: EditContext,
  finish: Finish,
  defaultStroke: DefaultStroke,
): EditResult {
  const ids = uniqueIds(command.ids);
  if (ids === null || ids.length === 0) return fail('editor.invalid-command', '/ids');
  const key = command.key;
  if (!(BINDING_KEYS as readonly unknown[]).includes(key)) {
    return fail('editor.invalid-command', '/key');
  }
  const ref: unknown = command.ref;
  const shaped =
    ref === null ||
    (isRecord(ref) &&
      Object.keys(ref).length === 1 &&
      ((typeof ref.style === 'string' && isValidId(ref.style)) ||
        (typeof ref.variable === 'string' && isValidId(ref.variable))));
  if (!shaped) return fail('editor.invalid-command', '/ref');
  const tree = documentTree(document);
  if (
    ids.some((id) => !Object.hasOwn(document.nodes, id) || pageOf(tree, id) !== context.activePage)
  ) {
    return fail('editor.unknown-node');
  }
  const nodes = ids.map((id) => document.nodes[id]!);
  const carriers = nodes.filter(
    (node) =>
      bindingKeyAllowed(node.type, key) &&
      (key !== 'strokeWidth' || (node as { stroke?: unknown }).stroke != null),
  );
  if (carriers.length === 0) return fail('editor.invalid-command', '/key');
  const changed: string[] = [];
  if (ref === null) {
    for (const node of carriers) {
      if (node.bindings?.[key] === undefined) continue;
      draft.setChecked(setBindings(node, withBinding(node.bindings, key, null)));
      changed.push(node.id);
    }
    return done(document, draft, finish, changed);
  }
  const reference = ref as BindingRef;
  const tables: BindingTables = draft.tables;
  const target = bindingTarget(tables, reference);
  if (target === null) {
    return fail('style' in reference ? 'editor.unknown-style' : 'editor.unknown-variable');
  }
  if (!bindingTypeFits(target, key)) return fail('editor.binding-type');
  if (!bindingRangeFits(target, key)) return fail('editor.binding-range');
  const value = resolvedValue(target, tables.variables?.mode);
  if (value === undefined) return fail('editor.unknown-mode');
  if (typeof value === 'number') {
    const [min, max] = bindingRange(key);
    if (value < min || value > max) return fail('editor.binding-range');
  }
  for (const node of carriers) {
    const next = withBoundValue(node, key, value, defaultStroke);
    if (next === null) continue;
    const bound = setBindings(next, withBinding(node.bindings, key, reference));
    if (JSON.stringify(bound) === JSON.stringify(node)) continue;
    draft.set(bound);
    changed.push(node.id);
  }
  return done(document, draft, finish, changed);
}
