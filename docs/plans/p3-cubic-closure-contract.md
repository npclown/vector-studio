# P3.2i private cubic closure forms

Status: FROZEN after Primary and independent contract/fixture review, 2026-10-02, before implementation. Entry follows integrated P2.6f and [P3.2h](p3-native-cubic-workspace-contract.md). This implements already [approved visible closure semantics](p3-visible-semantics-proposal.md) inside the existing crate-private workspace. P3.2h's two endpoint-equality rejections were explicitly temporary preparation restrictions, not product policy. No public API, ABI, dependency, topology predicate, tolerance, work cap or stroke change is authorized.

## Four forms and ownership

Retain `MOVE CUBIC+ [CLOSE]`, four contours/16 cubics, cheap 24-verb/104-scalar caps, 72 flattened commands/64 owners, and all existing allocation/error/publication rules. LINE, empty/MOVE-only contours and all other previously unsupported forms remain unsupported. All P2 input/state/tolerance/empty and numeric error precedence remains inherited unchanged within the cheap caps.

Compare the last emitted point with the initial MOVE geometrically (+/-0 equal). A returning contour removes only its duplicate terminal point from collected polygon storage. Preserve all actual flattened commands and their source provenance. Do not deduplicate any zero-length cubic leaf; it retains its existing rejection.

| Endpoint relation | Canonical termination  | Collected polygon and final owner                                                                 |
| ----------------- | ---------------------- | ------------------------------------------------------------------------------------------------- |
| Returning         | explicit CLOSE         | Remove terminal duplicate; final owner remains CubicLeaf; no extra edge                           |
| Returning         | open, next MOVE or end | Same geometry and owner; no synthesized CLOSE command                                             |
| Nonreturning      | open, next MOVE or end | Retain terminal point; append existing ImplicitClosure { contour }                                |
| Nonreturning      | explicit CLOSE         | Retain terminal point; append ExplicitClose { source_verb } using the actual CLOSE global ordinal |

The private ExplicitClose owner must resolve to an actual source CLOSE on the current contour and correspond to that contour's final geometric edge. Implicit closure also belongs only to the final geometric edge. Returning explicit CLOSE remains a command with its own ordinal but contributes no additional zero-length edge. Contributor indices continue to identify the unchanged normalized source-edge sequence. Source cubic ordinals include all MOVE/CLOSE gaps in the actual input.

The existing simple-cubic topology certificate already constructs the same geometric closing segment for nonreturning source contours. Keep its algorithm and output unchanged; collected points/ranges and rounded input must still match it. The rounded fill algorithm and ledger do not depend on which canonical encoding supplied that segment. Screen/transport/public integration remain separate gates.

## Fixed validation before execution

Q01: Primary/independent source review of four-form normalization, source-ordinal mapping, final-edge ownership, unchanged precedence/caps and bounded publication. Only `cubic_fill.rs` and its thin native test adapter need code changes.

Q02: Preserve all original 94 serialized rows, controls, order, 92 successes/two sizing failures and independent TypeScript position/topology/rounded/mesh checks. For every row, construct a second canonical encoding by toggling the presence of CLOSE on every contour, without changing any coordinate bit or fill rule. Recompute source ordinals from that encoding. Execute alternate then original on the same workspace, each measured for zero allocation. For successes, compare exact collected point bits/ranges and complete rounded mesh, ledger and statistics; independently check each encoding's owners and decoded source ordinals against literal input traversal. Snapshot copies are test-owned and occur outside allocation measurement. For the two large-coordinate rows, retain the same sizing failure with no emission/topology/rounded publication. Emit only original output through the unchanged v1 JSON protocol. Assert both encodings remain within existing caps, including original C05's 72 commands versus alternate 68.

Q03: Literal raw canonical fixtures use exact linear cubic controls on a triangle: MOVE(0,0), CUBIC((1,0),(2,0),(3,0)), CUBIC((2,1),(1,2),(0,3)). Nonreturning forms stop here or CLOSE at ordinal 3. Returning forms add CUBIC((0,2),(0,1),(0,0)) and stop or CLOSE at ordinal 4. Each yields exact normalized triangle [(0,0),(3,0),(0,3)] with three owners under both fill rules, flatten tolerance 1/8 and rounded tolerance 1/16. First two owners are CubicLeaf ordinals 1 and 2 (dyadic endpoint 1/1, depth 0); final owner is CubicLeaf ordinal 3 for returning, ImplicitClosure contour 0 for nonreturning open, ExplicitClose ordinal 3 for nonreturning closed. Commands remain respectively 4,5,3,4 for returning open/closed and nonreturning open/closed. Preserve signed-zero source bits and geometric equality at returning endpoints. Exercise next-MOVE finalization with two disjoint translated copies (second triangle +9 in x), verifying second-contour ordinal shifts and closure owners independently.

Q04: The two original degenerate raw forms now proceed beyond decode: one A->B cubic plus explicit B->A closure, and two A->B->A cubics without CLOSE. Both have exactly two nonzero topology leaves, so require `Topology(Unresolved)` under the unchanged minimum-three-leaf rule. Assert sizing/emission/topology invoked, rounded not invoked, output None, and success -> each failure -> success with zero allocation. Retain their original exact controls and separate coverage for every other unsupported form. Preserve malformed/repeated CLOSE rejection through P2; test success -> invalid/repeated CLOSE, zero-length-leaf, command/source/rounded limit failures -> success with no stale mesh, forbidden stage invocation or per-attempt allocation. Keep original cap and work-limit fixtures. No result-selected input/expectation changes.

Q05: `pnpm test:geometry`, `$env:VITEST_MAX_WORKERS='2'; pnpm check`, `pnpm build`, exact unchanged release WASM hash/exports, explicit Markdown checks, local links and Primary/independent review before protected CI/integration. This unexported private operation has no release-WASM reachability change; browser/GPU/benchmark NOT RUN. P2.6f browser evidence remains tied to its source; this checkpoint makes no new browser/performance claim.

## Minimal ownership

One GPT-5.6 Sol high worker owns the coupled runtime module and native fixture adapter. A separate Sol medium reviewer audits contract and stable source read-only; Primary owns decisions, plans, evidence and integration. No extra TS protocol or duplicate composition implementation, no recursive delegation. Full C03-C05, LINE/mixed grammar, general topology, mesh transport/public scene/renderer and deferred stroke remain open.
