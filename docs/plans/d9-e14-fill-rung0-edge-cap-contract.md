# D9 E14-U1: a separate edge cap for the fill fast rung

Status: **DRAFT 2026-10-24**, documentation only, awaiting independent review. Questions E14-Q1 to E14-Q3 are answered by their recommended option (a), adopted automatically on 2026-10-24 under the user's standing instruction ([section 10](#10-questions-and-decisions)).

This is rendering-track item E14 ([D9 rendering track](d9-rendering-track.md#status-index)), unit E14-U1, the fix direction F1 of the [E14 cause record](../evidence/e14-fill-work-limit-cause-2026-10-24.md#fix-direction). The user moved E14 to phase R1 on 2026-10-24, with E2, because fill `work-limit` on ordinary smooth paths would fail A02 in the P3 exit sweep. It is full tier: it changes fill output, the fill operation id and kernel caps. It changes no threshold of the [P3 acceptance table](p3-fill-stroke-meshes.md#runtime-acceptance-coverage-to-freeze-in-p30b), no tolerance, no share of the 0.25 px budget and no stroke cap. Identifiers use the prefix **E14-**. Stroke is E2's ([E2 contract](d9-e2-stroke-fast-rung-contract.md)).

## 1. Cause and what this contract changes

- **Cause** ([record](../evidence/e14-fill-work-limit-cause-2026-10-24.md#summary)). All 641 fill `work-limit` rows of the E11-U2 scene `p3-exit-stress/v1` are the S1 prefix's flattened-edge cap `MAX_EDGE_OWNERS = 256` (`cubic_fill.rs`): 638 `CommandLimit` and 3 `OwnerLimit`. The prefix rejects the path before rung 0 or the exact rung does any work. At the V3 tolerance (1/16 to 1/8 device px), a smooth path needs more than 256 edges from about 32 to 64 device px of radius.
- **One cap, two rungs.** Rung 0 ([Alt-A1 §3.4](p3-alt-a1-fill-ladder-contract.md#34-caps-storage-and-allocation)) runs inside the prefix caps, and the exact rung's `FILL_V0_LIMITS` are derived from the same constant. The exact rung's pair and section budgets are quadratic in it (E = 4,096 would mean about 33M sections), but rung 0's stages are not.
- **Change.** Rung 0 and the S1 prefix run that feeds it get their own edge cap **E0 = 8,192** (E14-K1). The exact rung keeps E = 256 and every byte of its behavior (E14-K2). Rung 0 gains a work cap so that its cost stays bounded at the new size (E14-K3). Fill becomes `geometry-wasm/fill-v0+r3`.
- **Not changed.** The flattener, the tolerance buckets (F3 and F4 of the record, rejected there), `MAX_CONTOURS` 4, `MAX_SOURCE_SEGMENTS` 64, rung 0's stages FR1 to FR8 and AL-FR9 and their order, the exact rung's cascade, every stroke cap and the stroke rung instance of E2-K3.

## 2. Terms

- **E** = 256, the exact rung's edge cap: `MAX_EDGE_OWNERS` today, and every quantity of `FILL_V0_LIMITS` derived from it.
- **E0** = 8,192, rung 0's edge cap. **Flat edges** of a path: the edges of its S1 polygon, `MAX_EDGE_OWNERS`'s unit. Flat commands = flat edges + MOVE and CLOSE verbs, so a rung-0 path has at most E0 + 2·4 flat commands.
- **Today** means `fill-v0+r2` on `main` 8d98285.

## 3. E14-K1: rung 0's edge cap

1. **Constants.** `cubic_fill.rs` gains `MAX_FAST_EDGE_OWNERS = 8,192` beside `MAX_EDGE_OWNERS = 256`, with `MAX_FAST_FLAT_COMMANDS` and `MAX_FAST_CONTOUR_POINTS` derived from it as today's are from E. They are fill constants: nothing in `stroke_*.rs` reads them, and E2-K3's stroke instance keeps its own caps (E2 §6, "Instance").
2. **Prefix arrays.** The workspace's prefix arrays (`commands`, `contour_points`, `edge_owners`) are sized for E0. Each prefix run enforces the caps of its caller, passed per call: `fast_rung_until` calls `prepare_prefix` with the E0 caps and `MAX_FAST_FLAT_COMMANDS`; the four `attempt*` entries keep `B1_CAPS` and `MAX_FLAT_COMMANDS`. A prefix run over E0 is rung 0's `PREFIX`, as an over-cap prefix is today.
3. **Rung 0's arrays.** `fill_ladder.rs`'s `MAX_POINTS`, `MAX_EDGES` and the capacities derived from them (Alt-A1 §3.4) follow E0. `MAX_SOURCES` and `MAX_CONTOURS` are unchanged. Spike [§2.5](p3-b0-spike-ladder-contract.md)'s triangle bound n + 2h − 2k still sizes the triangle array, so a capacity overflow stays `TRIANGLE`.
4. **Storage.** At E0 the fixed arrays no longer fit a WebAssembly stack frame (1 MiB by default): `size_of::<FastRung>()` extrapolates from the record's two sizes (113,240 bytes at 256, 1,726,040 at 4,096) to about 3.4 MB. Therefore:
   - `FastRung` is constructed in place in its reserved heap storage; `FillLadder::reserve` never builds one on the stack.
   - The stage-local arrays sized by the caps move into a rung-0 scratch reserved once at `fill_v0_reserve`: FR5's `boxes`, `order` and `scratch`; FR7's `next`, `previous`, `order`, `scratch`, `rank`, `kind`, `active`, `helper`, `diagonals`, `visited`, `face`, `is_left`, `sorted` and `stack`; AL-FR9's `next` and `seen`. A stage reads and writes only the prefix `[..n]` of each, so no call zeroes a full-capacity array. This is the same move as E2 §6 plans for the generic rung; E14-U1 does it for the fill instance, and E2-U3 builds on it.
   - FR5's candidate bitset, which feeds only a `debug_assert!` and is quadratic in E0 (8 MiB at E0), is reserved only in builds with debug assertions and clears only the rows it set.
   - The fill scratch that AL-FR9 reuses is reserved for `max(3·(T + 2V) of FILL_V0_LIMITS, 3·(E0 + 4 + 2·4))` records. The exact rung reads only its own limits, so its slices and checks do not change.
5. **Allocation rules unchanged.** Every byte is reserved once with fallible reservation (refusal is `BATCH_ALLOCATION_FAILED`), counted in the reserve-time totals and `linearMemoryBytes()`; `fill_v0_process` allocates nothing and moves no storage. E14-U1 records the total reserved bytes of the fill engine before and after, and rung 0's share must be at most 16 MiB (E14-G3).

## 4. E14-K2: the exact rung keeps E

- **Identity.** The exact rung is the one path to a mesh for every path rung 0 refuses, at every size. Its four `attempt*` entries stay bit-identical to the merge base (Alt-A1 [AL-I1](p3-alt-a1-fill-ladder-contract.md#44-identity-rules-and-the-re-baseline)), and on every path where rung 0 falls back, the export output equals today's (AL-I2).
- **What a large refused path gets.** A path with more than E flat edges that rung 0 refuses (`MONOTONE`, `CROSSING`, `CLEARANCE` or any other reason) reaches the exact rung, whose prefix returns today's `CommandLimit` or `OwnerLimit`, so the port result is today's `work-limit`. E14-U1 creates no new port outcome.
- **`FILL_V0_LIMITS`** is unchanged and keeps reading `MAX_EDGE_OWNERS`. The record's experiment raised it with the prefix (holding only pairs and sections at E), which is why looping paths there failed with `Topology(WorkLimit)` instead of `CommandLimit`. E14-U1 does not do that.

## 5. E14-K3: rung 0's work cap

Rung 0 has no work budget today, because at E = 256 its scans are small. Two stages are not linear in the edge count: FR5's x sweep visits every pair whose x intervals overlap within `r = 2δ`, and FR7's status search scans the active edge list per event. On rings both stay near linear (the record's experiment measured about 2 µs per edge natively, a diagnostic observation), but a comb-like path of n edges costs about n²/2 at either stage, 33M at E0.

- **Cap.** One counter per call, charged once per FR5 sweep candidate and once per FR7 active-list visit, before the visit. At **W0 = 4,194,304** (2^22) charges, the next charge stops rung 0 with the new fallback reason `WORK`, and the exact rung runs as on any fallback. W0 is inclusive.
- **Unreachable at E.** On a path with at most E flat edges, FR5 has at most E(E−1)/2 = 32,640 candidates and FR7 at most (E + 4)² = 67,600 visits, so the charge total is below W0 and `WORK` cannot occur. Outcomes on every path rung 0 handles today are unchanged.
- **Observability.** `WORK` is a native-only reason like the other ten (Alt-A1 §3.6): no port, framing or adapter change. `Reason::ALL` gains it, and the AL-S1 harness and the identity tool print it.

## 6. Identity, documents and the precision label

- **Revision.** Fill output changes for paths with E + 1 to E0 flat edges that rung 0 proves, which were `work-limit`. Following Alt-A1 [§2.1](p3-alt-a1-fill-ladder-contract.md#21-new-identity), `FILL_V0_REVISION` becomes 3 in `fill_export.rs` and `fill-adapter.ts`, `FILL_V0_OPERATION_ID` becomes `'geometry-wasm/fill-v0+r3'` with its literal type, and the literal revision assertions in `fill_export_tests.rs` and `tests/geometry/fill-adapter.test.ts` follow. The transport version, `abi_version()` and `portVersion` are unchanged. V3 cache entries keyed by `r2` become unreachable and every drawn path rebuilds once (Alt-A1 §2.2). This is the shared-surface change that makes the unit full tier with both-track review ([D9, Boundary](d9-post-mvp1-tracks-proposal.md#boundary)).
- **AL-I3, rung 0 against the frozen spike.** The spike module keeps its caps. A path with more than E flat edges is a new allowed difference (spike `PREFIX`, production any outcome), listed per path like the `RANGE` and AL-M5 differences. On every path with at most E flat edges, AL-I3 is unchanged.
- **E11 exit snapshot.** E11 [§3.1](d9-e11-p3-c03-c05-closure-contract.md#31-e11-k1-identities) pins `fill-v0+r2`. The E14-U1 pull request updates that row with a dated note, and E11 §3.2's preconditions gain E14-U1, so the snapshot names `r3`. A fill revision change re-runs the criteria E11's invalidation table lists for it.
- **Documents.** A dated note in Alt-A1 §3.4 ("Caps") and in the P3 plan's "B1 kernel caps" points here. No requirement text changes: the outcome classes and their meanings are E11-U4's, unchanged.
- **Precision.** Rung 0's published mesh is its S1 polygon's region, proved by the same certificate at any size; the flattening error is the prefix's, at the same tolerance. The label stays UNVERIFIED until E3's measurement, and the E3 fill rows are measured on `r3`, or re-run if E3-U5 measures `r2` first.

## 7. Gates

- **E14-G1, outcomes (deterministic).** With `pnpm test:p3-fill-identity --failure-to-success --base <merge base>`, every case is identical to `r2` or moves from `work-limit` to `ok`. No `ok` row changes, and no row moves to `unsupported-geometry`, `numeric-range` or an internal error. Every `ok` row of the scene at `r2` stays `ok`.
- **E14-G2, cost (diagnostic A/B, native release, one machine).** On the paths rung 0 admits at `r2` (the AL-I3 corpus and the scene's rung-0 meshes), the per-path median time of `build_path` at `r3` is at most 1.10 × the `r2` median, per corpus. On the paths that fall back at `r2` with at most E flat edges, the same bound holds. A failure blocks the unit. It is a gate, not a performance claim.
- **E14-G3, memory.** Rung 0's reserved bytes (the `FastRung` storage, the rung-0 scratch and the fill scratch growth) are at most 16 MiB and are recorded with the fill engine's total before and after. `process_does_not_allocate_or_move_storage` passes on E14-F2, E14-F3, E14-F5 and a `WORK` path.
- **E14-G4, claims.** E14 makes no speed claim. A claim needs a committed record under [`docs/benchmarks/README.md`](../benchmarks/README.md).

## 8. Acceptance, fixtures and validation

Fixtures at `e = −3`, zoom 1, DPR 1, nonzero, unless named. Circles are four cubics with `k = 0.5522847498`; the flat edge counts are the record's Python mirror of the flattener and are confirmed by the kernel in E14-U1 before the change runs.

| Fixture | Path | Flat edges | Today | Expected at `r3` |
| --- | --- | ---: | --- | --- |
| E14-F1 | Circle, radius 512 | 256 | `ok`, rung 0 | `ok`, rung 0, bytes unchanged (regression control at E) |
| E14-F2 | Circle, radius 2,048 | 512 | `work-limit` (`CommandLimit`) | `ok`, rung 0 |
| E14-F3 | Circle, radius 32,768 | 2,048 | `work-limit` | `ok`, rung 0 |
| E14-F4 | A 64-cubic smooth simple path with exactly E0 flat edges, and its variant with E0 + 1; the literals are found by a search in E14-U1 and fixed before their first run | E0, E0 + 1 | `work-limit` | E0: `ok`, rung 0 (inclusive cap). E0 + 1: rung 0 `PREFIX`, then `work-limit` (`CommandLimit`) |
| E14-F5 | The lowest-index looping path of `p3-exit-stress/v1` with E + 1 to E0 flat edges, named by index in E14-U1 before its first run | recorded | `work-limit` | Rung 0 `CROSSING`, then `work-limit` (`CommandLimit`); the E14-Q1 class fixture |
| E14-F6 | The smooth scene path with 9,284 flat verbs (record, "Outcome by size") | > E0 | `work-limit` | Rung 0 `PREFIX`, then `work-limit`; outside every class |
| E14-F7 | A crescent: two circles of radius 2,048 whose boundaries are 0.2 px apart at their closest point, as one simple contour; literal fixed in E14-U1 | recorded, > E | `work-limit` | Rung 0 `CLEARANCE`, then `work-limit`; outside every class (a near-touching simple path) |
| E14-F8 | A comb whose teeth overlap in x, with more than 2,048 flat edges, built so that FR5's candidates exceed W0; literal fixed in E14-U1 | recorded | `work-limit` | Rung 0 `WORK`, then `work-limit` |

| ID | Criterion |
| --- | --- |
| E14-A1 | E14-G1 to E14-G3 pass |
| E14-A2 | The fixture table holds, with the rung and reason read through `build_path` natively |
| E14-A3 | Every rung-0 mesh of E14-F2 to E14-F4 and of the scene passes AL-FR9 with zero `MESH_CHECK`, SL-O2 (independent region and mesh validity) and the `triangle-mesh` oracle |
| E14-A4 | AL-I1 and AL-I2 hold on every case of `pnpm test:p3-fill-identity`'s native layer; AL-I3 holds with only the listed differences of section 6 |
| E14-A5 | Seeded defects are caught: E14-D1 the exact rung run with the E0 caps (E14-G1 fails: a fallback row changes from `CommandLimit`); E14-D2 W0 not enforced (E14-F8 publishes or exceeds its time budget, the test fails); E14-D3 the AL-FR9 scratch sized from `FILL_V0_LIMITS` only (reserve returns `BATCH_INTERNAL_ERROR`, the reserve test fails) |
| E14-A6 | The release WASM meshes E14-F2 and E14-F3 through the adapter, so rung 0's storage is not on the WebAssembly stack |
| E14-A7 | Scene report: `pnpm p3-exit:sweep --scene` on the release WASM with the fill `ok` count, the cause breakdown, rung-0 reasons on paths over E (E14-R2) and zero structure issues, appended to the cause record. The experiment's 731 at a 4,096 cap is for comparison, not a gate |

**Validation.** `pnpm check`, `pnpm build`, `pnpm test:geometry` (native kernel tests with the fixtures and seeded defects), `pnpm test:p3-fill-identity --failure-to-success`, the E14-G2 A/B run and the scene report. No GPU or headed run is needed: E14-U1 changes mesh content and the operation id, not the renderer; V3's cache rule already covers an operation id change.

## 9. Units

| Unit | Tier | Scope | Files |
| --- | --- | --- | --- |
| E14-U1 | Full | E14-K1 to E14-K3, `r3`, E14-F1 to E14-F8, E14-A1 to E14-A7, the dated notes of section 6 | `cubic_fill.rs`, `fill_ladder.rs`, `fill_export.rs`, `fill-adapter.ts`, their tests, the AL-I3 difference list, `tests/geometry/fill-adapter.test.ts` |
| E14-U2 | Full | Only under E14-Q1 (b), or later from the backlog: a contract for an output-sensitive exact rung for self-intersecting paths over E (record option F2) | contract first |

E14-U1 starts when the rendering track's WIP limit allows. It and E2-U3 both touch `fill_ladder.rs`: whichever lands second rebases, and E2-U3's generic rung takes E0 as the fill instance's caps.

## 10. Questions and decisions

**E14-Q1. May the E11-Q2 closed list take a narrow class for large self-intersecting fill paths?**

- (a) **Recommended.** Yes, after E14-U1 has merged, the class **"fill `work-limit` on a self-crossing path over E"**: a rejected fill row is in it when (1) its S1 polygon at the row's tolerance has more than E flat edges, and (2) two edges of that polygon cross properly, decided by exact `orient2d` (strictly opposite signs at both edges), and (3) its port result is `work-limit`. The A01 sweep applies the test with its own exact predicates on the P2 flattening of the row, not the generator's label, and counts the class per stratum (E11 §7.2). Fixture E14-F5, backlog item E14-U2. A polygon crossing can also come from two parts of a simple curve that pass within the flattening tolerance of each other; the class takes those too, and the A01 record reports them. This sets aside, for that class only, the P3 plan's "Ordinary frozen corpus must succeed; prevent blanket NUMERIC_RANGE/WORK_LIMIT from masking unsupported geometry" ([P3 plan](p3-fill-stroke-meshes.md), bounded-work rule), as E11-Q2 (a) did for the stroke class. It does not cover E14-F6 (over E0) or E14-F7 (simple, near-touching): such rows still fail A02.
- (b) No class. E14-U2 becomes R1 and must merge before the exit: a new exact-rung algorithm with its own certificate, which puts the exit behind the largest change of the record.
- (c) A class for every fill `work-limit` over E. It masks simple paths such as E14-F7, which the text quoted in (a) forbids.

**E14-Q2. The value of E0.** (a) **Recommended.** 8,192. The E3 large class reaches 8,192 px of physical extent at tolerances down to 1/16 px ([E3 size classes](d9-e3-b4-precision-contract.md)), about 4,096 to 5,800 px of radius for a centered path, while the record's experiment at 4,096 already meshed every smooth scene path below 8,192 px of radius; edges grow as the square root of size, so 8,192 adds about a factor of four in size. It also equals P2's per-cubic line cap. (b) 4,096, the measured value: half the memory, no margin above the large class for noisier shapes than the scene's.

**E14-Q3. Rung 0's work cap.** (a) **Recommended.** E14-K3 with W0 = 2^22, unreachable at E. (b) No cap: a comb of E0 edges costs about 33M orientation tests in FR5 before falling back.

**Decision record.** 2026-10-24: E14 promoted to R1 by the user ("추천대로 진행해", in chat, with E2). E14-Q1 to E14-Q3 (a): recommended options adopted automatically on 2026-10-24 under the user's standing instruction of 2026-10-24 (auto-adopt the recommended option and notify). The E14-Q1 class enters the E11 closed list in the exit snapshot record, not before E14-U1 merges. The contract is approved when the independent review is READY.

## 11. Risks

- **E14-R1, cost on large admitted paths.** Rung 0 at a few thousand edges costs milliseconds natively. E14-G2 guards today's paths only; a large path's time is recorded in the scene report and judged by the AL-S1 verdict when it is next run, not by E14.
- **E14-R2, simple large paths that rung 0 refuses.** `MONOTONE` or `CLEARANCE` on a simple path over E sends it to the exact rung's `work-limit`, outside every class (E14-F7). E14-A7 reports how many scene paths do that; if the A01 sweep finds such rows in `a04-corpus/v1`, they fail A02 and E14-U2 or another remedy is needed.
- **E14-R3, near-touching crossings in the class.** The E14-Q1 membership test is on the flattened polygon, so a simple curve that passes within tolerance of itself can count. The A01 record lists class members with their minimum source distance where the sweep can compute it.
- **E14-R4, coupling with E2-U3.** Both units edit `fill_ladder.rs` (section 9). The fill instance's outcomes stay identical under AL-I3 in both orders.
- **E14-R5, paths beyond E0.** Smooth paths with more than E0 flat edges (E14-F6) stay `work-limit`. They lie beyond the E3 large class; tiling or viewport clipping (record option F6) is R2 backlog.

## 12. Review record

- None yet.
