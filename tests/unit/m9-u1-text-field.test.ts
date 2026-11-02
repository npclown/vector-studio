// MVP M9-U1 pre-run fix (product, packages/ui): the property panel's `TextField` replaces its
// draft when the shown value or its identity changes during render, not in an effect. At 044e597
// the effect `setDraft(shown)` ran after every commit in which the value changed. A drag changes
// the transform fields on every move: the move selection r4 and e5 share Y = 0, so the Y field
// shows one value that follows the pointer. Each input-driven sync commit then left that effect's
// default-lane update pending. With moves queued behind a busy main thread (the laptop's
// font-load change; every run in the container's SwiftShader page), more than 50 such commits
// came in a row, and React threw error #185, "Maximum update depth exceeded". An ad-hoc headless
// run of the pointer-busy v2 drag with `ui=1` reproduced it in 8 of 8 runs (4 busy, 4 plain) before the fix and in
// 0 of 6 after it.
//
// The tests' React has no DOM renderer, so this checks the source: no effect in the field, and
// the adjustment during render. The browser behaviour (Enter and blur commits, the reset after a
// commit, an undo or a selection change) is the tests/m8-next-host spec's.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TextField } from '../../packages/ui/src/fields.js';

const root = path.resolve(import.meta.dirname, '../..');
const FIELDS = readFileSync(path.join(root, 'packages/ui/src/fields.tsx'), 'utf8');
/** The `TextField` function's source, up to the next top-level declaration. */
const FIELD = FIELDS.slice(
  FIELDS.indexOf('export function TextField('),
  FIELDS.indexOf('\nfunction ', FIELDS.indexOf('export function TextField(')),
);

describe('M9-U1: TextField follows its value without an effect', () => {
  it('replaces the draft during render, with no effect and no extra commit', () => {
    expect(FIELD.length).toBeGreaterThan(0);
    expect(FIELD).not.toMatch(/\buse(?:Layout)?Effect\b/u);
    expect(FIELDS).not.toMatch(/\buse(?:Layout)?Effect\b/u);
    // The previous value and identity are state, compared during render.
    expect(FIELD).toContain('const [source, setSource] = useState({ shown, identity });');
    expect(FIELD).toMatch(
      /if \(source\.shown !== shown \|\| source\.identity !== identity\) \{\s*setSource\(\{ shown, identity \}\);\s*setDraft\(shown\);\s*setInvalid\(false\);/u,
    );
  });

  it('renders the shown value, and a mixed value as empty with the placeholder', () => {
    const one = renderToString(
      createElement(TextField, { label: 'Y', value: '12', identity: 'r4 e5', commit: () => true }),
    );
    expect(one).toContain('value="12"');
    expect(one).toContain('aria-invalid="false"');
    const mixed = renderToString(
      createElement(TextField, { label: 'X', value: null, commit: () => true }),
    );
    expect(mixed).toContain('value=""');
    expect(mixed).toContain('placeholder="mixed"');
    expect(mixed).toContain('data-mixed="true"');
  });
});
