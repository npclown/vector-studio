# E16 corpus fill rejections outside the closed list: cause, 2026-10-25

Rendering track item E16 ([status index](../plans/d9-rendering-track.md#status-index)). Opened on 2026-10-25 as an R1 item because these rejections would fail A02 at the P3 exit snapshot (recommended option auto-adopted 2026-10-25, under the user's standing instruction of 2026-10-24). This record answers its first acceptance check, "a written cause per row family", and proposes fix directions for a contract. It changes no kernel output, cap, threshold, tolerance or closed list. Precision stays **UNVERIFIED**. All runs are **PRE-FREEZE** ([E11 section 3.2](../plans/d9-e11-p3-c03-c05-closure-contract.md#32-snapshot-record-valid-runs-and-invalidation)).

## Summary

- **Input.** The A01 sweep over the frozen `a04-corpus/v1` on `main` `9b653ea` (`fill-v0+r3`), from the [A02 record](a02-fill-rules-2026-10-25.md#5-pre-freeze-run-2026-10-25): 1,655 rejected fill requests. 312 are in the E14-Q1 class. The other 1,343 (328 `work-limit`, 1,015 `unsupported-geometry`) are outside E11 section 7.2's closed list, and named rows are among them.
- **Four causes**, from the kernel's unmapped errors:
  1. **Source caps** (84 requests, 6 named rows): C11 f01, f03, f04, f06, f08 and C12 j02 exceed the B1 source caps (at most 4 contours and 64 source segments per path, `cubic_fill.rs`). Rung 0 shares these caps (E14-K1 raised only its edge caps). They fail at S1, before any polygon is built, at every transform and zoom (f01, f03 and f04 already before sizing).
  2. **Exact-rung edge cap E = 256 on paths without a polygon crossing** (234 requests): rung 0 refuses with `MONOTONE`, `CLEARANCE` or `PREFIX`, and the exact rung's `CommandLimit` or `OwnerLimit` follows. C3: 21 generated and 10 named rows (S-curve, cusps, near-cusps, inflection, degenerate control points, a circle of radius 4,096). C4 (near-coincidence): all 6 named rows, every one refused by rung 0's `CLEARANCE`; n09-n11 are cubic-line (circle and rectangle), n12-n14 cubic-cubic (two circles). This is the E14-R2 risk ([E14 section 11](../plans/d9-e14-fill-rung0-edge-cap-contract.md#11-risks)), now seen in the corpus.
  3. **Topology unresolved on small paths** (1,015 requests): every `unsupported-geometry`. 993 end in `Topology(Unresolved)` (directly or after `KnotMismatch` and the triangle-free retry) at only 3 to 252 flat verbs: 123 of the 300 generated C3 rows, and 9 named rows (loop c04/c05, inflection c10, crossing ellipses c11/c12, depth-positive star c20/c21, concentric c28/c29). 22 are `ZeroLengthLeaf` on the depth-positive zero-closure rows c22/c23.
  4. **Exact-rung topology caps** (10 requests): `Rounded(NodeLimit)` on generated g0111 and `Rounded(EventLimit)` on the crossing ellipses c11/c12, at about 256 edges.
- **Not decided here:** whether any request of cause 3 is the closed-list E8 class (M1′, a tangential reversal). The diagnostic stops at the kernel error; the E8 class needs the knot-level test of the [E8-U3 record](../plans/d9-rendering-track.md#e8-u3-record-and-e8-close-2026-10-24).

## Method

`pnpm e16:fill-diag <corpus.json>` (new, manual, never CI): `tests/geometry/e16/fill-input.check.ts` reads a corpus sweep record, rebuilds each failed fill request from the frozen corpus exactly as the sweep serves it (tolerance exponent by V3 section c), and writes it as input to the existing ignored native test `e14_fill_limit_diag` (release profile). That test runs `build_path`'s stage-4 order on `FILL_V0_LIMITS` (rung 0, then `attempt`, then `attempt_triangle_free` after `KnotMismatch` or `Unresolved`) and prints rung 0's reason and each exact step's kernel error, unmapped. The tool classifies by the first exact step's error (`SourceLimit`; `CommandLimit` or `OwnerLimit`; `ZeroLengthLeaf`; `Topology`, or `Rounded` after the retry) and writes `summary.tsv`.

Run: container, Node 24.15.0, cargo stable (native, release), 2026-10-25, about 2 min; first at `dd3d51d` with the uncommitted tool, then again at `main` `0b01024` (#245 merged; the fill identity is unchanged at `fill-v0+r3`, though #246 refactored rung-0 storage in `fill_ladder.rs`) with the tool as committed here, with an identical `summary.tsv`. Sweep record: `2026-10-25T15-10-56-907Z-beee919e` (clean commit `dd3d51d`, WASM `8bac62c3…ddb`). Every failed request (1,655) produced a native row, and each native outcome maps to the port's code: `SourceLimit`, `CommandLimit`, `OwnerLimit` and `Rounded` map to `work-limit`; `Topology` and `ZeroLengthLeaf` map to `unsupported-geometry`.

## Result by row family

Requests [distinct rows]. Flat verbs is the S1 sizing plan's count (MOVE and CLOSE included; 0 means the source cap stopped the path before sizing).

| Stratum | Sweep class | Cause | Rung 0 | Requests [rows] | Flat verbs min/median/max | Rows |
| --- | --- | --- | --- | --- | --- | --- |
| C11 named | `work-limit` | Source cap | `PREFIX` | 70 [5] | 0/0/24 | f01 (199 segments), f03 (16 contours), f04 (321 segments), f06 (5 contours), f08 (6 contours) |
| C12 named | `work-limit` | Source cap | `PREFIX` | 14 [1] | 25 | j02 (5 contours) |
| C3 named | `work-limit` | Edge cap | `MONOTONE` | 27 [9] | 258/327/1,028 | c03 c06 c07 c08 c09 c10 c25 c26 c30 |
| C3 named | `work-limit` | Edge cap | `PREFIX` | 2 [1] | 16,386 | c27 (circle of radius 4,096, over E0) |
| C3 generated | `work-limit` | Edge cap | `MONOTONE` | 151 [21] | 258/349/961 | g0004 g0014 … |
| C4 named | `work-limit` | Edge cap | `CLEARANCE` | 54 [6] | 263/516/2,052 | n09-n14 |
| C3 named | `work-limit` | Topology cap | `CROSSING` | 2 [2] | 260 | c11 c12 (`Rounded(EventLimit)`) |
| C3 generated | `work-limit` | Topology cap | `MONOTONE` | 8 [1] | 256 | g0111 (`Rounded(NodeLimit)`) |
| C3 named | `unsupported-geometry` | Topology unresolved | `MONOTONE` | 21 [9] | 4/11/18 | c04 c05 c10 c11 c12 c20 c21 c28 c29 |
| C3 named | `unsupported-geometry` | Zero-length leaf | `PREFIX` | 22 [2] | 8/33/223 | c22 c23 |
| C3 generated | `unsupported-geometry` | Topology unresolved | `MONOTONE` | 877 [115] | 4/13/252 | g0000 g0001 … |
| C3 generated | `unsupported-geometry` | Topology unresolved | `STRUCTURE` | 95 [15] | 3/4/11 | g0042 g0064 … |
| E14-Q1 (for comparison) | `work-limit` | Edge cap | `CROSSING`, `MONOTONE`, `PREFIX`, `CLOSURE` | 312 | 258 to 2,113 | C3, C6 c11, C12 j06 |

Generated rows can appear in more than one line at different transforms (for example g0004, g0102), so row counts are per line; 123 distinct generated rows end in `Topology(Unresolved)`. The full table, with all row names, is the tool's `summary.tsv`.

## Fix directions (for a contract, not decided)

- **F1, source caps (cause 1).** Give rung 0 its own source caps (contours and segments), as E14-K1 did for edges; the exact rung keeps B1. The C11 rows were built to reach the renderer's region-only path (`fringe-work-cap`, `fringe-unsupported`), so their meshes are expected and A04 measures them. Alternative: a closed-list class for "source over the B1 caps" with a backlog item. It would set aside "named ordinary fixtures must succeed" for six named rows, so it is weaker.
- **F2, exact-rung edge cap on paths without a crossing (cause 2).** E14-U2 (the output-sensitive exact rung, E14 backlog) or a rung-0 change that accepts `MONOTONE` and `CLEARANCE` refusals it can resolve. C4 is all `CLEARANCE`: near-touching pairs at local gaps of 2^-3 to 2^-16 (`C4_GAPS`), cubic-line on n09-n11 (E14-F7's shape) and cubic-cubic on n12-n14, so a fixture set needs both. c27 (over E0) is E14-R5.
- **F3, topology unresolved (cause 3).** The largest family, and on small paths, so no cap is involved. An investigation like E8's comes first: which knot or arrangement step returns `Unresolved` on the loop, cusp, inflection and crossing rows, and on the generated cubics. It may overlap the E8 class (M1′) and E14's 41 small looping scene paths.
- **F4, topology caps (cause 4).** Ten requests at about 256 edges; likely resolved with F2's exact-rung work.

The order and scope are a user decision (new kernel work, Full tier). Without F1 to F3, A02 cannot pass at the snapshot unless the closed list grows, which E11 section 7.2 and the private contract's "named ordinary fixtures must succeed" do not allow without a user decision.

## Closed-list class count (update 2026-10-25)

E11 section 7.2 (update 2026-10-25, the user decision of E11 section 9.2) adds two classes, decided on the native outcome:

- **"Fill stop in the exact rung's caps".** Rung 0 did not mesh the row, and the row is not in E14-Q1. The exact rung's terminal error, at e or as the stop error of the last E16-K2 retry, is one of:
  - `CommandLimit`, `OwnerLimit`, `Rounded(_)` or `Topology(WorkLimit)`;
  - `SourceLimit` on a line-only path over the exact rung's line segment cap (E = 256, E16-U1's `B1_LINE_CAPS`).
- **"Fill `ZeroLengthLeaf`".** The exact rung ends in `ZeroLengthLeaf`.

The sweep cannot see native errors, so `pnpm e16:fill-diag` assigns these classes. It also writes `classes.tsv`, which gives each stratum's failed fill requests by class: `E14-Q1`, `exact-rung cap stop`, `zero-length leaf`, or `outside:` with the cause. The input sidecar now carries each path's cubic count, for the line-only test. The terminal error at e is the triangle-free retry's error when that retry ran, and otherwise the exact attempt's. The cap-stop test takes either that error or the last retry's stop error, which E16-U1 prints as `retryStop` (`depth:error`). The E4 and E8 classes are left to the evidence review, as before.

The classes apply only once `fill-v0+r4` has merged, so the counts below on `fill-v0+r3` are a PRE-FREEZE preview. On the same input, with `summary.tsv` unchanged:

| Stratum | E14-Q1 | Exact-rung cap stop | Zero-length leaf | Outside |
| --- | --- | --- | --- | --- |
| C3 generated | 267 | 159 | 0 | 972 (topology unresolved) |
| C3 named | 32 | 31 | 22 | 21 (topology unresolved) |
| C4 named | 0 | 54 | 0 | 0 |
| C6 named | 8 | 0 | 0 | 0 |
| C11 named | 0 | 14 (f04, 321 line segments) | 0 | 56 (source cap) |
| C12 named | 5 | 0 | 0 | 14 (source cap) |

The classes take causes 2 and 4 (244), f04's 14 requests of cause 1, and the 22 `ZeroLengthLeaf` requests of cause 3. The other 70 requests of cause 1 and the 993 `Topology(Unresolved)` requests of cause 3 stay outside until the E16 remedy.

## Coordination

- E11 (exit snapshot): told on 2026-10-25 that A02 would fail on `fill-v0+r3` and that this record exists, so its snapshot plan accounts for it.
- E14: cause 2 is E14-R2 and E14-R5 seen in the corpus; F2 names E14-U2.
- E2 owns stroke. The 969 stroke `work-limit` and other stroke rejections of the same sweep are A03's and are not classified here.

## F1 and F3 investigation, 2026-10-25

Dated append, input to the [E16-U1 contract](../plans/d9-e16-fill-rejection-remedy-contract.md). Kernel `fill-v0+r3`, `main` `d85f634`, in the container (Node 22.22.0, Rust 1.94.1, native release). The A01 corpus sweep was re-run at `d85f634` (record `2026-10-25T18-22-22-282Z-fd6634f4`, WASM `5c9bcc2c…b879`; marked dirty only by an untracked local copy of the geometry test runner with the Linux host pin) and again has 1,655 rejected fill requests, which `pnpm e16:fill-diag` classifies as above. The probes below are scratch `cfg(test)` changes to `e14_fill_limit_diag` and `simple_cubic_topology.rs`, not committed, as in the E8 investigation. **PRE-FREEZE**; precision stays **UNVERIFIED**.

**F1, source caps.** All six named rows are line-only polygons. With the cubic-fill source caps raised to 64 contours and 4,096 segments for both rungs (a scratch build), the 84 requests end as follows: f01 14 of 14 meshed by rung 0; f04 10 meshed by rung 0, 4 refused by rung 0 (`CLEARANCE`) and then `OwnerLimit` at 321 segments; j02 12 meshed by rung 0 and 2 refused (`CLEARANCE`) and meshed by the exact rung; f03, f06 and f08 refused by rung 0 at every transform (`CROSSING` 37, `CLEARANCE` 5) and meshed by the exact rung's line fill. Raising rung 0's caps alone would mesh 36 of 84; raising the exact rung's caps for line-only paths as well, 80.

**F3, topology unresolved.** A probe recorded the source line of each `Unresolved` return. On all 993 requests the last exact step (`attempt_triangle_free`) fails at one of three checks:

| Check that fails | Requests [named] | Rung 0 |
| --- | ---: | --- |
| Adjacent leaves have no common monotone direction (`rounded_adjacent_projection`, E8 addendum E8.3) | 800 [8] | `MONOTONE` |
| Non-adjacent leaves whose hulls meet have no certified transverse crossing | 98 [13] | `MONOTONE` |
| A contour has fewer than three leaves (`validate_minimum_leaves`) | 95 [0] | `STRUCTURE` |

Every named request of this cause is at zoom 0.01, below a device pixel: c04 and c05 (loop), c10, c11, c12, c20, c21, c28 and c29. Generated rows fail at every zoom, since the corpus scales them to the same device size.

A second probe re-ran the unchanged cascade (`attempt`, then `attempt_triangle_free`) at the exponents e − 1, e − 2, … down to e − 20, stopping at the first success with flat status `PATH_OK` or the first error that is not `KnotMismatch` or `Unresolved`:

| Check | Kind | Meshed [rows] | Depth k min/median/max | Stopped at the edge cap [rows] |
| --- | --- | ---: | --- | ---: |
| Adjacent | generated | 613 [82] | 1/4/12 | 179 [25]: `CommandLimit` 150, `OwnerLimit` 29 |
| Adjacent | named | 8 [2] | 1/3/4 | 0 |
| Non-adjacent | generated | 53 [8] | 1/2/5 | 32 [6] `CommandLimit` |
| Non-adjacent | named | 13 [7] | 1/3/6 | 0 |
| Minimum leaves | generated | 91 [14] | 1/6/9 | 4 [1] `OwnerLimit` |

778 of 993 requests mesh, every named one among them, none deeper than k = 12; the other 215 reach E = 256 flat edges first, and none stays unresolved below the cap. An earlier run of the probe, down to e − 8 only, tried both topology tolerances (from e − k, or kept at e − 1) and found the same 725 meshed requests for both; the final run above derives both tolerances from e − k. On the 22 `ZeroLengthLeaf` requests (c22, c23), a variant of the retry that also continues past `ZeroLengthLeaf` (which E16-K2's trigger and stop rule do not) ends at `CommandLimit` on every request, at k = 1 to 14. Running rung 0 at the same finer exponents meshes 107 of the 778 and none of the 215: the others stay `MONOTONE` or reach `PREFIX`.

## Result at `fill-v0+r4` (E16-A6), 2026-10-26

On the E16-U1 commit the corpus sweep counts 7,086 fill `ok` (was 6,228), 560 `work-limit`, 237 `unsupported-geometry` and 2 `empty`. Of the 797 failed requests, 312 are E14-Q1, 463 are in E11's class "fill stop in the exact rung's caps" and 22 in "fill `ZeroLengthLeaf`"; none is outside every class. Details in the [E16-U1 evidence](e16-u1-2026-10-25.md#e16-a3-and-e16-a6-corpus-and-scene-sweep).
