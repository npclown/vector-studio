# D9 E14-U2: a larger edge cap for the fill exact rung

Status: **DRAFT 2026-11-06**, documentation only, independent review round 1 NOT READY, items applied, round 2 pending ([section 13](#13-review-record)).

This is rendering-track item E14 ([D9 rendering track](d9-rendering-track.md#status-index)), unit E14-U2, which was in the backlog since 2026-10-25 ([E14 §9](d9-e14-fill-rung0-edge-cap-contract.md#9-units)). The user started it on 2026-11-06, in the thread "Fix large paths vanishing on fill". They chose it on a decision card ("fill 256변 한도 개선") over a renderer stopgap that would retry at even coarser tolerances. The unit is full tier: it changes fill output, the fill operation id and kernel caps. It changes no threshold of the [P3 acceptance table](p3-fill-stroke-meshes.md#runtime-acceptance-coverage-to-freeze-in-p30b), no tolerance bucket, no share of the 0.25 px budget and no stroke cap. Identifiers use the prefix **E14-U2-**, shortened to **X** in this document (X-K1, X-G1 and so on).

## 1. Cause

On 2026-11-06 the user sent two pen paths from the editor:

- node-3: 619 × 410 px, 28 cubics and a line.
- node-8: 1,076 × 557 px, 16 cubics.

Both draw with their stroke and disappear entirely when a fill is applied. Measured natively on `main` 3ec23c9 (147d925 differs only in documents) (`fill-v0+r4`, `stroke-v0+r8`) through `build_path` and `prepare_prefix`:

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
- **Small path**: a path whose exact S1 prefix at the attempt's tolerance has at most E flat edges. **Large path**: E + 1 to EX flat edges.
- **Small tier, large tier**: the two limit sets of X-K1.
- **Today** means `fill-v0+r4` on `main` 147d925.

## 4. X-K1: two limit tiers in one workspace

The exact rung's workspace is reserved for the large tier and enforces the small tier on small paths, so a small path runs exactly as today.

1. **Storage.** `MAX_EDGE_OWNERS` becomes EX. The exact prefix arrays (`MAX_FLAT_COMMANDS`, `MAX_CONTOUR_POINTS`, `MAX_EXACT_FLAT_COMMANDS`), the rounded arrangement's arrays and the topology certificate's arrays (`ABSOLUTE_MAX_LEAVES` = EX, `LEAF_WORDS`, and the crossing array at X-Q3's ceiling) are sized for the large tier. Rung 0's caps (E0), `MAX_CONTOURS`, `MAX_SOURCE_SEGMENTS`, `ABSOLUTE_MAX_CUBICS` and the pre-B1 literal caps do not change.
2. **Line-only paths keep E.** `MAX_LINE_SOURCE_SEGMENTS` and the line-only exact caps (E16-K1, `line_caps`) are decoupled from `MAX_EDGE_OWNERS` and stay at 256 segments and today's command and point counts. A line-only path builds no topology certificate and takes the rounded fill's all-pairs and insertion-sort paths above 64 edges and 256 events (`rounded_line_fill.rs`), so raising it is not in this unit. E16-K1 item 2 gets a dated note.
3. **The small tier** is today's limits, exactly: `FILL_V0_LIMITS` at E (with `max_sections`, `max_work` and the byte caps at today's values), the topology leaf cap 256, pair cap 32,640 and crossing ceiling 32. Every attempt first runs the exact prefix with the large-tier command capacity. When the prefix has at most E flat edges, every later step of that attempt (the rounded arrangement, the topology certificate, the triangle-free scan) enforces the small tier. The checks compare against an active-limits value set per attempt instead of the constants. Widening the `LEAF_WORDS` bitset keeps iteration order and counts on small paths, because the extra words stay zero.
4. **The large tier** applies to an attempt whose prefix has E + 1 to EX flat edges:
   - edges, input vertices, pairs, events, nodes, cells, boundaries, contributors, vertices and triangles derived from EX as `FILL_V0_LIMITS` derives them from E;
   - `max_sections` fixed (X-K2);
   - `max_work` measured (X-K3);
   - topology leaves EX, pairs EX(EX − 1)/2, and crossings at X-Q3's ceiling.
5. **Outcome mapping on large paths.** On a large path, any exact-rung outcome other than `ok` maps to `work-limit`, the outcome such a path has today. A large path therefore never becomes `unsupported-geometry` or `numeric-range`. Small paths keep today's mapping. A self-check failure stays an internal error in both tiers.
6. **E16-K2 retries (E16-R4).**
   - A small path retries exactly as today. Each retry's prefix is enforced against E, so a retry stops at `CommandLimit` above E, as today. This keeps today's 215 F3 residuals and E16-F8 unchanged. Letting those retries reach EX is a separate decision (section 12, X-R4).
   - A large path gets no E16-K2 retry: one attempt at e, then the mapping of item 5. This bounds the cost of a failing large path to one cascade.
7. **Stack storage.** Every array whose size grows with EX moves to storage reserved once at `fill_v0_reserve` when it no longer fits comfortably on the WebAssembly stack. This is E14-U1's rule (E14 §3 item 4). X-U1 names each array with its size at EX in the evidence. The list includes at least:

   | Array | Location |
   | --- | --- |
   | `PairCandidates.rows`, `[[u64; LEAF_WORDS]; ABSOLUTE_MAX_LEAVES]`: 8 KiB → 128 KiB | `simple_cubic_topology.rs` |
   | `leaf_boxes` | `simple_cubic_topology.rs` |
   | `certify_topology`'s `leaves` | `cubic_fill.rs` |
   | the inline `points` arrays of the three topology workspaces | `simple_cubic_topology.rs` |
   | `partners` | `simple_cubic_topology.rs` |
   | the test-only `touched` and `scratch` | `simple_cubic_topology.rs` |

   A stage reads and writes only the prefix `[..n]` of each array and clears only that prefix, so a small path does not pay for clearing a full EX-sized array. The B0R size comments and the inline-size pins (`transverse_arrangement_tests.rs`, the `7_120` literals) are updated with the measured values.

## 5. X-K2: the large tier's section budget is not quadratic

`max_sections` in the large tier is a fixed value, recommended at today's 131,584 (X-Q2), not 2EX² + 2EX. A large path that needs more stops at `SectionLimit` and maps to `work-limit`. The probe shows the memory cost of EX is then about 10.6 MB instead of 73.5 MB.

## 6. X-K3: the large tier's work and the uncharged scan

- **Work cap.** `max_work` in the large tier is measured, not derived from EX². X-U1 records the work units charged on the fixtures and on the scene and corpus paths that become `ok`. It sets the cap to the largest measured value × 4, rounded up to a power of two, and records the time of the slowest admitted fixture. The aim is about 250 ms natively for a path near EX. The probe's 512M is an exploration bound only.
- **Crossing-triangle scan.** `closes_crossing_triangle` is O(C²) per crossing and is not charged today; its comment assumes 32 records. In the large tier each of its inner iterations is charged to the topology work counter. With 256 crossings the scan is about 16M operations per attempt and must sit inside the cap. The small tier is not charged, which keeps identity.
- **Allocation rules unchanged** (E14 §3 item 6). Every byte is reserved once at `fill_v0_reserve`, fallibly, and counted in `linearMemoryBytes()`. `fill_v0_process` allocates nothing and moves no storage.

## 7. Identity, documents and the precision label

- **Revision.** `FILL_V0_REVISION` becomes 5 in `fill_export.rs` and `fill-adapter.ts`, and the operation id becomes `'geometry-wasm/fill-v0+r5'`. The X-U1 pull request finds every pin with a repository search for `fill-v0+r4` and fill revision 4, as E14-U1 did. That covers the five GPU specs and the adapter and export tests.
- **Small paths are bit-identical** (X-K1 item 3): output, outcome, kernel error, retries and charged work, at every tier boundary inside the attempt.
- **Large paths move only from `work-limit` to `ok`.** Their kernel error may change within `work-limit`, for example from `CommandLimit` to `SectionLimit`. Each such change is recorded per case.
- **AL-I1 set-aside.** On large paths the `attempt*` entries move from `CommandLimit` or `OwnerLimit` to a mesh. AL-I1's bit-identity is set aside for entries whose prefix exceeds E, listed per case. `tooling/compare-p3-fill-identity.mjs` gains that rule, and its self-test gains:
  - one passing case: a large-path entry that moves to `ok`;
  - two failing cases: a small-path entry that changes, and an `ok` record that changes.
- **Size records.** `meta/cubic-workspace-sizes` and `meta/fill-engine-sizes` change. The combined mode records them as changes, as for E14-U1.
- **Documents.** The X-U1 pull request adds:
  - dated notes in E11 §3.1 (snapshot pin `r4` to `r5`), §3.2 (preconditions) and the invalidation table (re-run of the fill criteria);
  - a dated note in E11 §7.2: rows that become `ok` leave "fill stop in the exact rung's caps", and the class stays for paths over EX and large paths that stop in the large tier;
  - dated notes in the P3 plan's "B1 kernel caps", Alt-A1 §3.4 ("Caps") and E16-K1 item 2;
  - the E14 row in the rendering track.
- **Precision.** The exact rung's meshes are certified as today. The label stays UNVERIFIED until E3's measurement covers the new rows; rows that newly mesh enter A04 under E3-Q3.

## 8. Gates

- **X-G1, outcomes (deterministic).** Run `pnpm test:p3-fill-identity --failure-to-success --revision-change --base <merge base>` with section 7's set-aside.
  - Every small-path case is identical to `r4`.
  - Every large-path case is identical or moves from `work-limit` to `ok`.
  - No `ok` row changes, and no row moves to `unsupported-geometry`, `numeric-range` or an internal error.
  - The identity tool's random corpus may hold few large paths, so the large tier is also gated by X-A2 and the X-A7 sweep.
- **X-G2, cost (diagnostic A/B, native release, one machine).** These bounds follow E16-G2.
  - On paths that are `ok` at `r4` (the AL-I3 corpus, the scene and the corpus requests), the per-path median time of `build_path` at `r5` is at most 1.10 × the `r4` median, per corpus.
  - A path whose `r5` time exceeds both 100 ms and 20 × its `r4` time blocks the unit, unless it is a large path that became `ok`. Those are recorded with their times, and none may exceed 500 ms natively.
  - The report records the ten slowest paths at `r5` with their `r4` times, and the total time of rows that fail at both revisions.
  - It is a gate, not a performance claim.
- **X-G3, memory.**
  - The fill engine's reserved bytes grow by at most 16 MiB over `r4`; the probe measured 10.6 MB.
  - X-U1 records the totals before and after, and the number of fill engines the renderer and editor create. Linear memory never shrinks, so the per-instance growth is permanent for a session.
  - `process_does_not_allocate_or_move_storage` passes on X-F2, X-F3 and X-F7.
- **X-G4, claims.** E14-U2 makes no speed claim.

## 9. Acceptance, fixtures and validation

Fixtures are at zoom 1, nonzero, document coordinates. The user's two paths are fixed as literals from the thread, in frame space, as in `e35_hairpin_retry_tests.rs`.

| Fixture | Path | Flat edges | Today | Expected at `r5` |
| --- | --- | ---: | --- | --- |
| X-F1 | A path that rung 0 refuses (self-crossing) with exactly E flat edges at its tolerance; literal found by search in X-U1 | E | recorded at `r4` | identical to `r4` (small tier control) |
| X-F1b | The same shape with E + 1 flat edges | E + 1 | `work-limit` (`CommandLimit`) | `ok` or `work-limit`, never another outcome; recorded |
| X-F2 | The user's node-3 at `e` = −2, −3, −4 | 471 to 925 | `work-limit` (`MONOTONE`, `CommandLimit`) | `ok`, exact rung |
| X-F3 | The user's node-8 at `e` = −2, −3, −4 | 386 to 766 | `work-limit` | `ok`, exact rung |
| X-F4 | E14-F5 (scene path 3, looping, over E) at its recorded tolerance | recorded | `work-limit` | `ok` or `work-limit`; never `unsupported-geometry` |
| X-F5 | E14-F7 (near-touching simple path) | recorded | `work-limit` | `ok` or `work-limit`; never `unsupported-geometry` |
| X-F6 | node-3 at `e = −5` | 1,314 | `work-limit` | `work-limit` (`CommandLimit`), the cap |
| X-F7 | A path that rung 0 refuses with exactly EX flat edges, and its variant with EX + 1. Within 64 source segments, 4 contours and 64 cubics, so at least 16 leaves per cubic; literals found by search in X-U1 | EX, EX + 1 | `work-limit` | EX: `ok` or `work-limit`; EX + 1: `work-limit` (`CommandLimit`) |
| X-F8 | E16-F8 (an F3 residual stopped at `CommandLimit` in a retry) | ≤ E at e | `unsupported-geometry` | identical (X-K1 item 6) |
| X-F9 | A line-only path with E + 1 segments | E + 1 | `work-limit` (`SourceLimit`) | identical (X-K1 item 2) |

| ID | Criterion |
| --- | --- |
| X-A1 | X-G1 to X-G3 pass |
| X-A2 | The fixture table holds, with the rung, tier and kernel error read through `build_path` natively |
| X-A3 | Every new exact-rung mesh of X-F2 to X-F5 and X-F7 passes SL-O2, the independent region and mesh validity check |
| X-A4 | AL-I2 holds on every case; AL-I1 holds with only section 7's set-aside |
| X-A5 | Seeded defects are caught through a `cfg(test)` limits override on the workspace constructor, which the X-U1 pull request names. Constants cannot be switched at test time; E14-U1 used a lowered work cap the same way. X-D1: large-tier `max_sections` quadratic (X-G3's byte check fails). X-D2: large-tier topology leaf cap 256 (X-F2 stops at `Topology(WorkLimit)`). X-D3: large-tier work cap below the measured value (an X-F2 case stops). X-D4: small paths run in the large tier (X-G1 fails on a small case, or a test with a small path that stops at today's crossing ceiling changes). X-D5: no outcome mapping on large paths (a large failing fixture returns `unsupported-geometry`) |
| X-A6 | The release WASM meshes X-F2, X-F3 and X-F7 at EX through the adapter. X-U1 records the stack peak of those runs (the deepest frame, measured with a stack-pointer probe or the WASM's `__stack_pointer` low-water mark) and the list of moved arrays |
| X-A7 | The A01 corpus sweep record (`pnpm e16:fill-diag`) is re-run. It reports, per stratum, the rows that leave "fill stop in the exact rung's caps" and E14-Q1 and the rows that stay. No row moves outside the closed list |
| X-A8 | Headed GPU on the user's PC: the five specs that pin the operation id (`p3-v4-paths`, `viz-v2`, `viz-v3`, `p3-b2-strokes`, `viz-v1`) pass. The editor on :4194 draws node-3 and node-8 filled at the PC's DPR |

**Validation.** `pnpm check`, `pnpm build`, `pnpm test:geometry` (native tests, fixtures and seeded defects), the identity tool in combined mode with its self-test, the X-G2 A/B run, the A01 sweep and the headed run.

## 10. Questions

**X-Q1. The value of EX.**

- (a) **Recommended: 1,024.** It covers both user paths down to `e = −4` (DPR 2 at zoom 1), with about 10 % margin on node-3, and the probe measured its memory.
- (b) 2,048. It covers node-3 at `e = −5`, but topology pairs and the bitset rows grow fourfold, and it needs its own probe.

**X-Q2. The large tier's section budget.**

- (a) **Recommended:** a fixed 131,584, today's value (X-K2).
- (b) Quadratic in EX: about 90 MB reserved.
- (c) A different fixed value, chosen from the X-U1 measurements.

**X-Q3. The large tier's crossing ceiling.**

- (a) **Recommended:** 256, the probe's value. Both paths need more than 32. X-U1 records each fixture's crossing count and the charged cost of the crossing-triangle scan (X-K3).
- (b) EX / 2. That is the pre-B1 ratio, and it makes the uncharged-scan bound four times larger.

Approval-needed questions follow the user's standing instruction of 2026-10-24: the recommended option is adopted, recorded with its date, and the user is told.

## 11. Units

| Unit | Tier | Scope |
| --- | --- | --- |
| X-U1 | Full | X-K1 to X-K3, `fill-v0+r5`, the fixtures, X-A1 to X-A7, the identity tool's set-aside and the dated notes of section 7 |
| X-U2 | Light | X-A8: the headed run and the editor relaunch, then the status row |

## 12. Risks

- **X-R1, time on large self-crossing paths.** A path near EX may take hundreds of milliseconds per tolerance bucket, on the main thread. X-K3 and X-G2 bound it. If headed use shows stalls, moving fill builds off the main thread is a separate item.
- **X-R2, paths over EX.** They stay `work-limit` and disappear when filled at fine tolerances. Whether a failed fill should hide the stroke (#523) is a renderer question outside this unit.
- **X-R3, the crossing ceiling.** A dense scribble can exceed X-Q3's ceiling within EX edges and stop in the large tier, which maps to `work-limit`. The A01 sweep and the fixtures record how often this happens.
- **X-R4, small paths that stop in a retry.** E16's 215 F3 residuals stop at `CommandLimit` inside E16-K2's retries, at E. Letting retries use the large tier could mesh some of them, and could also change `unsupported-geometry` rows. That is left to a later decision with its own gate.

## 13. Review record

- **Round 1, 2026-11-06: NOT READY.** Both blocking items were applied:
  - the E16-K2 retry composition (X-K1 item 6: small paths retry as today, large paths get one attempt and the `work-limit` mapping);
  - the identity claim (X-K1 items 3 and 5: two tiers, so small paths are bit-identical and large paths move only to `ok`).

  Should-fix items applied: the AL-I1 set-aside with the tool's self-test; the stack inventory with prefix-only clearing and the measured stack peak; the charged crossing-triangle scan; E16-G2's per-path limits in X-G2; fixtures at E and E + 1 on the exact rung, expectations that can fail, X-F7's source bounds and named override mechanisms for the seeded defects; line-only caps kept at E; the full document list. Optional items applied: the measurement commit, the review-record link and per-instance memory.
