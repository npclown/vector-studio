// M6a-L3 and M6a-Q21 (a): one generation counter per JavaScript realm, shared by every text-dom
// instance, so a recreated port (HMR, a remount) never repeats a generation an earlier instance
// used. The counter lives on `globalThis` under a registry symbol rather than in a module
// variable, so a module evaluated again (HMR) or bundled twice still shares it.

const COUNTER = Symbol.for('@vector-studio/text-dom/generation');

type CounterHolder = { [COUNTER]?: unknown };

/**
 * Increments the realm counter and returns its new value; the first call returns 0. The counter
 * saturates at `Number.MAX_SAFE_INTEGER`, and a holder value that is not a non-negative safe
 * integer (written by other code) also saturates it rather than restarting at 0, so a value is
 * never smaller than one returned before (review r1 N1).
 */
export function nextGeneration(): number {
  const holder = globalThis as CounterHolder;
  const current = holder[COUNTER];
  let value: number;
  if (current === undefined) value = 0;
  else if (typeof current === 'number' && Number.isSafeInteger(current) && current >= 0) {
    value = Math.min(current + 1, Number.MAX_SAFE_INTEGER);
  } else value = Number.MAX_SAFE_INTEGER;
  holder[COUNTER] = value;
  return value;
}
