type Frame =
  | { kind: 'object'; keys: Set<string>; key: string | null; path: (string | number)[] }
  | { kind: 'array'; index: number; path: (string | number)[] };

/**
 * Returns the path of the first key that repeats inside one object of `text`, or null. `text`
 * must already be valid JSON; the scan only tracks strings and container punctuation.
 */
export function findDuplicateKey(text: string): (string | number)[] | null {
  const stack: Frame[] = [];
  let expectKey = false;
  const childPath = (): (string | number)[] => {
    const top = stack.at(-1);
    if (top === undefined) return [];
    return top.kind === 'object' ? [...top.path, top.key ?? ''] : [...top.path, top.index];
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const top = stack.at(-1);
      if (expectKey && top?.kind === 'object') {
        const key = JSON.parse(text.slice(i, end + 1)) as string;
        if (top.keys.has(key)) return [...top.path, key];
        top.keys.add(key);
        top.key = key;
        expectKey = false;
      }
      i = end;
    } else if (char === '{') {
      stack.push({ kind: 'object', keys: new Set(), key: null, path: childPath() });
      expectKey = true;
    } else if (char === '[') {
      stack.push({ kind: 'array', index: 0, path: childPath() });
    } else if (char === '}' || char === ']') {
      stack.pop();
    } else if (char === ',') {
      const top = stack.at(-1);
      if (top?.kind === 'object') expectKey = true;
      else if (top?.kind === 'array') top.index += 1;
    }
  }
  return null;
}
