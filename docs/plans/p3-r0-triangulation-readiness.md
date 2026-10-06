# P3.1n R0 clearance-aware triangulation readiness

Status: N00 readiness review revision 2. The independent review found that R0, as scoped, gives no admission benefit on the current corpus (see "Review finding"). On 2026-10-07 the user chose **R0a**: certificate fan-term refinement, test-only, with no visible change. The T1/T2 retriangulation checklist below is retained for reference and is not the next unit. Nothing is adopted and nothing is implemented. R0 is the second unit of the user's [U2 direction](p3-u2-failure-path-proposal.md) (R3, then R0, then R2). R3 was integrated through PRs #104 and #105. The [private contract](p3-private-contract.md) owns C04, the [rounded fill mesh contract](p3-rounded-fill-mesh-contract.md) owns the current carrier, and the [active plan](p3-fill-stroke-meshes.md) owns status.

## Question

Can a different exact triangulation of the same exact region remove the generator-induced small features that make P3.1m class B rows fail clearance? It must keep the region and boundary exactly and introduce no new coordinates.

R0 does not address source-level near-coincidence (class C). It does not change position bounds, add a rejection, or alter visible output: an exact retriangulation of the same region has identical coverage semantics.

## Where the small features come from

The read-only survey found two places where the shared carrier picks triangles:

- **Rust:** `packages/geometry-wasm/kernel/src/rounded_line_fill.rs`, function `build_mesh`.
- **Test-side mirror:** `tests/geometry/rounded-fill/oracle.ts`.

Both cut every slab cell `[bl, br, tr, tl]` along one fixed diagonal. `embed_scalar` places rounded values greedily and never enforces a minimum separation. The test-only J refinement (`tests/geometry/conforming-mesh/oracle.ts`) removes T-junctions by ear-clipping each parent, starting from its smallest index, over its hanging column nodes. Nothing in the generator or the oracles measures clearance. The only measure is the test-side `clearanceSummary` of the [position certificate](p3-position-certificate-contract.md).

Exact summaries of the 12 carrier source meshes and their J refinements (local units, before transform):

| Carrier family | dV²   | dE² (source to refined) | ρ̄ (source to refined)    | κ̄ (fan)         |
| -------------- | ----- | ----------------------- | ------------------------ | --------------- |
| W (4 rows)     | 2.25  | 2.25                    | 1/3                      | 1/3             |
| Y (4 rows)     | 1     | 0 to 0.396              | 1/3                      | 3/416 ≈ 7.21e-3 |
| Z (4 rows)     | 0.879 | 0 to 0.0110             | 0.214 to 17/337 ≈ 0.0504 | 3/835 ≈ 3.59e-3 |

The source meshes have dE² = 0 because they contain T-junctions; J removes them.

The source meshes report `overlappingFan = true`. The minimum fan ratios of Y and Z (3/416 and 3/835) come from pairs of two boundary edges. They meet at slab-column nodes, such as Y vertex 1 at (-1, -6.697916…) on the source edge (-3, 0) to (0, -10), where the exact y is -20/3. The rounded embedding moved those nodes off straight source edges within τ. Before rounding, those pairs were exactly opposite collinear rays and passed the `λ` test. The rounding bend turns them into nearly collinear `κ` pairs.

No retriangulation over the same vertices changes these pairs, and removing those vertices changes the region. Z's minimum disjoint-edge distance, between edges (3,4) and (1,5), and its minimum ρ̄, in triangle [1,4,5], come from J's fan from the apex (0, -10) to the hanging nodes on column x = 1. W's clean summaries match its failures being R3 origin-window effects, which T = 128 resolved.

## Candidate method

These candidates share one invariant: the output covers the identical exact region with the same boundary as a point set, and every output vertex is an existing exact vertex. No coordinates are created. A boundary vertex may be removed only where its output neighbours have exact orientation 0. Rasterized output can differ only within the certified position bound.

| ID  | Method                                                                                                                                                                                                                                                                                                                                                                                                                                      | Expected effect                                                    | Risk                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| T1  | **Constrained edge flips.** Starting from the verified J output, flip a non-boundary edge shared by two triangles that form a strictly convex quadrilateral. The potential is the sorted vector of local terms: ρ for each triangle, and κ over all incident pairs at the four quadrilateral vertices. A flip is made only when it increases this vector lexicographically. Boundary-pinned terms are held constant. Exact predicates only. | Repairs J-induced and fixed-diagonal edge and triangle terms.      | It cannot change boundary-boundary pairs or remove a vertex. Crossing a J parent edge needs its own control. |
| T2  | **Removal of non-essential vertices.** Drop interior vertices, which are always removable, and boundary vertices whose output neighbours have exact orientation 0. Retriangulate each hole by the same deterministic ear rule.                                                                                                                                                                                                              | Removes generator-only nodes that lie on straight output segments. | It cannot remove rounding-bent column nodes without changing the region. It changes the vertex count.        |
| T3  | **T2 followed by T1.**                                                                                                                                                                                                                                                                                                                                                                                                                      | Combines both effects.                                             | Highest change to the pinned corpora.                                                                        |

A full constrained Delaunay library is excluded, because it would add a dependency and needs an architecture decision. Exact flip and removal over at most 256 vertices is feasible with the existing exact helpers.

## What R0 can and cannot claim

R0 can show, as test-only evidence, that rows failing only through generator-induced features become admitted under the unchanged certificate. It cannot clear features that the region's own boundary forces, such as a genuinely thin spike in the source contour. Those stay in class B or C until R1 or R4 is decided.

Runtime adoption is a separate step. T2 would break three things in the [rounded fill mesh contract](p3-rounded-fill-mesh-contract.md): the ledger rule that maps each boundary atom to its endpoint nodes, the cell and triangle rule, and the rejecting control for merged distinct nodes. Adoption also needs the native carrier byte expectations and J's conventions updated, and the evidence regenerated through new versioned records. The contract's "not permission to merge, collapse" wording concerns the embedding, so a test-only R0 does not conflict with it.

## Freeze checklist for the R0 contract

| ID    | Required concrete contract                                                                                                                                                                                                                                                                                                                                | Evidence method                                                                                                       |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| R0-01 | Chosen method, with exact predicates, the lexicographic local potential, deterministic tie-breaking and work caps.                                                                                                                                                                                                                                        | Proof review. Controls for a non-convex quadrilateral, a boundary edge, a flip across a J parent edge, ties and caps. |
| R0-02 | Region invariants, checked by a new independent verifier against the input carrier or J mesh: the same boundary-edge multiset after splitting at exactly collinear vertices, equal total exact area, pairwise interior non-overlap, and conformity (no T-junctions). `verifyConformingRefinement` parent containment does not apply to flips or removals. | The new verifier together with `inspectTriangleMesh`.                                                                 |
| R0-03 | Clearance objective and its reporting, including exact `clearanceSummary` before and after.                                                                                                                                                                                                                                                               | Exact summaries per carrier and per row.                                                                              |
| R0-04 | Corpus: the 12 carriers and the 158 mesh-projection rows, reused unchanged as inputs. Prospective literal sliver rows written before results are seen.                                                                                                                                                                                                    | Reuse of the archived inputs and their hashes.                                                                        |
| R0-05 | Re-certification with the unchanged P3.1m certificate, at the fixture origin and under R3's T = 128 origin and windows, including the 8 W and 8 Y O-PX `clearance:triangle` rows. A written, term-by-term prospective counterfactual comes first (see "Review finding").                                                                                  | A new versioned report. Archived records are never mutated.                                                           |
| R0-06 | Ownership (Primary owns the shared seams; workers own disjoint files), validation commands, and a test-only boundary with no Rust change.                                                                                                                                                                                                                 | `pnpm check`, `pnpm test:geometry` and `pnpm build`; changed-Markdown and link checks.                                |

## Review finding: no admission benefit as scoped

The independent review re-evaluated every clearance term on the 158 fixture-origin rows:

| Rows                       | Result                                            |
| -------------------------- | ------------------------------------------------- |
| 12 Y `clearance:fan` rows  | All fail on `fan`                                 |
| 4 Z `clearance:fan` rows   | All fail on `fan`                                 |
| 12 Z `clearance:edge` rows | All fail on `edge`, `triangle` and `fan` together |

The binding `fan` pairs are boundary-boundary pairs bent by the rounded embedding. T1, T2 and T3 cannot change them without changing the region, so under the unchanged certificate R0 as scoped is expected to admit **no** class B fixture-origin row. At best it turns Z's edge and triangle failures into fan failures.

The U2 order assumed that R0 clears part of class B, so that premise does not hold. The unit is returned to the user with these options, none of which Primary adopts on its own:

| ID  | Option                                                                                                                                                                                                                      | Effect                                                                   | Cost and risk                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| R0a | **Certificate refinement.** Restrict the `fan` term to consecutive incident edges bounding a mesh wedge. Triangle orientation and the edge term would cover the remaining pairs, including a nearly straight boundary bend. | Likely removes the boundary-boundary false positives. No visible change. | Needs a new sufficiency proof replacing the reviewed K `shared` predicate, plus a certificate contract amendment. Benefit unknown until evaluated. |
| R0b | **Embedding-aware column placement.** Choose rounded column values that keep straight source edges straight where possible.                                                                                                 | Removes the bends at their source.                                       | Changes the frozen rounded-fill embedding policy and the native carrier bytes. Creates new embedded coordinates within τ. Needs a user decision.   |
| R0c | **Skip R0 and proceed to R2.**                                                                                                                                                                                              | Class A progress.                                                        | Class B stays open until R1 or R4.                                                                                                                 |

`R3 integrated -> N00 readiness -> R0-01..06 written freeze -> test-side implementation -> stable-source review -> exact re-certification -> independent evidence review -> separate runtime-adoption decision`.

N00 passes when Primary and an independent reviewer agree on the feature sources, the method candidates, the claim limits and the checklist, and the changed-Markdown, link, whitespace and scope checks pass. N00 needs no product test or GPU run. Deferred stroke stays deferred, and R0 stays fill-only.
