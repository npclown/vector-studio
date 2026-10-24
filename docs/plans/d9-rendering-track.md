# D9 rendering track plan

Status: active from the `mvp-1` tag. This plan holds the rendering track's status index, items, acceptance checks and evidence rules. The decision, the ownership boundary, the shared surface and the operating model are owned by [D9](d9-post-mvp1-tracks-proposal.md) (approved 2026-10-22) and are not repeated here. P3 history and the P3 acceptance table stay in [`p3-fill-stroke-meshes.md`](p3-fill-stroke-meshes.md). The Track B name from [D8](p3-d8-parallel-tracks.md) is retired for post-MVP 1 work (D9-Q5 (a)).

Ownership: the packages and pages listed in [D9, rendering track](d9-post-mvp1-tracks-proposal.md#rendering-track-engine). Branches use the prefix `claude/eng-<item>-<slug>`. A change to the shared surface is full tier with both-track review ([D9, Boundary](d9-post-mvp1-tracks-proposal.md#boundary)).

## Status index

One line per item since [D10](d10-roadmap-reset.md): state and a link. Dated detail goes in the evidence sections below or under `docs/evidence/`. Phase is the D10 roadmap phase; backlog items start only when they block A01-A08 or the user moves them.

| Item | Subject | Tier | Phase | State |
| --- | --- | --- | --- | --- |
| E1 | ST-U9 early abort when failure is certain | Full | R0 | Done: merged (#202), independent review ACCEPTED 2026-10-23 ([review](../evidence/r0-review-closeout-2026-10-23.md#e1)) |
| E3 | B4: A04 corpus and measurement contract | Full | R1 | In progress: U1 (#206), U2 (#212), U2b (#214), U2c (#216) merged; freeze not met (5 `ORACLE-WORK`); U3 harness and U4 GPU model check in review (headed Chrome and Edge PASS on non-corpus cases), no corpus run ([U3 evidence](#e3-e3-u3-evidence-2026-10-24), [U4 evidence](#e3-e3-u4-evidence-2026-10-24)) |
| E8 | Unsupported-geometry on simple smooth Q/T and C/S paths | Full | R1 | Done: U0 (#211), U0b (#213), U1 (#215), U2 (#221) merged; U3 records M1′ as known unsupported ([U3 record](#e8-u3-record-and-e8-close-2026-10-24)) |
| E10 | A08 test hooks for V-4: forced sample count, fringe-off, frame readback, count pass | Full (shared surface) | R1 | Contract APPROVED 2026-10-24 ([contract](d9-e10-renderer-test-hooks-contract.md)); U1, U2 and U3 in review in one pull request (departure from contract section 7, which plans separate pull requests: the session has one branch, and U3 needs U1 and U2); E10-A7 headed run PASS 2026-10-24, 12/12 in Chrome and Edge ([record](../evidence/e10-test-hooks-2026-10-24/record.md)); E10-A9 evidence review READY 2026-10-24 (contract section 14); merge of #228 closes E10 |
| E11 | P3 C03-C05 closure and exit snapshot | Full | R1 | Contract APPROVED 2026-10-24 (Q1-Q4 (a)); U2 sweep tool merged (#225), scene: 0 structure issues, fill 318 and stroke 121 of 1,000 meshed ([U2 evidence](#e11-e11-u2-evidence-2026-10-24)); U4 addendum APPROVED 2026-10-24 ([addendum](d9-e11-u4-failure-behavior-addendum.md)), implementation merged (#232), headed GPU check E11-U4-A4 PASS 2026-10-24 ([U4 evidence](#e11-e11-u4-evidence-2026-10-24)); next U3 after the E3 freeze and V-4 (E8-U2 merged, #221) ([contract](d9-e11-p3-c03-c05-closure-contract.md)) |
| E14 | Fill and stroke `work-limit` on ordinary smooth 32-cubic paths | Full | R1 | Promoted to R1 by the user 2026-10-24 (with E2); fill cause: the S1 prefix edge cap 256 ([cause](../evidence/e14-fill-work-limit-cause-2026-10-24.md)); E14-U1 contract APPROVED 2026-10-24 (rung-0 cap 8,192, Q1-Q3 (a) auto-adopted), next E14-U1 implementation ([contract](d9-e14-fill-rung0-edge-cap-contract.md)) |
| E2 | ST-U9 family-B fast-rung contract: stroke seam merge, band leaves, family-B rung | Full | R1 | In progress: E2-U1 seam merge (`stroke-v0+r5`, scene stroke ok 121 → 223) in review ([contract](d9-e2-stroke-fast-rung-contract.md), [U1 evidence](../evidence/e2-u1-2026-10-24.md)) |
| X1 | P3 exit evidence A01-A08 index | — (Primary acceptance) | R1 | Open; all eight TODO ([index](#p3-exit-evidence-index-x1)) |
| E4 | ST-U3f fix decision | Full | Backlog | Seven cases stay a known defect with fixtures (D10) |
| E7 | Conforming refinement (A01 watertightness remedy) | Full | Backlog | Candidate; first to promote if A01 needs it |
| E5 | Unmeasured-scope measurements after AL-Q6 (a) | Full, then light | Backlog | Not started |
| E6 | Remove or move the D8-interim overlay and fringe builders | Full | Backlog | Not started |
| E12 | Production mesh layout: the C04 parts and A07 gaps left open by v0 (K1, E1-E3, limits) | Full | Backlog | Proposed by E11 under E11-Q1 (a) ([E11 section 5](d9-e11-p3-c03-c05-closure-contract.md#5-c04-layout-ownership-cache-and-lifetime)) |
| E13 | Partial-coverage tolerance and stroke coverage gate | Full | Backlog | Proposed by E11 under E11-Q4 (a) ([E11 section 4.1](d9-e11-p3-c03-c05-closure-contract.md#41-the-coverage-blockers-of-the-private-contract)) |
| E9 | E1 review follow-ups: guard equality tests, per-guard blocked counter | Light | Backlog | Not started ([review](../evidence/r0-review-closeout-2026-10-23.md#e1)) |

E1 comes before E2: the early abort is a smaller, independent bound and needs no new certificate. The order is otherwise D9's.

## Items

Each item's scope and outcome are owned by the matching row of the [D9 first-items table](d9-post-mvp1-tracks-proposal.md#rendering-track-engine); this section adds only the acceptance check and the evidence it needs. A contract's acceptance criteria and validation method are written in that contract before code, as [`AGENTS.md`](../../AGENTS.md#working-rules) requires, and are not invented here.

| Item | Acceptance check (before code)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Evidence rule                                                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1   | Written in the [ST-U9 addendum, E1](p3-b2-stroke-contract.md#st-u9-addendum-2026-10-22-e1-early-abort-e1-unit-st-u10) (approved 2026-10-22, E1-Q3 (a)); implementing unit ST-U10. It defines "certain" (outcome-preserving abort at ledger start only, E1-K1). It keeps every outcome unchanged, including every case that succeeds today. The costly `NodeLimit` class is not abortable. Effect: `edges-1024` about 54 ms measured, about 19 ms projected. The sort-time improvement is a separate candidate under D9-Q7 / E2-alt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Independent contract review before code; a compatible stroke baseline record at `stroke-v0+r4` must be committed before any speed claim, or the ST-U9 addendum defines the comparison. Under E1-Q4 (a), E1 makes no speed claim |
| E2   | To be written in the same addendum: the certificate, the fallback rule to family A and its own performance gate. E2-alt (raise `STROKE_V0_LIMITS` or a swept crossing collector above 64 edges) is decided there. Written as its own [E2 contract](d9-e2-stroke-fast-rung-contract.md), where E2-alt is decided                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Independent contract review before code; the same baseline rule as E1; the choice between E2 and E2-alt cites E1's result                                                                                                       |
| E3   | To be written as the B4 corpus and measurement contract per [D8 B4](p3-d8-parallel-tracks.md#two-tracks): frozen versioned corpus, independent oracle, rejecting positive controls                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Measurement run on the frozen corpus; until it exists every result keeps the UNVERIFIED precision label; stroke rows are re-run when E1 or E2 changes outcomes                                                                  |
| E4   | A written decision between S2 and A1, the candidates recorded in the [ST-U3f follow-up](p3-fill-stroke-meshes.md#b2-st-u3dst-u3e-stroke-sharing-review-follow-up); A1 is cross-track (see D9 E4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Decision record with the fixture evidence the contract names; the investigator's counts are re-run, not quoted                                                                                                                  |
| E5   | A scenario contract that fixes a decision rule for the scope the [AL-OB5 verdict](p3-al-ob5-workload-scenario-proposal.md#4-decision-use) does not cover; the run does not set the rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Committed benchmark records per [`docs/benchmarks/README.md`](../benchmarks/README.md); a result cannot redefine its threshold                                                                                                  |
| E6   | A kernel-placement contract at the R2/K1 decision; a move into the kernel changes port output and is reviewed by both tracks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Independent review of contract and evidence; the exception in [graphics-engine-architecture.md](../graphics-engine-architecture.md#anti-aliasing) ends only by removal or move                                                  |
| E7   | Candidate (2026-10-22): a kernel contract that makes stored fill meshes conforming (T-vertices split into their edges using existing vertices, as P3.1j proposed), as the remedy for the user-approved A01 watertightness amendment ([P3 acceptance table](p3-fill-stroke-meshes.md#runtime-acceptance-coverage-to-freeze-in-p30b)); it changes fill output, so it bumps the fill revision and affects the identity runs and the AL-OB5 baseline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Independent contract review before code; A01 watertightness evidence from the E3 crack report; A04 re-run on the new revision per the E3 contract (E3-R4)                                                                       |
| E8   | Candidate (2026-10-22, from the V-2 headed runs, kernel `fill-v0+r2`): an investigation of `fill unsupported-geometry` on simple smooth Q/T and C/S paths. Paths: `M 0 0 L 0 -100 Q 100 -200 200 -100 T 400 -100 L 400 0 Z` and `M 0 0 C 0 -100 100 -100 100 -50 S 200 0 200 -50 L 200 50 L 0 50 Z`. Observation: both give `v2-path fill unsupported-geometry` and draw nothing in Chrome and Edge at DPR 1 and 2, while two nearby variants draw with `fringe-work-cap`. Hypothesis, not confirmed: the C/S path has all-integer coordinates, so "generic coordinates" alone does not explain it. Distinctive features of the failing paths are two adjacent smooth cubics joined at an inflection or vertical-tangent knot, and for the C/S path a vertical start tangent that continues the closing edge and a vertical tangent at the S knot. Reviewer's kernel table (`fill-v0+r2`, WASM `a7143f3a…`, tolerance exponent e): as-written Q/T gives `unsupported-geometry` at e -5..0 and `work-limit` at -8..-6; as-written S gives `unsupported-geometry` at -6..0 and `work-limit` at -8..-7; both drawing variants are `ok` at -6..0; the first cubic of each path alone is `ok` at -7..0. Fixtures: V-2 spec scenarios `p3qc` and `p3sc` ([contract amendment](viz-v2-path-data-contract.md#amendment-2026-10-22-primary-standing-instruction-v2-a9-p3-fixtures)). Update 2026-10-23: the hypothesis is refuted; the [investigation](#e8-investigation-2026-10-23) found mechanisms M1, M1′ and M2, and the acceptance checks of units E8-U1 to E8-U3 are written in the [E8 addendum](p3-rounded-knot-topology-contract.md#e8-addendum-2026-10-23), sections E8.8 and E8.9 |
| E14  | Promoted to R1 by the user 2026-10-24; fill cause in the [E14 record](../evidence/e14-fill-work-limit-cause-2026-10-24.md). Candidate (2026-10-24, from the [E11-U2 scene sweep](#e11-e11-u2-evidence-2026-10-24), kernels `fill-v0+r2` and `stroke-v0+r4`): an investigation of `work-limit` on ordinary smooth closed paths of 32 cubics. Observation: fill meshes every scene path up to about 16 device px in radius, 75 of 115 between 16 and 64, and none at 64 or more; stroke meshes 120 of 243 below 16, 1 of 115 between 16 and 64, and none at 64 or more; no self-intersecting (looping) path meshes. Fill `work-limit` is not on the E11-Q2 closed list, so such a row in `a04-corpus/v1`, if the post-freeze sweep finds one, would fail A02. Acceptance check: a written cause (which cap: `FILL_V0_LIMITS` edges 256, vertices or triangles 1,024, work 32M; for stroke E2's limits) and a contract with its own fixtures, before code. Related: E2, E2-alt, E8 |

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
| A07 | Partial (V-3, review accepted 2026-10-23): [V-3 implementation evidence](d9-visualization-track.md#v-3-implementation-evidence-2026-10-23) | TODO; headed page from the visualization track |
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

## E3 E3-U2 evidence, 2026-10-23

Dated append. Unit E3-U2 implements the independent A04 oracle of the [E3 contract](d9-e3-b4-precision-contract.md), section 4, with its proof obligations (section 4.5), the controls and seeded defects that section 9.1 assigns to E3-U2, and the oracle-only freeze check of section 5.5. The executable choices are recorded in the contract's [section 14 annex](d9-e3-b4-precision-contract.md#14-e3-u2-oracle-annex-2026-10-23). Each was decided under the user's standing instruction of 2026-10-22. Track: rendering. Packages: geometry-reference, tests, tooling and docs. Shared surface changed: no. **No kernel was run.** Precision stays **UNVERIFIED**.

**Files.**

- `packages/geometry-reference/src/a04-region.ts` (new) is the oracle. It imports only `./stroke-region.js` (`classifyStrokeSource`). Its source SHA-256 was `1a85af04aadfa71a51e9dd6214ba9ffd1bbf8a479317e96c57da8817d7b3fba2` at the first commit and is `629041a4963c92c0ed4937fb748a31abc07c543e461e66fb175efb1cb819c114` after the review follow-up below. It is exported from the package index.
- `tests/geometry/e3-a04-oracle.test.ts` (new) holds the paired tests, the controls and the seeded defects. `pnpm test:e3-a04` runs them, and `pnpm test:geometry`'s glob collects them too.
- `tests/geometry/e3-a04/oracle-cases.ts` (new) builds canonical cases and synthetic meshes for the tests.
- The freeze check: `tests/geometry/e3-a04/freeze.check.ts`, `vitest.e3-a04-freeze.config.ts` and `tooling/run-e3-a04-freeze.mjs`, with the `package.json` script `pnpm e3-a04:freeze`. It is sharded and manual, never CI.
- `docs/validation.md` gains the `pnpm e3-a04:freeze` row, and the `pnpm test:e3-a04` row now covers E3-U2.

**Obligations and their paired tests** (section 4.5; all PASS).

| Obligation | Test                                                                                                                                                                                                                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a)        | Closed-form windings of the pentagram (2, 1, 0) and of the nested squares (1, 0, 1). Rays through cubic anchors (roots at `t = 0, 1`) and tangent rays. The self-intersecting loop's two lobes wind in opposite senses. Closure membership on vertices, edges, a pinch, an exact on-cubic point `104 + 3κ`, the seam of coincident opposite edges and a zero-area contour |
| (b)        | ST-F16: the cusp disk, not a sweep normal (with the disk dropped, `(0.5, 0.78)` is outside and the cusp itself inside). ST-F19: the collinear continuation is `[−1, 1]²`. ST-F18 at butt: the stationary start has its limit normal and no disk behind it                                                                                                                 |
| (c)        | E3-PC6: the 0.4 px hole's four edges are found, and `B_R` contains `8 − 0.2`. E3-D12: the pentagram's ten outline portions match the exact closed form, and the crossing ellipses' eight bits lie within `10^-6` px of the closed-form diagonal crossings. Dropping one crossing is caught in both                                                                        |
| (d)        | A folded band (the parabola `y = x²/2`, `r = 2`): ∂R passes through the closed-form fold point `(0, 2.5)`, membership flips at `±2^-20`, and the certified distance there is at most `2^-10`. A wide turn: the inner offsets cross at `(0, 2√2)`. Both pass the freeze check. E3-D4 is caught on the folded band                                                          |
| (e)        | E3-PC13 under T4 with 24-bit offsets: in `M*`, one T-junction, six boundary sub-edges, `E = 0`, PASS, crack bound `2β_c`. `a04StorageCracks` reports 0 storage cracks, and 1 when the T-vertex is moved off its edge. E3-D11 (no splitting) gives a spurious boundary with `B_M > 0.25`                                                                                   |
| (f)        | E3-PC4: `G = 8` (closed form) with `B_M < 8`. E3-PC5: the independent grid estimate of `G` lies in the oracle's interval, and `G > B_M`. E3-D13: the annulus gives `G = 4 − 2√2` and `B_R = 6`. Skipping boundary-free leaves is caught                                                                                                                                   |
| (g)        | 4,005 random dyadic pairs: every outward-rounded operation, sqrt and rational conversion contains the exact BigInt value. `nextUp` and `nextDown` step by one binary64                                                                                                                                                                                                    |

**Controls and seeded defects.**

| ID                                       | Result                                                                                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E3-PC1, PC2                              | 0.26 px FAIL and 0.24 px PASS, each with the realized offset inside `[E_lo, E_hi]`                                                                                            |
| E3-PC3 (circle row)                      | The 14-gon of an exact radius-16 circle FAILS, with the closed-form sagitta (0.40 px) inside the interval                                                                     |
| E3-PC10                                  | Rectangle `E = 0`. The dyadic polygon translated by `(0, 2^-4)` gives `E = 2^-4`. The inscribed 4-gon and 16-gon of the exact circle (ST-S10 point cap) contain the sagitta   |
| E3-PC11                                  | An empty mesh FAILS, with `B_R = +∞`                                                                                                                                          |
| E3-PC14                                  | A missing mesh over a cover of Ω FAILS at the window point (`R` in, `M` out). The negative control, a shape away from Ω with no mesh, is `window-empty` and agrees            |
| E3-D1                                    | Caught on PC4 and PC5 (E misses the closed-form `G`)                                                                                                                          |
| E3-D2                                    | Caught on PC11 (E becomes finite) and on PC6 (the closed hole passes)                                                                                                         |
| E3-D3                                    | Caught: membership flips at the pentagram center under both rules, and the PC5 case passes under the wrong rule                                                               |
| E3-D4                                    | Caught (nearest point puts a point beyond the butt end inside)                                                                                                                |
| E3-D5                                    | Caught on the synthetic ST-F16 mesh: the oracle FAILS with `B_M > 0.95` px, and without the disk `B_M < 0.25` px (the mutant computes `B_M` only, so its status is UNDECIDED) |
| E3-D6                                    | Caught: on the 16-gon against its every-other-vertex 8-gon, the center-only upper bound makes `B_M` miss the closed-form value                                                |
| E3-D8                                    | Caught at resolution `2^-16`: z = 0.01, DPR 3, 8,192 px extent; `E_hi ≤ 2^-16` with the binary64 z, and `E_lo > 2^-15` with fround(z)                                         |
| E3-D11, D12, D13                         | Caught (above)                                                                                                                                                                |
| E3-PC7 to PC9, PC12; E3-D7, D9, D10, D14 | Not in E3-U2: they need `β`, the record or the GPU (E3-U3, E3-U4)                                                                                                             |

**Freeze check (section 5.5).** **NOT COMPLETE, so the corpus is not frozen** (section 5.5, step 3). A full run is estimated at about 235 CPU hours, or about 17 hours on 14 shards, so only partial runs were made:

- **Partial run.** `pnpm e3-a04:freeze --shards 14 --stride 25` checks every 25th case, 1,099 cases. It ran on Node v24.15.0, Windows 11, with 16 logical CPUs, and was stopped after 896 cases: 894 `ok` and 2 `ORACLE-WORK`. The run used an oracle build from before the point-like bound change (8 to 16 cells), so its results are not tied to either committed source SHA (contract section 14.2).
  - Every sampled fill case of C1 to C4 passed (523 cases).
  - C5 passed 271 of 272 and C9 78 of 79. Of C8, C11, C12, C6, C7 and C10, 22 cases were reached, all `ok`. Slow C9 cases held the shards, so the later strata were barely reached.
- **Mean time per case.** Fills: C1 15 ms, C2 22 ms, C3 0.18 s, C4 0.10 s. Strokes: C5 28 s, C9 170 s, with a maximum of 30 min (`C9/k22/T0/z64-d2`). C8 averaged 4.5 s.
- **The two `ORACLE-WORK` cases.**
  - `C5/l34/T3/z1-d2` passes after the point-like bound was raised from 8 to 16 cells (section 14.2). Its last cells close in on the corner of a thin notch outside `R`, about a dozen per level.
  - `C9/k10/T7/z64-d3` (the ST-F18 input, butt, under T7) is still `ORACLE-WORK` on a recheck: the cover cell at `(667.9375, 540)` does not resolve.
- **An earlier run.** A stride-50 run of an earlier oracle build failed `C9/g0220/T5/z1-d2` and `C9/g0259/T7/z1-d1`. Their rechecks with this build did not finish within 90 minutes each and were stopped, so they count as open. A per-case cost that the work cap does not bound is an open item for the review.
- **Disposition.** Under E3-Q6 (a), a case the oracle cannot certify fails the freeze. Before the freeze note there must be either a new oracle version that certifies `k10` and the remaining cases, or a disclosed generator revision. The complete run then follows.

**Review follow-up, 2026-10-23 (PR #212).**

- **S1 fixed.** A fill's distance lower bound is now `min(res.lo, depthInside, r)`, as for strokes: a boundary edge that the index search clipped lies at least `r` away. The regression test (a tall rectangle, from `(−3, 180)` the true distance is 97 px) fails without the fix (lower bound about 703 px) and passes with it.
- **Documents.** The contract annex gains the parameter notes of S4 (section 14.2), the soundness arguments of S6 (section 14.5) and the open pre-freeze items (section 14.6). The E3-O4 row, the E3-D5 and E3-D6 texts and the `pnpm test:e3-a04` row of `docs/validation.md` are corrected.
- **OPEN before the freeze (E3-U2b).** Decided under the user's standing instruction of 2026-10-22 (the recommended option): E3-U2 lands as a partial unit, and E3-U2b closes these items before the freeze note (contract section 14.6):
  - S2: `∂M` by edge count is unsound for zero-area or overlapping triangles. The oracle must reject such a mesh or mark it UNDECIDED, or the harness must enforce a precondition.
  - S3: the work cap does not charge root steps or arc nodes, so the cost of a case is unbounded. A deterministic weighted cap is required before E3-A4.
  - S7: the crack bound counts only the T-junctions of `M*`. The port mesh's storage cracks from `a04StorageCracks` must feed `a04Measure`, or E3-U3 closes them.

**Validation.** The commands and their results are in the PR. Still pending: E3-U2b (S2, S3 and S7), then the complete freeze run and the freeze note (section 5.5, step 4).

## E3 E3-U2b evidence, 2026-10-23

Dated append. Unit E3-U2b closes the three open pre-freeze items S2, S3 and S7 of the [E3 contract](d9-e3-b4-precision-contract.md), section 14.6. Its choices are recorded in [section 14.7](d9-e3-b4-precision-contract.md#147-e3-u2b-pre-freeze-closure-2026-10-23). Each was decided under the user's standing instruction of 2026-10-22 (recommended option). Track: rendering. Packages: geometry-reference, tests and docs. Shared surface changed: no. **No kernel was run.** No A04 threshold changed. Precision stays **UNVERIFIED**.

**Files.**

- `packages/geometry-reference/src/a04-region.ts` gains three things. Its source SHA-256 was `218ed5891c1392239b5400578d27ea45225af657e2089113422ec777aa1e26e5` for the freeze run below, and is `0544b1dc8c4e8fced559e406851ff0dcca9e85b3fee06c9c9ed8992b3b3e0725` after the review follow-up.
  - The exact mesh preconditions.
  - The weighted work accounting, with its new caps, and `workByKind` in the freeze result.
  - The `portMesh` option and the `storage` result of `a04Measure`.
- `tests/geometry/e3-a04-oracle.test.ts` gains seven tests:
  - S2: a valid fan, the reviewer's zero-area sliver, a repeated vertex, and overlapping against touching triangles;
  - S3: determinism and the charged kinds, and the cap at the freeze and at measurement;
  - S7: the storage crack keeps the crack bound.

**Results.**

| Item | Result                                                                                                                                                                                                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S2   | Zero-area and overlapping triangles are found exactly, and the case is UNDECIDED with an `invalid mesh` reason, never PASS. The reviewer's sliver gives `invalid mesh: zero-area triangle 2`. A touching triangle is valid and measured. The section 14.5 `G` strip argument now cites S2 |
| S3   | Every unbounded loop is charged. The weights are fitted to wall time on the stride-25 run and scaled so that no case above 20 s took more than 1 µs per unit (largest 0.97). The caps are 1.8·10^9 units at the freeze (a nominal 30 min) and 7.2·10^9 at measurement                     |
| S7   | With `portMesh`, a port T-junction that is a storage crack in `M*` keeps the crack bound `2β_c`, although `M*` has no T-junction                                                                                                                                                          |

**The open cases of E3-U2 now end in bounded time.** Each is `ORACLE-WORK`: `C9/k10/T7/z64-d3` in 137 s (its cover cell at `(667.9375, 540)` does not resolve), `C9/g0220/T5/z1-d2` in 473 s and `C9/g0259/T7/z1-d1` in 552 s (both at the work cap). Before E3-U2b, the last two did not finish within 90 minutes.

**Stride-25 freeze run on the final build.** The run was `pnpm e3-a04:freeze --shards 14 --stride 25` at commit `7c8ac51` (oracle SHA above), on Node v24.15.0, Windows 11, with 16 logical CPUs. It took 69 min wall time and 10.5 CPU hours. The run directory was `.tools/e3-a04-freeze/2026-10-23T05-26-13-267Z/`, which is machine-local and not committed.

- **1,099 cases: 1,062 `ok` and 37 `ORACLE-WORK`.** The fill strata and C6, C7, C10, C11 and C12 are all `ok`. The failures are in C5 (5), C8 (1) and C9 (31).
- **Causes.** 35 cases reached the work cap, and two (`C9/k10`, `C9/g0234`) have a cover cell that does not resolve point-like. The slowest case took 1,168 s.
- **An earlier run with the first weights** (commit `4fe4679`) checked the same 1,099 cases: 1,079 `ok` and 20 `ORACLE-WORK`. It took 2 h 25 min, and up to 85 min per case, which is why the weights were refitted (contract section 14.7).
- **Full-run estimate.** About 263 CPU hours, or about 19 h on 14 shards. That is above 17 h, so the full run was **not started**.
- **Disposition.** Under E3-Q6 (a), the 37 cases fail the freeze, so the corpus is **not frozen**. About 900 cases of the full corpus would fail at this rate. Before the freeze note there must be either a faster oracle on these strokes or a disclosed generator revision, and then the complete run.

**Review follow-up (PR #214).**

- `crackBound` is null whenever the mesh was not fully built and checked.
- `a04StorageCracks` is charged and capped.
- Six tests are added: the two cap tests, and the S2 tests for a contained triangle, partly shared collinear edges, a duplicated triangle and a pair that only the second triangle separates.
- The stride-25 result is tied to SHA `218ed589…` and was not rerun. The change adds charges only after the freeze terms (contract section 14.7).

**Validation.** The commands and their results are in the PR. Still pending: the oracle speed or generator decision (E3-U2c), then the complete freeze run and the freeze note (section 5.5, step 4).

## E3 E3-U2c evidence, 2026-10-23

Dated append. Unit E3-U2c speeds up the A04 oracle on the stroke strata, the E3-Q6 (a) path of an oracle fix, with no corpus change. The changes and their soundness are in [contract section 14.8](d9-e3-b4-precision-contract.md#148-e3-u2c-oracle-speed-up-2026-10-23). Each was decided under the user's standing instruction of 2026-10-22 (recommended option). Track: rendering. Packages: geometry-reference and docs. Shared surface changed: no. **No kernel was run.** No A04 threshold or cap changed. The work weights were refitted (disclosed). Precision stays **UNVERIFIED**.

**Files.** `packages/geometry-reference/src/a04-region.ts`, with source SHA-256 `411c81780e0c83439633e64a5eb00a8c7184744bbe5a88f20839912edec442a1` at commit `52f5177`. The tests are unchanged: `pnpm test:e3-a04` passes its 60 tests.

**Results** (Node v24.15.0, Windows 11, 16 logical CPUs, 14 processes).

| Run                                                    | Result                                                                                                                                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The 37 `ORACLE-WORK` cases of E3-U2b, cap 6·10^9       | 36 `ok` (up to 1,658 s) and `C9/k10`. The C5 and C8 cases take 1 to 155 s                                                                                                                         |
| `pnpm e3-a04:freeze --shards 14 --stride 25` (52f5177) | 1,094 `ok` and 5 `ORACLE-WORK` of 1,099, in 42 min wall and 6.7 CPU hours. Four C9 cases reach the cap on sub-arc nodes (each `ok` in 19 to 28 min uncapped), and `C9/k10` has an unresolved cell |
| Full-run estimate                                      | About 168 CPU hours, about 12 h on 14 shards. **Not started**: the sample is not 100 % `ok`                                                                                                       |

**Disclosed.**

- The refitted weights bound the fitting sample at 1 µs per unit. On the freeze run, the worst stroke case took 1.53 µs per unit, so the cap bounds a stroke case at about 46 min, not 30. One fill case took 5.8 µs per unit (21 s).
- The run directory `.tools/e3-a04-freeze/2026-10-23T12-28-33-518Z/` is machine-local and not committed.

**Validation.** The commands and their results are in the PR. Still pending: a review of E3-U2c, and a decision on the five remaining cases (a further speed-up, a weight choice, or a disclosed generator revision for `k10`). Then the complete freeze run and the freeze note.

**Update 2026-10-23, review of PR #216.** Review finding B1 was a soundness defect in the integer clip: a kept vertex on the clip line kept a stale outgoing line, so a later clip could place a wrong vertex and drop a piece as covered. It is fixed, and the review's tests are added ([contract section 14.8](d9-e3-b4-precision-contract.md#148-e3-u2c-oracle-speed-up-2026-10-23)). The loose weight fit is kept, decided under the user's standing instruction of 2026-10-22 (recommended option).

- Source SHA-256 `47117f777812e43cb68c0793ac6db7a1dd4238f3500afcadd38a940efc4cbe09` at commit `0941180`. `pnpm test:e3-a04` passes 78 tests (60 before, 18 new).
- `pnpm e3-a04:freeze --shards 14 --stride 25` on that SHA: 1,094 `ok` and 5 `ORACLE-WORK` of 1,099, the same five cases, in 44 min wall and 6.7 CPU hours. No status changed, and one case's work changed slightly (`C9/k05/T0/z64-d1`, still `ok`). The run directory `.tools/e3-a04-freeze/2026-10-23T14-16-44-666Z/` is machine-local and not committed.

## E3 E3-U3 evidence, 2026-10-24

Dated append. Unit E3-U3 implements the A04 harness, the evidence record and the run tool of the [E3 contract](d9-e3-b4-precision-contract.md), section 9.1. The executable choices are in the contract's [section 15 annex](d9-e3-b4-precision-contract.md#15-e3-u3-harness-annex-2026-10-24). Each was decided under the user's standing instruction of 2026-10-22 (recommended option), and section 15.9 lists the four departures for the evidence review. Track: rendering. Packages: tests, tooling, docs, and a test-only hook in `geometry-reference`. Shared surface changed: no. **No kernel was run on the corpus**, because the corpus is not frozen. Precision stays **UNVERIFIED**.

**Files.**

- `tests/geometry/e3-a04/harness.ts`: the product path through the release WASM ports, `PathMeshPipeline` and K4 packing. Also the exact shader model, `β` with the NDC round trip, the guard band and clip model, the no-flip certificate, and the call to the oracle.
- `tests/geometry/e3-a04/record.ts`: the record, its aggregates, the coverage, the verdict, the validator and the Markdown view.
- `tests/geometry/e3-a04/controls.ts`: E3-PC1 to E3-PC9, E3-PC11 and E3-PC14 as synthetic port answers.
- `tests/geometry/e3-a04/smoke.ts`: the five non-corpus smoke cases.
- `tests/geometry/e3-a04/run.check.ts` and `vitest.e3-a04-run.config.ts`: the shard, finalize and smoke phases.
- `tooling/run-e3-a04.mjs`: `pnpm e3-a04:run`.
- `tests/geometry/e3-a04-harness.test.ts`: in `pnpm test:e3-a04`.
- `tests/geometry/e3-a04-harness-wasm.test.ts`: in `pnpm test:geometry`.
- `packages/geometry-reference/src/a04-region.ts`: the test-only `window` hook for E3-D9.

**Smoke cases on the release WASM** (Linux container, Node v22.22.0, one process per case; diagnostic timing only).

| Case                            | Status | `U` (px) | `β_c` (px) | Oracle time |
| ------------------------------- | ------ | -------- | ---------- | ----------- |
| `smoke/rect/T0/z1-d1`           | PASS   | 0.00128  | 0.00046    | 0.1 s       |
| `smoke/rect/T0/z64-d3`          | PASS   | 0.00198  | 0.00132    | 0.1 s       |
| `smoke/blob/T2/z1-d2`           | PASS   | 0.0764   | 0.00064    | 8 s         |
| `smoke/segment-butt/T0/z1-d1`   | PASS   | 0.00137  | 0.00040    | 274 s       |
| `smoke/polyline-miter/T0/z1-d1` | PASS   | 0.0161   | 0.00043    | 59 s        |

The blob has one collapsed triangle. Before the exemption of section 15.4 it was UNDECIDED (`invalid mesh: zero-area triangle 15`). An earlier, larger segment (length 96, width 8) did not end within 10 min.

**Findings for the evidence review.**

- `fringe-unsupported` hides the path in the product, so it is rejected, not measured (section 15.9, item 1).
- Kernel meshes can hold triangles that collapse after f32 storage (section 15.9, item 2).
- The oracle's cost on stroke cases decides the length of the reference run. The freeze estimate covers only the ideal boundary. The measurement also scores the mesh, and on the smoke strokes that took about a minute to more than ten minutes per case. The full-run cost is unknown until the freeze. It is an input to E3-U2d's oracle work.

**Validation.** The commands and their results are in the PR. Still pending: E3-U4 (the GPU model check, headed, on the user's machine), the corpus freeze note, then E3-U5's reference run.

## E3 E3-U4 evidence, 2026-10-24

Dated append. Unit E3-U4 implements the GPU model check of the [E3 contract](d9-e3-b4-precision-contract.md), section 7.1: the page, the headed spec and E3-PC12. The executable form is in the contract's [section 16 annex](d9-e3-b4-precision-contract.md#16-e3-u4-gpu-model-check-annex-2026-10-24), which also lists what the check does not observe (section 16.4). Each choice was decided under the user's standing instruction of 2026-10-22. Track: rendering. Packages: apps/playground (a test-only page), tests, tooling and docs. Shared surface changed: no. **No kernel was run on the corpus.** Precision stays **UNVERIFIED**.

**Files.**

- `apps/playground/e3-a04-readback.html` and `apps/playground/src/e3-a04-readback.ts`: the page.
- `tests/geometry/e3-a04/readback.ts`: the payload, the model check, a CPU stand-in for the page, and E3-PC12.
- `tests/gpu/e3-a04-readback.spec.ts`: the headed spec.
- `tests/geometry/e3-a04-readback.test.ts`: in `pnpm test:e3-a04`.
- `combineGpuChecks` in `record.ts`, and `--gpu <chrome.json>,<edge.json>` in `pnpm e3-a04:run`.

**Results.**

- **Software dry run.** Headless Chromium 153 on SwiftShader, which is not evidence: 8 draws and 77 points, no failures, largest error 0.076 of `β_vertex` and 0.118 of `β_feature`, and E3-PC12 rejected.
- **Headed Chrome 155.0.8059.85 and Edge 156.0.4314.42** on the user's NVIDIA GTX 1660 SUPER (Windows 11, commit `f856b96`, WASM `8034d36b…1d6f`): **both PASS**. Each read back 8 draws and 77 points within `β`: the largest ratio was 0.109 on the vertex path and 0.118 on the feature path. E3-PC12 was rejected. This is E3-A6 for the non-corpus cases; the named subset follows after the freeze (E3-U5). Details are in [contract section 16.5](d9-e3-b4-precision-contract.md#165-runs).

## E11 E11-U4 evidence, 2026-10-24

Dated append. Acceptance check E11-U4-A4 of the [E11-U4 addendum](d9-e11-u4-failure-behavior-addendum.md#6-acceptance-criteria): the headed GPU specs that read path notices, run on the user's machine after PR #232 merged.

- Commit: `fe94c4983e2564af8ad2429f9a8ad7134b30c87a` on `main`, which contains #232 (`55e1fa0`). Working tree clean for tracked files; nothing edited or committed during the run.
- Build: `pnpm install --frozen-lockfile`, `pnpm build`; release geometry WASM rebuilt with the pinned Rust 1.94.1, SHA-256 `8034D36B…101D6F`, the same as the build already on that machine. The container's `9b39af75` difference noted under E11-U2 is still unexplained and is still to be checked before the exit run.
- Command: `pnpm test:gpu -- --reporter=list` with the eight files below, headed, Chrome and Edge. GPU adapter name: not logged by the list reporter.
- Result: **PASS**, 34 tests passed, 0 failed, 0 skipped, exit 0, 10.0 min.

| Spec | Chrome | Edge |
| --- | --- | --- |
| `p3-b2-strokes` (DPR 1, 2, 3) | 3 passed | 3 passed |
| `p3-st-u6-stroke` (samples 1, 4) | 2 passed | 2 passed |
| `p3-st-u7-joint` (samples 1, 4, seeded defects) | 3 passed | 3 passed |
| `p3-v3-mesh-smoke` | 2 passed | 2 passed |
| `p3-v4-paths` | 1 passed | 1 passed |
| `viz-v1-appearance` (DPR 1, 2) | 2 passed | 2 passed |
| `viz-v2-path-data` (DPR 1, 2) | 2 passed | 2 passed |
| `viz-v3-integration` (DPR 1, 2) | 2 passed | 2 passed |

With E11-U4-A1, A2, A3 and A5 checked by CI on #232, unit E11-U4 is complete.

## E11 E11-U2 evidence, 2026-10-24

Dated append. Unit E11-U2 of the [E11 contract](d9-e11-p3-c03-c05-closure-contract.md#8-units): `pnpm p3-exit:sweep`, the A01 structure sweep. Light tier. **PRE-FREEZE observation, not A01 evidence:** the E3 corpus freeze record does not exist yet, so only the scene phase ran, and no exit snapshot exists (E11 section 3.2).

**Files.** `tests/geometry/p3-exit-sweep/structure.ts` (the checker: exact orientation over BigInt behind a Float64 filter, exact bounds, no duplicate directed edge by exact position, boundary edges against V1 rule 5, conformity (no vertex strictly inside an edge used once), and the `triangle-mesh` oracle, which also checks overlap, within its 256 cap), `scene.ts` (scene `p3-exit-stress/v1`, seed `0x5eede111`, pinned by digest in the unit test), `sweep.ts` (batches of 32, `requestId`s that are not positions, echo and result-count checks, every request re-run alone, whole-batch failures counted, nine seeded controls including a T-junction with a consistent boundary list), `run.check.ts`, `tooling/run-p3-exit-sweep.mjs` (provenance, exit status), `tests/unit/p3-exit-sweep-structure.test.ts` (in `pnpm test:unit`). The corpus phase refuses to run before the freeze record.

**Disclosure.** A first, unsmoothed scene draft was probed on the release WASM before v1 was fixed: every one of its 2,000 requests failed, most with `work-limit`. v1 (smooth Catmull-Rom contours, every fourth path looping) was then written and pinned. E11 section 8 says the generator and seed "are committed before its first run"; v1 was committed before its record run below, but not before that probe. The probe tuned the scene toward meshing more paths, which gives the checker more meshes, not fewer. The disposition of this departure is the evidence review's. The scene is a structure-sweep input, not a blind acceptance corpus.

**Run.** Container, Node 22.22.0 (the repo pins 24.15.0), on the clean committed head of this PR (`provenance.json`: `dirty: false`), WASM `9b39af75…2193` built here by `pnpm test:geometry` (the user's machine had `8034d36b…1d6f`; the difference is not explained and must be checked before any exit run), batch 32, 70 s: run `2026-10-24T04-13-19-255Z-f6716ea4` at commit `125d52c` (the same digest as run `394ead0b` at `b1f12f1`). Outcome digest `fcec1941…48ff` (the earlier dirty runs gave `129fa819…a5a3` twice; the digest changed only because mesh hashes now include array lengths).

| Kind | ok | `work-limit` | `unsupported-geometry` | Triangles | Oracle-checked | Structure issues |
| --- | --- | --- | --- | --- | --- | --- |
| Fill `fill-v0+r2` | 318 | 641 | 41 | 71,135 (max 732) | 230 | 0 |
| Stroke `stroke-v0+r4` | 121 | 879 | 0 | 256,418 (max 4,118) | 0 (every stroke mesh is over the oracle's 256 cap, so no stroke mesh was checked for overlap) | 0 |

Echo, isolation and whole-batch failures 0; all nine seeded controls caught on a real fill mesh and a real stroke mesh.

**Finding: size limits.** Paths meshed (`ok`; the rest are `work-limit` or `unsupported-geometry`, not split by size) by largest device-pixel radius, the largest distance of any path point from the origin × zoom × DPR (`sceneSizes` in the record):

| Radius (device px) | < 1 | 1-4 | 4-16 | 16-64 | 64-256 | 256-1,024 | 1,024-4,096 | 4,096-16,384 | ≥ 16,384 | Looping, all sizes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Paths | 37 | 91 | 115 | 115 | 118 | 104 | 105 | 54 | 11 | 250 |
| Fill ok | 37 | 91 | 115 | 75 | 0 | 0 | 0 | 0 | 0 | 0 |
| Stroke ok | 27 | 57 | 36 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |

An ordinary smooth closed path of 32 cubics does not fill at 64 device px or more, and strokes mesh for only about half of the paths below 16 px and almost none above. Fill `work-limit` is not on the E11-Q2 closed list. **E14** is added as a backlog candidate. **E2** stays in the backlog: E11 section 7.2 leaves its promotion to the user, and this finding is input to that decision. Neither changes a threshold, a cap or the closed list.

**Validation.** `pnpm check` and `pnpm p3-exit:sweep --scene`; results in the PR.

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

**Round 2 (PR #210), 2026-10-23.** READY WITH FOLLOW-UPS; follow-ups F1-F4 applied (addendum E8.12). The addendum is APPROVED 2026-10-23 by the Primary under the user's standing instruction of 2026-10-22.

**Next.** E8-U0 (identity tooling, light tier), then E8-U1, then E8-U2, each on its own branch.

### E8-U0 evidence, 2026-10-23

Light tier. `tooling/compare-p3-fill-identity.mjs` gains `--failure-to-success` as specified in [E8.2a](p3-rounded-knot-topology-contract.md#e82a-e8-u0-a-failure-to-success-mode-for-the-fill-identity-tool). No kernel code changed. Plain mode keeps its behavior; the existing `parseArguments` test is untouched (the option record gains `failureToSuccess` only when the flag is given).

- **Classification.** A record is the tuple (digest, allocations, code, crossings). A base record that is not a path failure must be equal in every field. A base path failure may become `ok` or another path failure (allowed change, listed with both codes) and otherwise is an internal-regression (also FAIL, counted separately). A missing or extra record is a FAIL. Path-failure and internal codes follow `fill_export::map_attempt_error`; unrecognized codes count as non-path-failure.
- **Self-test** (`node tooling/compare-p3-fill-identity.mjs --self-test`, exit 0, 21 failure-to-success cases plus plumbing and the existing revision-change self-test). All cases classified as specified:
  - unchanged branch: 0 allowed, 0 FAIL
  - failure becomes ok or another failure: 3 allowed, 0 FAIL
  - one mesh byte; ok record becomes a failure; boundary pair change; diagnostics-only digest change; statistics-only digest change; allocations change; crossings change; ok code change with equal digest; META record change; missing record (native and WASM); extra record: each FAIL naming the case
  - path failure becomes an internal error, a batch failure, or an unrecognized code: FAIL and internal-regression 1 each
  - ok record becomes an internal error: FAIL, internal-regression 0
  - full-run tamper checks (one native, one WASM ok case): detected
  - compare-only on a synthetic run directory: unchanged passes, an allowed change passes (plain mode refuses it), `--tamper` detected
- **Empty (PR #211 review F1).** `empty` (`path_status=1`, `NO_MESH(flat_status=1)`) is a result, not a failure: a base `empty` record must stay equal in every field, and a base path failure may become `empty` (allowed change). The self-test has 21 failure-to-success cases including both; unit tests: 25 passed. The classifier change cannot alter the main-versus-main run (all 82,393 records identical, none changes class), so that run was not repeated.
- **Bases (PR #211 review F2).** The plain run used base e6eb90f and the failure-to-success run used base d37ab86. They are equivalent: d37ab86 differs from e6eb90f only in documents (#210), and the branch changes only tooling and tests, so the kernel under comparison is the same.
- **Unit tests.** `tests/unit/p3-fill-identity-failure-to-success.test.ts` (new) and `tests/unit/p3-b0r-identity.test.ts`: 24 passed.
- **Plain mode.** `pnpm test:p3-fill-identity --base origin/main` (base e6eb90f, head 2dc09ea): PASS; native 76,352 and WASM 6,041 cases digest-equal; 16 oracles passed; 0 allocating cases. Run `artifacts/p3-b0r-identity/20261022T190154Z-208dd78b` (not committed).
- **New mode on main itself.** `pnpm test:p3-fill-identity --failure-to-success --base origin/main` (base d37ab86, head 2dc09ea, which differs from main only in tooling and tests): PASS; identical 82,393 (native 76,352, WASM 6,041), allowed change 0, FAIL 0, internal-regression 0; both tamper self-checks detected; 16 oracles passed. Run `artifacts/p3-b0r-identity/20261022T194548Z-f81753d9`.
- **Environment.** Windows 11, Node 24 pinned toolchain Rust 1.94.1, `CARGO_HOME`/`RUSTUP_HOME` = `D:\GIT\vector-studio\.tools\rust\{cargo,rustup}` (no junction). `pnpm check` PASS.
- **Open.** The mode keeps the plain revision rule (`fill_v0_revision()` equal); if E8-U1 or E8-U2 bump the revision, that decision belongs to their contract. The self-test needs the E8.2a review before E8-U1 relies on the mode (E8-K12).

### E8-U0b, 2026-10-23

Dated append. Light tier, track rendering, a precursor of E8-U1 decided by the Primary under the user's standing instruction of 2026-10-22 (recommended option). Acceptance check: a topology-free attempt's identity digest no longer depends on an earlier attempt in the same workspace, and plain `pnpm test:p3-fill-identity --base origin/main` stays identical.

- **Finding (from the E8-U1 identity run).** `p3_b0r_identity::attempt_digest` hashed `CubicFillWorkspace::topology_stats()` for every attempt. `CubicFillWorkspace::begin_attempt` (`cubic_fill.rs:532`) does not reset those statistics, so an attempt that never reaches topology (a line-only path, or one that stops before topology) reports the statistics of the previous attempt in the same workspace. With E8-U1, earlier attempts in a chunk change from failure to success, so 888 topology-free `ok` records changed digest without any output change.
- **Change.** The harness hashes `topology_stats` only when `diagnostics().topology_invoked` is true, and a fixed marker `topology_stats=NOT_INVOKED` otherwise. Review S1 (PR #213): `rounded_stats` is guarded the same way by `rounded_invoked` (set just before `tessellate`, `cubic_fill.rs:449`), with the marker `rounded_stats=NOT_INVOKED`. Residual: `certify_topology` can return `OwnerLimit` or `InvalidCommand` after `topology_invoked` is set and before the stats are written; those error records still hash stale stats (probably unreachable after the prefix checks; error records, not `ok` ones). No kernel code changes; the stats are not reset (Primary decision). The identity tool copies the harness into the merge base (bootstrap overlay), so both sides use the same digest format.
- **Test.** `p3_b0r_identity::topology_free_attempt_digest_ignores_stale_topology_stats`: a line-only square digests the same in a fresh workspace and after a curved path in a reused one, whose stale `topology_stats` differ. With the old format (seeded) the test fails. `pre_rounded_failure_digest_ignores_stale_rounded_stats` (S1): the linear-cubic bowtie, whose exact topology fails before the rounded fill, digests the same fresh and after a filled curved path in a reused workspace; it fails with the old format seeded.
- **Known quirk, diagnostic only.** `begin_attempt` leaves `topology_stats` from the previous attempt when topology is not invoked. It affects only `topology_stats()` as read after such an attempt; it does not reach any output, status or mesh. The same holds for `rounded_stats`. A reset in `begin_attempt` is a candidate cleanup, not done here.
- **Comparability.** The digest format changes, so identity-run digests from before and after E8-U0b are not comparable; a run compares two trees under the same harness (the overlay copies it into the base).
- **Evidence.** Topology guard only: plain `pnpm test:p3-fill-identity --base origin/main`, run `20261023T013851Z-7ffe2ac7` (base f56c263, head 2cfc377, clean): native 76,352 and WASM 6,041 cases equal, WASM equal to native, revisions 2 and 2, 16 full-size oracles passed, both tamper self-checks detected. After review S1 (rounded guard): run `20261023T034924Z-98fa1aac` (base 3d4f216, head 158e3ef with `main` merged in, clean): PASS, native 76,352 and WASM 6,041 cases equal, WASM equal to native, revisions 2 and 2, release WASM `a7143f3a…4ef5` on both sides, 16 full-size oracles passed, both tamper self-checks detected, O5 clean. An earlier run on 1f283fe against the then-new `main` 3d4f216 (`20261023T024126Z-1d769ada`) had all digests equal but failed O5 only because the branch lacked the E3-U2 test files of #212; `main` was merged in for the rerun.

### E8-U1 evidence, 2026-10-23

Dated append. Full tier, track rendering, branch `claude/eng-e8-u1-direction-hint` on `main` e77dcac (E8-U0 and E8-U0b merged; first written on f56c263). Implements [E8.3](p3-rounded-knot-topology-contract.md#e83-e8-u1-a-second-exact-candidate-direction) exactly: d₁ first, then the own-progress guard, then V (at most 8 vectors), the exact extremes a and b, d₂ = J(a − b) or a, and the frozen line-11 test with d₂. Kernel `fill-v0+r2`, `fill_v0_revision()` 2 (no bump). E8-U2 (the snap) is not in this unit.

**Change.**

- `simple_cubic_topology.rs`: one helper, `rounded_adjacent_projection`, called at the four sites of E8.1 (`RoundedKnotCubicTopologyWorkspace::check_pair` and its `reference_pair_body`, `TransverseArrangementWorkspace::check_pair` and its `reference_pair_body`). Every decision is an exact integer sign (`dot`, `cross_vectors`); step 6 reuses the frozen `rounded_projected_monotone`. No floating-point direction, no transcendental, nothing allocated. FR4 (`fill_ladder.rs`) and the P3.1e helper are untouched. Three `cfg(test)` hooks (`e8_test_adjacent_pair`, `e8_test_second_direction`, `E8TestLeaf`) outside the inline test module.
- TypeScript mirror (E8-K10): `adjacentPairProjects` in `tests/geometry/simple-cubic-topology/oracle.ts`, written from the E8.3 text, used by the P3.1f, P3.1g (and P3.1h) and P3.1i oracles; the oracle's leaf record gains a `closure` flag for the guard.
- Tests: `e8_direction_hint_tests.rs` (new: literal rule tests, the width test at the largest admitted magnitudes, two ignored emitters), the E8 fixtures and the crossing replacement in `fill_export_tests.rs`, the E8-C5 replacements, `tests/geometry/native-e8-corner.test.ts` (K10), `tests/geometry/e8-corner-corpus.test.ts` (K8, rates) and the `e8-corner/v1` generator.

**E8-C5 replacements** (E8.6, decided per control; every old path kept as a positive):

| Control                                                                           | Replacement                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mapping_row_fixtures_reach_their_kernel_values`, row "Topology(Unresolved) in both cascade steps" | E8-C1 at e = −3; `cubic_bowtie` asserted as step-1 `Unresolved`, export `ok`                                                                                                                                                                                                                                                                                                  |
| `cascade_retries_triangle_free_only_after_knot_or_unresolved`                      | crossing replacement for the KnotMismatch step; also E8-C1 for its "Unresolved in both steps" sub-check (the bowtie there flips too). `rounded_failure` asserted step-1 `Ok`, export `ok`                                                                                                                                                                                                       |
| `rounded_topology_failure_preserves_exact_knot_mismatch_and_recovers`              | E8-C2 at e = 0 (flatten 1, topology 1/2): exact `KnotMismatch`, rounded helper `Unresolved`, counters 33 leaves and 523 pairs (observed values, pinned); `rounded_failure_path` asserted admitted by the rounded helper                                                                                                                                                                         |
| `al_u3_defect_14_cascade_inverted_is_detected`                                     | crossing replacement (record step `TriangleFree`, `Legacy` under defect (14)); its second detector, the bowtie, also flips and is replaced by E8-C1. AL-F6 and the bowtie asserted as positives. Dated AL-F6 note in the [Alt-A1 contract](p3-alt-a1-fill-ladder-contract.md#43-fixtures-and-seeded-defects)                                                                                       |

**Crossing candidate (deviation, recorded).** The starting candidate, `transverse_bowtie` with one interior control offset by 2^−54, does not meet the preconditions: its trisection cubics flatten to single exact leaves (no internal knot) and no control is zero, so a 2^−54 offset rounds away and the path is the unchanged bowtie. The chosen path is that bowtie with its top edge bowed to controls (1, 6) and (−1, 6 + 2^−50). `e8_crossing_replacement_meets_its_preconditions` checks: `attempt` returns `KnotMismatch`, the rounded helper ran and failed `Unresolved` (not selected), `attempt_triangle_free` certifies with exactly one transverse crossing, and the export is `ok` with the mesh invariants. Since triangle-free builds the same leaves and applies the same adjacent test, the rounded helper's `Unresolved` is the non-adjacent crossing.

**Other expectations that flip (deviations, recorded; failure-to-success only).**

- **The frozen P3.1f cyclic-only projection control (contract line 47)** is not one of the four E8-C5 controls, but d₂ admits it: its last-to-first pair fails d₁ = (33/4, 9/4), while its vectors (C-to-A and A-to-B directions) lie in an open half-plane and every actual chord is its source chord. Native and oracle agree. Its literal input and frozen status stay in `roundedKnotTopologyControls`; `E8_ADMITTED_CYCLIC_ONLY` records its outcome (CERTIFIED, 6 leaves, 15 pairs, the literal polygon, orientation −1) and the P3.1f, P3.1g, P3.1h, P3.1i unit tests and the P3.2n, P3.2s, P3.2v native harnesses read it (counts 12/15 → 13/14, 24/13 → 25/12, 31/20 → 32/19). The P3.2x carrier keeps its frozen 42 rows by not inheriting that row. **Open question:** a cyclic-only rejection that survives E8-U1 (for example an M1′ turn at the last-to-first pair with exact knots) needs a Primary decision, as E8-Q3 did for E8-C5.
- **`tests/geometry/st-u7-joint-real-ports.test.ts`:** four cases whose fill port failed with `unsupported-geometry` now build (s-curve round and square caps, arch round caps e = −2, arch butt e = −1); `EXPECTED_OUTCOMES` re-baselined with a dated note.
- **V-2 `p3qc` (E8-Q4 (a), D9-Q8: `tests/gpu/viz-v2-path-data.spec.ts` is a visualization-track file changed in this rendering PR):** probes now expect fill inside the Q peak (100, −140) and backdrop outside (100, −160); the observed notice is `v2-path fill fringe-work-cap` (like `p3q`). `p3sc` unchanged.

**Acceptance (E8.8).**

| ID     | Result | Evidence |
| ------ | ------ | -------- |
| E8-K1  | PASS (before code) | Addendum approved 2026-10-23 (E8.12) |
| E8-K2  | PASS | `fill_export_tests::e8_fixtures_reach_their_e8_u1_status_through_the_export` (FillEngine batch, build-path self-check, mesh invariants): E8-F1 `ok` at e −5..0 and `work-limit` at −8..−6; E8-F2 `ok` at −7, −3, 0; E8-F3 and E8-F4 `ok` at −3, 0; E8-F5 `unsupported-geometry` (KnotMismatch at the source-final knot); E8-F6 `ok` at −6..0 with the same bytes as the merge base (scratch base-versus-branch WASM run: all 7 records byte-identical; committed as `fill_export_tests::e8_f6_output_bytes_equal_the_merge_base`, FNV-1a 64 of input and output pinned from the merge-base WASM, PR #215 review S3) |
| E8-K3  | PASS after E8-U0b (records); O5 accepted (disposition 2). | Rerun 2026-10-23 on the rebased head: `pnpm test:p3-fill-identity --failure-to-success --base origin/main`, run `artifacts/p3-b0r-identity/20261023T052923Z-b2b214f1` (base e77dcac, head 7318b50, clean): identical 77,842, allowed change 4,555, **FAIL 0, internal-regression 0** (native 71,848 identical and 4,504 allowed; WASM 5,994 and 51); cascade allowed changes: native 303 `path_status=6 -> 0` and 8 `6 -> 5`, WASM 51 `6 -> 0`; revisions 2 and 2; WASM-versus-native equal; 16 full-size oracles passed (3,597 s); both tamper self-checks detected; the tool verdict line is FAIL only for the accepted O5 inline-module difference of `native_cubic_fill_tests.rs`. First run, before E8-U0b: `pnpm test:p3-fill-identity --failure-to-success --base origin/main` with the 18 changed test files allow-listed, run `artifacts/p3-b0r-identity/20261023T002146Z-d7d957c6` (base f56c263, head cb4af0d): internal-regression 0; WASM 5,994 identical, 51 allowed, 0 FAIL; every native `fill_v0_cascade` `ok` record identical; native 888 FAIL, all on the four `CubicFillWorkspace` entries of line-only or topology-free paths (F6-slivers 106, F4-star-wave 101, L1 10, F5 5 paths, × 4 entries); revisions 2 and 2; WASM-versus-native digests equal; 16 full-size oracles passed (2,793 s); both tamper self-checks detected. The O5 inline-module check also fails for `native_cubic_fill_tests.rs` (its E8-C5 control is inside `mod tests`), as for B1. `pnpm test:p2-identity origin/main` PASS (10,048 batches, output SHA-256 `876f4a49…046f`). AL-OB5 admission tests (`p3_al_ob5_tests`, in `cargo test --release --lib`) PASS. AL-U2 ladder dump oracles: `tests/geometry/p3-fill-ladder-oracle.test.ts` PASS in `pnpm test:geometry` |
| E8-K4  | PASS | E8-C1 `unsupported-geometry` at −6..0, E8-C2 at −3, 0 (K2 test); E8-C3: native collapse and reversal controls `Unresolved` in `native-rounded-cubic-topology.test.ts`; E8-C4 unchanged except the E8-C5 controls and the cyclic-only deviation above; E8-C5 replacements fail in the same rung and step, old paths pass |
| E8-K5  | PASS for D1-D5 (U1), D5 by both named checks (PR #215 review B1); D6-D10 belong to E8-U2 | see the defect table |
| E8-K6  | Gated after E8-U2; U1 rates recorded below | — |
| E8-K7  | PASS | Headed V-2, `playwright.gpu.config.ts`, Chrome and Edge at DPR 1 and 2: 4 passed (6.6 min), runs Chrome `2026-10-23T00-46-04-416Z-34280`, Edge `2026-10-23T00-48-57-597Z-18828`, WASM `8034d36b…1d6f` |
| E8-K8  | PASS | `e8-corner-corpus.test.ts`: all 2,800 paths, native cascade digest equals release-WASM digest (status and bytes), 0 allocations |
| E8-K9  | PASS | `fill_v0_revision()` 2 on both sides; no threshold, cap or A04 target changed |
| E8-K10 | PASS | `native-e8-corner.test.ts`: 310 rows (E8-F1 to F6 and E8-C1, C2 at their exponents, every tenth `e8-corner/v1` path), P3.2n/P3.1f, P3.2s/P3.1g, P3.2x/P3.1i agree in status, leaves and pairs; E8-F1 (e −1, 0), F2 (−3, 0), F3 (0), F4 (0) certify at the oracle ceilings, C1/C2 stay `UNRESOLVED`. Existing native-versus-oracle corpora pass in `pnpm test:geometry` |
| E8-K11 | n/a (E8-U2) | — |
| E8-K12 | PASS | E8-U0 merged as f56c263 before this run |

**Seeded defects** (each seeded in the worktree, detected, then reverted with `git checkout`):

| ID    | Detected by |
| ----- | ----------- |
| E8-D1 | `cargo test --release --lib`: `e8_direction_hint_tests::own_progress_guard_keeps_a_reversed_actual_chord_unresolved`; and E8-C3 in `tests/geometry/native-rounded-cubic-topology.test.ts` (`control/reversed-actual-chord` certifies natively against the oracle's UNRESOLVED) |
| E8-D2 | `cargo test --release --lib`: 10 tests, among them `e8_fixtures_reach_their_e8_u1_status_through_the_export` (E8-F1 at e = −5 stays unsupported) |
| E8-D3 | `cargo test --release --lib`: `e8_direction_hint_tests::antiparallel_vectors_have_no_extreme` only. Finding: D3 cannot change an outcome, because step 6 re-verifies every dot exactly and, when V lies in an open half-plane, the weakened rule picks the same a and b; E8-C1 and E8-C2 stay unsupported under D3, so the detector is the literal step-4 test |
| E8-D4 | `cargo test --release --lib`: `simple_cubic_topology_sweep_tests::b0r_o3b_smoke_workspace_differential` (the B0R O3 reference loop) |
| E8-D5 | `cargo test --release --lib`: `fill_ladder_tests::al_u4b2_fr4_shared_operands_decide_as_before`; the debug AL-I3 sample did not fire. Update 2026-10-23 (PR #215 review B1): the full-size AL-I3 spike identity (`fill_ladder_tests::al_i3_full_corpus_equals_the_spike_and_allocates_nothing`, release, ignored, on the corpora of identity run `20261023T052923Z-b2b214f1`) with D5 seeded: **detected**, B0 frame 1,270 identical, `p3-b0r-random/v1` 810 failures of 12,000; seed reverted. `pnpm test:p3-fill-identity --failure-to-success --base origin/main` with D5 seeded (uncommitted, head f2370a8, base e77dcac), run `artifacts/p3-b0r-identity/20261023T083940Z-b60304d4`: **detected**, FAIL 433 (internal-regression 0): 408 native and 25 WASM `fill_v0_cascade` `path_status=0` records whose bytes differ (F4-star-wave 189, F6-slivers 143, F2-nested-rings 66, F5 9, L1 1 native); seed reverted. Both named detectors catch D5 |

**Corpus `e8-corner/v1`.** Generator `tests/geometry/e8-corner/corpus.ts` (seeded 64-bit LCG, constants and seeds written in the file), frozen by `corpus-v1.manifest.json` before any run: 14 frame families × 200 = 2,800 paths, 375,119 bytes, corpus SHA-256 `6a77cedb…bff4`. Cascade statuses, merge base f56c263 → E8-U1 (scratch base-versus-branch release-WASM run; branch equals native by K8; 0 `ok` record changed, 0 internal):

| Family              | e = −3 before → after          | e = 0 before → after           |
| ------------------- | ------------------------------ | ------------------------------ |
| lens /1             | 200 ok → 200 ok                | 200 ok → 200 ok                |
| lens /10            | 38 unsupported → 9             | 64 unsupported → 17            |
| lens /3             | 34 unsupported → 14            | 41 unsupported → 17            |
| lens-tangent /1     | 200 ok → 200 ok                | 200 ok → 200 ok                |
| lens-tangent /10    | 1 unsupported → 1              | 38 unsupported → 38            |
| lens-tangent /3     | 200 ok → 200 ok                | 11 unsupported → 11            |
| wave                | 158 unsupported → 0            | 142 unsupported → 2            |

The lens-tangent failures are unchanged by E8-U1, as the investigation found (source-final knots, M2, E8-U2).

**Review nit (PR #215, fill_export_tests.rs crossing replacement).** Asserting the non-adjacent finding directly is not cheap: the native `TopologyError::Unresolved` carries no pair or finding. The test keeps the stated argument (triangle-free builds the same leaves and passes every adjacent pair), so the rounded helper's `Unresolved` is the non-adjacent crossing.

**Other commands.** `cargo fmt --check`, `cargo clippy --all-targets -D warnings` and `cargo test --release --lib` (481 passed, 62 ignored on the rebased head) PASS. `pnpm test:geometry` (WASM rebuild, independent-build SHA-256 `8034d36b…1d6f`): kernel fmt, clippy and debug tests PASS; the vitest run (62 files, started before the two new E8 test files existed) reported 5 failures, of which the three cyclic-only rows and `st-u7-joint-real-ports` are fixed above and `extent-t03-local` timed out under concurrent load; the seven affected files plus the two new E8 tests then passed (514 tests), and `extent-t03-local` passed alone (4 tests). `pnpm check` PASS (80 files, 1,323 tests, boundaries PASS). `pnpm build` PASS.

**Blockers for the Primary.**

1. **E8-K3 tool verdict.** The 888 native FAIL records are a harness artifact: `CubicFillWorkspace::begin_attempt` does not reset `topology_stats`, and `p3_b0r_identity::attempt_digest` hashes it, so a path that never invokes topology hashes the stats of the last attempt in the same workspace. When that earlier attempt changed (a failure-to-success), the next topology-free `ok` record's digest changes. Scratch check: both kernels re-dumped with a harness digest that omits `topology_stats` and records `topology_invoked` (not committed): 71,422 identical, 4,930 allowed, 0 FAIL, 0 missing; all 888 official FAIL records are `topology_invoked=false` and equal under that digest. A fix (reset the stats, or the harness) is a tooling or kernel decision outside this unit.
2. **O5** flags `native_cubic_fill_tests.rs` because its E8-C5 control lives in the inline `mod tests`; unavoidable for that control.
3. **The cyclic-only control** needs a replacement decision (above).

**Dispositions, 2026-10-23.** Decided by the Primary under the user's standing instruction of 2026-10-22 (recommended option):

1. **K3 harness artifact.** Fixed in a separate precursor light-tier unit, [E8-U0b](#e8-u0b-2026-10-23) (PR #213): the identity harness hashes `topology_stats` and `rounded_stats` only when their stage ran. The kernel does not reset the stats. After E8-U0b merges, this branch is rebased and K3 rerun in `--failure-to-success` mode (expected 0 FAIL).
2. **O5 on `native_cubic_fill_tests.rs`.** Accepted with the B1 precedent: the E8-C5 control lives in that file's inline `mod tests`, so changing it cannot avoid the inline-module check. Every other O5 condition holds (the 18 changed test files are allow-listed and listed in the run).
3. **The cyclic-only control.** The handling above stands (literal input unchanged, admitted positive via `E8_ADMITTED_CYCLIC_ONLY`). A replacement negative cyclic-only control is added under the E8-Q3 rule, recorded as a dated [E8-Q3 extension](p3-rounded-knot-topology-contract.md#e812-review-round-1-2026-10-23) in the contract: `e8CyclicOnlyReplacement`, an M1′ turn at the last-to-first pair with exact knots, UNRESOLVED at pair 0,5 (6 leaves, 5 pairs) in P3.1f, P3.1g, P3.1i (`tests/unit/geometry-e8-cyclic-only.test.ts`) and natively in P3.2n, P3.2s, P3.2x (`e8_direction_hint_tests::cyclic_only_replacement_is_unresolved_natively`). A seeded oracle without the cyclic branch fails the TypeScript test (the pair turns into a nonadjacent contact). Deviation, accepted: the unchanged P3.1e certificate also rejects it (the frozen original was P3.1e CERTIFIED).
4. **Full `pnpm test:geometry`.** Rerun on the rebased head 7318b50 (base e77dcac): fmt, clippy, debug `cargo test` (481 passed), the native intersection capture and the reproducible release WASM (`8034d36b…1d6f`, equal to the independent build) PASS; vitest 63 files, 1,301 passed, 3 failed, 6 skipped. The 3 failures are 60 s timeouts in `extent-t03-local` (1) and `position-certificate` (2), files that E8-U1 does not touch and that import no fill kernel or topology oracle; another session's 14-shard calibration run loaded the machine during the run. Rerun of the two files: `position-certificate` PASS, `extent-t03-local` timed out again under the same load (it passed alone earlier, 4 tests). Every E8 test, native harness and oracle file passed. `cargo test --release --lib` 481 passed; `pnpm check` PASS (81 files, 1,326 tests). Link check: 130 relative links, 0 problems (the `#e8-u0b-2026-10-23` anchor resolves).
5. **CI cost (PR #215 review S5).** Risk: `native-e8-corner.test.ts` took 680 s and the CI run about 37 min with 310 rows (every tenth corpus path). Decision (Primary, standing instruction of 2026-10-22): CI samples every 40th corpus path (70 corpus rows plus the 30 fixture rows), and the full corpus stays available manually as `P3_E8_CORNER_STRIDE=1 pnpm test:geometry`. The K10 evidence above is the stride-10 run; the stride-40 default was rerun on this head (see the targeted tests).

### E8-U3 record and E8 close, 2026-10-24

Light tier, documents only, track rendering. E8-U3 is the record that [addendum E8.5](p3-rounded-knot-topology-contract.md#e85-e8-u3-tangential-reversal-stays-unsupported) asks for (E8-Q6 (a): in the addendum and this plan only). No code or test changes.

- **Known unsupported case: M1′, a tangential reversal.** A knot at which a source piece's end tangent is collinear with the next segment and points the opposite way stays UNRESOLVED in every rung and maps to `unsupported-geometry`. The adjacent hulls overlap along a segment, so no common direction exists for the d test, and the exact-knot helper's hulls do not meet only at the knot. A certificate (fix candidate F4: P minus the knot lies strictly on one side of N's supporting line, from the Bernstein coefficients after factoring out (1−t)^m) is deferred and needs its own contract.
- **Fixture.** V-2 `p3sc` (`M 0 0 C 0 -100 100 -100 100 -50 S 200 0 200 -50 L 200 50 L 0 50 Z`) stays not drawn with `v2-path fill unsupported-geometry`; its gated outcome in `tests/gpu/viz-v2-path-data.spec.ts` is unchanged. Headed V-2 after E8-U2 PASS 4/4 ([E8-U2 evidence](../evidence/e8-u2-2026-10-24.md#pc-runs-users-windows-machine)): `p3qc` draws, `p3sc` keeps its notice (E8-K7).
- **E8-K6 per-family counts** on `e8-corner/v1` after E8-U1 and E8-U2 (native cascade, equal to the release WASM, E8-K8), ok paths of 200 at e = −3 / 0:

| Family | e = −3 | e = 0 |
| --- | ---: | ---: |
| Lens, corner knots, integer, /10, /3 | 200 each | 200 each |
| Lens, tangent-aligned knots, integer, /10, /3 | 200 each | 200 each |
| Icon-like wave | 200 | 198; 2 `unsupported-geometry`, both non-adjacent hull crossings |

- **E8 acceptance (E8.8).** K1 and K12: addendum review and E8-U0 (#211, #213). K10: E8-U1 (#215). K2 to K9 and K11: E8-U2 (#221), [evidence](../evidence/e8-u2-2026-10-24.md); K3 identity diff FAIL 0 on the user's PC. The Alt-A1 oracle amendment that E8-U2 needed was decided by the user on 2026-10-24 (Alt-A1 contract §4.2).
- **Open, outside E8.** The unconstrained random two-cubic loop families (upper bound, often self-intersecting) were not re-measured; the wave family's non-adjacent crossings belong to the P3.1f crossing check, not to E8.

## Status history before D10 (kept as written)

The status index as it stood before [D10](d10-roadmap-reset.md) reduced it to one line per item. The dated updates are kept here unchanged.

| Item | Subject                                                           | Tier                                       | State                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | ----------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1   | ST-U9 early abort when failure is certain                         | Full                                       | ST-U10 implemented ([evidence](#e1-st-u10-evidence-2026-10-22)); independent diff and evidence review pending                                                                                                                                                                                                                                                                                                 |
| E2   | ST-U9 family-B fast-rung contract                                 | Full                                       | Not started                                                                                                                                                                                                                                                                                                                                                                                                   |
| E3   | B4: A04 corpus and measurement contract                           | Full                                       | Not started. Update 2026-10-22: [contract draft](d9-e3-b4-precision-contract.md) in review. Update 2026-10-22 (later): contract approved (PR #204); next E3-U1 corpus freeze. Update 2026-10-23: E3-U1 merged (#206); [E3-U2 oracle](#e3-e3-u2-evidence-2026-10-23) merged (#212); [E3-U2b](#e3-e3-u2b-evidence-2026-10-23) closes S2, S3, S7; stride-25 freeze 1,062 ok, 37 `ORACLE-WORK`, corpus not frozen |
| E4   | ST-U3f fix decision                                               | Full                                       | Not started                                                                                                                                                                                                                                                                                                                                                                                                   |
| E5   | Unmeasured-scope measurements after the AL-Q6 (a) decision        | Full (scenario contract), then light (run) | Not started                                                                                                                                                                                                                                                                                                                                                                                                   |
| E6   | Remove or move the D8-interim overlay and fringe builders         | Full                                       | Not started                                                                                                                                                                                                                                                                                                                                                                                                   |
| E7   | Conforming refinement (E3-Q10 (c), remedy for A01 watertightness) | Full                                       | Candidate, added 2026-10-22 from the [E3 decisions](d9-e3-b4-precision-contract.md#user-decisions-2026-10-22); not started                                                                                                                                                                                                                                                                                    |
| E8   | Unsupported-geometry on simple smooth Q/T and C/S paths           | Full                                       | Candidate, added 2026-10-22 from the V-2 headed runs. Update 2026-10-23: investigated ([result](#e8-investigation-2026-10-23)); contract approved (PR #210, [E8 addendum](p3-rounded-knot-topology-contract.md#e8-addendum-2026-10-23)); next E8-U0 (identity tooling), then E8-U1, then E8-U2. Update 2026-10-23: E8-U0 (#211) and E8-U0b (#213) merged; E8-U1 in review as PR #215 ([evidence](#e8-u1-evidence-2026-10-23)): K3 FAIL 0 after E8-U0b, O5 accepted, cyclic-only control replaced (E8-Q3 extension); next E8-U2 |
| X1   | P3 exit evidence A01-A08 index                                    | — (Primary acceptance)                     | Open                                                                                                                                                                                                                                                                                                                                                                                                          |
