# P3.1c independent line-fill region equality oracle

Status: prospective test-only contract, 2026-09-29. Follows [P3.1a line membership](p3-line-oracle-contract.md) and [P3.1b mesh invariants](p3-mesh-oracle-contract.md). The [active plan](p3-fill-stroke-meshes.md) owns entry; stroke-bound refinement remains deferred. No production tessellation, numeric budget, ABI, public API or renderer decision is introduced.

## Test surface and meaning

Add `packages/geometry-reference/src/fill-region.ts`, exported by the existing test-only index:

```ts
type LineFillMeshInput = Readonly<{
  contours: readonly (readonly Point[])[];
  rule: LineFillRule;
  mesh: TriangleMeshInput;
}>;
type LineFillMeshInspection = Readonly<{
  valid: boolean;
  issue: TriangleMeshIssue | 'REGION_MISMATCH' | null;
}>;
function inspectLineFillMesh(input: LineFillMeshInput): LineFillMeshInspection;
```

Reuse the existing test-only types, not a new transport schema. Source contours are implicitly closed for fill, with the approved nonzero/evenodd semantics. Empty/isolated/zero-area/retraced contours contribute no filled region. Compare the regularized filled regions (closures of filled open cells), not every source edge. Canceled shared edges are not holes; isolated source segments are not visible filled regions.

Validate source object/ordinary array shapes, a supported rule and finite two-coordinate vertices before geometry. At most 256 contours and 32 total source vertices, counting repeated points before normalization. Validate the complete mesh through `inspectTriangleMesh`, retaining its RangeError behavior and invariant issue. Then enforce `sourceVertexCount + mesh.indices.length <= 32` before returning an invariant issue or constructing events. This counts all source vertices and all triangle edges, including repeated/zero contributions; it is a bounded oracle-carrier limit, not a product limit. The mesh's existing unused-vertex/bounds and optional expectedArea semantics remain unchanged. Full malformed-input validation must not be hidden by a source/mesh region mismatch.

After validation, return an existing mesh invariant failure first. Otherwise compare the regions exactly and return REGION_MISMATCH on the first disagreeing open cell; success has issue=null. No approximate equality, epsilon or tolerance. Inputs and caller arrays remain unchanged and are not retained. Message text is not a contract.

## Exact arrangement verification

This is a verifier over a supplied mesh, not a tessellator. Do not import/copy the archived topology spike or any production topology implementation. Independently implement reduced BigInt rational operations and direct half-open ray winding/parity. Sharing existing mesh invariant validation and declarative types is allowed; do not convert rational query points to Number or call a Number-only point oracle on rounded representatives.

Interpret finite binary64 coordinates exactly (including subnormals and signed zero). Build source directed edges and triangle directed edges; omit only exact zero-length edges after counting input limits. Empty/one-point source contours have no edges. Every other source contour implicitly closes. All accepted triangle interiors are positive and disjoint by P3.1b.

Build exact x events from every segment endpoint and every intersection of two nonparallel closed segments. Use exact determinant/range tests, including endpoint intersections. Parallel/collinear overlap changes only at endpoint events, so no invented perturbation is needed. Sort/deduplicate rationals exactly.

For every consecutive distinct x pair, choose the exact rational midpoint. Intersect that vertical line with every active nonvertical segment; sort/deduplicate all exact y crossings from both source and mesh. Choose one exact y midpoint in each consecutive distinct pair, plus representatives one exact local unit below/above the extremes. Compare source winding/parity against the triangle-edge nonzero winding at every such point. If a slab has no crossings, both finite regions are empty there. Regions outside the first/last x event are empty. Traverse slabs left-to-right and y cells bottom-to-top. No finite grid or random sampling replaces a cell.

Why this is sufficient: no endpoint or edge intersection is inside an open x slab, so edge order and membership are constant on every open cell between successive edge graphs. The exact midpoint represents that entire cell. Source and triangle regularized polygonal regions are closures of their filled two-dimensional cells, so agreement on all cells also determines event-column boundaries. Checking event-line source multiplicity alone would incorrectly expose canceled edges. This does not establish continuous cubic error or the topology of approximate Float64 output relative to an unflattened curve.

At most 32 segments imply 496 unordered pair checks, at most 64 endpoint plus 496 intersection x entries before deduplication, at most 559 slabs and at most 33 y cells per slab. Therefore at most 18,447 cell checks, each scanning at most 32 source/mesh edges combined. Arithmetic uses fixed finite binary64 inputs and nonrecursive rational constructions; no adaptive subdivision, retry or cap increase. Early mismatch may stop; success must exhaust all cells. Literal input caps are checked before geometry enumeration, so no late truncation can become success.

## Acceptance fixtures

Freeze before implementation. Expected meshes are literal analytic decompositions, never produced by this verifier or the archived spike. Small helpers may expand literal rectangles into their two known triangles.

| ID  | Required evidence                                                                                                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R01 | F01 square with both diagonals, F02 same-oriented nesting (solid for nonzero/ring for evenodd), F03 reversed inner ring, F04 duplicate and F05 opposite cancellation under both rules. Ring mesh has eight triangles and exactly 32 combined input units.                         |
| R02 | F06 bowtie as two lobe triangles; F07 adjacent squares; F08 implicit closure; F09 repeated point/contour permutation; F10 overlap under both rules and reversed second contour; F11 partial shared span. Exact meshes agree despite source/internal edges.                        |
| R03 | Equal-area translated mesh, omitted/extra hole, wrong fill rule, missing triangle and duplicated overlapping triangle all reject for the appropriate region/invariant reason. Correct carriers pass first. Include equal-total-area gap plus extra region, not only changed area. |
| R04 | Non-dyadic intersection coordinates from dyadic source edges; rational cell representatives without binary64 rounding; tiny represented gaps/overlaps, subnormal and huge coordinate fixtures; empty/isolated/retraced source.                                                    |
| R05 | Translation, power-of-two scaling, reflection with corrected triangle orientation, source traversal and contour/triangle permutations preserve meaning; no input mutation/state retention.                                                                                        |
| R06 | Invalid source shape/rule/nonfinite values, malformed later source/mesh data, source/contour/combined limits and limit+1; malformed data before region checks, mesh invariants before region mismatch.                                                                            |

R04 non-dyadic intersections may use cancellation cases with known empty output, so tests never round a required rational mesh vertex into Number and then demand exact equality. Include the crossing contours `(0,0),(3,1),(0,2)` and `(1,-1),(2,3),(3,-1)`, each paired with its reversed contour; both rules yield empty despite rational intersections. This is an arithmetic/event fixture, not the only crossing acceptance case.

## Ownership, validation and limits

Primary owns this contract, exports, review and integration. Sol high first audits the proof/contract, then owns only `fill-region.ts`; Terra medium owns only `tests/unit/geometry-fill-region.test.ts`, using independent expected regions. No recursive delegation or new dependencies. Escalate actual ambiguity instead of substituting approximate classification.

Run focused `pnpm exec vitest run tests/unit/geometry-fill-region.test.ts`, `pnpm check`, `pnpm build`, explicit changed-Markdown formatting, local links/anchors and `git diff --check`. Primary reviews exact intersections, collinear cases, winding at rational representatives, zero-dimensional exclusions, bounds and false-success paths. Record R01-R06 evidence before commit and protected CI/PR integration. Local native/WASM/browser/GPU/benchmark runs are NOT RUN for this test-only TypeScript slice. Full P3.0b/P3.1/runtime gates remain open; this checker has a small frozen carrier envelope and no performance claim.
