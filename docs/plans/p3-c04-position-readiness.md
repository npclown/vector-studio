# P3.1m C04 vertex position representation readiness

Status: M00 documentation/readiness review. Nothing is adopted: no position representation, layout or runtime behavior is selected. The [private contract](p3-private-contract.md) owns C04, and the [active plan](p3-fill-stroke-meshes.md) owns execution status. On 2026-10-06 the user selected this readiness step as the next work unit after P3.1l. Adopting any representation remains a separate user decision.

## Question

C04 item 2 requires a frozen "vertex position representation and local origin" before any mesh ABI or renderer packet. This note answers three questions:

- what the integrated K and L evidence supports for that item;
- what it does not support;
- which concrete obligations must be frozen before a successor private position layout can be proposed for adoption.

It does not address coverage/edge-distance attributes, index width, region labels, fill/stroke ordering or any other C04 item. Those remain open in the private contract.

## Candidate under consideration

The only representation with integrated evidence is K's mesh-local midpoint carrier, defined in the [P3.1k contract](p3-mesh-projection-experiment.md#frozen-arithmetic-graph):

- **Geometry-owned data:** a Float64 per-mesh midpoint `m` and one binary32 local offset `u = f32(v - m)` per vertex. These depend only on geometry, never on transform, camera or origin.
- **Transform-owned data:** binary32 linear lanes `a, b, c, d` and a binary32 anchor `B = f32(W(m) - O)` relative to the packet origin `O`.
- **Frame-owned data:** binary32 lanes `O - camera`, zoom, DPR and physical size, the same lanes as the P1 frame uniform.
- **Vertex stage:** `s = A * u + B`, then `r = s + frameOffset`, then `p = r * zoom * DPR`, then NDC.

A pan inside the same origin changes only frame lanes. An origin rebase or transform edit rewrites anchors and linear lanes only. Local offsets are rebuilt only when geometry changes.

This is consistent with C04 item 5, which requires color and opacity edits to avoid a geometry rebuild. By K's construction, camera and transform edits also leave local offsets unchanged. It also fits the [P1 origin and rebase rule](p1-private-contract.md#precision-and-rebase-contract). In the K corpus, the origin is supplied by the fixture rather than computed by P1's snapping rule. That gap is open obligation M02 below.

## What the evidence supports

| Source                                                                        | Established                                                                                                                                                                                                                                                                                                                                                                                                                          | Not established                                                                                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| [K](../evidence/p3.1k-mesh-projection-review-2026-10-05.md)                   | Under K's declared JavaScript round-to-nearest-even graph, all 40 REQUIRED_PASS and 117 OBSERVE mesh rows certify the unchanged 1/16 physical-pixel share and indexed topology. The thin control is rejected by topology while its position passes, and the origin sequence keeps local-offset bits invariant.                                                                                                                       | Native arithmetic, a priori runtime bounds, unbounded extents and the P1 origin rule                           |
| [L](../evidence/p3.1l-native-projection-review-2026-10-06.md)                 | On one NVIDIA Turing adapter in Chrome 154 and Edge 154, the instrumented vertex stage gave 157 CERTIFIED rows and 1 TOPOLOGY_REJECTED row (the thin control). Readbacks are deterministic across browsers and runs. 83 clip words differ from K, with no status change.                                                                                                                                                             | Other adapters, backends or drivers; uninstrumented shaders; raster coverage and clipping; a product guarantee |
| Archived L records together with K's physical magnitudes (a characterization) | The two largest native errors are on stress rows that touch the viewport but extend far offscreen. In each, the worst vertex (index 2) is the far vertex, about 741,000 and 811,000 physical pixels from the viewport's top-left physical origin. Their errors are about 0.040 and 0.024 pixel against the 0.0625 share. The 146 rows whose vertices all lie within 4096 physical pixels have a worst error of about 0.000106 pixel. | Any bound. Physical magnitudes here come from K's CPU model and serve only as a characterization.              |

The observed error grows with physical extent, which is consistent with binary32 spacing. The corpus is too small to fit a scaling law. In the clip-space stages, rounding error scales with distance from the viewport rather than with mesh size alone. Whole-mesh certification over unbounded offscreen extents therefore cannot hold in binary32 for every finite input. The final binary32 physical coordinate alone has spacing 0.25 pixel for magnitudes in [2^21, 2^22). Rounding it can therefore displace a vertex by up to 0.125 pixel, which exceeds the 0.0625 share whatever the carrier. The worst row already uses about 64% of the share. Neither K nor L supplies a check that a runtime could evaluate before uploading. Their audits are exact, after-the-fact verifications over a finite corpus.

## Blocking gaps before adoption

1. **A priori admission certificate.** A runtime needs a conservative, cheaply computable bound on the total position error of the carrier, from inputs available at pack time:
   - the local offset magnitudes;
   - linear, anchor and frame lane magnitudes;
   - zoom, DPR and viewport size.

   The bound must hold under every evaluation the pinned [WGSL rules](https://www.w3.org/TR/2026/CRD-WGSL-20260921/#floating-point-evaluation) permit: reassociation, fusion, the division accuracy allowance and subnormal flushing. A bound that holds only for the K graph is insufficient, because L observed different words.

2. **Visible-plus-guard versus whole-mesh obligation.** K deliberately certified whole meshes. P1 bounds only visible geometry plus a guard band. Large offscreen extents need an explicit choice:
   - (a) obligate only vertices whose geometry intersects the viewport plus guard, while topology across the guard stays preserved by a separate argument; or
   - (b) bound the admissible extent and reject beyond it.

   The choice interacts with clipping and raster coverage, which are still open. Any option that introduces new user-visible rejection is a requirement change, and so needs user approval.

3. **Topology clearance.** Positional bounds do not preserve connectivity, as the thin control shows. Adoption needs one of:
   - an a priori clearance test comparing the certificate radius with distinct-vertex separation, triangle double-area slack, shared-edge predicate slack and disjoint-edge distance, as in K's [carrier eligibility inventory](../evidence/p3.1k-projection/carrier-eligibility-exact.json);
   - an explicit failure precedence that rejects the mesh rather than drawing a changed complex.
4. **Origin integration.** The packet origin must come from the P1 snapping and hysteresis rule, not from fixture literals. The certificate must then hold for every camera position inside one origin's hysteresis window.
5. **Adapter breadth.** Native evidence exists for one adapter and backend. An a priori bound valid under all permitted WGSL evaluations reduces this to corroboration. Without such a bound, adapter coverage would be the only support, and that would be insufficient support for adoption.

## Freeze checklist for the next contract

Every M-item below needs a concrete written answer and independent review before any implementation:

| ID  | Required concrete contract                                                                                                                                                                                                                                                                                                                                                                                                                                 | Evidence method to freeze                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M01 | The certificate formula: per-stage error terms for the CPU binary64-to-binary32 packing and for each shader operation under the permitted WGSL evaluations, combined in one physical Euclidean norm, with every guard included inside the 1/16 share                                                                                                                                                                                                       | Exact proof review. An independent exact checker shows certificate ≥ actual displacement on every K row, every archived L row and adversarial rows that target each term, and reports which K and L rows the certificate admits, so that a vacuous always-reject certificate is visible |
| M02 | Origin derivation from P1's rule, the camera window within one origin, and anchor/frame lane derivation; whether the certificate is evaluated per pan or per origin window; re-evaluation on a zoom, DPR or viewport-size change and on newly visible meshes, matching P1's budget-recheck rule (which by itself does not dirty geometry)                                                                                                                  | Exact replay of P1 N03-style sequences, plus a proof that the certificate is monotone over the window                                                                                                                                                                                   |
| M03 | The obligation domain (whole mesh, or visible plus guard) and behavior when the certificate fails: a rebase attempt, a finer origin, rejection or an alternative representation. Any user-visible change is escalated. State the relation to P1's existing finite-but-unrepresentable outcome (`render.submission-failed` with a numeric-preparation reason); reusing it for meshes needs explicit confirmation that it adds no new user-visible rejection | Written precedence and an explicit list of user decisions. No silent coarse output                                                                                                                                                                                                      |
| M04 | A topology clearance predicate in terms of the certificate radius, and its precedence relative to position                                                                                                                                                                                                                                                                                                                                                 | Exact predicate tests on K carriers and the thin control, plus counterexamples showing that position alone is insufficient                                                                                                                                                              |
| M05 | Corpus and controls: K and L rows reused unchanged as data, and new prospective literal rows written before any result is seen (large offscreen extents, near-threshold rows, origin-window edges)                                                                                                                                                                                                                                                         | Host-only exact verification. Native confirmation is an optional later checkpoint using the L runner seam with a separately frozen corpus                                                                                                                                               |
| M06 | Ownership and validation: test-only modules, no runtime/ABI/API/dependency change, and the commands that will verify the work                                                                                                                                                                                                                                                                                                                              | `pnpm check`, `pnpm test:geometry` and `pnpm build`. Changed-Markdown/link checks for any documentation-only step                                                                                                                                                                       |

The certificate is a sufficient condition and not a precision theorem for arbitrary inputs. Meeting it on a corpus does not adopt the carrier. Adoption into a C04 layout needs Primary review, independent review and the user's decision. C04 items 1 and 3-6, coverage and composition stay open.

## Dependency order and acceptance

`L integrated -> M00 readiness -> M01-M06 written freeze -> host-only certificate implementation and exact verification -> independent evidence review -> user adoption decision -> later C04 layout freeze`.

M00 passes when Primary and an independent reviewer agree on:

- the evidence boundaries;
- the gaps;
- the checklist;
- this dependency order.

M00 also requires passing changed-Markdown formatting, local link/anchor, whitespace and scope checks. It needs no product test, GPU run or benchmark. Required protected PR CI still applies.

Deferred stroke stays deferred. No public export, dependency, renderer change, threshold change or rejection policy follows from this note.
