import { describe, expect, it } from 'vitest';
import { buildO02 } from '../support/p3-o02-build.js';
import { ruleAtPixel, ruleContext } from './coverage-oracle/rule.js';
import { o02Variants, variantStatus } from './coverage-oracle/variants.js';
import { toNumber } from './rounded-fill/exact.js';

/**
 * P3.1o O02: a float32 emulation of P3_O02_MAIN_WGSL over the actual buildO02 records agrees with
 * the exact rule oracle at every crop pixel center strictly inside one drawn primitive, and no
 * center lies strictly inside two drawn primitives (docs/plans/p3-o02-a5-coverage-contract.md).
 */

const F = Math.fround;
const scratch = new Float32Array(1);
const scratchWords = new Uint32Array(scratch.buffer);
const word = (bits: number) => {
  scratchWords[0] = bits;
  return scratch[0]!;
};

function emulate(
  words: Uint32Array,
  offset: number,
  count: number,
  role: number,
  px: number,
  py: number,
): number {
  let best = 3.0e38;
  let side = 0;
  let width = 1;
  for (let index = 0; index < count; index += 1) {
    const base = (offset + index) * 16;
    if (words[base] === 0) {
      const nx = word(words[base + 1]!);
      const ny = word(words[base + 2]!);
      const u = F(F(-ny * px) + F(nx * py));
      if (u >= word(words[base + 4]!) && u <= word(words[base + 5]!)) {
        const v = F(F(F(nx * px) + F(ny * py)) + word(words[base + 3]!));
        if (Math.abs(v) < best) {
          best = Math.abs(v);
          side = v;
          width = F(Math.abs(nx) + Math.abs(ny));
        }
      }
    } else {
      const dx = F(px - word(words[base + 1]!));
      const dy = F(py - word(words[base + 2]!));
      const dist = F(Math.sqrt(F(F(dx * dx) + F(dy * dy))));
      if (dist < best) {
        const flags = words[base + 3]!;
        let inside = false;
        for (let sector = 0; sector < (flags & 0xff); sector += 1) {
          const at = base + 4 + sector * 4;
          const a = F(F(word(words[at]!) * dy) - F(word(words[at + 1]!) * dx));
          const b = F(F(dx * word(words[at + 3]!)) - F(dy * word(words[at + 2]!)));
          const reflex = ((flags >>> (8 + sector)) & 1) === 1;
          inside ||= reflex ? !(a <= 0 && b <= 0) : a > 0 && b > 0;
        }
        best = dist;
        side = inside ? -dist : dist;
        width = dist > 0 ? F(F(Math.abs(dx) + Math.abs(dy)) / dist) : 1;
      }
    }
  }
  if (count === 0 || best >= 1) return role === 0 ? 1 : 0;
  return Math.min(1, Math.max(0, F(0.5 - F(side / width))));
}

// Deficit rows, literal rows and pinch rows, at two acceptance DPRs.
const ROWS = new Set([3, 12, 77, 83, 89, 95, 143, 144, 145, 146, 147, 148]);
const DPRS = new Set([1, 2]);

describe('P3.1o O02 shader emulation', () => {
  it('matches the exact rule at single-covered centers', { timeout: 600_000 }, () => {
    let pixels = 0;
    let worst = 0;
    let multiple = 0;
    for (const variant of o02Variants()) {
      if (!ROWS.has(variant.rowIndex) || !DPRS.has(variant.dpr)) continue;
      const resolved = variantStatus(variant.input);
      if (resolved.status !== 'RENDERED') continue;
      const built = buildO02(resolved.exterior, resolved.crop);
      const words = new Uint32Array(
        built.features.buffer,
        built.features.byteOffset,
        built.features.byteLength / 4,
      );
      const points = resolved.exterior.preimage.map(([x, y]) => [toNumber(x), toNumber(y)]);
      let offset = 0;
      const drawn = built.stats.perPrimitive.map((primitive) => {
        const entry = { ...primitive, offset, corners: primitive.triangle.map((v) => points[v]!) };
        offset += primitive.count;
        return entry;
      });
      const context = ruleContext(resolved.geometry, resolved.exterior.sectors);
      const { x, y, w, h } = resolved.crop;
      for (let j = y; j < y + h; j += 1)
        for (let i = x; i < x + w; i += 1) {
          const cx = i + 0.5;
          const cy = j + 0.5;
          const hits = drawn.filter(({ corners: [a, b, c] }) => {
            const o = (p: number[], q: number[]) =>
              (q[0]! - p[0]!) * (cy - p[1]!) - (q[1]! - p[1]!) * (cx - p[0]!);
            const s = [o(a!, b!), o(b!, c!), o(c!, a!)];
            return s.every((value) => value > 0) || s.every((value) => value < 0);
          });
          if (hits.length > 1) multiple += 1;
          if (hits.length !== 1) continue;
          const hit = hits[0]!;
          const observed = emulate(
            words,
            hit.offset,
            hit.count,
            hit.role,
            cx - built.origin[0],
            cy - built.origin[1],
          );
          worst = Math.max(worst, Math.abs(observed - toNumber(ruleAtPixel(context, i, j))));
          pixels += 1;
        }
    }
    expect(pixels).toBeGreaterThan(10_000);
    expect(multiple).toBe(0);
    expect(worst).toBeLessThan(1e-3);
  });
});
