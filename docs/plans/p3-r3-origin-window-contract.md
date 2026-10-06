# P3.1m R3 mesh-origin window contract

Status: FROZEN, 2026-10-06, after independent Astra high review: round 1 NOT FREEZE-READY, revision 2 FREEZE-READY, with its two non-blocking clarifications applied. Implementation is authorized after integration. It is the first unit of the user's [U2 direction](p3-u2-failure-path-proposal.md) (R3, then R0, then R2). The [private contract](p3-private-contract.md) owns C04, and the [active plan](p3-fill-stroke-meshes.md) owns status.

This is a test-only selection of the physical-window target for the U3 mesh-specific origin. It uses the integrated [position certificate](p3-position-certificate-contract.md) unchanged. It selects no runtime lanes, layout, rebase accounting, rejection or requirement change.

## Question

O-PX used a 1024-pixel target, so `‖F‖·z·q ≤ 2048` px. That rejected 12 rows the fixture origin admits (class D). R3 asks a single question: which target T restores every fixture-origin admission, and how many rebases does each target cost on fixed trajectories? Both answers are fixed before any result is seen.

## Policy family

`O-PX(T)` is the certificate contract's O-PX with the constant 1024 replaced by T:

- `g_T = 2^floor(log2(T / (z * q)))` document units. It is computed exactly in rationals from `q(fround(zoom)) * q(fround(dpr))`, as `originPX` does.
- `O = g_T * floor(c / g_T)` per axis.
- O is kept while each camera-axis displacement is at most `2 * g_T` and g_T is unchanged. Otherwise O is re-snapped.
- Hence `‖F‖·z·q ≤ 2T` per axis.

The candidates are `T ∈ {1024, 512, 256, 128, 64}`.

For T = 1024, `originPXTarget` equals `originPX`, and the result matches the archived O-PX record on all 158 fixture rows. The match covers origin, g, status, reason, the exact `delta2Max`, the window half-width `2g` and the window admission. Literal O-PX rows are excluded.

## Prospective selection rule

`ADM` is the set of the 158 fixture rows that the integrated certificate admits at the fixture origin: 127 rows, read from the [archived report](../evidence/p3.1m-position-certificate/report.json), whose SHA-256 is asserted. ADM excludes both class A stress rows (fixture `position:0`), so no exemption applies.

For each T, every fixture row is evaluated at its fixture camera with origin `O-PX(T)`, computed with no previous state. A candidate qualifies when both conditions hold:

- **S1:** `certifyPosition` admits every row in ADM.
- **S2:** for every row in ADM, `certifyWindow(input, O, 2 * g_T).windowAdmitted` is true, **and** the M04 clearance test passes with `δ̄ = sqrtUp(max_v (ewx_v^2 + ewy_v^2))`.
  - `r3-window.ts` implements this window clearance test from the exported `clearanceSummary`, `sqrtUp` and `q`.
  - A unit control asserts that, with pointwise δ, it reproduces `certifyPosition`'s clearance term on all 158 fixture rows at their fixture origins.

The selected target is the largest qualifying T. The candidates are distinct and the order is total, so ties cannot occur. If no candidate qualifies, nothing is selected: the result is reported and escalated to Primary review, and T is never tuned after seeing results.

For every T the report records the minimum clearance slack over ADM, under both pointwise and window δ. Slack is the smallest `LHS − RHS` across the M04 terms, taken in check order, for that term's comparison; for example `σlo²·dV2 − 4δ̄²`. It is reported as an exact rational plus an approximation, with its term and row id. It is an observation and does not affect the selection.

The prospective literal rows (P1-CANCEL-64, PX-CANCEL-64, WIN-EDGE) are re-evaluated under the selected T and reported only; the selection does not depend on them. The result uses the integrated whole-mesh domain, not U1's visible-plus-guard domain, so it does not restate U1. Class A remains with R2.

**Disclosure.** The independent reviewer of revision 1 ran a read-only float-approximate estimate. It showed that revision 1's S2 checked window position but not window clearance, and would have selected T = 512 even though 24 ADM rows fail clearance at cameras inside the window. The added window-clearance term is required for soundness whatever the outcome. The estimate counted window-δ clearance failures over ADM: 24 at T = 512, 8 at T = 256 (W S7 ×4, Z star/zero-closure S0 ×4), and 0 at T = 128 and T = 64. A pointwise check at the window-corner cameras gave the same counts. S1 and window position passed for every T ≤ 512. The estimate used a float-approximate g_T, its scripts are not part of the evidence, and its numbers are not acceptance targets. The rule and its candidate set were not otherwise changed after that estimate, and the exact evaluation remains the evidence.

## Rebase-count observation

Rebase counts are observations only, with no threshold. They are counted for O-P1 and for every candidate T on these trajectories:

| ID      | Trajectory                                                                                                                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TR-PAN  | For each (zoom, DPR) in {(0.01, 1), (1, 1), (1, 2), (64, 2)}: frames k = 0..1023 with camera `x_k = k * 4 / (zoom * dpr)`, evaluated in binary64 from the literal zoom and DPR and not accumulated; y = 0 |
| TR-ZOOM | Camera fixed at (1000.5, -300.25), DPR 1; zoom `fround(2 ** (-7 + 13 * k / 511))` for k = 0..511, evaluated in binary64                                                                                   |
| TR-N03  | The N03P and N03N camera sequences from `originSequences()` in `corpus.ts`, at zoom 1 and DPR 1                                                                                                           |

**Counting rule.** Frame 0 derives its origin with no previous state and is not counted. For each k ≥ 1:

- count the frames whose origin differs from frame k − 1;
- separately, count the frames whose g differs from frame k − 1.

For O-P1 the g count is reported as n/a.

**Cost model, stated rather than measured.** A rebase changes each live mesh's anchor lanes (`A·m + t − O`) and requires the certificate to be re-evaluated (M02). Two things remain open C04 items: whether frame lanes are per mesh or per view, and the byte and CPU cost. No budget is implied.

## Evidence and validation

**Ownership.** All of this is owned by Primary, with no recursive delegation:

- `tests/geometry/position-certificate/r3-window.ts`, which exports `originPXTarget(camera, zoom, dpr, target, previous?)` and the trajectory generators;
- `tests/geometry/position-certificate-r3.test.ts`.

The new code imports `certifyPosition` and `certifyWindow`, the fixtures and the archived report. It does not modify `certificate.ts` or the archived report.

**Report.** The test regenerates `docs/evidence/p3.1m-r3-origin-window/report.json` and requires a byte-for-byte match. It is written only when the test runs with `P3_R3_WRITE=1 pnpm test:geometry`. The report contains:

- for each T: its S1 and S2 results, with failing ids;
- the selected T, or none;
- the rebase counts;
- the minimum clearance slacks;
- the SHA-256 of each hashed source: `r3-window.ts`, the R3 test, `certificate.ts`, `corpus.ts`, `rounded-fill/exact.ts`, and the archived P3.1m report.

The report contains no timing fields. A test asserts that `certificate.ts` and the archived P3.1m report are byte-unchanged, by their pinned SHA-256.

A review record accompanies it.

**Validation commands.** `pnpm check`, `pnpm test:geometry` and `pnpm build`. No GPU run.

An independent review checks the selection, the counts and the absence of any post-result tuning.

**Dependency order:** `U2 decided -> this contract FROZEN -> implementation -> review -> evidence`. The selected T is a planning input for the C04 mesh-origin lanes. It is not adopted runtime behavior.
