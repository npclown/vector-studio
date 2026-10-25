# E14 fill `work-limit` cause, 2026-10-24

Rendering track item E14 ([status index](../plans/d9-rendering-track.md#status-index)), promoted to R1 by the user on 2026-10-24 together with E2. This record answers E14's acceptance check, "a written cause (which cap)", and proposes the fix direction for the E14 contract. It changes no kernel output, cap, threshold or closed list. Stroke is E2's ([split agreed with the E2 thread](#coordination-with-e2)).

## Summary

- **Cause.** All 641 fill `work-limit` results of the [E11-U2 scene run](../plans/d9-rendering-track.md#e11-e11-u2-evidence-2026-10-24) are the S1 prefix's flattened-edge cap, `MAX_EDGE_OWNERS = 256` (`packages/geometry-wasm/kernel/src/cubic_fill.rs`): 638 `CubicFillError::CommandLimit` (more than `MAX_FLAT_COMMANDS` = 264 flat commands) and 3 `OwnerLimit` (more than 256 edges within 264 commands). None is the exact rung's pair, section or work budget (`FILL_V0_LIMITS.max_work` 32M is never reached), because the prefix rejects the path first.
- **Why the cap is hit.** V3 chooses the tolerance bucket with `2^e · σ ≤ 0.125`, so the flattening tolerance is between 1/16 and 1/8 device px. The edge count a curve needs grows as the square root of its size over that tolerance: on this scene about 10·√(R/tol) for smooth paths. 256 edges is reached at about 32-64 device px of radius.
- **The flattener is not the lever.** The P2 binary-subdivision flattener emits only 1.12-1.3× the edges of a per-cubic uniform minimum on smooth paths of 32 px or more (1.6× on looping paths). Even that minimum needs more than 256 edges above about 64 px.
- **Experiment.** With only the prefix and rung-0 edge cap raised to 4,096 (scratch build, not committed), rung 0 meshes every smooth path below 8,192 px of radius and fill goes from 318 to 731 of 1,000. Looping paths then fail in the exact rung with `Topology(WorkLimit)`.
- **Fix direction (recommended).** E14-U1: give the S1 prefix and rung 0 their own edge cap (candidate 8,192) and keep the exact rung's E = 256 budgets. Large self-intersecting paths need a second remedy (E14-U2) or a closed-list decision before the exit.

## Method

`pnpm e14:fill-diag` (new, manual, never CI): `tests/geometry/e14/fill-input.check.ts` writes the E11-U2 scene `p3-exit-stress/v1` (the same generator, seed and tolerance exponents) as input, and the ignored native test `e14_fill_limit_diag` (`packages/geometry-wasm/kernel/src/e14_fill_limit_diag_tests.rs`, release profile) runs `build_path`'s stage-4 order on `FILL_V0_LIMITS`: rung 0, then `attempt`, then `attempt_triangle_free` after `KnotMismatch` or `Unresolved`. It prints the S1 sizing plan's flat verb count and each step's kernel error before the port mapping. The native outcomes reproduce the E11-U2 WASM run: 318 meshes (rung 0 103, exact 199, triangle-free 16), 641 `work-limit` and 41 `unsupported-geometry` (`Topology(Unresolved)`).

Run: container, Node 22.22.0, cargo 1.97.0, branch `claude/eng-e14-fill-work-limit` on top of E11-U2's branch (PR #225), 2026-10-24.

## Outcome by size

Device radius is the largest distance of a path point from the origin × zoom × DPR, as in the E11-U2 record. Flat verbs counts MOVE and CLOSE, so 264 is the cap.

| Radius (device px) | Smooth: outcome | Smooth: flat verbs, median/max | Looping: outcome | Looping: flat verbs, median/max |
| --- | --- | --- | --- | --- |
| < 1 | 37 mesh | 34/46 | 12 `Unresolved` | 81-94 (medians)/122 |
| 1-4 | 91 mesh | 44-76 (medians)/111 | 21 `Unresolved` | 133-171 (medians)/209 |
| 4-16 | 115 mesh | 100-143 (medians)/198 | 20 `CommandLimit`, 8 `Unresolved` | 237-311 (medians)/419 |
| 16-32 | 46 mesh, 1 `CommandLimit`, 1 `OwnerLimit` | 189/266 | 23 `CommandLimit` | 482/629 |
| 32-64 | 29 mesh, 36 `CommandLimit`, 2 `OwnerLimit` | 270/357 | 22 `CommandLimit` | 655/844 |
| 64-4,096 | 327 `CommandLimit` | 370-2,020 (medians)/2,749 | 109 `CommandLimit` | 868-4,599 (medians)/6,701 |
| ≥ 4,096 | 65 `CommandLimit` | 2,766-9,284 (medians)/9,284 | 35 `CommandLimit` | 7,133-24,009 (medians)/24,009 |

## The flattener's share

A Python mirror of the P2 flattener ([`flattener-share.py`](e14-fill-work-limit-2026-10-24/flattener-share.py), a scratch analysis committed with this record; it is not a test) (`geometry.rs` `visit`: binary subdivision until the control points are within the tolerance of the chord's third points) reproduces the kernel's flat verb counts within the two MOVE and CLOSE verbs on the first 400 scene paths, and the table below covers those 400 paths. Against it, the smallest uniform-in-t split per cubic whose chords stay within the tolerance (16 samples per chord) gives:

| Radius (device px) | Kernel edges / per-cubic uniform minimum, smooth | Same, looping |
| --- | --- | --- |
| 2-8 | 2.2 | 1.7-1.8 |
| 8-32 | 1.3-1.5 | 1.7 |
| 32-16,384 | 1.12-1.28 | 1.57-1.65 |

So a better flattener saves at most about 1.3× on large smooth paths. It would also change the dyadic provenance numerators that the exact rung and the leaf partitions check, so it is not proposed for E14.

## Experiment: a separate rung-0 cap

Scratch copy of the kernel, not committed. `MAX_EDGE_OWNERS` 256 → 4,096 (the prefix arrays and rung 0's `MAX_EDGES`), with `FILL_V0_LIMITS.max_pairs` and the quadratic part of `max_sections` held at their E = 256 values so that the exact rung keeps its budget, and the 16 MiB byte caps raised so that the workspace reserves. The module `fill_ladder_tests` was left out of the build, because its test `ladder_storage_is_reserved_once_and_checked_against_the_fill_scratch` holds a `const` assertion that pins rung 0 to E = 256. The exact patch, with the values `max_pairs` 32,640, `max_sections` 2·256² + 2·4,096 = 139,264, `max_bytes` 512 MiB and `MAX_COMBINED_HEAP_BYTES` 1 GiB, is [`rung0-cap-4096-experiment.patch`](e14-fill-work-limit-2026-10-24/rung0-cap-4096-experiment.patch).

| Outcome | Today (E = 256) | Rung-0 cap 4,096 |
| --- | --- | --- |
| Mesh, rung 0 | 103 | 516 |
| Mesh, exact or triangle-free | 215 | 215 |
| `CommandLimit` / `OwnerLimit` | 641 | 66 (smooth ≥ 8,192 px: 19; looping ≥ 1,024 px: 47) |
| `Topology(WorkLimit)` | 0 | 162 (looping, 4-4,096 px) |
| `Topology(Unresolved)` | 41 | 41 |

- Every smooth path below 8,192 px of radius meshes, through rung 0 from 32 px up (10 of 18 between 8,192 and 16,384 px). No smooth path that rung 0 rejected at 32 px or more needed the exact rung.
- `size_of::<FastRung>()` grows from 113,240 to 1,726,040 bytes.
- Rung-0 wall time grew about linearly with edges in the native release build, roughly 2 µs per edge (median 2.9 ms at 1,427 edges). Diagnostic only, not performance evidence ([benchmarks README](../benchmarks/README.md)).
- NOT RUN: the E11-U2 structure checker on the experiment's meshes (only rung 0's own AL-FR9 mesh check ran), WASM build, browsers.

## Fix direction

| Option | Effect on this scene | Cost and risk | Proposed |
| --- | --- | --- | --- |
| **F1.** Separate the S1 prefix and rung-0 edge cap E0 from the exact rung's E = 256 | Smooth paths mesh up to the new cap (4,096 measured: all smooth paths below 8,192 px) | Fill output changes for those paths, so a fill revision bump (`fill-v0+r3`), shared surface, Full tier, both-track review. `FillScratch` vertex and triangle space and AL-FR9 records scale with E0. Needs a performance gate under the benchmarks README and an A01 sweep rerun | **Yes, E14-U1.** E0 to be fixed in the contract from the A04 large class (up to 8,192 px extent at 1/16 px tolerance); candidate 8,192 |
| **F2.** An output-sensitive exact rung for self-intersecting paths (a swept crossing collector, the fill analog of E2-alt) | Looping paths over about 16 px | The largest change: a new exact-rung algorithm with its own certificate tests; the exact rung's pair and section budgets are quadratic in E today (E = 4,096 would mean about 33M sections) | Contract after F1 (E14-U2), or a closed-list decision (below) |
| F3. A better flattener | At most about 1.3× fewer edges on smooth paths | Provenance numerators change | No |
| F4. A coarser tolerance bucket | √2 fewer edges per bucket step | Uses the A04 0.25 px budget meant for the rest of the pipeline; changes V3 | No |
| F5. Add fill `work-limit` to the E11-Q2 closed list | Exit unblocked without a fix | Masks ordinary smooth geometry, which is exactly what the P3 plan text the closed list sets aside forbids | No, for smooth paths |
| F6. Viewport clipping before flattening | Bounds edges for paths much larger than the viewport | Renderer and port semantics change; beyond P3 | Backlog note only |

**Open question E14-Q1, for the E14 contract.** If F2 does not land before the P3 exit, may the E11-Q2 closed list take a narrow class "fill `work-limit` on a self-intersecting path whose S1 flat edge count exceeds 256", with a named fixture and E14 as the backlog item? Recommended: yes, with F1 required first, but the contract must settle three points the class does not settle by itself:

- **Membership test.** "Self-intersecting" needs a test the A01 sweep can apply when it counts rejected rows per class (E11 section 7.2), for example an exact crossing check on the source cubics, not the generator's label.
- **What stays outside every class.** F1 does not make every simple path mesh. A smooth path beyond E0 still fails (the scene has one at 9,284 flat verbs, above 8,192), and a simple path over 256 edges that rung 0 rejects for `MONOTONE` or `CLEARANCE` falls back to the exact rung and fails there. Both would fail A02 outside any class. E0 must therefore be fixed against the A04 large class, which bounds physical extent (up to 8,192 px), while this record measures radius, so a factor of about two has to be carried into that choice.
- **The frozen text it sets aside.** Like E11-Q2 (a), the class would set aside the P3 plan's "prevent blanket NUMERIC_RANGE/WORK_LIMIT from masking unsupported geometry" for that class, and the contract must quote it.

## Coordination with E2

Agreed with the E2 thread on 2026-10-24: E2 owns the stroke side (which stroke cap fires, the ST-U9 addendum, E2 against E2-alt), E14 owns the fill side and this cause write-up.

E2's stroke breakdown on the same scene (reported by the E2 thread, to be recorded as `docs/evidence/e2-stroke-work-limit-cause-2026-10-24.md` on its branch; not reproduced here): of 879 stroke `work-limit` results, 712 are the front end's `PieceLimit` (512 pieces), 140 the arrangement's `InputLimit` (1,024 vertices), 109 `DepthLimit`, 12 `NodeLimit` and 3 `EventLimit`. The stroke knee is not the fill cause: it is B2's cubic-leaf rule, whose 4·r·sin term makes leaf demand grow linearly with device stroke width. Only for very large radii does stroke meet the same √(R/tol) growth as fill.

Shared constraint: E2's proposed family-B rung feeds stroke rings to the fill ladder's rung 0 under its own stroke cap. E14-U1 therefore adds the rung-0 cap E0 as its own constant and does not change any stroke cap.

## Update 2026-10-25: E14-U1 result

E14-U1 implemented option F1 at `fill-v0+r3` (rung-0 cap E0 = 8,192, work cap W0 = 2^22). On the same scene the fill `ok` count is 748 of 1,000 (318 at `r2`, 731 in the 4,096-cap experiment above), with zero structure issues; every smooth path up to E0 meshes in rung 0, and of the 252 remaining failures, 250 are looping paths (209 `CommandLimit`, 41 `Topology(Unresolved)`) and 2 are smooth paths over E0 (`CommandLimit`). Evidence: [e14-u1-2026-10-25.md](e14-u1-2026-10-25.md).
