# V-4 contract: A08 headed corpus page (coverage fringe versus MSAA)

Status: APPROVED 2026-10-24 by the user in chat, with VZ4-Q1 to VZ4-Q7 as recommended (independent review round 3 READY, sections 12 to 14). V-4 code may start once its section 9 dependencies (E10, the E3 freeze and the E3-U3 harness) exist.

Track: visualization. Item: V-4 of the [D9 visualization track plan](d9-visualization-track.md#status-index), phase R1 of [D10](d10-roadmap-reset.md). Tier: full, because V-4 supplies exit evidence for a P3 acceptance criterion and needs test hooks that the rendering track publishes (section 2). Structural model: the approved [V-3 contract](viz-v3-a07-integration-contract.md).

Source of the item: [D9-Q2 (a)](d9-post-mvp1-tracks-proposal.md#user-decisions-2026-10-22) makes the visualization track supply the headed page for A08, and the [P3 exit evidence index (X1)](d9-rendering-track.md#p3-exit-evidence-index-x1) lists A08 as "headed page from the visualization track". A08's text, in the [P3 acceptance table](p3-fill-stroke-meshes.md#runtime-acceptance-coverage-to-freeze-in-p30b), is "Headed Chrome/Edge corpus, coverage fringe versus MSAA comparison and reproducible evidence". Its visual contract is fixed by [V3 section k](p3-v3-renderer-mesh-pipeline-contract.md#k-a08-visual-contract) and is not restated or changed here.

This contract owns V-4's corpus selection, page design, capture, offline metrics, acceptance criteria and validation. It changes no requirement, threshold (Q4, Q9), milestone order, gate, port, ABI or `packages/contracts` export. Where the drawn position is uncertain (section 5.2), a pixel is left UNDECIDED rather than judged against a widened class, so Q4's 2 px and 1 px classes stay as written. Criteria are VZ4-A1 to VZ4-A12 and questions VZ4-Q1 to VZ4-Q7.

## 1. Scope

### 1.1 In scope

1. One headed playground page that renders the A08 corpus of section 3 through the product path: the release WASM `createFillMeshPort`, `PrimitiveRendererService` and `WebGpuBackend`, in three render variants per case (section 4).
2. Exact physical-pixel capture of every rendered case and variant, and of the per-sample coverage counts that G3 needs, through the hooks of section 2.
3. An offline metrics runner that evaluates O02's G1, G2 and G3 ([O02 contract, Oracles and acceptance](p3-o02-a5-coverage-contract.md#oracles-and-acceptance)) on the captures against an independent reference boundary (section 5), with byte-identical replay.
4. A committed evidence record under `docs/evidence/` and its link in the X1 row of A08.

### 1.2 What V-4 evidences of A08, and what remains

V-4 produces the A08 headed evidence: Q4 (G1, G2) and Q9 (G3) on the fringe at 1x and 4x, and the MSAA-only baseline as a report. Section k and the [D8 carve-out](p3-private-contract.md) say that A08 evidence **counts only after C03-C05 are complete, on the frozen layout and carrier**. V-4 does not decide when that holds. Every V-4 run before it holds is labelled `PRE-FREEZE` and closes nothing ([VZ4-Q1](#8-open-questions)). Whether the evidence closes A08 is the Primary's exit decision.

Precision stays UNVERIFIED against the 0.25 physical-pixel target until E3 has A04 evidence. V-4 measures coverage, not position; it makes no A04 claim and no performance claim.

### 1.3 Deferred and out of scope

- Strokes are captured and reported, not gated: section k fixes the visual contract for fill only ([VZ4-Q4](#8-open-questions)).
- DPR 3 is observed only, as section k says.
- Gradients, dashes, clip and mask (P4) and every editor feature (P5).
- Any renderer, kernel or shader change. A defect found by V-4 is filed as a rendering-track item with its case as the fixture.

## 2. Dependencies and shared surface

V-4 needs three things that do not exist today. The page cannot obtain them from the published surface: `PrimitiveRendererService` always installs the fringe builder (`packages/renderer-core/src/primitive-renderer-service.ts`), the backend always tries 4x and falls back to 1x (`packages/renderer-webgpu/src/native-primitive-scene.ts`), and the only frame access is a compositor screenshot, which V-3 used with a probe tolerance and which cannot carry a 2/255 gate.

| ID | Need | Owner |
| --- | --- | --- |
| VZ4-D1 | The frozen corpus `a04-corpus/v1`: E3 freeze record per [E3 section 5.5](d9-e3-b4-precision-contract.md#55-freeze-procedure-and-blindness) | Rendering track, E3 |
| VZ4-D2 | Test-only render options: force `sampleCount` 1 or 4 (failing, not falling back, when 4x is unavailable), and a fringe-off mode that draws region triangles with `c = 1` and no exterior triangles (section k's MSAA-only variant) | Rendering track, new item E10 |
| VZ4-D3 | Test-only exact readback of the presented frame in physical pixels, and the O02 count pass on the same vertex stage, buffers and draw ranges (1x center count; 4x per-sample count via `textureLoad`) | Rendering track, E10 |
| VZ4-D4 | C03-C05 complete, for the evidence to count (not for the page to run) | Unassigned today ([VZ4-Q1](#8-open-questions)) |
| VZ4-D5 | E3-U3's harness: the exact K4 mapping model `p*`, the bound `β_c` and the clipping model of E3-Q11 (a) ([E3 section 9.1](d9-e3-b4-precision-contract.md#91-units)) | Rendering track, E3 |

D2 and D3 add published `…ForTesting` members to `renderer-core` or `renderer-webgpu`, as `destroyDeviceForTesting()` is. That is a shared-surface change: E10 is full tier under its own short contract, reviewed by both tracks. V-4 itself edits no file under `packages/` and adds no dependency.

## 3. The A08 corpus

The A08 corpus is a declared subset of the frozen `a04-corpus/v1`, so A04 and A08 measure the same geometry. It is identified by the A04 `corpusSha256` plus the subset rule below. A manifest `tests/visual/viz-v4/a08-subset.manifest.json` lists the case keys and its SHA-256. A case key is the A04 case key of the row, transform and `z = 1` pair, plus the V-4 DPR; for DPR 1.5, which A04 lacks, the key is the DPR 1 A04 key with `dpr = 1.5`.

| Part | Rows | Transforms | DPR | Role |
| --- | --- | --- | --- | --- |
| Named fill, lines: E3-C1 | 40 | T0, T2, T5, T7 | 1, 1.5, 2 gated; 3 observed | Gated |
| Named fill, cubics: E3-C3 | 30 | T0, T2, T5, T7 | as above | Gated |
| Near-coincidence: E3-C4 | 24 | T0, T2 | as above | Gated |
| T-junction fills: E3-C12 | 8 | T2, T6 | as above | Gated |
| Region-only fills: E3-C11 | 8 | T0 | as above | Reported (`REGION-ONLY` expected) |
| Named strokes: E3-C5, E3-C9 | 109 | T0, T3 | as above | Reported ([VZ4-Q4](#8-open-questions)) |

- **Zoom.** `z = 1` only. Coverage is a physical-pixel property and section k names DPR, not zoom ([VZ4-Q3](#8-open-questions)).
- **DPR 1.5.** A04 does not use DPR 1.5. The case is re-projected at `d = 1.5` exactly as O02 re-projects its rows: only `dpr`, `width` and `height` change; geometry, transform, camera and origin are unchanged.
- **Camera.** E3's center placement ([section 13.7](d9-e3-b4-precision-contract.md#137-camera)) and E3's window `Ω`.
- **Size.** Gated part: (40 + 30) × 4 + 24 × 2 + 8 × 2 = 344 row-transforms; × 3 gated DPRs = 1,032 gated cases, plus 344 observed at DPR 3. Reported part: 8 × 4 + 109 × 2 × 4 = 904 cases. All 2,280 cases render 3 variants: 6,840 renders per browser.
- **Blindness.** The corpus is chosen before any V-4 capture and is not changed after the first capture; a change is a new subset version that keeps every failing or undecided case.

## 4. Page design

### 4.1 Files

`apps/playground/viz-v4-a08-corpus.html`, `src/viz-v4-a08-corpus.ts` (host), `src/viz-v4-a08-cases.ts` (corpus loading and scene build), the rollup input in `vite.config.mjs`, `tests/gpu/viz-v4-a08-corpus.spec.ts`, `tests/unit/viz-v4-a08-corpus.test.ts`, the offline runner `tooling/run-viz-v4-metrics.mjs` with its modules under `tests/visual/viz-v4/`, a `docs/validation.md` command row, and the `.gitignore` line for `artifacts/viz-v4-a08/`.

### 4.2 Variants

| Variant | `sampleCount` | Fringe | Gated |
| --- | --- | --- | --- |
| `fringe-1x` | 1 | on | Q4 (G1, G2) and Q9 (G3, center count) |
| `fringe-4x` | 4 | on | Q4 and Q9 (four sample counts) |
| `msaa-4x` | 4 | off (`c = 1`, no exterior triangles) | Never; reported baseline |

### 4.3 Scene and color

Each case is one path node at opacity 1, filled only (fill cases) or stroked only (stroke cases) in opaque white `#ffffff`, on the backend's opaque black clear, so the captured channel value is the coverage `obs` in 8-bit encoded sRGB under P1's premultiplied blending (Q12). The canvas is sized to the case's physical `width × height` at its DPR. The page uses the published scene contracts as the V-1 page does; it adds no draw work.

### 4.4 Per-case statuses

Each case and variant gets one status, recorded with its reason:

| Status | Meaning |
| --- | --- |
| `RENDERED` | Drawn, captured, and every check of section 5.1 passed. The offline runner then judges each `RENDERED` case PASS, FAIL or UNDECIDED (section 5.2); that judgment is not a status |
| `KERNEL-REJECTED` | The port returned a path or batch failure (A01 evidence, not A08) |
| `REGION-ONLY` | The renderer issued `fringe-work-cap` or `fringe-unsupported` for the path |
| `EMPTY-CROP` | The path covers no pixel of `Ω` ∩ canvas |
| `MESH-MISMATCH` | The browser's port requests or mesh bytes differ from Node's for the same case and variant |
| `RENDERER-FAILED` | The renderer reported any other state failure (`tolerance-range`, `packing-range`, ...): a renderer defect, never A01 evidence (added 2026-10-24, section 15) |

### 4.5 Test hook

`window.__vectorStudioVizV4` exposes `ready`, `physical`, `render(caseInput)` returning the capture, the counts, the draw record, the notices and every port call with its mesh digest, and `diagnostics()`. The variant and DPR are page query parameters. The spec decodes each case in Node, renders it, writes one `observations.ndjson` line per case (red channel and counts as O02 `rle.ts` RLE) per browser, variant and DPR, and asserts only completeness (every case has a status). Gates are evaluated offline (section 5).

## 5. Reference and metrics

### 5.1 Reference boundary

- The mesh is the port's output for the case, regenerated in Node by the same release WASM and checked against the browser's bytes (`MESH-MISMATCH` otherwise).
- The reference boundary is the port's `boundaryEdges` (`packages/contracts/src/geometry.ts`), the edges the fringe builder consumes, mapped to physical pixels by E3's CPU model of the K4 shader mapping ([E3 section 7.1](d9-e3-b4-precision-contract.md#71-where-it-runs)), giving `p*` and the per-case bound `β_c`. O02's "edges used by exactly one region triangle" is not used: on a mesh with slab T-junctions (E3-K2, E3-C12) it would label interior half-edges as boundary.
- Vertices outside the viewport are allowed. Clipping follows E3-Q11 (a): the viewport is the guard band and clipping is modelled, so the frame edge is not a coverage boundary and pixels are judged only inside `Ω` ∩ canvas (E3's `Ω` extends 2 px beyond the viewport; the capture does not).
- Corners and sectors follow O02's pairing rule on `boundaryEdges`; a failed pairing is `REGION-ONLY` if the renderer also reported it, otherwise a V-4 failure.
- **Expected statuses.** `KERNEL-REJECTED`, `REGION-ONLY`, `RENDERER-FAILED` and `EMPTY-CROP` are determined in Node before any headed run, by the same WASM and `renderer-core` code. They are committed as a literal list with the subset manifest; a headed status that differs from it is reported and makes the run INCONCLUSIVE.

### 5.2 Gates

G1, G2 and G3 are O02's, with its 2 px, 1 px and 0.708 px classes unchanged. The drawn boundary is known only within `β_c` of the boundary at `p*`, so a pixel center at exact distance `d` from the `p*` boundary has a true distance in `[d − β_c, d + β_c]`. Each gate is decided per pixel as E3 decides its U and L bounds ([VZ4-Q2](#8-open-questions)):

- **G1 (Q4).** A pixel with `d − β_c ≥ 2` must have `obs` within 2/255 of 255 inside and of 0 outside; a violation FAILS. A pixel with `d − β_c < 2 ≤ d + β_c` that violates is UNDECIDED; one that complies is not counted.
- **G2 (Q4).** A pixel with `obs ≥ 128` is classified inside. A misclassified pixel with `d + β_c ≤ 1` passes, one with `d − β_c > 1` FAILS, and one between is UNDECIDED.
- **G3 (Q9).** O02's rule in full: the four counts of a pixel are an order-independent multiset. All four counts must equal 1 (at 1x, the center count) when the pixel center is inside the region at `p*` and `d − β_c > 0`, or when `d + β_c ≤ 0.708` px on either side. Every other pixel is held to "at most 1"; that includes the `β_c` margins of both classes.
- **Cracks.** A T-junction edge is a port-mesh edge with a mesh vertex in its interior. A pixel whose center lies within `0.3953 + 2β_c` px (4x) or `2β_c` px (1x) of a mapped T-junction edge, and that shows a count-0 sample or a coverage deficit, is a GPU crack. Under the approved A01 amendment (E3-Q10 (b)) it is A01 evidence: it is reported with its width and excluded from G1, G2 and G3's "equal to 1" rule, never from "at most 1".
- New metric code is needed for the margins and the crack exclusion: the `metrics-o02.ts` helpers fix the 1 px and 2 px classes on exact distance with no margin. V-4 reuses O02's RLE, crop and distance primitives and adds `tests/visual/viz-v4/metrics.ts`.

### 5.3 Verdict

- **PASS** when no gated case of `fringe-1x` or `fringe-4x` at DPR 1, 1.5 and 2 FAILS in either browser, and the INCONCLUSIVE conditions do not hold.
- **INCONCLUSIVE** when any gated case is UNDECIDED; or when, at any gated DPR in either browser, more than 5 % of the gated cases expected `RENDERED` are not `RENDERED`; or when a headed status differs from the expected-status list of section 5.1.
- **FAIL** otherwise. The failing cases are listed with their key, variant and gate.

### 5.4 Reported, with no threshold

Per variant and DPR: `obs − rule` by class (interior, exterior, band), as O02 reports it; the `msaa-4x` G1 and G2 results and band deviation, beside the fringe variants (the comparison A08 names); the 1x/4x difference; per case, the crack widths and the number of pixels excluded as cracks; DPR 3 results; stroke results; and status counts.

## 6. Acceptance criteria

| ID | Criterion | Method |
| --- | --- | --- |
| VZ4-A1 | Page loads in headed Chrome and Edge, reports `ready`, and refuses to run if a hook of VZ4-D2 or VZ4-D3 is absent | GPU spec |
| VZ4-A2 | The subset manifest regenerates byte-identically from `a04-corpus/v1`, and its `corpusSha256` equals the E3 freeze record | Unit test |
| VZ4-A3 | Every case and variant has exactly one status of section 4.4 | GPU spec, completeness assertion |
| VZ4-A4 | Browser mesh bytes equal Node's for every `RENDERED` case | Offline runner |
| VZ4-A5 | The `msaa-4x` variant is region-only: its recorded exterior draw range is empty for every case, and its interior pixels (`d − β_c ≥ 2`) have `obs` = 255 | Offline runner, from the draw record and captures |
| VZ4-A6 | G1 and G2 on `fringe-1x` and `fringe-4x`, DPR 1, 1.5, 2 | Offline runner |
| VZ4-A7 | G3 on `fringe-1x` and `fringe-4x`, DPR 1, 1.5, 2 | Offline runner |
| VZ4-A8 | Controls on synthetic captures and records. Must FAIL: a 2 px boundary shift (G2); an interior pixel at 3/255 off (G1); a doubled exterior draw (G3, count 2); a dropped region triangle (G3, count 0 away from T-junction edges); a fringe left on in `msaa-4x` (VZ4-A5); a one-byte mesh change (`MESH-MISMATCH`); a missing case (VZ4-A3); a readback from a cleared texture (G1). Must PASS: a 2/255 interior deviation and a known-good synthetic rendering of the rule | Unit tests |
| VZ4-A9 | Offline metrics replay byte-identically from the committed record's inputs | `pnpm coverage:viz-v4 --replay` |
| VZ4-A10 | The section 5.4 report exists for both browsers | Evidence record |
| VZ4-A11 | The record states `PRE-FREEZE` or names the C03-C05 completion it relies on | Evidence record review |
| VZ4-A12 | Independent `reviewer` evidence review, ACCEPTED | Review record |

The expected-literal rule of V-3 (section 4.1 there) applies: any value the gates use is fixed before the first headed run; values left open are observations only.

## 7. Validation commands

| Command | Where | Covers |
| --- | --- | --- |
| `pnpm check` | Cloud and CI | Unit tests, including VZ4-A2 and VZ4-A8 |
| `pnpm build`, `pnpm test:geometry` | CI | WASM build used by the page |
| `pnpm test:gpu:viz-v4` (new, `playwright.gpu.config.ts` project) | User PC, headed Chrome and Edge | VZ4-A1, VZ4-A3 |
| `pnpm coverage:viz-v4` | User PC or cloud on copied captures | VZ4-A4 to VZ4-A7, VZ4-A9, VZ4-A10 |

Headed runs are not possible in the cloud container; they run on the user's PC through Remote Control or are reported NOT RUN.

## 8. Open questions

| ID | Question | Recommendation |
| --- | --- | --- |
| VZ4-Q1 | Start V-4 before the E3 freeze and C03-C05, labelling runs `PRE-FREEZE`? Who owns C03-C05 completion? | (a) yes, contract and harness now; C03-C05 ownership is a user decision raised separately |
| VZ4-Q2 | Decide pixels in the `β_c` margin as UNDECIDED (section 5.2), or ignore `β_c` and use O02's classes on `p*` as if exact? | (a) UNDECIDED: keeps Q4's classes unchanged and never lets a mapping error pass or fail as coverage |
| VZ4-Q3 | Zoom `z = 1` only, or all three E3 zooms? | (a) `z = 1`: coverage is per physical pixel; zoom is A04's axis |
| VZ4-Q4 | Strokes: report only, or gate them with the same Q4? | (a) report: section k covers fill; a stroke gate needs its own full-tier decision |
| VZ4-Q5 | The test hooks as rendering item E10 (full tier, both-track review), or a V-4 page that rebuilds the mesh pipeline itself? | (a) E10: a rebuilt pipeline would not be the product path that A08 evidences |
| VZ4-Q6 | The INCONCLUSIVE threshold of 5 % of expected-`RENDERED` gated cases not `RENDERED` (any UNDECIDED case is INCONCLUSIVE regardless) | (a) 5 %: O02 tolerated about 9 % (130 of 143), and expected rejections are already removed by the Node pre-run |
| VZ4-Q7 | Transform subset T0, T2, T5, T7 for named fills | (a) as stated: identity, generic rotation, negative determinant, strong anisotropy |

## 9. Units and order

`this contract APPROVED -> E10 contract and implementation (rendering track) -> E3 freeze record and E3-U3 harness -> VZ4-U1 page, spec and subset manifest -> VZ4-U2 offline runner and positive controls -> VZ4-U3 headed run on the user's PC, PRE-FREEZE record -> independent evidence review -> counted run after C03-C05`. VZ4-U1 and VZ4-U2 may start before the E3 freeze against the unfrozen `a04-corpus/v1`; their tests then pin the corpus SHA as a TODO that VZ4-A2 closes.

## 10. Risks

- **E10 not scheduled.** Without E10, VZ4-A1 refuses to run and A08 stays TODO. Mitigation: E10 is filed with this contract as an R1 item.
- **C03-C05 unowned.** A08 evidence cannot count until they are complete; see VZ4-Q1.
- **Run time.** 6,840 renders per browser; a run is expected to take minutes, not hours, at the corpus sizes. If not, the spec is sharded by stratum.
- **Driver variance.** Results hold only for the recorded adapter and driver, as O02's do.
- **Readback path.** If E10's readback reads a texture other than the one presented, the evidence is of that texture; E10's contract must state which.

## 11. Gate

Satisfies nothing yet. After approval, V-4 is complete when VZ4-A1 to VZ4-A12 have evidence on a counted run. A `PRE-FREEZE` record may be linked from the X1 row of A08 only with the words "PRE-FREEZE, not counted" in that cell, and the row stays TODO.

## 12. Review round 1 (2026-10-24)

Independent `reviewer` review: NOT READY, three blocking and eight should-fix items. Applied in revision 2; B1 and S6 were completed in revision 3 (round 2).

- B1: the `β_c` widening of the G1 and G2 classes changed Q4; replaced by per-pixel UNDECIDED margins (section 5.2, VZ4-Q2).
- B2: the O02 boundary rule mislabels T-junction half-edges; the reference is now the port's `boundaryEdges`, and GPU cracks are routed to A01 (section 5.1, 5.2).
- B3: `GUARD-BAND` contradicted E3-Q11 (a) and made PASS unreachable on off-viewport rows; clipping is now modelled as in E3, and expected statuses are fixed in Node before the headed run (section 5.1, 5.3).
- S4 to S11: the E3-U3 dependency (VZ4-D5); one meaning per status; G3 stated in full; controls widened with a negative control (VZ4-A8); VZ4-A5 made testable; DPR 1.5 key rule and gated count without DPR 3 (section 3); new metric code stated; the X1 "not counted" guard (section 11).

## 13. Review round 2 (2026-10-24)

NOT READY, two blocking and six should-fix items, all applied in revision 3: the G1 margin now covers `2 ≤ d < 2 + β_c`; G3's "all four equal 1" class includes every interior pixel; any UNDECIDED gated case makes the run INCONCLUSIVE; the crack zone is `0.3953 + 2β_c` (4x) or `2β_c` (1x) and applies to G1 and G2 too; UNDECIDED is an offline judgment, not a page status; pixels are judged in `Ω` ∩ canvas.

## 14. Review round 3 (2026-10-24)

READY, no blocking or should-fix items. Its optional follow-up, reporting the pixels excluded as cracks per case, is applied in section 5.4.

## 15. Implementation notes (VZ4-U1, 2026-10-24)

- Subset: `tests/visual/viz-v4/subset.ts`, `a08-subset/v1`, 2280 cases (1032 gated), pinned by `tests/visual/viz-v4/a08-subset.manifest.json` with the `a04-corpus/v1` `corpusSha256`. VZ4-A2 is closed for the subset definition; it is re-checked unchanged after the E3 freeze record. DPR 1.5 cases keep the DPR 1 case's `gap` block; VZ4-U2 must not read `gap.phys` for them. The strokes part holds C9's fill-role and opacity rows too, drawn alone at opacity 1.
- E3 blindness (E3 section 5.5): `pnpm viz-v4:expected` and the headed spec refuse to run until the E3 contract holds the freeze record. Before that, unit tests use scripted ports only.
- Expected statuses: `pnpm viz-v4:expected` runs the product CPU path (E3's `drawCase`, given a `fringe: 'off'` option for `msaa-4x`) on the release WASM and writes `tests/visual/viz-v4/a08-expected-status.json`, keyed by the subset keys SHA and the WASM SHA, with each case and variant's status, reason and port calls. The spec records any headed deviation in `meta.json`.
- `MESH-MISMATCH`: both sides record every port call as the request's SHA-256 and its outcome (mesh digest by `meshDigestBytes`, `empty`, `failed:<code>` or `batch:<code>`). The headed calls must equal Node's for the case, so a different request, mesh or call count is a mismatch. The case key is the node id, so no mesh is served from another case.
- `fringe-unsupported` hides the path under fringe, so it is `REGION-ONLY` with nothing drawn; under `msaa-4x` the same case is `RENDERED`. A port `empty` on a subset case is `EMPTY-CROP` with reason `port-empty` and is listed in `meta.json` (`portEmpty`) for review, since a centred named row should cover pixels (E3-PC11).
- Section 4.5 was rewritten to the built hook (`window.__vectorStudioVizV4`, `render(caseInput)`, query-string variant, `observations.ndjson`); section 4.3 states the backend's opaque black clear. Neither changes a gate.
- Capture identity (E10 section 14 carry-overs): per case, capture size equals the physical size, `sampleCount` and `devicePixelRatio` equal the variant's and the DPR, one submitted frame and one prepare per capture, and mesh triangle totals equal the draw record.
- Artifacts: `artifacts/viz-v4-a08/<run>/<project>/<variant>/dpr<D>/` with `meta.json` (label `PRE-FREEZE`, `complete`), `observations.ndjson` and `UNVERIFIED.txt`, the labels written before the first case. The headed command is `pnpm test:gpu:viz-v4`; `pnpm test:gpu` also collects the spec, which skips before the freeze.
