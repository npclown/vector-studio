# P3 fill and stroke meshes execution plan

## D8: parallel visualization and engine tracks

Under [D8](p3-d8-parallel-tracks.md), user-approved on 2026-10-08, P3 runs two tracks:

- **Track A, visualization, leads:** V1 path scene and port proposal (needs user approval), V2 fill-mesh WASM export (functional transport v0), V3 renderer mesh pipeline (fill only, untiled carrier), V4 playground path page.
- **Track B, engine:** B0 performance feasibility (scaling within current caps), B1 kernel caps, B2 stroke contract, B3 defects that Track A finds, B4 A04 corpus and measurement contract.

The P3.1p precision-certificate line below is **parked** at its frozen T04 contract. A04 is now evidenced by measurement on a frozen corpus against an independent oracle; the 0.25-pixel target is unchanged. Process tiers and agent roles are owned by [`AGENTS.md`](../../AGENTS.md#agent-roles). The [D8 amendment of 2026-10-08](p3-d8-parallel-tracks.md#amendment-2026-10-08-plan-review-findings) added B4, the V2/V3 restatements, the B0 restatement and the [C04 carve-out](p3-private-contract.md#private-transport-and-lifetime-requirements).

**Status index.** Checkpoints under D8, with their state and evidence. Pre-D8 sections below keep their contemporaneous text.

| Checkpoint                           | Tier                                                  | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Evidence or contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1 path scene and port proposal      | Full                                                  | APPROVED 2026-10-08; ADR 0002 accepted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | [V1 proposal](p3-v1-path-scene-port-proposal.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| V2 fill-mesh export, transport v0    | Full (ABI)                                            | Contract FROZEN 2026-10-12; implemented; evidence review ACCEPTED; PR open; precision UNVERIFIED                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | [V2 contract](p3-v2-fill-mesh-transport-contract.md), [evidence](#v2-implementation)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| V3 renderer mesh pipeline, fill only | Full (draw contract)                                  | Contract APPROVED 2026-10-12; V3a (#132), V3b (#133) and V3c (#134) merged; precision UNVERIFIED                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | [V3 contract](p3-v3-renderer-mesh-pipeline-contract.md), [V3a evidence](#v3a-implementation), [V3b evidence](#v3b-implementation), [V3c evidence](#v3c-implementation)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| V4 playground path page              | Light                                                 | Not started; after V2 and V3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| B0 performance feasibility           | Full (benchmark contract with a decision rule)        | Reference run 2026-10-12: verdict INFEASIBLE (provisional at k = 2), all checks pass; independent evidence review ACCEPTED. User decision 2026-10-13: remedy by the B0R kernel performance contract, budgets and architecture unchanged; B0R's remeasure updates the verdict. B0R remeasure 2026-10-17: verdict INCONCLUSIVE (check 2 fails, prediction factor 3.248 > 2; the other checks pass); independent evidence review ACCEPTED (PR #146). User decision 2026-10-18 (chat, B0-Q3): an alternatives-comparison proposal before choosing a direction; the B0 direction proposal (independent review READY) is decided: user decisions 2026-10-18 (chat) B0D-Q1 to Q6 all (a), the Alt-A1 fallback ladder gated by a test-only spike with budgets unchanged. B1 stays blocked. Spike contract FROZEN 2026-10-18: independent review round 2 READY, user approval in chat with SL-Q1 (a). SL-U1 (fast rung, ladder, fixtures, seeded defects) implemented 2026-10-18, independent diff and proof-correspondence review pending ([SL-U1](#b0-spike-sl-u1-implementation)). SL-U1 merged through PR #149. SL-U2 (independent TypeScript oracles SL-O1, SL-O2, SL-O3 area band, SL-O5, positive controls) implemented 2026-10-18, independent diff review pending ([SL-U2](#b0-spike-sl-u2-implementation)). SL-U2 merged through PR #150. SL-U3 (harness, runner, analysis, validator, oracle run and dump, root script) implemented 2026-10-18, independent diff review pending ([SL-U3](#b0-spike-sl-u3-implementation)); reference configuration hash `0daa96c068504c33dcf17ca787c1995db4972a76a006cd6db79473243fe72267`. SL-U3 merged through PR #151. SL-U4 reference run 2026-10-18 (run `20261018T213619Z-89016cc9`, `main` `9505ddd`): verdict INCONCLUSIVE (check 2 fails, prediction factor 2.610 > 2; the other checks, the four oracle gates SL-O1 to SL-O4 and the harness checks pass); independent evidence review (SL-A11) ACCEPTED ([SL-U4](#b0-spike-sl-u4-reference-run)) | [B0 contract](p3-b0-feasibility-benchmark-contract.md), [B0 result](../benchmarks/results/2026-10-12_p3_p3-b0-feasibility-v1_native_desktop-dkvusav_20261012T144359Z-65a7b05f.md), [user decision](#b0-reference-run), [B0R remeasure result](../benchmarks/results/2026-10-17_p3_p3-b0-feasibility-v1_native_desktop-dkvusav_20261017T150336Z-23973138.md), [B0 direction proposal](p3-b0-direction-proposal.md), [B0 spike contract](p3-b0-spike-ladder-contract.md), [B0 spike result](../benchmarks/results/2026-10-18_p3_p3-b0-spike-ladder-v1_native_desktop-dkvusav_20261018T213619Z-89016cc9.md)                                                                                                                    |
| B0R kernel fill performance          | Full (outcome-preserving kernel change and remeasure) | Contract FROZEN 2026-10-13 after independent review round 3 READY (rounds 1-2 NOT READY, resolved; round 3 also covered implementability). User decisions 2026-10-13: B0R-Q1 include, B0R-Q2 (a), B0R-Q3 (a). U0 identity tool implemented, `pnpm test:p3-fill-identity` PASS. U1 topology filters merged through PR #138. U1b low-limb skipping merged through PR #139. U2 sweep candidates merged through PR #140. U3 binary64 filters merged through PR #141. U4 column and section filters merged through PR #142. U5 endpoint sections and slab sentinels merged through PR #143. U6 event-loop restructuring merged through PR #144. U7 scan restructuring (L3, L4) merged through PR #145. U8 remeasure run 2026-10-17 on `main` `0b48163`: identity cross-check PASS; verdict INCONCLUSIVE (check 2 fails, prediction factor 3.248 > 2); independent evidence review ACCEPTED (PR #146)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | [B0R contract](p3-b0r-kernel-performance-contract.md), [U0 evidence](#b0r-u0-implementation), [U1 evidence](#b0r-u1-implementation), [U1b evidence](#b0r-u1b-implementation), [U2 evidence](#b0r-u2-implementation), [U3 evidence](#b0r-u3-implementation), [U4 evidence](#b0r-u4-implementation), [U5 evidence](#b0r-u5-implementation), [U6 evidence](#b0r-u6-implementation), [U7 evidence](#b0r-u7-implementation), [U8 evidence](#b0r-u8-remeasure), [first B0 result](../benchmarks/results/2026-10-12_p3_p3-b0-feasibility-v1_native_desktop-dkvusav_20261012T144359Z-65a7b05f.md), [remeasure result](../benchmarks/results/2026-10-17_p3_p3-b0-feasibility-v1_native_desktop-dkvusav_20261017T150336Z-23973138.md) |
| B1 kernel caps                       | Light                                                 | Not started; after the B0R remeasure verdict, under the B0 decision rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| B2 stroke contract proposal          | Full                                                  | Not started; needs approval                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| B3 kernel defects from Track A       | Light                                                 | Open as found                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| B4 A04 corpus and measurement        | Full                                                  | Not started; after V2 and V3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| P3.1p T04 sliver mitigation          | Full                                                  | Parked, contract FROZEN                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | [T04 contract](p3-t04-sliver-mitigation-contract.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| P3 A01-A08                           | —                                                     | All TODO; see the acceptance table                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | [acceptance table](#runtime-acceptance-coverage-to-freeze-in-p30b)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

**Next:** V4, gated by the builder-cost rule in the [V3c entry](#v3c-implementation), under the [approved V3 contract](p3-v3-renderer-mesh-pipeline-contract.md). On Track B: B0R units U0-U7 are merged, and U8's reference run (the B0 remeasure) gave verdict INCONCLUSIVE with identity cross-check PASS ([U8](#b0r-u8-remeasure), [record](../benchmarks/results/2026-10-17_p3_p3-b0-feasibility-v1_native_desktop-dkvusav_20261017T150336Z-23973138.md)). Under user decision B0-Q3 and the [frozen B0 decision rule](p3-b0-feasibility-benchmark-contract.md#5-extrapolation-and-the-feasibility-decision), the INCONCLUSIVE verdict went to the user, who chose on 2026-10-18 an alternatives-comparison proposal first ([decision](#b0r-u8-remeasure)). Next: the [B0 direction proposal](p3-b0-direction-proposal.md) is decided (independent review READY; user decisions 2026-10-18, B0D-Q1 to Q6 all (a)): write the full-tier spike contract for Alt-A1, the fallback ladder (proposal section 5, unit 1), for independent review and the user's approval. B1 stays blocked until the spike's verdict. B0R chooses no further remedy. Update 2026-10-18: the [B0 spike contract](p3-b0-spike-ladder-contract.md) is FROZEN (independent review READY, user approval in chat, SL-Q1 (a)); next, its units SL-U1 to SL-U5, ending in a reference run whose verdict goes to the user. B1 stays blocked until then. Update 2026-10-18: [SL-U1](#b0-spike-sl-u1-implementation) is implemented on its branch; next, its independent diff and proof-correspondence review, then SL-U2. Update 2026-10-18: SL-U1 merged through PR #149; [SL-U2](#b0-spike-sl-u2-implementation) is implemented on its branch; next, its independent diff review, then SL-U3. Update 2026-10-18: SL-U2 merged through PR #150; [SL-U3](#b0-spike-sl-u3-implementation) is implemented on its branch, with the reference configuration hash `0daa96c068504c33dcf17ca787c1995db4972a76a006cd6db79473243fe72267` recorded for SL-A10; next, its independent diff review, then SL-U4 (the reference run). Update 2026-10-19: SL-U3 merged through PR #151; [SL-U4](#b0-spike-sl-u4-reference-run)'s reference run gave verdict INCONCLUSIVE (check 2, prediction factor 2.610 > 2; every oracle gate PASS) ([record](../benchmarks/results/2026-10-18_p3_p3-b0-spike-ladder-v1_native_desktop-dkvusav_20261018T213619Z-89016cc9.md)); the independent evidence review (SL-A11) is ACCEPTED; the user decided on 2026-10-19 (SL-U5) to write the full-tier Alt-A1 production contract, with its own performance gate ([decision](#b0-spike-sl-u4-reference-run)). Next: that contract, for independent review and the user's approval. B1 stays blocked until then.

### V2 implementation

Full tier, under the [frozen V2 contract](p3-v2-fill-mesh-transport-contract.md). Functional evidence only: precision is **UNVERIFIED** against the 0.25 physical-pixel target until B4 has A04 evidence. V2 closes no A01-A08 criterion and no C03-C05 item.

Landed: the V1 section b port types in `packages/contracts/src/geometry.ts`; the kernel `fill_v0_*` family (`fill_export.rs`, `FillEngine`, `FILL_V0_LIMITS`, revision 1) beside the unchanged P2 exports, with only the two additive P2-side items of section k item 3; the `createFillMeshPort` adapter in `packages/geometry-wasm/src/fill-adapter.ts`; the P-B1 policy entry and P-B2 contracts purity check with exported evaluation functions; the shared conformance suite C01-C18 with its test double; and `tooling/compare-p2-wasm.mjs` (`pnpm test:p2-identity`) for section k item 6.

Local evidence, 2026-10-12, Windows 11, pinned Rust 1.94.1, Node 24.15.0:

- `pnpm test:geometry`: PASS. Kernel fmt and clippy clean; native `cargo test` 227 passed, 18 ignored, including 21 `fill_export_tests` (framing rejections, the exhaustive mapping table and one fixture per reachable row found, cascade order, capacity retry with exact `required_output_bytes`, transport caps at limit and limit + 1, epochs and exhaustion, dispose, workspace construction failure, self-check recovery, zero allocation in `process`, both hanging fixtures); geometry vitest 43 files passed, 4 skipped; 733 tests passed, 6 skipped, including `fill-adapter.test.ts` (52, each fail-closed trigger pinned to the specific breach reason) and the WASM conformance run (20). The independent-build reproducibility check passed.
- `pnpm test:unit`: 57 files, 600 tests passed, including the double conformance run (20), the mesh-check positive controls (5) and the P-B1/P-B2 fixtures (`fill-port-boundaries.test.ts`).
- `pnpm check`: PASS (format, lint, typecheck, unit tests, boundaries including contracts purity).
- `pnpm build`: PASS.
- `pnpm test:p2-identity`: PASS. The comparison builds the working tree, so it was run on a clean tree at the committed V2 head over merge base ab08689: 10,048 differential batches, 10,047 with published output, 153,299,036 output bytes identical between main's release WASM (SHA-256 3f20b4e9...b17a) and V2's (2075c339...7e2).

Independent evidence review (`reviewer`, V2-A13): NOT ACCEPTED with one blocking item, a missing fixture for the reachable rounded work-limit row, resolved with the {13/6} star; its SHOULD-FIX items (fail-closed triggers pinned to their breach reason, refreshed evidence) applied; the re-review returned ACCEPTED.

Interpretations recorded for review:

- Mapping rows reached by a native fixture: sizing `NUMERIC_RANGE` and `WORK_LIMIT`, `SourceLimit`, `CommandLimit`, `UnsupportedSource`, `ZeroLengthLeaf`, `Topology(Unresolved)` in both cascade steps, `Topology(KnotMismatch)` retried, `Rounded(TopologyAmbiguous)`, and the rounded work-limit row through `Rounded(NodeLimit)` on the line-only star polygon {13/6} of radius 100 (a current-cap fixture that B1 may re-baseline). The internal rows are covered by the exhaustive table test of the mapping function.
- `Topology(WorkLimit | ByteLimit)` has no fixture. `ByteLimit` is returned only by the topology workspace constructors, so it can arise at `fill_v0_reserve` but never from an attempt. `WorkLimit` has four sources. The count check and the leaf-push check cannot fire, because `cubic_fill.rs` rejects more than 16 source segments, 4 contours or 64 edge owners earlier with `SourceLimit` or `OwnerLimit`, and every topology leaf, closure leaves included, has an edge owner. The pair check cannot fire, because 64 leaves give at most 2,016 pairs, equal to `max_pairs`, and the check precedes the increment. The matching-policy crossing ceiling cannot fire, because 64 leaves admit at most 32 disjoint partner pairs. Only the triangle-free 32-crossing ceiling can fire in principle. A bounded search for an input reaching it (sawtooth comb strips, a cubic wave crossed by LINE strips, wavy and concentric cubic rings) always failed earlier with `CommandLimit`, `OwnerLimit`, `KnotMismatch` or `Unresolved`, mainly because adjacent leaves must stay projected-monotone, which forbids the sharp turns that dense crossings need within 72 flat commands. The row stays covered by the table test; B1 or B3 may add a fixture once caps change.
- The fail-closed tests observe the breach reason through an optional `onFailClosed` callback of the test entry `createFillMeshPortFromExports`, which is not exported from the package index. The package index exports only `createFillMeshPort` and the `FillMeshAdapter` type of section h.
- The section f test-side check uses the exact `inspectTriangleMesh` and `classifyLineFill` of `geometry-reference` as oracles and recomputes orientation, conformity and the used-once edge multiset in exact integer arithmetic in the test helper, because the reference package does not export a bare orientation predicate. Region-boundary equality is checked by exact samples on each listed edge and by coverage of every oracle-boundary span of the source edges.
- The kernel zeroes the output header at the start of each `fill_v0_process`, so a stale header never survives a failed call; the adapter never reads it without `result_len > 0`.
- The P2 identity comparison drives the P2 v1 exports directly so that whole output byte streams are compared.

### V3a implementation

Full tier, unit V3a of the [approved V3 contract](p3-v3-renderer-mesh-pipeline-contract.md#o-implementation-units): CPU only, no GPU. Functional evidence only: precision is **UNVERIFIED** against the 0.25 physical-pixel target until B4 has A04 evidence, and no Q4 coverage threshold is claimed. V3a closes no A01-A08 criterion and no C03-C05 item. Interpretation 3 of V3-C1 (bisection after `internal-error` or `resource-limit` reads V1 rule 3 narrowly) is implemented as written and must be restated in the PR.

Landed:

- `packages/contracts`: the section a scene types (`ScenePathVerb`, `SceneFillRule`, `ScenePathGeometry`, `PathStyle`, the `path` member of `RenderNodeSnapshot`) and the section h code `PATH_MESH_INTERIM_FAILURE: 'render.path-mesh-interim-failure'`.
- `renderer-core`: `RetainedSceneMirrorOptions` and path validation, replay equality and owned copies (`scene-validation.ts`, `scene-mirror.ts`); the mirror-owned geometry revision with `RetainedSceneView.getGeometryRevision` and overflow handling; the point-box bounds rule (`scene-numeric.ts`); the exact BigInt buckets `e` and `f` with the f32 orientation check (`path-buckets.ts`); the CPU pipeline (`path-mesh-pipeline.ts`): consumption order, one batch per `prepare`, depth-first left-first isolation with a resumable stack and the 32-call bound, response validation, the reuse rule, the mesh cache with byte accounting and eviction, the failure memo with expiry and the `disposed` latch, the three failure classes, and the notice queue; `PrimitiveRendererServiceOptions` with the port shape check (`primitive-renderer-service.ts`).
- Tests named by criterion: `v3a-path-scene.test.ts` (V3-A1, V3-A2), `v3a-path-buckets.test.ts` (V3-A5, with an independent brute-force Sylvester-criterion oracle), `v3a-path-pipeline.test.ts` (V3-A3 to V3-A9, the CPU part of V3-A15, V3-A18), `v3a-primitive-packet-golden.test.ts` (V3-A16), and the counting, failing and range doubles in `tests/support/v3a-path-harness.ts`.

Local evidence, 2026-10-12, Windows 11, Node 24.15.0:

- `pnpm check`: PASS. Format, lint, typecheck, boundaries (contracts purity PASS, renderer-core -> contracts only); `pnpm test:unit` 61 files, 663 tests passed (V2 baseline 57 files, 600 tests; V3a adds 63: scene 16, buckets 5, pipeline 41, golden 1).
- `pnpm build`: PASS.
- `pnpm test:geometry`: PASS, unchanged from V2: native `cargo test` 227 passed, 18 ignored; geometry vitest 43 files passed, 4 skipped; 733 tests passed, 6 skipped.
- V3-A16 headed evidence, 2026-10-12, on the review fixes, NVIDIA GTX 1660 SUPER: `pnpm test:gpu` PASS, 38 passed in Chrome and Edge (18.5 min), including the P1 primitive, precision, position-probe and latest-scene recovery specs; `pnpm benchmark:p1 --profile functional` PASS, 8 passed in Chrome and Edge (records under ignored `artifacts/p1.6b/`; functional only, P1/A09/A10 stay UNVERIFIED).
- V3-A16 golden: a fixed primitive-only corpus (containers, rotation, hidden nodes, a stroked line, a culled node, pans, a rebase, an insert and removal, a generation change, a DPR and size change, dispose) is serialized field by field, with key order and write bytes, and hashed. The digest `818841068e24...66997282` was recorded by running the test against main 4e6e40d before any V3a source change; it is unchanged after V3a.
- V3-A18: `apps/playground` has no change and no `fillMesh` or `geometry-wasm` reference, checked by a unit test and the diff. V4 removes that test when the playground gains the port.
- `git diff --check` and Prettier on the changed Markdown with an empty ignore file: see the PR.

Interpretations recorded for review:

- **P1 test files (erratum to V3-A16, accepted at review).** Recorded as [interpretation 5 under V3-C1](p3-v3-renderer-mesh-pipeline-contract.md#l-acceptance-criteria-and-validation); the reviewer reproduced the golden SHA on main 4e6e40d. Adding the `path` member to `RenderNodeSnapshot` breaks type narrowing in two P1 test files, so V3-A16's "no edits to P1 tests" cannot hold literally with section a. Two type-only edits keep them compiling with unchanged runtime behavior: `tests/support/p1-visual-oracle.ts` gains `if (node.kind !== 'primitive') return;` after its container branch, and `tests/unit/primitive-native-integration.test.ts` casts one spread to the primitive member. No assertion, fixture, probe or runner changes.
- **Observable output before V3b.** V3a has no packet mesh part. Each `prepare` keeps a CPU `PathMeshFrame` (`getPathMeshFrame()`, on the source only and marked `@internal`; the service does not expose it): the served paths in paint order and the at most 32 notices of that packet, oldest first. V3b moves both into `mesh.draws` and `mesh.notices`. The P1 packet is untouched, including a single analytic draw. Notices leave the queue only when a packet is returned, so a throwing `prepare` keeps them. Since no host has a port (V3-A18), no notice is lost to a host.
- **Fringe seam.** V3a installs no fringe builder, so draws carry `fringeBucket: null`. The variant rules of sections d and e (marking, `f ≤ f′ ≤ f + 1`, two variants, per-variant bytes) are implemented behind an internal builder seam and tested with a builder double; V3c installs the exact builder. The section f packed Float32 offsets do not exist yet, so V3a accounts only the port arrays and fringe arrays; V3b adds the offsets to the account.
- **State order.** One state code per node and `prepare`, in this order: `port-version`, `tolerance-range`, `fringe-range`, `packing-range`. Their notices carry `toleranceExponent: null`, since no request exists. A node that stops being drawable keeps its last state, so culling in and out does not repeat a notice.
- **Reachability.** The `E_MAX` clamp cannot reach the port: `e > E_MAX` needs `sigmaMax < 2^-1026`, so `sigmaMin ≤ sigmaMax` gives `f ≥ 1028 > F_MAX`, and the `fringe-range` state applies first. The clamp is tested on the bucket function, and the pipeline outcome is tested as `fringe-range`. In a frame that P1 accepts (zoom and DPR finite in f32), `tolerance-range` and `fringe-range` need world lanes outside the f32 range, which also fail the f32 orientation check; the order above keeps all four codes reachable and distinct.
- **Response granularity.** A thrown call, a non-object result, an unknown status or batch code, a non-array or a wrong-length `results` make every key of the call `invalid-response`. A wrong `requestId` (including a swapped order) or exponent echo, an unknown status or failure code in one result affects that result only. An `ok` mesh with no vertex is `invalid-mesh`, since its bounds cannot equal the positions' bounds; an `ok` mesh with vertices but no indices is also `invalid-mesh`, matching V3b's `triangleCount > 0` draw rule. The `invalid-path` notice carries `toleranceExponent: null`, matching its exponent-free memo key.
- **Port reading.** An `operationId` that is not a nonempty string at `prepare` time, or a throwing getter, is treated like a `portVersion` change. The service also rejects a non-function `fillMeshMemoryBytes` with `TypeError`; a hook that throws or returns a negative or nonfinite value omits `portLinearMemoryBytes` for that `prepare`.
- **Isolation details.** When a resumed stack empties, new keys are sent in the next `prepare`. On the `disposed` latch, the keys of the remaining stack ranges are memoized as batch `disposed` at once. In the all-defective case with n = 1000 the implementation makes exactly 1999 calls over 63 prepares.
- **Accounting.** `evictions` counts variant-cap and budget evictions, not unreachable drops. The mesh cache survives a scene identity switch, because geometry revisions do.
- **Test seam.** The overflow fixture uses `setNextGeometryRevisionForTesting`, exported from `scene-mirror.ts` but not from the package index.

### V3b implementation

Full tier, unit V3b of the [approved V3 contract](p3-v3-renderer-mesh-pipeline-contract.md#o-implementation-units): the optional mesh packet part and receipts, the mesh arena and range management, the mesh pipeline created at initialization and recovery, region-triangle draws with `c = 1`, paint-order interleave and device loss. Functional evidence only: precision is **UNVERIFIED** against the 0.25 physical-pixel target until B4 has A04 evidence, and no Q4 coverage threshold is claimed. V3b closes no A01-A08 criterion and no C03-C05 item. Interpretation 3 of V3-C1 (bisection after `internal-error` or `resource-limit` reads V1 rule 3 narrowly) is unchanged from V3a and must be restated in the PR. No host gets a port (V3-A18), so region-only drawing is reachable only from tests.

Landed:

- `renderer-core`: the section f types (`MeshPacketPart`, `MeshFillDraw`, `MeshResourceId`, the `mesh` receipt part) and the optional `requiresMeshPipeline` source flag (`primitive-packet.ts`); the geometry-owned K4 midpoint and binary32 offsets with their bytes in the cache account, and the transform-owned f32 lanes and anchors with their `packing-range` checks (`path-mesh-pipeline.ts`); the O-PX(128) mesh origin, the frame-corner rule, the six resources and byte layouts, first-fit range management with fragmentation repacking, record versions, receipts and latest-state reconstruction (`path-mesh-packet.ts`); the mesh part, the paint-order interleave, receipt matching and the skipped-receipt stop (`primitive-scene-source.ts`); the service flag (`primitive-renderer-service.ts`). The V3a `getPathMeshFrame()` is removed, as the V3a entry above says (V3b moves both into `mesh.draws` and `mesh.notices`).
- `renderer-webgpu`: the vertex-pulling mesh shader `p3-mesh-fill-v0` (`mesh-fill-shader.ts`), its layout and pipeline key (`mesh-pipeline.ts`), the mesh pipeline created next to the P1 pipeline with the limit checks and the unavailable fallback, the generation-owned mesh arena, mesh preflight, merged encoding and the mesh receipt (`native-primitive-scene.ts`), the creation option (`webgpu-platform.ts`), and the flag read at attach, `mesh-pipeline-unavailable` once per generation and notice emission after a non-null `prepare` (`webgpu-backend.ts`).
- Tests named by criterion: `v3b-mesh-packet.test.ts` (V3-A10, V3-A12, the range-management part of V3-A13, V3-A15, V3-A16) and `v3b-mesh-backend.test.ts` (V3-A13, V3-A15, V3-A18), with helpers in `tests/support/v3b-mesh-harness.ts`. The contract assigns no headed check to V3b; V3-A14 stays with V3c.

Local evidence, 2026-10-12, Windows 11, Node 24.15.0:

- `pnpm check`: PASS. Format, lint, typecheck, boundaries (contracts purity PASS, renderer-core -> contracts only); `pnpm test:unit` 63 files, 689 tests passed (V3a baseline 61 files, 663 tests; V3b adds 26: packet 17, backend 9).
- `pnpm build`: PASS.
- V3-A16 headed evidence, NVIDIA GTX 1660 SUPER: `pnpm test:gpu` PASS, 38 passed in Chrome and Edge (17.8 min), including the P1 primitive, precision, position-probe and latest-scene recovery specs; `pnpm benchmark:p1 --profile functional` PASS, 8 passed in Chrome and Edge (records under ignored `artifacts/p1.6b/`; functional only, P1 A09 and A10 stay UNVERIFIED).
- V3-A16 golden: the V3a primitive-only digest `818841068e24...66997282` is unchanged; a service with a port and a primitive-only scene emits packets identical to a service without one, with no `mesh` key. No P1 test, probe or runner file changed.
- V3-A18: `apps/` has no `fillMesh`, `geometry-wasm`, `meshPipeline` or `requiresMeshPipeline` reference, checked by a unit test and the diff.
- Observation, not evidence for any criterion: a scratch script outside the repository compiled the mesh shader and pipeline in headed Chrome on the same GPU with no compilation message or validation error, and drew one region-only packet from `renderer-core`; the covered pixels matched the transformed square and the premultiplied fill exactly.
- `git diff --check`: clean. Prettier on the changed Markdown with an empty ignore file: PASS.

- Independent evidence review (`reviewer`): ACCEPTED with no blocking items; its should-fix items are recorded here.

Open risks:

- **No committed GPU compile of the mesh shader before V3c.** `mesh-fill-shader.ts` and the mesh pipeline are exercised only through fake-device unit tests; no committed spec parses the WGSL or creates the pipeline on a real device until V3c's V3-A14. A compile failure would fall back to `mesh-pipeline-unavailable` with primitives still drawing.
- **Mesh arena above device limits fails the whole packet.** A mesh resource larger than `maxStorageBufferBindingSize` makes every packet `allocation-failed` under P1's rule (interpretation 8), so primitives stop drawing too, which is in tension with section h's "every other node draws". The 64 MiB cache budget's working-set exemption can reach this. A per-part fallback is deferred to V3c or B4.

Interpretations recorded for review:

- **Region-only variants.** V3b installs no fringe builder, so each served entry has one GPU variant: the port vertices, the port triangles with role 0 and no lists or features (`listBase` and `featureBase` 0). Exterior triangles, lists, features and frame corners get their ranges in V3c. A test fringe-builder double's arrays are accounted as in V3a but not packed. The shader evaluates `c = 1` for role 0 and `c = 0` for role 1, which no V3b variant contains.
- **Frame corners.** V3-A10's corner item is met by `meshFrameCorners`, the section e rule with an exact BigInt check, tested against an independent rational oracle; V3c stores the corners in its variants.
- **Notices-only part.** A mesh part with no resources, writes or draws carries notices when the scene has no path slot but notices are queued, and after the first `skipped` receipt in a generation. Its `submitted` receipt carries zero resources; the backend rejects such a part with writes or draws.
- **`packing-range` sources.** Besides V3a's f32 orientation check, V3b reports `packing-range` for an entry whose offsets are not finite binary32 values, for nonfinite linear or anchor lanes, and for every drawable path when the shared `meshFrame` is not finite (in a frame P1 accepts, only at a zoom times DPR below about 7.5·10^-37). Port results are published first and stay cached; notices follow the V3a state-transition rule.
- **Mesh origin.** `originRevision` is replaced at every re-snap, that is whenever O-PX(128) does not keep the previous origin; the rebase count on R3's TR-PAN trajectory at zoom 1 and DPR 1 is 15, equal to R3's count from its own `originPXTarget`.
- **Range management.** Ranges are in elements per region. A range released by packet N is reusable from packet N + 1. Any capacity growth (a geometry region or `meshInstances`) and any fragmentation replace the arena with new incarnations and repack every resident variant contiguously in slot order; instance records of hidden slots are patched to the new bases. Records carry one version symbol per placed range or record.
- **Device loss.** Mesh incarnations and layout survive a generation change; the first packet of a new generation marks every occupied instance record, every resident variant range and `meshFrame` dirty, so the new arena receives the pre-loss bytes.
- **Backend checks.** Draw positions are nondecreasing integers in `[0, analytic draws]`; an instance must be inside capacity and initialized in the current arena; a triangle range must be nonempty and inside `meshTriangles`; `meshFrame` must be initialized before a draw. The backend does not track initialization of geometry ranges, which the CPU source guarantees. A mesh arena beyond the device limits fails the packet as `allocation-failed`, P1's rule.
- **`mesh-pipeline-unavailable`.** It is emitted when the scene is created at initialization or recovery for a source that requires the mesh pipeline and the scene reports it unavailable; a device port that ignores the creation option counts as unavailable.
- **V3a test edits.** The V3a harness observes the pipeline's CPU draws and the packet's notices instead of the removed `getPathMeshFrame()`. Expected cache bytes add the packed offsets (section d): a square entry is 152 bytes instead of 120, and the budget fixture uses 400 bytes instead of 300 to keep its eviction scenario. The throwing-prepare test drops its frame-identity check. No V3a assertion about calls, notices or draws changed.
- **Golden digest.** The V3-A10 digest pins the implementation's mesh bytes against regressions; the field-by-field expectations computed independently in the test are the oracle.

### V3c implementation

Full tier, unit V3c of the [approved V3 contract](p3-v3-renderer-mesh-pipeline-contract.md#o-implementation-units): the fringe builder at the placement V3-Q3 (c) selects, exterior triangles, features and lists, the coverage shader and the headed smoke (V3-A11, V3-A14, V3-A17). Functional evidence only: precision is **UNVERIFIED** against the 0.25 physical-pixel target until B4 has A04 evidence, and no Q4 coverage threshold is claimed. O02's G1-G3 PASS does not transfer to this realization (section e). V3c closes no A01-A08 criterion and no C03-C05 item. Interpretation 3 of V3-C1 (bisection after `internal-error` or `resource-limit` reads V1 rule 3 narrowly) is unchanged from V3a and must be restated in the PR. V3-Q1 (a) adoption stays conditional on V3-A14, B0's E4 draw cost and the R2 per-tile partition. No host gets a real port: V3-A18 stays true until V4.

Landed:

- `renderer-core`: the exact BigInt fringe builder `buildPathFringe` (`path-fringe.ts`), a D8-interim placement under V3-Q3 (c). It ports O02's sector pairing, loop tracing, nesting, bridging, ear clipping and exact partition check from the test-only `exterior.ts` as production code. It encodes the variant's frame corners, region and exterior triangle records, feature lists and EDGE/VERTEX features per section f. The service installs it (`primitive-renderer-service.ts`). The pipeline seam now carries a structured `PathFringe`, each built variant has its own identity and its bytes are its four owned arrays (`path-mesh-pipeline.ts`). The packer places each served fringe variant in its own ranges in all four geometry regions, with the port vertices followed by the four corners (`path-mesh-packet.ts`).
- `renderer-webgpu`: the O02 coverage rule in `p3-mesh-fill-v0` (`mesh-fill-shader.ts`). The shader evaluates at `@builtin(position)`, takes the nearest listed feature with strict-`<` updates, and clamps the far field at 1.0 px to the role constant. It maps local features with the K4 lanes and multiplies side and sector tests by `σ`.
- Smoke fixture: `apps/playground/p3-v3-mesh.html` and `src/p3-v3-mesh.ts`, a test fixture page with a static test-double port (hand-made F01/F02 meshes, no WASM). The Vite build gains the entry, and `.gitignore` gains `artifacts/p3-v3-mesh/`.
- Tests named by criterion: `tests/unit/v3c-path-fringe.test.ts` (V3-A11, 28 tests, with O02's `exterior.ts` as the independent oracle) and `tests/gpu/p3-v3-mesh-smoke.spec.ts` (V3-A14, V3-A17) with its scene and analytic oracle in `tests/support/v3c-mesh-smoke.ts`.
- Owning documents: the [anti-aliasing](../graphics-engine-architecture.md#anti-aliasing) item on the V3 fringe realization with the D8-interim placement exception and its removal at the R2/K1 placement decision, and a [primitive-rendering](../graphics-engine-architecture.md#primitive-rendering) paragraph on the mesh draw. The `pnpm test:gpu` row in [`validation.md`](../validation.md) names the V3 mesh smoke spec, and the A08 row below points to section k.

Local evidence, 2026-10-12, Windows 11, Node 24.15.0:

- `pnpm check`: PASS. Format, lint, typecheck, boundaries (contracts purity PASS, renderer-core -> contracts only). `pnpm test:unit` ran 64 files and 717 tests, all passed (V3b baseline 63 files, 689 tests; V3c adds 28 in `v3c-path-fringe.test.ts`).
- `pnpm build`: PASS, including the `p3-v3-mesh.html` entry.
- V3-A11: on F01-F11, H1, H2 and O02's bowtie pinch, even-odd star and zero-closure shapes, at `f` = −3, 0, 1 and 4, region plus all exterior triangles pass O02's independent `checkPartition` on independently computed fixed-point points (Float64 times 2^1074; corners `m + k`). Every published list equals a brute force over O02's exact rational distances, and every dropped exterior triangle has no feature within `ρ`. The frame margin is at least `ρ` on each side, exactly. A degree-8 vertex gives `fringe-unsupported` (`degree:0:8`), and so do duplicate coordinates (`duplicate:2:3`) and a failed partition. A corner beyond binary32 gives `fringe-range`. In the pipeline both keep the mesh cached, notify once and make no further port call.
- V3-A14 (UNVERIFIED), headed, NVIDIA GTX 1660 SUPER, Chrome 155.0.8059.40 and Edge 155.0.4283.45: final `pnpm test:gpu` after the review fixes: PASS, 42 passed, 0 failed (18.8 min). It includes the P1 primitive, precision, position-probe and latest-scene recovery specs (V3-A16) and the four `p3-v3-mesh-smoke` tests (1x and 4x per browser, 16 renders per browser). In that final run (all 32 renders; the same figures on the earlier full PASS of 42 in 19.1 min):
  - the gated pixels (221,824 to 903,884 per render) deviate at most 0.5/255 from the analytic composite, against the 2/255 gate;
  - the 986 to 6,786 overlap pixels per render sit at least 64.25/255 from the double-opacity value, against the more-than-20/255 gate;
  - after injected device loss, all 903,852 probed pixels and the full frame are equal, with 0 new port calls (3 before, 3 after);
  - no D8-interim notice and no error diagnostic other than the injected loss occurred.
    Records are under ignored `artifacts/p3-v3-mesh/`. Every run directory holds an `UNVERIFIED.txt` label file, and every `observations.json` carries the label.
- V3-A14 edge observation, not gated (`edgeObservation` in `observations.json`). It compares max |observed − O02 rule| over the opaque F02 nonzero square's pixel centers within 1.5 physical px of its boundary and at least 3 px from every other boundary. The rule is evaluated in float64 at the pixel center, and observed is the red channel over black. Axis-aligned edges (identity: 400 pixels at DPR 1, 800 at DPR 2) give 0.00/255. The 30° edges (rotate-30: 598 and 1,198 pixels) give a maximum of 0.55/255 (mean 0.12 and 0.11). Both hold in Chrome and Edge, at 1x and 4x. The independent reviewer's spot check agrees. At rotate-30 DPR 1, pixels (110,51) and (110,52) are analytic 73/235 and observed 73/235 at 1x and 4x. On the reflection, one edge steps from pixel 179 at 0 to pixel 180 at 255.
- P1 flake investigation (review item B1; `docs/validation.md` treats an unexplained flaky test as a failure). The first full `pnpm test:gpu` run on this branch had 41 passed and 1 failed. `P1 visual samples1 dpr1.5` (Chrome) failed at its first `page.evaluate` because `window.__vectorStudioP1` was undefined. The spec sets `trace: 'off'`, and the failure path throws before the spec records page errors, so no trace or page error exists for it. The full rerun passed 42 of 42.
  - Repeats: `pnpm exec playwright test -c playwright.gpu.config.ts tests/gpu/p1-primitives.spec.ts --project chrome --repeat-each 5` on this branch gave 70 passed, 0 failed (42.3 min). The same command on `main` 6dee6fb gave 70 passed, 0 failed (43.4 min). Main ran in a temporary detached worktree outside the repository (`pnpm install --offline`, `tsc --build`), removed afterwards; this branch's uncommitted state was not touched.
  - Analysis: `p1-fixture.ts` assigns the global synchronously at the end of its module, and Playwright's `goto` waits for `load`, which follows module execution. So the global is missing only if the module graph failed to load or threw before that line. A thrown error would be a page error, which the failing path does not record; a failed module fetch from the Vite dev server leaves only a console error. The Vite dependency-optimizer cache (`apps/playground/node_modules/.vite/deps/_metadata.json`, `optimized: {}`, written before this work) rules out a dependency re-optimization reload. No file under `apps/` or `packages/` changed during that run; only `docs/` was edited. The cause is therefore unexplained. It did not reproduce in 140 repeats, 70 on each tree, nor in two later full runs.
  - Disposition: no spec change. The failure is not shown to be a readiness race in the test, and V3-A16 forbids P1 spec edits. It is recorded as an unexplained, non-reproducing P1 fixture-load failure for the coordinator. A separate P1 light-tier work item (`claude/p1-gpu-spec-diagnostics`, proposed 2026-10-12) will make the P1 spec record console messages, page errors and failed requests before its first `evaluate`; until it lands and the cause is explained, the failure stays an open P1 defect under `docs/validation.md`, not a waived one.
- V3-A16 regression guard: `pnpm benchmark:p1 --profile functional` PASS, 8 passed in Chrome and Edge (records under ignored `artifacts/p1.6b/`; functional only, P1 A09 and A10 stay UNVERIFIED).
- V3-A18: `apps/playground` hosts (`index.html`, `main.ts` and the P1/P3 pages) have no `fillMesh` or `geometry-wasm` reference. The smoke fixture page is the only exemption in both V3-A18 unit tests, and it imports no `geometry-wasm`.
- `git diff --check`: clean. Prettier on the changed Markdown with an empty ignore file: PASS.

Interpretations recorded for review:

- **Builder seam and region-only mode.** The seam result changes from `arrays` to a structured `PathFringe` (corners, triangle records, lists, features, counts); its bytes are those four arrays' `byteLength`s (section d). Only the service installs `buildPathFringe`. A `PathMeshPipeline` built without a builder stays region-only, which only tests reach. It remains the `c = 1` region-only mode that section k's MSAA-only baseline needs in V4.
- **Orientation.** `boundaryEdges` are used as port rule 5 orients them, not re-derived from a third vertex as O02 did. Exterior triangles are counterclockwise; O02 flipped them to the region sign, which agrees for a counterclockwise port mesh. A port mesh with clockwise or zero-area triangles fails the partition's orientation check and is `fringe-unsupported`. V2 emits only counterclockwise triangles.
- **Ported unchanged, one lookup indexed.** `traceWalks` indexes outgoing half-edges by tail in ascending edge order. That gives O02's selection (the first candidate, replaced only by a strictly more clockwise one) without scanning every edge. Every other rule is O02's.
- **Feature encoding.** The global order is EDGE features by directed `(from, to)`, then VERTEX features by vertex index. Every boundary feature is stored, and lists hold variant-relative indices. Feature positions are the K4 vertex offsets `fround(v − m)`, so they coincide with the drawn vertices. A sector direction is the exact difference, scaled by a power of two so that its larger component lies in [1, 2), then correctly rounded to binary32 (round-to-odd to 53 bits, then `Math.fround`). Only its sign tests matter, so it never overflows.
- **Dropped exterior triangles.** Without Steiner points an exterior triangle touches a boundary vertex, at distance 0, unless all three corners are frame corners. Only such a triangle can have an empty list and be dropped. The partition check runs on all exterior triangles before any is dropped.
- **Shader rule.** An EDGE contributes when `0 ≤ t·(p − a) ≤ |b − a|` in physical px, which equals O02's `ta ≤ t·p ≤ tb`. Its signed distance is `v = −σ·cross(t, p − a)`, positive outside, with `w = |t.x| + |t.y|`. A physical edge of zero length is skipped. VERTEX sector rays are mapped by the linear lanes alone, since the positive factor zoom·DPR does not change a sign. V3b's `discard` at zero alpha is kept.
- **Variant identity and ranges.** Each built variant has its own identity. The resident set holds entry and variant identities, and the packer places by variant. When a slot's served variant changes, the previous ranges return after the packet, as V3b's release rule says. A variant serving `f ≤ f′ ≤ f + 1` writes no geometry again.
- **V3-A11 corpus.** F01-F11 use the V2 conformance double's meshes; F04 evenodd and F05 are empty and have no fringe. F08 is a hand triangle. F09 reuses the F01 and F02 evenodd regions, which its definition leaves unchanged. H1 and H2 are added. The bowtie pinch (also F06), the even-odd star and the zero-closure shape are O02's synthetic shapes.
- **V3-A14 design.** One container holds, in paint order: F02 nonzero, F02 evenodd, a path between two rectangles, and an opaque rectangle under a half-opacity path. It is drawn under identity, a 30° rotation, a reflection (`a = −1`) and a 3 by 0.5 scale, at DPR 1 and 2, in two tests (`?samples=1` uses the existing 1x fallback injection, as the P1 fixture does) per browser. The gates are the contract's: pixel centers at least 3 physical px from every boundary within 2/255 of the analytic composite over opaque black; overlap pixels more than 20/255 from the double-opacity value; probed pixels equal after injected device loss (identity scene, DPR 2) with zero new port calls. The packet shape is also checked: four mesh draws, two analytic runs, and no D8-interim notice. Full-frame equality after recovery is reported as an observation. Edge pixels are captured, not gated. The port calls between transform variants are not gated: the 30° rotation's rounded lanes put `sigmaMax` of the four-times-scaled paths just above 4, where `e = −5` sits exactly on a bucket edge, so `e = −6` and one call follow. That is section c's rule.
- **Test edits.** The V3a fringe doubles return structured fringes (`fringeDouble`). The V3a service-accounting expectation adds the square's fringe bytes, because the service now builds a fringe. A V3b packer draw literal gains `fringe: null`. Both V3-A18 tests exempt only the smoke fixture page. No assertion about calls, notices or draws changed.
- **V3-A18 reading.** V3-A14 (section l) requires a fixture page under `apps/playground` with a static test-double port. That page, `p3-v3-mesh.ts`, therefore constructs a `PrimitiveRendererService` with a static test-double `fillMesh` (hand-made F01/F02 meshes, no WASM). It is a test fixture, not a host. No host page (`index.html`/`main.ts`, the P1 and P3 pages) gets a port, and no page gets a real port, so V3-A18 ("no host injects a port") stays true until V4. Both V3-A18 unit tests exempt exactly these two fixture files and assert that they import no `geometry-wasm`.
- **Formatting.** `docs/validation.md` failed Prettier on `main` (misaligned table rows); formatting it with the row change realigns the table without changing its text.

Open risks:

- **Open P1 fixture-load defect.** One headed run failed `P1 visual samples1 dpr1.5` in Chrome (`window.__vectorStudioP1` undefined); it did not reproduce in 140 repeats across this branch and main and is unexplained. Its diagnostics follow-up is the P1 light-tier item named above.
- **CPU cost.** BigInt predicates, ear clipping (O02's re-tracing) and exact list distances run synchronously inside `prepare`. The independent reviewer timed `buildPathFringe` on convex n-gons at f = 0: n = 64, 25 ms; 128, 47 ms; 256, 141 ms; 512, 584 ms. That is roughly n² growth, so one large path can stall a frame for its first build and for each new fringe bucket. They are untested on large kernel meshes. B0's E3 and E4 measure them; no performance claim is made. **V4 must not give a host a real port until B0's E3 result exists or a work cap for the builder is decided.**
- **No certificate.** Exactness holds on the preimage only. f32 offsets, lanes and shader-side feature mapping can invert thin triangles or shift features (risks in the V3 contract, section m). The GPU partition (at most one covered sample per variant) remains O02's G3 assumption, which V3-A14 observes only away from edges.
- **Smoke coverage.** V3-A14 uses axis-aligned F01/F02 meshes from a static double. Curved kernel meshes, pinch vertices on the GPU and the section k comparison come with V4.
- **Placement exception.** The TypeScript builder in `renderer-core` is a time-bounded D8-interim exception. It must be removed or moved when R2/K1 decides production placement.
- **Mesh arena above device limits** still fails the whole packet (V3b risk, unchanged). The V3b risk "no committed GPU compile of the mesh shader" is closed by the V3-A14 spec.

### B0 reference run

Run `20261012T144359Z-65a7b05f` on the reference machine (DESKTOP-DKVUSAV), clean main `34ae06d`, `pnpm benchmark:p3-b0 --profile reference --environment-json <observations>`. The user chose the development PC over a cloud machine, because the frozen contract and the prototype plan's constraint 2 fix it as the reference. Background load comes from the operator's readiness statement in chat and a Primary process listing 21 s before the start, with no separate CPU sampling, per the user's standing instruction. An earlier attempt the same day was stopped by the user and left no record.

Result: [record](../benchmarks/results/2026-10-12_p3_p3-b0-feasibility-v1_native_desktop-dkvusav_20261012T144359Z-65a7b05f.md) with its raw `.json`; `validateRecord` accepts it. All eight validity checks pass. **Verdict INFEASIBLE, provisional at k = 2 until B0-W**, for simple, disjoint, snapped contours at zoom 1 only (no zoom range, generic coordinates or crossings, which B0 does not measure): at k = 2 the initial build estimate is about 3,920 s against 1,000 ms and the p95 edit proxy about 4.5 s against 4 ms; mesh memory, 15.41 MiB, is within 64 MiB. Fitted slopes of time against leaves are 1.84-1.95 (P2 1.84-1.86, P4 about 1.91, P8 1.91-1.95; the binding estimate is P8). The topology certificate takes 91-94% of the time at the largest cells. H1 is Supported for P2, P4 and P8, with an estimated exact share of about 0.87.

Independent evidence review (`reviewer`): round 1 NOT ACCEPTED (the contract's verdict-scope statement was missing, and the plan quoted only the P2 slope), round 2 ACCEPTED; the record JSON is unchanged.

Under the contract's decision rule, the verdict went to the user as an architecture decision before B1. B0 chose no remedy.

**User decision, 2026-10-13, in chat.** The user chose the recommended option, a kernel performance improvement contract:

- Requirements, the 0.25 px precision target, the B0 budgets (B0-Q1: 1,000 ms initial build, 4 ms edit proxy, 64 MiB) and the architecture stay unchanged.
- A new full-tier contract targets the measured bottleneck with (1) adaptive predicates, floating-point filters with an exact fallback only when needed, and (2) a sweep-based approach replacing the all-pairs topology certification.
- The same B0 corpus is then remeasured to update the verdict.

The user was told that the needed improvement, about three orders of magnitude, may exceed what this alone delivers. The work unit is [B0R](p3-b0r-kernel-performance-contract.md). Its section 8 reruns B0 v1 unchanged; the B0 contract and this record are not edited.

**User decision, 2026-10-13, in chat (B0R-Q2, answered (a)).** After being told that a zero-cost topology stage still leaves the tessellation stage 6-20 times over the per-path allowance (about 126 times at L* by extrapolation), the user chose the recommended option "include tessellation work". B0R's scope expands to the rounded tessellation: event sorting, exact column and section computation, `embed_scalar` and the other measured tessellation costs. Requirements, the 0.25 px target, the B0 budgets and the architecture stay unchanged, and outcomes stay bit-identical (meshes, codes, diagnostics, stats). FEASIBLE remains uncertain. B0R-Q1 (low-limb skipping) is the only open user question.

**User decisions, 2026-10-13, in chat (B0R-Q3 (a) and B0R-Q1).** B0R-Q3 (a): B0R also restructures the tessellation loops (event sorting, `collect_events`, the column-by-edge scans, `lookup_section_node` and other measured loops), keeping outcomes bit-identical, `work_units` included, by logical charge-counter emulation; scratch content after a failure stays unobservable, as the P3.2e contract allows. B0R-Q1: include low-limb skipping in `fill_exact` (unit U1b). No user question remains open.

The B0R contract is FROZEN on 2026-10-13 after independent review round 3 returned READY; that review also covered implementability. Next: B0R unit U0, the identity tool.

### B0R U0 implementation

Unit U0 of the [B0R contract](p3-b0r-kernel-performance-contract.md#10-implementation-units): the identity tool for O4, O5 and O7, with no non-test kernel change. Acceptance: section 9 row U0 plus A9 and A10. Functional evidence only; no performance claim.

Landed:

- `tooling/compare-p3-fill-identity.mjs`, run by `pnpm test:p3-fill-identity`. It checks O5, builds the merge base from `git archive` with the pinned toolchain and applies the bootstrap overlay. It then runs both native dumps and the WASM layer, compares each WASM cascade digest with the native one, and runs the O7 allocation check, the coverage floors and a tamper self-check. It refuses to run when either corpus SHA-256 differs from its pinned value (`B0_CORPUS_SHA256`, `RANDOM_CORPUS_SHA256`). It writes a run directory under `artifacts/p3-b0r-identity/` (git-ignored). `--compare-only <run-dir> [--tamper <case>]` compares a finished run again, optionally with one tampered branch digest.
- `tests/geometry/p3-b0r/corpus.ts` generates the randomized corpus `p3-b0r-random/v1`: six families of 2,000 paths in a frame like B0's, with a per-path fill rule and tolerance exponent. Every path is within the source caps.
- `packages/geometry-wasm/kernel/src/p3_b0r_identity.rs` is the `cfg(test)` harness, declared in `lib.rs`. Its ignored release-profile test `dump_native_digests` writes one SHA-256 digest per case. It also has two ordinary tests: SHA-256 known answers and the fill-v0 input layout.
- `tests/unit/p3-b0r-identity.test.ts` (11 tests) covers the generator (counts, caps, determinism, pinned SHA-256, xorshift equality with B0's), the inline-module extraction, the digest comparison and tamper detection, the coverage classification, the WASM selection, the WASM-vs-native comparison and the input packing.

Local evidence, 2026-10-13, Windows 11, 16 logical cores, pinned Rust 1.94.1, Node 24.15.0, working tree on branch `claude/p3-b0r-u0-fill-identity-tool` over merge base `b52b683`:

- `pnpm test:p3-fill-identity`: **PASS**, run `20261013T014407Z-b9659cab`, 17 min 29 s wall time. This is the rerun after the independent review's changes; the first run, `20261013T010835Z-7bdd85a5` (17 min 19 s, 2,430 WASM cases), also passed.
  - Overlay: the merge base has no harness, so the tool copied it and inserted the declaration (`harnessCopied` and `declarationInserted` true).
  - Corpus SHA-256: B0 `206cf6e9…9796`, equal to the frozen value of section 8; `p3-b0r-random/v1` `a1902d0f9a0dadf50abe930791e84d3b8a3fcf0bcf6bb37423d400690673ca9d`, equal to the pinned value.
  - Native layer: 66,351 cases on each side, all digests equal. That is 6,350 B0 cases (1,270 paths × five entries: the four `CubicFillWorkspace` entries and the `FillEngine` cascade), 60,000 randomized cases (12,000 paths × five) and one workspace-size case. Every entry call allocated nothing (O7), on both sides.
  - WASM layer: 3,969 cases, all digests equal between the two WASMs. Every case also equals the native cascade digest of the same path.
    - Selection: 430 B0 decision-cell paths and 3,539 randomized paths. The randomized paths are the literal first 2,000 (F1) plus a stratified superset: F2 200, F3 200, F4 248 (all its crossing paths), F5 691 (all 356 non-default-exponent and 335 scaled paths) and F6 200.
    - Path statuses: 1,891 OK, 1,324 unsupported geometry, 601 work limit, 153 numeric range.
    - 248 cases have crossing columns.
    - Tolerance exponents: -3 for 3,183 paths, and -38 to -34 and 32 to 36 for the rest.
  - Durations: release test-harness build of the merge base 44.8 s (cold); the branch builds were warm (0.1 s; 44.3 s cold in the first run); release WASM builds 5.0 s and 0.1 s; native dumps 105.1 s and 106.0 s on 16 threads; WASM layer 785.4 s (single-threaded Node, both WASMs).
  - Coverage floors, counted over the 12,000 randomized paths: 5,135 `ok` (floor 1,000), 3,376 `Topology(KnotMismatch)` (100), 2,426 `Topology(Unresolved)` (100), 1,665 cap failures (100) and 248 `ok` with crossing columns (100). No generator parameter change is needed.
  - Release WASM SHA-256 is the same for base and branch: `2075c3390ebe5dd91e5660e79661694d7669a9913494e0e76a1b57851d0b27e2`.
  - O5: the only modified kernel source is `lib.rs`, whose inline `#[cfg(test)] mod allocation_test_support` is byte-identical to the merge base. No existing test file changed.
- Tamper detection:
  - The tool's built-in self-check altered one native digest (`rnd/F1-generic-rings/0000/attempt`) and one WASM digest (`wasm/b0/P2/s=3/0000`). Each was reported as exactly one mismatch naming that case.
  - Command line, first run: `--compare-only <run> --tamper b0/P4/s=16/0042/fill_v0_cascade` reported `native: MISMATCH (1 differing)` naming that case and exited 1. The same held for `wasm/rnd/F1-generic-rings/1999`.
  - Command line, rerun: `--tamper wasm/rnd/F4-star-wave/0035` was reported both as a WASM mismatch and as a WASM-vs-native mismatch, and the command exited 1. Without `--tamper`, the command exits 0.
- `pnpm check`: PASS (65 unit files, 728 tests, including the 11 new ones; format, lint, typecheck and boundaries), rerun after the review changes.
- `pnpm build`: PASS.
- `pnpm test:geometry`: PASS, 7 min 7 s. Kernel fmt and clippy are clean. Native `cargo test`: 229 passed, 19 ignored (the new ignored dump included). Geometry vitest: 43 files passed and 4 skipped; 733 tests passed and 6 skipped. The independent-build WASM SHA-256 is `2075c339…27e2`, unchanged from main.
- A10 `p3_b0_diag` clippy (`RUSTFLAGS="--cfg p3_b0_diag"`, `CARGO_TARGET_DIR=.tools/geometry-build-p3-b0-diag`, `--all-targets -D warnings`): PASS.
- A9: `git diff --exit-code main -- packages/geometry-wasm/kernel/Cargo.toml packages/geometry-wasm/kernel/Cargo.lock pnpm-lock.yaml packages/contracts` exits 0. The root `package.json` adds only the `test:p3-fill-identity` script. No cap, limit or `fill_v0_*` export changed.

Interpretations recorded for review:

- **Digest content.** Each attempt digest covers the result with its exact variant, `diagnostics()`, `topology_stats()`, `rounded_stats()` (also on failure), `allocated_bytes()` and, when published, every `output()` field, including the rounded mesh with its sections, nodes, cells, boundaries, spans and contributors. They are hashed in `Debug` form, which renders f64 values bit-exactly except NaN payloads. Mesh vertex bits are also hashed raw. The topology workspaces' internal publications (points, contours, orientations, winding, crossings) are covered here only through their effect on the composed output and `topology_stats()`. Their direct differential is O3(b), which U2 adds with the reference loops.
- **No budget-failure case.** No B0 or randomized case returns `Rounded(WorkLimit)`, so O4 compares no `WorkLimit` point of the tessellation budget. For U4-U7, identity of the budget-failure point rests on O11's budget sweeps and O10's reference loops. The randomized cap failures are `CommandLimit`, `OwnerLimit`, `Rounded(NodeLimit)`, `Rounded(EventLimit)`, `Topology(WorkLimit)` and flat status 5.
- **Case independence.** One workspace serves a B0 cell or a 50-path randomized chunk, in a fixed order. Stale state that a failure leaves, such as `rounded_stats()` after a topology failure, is therefore compared as well, and the comparison is still deterministic.
- **Floors.** A path counts toward a floor when any of its five cases shows the outcome. Cap failures are every `*Limit` code, flat status 5 and fill-v0 `WORK_LIMIT`. A path has crossing columns when an `ok` case has more raw events than twice its edges.
- **WASM selection.** The contract's "first 2,000 randomized paths" is kept literally, in corpus order, so it is family F1. At the review's request a stratified superset adds the other families. Each of F2-F6 gets every path whose native `ok` case has crossings, every path with a non-default tolerance exponent, every path with a coordinate magnitude outside [2^-20, 2^30], and then every tenth index until the family has at least 200 paths. The B0 decision cells include all 100 paths of the linearity cell. The WASM digest uses the native cascade digest's text, so each WASM case is also compared with the native `fill_v0_cascade` case of the same path.
- **Corpus frame and seed.** The randomized frame adds a fill-rule byte and an `i32` tolerance exponent per path. Each family draws from its own xorshift32 stream, whose seed is the next draw of a master stream seeded with 0x42305231.
- **O5 extraction.** An inline test module runs from its `#[cfg(test)]` line to the first later `}` line at the `mod` line's indentation, which rustfmt guarantees.
- **Run time.** The merge base is `b52b683` itself, so the native times are today's kernel. Later units' merge bases keep that slow side.

### B0R U1 implementation

Unit U1 of the [B0R contract](p3-b0r-kernel-performance-contract.md#10-implementation-units): the shared filter module (R1-R3, sections 3.3 and 3.4) and the topology filters F0.1 and F2.1-F2.4. Acceptance: A1, A3-A10 and A8 for defects (1) and (7). A2 and A13 belong to U2 and U4-U7. Functional evidence only; no performance claim.

Landed:

- `packages/geometry-wasm/kernel/src/fill_filter.rs`, private and std-only:
  - `Interval` arithmetic with R1 outward widening on every operation; a non-finite endpoint makes the result undecidable;
  - `enclose` (section 3.3), with `debug_assert!` and a `None` return on a trimmed-invariant violation;
  - `enclose_ratio` (section 3.4), with no caller until U4;
  - `compare_enclosures`;
  - `cfg(test)` thread-local decided/fallback counters per filter and the O8 fault switches.
- `simple_cubic_topology.rs`:
  - `orient` runs F0.1 (two equal `ExactPoint`s give `Equal`), then F2.1, then the unchanged exact routine, now named `orient_exact`.
  - `cross_sign` (F2.1 and F2.4) replaces the cross-sign test in `transverse_orientation`.
  - `projected_monotone` and `rounded_projected_monotone` run F2.2 on every dot sign, including the three-term `total`.
  - `compare_coordinate` runs F2.3; `compare_points` and `between_closed` reach it through that function. The exact routine is now named `compare_coordinate_exact`.
  - The width-bound derivation and the scratch envelope are code comments. The unfiltered composites stay as `cfg(test)` reference copies, next to the `cfg(test)` test access `b0r_test_*`.
  - `dot`, `cross_vectors`, `cross_points` and the inline test module are unchanged.
- New test files `fill_filter_tests.rs` (10 tests, 1 ignored) and `simple_cubic_topology_filter_tests.rs` (10 tests, 1 ignored):
  - O1: smoke and full-size differentials;
  - O2: named fixtures that assert, through the counters, whether the fallback ran, plus decided controls;
  - O8: the seeded defects.
- `tooling/compare-p3-fill-identity.mjs` gains step 5. It runs every ignored test named `b0r_oracle_full` in the release profile on the branch tree and saves the output as `oracles-branch.txt` in the run directory. It fails the run on a nonzero exit, a missing cargo summary line, any failed test, or an expected oracle (a declared list of test names, which each unit extends) that did not run. Section 7 requires `pnpm test:p3-fill-identity` to run the full O1; U0's tool did not yet do so.
- Dated pointer lines under the status lines of [P3.2g](p3-native-cubic-topology-contract.md), [P3.2n](p3-native-rounded-topology-contract.md) and [P3.2r](p3-transverse-crossing-contract.md), for the section 6.2 clauses that U1's filters touch. The sweep rows of section 6.2 belong to U2.

Local evidence, 2026-10-13, Windows 11, 16 logical cores, pinned Rust 1.94.1, Node 24.15.0, uncommitted working tree on branch `claude/p3-b0r-u1-topology-filters` over the U0 commit `ecacdbb`. Its tree is identical to `f07854c`, the squash merge of U0 into `main` and this PR's base. The identity tool compared against `b52b683`, the merge base of that pre-merge branch; `f07854c` differs from `b52b683` only by U0's test tooling, harness and corpus, so the kernel compared is the same:

- `pnpm test:p3-fill-identity`: **PASS**, run `20261013T024933Z-9b8bb624`, 13 min 39 s wall time. The first run, `20261013T022436Z-bc74c18e`, also passed; it predates a fix to the regular expression that copies the oracle pass count into `summary.json`, which did not affect pass or fail.
  - Native: 66,351 cases on each side (6,350 B0, 60,000 randomized, 1 workspace size), all digests equal.
  - WASM: 3,969 cases, all equal between the two WASMs and equal to the native cascade digests.
  - Allocations: every entry call allocated nothing (O7), on both sides.
  - Corpora: SHA-256 B0 `206cf6e9…9796` and `p3-b0r-random/v1` `a1902d0f…ca9d`, both equal to the pinned values. Coverage floors are met with the same counts as U0's (5,135 `ok`, 3,376 `KnotMismatch`, 2,426 `Unresolved`, 1,665 cap failures, 248 `ok` with crossings). Both tamper self-checks were detected.
  - O5: the modified kernel sources are `lib.rs` and `simple_cubic_topology.rs`; their inline test modules are byte-identical to the merge base, and no existing test file changed.
  - Release WASM SHA-256: base `2075c339…27e2`, branch `c9c80356…dc9d`. The change is expected (section 2, operation identity); `fill_v0_revision()` stays 1.
  - Durations: release test build of the merge base 45.3 s (cold); the branch builds were warm (0.1 s; 49.1 s cold in the first run); release WASM builds 5.2 s and 0.1 s; native dumps 105.8 s (base) and 34.9 s (branch) on 16 threads; release oracles 106.3 s (2 passed); WASM layer 518.8 s.
- Full-size O1 (release profile, inside the run above): zero disagreements and zero containment violations. Each corpus is split into 16 fixed seeded shards, one thread each, so the tuples and counts do not depend on the machine's core count; the evidence run had 16 cores, so its counts are those of the fixed sharding. The independent reviewer reran the release O1 on commit `7473926` with identical counts. After the review, a rerun with the fixed-shard change and the stricter oracle check gave identical counts again (2 passed, 104.9 s).
  - Topology: 10^7 random and 10^6 adversarial tuples for each of the 13 predicate variants, 88.5 s. The variants are `orient`, the cross sign, the dot sign, `projected_monotone`, `rounded_projected_monotone` (closure and not), `transverse_orientation` (four closure combinations), `compare_coordinate`, `compare_points` and `between_closed`.
  - Filter module, 17.6 s:
    - interval add, sub, mul and div on point intervals, checked exactly: 44,000,000 cases, 2,656,957 undecidable (non-finite);
    - section 3.3 containment: 11,000,000 cases;
    - section 3.4 column and section ratios: 11,000,000 each, enclosure containment checked and every decided comparison equal to `compare_ratios`. About 48% are decided; equal ratios in another representation and N + 1 neighbours are undecided by design.
- Decided fractions of filter calls (random / adversarial):

  | Predicate                                                         |                Random |           Adversarial |
  | ----------------------------------------------------------------- | --------------------: | --------------------: |
  | `orient` (F0.1 and F2.1)                                          |                 0.959 |                 0.292 |
  | cross sign (F2.1, F2.4)                                           |                 0.827 |                 0.016 |
  | dot sign (F2.2)                                                   |                 0.989 |                 0.184 |
  | `projected_monotone` (F2.2)                                       |                 0.991 |                 0.616 |
  | `rounded_projected_monotone`, not closure / closure               |         0.992 / 0.990 |         0.456 / 0.362 |
  | `transverse_orientation`, four closure combinations               |          0.992-0.9996 |           0.439-0.833 |
  | `compare_coordinate` / `compare_points` / `between_closed` (F2.3) | 0.741 / 0.787 / 0.987 | 0.225 / 0.150 / 0.635 |

  The random cross-sign corpus pairs a vector with itself in one case in six, and the random coordinate corpora share an x coordinate in one case in four, so their exact zeros fall back by construction.

- O8, in `pnpm test:geometry`:
  - (1) R1 widening removed from the interval operations: detected by `fill_filter_tests::b0r_o8_r1_widening_removed_is_detected` (O1 primitive containment).
  - (1), enclosure part, the two-ulp widening of 3.3 step 4 removed: detected by `b0r_o8_enclosure_widening_removed_is_detected` (O1 containment).
  - (7) fixed numerator unit: detected by `b0r_o8_ratio_fixed_numerator_unit_is_detected` (O1 ratio differential).
  - Defects (2)-(6) and (8)-(14) belong to U2-U7.
- `pnpm test:geometry`: PASS, 6 min 58 s. Kernel fmt and clippy are clean. Native `cargo test`: 249 passed (229 before, 20 new), 21 ignored (2 new). Geometry vitest: 733 passed, 6 skipped. The independent-build WASM SHA-256 is `c9c80356…dc9d`, equal to the first build.
- `pnpm test:p2-identity`: PASS, 10,048 batches with identical P2 output bytes (SHA-256 `876f4a49…0e046f`).
- `pnpm check`: PASS (65 unit files, 728 tests). `pnpm build`: PASS.
- A10 `p3_b0_diag` clippy (`RUSTFLAGS="--cfg p3_b0_diag"`, `CARGO_TARGET_DIR=.tools/geometry-build-p3-b0-diag`, `--all-targets -D warnings`): PASS.
- A9: relative to `main`, only U0's `test:p3-fill-identity` script differs in `package.json`. U1 changes no `Cargo.toml`, `Cargo.lock`, `pnpm-lock.yaml` or `packages/contracts` file, no cap, limit or `fill_v0_*` export. The crate stays std-only with no `unsafe`.

Interpretations recorded for review:

- **F2.4 and F2.2 inputs.** `transverse_generators`, the chord of `projected_monotone` and the `direction` of `rounded_projected_monotone` are exact values that the unchanged code already builds. The filters enclose those values directly (section 3.3) instead of re-forming them as interval differences. Step differences such as `points[i + 1] − points[i]` are interval differences of the point enclosures. Either form is sound by R1-R3.
- **Three-term total.** Its interval is the sum of the three projection intervals, as section 3.7 states. An undecided total recomputes the exact sum as today.
- **Unfiltered sites.** The signed-area sums in `derive_output` (`cross_points` accumulated into an `ExactProduct`) are not sign tests of one product, have no F2 row, and stay exact.
- **Width bounds.** The committed derivation gives the F2.1 second-order term as 2^11 u²M², not section 3.7's 2^9 u²M², because it also counts the R1 widening of the differences. Section 3.7 states first-order sizes; the bounds affect only how often a filter decides, never soundness.
- **Trimmed-invariant fixture.** `enclose` `debug_assert!`s the invariant as section 3.3 requires, so the O2 fixture expects a panic in debug builds and `None` in release. `top_limbs`, which returns the `None`, is also checked directly.
- **Counters and faults.** These are `cfg(test)` thread-locals, as section 7 requires. In other builds `record` is an empty inline function and the fault check is a constant `false`.

An informal local timing of whole attempts, not committed, suggested the topology stage is faster; it is not a benchmark, and only U8's committed remeasure carries performance evidence.

### B0R U1b implementation

Unit U1b of the [B0R contract](p3-b0r-kernel-performance-contract.md#10-implementation-units): low-limb skipping in `fill_exact` (section 5.5, user decision B0R-Q1). Acceptance: A1 (as the section 5.5 differential), A3-A7, A9 and A10. The contract lists no O8 defect for U1b; A2 and A13 belong to U2 and U4-U7. Functional evidence only; no performance claim.

Landed:

- `packages/geometry-wasm/kernel/src/fill_exact.rs`:
  - `multiply` starts both loops at each operand's lowest nonzero limb, so every product word lands at its summed offset as before, and trims from `left.used + right.used` (capped at the output width) instead of from the full width. Every partial sum is below the final product, so no word at or above that bound is ever nonzero and the trimmed result is the same.
  - `add_magnitudes` copies, unchanged, the limbs of the operand whose lowest nonzero limb is lower, up to the other operand's lowest nonzero limb, and starts the carry loop there.
  - `subtract_magnitudes` copies the minuend's limbs below the subtrahend's lowest nonzero limb and starts the borrow loop there. That range is the low limbs zero in both operands, plus the minuend limbs above a still-zero subtrahend (the copy case of section 5.5). It never skips a nonzero subtrahend limb.
  - `compare_magnitude`, the capacity and borrow assertions, `used`, trimming, every width, the five `p3_b0_diag` hooks and the inline test module are unchanged. The two magnitude routines become `pub(crate)` so the new test file can call them directly.
- New test file `fill_exact_tests.rs` (5 tests, 1 ignored), with `cfg(test)` reference copies of the pre-U1b `multiply`, `add_magnitudes`, `subtract_magnitudes`, `Signed::add` and `compare_ratios` from `main` `2d4d245`. Every comparison is of the whole `Signed` value: sign, `used` and all limbs of the fixed array.
  - Smoke and full-size differentials over every kernel width (add and subtract at 33, 34, 66, 68, 99, 132, 165 and 231 limbs; every `multiply` instantiation; both `compare_ratios` instantiations), on random and adversarial patterns: sparse limbs, zero low prefixes shared or disjoint, borrows from a single top limb through runs of zero limbs, carries across the skipped boundary, equal and one-limb-perturbed magnitudes, and maximum widths.
  - An exhaustive test over every 4-limb value with limbs in {0, 1, 2^63, 2^64 − 1}, both signs, against every other.
  - Named boundary fixtures and a check that the capacity assertions fire for the same inputs with the same messages.
  - A self-check that the differential detects the forbidden skip, a subtraction that also skips subtrahend limbs below the minuend's lowest nonzero limb.
- `tooling/compare-p3-fill-identity.mjs`: `EXPECTED_ORACLES` gains `fill_exact_tests::b0r_oracle_full_u1b_fill_exact`.
- Dated pointer lines under the status lines of [P3.2c](p3-fill-event-order-contract.md) (the `:30` and `:32` clauses) and reference pointers in [P3.2r](p3-transverse-crossing-contract.md) and [P3.2g](p3-native-cubic-topology-contract.md), as section 6.2 requires.

Local evidence, 2026-10-13, Windows 11, 16 logical cores, pinned Rust 1.94.1, Node 24.15.0, branch `claude/p3-b0r-u1b-limb-skipping` at commit `b3d47c4` plus the uncommitted documentation, against the merge base `2d4d245`:

- `pnpm test:p3-fill-identity`: **PASS**, run `20261013T035052Z-53234806`, 7 min 7 s wall time.
  - Native: 66,351 cases on each side (6,350 B0, 60,000 randomized, 1 workspace size), all digests equal.
  - WASM: 3,969 cases, all equal between the two WASMs and equal to the native cascade digests.
  - Allocations: zero allocating cases (O7).
  - Corpora: SHA-256 B0 `206cf6e9…9796` and `p3-b0r-random/v1` `a1902d0f…ca9d`, both equal to the pinned values. Coverage floors are met with the same counts as U0's and U1's. Both tamper self-checks were detected.
  - O5: the modified kernel sources are `fill_exact.rs` and `lib.rs`; their inline test modules are byte-identical to the merge base, and the only test-file change is the added `fill_exact_tests.rs`.
  - Release WASM SHA-256: base `c9c80356…dc9d`, branch `4e5e22cf…60a8`. The change is expected (section 2, operation identity); `fill_v0_revision()` stays 1.
  - Durations: release test builds 49.6 s (base) and 54.0 s (branch); release WASM builds 6.1 s and 0.1 s (warm); native dumps 36.1 s (base) and 24.6 s (branch) on 16 threads; release oracles 94.0 s (3 passed); WASM layer 159.5 s.
- Full-size U1b differential (release profile, inside the run above), 16 fixed seeded shards, 14.1 s, zero disagreements. Counts are cases and, in parentheses, cases in which at least one operand has a zero low limb:
  - add and subtract (`Signed::add` both ways, plus both magnitude routines directly): 10,000,000 random (8,685,292) and 1,000,000 adversarial (854,955);
  - `multiply`: 10,000,000 random (8,561,189) and 1,000,000 adversarial (990,115);
  - `compare_ratios`: 9,728,553 random (8,516,207) and 994,500 adversarial (988,783); tuples with a zero weight are discarded before counting.
  - The U1 full O1 oracles in the same run gave the same counts as in the U1 entry.
- Self-check of the differential: four hand-made mutations of the new `fill_exact.rs` were each detected by the smoke tests and then reverted (subtraction also skipping below the minuend's lowest nonzero limb; `multiply` trimming one limb short; `add_magnitudes` copying the wrong operand; `multiply` skipping the lowest nonzero column).
- `p3_b0_diag` counts unchanged: the `run_diagnostic` bench (warmup 0, timed 1, one replay loop) on the committed B0 corpus `20261012T144359Z-65a7b05f/corpus.bin`, with `--cfg p3_b0_diag`, on this branch and on a `git archive` of `2d4d245`. All 26 primary cells have identical per-routine, per-instantiation top-level call counts (390 entries), and the admission observations are identical.
- `pnpm test:geometry`: PASS, 6 min 56 s. Kernel fmt and clippy are clean. Native `cargo test`: 254 passed (249 before, 5 new), 22 ignored (1 new). Geometry vitest: 733 passed, 6 skipped. The independent-build WASM SHA-256 is `4e5e22cf…60a8`, equal to the identity tool's branch build.
- `pnpm test:p2-identity`: PASS, 10,048 batches with identical P2 output bytes (SHA-256 `876f4a49…0e046f`).
- `pnpm check`: PASS (65 unit files, 728 tests). `pnpm build`: PASS.
- A10 `p3_b0_diag` clippy (`RUSTFLAGS="--cfg p3_b0_diag"`, `CARGO_TARGET_DIR=.tools/geometry-build-p3-b0-diag`, `--all-targets -D warnings`): PASS.
- A9: U1b changes no `Cargo.toml`, `Cargo.lock`, `package.json`, `pnpm-lock.yaml` or `packages/contracts` file, no cap, limit or `fill_v0_*` export. The crate stays std-only with no `unsafe`.
- A8: the contract lists no seeded defect for U1b.

Interpretations recorded for review:

- **Trim bound.** Section 5.5 says "placement with trim to canonical form". `multiply` trims from `left.used + right.used` rather than from the output width; the comment beside it gives the reason, and the differential compares every limb of the result.
- **Subtraction start.** The borrow loop starts at the subtrahend's lowest nonzero limb in every case. Below it, the copied minuend limbs are the both-zero limbs and, when the minuend's lowest nonzero limb is lower, the subtrahend-zero copy case. This is the whole skip section 5.5 allows.
- **Zero operands.** `add_magnitudes` and `subtract_magnitudes` are reached only through `Signed::add`, which returns early on a zero operand. For a zero operand the lowest nonzero limb is taken as 0, so the loops then run in full as before; the direct-call tests cover it.
- **Diagnostic counts.** The hooks sit where they were, and `subtract_magnitudes`'s `debug_assert!` still calls `compare_magnitude` only in debug builds, as before.

### B0R U2 implementation

Unit U2 of the [B0R contract](p3-b0r-kernel-performance-contract.md#10-implementation-units): sweep-based pair candidates and the Lemma B logical pair counter in the three topology pair loops (section 4), with the `cfg(test)` reference loops. Acceptance: A1-A10, with A2 (O3) as U2's own criterion and A8 for defects (3)-(6). A13 belongs to U4-U7. Functional evidence only; no performance claim.

Landed:

- `packages/geometry-wasm/kernel/src/simple_cubic_topology.rs`:
  - `SimpleCubicTopologyWorkspace::validate_pairs`, `RoundedKnotCubicTopologyWorkspace::validate_pairs` and `TransverseArrangementWorkspace::validate_pairs_with_kinds` now run `sweep_pairs`. Each pair body moved unchanged into a `check_pair` method; the transverse body's `continue` is its early `Ok(())`.
  - Section 4.2: `leaf_box` spans the section 3.3 enclosures (`fill_filter::enclose`, through U1's `enclose_coordinate`) of the leaf's four controls or six rounded points. A leaf with an unavailable enclosure goes into a `wild` mask, and every pair with it is a candidate. Forced pairs F are marked from the contour ranges: consecutive `contour_leaf` values and the pair (0, count − 1).
  - Section 4.3: `PairCandidates` insertion-sorts the boxed leaves by `x_lo` into a `[u8; 64]`, scans forward while `x_lo_b <= x_hi_a`, and marks pairs whose closed y ranges also overlap in a `[u64; 64]` bitset, row i holding bit j for j > i. Scratch is 2 KiB of boxes, the 512-byte bitset and the 64-byte order, all on the stack.
  - Section 4.4: `pairs()` reads the bitset rows in index order with `trailing_zeros`, which is lexicographic (i, j) order. `enter_pair` computes rank(i, j) = i(2n − i − 1)/2 + (j − i − 1); at rank ≥ `max_pairs` it sets `pairs = max_pairs` and returns `WorkLimit`, otherwise it sets `pairs = rank + 1` before the body runs. `finish_pairs` returns `WorkLimit` with `pairs = max_pairs` when T = n(n − 1)/2 exceeds `max_pairs`, and otherwise sets `pairs = T`. The derivation is a code comment.
  - `cfg(test)` only: the pre-U2 loops as `reference_pairs`, with verbatim body copies (`reference_pair_body`), the budget as their only parameter and a touched-pair bitset for O3(c); a thread-local pair-loop mode (sweep, reference or shadow); the shadow comparison; the O8 fault switch `SweepFault`; and test access functions. In other builds `sweep_fault` is a constant `false`.
  - No workspace field, retained buffer, cap, limit or export changes, and nothing is allocated.
- `p3_b0r_identity.rs`: `Chunk`, `read_b0`, `read_random`, `read_file` and `run_chunk` become `pub(crate)`, so the O3(b) corpus oracle can drive the O4 inputs. Behaviour is unchanged. The identity tool copies the file into the merge-base tree as its bootstrap overlay.
- New test file `simple_cubic_topology_sweep_tests.rs` (11 tests, 3 ignored), declared in `lib.rs`:
  - O3(a), Lemma A on random hull pairs: shifted copies of restricted leaves separated by zero, tiny, small or negative gaps; four- and six-point leaves; pairs touching exactly at x = 0 or y = 0; collinear and coincident controls; subnormal and extreme coordinates.
  - The section 4.2-4.4 definitions, checked directly. The candidate pairs, in processing order, are compared with a brute-force C on synthetic boxes with frequent touching endpoints and unboxed leaves. The Lemma B counter is compared with the pre-U2 counter for random candidate sets, failing pairs and budgets.
  - O3(b) and O3(c) on whole workspaces. Seeded scenes come in separated, nested, overlapping, touching-at-origin, sliver, subnormal-scale, random-magnitude and star families, with perturbed actual ends and marked LINE adapters. Each runs the five certify calls with the reference loops, with the sweep and in shadow mode, at the default or a small random `max_pairs`. Result, `stats()`, output, crossings and partners must be equal, and no call may allocate.
  - Shadow mode runs both loops from the same state for the real budget and for the budgets 0, 1, q − 1, q, q + 1, T/2, T − 1, T and one pseudo-random value, with q the reference's final counter. It compares the result and the full loop state (counter, partners, crossing array and length). It also checks that every pair whose reference body returned an error or appended a crossing is in C.
  - The full-size O3(b) corpus oracle runs shadow mode over every O4 input: both corpora through the four `CubicFillWorkspace` entries and the V2 cascade, by the identity harness's `run_chunk`.
  - O8 tests for defects (3)-(6).
- `tooling/compare-p3-fill-identity.mjs`: `EXPECTED_ORACLES` gains the three U2 oracles, and the release oracle run receives the two corpus paths (`P3_B0R_B0_CORPUS`, `P3_B0R_RANDOM_CORPUS`).
- Dated pointer lines under the status lines of [P3.2g](p3-native-cubic-topology-contract.md), [P3.2n](p3-native-rounded-topology-contract.md), [P3.2s](p3-native-transverse-arrangement-contract.md) and [P3.2x](p3-native-triangle-free-arrangement-contract.md), for the section 6.2 sweep rows. P3.2r has no sweep row; its filter pointer came with U1.

Local evidence, 2026-10-13, Windows 11, AMD Ryzen 7 3700X, 16 logical cores, pinned Rust 1.94.1, Node 24.15.0, uncommitted working tree on branch `claude/p3-b0r-u2-sweep-candidates` over `main` `2d46fe1`:

- `pnpm test:p3-fill-identity`: **PASS**, run `20261013T071252Z-8408865d`, 19 min 35 s wall time.
  - Native: 66,351 cases on each side (6,350 B0, 60,000 randomized, 1 workspace size), all digests equal.
  - WASM: 3,969 cases, all equal between the two WASMs and equal to the native cascade digests.
  - Allocations: zero allocating cases (O7).
  - Corpora: SHA-256 B0 `206cf6e9…9796` and `p3-b0r-random/v1` `a1902d0f…ca9d`, both equal to the pinned values. Coverage floors are met with the same counts as U0's (5,135 `ok`, 3,376 `KnotMismatch`, 2,426 `Unresolved`, 1,665 cap failures, 248 `ok` with crossings). Both tamper self-checks were detected.
  - O5: the modified kernel sources are `lib.rs`, `p3_b0r_identity.rs` and `simple_cubic_topology.rs`; their inline test modules are byte-identical to the merge base. No existing test file changed. The new test file was untracked at run time, so the tool's added-file listing is empty.
  - Overlay: the harness was copied into the merge-base tree, because its visibility changed.
  - Release WASM SHA-256: base `4e5e22cf…60a8`, branch `353e2cf7…29ba`. The change is expected (section 2, operation identity); `fill_v0_revision()` stays 1.
  - Durations: release test builds 57.7 s (base) and 58.9 s (branch); release WASM builds 6.5 s and 6.7 s; native dumps 25.1 s (base) and 7.6 s (branch) on 16 threads; release oracles 951.8 s (6 passed); WASM layer 58.2 s.
- Full-size O3, release profile, inside the run above:
  - O3(a), `b0r_oracle_full_o3a_lemma_a`: 2,000,000 hull pairs in 16 fixed seeded shards, 6.7 s. 1,547,605 have separated boxes, with zero violations. Of the rest, 326,609 overlap (12,474 of them with disjoint hulls) and 125,786 have no box; 199,865 are zero-touch pairs.
  - O3(b) on the O4 corpora, `b0r_oracle_full_o3b_corpus_shadow`: 306 chunks, 32,804 pair-loop calls and 278,915 compared reference/sweep runs (136,915 ending in `WorkLimit`, 83,140 in another error), with zero mismatches. O3(c): 20,638 touched pairs, zero outside C. The candidates were 916,194 of 13,119,906 logical pairs; no corpus call had an unboxed leaf. 122.8 s on 16 threads.
  - O3(b) on seeded scenes, `b0r_oracle_full_o3b_random_scenes`: 64,000 scenes and 320,000 certify calls in each mode, with zero mismatches and zero allocating calls. Outcomes: 59,614 `Ok`, 140,064 `Unresolved`, 75,605 `WorkLimit`, 44,717 `KnotMismatch`, 39,026 crossing records. Shadow: 260,420 calls and 2,360,998 compared runs (1,186,209 `WorkLimit`, 944,680 other errors), zero mismatches; 244,515 touched pairs, zero outside C; 30,353 calls with an unboxed leaf. 728.8 s on 16 threads.
  - The U1 and U1b full oracles in the same run gave the same counts as in their entries.
- O8, in `pnpm test:geometry`:
  - (3) strict box overlap: detected by `simple_cubic_topology_sweep_tests::b0r_o8_strict_box_overlap_is_detected`. O3(a) finds 500 Lemma A violations (the zero-touch pairs), the candidate-set check 1,843 mismatches, and the workspace differential 1 mismatch, 7 shadow mismatches and 1 touched pair outside C (O3(b), O3(c)).
  - (4) forced pairs not marked: detected by `b0r_o8_forced_pairs_not_marked_is_detected` with 1,931 candidate-set mismatches. On real leaves the defect is masked (see below), and the workspace differential sees no difference.
  - (5) sorted-by-x processing: detected by `b0r_o8_sorted_by_x_order_is_detected` with 1,885 candidate-order mismatches and 26 workspace and 183 shadow mismatches (O3(b)).
  - (6) Lemma B counter off by one: detected by `b0r_o8_counter_off_by_one_is_detected` with 1,222 Lemma B mismatches and 55 workspace and 412 shadow mismatches (O3(b)).
  - The U1 defects (1) and (7) are still detected by their U1 tests. Defects (2) and (8)-(14) belong to U3-U7.
- `pnpm test:geometry`: PASS, 7 min 51 s. Kernel fmt and clippy are clean. Native `cargo test`: 262 passed (254 before, 8 new), 25 ignored (22 before, 3 new). Geometry vitest: 733 passed, 6 skipped. The independent-build WASM SHA-256 is `353e2cf7…29ba`, equal to the identity tool's branch build.
- `pnpm test:p2-identity`: PASS, 10,048 batches with identical P2 output bytes (SHA-256 `876f4a49…0e046f`).
- `pnpm check`: PASS (format, lint, typecheck, 65 unit files with 728 tests, boundaries). `pnpm build`: PASS. `git diff --check`: clean.
- A10 `p3_b0_diag` clippy (`RUSTFLAGS="--cfg p3_b0_diag"`, `CARGO_TARGET_DIR=.tools/geometry-build-p3-b0-diag`, `--all-targets -D warnings`): PASS.
- A9: U2 changes no `Cargo.toml`, `Cargo.lock`, `package.json`, `pnpm-lock.yaml` or `packages/contracts` file, no cap, limit or `fill_v0_*` export. The crate stays std-only with no `unsafe`.

Interpretations recorded for review:

- **Body extraction.** Each pre-U2 loop body moved into a `check_pair` method with the same statements; only the transverse `continue` became `return Ok(())`. The reference loops keep a verbatim copy of each body, so they stay the pre-U2 code if `check_pair` ever changes.
- **Forced pairs.** F is taken from the contour ranges, where leaf `start + k` has `contour_leaf` k. It is a superset of the adjacency the bodies detect, as section 4.2 requires.
- **Counter start.** Lemma B assumes `pairs == 0` when the loop starts. Every caller resets it in `begin_attempt`, and the pre-U2 loop's `pairs == max_pairs` test relied on the same.
- **Defect (4).** Adjacent leaves share an exact point, whose enclosure lies in both boxes, so on real inputs F is contained in the box-overlap pairs and an unmarked F changes no output. Only the candidate-set check against the section 4.2 definition can detect it. F stays marked, as the contract requires.
- **Defect (6) variant.** The seeded counter defect sets `pairs = rank` instead of `rank + 1` on entering a candidate.
- **Smoke run time.** Run alone in the debug profile, the U2 smoke tests take about 60 s of wall time, mostly the shadow mode's repeated budgets. Under `pnpm test:geometry` they run beside the other tests.
- **Corpus shadow.** It drives the O4 inputs through `run_chunk` and discards the digests; the digest comparison with the merge base is the identity tool's O4 step.

The two native dump times (25.1 s base, 7.6 s branch) are not a benchmark; only U8's committed remeasure carries performance evidence.

### B0R U3 implementation

Unit U3 of the [B0R contract](p3-b0r-kernel-performance-contract.md#10-implementation-units): the binary64-input filters F0.2, F0.3, F0.4, F1 and F2.5 (sections 3.5-3.7). Acceptance: A1, A3-A10 and A8 for defect (2). A2 belongs to U2 and A13 to U4-U7. Functional evidence only; no performance claim.

Landed:

- `packages/geometry-wasm/kernel/src/fill_predicates.rs`:
  - `orient2d_filtered` runs F0.2 (two points equal by `same_point` give `Equal`), then F1, then the unchanged exact accumulator `orient2d_finite`, once. It replaces `orient2d_finite` at every call: `orient2d`, `point_on_segment_finite` and the four orientations of `segment_relation`.
  - F1 is Shewchuk's stage A with `ccwerrboundA = (3 + 16u) · u` and the strict test `|det| > ccwerrboundA · (|detleft| + |detright|)`. Its guard (every input magnitude at most 2^500, and the sum at least 2^-900, otherwise exact) and the section 3.6 rationale are a code comment beside it.
  - `segment_relation` runs F0.3 right after validation: disjoint closed coordinate boxes return `Disjoint`. The reason is a code comment.
  - `cfg(test)` only: pre-U3 copies `b0r_reference_orient2d`, `b0r_reference_point_on_segment` and `b0r_reference_segment_relation`, with the same statements except the `p3_b0_diag` hook, whose orientations all use `orient2d_finite`.
- `packages/geometry-wasm/kernel/src/fill_event_order.rs`:
  - `compare_event_x` and `compare_event_positions` validate both events and classify the left and then the right crossing, as before, so error precedence is unchanged. Then F0.4 compares two endpoints by their binary64 coordinates (x, then y for positions; signed zeros equal). Otherwise F2.5 compares x enclosures: an endpoint's x is a point interval, and a crossing's x is X / W from `crossing_position`'s formula evaluated in interval arithmetic from its four points. Only disjoint enclosures decide. On overlap the unchanged exact comparison runs for the whole comparison, x and then y.
  - `exact_event_position` keeps its behaviour; it now shares the classification and position helpers. The first-order width derivation of F2.5 is a code comment.
  - `cfg(test)` only: pre-U3 copies `b0r_reference_compare_event_x`, `b0r_reference_compare_event_positions` and `b0r_reference_exact_event_position` (classifying through the pre-U3 `segment_relation`), and `b0r_test_x_enclosure`. The inline test module is unchanged.
- `packages/geometry-wasm/kernel/src/fill_filter.rs`: five `FilterId` variants after U1's six, the O8 fault `F1BoundHalved`, and `fault_active` made `pub(crate)`. `FILTER_COUNT` keeps its U1 value 6, because U1's test files size arrays by it; the new `BINARY64_FILTER_COUNT` is 5 and the `cfg(test)` counter array holds both.
- New test files, declared in `lib.rs`:
  - `fill_predicates_filter_tests.rs` (9 tests, 1 ignored): the O1 smoke and full-size differentials of `orient2d`, `point_on_segment` and `segment_relation` against the pre-U3 copies; O2 fixtures for exactly collinear triples on a slope-1/3 line, one-ulp perturbations, F1's guard at 2^500, beyond it and below the 2^-900 product floor, subnormal coordinates, shared points with signed zeros, and F0.3 decided and touching boxes, including a signed-zero touch; three seeded triples on which binary64 stage A has the wrong sign with |det| between 0.5 and 1 times the bound; O8 (2).
  - `fill_event_order_filter_tests.rs` (8 tests, 1 ignored): the O1 smoke and full-size differentials of both comparisons against the pre-U3 copies, plus a direct check that every finite crossing enclosure contains the exact x; O2 fixtures for equal-x crossings with different y (tie rule), endpoints at a crossing's x and one ulp away, a nearly parallel crossing whose weight interval contains zero, overflowing scales (2^600, 2^1000) and deep underflow, unchanged error precedence, and decided controls; an O8 (1) check for the F2.5 enclosures.
  - Adversarial generators: near-line points `a + t(b − a)` with ulp steps, lattice lines of several slopes, shared and ulp-neighbouring points, touching boxes, scales from 2^-1000 to 2^960 and signed zeros; for events, endpoints near a crossing's x, lattice crossings exactly at a point, equal-x crossings, nearly parallel crossings, scaled crossings, reordered copies of one crossing, non-proper and non-finite events, and endpoint pairs.
- `tooling/compare-p3-fill-identity.mjs`: `EXPECTED_ORACLES` gains the two U3 oracles.
- Dated pointer lines under the status lines of [P3.2a](p3-fill-predicates-contract.md) and [P3.2c](p3-fill-event-order-contract.md), for the section 6.2 rows that U3's filters touch.

Local evidence, 2026-10-13, Windows 11, AMD Ryzen 7 3700X, 16 logical cores, pinned Rust 1.94.1, Node 24.15.0, uncommitted working tree on branch `claude/p3-b0r-u3-binary64-filters` over `main` `3e425ed`:

- `pnpm test:p3-fill-identity`: **PASS**, run `20261013T081921Z-ccfd17f4`, 18 min 36 s wall time.
  - Native: 66,351 cases on each side (6,350 B0, 60,000 randomized, 1 workspace size), all digests equal.
  - WASM: 3,969 cases, all equal between the two WASMs and equal to the native cascade digests.
  - Allocations: zero allocating cases (O7).
  - Corpora: SHA-256 B0 `206cf6e9…9796` and `p3-b0r-random/v1` `a1902d0f…ca9d`, both equal to the pinned values. Coverage floors are met with the same counts as U0's (5,135 `ok`, 3,376 `KnotMismatch`, 2,426 `Unresolved`, 1,665 cap failures, 248 `ok` with crossings). Both tamper self-checks were detected.
  - O5: the modified kernel sources are `fill_event_order.rs`, `fill_filter.rs`, `fill_predicates.rs` and `lib.rs`; their inline test modules are byte-identical to the merge base. No existing test file changed. The two new test files were untracked at run time, so the tool's added-file listing is empty.
  - Overlay: not needed (the harness is unchanged).
  - Release WASM SHA-256: base `353e2cf7…29ba`, branch `af59c882…4941`. The change is expected (section 2, operation identity); `fill_v0_revision()` stays 1.
  - Durations: release test builds 53.9 s (base) and 54.6 s (branch); release WASM builds 6.9 s and 6.1 s; native dumps 7.9 s (base) and 6.6 s (branch) on 16 threads; release oracles 961.3 s (8 passed); WASM layer 16.4 s.
- Full-size O1, release profile, inside the run above, 16 fixed seeded shards, zero disagreements:
  - `b0r_oracle_full_o1_binary64_predicates`, 2.1 s: 10^7 random and 10^6 adversarial tuples for each of `orient2d`, `point_on_segment` and `segment_relation`.
  - `b0r_oracle_full_o1_event_order`, 12.1 s: 10^7 random and 10^6 adversarial pairs for each of `compare_event_x` and `compare_event_positions`. Error results: 1,598,259 random and 106,379 adversarial (x), 1,597,067 and 106,895 (positions). Crossing enclosures checked against the exact x: 10,332,424 random and 1,051,142 adversarial, zero containment violations; 90,159 adversarial enclosures were unbounded (overflow or a weight interval containing zero) and fell back.
  - The U1, U1b and U2 full oracles in the same run gave the same counts as in their entries.
- Decided fractions of filter calls (random / adversarial):

  | Filter                    | `orient2d`      | `point_on_segment` | `segment_relation` |
  | ------------------------- | --------------- | ------------------ | ------------------ |
  | F0.2, calls (all decided) | 32 / 101,697    | 35 / 107,308       | 102 / 228,747      |
  | F1                        | 0.9948 / 0.3466 | 0.9948 / 0.3272    | 0.9960 / 0.3504    |
  | F0.3                      | —               | —                  | 0.5542 / 0.3554    |

  | Filter                    | `compare_event_x`   | `compare_event_positions` |
  | ------------------------- | ------------------- | ------------------------- |
  | F0.4, calls (all decided) | 1,601,073 / 100,093 | 1,600,791 / 100,170       |
  | F2.5                      | 0.9152 / 0.0537     | 0.9153 / 0.0539           |

  The adversarial event families aim at ties, exact crossings, near-parallel crossings and extreme scales, so their fallbacks are by design.

- O8, in `pnpm test:geometry`:
  - (2) F1 bound multiplied by 0.5: detected by `fill_predicates_filter_tests::b0r_o8_f1_bound_halved_is_detected`. All three seeded stage-A triples are then decided with the wrong sign, against the exact routine; without the fault, `b0r_o2_stage_a_wrong_sign_triples_fall_back` shows that F1 falls back on them.
  - (1), F2.5 part: with R1 widening removed, `fill_event_order_filter_tests::b0r_o8_r1_widening_removed_is_detected_by_event_enclosures` finds crossing enclosures that miss the exact x. U1's tests still detect (1) and (7), and U2's still detect (3)-(6).
  - Defects (8)-(14) belong to U4-U7.
- `pnpm test:geometry`: PASS, 7 min 29 s. Kernel fmt and clippy are clean. Native `cargo test`: 277 passed (262 before, 15 new), 27 ignored (25 before, 2 new). Geometry vitest: 733 passed, 6 skipped. The independent-build WASM SHA-256 is `af59c882…4941`, equal to the identity tool's branch build. The 15 new smoke tests take about 0.7 s in the debug profile.
- `pnpm test:p2-identity`: PASS, 10,048 batches with identical P2 output bytes (SHA-256 `876f4a49…0e046f`).
- `pnpm check`: PASS (65 unit files, 728 tests). `pnpm build`: PASS. `git diff --check`: clean. Prettier check of the changed documents and the tool (with an empty ignore file): clean.
- A10 `p3_b0_diag` clippy (`RUSTFLAGS="--cfg p3_b0_diag"`, `CARGO_TARGET_DIR=.tools/geometry-build-p3-b0-diag`, `--all-targets -D warnings`): PASS.
- A9: `git diff --exit-code main` on the Cargo files, `pnpm-lock.yaml`, every `package.json` and `packages/contracts` exits 0. No cap, limit or `fill_v0_*` export changes. The crate stays std-only with no `unsafe`.

Interpretations recorded for review:

- **Filter placement.** F0.2 and F1 sit in one private wrapper that replaces every `orient2d_finite` call, so they also run inside `point_on_segment` and the point-segment branches of `segment_relation`. Section 3.6 lists those callers.
- **F0.3 placement.** It runs before the point-segment branches. Section 3.5's reason covers them: a point segment is `CollinearPoint` only on the other closed segment.
- **F2.5 inputs.** The crossing formula uses the binary64 points as point intervals; no translation to a local origin is applied. The sign normalisation of W in `crossing_position` is skipped, because negating X and W together leaves X / W unchanged.
- **Classification before filtering.** Both comparisons run the `ProperCrossing` classification of each crossing before F0.4 or F2.5, as section 3.1 requires, so the number of `segment_relation` calls, and the `p3_b0_diag` count of that routine, is unchanged.
- **Stage-A fixtures.** The three triples come from a seeded search of the near-line family, in a scratch script that is not committed. Their binary64 determinant has the wrong sign with a ratio |det| / (u · sum) of 1.90, 1.71 and 1.67, between the halved bound (about 1.5) and the full bound (about 3).
- **Counter sizing.** `FILTER_COUNT` stays 6 so U1's test files compile unchanged (O5).

The durations above are not a benchmark; only U8's committed remeasure carries performance evidence.

### B0R U4 implementation

Unit U4 of the [B0R contract](p3-b0r-kernel-performance-contract.md#10-implementation-units): the column and section filters F0.5, F0.6 and F2.6-F2.8 (sections 3.4, 3.5 and 3.7) and the tessellation changes T1, T2 and T4 (section 5.2), with the O10 shadow mode for them. Acceptance: A1, A3-A10 and A13. A2 belongs to U2; T3 and T5 are U5, and L1-L4 are U6 and U7. Functional evidence only; no performance claim.

Landed:

- `packages/geometry-wasm/kernel/src/fill_sections.rs`:
  - `compare_columns` and `compare_sections` run F0.6 (identical sign and used limbs give `Equal`; two zeros are one identity), then F2.6 or F2.7 (disjoint section 3.4 ratio enclosures decide), then the unchanged exact routine once. `compare_column_f64` and `compare_section_f64` run F2.6 or F2.7 against the candidate's point interval.
  - `within_half_budget`, `lower_half_predicate` and `upper_half_predicate` run F2.8 on the ratio enclosure: d = (s − v) − τ/2 in interval arithmetic, with τ · 0.5 only when τ ≥ 2^-1021 (otherwise, and for every non-positive or non-finite τ, the filter is undecided). `within_half_budget` combines the two one-sided decisions. The first-order width derivations of F2.6-F2.8 are code comments.
  - The unchanged exact routines stay as `exact_compare_columns`, `exact_compare_column_f64`, `exact_compare_sections`, `exact_compare_section_f64`, `exact_within_half_budget`, `exact_lower_half_predicate` and `exact_upper_half_predicate`: the fallbacks and the O1/O10 reference. They are not `cfg(test)` copies; the module has no `p3_b0_diag` hook to omit.
  - T1 and T4: `compare_column_source_f64` compares an event's column with a binary64 value: F0.5 for an endpoint (its column is (x, 1)), the F2.5 crossing x enclosure (`x_enclosure`) for a crossing, and only then `event_column` and the filtered comparison. `SectionSource` names a section by its defining data (`Endpoint(y)`, `Column(event)`, `Edge { start, end, column }`); its `build` is the eager construction (`endpoint_section`, `column_as_section(event_column)`, `section_at_column(.., event_column)`), and its `enclosure` is computed from the binary64 data. `compare_section_sources` runs F0.5 for two endpoint values, then the source enclosures, then builds both sections, left first, and calls `compare_sections`.
  - T2: `SectionTarget` holds one `embed_scalar` target: its F0.5 value or enclosure is computed once, each bisection step (`compare_f64`) and window step (`lower_half`, `upper_half`) compares the candidate against it, and the exact section is built at most once per target, only when a step falls back. Nothing is cached across targets.
  - The inline test module is unchanged.
- `packages/geometry-wasm/kernel/src/rounded_line_fill.rs`, inside the charged operations only:
  - `find_endpoint_column` compares through `compare_column_value` (T4: F0.5 or the crossing enclosure; T1: the column is built only on fallback).
  - `build_sections_and_nodes` passes the column's and each node's `SectionSource` to `embed_scalar` instead of a built section, and `compare_section_records` (the comparator of `sort_section_range` and node grouping) compares sources. The endpoint-code check `InternalInvariant` stays at the same place.
  - `embed_scalar`, `search_lower_window` and `search_upper_window` take one `SectionTarget` per call (T2).
  - `sort_events` and `build_exact_columns` are unchanged: their comparator `compare_event_x` already runs F0.4 and F2.5 since U3, which is T4 for them. `build_cells`, `sort_active` and `build_slab_cells` keep their eager sections (T5 is U5); their `compare_sections` calls now run F0.6 and F2.7 inside the crate function.
  - Charge invariance (section 5.1): no `charge()` line, loop header, `break` or `continue` is moved or removed; the diff adds only `?` error propagation for the lazy builds after existing charges.
  - `cfg(test)` only: the pre-U4 `exact_section` as the O10 reference, and shadow checks at each lazy site that compare the built source with the eager value and each decision with the exact routine on it.
  - The inline test module is unchanged; it calls `embed_scalar` with a built section, which `SectionTarget`'s `cfg(test)` `From<ExactSection>` accepts.
- `packages/geometry-wasm/kernel/src/fill_filter.rs`: nine `FilterId` variants after U3's eleven, `SECTION_FILTER_COUNT` = 9 (`FILTER_COUNT` and `BINARY64_FILTER_COUNT` keep their values), and the `cfg(test)` O10 shadow switch and tally (`with_shadow`, `shadow_active`, `shadow_check`, `take_shadow_tally`), thread-local like the counters.
- `packages/geometry-wasm/kernel/src/fill_event_order.rs`: `x_enclosure` (the F2.5 crossing x enclosure) becomes `pub(crate)` so the T1 and T4 column enclosures reuse it. No other change.
- New test file `fill_sections_filter_tests.rs`, declared in `lib.rs` (17 tests, 2 ignored):
  - O1 smoke and full-size differentials of the seven crate comparisons against the `exact_*` routines, and of the five source-level comparisons against the exact routine on the eagerly built value, with an exact containment check of every finite source enclosure and crossing column enclosure.
  - O2 fixtures: sections exactly equal to a binary64 candidate; half-budget ties 2(N − vW) = TW, as endpoint sections and as edge sections; τ at the minimum subnormal, at 2^-1022, just below and at 2^-1021; `endpoint_section` at 100 and near 2^±1000 through section 3.4; F0.6 on identical and on shifted representations, and on zeros with either sign flag; equal sections of the two edges of a crossing and of edges through a shared vertex; non-finite sources keeping their errors; decided controls for snapped mediant columns, sections at mediant samples and at crossing columns, crossing columns from their points and window steps.
  - O10 smoke: the 202 `p3-rounded-fill-v1` rows and 15 seeded random scenes, each tessellated with shadow mode off and on, with equal results, stats and vertex bits, and zero shadow mismatches.
  - O8: (1) R1 widening removed, detected by the source enclosure containment check; (7) fixed numerator unit, detected by the crate differential and by shadow mode on fixture rows.
  - Generators: scene points at scales 2^-1000 to 2^1000, small integers and zeros; proper crossings near a point and exactly at lattice points; mediants of independent and of adjacent binary64 columns; numerator and weight shifted together by up to 400 bits; candidates at, and within three ulps of, the value; tolerances at the halving limits and at twice the distance.
- `tooling/compare-p3-fill-identity.mjs`: `EXPECTED_ORACLES` gains the two U4 oracles.
- A dated pointer line under the status line of [P3.2e](p3-rounded-fill-mesh-contract.md), for the section 6.2 rows that U4 touches (`:37`, `:43`, `:45`, `:134`, `:138`).

Local evidence, 2026-10-13, Windows 11, AMD Ryzen 7 3700X, 16 logical cores, pinned Rust 1.94.1, Node 24.15.0, uncommitted working tree on branch `claude/p3-b0r-u4-section-filters` over `main` `b7f82c4`:

- `pnpm test:p3-fill-identity`: **PASS**, run `20261013T094837Z-b506e473`, 19 min 25 s wall time.
  - Native: 66,351 cases on each side (6,350 B0, 60,000 randomized, 1 workspace size), all digests equal.
  - WASM: 3,969 cases, all equal between the two WASMs and equal to the native cascade digests.
  - Allocations: zero allocating cases (O7).
  - Corpora: SHA-256 B0 `206cf6e9…9796` and `p3-b0r-random/v1` `a1902d0f…ca9d`, both equal to the pinned values. Coverage floors are met with the same counts as U0's (5,135 `ok`, 3,376 `KnotMismatch`, 2,426 `Unresolved`, 1,665 cap failures, 248 `ok` with crossings). Both tamper self-checks were detected.
  - O5: the modified kernel sources are `fill_event_order.rs`, `fill_filter.rs`, `fill_sections.rs`, `lib.rs` and `rounded_line_fill.rs`; their inline test modules are byte-identical to the merge base. No existing test file changed. The new test file was untracked at run time, so the tool's added-file listing is empty.
  - Overlay: not needed (the harness is unchanged).
  - Release WASM SHA-256: base `af59c882…4941`, branch `29fb0794…4601`. The change is expected (section 2, operation identity); `fill_v0_revision()` stays 1.
  - Durations: release test builds 53.7 s (base) and 55.9 s (branch); release WASM builds 5.7 s and 6.0 s; native dumps 6.8 s (base) and 3.6 s (branch) on 16 threads; release oracles 1,020.3 s (10 passed); WASM layer 10.3 s.
- Full-size O1, release profile, inside the run above, 16 fixed seeded shards, zero disagreements, 31.5 s (`b0r_oracle_full_o1_sections`):
  - Crate comparisons: 10^7 random and 10^6 adversarial tuples, each evaluated by all seven comparisons.
  - Source comparisons: 10^7 random and 10^6 adversarial tuples, each evaluated by `compare_column_source_f64`, `compare_section_sources` and three steps of one `SectionTarget` (compare, lower and upper half). Source enclosures checked against the exact value: 26,606,712 random and 1,825,598 adversarial, zero containment violations; 897,319 adversarial enclosures were unbounded (extreme scales) and fell back.
  - The U1, U1b, U2 and U3 full oracles in the same run gave the same counts as in their entries.
- Full-size O10, `b0r_oracle_full_o10_tessellation_shadow`, release profile, inside the run above: the B0 corpus (66 chunks, 12.4 s) and `p3-b0r-random/v1` (240 chunks, 45.5 s cumulative) through every `CubicFillWorkspace` entry and the V2 cascade with shadow mode on: 34,278,548 and 255,947,415 shadow checks, zero mismatches.
- Decided fractions of filter calls. O1 (random / adversarial):

  | Filter                | Crate tuples        | Source tuples          |
  | --------------------- | ------------------- | ---------------------- |
  | F0.5, calls (decided) | —                   | 14,562,006 / 1,108,986 |
  | F0.6, calls (decided) | 3,341,980 / 499,795 | 9,038 / 22,606         |
  | F2.6                  | 0.5014 / 0.4185     | 0.0031 / 0.1344        |
  | F2.7                  | 0.5015 / 0.5288     | 0.0051 / 0.2434        |
  | F2.8                  | 0.5011 / 0.4358     | 0.0439 / 0.1983        |
  | T1/T4 crossing column | —                   | 0.2479 / 0.1287        |
  | T1 section sources    | —                   | 0.9947 / 0.4682        |
  | T2 bisection step     | —                   | 0.2582 / 0.1640        |
  | T2 window step        | —                   | 0.5869 / 0.4526        |

  Most O1 candidates are placed at, or within three ulps of, the value by design, so their fallbacks are expected; the F2 rows of the source tuples count only the fallbacks of the source filters. On the O10 corpora (B0 / randomized): F0.5 6,548,069 / 32,040,443 calls; F0.6 30 / 90,980; F2.7 0.2480 / 0.3497; F2.8 0.0471 / 0.1233; T1/T4 crossing column 1.0000 (3,784 / 75,148 calls); T1 section sources 0.5609 / 0.7386; T2 bisection step 0.9524 / 0.9458; T2 window step 0.9492 / 0.9408. F2.6 did not run on the corpora, because every column comparison was decided by F0.5 or the crossing enclosure.

- O8, in `pnpm test:geometry`:
  - (1), U4 part: with R1 widening removed, `fill_sections_filter_tests::b0r_o8_r1_widening_removed_is_detected_by_section_sources` finds source enclosures that miss the exact value.
  - (7), U4 part: with the fixed numerator unit, `fill_sections_filter_tests::b0r_o8_ratio_fixed_numerator_unit_is_detected_by_section_filters` finds disagreements of the crate filters, and `b0r_o8_ratio_fixed_numerator_unit_is_detected_by_shadow_mode` finds O10 mismatches on fixture rows.
  - The contract assigns none of defects (8)-(14) to U4: (8)-(10) are T3 and T5 (U5), (11)-(14) are L1-L4 (U6, U7). U1's tests still detect (1) and (7), U2's (3)-(6) and U3's (2).
- `pnpm test:geometry`: PASS, 7 min 44 s. Kernel fmt and clippy are clean. Native `cargo test`: 292 passed (277 before, 15 new), 29 ignored (27 before, 2 new). Geometry vitest: 733 passed, 6 skipped. The independent-build WASM SHA-256 is `29fb0794…4601`, equal to the identity tool's branch build. The 15 new smoke tests take about 9 s wall time in the debug profile when run alone.
- `pnpm test:p2-identity`: PASS, 10,048 batches with identical P2 output bytes (SHA-256 `876f4a49…0e046f`).
- `pnpm check`: PASS (65 unit files, 728 tests; dependency boundaries PASS). `pnpm build`: PASS. `git diff --check`: clean. Prettier check of the changed documents and the tool (with an empty ignore file): clean.
- A10 `p3_b0_diag` clippy (`RUSTFLAGS="--cfg p3_b0_diag"`, `CARGO_TARGET_DIR=.tools/geometry-build-p3-b0-diag`, `--all-targets -D warnings`, `CARGO_ENCODED_RUSTFLAGS` unset): PASS.
- A9: `git diff --exit-code main` on the Cargo files, `pnpm-lock.yaml`, every `package.json` and `packages/contracts` exits 0. No cap, limit or `fill_v0_*` export changes. The crate stays std-only with no `unsafe`.
- A13: the diff of `rounded_line_fill.rs` moves or removes no `charge()` line, loop header, `break` or `continue`; O10 passes and O4 shows equal `work_units` for every case.

Interpretations recorded for review:

- **Edge-section enclosure formula.** T1 asks for interval evaluation of `section_at_column`'s formula. The source enclosure evaluates a.y + (x − a.x) · (b.y − a.y) / (b.x − a.x), which multiplies out to the same real number −(Lx · x + Lz) / Ly for b.x ≠ a.x and avoids the cancellation of Lz's products. Soundness rests on R1-R3 only.
- **Validation before lazy column filters.** Section 3.1 runs filters after a routine's validation. `event_column` validates the event and classifies a crossing; the lazy column and section filters skip that for events in `exact_columns`, every one of which already passed `compare_event_x`'s validation and `ProperCrossing` check in `sort_events` and `build_exact_columns` (each event is compared at least once, because every edge contributes two endpoint events). So the eager `event_column` cannot fail there, and errors are unchanged. Non-finite endpoint data is not filtered, so the crate-level source functions keep the eager errors; O10 compares lazy and eager results, errors included.
- **F2.6-F2.8 inside the crate functions.** The filters run inside `compare_columns`, `compare_sections` and the half predicates, so `sort_active` and `build_slab_cells` (unrestructured, T5 is U5) also use F0.6 and F2.7 on their eager sections. F0.6 is applied only to built representations; U5's sentinel rule still has to resolve sentinels before F0.6.
- **T2 step test.** Each step compares the candidate with the per-call enclosure in binary64 (equivalent to comparing its rank with the enclosure's rank interval); a window step evaluates F2.8's d on the same enclosure.
- **Counter sizing.** `FILTER_COUNT` and `BINARY64_FILTER_COUNT` keep their values so U1's and U3's test files compile unchanged (O5).

The durations above are not a benchmark; only U8's committed remeasure carries performance evidence.

### B0R U5 implementation

Unit U5 of the [B0R contract](p3-b0r-kernel-performance-contract.md#10-implementation-units): the tessellation changes T3 (endpoint-section identity) and T5 (lazy slab samples and the zero-weight `ActiveEdge.section` sentinel under the T5 consumer rule) of section 5.2, with O10 shadow coverage for them. Acceptance: A1, A3-A10 and A13, and A8 for defects (8)-(10). A2 belongs to U2; L1-L4 are U6 and U7. Functional evidence only; no performance claim.

Landed:

- `packages/geometry-wasm/kernel/src/fill_sections.rs`:
  - T3: `SectionSource::edge(start, end, column)` returns the new variant `SectionSource::EdgeEndpoint` when `column` is an `Endpoint` event whose x equals `start.x` or `end.x` (binary64 `==`), every coordinate is finite and the edge is nonvertical. Its `exact_value` is that endpoint's y (so F0.5 compares it), its `enclosure` is the point interval, and its `build` is the unchanged `section_at_column(start, end, event_column(column))`. Otherwise the plain `Edge` keeps the U4 behaviour, including the vertical-edge assertion. The identity and the signed-zero argument are code comments.
  - T5: `ExactSection::unbuilt()` is the zero-weight sentinel and `is_unbuilt()` tests it. `SlabSample` holds one slab's two column events, its enclosure and the lazily built mediant. For two endpoint columns the enclosure is (x1 + x2) · 0.5 by interval arithmetic; if either column is a crossing, it is the hull of the two `x_enclosure`s, which contains every mediant of the two ratios. `compare_slab_sections` follows the consumer rule: (1) compare the two sections' enclosures, computed from the edge endpoints and the sample's enclosure, never from a stored representation; (2) otherwise resolve both operands in place, left first, a sentinel becoming `section_at_column(edge.a, edge.b, sample)` with the sample built at most once per slab; (3) only then `compare_sections` (F0.6, F2.7, exact). F0.6 therefore never sees a sentinel.
  - The edge-section interval formula of U4's `SectionSource::enclosure` moves into a shared helper; its arithmetic is unchanged.
  - The inline test module is unchanged.
- `packages/geometry-wasm/kernel/src/rounded_line_fill.rs`, inside the charged operations only:
  - `section_source` builds endpoint code 0 through `SectionSource::edge` (T3), which reaches `compare_section_records` and `embed_scalar`. T3 is not used in `build_cells`.
  - `build_cells` makes one `SlabSample` per slab and pushes each active edge with the sentinel instead of an eager section. `sort_active` compares through `compare_active`, which stores a built section in `self.active[left]` or in the moving copy `value` (written back by the existing `self.active[cursor] = value`); shifts copy whatever an element holds. `build_slab_cells` compares through `compare_active_elements` (`split_at_mut`), which stores built sections in both elements. `ActiveEdge`, the `active` buffer and its capacity are unchanged.
  - Charge invariance (section 5.1): no `charge()` line, loop header, `break` or `continue` is moved or removed; the diff replaces only the comparison expressions and adds `?` propagation for the lazy builds, whose errors are unreachable for columns that passed `compare_event_x`.
  - `exact_column` becomes `cfg(test)`: it is now only the O10 shadow reference.
- `packages/geometry-wasm/kernel/src/fill_filter.rs`: two `FilterId` variants after U4's nine (`EndpointSection` for T3 applications, `SlabSection` for consumer-rule step 1), `SLAB_FILTER_COUNT` = 2 (`FILTER_COUNT`, `BINARY64_FILTER_COUNT` and `SECTION_FILTER_COUNT` keep their values), and three O8 fault variants (`T3OneUlp`, `T5SentinelAsValue`, `T5SentinelIdentity`), which compile to nothing outside test builds like the existing ones.
- New test file `fill_sections_slab_tests.rs`, declared in `lib.rs` (14 tests, 2 ignored):
  - O1 T3 differential: nonvertical edges with the column x at an endpoint x (including ±0.0 and a.y = -0.0), one to three ulps away, or unrelated, at scales 2^-1000 to 2^1000 with zeros and subnormals in the adversarial set. It checks that the identity applies exactly when the x coordinates are equal, that its value equals the exact section, that `build` equals the eager section, and that `compare_section_sources` (both orders, against endpoint, shared-vertex edge, column and unrelated partners) and three `SectionTarget` steps equal the exact routines.
  - O1 T5 differential: slabs of independent, adjacent-binary64, endpoint and crossing columns; active edges that are random, through a slab vertex, segments of a crossing column, identical, or one ulp apart; operands as sentinels or already built. It checks `compare_slab_sections` against the exact comparison of the eager sections at the eager mediant, that every stored section equals the eager one, and that every finite sample and section enclosure contains the exact value.
  - O2 fixtures: T3 with a.y = -0.0 at column x +0.0 and -0.0 (decided, value -0.0, and a +0.0 output vertex in a tessellation); T3 not applied one ulp away, to a vertical edge, at a crossing column or with non-finite data; T3 decided controls (shared-vertex sections and embedding steps without fallback); T5 decided controls on an endpoint slab and on a slab bounded by a crossing column (nothing built, neither sample nor section); T5 fallbacks for two edges through a vertex with slopes one ulp apart and for identical edges (both sentinels resolved, sample built once, then F0.6), and a built operand kept beside a resolved sentinel; the sentinel's zero weight.
  - O10 smoke: the 202 `p3-rounded-fill-v1` rows with shadow mode off and on, equal results, stats and vertex bits, zero mismatches. The U4 shadow switch now also checks, at every slab comparison, the result against the eager exact comparison and every operand that reaches `compare_sections` against the eager section.
  - O8: (8) `b0r_o8_t3_one_ulp_is_detected`, (9) `b0r_o8_t5_sentinel_read_as_value_is_detected`, (10) `b0r_o8_t5_sentinel_identity_is_detected` (details below).
- `tooling/compare-p3-fill-identity.mjs`: `EXPECTED_ORACLES` gains the two U5 oracles.
- A dated pointer line under the status line of [P3.2e](p3-rounded-fill-mesh-contract.md), for the section 6.2 rows that U5 touches (`:134`, `:138`).

Local evidence, 2026-10-13, Windows 11, AMD Ryzen 7 3700X, 16 logical cores, pinned Rust 1.94.1, Node 24.15.0, uncommitted working tree on branch `claude/p3-b0r-u5-endpoint-sentinel` over `main` `b2e6e3e`:

- `pnpm test:p3-fill-identity`: **PASS**, run `20261013T110003Z-805602f3`, 19 min 24 s wall time.
  - Native: 66,351 cases on each side (6,350 B0, 60,000 randomized, 1 workspace size), all digests equal.
  - WASM: 3,969 cases, all equal between the two WASMs and equal to the native cascade digests.
  - Allocations: zero allocating cases (O7).
  - Corpora: SHA-256 B0 `206cf6e9…9796` and `p3-b0r-random/v1` `a1902d0f…ca9d`, both equal to the pinned values. Coverage floors are met with the same counts as U0's (5,135 `ok`, 3,376 `KnotMismatch`, 2,426 `Unresolved`, 1,665 cap failures, 248 `ok` with crossings). Both tamper self-checks were detected.
  - O5: the modified kernel sources are `fill_filter.rs`, `fill_sections.rs`, `lib.rs` and `rounded_line_fill.rs`; their inline test modules are byte-identical to the merge base. No existing test file changed. The new test file was untracked at run time, so the tool's added-file listing is empty.
  - Overlay: not needed (the harness is unchanged).
  - Release WASM SHA-256: base `29fb0794…4601`, branch `380f94f6…0bbd`. The change is expected (section 2, operation identity); `fill_v0_revision()` stays 1.
  - Durations: release test build 67.1 s (base; the branch build was cached by `pnpm test:geometry`); release WASM build 6.5 s (base); native dumps 4.0 s (base) and 3.0 s (branch) on 16 threads; release oracles 1,074.7 s (12 passed); WASM layer 5.9 s.
- Full-size O1, release profile, inside the run above, 16 fixed seeded shards, zero failures in every check, 15.2 s (`b0r_oracle_full_o1_slab_sections`):
  - T3: 10^7 random and 10^6 adversarial cases. The identity applied to 5,082,166 and 525,140 of them, exactly the cases whose column x equals an endpoint x.
  - T5: 10^7 random and 10^6 adversarial slab samples with two comparisons each (2 × 10^7 and 2 × 10^6). Enclosures checked against the exact value: 50,000,000 random and 3,524,380 adversarial, zero containment violations; 1,475,620 adversarial enclosures were unbounded (extreme scales) and fell back. Comparisons that built a section: 1,677,598 and 1,236,879.
  - The U1-U4 full oracles in the same run gave the same counts as in their entries.
- Full-size O10, `b0r_oracle_full_o10_tessellation_shadow` (U4's oracle, which now includes the T5 checks), release profile, inside the run above: 33,863,167 (B0) and 254,017,031 (randomized) shadow checks, zero mismatches.
- Decided fractions of the U5 identities and filters (step 1 for T5; T3 counts applications, which are always decided):

  | Filter                     | O1 random / adversarial | O4 corpora B0 / randomized |
  | -------------------------- | ----------------------- | -------------------------- |
  | T3 applications            | 7,128,493 / 738,057     | 667,540 / 3,878,852        |
  | T5 slab section            | 0.9056 / 0.3042         | 0.9717 / 0.9594            |
  | T1 section sources (T3 O1) | 0.9058 / 0.5337         | 0.9899 / 0.9772            |
  | T2 bisection step (T3 O1)  | 0.9975 / 0.6679         | 0.9492 / 0.9409            |
  | T2 window step (T3 O1)     | 0.8334 / 0.7517         | 0.9492 / 0.9408            |

  The corpus rates come from `b0r_oracle_full_slab_corpus_rates` (shadow off): 198,030 decided and 5,776 fallback slab comparisons on B0, 2,128,792 and 89,992 on the randomized corpus. The T3 O1 cases place candidates at, or within two ulps of, the value by design, so their fallbacks are expected.

- O8, in `pnpm test:geometry`:
  - (8) T3 applied when the column x is one ulp from the endpoint x: `fill_sections_slab_tests::b0r_o8_t3_one_ulp_is_detected` finds identity values unequal to the exact section and comparisons that disagree with the exact routines (O1).
  - (9) the T5 sentinel read as a value (consumer-rule step 2 skipped): `b0r_o8_t5_sentinel_read_as_value_is_detected` finds slab comparisons that disagree with the exact routine (O1). Every operand starts as a sentinel there, so the defect compares two sentinels and never reaches `compare_ratios` with a zero weight, whose debug assertion would otherwise panic.
  - (10) F0.6 applied to two sentinels: `b0r_o8_t5_sentinel_identity_is_detected` finds O1 disagreements and O10 shadow mismatches on the first 60 fixture rows.
- `pnpm test:geometry`: PASS. Kernel fmt and clippy are clean. Native `cargo test`: 304 passed (292 before, 12 new), 31 ignored (29 before, 2 new). Geometry vitest: 733 passed, 6 skipped. The independent-build WASM SHA-256 is `380f94f6…0bbd`, equal to the identity tool's branch build. The 12 new smoke tests take about 4 s wall time in the debug profile when run alone.
- `pnpm test:p2-identity`: PASS, 10,048 batches with identical P2 output bytes (SHA-256 `876f4a49…0e046f`).
- `pnpm check`: PASS (65 unit files, 728 tests; dependency boundaries PASS). `pnpm build`: PASS. `git diff --check`: clean. Prettier check of the changed documents and the tool (with an empty ignore file): clean.
- A10 `p3_b0_diag` clippy (`RUSTFLAGS="--cfg p3_b0_diag"`, `CARGO_TARGET_DIR=.tools/geometry-build-p3-b0-diag`, `--all-targets -D warnings`, `CARGO_ENCODED_RUSTFLAGS` unset): PASS.
- A9: `git diff --exit-code main` on the Cargo files, `pnpm-lock.yaml`, every `package.json` and `packages/contracts` exits 0. No cap, limit or `fill_v0_*` export changes. The crate stays std-only with no `unsafe`.
- A13: the removed lines of `rounded_line_fill.rs` and `fill_sections.rs` contain no `charge()`, `for`, `while`, `loop`, `break` or `continue`; O10 passes and O4 shows equal `work_units` for every case.

Interpretations recorded for review:

- **T3 as a separate source variant.** T3 is applied where the tessellation forms a section source (`SectionSource::edge`), and a plain `SectionSource::Edge` built directly keeps U4's behaviour. U4's fixture `b0r_o2_equal_sections_at_crossing_and_shared_vertex_fall_back` builds such a source and still expects a fallback; O5 forbids changing it, and the tessellation now decides that case by T3. The variant's `build` is the eager construction, so U4's shadow check of built sources against `exact_section` stays a representation equality.
- **T3 only for endpoint representatives.** A column is represented by its first event in sorted order. If that event is a crossing whose x equals an edge endpoint's x, T3 does not apply and the U4 path runs; the contract defines T3 for columns that come from an `Endpoint` event.
- **Endpoint-slab sample enclosure.** The contract derives it from 3.4 on the exact mediant of the two endpoint columns (two `from_finite` and one add). `SlabSample::new` instead evaluates `(x1 + x2) · 0.5` in interval arithmetic on the binary64 endpoint coordinates, which encloses the same exact mediant value by R1-R2; section 3.4 allows an enclosure taken directly from the defining f64 data. Soundness is checked by the O1 containment counts above.
- **Crossing-slab sample enclosure.** The contract asks for "the mediant's interval formula" over both columns' enclosures. Without the exact weights the formula's range is the hull of the two values, which is what U5 uses. It is wide, so slabs next to a crossing column fall back more often (O1 adversarial decided fraction 0.3042).
- **Lazy-build errors.** The eager code built both slab columns before the slab's charges, so an `event_column` error would have come earlier. Every column event passed `compare_event_x` (the U4 argument), so the error cannot occur and no outcome or charge moves.

The durations above are not a benchmark; only U8's committed remeasure carries performance evidence.

### B0R U6 implementation

Unit U6 of the [B0R contract](p3-b0r-kernel-performance-contract.md#10-implementation-units): the loop restructurings L1 (`collect_events`) and L2 (`sort_events`) of section 5.4, with Lemma C, Corollary C1 and Lemma D, the `cfg(test)` reference loops and the oracles O10 and O11. Acceptance: A1, A3-A10 and A13, and A8 for defects (11)-(13). A2 belongs to U2; L3 and L4 are U7. Functional evidence only; no performance claim.

Landed:

- `packages/geometry-wasm/kernel/src/rounded_line_fill.rs`:
  - L1: `collect_events` pushes the endpoint events as before. With at most 64 edges, `collect_crossings_swept` runs; otherwise the current all-pairs loop, kept unchanged in place, runs (size guard). `sweep_box_overlaps` builds the exact closed box of each edge, insertion-sorts the edge indices by `x_lo` into a `[u8; 64]`, scans forward while `x_lo_b <= x_hi_a` and marks pairs whose y ranges also overlap in a `[u64; 64]` bitset, row i holding bit j for j > i. These are exactly the pairs that F0.3 does not decide `Disjoint`. The rows are read in index order with `trailing_zeros`, which is lexicographic (left, right) order.
  - Corollary C1 with the rank i(2n − i − 1)/2 + (j − i − 1) as the iteration index: before each candidate's unchanged body (`crossing_pair`: `segment_relation`, then `push_event`, which may fail `EventLimit`), `bulk_charge_pairs(rank − consumed + 1)` applies the outer charges of the skipped iterations and of this one; after the last candidate, `bulk_charge_pairs(total − consumed)`. `bulk_charge` is Lemma C (on overflow `work_units = max_work` and `WorkLimit`), and `bulk_charge_pairs` is its counted variant: it adds min(m, `max_work − work_units`) to `pair_checks`, the number of `charge()` calls that would have succeeded.
  - L2: with at most 256 events, `sort_events_merged` runs `stable_sort_charges`, a stable bottom-up merge sort of event indices in two `[u16; 256]` stack arrays with the unchanged comparator `compare_event_x` (F0.4 and F2.5 since U3), uncharged. It counts Σ g_i while merging (taking a right-run element adds the number of left-run elements remaining) and m in one extra running-minimum pass, and returns C = Σ g_i + (n − 1) − m. Then `bulk_charge(C)`: on success the permutation is applied through `exact_columns` (empty at this point, capacity `max_events`), which is cleared again; on failure `WorkLimit` returns with `events` unsorted. A comparator error returns `None`, and the current insertion sort, kept unchanged in place, runs on the untouched `events` from the start. More than 256 events also run the insertion sort (size guard).
  - The derivations of the sweep, the rank, Lemma C, Corollary C1, Lemma D and the fallback argument are code comments.
  - `cfg(test)` only: `derive(Clone)` on `RoundedFillWorkspace`; verbatim copies of the pre-U6 loops (`b0r_reference_collect_events`, `b0r_reference_sort_events`); the O10 shadow comparison `b0r_shadow_event_loop`, which runs the restructured loop on the workspace and the reference on a clone of the state before it and compares the result, every `RoundedFillStats` counter, the bit patterns of the pushed events and `exact_columns`; a loop-variants switch that also compares both loops from clones under reduced budgets and event limits; per-thread loop counts and tallies; the O8 (13) fault path; and test access functions.
  - No workspace field, retained buffer, cap, limit or export changes, and nothing is allocated. The diff removes no line of the file: every unrestructured function keeps every `charge()`, loop header, `break` and `continue`.
- `packages/geometry-wasm/kernel/src/fill_filter.rs`: three O8 fault variants, `C1OuterChargeShort` (11), `LemmaDWithoutMinimum` (12) and `L1SortedByX` (13). No `FilterId` is added, so every filter count keeps its value.
- New test file `rounded_line_fill_loop_tests.rs`, declared in `lib.rs` (11 tests, 2 ignored):
  - O10 smoke: the 202 `p3-rounded-fill-v1` rows and 12 seeded random scenes, tessellated with shadow mode and loop variants off and on, with equal results and stats and zero loop mismatches.
  - O11 smoke: Lemma D on 10^4 tie-heavy integer sequences (all equal, sorted, reversed, sawtooth, random over 1-8 keys, random wide keys; lengths 0-256) against a counting stable insertion sort, comparing permutation, C and stability; Lemma C on 10^4 random states at every boundary of the remaining budget, plain and counted, against consecutive `charge()` calls; and 12 scenes through both real loops at every failing budget (the debug smoke samples both sides of 48 iteration boundaries when a loop's charge total exceeds 400 for L1 or 600 for L2; the full-size O11 is exhaustive) and, for L1, at every crossing push's `EventLimit`, with reordered events, tied copies and injected invalid events for L2.
  - The fallback and size guards: with an erroring element at any position, `stable_sort_charges` reports the error for every n ≥ 2; an invalid event (a non-finite endpoint or a non-crossing `Crossing`) at every position of a 12-event list, at every budget 0-80, gives the reference's result, counters and events; 256 events are merge-sorted and 300 are insertion-sorted; 64 edges are swept and 65 run the all-pairs loop.
  - O8 tests for defects (11)-(13).
- `tooling/compare-p3-fill-identity.mjs`: `EXPECTED_ORACLES` gains the two U6 oracles.
- A dated pointer line under the status line of [P3.2e](p3-rounded-fill-mesh-contract.md), for the section 6.2 rows that U6 touches (`:130`, `:138`).

Local evidence, 2026-10-13, Windows 11, AMD Ryzen 7 3700X, 16 logical cores, pinned Rust 1.94.1, Node 24.15.0, uncommitted working tree on branch `claude/p3-b0r-u6-event-loops` over `main` `aaa03de`:

- `pnpm test:p3-fill-identity`: **PASS**, run `20261013T125102Z-454b0f72`, 29 min 3 s wall time.
  - Native: 66,351 cases on each side (6,350 B0, 60,000 randomized, 1 workspace size), all digests equal.
  - WASM: 3,969 cases, all equal between the two WASMs and equal to the native cascade digests.
  - Allocations: zero allocating cases (O7).
  - Corpora: SHA-256 B0 `206cf6e9…9796` and `p3-b0r-random/v1` `a1902d0f…ca9d`, both equal to the pinned values. Coverage floors are met with the same counts as U0's (5,135 `ok`, 3,376 `KnotMismatch`, 2,426 `Unresolved`, 1,665 cap failures, 248 `ok` with crossings). Both tamper self-checks were detected.
  - O5: the modified kernel sources are `fill_filter.rs`, `lib.rs` and `rounded_line_fill.rs`; their inline test modules are byte-identical to the merge base. No existing test file changed. The new test file was untracked at run time, so the tool's added-file listing is empty.
  - Overlay: not needed (the harness is unchanged).
  - Release WASM SHA-256: base `380f94f6…0bbd`, branch `2467c87c…47f7`. The change is expected (section 2, operation identity); `fill_v0_revision()` stays 1.
  - Durations: release test builds 62.5 s (base) and 65.5 s (branch); release WASM builds 6.8 s and 6.8 s; native dumps 4.0 s (base) and 3.2 s (branch) on 16 threads; release oracles 1,585.1 s (14 passed); WASM layer 5.5 s.
- Full-size O10 for L1 and L2, `b0r_oracle_full_o10_event_loops`, release profile, inside the run above, through every `CubicFillWorkspace` entry and the V2 cascade:
  - B0 corpus (66 chunks, 14.4 s): with shadow off, 2,385 swept `collect_events` calls with 91,730 candidate pairs of 2,182,675 logical pairs (fraction 0.0420), and 2,385 merge sorts of 182,220 events with emulated charge totals summing to 3,956,673 and no comparator-error fallback. With shadow mode and loop variants on, 23,745 `collect_events` and 23,734 `sort_events` comparisons with the reference (32,809 ending in `WorkLimit`, 360 in `EventLimit`), zero mismatches.
  - `p3-b0r-random/v1` (240 chunks, 38.4 s): 24,280 swept calls, 575,801 candidates of 7,628,226 logical pairs (0.0755); 24,268 merge sorts of 984,179 events, charge totals 14,317,013, no fallback. Shadow: 228,713 and 236,007 comparisons (314,777 `WorkLimit`, 4,335 `EventLimit`), zero mismatches.
  - These comparisons are also O11's check on the B0 and randomized events: each successful L2 run equals the counting insertion sort's permutation and its `work_units` increase equals that sort's comparison count.
- Full-size O11, `b0r_oracle_full_o11_charge_lemmas`, release profile, inside the run above, 16 fixed seeded shards, 446.7 s:
  - Lemma D: 10^6 sequences (86,645,605 elements, 166,065-167,086 per family), zero permutation, charge-count or stability mismatches.
  - Lemma C: 10^6 bulk-charge cases, zero mismatches.
  - Corollary C1 and Lemma D through the real loops on 640 scenes, each swept exhaustively: every budget from the start to one past each loop's charge total, so the scan fails at each of its iterations, and for L1 every crossing push's `EventLimit` (zero sampled sweeps). 124,025 `collect_events` runs (105,899 `WorkLimit`, 16,206 `EventLimit`) and 859,449 `sort_events` runs (857,529 `WorkLimit`; 91,368 with an injected invalid event), zero mismatches. The scene count is 640 because an exhaustive sweep costs time quadratic in the charge total (L2 totals reach tens of thousands of comparisons); per-scene coverage is not reduced.
  - The U1-U5 full oracles in the same run passed; the U4 O10 oracle gave 33,867,937 (B0) and 254,065,579 (randomized) shadow checks, zero mismatches (the counts now include the L1 and L2 comparisons).
- O8, in `pnpm test:geometry`:
  - (11) Corollary C1 with one outer charge too few: `rounded_line_fill_loop_tests::b0r_o8_c1_outer_charge_short_is_detected`; the O11 loop differential finds 1,209 mismatching runs and O10 shadow mode 270 on the first 40 fixture rows.
  - (12) Lemma D without the prefix-minimum correction m: `b0r_o8_lemma_d_without_minimum_is_detected`; the O11 sequence differential finds 394 charge-count mismatches in 1,000 sequences and O10 shadow mode 12 on the first 40 fixture rows.
  - (13) L1 with its candidates in sorted-by-x order: `b0r_o8_l1_sorted_by_x_is_detected`; the O11 loop differential finds 360 mismatching runs and O10 shadow mode 20 on six random scenes.
  - Defect (14) belongs to U7. U1-U5's tests still detect (1)-(10).
- `pnpm test:geometry`: PASS, 7 min 55 s. Kernel fmt and clippy are clean. Native `cargo test`: 313 passed (304 before, 9 new), 33 ignored (31 before, 2 new). Geometry vitest: 733 passed, 6 skipped. The independent-build WASM SHA-256 is `2467c87c…47f7`, equal to the identity tool's branch build. The 9 new smoke tests take about 4.5 s wall time in the debug profile when run alone.
- `pnpm test:p2-identity`: PASS, 10,048 batches with identical P2 output bytes (SHA-256 `876f4a49…0e046f`).
- `pnpm check`: PASS (65 unit files, 728 tests; dependency boundaries PASS). `pnpm build`: PASS. `git diff --check`: clean. Prettier check of the changed documents and the tool (with an empty ignore file): clean.
- A10 `p3_b0_diag` clippy (`RUSTFLAGS="--cfg p3_b0_diag"`, `CARGO_TARGET_DIR=.tools/geometry-build-p3-b0-diag`, `--all-targets -D warnings`, `CARGO_ENCODED_RUSTFLAGS` unset): PASS.
- A9: `git diff --exit-code main` on the Cargo files, `pnpm-lock.yaml`, every `package.json` and `packages/contracts` exits 0. No cap, limit or `fill_v0_*` export changes. The crate stays std-only with no `unsafe`.
- A13: `git diff main` removes no line of `rounded_line_fill.rs` (785 added, 0 removed), so no unrestructured function loses a `charge()`, loop header, `break` or `continue`. The restructured paths charge only through `bulk_charge` and `bulk_charge_pairs`; O10 and O11 pass and O4 shows equal `work_units` for every case.

Interpretations recorded for review:

- **Edge cap.** `RoundedFillWorkspace` accepts any `max_edges`, so n can exceed 64 in a workspace built with larger limits. The contract's size guard handles it: L1 applies only to at most 64 edges and L2 to at most 256 events, and otherwise the current loops run. `LIMITS` and `FILL_V0_LIMITS` (64 edges, 128 events, `max_pairs` 2,016) always meet the guard.
- **Fallback loops kept in place.** The size-guard and comparator-error paths are the pre-U6 loops, unchanged and still charging per iteration, so the diff removes no line. A13's "restructured loops charge only through `bulk_charge` or the Lemma D count" is read as applying to the L1 and L2 paths themselves.
- **Order of L2's charge and permutation.** The contract applies the permutation when `work_units + C ≤ max_work` and then adds C. U6 charges C first by Lemma C and applies the permutation only on success; the outcomes are the same.
- **Comparator-error detection.** The running-minimum pass alone compares every element at least once for n ≥ 2, which the fallback argument needs; the merge passes also stop at the first error. A smoke test checks the property for every n ≤ 64 and every erroring position.
- **O10 comparison scope.** After an L2 `WorkLimit`, `events` is scratch (P3.2e:140) and is not compared; in every other case, including L1 failures and the comparator-error fallback, the events are compared bit for bit. The loop variants use budgets at the start, one unit later, the middle, around the reference's final count and three pseudo-random points, and for an L1 call with crossings the event limits failing at the first, a middle and the last crossing push.
- **Corollary C1 with charging bodies.** L1's bodies do not charge, so O11 exercises C1 through L1 at every failing budget and every `EventLimit` point; bodies with their own charges (`lookup_section_node` inside L3) come with U7.
- **Diagnostic counts.** In a `p3_b0_diag` run, `segment_relation` and `compare_event_x` are now called for fewer pairs and comparisons; the diagnostic counters count top-level calls, as section 3.1 says.

The durations above are not a benchmark; only U8's committed remeasure carries performance evidence.

### B0R U7 implementation

Unit U7 of the [B0R contract](p3-b0r-kernel-performance-contract.md#10-implementation-units): the loop restructurings L3 (the four column-by-edge scans) and L4 (`lookup_section_node`) of section 5.4, with Lemma C and Corollary C1, the `cfg(test)` reference copies and the oracles O10 and O11. Acceptance: A1, A3-A10 and A13, and A8 for defect (14) and for defect (11) applied to L3. Functional evidence only; no performance claim.

Landed:

- `packages/geometry-wasm/kernel/src/rounded_line_fill.rs`:
  - L3: with at most 64 edges, each of `build_sections_and_nodes`, `build_cells` and `build_ledger` builds an `EdgeColumnSweep`: the edge indices insertion-sorted by `low_column` and by `high_column` into two `[u8; 64]` stack arrays, and a vertical-edge mask. Visiting the columns (or slabs) in ascending order, it adds the edges with `low <= upto` and removes those with `high < from`, so the `u64` set is {low ≤ upto and high ≥ from}, in O(columns + edges) per phase after the sorts. The section scan uses the column set (`low <= c <= high`, which for a vertical edge means `low == c`), the active-edge scan the slab set (`low <= s < high`), and `build_column_span`'s winding and vertical scans the column set's nonvertical and vertical parts. Each set holds exactly the edges whose current body does more than test and continue.
  - Corollary C1, `sparse_charged_scan`: before the unchanged body of the active edge k, one Lemma C `bulk_charge` applies the outer charges of iterations `consumed..=k`; after the last active edge, the remaining `n - consumed`. The bodies (`column_section_body`, `slab_active_body`, `span_winding_body`, `span_vertical_body`) are the current loop bodies after their charge, tests included. They charge internally through `lookup_section_node` and may fail (`SectionLimit`, `ContributorLimit`, `InternalInvariant`), and each runs at the same `work_units`, in ascending edge order, with the same state.
  - Size guard: with more than 64 edges the current loops run. They stay in place; their headers now iterate `0..fallback_edges`, which is zero after a swept scan and `edges.len()` otherwise. `build_column_span` takes the column's sets as a new `Option` parameter.
  - L4: `lookup_section_node` scans its column's range without charging, then charges q + 1 units for a match at offset q, or `range.count` units followed by `InternalInvariant` without one, by one `bulk_charge` each. L4 has no size guard.
  - The derivations of the incremental sets, Corollary C1 and L4 are code comments.
  - `cfg(test)` only: verbatim copies of the pre-U7 scans and of `lookup_section_node`. The two `build_column_span` copies call the reference lookup. Also: the O10 shadow comparison `b0r_shadow_scan`, scan variants (`with_scan_variants`, sampled or exhaustive), per-thread scan counts and tallies, and test access.
  - The diff removes 6 lines and changes no unrestructured function: four scan loop headers, the per-candidate `charge()` of the old L4 loop and the `build_column_span` call in `build_ledger`. No workspace field, retained buffer, cap, limit or export changes, and nothing is allocated.
- `packages/geometry-wasm/kernel/src/fill_filter.rs`: two O8 fault variants, `L3OuterChargeShort` (defect (11) applied to L3) and `L4ChargeShort` (14). No `FilterId` is added, so every filter count keeps its value.
- New test file `rounded_line_fill_scan_tests.rs`, declared in `lib.rs` (9 tests, 2 ignored):
  - O10 smoke: the 202 `p3-rounded-fill-v1` rows and 12 seeded random scenes, tessellated with shadow mode off and on with sampled scan variants. Results, every counter and the published output are equal, and there are zero scan mismatches.
  - O11 smoke: 4 small scenes with exhaustive scan variants, plus L4 on 2,000 synthetic section ranges (lengths 0-12, repeated edges and endpoints) for every record key and absent keys, at every budget from a random start to one past the charge total.
  - The size guard: a 64-edge ring builds three sweeps and runs sparse scans; a 65-edge ring builds none.
  - O8 tests for defects (11) on L3 and (14).
- `tooling/compare-p3-fill-identity.mjs`: `EXPECTED_ORACLES` gains the two U7 oracles.
- A dated pointer line under the status line of [P3.2e](p3-rounded-fill-mesh-contract.md), for the section 6.2 row that U7 touches (`:138`).

Local evidence, 2026-10-13, Windows 11, AMD Ryzen 7 3700X, 16 logical cores, pinned Rust 1.94.1, Node 24.15.0, uncommitted working tree on branch `claude/p3-b0r-u7-scan-loops` over `main` `355b502`:

- `pnpm test:p3-fill-identity`: **PASS**, run `20261013T140230Z-0fd7a009`, about 31 min 30 s wall time.
  - Native: 66,351 cases on each side (6,350 B0, 60,000 randomized, 1 workspace size), all digests equal.
  - WASM: 3,969 cases, all equal between the two WASMs and equal to the native cascade digests.
  - Allocations: zero allocating cases (O7).
  - Corpora: SHA-256 B0 `206cf6e9…9796` and `p3-b0r-random/v1` `a1902d0f…ca9d`, both equal to the pinned values. Coverage floors are met with the same counts as U0's (5,135 `ok`, 3,376 `KnotMismatch`, 2,426 `Unresolved`, 1,665 cap failures, 248 `ok` with crossings). Both tamper self-checks were detected.
  - O5: the modified kernel sources are `fill_filter.rs`, `lib.rs` and `rounded_line_fill.rs`; their inline test modules are byte-identical to the merge base. No existing test file changed. The new test file was untracked at run time, so the tool's added-file listing is empty.
  - Overlay: not needed (the harness is unchanged).
  - Release WASM SHA-256: base `2467c87c…47f7`, branch `76fad318…e6d5`. The change is expected (section 2, operation identity); `fill_v0_revision()` stays 1.
  - Durations: release test builds 74.3 s (base) and 71.7 s (branch); release WASM builds 6.4 s and 6.4 s; native dumps 3.2 s (base) and 2.9 s (branch) on 16 threads; release oracles 1,714.7 s (16 passed); WASM layer 6.1 s.
- Full-size O10 for L3 and L4, `b0r_oracle_full_o10_scan_loops`, release profile, inside the run above, through every `CubicFillWorkspace` entry and the V2 cascade:
  - B0 corpus (66 chunks, 14.2 s). Shadow off: 7,155 sweeps; 368,835 sparse scans with 766,040 active members of 18,014,330 logical iterations (fraction 0.0425); 668,330 lookups charging 1,401,279 units. Shadow mode with sampled variants: 91,710 section, 89,325 active-edge, 93,900 winding, 93,900 vertical and 366,420 lookup calls compared, 5,672,389 runs (3,197,464 ending in `WorkLimit`, 269,160 in a push limit), zero mismatches.
  - `p3-b0r-random/v1` (240 chunks, 37.9 s). Shadow off: 72,044 sweeps; 2,440,828 scans with 6,950,151 members of 83,006,753 iterations (0.0837); 6,162,644 lookups charging 19,380,146 units. Shadow: 467,814, 430,788, 771,113, 771,113 and 2,245,544 calls, 36,434,092 runs (21,004,552 `WorkLimit`, 1,370,424 push limit), zero mismatches.
- Full-size O11, `b0r_oracle_full_o11_scan_loops`, release profile, inside the run above, 16 fixed seeded shards, 93.8 s:
  - Corollary C1 with charging bodies and Lemma C through L3 and L4: 8,000 seeded scenes (6,152 `ok`), at most 63 edges each, every one tessellated with exhaustive variants. Every L3 and L4 call is rerun at every budget from its start to one past its charge total, so each scan fails at each of its iterations and at each charge inside an active body. It is also rerun at every `SectionLimit` or `ContributorLimit` push point. Zero sampled calls (3,228,324 exhaustive). Calls: 177,033 section, 119,895 active-edge, 714,583 winding, 714,583 vertical and 1,502,230 lookup. Runs: 124,170,799 (112,744,802 `WorkLimit`, 1,741,025 push limit). Zero mismatches.
  - L4 on 10^6 synthetic ranges (lengths 0-24): 262,304,812 runs (162,873,377 matches, 4,916,148 without a match, 94,515,287 `WorkLimit`), zero mismatches.
  - The U1-U6 full oracles in the same run passed. The U4 O10 oracle gave 34,603,192 (B0) and 258,751,951 (randomized) shadow checks, zero mismatches (the counts now include the L3 and L4 comparisons).
- O8, in `pnpm test:geometry`:
  - (11) on L3, Corollary C1 with charging bodies and one outer charge too few per active member: `rounded_line_fill_scan_tests::b0r_o8_l3_outer_charge_short_is_detected`. O10 shadow mode finds 3,648 mismatching runs on the first 40 fixture rows, and the exhaustive O11 differential finds 1,038 on two scenes.
  - (14) L4 charging q instead of q + 1: `b0r_o8_l4_charge_short_is_detected`. The O11 lookup differential finds 10,437 mismatching runs in 200 ranges, and O10 shadow mode finds 4,122 on the first 40 fixture rows.
  - U1-U6's tests still detect (1)-(13).
- `pnpm test:geometry`: PASS, 8 min 0 s. Kernel fmt and clippy are clean. Native `cargo test`: 320 passed (313 before, 7 new), 35 ignored (33 before, 2 new). Geometry vitest: 733 passed, 6 skipped. The independent-build WASM SHA-256 is `76fad318…e6d5`, equal to the identity tool's branch build. The 7 new smoke tests take about 4.4 s wall time in the debug profile when run alone.
- `pnpm test:p2-identity`: PASS, 10,048 batches with identical P2 output bytes (SHA-256 `876f4a49…0e046f`).
- `pnpm check`: PASS (65 unit files, 728 tests; dependency boundaries PASS). `pnpm build`: PASS. `git diff --check`: clean. Prettier check of the changed documents and the tool (with an empty ignore file): clean.
- A10 `p3_b0_diag` clippy (`RUSTFLAGS="--cfg p3_b0_diag"`, `CARGO_TARGET_DIR=.tools/geometry-build-p3-b0-diag`, `--all-targets -D warnings`, `CARGO_ENCODED_RUSTFLAGS` unset): PASS.
- A9: `git diff --exit-code main` on the Cargo files, `pnpm-lock.yaml`, every `package.json` and `packages/contracts` exits 0. No cap, limit or `fill_v0_*` export changes. The crate stays std-only with no `unsafe`.
- A13: `git diff main` on `rounded_line_fill.rs` adds 1,070 lines and removes 6. All six are in the restructured loops (the four scan headers and the old L4 charge) or are the `build_column_span` call that passes the sets. No unrestructured function of section 5.1 loses or moves a `charge()`, loop header, `break` or `continue`. The swept L3 path and L4 charge only through `bulk_charge`. O10 and O11 pass, and O4 shows equal `work_units` for every case.

Interpretations recorded for review:

- **Superset-safe bodies.** The swept bodies keep the current loops' membership tests. The sets equal the effective sets for validated state: a nonvertical edge has `low < high`, so `low <= c <= high` equals "active left or right", and a vertical edge has `low == high`. A stray member would therefore only test and continue, as Corollary C1 allows.
- **Fallback loops kept in place.** As in U6, the size-guard path is the pre-U7 loops, unchanged except for their range variable. A13's "charge only through `bulk_charge`" is read as applying to the L3 and L4 paths themselves. L4 has no size guard, so its old loop survives only as the `cfg(test)` reference copy.
- **L4 bounds.** The uncharged scan reads the column's whole range before charging. The current loop may stop at `WorkLimit` before reading the later records. Both read only `sections[range]`, which `build_sections_and_nodes` recorded from its pushes, so no in-bounds difference and no panic can arise.
- **O10 granularity and state.** Shadowing is per scan call, not per tessellation phase. Cloning the workspace for each of the millions of calls would be far too slow. Instead, a snapshot holds the counters, the limits and the lengths of the three buffers a scan pushes into (`sections`, `active`, `contributors`). The reference runs first and is restored by truncation, then the restructured scan runs. The capture compares the result (with the windings, vertical delta or node), every counter, the lengths of all 16 buffers and the pushed records (active entries including their sections). Lookups nested in a shadowed winding or vertical scan run unshadowed; the enclosing comparison covers them through the reference copy's reference lookups.
- **O11 scope.** "Every budget that makes the scan fail at each iteration and inside an active body" is realized per call. Each call is rerun at every budget from its start to one past its charge total, which includes every charge inside its bodies' lookups. The scene count is not reduced: per-call reruns are short, so 8,000 scenes take about 94 s. The real-pipeline secondary counter has no L3 or L4 analogue (`pair_checks` is L1's).
- **Defect (11) for L3.** The contract lists (11) generically; U6 seeded it in L1, whose bodies do not charge. U7 adds a separate fault that seeds it in L3, so Corollary C1 with charging bodies has its own seeded defect. U6's fault and tests are unchanged.
- **Errors inside L3 bodies.** No real-pipeline O10 or O11 run produced an `InternalInvariant` or other non-limit error inside an L3 body (`other_errors: 0`), because such errors are unreachable on validated state. Failure-point equivalence for that error class rests on Corollary C1: the body runs at the same `work_units` and state in both versions. Only L4's no-match `InternalInvariant` is exercised, by the synthetic differential.
- **Diagnostic counts.** L3 and L4 call no diagnostic routine, so `p3_b0_diag` counts are unaffected.

The durations above are not a benchmark; only U8's committed remeasure carries performance evidence.

### B0R U8 remeasure

Unit U8 of the [B0R contract](p3-b0r-kernel-performance-contract.md#8-remeasure-plan): the record-comparison tooling `tooling/compare-p3-b0-records.mjs` (`pnpm compare:p3-b0-records --old <old.json> --new <new.json> [--markdown <out.md>]`) exists. It implements the section 8 item 4 identity cross-check and the item 6 comparison tables, and `tests/unit/p3-b0-record-comparison.test.ts` covers it.

**Functional check (section 8 item 2).** `pnpm benchmark:p3-b0 --profile functional --environment-json <observations.json>` on `main` `0b48163` (the run record marks the tree dirty only for the untracked `.claude/launch.json`), run `20261013T150441Z-c0a1a0a2` (2026-10-13T15:04Z, 1 min 7 s): one repetition complete, verdict NONE as the functional profile gives. It is not evidence.

**Reference run.** Run `20261017T150336Z-23973138` on the reference machine (DESKTOP-DKVUSAV), `main` `0b48163` (U7 merged through PR #145) from a clean worktree: `pnpm benchmark:p3-b0 --profile reference --environment-json <observations>`. It started at 2026-10-17T15:03:36Z and the record spans 2 min 29 s (`utcStart` to `utcEnd`; the shell timed the whole command at 2 min 31 s). The untracked, machine-local `.claude/launch.json` was moved out of the worktree for the run, because the runner requires a clean worktree, and restored afterwards. The provenance protocol is the 2026-10-12 one: power observed before the run (AC, Balanced plan); the operator's readiness reply "시작해" in chat; a Primary process listing at 15:03:09Z with no node, cargo, rustc or build process; no CPU-load sampling, per the user's standing instruction. Configuration hash `a10c98e9…9271` and corpus SHA-256 `206cf6e9…9796` equal section 8 item 3's.

Result: [record](../benchmarks/results/2026-10-17_p3_p3-b0-feasibility-v1_native_desktop-dkvusav_20261017T150336Z-23973138.md) with its raw `.json`, a byte-for-byte copy of the runner's `record.json`; `validateRecord` accepts it. The [2026-10-12 record](../benchmarks/results/2026-10-12_p3_p3-b0-feasibility-v1_native_desktop-dkvusav_20261012T144359Z-65a7b05f.md) is unchanged.

- **Identity cross-check (section 8 item 4): PASS.** `node tooling/compare-p3-b0-records.mjs --old <2026-10-12 .json> --new <2026-10-17 .json> --markdown <scratch>` reports zero differences and exits 0. It compares the scenario, configuration hash, runner, corpus SHA-256 and their pinned values; the first admission hash (`2ea479cdae7a` in both); per repetition every admission cell with its topology mix and allocation counts, every cell's batch checksums and the linearity checksums; and the O1 and O2 tables.
- **Verdict, as the runner computes it: INCONCLUSIVE.** Check 2 (prediction factor) fails with a maximum of 3.248 against the limit 2. The other checks pass, including 5b. The B0 verdict scope applies: simple, disjoint, snapped contours at zoom 1 only, provisional on native measurement until B0-W.
- **Comparison with the 2026-10-12 record (section 8 item 6),** all from the two committed records through the tool, ratios old/new:
  - T̂ 3,920,405 ms to 41,419.3 ms (94.7); t̂_edit 4,503.5 ms to 122.048 ms (36.9); M̂ 15.41 MiB, unchanged.
  - Per-cell per-path medians: 7.7 times faster at P2/s=3, rising with L to 53.8-57.5 times at the 64-leaf cells.
  - Fitted median slopes: from 1.84-1.95 to 0.82-1.14.
  - Stage split at the largest cells: topology 44.7-78.2 times faster, tessellation 10.6-14.1 times; the topology share falls from 91-94% to 71-72%.
  - H1: exact share about 0.13, Not supported. After B0R it measures the residual exact share (section 3.1) and is not comparable with the first record's 0.87.
- **Why check 2 failed.** The factor is exp(t · s_e · √(1 + 1/n + (x\* − x̄)²/S_xx)). The design is the same in both records, so it changes only through the residual standard error s_e. For P8 (6 points, L = 24-64, L\* = 256) it is exp(5.264 s_e), so the limit 2 needs s_e ≤ 0.132. Two of the 30 primary fits exceed 2, both P8 p95 fits of individually timed paths: repetition 4 (3.248, s_e 0.224) and repetition 0 (3.215, s_e 0.222). Every median fit passes, at most 1.742. In repetition 4 the P8/s=7 (L = 56) p95, 3.602 ms, lies 1.48 times above the P8/s=8 p95; 34 of that cell's 200 individual samples exceed 1.25 times its median. In repetition 0, P8/s=4 (L = 32) has 17 such samples and its p95 is 2.071 ms, against 1.160-1.294 ms in the other repetitions. The per-path times are now 22-54 times smaller than in the first record (whose P8 p95 fits had s_e 0.010-0.024), so delays of a given absolute size weigh correspondingly more in the log-log fit. The record does not identify their source.
- **Context, not a verdict.** The estimates exceed the budgets: T̂ about 41 times B_init and t̂_edit about 31 times B_edit; M̂ is within B_mem. The runner's INCONCLUSIVE verdict stands.

Independent evidence review (`reviewer`, section 8 item 7, A12): ACCEPTED with no blocking items, before the merge of PR #146. It recomputed every cited number from the two committed records with `analyze()`, confirmed the committed `.json` is byte-identical to the runner output and that the source manifest matches `0b48163`, and confirmed the check-2 analysis. Its should-fix (the slope-range wording) and minor items (the functional run's dirty marker, a rounding mismatch, the duration source, a batch range) were applied before the merge.

Superseded by the review above and the 2026-10-18 decision below: Next: the independent evidence review of the record (section 8 item 7, A12). Then, under user decision B0-Q3, the INCONCLUSIVE verdict goes to the user as an architecture decision before B1, as INFEASIBLE would (section 8 item 8). B0R chooses no further remedy.

**User decision, 2026-10-18, in chat (B0-Q3).** Shown four directions (a float plus robust-predicate tessellator for interactive paths with the exact kernel kept for validation and final output; a requirement change by progressive initial build, incremental rebuild of the edited path or a budget change; B0R2, a second kernel round, judged unlikely to close 41×; a rerun only), the user chose "대안 비교 제안서 먼저": an alternatives-comparison proposal before choosing a direction. No direction is chosen. The proposal is the [B0 direction proposal](p3-b0-direction-proposal.md), PROPOSAL, awaiting independent review and the user's decision. Requirements, the 0.25 px target, the B0 budgets, the B0 and B0R contracts and both records are unchanged, and B1 stays blocked.

**User decisions, 2026-10-18, in chat (B0 direction proposal).** After the proposal's independent review returned READY, the user chose the recommended option of each question: B0D-Q1 (a), Alt-E1, the Alt-A1 fallback ladder gated by a test-only spike, the D8 checkpoint B1 blocked until the spike's verdict; B0D-Q2 (a), budgets unchanged; B0D-Q3 (a), the exact clearance condition on the fast rung, subject to proof and independent review in the spike contract; B0D-Q4 (a), no rerun, the verdict stays INCONCLUSIVE; B0D-Q5 (a), workers deferred; B0D-Q6 (a), simple contours only, crossings take the exact rung. This authorizes only the spike contract; the spike and its run wait for that contract's review and the user's approval.

### B0 spike SL-U1 implementation

Unit SL-U1 of the [B0 spike contract](p3-b0-spike-ladder-contract.md#71-units): the fast rung, the ladder, the `cfg(test)` S1 accessor, fixtures SL-F1 to SL-F21 with their literal expectations and the ten seeded defects of section 4.8. Acceptance: SL-A1, SL-A2, SL-A4, SL-A5 (Rust side), SL-A7 (the U1 test) and SL-A9. Functional evidence only; no performance claim.

Landed:

- New test-only module `packages/geometry-wasm/kernel/src/p3_b0_spike.rs`:
  - `SpikeLadder` (section 2.1): rung 0 on the S1 view; on its first unproved check, the cell's unchanged exact entry (`attempt` or `attempt_transverse`) on the same input, which re-runs its own prefix. `LadderOutcome` keeps the rung, the reason and, on fallback, the exact result.
  - `FastRung` with inline fixed storage at the S1 caps (68 points, 64 edges, 4 contours, 16 sources, 128 triangles, 128 diagonals) and stages FR1-FR8 in order, each stoppable for the section 5.8 stops. Fallback reasons follow section 2.6 in stage order, and within a stage in edge or sweep order.
  - FR1 (SL-C0, sections 3.3 and 3.6): each edge's source piece from its owner and the decoded sources; `STRUCTURE` for a closed polygon over an open source; the degenerate-source close is recorded and contracted into P′ (e′ = [p, m] with γ_e′ = γ_e); at least three edges after contraction.
  - FR2 (SL-C1, SL-L1): interval de Casteljau restriction following the high-to-low bits of n − 1 as P3.2g's `restrict_cell` does, d_0 to d_3 (d_0, d_1 for segments) and |d_m|² proved below δ² with `compare_enclosures`.
  - FR3 (SL-M1 to SL-M4, SL-L5): |k − m|² < δ², σ = orient2d(p, k, m) with the σ = 0 dot test, and the exact cone tests at m and p (for σ = 0, the collinear tests on [p, m]).
  - FR4 (SL-C2, SL-L2) over the consecutive pairs of P′ in contour order, then the cyclic pair; FR5 (SL-C3, SL-L3, SL-L4, section 3.9) with the xlo sweep and the `next_up(fl(xhi(a) + r))` scan bound, a `[u64; 64]` mark bitset, the box gap, `segment_relation` and the three point-segment tests.
  - FR6: orientation at the lexicographically smallest vertex, exact half-open ray nesting, w_out and w_in, boundary contours and traversal direction. FR7: de Berg's monotone decomposition with a linear status array, face tracing over boundary edges and diagonals, and stack triangulation, each triangle checked by exact `orient2d`. FR8 publication.
  - A `cfg(test)` thread-local `SpikeFault` switch for the ten seeded defects, in the `fill_filter.rs` pattern; defect (1) combines it with the existing `Fault::R1WideningRemoved`. `fill_filter.rs` is unchanged.
  - Code comments cite the condition or lemma behind each check; a module table maps the stages to SL-C0-C4, SL-M1-M4 and SL-L1-L5.
- `cubic_fill.rs`: one `#[cfg(test)] impl CubicFillWorkspace` block appended at the end of the file with `prepare_for_spike`, the statements of `attempt_body` up to S1 in the same order. It returns borrowed views or `PrefixFailure` (`Sizing(status)` or `Error`). No other line changes.
- `lib.rs`: two `#[cfg(test)]` module declarations appended at the end of the file.
- New test file `p3_b0_spike_tests.rs` (19 tests, 3 ignored): the fixtures, the defects, SL-F13, the S1 accessor tests, a ladder fallback test, the corpus tests and `emit_spike_fixtures`.

Local evidence, 2026-10-18, Windows 11, pinned Rust 1.94.1, Node 24.15.0, uncommitted working tree on branch `claude/p3-b0-spike-u1-fast-rung` over `main` `3c139e4`:

- Fixtures (SL-A4), `p3_b0_spike_tests::spike_fixtures_match_their_literal_expectations`, 26 synthetic entries, all at their literal expectation: SL-F1 `CLEARANCE`; SL-F2 `CROSSING`; SL-F3 `CLEARANCE`; SL-F4 fast, area 2, 4 triangles; SL-F5 fast, area 100 under both rules; SL-F6 fast, nonzero area 100 with only the outer contour a boundary contour, evenodd area 84 (8 triangles); SL-F7 fast, area 84 under both rules; SL-F8 F05 and F07 `CROSSING`; SL-F9 and SL-F10 `MONOTONE`; SL-F11 `DEVIATION`; SL-F12 (a) fast through SL-L5, area 1 − 2^-31, 3 triangles, (b) `CLOSURE`; SL-F14 and SL-F15 `STRUCTURE`; SL-F16 and SL-F17 fast, area 16; SL-F18 `CLEARANCE`; SL-F19 `DEVIATION`; SL-F20 `CLOSURE`; SL-F21 (a) FR3 passes on the stage result, (b) `CLOSURE`. The same test also runs SL-F10b, a supplementary fixture beyond section 4.8 (review item S1, below), at `MONOTONE`. SL-F13, `sl_f13_b0_fixture_paths_take_the_fast_rung`: P4/s=4 path 0 and K2/s=3 path 0 take the fast rung through the full ladder (14 and 20 triangles). Each fast outcome passes the three Rust-side checks of section 4.8 and the directed-edge cancellation aid. The TypeScript SL-O1, SL-O2 and SL-O3 steps are SL-U2's.
- Seeded defects (SL-A5, Rust side), each failing its named fixture:
  - (1) ≥ with `R1WideningRemoved`: `sl_defect_01_clearance_ge_without_r1_widening_is_detected`, SL-F3 becomes fast.
  - (2) knot errors omitted: `sl_defect_02_knot_errors_omitted_is_detected`, SL-F11 and SL-F19 become fast.
  - (3) chords only: `sl_defect_03_monotone_chords_only_is_detected`, SL-F10 becomes `CLEARANCE` (its left and right edges are exactly 1/4 apart), and the supplementary SL-F10b becomes fast with area 9/8 in three triangles.
  - (4) simplicity only: `sl_defect_04_simplicity_only_is_detected`, SL-F1, SL-F3 and SL-F18 become fast.
  - (5) cone inverted: `sl_defect_05_cone_inverted_is_detected`, SL-F12 (a) becomes `CLOSURE`.
  - (6) nesting from orientation: `sl_defect_06_nesting_from_orientation_is_detected`, SL-F6 nonzero signed area 116.
  - (7) flipped triangle: `sl_defect_07_flipped_triangle_is_detected`, SL-F5 triangle 0 not positive.
  - (8) non-boundary contour triangulated: `sl_defect_08_non_boundary_triangulated_is_detected`, SL-F6 nonzero signed area 116.
  - (9) scan bound xhi(a): `sl_defect_09_scan_bound_without_radius_is_detected`, SL-F3 becomes fast.
  - (10) skip two apart: `sl_defect_10_skip_two_apart_is_detected`, SL-F18 becomes fast.
- Corpus commands for the two release corpus tests below, from the repository root in Git Bash:
  - Environment: `CARGO_HOME=.tools/rust/cargo`, `RUSTUP_HOME=.tools/rust/rustup`, `CARGO_TARGET_DIR=.tools/geometry-build-spike-rel`, pinned toolchain through `.tools/rust/cargo/bin/rustup.exe run 1.94.1 cargo …`.
  - Corpus: a scratch Node script imports `tests/geometry/p3-b0/corpus.ts` and writes `encodeCorpus(corpusCells())` to a file (580,965 bytes); `sha256sum` of that file gives `206cf6e9971d5f38f11cbef801692555843b1602ee937c5e1b60ed7dbd329796`, the pinned value. `P3_B0R_B0_CORPUS` is set to its path.
  - Invocation: `cargo test --manifest-path packages/geometry-wasm/kernel/Cargo.toml --release --lib --locked --offline p3_b0_spike_tests::spike_corpus -- --ignored --nocapture --test-threads 1` (2 passed).
- S1 accessor (section 2.2): `s1_accessor_matches_published_output_on_small_paths` (debug, 6 published paths) and, in the release profile over the B0 corpus, `spike_corpus_s1_accessor_matches_published_output`: 453 published paths equal bit for bit, and on the other 817 the accessor succeeds or fails exactly as the attempt's prefix did.
- SL-A7, `spike_corpus_ladder_is_allocation_free`, release profile, the corpus regenerated by `encodeCorpus` (SHA-256 `206cf6e9…9796`) and passed in `P3_B0R_B0_CORPUS`: 1,270 ladder calls, zero allocating calls, with the counter on only around each `SpikeLadder::run`. Outside that window (review item S4) every fast mesh, 1,121, passes the Rust mesh checks against its S1 polygon from a separate prefix run: positive orientation, shoelace area to a relative 1e-12, the vertex set and the directed-edge cancellation, with every contour expected to be a boundary contour (B0 rings are disjoint and not nested). Zero failures. This is an early warning, not SL-O2.
- Fast-rung admission on the B0 corpus, an observation with no expected value (section 5.7) and no speed claim: every decision path (430) takes the fast rung. O1 (780 paths): 691 fast, 73 `CLOSURE` (0-10 per cell) and 16 `PREFIX` (8 each in O1/P4/s=16 and O1/P8/s=8, prefix failures that the exact rung reproduces); the exact rung published none of the O1 fallbacks. X (60 paths): all `CROSSING`, as section 4.7 expects. SL-O1 has not yet checked any of these admissions; that is the oracle run of SL-U2 and SL-U3.
- `pnpm test:geometry`: PASS after the review fixes, 9 min 37 s. Kernel fmt and clippy are clean. Native `cargo test`: 336 passed (320 before, 16 new), 38 ignored (35 before, 3 new). Geometry vitest: 733 passed, 6 skipped. The 16 new debug tests take about 0.05 s. Independent-build WASM SHA-256 `76fad318…e6d5`.
- SL-A1, release WASM: the merge base's, built from `git archive main` (`3c139e4`) with the same `cargo build --release --target wasm32-unknown-unknown` and path remap, has SHA-256 `76fad318f5b20cb6ed0b8a1f7699b5825c9f3d027461567cb203242702c4e6d5`; this branch's, built by `pnpm test:geometry`, has the same hash, and so do both builds of the identity tool. Hashing command: `sha256sum .tools/geometry-build-spike-mainwasm/wasm32-unknown-unknown/release/vector_studio_geometry_kernel.wasm .tools/geometry-build/wasm32-unknown-unknown/release/vector_studio_geometry_kernel.wasm` (merge base, then branch), both `76fad318…e6d5`. The merge-base build ran in the scratch copy with `CARGO_ENCODED_RUSTFLAGS` set to `--remap-path-prefix` and `<scratch copy>=.`, as `pnpm test:geometry` remaps the repository root.
- SL-A1, `pnpm test:p3-fill-identity`: PASS, run `20261018T082035Z-fe5f26f7`, 30 min 43 s. Native 66,351 cases (6,350 B0, 60,000 randomized), all digests equal; WASM 3,969 cases, all equal, and equal to the native cascade digests; release WASM SHA-256 base and branch both `76fad318…e6d5`. O5: modified kernel sources `cubic_fill.rs` and `lib.rs`, no existing test file changed. Both tamper self-checks were detected; the 16 release oracles passed. It was not rerun after the review fixes, which changed only `p3_b0_spike_tests.rs` (a new test file that no release or WASM build compiles) and this plan.
- SL-A1, `pnpm test:p2-identity`: PASS, 10,048 batches with identical P2 output bytes (SHA-256 `876f4a49…0e046f`).
- SL-A2: `git diff --exit-code main -- packages/geometry-wasm/kernel/Cargo.toml packages/geometry-wasm/kernel/Cargo.lock pnpm-lock.yaml packages/contracts` exits 0. No `LIMITS`, `MAX_*`, `ABSOLUTE_MAX_*` or `fill_v0_*` change: the `main` diff of the two existing files adds 58 lines and removes none. The new module's capacity constants are its own, equal to the S1 caps. The crate stays std-only with no `unsafe`.
- `pnpm check`: PASS (66 unit files, 733 tests; dependency boundaries PASS). A first `pnpm check` run concurrently with the identity tool failed three unrelated unit tests at the 5 s vitest timeout under the CPU load; the rerun alone passed. `pnpm build`: PASS.
- `p3_b0_diag` clippy (`RUSTFLAGS="--cfg p3_b0_diag"`, `CARGO_TARGET_DIR=.tools/geometry-build-p3-b0-diag`, `--all-targets -D warnings`, `CARGO_ENCODED_RUSTFLAGS` unset): PASS.
- `git diff --check`: clean. Prettier check of this plan (with an empty ignore file): clean.

Interpretations recorded for review:

- **Placement of the accessor and module declarations.** The release WASM embeds source locations, so a method inserted inside the existing `impl` moved later panic locations and changed the WASM hash. The accessor is therefore its own `cfg(test)` impl block appended at the end of `cubic_fill.rs`, and the module declarations are appended at the end of `lib.rs`; the release WASM is then byte-identical to `main`'s.
- **FR1 consistency premise.** FR1 also checks section 3.3's consistency at every vertex (abutting dyadic intervals within one cubic, otherwise equal exact source points), returning `STRUCTURE`. S1 guarantees it; the check guards synthetic views.
- **SL-M1.** It equals SL-C0 on P′, which FR1 checks first, so its FR3 check is unreachable and a contour that fails it is `STRUCTURE`.
- **SL-M4 with σ = 0.** The dot sign that would let f or h enter [p, m] must be proved negative; an undecided sign falls back as `CLOSURE`.
- **Internal invariants.** A view larger than the S1 caps or with no polygon is `PREFIX`. An FR7 face that is not monotone, an equal pair of points, a touching status query or an angular tie is `TRIANGLE`; under SL-T1 none occurs.
- **FR8 vertex order.** A reversed contour lists its vertices in reverse array order.
- **Corpus tests.** The B0 corpus is not available inside `pnpm test:geometry`, so the corpus-wide S1 accessor test and SL-A7 are ignored release tests reading `P3_B0R_B0_CORPUS`; the debug suite runs the accessor test on six small paths and SL-F13. The independent review accepted this (item S2): both stay ignored release tests in SL-U1 and are wired into SL-U3's harness or `pnpm test:geometry` later.
- **`emit_spike_fixtures`.** Section 4.8 places the Rust side of the hand-off with the fixtures, so the ignored test is here. It prints one JSON block, schema `p3-b0-spike-fixtures/1`, between `P3_B0_SPIKE_FIXTURES_BEGIN` and `P3_B0_SPIKE_FIXTURES_END`: every fixture's view (bits as hex), expectation, stop, rung or reason and mesh, and for SL-F13 also the exact rung's published polygon and mesh. Its vitest consumer is SL-U2's.
- **SL-A1 hash.** `pnpm build` runs `tsc` only and builds no WASM. The release WASM is the one `pnpm test:geometry` builds (`cargo build --release --target wasm32-unknown-unknown` with the path remap); the merge base's was built the same way from `git archive main`.
- **SL-F10b (review item S1, beyond section 4.8).** SL-F10 detects defect (3) only through a changed reason, because its vertical edges are exactly 2δ apart. SL-F10b is a supplementary fixture, not one of section 4.8's: a 3-edge contour whose depth-0 cubic leaf (0, 0), (1/16, 1/16), (5/16, 1/32), (1/2, 0) starts backward for the cyclic pair (h, e), w = (1/4, −1/2): the chord dots are 3/16 and 1/8 but ⟨R1 − R0, w⟩ = −1/64. Every other dot of the three pairs is positive, |d_1|² = 34/2304 < δ² = 36/2304, and a unit square at [10, 11]² supplies cross-contour pairs, all more than 2δ apart (the triangle itself has no non-consecutive pair). Expected `MONOTONE`; under chords only, fast with area 9/8 in three triangles. Both outcomes were derived by hand before the run.
- **Positional difference on a contracted contour (for SL-U2 and SL-U4).** FR2 certifies δ̄(e′) < δ for the merged edge e′ = [p, m] of P′. The mesh triangulates P, whose real edges [p, k] and [k, m] differ from γ_e by up to δ̄(e′) + |k − m|, with |k − m| < δ by SL-M2 and in practice about one ulp. So "positional difference at most δ" (section 3.1, SL-O6's curve share) holds for P′, and for P only to within that extra |k − m|. SL-O6 reporting must say so.
- **SL-F13 area.** Its expected area is the S1 polygon's shoelace area, compared to a relative 10^-12, because the emitted knots are not few-bit dyadics; the exact area check is SL-O2's.

### B0 spike SL-U2 implementation

Unit SL-U2 of the [B0 spike contract](p3-b0-spike-ladder-contract.md#71-units): the independent TypeScript oracles SL-O1, SL-O2, the SL-O3 area band and SL-O5, with positive controls, over the `emit_spike_fixtures` hand-off of section 4.8. Acceptance: SL-A5 (the SL-U2 part), SL-A6 and SL-A9. Functional evidence only; no performance claim. SL-U1 merged through PR #149 (`754a8bd`).

Landed:

- New `tests/geometry/p3-b0-spike/oracle.ts`, test-only, using BigInt rationals (`tests/geometry/rounded-fill/exact.ts`) and no Rust code:
  - A strict parser of schema `p3-b0-spike-fixtures/1`: one frame, exact key sets, 16-digit finite hex bits, rung/reason/mesh consistency, and a fast entry must stop at FR8.
  - SL-O1 (section 4.1), `verifyCertificate`. It derives each edge's source piece from its owner and the decoded sources, checks that the leaves of each cubic source partition [0, 1] in order and that every source with a nonzero span is used once in order, classifies each contour's closure (exact close, non-degenerate close, degenerate-source close, closed polygon over an open source), checks the vertex consistency γ_e(1) = γ_f(0), requires an `ExplicitClose` verb to follow the contour's last source and precede the next contour's first, contracts each degenerate-source close by SL-L5 and checks SL-C0 on P′. Then, exactly: SL-C1 (max_m |d_m|² < δ²), SL-M1 to SL-M4, SL-C2's dot signs, and SL-C3 over every non-consecutive pair of P′ without the sweep (exact closed-segment intersection, then exact squared segment distance against (2δ)²). Restricted controls come from the cubic's blossom b(t_a, t_a, t_b) etc., not from the fast rung's bit-walking de Casteljau.
  - `judgeRung`: every condition of a stage the Rust rung passed must hold exactly (a fast entry: all of them, whatever its stop). A fallback gets two separate classifications: conservative in the sense of section 4.1 (every exact condition holds), and its reason as `exact` (the reason's condition fails exactly), `reason-not-exact` (it holds) or `no-condition` (`PREFIX` and `TRIANGLE`, which name no condition and are not conservative by default).
  - SL-O2 (section 4.2), `verifyRegionMesh`: exact simplicity and disjointness of P, orientations from exact shoelace areas, nesting from exact winding numbers, the boundary contours under the rule; then items 1-4 (positive triangles; vertex set; no directed edge twice and the cancelled chain equal to the oriented boundary of R(P); exact area) and `inspectTriangleMesh` of `packages/geometry-reference`, whose throw above its 256-vertex or 256-triangle cap is caught and reported as an issue. Each failure carries an item code (`simplicity`, `item1` to `item4`, `inspect`, `shape`), so tests assert the cause.
  - SL-O3 (section 4.3), `verifyAgreement`: the exact rung's published ranges, points, owners and sources equal the fast rung's S1 view, and |A(exact mesh) − A(R(P))| ≤ Σ_e (2τ (|Δx_e| + |Δy_e|) + 4τ²), exactly; also SL-O2 on the exact mesh, reported.
  - SL-O5 (section 4.5), `sliverStatistics`: Float64 quality ρ, smallest angle (each corner as atan2(|cross|, dot)) and smallest altitude, with min, nearest-rank p5 and median (B0's `nearestRank`), the counts with ρ < 0.1 and ρ < 0.01, and the raw per-triangle values (`perTriangle`) for SL-U3's per-cell and per-rung aggregation.
- New `tests/geometry/p3-b0-spike-oracle.test.ts` (9 tests), run by `pnpm test:geometry`: it runs `cargo test --release --lib p3_b0_spike_tests::emit_spike_fixtures -- --ignored --exact --nocapture` through `P2_NATIVE_RUSTUP` with the inherited Rust runner environment, as the P3.2g bridge `native-cubic-topology.test.ts` does, then applies the oracles.
- `p3_b0_spike_tests.rs` (test file, `cfg(test)` only): `emit_spike_fixtures` now builds each fixture entry with a factored `json_fixture` helper (output unchanged) and appends a top-level `defects` array: each seeded defect's named fixtures run under its fault switch, defect (1) together with `Fault::R1WideningRemoved`, as the U1 defect tests do. No other change. The SL-U1 entry's description of the `/1` hand-off above predates this `defects` array.

Local evidence, 2026-10-18, Windows 11, pinned Rust 1.94.1, Node 24.15.0, uncommitted working tree on branch `claude/p3-b0-spike-u2-oracles` over `main` `754a8bd`:

- Hand-off: 27 view entries (the 26 of section 4.8 and SL-F10b), 2 SL-F13 ladder entries and 14 defect entries, δ = 1/8 exactly.
- SL-O1 and SL-O2 on every fixture (`SL-O1 and SL-O2 accept every fixture outcome at its literal expectation`): every outcome matches its literal expectation, rechecked exactly (areas as exact rationals, boundary contours derived by SL-O2, triangle counts); every fast mesh passes SL-O2; no rung passes a condition that fails exactly; no named fallback is conservative, and every named fallback's reason is `exact` (its condition fails exactly). Exact failing conditions per fallback: SL-F1, SL-F3, SL-F18 SL-C3 clearance; SL-F2 SL-C3 relation and clearance; SL-F8 F05 and F07 SL-C3 relation; SL-F9 SL-C2 and SL-C3 relation; SL-F10 SL-C2 and SL-C3 clearance (its vertical edges are exactly 2δ apart); SL-F10b SL-C2; SL-F11 and SL-F19 SL-C1; SL-F12 (b) and SL-F21 (b) SL-C4; SL-F14 and SL-F15 SL-C0 (closed polygon over an open source; two edges); SL-F20 SL-C4, SL-C2 and SL-C3 clearance. SL-F12 (a) and SL-F21 (a) are degenerate-source closes that hold every condition; SL-F16 and SL-F17 are non-degenerate closes.
- SL-F13 (`SL-F13: both B0 paths ...`): P4/s=4 path 0 and K2/s=3 path 0 hold every condition exactly (104 and 252 non-consecutive pairs), exact max |d_m|² 0.00879262 and 0.00879861, each at most its certified bound and below δ² = 0.015625; both fast meshes pass SL-O2 (V 16, T 14; V 24, T 20). SL-O3: same input polygon; |ΔA| 8.5 · 10^-16 within the band 5.809 and 0.0557 within 8.389. The exact meshes (V 30, T 28; V 44, T 40) do not pass SL-O2 item 3 (section nodes off polygon vertices), reported as section 4.3 allows.
- SL-A6 positive controls, each rejected for its expected cause (asserted): on each of the 12 fast meshes a flipped triangle (item 1 and the inspector), a missing triangle (items 3 and 4), a duplicated triangle (item 3 and the inspector) and a vertex moved by one ulp (item 2), 48 controls; wrong boundary contours (SL-F6's evenodd mesh under nonzero and its nonzero mesh under evenodd, SL-F7's holed mesh against SL-F6 under nonzero, SL-F4 without its second square; items 2 and 3, and item 4 for SL-F4); P's simplicity (SL-F9's bowtie and SL-F2's crossing contours, the latter by the edge-crossing test alone); SL-F17 with its CLOSE verb renumbered before its last source (SL-C0); SL-O1 on SL-F5 with a vertex moved by 3/16 (SL-C1) and on SL-F13 with a leaf numerator or depth changed (SL-C0); SL-O3 with the exact mesh scaled by 2 (outside the band) and with one exact point changed by one ulp (not the same polygon). The unmodified meshes pass.
- SL-A5, the SL-U2 part (`SL-A5: the oracles detect each seeded defect`): (1) SL-F3, (4) SL-F1, SL-F3, SL-F18, (9) SL-F3 and (10) SL-F18 become fast and SL-O1 finds SL-C3 clearance failing; (2) SL-F11 and SL-F19 become fast and SL-O1 finds SL-C1 failing; (3) SL-F10 falls back as `CLEARANCE` after passing FR4 and SL-F10b becomes fast, and SL-O1 finds SL-C2 failing on both; (6) and (8) SL-F6 nonzero and (7) SL-F5 nonzero are rejected by SL-O2 (items 2 and 3 and the inspector; item 1 and the inspector). (5) only makes the rung more conservative: SL-F12 (a) falls back as `CLOSURE`, which SL-O1 classifies as conservative with reason `reason-not-exact` and the literal expectation rejects. The test asserts each defect's expected cause (the unsound condition, the SL-O2 items, or the conservative classification), not only a rejection.
- SL-O5, observational: the fast meshes of SL-F13 have minimum ρ 0.310 and 0.150, smallest angles 10.8° and 7.2°, no triangle with ρ < 0.1; their exact meshes have minimum ρ 0.0033 and 0.0010 with 12 and 9 triangles below 0.1. SL-F12 (a) has one sliver (ρ 1.6 · 10^-9) at its micro-closure vertex, as expected.
- Check-deletion experiment (review item S2): with each SL-O2 check disabled in turn in `oracle.ts` (item 1, item 2, item 3, item 4, the inspector, the edge-crossing simplicity test), the oracle test run fails: item 1 fails the mesh-control test (flipped triangle) and the SL-A5 test (defect (7)); item 2 and item 3 each fail the mesh-control, wrong-boundary and SL-A5 tests; item 4 the mesh-control and wrong-boundary tests; the inspector the mesh-control and SL-A5 tests; the crossing test the wrong-boundary test (SL-F2). `oracle.ts` was then restored byte for byte (`cmp` with the saved copy) and the test passes again (9 of 9).
- `pnpm test:geometry`: PASS. Kernel fmt and clippy `-D warnings` clean; native `cargo test` 336 passed, 38 ignored (unchanged from SL-U1); geometry vitest 44 files passed and 4 skipped, 742 tests passed (733 before, 9 new) and 6 skipped, 381.5 s, after the review fixes (the first run, before them, had 741 with 8 new tests in 404.8 s); the new oracle test takes about 0.3 s after its release-test build. Independent-build WASM SHA-256 `76fad318…e6d5`, the same as SL-U1's and `main`'s, since only a test file changed in the kernel.
- `pnpm check`: PASS (format, lint, typecheck, 66 unit files with 733 tests, dependency boundaries PASS). Run before the review fixes; after them, `tsc --noEmit -p tsconfig.json` and `eslint` of the two new files are clean.
- `prettier --check` of the two new files and this plan, and `git diff --check`: clean.

Interpretations recorded for review:

- **Emit extension.** Section 4.8 and the task allow extending `emit_spike_fixtures`; it gained a top-level `defects` array so that SL-A5's SL-U2 part is checked through the oracles. The `fixtures` array is unchanged, the schema string stays `p3-b0-spike-fixtures/1` and the parser requires both arrays.
- **What "detected" means for SL-A5.** For nine defects an oracle rejection with its expected cause (the SL-O1 condition or the SL-O2 items) is required. Defect (5) cannot produce an unsound output on its named fixture, only a conservative fallback, so its detection is the literal expectation plus SL-O1's classification (conservative, reason `reason-not-exact`).
- **SL-O1 beyond the conditions.** SL-O1 also requires the leaf partition and the use of every spanning source, and the MOVE point emitted bit for bit. These are the premises of section 3.3's family (S1 enforces them); a failure is reported as SL-C0.
- **SL-O1 stage soundness.** Besides "every fast path satisfies every condition", `judgeRung` requires every condition of each stage a fallback passed to hold exactly. This is what catches defect (3) on SL-F10, whose faulty run still falls back.
- **SL-O2 premise.** SL-O2 checks P's simplicity and disjointness exactly before deriving the boundary, since the winding argument of section 4.2 assumes it; it does not rely on SL-O1.
- **inspectTriangleMesh bounds.** It is called with the mesh's own bounding box and no expected area; SL-O2 item 4 is the exact area check.
- **SL-O3 τ.** τ = 1/16 is taken from section 1 (`TOPOLOGY_TOLERANCE`); the hand-off carries δ only.
- **Cargo profile.** The test runs the release test binary, like the P3.2g bridge; `pnpm test:geometry` builds it for the other bridges anyway.
- **Independent review (`reviewer`): READY**, no blocking item. Applied: S1, conservative now means every exact condition holds (section 4.1), and the reason's own exactness is a separate classification in which `PREFIX` and `TRIANGLE` are `no-condition`; S2, every SL-A5 defect and SL-A6 control asserts its expected cause, shown by the check-deletion experiment above; S3, a fast entry is judged on every condition and the parser rejects one stopped before FR8; S4, `perTriangle` raw values for SL-U3; N1, the cross-reference to the SL-U1 entry's `/1` description; N2, angles by atan2; N3, `inspectTriangleMesh` throws are caught and reported (SL-U3 meshes above 256 vertices or triangles get an `inspect` issue rather than an exception); N4, the CLOSE verb order check.

### B0 spike SL-U3 implementation

Unit SL-U3 of the [B0 spike contract](p3-b0-spike-ladder-contract.md#71-units): the harness, runner, analysis, validator, oracle run and dump, and the root script, following section 5. Acceptance: SL-A1, SL-A2, SL-A3, SL-A7 (the U3 part), SL-A8 and SL-A9. Functional evidence only; no performance claim. SL-U2 merged through PR #150 (`e17a60d`).

Landed:

- New test-only harness `packages/geometry-wasm/kernel/src/p3_b0_spike_bench.rs` with three ignored release tests, run only by the runner:
  - `run_spike_decision` (sections 5.3-5.5): one repetition. E5 (`size_of::<SpikeLadder>()` and the exact workspace's `allocated_bytes()`); the admission pre-check through the ladder over paths 0-9 of each decision cell and 0-99 of P4/s=16, recording per path the status (B0's code list applied to the exact rung's error), rung, reason, the S1 flat command count from a separate prefix probe, V and T, the exact rung's topology selection on fallback (false on the fast rung) and the allocations counted around the ladder call only; then B0's shuffled order, warm-up, timed and linearity batches with one reused ladder per cell, an allocation-counted untimed batch, and the section 5.5 checksum (B0's FNV-1a fold with the status word replaced by the rung, 0 fast and 1 exact).
  - `run_spike_diagnostic` (section 5.8): over the P2, P4 and P8 cells, the stops SL-D1 (`Stage::S1`), SL-D2 (`Fr5`), SL-D3 (`Fr6`) and SL-D4 (`Fr8`) of the fast rung alone (its own S1 prefix workspace and `FastRung`, `prepare_for_spike`, `load` and `run(stop)` as `SpikeLadder::run_until` calls them, but with no exact rung on a fallback, so no stop includes exact-rung time), the exact rung alone as a same-process baseline, and per path `FastStats` (sweep candidates, step-2 and step-3 clearance tests, diagonals) with the `fill_filter` decided and fallback counts of F1, and of F0.2 and F0.3 beside it.
  - `run_spike_oracle` (section 5.9): every corpus path (which is section 4's list) through the ladder with the allocation counter around the call only (SL-A7), the exact rung alone in its own workspace, and the corpus-wide S1 accessor equality of section 2.2 against that exact run. It writes the dump `p3-b0-spike-dump/1` (per path the S1 view, owners and sources in the SL-U2 hand-off schema, both meshes, rung, reason, ladder status, the certified max |d_m|² of a fast path, and the exact rung's status, sizes, topology selection, published polygon and mesh) and a small output with the allocating calls, the accessor counts and the exact rung's B0 batch checksums (paths 0-9 of each decision cell, and 0-99 of P4/s=16) for SL-O4.
- `p3_b0_bench.rs`: visibility only (private to `pub(crate)`) on `Cell`, `CorpusPath`, `Reader` and `Json` with their fields and methods, `read_corpus`, `env_usize`, `nanos`, `clock_quantum`, `shuffled`, `fnv`, `write_output`, the FNV constants and the `Entry` enum (the type of `Cell::entry`). With `pub(crate) ` removed from both sides, the file equals `main`'s.
- `lib.rs`: one `#[cfg(test)] mod p3_b0_spike_bench;` declaration appended at the end, as SL-U1 did, to keep the release WASM byte-identical.
- New `tests/geometry/p3-b0-spike/analysis.ts`:
  - `scenarioConfig(profile)`, the configuration of section 5.1, built from B0's unchanged `scenarioConfig` (generator, cells, admission cap codes, aggregation, fits, order and decision with k and the budgets) plus the spike's identity, corpus SHA-256, δ, r and τ, rung entries, stage and reason order, the oracles with their gate or observation status, sampling (B0's counts without the H1 replay), the diagnostic stops and the check list.
  - `evaluateOracle`: SL-O1 (`verifyCertificate` and `judgeRung` on every path with an S1 view, except `PREFIX` fallbacks; a fast path must also have its certified bound at or above the exact max |d_m|²), SL-O2 (`verifyRegionMesh` on every fast mesh), SL-O3 (`verifyAgreement` on every path both rungs admit), SL-O4 (each exact outcome and the batch checksums against the [2026-10-17 record](../benchmarks/results/2026-10-17_p3_p3-b0-feasibility-v1_native_desktop-dkvusav_20261017T150336Z-23973138.md), whose configuration hash is recomputed and whose stored analysis B0's own `validateRecord` re-checks first, together with its corpus hash; each fallback's ladder status against the exact rung run alone; and the dump's completeness, every (cell, path) of the oracle list exactly once, 1,270 in total), SL-O5 per cell and rung from SL-U2's `perTriangle` values, SL-O6 per cell (certified and exact curve share, topology share zero when SL-O2 passes, the contracted contours and their largest |k − m|) and SL-O7 (the O1 table beside the record's exact OK count, and the X expectation).
  - `analyze` and `validateSpikeRecord`: B0's `summarize`, `nearestRank`, `classify`, `leaves`, `fitSeries`, `canonicalJson` and `configHash`, imported unchanged; B0's eight checks with check 5 split into checksums (5) and the ladder mix (5b: per path rung, reason and topology selection); estimates, budget ratios, fallback tables per cell and repetition, the largest-cell fallback rate per primary series, the share of timed decision paths on the fast rung, the diagnostic stage split, the oracle gate and harness status recomputed from the stored failure lists, and the verdict. `validateSpikeRecord` also pins the configuration: it must equal `scenarioConfig(profile)` exactly, not only match its stored hash.
- New `tooling/run-p3-b0-spike-benchmark.mjs` and `.d.mts`: mirrors the B0 runner; imports B0's `parseArguments` and `readEnvironmentObservations` unchanged; regenerates the corpus with `encodeCorpus` and refuses a hash other than `206cf6e9…9796`; builds B0's decision build in B0's decision target directory; runs the repetitions, the diagnostic run (reference only) and the oracle run as separate processes; evaluates the oracles in TypeScript; writes `raw-record.json`, `record.json` (validated) and `summary.md` under `artifacts/p3-b0-spike/<run-id>/`; exits nonzero after writing them when an oracle gate, the S1 accessor or the allocation check fails. A Node resolve hook maps the `.js` specifiers of the TypeScript modules to their `.ts` files, since `oracle.ts` imports other modules at run time.
- New `tests/geometry/p3-b0-spike-analysis.test.ts` (9 tests), run by `pnpm test:geometry`: B0's hash and the spike configuration; the validator on synthetic records (valid; tampered sample, ladder mix, oracle failure list, stored verdict, configuration, scenario identity, and a budget edited with its hash recomputed, all rejected); the verdict rules, including `INVALID` for an allocating oracle-run ladder call and for an S1 accessor mismatch, each of which validates only as `INVALID`; the fallback-rate tables; and the Rust oracle harness on the regenerated corpus, which wires the corpus-wide S1 accessor test and SL-A7 into `pnpm test:geometry`, SL-O4 on the full dump (and its rejection of a dump with one entry dropped and of an identity record whose stored analysis was changed), and every gate on path 0 of every cell with positive controls (a flipped fast triangle, a certified bound below the exact value, a polygon vertex moved by 3/16, a changed exact polygon point, a changed exact outcome and a changed checksum), each rejected by its gate.
- `package.json`: the root script `benchmark:p3-b0-spike`.

Reference configuration hash (S7, for SL-A10): `configHash(scenarioConfig('reference'))` of the spike is `0daa96c068504c33dcf17ca787c1995db4972a76a006cd6db79473243fe72267`. The functional profile's is `e5b4e745a11cc15b68bf3774a04f53e36b155479c367c7456e155acaa78dd7fe`. `configHash(scenarioConfig('reference'))` of the unchanged B0 modules is still `a10c98e9c732929b2752a7349486cbd95e31cc02018d3c703011543483d29271`.

Local evidence, 2026-10-18, Windows 11, pinned Rust 1.94.1, Node 24.15.0, uncommitted working tree on branch `claude/p3-b0-spike-u3-runner` over `main` `e17a60d`:

- SL-A8, `pnpm benchmark:p3-b0-spike --profile functional --environment-json <scratch b0r-u8-env.json>`: completes end to end, run `20261018T121040Z-960f8b81` (after the last runner edit; an earlier run, `20261018T111803Z-3258d2ee`, had the same oracle results), about 5 min, about 4.5 min of it the TypeScript oracle evaluation. Exit 0; verdict `NONE` (functional); the corpus SHA-256 `206cf6e9…9796` regenerated and checked; `validateSpikeRecord` accepted the record. Oracle gates, all PASS: SL-O1 1,254 paths checked, 0 failures; SL-O2 1,121 fast meshes, 0; SL-O3 453 paths both rungs admit, 0; SL-O4 1,305 comparisons (1,270 exact outcomes and 35 batch checksums, 34 ten-path and P4/s=16's 100-path one), 0, every checksum equal to the 2026-10-17 record's (for example K4/s=4 `873827d8f8a1419b`, P4/s=16 `5036916f417d820d` and `137e6681229d3027`). The run directories were then moved out of the worktree (see the artifacts item below).
- SL-A8, tampered record: `tests/geometry/p3-b0-spike-analysis.test.ts` `recomputes a valid record and rejects tampered ones`: a changed batch sample, ladder mix, oracle failure list or stored verdict is rejected with `stored analysis differs from the recomputation`, a changed configuration with `configuration hash mismatch`, a changed scenario ID with `scenario identity mismatch`.
- SL-A7, wired in: the oracle run counts allocations around each of the 1,270 ladder calls only, zero allocating calls, in the functional run and in `pnpm test:geometry` (`runs every corpus path allocation-free with the S1 accessor equal`); the functional run's admission pre-check (430 decision paths) and its allocation-counted untimed batches are allocation-free too.
- Section 2.2, wired in: the corpus-wide S1 accessor test runs in the oracle run and in `pnpm test:geometry`: 453 published paths equal bit for bit, and on the other 817 the accessor succeeds or fails exactly as the attempt's prefix did; 0 failures.
- SL-A3: `git diff --exit-code main -- tests/geometry/p3-b0 tests/unit/p3-b0.test.ts tests/unit/p3-b0-record-comparison.test.ts tooling/run-p3-b0-benchmark.mjs tooling/run-p3-b0-benchmark.d.mts tooling/compare-p3-b0-records.mjs tooling/compare-p3-b0-records.d.mts 'docs/benchmarks/results/*p3-b0-feasibility-v1*'` exits 0; `diff <(git show main:packages/geometry-wasm/kernel/src/p3_b0_bench.rs | sed 's/pub(crate) //g') <(sed 's/pub(crate) //g' packages/geometry-wasm/kernel/src/p3_b0_bench.rs)` exits 0 (visibility only); `pnpm benchmark:p3-b0 --profile functional` completes (run `20261018T112416Z-5098970f`, verdict `NONE`); `configHash(scenarioConfig('reference'))` of the unchanged B0 modules is `a10c98e9…9271`, also asserted in the analysis test.
- SL-A1, release WASM: `main` (`e17a60d`) built from `git archive main packages/geometry-wasm/kernel` in a scratch copy with `cargo build --manifest-path packages/geometry-wasm/kernel/Cargo.toml --locked --offline --release --target wasm32-unknown-unknown` and `CARGO_ENCODED_RUSTFLAGS` set to `--remap-path-prefix` and `<scratch copy>=.`; the branch's built by `pnpm test:geometry`. Hashing command: `sha256sum .tools/geometry-build-u3-mainwasm/wasm32-unknown-unknown/release/vector_studio_geometry_kernel.wasm .tools/geometry-build/wasm32-unknown-unknown/release/vector_studio_geometry_kernel.wasm` (main, then branch): both `76fad318f5b20cb6ed0b8a1f7699b5825c9f3d027461567cb203242702c4e6d5`. `pnpm test:p2-identity` and `pnpm test:p3-fill-identity` report the same hash for base and branch.
- SL-A1, `pnpm test:p3-fill-identity`: PASS, run `20261018T113443Z-5818eea1`, 35 min. Native 66,351 cases (6,350 B0, 60,000 randomized), all digests equal; WASM 3,969 cases, all equal, and equal to the native digests; O5: modified kernel sources `lib.rs` and `p3_b0_bench.rs`, test-file changes none; both tamper self-checks detected; the release oracles passed.
- SL-A1, `pnpm test:p2-identity`: PASS, 10,048 batches with identical P2 output bytes (SHA-256 `876f4a49…0e046f`).
- SL-A1, test-only: every new Rust item is in `p3_b0_spike_bench.rs`, declared under `#[cfg(test)]` in `lib.rs`; this unit does not change `cubic_fill.rs`.
- SL-A2: `git diff --exit-code main -- packages/geometry-wasm/kernel/Cargo.toml packages/geometry-wasm/kernel/Cargo.lock pnpm-lock.yaml packages/contracts` exits 0; `package.json` adds only the `benchmark:p3-b0-spike` script; no `LIMITS`, `MAX_*`, `ABSOLUTE_MAX_*` or `fill_v0_*` change.
- SL-A9: `pnpm test:geometry` PASS, 520 s: kernel fmt and clippy `-D warnings` clean; native `cargo test` 336 passed, 41 ignored (38 before, 3 new ignored harness tests); geometry vitest 45 files passed and 4 skipped, 750 tests passed (742 before, 8 new) and 6 skipped; the new analysis test takes about 14 s after its release-test build; independent-build WASM SHA-256 `76fad318…e6d5`. `pnpm check` PASS (format, lint, typecheck, 66 unit files with 733 tests, dependency boundaries PASS). `pnpm build` PASS.
- `p3_b0_diag` clippy (`RUSTFLAGS="--cfg p3_b0_diag"`, `CARGO_TARGET_DIR=.tools/geometry-build-p3-b0-diag`, `CARGO_ENCODED_RUSTFLAGS` unset, `--all-targets -D warnings`): PASS; `cargo clippy -v` shows `--cfg p3_b0_diag` on the compiler line.
- `run_spike_diagnostic`, which only the reference profile runs, was run once by hand on the regenerated corpus with `P3_B0_DIAG_WARMUP=1` and `P3_B0_DIAG_TIMED=2` (0.9 s) and analysed with `analyze`: every stop and the exact baseline produce samples, no path falls back at any stop, and the counts are recorded (for example P4/s=16: 84.2 sweep candidates per path, none reaching steps 2 or 3, 2.2 diagonals, F1 2,433 decided and 0 fallback over the ten paths).
- `prettier --check --ignore-path <empty file>` of this plan and of the new or changed TypeScript, JavaScript and JSON files, and `git diff --check`: clean.
- After the review fixes (S1-S5, M1-M3), rerun: `pnpm test:geometry` PASS, 502 s (native 336 passed and 41 ignored; geometry vitest 45 files passed and 4 skipped, 751 tests passed and 6 skipped, the analysis test now 9 tests; independent-build WASM SHA-256 `76fad318…e6d5`, unchanged, as the fixes touch only test code); `pnpm check` PASS (66 unit files, 733 tests, boundaries PASS); `pnpm benchmark:p3-b0-spike --profile functional --environment-json <scratch b0r-u8-env.json>` PASS, run `20261018T124100Z-0c67613b`, 322 s, kept under the now-ignored `artifacts/p3-b0-spike/`: verdict `NONE`, `invalidReasons` empty, the same gate counts (SL-O1 1,254, SL-O2 1,121, SL-O3 453, SL-O4 1,305 including the dump completeness check, all 0 failures), harness allocation-free and S1 accessor PASS, the same dump SHA-256 `3ccd703f…548c` as the earlier runs. `run_spike_diagnostic` with the fast-rung-alone stops was rerun by hand (warm-up 1, timed 2): no stop falls back, P4/s=16 ten-path fast rung about 0.80 ms against about 22.4 ms for the exact rung. `pnpm test:p3-fill-identity` and `pnpm test:p2-identity` were not rerun: the fixes change only `p3_b0_spike_bench.rs` (a `cfg(test)` module no release or WASM build compiles) and TypeScript test and tooling files.

Functional run observations, not evidence (one repetition, two timed batches, a busy development machine; section 5.13):

- Admission: all 34 decision cells ADMITTED; every decision path (430, with P4/s=16's 100) takes the fast rung, so the timed fast-rung share is 1 and the largest-cell fallback rate is 0 for P2, P4 and P8. All eleven checks pass in this run (in the earlier functional run check 2 failed, prediction factor 2.506).
- O1 (780 paths): 691 fast, 73 `CLOSURE` and 16 `PREFIX` fallbacks, as SL-U1 observed; no conservative fallback (every `CLOSURE` fails SL-C4 exactly); the exact rung's OK count per cell equals the record's (23 in total). X (60 paths): every path `CROSSING`, with the exact rung `Topology(Unresolved)`, as section 4.7 expects.
- SL-O6 on fast paths: largest certified deviation 0.0940676 and exact max |d_m| 0.0940676, below δ = 0.125; topology share 0 by SL-O2; 247 contracted contours (all on O1 cells), largest |k − m| 9.5 · 10^-16.
- SL-O5 over the decision cells: fast meshes 16,160 triangles, minimum ρ 0.00198, smallest angle 0.067°, 5,817 with ρ < 0.1 and 76 with ρ < 0.01, minimum altitude 0.0094; exact meshes 33,081 triangles, minimum ρ 1.1 · 10^-5, smallest angle 0.00037°, 23,545 with ρ < 0.1 and 2,981 with ρ < 0.01.
- E5: `size_of::<SpikeLadder>()` 41,840 bytes; the exact workspace's `allocated_bytes()` 1,111,552.
- Timings, not evidence: clock quantum 100 ns; median per-path batch time P2/s=16 34.2 µs, P4/s=16 81.3 µs, P8/s=8 95.8 µs, K4/s=4 85.1 µs; linearity ratio 1.064; the functional fits give 872 ms initial, 2.38 ms edit proxy and 6.81 MiB at k = 2 (the earlier functional run gave 1,233 ms and 1.47 ms). The by-hand diagnostic run (two timed batches) put the P4/s=16 ten-path fast rung at about 0.81 ms and the exact rung alone at about 23 ms. These are single-repetition observations on a development machine; only SL-U4's reference record carries performance evidence.

Interpretations and deviations recorded for review:

- **`Entry` visibility.** S9 lists the structs with their fields; `Cell::entry`'s type `Entry` is also made `pub(crate)`, since a `pub(crate)` field of a private type fails clippy `-D warnings` (`private_interfaces`). Still visibility only.
- **Invalid runs.** Sections 4 and 6 give a run invalidated by an oracle gate or a checksum mismatch no verdict. The analysis reports verdict `INVALID` with `invalidReasons` (`oracle gate`, `allocating ladder call`, `S1 accessor mismatch`, `checksum mismatch`) in the reference profile; the functional profile's verdict is `NONE`. A gate with no checked path does not pass, and a missing oracle run is invalid. Check 5 (checksums) leads to `INVALID`, check 5b (the ladder mix) to `INCONCLUSIVE` like the other checks.
- **SL-O1 scope.** Besides every fast path, `judgeRung`'s stage soundness (every condition of a stage the rung passed holds exactly) is gated on every fallback with an S1 view, as SL-U2 defined it; a `PREFIX` fallback has no condition and is skipped. Conservative fallbacks and the reason classification are reported per cell.
- **Certified δ̄ in the dump.** `FastStats` exposes the per-path maximum of the certified |d_m|² bound, not per-edge values; the dump carries that maximum, which is what SL-O6 aggregates, and SL-O1 checks it against the exact maximum.
- **SL-O4 extent.** Besides paths 0-9 of each decision cell, SL-O4 also compares P4/s=16's 100-path batch checksum and every exact outcome of every corpus path (status, flat commands, V, T, topology selection; allocations are not compared, since B0's count includes its failure-code formatting) with the record's admission (repetition 0) and O1 and X observations.
- **Harness checks.** The S1 accessor equality (section 2.2) and the oracle-run allocation check (SL-A7) are not among section 5.6's eight checks; after review item S1 they invalidate the run like an oracle gate (verdict `INVALID`), and the runner exits nonzero after writing the record.
- **Process listing.** Section 5.11's process listing is captured by the runner (`tasklist /fo csv /nh`) into the artifact directory; the record keeps its time, process count, hash and path, and check 8 requires it. No CPU-load sampling.
- **Oracle evaluation cost.** The exact TypeScript oracles over all 1,270 paths take about five minutes of the runner's time; `pnpm test:geometry` evaluates path 0 of every cell (about 11 s) and SL-O4 on the full dump.
- **Artifacts directory.** This diff adds `artifacts/p3-b0-spike/` to `.gitignore` (raw run output stays out of `pnpm check`'s Prettier check and of the reference profile's clean-worktree rule) and `docs/benchmarks/results/*_p3_p3-b0-spike-ladder-v1_*.json` to `.prettierignore` (the committed SL-U4 record stays byte for byte). The first functional runs predate the `.gitignore` entry, so their directories were moved out of the worktree.
- **Diagnostic stops (review item M1).** The stops time the fast rung alone, as section 5.8 says; a stop's fallback count is recorded and no exact rung runs inside a stop. The configuration's diagnostic entry states this, so the reference configuration hash changed from the first implementation's `02ae577d…53b3` to `0daa96c0…2267`; the functional hash, which has no diagnostic entry, is unchanged.
- **S1 accessor on prefix failures (review item M2).** When the exact attempt did not publish and the accessor succeeds, the attempt must have got past S1: an Ok result has sizing status `PATH_OK`, and an error must come after `validate_leaf_partitions` (topology or rounded fill invoked); an attempt that failed inside the prefix while the accessor succeeded is a mismatch.
- **Independent review (`reviewer`): READY**, no blocking item. Applied: S1, harness failures invalidate the verdict; S2, the configuration is pinned to `scenarioConfig(profile)`; S3, SL-O4 recomputes the identity record's configuration hash and runs B0's `validateRecord` on it; S4, the dump completeness check; S5, this artifacts item; M1 and M2 above; M3, no argument spreading over per-triangle arrays (`minAltitude` and the summary's SL-O6 maxima are loops, the latter printing `none` for an empty set).

### B0 spike SL-U4 reference run

Unit SL-U4 of the [B0 spike contract](p3-b0-spike-ladder-contract.md#71-units): the reference run and its committed record. Acceptance: SL-A10, then SL-A11 (independent evidence review). SL-U3 merged through PR #151 (`9505ddd`). This entry records the run; no performance claim beyond the record.

**Reference run.** Run `20261018T213619Z-89016cc9` on the reference machine (DESKTOP-DKVUSAV), `main` `9505ddd` from a clean worktree (the record's `dirty: false`; its 57 source-manifest hashes equal the files at `9505ddd`): `pnpm benchmark:p3-b0-spike --profile reference --environment-json <scratchpad>/spike-u4-env.json`. It started at 2026-10-18T21:36:20Z and the record spans 6 min 27 s (`utcStart` to `utcEnd`; the shell timed the whole command at 6 min 30 s). The untracked, machine-local `.claude/launch.json` was moved out of the worktree for the run, because the reference profile requires a clean worktree, and restored afterwards. Provenance follows the 2026-10-12 protocol (section 5.11): power observed before the run (AC, no battery, Balanced plan); the operator's readiness answer "지금 시작 (Recommended)" in chat; a Primary process listing at 21:36:02Z with no cargo, rustc or build process and no node process of this project (only idle third-party node helpers), and the runner's own `tasklist` capture at 21:36:19.589Z; no CPU-load sampling, per the user's standing instruction.

Result: [record](../benchmarks/results/2026-10-18_p3_p3-b0-spike-ladder-v1_native_desktop-dkvusav_20261018T213619Z-89016cc9.md) with its raw `.json`, a byte-for-byte copy of the runner's `record.json` (SHA-256 `180cdc14…bb36`); `validateSpikeRecord` accepts it. The `.json` is covered by the existing `.prettierignore` entry. Raw output stays under the ignored `artifacts/p3-b0-spike/20261018T213619Z-89016cc9/`.

- **SL-A10.** Clean `main`; corpus SHA-256 `206cf6e9…9796`; configuration hash `0daa96c0…2267`, equal to the one recorded above when SL-U3 merged; every oracle gate PASS: SL-O1 1,254 checked, 0 failures; SL-O2 1,121, 0; SL-O3 453, 0; SL-O4 1,305, 0. Harness checks PASS: 1,270 ladder calls with no allocating call, S1 accessor 453 published equal and 817 others consistent, 0 failures. Every timed batch and pre-check path allocation-free. The oracle dump's SHA-256, `3ccd703f…548c`, equals the SL-U3 functional runs'.
- **Verdict, as the runner computes it: INCONCLUSIVE.** Check 2 (prediction factor) fails with a maximum of 2.610 against the limit 2. The other ten checks pass, including 5b (ladder mix identical across repetitions); linearity ratios 1.077, 1.182, 0.977, 1.171 and 1.183. The verdict scope of section 6 applies: simple, disjoint, snapped contours at zoom 1, native and provisional on k = 2, for the ladder as specified and as a test-only spike.
- **Summary.** Every decision path took the fast rung (430 pre-check paths, 340 timed, fallback rate 0 at every largest cell). Estimates at k = 2: T̂ 1,285.3 ms (1.285 × B_init), from the P8 median fit of repetition 0; t̂_edit 2.491 ms (0.623 × B_edit), from the P8 p95 fit of repetition 0; M̂ 6.81 MiB (0.106 × B_mem). U binds in both timing estimates. Median slopes 0.944-1.048. Diagnostic: the fast rung alone is 26.5-30.5 times faster than the exact rung alone at the largest cells, and its certificate (FR1-FR5) takes 76-82% of it. O1: 691 of 780 generic-coordinate paths take the fast rung (73 `CLOSURE`, 16 `PREFIX`, no conservative fallback) against 23 exact-rung OKs; X: every path `CROSSING`, as expected. SL-O6: curve share at most 0.0941 (decision) and 0.0938 (O1), below δ; on 247 contracted O1 contours P's positional bound holds within an extra |k − m| ≤ 9.5 · 10^-16.
- **Comparison with the 2026-10-17 B0 record,** from `analyze()` of both committed records, ratios B0/spike: T̂ 32.2, t̂_edit 49.0, M̂ 2.26; per-cell per-path medians 25.5-30.6 in every cell, not growing with L; stage split at the largest cells: topology-certificate role 25.0-29.6, tessellation role 86.3-96.5, totals 28.5-31.6.
- **Why check 2 failed.** The design is B0's, so the factor exp(t · s_e · √(…)) changes only through s_e; for P8 (6 points, L\* = 256) the limit needs s_e ≤ 0.132. Two of the 30 primary fits exceed 2, both P8 p95 fits of individually timed paths, as in the 2026-10-17 record: repetition 1 (2.610, s_e 0.182) and repetition 0 (2.356, s_e 0.163); every median fit passes, at most 1.731. In both the outlying point is P8/s=5 (L = 40). In repetition 1 its path times are about 56 µs until late in batch 10, then rise (up to 121.6 µs in batches 10-12) and stay at about 69-79 µs through batch 19, so 58 of 200 samples exceed 1.25 times the median and the p95 is 0.0884 ms against 0.0593-0.0828 ms in the other repetitions. In repetition 0 they alternate between about 57 and about 69 µs in runs across batches, which also lifts that cell's batch median to 0.0704 ms against 0.0561-0.0568 ms and makes repetition 0's P8 median fit, the binding fit for T̂, the largest median factor. The record does not identify the source of the level changes.
- **Context, not a verdict.** T̂ is about 1.29 times B_init; t̂_edit and M̂ are within budget. The runner's INCONCLUSIVE verdict stands.

Independent evidence review (`reviewer`, SL-A11): ACCEPTED with no blocking items. It confirmed SL-A10: the committed `.json` is byte-identical to the run's `record.json`; `validateSpikeRecord` accepts it; the configuration and corpus hashes are as above; the gate counts cover all 1,270 paths; and the source manifest equals `9505ddd`. It recomputed the record's tables from `analyze()` of both committed records and checked the check-2 analysis against the raw samples. Its three should-fix items were applied to the record before it was committed: the functional-run figures and their sources, the contracted-contour cell count, and one O1 sentence. A clause noting that the observational K2 p95 fit is outside check 2 was also added. SL-U1's proof-correspondence review is READY, as recorded in PR #149.

Superseded by the review above: Next: the independent evidence review (SL-A11) of the record against the contract, SL-U1's proof correspondence and the oracle results. Then, under the spike contract's [section 6](p3-b0-spike-ladder-contract.md#6-decision-rule-and-consequences) and user decision B0-Q3, the INCONCLUSIVE verdict goes to the user before B1, as INFEASIBLE would, with the measured numbers and the consequence options (SL-U5, SL-A12). The spike chooses no remedy; B1 stays blocked.
**User decision, 2026-10-19, in chat (SL-U5, spike verdict INCONCLUSIVE).** Shown the verdict and four options (an Alt-A1 production contract with its own performance gate; one more spike reference run; a further fast-rung optimization and a spike v2; a return to Alt-E2, Alt-E3 or Alt-B), the user chose the recommended option: write the full-tier Alt-A1 production contract. Its performance gate is re-measured inside that contract: optimization of the fast rung's certificate stage (76-82% of its time), the WASM ratio measurement (B0-W), and verification of the 1 s initial-build budget at the product stage. The budgets, the B0 and spike records and the decision rule are unchanged. B1 (kernel caps) stays blocked until that contract is approved.

### B0 runner (light tier)

Plan entry: implement section 9 item 1 of the [B0 contract](p3-b0-feasibility-benchmark-contract.md) without changing it. Acceptance check: `pnpm benchmark:p3-b0 --profile functional` completes end to end; the TypeScript generator and an independent Rust generator match committed fixture bits; a tampered record is rejected; `pnpm check`, `pnpm build` and `pnpm test:geometry` pass; the diagnostic flag builds and passes clippy in its own target directory; the WASM release artifact is byte-identical to main's. Evidence is recorded on the runner PR. A functional run is not performance evidence.

Interpretations the contract leaves open, fixed by the runner and reviewed on its PR:

- check 2 applies to the p95 edit-proxy fits as well as the median fits;
- H1 is Inconclusive when a counted instantiation has no captured unit cost;
- a reference record with missing metadata fails check 8, so its verdict is INCONCLUSIVE rather than absent;
- the curvature guard breaks a tie for the half-L point toward the smaller L, which does not occur in the frozen sweep;
- a failed or timed-out process is retained under `failures` in the record and fails check 7.

Current status: P3.1k integrated through [PR #95](https://github.com/npclown/vector-studio/pull/95). P3.1l is integrated through PRs #96-#98. P3.1m and its [U1-U4](p3-private-contract.md#user-decisions-on-mesh-position-representation-2026-10-06), U2 and R3 follow-ups are integrated through PRs #99-#105. P3.1n R0/R0a is integrated through PRs #106-#108: the C2 clearance admits 143 of 158 fixture rows. P3.1o O00 raster coverage readiness is integrated through [PR #109](https://github.com/npclown/vector-studio/pull/109). The O01 observational coverage contract is integrated through [PR #110](https://github.com/npclown/vector-studio/pull/110). Its headed observations are recorded below; the evidence was accepted. The user decided [Q4 and Q5](p3-private-contract.md#user-decisions-on-mesh-position-representation-2026-10-06) on 2026-10-07: A5 with inherited P1 thresholds. The [O02 A5 coverage rule contract](p3-o02-a5-coverage-contract.md) is integrated through [PR #113](https://github.com/npclown/vector-studio/pull/113). Its headed evidence gives a **PASS** verdict for the test-only A5 realization. Earlier sections retain their contemporaneous gate context and evidence. Complete P3 acceptance remains open; stroke refinement stays user-deferred.

## P3.1p R2 tiling contract

The [R2 tiling contract](p3-r2-tiling-contract.md) is FROZEN.

- **Technical review (Astra high):** NOT READY twice, then READY.
- **Implementability review (Sol medium):** NOT IMPLEMENTABLE, then IMPLEMENTABLE.
- **User decisions (2026-10-08, chat):** the user confirmed E1-E3:
  - shared vertex records with a per-vertex owner-cell carrier, for watertight seams;
  - builds only at epoch changes, with a per-level cache;
  - the Q1 coverage reference restated as the exact reference tiling.

**What it fixes.**

- The epoch-based successor certificate:
  - S1 domain;
  - S2 epoch position `E_ep`;
  - S3 merged-mesh C2 at `s_lo`;
  - S4 exact partition;
  - S5 lists.
- The per-cell exterior fringe.
- The reach constants.
- γ = 4.
- A pre-stated thin-tip sliver hazard, which is reported, not gated.
- The T02 offline exact evidence, with four pre-registered gates.

O03, the GPU evidence, follows under its own contract.

**T02 implementation** (branch `codex/p3-1p-t02-impl`):

- **Primary:** epoch, `E_ep` (S2), pruned merged C2 (S3), lists (S5), camera variants, and the report and replay.
- **Sol medium:** the merged mesh (E1 records and carriers), `fringeFaces`, S4, and the trajectory cell sets.

Astra high's stable-source review was CLEARED after one fix round. Its evidence review was EVIDENCE ACCEPTED, with 15 of 15 rows independently recomputed.

**Result: T02 FAILS.** See the [review record](../evidence/p3.1p-t02/review-2026-10-08.md); the archived report SHA is `3e89e55a…`.

- **Gates 1 (partition) and 4 (frame coverage):** pass.
- **Gate 2:** fails. The three class A rows are admitted, but 16 camera variants fail on genuine grid slivers: thin tips that span several cells, and a near-diagonal grid corner.
- **Gate 3:** fails. 100 of 429 O rows are lost.
  - The losses are δ- and scale-driven: S3 runs at `s_lo`, and Ē sits 1.4 to 2.3 times above T01's δ̄ because of the zoom band and the record extent. Fringe triangles add to them.
  - The larger window's geometry passes with T01's δ̄.

**User decision (2026-10-08, chat).** Both are the recommended options:

- for gate 3: reduce δ and improve the fringe;
- for gate 2: compare grid-sliver mitigations, then decide.

**R2 revision 4.** The [delta contract](p3-r2-tiling-rev4-contract.md) is FROZEN. Its technical review (Astra high) went NOT READY, then READY; its implementability review (Sol medium) was IMPLEMENTABLE. It adds four deltas:

- **D-A:** localized C2, with best rotation for the triangle term;
- **D-B:** four certificate sub-bands per epoch;
- **D-C:** exact Delaunay flips on the fringe, ordered by position;
- **D-D:** owner carriers centred on the geometrically owned records.

Gates are not relaxed. A pre-registered prediction set R (16 ids, from the disclosed census) defines a FAIL-AS-PREDICTED verdict, which is not acceptance.

**T03 implementation** (branch `codex/p3-1p-t03-impl`):

- **Primary:** D-A and D-B (`local.ts`), the report with its gates, prediction and verdict, and the replay.
- **Sol medium:** D-C (`delaunay.ts`) and D-D (`owner.ts`), with their locality tests.

Astra high's stable-source review was CLEARED after one fix, an unpruned oracle test. Its evidence review returned EVIDENCE ACCEPTED, with 14 of 14 rows independently recomputed.

**Result: FAIL-AS-PREDICTED, which is not acceptance.** See the [review record](../evidence/p3.1p-t03/review-2026-10-08.md); the archived report SHA is `5679e76e…`.

- **Gates 1 and 4:** pass.
- **Gates 2 and 3:** fail on exactly the pre-registered set R, with the predicted outcomes:
  - 12 class A variants on `vertex`, which are full grid-sliver clearance failures;
  - 4 `Z/depth-positive …/S5` O rows at DPR 1 on `triangle`.
- **Against T01:**
  - O losses fell from 100 to 4 and C losses from 32 to 0.
  - Six admitted rows pass only some sub-bands. They are instances of the zoom-only U4 case.

**T04 contract.** The [T04 grid-sliver mitigation comparison contract](p3-t04-sliver-mitigation-contract.md) is FROZEN.

- **Reviews.** Astra high: NOT READY four times, then READY with one verbatim fix. Sol medium: NOT IMPLEMENTABLE twice, then IMPLEMENTABLE.
- **User decisions, all 2026-10-08 in chat:**
  - evaluate needle-tip truncation; this was later withdrawn because it removes a visible line;
  - evaluate M-D, needle-as-fringe, instead;
  - evaluate a relaxed coverage meaning for features narrower than 2Ē.

T04 compares these configurations against C0, the T03 control:

| Configuration | Adds                                   |
| ------------- | -------------------------------------- |
| C1            | K = 8 sub-bands                        |
| C2            | + M-B, per-cell region retriangulation |
| C3(w)         | + M-D, for `w` in {1/32, 1/16, 1/8}    |
| C4(w)         | M-D without M-B                        |

It adopts nothing.

**Parked under [D8](p3-d8-parallel-tracks.md).** T04 implementation (`tests/geometry/extent-t04/`) would come next, then the evidence and a user decision. Adopting anything would lead to R2 revision 5; adopting the relaxed semantics would also need a requirements update. The residual set R stays an open risk.

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

The stable-source review was CLEARED after one fix round.

**Evidence.** See the [review record](../evidence/p3.1p-t01/review-2026-10-07.md). The archived report has SHA `5e49c880…`. Replay is byte-identical, and the independent recomputation matched 227 of 227 records: EVIDENCE ACCEPTED.

**Observed** (nothing adopted):

- K1 @256 admits the three class A rows that K4 fails, with no regression against K4, M_max ≥ 40, and up to 45-66 tiles per frame.
- Larger T or K2c lose rows K4 admits, through δ̄ growth, slivers or lane-range.
- K5-ASSUMED stops at k 18 at the NDC floor.

The user decided D1 on 2026-10-07: [K1 with T_tile = 256](p3-private-contract.md#user-decisions-on-mesh-position-representation-2026-10-06). Next is the R2 contract: the U1 successor certificate, tile-seam watertightness, the tile cache and hysteresis, the exterior partition, and GPU evidence.

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

| ID  | Required evidence                                                                                                         | Status                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 | Valid mesh/index/range structure, deterministic failure isolation and bounded adversarial work                            | TODO                                                                                                                                                                                                                                                                                      |
| A02 | Both fill rules, holes, intersections and winding agree with independent analytic/membership and image fixtures           | TODO                                                                                                                                                                                                                                                                                      |
| A03 | Required caps/joins, open/closed paths, thin strokes and miter/degenerate cases match fixed semantics                     | TODO                                                                                                                                                                                                                                                                                      |
| A04 | Combined geometric error <=0.25 physical pixel across declared transforms/zoom/DPR, with rejecting positive controls      | TODO; measured on a frozen corpus against an independent oracle (D8)                                                                                                                                                                                                                      |
| A05 | ABI capacity/growth/view ownership, copied results, stale work, disposal and recreation                                   | TODO                                                                                                                                                                                                                                                                                      |
| A06 | Stable mesh reuse; only affected geometry rebuilds across revision/style/bucket changes; color/opacity avoid mesh rebuild | TODO                                                                                                                                                                                                                                                                                      |
| A07 | Ordered path/primitive integration, upload/resource lifetime and latest-scene device recovery                             | TODO; scene/API decision taken at [D8 V1](p3-v1-path-scene-port-proposal.md)                                                                                                                                                                                                              |
| A08 | Headed Chrome/Edge corpus, coverage fringe versus MSAA comparison and reproducible evidence                               | TODO; visual contract fixed in [V3 contract section k](p3-v3-renderer-mesh-pipeline-contract.md#k-a08-visual-contract) (fringe at 1x and 4x gated by Q4; MSAA-only a reported baseline); V4 supplies the harness, and evidence counts only after C03-C05 on the frozen layout and carrier |

P3 defines no new performance multiplier here. A later performance assertion requires its own prospective measured event/workload/environment/sample/threshold contract. D7 does not authorize changing P1/P2 metrics or using a functional run as performance evidence.

## Task graph and ownership

**Superseded by [D8](p3-d8-parallel-tracks.md) on 2026-10-08.** The table and diagram below record the pre-D8 order, in which P3.6 integration waited for P3.5. Under D8 the current order is the V1-V4 and B0-B4 checkpoints at the top of this plan; P3.6 may proceed before P3.1-P3.5 acceptance. The task purposes and ownership rules remain valid as descriptions of the work.

| Task  | Purpose and expected files                                                                     | Predecessors                                                        | Parallelism / owner                                                                        | Risk / model and effort                                        |
| ----- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| P3.0a | Entry decision, roadmap/navigation and this plan                                               | D7                                                                  | Primary; read-only independent review                                                      | Medium consistency; Primary                                    |
| P3.0b | Private contract, topology/error-budget feasibility and fixture specification under docs/plans | P3.0a                                                               | Primary single owner; bounded independent review                                           | High cross-module/numeric; Primary, reviewer audit             |
| P3.1  | Independent mesh oracle/corpus in geometry-reference and test support                          | P3.0b                                                               | Oracle and positive controls precede production fill                                       | High verification; implementer; analytic fixtures              |
| P3.2  | Fill topology/tessellation in geometry-wasm/kernel private modules                             | P3.0b + P3.1                                                        | After independent oracle review; no shared ABI edits                                       | High algorithm/numeric; implementer on Opus                    |
| P3.3  | Stroke mesh generation in geometry-wasm/kernel private modules                                 | P3.2 shared topology review + P3.0b                                 | Sequential by default until reuse boundary is proven independent                           | High degeneracy/overlap; implementer on Opus                   |
| P3.4  | Mesh ABI/adapter/cache integration in geometry-wasm and tests                                  | P3.2 + P3.3                                                         | Single owner of engine/codec/adapter; no concurrent lifecycle edits                        | High ownership/regression; implementer on Opus, Primary review |
| P3.5  | Native/WASM/browser differential acceptance                                                    | P3.1 + P3.4                                                         | Independent audits after integration; validation commands may run separately               | High numeric interpretation; reviewer; Primary acceptance      |
| P3.6  | Concrete path scene/port proposal, then ordered core/backend composition and coverage          | P3.0b for proposal; P3.5 + explicit API decision before integration | Primary owns contracts and lifecycle; only disjoint shader/fixture delegation after freeze | High API/lifecycle; Primary, bounded implementer               |
| P3.7  | Headed visual/cache/recovery corpus and milestone review                                       | P3.6 + frozen visual contract + valid environment                   | Serial hardware execution, then independent evidence audit                                 | High acceptance; Primary; runner for commands                  |

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
