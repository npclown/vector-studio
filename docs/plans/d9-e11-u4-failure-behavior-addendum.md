# D9 E11-U4: P3 path mesh failure behavior (addendum)

Status: **DRAFT 2026-10-24**, for independent review by both tracks. Under the user's standing rule of 2026-10-24 (take the recommended option without asking, record it with its date, tell the user), E11-U4-Q1 (a) is adopted on review READY; the record is section 8.

This addendum is unit E11-U4 of the [E11 contract](d9-e11-p3-c03-c05-closure-contract.md#8-units), in scope because the user chose [E11-Q3 (a)](d9-e11-p3-c03-c05-closure-contract.md#91-user-decisions-2026-10-24). It fixes the acceptance criteria and validation before code, as [`AGENTS.md`](../../AGENTS.md#working-rules) requires. It changes no threshold, cap, kernel output or drawing outcome.

**Tier and review.** Full tier. It changes the shared surface twice ([D9 boundary](d9-post-mvp1-tracks-proposal.md#boundary)): item 1, `DIAGNOSTIC_CODES` in `packages/contracts`, which is jointly owned ("full tier, reviewed by both tracks and approved by the Primary"); and item 2, the `renderer-core` root exports `PathMeshNotice` and `pathMeshNoticeDiagnostic`. Both this addendum and its implementation are reviewed from the rendering and the visualization side, and the visualization-owned files of section 5 item 4 are edited in the implementation PR with that review.

## 1. Frozen texts this unit settles or sets aside

E11-Q3 (a), quoted: "Adopt the three D8-interim outcomes as P3's product behavior … E11-U4 writes the requirements text naming every class that reaches each outcome … It turns the interim code into product code. Because ST7-R10 says `overlay-unsupported` 'must be removed with the TypeScript builder', that outcome stays tied to E12's builder placement." The user's choice of (a) already set aside the first three texts below; U4 carries out the rest.

| Source | Quoted text | Effect of U4 |
| --- | --- | --- |
| [Private contract](p3-private-contract.md) U2 | "Failure behavior is decided only after a separate proposal compares alternative paths … No user-visible rejection is introduced by default." | Set aside by E11-Q3 (a): the not-drawn outcome with a warning ships. U2's alternatives continue in E12 |
| [V1 proposal](p3-v1-path-scene-port-proposal.md#h-decisions-for-the-user) section h | "The production failure behavior stays with U2: the R3, R0 and R2 direction, then R5 and U4 as last resorts." | Set aside by E11-Q3 (a), for the P3 exit |
| Private contract, D8 interim pointer | "for D8 checkpoints V2-V4 only … It does not answer U2 or U4, which stay as written above; the interim code is removed or replaced when the production failure behavior is decided." | The scope widens to P3 product behavior; the interim code is replaced (section 5) |
| V1 section h | "It must be decided before P3 acceptance, with requirements text naming the meshes that can reach it. The interim code is then removed or replaced." | Settled: decided by E11-Q3 (a); requirements text of section 5 item 5; code replaced |
| [V3](p3-v3-renderer-mesh-pipeline-contract.md#h-d8-interim-failure-outcome) section h | "It does not answer U2 or U4 … It is removed or replaced when the production failure behavior is decided, before P3 acceptance, with requirements text naming the meshes that can reach that behavior. Removal deletes the code, the `notices` field and their tests in one change." | Settled by replacement: the code is renamed, the `notices` field and transport stay |
| V3 section m | "The interim diagnostic code must be removed before P3 acceptance." | Settled: no interim code remains (E11-U4-A1) |
| Private contract U4 | "Reuse of P1's existing `render.submission-failed` … only as a last resort … No new public result variant is added. The requirements must state which meshes can reach this outcome …" | Not invoked: `render.submission-failed` is not reused. No port or render result variant is added; one existing diagnostic code is renamed, not added. The requirements text names the classes anyway |
| V3 section h, V4 amendment (`fringe-work-cap`) | "It is removed with the TypeScript builder at the R2/K1 placement decision, or when B0's E3 result replaces it." | Kept: O2 is product behavior only while that builder ships (section 2) |
| [ST-U7 addendum](p3-b2-st-u7-joint-coverage-addendum.md) 4.6, ST7-R10; [B2 stroke contract](p3-b2-stroke-contract.md#98-notices) 9.8 | "`overlay-unsupported` is D8-interim. It is removed with the TypeScript builder at the R2/K1 placement decision"; "must be removed with the TypeScript builder" | Kept: O3 is product behavior only while that builder ships (section 2) |

## 2. The three outcomes (unchanged behavior)

| Outcome | When | What draws | Lifetime |
| --- | --- | --- | --- |
| **O1 not drawn** | Any failure of section 3 except `fringe-work-cap` and `overlay-unsupported`, on either drawable paint | The whole path is not drawn (fill and stroke); every other node draws in order; the other paint's cached mesh stays (V3 section h, ST-U6 amendment) | P3 product behavior; E12 may shrink the classes that reach it |
| **O2 region-only** | `fringe-work-cap`: a paint mesh with more than `fringeBoundaryVertexCap` (128) distinct boundary vertices | That paint draws its region triangles without the coverage fringe (V4 amendment) | Tied to the TypeScript fringe builder: removed or re-decided by E12 (or E6) with its placement |
| **O3 path hidden by overlay** | `overlay-unsupported`: the joint overlay of a path with both paints at `0 < opacity < 1` fails | The whole path, fill included, is not drawn; both cached meshes stay (ST-U7 addendum 4.6) | Tied to the TypeScript overlay builder, as O2 |

**Notices.** Each failure is reported by one warning, created as V3 section d's class table says: once per memo entry, once per marked fringe variant, once per marked overlay variant, and on each `(node, paint)` or per-node state transition. `renderer-core` queues at most 4,096 and attaches at most 32 per packet. `mesh-pipeline-unavailable` is the exception: the backend emits it directly, once per generation, outside the queue and its caps.

**Not failures.** These draw less with no notice, and the requirements text says so: a renderer without a stroke port draws fills only; a renderer without a fringe builder draws meshes without a fringe; a path with a singular transform is not drawn (P1 D2's singular rule).

## 3. Classes that reach each outcome

Codes are those of `PathMeshFailureCode` (20: 6 path, 4 batch, 10 renderer).

| Scope | Code | Outcome | Known classes of input |
| --- | --- | --- | --- |
| path | `invalid-path`, `invalid-stroke` | O1 | Malformed requests; unreachable from a scene that passed validation |
| path | `invalid-tolerance` | O1 | Unreachable: the renderer never requests an `e` outside the port's range (`tolerance-range` fires first) |
| path | `numeric-range` | O1 | Coordinates or scales whose exact intermediates leave the kernel's range |
| path | `work-limit` | O1 | Paths over `FILL_V0_LIMITS` or `STROKE_V0_LIMITS`: stroke cases of ST-U8 and B2 S7 (until E2); in the [E11-U2 scene](d9-rendering-track.md#e11-e11-u2-evidence-2026-10-24) (E14), smooth 32-cubic closed paths fail to fill from about 16 device px in radius and all fail from 64, while about half fail to stroke even below 16 and all fail from 64 |
| path | `unsupported-geometry` | O1 | The seven ST-U3f stroke cases (E4); E8's residue after E8-U2. The E11-U2 scene's 41 fill failures of this code; its self-intersecting paths mesh at no size, with no split by code recorded |
| batch | `internal-error`, `resource-limit` isolated to one path | O1 | Kernel faults; memory exhaustion; a request over a V2 transport cap (input 64 MiB, output 256 MiB) at limit + 1 |
| batch | `invalid-request` | O1 | An adapter request-shape rejection, unreachable from a validated scene |
| batch | `disposed` | O1 | A disposed port |
| renderer | `tolerance-range` | O1 | A zoom, DPR and transform whose bucket `e` is below `E_MIN` (fill) or `STROKE_E_MIN` (stroke); `e > E_MAX` is clamped and draws (V3 section c) |
| renderer | `fringe-range`, `fringe-unsupported`, `packing-range` | O1 | Fringe bucket out of range; a mesh the exact fringe builder cannot partition; a packet over the K4 packing range |
| renderer | `invalid-response`, `invalid-mesh` | O1 | A port answer that breaks V3 section h's validation (a defect, never expected) |
| renderer | `port-version`, `mesh-pipeline-unavailable` | O1 | A port of another version (every path); a backend without the mesh pipeline (every mesh path) |
| renderer | `fringe-work-cap` | O2 | Meshes with more than 128 distinct boundary vertices |
| renderer | `overlay-unsupported` | O3 | A failed partition check; a triangulator failure; a Steiner point on a sloped outer edge (open subpaths, or `r_phys·cos(θ/2) ≤ δ_F + δ_S`, ST7-R10); an overlay over its work cap (ST7-Q5) |

The code and outcome columns are closed for P3: a new code or outcome is a contract change. The last column is informative and is updated by the item that changes it (E2, E4, E8, E12, E14).

## 4. Dependencies

The E11-U2 anchor above resolves once PR #225 merges; this addendum merges after it.

## 5. Changes

1. **Code.** `DIAGNOSTIC_CODES.PATH_MESH_INTERIM_FAILURE: 'render.path-mesh-interim-failure'` becomes `PATH_MESH_FAILURE: 'render.path-mesh-failure'` (E11-U4-Q1 (a)). Severity stays `warning`.
2. **Notice.** `PathMeshNotice` loses `interim: 'd8'`; the diagnostic context loses `interim` and keeps `nodeId`, `failureScope`, `failureCode`, `toleranceExponent`, `paint` with V3 section h's values. Messages: `Path <id> is not drawn (<scope> <code>).`, `Path <id> is drawn without its coverage fringe (…).` for O2, and `Mesh paths are not drawn (renderer mesh-pipeline-unavailable).` when `nodeId` is null.
3. **Comments and page text.** Source comments, page text and UNVERIFIED strings that call the notices or these outcomes "D8-interim" are updated (among them `p3-b2-strokes.html`, `viz-v1-appearance.html`, `viz-v2-path-data.html`, `viz-v1-appearance-scene.ts`, `viz-v2-path-data-state.ts`, `p3-b2-strokes-scene.ts`). The fringe and overlay **builders** keep their D8-interim placement label.
4. **Consumers.** `webgpu-backend.ts`; the pages that filter on the code (`p3-v4-paths.ts`, `p3-b2-strokes.ts`, `viz-v1-appearance-state.ts` `NOTICE_CODE`, used by `viz-v1-appearance.ts` and `viz-v2-path-data.ts`, and `viz-v3-integration.ts`); their unit tests (`v3a`, `v3b`, `v3c`, `v4-fringe-cap`, `st-u6`, `st-u7`, `viz-v1-appearance`); and the GPU specs (`p3-v3-mesh-smoke`, `p3-v4-paths`, `p3-b2-strokes`, `p3-st-u6-stroke`, `p3-st-u7-joint`).
5. **Requirements.** `docs/requirements.md` gains a "Path rendering failures" section with the three outcomes, their lifetimes, the not-failure cases of section 2, and the codes per outcome by name (the code and outcome columns of section 3); the known classes stay here by link.
6. **Pointers.** One dated line, "replaced by E11-U4 on <merge date>", in each text of section 1 (private contract U2, U4 and D8 pointer; V1 section h; V3 sections h, m and the V4 amendment; ST-U7 addendum 4.6; B2 stroke contract 9.8), in `docs/graphics-engine-architecture.md` (fringe cache identity), and in the visualization contracts that quote the old code (`viz-v1-path-appearance-contract.md`, `viz-v3-a07-integration-contract.md`). Dated status records elsewhere (`p3-fill-stroke-meshes.md`, the V2 contract) stay as written.

## 6. Acceptance criteria

| ID | Criterion | Check |
| --- | --- | --- |
| E11-U4-A1 | No file under `packages/*/src` or `apps/` contains `path-mesh-interim-failure`, `PATH_MESH_INTERIM_FAILURE`, `interim: 'd8'`, or `D8-interim` outside a comment or string about the fringe or overlay builder placement | A unit test greps those trees with an explicit allow-list of builder-placement lines |
| E11-U4-A2 | Every `PathMeshFailureCode` maps to exactly one outcome, and `docs/requirements.md` names every code under its outcome | A unit test with a `Record<PathMeshFailureCode, 'O1' \| 'O2' \| 'O3'>` (a missing code fails typecheck) that parses the requirements section |
| E11-U4-A3 | Drawing outcomes, notice counts, order, caps and `noticesDropped` are unchanged | The unit tests of section 5 item 4 pass with only the code, context, message and notice-object (`interim`) expectations changed; no other assertion is edited, which the review checks in the diff |
| E11-U4-A4 | Headed GPU specs that read notices pass | `pnpm test:gpu` on the user's machine, or NOT RUN with the reason; the specs change only the code string |
| E11-U4-A5 | Section 5 item 6 pointers exist | A unit test greps each named file for "E11-U4" |

Validation: `pnpm check`, CI, both-track review, and E11-U4-A4 headed (NOT RUN in the cloud container: no GPU).

## 7. Decision

**E11-U4-Q1. What is the product code called?**

- (a) **Recommended.** `render.path-mesh-failure`, key `PATH_MESH_FAILURE`: the family of `render.submission-failed`, no phase name in a product identifier.
- (b) Keep `render.path-mesh-interim-failure` and only drop the `interim` key and prefix. Fewer consumer edits, but the product code would keep the word V3 section m says must go.

## 8. Review and decision record

- **Round 1, 2026-10-24 (rendering side): NOT READY.** Blocking: the frozen texts were not quoted (now section 1), and O2 and O3 were not tied to the builder placement (now the lifetime column). Should-fix applied: the four `overlay-unsupported` causes, `tolerance-range` below `E_MIN` only, the E11-U2 size wording, requirements naming codes, both-track review and the second shared-surface item, the full consumer, page-text and pointer lists, transport caps. Minor applied: the backend notice exception and overlay marks, `invalid-request` and `invalid-tolerance` reachability, the quiet cases, message wording, the `E11-` prefix, a grep check for pointers.
