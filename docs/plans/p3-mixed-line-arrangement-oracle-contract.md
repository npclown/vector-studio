# P3.1h explicit LINE-kind arrangement oracle

Status: FROZEN after Primary, independent Astra high mathematical and Sol medium engineering/interface review on2026-10-05, before implementation or numerical execution. This test-only prerequisite prepares a separately identified mixed-source topology certificate. The [active plan](p3-fill-stroke-meshes.md) owns execution. Existing [P3.1g](p3-transverse-arrangement-contract.md), [P3.2t](p3-transverse-cubic-composition-contract.md) and [P3.2u](p3-nonlinear-transverse-composition-contract.md) entry points, accepted/rejected sets and runtime behavior remain unchanged. Native mixed-source adoption requires a later contract; this checkpoint adds no runtime source, public API/ABI, dependency, tolerance/cap change or deferred stroke work.

## Source meaning and proof

Add test-only `certifyMixedTransverseCubicArrangement(contours, sourceKinds, limits?)`, returning the existing TransverseArrangementResult. Contours use existing CubicTopologySegment descriptors. sourceKinds is a required dense boolean array, one entry per supplied source descriptor in contour/source order. true explicitly declares a genuine affine LINE A+t(B-A); false retains the original cubic meaning. Never infer LINE from repeated control points. A marked descriptor stores mathematical [A,A,B,B], with A!=B and exactly one full depth0/end1 leaf. This four-point storage is an explicitly tagged adapter representation, not a claim that the LINE follows the stationary cubic parameterization.

A true LINE has source derivative B-A. Its transverse cone therefore contains [B-A, actualChord], using the existing strict two-generator case. Hull, endpoint-sweep, per-leaf monotonicity and adjacent common-projection obligations remain unchanged. An unmarked stationary cubic with the same controls keeps all three cubic differences, including zero endpoint generators, and retains the old sufficient-condition rejection. Source LINE and implicit closure remain distinct input identities even though their derivative cones share a formula. Genuine LINE positional error is exactly zero once original endpoints/full-leaf identity match; do not pass its adapter controls to the cubic matched-parameter positional oracle. Unmarked cubics retain the independent P3.1d proof where positive fixtures require it.

All matching, complete i<j pair coverage, charge order, crossing signs/order, maximum one partner per leaf, output publication and corresponding-face winding conclusions are inherited without relaxation. This is not general intersection-order support or a product rejection envelope.

## Validation order and shared seam

Keep prepareTopologyInput unchanged. It owns invalid limits, declared caps, structure and complete generic provenance checks. Extract the remaining prepareRoundedTopology suffix into a private helper accepting successful preflight data and optional already validated kind data. The old wrapper passes no kinds. The new wrapper first calls the same preflight, then validates the entire kind-array structure and all marked source shapes, then calls the suffix. Source-final equality, leaf/closure construction and minimum-contour checks retain their existing order. Do not duplicate generic preflight or introduce a callback framework.

Kind validation has no leaf/pair work and returns0/0 on failure. Check array type, exact total-source length, dense own entries and primitive boolean values for the whole sidecar before inspecting marked shapes in source order. A marked descriptor must have equal mathematical points0/1 and2/3, distinct endpoints and exactly one full source leaf. Generic preflight already proves full partition/provenance, so a valid two-leaf marked source is INVALID_INPUT, while malformed provenance retains earlier INVALID_PROVENANCE. Shape/zero-line failures are INVALID_INPUT. A valid marked descriptor whose actual final endpoint differs from B reaches existing KNOT_MISMATCH after all kind validation. Signed zero compares mathematically; copied original polygon bits are preserved. No zero source is removed here and marks never index original verb ordinals.

At marked source-leaf construction, use sourceDifferences=[B-A]; unmarked leaves use existing cubic differences. Genuine closure construction stays separate. Share the existing transverse pair loop and publication in one private function used by both public test-only wrappers. No additional output fields, fabricated orientation/nesting, line normalization, inference, native mask, retained cache or new resource budget is introduced. All existing4-contour/16-source/64-leaf/2016-pair and arithmetic limits remain.

## Seven frozen positive fixtures

Use the exact N and R sources in P3.2u, with one depth0/end1 actual chord per source. A marked source replaces its descriptor controls by[A,A,B,B] and retains its original source verb ordinal and actual endpoint. N has eight sources; R has seven sources plus a genuine nonzero closure. All unmentioned kinds are false. Use source ordinals1..8 for N and1..7 for R unless specified below. Reflection/translation maps every source control and actual point.

| ID                 | Source and marks                                                                                                       | Expected leaves/pairs | Ordered crossing records |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------ |
| line-cubic         | N, mark source0; source4 remains genuinely nonlinear                                                                   | 8/28                  | (0,4,-1)                 |
| line-line          | N, mark sources0 and4                                                                                                  | 8/28                  | (0,4,-1)                 |
| line-closure       | R, mark source3                                                                                                        | 8/28                  | (3,7,+1)                 |
| reflected          | Apply F(x,y)=(12-x/2,-8+y/2) to line-cubic                                                                             | 8/28                  | (0,4,+1)                 |
| packed-ordinals    | line-cubic with original source ordinals2..9                                                                           | 8/28                  | (0,4,-1)                 |
| two-closures       | Two line-closure contours, second translated(+30,0); ordinals1..7 and9..15; flat marks3 and10                          | 16/120                | (3,7,+1),(11,15,+1)      |
| marked-signed-zero | line-cubic translated(+3,+3); first A=(-0,-0), first repeated control=(+0,+0), final returning source endpoint=(+0,+0) | 8/28                  | (0,4,-1)                 |

Expected polygons are literal B/R, their declared exact transforms, and both translated R polygons in input order. Signed-zero first polygon point must retain both negative-zero bits; the mathematically equal final(+0,+0) produces no extra closure. Two R contours have disjoint x ranges[-3,3] and[27,33], so all cross-contour pairs are disjoint. Marks3/10 map to original source ordinals4/12 and output leaves3/11, demonstrating separate source/verb/leaf identities. Packed-ordinals does not claim canonical zero-LINE normalization; it checks only descriptor-order alignment.

For each positive, compare the old entry and new entry with allfalse marks: both must be UNRESOLVED with equal full result. Their first rejection counts are8/4 for line-cubic,line-line,reflected,packed-ordinals,marked-signed-zero;8/22 for line-closure;16/46 for two-closures. True kinds must certify the literal polygon bits and crossing records. R pair(3,7) is inspection7+6+5+4=22; two-contour pair(3,7) is15+14+13+4=46.

Additionally reuse every row from fixedNativeTransverseArrangementFixtureRows (39 rows, including signed-zero) as pure test data. With allfalse kinds the new result must deepEqual the old entry, preserving24 Certified/2 KnotMismatch/13 Unresolved and all counters/findings/output. Do not import a registering test or execute a native emitter for this comparison.

## Frozen rejecting and precedence controls

Start from line-cubic unless specified. All preflight/kind/final failures below have leaves0/pairs0 and no certificate. Keep each isolated mutation separate:

- Non-array kinds, short/long sidecar, a sparse hole or nonboolean entry: INVALID_INPUT; finding identifies source kinds.
- Mark the unchanged nonlinear source4 in addition to valid source0: INVALID_INPUT; finding identifies marked LINE shape.
- Prefix a mathematically zero marked descriptor at A before the original N contour (all eight N kinds false), with source ordinals1..9 and a valid one-leaf partition: INVALID_INPUT for a zero marked LINE. Do not use a disconnected zero replacement that would fail generic structure instead.
- Replace marked source0's one leaf with a valid two-leaf partition ending at midpoint(0,0), then B, depth1/end1,2: INVALID_INPUT for marked LINE full-leaf shape.
- Change marked source0's actual final x by+1/16, retaining source controls: KNOT_MISMATCH.
- Earlier wrong final endpoint plus later invalid marked source4 shape: INVALID_INPUT, proving global kind checks precede source-final checks.
- Earlier invalid marked shape plus later malformed source7 provenance: INVALID_PROVENANCE, proving global generic provenance precedes kind checks.
- Invalid kinds plus maxCubics7 against eight sources: existing WORK_LIMIT. Invalid maxPairs=-1 plus invalid kinds: existing INVALID_LIMITS. Use the existing limit field names and validators without introducing aliases.
- An earlier invalid marked shape and later nonboolean kind: INVALID_INPUT finding must identify kind-array structure, proving the entire sidecar is structurally checked first.

Freeze one geometric rejection under true kinds: M=[(-9,0),(9,0),(9,9),(-3,9),(-3,-3),(3,-3),(3,6),(-9,6)], eight marked full affine LINE descriptors including return. Complete build has8 leaves; the second partner is rejected at pair inspection5, UNRESOLVED8/5, without partial output. No all-LINE runtime shortcut is involved in this direct sufficient-condition oracle.

Owned output copies must survive caller mutation and later calls. Check positive -> malformed -> positive recovery at the pure function boundary, sign/index/polygon-bit corruption against frozen expectations, and all old oracle suites. Do not weaken old expectations or decide expected counters from execution.

## Ownership and validation

Primary owns this contract, active plan, acceptance interpretation and integration. Sol high may own only tests/geometry/simple-cubic-topology/oracle.ts. Sol medium may independently own new tests/geometry/mixed-line-arrangement/fixtures.ts and tests/unit/geometry-mixed-line-arrangement.test.ts. Both use this fixed interface and corpus; no recursive delegation, runtime files, dependencies, commits or numerical execution before Primary/independent stable-source clearance. Independent Astra high reviews the proof, global validation precedence and stable sources.

H01: Full contract and literal/precedence review frozen before implementation; stable source hashes and review before numerical execution.
H02: Seven positives, allfalse counterparts,39 old-row parity, isolated invalid/precedence/matching controls, signed-zero bits, source identity and owned output pass independent assertions.
H03: Focused new and existing cubic/rounded/transverse oracle suites, full pnpm test:geometry (shared oracle regression), bounded two-worker pnpm check, pnpm build, explicit Markdown/link/diff checks, Primary/independent evidence review and protected CI.

No native mixed-source adoption, public API/ABI, GPU/browser, benchmark/full census or deferred stroke work. General depth-positive crossings, source-boundary rounding, multiple-partner order, larger capacities and full P3 gates remain open. Historical P2 A08 FAIL/latest-source performance UNVERIFIED remain unchanged.
