# P3.1b independent triangle-mesh invariant oracle

Status: prospective test-only contract, 2026-09-29. This slice follows the user's instruction to defer further stroke-bound refinement and move on. It depends on the [P3 plan](p3-fill-stroke-meshes.md) and the existing independent reference package, not on a frozen production mesh ABI or the deferred stroke experiment. It does not complete C03-C05 or authorize runtime meshes.

## Surface and scope

Add `packages/geometry-reference/src/triangle-mesh.ts` and export it through the existing test-only index. Reuse `Point` from `types.ts`. The plain test carrier is deliberately unrelated to a future WASM/GPU layout:

```ts
type TriangleMeshInput = Readonly<{
  vertices: readonly Point[];
  indices: readonly number[];
  bounds: readonly [minX: number, minY: number, maxX: number, maxY: number];
  expectedArea?: number;
}>;
type TriangleMeshIssue =
  | 'DEGENERATE_TRIANGLE'
  | 'REVERSED_TRIANGLE'
  | 'BOUNDS_MISMATCH'
  | 'OVERLAPPING_TRIANGLES'
  | 'AREA_MISMATCH';
type TriangleMeshInspection = Readonly<{
  valid: boolean;
  issue: TriangleMeshIssue | null;
}>;
function inspectTriangleMesh(input: TriangleMeshInput): TriangleMeshInspection;
```

Require ordinary arrays, finite two-coordinate vertices, finite ordered four-coordinate bounds, integer in-range indices and an index count divisible by three. At most 256 vertices and 256 triangles, inclusively; validate lengths before iteration. When supplied, expectedArea must be finite and nonnegative, interpreted as its exact represented binary64 value. Invalid input throws RangeError, including a malformed later vertex or index even when earlier geometry is wrong. No partial success, retained references, mutations, cache or cross-call state. Error-message text is not a contract.

After validating all input, return the first violated phase in this order: (1) zero or negative triangle signed area, scanning triangles in index order; (2) bounds fail to enclose any supplied vertex, including unused vertices; (3) positive-area triangle interior overlap, scanning pairs in lexicographic index order; (4) sum of triangle areas differs exactly from expectedArea, when supplied. A valid result has issue=null. An empty triangle list has area zero; unused finite vertices are allowed and still checked against bounds. Bounds need only enclose vertices, not equal their tight bounding box.

Positive signed orientation is the test carrier's mathematical x/y convention; it does not select GPU front-face/culling or the future transport convention. Shared edges, partial collinear edge contact, T-junction contact and shared vertices are allowed when interiors do not overlap. Reject duplicated triangles, strict containment and crossing overlaps even without any strictly contained vertex. No tolerance can merge a small overlap or make a zero-area triangle nondegenerate.

## Exact independent method and limits

Convert each finite binary64 coordinate to an exact BigInt integer in units of 2^-1074. Compute determinants, interval ordering and signed area exactly. No epsilon, Float64 determinant, sampling or production topology helper may decide an invariant. Basic conversion logic may follow the already reviewed line oracle; keep geometry predicates independent from any tessellator. No external dependency or general numeric framework is needed.

For each pair of positively oriented triangles, test the six edge supporting axes. Convex interiors are disjoint iff at least one edge line has all vertices of the other triangle on or outside that edge's exterior half-plane (orientation <=0). Equality allows boundary-only contact. Otherwise their interiors overlap. This separating-axis check includes identical/contained triangles and crossings without interior vertices. The finite caps imply at most 32,640 pairs and six edge tests per pair, each with three exact orientations; do not skip a pair by heuristic.

Sum positive twice-areas in integer units of 2^-2148. For expectedArea converted to integer A in units of 2^-1074, compare that sum to `2*A*2^1074`. Do not convert the accumulated area back to Number. Optional omission of expectedArea checks only structure/bounds/nonoverlap and must never imply area agreement.

This is an invariant checker, not complete region equivalence: equal area and disjoint triangles can cover the wrong region. Include a translated same-area carrier as a documented valid invariant-only example. Future region verification must separately use independent membership/boundary evidence. Cubics, stroke errors, paint attribution, coverage, stale ownership and binary ABI decoding remain outside this slice.

## Acceptance and validation

| ID  | Required evidence                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M01 | Literal square triangulations with both diagonals, disjoint triangles and empty output pass; exact optional area and loose bounds behave as specified.                                                                                          |
| M02 | Missing square triangle fails area; duplicated, contained and crossing triangles fail overlap; flipped and collinear triangles fail orientation. Verify the unmodified carriers first.                                                          |
| M03 | Shared edge/vertex, partial edge contact and T-junction contact pass; arbitrarily thin but represented positive overlap fails.                                                                                                                  |
| M04 | NaN/infinite vertices, malformed arrays/points/bounds, unordered bounds, fractional/negative/out-of-range indices and incomplete triples throw; later invalid data cannot be hidden by an earlier failed invariant.                             |
| M05 | Vertex and triangle limits and limit+1; signed zero; exact subnormal and huge-coordinate triangles whose ordinary determinants underflow/overflow; no input mutation or cross-call state.                                                       |
| M06 | Exact translation, power-of-two scaling, triangle permutation and reflection with corrected winding retain invariant results; deliberately wrong bounds and area reject. Same-area wrong-region example explicitly demonstrates the limitation. |

Freeze this contract before implementation. Sol high owns only `triangle-mesh.ts`; Terra medium owns only `tests/unit/geometry-triangle-mesh.test.ts` using independent literal expected outcomes. Primary owns contract, exports, documentation, integration and result interpretation, and reviews every worker result. No recursive delegation or shared-file editing.

Run focused `pnpm exec vitest run tests/unit/geometry-triangle-mesh.test.ts`, root `pnpm check` and `pnpm build`, explicit changed-Markdown formatting, local links/anchors and `git diff --check`. Record M01-M06 evidence and Primary review before checkpoint commit and protected PR/CI integration. Local native/WASM/browser/GPU/benchmark commands are NOT RUN for this test-only TypeScript change. P3.1b completion proves only these invariants; full P3.1 and production gates stay open.
