# P3.2c exact private event position comparison

Status: prospective contract, 2026-09-29. After [exact predicates](p3-fill-predicates-contract.md) and [certified placement](p3-fill-intersections-contract.md), compare symbolic endpoint/proper-crossing positions exactly. This is a private numeric building block inside existing Rust geometry ownership, not a document format, public API, rational mesh transport, event store, sweep or triangulator. The [active plan](p3-fill-stroke-meshes.md) owns status and narrow entry. Stroke-bound refinement remains deferred.

## Surface and semantics

Add `fill_event_order.rs`, reusing `geometry::Point` and P3.2a relation classification. Freeze crate-private Copy/Debug/PartialEq types and function:

```rust
enum FillEvent { Endpoint(Point), Crossing { a: Point, b: Point, c: Point, d: Point } }
enum EventError { NonFinite, NotProperCrossing }
fn compare_event_positions(left: FillEvent, right: FillEvent)
    -> Result<core::cmp::Ordering, EventError>;
```

First validate all coordinates of both events; any NaN/infinity returns NonFinite before any relation/classification. Then every Crossing must be exact ProperCrossing per P3.2a or return NotProperCrossing. Touch, overlap, collinear, disjoint and degenerate inputs cannot masquerade as proper crossing symbols; their existing endpoint events are constructed separately by a future caller. Endpoint coordinates only require finiteness. Signed zeros are equal.

Compare exact represented-input intersection positions lexicographically, x first then y. Equal means identical geometric positions even when source segments differ. Do not add a source-ID/order tie-breaker; future grouping must retain all contributing source identities. Reversing either segment, swapping crossing segments or exchanging comparison operands preserves equality/changes order as mathematically required.

This exact-only version deliberately has no interval fast path, tolerance, placement certificate or P3.2b call. A finite ProperCrossing whose Float64 placement is Unresolved can still be compared exactly; success here does not publish coordinates or certify placement/topology. No epsilon, representative-point sort, retry, retained cache or output allocation.

## Fixed exact arithmetic proof

Decode each finite binary64 coordinate to a signed integer X in units 2^-1074. Subnormal magnitude is its fraction; normal magnitude is `(2^52+fraction) << (rawExponent-1)`. Zero has canonical positive sign. Raw magnitude <2^2098 fits 33 u64 limbs. Split the shifted <=53-bit significand without shift-by-64 or truncation; the highest shift is 2045 and the top occupied limb is 32.

For endpoints A/B, homogeneous line coefficients are `L=(Ay-By, Bx-Ax, Ax*By-Ay*Bx)`. Direction magnitudes <2^2099 fit 33 limbs; constants <2^4197 fit 66. For two crossing lines L/M, calculate `H=L cross M`: Hx/Hy magnitudes <2^6297 fit 99 limbs, Hw magnitude <2^4199 fits 66. Exact ProperCrossing proves Hw != 0. If Hw is negative, negate all three signed magnitudes so W>0. Coordinates are Hx/Hw, Hy/Hw in the original integer units. Endpoint events use `(X,Y,1)` in that same representation.

Compare x by sign of `Hx_left*W_right - Hx_right*W_left`; if zero, compare y similarly. Each product <2^10496 and difference <2^10497, fitting 165 limbs (10560 bits), with 63 spare bits. No division, gcd, arbitrary growth or rounded Float64 construction is needed. This fixed exact scratch certifies relationships among Float64 inputs; it does not change the stored coordinate policy.

Keep signed-magnitude arithmetic module-private, instantiated only at 33/66/99/165 limbs. A small const-generic implementation with fixed arrays and used-length is permitted to avoid duplicating the same carry logic; it must not become a general exported integer framework. Canonical zero has used=0 and negative=false. Trim after subtraction; widening zero-fills and preserves sign. Same-sign add propagates carries; opposite-sign add subtracts smaller magnitude from larger. Negation changes only a nonzero sign. Specialized product call shapes are 33x33->66, 33x66 (or reverse)->99, and 99x66 (or reverse)->165. Schoolbook `u128(a*b)+existing_word+carry <= u128::MAX`; propagate terminal carry and assert if it escapes capacity. Subtraction must handle borrow without signed overflow. Proven-impossible zero denominators or capacity overflow assert rather than silently truncate; malformed geometry is rejected before construction.

All work/storage is bounded for one pair: fixed stack values and loops bounded by declared limb widths/used lengths, no heap, unsafe, dependency, hidden arena or state. Keep existing P3.2a code unchanged; a small private Float64 decoder in this module is acceptable to avoid refactoring validated predicate internals. This checkpoint makes no speed claim and selects no production path/event count limits.

Internal overflow controls may deliberately use an undersized multiplication output (33x33->33) to prove the assertion; production call shapes remain exactly those above. Other internal fixtures use the same 33/66/99/165 widths, including carry into the top comparison limb and multiple-word borrow propagation. Test-only impossible inputs do not change the semantic capacity proof or accepted geometry.

## Independent frozen corpus

Add `tooling/generate-p3-fill-event-fixtures.mjs` and `tests/fixtures/p3-fill-event-order-v1.txt`. Expected events use independent BigInt signed integers and the parametric intersection formula `A + cross(C-A,D-C)/cross(B-A,D-C) * (B-A)`, not homogeneous lines, fixed limbs, production imports or Number division. Exact rational x comparison, then y comparison supplies -1/0/1. Require every constructed crossing to be strict proper crossing with exact independent orientation tests.

Each LF UTF-8 row is `event | event | sign`. An endpoint is `P` plus two lowercase 16-digit IEEE hex fields; a crossing is `X` plus eight. Fixed version/seed/count headers; no row ID. Default/--check requires byte-identical regeneration; --write creates the owned fixture; unknown/multiple arguments reject. Primary adds --check to the geometry runner. Native tests parse exact token counts and require all expected signs; no frame/native output extension is needed for this enum result.

Freeze these 16 literal pairs, in order (C means Crossing; E means Endpoint; M=MAX finite, m=minimum subnormal, e=2^-52):

1. E(-0,+0) versus E(+0,-0): Equal.
2. E(1,2) versus E(2,-1): Less.
3. E(1,3) versus E(1,2): Greater.
4. E(2,2) versus C((0,0),(4,4),(0,4),(4,0)): Equal.
5. C((0,0),(1,1),(0,1),(1,-1)) versus C((0,1),(1,-1),(-1,1),(1,0)): Equal at (1/3,1/3).
6. C((0,0),(1,1),(0,1),(1,-1-e)) versus the unperturbed third event from row 5: Less.
7. E(1,0) versus C((1,0),(1,1),(0,0),(3,1)): Less, identical x.
8. E(0,0) versus C((0,0),(m,m),(0,m),(m,0)): Less.
9. The half-subnormal crossing from row 8 versus E(m,m): Less.
10. C((-M,-M),(M,M),(-M,M),(M,-M)) versus E(0,0): Equal.
11. E(-M,0) versus E(M,0): Less.
12. C((0,0),(0,4),(-1,1),(1,1)) versus C((0,0),(0,4),(-1,2),(1,2)): Less, identical x.
13. E(m,0) versus E(-m,0): Greater.
14. C((-M,m),(M,2m),(0,m),(0,3m)) versus E(0,m): Greater, identical x.
15. X-reflected row 6 (negate every x in both events): Greater.
16. C((-M,-M),(M,M),(-M,M),(M,0)) versus C((-M,-M),(M,M),(-M,M),(M,-M/2)): Greater (M/3 versus M/7). This exercises high homogeneous product limbs, not only cancellation to zero.

Append 256 endpoint pairs then 256 proper-crossing pairs, using one continuous xorshift32 state seeded `0x50333243` (<<13, >>>17, <<5, force unsigned after each). Endpoint phase: four coordinates per row; each consumes high word then low word; raw exponent 2047 clears high-word exponent bit20, preserving sign/fraction. Crossing phase: each event consumes five words with `tx=(w1%256)-128`, `ty=(w2%256)-128`, `w=1+w3%64`, `h=1+w4%64`, `k=1+w5%64`, and segments `(tx,ty)-(tx+w,ty+h)` / `(tx,ty+h)-(tx+w,ty-k)`. Consume ten words per pair with no reset/filtering. Verify each event's separate analytic formula `(tx+w*h/(2h+k),ty+h*h/(2h+k))` in integer units before emitting. Total 528 rows. Literal signs are independently asserted before writing.

For row 6, exactly prove both coordinates of both events lie strictly between the midpoints adjacent to Float64 bits `3fd5555555555555`; they therefore round to the same nearest representative, but exact ordering is Less. A deliberately representative-only equality control must disagree with the exact expected order. No fixture expected sign may come from production output.

## Acceptance and ownership

| ID  | Required evidence                                                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E01 | All 528 independent literal/seeded pairs match, and event-swap antisymmetry holds. Exercise all eight segment-order permutations per Crossing (Cartesian product when both are crossings), preserving bit-independent exact position order.                                                                           |
| E02 | All six pairwise crossing symbols of four concurrent lines y=x, y=1-2x, y=(1-x)/2 and y=4x-1 compare Equal at (1/3,1/3). Use segments (0,0)-(1,1), (0,1)-(1,-1), (-1,1)-(1,0), (0,-1)-(1,3). Also endpoint/crossing equality and equal-x/different-y cases.                                                           |
| E03 | Near-coincident representative collision control rejects representative equality; min-subnormal and near-MAX exact comparison succeeds even when placement cannot. Exactly represented scale/translation/reflection fixtures preserve expected order; include a crossing at (2^52+1/2,2^52+1/2) against E(2^52,2^52). |
| E04 | NaN/+infinity/-infinity in every coordinate of both variants reject before nonproper crossing checks; disjoint/touch/collinear/overlap/point crossings reject as NotProperCrossing on either operand. No output or panic for malformed geometry.                                                                      |
| E05 | Internal literal carry/borrow/sign-zero/widen/shift and high-limb product checks, including bounded-overflow assertion controls; existing allocation tracker observes zero allocations across repeated endpoint/crossing/equal/error comparisons.                                                                     |
| E06 | Fixture regeneration, pinned Rust fmt/Clippy/native tests, reproducible WASM and existing P2 differential/adapter regressions, root check/build and unchanged export surface.                                                                                                                                         |

Primary owns contract, lib/runner wiring, review and evidence. Sol high owns only `fill_event_order.rs` including internal arithmetic tests; independent Sol medium owns generator/corpus/`fill_event_order_tests.rs`; separate Sol medium performs read-only audit. No child delegation or overlapping worker files. Narrow module dead-code allowance follows earlier uncalled P3 slices; no P2 caller/export changes. Before implementation, the independent audit confirmed exact-only separation, all width proofs, the collision/concurrence cases and signed-carry obligations; Primary rechecked them.

Validation: generator --check; `pnpm test:geometry`; `pnpm check`; `pnpm build`; changed-Markdown format/links, whitespace, Primary review and protected CI. Browser/GPU/benchmark NOT RUN for the isolated unexported helper. Full P3 C03-C05 remain open: exact position order alone does not split edges, attribute winding, group source identities, preserve emitted mesh connectivity or satisfy ordinary full-path acceptance.
