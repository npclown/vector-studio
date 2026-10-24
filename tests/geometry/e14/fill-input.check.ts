// D9 E14 cause diagnostic: writes the E11-U2 stress scene as the native fill diagnostic's input
// (packages/geometry-wasm/kernel/src/e14_fill_limit_diag_tests.rs) and a sidecar with each
// path's device radius and class. Run through `pnpm e14:fill-diag`, never in CI.

import { writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { STRESS_CUBICS, stressScene } from '../p3-exit-sweep/scene.js';

const hex = (value: number) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
};

test('E14 fill diagnostic input', () => {
  const out = process.env.E14_FILL_INPUT_OUT;
  expect(out, 'E14_FILL_INPUT_OUT is required').toBeTruthy();
  const rows: string[] = [];
  const sidecar: Record<
    string,
    { deviceRadius: number; looping: boolean; flatTolerancePx: number }
  > = {};
  for (const path of stressScene()) {
    expect(path.verbs.length).toBe(STRESS_CUBICS + 2);
    let radius = 0;
    for (let i = 0; i < path.points.length; i += 2) {
      radius = Math.max(radius, Math.hypot(path.points[i]!, path.points[i + 1]!));
    }
    rows.push(
      [
        path.index,
        path.toleranceExponent,
        path.fillRule,
        Array.from(path.verbs).join(','),
        Array.from(path.points, hex).join(','),
      ].join('\t'),
    );
    sidecar[path.index] = {
      deviceRadius: radius * path.zoom * path.dpr,
      looping: path.index % 4 === 3,
      flatTolerancePx: 2 ** path.toleranceExponent * path.zoom * path.dpr,
    };
  }
  writeFileSync(`${out}.tsv`, `${rows.join('\n')}\n`);
  writeFileSync(`${out}.paths.json`, JSON.stringify(sidecar));
});
