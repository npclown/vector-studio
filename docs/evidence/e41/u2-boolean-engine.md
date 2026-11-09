# E41-U2 record: boolean engine

Unit U2 of the [E41 contract](../../plans/d9-e41-boolean-effects-contract.md): the boolean engine in `packages/editor-core/src/boolean/` (section 2.4), checked by E41-A02 and E41-A04. Test file: `tests/unit/e41-u2-boolean-engine.test.ts`.

## Environment

Cloud container, 4 vCPU, Node 22.23.4, vitest 4.1.11, 2026-11-09.

## E41-A02 correctness — PASS

- **Fixtures.** B1 to B15 and B10b: every operation listed in section 8 passes the 256 × 256 grid oracle under both fill rules. Every result piece lies on an input segment within `η`, and every contour is closed and encloses area. The expected contour counts hold: B1 union 1 and exclude 2; B4 one rectangle; B5 two contours; B7 two; B12 union two, intersect `boolean-empty`; B14 one rectangle.
- **Regressions from the U2 review.** These also pass:
  - B12 rotated by 0.123, 0.7 and 1.3 rad: union gives two contours.
  - An open subpath.
  - 6 × 1 rectangles rotated across a long, slightly curved cubic, and on a circle of radius 1,000 (every operation).
  - An ellipse with a copy shifted diagonally by 0.5 to 1,000 `η` (every operation).
- **Corpus generator.** The random corpus has:
  - near-coincident copies in a random direction, in three bands relative to the case's `D`: below `η`, 1 to 4 `η`, and 4 to 10 `η`;
  - mixed scales: 15 % of inputs shrink to 2 % to 20 % of the frame.
- **Seed `0xe41`.** 1,000 cases, 256 × 256 grid: 0 mismatches, 0 `boolean-failed`.
- **Seeds 1 to 11.** 11,000 cases, 256 × 256 grid: 0 mismatches and 1 `boolean-failed`, which is under the bound of 5 per 1,000.
  - The failure is seed 11, case 621: `subtract` of an evenodd self-crossing cubic blob and its copy 2.4 `η` away. It fails closed.
  - The cause is that its self-crossing point and the copy's give four vertices within about 2 `η` of each other. Vertex clustering is not transitive, so they do not all merge.
  - It is kept as the fixture "seed 11 case 621", which accepts a closed failure or a correct result, never a wrong one.

- **Re-review findings, same class, fail closed.** Seed 12 case 804 (`intersect`) and seed 13 case 155 (`subtract`) are near-coincident evenodd self-crossing blobs, like seed 11 case 621. An ellipse against a copy rotated by 3e-7 rad fails closed for union and exclude; from 1e-6 rad up, the result is correct. None of these gives a wrong fill.

The oracle in the test is independent of the engine. It has its own:

- row crossings with cubic root finding;
- distance search;
- area (Green's theorem with 4-point Gauss-Legendre, which is exact for cubics);
- closing of open contours.

## E41-A04 cost — PASS

The inputs are two closed rings of 512 cubic segments each, `r = 100 + 0.5 sin 256θ` and `r = 100 + sin(512θ + 0.3)`. They cross 1,024 times: per period of `256θ`, `0.5 sin x = sin(2x + 0.3)` has 4 roots. The test asserts that the union's boundary switches inputs exactly 1,024 times. It also asserts that the timed result is correct, using the grid oracle (128 × 128).

The measurement is the median of 5 union runs after one warm-up run, with `E41_A04_GATE=1`:

| Run | Median | Runs (ms) |
| --- | --- | --- |
| 1 | 73.0 ms | 55.3, 71.5, 73.0, 76.7, 87.0 |
| 2 | 59.7 ms | 56.8, 58.9, 59.7, 62.2, 68.5 |
| 3 | 63.4 ms | 58.7, 63.1, 63.4, 71.4, 76.7 |

The gate is 100 ms. Run alone, the A04 test gave a median of 54.0 ms.

## Departures from the contract text

- **CI ceiling (A04).** The 100 ms gate is judged on this container record, with `E41_A04_GATE=1`. On shared CI runners, the test asserts only a 1 s ceiling, so runner noise does not decide the gate.
- **Axis rays (2.4 step 4).** Membership uses a ray along +x, or along +y where the piece runs closer to horizontal, instead of the left normal. This lets a band index prune candidates. The group's copies are excluded and give the jump between the sides, as the contract states.
- **Coincidence scale (2.4 step 2).** Coincidence is tested only on pieces longer than `4096 η`. Near-coincident features smaller than that are subdivided instead. They can exhaust the subdivision budget, and then they fail closed.
- **Loop split.** A piece that leaves a vertex and returns to it is split at its middle by a new vertex. That vertex is created after the vertex rule has run, so it cuts only its own segment.

The contract text was amended in this unit for the monotone split, subdivision for line-cubic, the side-change bisection, budget failure, the chaining tie-break and the A02 area criterion (section 12, "U2 amendments").

## Exact early exits in the subdivision

These stop the search early without losing a crossing:

- **Shared end point.** Pieces that share an end point, where a line through it separates their control points: by the convex hull, they meet only there.
- **Fat lines.** Each piece lies in a strip along its own chord. If the other piece's controls are outside that strip (plus `ε`), there is no crossing.
- **Chord pad.** Pieces whose controls project inside their chords lie in rectangles of half-width `dev` around the chords. A common point lies within `(dev_a + dev_b + ε) / sin` of the chords' crossing, so a chord crossing outside that pad means no crossing.
- **Disjoint hodograph cones.** If the cones of the two pieces' control-polygon directions are disjoint, the pieces cross at most once. A Newton root inside both pieces is then that crossing; otherwise subdivision goes on.
- **`η`-flat chords.** Pieces within `η/4` of their chords: the chords stand in for the curves.
