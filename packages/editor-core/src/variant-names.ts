// Variant values from names and their distinct suffixes (V-37 contract, section 4.1: V37-N1 and
// V37-N2). Pure string rules, shared by the commands and the edit draft.

/** The most UTF-16 units of a variant name or value (V37-S2). */
export const MAX_VARIANT_TEXT = 64;
/** A value derived from a name is cut to this many units, leaving room for a suffix (V37-N1). */
const MAX_DERIVED = 60;

const isControl = (unit: number) => unit <= 0x1f || (unit >= 0x80 && unit <= 0x9f);
const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/** `text` cut to at most `max` units without splitting a surrogate pair. */
export function cutUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = isHigh(text.charCodeAt(max - 1)) ? max - 1 : max;
  return text.slice(0, Math.max(end, 0));
}

/**
 * V37-N1: a value from a symbol's name: control characters and lone surrogates removed, cut to at
 * most 60 units without splitting a pair, and `Variant` when nothing is left.
 */
export function valueFromName(name: string): string {
  let kept = '';
  for (let i = 0; i < name.length; i += 1) {
    const unit = name.charCodeAt(i);
    if (isControl(unit)) continue;
    if (isHigh(unit)) {
      const next = i + 1 < name.length ? name.charCodeAt(i + 1) : 0;
      if (!isLow(next)) continue;
      kept += name[i]! + name[i + 1]!;
      i += 1;
      continue;
    }
    if (isLow(unit)) continue;
    kept += name[i]!;
  }
  const cut = cutUnits(kept, MAX_DERIVED);
  return cut === '' ? 'Variant' : cut;
}

/** The names of `variant` in UTF-16 code unit order (the serialized order). */
export const namesOf = (variant: Readonly<Record<string, string>>): string[] =>
  Object.keys(variant).sort();

/** A key for the values of `variant` over `names`, equal exactly when the tuples are equal. */
export const tupleKey = (variant: Readonly<Record<string, string>>, names: readonly string[]) =>
  JSON.stringify(names.map((name) => variant[name]));

/**
 * V37-N2: `variant` made distinct from the tuples in `seen`: the smallest suffix ` 2`, ` 3` ... on
 * its first property's value that makes it distinct, the value cut first so value plus suffix stay
 * within 64 units. Adds the result's tuple to `seen`.
 */
export function distinctVariant(
  variant: Readonly<Record<string, string>>,
  seen: Set<string>,
): Readonly<Record<string, string>> {
  const names = namesOf(variant);
  let result = variant;
  if (seen.has(tupleKey(result, names)) && names.length > 0) {
    const first = names[0]!;
    for (let n = 2; ; n += 1) {
      const suffix = ` ${n}`;
      const value = cutUnits(variant[first]!, MAX_VARIANT_TEXT - suffix.length) + suffix;
      result = { ...variant, [first]: value };
      if (!seen.has(tupleKey(result, names))) break;
    }
  }
  seen.add(tupleKey(result, names));
  return result;
}
