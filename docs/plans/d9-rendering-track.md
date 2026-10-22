# D9 rendering track plan

Status: active from the `mvp-1` tag. This plan holds the rendering track's status index, items, acceptance checks and evidence rules. The decision, the ownership boundary, the shared surface and the operating model are owned by [D9](d9-post-mvp1-tracks-proposal.md) (approved 2026-10-22) and are not repeated here. P3 history and the P3 acceptance table stay in [`p3-fill-stroke-meshes.md`](p3-fill-stroke-meshes.md). The Track B name from [D8](p3-d8-parallel-tracks.md) is retired for post-MVP 1 work (D9-Q5 (a)).

Ownership: the packages and pages listed in [D9, rendering track](d9-post-mvp1-tracks-proposal.md#rendering-track-engine). Branches use the prefix `claude/eng-<item>-<slug>`. A change to the shared surface is full tier with both-track review ([D9, Boundary](d9-post-mvp1-tracks-proposal.md#boundary)).

## Status index

| Item | Subject                                                           | Tier                                       | State                                                                                                                                                                                                                                                                                                                                          |
| ---- | ----------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1   | ST-U9 early abort when failure is certain                         | Full                                       | ST-U10 implemented ([evidence](#e1-st-u10-evidence-2026-10-22)); independent diff and evidence review pending                                                                                                                                                                                                                                  |
| E2   | ST-U9 family-B fast-rung contract                                 | Full                                       | Not started                                                                                                                                                                                                                                                                                                                                    |
| E3   | B4: A04 corpus and measurement contract                           | Full                                       | Not started. Update 2026-10-22: [contract draft](d9-e3-b4-precision-contract.md) in review. Update 2026-10-22 (later): contract approved (PR #204); next E3-U1 corpus freeze                                                                                                                                                                   |
| E4   | ST-U3f fix decision                                               | Full                                       | Not started                                                                                                                                                                                                                                                                                                                                    |
| E5   | Unmeasured-scope measurements after the AL-Q6 (a) decision        | Full (scenario contract), then light (run) | Not started                                                                                                                                                                                                                                                                                                                                    |
| E6   | Remove or move the D8-interim overlay and fringe builders         | Full                                       | Not started                                                                                                                                                                                                                                                                                                                                    |
| E7   | Conforming refinement (E3-Q10 (c), remedy for A01 watertightness) | Full                                       | Candidate, added 2026-10-22 from the [E3 decisions](d9-e3-b4-precision-contract.md#user-decisions-2026-10-22); not started                                                                                                                                                                                                                     |
| E8   | Unsupported-geometry on simple smooth Q/T and C/S paths           | Full                                       | Candidate, added 2026-10-22 from the V-2 headed runs. Update 2026-10-23: investigated ([result](#e8-investigation-2026-10-23)); E8-U1/U2 contract draft in review ([E8 addendum](p3-rounded-knot-topology-contract.md#e8-addendum-2026-10-23)); revised after review round 1 (PR #210), E8-Q1 to E8-Q6 decided, unit order E8-U0, E8-U1, E8-U2 |
| X1   | P3 exit evidence A01-A08 index                                    | — (Primary acceptance)                     | Open                                                                                                                                                                                                                                                                                                                                           |

E1 comes before E2: the early abort is a smaller, independent bound and needs no new certificate. The order is otherwise D9's.

## Items

Each item's scope and outcome are owned by the matching row of the [D9 first-items table](d9-post-mvp1-tracks-proposal.md#rendering-track-engine); this section adds only the acceptance check and the evidence it needs. A contract's acceptance criteria and validation method are written in that contract before code, as [`AGENTS.md`](../../AGENTS.md#working-rules) requires, and are not invented here.

| Item | Acceptance check (before code)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Evidence rule                                                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1   | Written in the [ST-U9 addendum, E1](p3-b2-stroke-contract.md#st-u9-addendum-2026-10-22-e1-early-abort-e1-unit-st-u10) (approved 2026-10-22, E1-Q3 (a)); implementing unit ST-U10. It defines "certain" (outcome-preserving abort at ledger start only, E1-K1). It keeps every outcome unchanged, including every case that succeeds today. The costly `NodeLimit` class is not abortable. Effect: `edges-1024` about 54 ms measured, about 19 ms projected. The sort-time improvement is a separate candidate under D9-Q7 / E2-alt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Independent contract review before code; a compatible stroke baseline record at `stroke-v0+r4` must be committed before any speed claim, or the ST-U9 addendum defines the comparison. Under E1-Q4 (a), E1 makes no speed claim |
| E2   | To be written in the same addendum: the certificate, the fallback rule to family A and its own performance gate. E2-alt (raise `STROKE_V0_LIMITS` or a swept crossing collector above 64 edges) is decided there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Independent contract review before code; the same baseline rule as E1; the choice between E2 and E2-alt cites E1's result                                                                                                       |
| E3   | To be written as the B4 corpus and measurement contract per [D8 B4](p3-d8-parallel-tracks.md#two-tracks): frozen versioned corpus, independent oracle, rejecting positive controls                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Measurement run on the frozen corpus; until it exists every result keeps the UNVERIFIED precision label; stroke rows are re-run when E1 or E2 changes outcomes                                                                  |
| E4   | A written decision between S2 and A1, the candidates recorded in the [ST-U3f follow-up](p3-fill-stroke-meshes.md#b2-st-u3dst-u3e-stroke-sharing-review-follow-up); A1 is cross-track (see D9 E4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Decision record with the fixture evidence the contract names; the investigator's counts are re-run, not quoted                                                                                                                  |
| E5   | A scenario contract that fixes a decision rule for the scope the [AL-OB5 verdict](p3-al-ob5-workload-scenario-proposal.md#4-decision-use) does not cover; the run does not set the rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Committed benchmark records per [`docs/benchmarks/README.md`](../benchmarks/README.md); a result cannot redefine its threshold                                                                                                  |
| E6   | A kernel-placement contract at the R2/K1 decision; a move into the kernel changes port output and is reviewed by both tracks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Independent review of contract and evidence; the exception in [graphics-engine-architecture.md](../graphics-engine-architecture.md#anti-aliasing) ends only by removal or move                                                  |
| E7   | Candidate (2026-10-22): a kernel contract that makes stored fill meshes conforming (T-vertices split into their edges using existing vertices, as P3.1j proposed), as the remedy for the user-approved A01 watertightness amendment ([P3 acceptance table](p3-fill-stroke-meshes.md#runtime-acceptance-coverage-to-freeze-in-p30b)); it changes fill output, so it bumps the fill revision and affects the identity runs and the AL-OB5 baseline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Independent contract review before code; A01 watertightness evidence from the E3 crack report; A04 re-run on the new revision per the E3 contract (E3-R4)                                                                       |
| E8   | Candidate (2026-10-22, from the V-2 headed runs, kernel `fill-v0+r2`): an investigation of `fill unsupported-geometry` on simple smooth Q/T and C/S paths. Paths: `M 0 0 L 0 -100 Q 100 -200 200 -100 T 400 -100 L 400 0 Z` and `M 0 0 C 0 -100 100 -100 100 -50 S 200 0 200 -50 L 200 50 L 0 50 Z`. Observation: both give `v2-path fill unsupported-geometry` and draw nothing in Chrome and Edge at DPR 1 and 2, while two nearby variants draw with `fringe-work-cap`. Hypothesis, not confirmed: the C/S path has all-integer coordinates, so "generic coordinates" alone does not explain it. Distinctive features of the failing paths are two adjacent smooth cubics joined at an inflection or vertical-tangent knot, and for the C/S path a vertical start tangent that continues the closing edge and a vertical tangent at the S knot. Reviewer's kernel table (`fill-v0+r2`, WASM `a7143f3a…`, tolerance exponent e): as-written Q/T gives `unsupported-geometry` at e -5..0 and `work-limit` at -8..-6; as-written S gives `unsupported-geometry` at -6..0 and `work-limit` at -8..-7; both drawing variants are `ok` at -6..0; the first cubic of each path alone is `ok` at -7..0. Fixtures: V-2 spec scenarios `p3qc` and `p3sc` ([contract amendment](viz-v2-path-data-contract.md#amendment-2026-10-22-primary-standing-instruction-v2-a9-p3-fixtures)). Update 2026-10-23: the hypothesis is refuted; the [investigation](#e8-investigation-2026-10-23) found mechanisms M1, M1′ and M2, and the acceptance checks of units E8-U1 to E8-U3 are written in the [E8 addendum](p3-rounded-knot-topology-contract.md#e8-addendum-2026-10-23), sections E8.8 and E8.9 |

## In-flight and exit items

State and evidence are owned by the [D9 in-flight table](d9-post-mvp1-tracks-proposal.md#rendering-track-engine) and by the P3 status index; this table carries only what the track still has to close. Update a state here only when the cited evidence exists.

| Item                                               | State                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| B2 ST-U6 re-review, ST-A0 amendment review, ST-U7  | Done per D9 (ST-U7c+d merged in #193); no action                                                       |
| B3 kernel defects found by the visualization pages | Open as found; viewer findings arrive as rendering-track items with a fixture; ST-U3f is tracked as E4 |
| C04 transport                                      | Open; the D8 carve-out keeps V2's transport functional and disposable                                  |
| P1 A09/A10                                         | Open; performance evidence UNVERIFIED ([P1 plan](p1-instanced-primitives.md))                          |
| P2 A08                                             | Open; FAIL, D7 entry exception only ([P2 plan](p2-geometry-kernel.md))                                 |

## P3 exit evidence index (X1)

By D9-Q2 (a) this plan carries the evidence index for the P3 exit gate. The visualization track supplies the headed pages for A07 and A08, and the Primary accepts the exit. The requirement text and thresholds stay in the [P3 acceptance table](p3-fill-stroke-meshes.md#runtime-acceptance-coverage-to-freeze-in-p30b). A row is marked done only when its evidence link exists.

| ID  | Evidence location                                                                                                                     | State                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| A01 | None yet                                                                                                                              | TODO                                           |
| A02 | None yet                                                                                                                              | TODO                                           |
| A03 | None yet                                                                                                                              | TODO                                           |
| A04 | None yet                                                                                                                              | TODO; depends on E3                            |
| A05 | None yet                                                                                                                              | TODO                                           |
| A06 | None yet                                                                                                                              | TODO                                           |
| A07 | None yet; A07 partial (V-3 evidence): [V-3 implementation evidence](d9-visualization-track.md#v-3-implementation-evidence-2026-10-23) | TODO; headed page from the visualization track |
| A08 | None yet                                                                                                                              | TODO; headed page from the visualization track |

## Evidence rules

- Baseline: per the [closure record baseline marking](p3-fill-stroke-meshes.md#mvp-1-closure-record-2026-10-22), AL-OB5 is the only accepted baseline, for fill and for its measured scope; no stroke baseline exists. Compatibility is stated per comparison ([D9, Baseline](d9-post-mvp1-tracks-proposal.md#baseline-and-performance-claims)). A performance claim needs a committed record following [`docs/benchmarks/README.md`](../benchmarks/README.md).
- GPU specs that check kernel outcomes are updated in the same PR as the change that alters the outcome.
- Every PR names its track, the packages touched and whether the shared surface changed, per the [PR gate in `AGENTS.md`](../../AGENTS.md#pull-request-gate).
- The weekly integration checkpoint is described in [D9, Operations](d9-post-mvp1-tracks-proposal.md#operations); this plan records its results by link only.

## E1 ST-U10 evidence, 2026-10-22

Dated append. Unit ST-U10 implements E1-K1 exactly as the approved [ST-U9 addendum, E1](p3-b2-stroke-contract.md#st-u9-addendum-2026-10-22-e1-early-abort-e1-unit-st-u10) specifies, on branch `claude/eng-e1-st-u10-early-abort`. Track: rendering. Packages: `geometry-wasm` (kernel), tooling, docs. Shared surface changed: no. Stroke precision stays **UNVERIFIED**. No performance claim (E1-Q4 (a)).

**What changed.**

- `rounded_line_fill.rs`: the stroke constructor `RoundedFillWorkspace::new_stroke(limits)` sets a private `early_abort` flag. `new(limits)` is unchanged and leaves the flag off, so `CubicFillWorkspace` (`cubic_fill.rs:292`) and every existing call site take no new branch. In `build_ledger`, after the cell-boundary loop and before the span loop, E1-K1 computes the closed form `F_L = Σ_c saturating_sub(n_c, 1)·(2E + s_c(s_c + 1)/2)` and `S` with checked arithmetic. It aborts only when `W + F_L > max_work`, `boundaries.len() + S ≤ max_boundaries` and `contributors.len() + Σ_vertical |Δrank| ≤ max_contributors` all hold. It then sets `work_units = max_work` and returns `WorkLimit`. The vertical ranks are found by an uncharged scan of the column's section range, and a missing section means no abort. The computation charges nothing and allocates nothing. The charged ledger loops carry a comment naming the forecast. `RoundedFillStats` gains no field. The inline `cfg(test)` modules are byte-identical to `main`.
- `cfg(test)` only: the E1.4 item 3 exactness assertion (`assert_eq!` of the span loop's actual charges against `F_L` whenever a stroke span loop completes), the per-thread probe with the "E1-K1 fired" counter, and the switch `with_early_abort_disabled`.
- `stroke_outline.rs`: `StrokeWorkspace` calls `new_stroke`.
- New `stroke_early_abort_tests.rs` (fixtures E1-F1 to E1-F8 and the ignored sweep `e1_c1_differential_sweep`) and its `lib.rs` declaration. No existing `*_tests.rs` file changes.
- New `tooling/p3-stroke-e1-corpus.mjs`, mode `c1`, for the corpus E1-C1: 1,134 chords cases (2 to 64 segments, every join and cap, `e ∈ {−3, −6}`), 57 `edges-N` stacks (N = 8 to 64), and the four remaining E1.1 cases. 1,195 cases in all. Two deviations are disclosed and were accepted in review round 1:

- (i) The extra guard-blocking sweep points described below.
- (ii) The three playground cases use their local path data. The scene placement and scale are left out, so their names carry `-local`: `cusp-f16-local` (the playground's `cusp-f16-large` draws this curve at scene scale 60), `wide-cubic-local` and `fill-stroke-circle-local`. The chord points come from JavaScript `Math.cos` and `Math.sin`, so the input hash is stated with its Node version.

**Identity (E1.4 item 1, E1-A1).** `emit_stroke_dump` ran on `origin/main` `485ddd0` (kernel identical to `ff81a93`) and on the branch. Each pair of dumps is byte-identical. `tooling/p3-stroke-dump-diff.mjs` reports `changed: 0` for every corpus.

| Corpus                                 | Cases | Input SHA-256               | Dump SHA-256, before = after |
| -------------------------------------- | ----: | --------------------------- | ---------------------------- |
| B2 line and cubic                      |   145 | `36cd8dcb…`                 | `ad6933bc…`                  |
| `p3-stroke-reversal-corpus.mjs lines`  | 4,800 | `f4914717…`                 | `82d7b014…`                  |
| `p3-stroke-reversal-corpus.mjs mixed`  |   720 | `aa0b9d39…`                 | `274c2f35…`                  |
| E1-C1 (`p3-stroke-e1-corpus.mjs c1`)   | 1,195 | `52940665…` (Node v24.15.0) | `8091e7c7…`                  |
| Review cusp corpus (scratch)           |   100 | `044c23b6…`                 | `3714546f…`                  |
| ST-U3c reproductions (scratch)         |    28 | `f4476fd8…`                 | `d937614f…`                  |
| ST-U3c table-direction probe (scratch) |   495 | `2d6ded2c…`                 | `361eabba…`                  |
| PR #190 review probe 1 (scratch)       |   107 | `9630b5e7…`                 | `ceec242e…`                  |
| PR #190 review probe 2 (scratch)       |   656 | `01a8edba…`                 | `d72020c1…`                  |

E1-C1's statuses are the same on both sides: 275 `ok`, 462 `Rounded(NodeLimit)`, 229 `Rounded(EventLimit)`, 215 `Rounded(InputLimit)`, 13 `Rounded(WorkLimit)` and 1 `Front(PieceLimit)`. All scratch inputs were available, so none is NOT RUN.

**Operation identity.** It stays `'geometry-wasm/stroke-v0+r4'`, with `stroke_v0_revision() == 4`. The fill identity and the ABI are unchanged. The release WASM's hash changes, because the code changes: `1387bada…` on `main` and `a7143f3a…` on the branch (from `pnpm test:p2-identity`). Every outcome stays identical.

**Fixtures (E1-A2, E1-A4).** All passed on their first run, with the literals of E1.5 fixed beforehand:

- E1-F1: `edges-1024` gives `WorkLimit` with `work_units = 64,000,000`. E1-K1 fired, no span loop was entered (E1-A4), `W = 1,531,479` and `F_L = 122,461,184`. `boundaries` and `contributors` are both 384.
- E1-F2: under wide limits the result is `ok` at 123,993,047 work units, the mesh is bit-identical on and off, and the exactness assertion ran.
- E1-F3: at 123,992,662, E1-K1 fired; the off run gives `WorkLimit` with 511 boundaries. At 123,992,663 it did not fire, and the span loop completed before `WorkLimit` in `build_mesh`. At 123,993,047 the result is `ok`.
- E1-F4: with `max_boundaries` 384 or 510 the cause stays `BoundaryLimit`, and with `max_contributors` 1,000 it stays `ContributorLimit`. In each case the guard blocked and nothing fired.
- E1-F5: ST-F16 at `e = −8`, the three chords-16 cases and chords-32 keep `NodeLimit`. None reaches E1-K1.
- E1-F6: `chev-1.40625` stays `TopologyAmbiguous` at `e = −3` and at `e = 0`.
- E1-F7: `edges-4` (64 edges, the swept path) fires at `W + F_L − 1` and does not fire at `W + F_L`.
- E1-F8: in `edges-1024` the vertical sum is 640, both when E1-K1 fires and when it does not. The off run ends with exactly `384 + 640` contributors.

A further test checks that a `new(limits)` fill workspace never reaches the probe.

**Differential and sweep (E1.4 item 2).** `P3_E1_CORPUS=<e1-c1.txt> cargo test --release --lib e1_ -- --ignored` PASS in 135 s with 8 threads. The run covered:

- 1,195 cases and 10,568 builds;
- 288 cases that reach the ledger, each swept at `max_work ∈ {2^k : 16 ≤ k ≤ 26} ∪ {W + F_L − 1, W + F_L}`;
- one extra blocking point per guard at `W + F_L − 1`: `max_boundaries = 2·cells + S − 1`, and, where verticals exist, `max_contributors = contributors + vertical − 1`. These points are needed for the "guard blocks" floor, because no E1-C1 case reaches the guards' production caps.

On and off were equal everywhere. The coverage floor holds: E1-K1 fired 58 times with `E ≤ 64` and 789 times with `E > 64`, the guards blocked 345 times, and 57 of the cases that reach E1-K1 have vertical contributors. The exactness assertion ran on 4,606 completed span loops.

**Seeded defects (E1-A3).** Each defect was applied to a scratch copy of the kernel, run, and then reverted. After the revert the copy passes all E1 tests.

| Defect                                                  | Failing test                                          | Output                                                                                 |
| ------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| E1-D1: `>` becomes `≥`                                  | `e1_f3_edges_1024_boundary_trio` (the middle row)     | `E1-K1 did not fire`: left 1, right 0                                                  |
| E1-D2: the forecast omits the lookup charges            | `e1_f2_edges_1024_wide_is_ok_and_identical`           | `E1-K1 forecast exactness` (`rounded_line_fill.rs`): left 122,461,184, right 1,302,528 |
| E1-D3: the contributor guard omits `contributors.len()` | `e1_f4_edges_1024_bounds_guard` (the contributor row) | cause: left `Rounded(WorkLimit)`, right `Rounded(ContributorLimit)`                    |

**Timing note (E1-A5): diagnostic, not evidence.** This is a functional observation only and makes no performance claim (E1-Q4 (a)). The run used native release, one thread, a Ryzen 7 3700X and Windows 11, with 5 builds on one reused production workspace, twice for each side. On `edges-1024`, E1-K1 on took a best of 18.6 ms and a median of 18.8-18.9 ms. Off took a best of 54.3-54.4 ms and a median of 54.5-54.7 ms. The scratch timing test is not committed.

**Validation.** Run on the branch with `CARGO_HOME` and `RUSTUP_HOME` set to the main checkout's `.tools`, without a junction. The commands and their results are listed in the PR. Still pending: the independent diff review and the evidence review (E1-Q1 (a)).

**Review round 1 (PR #202), 2026-10-22.** The verdict was NOT READY, on one mechanical item; the kernel and the evidence were accepted. The follow-ups below are applied.

- **B1.** This file was reformatted with `prettier --config .prettierrc.json --ignore-path "" --write`. `.prettierignore` excludes `**/*.md`, so `pnpm format:check` does not cover it.
- **S1.** The playground cases were renamed with `-local`. This changes the E1-C1 input hash from `35964ce6…` to `52940665…` (Node v24.15.0, S2). The before and after dumps were re-run and are again byte-identical (`8091e7c7…`), with `changed: 0` and the same statuses. The sweep was re-run with identical counts.
- **S3.** The fixture comment on the E1-F4 window now gives the 127 vertical boundaries that are emitted before `WorkLimit`.

## E3 E3-U1 evidence, 2026-10-22

Dated append. Unit E3-U1 implements the corpus generator of the [E3 contract](d9-e3-b4-precision-contract.md), section 5, as its [section 13 annex](d9-e3-b4-precision-contract.md#13-e3-u1-corpus-annex-2026-10-22) makes it executable (deliverables of section 13.9). The work is on branch `claude/eng-e3-u1-a04-corpus`, which is stacked on the annex PR #205. Track: rendering. Packages: tests, tooling (`package.json` script, `vitest.e3-a04.config.ts`) and docs. Shared surface changed: no. **No kernel was run on the corpus.** The oracle-only freeze check and the freeze note belong to E3-U2 (section 5.5), so the corpus is generated but not yet frozen. Precision stays **UNVERIFIED**.

**Files.**

- `tests/geometry/e3-a04/corpus.ts`: the generator. It implements sections 13.2 to 13.7, including the hex literal tables of E3-N10. At generation it uses only binary64 basic operations, `Math.floor`, `Math.round` on exact values, and BigInt. It evaluates no `Math.sin`, `Math.cos`, `Math.sqrt` or `Math.pow`.
- `tests/geometry/e3-a04/corpus-v1.manifest.json`: the manifest, with the version, the generator SHA-256, the seeds, the per-stratum counts, the byte count, `corpusSha256`, the Node version and the Rust span hashes.
- `tests/geometry/e3-a04-corpus.test.ts`: 15 tests (14 at first; review round 1 added one). `pnpm test:e3-a04` runs them through `vitest.e3-a04.config.ts`, and `pnpm test:geometry`'s glob collects them too, so they also run in CI.
- `docs/validation.md`: a row for `pnpm test:e3-a04`, as section 9.3 requires. Prettier re-padded the existing command table: on `main` the file did not pass `prettier --check`.

**Corpus `a04-corpus/v1`.**

| Stratum | Cases | Stratum | Cases |
| ------- | ----: | ------- | ----: |
| C1      | 4,680 | C7      |   108 |
| C2      | 1,800 | C8      | 2,682 |
| C3      | 4,860 | C9      | 3,510 |
| C4      | 1,728 | C10     |    12 |
| C5      | 7,038 | C11     |   576 |
| C6      |   324 | C12     |   144 |

- **Total.** 27,462 cases, matching section 13.8. The canonical text is 31,259,558 bytes (31,265,408 before review round 1).
- **`corpusSha256`.** `7f4bb1c97b2358ef45d23fdcab31aadc35fe4e7d3d5de25ce1bea7a8203d721c` after review round 1. The first push had `7f4d090f320b37b42848edac590f2f050af908600effdb90c941d955e670dcbb`.
- **Generator SHA-256.** `3c4f12991f0554cad2dde1d96eb549cb343b6ecee3e24539e8083320e7e0d438` after review round 1. The first push had `4f535c6be0cbcc7ec4565ccec5b206babed2f179d91f037cfb51158e71af26b0`.
- **Node.** v24.15.0. Generation takes about 1 s.
- **Engine independence.** No generated value depends on a JavaScript transcendental function. T1, T2, T6, the chevron arms, f01, f06, f08 and j05 are hex tables. The test re-derives each of them with a BigInt Taylor series (2^-320 fixed point, accepted only when both ends of its error interval round to the same binary64) and bit-compares the result. T1 and T2 also equal V8's `Math.cos` and `Math.sin`, as section 13.3 states.
- **Source-module checks.** The AL-OB5 rings (c14 to c19 and f02) come from `generateCellPaths`, which uses `Math.cos` and `Math.sin`. Their check against that module is therefore V8-dependent. The literals themselves are fixed.

**Tests (all PASS).**

- **Regeneration (E3-A1).** The test regenerates the corpus and checks `corpusSha256`, the counts, the bytes, the seeds and the generator SHA-256 against the manifest.
- **Schema.** It checks the 20 keys, the index order, the stratum order, the id format, unique ids, valid `duplicateOf` targets and the point counts.
- **Literal tables.** T0 to T7, the chevrons, f01, f06, f08 and j05. Every value that is rounded to an integer lies more than `10^-3` from a tie.
- **Sources.** c14 to c19 and f02 are checked against `generateCellPaths`. c20 to c23 are checked against `fixedNativeDepthPositiveCubicFixtureRows`. Forty-eight C5 and C9 rows are checked against the stroke-oracle fixtures that they name. k01 to k06 are checked against `STROKE_S2_FAMILIES`.
- **Rust spans.** The SHA-256 of each l76 to l79 span is checked against the `5c691ad` blob, and each literal is checked as well. The non-failing drift report against HEAD says that all three spans are unchanged, at lines 728, 1752 and 1890.
- **Partial placement.** The extent of every partial case lies in `[4096, 8192)` and exceeds `640·d + 4`.
- **53-bit draws.** Every generic scalar comes from a recorded 53-bit draw. More than 90 % of the draws carry more than 32 significant bits.
- **C7.** `s = 1` holds exactly at the four attainable pairs, so 48 of the cases are duplicates.
- **C4.** Every gap enclosure lies in `[g, 2g]`, with its lower end at least `g`.

**Interpretations where section 13 is silent.** Each one affects `corpusSha256`. Each is the literal reading of the annex text, and each is listed for review before the freeze.

1. **Closing and orientation.**
   - Every named fill polygon is emitted as a closed contour (`Z`).
   - "Centered" and "at the origin" squares (s06 to s08, x09, x11) are centered on the origin.
   - A hole "at (x, y)" (j02, j04) has its minimum corner there.
2. **`source` strings.**
   - A stroke-oracle fixture name where one exists.
   - `page:<node>` for a page node.
   - `T03:S/TRI/k24` and similar for the T03 analogs.
   - `AL-OB5/<cell>/path<i>` for the AL-OB5 rings.
   - `SB-<n>` for the ST-U8 rows.
   - `e3-annex/<row>` for annex-defined shapes.
3. **Generated ids.**
   - The seed is written as `0x%08x`.
   - C9's draw indices continue the shared stream: `g0150` to `g0299`.
4. **Generated draws.**
   - C5 and C9 draw no family index, because each has a single family.
   - C5 draws `n`, then the points, then the closed flag.
   - The C3 ring draws its anchors, then per edge `δ₁x, δ₁y, δ₂x, δ₂y`.
   - The pseudo-angle order is the exact angle in `[0, 2π)` from +x, counter-clockwise. The origin sorts first.
   - C1 snaps after the whole family is built, including the 1/4 hole.
5. **Tables.** Each table entry is the JavaScript expression, with `sin` and `cos` correctly rounded:
   - f01: `2 * Math.PI * i / 200`;
   - f06 and f08: `(deg * k * Math.PI) / 180`, with `R(x, y) = (x·c − y·s, x·s + y·c)`;
   - j05: `r * cos(2 * Math.PI * i / 32)`;
   - f03: the grid is row-major, with y outer.
6. **Camera.**
   - The midpoint is `(min + max) / 2`.
   - World points are `(a·x + b·y) + t`.
   - `E_cur` is `(d·z)·(a·x + b·y)`.
   - The empty path (x03) uses the box `{t}`.
   - x01 and x02 keep the label `T0`, with `world.l` overridden.
   - The first push kept `joint` on C6, C7 and C8 copies and gave k27 and k28 single-member groups. Review round 1 replaced both, as described below.
7. **Test fallback in CI.** On a shallow CI checkout without `5c691ad`, the span test fetches exactly that commit (`git fetch --depth=1 origin <sha>`) before it reads the blob.

**Validation.** The commands and their results are in the PR. Still pending: E3-U2 (the oracle and the oracle-only freeze check), then the freeze note, and one independent diff review of this unit.

**Review round 1 (PR #206), 2026-10-22.** The verdict was READY WITH FOLLOW-UPS. The reviewer reproduced `corpusSha256` exactly, and CI passed. The Primary decided the follow-ups under the user's standing instruction, taking the recommended option each time. They are recorded in [contract section 13.11](d9-e3-b4-precision-contract.md#1311-e3-u1-implementation-interpretations-2026-10-22-accepted-under-the-users-standing-instruction) and applied in one commit:

- **Joint.** `joint` is `null` on every C6, C7 and C8 copy, and on k27 and k28, which keep opacity 0.5. A new test asserts that every joint group pairs one fill with one stroke per transform and pair.
- **No −0.** f01's one −0 entry is now +0, and no other table had one. The new test asserts that no table and no case carries `8000000000000000`.
- **F1.** The generator comment and section 13.11 state that `gap.phys` is a lower bound for n12 to n14.
- **F2.** The test comment says that an engine change can fail the `generateCellPaths` comparison without a corpus change, because the literals are authoritative.
- **F4.** The comment on the error bound of the exact series is tightened.
- **Rerun.** The corpus and the manifest were regenerated, giving the hashes above. `pnpm test:e3-a04` passes 15 of 15 and `pnpm check` passes.

## E8 investigation, 2026-10-23

Dated append. This is the investigation result for item E8. Kernel `fill-v0+r2`, `main` 6a3a624, natively in `packages/geometry-wasm/kernel` with scratch `cfg(test)` probes that are not committed. Track: rendering. No code changed. The contract for the fix is the draft [E8 addendum](p3-rounded-knot-topology-contract.md#e8-addendum-2026-10-23).

**Reproduction.** The native run reproduces the reviewer's table exactly.

- **Q/T path:** `work-limit` at e −8 (`CommandLimit`) and at −7..−6 (`OwnerLimit`); `unsupported-geometry` at −5..0.
- **C/S path:** `work-limit` at −8..−7 (`CommandLimit`); `unsupported-geometry` at −6..0.
- **Where both fail at the unsupported exponents:**
  - The fast rung falls back with `MONOTONE` (FR4, `fill_ladder.rs:1700-1745`).
  - Step 1 of the exact cascade fails. For Q/T, `preflight_knots` returns `KnotMismatch` (`simple_cubic_topology.rs:2304`), then the rounded helper's adjacent check (`:839`) fails. For C/S, the exact helper's adjacent hull check (`:512`) fails.
  - Step 2 (triangle-free) then fails at its adjacent check (`:1102`) with `Topology(Unresolved)`, which maps to `unsupported-geometry`.
- **Not the ST-U3f class.** Rounded fill never runs, so this is not an `embed_scalar` event in `rounded_line_fill.rs`.

**Root cause.** The failing pair is not at the cubic-cubic knot, so the earlier hypothesis (inflection or vertical-tangent knot between the two cubics) is refuted.

- **M1 (Q/T): a corner next to a cubic leaf.** The rounded rungs accept an adjacent pair only along the sole direction d = N.Q3 − P.Q0 ([P3.1f](p3-rounded-knot-topology-contract.md) line 11; FR4 uses the same w).
  - At the T-end corner (leaves 32→33, d = (12.5, 88.28)) the short T tail heads along (1, −1) and the long `L 400 0` along (0, 1): a 135° turn, so a control difference has a negative dot.
  - Only the exact-knot helper (P3.1e) tolerates such corners, and it needs every flattening knot to be exactly representable. Raising Q to a cubic gives non-dyadic thirds, so its knots are not exact.
- **M1′ (C/S): a tangential reversal.** The S ends with a vertical tangent and `L 200 50` returns along x = 200, a 180° turn.
  - The knots are exact, but the adjacent hulls overlap along a segment, and no common direction exists.
- **M2: an inexact source-final knot.** A cubic's final flattened point is `origin + (p3 − origin)` (`geometry.rs:651-654`). With non-dyadic endpoints it often differs from p3, and `preflight_source_final` (`:2286`) then returns `KnotMismatch`.
  - M2 does not affect the two V-2 paths, whose endpoints are integers.

**Why the variants pass, and the minimal condition.**

- **The Q/T variant** has the same geometry and the same corner, but every control is an integer (90·2/3 = 60). It passes through the exact-knot helper. The original path with coordinates ×3 passes the same way.
- **The C/S variant** ends along (20, −60), a 161° turn that is not collinear. The exact helper's hulls then meet only at the knot.
- **M1 needs both:** a path containing a cubic whose flattening knots are not all exact, and an adjacent edge pair that fails the d test. In practice that pair is a turn of about 90° or more, worst when a short leaf meets a long segment.
- **M1′ needs only** a tangential reversal at a knot.

**Prevalence.** 200 paths per family. Each cell gives the `unsupported-geometry` count at e −3 / 0. The lens families are simple by construction (P0 = (−100, 0), P1 = (100, 0), upper controls above and x-ordered, lower controls below, a random offset), so every failure is a kernel limitation, not invalid input.

| Family                                                                 | Today (r2) | E8-U1 prototype | E8-U1 + E8-U2 prototype |
| ---------------------------------------------------------------------- | ---------: | --------------: | ----------------------: |
| Lens, corner knots, integer                                            |      0 / 0 |           0 / 0 |                   0 / 0 |
| Lens, tangent-aligned knots, integer                                   |      0 / 0 |           0 / 0 |                   0 / 0 |
| Lens, corner knots, one decimal (/10)                                  |    35 / 47 |         11 / 12 |                   0 / 0 |
| Lens, tangent-aligned knots, one decimal (/10)                         |     0 / 42 |          0 / 42 |                   0 / 0 |
| Lens, corner knots, thirds (/3)                                        |    38 / 47 |         20 / 26 |                   0 / 0 |
| Lens, tangent-aligned knots, thirds (/3)                               |     1 / 19 |          1 / 18 |                   0 / 0 |
| Icon-like wave: `M 0 0 L 0 -H Q.. T.. L W 0 Z`, integer W, H, A        |  167 / 152 |           1 / 4 |                   1 / 4 |
| Unconstrained random two-cubic loops, integer (corner and smooth knot) |   77 / 110 | not re-measured |         not re-measured |
| Unconstrained random two-cubic loops, integer, all knots tangent       |    27 / 59 | not re-measured |         not re-measured |

How to read the table:

- **Unconstrained loops** often self-intersect or have near-cusps (failures at `:422` and `:515`). They are an upper bound, not icon prevalence.
- **Remaining wave failures** are non-adjacent crossing failures (`:1115`). With E8-U1 and E8-U2, the C/S path (M1′) stays unsupported.
- **The E8-U1 column** uses the exact candidate of addendum E8.3.
- **The E8-U2 column** uses a scratch snap of the final knot in the flattener, which applies in every rung. That gives the same statuses on these families, but it is not the exact-rung-only rule of addendum E8.4.

**Decisions taken under the standing instruction** (recommended options; recorded for review, not yet approved):

- Fix candidate F3 becomes E8-U1, exact rung only.
- F5c becomes E8-U2, exact rung only.
- The tangential reversal (F4) is deferred: E8-U3 records M1′ as a known unsupported case, and `p3sc` stays not drawn.
- Rejected:
  - F3 in the fast rung: it changes `ok` meshes and needs revision 3.
  - F5 in the shared flattener: it changes P2 output and fast-rung meshes.
- Neither unit changes an `ok` mesh, so `fill_v0_revision()` stays 2 ([V2](p3-v2-fill-mesh-transport-contract.md) lines 36 and 491).
- No threshold changes, and the A04 target does not change.

**Review round 1 (PR #210), 2026-10-23.** The verdict was NOT READY on one blocking item. E8-U1 was found sound and byte-identical. The Primary applied every item under the standing instruction. They are recorded in [addendum section E8.12](p3-rounded-knot-topology-contract.md#e812-review-round-1-2026-10-23).

- **B1 (blocking).** The E8-U2 snap now runs on `commands` before `collect_contours`, so the closure rule sees canonical points. A snap after collection gave E8-F5 a zero-length closing owner and an internal error.
- **S1-S7.**
  - E8-P1 now blocks E8-U2 (E8-K11).
  - A light-tier tooling unit, E8-U0, adds a `--failure-to-success` mode to `pnpm test:p3-fill-identity` with a reviewed self-test.
  - The work bound in P3.2n line 17 is amended.
  - The TypeScript oracle mirror is added (E8-K10).
  - Each E8-C5 control has its own replacement.
  - Every fixture states its result after E8-U1 alone and after both units.
  - The completeness note is reworded.

**Decisions, 2026-10-23, under the standing instruction:**

- E8-Q1 (a): exact rung only.
- E8-Q2 (b): TypeScript oracle mirror.
- E8-Q3: per control.
- E8-Q4 (a): `p3qc` expectation updated in the E8-U1 PR, with visualization-track review.
- E8-Q5 (a): separate PRs, E8-U0, then E8-U1, then E8-U2.
- E8-Q6 (a): M1′ recorded in the addendum and this plan only.

**Next.** Re-review of the revised addendum, then E8-U0 on its own branch.
