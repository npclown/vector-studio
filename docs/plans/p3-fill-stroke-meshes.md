# P3 fill and stroke meshes execution plan

Current status: P3.1k integrated through [PR #95](https://github.com/npclown/vector-studio/pull/95). P3.1l is integrated through PRs #96-#98. P3.1m and its [U1-U4](p3-private-contract.md#user-decisions-on-mesh-position-representation-2026-10-06), U2 and R3 follow-ups are integrated through PRs #99-#105. P3.1n R0/R0a is integrated through PRs #106-#108: the C2 clearance admits 143 of 158 fixture rows. P3.1o O00 raster coverage readiness is integrated through [PR #109](https://github.com/npclown/vector-studio/pull/109). The O01 observational coverage contract is integrated through [PR #110](https://github.com/npclown/vector-studio/pull/110). Its headed observations are recorded below; the evidence was accepted. The user decided [Q4 and Q5](p3-private-contract.md#user-decisions-on-mesh-position-representation-2026-10-06) on 2026-10-07: A5 with inherited P1 thresholds. The [O02 A5 coverage rule contract](p3-o02-a5-coverage-contract.md) is integrated through [PR #113](https://github.com/npclown/vector-studio/pull/113). Its headed evidence gives a **PASS** verdict for the test-only A5 realization. Earlier sections retain their contemporaneous gate context and evidence. Complete P3 acceptance remains open; stroke refinement stays user-deferred.

## P3.1p T01 offline extent experiment contract

The user chose to start T01 on 2026-10-07.

The [T01 contract](p3-t01-extent-experiment-contract.md) is FROZEN after independent review rounds:

- technical review (Astra high): NOT READY twice, then READY;
- implementability review (Sol medium): NOT IMPLEMENTABLE twice, then IMPLEMENTABLE.

**Scope.** It compares K1 (fixed-grid tiling with exact Steiner references), K2c (feature-decoupled boundary with coarse tiling) and K5-ASSUMED (an unranked, non-certifiable f32-pair reference). The baseline is the untiled carrier, K4.

**Method.** Offline and exact, under the production M01 error model with O-PX(128). The corpora are C, L and O, plus a synthetic class A family S.

**Measured.**

- admission;
- M_max, the largest far magnitude admitted;
- inversions;
- seam split;
- Steiner deviation;
- trajectory cost.

**Not decided.** No candidate is selected. D1 stays a user decision after the evidence.

**Implementation** (branch `codex/p3-1p-t01-impl`):

- **Primary.** `core.ts`, which reproduces the pinned M01/M04/R0a code over rational points; the identity test passes on C, L and O, and the pinned SHA-256s are asserted. Also `synthetic.ts` (S, 360 rows, none skipped), `k5.ts`, `report.ts` with the K2c option, and the report and replay harness.
- **Sol medium.** `clip.ts`, `tile.ts` and `tile-certificate.ts`, with host tests.

Next: the stable-source review, then the report.

## P3.1p R2 bounded-extent and guard readiness

The [R2 readiness note](p3-r2-tiling-readiness.md) passed independent Astra high review in two rounds plus confirmation fixes. It is documentation only. It prepares the Q10 clipping and guard contract by recording what O02's evidence does not cover: O02's vertices are host NDC, with no M01 Shader term, which is the class A cause.

It also contains:

- candidates K1-K7, including the decided R2 tiling (K1) and a feature-decoupled boundary (K2);
- decisions D1-D7 with their owners;
- a proposed offline exact experiment, T01, and the items its contract must fix.

Nothing is adopted. The user has not yet selected this unit, and D1 (the mechanism) is a user decision after T01.

## P3.1o O02 A5 coverage rule contract

The [O02 contract](p3-o02-a5-coverage-contract.md) is FROZEN after independent review rounds. The technical review went NOT READY ×2, then READY. The implementability review went NOT IMPLEMENTABLE ×2, then IMPLEMENTABLE.

It fixes the test-only A5 realization accepted by the user on 2026-10-07:

- screen-space segment/vertex distance at the pixel center, with multi-sector pinch vertices;
- an analytic ramp width;
- a complement-triangulation fringe with an exact partition check.

It gates G1/G2 (Q4) and G3 (Q9) on headed Chrome/Edge at DPR 1, 1.5 and 2, at 1x and 4x. DPR 3 is observed only.

The census before freeze, per DPR: 143 renderable and 6 empty crops. 96 rows have degree-4 pinch vertices, and the maximum frame NDC magnitude is 31.2.

Production adoption, R2 and C04 are not implied.

**Implementation** (branch `codex/p3-1o-o02-impl`):

- Primary wrote the page, the shaders (main, count, readout), the builder, the spec, the evidence helpers and the configs.
- An independent Sol medium worker wrote the variants, the exact complement triangulator with sectors and the partition check, the exact rule oracle, the capture schema, the metrics and the replay, together with host tests.
- Sol made three triangulator choices that the contract does not spell out. Astra high ruled all three within the contract, because they only tighten checks that end in the exact partition check:
  - a hole is bridged by the minimum-distance visible vertex pair, with distinct coordinates, plus an exact wedge check;
  - the half-edge walk is re-traced after each clip, and segments covered from both sides cancel;
  - an extra ear is rejected at pinch corners.
- Verdict precedence, fixed before any evidence exists: INCONCLUSIVE when any INCONCLUSIVE condition holds; otherwise FAIL on any G1-G3 violation; otherwise PASS. Both reason lists are always emitted.

**Stable-source review** (Astra high): CLEARED. Its own float32 shader emulation over all 572 renderable variants (84.8M centers) found a maximum |emulation − rule| of 8.5e-5, and no center covered twice.

**SHOULD-FIX applied:**

- non-rendered rows carry the crop origin;
- the verdict precedence above;
- fragment feature-evaluation proxy, `clipOutside` and feature statistics;
- a committed shader-emulation host test.

**Local checks:** a pre-review WGSL compile check and an `init()` check in the in-app browser, with no draws, both passed.

**Evidence:** [review record](../evidence/p3.1o-o02/review-2026-10-07.md); verdict **PASS**, EVIDENCE ACCEPTED.

- Headed Chrome and Edge (NVIDIA Turing) at DPR 1, 1.5 and 2, 1x and 4x: 143 rendered variants per DPR, with zero G1, G2 or G3 violations.
- The two browsers and the two runs are byte-identical (596 of 596 crops), and 1x equals 4x.
- `|obs − rule|` is at most 1 LSB.
- The O01 line-not-segment deficit is gone.
- Observations, not gates: an acute-tip boundary-shift outlier of +0.28 px over 0.93 px of boundary, and THIN over-coverage at DPR 1.5.

Next, all needing user direction: production adoption (C04 layout, Q11, R2 clipping), the partial-coverage tolerance, and R1/R4.

## P3.1o O01 coverage observations

Base: `cb73d02`, the PR #110 squash merge. Branch: `codex/p3-1o-o01-coverage-impl`. Runner source: `6d3b4a8`.

The [evidence review](../evidence/p3.1o-coverage/review-2026-10-07.md) archives the first headed Chrome/Edge records (NVIDIA Turing), with offline metrics and byte-identical replay. Independent Astra high review recomputed all 143 rows: EVIDENCE ACCEPTED.

**Results**, observation only:

| Candidate         | Mean boundary shift at 1x | Band error | Seams           |
| ----------------- | ------------------------- | ---------- | --------------- |
| A5 symmetric ramp | −0.002 px                 | 0.257      | None on F07/F11 |
| A1 outward fringe | +0.111 px                 | —          | —               |
| A2 inside ramp    | −0.139 px                 | —          | —               |

Shift covers 83 rows; the remaining 60 rows are `N/A:L=0`.

**Findings:**

- **A2/A5 interior deficit.** A 30/255 deficit on 2 pixels of the Z S8 rows. It comes from the line-not-segment distance rule.
- **A1 4x nondeterminism.** A 1-LSB difference between runs and between browsers, consistent with implementation-defined resolve rounding.

At the time of the observations nothing was adopted. On 2026-10-07 the user decided:

- **Q5:** A5.
- **Q4:** P1's 2/255 interior and exterior tolerance and 1 px edge location, with DPR 1, 1.5 and 2 as acceptance axes and DPR 3 observed only.

Next is the A5 coverage contract. It covers:

- the Q3 corner and segment rule, which must remove the observed 30/255 deficit;
- the thin-feature rule;
- Q6, Q7 and Q9 for seams, attribution and double coverage;
- the remaining Q items.

That contract needs independent review before any implementation.

## P3.1o O01 observational coverage contract

Base: `1a6aa2a`, the PR #109 squash merge. Branch: `codex/p3-1o-o01-coverage-contract`.

The [O01 contract](p3-o01-coverage-experiment-contract.md) freezes a test-only headed experiment. It compares A1 (discontinuous outward fringe), A2 (inside-only ramp) and A5 (symmetric straddling ramp) at 1x and 4x against an exact dyadic pixel-area oracle.

**Inputs.** The 143 C2-admitted fixture rows plus literal F07, F11, SQ and THIN rows.

**Precision path.** NDC is rounded once on the CPU. The reference region is the exact preimage. Distance is computed from the fragment position and per-edge coefficients relative to the crop origin.

**Metrics.** These are reported with no thresholds:

- interior and exterior error;
- band deviation, with and without corner pixels;
- boundary shift over the inset viewport;
- seams;
- the 1x/4x difference;
- overlap mass, from float `max` and `add` diagnostic passes.

**Runner and evidence.** These follow P3.1l:

- page API;
- 64-byte vertex record;
- timeouts and statuses;
- exclusive records;
- contract identity;
- an offline replayable metrics file;
- a 25 MB archive cap;
- a confirmation-run rule.

**Review.** Independent Astra high technical review and Sol medium implementability review each ran two rounds, plus confirmation fixes.

- **Round 1** found five problems: pixel-aligned literal rows; precision noise in the shader NDC and distance path; an unstated Q3 rule; an ambiguous A1; and the wrong corpus source. It also found infeasible oracle and archive sizes, and missing page, layout and identity details.
- **Round 2** found that the A5 fringe conditional broke continuity, that fringe vertex construction was unspecified, that overlap mass mixed quantizations, that classification cost was unbounded, and that pass identity was ambiguous.

Nothing is adopted. Q4 and Q5 remain user decisions after the evidence.

## P3.1o raster coverage readiness

Base: `4a2853e`, the PR #108 squash merge. Branch: `codex/p3-1o-raster-coverage-readiness`. On 2026-10-07 the user chose this documentation-only unit as the prerequisite for R2 and R4.

The [readiness note](p3-raster-coverage-readiness.md) does four things:

- inventories the inherited P1, architecture, private-contract, visible-semantics and U1 constraints;
- records that a naive mesh puts triangle edges on the contour, so MSAA mixes unequal coverage unless both sides of the seam evaluate the same function or the seam moves to where coverage is 0 or 1;
- compares five antialiasing mechanisms, with the A5 symmetric straddling ramp as the leading candidate (not adopted);
- lists the open decisions Q1-Q14, with owners, together with an observational first experiment, O01, comparing A1, A2 and A5.

No threshold, architecture or behavior is changed.

## P3.1m user decisions U1-U4

Base: `4c798b2d1c3878ae77a87fdbe26ad73e4e13e0e8`, the PR #101 squash merge. Its required check passed in run 37465973406, job 112276965614. Branch: `codex/p3-1m-user-decisions`.

The user selected the recommended option for each decision:

- **U1:** a visible-plus-guard position domain.
- **U2:** decide failure handling only after a separate proposal for alternative paths.
- **U3:** a mesh-specific physical-window origin.
- **U4:** reuse of the existing `render.submission-failed` outcome only as a last resort, with no new public variant.

The private contract records the decisions and their consequences. This is a documentation-only checkpoint: no layout, ABI, runtime check or requirement text is changed.

The reviewed [U2 failure-path proposal](p3-u2-failure-path-proposal.md) had three rounds of independent Astra high review. The fixes were:

- R1 was reclassified as a visible-semantics change.
- The δ0 floor was scoped to the M01 bound.
- The O-PX class D counts were corrected, with an erratum appended to the P3.1m review record.
- R0 was limited to generator-induced slivers.

On 2026-10-06 the user chose (a): R3, then R0, then R2, with R5 for residual inputs only. The next units are:

1. An R3 tighter mesh-origin window contract: certificate rerun with rebase counts. The [contract](p3-r3-origin-window-contract.md) is FROZEN after independent review. Round 1 found that S2 omitted window clearance and that the stress-row exemption was vacuous. A reviewer pre-freeze estimate is disclosed in the contract. Implementation and [evidence](../evidence/p3.1m-r3-origin-window/review-2026-10-06.md): the exact selection is **T = 128**, with minimum window slack +9.21e-6. Independent review: STABLE-SOURCE CLEARED and EVIDENCE ACCEPTED. TR-N03 uses the x-only N03 sequences with y = 0.
2. R0. The P3.1n N00 [readiness note](p3-r0-triangulation-readiness.md) has base `b7ed0b8`, the PR #105 squash merge. Independent Astra high review found that same-vertex retriangulation cannot admit any class B fixture row. The binding `fan` pairs are boundary bends introduced by the rounded embedding. On 2026-10-07 the user chose R0a, a certificate fan-term refinement with a new sufficiency proof and no visible change, as the next unit. The [R0a contract](p3-r0a-wedge-clearance-contract.md) is FROZEN. It replaces `fan` with an exterior-`wedge` term (C2). Proof obligations W1-W5 include exact monotonicity: C2 admits every row that P3.1m admits. The implementation and [evidence](../evidence/p3.1n-r0a-wedge/review-2026-10-07.md) show C2 admits 143 of 158 fixture rows, up from 127: 12 Y and 4 Z S5 rows are newly admitted. The same 143 are admitted under O-PX(128) pointwise and window. The remaining rows are the 12 Z J-induced `edge` rows, 2 stress rows and the thin control. Independent review: STABLE-SOURCE CLEARED and EVIDENCE ACCEPTED.
3. An R2 tiling contract with the visible-plus-guard successor certificate.

Both stay test-only until C04 layout and raster contracts exist.

## P3.1m N01-N03 position certificate implementation and evidence

Base: `d9fe6f95371a2fbefd95d159667edfb44d484d60`, the PR #100 squash merge. Its required check passed in run 37461866777, job 112263159166. Branch: `codex/p3-1m-position-certificate-impl`.

| Unit | Owner      | Files                                                                                          |
| ---- | ---------- | ---------------------------------------------------------------------------------------------- |
| N01  | Primary    | `tests/geometry/position-certificate/certificate.ts`                                           |
| N02  | Sol medium | `adversarial.ts`                                                                               |
| N03  | Sol medium | `corpus.ts`, `tests/geometry/position-certificate.test.ts` and the deterministic `report.json` |

There was no recursive delegation.

The contract gained two amendments during implementation, both independently reviewed:

- **A1:** the input-magnitude row literal now isolates guard check 4.
- **A2:** documents the shared `Plo` minimum, the overlapping-fan outcome and the window lane bound.

Neither changes a formula, threshold or expectation.

The [evidence review](../evidence/p3.1m-position-certificate-review-2026-10-06.md) records:

- **Dominance:** exact dominance over the K graph, archived L Chrome/Edge and 6,393,600 N02 adversarial evaluations on all 158 fixture rows.
- **Prospective expectations:** every one was met exactly. Notably, P1's origin rule rejects an on-screen zoom-64 mesh while the physical-window origin admits it.
- **Admission:** 127 of 158 fixture rows are admitted. Rejected rows are large-extent stress rows, the thin control, and 28 genuine sub-δ carrier clearance failures.
- **Γ9:** sensitivity flips only EXT-32768.

**Checks:**

- Independent Astra high review: STABLE-SOURCE CLEARED, and EVIDENCE ACCEPTED, with 0 mismatches against its own BigInt recomputation.
- `pnpm check`: PASS, 550 tests.
- `pnpm build`: PASS.
- `pnpm test:geometry`: PASS, 520 passed and 1 env-gated skip. WASM identity is unchanged.
- The targeted test reproduces `report.json` byte for byte.
- No GPU run was needed.

Adoption of the carrier, origin rule, domain or failure behavior awaits user decisions U1-U4.

## P3.1m M01-M06 position certificate contract

Base: `0491340a6859cb9efa86d23be612635780a328ca`, the PR #99 squash merge. Its required check passed in run 37459250400, job 112254419942. Branch: `codex/p3-1m-position-certificate-contract`.

The [contract](p3-position-certificate-contract.md) freezes a test-only sufficient position certificate for K's carrier under the pinned WGSL §15.7 rules:

- a syntactic evaluation family F, with residual risk R1 stated;
- `E = Pack + Γ8·(absolute monomial sum) + 2^-40`, with proof obligations P1-P5;
- an exact window-uniform bound comparing P1's origin rule with a physical-window origin;
- rational clearance transport of K's four eligibility terms;
- a pinned K/L data corpus plus prospective and term-targeting rows;
- a deterministic N02 adversarial evaluator (5400 evaluations per vertex-axis);
- a byte-identical `report.json`;
- open user decisions U1-U4.

Nothing is adopted.

**Review.** Two independent read-only reviewers reviewed it: Astra high on the proofs and Sol medium on implementability and governance.

- **Round 1.** Both found it not freeze-ready.
  - Value-defined F did not imply the five-monomial form.
  - A form with 9 operations would have flipped EXT-32768. This was fixed with the exactness argument for doubling, and Γ9 sensitivity is recorded.
  - Three window samples could not bound the whole window.
  - Exports, imports, evidence and the N02 budget were missing.
- **Round 2.** All round-1 findings were resolved. New findings:
  - window values omitted the F-lane rounding term;
  - the Pack64 underflow term was too small;
  - P4 omitted the subnormal case;
  - some rows were not literal;
  - the tables rendered broken;
  - N02 asserted wall time.
- **Round 3.** All round-2 findings were fixed. Confirmation added the 2^60 original-input guard and its boundary control. Both reviewers found the contract FREEZE-READY.

**Checks.** Changed-Markdown Prettier, link, whitespace and scope checks PASS. Product, unit, build, GPU and benchmark commands were NOT RUN for this documentation-only checkpoint. Required protected CI still applies.

## P3.1m C04 position representation readiness

Base: `80d8a20a398298ba4da5d56e969558c77d3921ee`, the PR #98 squash merge. Its required check passed in run 37432763718, job 112167254880. Branch: `codex/p3-1m-c04-position-readiness`. On 2026-10-06 the user selected this documentation-only readiness step as the next unit.

The [readiness note](p3-c04-position-readiness.md) does three things:

- It maps the K/L evidence onto C04 item 2.
- It records that native position error grows with physical extent, consistent with binary32 spacing: about 0.040 pixel on a stress row whose far vertex lies near 741,000 physical pixels, against at most about 0.000106 pixel across the 146 rows within 4096 pixels.
- It defines M01-M06: an a priori certificate under permitted WGSL evaluation, P1 origin integration, the obligation domain and failure behavior, topology clearance, a prospective corpus, and validation.

Nothing is adopted. No runtime, ABI, API, dependency, threshold or rejection policy changes. Adoption remains a user decision after a frozen and verified certificate. **M00 local PASS, 2026-10-06.** Primary wrote the note after inspecting:

- the C04 obligations and numeric allocation in the private contract;
- the P1 precision and rebase contract;
- K's graph and evidence;
- L's frozen contract and archived records.

Independent read-only Astra high review recomputed every number from the archives. Round 1 was NOT READY, with five should-fix items:

- the two worst rows touch the viewport rather than lying offscreen;
- the causal wording overclaimed, and the binary32 impossibility argument was missing (spacing 0.25 pixel in [2^21, 2^22));
- the C04 item 5 attribution was wrong;
- the P1 recheck triggers and the existing `render.submission-failed` path were missing from M02/M03;
- the clearance terms did not match the eligibility JSON fields.

All of them and three nits were applied. Round 2 found M00 READY.

Checks: changed-Markdown Prettier PASS. `git diff --check` PASS. Local links/anchors: 874 links across 178 files resolve, apart from the one pre-existing historical anchor in `docs/evidence/p1.0m-method-assessment-2026-09-12.md`. Scope: three plan files.

Product, unit, build, native, browser, GPU and benchmark commands were NOT RUN for this documentation-only checkpoint. Required protected CI still applies. M01-M06 contract work follows only after integration.

## P3.1l L07-L09 native projection runner and observations

Base: `a40459376e1536c741a52d34de6aedafccb146dc`, the PR #97 squash merge. Its required check passed in run 37427848135, job 112151485721. Branch: `codex/p3-1l-l07-native-projection-runner`. The implementation follows the [frozen contract](p3-native-projection-readiness.md#l01-l06-written-contract) without changing any literal. There was no recursive delegation.

| Unit | Owner      | Delivered                                                                                                                                                      |
| ---- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L07  | Primary    | Config, `pnpm test:gpu:p3-projection`, Vite entry, ignores, the validation.md row, packer, evidence writer, spec, shader-identity test and offline replay test |
| L08  | Sol high   | The isolated page and shader module                                                                                                                            |
| L09  | Sol medium | Byte auditor, decoder, classifier and all L01-L03 host controls                                                                                                |

Primary ruled on two points the contract text left open:

- `dispose()` stays idempotent and resolves. Later `init`/`capture` calls reject with `disposed`.
- `init` reports `DEVICE_LOST:<reason>` for a loss during setup, as L04's `device.lost` rule requires.

Two known nits remain:

- An early prelude failure records empty `rows` instead of `NOT_RUN` skeletons. The case is still `RUNNER_ERROR`.
- A CRLF checkout fails safe as `contract-identity`.

The stable-source review was by Astra high. Round 1 was NOT CLEARED, because:

- unbounded `goto`/userAgent and unwrapped prelude calls could lose a record;
- contract identity was recorded but not enforced;
- shader-text identity had no test;
- device loss during init was misreported.

All findings were fixed. Round 2 cleared GPU dispatch.

**Local validation on the committed runner `a322a65`:**

- `pnpm check` PASS: 550 tests.
- `pnpm build` PASS.
- `pnpm test:geometry` PASS: 504 tests, including the 13 L01-L03 controls and the shader-identity test. The independent release WASM SHA-256 is `3f20b4e93597bff852c0cd4e978495b73bed2568a25e39c9d87daffa7148b17a`.

**Native runs on an NVIDIA Turing hardware adapter, headed Chrome 154.0.8037.98 and Edge 154.0.4258.53:**

- `pnpm test:gpu:p3-projection` passed 4/4, then 4/4 again in the same-machine confirmation run.
- Runner acceptance PASS for both browsers.
- Both runs and both browsers produced identical readbacks for all 158 rows.
- Native classification: 157 CERTIFIED and 1 TOPOLOGY_REJECTED (`thin/collapse`). The worst squared displacement is ≈0.0016036, against the unchanged 1/256 bound.
- 83 clip words and 24 exact `maxSquared` values differ from K's declared graph, with no status change. This is an observation only.
- Offline replay reproduced all four classification records byte for byte.
- The unchanged `pnpm test:gpu` P1 regression passed, 38 tests.

The [evidence review](../evidence/p3.1l-native-projection-review-2026-10-06.md) archives the first complete records and hashes. These per-row results hold only for this browser and adapter. Other adapters and backends remain UNVERIFIED. Production mesh layout, raster coverage, fringe and MSAA, C03-C05, capacity, and deferred stroke work all remain open. The independent Astra high evidence review was EVIDENCE ACCEPTED. It recomputed all 158 rows with its own decoder and classifier, and its should-fix and nits were applied.

## P3.1l L01-L06 native projection contract

Base clean updated `ec6755e394b29c8a8a4db2e6c68238f7fcd82e9e`, the PR #96 squash merge on `main` (2026-10-05 07:58:17 KST). Branch `codex/p3-1l-l01-l06-native-projection-contract`.

PR #96 integration evidence:

- Required check on head `405a348a9a790e580140896dc4cb1daed94ce38e`: run 37241667145, job 111551443454, `success`.
- Post-merge `main` check: job 111552460682, `success`.

The L00 paragraph below records its contemporaneous pre-merge state; its "pending" CI/integration wording is superseded by this record, not edited.

The [readiness note](p3-native-projection-readiness.md#l01-l06-written-contract) now gives concrete answers for every freeze-checklist row:

- the 158-row identity and the packed binary32 byte layout, with independent provenance checks;
- the literal WGSL and the row-to-texel capture mapping;
- the capture-failure taxonomy;
- exact host-side classification;
- device preflight and lifecycle;
- exclusive evidence schemas;
- the separately named runner command, with its hardware disposition.

All native rows remain OBSERVE, and the 1/16 physical-pixel bound and topology rule are unchanged. This checkpoint is documentation-only: no runner, page, configuration, script or GPU execution is added. L01-L06 FROZEN, local PASS, 2026-10-06. Primary wrote the contract after inspecting the K model/audit/fixtures, the archived K observations, the P1 probe, the GPU/Vite/vitest configurations, the evidence helper and the boundary tooling. There was no recursive delegation. Two independent read-only reviewers then reviewed it:

- **Arithmetic/provenance and WebGPU correctness.** Round 1 found one blocker: the short-draw control could never decode as `missing`, because the decoder used `drawCount`. It also found eight should-fix items:
  - division in the point position could be inexact, so the shader uses `* 0.125`;
  - clip texels carried no identity;
  - texel precedence was not literal;
  - fallback detection was missing;
  - vertex-stage storage limits and an explicit layout were missing;
  - the rounder import conflicted with independence;
  - the sign of zero lanes was not pinned;
  - the contract identity was undefined.
- **Implementability, ownership and governance.** Round 1 found four blockers:
  - `pnpm check` was wrongly said to run the host controls;
  - the interfaces between work units were not fixed;
  - the import rules contradicted each other;
  - the record could be lost on a hang.

  It also found seven should-fix items: control COMPLETE semantics, root/worker restart, backend and archive metadata, software adapters, ambiguous vertex order, the validation.md row and a port collision (4176 changed to 4177).

Round 2 confirmed that every round-1 finding was resolved. It found three new blockers:

- control COMPLETE contradicted the `capture-invalid` PARTIAL rule;
- the orientation reason did not reproduce K's `topology:orientation:0`;
- a type-only import was missing from the allowlist.

It also found should-fix items: a squash-stable contract identity and packer/auditor author independence (the packer moved to Primary L07). Primary applied all of them. Both reviewers stated that the contract is freeze-ready after these one-line fixes.

Validation:

- Changed-Markdown Prettier, local link/anchor, whitespace and two-file scope checks PASS, as recorded in the PR.
- Product/unit/build/native/browser/GPU/benchmark commands NOT RUN for this documentation-only checkpoint.

Next: L07-L09 implementation from integrated `main`, then stable-source review before any GPU dispatch.

## P3.1l native vertex projection readiness

Base clean updated `f7c5e6344c916f5db4b10d13209231035d189d11`, after K PR #95 and required CI run37241162224/job111550000719 PASS on `8e86d92e9195fd922c49c0808dd92842e416d1b1`, completed2026-10-05 07:48:49KST. Branch `codex/p3-1l-native-projection-readiness`. The [readiness note](p3-native-projection-readiness.md) selects the next instrumented vertex/readback question and records exact prerequisites before runner implementation. This documentation-only checkpoint retains all158 K mesh inputs as prospective native observations; K's numeric dispositions do not transfer automatically. No GPU dispatch, new native threshold or runtime/API/ABI selection occurs.

L00 local PASS: Primary inspected the P1 probe/configuration/evidence seams and pinned WGSL numeric rules; Sol medium independently inventoried reusable infrastructure and Astra high reviewed the complete written readiness note. No recursive delegation. Review explicitly rejected inheriting K's thin-control outcome as a native requirement and retained raw clip-bit/provenance obligations instead of P1's already converted coordinates. Explicit changed-Markdown Prettier,861 local links/anchors across176 Markdown files, whitespace and two-file scope review PASS. Local product/unit/build/native/browser/GPU/benchmark commands NOT RUN for this documentation-only checkpoint. Required remote CI/protected integration remain pending; L01-L06 contract work follows, then separately gated implementation and observations. User's3% remaining finish-and-stop rule remains active.

## P3.1k mesh-local projection precision experiment

Base clean updated d031e3d318ce0cbad4755c2710c19949204784b7 after J PR #94 and required CI run37237985320/job111540839662 PASS on693b23158dd29852553d9c32bf989419d3f8490b, completed2026-10-05 06:59:05KST. Branch codex/p3-1k-mesh-projection-precision. The [prospective experiment](p3-mesh-projection-experiment.md) addresses complete ordered storage/shader/NDC error using fixed mesh-local offsets and the existing origin/frame split. The [review record](../evidence/p3.1k-mesh-projection-review-2026-10-05.md) tracks independent proof/corpus/source/evidence review. Full contract freeze precedes implementation; stable-source review precedes numeric execution. This is one test-only feasibility model, not a new ABI, runtime packing implementation or GPU claim. Keep stress failures as explicit observations and retain all P3 gates.

K01 PASS: Primary/Astra high and both implementation preflights approve the complete159-row contract. Exact integrated-J source inventories prove the required carriers' prospective topology margins and complete vertex use, independently of K projection. Exclusive records preserve every stress or unexpected required failure before assertions. K02/K03 implementation proceeds in disjoint files; stable-source review remains the numerical-dispatch gate.

K02-K04 local PASS after Primary/Astra stable-source clearance:4 targeted tests,204 native tests,490 geometry tests and550 root units, static/boundary checks and build. All40 required and117 observational rows certify; the thin control independently rejects topology despite passing position, and the legacy counter is retained. Maximum observed error is about0.047846 physical pixels versus1/16; this is a finite ordered-JavaScript corpus result, not a universal or GPU bound. Primary independently recomputed158 raw exact-error rows and verified full-suite repeat equality. No runtime/ABI/dependency or numerical expectation change occurred; independent release WASM identity is unchanged. Final Primary/Astra evidence review, explicit Markdown/857-link and scope checks PASS; protected integration remains required. Actual GPU arithmetic/coverage and production mesh transport remain separate prerequisites.

## P3.1j conforming mesh refinement oracle

Base clean updated `633f8af7f45ec02d765062572000e509d78af36e`, after Z PR #93 and required CI run37235794184/job111534504909 PASS on `80fcc0dad981c84ae4dc0310035708bffb87a33b`, completed2026-10-05 06:26:05KST. Branch `codex/p3-1j-conforming-mesh-oracle`. The [prospective contract](p3-conforming-mesh-oracle-contract.md) addresses the actual hanging-node contact in the existing slab mesh without coordinate movement or runtime changes. Independent source review found that positive triangle signs and vertex error alone cannot establish projection conformity. A separate affine precision counterexample also prevents relabeling P1's looser proof as P3's1/16 share. Conformity refinement is the next prerequisite; mesh-local origin/split representation, GPU proof, capacities and public transport remain separate. Do not freeze ordinary projection success from existing carrier equality.

P3.1j J01 freeze PASS: Primary/Astra high, Sol high preflight and Sol medium retained-source inventory agree before implementation. All12 W/Y/Z carriers meet input preconditions; source-derived output counts and exact work controls are pinned. The [review record](../evidence/p3.1j-conforming-mesh-oracle-review-2026-10-05.md) preserves the analytic findings and evidence limits. Independent candidate/verifier source review precedes numerical dispatch.

J02-J04 local PASS after Primary/Astra stable-source clearance:16 targeted tests,204 native tests,486 geometry tests and550 root units, all static/boundary checks and build. Seven analytic and12 independent W/Y/Z carriers preserve exact coordinates/region and pass independent conformity verification; all frozen corruption, ownership and inclusive cap controls pass. No runtime changes or numerical expectation adjustments occurred. Independent release WASM identity remains unchanged. Final evidence review and protected CI/integration remain required. Next proposed private prerequisite is a mesh-local-origin precision experiment covering the full storage/shader/projection share; it does not choose an ABI or establish GPU coverage.

## P3.2z depth-positive triangle-free composition

Base clean updated `80141101ea1904fe1ceb7ee8aa7aa2a4578d96b5`, after Y PR #92 and required CI run37233920239/job111529166018 PASS on `a4a899996e93708044bdc80d163b06cdb571d433`, completed2026-10-05 05:58:54KST. Branch `codex/p3-2z-depth-positive-composition`. The [prospective contract](p3-depth-positive-composition-contract.md) verifies a genuinely split cubic whose right child crosses two LINE boundaries. Existing runtime, capacities and private/public boundaries stay unchanged. Full contract review precedes implementation; stable-source review precedes numerical dispatch. Four source/rule rows cover literal child partitions, both crossing owners, zero-LINE packing, true closures and independently derived exact polygon/embedded areas. Full P3, larger capacities and public mesh/coverage remain separate.

P3.2z Z01 PASS: full Primary/Astra high, Sol high native and Sol medium transport review agreed before implementation. The [review record](../evidence/p3.2z-depth-positive-composition-review-2026-10-05.md) preserves source-level input/proof review and corrected shared-seam ownership. Z02/Z03 are independent native/TypeScript test work; stable-source review is required before numeric execution.

Z02-Z04 local PASS after Primary/Astra stable-source clearance:204 native/470 geometry/550 root unit tests, static/boundary checks and build pass. Four depth-positive source/rule rows retain exact partitions, owners, polygons and independent area checks with0 allocations and unchanged memory/WASM. Extracted W/Y output frames match their prior captures byte-for-byte. Final evidence review and protected CI remain required. Next prospective private prerequisite is mesh packing/projection precision, not another topology mode or public transport.

## P3.2y canonical triangle-free cubic composition

Base clean updated `5919fab2902b11dfe4a656133f5704a59b1d2755`, after P3.2x PR #91 and required CI run37231452149/job111521786017 PASS on `e8de8158afed5d2c3ace697b9c66c2fe4b290564`, completed2026-10-05 05:19:34KST. Branch `codex/p3-2y-triangle-free-cubic-composition`. The prospective [contract](p3-triangle-free-cubic-composition-contract.md) reuses the X helper through the canonical bridge, preserving old modes, caches, resources and public boundaries. The [review record](../evidence/p3.2y-triangle-free-cubic-composition-review-2026-10-05.md) tracks decisions and evidence. Full written review/freeze precedes implementation; stable-source review precedes numerical dispatch. Four source/rule rows cover two crossings, both contours, zero-LINE packing and true closure ownership. Public mesh/coverage, depth-positive crossing composition, capacity changes and deferred stroke remain separate.

P3.2y Y01 freeze PASS: full Primary/Astra and native/transport review fixed exact source/count/owner mapping, P2 guarded bounds, old-mode rejection counters and unchanged private ownership. Primary-owned TS encoder/parser/proof extractions passed independent review before parallel Rust and new TS implementation. Full stable-source clearance preceded the first numerical run.

Initial Y result:200 native PASS/1 area assertion FAIL/15 ignored,550 root units/static/boundaries and build PASS. Geometry stopped before TS carriers and release WASM validation. The [review record](../evidence/p3.2y-triangle-free-cubic-composition-review-2026-10-05.md#approved-exact-area-correction) preserves the failure and independent derivation. User authorized exact source30 versus exact emitted963/32-2^-49 checks, with unchanged runtime/input/tolerance/caps. At that point, Primary/Astra corrected written contract freeze preceded test-only edits; independent delta review and full geometry rerun were still required, with no commit/PR or complete Y acceptance claimed.

Corrected Y01-Y04 local PASS: Primary/independent corrected-source review preceded the full rerun;201 native/459 geometry/550 root unit tests, static checks/boundaries and build pass. All four rows preserve original/packed ownership,7/21 topology, exact source30 and independently derived dyadic mesh area,0 allocations and unchanged retained memory/WASM. Current W output frame is byte-identical to the prior frame. Final Primary/Astra evidence review, explicit Markdown/823-link checks and scope review PASS. Protected CI remains required; full P3, larger capacities and depth-positive crossing composition remain separate.

## P3.2x native triangle-free arrangement helper

Base clean updated `a8602b4a0c43ce154f15c372139e68ea4bb5dc94`, after P3.1i PR #90 and required CI run37229266685/job111515290168 PASS on `fa3bb52e17c7e01aaa0003eb71d11f5f545d3108`. Branch `codex/p3-2x-native-triangle-free-arrangement`. The frozen [contract](p3-native-triangle-free-arrangement-contract.md) reuses the integrated I theorem and existing mixed native workspace, retaining32 crossing records, original modes, resources and input/output schemas. The [review record](../evidence/p3.2x-native-triangle-free-arrangement-review-2026-10-05.md) tracks proof/source/evidence. X01 full contract freeze preceded implementation; stable-source review preceded numerical dispatch. Canonical adoption, public mesh/coverage, capacity changes and deferred stroke remain separate.

X01 contract freeze PASS: Primary, Astra high and Sol medium reviewed proof, unchanged resource ownership,42-row corpus, parser policy and error precedence. Before implementation, the fixed119-pair lifecycle, inherited stationary-cubic regression, new WorkLimit type, exact shared encoder and stage-specific corruption checks were clarified. X02-X03 implementation followed stabilized Primary-owned shared seams; Primary/Astra stable-source/hash/scratch clearance preceded X04 numerical dispatch.

X02-X04 local PASS:198 native tests/14 ignored emitters and448 geometry tests/16 files pass, including all42 new carrier rows with39 Certified/2 Unresolved/1 WorkLimit. Every row has0 attempt allocations and unchanged224256 heap/2512 inline bytes. Full bounded root check passes550 units/53 files plus static/boundary checks; build passes43 modules. Independent release WASM identity is unchanged. Old modes and all prior corpora remain passing. Final Primary/Astra evidence review, explicit Markdown/812-link checks and11-file diff review PASS. Protected CI remains required; canonical composition adoption is the next separately contracted dependency.

## P3.1i triangle-free transverse arrangement oracle

Base: clean updated `e56a90f03baffdd9da4f4f9452f7aaea7132ec8f`, after P3.2w PR #89 and required CI run37227221817/job111509276309 PASS on `a95f81a965f5001f58d7ecde1bd76a6aba894a16`. Branch `codex/p3-1i-triangle-free-arrangement`. The prospective [contract](p3-triangle-free-arrangement-contract.md) extends a test-only sufficient topology condition to multiple partners using a triangle-free crossing graph, with unchanged32-record publication ceiling and original entry-point semantics. The [review record](../evidence/p3.1i-triangle-free-arrangement-review-2026-10-05.md) tracks proof, literal fixtures and evidence. Full written review/freeze precedes implementation; stable source review precedes numerical dispatch. Native adoption, public mesh/coverage, capacity changes and deferred stroke remain separate.

I01 PASS: Primary, Astra high and Sol medium independently reviewed the complete theorem, literal corpus, counters, limits and failure precedence before execution. The exact fixture interface and independent rational event-order checks were frozen before isolated implementation; I03 numerical execution remained gated on stable-source review until the clearance recorded below.

I02-I03 local PASS: Primary/Astra stable-source review preceded numerical dispatch. Eight positives including32 crossings certify; two triangles and33rd-record attempt reject atomically at frozen counts.31 inherited positive results and old matching restrictions remain exact. Focused five-file tests pass169; bounded root check passes550 units/53 files plus formatting/lint/types/boundaries; build passes43 modules. No frozen expectation changed. Final Primary/Astra evidence review, explicit Markdown/805-link checks and diff review PASS. Protected CI remains required; native helper adoption is the next dependency, with unchanged public/runtime scope.

## P3.2w canonical mixed LINE/cubic composition

Base: clean updated `ac69ebdbd26a4630544a2b48f310ab7bab50f00f`, after P3.2v PR #88 and required CI run37224435550/job111501049910 PASS on `e22e24fa2ca6af6ef7ac08ef8e260f667861d1e1`. Branch `codex/p3-2w-mixed-cubic-composition`. The prospective [contract](p3-mixed-cubic-composition-contract.md) fixes a separate private mode using original LINE kinds, zero-LINE packed alignment, unchanged caches/diagnostics and four independently verified source/rule rows. The [review record](../evidence/p3.2w-mixed-cubic-composition-review-2026-10-05.md) tracks decisions/evidence. Full written contract review precedes implementation; stable source review precedes numeric dispatch. Old modes, public API/ABI, dependencies, caps/tolerances and user-deferred stroke remain unchanged.

W01 PASS: account availability recovered and both full-written-contract reviews completed on2026-10-05. Primary, Astra high and Sol medium verified source/packed identity, literals/counts/owners, old-mode isolation and shared seams. Zero-LINE corruption wording and marked-shape input controls were clarified before freeze. At freeze W02-W04 remained in progress and stable-source independent review was required before numerical execution; subsequent results follow.

Initial W numerical run:192 native tests PASS,393 geometry tests PASS/4 new positives FAIL at exact flat-bounds equality;527 root unit tests/static/boundaries and build PASS. Primary and independent review traced the four failures to W's mistaken unexpanded bounds expectation, not new runtime behavior. The [review record](../evidence/p3.2w-mixed-cubic-composition-review-2026-10-05.md#initial-numerical-result-and-proposed-bounds-correction) preserves failure evidence and proposes strict P2-derived guarded bounds. At that point the frozen acceptance correction required user confirmation, no commit/PR had been created and complete W acceptance was not claimed.

Corrected W01-W04 local PASS: the user approved the exact P2 guard expectation on2026-10-05 before its implementation and independent delta review. Full rerun passes192 native/398 geometry tests; bounded root check passes527 unit tests and static/boundary checks. Build passes with unchanged build inputs. All four rows complete independent command/26 cubic boundary/topology/region/mesh/owner proofs, original8 vs packed7 zero-LINE mapping, and bounds corruption controls;0 allocations and unchanged1,111,552 heap/12,952 inline bytes. Native input/output hashes and independent WASM identity are unchanged. Final Primary/independent evidence review PASS; protected CI remains required. General multiple-partner ordering, depth-positive crossing coverage, public mesh/coverage integration, full capacities and deferred stroke remain separate.

## P3.2v native mixed LINE-kind arrangement helper

Base: clean updated `537f50743ed99e6ed78a1b1be657e0504241e17e`, after P3.1h PR #87 and required CI run37222624299/job111495870337 PASS on `e658e5d91e918d6d6eb0f802e08918ab334d3e0c`. Branch `codex/p3-2v-native-mixed-line-arrangement`. The frozen [contract](p3-native-mixed-line-arrangement-contract.md) fixes a separate private helper, explicit source/leaf flags, unchanged retained layout,53-row independent corpus and required-kinds test transport. The [review record](../evidence/p3.2v-native-mixed-line-arrangement-review-2026-10-05.md) tracks decisions/evidence. Full contract review precedes implementation and stable source review precedes numeric dispatch. Canonical workspace adoption remains separate; no public API/ABI/dependency/cap/tolerance or deferred stroke change.

V01-V04 local implementation/numerical PASS:188 native tests and385 geometry tests across14 files pass. All53 fixed rows match31 Certified/2 KnotMismatch/20 Unresolved with complete kind identity, literal polygon/crossing and independent oracle checks. Every call retains0 allocations and unchanged224256 heap/2512 inline bytes; independent WASM identity is unchanged. Root check passes527 tests/52 files plus all static/boundary checks; build passes43 modules. Final Primary source review preceded numeric dispatch; lifecycle/corruption isolation corrections were made before execution with unchanged expectations. Final Primary/independent evidence review PASS; docs/785 links across161 Markdown files/diff checks PASS. Protected CI/integration remain required. Canonical mixed-source adoption is the next separately contracted dependency.

## P3.1h mixed LINE-kind arrangement oracle

Base: clean updated `876787d05ea69750e8a16bd4ab5d4328eea02d84`, after P3.2u PR #86 and required CI run37221004554/job111491158599 PASS on `58c0287636da6636ff0ac379355f29ec5afe43c2`. Branch `codex/p3-1h-mixed-line-arrangement-oracle`. The frozen [contract](p3-mixed-line-arrangement-oracle-contract.md) fixes a separate test-only true-LINE entry, seven analytic positives, packed identity/signed-zero rules and complete preflight precedence. The [review record](../evidence/p3.1h-mixed-line-arrangement-review-2026-10-05.md) tracks decisions/evidence. Full contract/source review precedes implementation/numeric dispatch. Old entry points and stationary-cubic rejection remain unchanged; native mixed-source adoption requires a later contract. No public API/ABI, dependency, cap/tolerance or deferred stroke change.

H01-H03 local PASS: final Primary/independent source review preceded the first numerical dispatch. Seven mixed LINE positives and seven stationary all-false counterparts,39 old-row full-result comparisons, error precedence and ownership/bit controls pass. Focused146 tests,184 native tests,323 geometry tests,527 root tests across52 files, all static/boundary checks and build pass. Independent WASM identity is unchanged. No runtime/API/dependency/cap change or performance claim. Final Primary/independent evidence review PASS; docs/778 links across159 Markdown files/diff checks PASS. Protected CI/integration remain required. Next dependency is a separately frozen native mixed-kind helper; canonical workspace adoption follows later.

## P3.2u nonlinear transverse composition

Base: clean updated `573ad653f87030f09aea8db3fc0d67ac650e5476`, after P3.2t PR #85 and required CI run37219343513/job111486321595 PASS on `8194d41f73964e979b6d881f797522b117a04688`. Branch `codex/p3-2u-nonlinear-transverse-composition`. The frozen [contract](p3-nonlinear-transverse-composition-contract.md) fixes eight nonlinear source/rule rows, including actual subdivision on a noncrossing source while preserving proper depth0 crossings. Full proof and shared test-plumbing review precede implementation; stable source review precedes numeric execution. The [review record](../evidence/p3.2u-nonlinear-transverse-composition-review-2026-10-05.md) tracks decisions/evidence. Runtime/default selection, public API/ABI, dependencies, tolerances/caps and user-deferred stroke remain unchanged.

U01-U03 local implementation/numerical PASS:184 native and323 TypeScript geometry tests pass, including all eight nonlinear rows and original6/94/4 corpora. Exact nonlinear controls,62 source-boundary proofs, S depth1 midpoint/provenance, complete arrangement/region/mesh checks and paired closure ownership pass. All attempts retain0 allocations and unchanged1,111,552 heap/12,952 inline bytes. Independent WASM identity is unchanged. Bounded root check passes507 tests/51 files and all static/boundary checks; build passes43 modules. Source review preceded all numeric dispatch; extraction/count/owner corrections were made beforehand without changing frozen expectations. Final Primary/independent evidence review PASS; protected CI/integration remain required. A separately contracted genuine LINE-kind oracle/private mode is the next prospective capability; old stationary-cubic rejection and all existing entry points must remain unchanged. General depth-positive crossings, source-boundary rounding, full capacities and public integration remain open.

## P3.2t explicit transverse cubic composition

Base: clean updated `964c7f54e5f84435eb98ba6b37831b9b8fb5855a`, after P3.2s PR #84 and required CI run37217593652/job111481178343 PASS on `27c673d4655cf56eedff054b0decc8852e94a0d3`. Branch `codex/p3-2t-transverse-cubic-composition`. The frozen [contract](p3-transverse-cubic-composition-contract.md) defines a separate private single-helper route through existing canonical flattening and rounded mesh composition, retaining legacy selection and fixed work limits. Six sources/rules, full positional/region/mesh checks, ownership and alternating-mode failure semantics were frozen before implementation. The [review record](../evidence/p3.2t-transverse-cubic-composition-review-2026-10-05.md) tracks decisions/evidence. New reserved storage is accounted under unchanged ceilings; no public API/ABI/dependency, cap/tolerance increase, default fallback change or deferred stroke work.

T01-T04 local implementation/numerical PASS:184 native tests and307 TypeScript geometry tests pass, including six new rows with complete independent positional/arrangement/rounded mesh verification and all old94/4 rows. Native paired closure, failure/cache/mode-switch and ownership/allocation controls pass. Retained1,111,552 bytes/inline12,952 bytes fit unchanged ceilings with0 attempt allocations. Independent WASM builds retain the previous identity. Bounded root check passes507 tests/51 files plus all static/boundary checks; build passes43 modules. Source review preceded the first numerical run; test-only coverage corrections were completed beforehand with no numerical expectation tuning. Final Primary/independent evidence review PASS; required protected CI/integration remain pending. Next prospective fill-only prerequisite is nonlinear source composition under a separately frozen contract; depth-positive/general crossings, source-boundary rounding, full capacities and public mesh integration remain open.

## P3.2s native transverse arrangement preservation

Base: clean updated `c12b4c5823bf970bed4c692535462d42aebc2ef5`, after P3.1g PR #83 and required CI run37215934915/job111476326740 PASS on `6a998ceba3c6df88832fae3000292db74b993d7d`. Branch `codex/p3-2s-native-transverse-arrangement`. The [contract](p3-native-transverse-arrangement-contract.md) freezes the private wrapper, existing rounded preparation/storage reuse, true-line crossing semantics, bounded matching and distinct output. S01 review/freeze precedes implementation; stable source/protocol review precedes numeric execution. The [review record](../evidence/p3.2s-native-transverse-arrangement-review-2026-10-05.md) tracks decisions and evidence. No workspace adoption, public API/ABI, dependency, cap/tolerance change, full-workload claim or deferred stroke work.

S01-S04 local implementation/numerical PASS: first complete geometry run passes181 native tests and294 TypeScript geometry tests; all39 rows match24 Certified/2 KnotMismatch/13 Unresolved with literal/independent checks and zero certify allocations. Retained224256 bytes and inline2512 bytes satisfy frozen limits. Two independent WASM builds retain the old identity. Bounded root check passes507 tests across51 files plus static/boundary checks; build passes43 modules. Primary/independent source review preceded all numeric dispatch; fixture coverage and scratch documentation corrections were completed before execution. Final Primary/independent evidence review PASS; protected CI/integration remain required. Later adoption must separately fix bounded selection/failure/resource semantics and position/mesh composition; no full-workload readiness or cap increase is inferred.

## P3.1g transverse arrangement preservation

Base: clean updated`7a5a10e907b69516a115b293a09e82ef5db2163d`, after P3.2r PR #82 and required CI run37214127768/job111471076873 PASS on`ef2475ef087b39cc2dd2ce19cc87f248725a0196`. Branch`codex/p3-1g-transverse-arrangement`. The [frozen contract](p3-transverse-arrangement-contract.md) extends the test-only rounded oracle with complete pair coverage, genuine constant-line closure and a single transverse partner per leaf. Its publication avoids invalid simple-contour orientation/nesting assumptions. G01 contract freeze after Primary/independent proof and literal review precedes implementation; stable-source review precedes numerical execution, and all G01-G04 evidence remains required. The [review record](../evidence/p3.1g-transverse-arrangement-review-2026-10-05.md) tracks decisions and evidence. Native adoption, general multiple-partner crossings, larger capacities, position/mesh/coverage composition and deferred stroke remain separate.

G01-G04 local acceptance PASS: stable-source Primary/independent Astra review preceded the first numeric run, with all23 positives and15 geometric rejection candidates frozen in advance. Focused new/old oracle suites pass126 tests; bounded two-worker root check passes507 tests across51 files and all static/boundary checks; build passes43 modules. Primary corrected true-closure fixture construction and malformed-provenance stage coverage before execution, without changing expected outcomes. No runtime/native/API/dependency/cap changes or performance claim. Protected CI/integration remain required. Next dependency is a separately contracted native whole-contour counterpart before workspace adoption; full P3 geometry/coverage/transport gates remain open.

## P3.2r transverse crossing preservation predicate

Base: clean updated`5617d463e37789857cfb1a24694de5f1e851d8c3`, after P3.2q PR #81 and required CI run37211590729/job111463710871 PASS on`c3e7e0914c0f3c0babe6ab38c26ffb59e1d72296`. Branch`codex/p3-2r-transverse-crossing-certificate`. The [frozen contract](p3-transverse-crossing-contract.md), approved by Primary and independent Astra high before implementation, addresses a genuine missing crossing primitive: prove unique transverse intersection persistence for two restricted source cubics and their actual chords through the existing straight homotopy. It reuses exact arithmetic, adds no workspace/cap/API/dependency, and makes no global contour claim. Stable source/scratch review precedes numeric dispatch. The [review record](../evidence/p3.2r-transverse-crossing-review-2026-10-05.md) tracks freeze, delegation and evidence. Complete pair coverage, crossing order/triple events, positional correspondence and later adoption remain separate gates. No new census, private-cap lift or deferred stroke work.

R01-R04 local acceptance PASS: all60 literal fixtures match the independent BigInt oracle and allocation-free native helper, with39 Certified/10 Unresolved/11 invalid outcomes. Primary and independent Astra high stable-source/scratch review preceded all numeric execution. First full geometry run passes177 native and246 TypeScript geometry tests with unchanged independent WASM identity; bounded two-worker root check passes483 tests and all static/boundary checks; build passes. Review corrected parser error propagation, lifetime-test input ownership and unnecessary scratch copies before execution, without changing expectations. Protected CI/integration remain required. The next prospective prerequisite is a separately reviewed whole-contour crossing contract for complete pair coverage, joins and event-order/triple-event preservation, not direct workspace adoption or a capacity increase.

## P3.2q canonical all-LINE degenerate contour composition

Base: clean updated`28b3cf05ed623b5a18546691f090e636fea2074b`, after P3.2p2 PR #80 and required CI run37209507945/job111457623286 PASS on`a7156b0fae80b1934bf69406f770731e0bc09020`. Branch`codex/p3-2q-line-degenerate-composition`. The [frozen contract](p3-line-degenerate-composition-contract.md), approved by Primary and independent Astra high before implementation, closes temporary all-LINE composition restrictions using approved visible semantics and the existing rounded workspace. It preserves singleton contour identities and cancelled nonzero proof edges, with unchanged caps and all CUBIC/mixed behavior. Primary owns contract/review/integration; one Sol high owns coupled runtime/native tests after freeze, with independent stable-source review before numeric dispatch. Q01-Q05 and protected CI are required. No general curved topology, public API/ABI/dependency change or deferred stroke work.

The [review record](../evidence/p3.2q-line-degenerate-composition-review-2026-10-04.md) tracks prospective decisions, actual delegation, source freeze, validation and remaining gates. Cached last-invoked topology statistics retain the earlier adoption contract; current-attempt flags and publication remain separate.

Q01-Q05 local acceptance PASS:16 standalone/48 composed all-LINE attempts and8 fixed ambiguity rejections, exact ownership and lifecycle/resource controls,174 native tests,246 geometry tests,483 root unit tests, static/boundary checks and build. Independent WASM identity is unchanged. The record preserves one first-run fixture error: a supposedly mixed old carrier used the all-LINE mask; it was corrected to the prospectively required CUBIC carrier with unchanged failure expectation, independently rereviewed, then the entire geometry suite passed. Final Primary/independent evidence review PASS on2026-10-05, changed docs/733 links across147 Markdown files/diff checks PASS; protected integration remains pending. General CUBIC topology/capacity, public transport/coverage and deferred stroke remain separate.

## P3.2p historical polygon segment-relation census

P3.2p1 protected integration: required CI run37208813126/job111455583558 PASS on`b2cc465a02b59af768155c8ba93c0b8c670a73b1`; PR #79 squash`a5764303e27f4bebb8eff7e0711882df3105b3aa`. P3.2p2 starts from that clean updated main on`codex/p3-2p2-polygon-relation-observation`. Its single frozen FULL run completed1000 rows and the independent audit passed, preserving separate historical/analysis identities and unchanged source manifest. The [immutable observation](../evidence/p3.2p2-polygon-relations-2026-10-04/README.md) records881038654 classified pairs,63648 nonadjacent proper crossings and complete provenance/hash evidence. Every recorded polyline has a crossing; this says nothing by itself about original cubic topology or current runtime acceptance. Primary and independent Sol medium evidence review PASS, including all1000 journal reductions and byte-copy hashes; protected integration remains pending. Next meaningful private implementation candidate: canonical all-LINE degenerate contour composition under a new narrow contract; general cubic topology/resource obligations remain open.

Base: clean updated`1488094118ac1be1c3a0724b411779f0561206a7`, after P3.2o PR #78 and required CI run37205671538/job111446234189 on`c5fbf96129892d8067a092d25e365753e4422984`. Branch: codex/p3-2p1-polygon-relation-census. The [relation census contract](p3-polygon-relation-census-contract.md) is FROZEN after Primary and independent Astra high mathematical/interface review, before implementation. P3.2p1 implements and validates tooling/smoke only; P3.2p2 later performs the full immutable observation after p1 integration.

Reuse authenticated historical m2 frames to classify actual polygon edge relations and work counts. Runtime identity remains pinned to m2 and analysis identity is separate. No current kernel/position-proof rerun, curved topology certificate, cap/API/ABI/dependency change, browser/GPU/performance or deferred stroke work. Primary owns contract/shared types/review/integration; disjoint classifier, independent parametric auditor and transport/runner scopes may run in parallel after freeze. Stable-source and supplementary analytic fixture review precede numerical smoke dispatch. Full1000 classification is NOT RUN in p1. The [review record](../evidence/p3.2p1-polygon-relation-tooling-review-2026-10-04.md) tracks decisions and evidence.

P01-P04 local acceptance PASS: final Primary/Astra mathematical review and independent Sol I/O review preceded all numeric dispatch;89 analytic/mechanics tests plus separate RUN/AUDIT phases pass with four COMPLETE smoke rows. Root483 tests/50 files, static/boundary checks and build pass. The review record pins source/capture hashes and corrections made before execution. Required protected CI/integration remain pending. The next dependency-ready checkpoint after integration is p2: one frozen full historical observation and independent audit on a fresh clean evidence branch, followed by immutable archive and evidence review. Complete observation will not establish current-kernel or source-curve topology acceptance.

## P3.2o private rounded-topology adoption

Base: clean updated`6e9f81c84aeae498b550a1727784aa0caa2b9fb6`, after P3.2n PR #77 and required CI run36994842118/job110799086442 on`6af675ac01d0e6c5854a1c3260f947ee3a41c49b`. Branch: codex/p3-2o-rounded-topology-adoption. The [adoption contract](p3-rounded-topology-adoption-contract.md) is FROZEN after final Primary/independent selection, resource, interface and analytic carrier review. Implementation may begin; stable-source review still precedes numeric execution.

O01-O04 select the original exact certificate first and invoke the separate rounded helper only on KnotMismatch. Alternative failure preserves the original error; private diagnostics distinguish the extra work and every retained workspace is accounted under unchanged ceilings. Four new actual-kernel carriers and paired closure runs will complement unchanged94-row transport. Primary owns decisions/evidence/integration; Sol high owns coupled Rust workspace/test adapter, Sol medium owns disjoint TS transport/checks, separate Sol medium reviews stable code. No recursive delegation. The [review record](../evidence/p3.2o-rounded-topology-adoption-review-2026-10-02.md) tracks prospective decisions. No public API/ABI, cap/tolerance, dependency, browser/GPU/performance or deferred stroke work.

O01-O04 local acceptance PASS on resumed2026-10-04:168 native tests,246 geometry tests,483 root unit tests, static/boundary checks and build pass. All four new rows select the frozen route and satisfy complete independent geometry checks; all94 historical rows preserve their outcomes without fallback. Observed combined retained capacity887296 bytes and inline10432 bytes fit unchanged ceilings with zero attempt allocations. Release WASM identity remains unchanged. Primary corrected checked accounting before final independent source clearance and numeric dispatch; no numeric expectation changed after execution. Required protected CI/integration remain pending. Next candidate is a separately frozen offline1000x32 topology/work classification to inform general arrangement and resource feasibility; private caps and full P3 gates remain unchanged.

## P3.2n native rounded internal-knot topology

Base: clean updated `8645b0dfac6e9a9d69593cc19bf6f9db8e790ac5`, after P3.1f PR #76 and required CI on `3b55b4e82845add4bf87a9b7354ae1914aac341b` (run36990548139, job110785481020). Branch: `codex/p3-2n-native-rounded-topology`. The [native rounded contract](p3-native-rounded-topology-contract.md) is FROZEN after Primary and independent arithmetic/proof/interface/carrier review. Implementation may begin; stable-source review still precedes numeric execution.

N01-N04 add a separate private native workspace with fixed-width exact arithmetic and accounted allocation, then compare29 fixed source carriers against the independent P3.1f oracle. Existing exact-knot helper/layout/accounting and old54-row transport remain unchanged. The new helper computes area and winding from actual carried knots; it cannot reuse the old controls[0] publication assumption. No CubicFillWorkspace adoption, runtime cap/API/dependency/ABI change, general crossings, browser/GPU/performance run or deferred stroke work is included.

Primary owns contract/shared test transport/lib wiring/review/evidence/integration. Sol high owns the numeric helper and its separate Rust units/emitter; Sol medium owns disjoint TS carrier/transport/verification files. Astra high reviews arithmetic and proof; separate Sol medium reviews stable source. No recursive delegation. Source freeze precedes implementation, stable review precedes numeric execution, and local evidence plus protected CI precede integration. The [review record](../evidence/p3.2n-native-rounded-topology-review-2026-10-02.md) retains prospective decisions and validation evidence. Adoption semantics for the two non-equivalent certificates remain a later separately contracted checkpoint.

Local N01-N04 and corrective final source review PASS:163 native tests,238 TypeScript geometry tests,483 root unit tests, static/boundary checks and build pass. All29 new carriers match fixed12/2/15 statuses, literal output/counters and independent oracle; old54 topology and94 cubic-fill rows remain passing. Retained bytes224256, inline1216, zero certify allocations; independent release WASM identity is unchanged. The review record explicitly retains the preliminary dispatch sequencing gap and subsequent fixture isolation correction/final validation. Protected CI/integration remain pending. Next private dependency is separately frozen old/new certificate selection and accounting before CubicFillWorkspace adoption; no full-workload readiness is inferred.

## P3.1f rounded internal-knot topology

Base: clean updated `5f4fece1629343d4ef054b41e9cb8c2730ad0b0c`, after P3.2m2 PR #75 and required CI on `ca360f82e4fea7dba7bc3c2d21e5a9c256b1e9b7` (run36988360168, job110778488068). Branch: `codex/p3-1f-rounded-knot-topology`. The [new contract](p3-rounded-knot-topology-contract.md) is FROZEN after Primary and independent mathematical/interface/literal-fixture review; implementation may now begin, with numeric execution still gated by stable-source review.

K01-K04 add a separate sufficient topology certificate for rounded internal subdivision knots with exact source endpoints. Expanded hull disjointness and directed cyclic common projection preserve a simultaneous embedding; existing P3.1d position proof and P3.1e exact-knot certificate remain unchanged. Freeze11 literal positive carriers, rejecting controls and bounded stage/counter semantics before implementation; stable source review precedes execution. This does not claim acceptance of the1000-path census or general crossing support.

Primary owns proof contract/shared decisions/evidence/integration. Sol high owns the coupled test-only oracle and shared preflight extraction; Sol medium owns disjoint fixtures/unit tests. Astra high reviews the mathematical proof and prospective fixtures; an independent Sol medium checks stable code and Primary reviews both workers. No recursive delegation. Runtime/native/API/ABI/dependency/cap changes, browser/GPU/performance runs and deferred stroke are excluded. The [review record](../evidence/p3.1f-rounded-knot-topology-review-2026-10-02.md) retains prospective decisions and forthcoming validation. Local evidence is recorded below; protected CI/integration remains pending.

K01-K04 local PASS: all11 new positive carriers and positional proofs, all fixed controls and old-oracle counterparts pass. Focused tests pass124 units; bounded two-worker `pnpm check` passes483 units across50 files and all static/boundary checks; build passes. Primary/independent pre-execution review preserved old semantics and corrected the cyclic fixture's provenance before any numeric run. No numerical failure or post-result tuning occurred. Required CI/protected integration remain pending. The next candidate is a separately contracted native counterpart before any private workspace adoption; no runtime or capacity readiness is inferred from this test-only checkpoint.

## P3.2m2 full cubic readiness evidence

Base: clean updated `9508a6615f6b6e941aee26802a49eb9ca1b9dbd0`, after PR #74 and required CI on `55c2203d89e87b4b13dc6ba11db3cb26fb15e7c3` (run36985763300, job110770307120). Branch: `codex/p3-2m2-cubic-readiness-evidence`. M01-M04 are integrated. M05 executes the unchanged [census contract](p3-cubic-census-contract.md) once from clean source and preserves the [immutable full observation and audit](../evidence/p3.2m2-cubic-readiness-2026-10-02/README.md).

M05 local PASS: all1000 rows complete, all32000 source-cubic boundary proofs CERTIFIED, separate full-frame AUDIT PASS and independent journal/source arithmetic review PASS. All1000 preparations report KNOT_MISMATCH and exceed existing cheap source caps. Pair topology, intersections, rounded fill and meshes are NOT_EVALUATED; no capacity increase or topology acceptance is inferred. Primary reviewed the fixed-source run, concrete findings, byte hashes and scope. No production code, API, architecture, dependency or numeric threshold changes.

After evidence integration, the next proposed private prerequisite is a separately frozen test-only rounded-internal-knot topology certificate, retaining exact source endpoints and the existing position proof. Independent proof/analytic fixture review must precede implementation. Larger capacities and general crossings remain subsequent work, not part of M05. Historical P2 A08 FAIL, latest-source performance UNVERIFIED and user-deferred stroke stay unchanged.

## P3.2m bounded cubic readiness

Base: clean updated `c3b0c6f655844e83c1802f0e2c248a4a26745c83`, after P3.2l PR #73 and required CI on `7f35806bc9756d79a94137eb4ecce5c2dd34b331` (run36981514875, job110756885866). Branch: `codex/p3-2m1-cubic-readiness-tooling`. The [census contract](p3-cubic-census-contract.md) owns the bounded inspector, runner, immutable observations and audit. No production capacity/algorithm/API change is included.

M01 freezes the contract after independent mathematical/interface review; M02 adds the preparation-only inspector and analytic/precedence/limit fixtures; M03 adds bounded native transport, isolated wrapper/schema/audit and four native smoke sources; M04 requires stable-source review, smoke/mechanics, geometry/root/build/docs validation and protected CI/integration. Full1000-path observation is explicitly NOT RUN in m1. Separate m2 M05 must start from clean integrated tooling, execute the frozen workload once, retain every observation/failure and independently audit it before drawing readiness conclusions. Existing P2 performance evidence and deferred stroke are unchanged.

Primary owns contracts, native transport and CI; Sol high owns inspector/focused fixtures, Sol medium owns isolated runner/reporting/smoke, and another Sol medium performs independent source review. No recursive delegation. M01 is frozen after prospective review; M02-M04 implementation/validation are in progress. The [review record](../evidence/p3.2m1-cubic-readiness-tooling-review-2026-10-02.md) retains decisions, corrections and evidence.

Local M01-M04 and Primary/independent review PASS. Preparation11 fixtures and full geometry152 native/201 TypeScript tests pass; release WASM identity remains unchanged. Smoke passes9 mechanics controls, four native observations and separate full-row/source/hash audit. Root check passes446 tests and all static/boundary checks; build passes. The first smoke stopped at an incorrectly located negative path fixture before any numeric execution; evidence retains the failed attempt and reviewed correction. Required CI/protected integration remain pending. M05 full1000 observation remains NOT RUN until m1 integration.

## P3.2l repeated canonical LINE normalization

Base: clean updated `44ab0c020aaf4e0203fbefd62047b5279158b9ab`, after P3.2k [PR #72](https://github.com/npclown/vector-studio/pull/72) and required CI on `dff2e7cd8e7ce4fff0ccbd8a183cc2d2e4afbdc9` (run36979268660, job110749838521). Branch: `codex/p3-2l-zero-line-normalization`. The [zero-LINE contract](p3-zero-line-contract.md) is FROZEN after Primary/independent proof and literal-fixture review, before implementation.

Z01-Z04 cover exact repeated-point normalization while retaining original source/command bits, ordinals and cap charging, compact proof inputs for mixed/CUBIC contours, F09/triangle/ownership fixtures and allocation/error precedence. Only the superseded private zero-LINE preparation rejection changes; constant-CUBIC and fully collapsed controls remain explicit. One Sol high worker owns the coupled runtime/native adapter; Sol medium reviews stable source and Primary owns decisions/evidence/integration. No new API/dependency/numeric allowance/cap/topology algorithm or deferred stroke work. Implementation and validation are pending.

Local Z01-Z04 and Primary/independent stable-source review PASS; the [review record](../evidence/p3.2l-zero-line-review-2026-10-02.md) records the original-versus-emitted endpoint correction, fixed pre-execution regressions, static-only Clippy correction and final evidence. Geometry passes150 native/190 TypeScript tests with unchanged independent WASM hash; bounded two-worker root check passes446 unit tests and all static/boundary checks; build passes. Required CI/integration remain pending. Next proposed work is a separately specified1000x32 readiness runner followed by immutable observations, not a premature runtime cap increase.

## P3.2k exact canonical LINE topology composition

P3.2j is integrated through [PR #71](https://github.com/npclown/vector-studio/pull/71) as `8f14be23a684632ad101313cdf9c1132d4bb2715`, after required CI on `14bb9892b5566b31c3f8dc301ca39e98187de874` (run36977871471, job110745549470). Base is that clean updated main; branch `codex/p3-2k-line-identity`. This is the current selected private prerequisite under continuous-work authorization; earlier status paragraphs retain their historical context.

The [LINE identity contract](p3-line-identity-contract.md) is FROZEN after Primary/independent proof and fixed-fixture review, before code. It composes actual LINE geometry directly with existing rounded topology after source/provenance validation, preserving mixed/curved guards and all numeric limits. I01-I04 require 120 source/rule/closure cases, 12 transforms, literal areas, full carrier comparisons, unchanged independent oracles, failure isolation and zero allocations. One Sol high worker owns the two coupled Rust files, a separate Sol medium reviewer checks stable source, and Primary owns contract/evidence/integration. No recursive delegation or public/API/renderer/stroke change. Implementation and validation are pending.

Local I01-I04 and Primary/independent stable-source review PASS; the [review record](../evidence/p3.2k-line-identity-review-2026-10-02.md) links proof, fixture and validation evidence. First complete geometry run passes 143 native tests and 190 TypeScript geometry tests with unchanged independent release WASM hash. Bounded two-worker `pnpm check` passes 446 unit tests and all static/boundary checks; build passes. Required remote CI/integration remain pending. Next ordinary private prerequisite is repeated canonical LINE normalization under a separately frozen contract; no full P3 gate or performance acceptance is claimed.

## P3.2j private canonical LINE/CUBIC input

Base: clean updated `5aef7c14f2f51326fbb9f59457a80259888c8c5b`, after P3.2i [PR #70](https://github.com/npclown/vector-studio/pull/70) and required CI on `6dbb8ad618fd10f3e9d8f45dcc0fee8592a747d9` (run36975711009, job110738974208). Branch: `codex/p3-2j-canonical-mixed`. Primary selects the [mixed-source contract](p3-canonical-mixed-contract.md) after independent feasibility review: actual LINE source identity is retained, while the existing topology proof receives an exactly equivalent segment representation only at composition.

Freeze R01-R05 and stable source before implementation/execution respectively. One Sol high owner changes the coupled private workspace/native adapter; a separate Sol medium reviewer checks proof and ownership. Primary keeps contract/evidence/integration ownership. No new public API/ABI, dependency, P2 behavior, numeric tolerance, work cap, topology algorithm or deferred stroke work. The original94 cubic protocol and P3.2i closure pairs remain unchanged.

Local R01-R05 and Primary/independent review PASS; the [review record](../evidence/p3.2j-canonical-mixed-review-2026-10-02.md) includes the initial Clippy-only correction and final evidence. `pnpm test:geometry` passes 138 native tests and 190 TypeScript geometry tests, preserving the original 94 outcomes and all closure pairs. Two release WASM builds retain the P2.6f hash. Bounded two-worker `pnpm check` passes 446 unit tests and all static/boundary checks; `pnpm build` passes. Protected CI/integration remain required. Next prospective private work is exact all-LINE topology composition, with mixed/curved inputs retaining their existing certificate and all numeric caps unchanged.

## P3.2i private cubic closure forms

Base: clean updated `73be4460ed6d276f91d8dd09b2e474c9b2dbbf8e`, after P2.6f [PR #69](https://github.com/npclown/vector-studio/pull/69) and required CI on `9359e3c5c4ae9164d98d67d7498f0c8847ba6209` (run 36973740598, job 110733000792). Branch: `codex/p3-2i-cubic-closure-forms`. Primary selects the [closure contract](p3-cubic-closure-contract.md), extending the existing private workspace to the two closure forms already required by approved visible semantics. The older P3.2h restrictions explicitly describe preparation limitations, not product rejection policy.

One Sol high owner changes the coupled runtime/native adapter, with a separate Sol medium contract/source reviewer. Primary owns decisions, documentation and integration. Freeze Q01-Q05 and stable source before execution. Reuse the unchanged 94-row protocol and independent TS oracles; add paired alternate closure execution and literal owner fixtures. No public API/ABI, dependency, tolerance/cap, topology algorithm, renderer or deferred stroke change. Full C03-C05 remain open.

Local Q01-Q05 and Primary/independent source review PASS; the [review record](../evidence/p3.2i-cubic-closure-review-2026-10-02.md) links the frozen semantics and evidence. `pnpm test:geometry` passes 134 native tests and 190 TypeScript geometry tests, including 94 alternate/original closure pairs with unchanged 92/2 original outcomes. Two release WASM builds retain the P2.6f hash. Bounded two-worker `pnpm check` passes 446 unit tests and all static/boundary checks; `pnpm build` passes. Required remote CI/integration remain pending. Next ordinary private prerequisite is canonical LINE/mixed support under a separately frozen source-kind contract; deferred stroke stays deferred.

## P3.2h private native cubic-fill workspace

Base: clean updated `7bc0fdd`, branch `codex/p3-2h-native-cubic-workspace`. Primary selects the [workspace contract](p3-native-cubic-workspace-contract.md) to move the validated composition from a cfg(test) fixture model into a private canonical-input Rust operation. An independent dependency/seam audit confirms that existing PathInput accessors and run_path validation suffice. Cheap source caps precede sizing; inherited P2 error precedence applies within that envelope, while P2 itself remains unchanged. The current restricted grammar is explicit and does not define final product rejection behavior.

Contract review and freeze precede implementation; stable source/raw fixture review precedes execution. One Sol high owner will migrate the coupled module/test adapter, with a separate Sol medium read-only reviewer; Primary owns the shared lib seam, contracts and integration. W01-W05 and protected CI are required. Existing 94-row oracles/expectations are reused without a new test-only composition. No public API, mesh ABI, WASM export, dependency, renderer or deferred stroke change is included.

Primary/independent contract review PASS and FROZEN. Review resolved unconditional reset before cheap caps, deterministic restricted-decode error order and min(requested,72) command-capacity behavior. The [review record](../evidence/p3.2h-native-cubic-workspace-review-2026-10-02.md) tracks evidence; implementation and validation remain pending.

Local W01-W05 and Primary/independent review PASS. The runtime workspace reads canonical PathInput; the previous cfg(test) composition is replaced by a thin adapter. Final `pnpm test:geometry` passes 121 native tests and 189 TypeScript geometry tests across seven files, preserving all 94 original outcomes and the release WASM hash. `pnpm check` passes formatting/lint/types, 445 unit tests across 49 files and boundaries; `pnpm build` passes. The first native run exposed two incorrectly constructed raw linear fixtures; independent bit-level analysis and exact integer-trisection correction are retained in the review record. No runtime workaround, expectation relaxation, tolerance/cap change or original-corpus edit was made.

Protected CI/integration remain required. A separate source audit found that an axis-wise endpoint convex-hull certificate could avoid the existing P2 near-linear bounds rejection while retaining the guard and independent oracle. Because the frozen P2 root/uncertainty acceptance rule currently requires rejection, a concrete prospective contract decision must precede any such follow-up; this checkpoint does not change it. General grammar, topology, operation/transport and full C03-C05 remain open; deferred stroke refinement stays deferred.

Final document checks PASS: explicit formatting of four changed Markdown files, local links/anchors (631 references across 122 files), whitespace and seven-file scope review. No generated binary/cache, public export, dependency or unrelated change is included.

P3.2f integrated through [PR #66](https://github.com/npclown/vector-studio/pull/66) as `63daad21463ac5cdc67ec96987f4adb2d008aa11` after required CI on `73baa825c52d052404c3e850c053078d8b6b5f80` (run36964410591, job110704906113).

## P3.2g native simple cubic topology

Base: clean updated `63daad2`, branch `codex/p3-2g-native-cubic-topology`. Primary selects the missing native topology guard after the actual-kernel compatibility checkpoint. The [frozen contract](p3-native-cubic-topology-contract.md) ports the existing exact-knot sufficient condition using bounded34/68-limb arithmetic, without new dependencies or Float64-control representability restrictions. A Sol high read-only feasibility audit confirms the integer width and bounded-memory approach; Primary chooses two restriction passes to preserve all-knots-before-hulls precedence using one pre-reserved vector.

Primary/independent contract review PASS; the contract is FROZEN. Review resolved control-source identity, token-array encoding, inclusive byte/pair limits and the linked prospective combined accounting field without changing historical evidence. Sol high may implement the private module; Sol medium owns disjoint transport fixtures/emitter. Stable source and fixed54-row fixture review precede execution. Standalone certificate validation precedes Primary's dependent test-only P3.2f guard. No production operation/source model, public API, ABI, P2 behavior, renderer, acceptance-budget or deferred stroke change. G01-G05 and protected integration are required; full C03-C05 remain open.

Local G01-G05 and Primary/independent review PASS; the [review record](../evidence/p3.2g-native-cubic-topology-review-2026-10-02.md) maps exact arithmetic, all 54 fixed certificate rows, limits, publication/allocation and guarded bridge evidence. Standalone validation passed before Primary added the dependent guard; final `pnpm test:geometry` passes 116 native tests and 189 TypeScript geometry tests across seven files, including all 94 unchanged actual cubic-mesh expectations. `pnpm check` passes formatting/lint/types, 445 unit tests across 49 files and boundaries; `pnpm build` passes. Independent release WASM builds preserve the existing hash. Source/fixture and guard review preceded their executions; no observed result changes a corpus, cap, expectation or error budget. Protected CI/integration remain required.

Next meaningful private dependency is a native cubic-fill workspace composed from the now-validated helpers and existing canonical input, with a separately frozen narrow contract before implementation. Public path/mesh ABI, cache/transport, renderer and full curved-topology/coverage obligations remain later gates; deferred stroke refinement stays deferred.

Final explicit Markdown formatting, local links/anchors (622 references across 120 files), whitespace and 12-file scope review PASS. No generated inputs, local caches, dependencies, public exports or unrelated work are included.

P3.1e was integrated through [PR #65](https://github.com/npclown/vector-studio/pull/65) as `1eac46fdc2ab04aa8852246a543ac00c2cbf4d62` after required CI on `5be209d9e6b8c563729465cefd9cdfd5184f530c` (run36961562928, job110696166877).

## P3.2f native cubic fill compatibility

Base: clean updated `1eac46f`, branch `codex/p3-2f-native-cubic-bridge`. Primary selects actual-kernel compatibility before a production cubic mesh operation, following independent dependency review. The [frozen bridge contract](p3-native-cubic-bridge-contract.md) composes actual Rust flattening at1/8 and rounded fill at1/16 under identity screen, then independently verifies original-source position/topology, provenance/closure ownership and complete mesh output. Its prospective94 rows reuse the47 frozen source cases under both rules:92 mandatory successes and two analytically required large-coordinate sizing failures.

Contract/source/limit review must precede the first new geometry execution. All composition remains test-only; absent native topology acceptance and incomplete operation/transport contracts prohibit publishing this as a general runtime operation. No P2 behavior, public API, ABI, dependency, renderer or user-deferred stroke work is included. Primary owns shared seams; only after freeze may native and TS workers implement disjoint files.

Primary and independent contract/proof review PASS. Native dyadic flattening, separated hulls, monotone rounded-window feasibility and convex-family output bounds were established before execution. Review clarified failed sizing-plan retention and avoided stringify/reparse loss of signed zero. The contract is FROZEN; Sol high owned only the new cfg(test) native bridge, Sol medium owned disjoint TS fixtures/parser/checks, and Primary owned lib/serializer/parser seams. Stable-source review preceded the first geometry execution.

Local N01-N05 acceptance and Primary review PASS; the [review record](../evidence/p3.2f-native-cubic-bridge-review-2026-10-02.md) maps the fixed cases, publication/allocation tests and review corrections. `pnpm test:geometry` passes 102 native tests, 129 TypeScript geometry tests in six files and unchanged reproducible WASM. All 94 new actual rows match the frozen expectations: 92 certified meshes and two sizing failures. `pnpm check` passes formatting/lint/types, 445 unit tests in 49 files and boundaries; `pnpm build` passes. Source review preceded execution, and no observed result changed a source, tolerance, cap or expected outcome. Protected CI/integration remain required.

Final independent stable-source audit and Primary review PASS with no remaining implementation must-fix. Explicit Markdown formatting, the existing local-link/anchor checker (612 references across 118 Markdown files), whitespace and scope review PASS. The 11-file change is limited to test support, fixtures and owning documents; generated inputs remain ignored. The next private dependency is native topology acceptance and remaining operation/transport readiness, not the user-deferred stroke refinement or an implicit public path API.

P3.1d was integrated through [PR #64](https://github.com/npclown/vector-studio/pull/64) as `d42dfb2f18152d003c5957d859c52b1355078f13` after required CI on `833d5a730bc193404302449ca4764f3cff895d4f` (run36959253670, job110689045097).

## P3.1e restricted simple cubic topology

Base: clean updated `d42dfb2`, branch `codex/p3-1e-simple-cubic-topology`. Primary selects the next test-only topology prerequisite under resumed continuous execution. The [frozen contract](p3-simple-cubic-topology-contract.md) fixes an exact-knot, monotone-projection/control-hull proof, closed/open implicit closure, a 47-case analytic corpus, resource ceilings and rejecting controls. This is a sufficient certificate for a restricted simple-contour family; unresolved crossings, tangencies, rounded knots and close hull bands remain open rather than becoming product rejection rules.

A Sol medium independent mathematical audit agrees that the simultaneous linear homotopy remains embedded under the proposed exact separation conditions. Primary retains the 1/8 boundary share through P3.1d and the original 1/4 total budget. Source/contract review precedes fixture execution and implementation freeze. Primary owns shared test-fixture extraction and integration; after freeze, Sol high may implement the oracle and Sol medium the disjoint fixtures/tests, with independent read-only review. No production, public API, ABI, external dependency or deferred stroke work is included.

Local T01-T04 acceptance and Primary/independent review PASS; the [review record](../evidence/p3.1e-simple-cubic-topology-review-2026-10-02.md) links the proof, source review, fixes and limitations. The focused suite passes 65 tests, including all 47 analytic topology certificates and each source cubic's P3.1d positional check. `pnpm check` passes formatting/lint/types, 445 tests in 49 files and dependency boundaries; `pnpm build` passes. Review corrected leaf-cap precedence after an earlier implicit closure and added a reproducing control. An aggregate-test timeout was resolved by individually naming all 47 unchanged cases with unchanged assertions/default timeout. No acceptance, corpus density or error budget changed. Protected CI/integration remain required.

Final document checks PASS: explicit Prettier check of four changed Markdown files, the existing local-link/anchor checker (604 references across 116 Markdown files), whitespace and scope review. Eight files contain only test support, unit fixtures and owning documentation; no product source, dependencies, generated binary, local cache or unrelated changes are included.

## P3.1d continuous cubic boundary certificate

On 2026-10-02 the user resumed continuous execution, superseding the stop after P3.2e. Base is clean `c7fd5c7`, equal to freshly fetched origin/main; branch `codex/p3-1d-cubic-boundary-oracle`. The [test-only contract](p3-cubic-boundary-oracle-contract.md) owns B01-B04 and the fixed 1/8 physical-pixel target. Primary selects this independent oracle before cubic integration because P2's unchanged 1/4-pixel verifier cannot prove the P3 boundary share. A Sol medium read-only audit independently confirmed this dependency and the remaining curved-topology gap.

Contract/source review precedes the first fixture execution. Primary owns decisions, shared plan/evidence and review. Disjoint Sol medium workers may implement the oracle and fixed fixtures/tests after contract/interface freeze; no recursive delegation. Required validation is focused units, `pnpm check`, `pnpm build`, changed-Markdown checks and protected CI. No runtime, P2 verifier, public API, ABI, dependency, browser/GPU or benchmark change is included. The user-deferred stroke refinement remains deferred.

Dependency order: P3.1d continuous positional certificate -> separately frozen curved-region/topology oracle -> private P3-budget flattening/contour/source-provenance composition with rounded fill. A distance bound alone cannot certify crossings, tangencies or region connectivity. Full cubic workload limits, mesh transport, coverage and GPU validation remain later gates.

Local B01-B04 acceptance and Primary/independent review PASS; the [review record](../evidence/p3.1d-cubic-boundary-review-2026-10-02.md) maps the evidence and its limits. Focused units pass 22 tests with all 106 fixed cases / 22,912 intervals. `pnpm check` passes formatting/lint/types, 380 tests in 48 files and dependency boundaries; `pnpm build` passes. Fixture source was reviewed before first execution; unit conversion, explicit status/precedence, literal carriers, sparse-input validation and successful-refinement coverage were clarified or corrected before acceptance without changing the fixed corpus, densities or budget. Protected CI/integration remain required.

Final document validation PASS: explicit Prettier check of four changed Markdown files, the existing local-link/anchor checker (596 references across 114 Markdown files), whitespace and source-of-truth/scope review. The seven-file change contains only test support, unit fixtures and owning documentation; no product code, P2 verifier, dependency, generated binary, local cache or unrelated change is included.

## P3.2e rounded line-fill mesh

Base: clean `514e3b6`, equal to updated origin/main; branch `codex/p3-2e-rounded-fill`. The [rounded-fill contract](p3-rounded-fill-mesh-contract.md) freezes 202 fixed rows, exact section/region/source correspondence, full-window pin/greedy embedding and independent local/physical displacement checks. Primary and independent numeric reviewers derived the mediant/section width proof, single-zero rank, vertical winding transfer and shared-node topology argument before any new runtime code. This is private technical work under continuous execution authorization; no public API, ABI, dependency, renderer or tolerance change is implied. Deferred stroke refinement stays deferred.

Oracle-first entry is complete: all 198 mandatory successes and four policy ambiguities pass nine focused unit tests, including all 32 legacy exact-region checks, fixed structural bounds, source areas, physical budgets and semantic corruption controls. Generator byte identity, scoped formatting/lint and TypeScript pass. Primary and independent review closed numeric, memory-inventory and verifier gaps without changing the corpus/tolerances/caps. The complete private contract is now FROZEN; kernel implementation and independent native/bridge fixtures may proceed in disjoint files. The user's later instruction limits execution to completing this P3.2e checkpoint, then stopping before any subsequent checkpoint.

Local implementation and acceptance are COMPLETE; the [review record](../evidence/p3.2e-rounded-fill-review-2026-09-29.md) maps R01-R06 to reproducible evidence. `pnpm check` PASS: 358 tests in 47 files, formatting/lint/TypeScript and boundaries. `pnpm build` PASS. `pnpm test:geometry` PASS: 98 native tests, all 202 actual rounded rows (198 success/four policy ambiguities), unchanged F32 regions, 30 differential/bridge tests in five files and reproducible unchanged WASM. Primary and independent stable-source review PASS; comparator precedence, work accounting and test-emitter defects found during review/validation were corrected without changing acceptance. Protected CI/integration remain required. Complete P3, public path/mesh ABI, GPU and performance gates remain open.

Final documentation validation PASS: explicit Prettier check of the three changed Markdown files; the existing local-link/anchor checker verifies 588 links across 112 Markdown files; staged whitespace check is clean. The diff is limited to this checkpoint's private runtime, fixtures, runner wiring and owning documents, with no dependencies, generated binaries, machine-local caches or unrelated work.

## P3.2d bounded private line-fill mesh v0

P3.2c integrated through [PR #61](https://github.com/npclown/vector-studio/pull/61) as `cb8210797da879d5a4d9a57294d573ffce2c878a`, after required CI on `9b3c8a7c906bfb842904207f62b2f68041639113` (run 36575233344, job 109429024669). P3.2d starts from that clean updated main on `codex/p3-2d-line-fill-mesh` and is IN PROGRESS.

The frozen [line-fill contract](p3-line-fill-mesh-contract.md) owns L01-L05: bounded workspace, exact event columns/cuts, coincident winding, nonoverlapping triangle output, atomic failures and 32 independently checked source/rule fixtures. This is an unexported exact-output subset; nonrepresentable coordinates explicitly remain unresolved. P3.2b remains available for later rounded output. No public API, P2 arena/export, dependency, renderer or error threshold changes are authorized by this slice. Deferred stroke refinement stays deferred and full C03-C05 remain open.

Primary owns shared x-comparison seam/lib wiring, contract, review and integration. Sol high owns only line_fill.rs; independent Sol medium owns native fixtures and TypeScript mesh bridge. A separate Sol medium audit reviews stable sources. No recursive delegation. The continuous-work authorization covers this private implementation after the acceptance contract is frozen. Required validation: `pnpm test:geometry`, `pnpm check`, `pnpm build`, unchanged exports, Markdown formatting/links, diff review and protected CI. Browser/GPU/benchmark NOT RUN for this numeric checkpoint.

### P3.2d local acceptance

The [Primary review and evidence](../evidence/p3.2d-line-fill-mesh-review-2026-09-29.md) map L01-L05 to all 32 independently checked native meshes, seven corruption controls, exact searches, deterministic caps and atomic failure/zero allocation. `pnpm test:geometry` PASS: 75 native tests, unchanged intersection certificates, reproducible release WASM and 27 differential/bridge tests in four files. `pnpm check` PASS: formatting/lint/TypeScript, 348 unit tests in 46 files and boundaries. `pnpm build` PASS. A final test-only strengthening to strictly negative search ranges passed all five focused internal tests and Rust formatting. P2 exports and public/dependency boundaries remain unchanged.

Primary and independent final review found no runtime defect; two fixture lint errors and missing extreme-search coverage were corrected before acceptance. Explicit Prettier check of four changed Markdown files PASS; local links/anchors PASS (582 links across 110 Markdown files); whitespace PASS. Protected CI/integration remains required; this exact-output slice does not pass full C03-C05. Next work is a coherent rounded-fill contract with boundary correspondence/displacement evidence, not deferred stroke refinement.

## P3.2c exact symbolic event positions

Base: clean `a1990a7`, equal to updated origin/main; branch `codex/p3-2c-fill-event-order`. Primary selects the next private topology dependency: exact lexicographic comparison of endpoint/proper-crossing positions. The frozen [contract](p3-fill-event-order-contract.md) owns E01-E06 and the 528-row independent corpus. This exact-only helper is deliberately independent of Float64 placement: overlapping enclosures and equal rounded coordinates cannot establish event equality. Comparison success never certifies coordinate emission or connectivity.

Primary and a separate Sol medium read-only audit checked bounded homogeneous widths, canonical signed magnitude, proper-crossing validation, near-coincident representative collision and four-line concurrence. Sol high owns only the implementation/internal arithmetic fixtures; independent Sol medium owns generator/corpus/external native tests. Primary owns shared lib/runner wiring, documentation, review and integration. No recursive delegation. No accepted predicate/placement code is refactored, and no public or P2 v1 meaning changes.

```text
P3.2a exact relations -> frozen P3.2c contract -> exact pairwise position comparison
    -> independent rational corpus + native/P2 regressions -> protected PR
P3.2b placement + P3.2c comparison -> later bounded arrangement/edge attribution
```

The user's continuous-work authorization covers this ordinary private algorithm choice inside the approved roadmap. Mandatory validation is generator --check, `pnpm test:geometry`, `pnpm check`, `pnpm build`, changed-Markdown format/links, Primary review and protected CI. This does not create an event arena, define path limits or complete C03-C05. Deferred stroke refinement stays deferred; public path/coverage/transport decisions remain separate.

### P3.2c local acceptance

The [Primary review and evidence](../evidence/p3.2c-fill-event-order-review-2026-09-29.md) map E01-E06 to 528 independently generated pairs, 34026 permutation/antisymmetry comparisons, exact four-line concurrence, a rejecting representative-collision control, extreme inputs and zero-allocation proof fixtures. `pnpm test:geometry` PASS: Rust fmt/Clippy, 58 native tests, existing explicitly invoked intersection certificate checks, reproducible release WASM and 25 differential/adapter tests. `pnpm check` PASS: formatting, lint, TypeScript, 348 unit tests in 46 files and boundaries. `pnpm build` PASS. No public API, dependency or P2 export/caller changes.

Primary and independent stable-source review found no runtime defect; strengthened literal arithmetic/validation fixtures preceded the first stable full test run. Explicit Prettier check of four changed Markdown files PASS; local links/anchors PASS (573 links across 108 Markdown files); whitespace PASS. Browser/GPU/benchmark NOT RUN, with no performance claim. Protected integration remains required. Next work combines bounded event/source handling, x columns, active-edge ordering, winding and mesh output in a coherent private line-fill slice; it does not reopen deferred stroke refinement.

## P3.2b certified pairwise placement

Base: clean `c620210`, equal to updated origin/main; branch `codex/p3-2b-fill-intersections`. Primary selects the next private numeric dependency after exact predicates: bounded outward Float64 construction of one segment-pair intersection, with exact endpoint/overlap branches and explicit failure when certification is unavailable. The frozen [contract](p3-fill-intersections-contract.md) owns I01-I06, error precedence, canonicalization, arithmetic, independent corpus and evidence. It does not select global event order/equality, arrangement, mesh limits, ABI or renderer behavior.

The separate Sol medium read-only audit found no architecture or mathematical blocker and required returning an enclosure plus independently checking the actual native representative's exact L1 error. Primary adopted both, checked all four parametrizations and froze the constructive 260-case ordinary-success corpus before code. Sol high owns only the private implementation/internal arithmetic tests; independent Sol medium owns generator/corpus/external native fixtures. Primary owns lib/runner wiring, review, evidence and integration. No recursive delegation or shared worker edits.

```text
P3.2a exact predicates -> frozen P3.2b contract + independent rational fixtures
    -> certified pairwise placement -> native exact-certificate review + P2 regressions
    -> protected PR -> later exact event identity/order and bounded topology
deferred stroke refinement remains outside this dependency
```

The existing continuous-work authorization covers this ordinary private implementation. Required local commands are generator --check, native emission with independent --verify-native, `pnpm test:geometry`, `pnpm check`, `pnpm build`, changed-Markdown format/links and diff review. Protected CI follows. Unresolved extreme/ill-conditioned cases are explicit helper limitations, not newly rejected product cases or waiver of the future full ordinary corpus. Full C03-C05 remain open.

### P3.2b local acceptance

The [Primary review and evidence](../evidence/p3.2b-fill-intersections-review-2026-09-29.md) map I01-I06 to 260 independent exact intersections, 2080 permutation comparisons, two geometric corruption controls, exact relations, invalid inputs, arithmetic transitions and zero-allocation fixtures. `pnpm test:geometry` PASS: Rust fmt/Clippy, 45 native tests, explicitly invoked emission/exact-certificate verification, reproducible release WASM and 25 existing differential/adapter tests. `pnpm check` PASS: formatting, lint, TypeScript, 348 tests across 46 files and dependency boundaries. `pnpm build` PASS. No P2 export/caller or public API changed.

Primary corrected expected-value units, corruption-control specificity and missing native relation/error cases before the first stable full test run. Independent read-only source audits found no remaining defect. Explicit Prettier check of four changed Markdown files PASS; local links/anchors PASS (565 links across 106 Markdown files); whitespace review PASS. Browser/GPU/benchmark commands are NOT RUN and no performance claim is made. Protected CI/integration remain checkpoint requirements. Next dependency is exact symbolic event position equality/order, followed by bounded arrangement work; deferred stroke refinement remains deferred.

Status: P3.0a integrated through [PR #52](https://github.com/npclown/vector-studio/pull/52) as `4928a88` after required CI (run 36246634960). P3.0b contract preparation is IN PROGRESS under [D7](p2-follow-on-entry.md); the [private-contract draft](p3-private-contract.md) is PARTIAL and [visible behavior](p3-visible-semantics-proposal.md) is APPROVED. The separately frozen [P3.1a test-only line oracle](p3-line-oracle-contract.md) is integrated through PR #54 as `f040265` after required CI (run 36559942597). The [regular stroke certificate review](p3-stroke-boundary-certificate.md) is integrated through PR #55 as `5f16301`; the [bounded numerical experiment](p3-stroke-numeric-experiment.md) is integrated through PR #56 as `28d815b`, with candidate-wide feasibility PARTIAL. Further stroke-bound refinement is DEFERRED by the user; [P3.1b mesh invariants](p3-mesh-oracle-contract.md) integrated through PR #57 as `0b991e8`, and [P3.1c region equality](p3-fill-region-oracle-contract.md) through PR #58 as `62c53bc`. [P3.2a private fill predicates](p3-fill-predicates-contract.md) is the active isolated implementation slice. No complete P3 runtime acceptance or public API extension is claimed.

## Scope and current seams

Implement only the [P3 roadmap scope](../prototype-plan.md#p3-fill-and-stroke-meshes): multiple subpaths/holes, nonzero/evenodd fill, open/closed paths, required caps/joins, thin/extreme strokes and coverage-fringe/MSAA comparison. [Graphics architecture](../graphics-engine-architecture.md) owns algorithms and numeric policy; [system architecture](../../ARCHITECTURE.md) owns inward dependency direction. Dash editing remains in the roadmap's later editor coverage; P3.0b must explicitly resolve the dash design gate without silently adding runtime dash scope.

P2 already supplies local Float64 bounds and flattened paths, source provenance, a private batch/reserve ABI and owned adapter/cache results. Its fillRule/strokeStyleHash fields currently affect cache identity only. They are not implemented fill/stroke behavior. Preserve [P2 v1](p2-private-contract.md) rather than reinterpreting its output as triangles.

`packages/contracts/src/scene.ts` accepts primitives and containers, with a color/width stroke; it has no path node or cap/join contract. `packages/renderer-core/src/primitive-packet.ts` and the existing WebGPU path consume primitive packets. Thus private numeric mesh work can be planned independently, but end-to-end path integration requires a concrete scene/API proposal before changing those exported meanings. Do not hide a path API in primitive data or import geometry-wasm directly from renderer-core.

The composition root must inject geometry through plain contracts. Rust/geometry-wasm owns reconstructible geometry; renderer-core owns retained scene/order/cache coordination; renderer-webgpu alone owns GPU resources and its scheduler/device generation. No worker independently redesigns these boundaries.

## P3.0 planning acceptance

| ID  | Required result                                                                                                                        | Current status              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| C01 | D7 authority, measured revision, original FAIL and latest performance uncertainty linked consistently                                  | PASS P3.0a / PR #52         |
| C02 | Existing package/scene/ABI seams inspected; public path integration identified as a separate decision                                  | PASS P3.0a; no API selected |
| C03 | Exact private fill/stroke numeric semantics, combined error budget, work limits and error precedence fixed with deterministic fixtures | TODO P3.0b                  |
| C04 | Mesh ABI/version/layout, ownership, cache keys and stale/dispose behavior fixed without reinterpreting P2 v1                           | TODO P3.0b                  |
| C05 | Independent oracle, positive controls, corpus, commands and evidence rules fixed before corresponding implementation                   | TODO P3.0b                  |

P3.0a completes only after document checks, Primary review and protected integration. P3.0b completes only with C03-C05 and an explicit implementation readiness review. The downstream code tasks below are proposed dependencies, not authorization supplied by this docs-only D7 checkpoint; resolve implementation-entry scope and any API/product decisions after the contract is concrete. Unresolved choices remain blockers for affected work, not permission for workers to invent defaults.

## Next checkpoint: P3.0b contract and feasibility

Primary owns the [private-contract draft](p3-private-contract.md), the single owner of C03-C05 technical details. Its [visible semantics](p3-visible-semantics-proposal.md) were approved by the user after PR #53; technical C03-C05 obligations remain open. A Sol medium worker may independently inspect algorithm/numeric feasibility; a Terra medium worker may inventory analytic fixtures in disjoint test-only files after fixture requirements are fixed. Prefer read-only audit before allocating implementation workers. No recursive delegation by default.

Before implementation, specify:

- Fill topology: contour orientation, holes, nonzero/evenodd winding, implicit closure for fill versus open-path stroke, intersections, coincident/retraced edges, zero-area contours and deterministic treatment of boundary samples. Freeze ordinary-success versus intentionally rejected adversarial fixtures.
- Stroke meaning: local/world units, width, miter ratio/cutoff, cap/join construction, zero-length segments and closed seams. Identify any product decision requiring approval; do not assume new exported defaults. Resolve dash scope explicitly against the roadmap.
- Numeric policy: retain the total <=0.25 physical-pixel target through flattening, tessellation/round approximation and GPU conversion/projection. P2's complete 0.25 flattening allowance cannot also be spent independently by later stages. Define conservative budgets, screen transforms/zoom/DPR, precision guards and fail-closed behavior before accepting an algorithm. The current P2 adapter fixes the full 0.25 allowance, so it cannot simply be requested to supply a smaller share. Resolve this compatibility blocker explicitly: prove later stages fit the residual budget, define a separate P3 operation/budget, or seek the required decision for a P2 behavior change. Preserve P2 v1 meaning and include budget identity in affected cache keys.
- Bounded work: cap input edges, intersection/split work, triangles/vertices, scratch/output bytes and retries; specify inclusive limits and the first rejected operation. Ordinary frozen corpus must succeed; prevent blanket NUMERIC_RANGE/WORK_LIMIT from masking unsupported geometry.
- Private mesh transport: vertex position/coverage or edge-distance semantics, triangle winding/cull convention, fill/stroke range identity and paint order, overlap handling to avoid repeated alpha accumulation, coverage/blend behavior, version/operation identity, scalar types, offset units/alignment, index/range validation, bounds/source tokens, batch versus per-path errors, reserve/view invalidation, owned copies and terminal disposal. Decide an extension only after checking its effect on P2 v1 compatibility and tests.
- Cache/lifetime: geometry revision, fill/stroke geometry parameters and tolerance budget identity; color/opacity independence; latest-source publication; separate CPU mesh and GPU device generations; deferred GPU allocation reuse only after completion. Define transform-only reuse and affected-node bucket invalidation without changing shared backend lifetime ownership.
- Independent verification: analytic area/winding/cap/join cases and a separately implemented membership/error oracle; positive controls for wrong winding, missing/overlapping triangles, bad indices, nonfinite vertices, incorrect caps/joins and stale results. A screenshot or triangle-count comparison alone is insufficient.

Record a versioned deterministic corpus, all seeds and concrete transforms: nested alternating-winding contours, intersecting and coincident edges, degenerates, fractional translation/rotation, reflections/shears, zoom 0.01/1/64, DPR 1/2/3, and the roadmap's 1,000 paths x 32 cubics. Freeze exact numeric/raster comparisons and reference provenance before running acceptance. Do not add a reference library without the required dependency review.

Before choosing production fill topology, review feasibility on already-flattened line contours, especially intersections and coincident/retraced edges. Any executable spike needs a bounded non-accepting plan first and independent expected membership results; it cannot supply runtime acceptance or change public contracts. Freeze that review before P3.2 rather than letting a worker select an untested topology algorithm during implementation.

## Runtime acceptance coverage to freeze in P3.0b

These IDs reserve required evidence; they are not executable acceptance until C03-C05 supply exact fixtures, tolerances and commands.

| ID  | Required evidence                                                                                                         | Status                            |
| --- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| A01 | Valid mesh/index/range structure, deterministic failure isolation and bounded adversarial work                            | TODO                              |
| A02 | Both fill rules, holes, intersections and winding agree with independent analytic/membership and image fixtures           | TODO                              |
| A03 | Required caps/joins, open/closed paths, thin strokes and miter/degenerate cases match fixed semantics                     | TODO                              |
| A04 | Combined geometric error <=0.25 physical pixel across declared transforms/zoom/DPR, with rejecting positive controls      | TODO                              |
| A05 | ABI capacity/growth/view ownership, copied results, stale work, disposal and recreation                                   | TODO                              |
| A06 | Stable mesh reuse; only affected geometry rebuilds across revision/style/bucket changes; color/opacity avoid mesh rebuild | TODO                              |
| A07 | Ordered path/primitive integration, upload/resource lifetime and latest-scene device recovery                             | TODO; scene/API decision required |
| A08 | Headed Chrome/Edge corpus, coverage fringe versus MSAA comparison and reproducible evidence                               | TODO; visual contract required    |

P3 defines no new performance multiplier here. A later performance assertion requires its own prospective measured event/workload/environment/sample/threshold contract. D7 does not authorize changing P1/P2 metrics or using a functional run as performance evidence.

## Task graph and ownership

| Task  | Purpose and expected files                                                                     | Predecessors                                                        | Parallelism / owner                                                                        | Risk / model and effort                                       |
| ----- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| P3.0a | Entry decision, roadmap/navigation and this plan                                               | D7                                                                  | Primary; read-only independent review                                                      | Medium consistency; Primary                                   |
| P3.0b | Private contract, topology/error-budget feasibility and fixture specification under docs/plans | P3.0a                                                               | Primary single owner; bounded independent review                                           | High cross-module/numeric; Primary, Sol medium audit          |
| P3.1  | Independent mesh oracle/corpus in geometry-reference and test support                          | P3.0b                                                               | Oracle and positive controls precede production fill                                       | High verification; Sol medium; Terra medium analytic fixtures |
| P3.2  | Fill topology/tessellation in geometry-wasm/kernel private modules                             | P3.0b + P3.1                                                        | After independent oracle review; no shared ABI edits                                       | High algorithm/numeric; Sol high                              |
| P3.3  | Stroke mesh generation in geometry-wasm/kernel private modules                                 | P3.2 shared topology review + P3.0b                                 | Sequential by default until reuse boundary is proven independent                           | High degeneracy/overlap; Sol high                             |
| P3.4  | Mesh ABI/adapter/cache integration in geometry-wasm and tests                                  | P3.2 + P3.3                                                         | Single owner of engine/codec/adapter; no concurrent lifecycle edits                        | High ownership/regression; Sol high with Primary review       |
| P3.5  | Native/WASM/browser differential acceptance                                                    | P3.1 + P3.4                                                         | Independent audits after integration; validation commands may run separately               | High numeric interpretation; Sol medium; Primary acceptance   |
| P3.6  | Concrete path scene/port proposal, then ordered core/backend composition and coverage          | P3.0b for proposal; P3.5 + explicit API decision before integration | Primary owns contracts and lifecycle; only disjoint shader/fixture delegation after freeze | High API/lifecycle; Primary, Sol high bounded implementation  |
| P3.7  | Headed visual/cache/recovery corpus and milestone review                                       | P3.6 + frozen visual contract + valid environment                   | Serial hardware execution, then independent evidence audit                                 | High acceptance; Primary; Luna low command collection         |

```text
D7 -> P3.0a -> P3.0b -> implementation-entry scope review
                           -> P3.1 oracle -> P3.2 -> P3.3 -> P3.4 -> P3.5 --+
                    -> P3.6 API proposal -> decision ---------------------+-> P3.6 integration -> P3.7
```

The P3.1 oracle joins P3.4 implementation at P3.5. Each integrated work unit uses its own protected PR. Task subdivision may change as feasibility becomes concrete; requirements, ownership and acceptance cannot silently change with it.

## Validation and next execution batch

For P3.0a/P3.0b documentation: explicit changed-Markdown formatting, local path/anchor checks, whitespace, source-of-truth and source-claim review; required PR static/unit/build CI. Local product tests, browser/GPU runs and benchmarks are NOT RUN for planning-only changes. Any numeric feasibility script must preserve source/inputs/results and be labeled feasibility, not implementation acceptance.

After P3.0a integration, the next executable batch is P3.0b: Primary contract draft and one independent Sol medium feasibility audit. The proposed first code checkpoint is P3.1 after contract freeze and implementation-entry scope resolution; production P3.2 additionally waits for its independent oracle and positive-control review; coordinate shared build/exports/test configuration through Primary. Final milestone completion requires all applicable A01-A08 evidence; integration alone does not pass a gate.

## P3.0a local review

Base: clean `b4316201af38af5afda36379ba5e3088b3cdf686`, equal to fetched origin/main. Primary wrote the D7 decision and execution/navigation documents. One GPT-5.6 Sol worker, medium reasoning, independently audited the existing seams and draft read-only; no child delegation. Primary checked the scene union, private geometry ownership, error-budget gate and archived aggregate directly. Review corrections make oracle validation precede production fill, reserve an explicit later implementation-entry scope review, name the private-contract owner, and add mesh coverage/order plus the fixed-P2-budget compatibility blocker. Its ten rows retain original FAIL, paired medians above 1.00 and the six documented p95 failures. PR #51's merged SHA and successful required check were verified separately; contemporaneous evidence files remain unchanged.

Local checks: explicit Prettier check for the six changed Markdown files PASS; the existing local-link/anchor check documented in the P1.0b review PASS (481 links across 90 Markdown files); `git diff --check` PASS. Source-of-truth review keeps D7 limited to entry, leaves C03-C05 unresolved and preserves product requirements, public exports, dependencies, evaluator and immutable observations. Local product/build/browser/GPU/benchmark runs are NOT RUN for this documentation-only checkpoint. Required CI passed on `8679645886c3cdb612c69715fb86aca57edd9a53` (run 36246634960); protected PR #52 integrated as `4928a88eb45ef3f4b1d4716e432a2a1fe9eca358`. P3.0a is complete.

## P3.0b preparation review: 2026-09-29

Base: clean `4928a88`, equal to fetched origin/main. Primary prepared the private-contract draft and visible-output proposal; one GPT-5.6 Sol worker with medium reasoning independently audited feasibility and reviewed the documents read-only, with no child delegation. Code inspection confirms both P2 flattening and P1 GPU precision independently permit the full 0.25 physical-pixel budget. The draft preserves those contracts and identifies separate P3 operation/budget and mesh-specific precision work.

The reviewed candidate includes independent winding/analytic fixtures, explicit ownership and cache obligations, and bounded topology feasibility. Primary did not adopt unproven worker suggestions for a single fill/stroke union paint, an inside-only coverage ramp, or arbitrary work caps. Those would not establish color/edge correctness or ordinary-corpus feasibility. C03-C05 remain incomplete; no ABI, numeric/visual acceptance or product implementation is falsely marked frozen.

The next dependent step is the concrete visible-semantics decision. Remaining technical work is topology/continuous-stroke/packing/fringe feasibility and exact transport/work-limit/corpus freeze; an approval of visible semantics alone does not pass these gates. Local documentation validation and protected CI results are recorded on this checkpoint PR. No local product/build/GPU/benchmark run is claimed for this preparation-only checkpoint.

### Independent closed-contour topology experiment

While the visible decision is pending, a bounded non-accepting experiment may test only the closed integer-coordinate fill fixtures F01-F07/F09-F11 in the private draft, including both orientations for F10. Exclude open contours, stroke, cubic flattening, ABI, renderer, GPU and benchmark work. This uses existing approved nonzero/evenodd meaning, not a proposed cap/closure behavior.

Method frozen before execution: an ignored standalone Node script under `.tools/p3-0b-*` uses exact BigInt rational arithmetic to enumerate intersections and vertical event slabs, group directed crossings and emit disjoint trapezoids for each fill rule. Input coordinates remain literal integers. An independently coded direct ray-crossing oracle checks rational points strictly within/outside each resolved interval, skipping source-edge points; exact analytic fixture areas validate total area. Check sorted nonoverlapping interior intervals and independent expected shared-edge interior samples. Positive controls remove one nonzero-area cell and duplicate one cell; area and multiplicity checks must reject them. Do not import production helpers or copy the future Rust implementation.

Bound this experiment to 16 directed source edges per fixture, 120 pair tests per fixture, 256 x events and 4,096 emitted cells per rule. Count actual pair/event/cell work and fail before exceeding a bound. All fixture cases must match their exact rational area and sample membership; unhandled numeric/algorithm cases fail the experiment, not silently skip. These small-input experiment limits are not proposed production limits or evidence that the 1,000-path cubic stress scene fits.

Archive source, raw JSON observations, invocation/base revision, hashes and Primary review under `docs/evidence/p3.0b/`. Outcome is feasibility-only and leaves C03-C05/runtime acceptance incomplete even if every fixture agrees. Exact rational Node arithmetic does not prove robust Float64 Rust predicates or browser performance. Primary owns scope/interpretation; a single Sol medium worker may implement only the ignored diagnostic script, with no child delegation.

Local outcome: [archived tool, raw result and Primary review](../evidence/p3.0b/README.md) record FEASIBILITY_ONLY PASS for 12 closed-contour variants / 24 rule cases, 60 literal and 516 generated probes, four shared-edge interior cases and two rejected corrupt outputs. Maximum work is 8 edges / 28 pair tests / 4 events / 4 cells. Primary corrected event-column membership, separated F09 variants and required interval probes before the first execution; independently checked all raw areas and byte hashes afterward. C03-C05 remain incomplete and the visible-semantics decision is still pending.

Local documentation validation: explicit Prettier check of four changed Markdown files and the new archive manifest PASS; local link/anchor checker PASS (496 links across 93 Markdown files); whitespace and source/raw archive review PASS. Product, dependency and historical-result scope review found no changes. Required CI passed on `38b12da1fd2aa2a008c272b1f7f67a6283ca39b3` (run 36557040749); PR #53 integrated as `7bf9a17d6c7907c34c24f0d26aefea3d9e5ad88c`. P3.0b itself is not complete.

## Approved visible behavior and P3.1a slice: 2026-09-29

The user replied to the concrete visible-output question after PR #53 with an instruction to proceed. The [visible-semantics decision](p3-visible-semantics-proposal.md) is approved; the earlier preparation/evidence text remains historical. No further approval is needed for those same choices. The user's ongoing authorization permits ordinary task refinement inside the roadmap without expanding product scope.

Primary separates a test-only line-membership subset, P3.1a, from the full P3.1 oracle. Its [contract](p3-line-oracle-contract.md) freezes input/error limits, exact represented-number semantics, resolved boundary behavior and L01-L08 evidence before code. It depends on approved fill semantics and that slice contract, not the still-open stroke/fringe/mesh ABI. This replaces only the full P3.0b prerequisite for P3.1a; production P3.2-P3.6 and the remaining P3.1 work retain all relevant contract/oracle gates. No runtime acceptance or performance threshold is weakened.

```text
approved visible behavior -> P3.1a contract -> independent line oracle + literal fixtures
                           -> focused/root validation -> Primary review -> protected PR
P3.0b remaining stroke/topology/coverage/ABI freeze -> remaining P3.1 -> production gates
```

Base is clean `7bf9a17`, equal to fetched origin/main. Primary owns shared exports, docs and integration. Sol high owns only `packages/geometry-reference/src/line-fill.ts`; Terra medium owns only `tests/unit/geometry-line-fill.test.ts`. Their interface is frozen before parallel work. No child delegation. This is test-only infrastructure in the existing independent reference package, with no new dependency or public editor/renderer API.

### P3.1a local acceptance

The [Primary review and evidence](../evidence/p3.1a-line-oracle-review-2026-09-29.md) map L01-L08 to the independent literal fixtures. Focused Vitest passes 12 tests; `pnpm check` passes formatting, lint, TypeScript, 327 tests across 44 files and dependency boundaries; `pnpm build` passes workspace packages and production playground. Primary corrected fixture isolation/coverage and the F08 implicit-edge coordinate description; the initial unnecessary-type-assertion lint failure was repaired and the complete check rerun successfully. No product API/dependency/lifecycle changes or historical artifact edits are included.

Explicit Prettier check of the six changed Markdown files PASS; existing local-link/anchor checker PASS (508 links across 95 Markdown files); `git diff --check` PASS. Protected CI and integration are still required for checkpoint completion. Browser/GPU/native-WASM/benchmark commands are NOT RUN locally for this test-only TypeScript slice. Full P3.0b C03-C05 and remaining P3.1/production gates remain open. Next technical work is continuous stroke error and the remaining topology/coverage/transport freeze.

Protected outcome: required CI passed on `9e596df882dfef1402e92c118dec1136f6b2c8c1` (run 36559942597); PR #54 integrated as `f040265d5d5963b77e83655a8b6e1019a7797220`. P3.1a is complete. Its contemporary evidence remains unchanged.

## P3.0b-s1 regular stroke analytic review

Base: clean `f040265`, equal to updated origin/main. This is the next documentation-only subset of P3.0b, not a new runtime scope. Primary owns the [certificate note](p3-stroke-boundary-certificate.md) and private-contract link. One GPT-5.6 Sol worker, medium reasoning, audits existing P2 code and the derivations read-only; no additional delegation. The earlier P3.1a implementation/fixture workers do not edit this checkpoint.

Acceptance is a reviewed regular-leaf sufficient condition, independently derived continuous-verifier bound, exact dyadic centerline-only counterexample and explicit remaining numerical/topology/semantic obligations. The note contains the detailed proof and its limitations. It authorizes no executable experiment before outward guards, limits, input envelope and independent fixtures are frozen. Product behavior, public API, dependencies, source code and historical evidence remain unchanged.

Dependency order is: P3.0b-s1 analytic review -> prospectively frozen bounded arithmetic/corpus experiment -> observed feasibility and remaining stationary/join/topology/coverage obligations -> C03-C05 freeze -> remaining P3.1 and production tasks. No runtime gate is satisfied by an analytic formula alone. Local validation for this docs-only checkpoint is explicit Markdown formatting, links/anchors, whitespace and Primary/source-of-truth review, followed by protected CI.

Local outcome: independent audit and Primary review found no mathematical or semantic must-fix; the worker's statement that raw offset bounds do not establish resolved-region topology is retained explicitly. Prettier check of the three changed Markdown files PASS; local link/anchor check PASS (515 links across 96 Markdown files); `git diff --check` PASS. Local product/unit/build/native/browser/GPU/benchmark runs are NOT RUN for this subsequent docs-only revision; the preceding P3.1a results are historical evidence, not claimed as reruns here. Required remote CI/integration remain pending for this checkpoint. C03-C05 are still incomplete.

Protected outcome: required CI passed on `02ae4b794b013c35197513166be6e4bd50358634` (run 36560657591); PR #55 integrated as `5f163017a3e56ed0dfec709006f6ac9d1615a9d3`. P3.0b-s1 analytic review is complete.

## P3.0b-s2 bounded numerical feasibility

Base: clean `5f16301`, equal to fetched origin/main; branch `codex/p3-0b-stroke-numeric-feasibility`. Primary selects the [bounded experiment](p3-stroke-numeric-experiment.md) as the next dependency after s1. It freezes exact rational/outward arithmetic, candidate and separately derived verifier, 62 literal cases, five rejecting controls, finite work limits and immutable evidence before execution. A Sol medium read-only audit precedes implementation; a Sol high worker may own only the ignored standalone tool. Primary owns documents, execution, archival, result interpretation and integration. No further delegation or product source changes.

The 20-case minimum success set is an experimental sanity check; all other regular results stay visible, and any uncertified regular case makes candidate-wide feasibility PARTIAL. This does not satisfy the complete ordinary P3 corpus, prove Float64 production guards or settle stationary/join/topology/coverage/ABI work. Existing acceptance thresholds and historical measurements remain unchanged.

Before implementation, the independent audit required explicit physical endpoint-error units, absolute depth/visit limits, failure precedence, traversal order, exact output encoding and complete control carriers with geometric rejection. Primary resolved those points in the contract. A proposed larger square-root bit envelope was not adopted: Primary proved the correlated products fit the existing envelope and the auditor agreed. Contract review then found no remaining must-fix. No experiment had run at that point.

Local experiment outcome: [source, raw results and Primary review](../evidence/p3.0b-s2/README.md) record experimental completion PASS and candidate-wide feasibility PARTIAL. The first and only execution preserved all 62 outcomes: 50 regular cases independently certified <=1/8 physical pixel, nine candidate-node-cap outcomes (R4/R5/R6, zoom64, DPR1/2/3), and three stationary unsupported probes. All 20 minimum sanity cases and five rejecting controls passed. The failed cases publish no partial path, and all caps/first failing intervals remain visible. No tolerance or cap was changed after observing results.

Before execution, Primary/independent source review corrected candidate-depth trust, incomplete failure provenance, guard test coverage and arithmetic-validation order. Primary's separate raw audit and the independent worker's read-only result audit both passed, including exact upper-bound comparisons, corpus/matrix metadata, output suppression and source/contract hashes. No rerun was necessary. The observed limiting mechanism is candidate visit 1024 after the allowed 1023 visits, not observed geometric error above the target. Next technical work is a tighter continuously justified candidate bound under a new prospective experiment; stationary/topology/coverage/transport and C03-C05 remain open.

Local validation: syntax checks of diagnostic/capture/audit PASS; `node .tools/p3-stroke-capture.cjs p3-stroke-numeric-run-01` exit 0; `node .tools/p3-stroke-audit.cjs .tools/p3-stroke-numeric-run-01` PASS. Manifest verification of seven archived files and decompressed raw bytes PASS; restoring the archived data and running the archived audit also PASS without rerunning the experiment. Explicit Prettier check of four changed Markdown files PASS; local link/anchor check PASS (534 links across 98 Markdown files); `git diff --check` PASS. Local runtime unit/build/native/browser/GPU/benchmark commands are NOT RUN because no product source changed. Protected CI/integration remain required for checkpoint completion; candidate-wide feasibility remains PARTIAL independently of that workflow outcome.

Protected outcome: required CI passed on `089039348d5e1dba40a16c3f22849f9c046170de` (run 36564332601); [PR #56](https://github.com/npclown/vector-studio/pull/56) integrated as `28d815b6e2e96277ea09bf03b450f00b9538b7db`. P3.0b-s2 experimental checkpoint is complete; its candidate-wide feasibility remains PARTIAL.

## User deferral and independent P3.1b entry: 2026-09-29

The user instructed that the current error-refinement work be left for later and work move forward. Defer the proposed tighter regular-stroke candidate bound and its follow-up numerical experiment. No s3 implementation or measurement was started. Preserve the s2 observations: nine cases exhausted candidate work before certification; they are not measured error violations or newly certified successes. Historical artifacts, the total physical error target and final runtime acceptance remain unchanged.

Deferred follow-up: revisit the conservative stroke-bound/work tradeoff, production Float64 guards and the uncertified ordinary cases when resuming stroke numeric readiness. Do not automatically reopen that precision-only iteration ahead of independent work. This scheduling decision does not resolve stationary/join behavior or permit coarse successful production output. C03-C05 and dependent production gates retain their unresolved items.

Primary selects P3.1b, the [triangle-mesh invariant oracle contract](p3-mesh-oracle-contract.md), as the next independent slice. It checks malformed structure, orientation, bounds, overlapping interiors and optional exact analytic area on a plain test carrier. It does not choose a production ABI, GPU culling, fringe or public path API. Complete region equivalence remains separate; equal area alone is insufficient. This replaces the full P3.0b prerequisite only for the frozen M01-M06 test-only slice, like P3.1a; all affected production prerequisites remain.

```text
P3.1a + frozen P3.1b contract -> mesh invariant oracle + independent fixtures
                            -> local validation -> Primary review -> protected PR
deferred stroke refinement ---------------------> future stroke numeric readiness
remaining topology/coverage/ABI + full oracles --> production P3.2-P3.7 gates
```

Base: clean `28d815b`, equal to fetched origin/main; branch `codex/p3-1b-mesh-oracle`. Primary owns contract, exports, documentation and integration. Sol high owns only `triangle-mesh.ts`; Terra medium owns only `geometry-triangle-mesh.test.ts`, with no recursive delegation. Acceptance is M01-M06 plus focused/root validation, Primary review and protected CI. No stroke experiment or benchmark is run in this slice.

### P3.1b local acceptance

The [Primary review and evidence](../evidence/p3.1b-mesh-oracle-review-2026-09-29.md) map M01-M06 to literal fixtures and the normal 256-triangle work boundary. Focused Vitest passes 13 tests; `pnpm check` passes formatting, lint, TypeScript, 340 tests across 45 files and dependency boundaries; `pnpm build` passes workspace packages and the production playground. Primary reviewed exact binary64 arithmetic, separating-edge overlap checks, validation precedence and test-carrier independence. Fixture corrections and the intermediate helper-rename failure are preserved in the review; stable-source validation passes.

Explicit Prettier check of the four changed Markdown files PASS; local link/anchor check PASS (541 links across 100 Markdown files); `git diff --check` PASS. No runtime/API/dependency/lifecycle change or historical-result edit is included. Local native/WASM/browser/GPU/benchmark commands are NOT RUN for this independent TypeScript slice. Protected CI/integration still apply. Further stroke-bound refinement remains deferred; the next independent technical work is line-region coverage/topology verification and remaining coverage/transport contract preparation.

Protected outcome: required CI passed on `42d8a3ac3b66619b802d3c7dcac64c6694932a3e` (run 36566409383); [PR #57](https://github.com/npclown/vector-studio/pull/57) integrated as `0b991e8d751da2bb8cb4a5fffa7e0bf838c8109f`. P3.1b is complete within its invariant-only scope.

## P3.1c independent line-fill region equality

Base: clean `0b991e8`, equal to fetched origin/main; branch `codex/p3-1c-fill-region-oracle`. The user's continued-work instruction authorizes proceeding directly from integrated checkpoints to executable independent tasks. Primary selects the [P3.1c contract](p3-fill-region-oracle-contract.md): compare a supplied triangle mesh with the entire regularized source line-fill region, closing the known equal-area/wrong-region gap in P3.1b. Frozen rational arrangement cells provide complete coverage inside the bounded test-carrier envelope, rather than a finite arbitrary grid.

This test-only slice depends on P3.1a/P3.1b and its own contract; it does not depend on deferred stroke refinement or choose a production mesh layout. Primary owns the contract, exports, review and integration. Sol high first audits the contract and then owns only `fill-region.ts`; Terra medium owns only `geometry-fill-region.test.ts` with literal expected meshes. No recursive delegation. R01-R06, focused/root checks, Primary review and protected CI are required before completion.

```text
P3.1a + P3.1b -> P3.1c frozen contract -> independent implementation + literal fixtures
                                      -> Primary review + validation -> protected PR
remaining production topology/coverage/ABI contracts -> affected runtime gates
stroke-bound refinement remains a deferred follow-up
```

No test-only limit becomes a production work cap, and exact line-region equality does not prove an unflattened cubic/stroke or coverage/shader result. P3.0b C03-C05, remaining P3.1 and runtime acceptance remain open.

### P3.1c local acceptance

The [Primary review and evidence](../evidence/p3.1c-fill-region-review-2026-09-29.md) map R01-R06 to independent analytic fixtures and rejecting controls. Focused Vitest passes eight grouped tests; `pnpm check` passes formatting, ESLint, TypeScript, 348 tests across 46 files and dependency boundaries; `pnpm build` passes workspace packages and the production playground. Primary corrected the internal/external unit correspondence and literal fixture construction/limits before the first stable-source test run, then reviewed all exact intersection and membership logic.

Explicit Prettier check of four changed Markdown files PASS; local links/anchors PASS (550 links across 102 Markdown files); `git diff --check` PASS. Local native/WASM/browser/GPU/benchmark commands are NOT RUN for this test-only slice. Protected CI/integration remain required. Next work is fill-only private numeric implementation readiness, including independent production predicate/topology evidence and concrete work limits; it does not resume deferred stroke-bound refinement or bypass public path/renderer decisions.

Protected outcome: required CI passed on `0ef46402b45cf56584f1294b65b3a0a93b042858` (run 36570238712); [PR #58](https://github.com/npclown/vector-studio/pull/58) integrated as `62c53bcad9822d40790f2ef837c6cee477d9efcc`. P3.1c is complete within its frozen small-carrier envelope.

## P3.2a isolated private fill predicates

The user's later continuous-work authorization covers ordinary private implementation within the approved roadmap after its acceptance is frozen. Primary therefore refines only the prerequisite of this narrow slice: the [predicate contract](p3-fill-predicates-contract.md) and independent exact fixtures precede implementation, while full P3.0b/P3.1 remains required for affected tessellation/transport/renderer work. The older D7 planning-only checkpoint did not itself authorize this code; this entry follows the subsequent execution instruction and changes no product scope, architecture, public API, dependency or acceptance target.

Base: clean `62c53bc`, equal to updated origin/main; branch `codex/p3-2a-fill-predicates`. Implement exact orientation, point-on-segment and closed-segment relation in one allocation-free private Rust module. Intersection-coordinate construction, event sorting, triangulation, mesh allocation and integration remain outside this slice. P2 v1 does not call the new module and gains no export.

A Sol medium read-only readiness audit confirmed the fixed 4224-bit capacity proof and recommended including segment predicates as the reusable topology boundary. Primary rechecked the proof and retained independent fixture generation using the different BigInt difference formula. Sol high owns only the Rust implementation; separate Sol medium owns generator/corpus/native fixtures. Primary owns crate/test wiring, existing runner integration, evidence, review and gate interpretation. No child delegation.

```text
reviewed predicate contract + independent expected bits -> private Rust fill predicates
    -> native zero-allocation/differential tests + existing P2 regressions -> protected PR
predicate foundation -> later intersection placement/event ordering/topology contracts
full ordinary corpus + remaining C03-C05 -> downstream tessellation/ABI/renderer gates
```

The 32-unit reference envelope does not select production path limits. This checkpoint proves only its P01-P06 predicates, not full fill tessellation or product-scale geometry. Deferred stroke refinement stays deferred. Public path/port and visible coverage changes still require concrete decisions before implementation.

### P3.2a local acceptance

The [Primary review and evidence](../evidence/p3.2a-fill-predicates-review-2026-09-29.md) map P01-P06 to exact bit-pattern and native fixtures. Independent generator byte check PASS (4112 rows); all six permutations PASS (24672 sign checks). `pnpm test:geometry` passes Rust fmt/Clippy, 33 native tests, independent release WASM hashes and 25 differential/adapter tests. Repeated predicate success/error calls record zero heap allocations; output export inspection finds no new WASM function. Existing P2 engine/codec/adapter source is unchanged.

`pnpm check` passes formatting, lint, TypeScript, 348 tests across 46 files and boundaries; `pnpm build` passes. Explicit Prettier check of four changed Markdown files PASS; local link/anchor check PASS (558 links across 104 Markdown files); `git diff --check` PASS. Primary and a read-only Sol medium source audit found no predicate defect. Primary corrected a literal crossing expectation, allocation assertions, a test Clippy style issue and runner formatting before final acceptance; the review preserves those outcomes. Local browser/GPU/benchmark runs are NOT RUN and no performance claim is made. Protected CI/integration remain required. Next technical work is intersection-coordinate placement/event ordering and bounded fill topology contracts, retaining all full-corpus obligations.
