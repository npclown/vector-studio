# E41-U2 record: boolean engine

Unit U2 of the [E41 contract](../../plans/d9-e41-boolean-effects-contract.md): the boolean engine in `packages/editor-core/src/boolean/` (section 2.4), checked by E41-A02 and E41-A04. Test file: `tests/unit/e41-u2-boolean-engine.test.ts`.

## Environment

Cloud container, 4 vCPU, Node 22.23.4, vitest 4.1.11, 2026-11-09.

## E41-A02 correctness — PASS

- Fixtures B1 to B15 and B10b: every operation listed in section 8 passes the 256 × 256 grid oracle under both fill rules, every result piece lies on an input segment within `η`, every contour is closed and no contour is narrower than about `η` (see the departure below). The expected contour counts hold (B1 union 1, exclude 2; B4 one rectangle; B5 two contours; B7 two; B12 union two, intersect `boolean-empty`; B14 one rectangle).
- Random corpus, seed `0xe41`, 1,000 cases on the 256 × 256 grid: 0 mismatches, 0 `boolean-failed`.
- Extra seeds 1 to 4, 3,000 cases each on a 64 × 64 grid (12,000 cases): 0 mismatches; 1 `boolean-failed` (seed 4, case 962, `exclude`, fail closed). The bound is at most 5 per 1,000.

The scanline oracle in the test is independent code: it computes row crossings of the inputs and of the result with its own cubic root finding, and its own distance search.

## E41-A04 cost — PASS

Two closed rings of 512 cubic segments each (`r = 100 + 0.5 sin 256θ` and `r = 100 + sin(512θ + 0.3)`), 1,149 crossings, union, median of 5 after one warm-up run, with `E41_A04_GATE=1`:

| Run | Median | Runs (ms) |
| --- | --- | --- |
| 1 | 68.9 ms | 64.4, 67.5, 68.9, 82.3, 94.1 |
| 2 | 69.2 ms | 61.6, 67.8, 69.2, 69.9, 83.0 |
| 3 | 68.7 ms | 64.9, 68.3, 68.7, 78.0, 84.5 |

The gate is 100 ms. Without `E41_A04_GATE=1` (shared CI runners) the test only asserts a 1 s ceiling, so CI noise does not decide the gate; this record does.

## Departures from the contract text

- **Sliver check (A02).** The contract asks for "area above `η D`". Near-coincident inputs (copies offset by 2 to 10 `η`, which A02 itself requires) give real slivers of width `2η` to `10η` whose area is below `η D`. The check is instead `|area| > η × perimeter / 4`: no contour narrower than about `η`. U8 carries this wording into the contract.
- **Monotone split (2.4 step 1).** Cubics are split at their x and y extrema first, so a self-crossing cubic shows up as a crossing between its pieces, and every piece meets an axis ray at most once.
- **Axis rays (2.4 step 4).** Membership uses a ray along +x, or +y where the piece runs closer to horizontal, instead of the left normal, so that a band index can prune candidates. The group's copies are excluded and give the jump between the sides, as the contract states.
- **Intersection search (2.4 step 2).** Subdivision stops early in three exact or conservative cases: pieces sharing an end point that a line through it separates (convex hull), flat pieces at a clear angle (chords at least 0.1 apart in sine, controls within 1 % of the chord) where Newton from the chord crossing converges inside both pieces, and `η`-flat pieces whose chords stand in for the curves.
