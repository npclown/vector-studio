# P3.1m U2 certificate-failure path proposal

Status: DECIDED 2026-10-06. The user chose option (a): R3, then R0, then R2, as the planning direction, with R5 only for documented residual inputs. R1 and R4 remain unopened. No contract unit is frozen or implemented by this record. It answers [user decision U2](p3-private-contract.md#user-decisions-on-mesh-position-representation-2026-10-06): failure handling is chosen only after the alternatives are compared. U1 (visible-plus-guard domain), U3 (mesh-specific origin) and U4 (`render.submission-failed` only as a last resort) are already decided. The [private contract](p3-private-contract.md) owns C04, the [requirements](../requirements.md) own visible behavior, and the [active plan](p3-fill-stroke-meshes.md) owns status.

## Failure classes in the integrated evidence

The classes below come from the [P3.1m report](../evidence/p3.1m-position-certificate/report.json). The O-PX counts correct the [review record's](../evidence/p3.1m-position-certificate-review-2026-10-06.md) statement; see its erratum.

**A. Large extent.**

- **Rows:** 2 fixture stress rows and EXT-65536, `position:0`.
- **Cause:** the Shader term grows with the physical magnitude of far vertices.
- **Not in this class:** `LANE-ANCHOR-MAX`, the three `lane-range` literal rows and the O-P1 row `P1-CANCEL-64` are guard-domain controls or are resolved by U3.

**B. Sub-δ features.**

- **Rows:** 28 fixture carrier rows, `clearance:edge` and `clearance:fan`. Of these, 24 are at zoom 0.01 and 4 are Z-S5 at zoom 1, DPR 1.5.
- **Cause:** transported features are below 2δ̄. The reviewed sizes for the zoom-0.01 `fan` rows are about 5e-5 to 1e-4 px.

**C. Degenerate source features.**

- **Rows:** THIN (also the fixture `thin/collapse`) and FTZ, `clearance:vertex` at zoom 1.
- **Cause:** source separations of 2^-25 and 2^-140, both below 2δ̄.

**D. Mesh-origin window.**

- **Rows:** 12 rows newly rejected under O-PX:
  - 8 W bowtie and zero-closure rows (S4 and S7), `clearance:triangle`;
  - 4 Y-S5 rows at zoom 1 and DPR 1.5, `clearance:fan`, with δ̄ about 3.39e-3.
- **Also:** 8 Y S4/S7 rows that were already in class B now report `triangle` instead of `fan`, because the terms are checked in order.
- **Cause:** O-PX lets `‖F‖·z·q` reach 2048 px, and g reaches 2^16 at zoom 0.01 and DPR 1. This is not only a low-zoom effect.

**Floors.** Under the M01 error model, every row has `δ̄ ≥ δ0 ≈ Γ * sqrt((W/2)^2 + (H/2)^2)`. The observed minimum is δ̄ = 4.597e-4 px at 640x360 and 9.193e-4 px at 1280x720.

That is the bound of this certificate, not a floor for every carrier:

- Any binary32-NDC carrier still has a vertex-independent rounding term of order `2^-24 * W/2`, about 3.8e-5 px at 1280 px.
- Rasterizer fixed-point subpixel snapping, which M01 does not model, adds a further floor.

So this certificate cannot clear features below `2 * δ0`, and no binary32 carrier can clear features far below about 1e-4 px. Class C and the smallest class B features are below both floors, so they need a geometric or coverage answer, not a numeric one.

## Alternatives

| ID  | Alternative                                                                                                                                                                                                                                               | Classes                                      | Visible effect                                                                                                                                                                                                                                                                                    | Cost and risk                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R0  | **Clearance-aware triangulation in the P3 generator, before transport.** Avoid generator-induced slivers by choosing a different exact triangulation of the same region. Vertical-slab decomposition can create slivers whatever the source feature size. | Generator-induced slivers (part of B); not C | None only where a different exact triangulation of the same region avoids the sliver, that is, for generator-induced slivers. Source-level near-coincidence (class C) cannot be cleared without either a region change (R1 semantics) or a rejection (R5/U4), so R0 alone does not close class C. | Needs a generator-side clearance contract, reusing the exact mesh oracles. Fill-only while stroke refinement is deferred.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| R1  | **Scale-bucket feature floor.** Collapse features whose physical size is below a floor φ.                                                                                                                                                                 | B, C                                         | Removes slivers or tiny components. **This is a visible-semantics change.**                                                                                                                                                                                                                       | Requires an explicit amendment of the 0.0625 topology row in the [allocation table](p3-private-contract.md#numeric-compatibility-decision), from region preservation to a bounded region deviation, with a new deviation oracle. The existing exact-region oracles (P3.2d/P3.2e) then cover unsimplified output only. It needs its own user decision. Its budget depends on the viewport: at 1280x720, 4δ0 is about 3.7e-3 px, but keeping φ viewport-independent at the lane bound W/2, H/2 ≤ 2^13 gives about 0.058 px, 93% of the 0.0625 row. If φ is keyed only on the σmax bucket, anisotropic transforms also need σmin bucketing or a σmax/σmin factor. Fill-only. |
| R2  | **Bounded-extent tiling plus the U1 domain.** Split meshes on a tile grid that is fixed in local space and independent of the camera, so that every triangle touching the visible region plus guard has a certified vertex set.                           | A                                            | None if seams are exact.                                                                                                                                                                                                                                                                          | Offscreen vertices of a triangle that crosses the visible region still move its visible edge, so U1 alone is unsound without tiling. This depends on the same clipping and raster contracts as R4. It adds draws and uploads.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| R3  | **Tighter mesh-origin window.** Use a 128 px O-PX target, so `‖F‖·z·q ≤ 256` px.                                                                                                                                                                          | D                                            | None.                                                                                                                                                                                                                                                                                             | More frequent rebases. A rebase is expected to rewrite only mesh-origin lanes; C04 defines them. The rebase count must be measured on P1-style trajectories.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| R4  | **Coverage-bounded acceptance.** Accept failures whose possible coverage change is below a raster tolerance.                                                                                                                                              | B, C                                         | Bounded coverage deviation.                                                                                                                                                                                                                                                                       | Blocked on the open raster coverage, fringe and MSAA contract.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| R5  | **Last-resort error (U4).**                                                                                                                                                                                                                               | Residual only                                | The mesh is not drawn.                                                                                                                                                                                                                                                                            | The requirements must list exactly which inputs can reach it. No new public variant.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**Mapping of the U2 candidates recorded in the private contract:**

| Candidate                | Maps to                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| Minimum-scale exception  | R5, for residual inputs only. As a silent skip it is rejected.                            |
| Sub-pixel simplification | R1                                                                                        |
| Mesh splitting           | R2                                                                                        |
| Per-mesh re-anchoring    | Already provided by the carrier's per-mesh midpoint and anchor. Its remaining part is R3. |

**Rejected:**

- Silently returning coarse geometry, which the [private contract](p3-private-contract.md#numeric-compatibility-decision) forbids.
- Re-meshing on pan, which contradicts P2's rule that translation does not rebuild geometry.

## Recommendation

Adopt **R3, R0 and R2** as the planning direction, and keep R5 only for documented residual inputs.

| Option | When                                                         | Status                                                                                            |
| ------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| R3     | First                                                        | Smallest change: a certificate rerun with rebase counts                                           |
| R0     | Next                                                         | Targets generator-induced slivers only. Class C stays open with class B until R1 or R4 is decided |
| R2     | After the clipping and guard contract                        | —                                                                                                 |
| R1     | Only if R0 cannot clear the remaining class B and C features | Needs a separate user decision on bounded region deviation                                        |
| R4     | Deferred                                                     | Waits for the raster coverage contract                                                            |

Under this direction, classes B and C may stay unadmitted until R1 or R4 is decided. Such meshes are sub-pixel, so the visible stake is small, but it is not zero.

Each adopted option needs its own frozen contract, independent review and exact evidence. Nothing changes runtime behavior before the C04 layout freeze.

## Decision requested

Choose one:

- **(a)** Adopt the recommendation (R3, then R0, then R2; R5 residual only) as the planning direction.
- **(b)** Also open R1 now as a separate bounded-region-deviation semantics decision.
- **(c)** A different combination.
- **(d)** Defer U2 until raster coverage evidence exists.

Choosing (a) authorizes only the contract units named above. It does not authorize implementation outside them, or any change to requirements, thresholds or public behavior.
