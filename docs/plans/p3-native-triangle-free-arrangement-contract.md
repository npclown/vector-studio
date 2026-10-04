# P3.2x native triangle-free arrangement helper

Status: FROZEN after Primary, Astra high and Sol medium full-contract review on2026-10-05 before implementation. The [active plan](p3-fill-stroke-meshes.md) owns execution. This is the private native counterpart of [P3.1i](p3-triangle-free-arrangement-contract.md), extending the existing [mixed helper](p3-native-mixed-line-arrangement-contract.md). No canonical CubicFillWorkspace adoption, public API/ABI, dependency, cap/tolerance, arithmetic, old-entry semantics or deferred stroke change.

## Private interface, proof and ownership

Add crate-private `TransverseArrangementWorkspace::certify_triangle_free(input: TopologyInput, source_kinds: &[bool])`. Reuse the exact I theorem: injective leaves, persistent unique transverse pairs, complete endpoint/adjacent separation, and triangle-free crossing graph exclude crossing-order exchanges and preserve corresponding face winding/parity under spatial transport. This is not fixed-coordinate membership, sorted event output, positional error or mesh/coverage acceptance. Rejecting every crossing triangle remains conservative.

Keep all retained fields/layout: rounded workspace as sole Vec owner, partners[64], crossings[32], crossing_len and published. No graph matrix, new retained flags, new allocation, new input/output field or inferred source kind. Defaults/ceilings stay4 contours/16 supplied cubics/64 total leaves/2016 pairs/depth20/1MiB retained heap. Resource values remain exactly224256 heap and2512 inline bytes. Constructor and actual-capacity accounting are unchanged. Each certify allocates0.

Share the existing mixed attempt body through a private matching/triangle-free policy: begin/reset, full rounded generic preflight, exact required kind length and all marked shapes, source-final/build/minimum suffix, then existing local[bool;64] packed-source-to-leaf map. Construct that map in place; do not return/copy it by value. Old certify and certify_mixed retain their precise matching behavior. No input/kind borrow survives a call.

In the shared pair loop, leave complete i<j charge-before-inspect, cyclic adjacency, hull rejection, generator selection and borrowed transverse certificate untouched. After a proved crossing, matching retains left-partner-before-right-partner failures, existing capacity guard and partner writes. Triangle-free scans only borrowed crossing prefix records for a common neighbor. Triangle returns Unresolved before the publication-cap guard; if32 records already exist, return WorkLimit before appending the33rd. Graph comparisons do not charge geometric pairs. Append remains shared. No partner-slot read/write is needed in the new mode; common begin_attempt may still clear it for unchanged lifecycle.

Every attempt resets publication, crossing length and inner counters/logical state before validation. Any failure publishes None, including after a successful32-record result or a partially accumulated graph. Only complete coverage copies actual ordinary starts and publishes the point/range/crossing view. Preserve negative-zero bits. Saved owned copies, independent workspaces and subsequent recovery remain isolated.

No arithmetic predicate changes: grid2^-1134, Signed34/Signed68 and existing restriction/derivative/hull bounds remain authoritative. Native graph scans add only borrowed references/indices/booleans to the inherited local64bool and exact-predicate scratch. Review source-level nonrecursive helper scratch including arguments/results/construction copies below32KiB; do not claim compiled stack-frame or whole-call-chain bounds.

## Frozen42-row carrier and shared seams

In exact order: eight I positives and three I controls, IDs `new/${id}`; then the31 Certified rows selected from the existing53-row mixed carrier, retaining its original order and IDs (seven `mixed/` H positives followed by24 `legacy/` positives). Expect39 Certified,2 Unresolved,1 WorkLimit. Inherit source controls, provenance, actual endpoint bits, explicit kinds, literal polygon/crossing output and counters unchanged. I controls retain7/13,7/13 and16/81; the32-crossing positive retains16/120. Never derive expected status/output from native or oracle results.

New header `# p3-native-triangle-free-arrangement-v1`, exact `# rows 42`, env `P3_NATIVE_TRIANGLE_FREE_ARRANGEMENT_INPUT`, emitter `triangle_free_arrangement_tests::emit_triangle_free_arrangement`, frames `P3_NATIVE_TRIANGLE_FREE_ARRANGEMENT_BEGIN/END`. Reuse required-kinds native reader, exact existing grammar/echo and unchanged54-row/512KiB/4-16-64 capacities. Every row requires one canonical kinds line. Existing300s native timeout and32MiB output cap remain. No production transport.

Primary owns the following shared test seams:

- Move the existing mixed fixture's kinds-token helper without behavior changes to `topologyInputTokensWithKinds(id, contours, sourceKinds)` in native-topology/fixtures.ts; both carriers reuse it. Retain exact supplied-kind/source-count equality, existing error text and insertion of exactly `kinds <count> <bits...>` immediately before the final `end`. Legacy input_tokens and encoding remain byte-identical.
- In native-transverse-arrangement/native.ts, share output/envelope parsing behind an explicit private matching/triangle-free policy. Old parseNativeTransverseArrangementRow/Value wrappers retain matching; add parseNativeTriangleFreeArrangementRow/Value wrappers for the new transport. New mode permits repeated partners but rejects triangles by bounded existing-list scan; preserve <=32 records, finite points, contour partitions, index bounds, strict lexicographic pair uniqueness/order, exact fields/signs and complete certified counters. Do not weaken the old parser.
- Wire only the new cfg(test) Rust module in lib.rs.

Output schema remains id,input_tokens,status,leaves,pairs,output,allocations,allocated_bytes,inline_bytes and existing points/contours/crossings shapes. Failures must have null output. All42 rows require literal plus independent I-oracle status/counter/output comparison, exact echoed token identity and0 allocations/unchanged storage. For the31 inherited positive rows also compare complete I result with the old mixed oracle; new multiple-partner cases intentionally do not claim old parity.

Freeze corruption controls: missing/extra/duplicate/reordered row identities, wrong/missing BEGIN/END markers, wrong header/count, missing or invalid kinds syntax/echo, status/null mismatch, wrong counters, polygon signed-zero bit, invalid ranges/extra fields, crossing sign, valid-but-wrong index, duplicate/reordered pairs,33-record output, and a triangle under the new parser. Named faults must reach their intended validator. Existing matching parser must still reject a valid new star's repeated partner; new parser must accept cap32's higher degree/four-cycles. Corrupted literal outputs must be rejected by actual verification paths, not tautological object comparisons. Required-kinds malformed input must fail in the native parser before emitter markers, with nonzero exit and the actual stage-specific stderr substring: header, row count, kinds tag/token count/declared count/canonical bit, or row end as applicable. Existing old transport corruption suites remain unchanged.

## Native units, limits and lifetime

Use I literals for the small star, reflected/reversed, implicit closure, explicit mixed/all-LINE/nonlinear variants and cap32/overflow/two triangles, with exact inherited quarter controls for unmarked straight sources. Native transport covers all42 rows; direct native units focus on mode distinction, boundaries and lifecycle rather than duplicating every source ledger.

Freeze same limits:

- Star inclusive2/7/7/21 succeeds; maxContours1/maxCubics6/maxLeaves6 return WorkLimit0/0; maxPairs20 returns7/20,0 returns7/0.
- Implicit star supplies5 sources; maxLeaves6 returns6/0 at final closure and7 succeeds.
- cap32 succeeds16/120 with32 records; maxCubics15 returns0/0, maxPairs119 returns16/119.
- overflow maxPairs80 returns16/80 before pair81;81/default returns16/81 at record33 with no output.
- Both triangles maxPairs12 returns7/12;13/default returnsUnresolved7/13.
- Old matching star7/6, reverse7/14, triangles7/3 and both cap16/9 restrictions remain.

Require short/long kinds, noncanonical marked source or otherwise-valid multi-leaf marked source, malformed/nonfinite/duplicate/connectivity input to yield InvalidInput0/0; malformed provenance yields InvalidProvenance0/0. Complete these generic checks before earlier source-final mismatch, which yields KnotMismatch0/0 before graph work. Preserve ordered validation; never alter expectations to fit runtime. The serialized I controls map exactly to Unresolved7/13/null, Unresolved7/13/null and WorkLimit16/81/null, including explicit WORK_LIMIT-to-WorkLimit conversion in independent verification.

Under default limits, test cap32 success -> invalid input/kind/provenance/knot/triangle/partial-crossing overflow -> cap32 recovery. Pair exhaustion uses a separate fixed max_pairs119 workspace: star success7/21 -> cap32 WorkLimit16/119 -> star recovery. A119-pair workspace cannot first certify cap32; do not mutate workspace limits. Pin the stationary-cubic regression to inherited H line-cubic: marked success8/28 -> old certify on the same unmarked adapters Unresolved8/4 -> marked recovery. Also alternate old/mixed/triangle-free calls, use independent workspaces, mutate input/kinds after calls and preserve saved owned output bits/crossings through subsequent calls. Measure allocation count0 for attempts and unchanged heap/inline values. Existing constructor/extreme arithmetic/old lifecycle suites remain authoritative and unchanged.

## Ownership and acceptance

Primary owns contract/plan/evidence, shared TS parser/token seams and lib wiring, integration and final review. Sol high owns only simple_cubic_topology.rs and new triangle_free_arrangement_tests.rs. Sol medium owns only new native-triangle-free-arrangement/fixtures.ts and native-triangle-free-arrangement.test.ts. Astra high independently reviews full proof/literals/storage, stable source and evidence. No recursive delegation or worker commits; shared seams are stabilized before dependent parallel work.

Freeze fixture exports `fixedNativeTriangleFreeArrangementFixtureRows()` and `encodeNativeTriangleFreeArrangementFixture(rows)`. New `NativeTriangleFreeArrangementFixtureRow` reuses the existing mixed row fields through `Omit<NativeMixedLineArrangementFixtureRow, 'expectation'>` plus readonly `expectation: 'Certified' | 'Unresolved' | 'WorkLimit'`. Do not widen the old expectation alias. Both parser wrappers return the existing NativeTransverseArrangementRow schema, whose common status already includes WorkLimit.

X01: full Primary/independent written contract freeze before implementation, then stable source/hash/scratch/transport review before first numerical dispatch.
X02: private native helper satisfies unchanged storage/old modes, frozen limits/precedence, atomic publication and0-attempt-allocation lifecycle.
X03: all42 rows match literal and independent proof, required corruption controls and old transports remain passing.
X04: pinned fmt/Clippy/full `pnpm test:geometry`, bounded two-worker `pnpm check`, `pnpm build`, unchanged independently built release WASM identity, explicit Markdown/links/diff checks, final evidence review and required protected CI/PR integration.

Preserve any failed observation; diagnose without tuning frozen sources/expectations/tolerances/caps. Local GPU/browser/benchmark/full census are not required. Canonical mixed composition adoption is the following separately contracted checkpoint. Public mesh/coverage, larger capacities and complete P3 remain open; historical P2 A08 FAIL/latest-source performance UNVERIFIED and user-deferred stroke remain unchanged.
