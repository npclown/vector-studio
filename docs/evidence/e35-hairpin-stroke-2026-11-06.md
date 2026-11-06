# E35: stroke retry for hairpin cubics, 2026-11-06

Rendering-track item E35. The user approved the kernel fix on 2026-11-06 (thread "Improve the editor UI usability", after the renderer stopgap #522). This record holds the cause, the rule, its error argument and the measured results. Identity: `geometry-wasm/stroke-v0+r8`.

## 1. The defect

Five pen paths drawn in the editor on 2026-11-06 (width 1, butt, miter 4) drew nothing. Each closes on a hairpin: in four of them the last cubic's first control equals its start (a corner anchor), and in all of them its second control, the first anchor's mirrored handle, points back past the end. At `stroke-v0+r7` each stroke is `work-limit` at zoom 1, DPR 1 (`e = -3`); `node3b` is `work-limit` at every `e` from `+2` down.

| Case (user's node) | Closing cubic (document px)                           | Tip                                  | `r7` at `e = -3`                |
| ------------------ | ----------------------------------------------------- | ------------------------------------ | ------------------------------- |
| node5              | (352, 98.4), c1 = start, c2 (389.6, 84.8), (339.2, 99.2) | near cusp, curve radius 0.065 px     | `Rounded(NodeLimit)`, 158 vertices on the cubic alone |
| node3a             | (371.2, 129.6), c1 = start, c2 (412.0, 104.0), (368.0, 132.0) | near cusp                            | work-limit                      |
| node3b             | (332.8, 92.0), c1 = start, c2 (348.8, 76.0), (335.2, 89.6) | near reversal on a line (P0, P2, P3 collinear to 1e-4) | `Front(DepthLimit)` at every `e` |
| node7              | (302.4, 69.6), c1 = start, c2 (316.0, 60.8), (298.4, 72.0) | near cusp                            | work-limit                      |
| node6              | (413.6, 56.0), c1 (376.0, 71.2), c2 (411.2, 34.4), (380.0, 76.0) | hairpin, 945 px path                 | work-limit (`DepthLimit`)       |
| V-25 triangle      | (100, 0), c1 (101, −0.4), c2 = end (50, 80)            | 1 px handle (not closing: the second cubic) | work-limit                      |

Three mechanisms, all in the front end's leaves (`p3-b2-stroke-contract.md` §4.5), not in flattening:

1. **Fan (node5, node3a, node7, triangle).** Where the curve's radius is below `r`, the leaf test still needs `4·r·sin(alpha) <= 2^e`, so the tip is resolved by about `pi·4r/2^e` leaves (25 at `e = -3`) that all lie within about 0.2 px. Their quads all cross one another. The arrangement meets `max_nodes` (8,192) with 158 input vertices on node5's cubic; with wide test limits it needs 53,306 nodes.
2. **Absolute cone guard (all, at `e <= -5`).** ST-G4's `768u·M²` does not shrink with the leaf (M = 390 px here), so below depth 12 `aLow <= 0` and tip leaves go to depth 20 (`DepthLimit`). This is the known ST-OB7 ([p3-fill-stroke-meshes](../plans/p3-fill-stroke-meshes.md), "Observed cost of the frozen absolute term").
3. **Near reversal (node3b).** The hodograph's minimum is about 6e-4 and the tangent turns 180° inside a 1e-9 px tip, which no leaf of depth 20 resolves, at any tolerance.

## 2. The rule (retry only)

`StrokeWorkspace::build` runs the `r7` build. Only when its result is `work-limit` does it build the path once more with the E35 retry, and it keeps the retry's answer only when that is `ok` or `empty`; any other answer (a refusal or an internal error) gives back the first build's `work-limit`, so the renderer's coarser retry (#522) still applies. A path that `r7` builds is never rebuilt, so every `ok` mesh is bit-identical (E35-A3 checks this on every case and exponent). The retry adds:

- **E35-K1, near-cusp fans.** Consecutive leaves of one range accepted by §4.5's test (not E2-K2 band leaves, which stay single) are grouped while the bounding box of all their controls has diagonal `dUp` with `dUp + g <= 2^(e-1)`, `g = gOff + 3·r·max dN + 8u(M + r)` plus `3·eps` for the computed controls, `eps = (4ℓ + 16)·u·M` (the split term on every leaf). A group of two or more leaves is emitted as two convex pieces (`fan-side`): the hull of every sample centre and its `E+` points, and the hull of the centres and the `E−` points. The group's first and last triples are those of its neighbours, so seams are shared. At most 64 leaves per group.
- **E35-K2, relative cone guard (ST-OB7).** On leaves not next to a reversal split, `768u·M²` becomes `8u·|V|·max|Di| + 2^-1022`. The budget `8u` holds the computed `V` and `Di` against the exact differences of the computed controls (about `2u` relative) and the products' rounding, which ST-G4 (1) bounds by `4.1u·|V|·|D|`. The computed controls' own error against the exact subcurve stays in `20·eps·|V|`. The split-end limit-direction term (`288u·M²`) only arises next to a split, where the frozen term is kept.
- **E35-K3, near-reversal disks.** An unaccepted leaf not next to a reversal split (whose end directions would carry the split terms) whose end directions have `dot(Ds, De) < 0` and whose controls are within `deltaUp` of `Q0` with `deltaUp + r·sinUp + gOff <= 2^e` is emitted as the disk of radius `r` at its start centre (`reversal-disk`, `push_disk` at the arc share's level), sharing the start triple's offset points and holding the end triple's three points.

## 3. Error argument (curve share `2^e`, two-sided Hausdorff)

**E35-K1.** Let a group have controls within diameter `d`, sample triples `(C_i, E±_i)` and ideal sweep `I`. A point `y` of the `+` hull is a convex combination `sum w_i (C_i + s_i·r·N_i)` = `C̄ + r·v` with `|v| <= 1`. If the sampled normals span at most `pi`, the direction of `v` is some `N(t)` of the group (continuity of `N` on the group's range), and `C(t) + r|v|N(t)` is in `I`, at distance `<= |C̄ − C(t)| <= d` from `y`. If they span more than `pi`, the direction of `v` or its opposite is attained and the `−` side gives the point. So the hulls lie within `d` of `I`. Conversely a point `C(t) + s·r·N(t)` of `I` in leaf `i` is within `|C(t) − C_i| + s·r·|N(t) − N_i| <= d + 2·r·sin(alpha) <= d + 2^(e-1)` of the segment `[C_i, E+_i]` in the hull, since the leaf test bounds `4·r·sin(alpha)` by `2^e`. Computed normals, controls and offset points add `g`. Both directions are within `d + g + 2^(e-1) <= 2^e`.

**E35-K3.** The leaf's hodograph does not vanish (the reversal is not exact: §4.6 would have split it), so its direction turns continuously from `Ds` to `De` through at least `pi − beta`, and with both normal sides every direction is covered except two wedges of `beta`. Every curve point is within `deltaUp` of `Q0`. So `I` is within `deltaUp` of the disk, and the disk is within `deltaUp + r·sin(beta)` of `I`, ST-G5's argument for a cusp disk with an inexact centre. The disk polygon's sagitta is in the arc share, as for cusp disks.

ST-O1 (the dump oracle) does not know the two new kinds yet, so the dump stays on the `r7` build (`no_retry`): its `ok` cases are the same meshes at `r8`. A former `work-limit` dump case that `r8` builds is not checked by ST-O1; extending ST-O1 to the new kinds is a follow-up. E35-A4 checks the outward half on the fixtures: every `fan-side` and `reversal-disk` vertex lies within `r + 2^e` of the densely sampled curve.

## 4. Results (native, release, `STROKE_V0_LIMITS`)

`r7 → r8` per whole path; `wl` is `work-limit`, with the `r8` cause.

| Case     | `e = 0`  | `e = -2` | `e = -3`        | `e = -4`        | `e = -5`        |
| -------- | -------- | -------- | --------------- | --------------- | --------------- |
| node5    | ok → ok  | wl → ok  | wl → ok         | wl → NodeLimit  | wl → InputLimit |
| node3a   | ok → ok  | wl → ok  | wl → ok         | wl → ok         | wl → InputLimit |
| node3b   | wl → ok  | wl → ok  | wl → NodeLimit  | wl → InputLimit | wl → InputLimit |
| node7    | wl → ok  | wl → ok  | wl → ok         | wl → ok         | wl → InputLimit |
| node6    | ok → ok  | wl → wl  | wl → InputLimit | wl → InputLimit | not run         |
| triangle | ok → ok  | wl → ok  | wl → ok         | wl → ok         | wl → NodeLimit  |

node6 is `wl → ok` at `e = -1`.

Each closing cubic alone is `ok` from `e = +2` to `−4`. The remaining refusals are the arrangement's general caps on these 300 to 700 px paths (`max_input_vertices` 1,024, `max_nodes` 8,192), not the hairpin: the renderer's coarser retry (#522) reaches `−2` for node3b at DPR 1. Raising the caps is a §7.6 threshold change and is not part of E35.

Arrangement nodes on node5's closing cubic at `e = -3`: 53,306 (r7, wide limits) against 1,414 (r8). On the triangle: 162,909 against 1,473.

**Cost.** A path that stays `work-limit` is now built twice, and under the renderer's coarser retry up to twice per tried exponent. The independent review's probe (1,760 r7/r8 pairs over the fixtures at four widths, two join styles and seven exponents, plus 400 synthetic hairpins) saw 121 ok → ok, 1,140 work-limit → ok and 499 work-limit → work-limit, and no other transition.

## 5. Not in E35

- The star outline `unsupported-geometry` found by V-25 (#523) is a separate refusal class (near-mirrored vertices), recorded as backlog candidate E36.
- Caps above, and node3b at `e = -3`. The user's fifth path (node6, 945 x 538 px, 14 cubics) builds at `r8` only from `e = -1`: at `e = -3` its merged outline has 1,358 vertices against `max_input_vertices` 1,024, and at `e = -2` it meets the output caps. Its closing hairpin alone builds from `+2` to `-4`. Raising §7.6's caps is a separate decision.
- Follow-ups from the review: ST-O1 for `fan-side` and `reversal-disk`; a test of the inward half and of bitwise seam sharing; a fan that reaches `FAN_MAX_LEAVES`; a reversal disk at a source end.

## 6. Headed evidence

Headed run on the main PC (DESKTOP-DKVUSAV, Chrome) at main 8f10383 with the r8 kernel: viz-v1 DPR 2, viz-v2 DPR 1 and 2 and viz-v3 DPR 1 and 2 pass. p3-b2-strokes (DPR 1, 2, 3) and viz-v1 DPR 1 failed on stale expectations only: strokes that stopped at `work-limit` now mesh, through E35 or the renderer's coarser retry (#522). #525 (3ec23c9) re-baselined both specs (viz-v1 N1 now strokes at width 64, `work-limit` at every exponent from −3 to +2), and the headed re-run passed 5/5.
