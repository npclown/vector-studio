import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { P3_NATIVE_PROJECTION_WGSL } from '../../apps/playground/src/p3-native-projection-shader.js';

// P3.1l L02: the compiled constant is the contract's fenced WGSL block without its final LF.
// The runner additionally compares against the note at the frozen contract commit before dispatch.
describe('P3.1l native projection shader identity', () => {
  it('equals the frozen contract block byte for byte', () => {
    const note = readFileSync('docs/plans/p3-native-projection-readiness.md', 'utf8').replaceAll(
      '\r\n',
      '\n',
    );
    const blocks = [...note.matchAll(/^```wgsl\n([\s\S]*?)^```$/gmu)];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]![1]).toBe(`${P3_NATIVE_PROJECTION_WGSL}\n`);
    expect(createHash('sha256').update(P3_NATIVE_PROJECTION_WGSL).digest('hex')).toBe(
      '5f1a6e4012972cd8ecb84fb0495613f9d87b709a03b7478c29a05dc5ffbd1a74',
    );
  });
});
