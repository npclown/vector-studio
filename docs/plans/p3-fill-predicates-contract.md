# P3.2a private fill predicate contract

Status: prospective implementation contract, 2026-09-29. The user's continued execution authorization permits this isolated private numeric building block after [P3.1c](p3-fill-region-oracle-contract.md). The [active plan](p3-fill-stroke-meshes.md) records the narrow dependency refinement. It is not complete tessellation, mesh transport or renderer entry. Further stroke-bound refinement remains deferred.

## Scope and private surface

Add `packages/geometry-wasm/kernel/src/fill_predicates.rs`. Reuse `crate::geometry::Point` without changing it. This module provides:

```rust
pub(crate) enum PredicateError { NonFinite }
pub(crate) enum SegmentRelation {
    Disjoint, Touch, ProperCrossing, CollinearPoint, CollinearOverlap,
}
pub(crate) fn orient2d(a: Point, b: Point, c: Point)
    -> Result<core::cmp::Ordering, PredicateError>;
pub(crate) fn point_on_segment(point: Point, start: Point, end: Point)
    -> Result<bool, PredicateError>;
pub(crate) fn segment_relation(a: Point, b: Point, c: Point, d: Point)
    -> Result<SegmentRelation, PredicateError>;
```

Greater means positive mathematical x/y orientation (counterclockwise), Less means clockwise, Equal means exact collinearity of represented binary64 values. Each entry validates every coordinate for finiteness first, including inputs to apparently degenerate/early-return cases. NaN/infinity returns NonFinite. Signed zeros are equal. No epsilon, rounded determinant, allocation, retained state, unsafe code or external dependency.

Point membership requires exact collinearity and inclusive coordinate bounds. A zero-length segment contains only its own point. Segment classification is symmetric under swapping segments or reversing either endpoint order. For two nondegenerate collinear segments, intersect their closed projected ranges: empty is Disjoint, one point is CollinearPoint, positive-length span is CollinearOverlap. A degenerate point on the other closed segment, including two equal points, is CollinearPoint; a point elsewhere is Disjoint. For noncollinear segments, strict opposite orientation signs on both sides give ProperCrossing; any endpoint lying on the other closed segment gives Touch (including a T-junction); otherwise Disjoint.

Do not construct intersection coordinates, sort arrangement events, triangulate, allocate meshes or change existing geometry behavior. P2 ABI v1, codec/engine/session/cache, public contracts and GPU paths remain unchanged. The private module is compiled but not yet called from P2: a narrowly scoped wasm-only dead-code allowance on its declaration is permitted until its future fill caller exists, matching the crate's existing native dead-code policy. Do not add public WASM exports merely to retain unused code. Release linking may remove the module.

## Exact bounded orientation

Decode finite f64 from IEEE bits into sign, unsigned significand M and exponent e. Normals have `M=2^52+fraction`, `e=rawExponent-1075`; subnormals have `M=fraction`, `e=-1074`. Zeros contribute nothing. Never take a signed integer absolute value or subtract extreme Float64 coordinates.

Evaluate the determinant as six signed products:

```text
ax*by - ay*bx + bx*cy - by*cx + cx*ay - cy*ax
```

Each unsigned significand product fits u128 (<2^106). Product exponents lie in [-2148,1942]. In integer units of 2^-2148, shift by exponent+2148 (0..4090). One term is <2^4196; even all six same-sign terms sum to <2^4199. Separate positive and negative accumulators, each `[u64; 66]` (4224 bits), therefore have at least 25 spare high bits. Fold operand signs and determinant coefficient into the chosen accumulator; compare arrays from high limb to low to determine the exact sign.

Shifted product insertion must avoid shift-by-64/128 and lost high words. Split into bounded unsigned pieces, propagate carries across at most 66 limbs and assert if carry escapes, which cannot occur for validated inputs under the above proof. Do not silently truncate on an internal defect. No adaptive retry or data-dependent growth. Segment operations use at most four orientation predicates plus exact finite coordinate ordering and degenerate-point checks. Fixed-size stack scratch is a reconstructible local calculation, not a new arena or document state.

## Independent fixture source

Add `tooling/generate-p3-fill-predicate-fixtures.mjs` and `tests/fixtures/p3-fill-orientation-v1.txt`. The generator uses exact BigInt integers in units of 2^-1074 and the independent difference formula `(bx-ax)*(cy-ay)-(by-ay)*(cx-ax)`, never the six-product limb implementation. Output rows contain six 16-digit hexadecimal IEEE bit patterns followed by expected sign -1/0/1; LF-delimited UTF-8 with fixed version/seed/count comment headers. No float determinant generates expected signs.

Freeze 16 literal orientation cases: unit positive/negative, diagonal collinear, duplicated first two points, all signed zeros, subnormal unit axes, positive max-finite axes, opposite max-finite corners, severe cancellation `(0,0),(2^52,2^52-1),(2^52+1,2^52)` and its reversal, mixed max/subnormal `(0,0),(MAX,MIN),(MAX,2*MIN)`, translated unit axes around `(2^52,2^52)`, repeated signed-zero points, horizontal max-finite collinearity, vertical subnormal collinearity, and `(0,0),(2^1000,2^-1000),(2^999,2^-1001)`. Their literal signs are `[1,-1,0,0,0,1,1,1,1,-1,1,1,0,0,0,0]`; check these before emitting.

Append 4096 random bit-pattern triples (six coordinates each) using xorshift32 seed `0x50333241`, updates `x ^= x<<13; x ^= x>>>17; x ^= x<<5`, each forced unsigned. For each coordinate use the next word as high bits, then the next as low bits. If the raw exponent is 2047, clear exponent bit 20 (giving 2046), retaining sign/fraction. Total 4112 rows. Store bits directly; expected signs come from the independent exact integer method. `--write` generates the owned fixture; default/`--check` regenerates in memory and requires byte equality. Unknown arguments fail. Record source/fixture hashes in evidence. This is correctness data, not a benchmark or product workload.

Primary extends the existing `pnpm test:geometry` runner to execute this fixture check before native tests, so required CI detects fixture drift. Native Rust tests consume the text without a dependency. Fixture generation does not import Rust, production geometry or the test-only arrangement implementation.

## Acceptance and ownership

| ID  | Required evidence                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P01 | All 4112 independent bit-pattern signs match; literal signs above independently checked; all six point permutations preserve/reverse sign as appropriate.                                                                                                                        |
| P02 | Inclusive point membership and all five segment relations, both endpoint orders/segment swaps; duplicate/zero-length/signed-zero, vertical/horizontal, near-collinear and extreme-scale literals.                                                                                |
| P03 | Nonfinite values in each point/coordinate position reject even when another point/segment is degenerate; finite inputs never return NonFinite.                                                                                                                                   |
| P04 | Exactly representable translations/power-of-two scales and axis reflection preserve expected relations; do not assume arbitrary rounded translations are ideal transforms.                                                                                                       |
| P05 | Existing thread-local allocation tracker observes zero allocations for repeated successful and error predicate calls, with fixture parsing/assertion formatting outside the tracked region. Carry/shift boundaries 0/63/64/127 and near the highest occupied limb are exercised. |
| P06 | Fixture byte regeneration, root Rust/native/WASM regression commands and unchanged P2 contracts; release build/export behavior remains compatible.                                                                                                                               |

Primary owns this contract, crate module/test wiring, runner integration, review and evidence. Sol high owns only `fill_predicates.rs`; a separate Sol medium worker owns the independent generator, text fixture and `fill_predicates_tests.rs`. Native test module is wired by Primary under cfg(test), so workers never edit shared lib/engine/codec files. No child delegation. A read-only Sol medium feasibility audit independently checked the bit capacity and recommended this small reusable topology seam rather than a full unreviewed tessellator.

Required validation: generator `--check`; `pnpm test:geometry` (pinned Rust fmt/Clippy/native tests, independent release WASM builds and existing Node/native differential suite); `pnpm check`; `pnpm build`; explicit changed-Markdown formatting, links/anchors, whitespace and Primary source/fixture review; protected PR/CI. Local browser/GPU/benchmark runs are NOT RUN because no exported runtime behavior changes. Acceptance proves only these predicates, not intersection-coordinate accuracy, tessellation, production path caps, the full ordinary P3 corpus or any final milestone gate.
