# P3.2p historical polygon segment-relation census

Status: FROZEN after Primary and independent Astra high mathematical/interface review, 2026-10-04, before implementation. Stable-source review and prospective supplementary fixture review precede numeric dispatch. The [active plan](p3-fill-stroke-meshes.md) owns execution. This is diagnostic tooling and observation, not curved topology certification, a capacity increase, benchmark or P3 gate.

## Purpose and checkpoint sequence

The immutable [P3.2m2 observation](../evidence/p3.2m2-cubic-readiness-2026-10-02/README.md) left881038654 prospective polygon pairs NOT_EVALUATED. Classify those recorded polygon relations to inform later arrangement/resource design. Reuse its native frames, authenticate each complete frame, and keep its runtime source identity separate from this analysis source identity. No current kernel run, continuous position proof rerun, simple/rounded cubic certificate, intersection-coordinate placement, mesh, renderer, browser/GPU, performance claim or deferred stroke work.

P3.2p1 implements the bounded classifier, independently implemented auditor, strict historical-frame reader and exclusive-output runner, then validates analytic/mechanics fixtures and protected CI. Only after p1 integration may P3.2p2 run the full observation on a new clean branch and archive its complete immutable journal/report/audit. No exploratory subset of the full corpus, new expected result selected from output, silent retry or post-result bound increase. Incomplete evidence is retained as incomplete.

Absence of polygon crossings cannot establish source-curve simplicity; polygon crossings cannot establish source-curve crossings. Counts describe the recorded carried polyline only. Neither successful observation nor any class distribution permits a runtime-cap change or product rejection rule.

## Historical input authentication and extraction

FULL accepts exactly the committed m2 directory `docs/evidence/p3.2m2-cubic-readiness-2026-10-02/` and read-only native input.bin/output.bin supplied through `--native-dir`. Pin its four source-record SHA256 values from the m2 README: invocation460b63483f0377832674bd9296400940d2c259c003e504df5938228cbd0763d6; census869c93b782d833cb6e28503bf4e80ee65155edfc6e68e5fe06c38af8d34cf803; rows e9536c9b8c51aa6bc5132692c8bb506b367da8e010ffbabd80e800b873a2d634; audit ba298dabe8306c233b105a7d25b29323b10962c23dd9e3d0d7e31070e081dd80. Authenticate bytes before trusting parsed records. Historical source HEAD is9508a6615f6b6e941aee26802a49eb9ca1b9dbd0, normalized manifest d443f5e5e18d5b60c11cb546cbaa15e36da5abec1bc8f58cd1df4f27b5507f0b, scenario p2-batch/v1, seed0x12345678,1000 paths x32 cubics, tolerance1/8, identity screen.

Regenerate sources with existing fullSources()/differentialCase()/encodeCase(), which do not execute proofs. Compare every complete input frame byte-for-byte to the regenerated frame and its committed SHA256, source identity and sourceSha256. Compare each complete output frame SHA256 with its committed row before decoding. Require all1000 rows, exact order/identities and EOF on both streams. Retain input/output file sizes and streaming SHA256; recorded files are1684000 and38612072 bytes. Before allocating payload buffers enforce input4096/output262144 bytes per frame and total input4MiB/output128MiB, as in m2. Native sources are never modified or copied into tracked evidence.

Use decodeOutput with the regenerated PackedPath source/tolerance. It validates canonical ABI, source echoes, finite values, command structure and provenance. Do NOT call verifyCase(), rowFromNative(), certifyCubicBoundary() or any preparation/topology oracle: those would rerun proofs outside this scope. Explicitly require batch status0, one OK path, initial MOVE only followed by LINE, at most4096 lines, at most128 per source and depth<=7; complete32-source partition/provenance and observed emitted/depth counts must match the authenticated m2 row. Source controls/command identity are historical, not a latest-source acceptance result.

Extract an emitted edge from the preceding ACTUAL carried point to each LINE endpoint, never by restarting at a cubic's canonical start. Preserve raw emitted index and sourceVerbOrdinal/endNumerator/depth. Emitted rawIndex is its original zero-based LINE index; closure rawIndex is rawEmitted. Append one synthetic last-to-MOVE closure iff mathematical endpoints differ, with a distinct closure identity and null source fields. Exact mathematical zero edges are omitted; +/-0 compare equal geometrically but original bits remain in provenance hashes/witnesses. Normalize before cyclic adjacency: retained indices i,j are adjacent iff j=i+1 or i=0,j=E-1, with i<j. Two-edge adjacency counts once; E<2 gives no pairs.

## Exact classification and bounded work

All pair inputs are finite nonzero segments. Use the exact binary64 common-grid integer conversion already available from test-only rounded-fill/exact.ts; no epsilon or ordinary floating determinant may decide a relation. Production classifier uses exact orientation signs and collinear interval comparison. It may first reject closed Float64 AABBs that are strictly disjoint; comparisons on finite input coordinates establish that rejection exactly. Enumerate pairs lexicographically i then j>i and retain no pair/contact collection.

The independent audit classifier uses segment-parametric determinant numerators/denominator and exact inclusive parameter comparisons, with its own parallel/collinear branch. It must not import the primary relation function, counts/witness reducer or candidate enumerator. It independently enumerates candidates using an x-interval index, sorts candidate second-edge indices for each first edge, and proves all omitted pairs disjoint by strict x/y interval comparisons. Temporary candidate/index storage is O(E), never quadratic. It reconstructs the same canonical pair order for the digest and first witnesses. Shared exact-number conversion, interface types, constants and canonical serialization are allowed; classification/aggregation decisions are not shared. No claims about JavaScript heap bytes: record logical peak edge/candidate records and caps only.

Classes are mutually exclusive; codes are fixed by the following order:

| Code | Class               | Exact meaning                                                           |
| ---- | ------------------- | ----------------------------------------------------------------------- |
| 0    | DISJOINT            | Empty segment intersection, including parallel noncollinear             |
| 1    | PROPER_CROSSING     | Nonparallel intersection with both parameters strictly inside(0,1)      |
| 2    | ENDPOINT_TOUCH      | Nonparallel intersection at endpoints of both segments                  |
| 3    | T_JUNCTION          | Nonparallel intersection at an endpoint of exactly one segment          |
| 4    | COLLINEAR_POINT     | Collinear overlap interval is a singleton                               |
| 5    | COINCIDENT_SAME     | Same two endpoints in the same direction                                |
| 6    | COINCIDENT_REVERSED | Same two endpoints in reverse direction                                 |
| 7    | COLLINEAR_OVERLAP   | Any other positive-length collinear intersection, including containment |

Limits:1000 paths,4096 raw emitted lines plus at most one closure,4097 normalized edges,8390656 pairs per path,8390656000 total possible pairs. All counts use checked nonnegative safe integers. Every finite authenticated polygon within these caps is completely classified, with no numerical-unresolved class. Invalid/nonfinite/zero pair input and exceeded caps fail before pair work; caller normalization is explicit. No intersection location/event multiplicity or winding/region assertion is made.

For each path require rawEmitted=omittedZero+retainedEmitted, normalizedEdges=retainedEmitted+closure, classified pairs=E(E-1)/2, adjacent+nonadjacent for each class=class total, and aabbRejected+exactTested=pairs. Both implementations report identical exactTested: the number of pairs whose closed x AND y boxes overlap, including pairs eventually found disjoint. Include explicit zero counts for every class. Track peakCandidateRecords separately by algorithm, not as an equal semantic result. Audit may determine the first AABB-disjoint witness by its own O(E^2) cheap numeric scan; it must not compute exact predicates on every excluded pair merely to obtain that witness. Its first DISJOINT witness is the lexicographic minimum of the excluded and exact-tested DISJOINT witnesses. Cache exact coordinate conversions per edge; determinant numerators need no reduced rational intersection coordinate.

## Frozen module interface and deterministic encoding

Files live under tests/p3-polygon-census/, separate from production and historical tools. `types.ts` owns plain test types/constants/serialization; `classifier.ts` owns primary classification/aggregation; `audit.ts` owns independent classification/aggregation; `transport.ts` owns authentication/extraction; `artifact.ts` and `census.test.ts` own runner records. The wrapper is tooling/run-p3-polygon-census.mjs with its declaration and vitest.p3-polygon-census.config.ts. No public exports, package script or dependency change.

Shared interface:

```typescript
type Point = readonly [number, number];
type Edge = Readonly<{
  rawIndex: number;
  kind: 'emitted' | 'closure';
  sourceVerbOrdinal: number | null;
  endNumerator: number | null;
  depth: number | null;
  start: Point;
  end: Point;
}>;
type Relation =
  | 'DISJOINT'
  | 'PROPER_CROSSING'
  | 'ENDPOINT_TOUCH'
  | 'T_JUNCTION'
  | 'COLLINEAR_POINT'
  | 'COINCIDENT_SAME'
  | 'COINCIDENT_REVERSED'
  | 'COLLINEAR_OVERLAP';
type Pair = readonly [number, number];
type RelationCounts = Record<Relation, number>;
type PairWitnesses = Record<Relation, Pair | null>;
type CarriedPath = Readonly<{
  verbs: Uint8Array;
  points: Float64Array;
  provenance: Uint32Array;
}>;
type NormalizedPath = Readonly<{
  edges: readonly Edge[];
  rawEmitted: number;
  omittedZero: number;
  retainedEmitted: number;
  closure: 0 | 1;
  normalizedEdges: number;
}>;
type Classification = Readonly<{
  edges: number;
  pairs: number;
  aabbRejected: number;
  exactTested: number;
  counts: RelationCounts;
  adjacent: RelationCounts;
  nonadjacent: RelationCounts;
  first: PairWitnesses;
  contactSha256: string;
  peakCandidateRecords: number;
}>;
// Independently implement in classifier.ts and audit.ts respectively:
// classifyPair(a: Edge, b: Edge): Relation; classifyEdges(edges: readonly Edge[]): Classification;
// auditPair(a: Edge, b: Edge): Relation; auditEdges(edges: readonly Edge[]): Classification;
// transport.ts: extractEdges(path: CarriedPath): NormalizedPath;
// audit.ts independently: auditExtractEdges(path: CarriedPath): NormalizedPath;
```

Every pair witness is the lexicographically first retained index pair of its class; null iff its count is zero. Retained edge array order is carried-stream order. SHA256 contact input begins UTF-8 `p3-polygon-contacts/v1\n`, followed for each NON-DISJOINT pair by a fixed18-byte tuple: u32LE retained i, u32LE retained j, u32LE first rawIndex, u32LE second rawIndex, u8 class code, u8 adjacency(0/1). Canonical edge digest starts UTF-8 `p3-polygon-edges/v1\n` then UTF-8 JSON.stringify of an array of explicit objects with keys rawIndex,kind,sourceVerbOrdinal,endNumerator,depth,startBits,endBits in that order; point bits are two lowercase16-hex IEEE754 strings preserving signed zero. The journal stores first witnesses expanded to `{pair, first: canonicalEdge, second: canonicalEdge}` in class order; auditors reconstruct these from frames.

## Runner, records and failure handling

CLI accepts exactly `--smoke` or `--full --native-dir <existing-directory> --output <fresh-directory-below-.tools>`. FULL requires clean nonignored worktree, current contract/tooling tracked at HEAD, Node24.15.0, all fixed historical hashes and complete frame authentication. No Rust invocation or ambient WASM requirement. Resolve actual output parents to keep exclusive creation below .tools; never overwrite an existing directory. Native input is read-only and output cannot overlap it. SMOKE runs only frozen analytic/mechanics controls, never a subset of historical1000 pairs.

Use isolated Vitest RUN and AUDIT phases. Per phase timeout900000ms, runner hard timeout per child960000ms; timeout/nonzero/incomplete journal records failure, never success. Full p2 may use the original local native directory or bit-identical reproduction; missing frames are a concrete blocking prerequisite, not permission to substitute latest-kernel bytes. Root checks cover new TypeScript source; add `--smoke` to required CI after implementation review.

Schema `p3-polygon-relations/v1`: invocation.json stores `{schema,mode,metadata,policy}`; report.json stores `{schema,mode,completion,metadata,policy,rows,summary,failure}`; audit.json stores `{schema,status,reportSha256,rowsSha256,rows,peakCandidateRecords,failure}`. Mode is SMOKE or FULL. Completion is COMPLETE only after every expected row and unchanged source manifest; failure null. Otherwise INCOMPLETE, summary null, concrete `{stage,message,index:null|number}`, with stage one of CLI,SOURCE,INPUT,OUTPUT,ABI,CLASSIFY,JOURNAL,WORKER,SUMMARY,AUDIT. Audit PASS only on independently derived complete equality, never on recorded counts alone. All files are created exclusively. Journal rows are individually newline-terminated, fsynced before counting complete; at most64KiB/row and64MiB total. Report rows descriptor is `{path:'rows.ndjson',sha256,bytes,count}`, adding mandatory `completePrefix:{bytes,count,sha256}` iff a partial tail exists; count always counts complete newline-terminated rows. Audit rows is the completed numeric count, peakCandidateRecords is the auditor's maximum `{value,index}` (null only on failed/empty audit). Preserve any partial tail and its complete-prefix count/hash; never truncate evidence.

Metadata separates `historical:{head,manifestSha256,invocationSha256,censusSha256,rowsSha256,auditSha256,inputBytes,outputBytes,inputSha256,outputSha256}` from `analysis:{head,dirty,nodeVersion,manifest:[{path,sha256}],manifestStartSha256,manifestEndSha256}`. Manifest includes tracked plus nonignored files under packages/geometry-reference/src, packages/geometry-wasm/src, tests/geometry/differential, tests/geometry/cubic-boundary, tests/p3-census, tests/p3-polygon-census, tests/geometry/rounded-fill/exact.ts, tests/geometry-benchmark/workload.ts; exact files tooling/run-p3-polygon-census.mjs, its.d.mts, vitest.p3-polygon-census.config.ts, package.json, pnpm-lock.yaml, tsconfig.json, tsconfig.base.json, eslint.config.mjs, .node-version and this contract. Exclude generated targets/caches and all .tools files; no symlink/junction traversal outside repository source. Normalize UTF-8 BOM/newlines and sort forward-slash paths like m2. Manifest digest is SHA256 of UTF-8 JSON.stringify(sorted entries). Start end hash is null; terminal end hash must equal start. Record known source identity only after verification; SMOKE uses historical:null.

Policy exact keys: `{role,scenario,seed,paths,classes,digestVersion,limits,timeoutsMs,excludedStages}`. Role is HISTORICAL_POLYGON_ANALYSIS (FULL) or ANALYTIC_SMOKE (SMOKE); scenario p2-batch/v1 or p3-polygon-smoke/v1; seed0x12345678 or null; paths1000 or4; classes is the fixed eight-name array, digestVersion1. Limits are `{rawEmitted:4096,edges:4097,pairsPerPath:8390656,paths:1000,inputFrameBytes:4096,outputFrameBytes:262144,inputBytes:4194304,outputBytes:134217728,rowBytes:65536,journalBytes:67108864}`; timeoutsMs `{phase:900000,child:960000}`; excludedStages exactly CURRENT_KERNEL,POSITION_PROOF,CURVED_TOPOLOGY,MESH,GPU,PERFORMANCE.

The row schema is `{index,nodeId,inputFrameSha256,outputFrameSha256,rawEmitted,omittedZero,retainedEmitted,closure,normalizedEdges,normalizedEdgeSha256,classification,witnesses}`. Classification is the exact interface above. Closure is0/1 after mathematical equality, never counted as an omitted emitted zero. Summary exact keys are `{rows,rawEmitted,omittedZero,retainedEmitted,closure,normalizedEdges,pairs,aabbRejected,exactTested,counts,adjacent,nonadjacent,maxima}`: scalar counts are totals, relation maps contain all eight keys; maxima is `{normalizedEdges,pairs,exactTested,peakCandidateRecords}`, each `{value,index}` with earliest-index ties. Summary is null for incomplete/empty observations, never an invented zero success. Counts plus first witnesses and contact/edge digests must match independent replay for EVERY path. PeakCandidateRecords is separately checked <=E, not compared between algorithms.

SMOKE observations contain exactly four rows in order: smoke/triangle ((0,0),(2,0),(0,2),(0,0)); smoke/bowtie ((0,0),(2,2),(0,2),(2,0), implicit closure); smoke/retrace ((0,0),(2,0),(0,0)); smoke/collapsed ((0,0),(0,0)). Each is MOVE(first listed point), LINE(each remaining listed point), so rawEmitted counts are3,3,2,1. Indices0..3, MOVE provenance[0,1,0], line ordinal1..N with numerator1/depth0. Input/output frame hashes are null only in SMOKE, since these are synthetic carried commands, not native frames. All coordinates use positive zero in these four rows. Historical:null, analysis dirty may be true. Unit-only negative/normalization fixtures below supplement these four rows without creating extra observation rows. Initial invocation metadata has historical:null pending authentication in RUN, in either mode. FULL INCOMPLETE reports may also have historical:null when authentication has not completed; COMPLETE FULL must contain the full authenticated historical metadata.

Audit authenticates historical records/frames and regenerates sources again, independently extracts carried edges and reconstructs counts/digests/witnesses/summary. DecodeOutput and immutable-source authentication may be shared, but primary edge-normalization function may not produce the audit's expected edges. Recompute report/journal byte hashes and reject missing/extra fields, wrong enums, non-safe counts, missing/duplicated/out-of-order rows, source drift, invalid terminal state, mismatched witnesses/digests/counts or trailing frames. No trusted summary reuse.

## Prospective acceptance and ownership

P01: final Primary/Astra high contract and interfaces review before implementation; stable-source review before numeric smoke/full dispatch. No full classification during p1.

P02 literal pair fixtures: base segment(0,0)->(2,0); disjoint parallel(0,1)->(2,1); crossing(1,-1)->(1,1); endpoint touch(2,0)->(2,2); T-junction(1,0)->(1,2); collinear point(2,0)->(3,0); same and reverse base; partial overlap(1,0)->(3,0); contained(1/2,0)->(3/2,0). Add vertical equivalents, parallel separated pairs with overlapping AABBs[(0,0),(2,2)]/[(0,1),(1,2)], box-boundary touch, and subnormal crossing base(0,0)->(2*Number.MIN_VALUE,0) with vertical(Number.MIN_VALUE,-Number.MIN_VALUE)->(Number.MIN_VALUE,Number.MIN_VALUE). Swap pair order/reverse directions: only SAME/REVERSED switches when exactly one segment reverses; other classes unchanged. Freeze explicit expected class and witnesses, never derive expectations from the other implementation.

P03 carrier controls: triangle(0,0),(2,0),(0,2), returning or implicit closure gives3 pairs/three adjacent ENDPOINT_TOUCH; bowtie(0,0),(2,2),(0,2),(2,0) plus closure gives6 pairs,4 adjacent ENDPOINT_TOUCH,1 nonadjacent PROPER_CROSSING,1 nonadjacent DISJOINT; retraced two-edge(0,0)->(2,0)->(0,0) gives1 adjacent COINCIDENT_REVERSED; fully collapsed gives0 pairs. Include repeated points/+/-0, adjacency across removed zeros/source boundaries, already-returning endpoint and carried-source-start mismatch (next edge starts at actual previous endpoint, not supplied canonical source p0). Hostile controls cover every class/count/witness/digest corruption, malformed finite/source/provenance/cardinality, exact caps/cap+1 before excess contents, altered/truncated/trailing frames, bad hashes, wrong row order/count, existing output, partial journal and analysis manifest drift. Implementation fixtures must keep these explicit outcomes; any additional analytic fixture requires prospective review before execution.

Literal first witnesses: triangle ENDPOINT_TOUCH[0,1]; bowtie ENDPOINT_TOUCH[0,1], PROPER_CROSSING[0,2], DISJOINT[1,3]; retrace COINCIDENT_REVERSED[0,1]; every absent class null. Signed-zero/removed-source-boundary control is MOVE(-0,0), LINE(0,-0), LINE(2,0), LINE(2,0), LINE(0,2), LINE(-0,0), ordinal1..5. It has rawEmitted5/omittedZero2/retainedEmitted3/closure0, retained raw indices[1,3,4], three adjacent ENDPOINT_TOUCH and first[0,1]. The first retained start retains(0,-0) bits from the actual preceding zero edge. Carried-source-start control is MOVE(0,0), source1 LINE(1,0), source2 LINE(1,1), source3 LINE(0,0). It forms the literal3-edge triangle above up to shape, with three adjacent ENDPOINT_TOUCH/first[0,1]. A hypothetical source2 canonical start(1+2^-52,0) is not an extractor input; assert the second edge starts with literal(1,0) bits and is continuous with the first. The extractor must depend only on carried commands/provenance. Source position proofs are not inferred from this control.

P04: all analytic/mechanics smoke controls, bounded two-worker pnpm check, pnpm build, explicit changed-Markdown formatting/local links/diff, Primary/independent review and protected CI. Existing pnpm test:geometry is required locally if shared native/ABI/oracle code changes; no such changes are planned. Existing baseline CI geometry checks remain in place and do not change this census's historical runtime identity. Full classification and GPU/benchmark tests are NOT RUN in p1; the new census runner never launches a kernel. p2 requires clean committed p1, the single full run+independent audit, immutable archive and evidence review before integration; observation completeness does not imply source-curve or runtime acceptance.

Primary owns documents, shared types/serialization, acceptance, source review and integration. After freeze, Sol high may own classifier/tests; a separate Sol high may own independent audit/tests without importing the primary algorithm; Sol medium may own disjoint transport/artifact/wrapper/config/mechanics files. No shared-file concurrent edits or recursive delegation. Freeze owners/hashes before numeric dispatch. All runtime resources, error budgets, public API/ABI, dependency directions and historical evidence remain unchanged.
