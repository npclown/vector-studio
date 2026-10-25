/** Deepest container nesting a document may have, data included; deeper text is rejected. */
export const MAX_DEPTH = 256;

type Container = {
  kind: 'object' | 'array';
  parent: Container | null;
  /** The key or index this container has in its parent. */
  slot: string | number | null;
  keys: Set<string>;
  key: string | null;
  index: number;
};

export type ScanFinding = Readonly<{
  kind: 'duplicate-key' | 'too-deep';
  path: (string | number)[];
}>;

/** Builds a path only when a finding needs one, so the scan stays linear in the text. */
function pathOf(container: Container | null, last?: string | number): (string | number)[] {
  const path: (string | number)[] = last === undefined ? [] : [last];
  for (let at = container; at !== null && at.slot !== null; at = at.parent) path.unshift(at.slot);
  return path;
}

/**
 * Finds the first key that repeats inside one object of `text`, or the first container nested
 * deeper than `MAX_DEPTH`. `text` must already be valid JSON; the scan only tracks strings and
 * container punctuation.
 */
export function scanJson(text: string): ScanFinding | null {
  let top = null as Container | null;
  let depth = 0;
  let expectKey = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      if (expectKey && top?.kind === 'object') {
        const key = JSON.parse(text.slice(i, end + 1)) as string;
        if (top.keys.has(key)) return { kind: 'duplicate-key', path: pathOf(top, key) };
        top.keys.add(key);
        top.key = key;
        expectKey = false;
      }
      i = end;
    } else if (char === '{' || char === '[') {
      const slot = top === null ? null : top.kind === 'object' ? top.key : top.index;
      const container: Container = {
        kind: char === '{' ? 'object' : 'array',
        parent: top,
        slot,
        keys: new Set(),
        key: null,
        index: 0,
      };
      depth += 1;
      if (depth > MAX_DEPTH) return { kind: 'too-deep', path: pathOf(container) };
      top = container;
      expectKey = char === '{';
    } else if (char === '}' || char === ']') {
      top = top?.parent ?? null;
      depth -= 1;
    } else if (char === ',' && top !== null) {
      if (top.kind === 'object') expectKey = true;
      else top.index += 1;
    }
  }
  return null;
}
