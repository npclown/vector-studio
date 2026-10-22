# D9 rendering track plan

Status: active from the `mvp-1` tag. This plan holds the rendering track's status index, items, acceptance checks and evidence rules. The decision, the ownership boundary, the shared surface and the operating model are owned by [D9](d9-post-mvp1-tracks-proposal.md) (approved 2026-10-22) and are not repeated here. P3 history and the P3 acceptance table stay in [`p3-fill-stroke-meshes.md`](p3-fill-stroke-meshes.md). The Track B name from [D8](p3-d8-parallel-tracks.md) is retired for post-MVP 1 work (D9-Q5 (a)).

Ownership: the packages and pages listed in [D9, rendering track](d9-post-mvp1-tracks-proposal.md#rendering-track-engine). Branches use the prefix `claude/eng-<item>-<slug>`. A change to the shared surface is full tier with both-track review ([D9, Boundary](d9-post-mvp1-tracks-proposal.md#boundary)).

## Status index

| Item | Subject                                                           | Tier                                       | State                                                                                                                                                                        |
| ---- | ----------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1   | ST-U9 early abort when failure is certain                         | Full                                       | ST-U10 implemented ([evidence](#e1-st-u10-evidence-2026-10-22)); independent diff and evidence review pending                                                                |
| E2   | ST-U9 family-B fast-rung contract                                 | Full                                       | Not started                                                                                                                                                                  |
| E3   | B4: A04 corpus and measurement contract                           | Full                                       | Not started. Update 2026-10-22: [contract draft](d9-e3-b4-precision-contract.md) in review. Update 2026-10-22 (later): contract approved (PR #204); next E3-U1 corpus freeze |
| E4   | ST-U3f fix decision                                               | Full                                       | Not started                                                                                                                                                                  |
| E5   | Unmeasured-scope measurements after the AL-Q6 (a) decision        | Full (scenario contract), then light (run) | Not started                                                                                                                                                                  |
| E6   | Remove or move the D8-interim overlay and fringe builders         | Full                                       | Not started                                                                                                                                                                  |
| E7   | Conforming refinement (E3-Q10 (c), remedy for A01 watertightness) | Full                                       | Candidate, added 2026-10-22 from the [E3 decisions](d9-e3-b4-precision-contract.md#user-decisions-2026-10-22); not started                                                   |
| X1   | P3 exit evidence A01-A08 index                                    | — (Primary acceptance)                     | Open                                                                                                                                                                         |

E1 comes before E2: the early abort is a smaller, independent bound and needs no new certificate. The order is otherwise D9's.

## Items

Each item's scope and outcome are owned by the matching row of the [D9 first-items table](d9-post-mvp1-tracks-proposal.md#rendering-track-engine); this section adds only the acceptance check and the evidence it needs. A contract's acceptance criteria and validation method are written in that contract before code, as [`AGENTS.md`](../../AGENTS.md#working-rules) requires, and are not invented here.

| Item | Acceptance check (before code)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Evidence rule                                                                                                                                                                                                                   |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1   | Written in the [ST-U9 addendum, E1](p3-b2-stroke-contract.md#st-u9-addendum-2026-10-22-e1-early-abort-e1-unit-st-u10) (approved 2026-10-22, E1-Q3 (a)); implementing unit ST-U10. It defines "certain" (outcome-preserving abort at ledger start only, E1-K1). It keeps every outcome unchanged, including every case that succeeds today. The costly `NodeLimit` class is not abortable. Effect: `edges-1024` about 54 ms measured, about 19 ms projected. The sort-time improvement is a separate candidate under D9-Q7 / E2-alt | Independent contract review before code; a compatible stroke baseline record at `stroke-v0+r4` must be committed before any speed claim, or the ST-U9 addendum defines the comparison. Under E1-Q4 (a), E1 makes no speed claim |
| E2   | To be written in the same addendum: the certificate, the fallback rule to family A and its own performance gate. E2-alt (raise `STROKE_V0_LIMITS` or a swept crossing collector above 64 edges) is decided there                                                                                                                                                                                                                                                                                                                   | Independent contract review before code; the same baseline rule as E1; the choice between E2 and E2-alt cites E1's result                                                                                                       |
| E3   | To be written as the B4 corpus and measurement contract per [D8 B4](p3-d8-parallel-tracks.md#two-tracks): frozen versioned corpus, independent oracle, rejecting positive controls                                                                                                                                                                                                                                                                                                                                                 | Measurement run on the frozen corpus; until it exists every result keeps the UNVERIFIED precision label; stroke rows are re-run when E1 or E2 changes outcomes                                                                  |
| E4   | A written decision between S2 and A1, the candidates recorded in the [ST-U3f follow-up](p3-fill-stroke-meshes.md#b2-st-u3dst-u3e-stroke-sharing-review-follow-up); A1 is cross-track (see D9 E4)                                                                                                                                                                                                                                                                                                                                   | Decision record with the fixture evidence the contract names; the investigator's counts are re-run, not quoted                                                                                                                  |
| E5   | A scenario contract that fixes a decision rule for the scope the [AL-OB5 verdict](p3-al-ob5-workload-scenario-proposal.md#4-decision-use) does not cover; the run does not set the rule                                                                                                                                                                                                                                                                                                                                            | Committed benchmark records per [`docs/benchmarks/README.md`](../benchmarks/README.md); a result cannot redefine its threshold                                                                                                  |
| E6   | A kernel-placement contract at the R2/K1 decision; a move into the kernel changes port output and is reviewed by both tracks                                                                                                                                                                                                                                                                                                                                                                                                       | Independent review of contract and evidence; the exception in [graphics-engine-architecture.md](../graphics-engine-architecture.md#anti-aliasing) ends only by removal or move                                                  |
| E7   | Candidate (2026-10-22): a kernel contract that makes stored fill meshes conforming (T-vertices split into their edges using existing vertices, as P3.1j proposed), as the remedy for the user-approved A01 watertightness amendment ([P3 acceptance table](p3-fill-stroke-meshes.md#runtime-acceptance-coverage-to-freeze-in-p30b)); it changes fill output, so it bumps the fill revision and affects the identity runs and the AL-OB5 baseline                                                                                   | Independent contract review before code; A01 watertightness evidence from the E3 crack report; A04 re-run on the new revision per the E3 contract (E3-R4)                                                                       |

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

| ID  | Evidence location | State                                          |
| --- | ----------------- | ---------------------------------------------- |
| A01 | None yet          | TODO                                           |
| A02 | None yet          | TODO                                           |
| A03 | None yet          | TODO                                           |
| A04 | None yet          | TODO; depends on E3                            |
| A05 | None yet          | TODO                                           |
| A06 | None yet          | TODO                                           |
| A07 | None yet          | TODO; headed page from the visualization track |
| A08 | None yet          | TODO; headed page from the visualization track |

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
