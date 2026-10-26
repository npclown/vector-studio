# V-4 A08 PRE-FREEZE headed run, 2026-10-25

**PRE-FREEZE. Not A08 evidence.** No E11 exit snapshot record exists ([E11 section 3.2](../plans/d9-e11-p3-c03-c05-closure-contract.md#32-snapshot-record-valid-runs-and-invalidation)), and this run predates `stroke-v0+r7` (#246) and the E16 fill remedy (`fill-v0+r4`). It closes nothing. It checks that the VZ4-U1 page and spec and the VZ4-U2 metrics run end to end on the user's PC, and it found one renderer defect and five metrics changes, which [contract section 17](../plans/viz-v4-a08-corpus-contract.md#17-first-headed-run-findings-vz4-u3-2026-10-25) records.

## Run identity

| Identity             | Value                                                                           |
| -------------------- | ------------------------------------------------------------------------------- |
| Run commit           | `main` `3ee6c20` (fill `geometry-wasm/fill-v0+r3`, stroke `geometry-wasm/stroke-v0+r6`) |
| Release WASM SHA-256 | `8bac62c3b42bf7deeb3121564eb116d87625ca1742640c41356e541dffddfddb` (equal to the Linux build, #242) |
| Host                 | User PC DESKTOP-DKVUSAV, Windows, discrete GPU, Node 24.15.0                    |
| Browsers             | Playwright projects `chrome` and `edge`, headed WebGPU                          |
| Wall time            | about 3.0 h for both browsers (24 spec tests, all passed)                       |
| Subset               | 2280 cases, 1032 gated (`tests/visual/viz-v4/a08-subset.manifest.json`)         |
| Expected list        | `a08-expected-status/v1`, SHA-256 `be56d98e…bd80`, keyed to the WASM above     |
| Metrics record       | `viz-v4-metrics/v1`, body SHA-256 `c12af63a23f6cf7aa7d33eee531df107638cb05c2bd91a689cd1694feba0ad77` |

The run directory and `record.json` stay on the PC (`artifacts/viz-v4-a08/2026-10-25T15-35-43-155Z-combined`, `.tools/viz-v4-metrics/2026-10-25T20-56-19-155Z/`). The two browser projects wrote separate run directories, which were combined by hand. `pnpm test:gpu:viz-v4` now sets one run id for both, and refuses a stale `packages/geometry-wasm/dist`; the first attempt had failed on a stale dist with "fill-v0 kernel revision mismatch". The expected list is not committed here: it is keyed to a WASM that the snapshot replaces, and the counted run commits its own (section 17).

## Expected statuses (Node, before the headed run)

| Variant   | RENDERED | REGION-ONLY | KERNEL-REJECTED | EMPTY-CROP |
| --------- | -------- | ----------- | --------------- | ---------- |
| fringe-1x | 1878     | 238         | 140             | 24         |
| fringe-4x | 1878     | 238         | 140             | 24         |
| msaa-4x   | 2116     | 0           | 140             | 24         |

No case is `RENDERER-FAILED`, and no `EMPTY-CROP` has reason `port-empty`. The headed run deviated from this list in 0 cases in each browser, and 0 calls were `MESH-MISMATCH`.

## Criteria

| Criterion | Result    | Detail                                                        |
| --------- | --------- | ------------------------------------------------------------- |
| VZ4-A3    | PASS      | Both projects, every case and group present                   |
| VZ4-A4    | PASS      | 0 status or call mismatches                                   |
| VZ4-A5    | PASS      | 0 pixel or record failures                                    |
| VZ4-A6    | UNDECIDED | 4128 gated case-variants, 0 FAIL, 744 UNDECIDED               |
| VZ4-A7    | FAIL      | 4128 gated case-variants, 8 FAIL, 744 UNDECIDED               |
| Result    | FAIL      | Section 5.3: FAIL outranks INCONCLUSIVE                       |

## The 8 failures

Four keys, all `fringe-4x`, each failing identically in `chrome` and `edge`:

| Key                                  | Gate        | Evidence                                                    |
| ------------------------------------ | ----------- | ----------------------------------------------------------- |
| `C4/n06/T2/z1-d1/center/k0@dpr1.5`   | G3-equal    | Pixel (491,268) has one sample at count 3: +22/255, visible |
| `C1/s04-I/T7/z1-d2/center/k0@dpr2`   | G3-at-most  | Count 3 in far-field exterior fans, fragments discarded     |
| `C3/c03/T7/z1-d2/center/k0@dpr2`     | G3-at-most  | Same                                                        |
| `C3/c26/T7/z1-d2/center/k0@dpr2`     | G3-at-most  | Same                                                        |

**Cause: a renderer defect.** The rasterizer snaps vertices to an 8-bit subpixel grid, an error of up to 2^-9·√2 ≈ 0.0028 px, against β_c ≈ 5·10^-4 px. Sliver triangles of the drawn mesh then flip, and one sample is covered three times. A model of the snap reproduces the GPU count images of all four keys with 0 mismatching samples.
- In C4/n06, near-coincident port vertices give a sliver exterior triangle.
- In the T7 cases, the fringe's ear-clipped exterior is fanned to frame corners that land about 8000 px away under the anisotropic transform. Those fragments have c = 0 and are discarded, so nothing shows, but the count pass counts them.
- Only 4x shows the defect: the wedges are about 10^-3 px thin and meet only off-centre samples. At 1x the same meshes give 0 overlaps.

It is filed on the rendering track as its own item. The same mechanism gives count > 1, hidden by the whole-case veto below, in C4/n07, n11, n12 and n13 and in C3/c11/T2. C1/s22-I and s23-I show count > 1 at β far above 1 px; their mechanism is not verified.

## The 744 UNDECIDED

All 744 come from the no-flip certificate. VZ4-U2 made the whole case UNDECIDED when any region triangle failed it, as E3's A04 rule does. Why it failed, by sample case:
- **T7 slivers.** Triangles of height 2·10^-4 to 8·10^-4 px (C1/s03-I, s03-Q, C3/c04). This is inherent to T7.
- **One-ulp port vertices.** In C4/n10 and C12/j06 under T2, port vertices 1 ulp apart in f64 quantise to the same f32 offset. Triangles become exactly collinear at `p*`, and `p*` duplicates make pairing refuse the case. This is an artifact of the V-4 reference; the product's fringe builder pairs on distinct node-local positions.
- **β ≥ 1 px.** C1/s20-I to s23-I, with β from 1.88 px to 4.9·10^6 px. This is inherent.

The case veto also hid 88 count > 1 failures: 40 snap flips and 48 in C1/s22-I and s23-I. A count above 1 needs no β to decide.

## Expected effect of the section 17 changes

These are Node estimates from the record's reasons and the zones; they are not a run.

| Outcome                                  | Entries | What                                                          |
| ---------------------------------------- | ------- | ------------------------------------------------------------- |
| FAIL (count > 1)                         | 88      | 40 snap flips, 48 in C1/s22-I and s23-I                       |
| PASS, empty zone                         | 386     | 24 of them need the equal-`p*` merge                          |
| PASS, non-empty zone, no violation       | 138     | 60 need the merge; only 6 of these have captures to check     |
| Still UNDECIDED (β ≥ 1 px)               | 132     | C1/s20-I to s23-I                                             |

Even with these changes the result stays FAIL until the renderer item lands. A re-score of this run with the new metrics needs the captures on the PC: NOT RUN here.

## Next

The counted A08 run is made after the E11 exit snapshot record, on its commit, with `pnpm test:gpu:viz-v4` and then `pnpm coverage:viz-v4 --label <snapshot short SHA>`. It closes A08 only when the renderer item has landed, or when the user accepts the item as a known defect.
