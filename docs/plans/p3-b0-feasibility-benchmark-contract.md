# P3 B0 performance feasibility benchmark contract

Status: FROZEN on 2026-10-08 after independent review and user decisions; see the [review and approval record](#review-and-approval-record). It is D8 checkpoint B0 ([D8](p3-d8-parallel-tracks.md)), full tier, because it fixes a feasibility decision rule before any run. It is documentation only. Its measurement runner is a separate light-tier work unit that starts only after this contract is FROZEN.

Scenario identity: `p3-b0-feasibility`, version 1. Any change to the corpus, sweep, sampling, fits or decision rule creates version 2, reviewed before it runs.

## Purpose and authority

The roadmap's P3 path stress workload is 1,000 paths with 32 cubic segments each ([prototype plan](../prototype-plan.md#p3-fill-and-stroke-meshes)). The private fill kernel cannot run it today. A path that `CubicFillWorkspace` accepts is bounded by:

| Cap                                                  | Value              | Where                                                    |
| ---------------------------------------------------- | ------------------ | -------------------------------------------------------- |
| Source verbs, source scalars                         | 24, 104            | `cubic_fill.rs` `MAX_SOURCE_VERBS`, `MAX_SOURCE_SCALARS` |
| Source segments, contours                            | 16, 4              | `MAX_SOURCE_SEGMENTS`, `MAX_CONTOURS`                    |
| Flat commands, contour points                        | 72, 68             | `MAX_FLAT_COMMANDS`, `MAX_CONTOUR_POINTS`                |
| Edge owners (flattened leaves plus explicit closes)  | 64                 | `MAX_EDGE_OWNERS`                                        |
| Topology leaves                                      | 64                 | `simple_cubic_topology.rs` `ABSOLUTE_MAX_LEAVES`         |
| Combined heap                                        | 16 MiB             | `MAX_COMBINED_HEAP_BYTES`                                |
| Rounded fill: input vertices and edges, events, work | 64, 128, 2,000,000 | the frozen `LIMITS` in `native_cubic_fill_tests.rs`      |

The 64-leaf owner cap binds first. A 32-cubic path exceeds the segment cap even before flattening. B0 therefore measures **scaling within the current caps** and extrapolates to the workload, as the [D8 amendment](p3-d8-parallel-tracks.md#amendment-2026-10-08-plan-review-findings) requires. Its verdict decides whether B1 (raising the caps) proceeds in the current kernel direction, or whether the user first takes an architecture decision.

**What B0 is not.**

- **Not an acceptance threshold.** The prototype plan's P3 exit gate has no performance threshold, and the [P3 plan](p3-fill-stroke-meshes.md#runtime-acceptance-coverage-to-freeze-in-p30b) defines no new performance multiplier. B0's budgets are feasibility budgets for a direction decision. They pass or fail no P3 criterion and cannot become one without their own prospective contract.
- **No threshold changes.** P1 A09/A10, P2 A08 and every P3-P5 gate stay as written. B0 measures the P3 fill kernel only; no P1 or P2 claim follows from it.
- **No functional runs as evidence.** A functional run validates the runner. It is never performance evidence.
- **No cap or behavior changes.** Raising caps is B1. The only change B0 allows to non-test kernel code paths is the diagnostic instrumentation in section 4, compiled only under a dedicated configuration flag. The runner also adds a test module and a `check-cfg` entry.

**Known before the run (anecdotal).** During review of this contract, the implementability reviewer probed a scratch copy of the kernel with single, unrandomized passes. Nothing about them is committed. They are not evidence, make no performance claim and fix nothing; they explain the sampling sizes and the crossing decision below:

- **Per-path times.** About 1.5 ms for P2 s = 3, 36 ms for P2 s = 16, and 134-141 ms at 64 leaves (P4 s = 16, P8 s = 8, K2 s = 8, K4 s = 4).
- **Admission.** On the section 2 generator, all 34 cells of P2, P4, P8, K2 and K4 admitted every path, with flat command counts as predicted, and every path took the exact Legacy topology.
- **Generic coordinates.** Without snapping, 0-2 of 30 paths per cell succeeded. The rest failed `KnotMismatch`, or `OwnerLimit` at 64 leaves.
- **Crossings.** Straight-edge star polygons failed `Unresolved` in transverse mode for every s. The transverse arrangement allows one crossing partner per leaf, and each star edge crosses two others.

Scaled to 1,000 paths of 32 cubics, the per-path figures suggest an initial tessellation two to three orders of magnitude above the recommended B_init. An INFEASIBLE verdict is therefore likely. The contract is fixed before the run regardless, and the run's diagnostics (section 4) are its main value for the architecture decision that would follow.

## 1. Measured events

| ID  | Event                                   | Status in B0                                                                                                                                                                                                                                                 |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E1  | Initial tessellation of N paths, native | **Measured.** Wall time of a batch from its first path's input to its last path's checksum, single thread, one reused workspace                                                                                                                              |
| E2  | Mesh bytes                              | **Measured.** Per path: vertex count V and triangle count T, and the port v0 core payload 16·V + 12·T bytes, which is Float64 x, y per vertex and three u32 per triangle                                                                                     |
| E3  | Single-path edit latency                | **Deferred** to after V3 implements the [V1](p3-v1-path-scene-port-proposal.md) path node. **Proxy now:** the extrapolated p95 of individually timed single-path tessellations. It is a lower bound: it excludes scene application, packing, upload and draw |
| E4  | Draw cost                               | **Deferred** to after V3. No proxy; B0 makes no GPU claim                                                                                                                                                                                                    |
| E5  | Kernel workspace bytes                  | **Recorded once** per family: `allocated_bytes()` of the heap workspaces and `size_of::<CubicFillWorkspace>()` for the inline part. They come from limits, not input                                                                                         |
| O1  | Generic-coordinate admission            | **Observed, untimed.** Paths 0-29 of every primary-series cell regenerated without coordinate snapping, with OK counts and failure codes per cell. It informs B1 and B3; it is not in the decision                                                           |
| O2  | Crossing admission                      | **Observed, untimed.** Series X below, with OK counts and failure codes. It documents the crossing limitation; it is not in the decision                                                                                                                     |

`boundaryEdges` bytes from the V1 port are not produced by today's kernel; V2 adds them. They are outside E2 until the WASM follow-up in section 6.

## 2. Corpus and sweep

**Generator `p3-b0-ring/v1`.** It is written in TypeScript under `tests/geometry/p3-b0/` and writes framed inputs, as the existing native tests do. The SHA-256 of the framed corpus is recorded, and B0-W reuses those bytes rather than regenerating them.

A path has C contours. Contour k (0-based) is built in counterclockwise index order, then possibly reversed:

1. Edge length e = 8 local units; circumradius r = e / (2 sin(π/s)).
2. The centre is (k·D, 0) with D = 2(r + h·e) + 4, so contours are disjoint.
3. Vertex i is the centre plus r·(cos φ_i, sin φ_i), with φ_i = 2πi/s + ρ_k.
4. For the edge v_i → v_(i+1) with d = v_(i+1) − v_i, the right-hand normal is n = (d_y, −d_x) / |d|, which points outward for this counterclockwise convex polygon. The cubic is v_i, v_i + d/3 + h·e·n, v_i + 2d/3 + h·e·n, v_(i+1).
5. **Snapping.** Every coordinate is rounded to the nearest multiple of 2^-10, ties to even. Every value stays below 2^11 in magnitude, so snapped values are exact in Float64 and closures are bit-exact.
6. **Orientation.** Even k keeps counterclockwise order: MOVE v_0, the s cubics in index order, CLOSE. Odd k is reversed: MOVE v_0, then the cubics in reverse order, each with its control points reversed, then CLOSE.

The fill rule is nonzero. **Random draws:** xorshift32 with shifts 13, 17, 5, and u = state / 2^32 drawn after each update, as in the [P2 generator](p2-geometry-kernel.md#acceptance-and-deterministic-fixtures). The state resets to 0x12345678 at the start of each cell. Draws are consumed path by path, and within a path contour by contour, with ρ_k = 2π·u. Path j of a cell is therefore the same whatever the batch size, and a cell's first 10 paths are a prefix of its first 100.

**Flattening density.** At flatten tolerance 0.125, the flatness of one of these cubics at subdivision depth d is h·e·4^-d. The bulge values sit away from that threshold:

| Density λ (leaves per cubic) | h    | Flatness by depth    |
| ---------------------------- | ---- | -------------------- |
| 2                            | 3/64 | 0.375, 0.094         |
| 4                            | 3/16 | 1.5, 0.375, 0.094    |
| 8                            | 3/8  | 3, 0.75, 0.19, 0.047 |

The runner records the actual flat command count per path and fails the run if any timed path's count differs from C·s·λ + 2C: the leaves plus one MOVE and one CLOSE per contour.

**Fixed for every cell:**

- zoom 1, DPR 1, identity world transform;
- flatten tolerance 0.125 and topology tolerance 0.0625, the values of the frozen native cubic-fill fixtures;
- the frozen `LIMITS` and `CubicFillWorkspace::attempt`, Legacy topology mode.

Zoom is fixed because the flattening caps bind before the segment cap at high zoom, so a zoom axis would measure cap rejection, not cost.

**Sweep.** L = C·s·λ is the total leaf count. The expected status is computed a priori from the caps, with L ≤ 64 required.

| Series | C   | λ   | s                                       | Expected admitted   | Role                                  |
| ------ | --- | --- | --------------------------------------- | ------------------- | ------------------------------------- |
| P2     | 1   | 2   | 3, 4, 5, 6, 7, 8, 10, 12, 14, 16        | all 10 (L = 6-32)   | Primary, fitted, binding              |
| P4     | 1   | 4   | 3, 4, 5, 6, 7, 8, 10, 12, 14, 16        | all 10 (L = 12-64)  | Primary, fitted, binding              |
| P8     | 1   | 8   | 3, 4, 5, 6, 7, 8                        | all 6 (L = 24-64)   | Primary, fitted, binding              |
| K2     | 2   | 4   | 3, 4, 5, 6, 7, 8                        | all 6 (L = 24-64)   | Contour series, fitted, observational |
| K4     | 4   | 4   | 3, 4                                    | both (L = 48, 64)   | Contour points, observational         |
| X      | 1   | 1   | 5, 7, 9, 11, 13, 15 (star {s/2}, h = 0) | none (`Unresolved`) | O2 only, untimed                      |

Every listed cell also satisfies C·(s + 2) ≤ 24 verbs, C·(6s + 2) ≤ 104 scalars, C·s ≤ 16 segments and L + 2C ≤ 72 flat commands. The rounded-fill event and work limits are not computable a priori; the admission pre-check finds them.

**Contour sensitivity.** The ratio of per-path medians at equal total cubic count, K2 versus P4 and K4 versus P4, at N = 6, 8, 12 and 16 where both exist. This is reported, not fitted.

**Crossing series X.** It uses the same snapping and rotation, with vertex i connected to vertex i + 2 (mod s) and h = 0. Each cubic is then a straight segment with controls at its thirds and flattens to one leaf. It runs through `attempt_transverse`, the only existing entry for crossing cubics. Each star edge crosses two others, while the transverse arrangement accepts one crossing partner per leaf, so every X cell is expected NOT-ADMITTED with `Unresolved`. X is therefore an untimed admission observation (O2), kept so that a later kernel change shows up in it. **Crossing cost is not measured by B0**, for straight or curved edges. The verdict says so, and B0 implies nothing about its feasibility.

**Admission pre-check.** In every repetition process, before timing, paths 0-9 of each cell run once, untimed, and paths 0-99 of P4 s = 16 for the linearity check. Admission must agree across processes. A path counts as OK only if `attempt` returns `Ok` and `output()` is `Some` with a nonempty mesh; `attempt` can return `Ok` with no mesh when flattening sizing fails. A cell is ADMITTED only if all of its paths are OK. Otherwise it is classified from its first failure:

- **CAP-BOUND** for `SourceLimit`, `CommandLimit`, `PointLimit`, `OwnerLimit`, `ContourLimit`, `CombinedByteLimit`, a rounded-fill or topology `WorkLimit` or `OutputLimit`, or flattening `PATH_WORK_LIMIT`;
- **NOT-ADMITTED** for anything else.

The failure code and path index are recorded. Excluded cells are reported, never dropped silently. The runner also records, per path, which topology preparation ran (`rounded_topology_selected` and `transverse_topology_selected`). The mix must be identical across repetitions.

## 3. Builds, sampling and checks

**Decision build.** An ignored `cargo test --release --lib` test in the kernel crate, with pinned Rust 1.94.1, run explicitly as the existing native tests are.

- The measured artifact is the libtest harness under the release profile: opt-level 3, LTO and one codegen unit, but with unwinding, because Cargo ignores `panic = "abort"` for test targets.
- The crate's `cfg(test)` tracking global allocator is compiled in.
- Both facts are recorded as known overhead. The harness allocates nothing inside a timed batch.
- The diagnostic flag of section 4 is off.

**Repetitions.** Five fresh processes, each with a 45-minute timeout; a timeout fails that repetition and is retained. Each process runs every admitted cell once. The order is a Fisher-Yates shuffle from the last index down, with j = floor(u·(i + 1)), using xorshift32 seeded with 0x9e3779b9 + r for repetition r = 0..4.

**Per cell.**

1. Construct the workspace once, untimed, and record its time separately.
2. Run three untimed warm-up batches, then 20 timed batches.
3. A batch tessellates the cell's first 10 paths in order with the reused workspace. Its sample is the wall time of the whole batch.
4. Each path inside the batch is also timed individually, into a preallocated array, for the edit proxy.
5. The batch includes an FNV-1a 64-bit checksum, computed without allocation, over each path's status (the constant u32 0, since only OK paths are timed), V and T as u32 little-endian, every vertex coordinate's f64 bits and every index as u32 little-endian.

**Clock.** `std::time::Instant`. Before sampling, the runner records the smallest observed positive increment as the clock quantum. A batch shorter than 100 quanta makes its cell UNVERIFIED.

**Aggregates.** The per-path time is the batch sample divided by 10; the individual path times feed only the edit proxy. Per cell and repetition the runner reports, for both, as [the benchmark policy](../benchmarks/README.md#samples-and-aggregation) requires:

- the nearest-rank median, p95 and p99 (`ceil(p·n) − 1` on ascending samples);
- the minimum and maximum.

**Determinism.** Checksums must be equal across all batches and repetitions of a cell. A mismatch invalidates the run.

**Linearity in N.** This runs in each repetition on P4 at s = 16. Run 20 timed batches of 10 paths, then two warm-up and five timed batches of 100 paths (paths 0-99, all admitted). It passes when the per-path median at 100 paths is at most 1.25 times the median at 10. This justifies multiplying a per-path estimate by 1,000.

**Retention.** Every sample, failure and repetition is kept, including invalid ones.

**Expected duration.** From the probe, about 10-20 minutes per repetition and under two hours in total. This is a planning figure, not a threshold.

## 4. Cost-driver identification

**Hypothesis H1.** Exact arithmetic dominates tessellation cost and its growth. The exact routines are in `fill_predicates` (`orient2d`, `segment_relation`, used by `rounded_line_fill`) and `fill_exact` (`multiply`, `compare_ratios`, `compare_magnitude`, used by topology and event ordering).

**Diagnostic build.** It is the decision build plus the flag `p3_b0_diag`:

- **Flag.** It is set through `--cfg p3_b0_diag` appended to the runner's encoded rustflags, and declared under `[lints.rust] unexpected_cfgs` `check-cfg` in the kernel's `Cargo.toml`. It builds into its own target directory, `.tools/geometry-build-p3-b0-diag`, so it never invalidates the ordinary build. Production, WASM and ordinary test builds never set it.
- **Counters.** Under the flag, thread-local counters count calls to the five routines above, separately per const-generic instantiation. A call made inside another counted routine is not counted, because a depth guard suspends counting, so that counts are top-level and unit costs are inclusive. For example, `compare_ratios` includes its two `multiply` calls, which are not counted again.
- **Operand capture.** The same guard applies when the counters copy the operands of each instantiation's first 1,000 top-level calls in the largest P4 cell.
- **Stop marker.** A thread-local stop marker makes `attempt_body` return after `validate_leaf_partitions` (S1) or after `certify_topology` (S2). S3 is the full attempt.

The flagged code is the only change B0 permits to non-test kernel code paths.

**Diagnostic run.** It is one process, separate from the five decision repetitions. It also produces the O1 and O2 observations. It runs over the P2, P4 and P8 cells, with three warm-up and ten timed batches per stage. It records:

1. **Stage costs:** S1 for decode, flatten and leaf validation; S2 − S1 for topology; S3 − S2 for tessellation and ownership validation. All are differences of medians.
2. **Counts** per routine per path.
3. **Unit costs** per instantiation: replay the captured operands cyclically through `std::hint::black_box` in five loops of 10^6 calls, and take the median of the five per-call means.
4. **The estimated exact share:** the sum over instantiations of top-level count × unit cost, divided by the S3 median.
5. **Counter overhead:** the S3 median of the diagnostic build divided by the decision build's median for the same cell.

**Verdict on H1**, reported separately at the largest admitted cell of each primary series and not combined:

- **Supported** when the estimated exact share is at least 50%;
- **Not supported** when it is below 25%;
- **Inconclusive** otherwise, or when counter overhead exceeds 1.5.

H1 is diagnosis for B1 and the user. It does not enter the feasibility decision.

## 5. Extrapolation and the feasibility decision

**Target.** The workload is 1,000 single-contour paths of 32 cubics. At density λ that is L* = 32λ leaves per path: 64, 128 and 256 for λ = 2, 4 and 8. The data reach L = 32, 64 and 64, so the extrapolation factors are 2, 2 and 4 in leaves.

**Fits.** For each repetition and primary series, fit x = ln L and y = ln t by ordinary least squares over its admitted cells, where t is the per-cell per-path median. Define:

- the upper prediction bound U = ŷ(x*) + t_(0.95, n−2) · s_e · sqrt(1 + 1/n + (x* − x̄)² / S_xx), with x* = ln L*, s_e the residual standard error and the one-sided Student-t quantiles hard-coded from a table for n − 2 = 2..8;
- the curvature guard G, the line through the largest-L admitted point and the admitted point whose L is nearest half of it, evaluated at x*. It guards against cost growth that steepens with size, such as the kernel's pairwise scans, on a baseline wide enough (ln 2) not to amplify noise much;
- the series estimate t̂ = exp(max(U, G)).

The edit proxy t̂_p95 is computed the same way, from the per-cell p95 of individually timed paths instead of the batch median.

**Workload estimates.** Take the maximum over repetitions and the three primary series. With k the WASM factor from decision B0-Q2:

- the initial tessellation estimate T̂ = 1,000 · t̂ · k;
- the edit-latency proxy t̂_edit = t̂_p95 · k;
- the mesh payload M̂ = 1,000 · m̂, where m̂ is the least-squares line of per-cell mean E2 bytes against L, evaluated at L* and maximized over series.

**Validity checks.** All must pass for a FEASIBLE or INFEASIBLE verdict:

1. Every primary series has at least 4 admitted cells, including its largest-L cell.
2. For every primary fit, exp(U − ŷ(x*)) ≤ 2. Otherwise the extrapolation is too uncertain.
3. No UNVERIFIED cell lies in a primary series.
4. Linearity in N passes in every repetition.
5. Checksums and topology mixes agree across repetitions.
6. Flat command counts match λ.
7. All five repetitions complete.
8. Metadata is complete (section 7).

Observational series (K2, K4 and X) are fitted or tabulated when they have enough admitted cells. They never fail a check.

**Decision rule.** B is the budget set fixed by decision B0-Q1.

| Verdict      | Condition                                                  | Consequence                                                                                                                                              |
| ------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FEASIBLE     | Checks pass, and T̂ ≤ B_init, t̂_edit ≤ B_edit and M̂ ≤ B_mem | B1 may proceed in the current kernel direction                                                                                                           |
| INFEASIBLE   | Checks pass, and any estimate exceeds its budget           | Goes to the user as an architecture decision before B1. B0 reports the drivers it measured, the H1 verdict and contour sensitivity; it chooses no remedy |
| INCONCLUSIVE | Any check fails                                            | Handled as decision B0-Q3 fixes                                                                                                                          |

**Scope of every verdict.**

- It covers simple, disjoint, snapped contours at zoom 1 and densities of 2-8 leaves per cubic, at e = 8.
- It does not cover the roadmap's 1%-6400% zoom range, generic-coordinate input (see O1) or crossings of any kind (see O2).
- Extrapolating beyond the data assumes no new cost regime between the largest admitted L and L*; the curvature guard limits, but does not remove, that risk.
- It is provisional on native measurement until B0-W replaces k with a measured ratio. If that changes the verdict, the new verdict goes to the user.

## 6. Native and WASM: what each run may claim

| Run                   | When                                | Claims                                                                                                                 | Does not claim                                     |
| --------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Native (B0 reference) | After the runner unit, before B1    | CPU cost of the private kernel's fill on the reference machine, single thread, test-harness release build              | Browser, WASM or GPU cost; edit latency; draw cost |
| WASM follow-up (B0-W) | After V2 exports the fill operation | The same corpus bytes through the V2 adapter in headed Chrome and Edge, and the measured WASM/native ratio replacing k | GPU, draw or end-to-end editor cost                |

B0-W is its own scenario version and its own light-tier runner, under this decision rule.

## 7. Environment, memory categories and result records

**Reference environment.** The current development PC, the first reference machine per the prototype plan's accepted constraint 2. Each record carries the [benchmark metadata](../benchmarks/README.md#accepted-reference-runs) that applies to a native run:

- git commit, or a dirty-tree marker with a source manifest;
- UTC timestamp and local timezone;
- OS and version; CPU, logical cores and RAM;
- power source and mode, and background load, as provenance-bearing observations from `--environment-json`;
- build mode, the Rust toolchain identity, target triple, effective profile and rustflags for both builds, and the known overhead of section 3;
- schema version, scenario ID and version, the full configuration and its hash, the corpus SHA-256 and seeds;
- warm-up, sample and repetition counts;
- source and runner provenance, the commands and the runner version.

Browser, GPU, viewport and DPR fields are recorded as not applicable, with that reason. A record missing required metadata is exploratory and carries no verdict.

**Memory categories.**

| Category               | Counted                                                       | Excluded, with reason                                    |
| ---------------------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| Mesh core payload (E2) | 16·V + 12·T bytes per path                                    | Allocator overhead and container headers: not observable |
| Kernel workspaces (E5) | `allocated_bytes()` per heap workspace; inline `size_of` once | Process RSS: not measured by B0                          |
| WASM linear memory     | —                                                             | No WASM run in B0; measured in B0-W                      |

Sizes are in bytes, with MiB = 2^20 bytes.

**Configuration hash.** SHA-256 of the configuration serialized as JSON with keys sorted, no whitespace, numbers in shortest round-trip form. The configuration includes every value in sections 2-5.

**Records.**

- **Raw output.** It goes to an exclusive new directory, `artifacts/p3-b0/<run-id>/`, under the ignored artifacts tree. The run ID is the UTC time `YYYYMMDDTHHMMSSZ` plus eight random hex digits. Nothing is ever overwritten.
- **Committed result.** It follows the [result format](../benchmarks/README.md#directory-layout): `docs/benchmarks/results/YYYY-MM-DD_p3_p3-b0-feasibility-v1_native_<machine>_<run-id>.md`, with its `.json` raw record beside it.
- **JSON content.** It holds the schema version, configuration and hash, environment, builds, corpus hash, admission, O1 and O2 tables, every sample in execution order, the diagnostic run, aggregates, fits, estimates, checks and the verdict.
- **Validator.** It recomputes aggregates, fits, estimates, checks and verdict from the raw samples, and rejects a record whose stored values differ. That is the tamper test's defined failure.
- **Immutability.** Committed records are immutable; corrections append a review record.

**Reproduction command.** `pnpm benchmark:p3-b0 --profile functional|reference --environment-json <observations.json>`. The runner unit introduces it; it does not exist yet. The functional profile runs one repetition with two timed batches per cell, no diagnostic run, and has no verdict.

## 8. Decisions for the user

Each lists the recommended option first.

| ID    | Decision                                    | Recommended                                                                                                                                                                                                                                   | Alternatives                                                                                                                       |
| ----- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| B0-Q1 | Feasibility budgets (B_init, B_edit, B_mem) | 1,000 ms initial tessellation of the workload; 4 ms per-path edit proxy, a quarter of a 60 Hz frame; 64 MiB of mesh payload                                                                                                                   | Tighter: 500 ms, 2 ms, 32 MiB. Looser: 2,000 ms, 8 ms, 128 MiB                                                                     |
| B0-Q2 | WASM factor k before B0-W                   | k = 2, with the verdict provisional until B0-W measures the ratio                                                                                                                                                                             | k = 1, native as is; or no verdict until B0-W, which delays B1 until after V2                                                      |
| B0-Q3 | Handling of INCONCLUSIVE                    | Same as INFEASIBLE: it goes to the user before B1                                                                                                                                                                                             | The Primary drafts a successor version and reruns it after independent review, without a user decision                             |
| B0-Q4 | Crossing content                            | Proceed without crossings: the verdict states that crossing cost is unmeasurable with today's kernel, which accepts one crossing partner per leaf. Measuring it becomes an explicit item for B1 or B3 before any crossing workload is claimed | Block B0 until the kernel admits multiple crossings per leaf. That needs a kernel change first and reverses the order B0 before B1 |

## 9. Follow-on work units

1. **B0 runner (light tier).** Scope:
   - the TypeScript generator and framed corpus;
   - the native harness, admission and O1 observation, timing and checksum;
   - the `p3_b0_diag` instrumentation and its `check-cfg` declaration;
   - fits, records, the validator and the `benchmark:p3-b0` command.

   Acceptance: the functional profile runs end to end; generator fixtures for P4 s = 4 path 0 and K2 s = 3 path 0 match committed expected coordinate bits computed by a second, independent implementation of section 2 (not the TypeScript generator); the diagnostic flag's code passes clippy and builds; a tampered record is rejected; ordinary `pnpm test:geometry` and the WASM build are unchanged by the flag. It needs one independent diff review and starts only after this contract is FROZEN.

2. **B0 reference run.** The reference profile on the reference machine, the committed result record, and an independent evidence review before the verdict is acted on.
3. **B0-W.** After V2, as in section 6.

## Review and approval record

- **Independent technical review.** A fresh-context `reviewer` agent found 4 blocking items:
  - the 64-leaf owner cap was missing, which made the validity minimums unsatisfiable;
  - non-exact closures caused `OwnerLimit` failures;
  - the measured topology path depended on the coordinate class;
  - a counter-free build could not be produced under `cfg(test)`.

  Its verdict was NOT READY. After the rewrite it returned READY, and its six SHOULD-FIX items are applied: the series X prediction, a wider curvature-guard baseline, individually timed paths for the edit proxy, the anecdotal label on probe figures, the non-test wording, and the 64-leaf admission risk, which the probe cleared.

- **Implementability review.** A second `reviewer` agent, from the implementer's perspective, returned NOT IMPLEMENTABLE with 5 blocking items:
  - generic coordinates are rejected (`KnotMismatch`);
  - the star family is never admitted;
  - the validity checks could not pass;
  - there was no API for the stage prefixes;
  - the counter build contradicted `cfg(test)`.

  After the rewrite it returned IMPLEMENTABLE. Its scratch probe of the section 2 generator admitted all 34 decision cells as predicted. Its seven SHOULD-FIX items are applied: X as an admission-only observation, instantiation-level top-level counts with replay loops, path counts, the checksum status constant, a separate diagnostic target directory with clippy acceptance, an independent fixture oracle, and wording.

- **User decisions, 2026-10-08, in chat.** The user chose the recommended option for each:
  - B0-Q1: budgets of 1,000 ms, 4 ms and 64 MiB;
  - B0-Q2: k = 2, with a provisional verdict until B0-W;
  - B0-Q3: INCONCLUSIVE goes to the user before B1, as INFEASIBLE does;
  - B0-Q4: proceed without crossings, which become an explicit B1 or B3 item.

  The user was told beforehand that the anecdotal probe makes INFEASIBLE likely.
