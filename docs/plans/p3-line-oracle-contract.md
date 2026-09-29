# P3.1a independent line-fill oracle contract

Status: frozen before test-only implementation, 2026-09-29. This is an independently reviewable subset of P3.1 under the user's continued-work authorization and approved [visible behavior](p3-visible-semantics-proposal.md). The [P3 plan](p3-fill-stroke-meshes.md) still gates production geometry on the complete private contract and independent verification. This slice adds no runtime geometry service, mesh ABI, dependency or renderer integration.

## Test-only surface and ownership

Add `packages/geometry-reference/src/line-fill.ts`, exported through that test-only package's existing index. Reuse its `Point = readonly [number, number]` type. Freeze this surface:

```ts
type LineFillRule = 'nonzero' | 'evenodd';
type LineFillLocation = 'inside' | 'outside' | 'boundary';
function classifyLineFill(
  contours: readonly (readonly Point[])[],
  query: Point,
  rule: LineFillRule,
): LineFillLocation;
```

Each contour is an ordered list of straight-segment vertices. Implicitly connect the last vertex to the first for fill, including originally open contours. This API deliberately has no cubic/stroke/mesh meaning. Empty contours and isolated points contribute no region; exact repeated vertices and zero-length edges do not introduce boundaries. Do not mutate/retain caller arrays or create cross-call state.

Require a valid rule, finite two-component query/vertices, at most 256 contours and at most 256 total input vertices (count repeated points before normalization). Malformed shape, nonfinite data or limit excess throws RangeError. These are bounded test-oracle limits, not product document/mesh limits. Validate all input before returning any classification, including an otherwise empty/cancelled region. Error-message text is not a contract; every invalid case is an explicit failure, never a classification that can accidentally pass verification.

## Exact membership and resolved boundary

Interpret every finite binary64 coordinate as its exact represented dyadic value; no epsilon, decimal rounding, `Math.atan2` sorting or Float64 determinant may decide topology. A suitable private implementation converts each coordinate to a BigInt integer in units of `Number.MIN_VALUE`, directly from IEEE sign/exponent/mantissa bits. All orientation/range comparisons then use exact integer arithmetic. This is test infrastructure; it does not authorize or prescribe BigInt/arbitrary-precision production geometry.

For an off-source-edge point, independently compute signed winding and crossing parity using a horizontal ray and half-open y intervals. Do not import the archived slab experiment, geometry-wasm or a future tessellator. Shared declarative Point types are allowed; production topology helpers are not.

The result describes the resolved filled region, not just proximity to an input segment. At a point on source edges, inspect the open angular sectors separated by all incident nonzero edge rays. Sort/deduplicate directions by exact half-plane/cross comparisons. Evaluate winding/parity at an infinitesimal displacement into each sector with lexicographic signs of constant and first-order terms; do not pick a finite perturbation that can jump across a nearby feature. Both filled and unfilled sectors means boundary; all filled means inside; all unfilled means outside. The isolated line of a zero-area contour is outside. Source multiplicity, orientation and cancelled shared edges must retain their winding effects.

This definition classifies an outer square edge/corner as boundary, the shared span of adjacent filled squares as inside, a same-oriented nested contour under nonzero as inside, and a completely cancelled contour as outside. At a bowtie crossing, filled and unfilled sectors coexist, so it is boundary. It does not prove continuous cubic boundary error, triangle coverage or antialiasing.

## Acceptance fixed before implementation

| ID  | Required fixture/evidence                                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L01 | All closed fill cases F01-F07/F09-F11 in the private draft, both rules, explicit inner/outer/boundary/cancelled samples and reversed contour order; use literal expected classifications                                               |
| L02 | Approved F08 open triangle samples: (1,1) inside; (6,6) and (-1,1) outside; (4,4) on the drawn diagonal and (0,4) on the implicit closing edge. Both boundary points and an explicit repeated closing vertex preserve classification   |
| L03 | Resolved boundaries: F07/F11 shared-edge interior; inner edge of F02 inside for nonzero/boundary for evenodd; duplicate opposite contours including source-edge points outside; bowtie center boundary; touching outer vertex boundary |
| L04 | Empty/MOVE-only/collinear/retraced contours, repeated points, zero and signed-zero coordinates; no artificial filled or boundary region                                                                                                |
| L05 | Binary64 precision: subnormal squares (sides of multiples of Number.MIN_VALUE), huge finite squares whose Float64 determinant would overflow, and points one representable step around an edge; no epsilon-based merging               |
| L06 | Exact dyadic metamorphisms: translation, power-of-two scale, axis reflection, reversal of every contour and contour permutation preserve expected region classifications for both rules; source inputs remain unchanged                |
| L07 | Invalid rule/shape/nonfinite query or any vertex and both contour/vertex limit boundaries. Malformed later contours cannot be ignored after an earlier match                                                                           |
| L08 | Positive controls: deliberately change hole winding/fill rule, omit a hole, remove implicit closure in a counterexample, or use source-edge-as-boundary classification; independent fixed expectations must reject each wrong answer   |

For L05, use explicit representable constructions rather than an approximate decimal ideal: a square from (0,0) to (8m,8m), query (4m,4m), m=Number.MIN_VALUE; a square from (-1e300,-1e300) to (1e300,1e300), query (0,0); and binary-exact edge neighbors near x=1. Include empty-region and boundary cases at these scales. Finite input conversion cannot silently lose the subnormal or sign information.

For L06 use literal integer polygons, translations (32,-16), scales 2 and 0.5, reflection x -> -x, and both traversal/order reversals. Do not use a seeded result generated by this oracle as its own expectation. Positive controls are verification tests against wrong classifications; no production mutation or test-specific implementation branch is allowed.

Validation commands: focused `pnpm exec vitest run tests/unit/geometry-line-fill.test.ts`, then `pnpm check` and `pnpm build`, explicit changed-Markdown formatting, local link/anchor and whitespace checks. Primary must review exact binary conversion, sector construction at collinear/opposite rays, boundary cancellation, limits and the worker fixtures before acceptance. GPU/browser/native-WASM/benchmarks are NOT RUN because this slice changes only the independent TypeScript oracle. Required protected CI still applies.

## Delegation and completion boundary

One Sol high worker owns only `line-fill.ts`; one Terra medium worker owns only `tests/unit/geometry-line-fill.test.ts` using this frozen surface and literal expectations. Primary owns index wiring, documentation, integration, review and command-result interpretation. Workers do not edit shared files or delegate further. If the exact sector algorithm is uncertain, escalate before changing this definition or substituting sampling/epsilon behavior.

Completion means L01-L08 have actual passing evidence and protected integration. It completes only P3.1a line membership, not P3.1 continuous/mesh/stroke oracles, P3.0b C03-C05, or any runtime P3 acceptance criterion. Archive observations from earlier experiments remain immutable.
