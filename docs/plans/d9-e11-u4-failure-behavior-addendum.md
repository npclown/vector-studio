# D9 E11-U4: P3 path mesh failure behavior (addendum)

Status: **DRAFT 2026-10-24**, for independent review. Under the user's standing rule of 2026-10-24 (take the recommended option without asking, record it with its date, tell the user), U4-Q1 (a) is adopted on review READY; the record is section 7.

This addendum is unit E11-U4 of the [E11 contract](d9-e11-p3-c03-c05-closure-contract.md#8-units), in scope because the user chose [E11-Q3 (a)](d9-e11-p3-c03-c05-closure-contract.md#91-user-decisions-2026-10-24). It is full tier: it changes a shared surface (`packages/contracts/src/diagnostics.ts`), the requirements and product behavior text. It fixes the acceptance criteria and validation before code, as [`AGENTS.md`](../../AGENTS.md#working-rules) requires. It changes no threshold, cap, kernel output or drawing outcome.

## 1. What E11-Q3 (a) requires

Quoted from E11-Q3 (a): "Adopt the three D8-interim outcomes as P3's product behavior … E11-U4 writes the requirements text naming every class that reaches each outcome … It turns the interim code into product code. Because ST7-R10 says `overlay-unsupported` 'must be removed with the TypeScript builder', that outcome stays tied to E12's builder placement."

The frozen texts it answers: V3 section h, "It is removed or replaced when the production failure behavior is decided, before P3 acceptance, with requirements text naming the meshes that can reach that behavior. Removal deletes the code, the `notices` field and their tests in one change"; and V3 section m, "The interim diagnostic code must be removed before P3 acceptance."

U4 **replaces** the interim code (the second branch of V3 section h): the outcomes, the notice transport and the `notices` packet field stay; the interim label goes.

## 2. The three outcomes (unchanged behavior)

| Outcome | When | What draws |
| --- | --- | --- |
| **O1 not drawn** | Any failure of section 3 except `fringe-work-cap` and `overlay-unsupported`, on either drawable paint | The whole path is not drawn (fill and stroke); every other node draws in order; the other paint's cached mesh stays (V3 section h, ST-U6 amendment) |
| **O2 region-only** | `fringe-work-cap`: a paint mesh with more than `fringeBoundaryVertexCap` (128) distinct boundary vertices | That paint draws its region triangles without the coverage fringe (V4 amendment) |
| **O3 path hidden by overlay** | `overlay-unsupported`: the joint fill and stroke overlay of a path with both paints at `0 < opacity < 1` fails to build | The whole path, fill included, is not drawn; both cached meshes stay (ST-U7 addendum, ST7-R10) |

Each outcome queues one warning notice per V3 section h's transport rules (once per memo entry, per marked fringe variant, per `(node, paint, code)` state transition), at most 32 per packet and 4,096 queued.

## 3. Classes that reach each outcome

This list is the requirements text's content (section 4). Codes are those of `PathMeshFailureCode`.

| Scope | Code | Outcome | Known classes of input that reach it |
| --- | --- | --- | --- |
| path | `invalid-path`, `invalid-tolerance`, `invalid-stroke` | O1 | Malformed requests; unreachable from a scene that passed validation |
| path | `numeric-range` | O1 | Coordinates or scales whose exact intermediates leave the kernel's range |
| path | `work-limit` | O1 | Paths over `FILL_V0_LIMITS` or `STROKE_V0_LIMITS`. Known classes: stroke cases of ST-U8 and B2 S7 (until E2); fill and stroke of smooth multi-cubic paths above about 64 (fill) and 16 (stroke) device px in radius, and self-intersecting ones at all sizes ([E11-U2 finding](d9-rendering-track.md#e11-e11-u2-evidence-2026-10-24), E14) |
| path | `unsupported-geometry` | O1 | The seven ST-U3f stroke cases (E4); E8's residue after E8-U2 |
| batch | `internal-error`, `resource-limit` isolated to one path; `invalid-request`; `disposed` | O1 | Kernel faults, memory exhaustion, a disposed port |
| renderer | `tolerance-range` | O1 | A zoom, DPR and transform whose bucket `e` leaves `[E_MIN, E_MAX]` (stroke `[STROKE_E_MIN, E_MAX]`) |
| renderer | `fringe-range`, `fringe-unsupported`, `packing-range` | O1 | Fringe bucket out of range; a mesh the exact fringe builder cannot partition; a packet over the K4 packing range |
| renderer | `invalid-response`, `invalid-mesh` | O1 | A port answer that breaks V3 section h's validation (a defect, never expected) |
| renderer | `port-version`, `mesh-pipeline-unavailable` | O1 | A port of another version; a backend without the mesh pipeline (every path) |
| renderer | `fringe-work-cap` | O2 | Meshes with more than 128 distinct boundary vertices |
| renderer | `overlay-unsupported` | O3 | Region-only fills with an open subpath, or with `r_phys·cos(θ/2) ≤ δ_F + δ_S` (thin strokes at low zoom), under both paints at `0 < opacity < 1` (ST7-R10) |

The list is closed for P3: a new code or a new outcome is a contract change. The known classes in the last column are informative and are updated by the item that changes them (E2, E4, E8, E12, E14).

## 4. Changes

1. **Code.** `DIAGNOSTIC_CODES.PATH_MESH_INTERIM_FAILURE: 'render.path-mesh-interim-failure'` becomes `PATH_MESH_FAILURE: 'render.path-mesh-failure'` (U4-Q1 (a)). Severity stays `warning`.
2. **Notice.** `PathMeshNotice` loses `interim: 'd8'`; the diagnostic context loses the `interim` key and keeps `nodeId`, `failureScope`, `failureCode`, `toleranceExponent`, `paint` with V3 section h's values. The message loses the `D8-interim:` prefix: `path <id> is not drawn (<scope> <code>).`, `… is drawn without its coverage fringe …` for O2, `the mesh path …` when `nodeId` is null.
3. **Comments.** Source comments that call the notice or these outcomes D8-interim are updated. The fringe and joint-overlay **builders** keep their D8-interim placement label: their placement is E6's and E12's, not U4's.
4. **Consumers.** The backend, the playground pages that filter on the code (`p3-v4-paths`, `p3-b2-strokes`, `viz-v1-appearance-state`, `viz-v3-integration`), their tests and the GPU specs switch to the new code. The visualization track is told before merge; its contracts that quote the old code get a dated pointer, not a rewrite.
5. **Requirements.** `docs/requirements.md` gains a "Path rendering failures" section: the three outcomes of section 2, "a path the renderer cannot mesh is not drawn and reported with a warning", and the code table of section 3 by reference to this addendum.
6. **Pointers.** Dated amendment lines in V3 section h and section m, the ST-U7 addendum (ST7-R10), the B2 stroke contract section 9.8 and the P3 private contract's D8 interim pointer, each saying "replaced by E11-U4 on <merge date>".

## 5. Acceptance criteria

| ID | Criterion | Check |
| --- | --- | --- |
| U4-A1 | No product source under `packages/` or `apps/` contains `path-mesh-interim-failure`, `PATH_MESH_INTERIM_FAILURE`, `interim: 'd8'` or the message prefix `D8-interim:` | A unit test greps the source trees |
| U4-A2 | Every `PathMeshFailureCode` maps to exactly one outcome of section 2, and `docs/requirements.md` names every code | A unit test with a `Record<PathMeshFailureCode, 'O1' \| 'O2' \| 'O3'>` (so the type checker fails on a missing code) that reads the requirements section |
| U4-A3 | Drawing outcomes, notice counts, ordering, caps and `noticesDropped` are unchanged | The existing V3a, V3b, V3c, V4, ST-U6 and ST-U7 unit tests pass with only the code, context and message expectations changed; no other assertion is edited |
| U4-A4 | Headed GPU specs that read the notices still pass | `pnpm test:gpu` on the user's machine, or NOT RUN with the reason; the specs change only the code string |
| U4-A5 | Section 4 item 6 pointers exist | Review |

Validation: `pnpm check`, CI, and U4-A4 headed (NOT RUN in the cloud container: no GPU).

## 6. Decision

**U4-Q1. What is the product code called?**

- (a) **Recommended.** `render.path-mesh-failure`, key `PATH_MESH_FAILURE`: the same family as `render.submission-failed`, no phase name in a product identifier.
- (b) Keep `render.path-mesh-interim-failure` and only drop the `interim` key and prefix. Fewer consumer edits, but the product code would carry the word "interim", which V3 section m forbids in spirit.

## 7. Review and decision record

- Pending.
