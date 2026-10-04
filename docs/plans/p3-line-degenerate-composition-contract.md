# P3.2q canonical all-LINE degenerate contour composition

Status: FROZEN after Primary and independent Astra high prospective review,2026-10-04, before implementation. The [active plan](p3-fill-stroke-meshes.md) owns execution. This applies existing [approved visible semantics](p3-visible-semantics-proposal.md) and the [line](p3-line-fill-mesh-contract.md)/[rounded](p3-rounded-fill-mesh-contract.md) workspaces' existing empty/degenerate behavior to the private canonical wrapper. No public API/ABI, dependency, capacity, tolerance, algorithm or architecture decision is changed.

## Exact scope and routing

Supersede only the temporary canonical all-LINE restrictions in [LINE identity](p3-line-identity-contract.md) and [zero-LINE normalization](p3-zero-line-contract.md): MOVE-only/fully collapsed contours and cyclic one-segment/two-edge retraces may reach the existing rounded workspace. These restrictions were explicitly preparation limitations, not final product rejection rules. Preserve all other existing j/k/l/o contracts, historical evidence and unchanged94 cubic rows/closure pairs. This neither resumes user-deferred stroke nor handles general CUBIC crossings.

Keep the cheap verb/scalar caps and unchanged run_path sizing first. Only after successful sizing, determine all-LINE eligibility from the entire bounded canonical verb stream: it contains no CUBIC. MOVE/CLOSE-only paths are eligible; truly empty input still returns its unchanged PATH_EMPTY sizing result. Eligibility must not depend on a decoded prefix: an empty contour before a later CUBIC retains its legacy failure. Invalid source/tolerance and cheap-cap precedence remain unchanged.

Only for eligible paths, decoding may retain zero-count source ranges; each original contour still has its own source-range entry and consumes the existing four-contour budget. Sources/commands/MOVE/CLOSE identities, all endpoint bits, original ordinals and the shared16 LINE/CUBIC source charging remain intact. Collection keeps one original MOVE point for every MOVE-only or collapsed contour as a singleton range. Never compact away its contour identity. Exact zero original LINEs keep their existing normalization rule, command/source retention and cap charging. A singleton has no edge owner and no explicit/synthetic closure edge. Returning nonzero contours retain every nonzero edge owner while removing exactly one duplicated terminal point.

Collection owner accounting and rounded ownership verification must use zero edges for singleton ranges, and range.count for cyclic ranges of two or more points. Zero-length ranges are not emitted by canonical collection. Two-point contours preserve both opposite directed edges: a returning LINE owns its reverse, otherwise the appropriate explicit CLOSE or implicit closure owns it. Rounded source edge contour/start/end indices must still bind to the original canonical contour indices and retained point indices. Never fabricate an owner for a point contour or index a nonexistent rounded edge.

After complete source/provenance validation, eligible paths invoke the existing rounded workspace directly without either cubic topology helper. Pass literal contour slices in original order, including singletons; use normal rounded tolerance/input/work/output validation even for empty fill. Do not shortcut or erase a retrace because its winding cancels: source edges, exact events, sections/nodes and embedding ambiguity remain part of the proof geometry. Publication succeeds only after rounded ownership validation. Success/failure/recovery must reset diagnostics and stale output as before.

Any path containing a CUBIC retains existing decode/collection restrictions, original-zero-LINE omission/proof compaction, exact-first/rounded-KnotMismatch certificate selection, failure precedence and diagnostics. In particular, introducing all-LINE eligibility must not incidentally accept MOVE-only/collapsed contours in mixed paths. Keep all storage and accounting unchanged; no new allocation per attempt or WASM export.

Skipped-helper checks preserve the [adoption contract](p3-rounded-topology-adoption-contract.md): topology_stats() remains the cached aggregate from the last actual topology invocation when that stage is skipped. Per-attempt invocation/selection/error flags reset; stale certificates never supply current ownership or publication. Assert unchanged cached stats across cubic success -> all-LINE attempts, rather than redefining that getter to return zero.

## Prospective literal acceptance

Use existing flatten tolerance1/8 and rounded tolerance1/16 except the explicitly named A02 ambiguity control. Both nonzero/evenodd rules are explicit. The following expected geometry is analytic and frozen before execution; do not derive expected outcomes from the implementation or choose cases after observing results.

Let D=(20,0), E=(23,0). Eight encodings:

- M: MOVE D, without/with CLOSE (two).
- Z: MOVE D, LINE D, without/with CLOSE (two).
- R: MOVE D, LINE E, optionally LINE D, independently without/with CLOSE (four).

Q01: all eight standalone under both rules (16 attempts) publish empty vertices/indices, positive-zero mesh bounds and error_bound=0. Literal direct-rounded contours are [D] for M/Z and [D,E] for R. M/Z have zero owners/edges; R has two opposite edges and the exact original/closure owners. Every attempt checks full direct-rounded output and statistics, original commands/source bits, contour ranges/indices, ownership and skipped cubic-helper state. Direct-rounded equivalence is composition evidence, supplemented by literal empty-region assertions; it is not an independent tessellator claim.

Q02: compose each encoding before, between and after the two same-oriented F02 contours, outer[(0,0),(10,0),(10,10),(0,10)] and inner[(3,3),(7,3),(7,7),(3,7)], ordinary contours encoded nonreturning/open. Both rules give48 attempts. Preserve the full three-contour order in independently constructed direct-rounded inputs; areas are100 nonzero and84 evenodd. Compare full rounded output/statistics and original ownership, not just area. Existing k/l fixtures retain ordinary contours' four closure forms; no redundant expanded cross-product is needed. Singleton composition retains two four-edge contours (eight owners); R adds two original/closure owners (ten total). These are exact contour inventories, not new caps.

Q03 focused controls, both rules where the helper accepts an explicit rule:

- Signed-zero MOVE(-0,+0), LINE(+0,-0), open/closed: retain exact original source/command bits and singleton MOVE bits; no owner/closure, empty fill.
- Four MOVE-only contours succeed with four singleton ranges; a fifth fails SourceLimit during decoding before emission. Original contour capacity still charges empty contours.
- Sixteen zero LINEs after MOVE succeed as collapsed fill; seventeen fail SourceLimit before emission. Existing cheap caps still precede this check.
- Frozen rounded A02 contours[(0,1),(2,nextUp(1))] and[(1,1),(1,nextUp(1))], both rules and all four closure forms: eight Rounded(TopologyAmbiguous) outcomes with rounded tolerance1, topology helpers skipped, rounded invoked, output absent. Preserve cancelled proof geometry. This explicitly tests policy-boundary rejection; it is not physical-budget success.
- Mixed preservation: MOVE-only before/after an exact integer-trisection cubic triangle retains UnsupportedSource; collapsed LINE before/after that triangle retains ZeroLengthLeaf. Constant CUBIC retains ZeroLengthLeaf. Existing short mixed/topology failures stay unchanged.
- Preserve cheap caps, malformed source, invalid flatten tolerance, truly empty PATH_EMPTY, decode limits, command-capacity rejection and rounded tolerance/work/output failures. For newly eligible empty fill, invalid rounded tolerance reaches the same existing Rounded error rather than publishing an empty result early.

Q04: exercise prior cubic success -> each meaningful new success/failure -> cubic recovery, truthful invocation flags/skipped helper statistics, no stale publication, caller-mutation retention, independent workspaces, zero attempt allocations and stable accounted heap/inline storage. Existing repeated-zero charging, signed-zero, rounded/canonical distinction and all nonmigrated cubic regressions remain. Update unit expectations only for precisely migrated all-LINE temporary failures; retain equivalent mixed/CUBIC failure controls so original safety/error tests are not deleted or weakened. The94-row protocol, independent position/topology/mesh oracles and release WASM identity remain unchanged.

## Ownership and validation

Primary owns contract, integration and acceptance. One GPT-5.6 Sol high worker owns the coupled `packages/geometry-wasm/kernel/src/cubic_fill.rs` and `native_cubic_fill_tests.rs` changes. A separate Sol medium reviewer checks stable source, ownership, eligibility and fixture evidence; Astra high reviews this prospective contract and any mathematical uncertainty. No parallel edits to shared lifecycle or test modules and no recursive delegation. New supplementary analytic fixtures need prospective Primary review before numeric execution, with source frozen and independently reviewed before tests.

Q05 validation: `pnpm test:geometry` (Rust fmt/Clippy, native tests, unchanged historical fixtures, independent WASM hashes and TypeScript oracle checks), bounded two-worker `pnpm check`, `pnpm build`, explicit changed-Markdown formatting/local-link checks, diff/scope review and required protected CI. No browser/GPU/benchmark or full P3 gate is claimed. Record source hashes, commands/results, corrections and remaining gates in the checkpoint evidence. Keep work in the existing private module; add no runtime dependency, helper framework or public transport.
