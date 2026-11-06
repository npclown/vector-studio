# D9 E14-U2: a larger edge cap for the fill exact rung

Status: **DRAFT 2026-11-06**, documentation only, independent review pending ([section 11](#11-review-record)).

This is rendering-track item E14 ([D9 rendering track](d9-rendering-track.md#status-index)), unit E14-U2, which was in the backlog since 2026-10-25 ([E14 §9](d9-e14-fill-rung0-edge-cap-contract.md#9-units)). The user started it on 2026-11-06, in the thread "Fix large paths vanishing on fill". They chose it on a decision card ("fill 256변 한도 개선") over a renderer stopgap that would retry at even coarser tolerances. The unit is full tier: it changes fill output, the fill operation id and kernel caps. It changes no threshold of the [P3 acceptance table](p3-fill-stroke-meshes.md#runtime-acceptance-coverage-to-freeze-in-p30b), no tolerance bucket, no share of the 0.25 px budget and no stroke cap. Identifiers use the prefix **E14-U2-**, shortened to **X** in this document (X-K1, X-G1 and so on).

## 1. Cause

On 2026-11-06 the user sent two pen paths from the editor:

- node-3: 619 × 410 px, 28 cubics and a line.
- node-8: 1,076 × 557 px, 16 cubics.

Both draw with their stroke and disappear entirely when a fill is applied. Measured natively on `main` 3ec23c9 (`fill-v0+r4`, `stroke-v0+r8`) through `build_path` and `prepare_prefix`:

| Path | Flat edges at `e` = 0, −1, −2, −3, −4, −5 | Fill outcome | Stroke |
| --- | --- | --- | --- |
| node-3 | 241, 339, 471, 667, 925, 1,314 | `ok` (exact rung) at `e ≥ 0`; `work-limit` at `e ≤ −1`: rung 0 `MONOTONE`, then the exact rung's `CommandLimit` | `ok` at `e ≥ −1` (E37) |
| node-8 | 197, 275, 386, 539, 766, 1,077 | the same | `ok` at `e ≥ −2` (E37) |

- **The cap.** Both paths cross themselves, so rung 0 refuses them, and the exact rung's S1 prefix stops at E = 256 flat edges (`MAX_EDGE_OWNERS`, `cubic_fill.rs`). This is the E11 closed-list class "fill stop in the exact rung's caps" ([E11 §7.2](d9-e11-p3-c03-c05-closure-contract.md#72-known-defects-at-the-exit)), whose backlog item is E14-U2.
- **Why the whole path disappears.** A failed paint hides the node (#523 found the same for a failed stroke).
- **Why the coarser retry does not save it.** The renderer retries a `work-limit` at up to three coarser exponents (#522, `WORK_LIMIT_COARSER_STEPS`). At zoom 1 and DPR 1 (`e = −3`) that reaches `e = 0` and the fill draws. At DPR 1.25 to 2 (`e = −4`) it stops at `e = −1` and the fill fails. The user's screen is in the second case.
- **Lowering the tolerance is not a fix.** The flat edge count grows as the inverse square root of the tolerance: four times coarser only halves it. A larger or busier path passes 256 even at `e = 0`, and a 1 px document tolerance is 2 device px at DPR 2, which shows on large curves.

## 2. The probe

A scratch build on 3ec23c9 (not committed) raised the exact rung's caps and kept every algorithm unchanged:

- `MAX_EDGE_OWNERS` 256 → 1,024, which `FILL_V0_LIMITS` derives from;
- the topology certificate's leaves (`ABSOLUTE_MAX_LEAVES`) 256 → 1,024, its crossing ceiling (`MAX_CROSSINGS`) 32 → 256 and its byte cap 1 MiB → 64 MiB;
- `max_work` 32M → 512M;
- the byte caps raised so that the workspace builds.

| Variant | Fill engine reserved bytes | node-3 at `e` = −2, −3, −4 | node-8 at `e` = −2, −3, −4 |
| --- | ---: | --- | --- |
| `main` (E = 256) | 16,743,924 | `work-limit` | `work-limit` |
| E = 1,024, sections quadratic in E (2E² + 2E = 2,099,200) | 90,287,772 | `ok`, exact rung, 20 / 32 / 51 ms | `ok`, 14 / 20 / 34 ms |
| E = 1,024, sections at today's absolute 131,584 | 27,324,060 | `ok`, the same times | `ok`, the same times |

The times are native release on the container and are not a performance claim. The section array dominates memory: `max_sections` is the pessimistic bound "events · E + 2E" and grows with E². Both paths need far fewer sections than that bound. With the topology caps left at 256 leaves and 32 crossings, both paths stopped at `Topology(WorkLimit)` instead.

On the probe build, 22 of 530 native kernel tests fail. Each pins a cap, a reserved byte count or a fixture whose expected outcome was the cap stop (for example `b1_257_leaves_fail_with_owner_limit`, `e14_f1_to_f3_circles`, `e16_f9_clearance_stays_work_limit`, `runtime_limits_equal_the_native_test_limits` and the constructor byte-count tests). None fails on a changed mesh.

## 3. Terms

- **E** = 256, the exact rung's edge cap today. **EX** = the new cap (X-Q1, recommended 1,024).
- **E0** = 8,192, rung 0's edge cap (E14-U1), unchanged.
- **Today** means `fill-v0+r4` on `main` 147d925.

## 4. X-K1: the exact rung's edge cap

1. `MAX_EDGE_OWNERS` becomes EX. The exact prefix caps, `MAX_FLAT_COMMANDS`, `MAX_CONTOUR_POINTS`, `MAX_EXACT_FLAT_COMMANDS` and `MAX_LINE_SOURCE_SEGMENTS` follow it as they do today. Rung 0's caps (E0) and `MAX_CONTOURS`, `MAX_SOURCE_SEGMENTS` and `MAX_LINE_CONTOURS` do not change.
2. `FILL_V0_LIMITS` keeps its derivation from E for edges, input vertices, pairs, events, nodes, cells, boundaries, contributors, vertices and triangles, with two exceptions:
   - `max_sections` (X-K2);
   - `max_work` and `max_bytes` (X-K3).
3. The topology certificate (`simple_cubic_topology.rs`):
   - `ABSOLUTE_MAX_LEAVES` follows EX, so the "leaf cap equals `MAX_EDGE_OWNERS`" rule of the B1 caps holds;
   - `MAX_CROSSINGS` becomes X-Q3's value;
   - `ABSOLUTE_MAX_BYTES` is set to fit those.
   - `ABSOLUTE_MAX_CUBICS` (64) does not change.
   - Stack arrays sized by these constants (for example `leaves` in `cubic_fill.rs`, `[TopologyLeaf::default(); MAX_EDGE_OWNERS]`, and the topology's `crossings` array) move to reserved heap storage when they no longer fit a WebAssembly stack frame. This is E14-U1's storage rule (E14 §3 item 4).
4. `MAX_COMBINED_HEAP_BYTES` (`cubic_fill.rs`) and the fill engine's byte caps are raised to the measured reservation plus a stated margin. X-G3 bounds the growth.
5. **Not changed.** The flattener, the tolerance buckets, rung 0 and its stages, the exact rung's cascade order, E16-K2's retries, every stroke cap (E37 stays backlog), the renderer's coarser retry and the port format.

## 5. X-K2: the section budget is not quadratic

`max_sections` stops following 2E² + 2E. It takes a fixed value, recommended at today's 131,584 (X-Q2). A path that needs more sections stops at the rounded arrangement's `SectionLimit`, which maps to `work-limit` as it does today. With that value no path that meshes today can fail on sections, because the budget is not lowered. The probe shows that the memory cost of EX is then about 10.6 MB rather than 73.5 MB.

## 6. X-K3: work and bytes

- `max_work` scales by the measured cost, not by E². X-U1 measures the work units that the exact rung charges on the fixtures and on the scene paths that become `ok`, and sets the cap to the largest measured value times 4, rounded up to a power of two. The aim is that a path near EX costs at most about 250 ms natively. The probe's 512M is an upper bound for exploration only. X-U1 records the value and the time of the slowest admitted fixture.
- The workspace keeps its allocation rules (E14 §3 item 6): every byte is reserved once at `fill_v0_reserve`, fallibly, and counted in `linearMemoryBytes()`. `fill_v0_process` allocates nothing and moves no storage.

## 7. Identity, documents and the precision label

- **Revision.** Fill output changes for paths that rung 0 refuses and that have E + 1 to EX flat edges: they were `work-limit` and can become `ok`. `FILL_V0_REVISION` becomes 5 in `fill_export.rs` and `fill-adapter.ts`, and the operation id becomes `'geometry-wasm/fill-v0+r5'`. Every literal pin follows: the X-U1 pull request finds them with a repository search for `fill-v0+r4` and fill revision 4, as E14-U1 did.
- **Outcome identity.** On every path with at most E flat edges, and on every path that rung 0 meshes, the export output is bit-identical to today's (AL-I1, AL-I2). X-K2 keeps the section budget, and X-K3 does not lower the work cap, so no path that meshes today can stop earlier.
- **Size records.** The workspace and engine size records change (`meta/cubic-workspace-sizes`, `meta/fill-engine-sizes`). The identity tool's combined mode (`--failure-to-success --revision-change`) records them as changes, as for E14-U1.
- **E11 closed list.** Rows of "fill stop in the exact rung's caps" that become `ok` leave the class. E11 §7.2 gains a dated note. The class stays for paths over EX and for paths that still stop on sections or work.
- **Precision.** The exact rung's meshes are certified as today. The label stays UNVERIFIED until E3's measurement covers the new rows.

## 8. Gates

- **X-G1, outcomes (deterministic).** Run `pnpm test:p3-fill-identity --failure-to-success --revision-change --base <merge base>`. Every case must be identical to `r4` or move from `work-limit` to `ok`. No `ok` row changes, and no row moves to `unsupported-geometry`, `numeric-range` or an internal error.
- **X-G2, cost (diagnostic A/B, native release, one machine).** On paths that mesh at `r4`, the per-path median time of `build_path` at `r5` is at most 1.10 × the `r4` median, per corpus. The new `ok` rows' times are recorded, not gated.
- **X-G3, memory.** The fill engine's reserved bytes grow by at most 16 MiB over `r4`; the probe measured 10.6 MB. The before and after totals are recorded. `process_does_not_allocate_or_move_storage` passes on X-F2 to X-F4.
- **X-G4, claims.** E14-U2 makes no speed claim.

## 9. Acceptance, fixtures and validation

Fixtures are at zoom 1, nonzero, document coordinates. The user's two paths are fixed as literals from the thread, in frame space as in `e35_hairpin_retry_tests.rs`.

| Fixture | Path | Flat edges | Today | Expected at `r5` |
| --- | --- | ---: | --- | --- |
| X-F1 | E14-F1, circle radius 512 | 256 | `ok`, rung 0 | `ok`, bytes unchanged (control at E) |
| X-F2 | The user's node-3 at `e` = −2, −3, −4 | 471 to 925 | `work-limit` (`MONOTONE`, `CommandLimit`) | `ok`, exact rung |
| X-F3 | The user's node-8 at `e` = −2, −3, −4 | 386 to 766 | `work-limit` | `ok`, exact rung |
| X-F4 | E14-F5 (scene path 3, looping, over E) at its recorded tolerance | recorded | `work-limit` | `ok` if within EX, recorded |
| X-F5 | E14-F7 (near-touching simple path) | recorded | `work-limit` | recorded; `ok` if within EX and the cascade certifies it |
| X-F6 | node-3 at `e = −5` (1,314 edges, over EX) | 1,314 | `work-limit` | `work-limit` (`CommandLimit`), the inclusive cap |
| X-F7 | A path with exactly EX flat edges that rung 0 refuses, and its variant with EX + 1; literals found by search in X-U1 | EX, EX + 1 | `work-limit` | EX: `ok` or a recorded topology stop; EX + 1: `CommandLimit` |

| ID | Criterion |
| --- | --- |
| X-A1 | X-G1 to X-G3 pass |
| X-A2 | The fixture table holds, with the rung and reason read through `build_path` natively |
| X-A3 | Every new exact-rung mesh of X-F2 to X-F5 passes SL-O2, the independent region and mesh validity check |
| X-A4 | AL-I1 and AL-I2 hold on every case of the identity tool's native layer |
| X-A5 | Seeded defects are caught: X-D1 `max_sections` left quadratic (X-G3 fails); X-D2 the topology leaf cap left at 256 (X-F2 stops at `Topology(WorkLimit)`); X-D3 a work cap below the measured value (an X-F2 case stops at `work-limit`) |
| X-A6 | The release WASM meshes X-F2 and X-F3 through the adapter, so no new array sits on the WebAssembly stack |
| X-A7 | The A01 corpus sweep record (`pnpm e16:fill-diag`) is re-run and reports how many rows leave "fill stop in the exact rung's caps" and E14-Q1, per stratum |
| X-A8 | Headed GPU on the user's PC: the fill specs that pin the operation id (`p3-v4-paths`, `viz-v2`, `viz-v3`, `p3-b2-strokes`, `viz-v1`) pass; the editor on :4194 draws node-3 and node-8 filled at the PC's DPR |

**Validation.** `pnpm check`, `pnpm build`, `pnpm test:geometry` (native tests, fixtures and seeded defects), the identity tool in combined mode, the X-G2 A/B run, the A01 sweep and the headed run.

## 10. Questions

**X-Q1. The value of EX.**

- (a) **Recommended: 1,024.** It covers both user paths down to `e = −4` (DPR 2 at zoom 1) with about 10 % margin on node-3. The probe measured the memory.
- (b) 2,048. It covers node-3 at `e = −5`, but the topology certificate and pair budgets grow fourfold. It needs its own probe.

**X-Q2. The section budget.**

- (a) **Recommended:** a fixed 131,584, today's value (X-K2).
- (b) Keep it quadratic in EX. That reserves about 90 MB.
- (c) A smaller fixed value. It would lower today's budget and could break meshes that work today.

**X-Q3. The topology crossing ceiling.**

- (a) **Recommended:** 256, the probe's value, which both paths need below. X-U1 records each fixture's crossing count.
- (b) EX / 2. That is the pre-B1 ratio, which B1 lowered because no B1 workload needed it.

Approval-needed questions follow the user's standing instruction of 2026-10-24: the recommended option is adopted, recorded with its date and the user is told.

## 11. Units

| Unit | Tier | Scope |
| --- | --- | --- |
| X-U1 | Full | X-K1 to X-K3, `fill-v0+r5`, the fixtures, X-A1 to X-A7, and the dated notes of section 7 |
| X-U2 | Light | X-A8: the headed run and the editor relaunch, then the status row |

## 12. Risks

- **X-R1, time on large self-crossing paths.** The exact rung is quadratic in its pairs. A path near EX may take hundreds of milliseconds per tolerance bucket, on the main thread. X-K3 bounds the worst case. If headed use shows stalls, moving fill builds off the main thread is a separate item.
- **X-R2, paths over EX.** They stay `work-limit` and disappear when filled, at fine tolerances. Whether a failed fill should hide the stroke (#523) is a renderer question outside this unit.
- **X-R3, the crossing ceiling.** A dense scribble can exceed 256 crossings within EX edges and stop at `Topology(WorkLimit)`. The A01 sweep and the fixtures record how often this happens.

## 13. Review record

None yet.
