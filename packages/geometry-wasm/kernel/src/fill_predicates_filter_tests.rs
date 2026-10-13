//! B0R unit U3 oracles for the binary64 orientation filters in `fill_predicates`: F0.2, F0.3 and
//! F1 (docs/plans/p3-b0r-kernel-performance-contract.md sections 3.5, 3.6 and 7: O1, O2, O8).
//!
//! Every filtered entry is compared with a `cfg(test)` copy of its pre-U3 routine, whose
//! orientations run through the unchanged exact accumulator only.
//!
//! The full-size run is an `#[ignore]` test in the release profile, run by
//! `pnpm test:p3-fill-identity`; the ordinary tests are the smoke versions and the fixtures.
use core::cmp::Ordering;
use std::time::Instant;

use crate::fill_filter::{counts, reset_counters, with_fault, Fault, FilterId};
use crate::fill_filter_tests::{parallel, pow2, share, Rng, ORACLE_SHARDS};
use crate::fill_predicates::{
    b0r_reference_orient2d, b0r_reference_point_on_segment, b0r_reference_segment_relation,
    orient2d, point_on_segment, segment_relation,
};
use crate::geometry::Point;

const IDS: [FilterId; 3] = [
    FilterId::PredicateOrientIdentity,
    FilterId::PredicateOrient,
    FilterId::SegmentBoxes,
];

fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}

fn scaled(value: Point, factor: f64) -> Point {
    point(value.x * factor, value.y * factor)
}

/// The filtered entries under test.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Predicate {
    Orient,
    PointOnSegment,
    SegmentRelation,
}

pub(crate) const PREDICATES: [Predicate; 3] = [
    Predicate::Orient,
    Predicate::PointOnSegment,
    Predicate::SegmentRelation,
];

/// The filtered or the reference result of one tuple, as its debug text.
fn evaluate(predicate: Predicate, points: [Point; 4], reference: bool) -> String {
    let [a, b, c, d] = points;
    match (predicate, reference) {
        (Predicate::Orient, false) => format!("{:?}", orient2d(a, b, c)),
        (Predicate::Orient, true) => format!("{:?}", b0r_reference_orient2d(a, b, c)),
        (Predicate::PointOnSegment, false) => format!("{:?}", point_on_segment(a, b, c)),
        (Predicate::PointOnSegment, true) => {
            format!("{:?}", b0r_reference_point_on_segment(a, b, c))
        }
        (Predicate::SegmentRelation, false) => format!("{:?}", segment_relation(a, b, c, d)),
        (Predicate::SegmentRelation, true) => {
            format!("{:?}", b0r_reference_segment_relation(a, b, c, d))
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct PredicateTally {
    pub(crate) cases: u64,
    pub(crate) disagreements: u64,
    /// (decided, fallback) per filter of `IDS`, for the filtered calls.
    pub(crate) filters: [(u64, u64); 3],
}

impl PredicateTally {
    pub(crate) fn merge(&mut self, other: Self) {
        self.cases += other.cases;
        self.disagreements += other.disagreements;
        for (slot, value) in self.filters.iter_mut().zip(other.filters) {
            slot.0 += value.0;
            slot.1 += value.1;
        }
    }
}

/// A random point with coordinates mixing magnitudes 2^-60 to 2^60, signs, signed zeros,
/// subnormals and small integers.
fn random_point(rng: &mut Rng) -> Point {
    point(rng.finite(-60, 60), rng.finite(-60, 60))
}

fn nudge(value: f64, rng: &mut Rng) -> f64 {
    let mut value = value;
    for _ in 0..rng.below(4) {
        value = if rng.chance(1, 2) {
            value.next_up()
        } else {
            value.next_down()
        };
    }
    value
}

/// A point near the line through `a` and `b`: `a + t (b - a)` in binary64, then up to three ulp
/// steps on one coordinate. This family produces the inputs on which stage A is closest to its
/// error bound.
fn near_line(rng: &mut Rng, a: Point, b: Point) -> Point {
    let t = (rng.next_u64() >> 11) as f64 * pow2(-53) * 6.0 - 3.0;
    let base = point(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y));
    if rng.chance(1, 2) {
        point(nudge(base.x, rng), base.y)
    } else {
        point(base.x, nudge(base.y, rng))
    }
}

/// A moderate point with a random significand and exponent in -5..=5 (the near-line base).
fn moderate_point(rng: &mut Rng) -> Point {
    point(rng.scaled_in(-5, 5, true), rng.scaled_in(-5, 5, true))
}

/// Exactly collinear lattice points on a line of slope p/q, times a power of two.
fn lattice_line(rng: &mut Rng, count: usize) -> [Point; 4] {
    let slopes = [
        (1.0, 3.0),
        (1.0, 1.0),
        (-2.0, 5.0),
        (7.0, 3.0),
        (0.0, 1.0),
        (1.0, 0.0),
    ];
    let (p, q) = slopes[rng.below(slopes.len() as u64) as usize];
    let origin = point(rng.below(64) as f64 - 32.0, rng.below(64) as f64 - 32.0);
    let factor = pow2(rng.range_i32(-40, 40));
    let mut points = [point(0.0, 0.0); 4];
    for slot in points.iter_mut().take(count) {
        let k = rng.below(33) as f64 - 16.0;
        *slot = scaled(point(origin.x + k * q, origin.y + k * p), factor);
    }
    points
}

fn adversarial_tuple(predicate: Predicate, rng: &mut Rng) -> [Point; 4] {
    let mut points = match rng.below(9) {
        // Stage A near its bound.
        0 | 1 => {
            let a = moderate_point(rng);
            let b = moderate_point(rng);
            let c = near_line(rng, a, b);
            let d = near_line(rng, a, b);
            [a, b, c, d]
        }
        // Exactly collinear lattice points, optionally perturbed by ulps.
        2 | 3 => {
            let mut points = lattice_line(rng, 4);
            if rng.chance(1, 2) {
                let index = rng.below(4) as usize;
                points[index] = point(nudge(points[index].x, rng), nudge(points[index].y, rng));
            }
            points
        }
        // Shared points and point segments.
        4 => {
            let mut points = [
                random_point(rng),
                random_point(rng),
                random_point(rng),
                random_point(rng),
            ];
            let from = rng.below(4) as usize;
            let to = rng.below(4) as usize;
            points[to] = points[from];
            points
        }
        // Touching boxes: a coordinate shared exactly between the two segments.
        5 => {
            let a = random_point(rng);
            let b = random_point(rng);
            let mut c = random_point(rng);
            let d = random_point(rng);
            if rng.chance(1, 2) {
                c.x = b.x;
            } else {
                c.y = a.y;
            }
            [a, b, c, d]
        }
        // Huge coordinates around F1's guard and beyond, up to the overflow range.
        6 => {
            let mut points = lattice_line(rng, 4);
            if rng.chance(1, 2) {
                points[2] = moderate_point(rng);
            }
            let factor = pow2(rng.range_i32(440, 960));
            points.map(|value| scaled(value, factor))
        }
        // Tiny coordinates around the 2^-900 product floor, and subnormals.
        7 => {
            let mut points = lattice_line(rng, 4);
            if rng.chance(1, 2) {
                points[3] = moderate_point(rng);
            }
            let factor = pow2(rng.range_i32(-1000, -420));
            points.map(|value| scaled(value, factor))
        }
        // Near points: ulp neighbours of one point.
        _ => {
            let a = random_point(rng);
            [
                a,
                point(nudge(a.x, rng), nudge(a.y, rng)),
                point(nudge(a.x, rng), nudge(a.y, rng)),
                random_point(rng),
            ]
        }
    };
    // Signed zeros: flip the sign of zero coordinates.
    if rng.chance(1, 8) {
        for value in &mut points {
            if value.x == 0.0 {
                value.x = -value.x;
            }
            if value.y == 0.0 {
                value.y = -value.y;
            }
        }
    }
    if predicate == Predicate::Orient && rng.chance(1, 4) {
        points.swap(rng.below(3) as usize, 3);
    }
    points
}

/// O1 differential of one predicate: `random` random and `adversarial` adversarial tuples.
pub(crate) fn differential(
    predicate: Predicate,
    seed: u64,
    random: u64,
    adversarial: u64,
) -> PredicateTally {
    let mut rng = Rng::new(seed);
    let mut tally = PredicateTally::default();
    for index in 0..random + adversarial {
        let points = if index < random {
            [
                random_point(&mut rng),
                random_point(&mut rng),
                random_point(&mut rng),
                random_point(&mut rng),
            ]
        } else {
            adversarial_tuple(predicate, &mut rng)
        };
        reset_counters();
        let filtered = evaluate(predicate, points, false);
        for (slot, id) in tally.filters.iter_mut().zip(IDS) {
            let (decided, fallback) = counts(id);
            slot.0 += decided;
            slot.1 += fallback;
        }
        let exact = evaluate(predicate, points, true);
        tally.cases += 1;
        if filtered != exact {
            tally.disagreements += 1;
            if tally.disagreements <= 3 {
                eprintln!(
                    "B0R O1 disagreement {predicate:?} {points:?}: filtered {filtered}, exact {exact}"
                );
            }
        }
    }
    reset_counters();
    tally
}

fn fraction(part: u64, whole: u64) -> f64 {
    if whole == 0 {
        0.0
    } else {
        part as f64 / whole as f64
    }
}

/// Runs `action` and returns its value with the (decided, fallback) counts of one filter.
fn counted<T>(id: FilterId, action: impl FnOnce() -> T) -> (T, (u64, u64)) {
    reset_counters();
    let value = action();
    let result = counts(id);
    reset_counters();
    (value, result)
}

/// Asserts the filtered orientation equals the exact one and reports whether F1 decided.
fn orient_case(a: Point, b: Point, c: Point) -> (Ordering, bool) {
    let (value, (decided, fallback)) = counted(FilterId::PredicateOrient, || orient2d(a, b, c));
    let value = value.expect("finite");
    assert_eq!(
        Ok(value),
        b0r_reference_orient2d(a, b, c),
        "{a:?} {b:?} {c:?}"
    );
    assert_eq!(decided + fallback, 1, "F1 runs once after F0.2");
    (value, decided == 1)
}

#[test]
fn b0r_o1_smoke_binary64_predicates() {
    for (offset, predicate) in PREDICATES.into_iter().enumerate() {
        let tally = differential(predicate, 0x4230_5231_5300 + offset as u64, 10_000, 1_000);
        assert_eq!(tally.disagreements, 0, "{predicate:?} {tally:?}");
        // Decided controls: random inputs are mostly decided by F1.
        let (decided, fallback) = tally.filters[1];
        assert!(
            fraction(decided, decided + fallback) > 0.8,
            "{predicate:?} {tally:?}"
        );
    }
}

/// O2: exactly collinear triples on a slope-1/3 line, at several scales and offsets, are exact
/// zeros: F1 cannot decide them and the exact routine runs.
#[test]
fn b0r_o2_collinear_slope_one_third_falls_back() {
    for exponent in [-400, -60, -1, 0, 1, 30, 60, 400, 497] {
        let factor = pow2(exponent);
        for (offset_x, offset_y) in [(0.0, 0.0), (3.0, 7.0), (-12.0, 5.0)] {
            let a = scaled(point(offset_x, offset_y), factor);
            let b = scaled(point(offset_x + 3.0, offset_y + 1.0), factor);
            let c = scaled(point(offset_x + 9.0, offset_y + 3.0), factor);
            let (value, decided) = orient_case(a, b, c);
            assert_eq!(value, Ordering::Equal);
            assert!(!decided, "an exact zero always falls back: 2^{exponent}");
            assert_eq!(point_on_segment(b, a, c), Ok(true));
        }
    }
}

/// O2: one-ulp perturbations above and below such a line are decided only when the bound
/// allows; every case agrees with the exact routine, and the closest ones fall back.
#[test]
fn b0r_o2_one_ulp_perturbations_of_collinear_triples() {
    let mut fallbacks = 0;
    for k in [2.0, 5.0, 33.0, 1000.0, 65_537.0] {
        let a = point(0.0, 0.0);
        let b = point(3.0, 1.0);
        let on = point(3.0 * k, k);
        for c in [
            point(on.x, on.y.next_up()),
            point(on.x, on.y.next_down()),
            point(on.x.next_up(), on.y),
            point(on.x.next_down(), on.y),
        ] {
            let (value, decided) = orient_case(a, b, c);
            assert_ne!(value, Ordering::Equal);
            fallbacks += u32::from(!decided);
        }
        // Offset lines: the differences no longer cancel exactly.
        let a = point(0.1, 0.7);
        let b = point(a.x + 3.0, a.y + 1.0);
        let c = point(a.x + 3.0 * k, (a.y + k).next_up());
        assert_eq!(
            orient2d(a, b, c),
            b0r_reference_orient2d(a, b, c),
            "offset k={k}"
        );
    }
    assert!(fallbacks >= 10, "{fallbacks} of 20 one-ulp cases fell back");
}

/// O2: F1's guard. Inputs at 2^500 and below are filtered; beyond it, and when the products'
/// sum is below 2^-900, the exact routine runs even for well-separated triples.
#[test]
fn b0r_o2_f1_guard_bounds() {
    let triple = [point(0.0, 0.0), point(1.0, 0.0), point(0.0, 1.0)];
    let case = |exponent: i32| {
        let [a, b, c] = triple.map(|value| scaled(value, pow2(exponent)));
        orient_case(a, b, c)
    };
    // Decided controls inside the guard.
    for exponent in [-440, -400, 0, 400, 499, 500] {
        assert_eq!(case(exponent), (Ordering::Greater, true), "2^{exponent}");
    }
    // Beyond the input guard, up to the largest finite scale.
    for exponent in [501, 600, 1000, 1023] {
        assert_eq!(case(exponent), (Ordering::Greater, false), "2^{exponent}");
    }
    // Products below the 2^-900 floor, through the subnormal range.
    for exponent in [-451, -500, -1000, -1074] {
        assert_eq!(case(exponent), (Ordering::Greater, false), "2^{exponent}");
    }
    // Mixed: one huge coordinate among small ones.
    let (_, decided) = orient_case(point(0.0, 0.0), point(pow2(501), 1.0), point(1.0, 3.0));
    assert!(!decided);
    // Subnormal coordinates with a well-separated, normal determinant are guarded too.
    let tiny = f64::from_bits(3);
    let (value, decided) = orient_case(point(tiny, 0.0), point(1.0, 0.0), point(0.0, 1.0));
    assert_eq!(value, Ordering::Greater);
    assert!(
        decided,
        "a subnormal input with a normal determinant is in range"
    );
}

/// O2: F0.2 catches shared points, including signed zeros, without reaching F1.
#[test]
fn b0r_o2_shared_points_are_exact_identities() {
    let a = point(0.0, -0.0);
    let same = point(-0.0, 0.0);
    let c = point(1.5, 2.5);
    for (x, y, z) in [(a, same, c), (a, c, same), (c, a, same), (c, c, c)] {
        let (value, (identity, _)) =
            counted(FilterId::PredicateOrientIdentity, || orient2d(x, y, z));
        assert_eq!(value, Ok(Ordering::Equal));
        assert_eq!(value, b0r_reference_orient2d(x, y, z));
        assert_eq!(identity, 1);
        let (_, (decided, fallback)) = counted(FilterId::PredicateOrient, || orient2d(x, y, z));
        assert_eq!(decided + fallback, 0, "F1 does not run after F0.2");
    }
}

/// O2: F0.3 decides disjoint boxes, and touching boxes (including a signed-zero touch) go on
/// to the unchanged classification.
#[test]
fn b0r_o2_segment_boxes() {
    let relation = |a: Point, b: Point, c: Point, d: Point| {
        let (value, counts) = counted(FilterId::SegmentBoxes, || segment_relation(a, b, c, d));
        assert_eq!(value, b0r_reference_segment_relation(a, b, c, d));
        (value.expect("finite"), counts)
    };
    use crate::fill_predicates::SegmentRelation as R;
    // Decided controls: separated along x, along y, and collinear with a gap.
    assert_eq!(
        relation(
            point(0.0, 0.0),
            point(1.0, 1.0),
            point(2.0, 0.0),
            point(3.0, 1.0)
        ),
        (R::Disjoint, (1, 0))
    );
    assert_eq!(
        relation(
            point(0.0, 0.0),
            point(5.0, 1.0),
            point(0.0, 2.0),
            point(5.0, 3.0)
        ),
        (R::Disjoint, (1, 0))
    );
    assert_eq!(
        relation(
            point(0.0, 0.0),
            point(1.0, 1.0),
            point(2.0, 2.0),
            point(3.0, 3.0)
        ),
        (R::Disjoint, (1, 0))
    );
    // A point segment off the other segment's box.
    assert_eq!(
        relation(
            point(4.0, 4.0),
            point(4.0, 4.0),
            point(0.0, 0.0),
            point(1.0, 3.0)
        ),
        (R::Disjoint, (1, 0))
    );
    // Touching boxes fall through: a shared endpoint, a collinear point touch, a box corner.
    assert_eq!(
        relation(
            point(0.0, 0.0),
            point(1.0, 1.0),
            point(1.0, 1.0),
            point(2.0, 0.0)
        ),
        (R::Touch, (0, 1))
    );
    assert_eq!(
        relation(
            point(0.0, 0.0),
            point(1.0, 1.0),
            point(1.0, 1.0),
            point(2.0, 2.0)
        ),
        (R::CollinearPoint, (0, 1))
    );
    assert_eq!(
        relation(
            point(0.0, 0.0),
            point(1.0, 1.0),
            point(1.0, 2.0),
            point(2.0, 1.0)
        ),
        (R::Disjoint, (0, 1))
    );
    // A touch at x = 0 written as +0.0 on one segment and -0.0 on the other.
    assert_eq!(
        relation(
            point(-1.0, 0.0),
            point(0.0, 0.0),
            point(-0.0, 0.0),
            point(1.0, 1.0)
        ),
        (R::Touch, (0, 1))
    );
    assert_eq!(
        relation(
            point(-0.0, -1.0),
            point(-0.0, 1.0),
            point(0.0, 0.0),
            point(1.0, 0.0)
        ),
        (R::Touch, (0, 1))
    );
    // A proper crossing and a collinear overlap.
    assert_eq!(
        relation(
            point(0.0, 0.0),
            point(2.0, 2.0),
            point(0.0, 2.0),
            point(2.0, 0.0)
        ),
        (R::ProperCrossing, (0, 1))
    );
    assert_eq!(
        relation(
            point(0.0, 0.0),
            point(2.0, 2.0),
            point(1.0, 1.0),
            point(3.0, 3.0)
        ),
        (R::CollinearOverlap, (0, 1))
    );
    // Validation still comes first.
    assert_eq!(
        segment_relation(
            point(0.0, 0.0),
            point(1.0, 1.0),
            point(5.0, 5.0),
            point(f64::NAN, 6.0)
        ),
        b0r_reference_segment_relation(
            point(0.0, 0.0),
            point(1.0, 1.0),
            point(5.0, 5.0),
            point(f64::NAN, 6.0)
        )
    );
}

/// Triples on which binary64 stage A is wrong in sign with |det| between 0.5 and 1 times the
/// error bound (found by a seeded search of the near-line family). F1 must fall back on them.
const STAGE_A_HARD: [[u64; 6]; 3] = [
    [
        0xbfcf_560c_3000_0000,
        0xbfb2_505f_0300_0000,
        0x4021_8ff8_8900_0000,
        0x3fa7_ac50_32c0_0000,
        0x400e_8634_9331_2ee9,
        0xbf93_00c8_ea73_7b42,
    ],
    [
        0x3fe9_4a7c_7d00_0000,
        0xbfb6_8e79_6300_0000,
        0x3ffb_6170_9080_0000,
        0x3f9f_6df7_1600_0000,
        0xbfd4_a2b6_922c_c145,
        0xbfcd_a71a_8b0d_b5d9,
    ],
    [
        0xbfff_fa2d_8300_0000,
        0x3fd0_5a37_7f00_0000,
        0x4024_40a7_35c0_0000,
        0xbfc5_e836_9140_0000,
        0x4003_6b7e_e7dd_f0cf,
        0x3fb9_89da_8e27_116e,
    ],
];

fn stage_a_hard(bits: [u64; 6]) -> [Point; 3] {
    let value = bits.map(f64::from_bits);
    [
        point(value[0], value[1]),
        point(value[2], value[3]),
        point(value[4], value[5]),
    ]
}

/// O2 for the same triples: the binary64 determinant has the wrong sign, and F1 falls back.
#[test]
fn b0r_o2_stage_a_wrong_sign_triples_fall_back() {
    for bits in STAGE_A_HARD {
        let [a, b, c] = stage_a_hard(bits);
        let det = (a.x - c.x) * (b.y - c.y) - (a.y - c.y) * (b.x - c.x);
        let (value, decided) = orient_case(a, b, c);
        assert!(!decided);
        assert_ne!(
            value,
            det.partial_cmp(&0.0).unwrap(),
            "binary64 sign is wrong"
        );
    }
}

/// O8 (2): with the F1 bound halved, the filter decides those triples with the wrong sign, and
/// the O2 fixture's comparison with the exact routine fails.
#[test]
fn b0r_o8_f1_bound_halved_is_detected() {
    let mut detected = 0;
    for bits in STAGE_A_HARD {
        let [a, b, c] = stage_a_hard(bits);
        let faulty = with_fault(Fault::F1BoundHalved, || orient2d(a, b, c));
        if faulty != b0r_reference_orient2d(a, b, c) {
            detected += 1;
        }
    }
    assert_eq!(detected, STAGE_A_HARD.len());
}

/// Full O1 for F0.2, F0.3 and F1: 10^7 random and 10^6 adversarial tuples per predicate.
#[test]
#[ignore = "B0R O1 full size; release profile via pnpm test:p3-fill-identity"]
fn b0r_oracle_full_o1_binary64_predicates() {
    const RANDOM: u64 = 10_000_000;
    const ADVERSARIAL: u64 = 1_000_000;
    let threads = ORACLE_SHARDS;
    let start = Instant::now();
    let mut failures = 0;
    for (offset, predicate) in PREDICATES.into_iter().enumerate() {
        for (label, random, adversarial) in [("random", RANDOM, 0), ("adversarial", 0, ADVERSARIAL)]
        {
            let mut tally = PredicateTally::default();
            for shard in parallel(threads, move |index| {
                differential(
                    predicate,
                    0x4230_5231_6000
                        + ((offset as u64) << 8)
                        + index as u64
                        + if random == 0 { 0x80 } else { 0 },
                    share(random, threads, index),
                    share(adversarial, threads, index),
                )
            }) {
                tally.merge(shard);
            }
            let rates: Vec<String> = IDS
                .iter()
                .zip(tally.filters)
                .map(|(id, (decided, fallback))| {
                    format!(
                        "{id:?} {decided}/{} decided ({:.4})",
                        decided + fallback,
                        fraction(decided, decided + fallback)
                    )
                })
                .collect();
            println!(
                "B0R O1 {predicate:?} {label}: {} cases, {} disagreements; {}",
                tally.cases,
                tally.disagreements,
                rates.join(", ")
            );
            failures += tally.disagreements;
        }
    }
    println!(
        "B0R O1 binary64 predicates ({threads} shards, {:.1} s)",
        start.elapsed().as_secs_f64()
    );
    assert_eq!(failures, 0);
}
