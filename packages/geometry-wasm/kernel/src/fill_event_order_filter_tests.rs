//! B0R unit U3 oracles for the event-order filters F0.4 and F2.5 in `fill_event_order`
//! (docs/plans/p3-b0r-kernel-performance-contract.md sections 3.5, 3.7 and 7: O1, O2, O8).
//!
//! Every filtered comparison is compared with a `cfg(test)` copy of the pre-U3 routine, whose
//! crossing classification also runs through the pre-U3 `segment_relation`. The crossing x
//! enclosure is also checked directly: the exact comparison places the crossing between the
//! enclosure's endpoints.
//!
//! The full-size run is an `#[ignore]` test in the release profile, run by
//! `pnpm test:p3-fill-identity`; the ordinary tests are the smoke versions and the fixtures.
use core::cmp::Ordering;
use std::time::Instant;

use crate::fill_event_order::{
    b0r_reference_compare_event_positions, b0r_reference_compare_event_x, b0r_test_x_enclosure,
    compare_event_positions, compare_event_x, EventError, FillEvent,
};
use crate::fill_filter::{counts, reset_counters, with_fault, Fault, FilterId};
use crate::fill_filter_tests::{parallel, pow2, share, Rng, ORACLE_SHARDS};
use crate::geometry::Point;

const IDS: [FilterId; 2] = [FilterId::EventEndpoints, FilterId::EventCrossingX];

fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}

fn endpoint(x: f64, y: f64) -> FillEvent {
    FillEvent::Endpoint(point(x, y))
}

fn crossing(a: Point, b: Point, c: Point, d: Point) -> FillEvent {
    FillEvent::Crossing { a, b, c, d }
}

fn scale_event(event: FillEvent, factor: f64) -> FillEvent {
    let scale = |value: Point| point(value.x * factor, value.y * factor);
    match event {
        FillEvent::Endpoint(value) => FillEvent::Endpoint(scale(value)),
        FillEvent::Crossing { a, b, c, d } => crossing(scale(a), scale(b), scale(c), scale(d)),
    }
}

/// The filtered comparisons under test.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Comparison {
    X,
    Positions,
}

pub(crate) const COMPARISONS: [Comparison; 2] = [Comparison::X, Comparison::Positions];

fn compare(
    comparison: Comparison,
    left: FillEvent,
    right: FillEvent,
    reference: bool,
) -> Result<Ordering, EventError> {
    match (comparison, reference) {
        (Comparison::X, false) => compare_event_x(left, right),
        (Comparison::X, true) => b0r_reference_compare_event_x(left, right),
        (Comparison::Positions, false) => compare_event_positions(left, right),
        (Comparison::Positions, true) => b0r_reference_compare_event_positions(left, right),
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct EventTally {
    pub(crate) cases: u64,
    pub(crate) disagreements: u64,
    /// Proper crossings whose x enclosure was checked, and enclosures that missed the exact x.
    pub(crate) enclosures: u64,
    pub(crate) containment_violations: u64,
    /// Enclosures that were not finite (overflow, or a weight interval containing zero).
    pub(crate) unbounded: u64,
    pub(crate) errors: u64,
    /// (decided, fallback) per filter of `IDS`, for the filtered calls.
    pub(crate) filters: [(u64, u64); 2],
}

impl EventTally {
    pub(crate) fn merge(&mut self, other: Self) {
        self.cases += other.cases;
        self.disagreements += other.disagreements;
        self.enclosures += other.enclosures;
        self.containment_violations += other.containment_violations;
        self.unbounded += other.unbounded;
        self.errors += other.errors;
        for (slot, value) in self.filters.iter_mut().zip(other.filters) {
            slot.0 += value.0;
            slot.1 += value.1;
        }
    }
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

/// A crossing built around a center: two segments through it in random directions. Rounding
/// may move the endpoints off the exact lines, so a few are not proper crossings.
fn built_crossing(rng: &mut Rng, center: Point, size_exponent: i32) -> FillEvent {
    let mut direction = || {
        point(
            rng.scaled_in(size_exponent - 4, size_exponent, true),
            rng.scaled_in(size_exponent - 4, size_exponent, true),
        )
    };
    let first = direction();
    let second = direction();
    let mut length = || 0.25 + (rng.next_u64() >> 11) as f64 * pow2(-53) * 2.0;
    let (s0, s1, r0, r1) = (length(), length(), length(), length());
    crossing(
        point(center.x - s0 * first.x, center.y - s0 * first.y),
        point(center.x + s1 * first.x, center.y + s1 * first.y),
        point(center.x - r0 * second.x, center.y - r0 * second.y),
        point(center.x + r1 * second.x, center.y + r1 * second.y),
    )
}

/// A crossing exactly at `center`: two lattice lines with integer directions through it.
fn lattice_crossing(rng: &mut Rng, center: Point, unit: f64) -> FillEvent {
    let mut direction = || loop {
        let p = rng.below(9) as f64 - 4.0;
        let q = rng.below(9) as f64 - 4.0;
        if p != 0.0 || q != 0.0 {
            return (p * unit, q * unit);
        }
    };
    let (p0, q0) = direction();
    let (mut p1, mut q1) = direction();
    while p0 * q1 == p1 * q0 {
        (p1, q1) = direction();
    }
    let mut k = || 1.0 + rng.below(3) as f64;
    let (s0, s1, r0, r1) = (k(), k(), k(), k());
    crossing(
        point(center.x - s0 * p0, center.y - s0 * q0),
        point(center.x + s1 * p0, center.y + s1 * q0),
        point(center.x - r0 * p1, center.y - r0 * q1),
        point(center.x + r1 * p1, center.y + r1 * q1),
    )
}

/// A binary64 estimate of a crossing's x (only to place adversarial neighbours near it).
fn estimate_x(event: FillEvent) -> f64 {
    match event {
        FillEvent::Endpoint(value) => value.x,
        FillEvent::Crossing { a, b, c, d } => {
            let (lx, ly, lz) = (a.y - b.y, b.x - a.x, a.x * b.y - a.y * b.x);
            let (rx, ry, rz) = (c.y - d.y, d.x - c.x, c.x * d.y - c.y * d.x);
            (ly * rz - lz * ry) / (lx * ry - ly * rx)
        }
    }
}

fn random_event(rng: &mut Rng) -> FillEvent {
    let center = point(rng.finite(-60, 60), rng.finite(-60, 60));
    match rng.below(10) {
        0..=3 => FillEvent::Endpoint(center),
        4..=8 => {
            let magnitude = center.x.abs().max(center.y.abs());
            let exponent = if magnitude > 0.0 && magnitude.is_normal() {
                magnitude.log2().floor() as i32
            } else {
                0
            };
            let size = exponent + rng.range_i32(-30, 2);
            built_crossing(rng, center, size)
        }
        // Four unrelated points: usually not a proper crossing (an error case).
        _ => crossing(
            point(rng.finite(-60, 60), rng.finite(-60, 60)),
            point(rng.finite(-60, 60), rng.finite(-60, 60)),
            point(rng.finite(-60, 60), rng.finite(-60, 60)),
            point(rng.finite(-60, 60), rng.finite(-60, 60)),
        ),
    }
}

/// A nearly parallel proper crossing: (0, 0)-(B, B + 1) and (0, 1)-(B, B), B = 2^k, shifted.
fn nearly_parallel(rng: &mut Rng) -> FillEvent {
    let big = pow2(rng.range_i32(20, 52));
    let shift = rng.below(16) as f64;
    crossing(
        point(shift, shift),
        point(shift + big, shift + big + 1.0),
        point(shift, shift + 1.0),
        point(shift + big, shift + big),
    )
}

fn adversarial_pair(rng: &mut Rng) -> (FillEvent, FillEvent) {
    let unit = pow2(rng.range_i32(-30, 30));
    let lattice_center = |rng: &mut Rng| {
        point(
            (rng.below(64) as f64 - 32.0) * unit,
            (rng.below(64) as f64 - 32.0) * unit,
        )
    };
    let pair = match rng.below(10) {
        // An endpoint at, or a few ulps from, a crossing's x; y near the crossing's y.
        0 | 1 => {
            let center = point(rng.finite(-40, 40), rng.finite(-40, 40));
            let size = rng.range_i32(-20, 20);
            let event = built_crossing(rng, center, size);
            let x = estimate_x(event);
            let x = if x.is_finite() {
                nudge(x, rng)
            } else {
                center.x
            };
            (event, endpoint(x, nudge(center.y, rng)))
        }
        // Crossings exactly at a lattice center against an endpoint there, or one ulp away.
        2 => {
            let center = lattice_center(rng);
            let event = lattice_crossing(rng, center, unit);
            (event, endpoint(nudge(center.x, rng), nudge(center.y, rng)))
        }
        // Equal-x crossings with different or equal y (the F2.5 tie rule).
        3 => {
            let center = lattice_center(rng);
            let other = point(
                center.x,
                if rng.chance(1, 2) {
                    center.y
                } else {
                    center.y + (rng.below(8) as f64 + 1.0) * unit
                },
            );
            (
                lattice_crossing(rng, center, unit),
                lattice_crossing(rng, other, unit),
            )
        }
        // Nearly parallel crossings against an endpoint or another crossing near their x.
        4 => {
            let event = nearly_parallel(rng);
            let x = estimate_x(event);
            let other = if rng.chance(1, 2) {
                endpoint(nudge(x, rng), 0.5)
            } else {
                nearly_parallel(rng)
            };
            (event, other)
        }
        // Huge and tiny scales: overflowing and underflowing interval operations.
        5 => {
            let center = lattice_center(rng);
            let event = lattice_crossing(rng, center, unit);
            let other = endpoint(nudge(center.x, rng), center.y);
            let factor = if rng.chance(1, 2) {
                pow2(rng.range_i32(300, 960))
            } else {
                pow2(rng.range_i32(-1040, -300))
            };
            (scale_event(event, factor), scale_event(other, factor))
        }
        // The same crossing, with its segments reordered or reversed.
        6 => {
            let center = point(rng.finite(-40, 40), rng.finite(-40, 40));
            let size = rng.range_i32(-20, 20);
            let event = built_crossing(rng, center, size);
            let FillEvent::Crossing { a, b, c, d } = event else {
                unreachable!()
            };
            let other = match rng.below(3) {
                0 => crossing(c, d, a, b),
                1 => crossing(b, a, d, c),
                _ => event,
            };
            (event, other)
        }
        // Errors: non-proper crossings (shared endpoints, collinear) and non-finite points.
        7 => {
            let center = lattice_center(rng);
            let bad = match rng.below(3) {
                0 => crossing(
                    center,
                    point(center.x + unit, center.y),
                    center,
                    point(center.x, center.y + unit),
                ),
                1 => crossing(
                    center,
                    point(center.x + 2.0 * unit, center.y),
                    point(center.x + unit, center.y),
                    point(center.x + 3.0 * unit, center.y),
                ),
                _ => endpoint(f64::NAN, center.y),
            };
            let good = lattice_crossing(rng, center, unit);
            if rng.chance(1, 2) {
                (bad, good)
            } else {
                (good, bad)
            }
        }
        // Two endpoints (F0.4) with signed zeros, equal coordinates and ulp neighbours.
        8 => {
            let x = if rng.chance(1, 2) {
                0.0
            } else {
                rng.finite(-60, 60)
            };
            let y = rng.finite(-60, 60);
            let flip = |value: f64, rng: &mut Rng| {
                if value == 0.0 && rng.chance(1, 2) {
                    -value
                } else {
                    nudge(value, rng)
                }
            };
            let other = endpoint(flip(x, rng), flip(y, rng));
            (endpoint(x, y), other)
        }
        // Signed zeros: endpoints at x = +0 and -0 against a crossing at x = 0.
        _ => {
            let center = point(0.0, (rng.below(8) as f64) * unit);
            let event = lattice_crossing(rng, center, unit);
            let zero = if rng.chance(1, 2) { 0.0 } else { -0.0 };
            let other = if rng.chance(1, 2) {
                endpoint(zero, center.y)
            } else {
                endpoint(-zero, nudge(center.y, rng))
            };
            if rng.chance(1, 2) {
                (event, other)
            } else {
                (other, event)
            }
        }
    };
    if rng.chance(1, 2) {
        (pair.1, pair.0)
    } else {
        pair
    }
}

/// Checks that a proper crossing's x enclosure contains its exact x, by the exact comparison
/// with endpoints at the enclosure's ends.
fn check_enclosure(event: FillEvent, tally: &mut EventTally) {
    let FillEvent::Crossing { a, .. } = event else {
        return;
    };
    // Not a proper crossing (or not finite): no position to enclose.
    if b0r_reference_compare_event_x(endpoint(0.0, 0.0), event).is_err() {
        return;
    }
    let enclosure = b0r_test_x_enclosure(event);
    if !enclosure.is_finite() {
        tally.unbounded += 1;
        return;
    }
    let low = b0r_reference_compare_event_x(endpoint(enclosure.lo, a.y), event);
    let high = b0r_reference_compare_event_x(endpoint(enclosure.hi, a.y), event);
    tally.enclosures += 1;
    if low == Ok(Ordering::Greater) || high == Ok(Ordering::Less) {
        tally.containment_violations += 1;
        if tally.containment_violations <= 3 {
            eprintln!("B0R O1 enclosure miss {event:?}: {enclosure:?}");
        }
    }
}

/// O1 differential of one comparison: `random` random and `adversarial` adversarial pairs.
pub(crate) fn differential(
    comparison: Comparison,
    seed: u64,
    random: u64,
    adversarial: u64,
) -> EventTally {
    let mut rng = Rng::new(seed);
    let mut tally = EventTally::default();
    for index in 0..random + adversarial {
        let (left, right) = if index < random {
            (random_event(&mut rng), random_event(&mut rng))
        } else {
            adversarial_pair(&mut rng)
        };
        reset_counters();
        let filtered = compare(comparison, left, right, false);
        for (slot, id) in tally.filters.iter_mut().zip(IDS) {
            let (decided, fallback) = counts(id);
            slot.0 += decided;
            slot.1 += fallback;
        }
        let exact = compare(comparison, left, right, true);
        tally.cases += 1;
        tally.errors += u64::from(exact.is_err());
        if filtered != exact {
            tally.disagreements += 1;
            if tally.disagreements <= 3 {
                eprintln!(
                    "B0R O1 disagreement {comparison:?} {left:?} {right:?}: filtered {filtered:?}, exact {exact:?}"
                );
            }
        }
        if comparison == Comparison::X {
            check_enclosure(left, &mut tally);
            check_enclosure(right, &mut tally);
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

/// Both comparisons agree with the reference; returns them with the F2.5 counts of each.
#[allow(clippy::type_complexity)]
fn both(
    left: FillEvent,
    right: FillEvent,
) -> (
    (Result<Ordering, EventError>, (u64, u64)),
    (Result<Ordering, EventError>, (u64, u64)),
) {
    let x = counted(FilterId::EventCrossingX, || compare_event_x(left, right));
    assert_eq!(x.0, b0r_reference_compare_event_x(left, right));
    let positions = counted(FilterId::EventCrossingX, || {
        compare_event_positions(left, right)
    });
    assert_eq!(
        positions.0,
        b0r_reference_compare_event_positions(left, right)
    );
    (x, positions)
}

const DECIDED: (u64, u64) = (1, 0);
const FALLBACK: (u64, u64) = (0, 1);

#[test]
fn b0r_o1_smoke_event_order() {
    for (offset, comparison) in COMPARISONS.into_iter().enumerate() {
        let tally = differential(comparison, 0x4230_5231_5400 + offset as u64, 10_000, 1_000);
        assert_eq!(tally.disagreements, 0, "{comparison:?} {tally:?}");
        assert_eq!(tally.containment_violations, 0, "{tally:?}");
        // Decided controls: random crossings are mostly decided by F2.5.
        let (decided, fallback) = tally.filters[1];
        assert!(
            fraction(decided, decided + fallback) > 0.8,
            "{comparison:?} {tally:?}"
        );
        assert!(tally.errors > 100, "{tally:?}");
    }
}

/// O2: an X centered at (1, 1), the canonical crossing of the fixtures below.
fn unit_x(center_x: f64, center_y: f64, half: f64) -> FillEvent {
    crossing(
        point(center_x - half, center_y - half),
        point(center_x + half, center_y + half),
        point(center_x - half, center_y + half),
        point(center_x + half, center_y - half),
    )
}

/// O2: equal-x crossings with different y. The x enclosures overlap, so F2.5 does not decide,
/// and `compare_event_positions` runs the exact routine for x and then y.
#[test]
fn b0r_o2_equal_x_crossings_use_the_tie_rule() {
    let low = unit_x(1.0, 1.0, 1.0);
    let high = unit_x(1.0, 6.0, 0.5);
    let ((x, x_counts), (positions, positions_counts)) = both(low, high);
    assert_eq!(x, Ok(Ordering::Equal));
    assert_eq!(positions, Ok(Ordering::Less));
    assert_eq!((x_counts, positions_counts), (FALLBACK, FALLBACK));
    // The same position written with other segments.
    let ((x, _), (positions, counts)) = both(low, unit_x(1.0, 1.0, 0.25));
    assert_eq!(
        (x, positions, counts),
        (Ok(Ordering::Equal), Ok(Ordering::Equal), FALLBACK)
    );
    // An endpoint exactly at the crossing, and one ulp to either side in x.
    let ((_, counts), (positions, _)) = both(low, endpoint(1.0, 1.0));
    assert_eq!((positions, counts), (Ok(Ordering::Equal), FALLBACK));
    let ((x, _), _) = both(low, endpoint(1.0f64.next_up(), -9.0));
    assert_eq!(x, Ok(Ordering::Less));
    let ((x, _), _) = both(low, endpoint(1.0f64.next_down(), 9.0));
    assert_eq!(x, Ok(Ordering::Greater));
}

/// O2: a nearly parallel crossing has a weight interval containing zero, so its enclosure is
/// undecidable and every comparison falls back.
#[test]
fn b0r_o2_nearly_parallel_crossing_falls_back() {
    let big = pow2(52);
    let event = crossing(
        point(0.0, 0.0),
        point(big, big + 1.0),
        point(0.0, 1.0),
        point(big, big),
    );
    assert!(!b0r_test_x_enclosure(event).is_finite());
    for other in [
        endpoint(-1.0, 0.0),
        endpoint(big, 0.0),
        unit_x(1.0, 1.0, 1.0),
    ] {
        let ((_, x_counts), (_, positions_counts)) = both(event, other);
        assert_eq!((x_counts, positions_counts), (FALLBACK, FALLBACK));
    }
}

/// O2: overflowing interval operations at 2^600 (NaN or infinite endpoints) fall back; a
/// moderate scale of the same configuration is decided.
#[test]
fn b0r_o2_overflowing_crossings_fall_back() {
    let event = unit_x(1.0, 1.0, 1.0);
    let other = endpoint(5.0, 0.0);
    for (exponent, expected) in [
        (0, DECIDED),
        (200, DECIDED),
        (600, FALLBACK),
        (1000, FALLBACK),
    ] {
        let factor = pow2(exponent);
        let ((x, counts), _) = both(scale_event(event, factor), scale_event(other, factor));
        assert_eq!((x, counts), (Ok(Ordering::Less), expected), "2^{exponent}");
    }
    // Deep underflow: tiny products lose their relative precision; the result stays exact.
    for exponent in [-300, -600, -1000] {
        let factor = pow2(exponent);
        let ((x, _), _) = both(scale_event(event, factor), scale_event(other, factor));
        assert_eq!(x, Ok(Ordering::Less), "2^{exponent}");
    }
}

/// O2 decided controls: well-separated crossings and endpoints are decided by F2.5, and two
/// endpoints always by F0.4, signed zeros included.
#[test]
fn b0r_o2_decided_controls() {
    let event = unit_x(1.0, 1.0, 1.0);
    for (other, expected) in [
        (endpoint(3.0, 1.0), Ordering::Less),
        (endpoint(-0.5, 1.0), Ordering::Greater),
        (unit_x(1.5, 1.0, 0.25), Ordering::Less),
        (unit_x(0.0, 7.0, 0.5), Ordering::Greater),
    ] {
        let ((x, x_counts), (positions, positions_counts)) = both(event, other);
        assert_eq!((x, positions), (Ok(expected), Ok(expected)));
        assert_eq!((x_counts, positions_counts), (DECIDED, DECIDED));
    }
    // A generic crossing with irrational-looking coordinates.
    let generic = crossing(
        point(0.1, 0.2),
        point(2.3, 1.7),
        point(0.3, 1.9),
        point(1.9, 0.1),
    );
    let ((_, counts), _) = both(generic, endpoint(0.5, 0.0));
    assert_eq!(counts, DECIDED);
    for (left, right, x, positions) in [
        (
            endpoint(0.0, 1.0),
            endpoint(-0.0, 1.0),
            Ordering::Equal,
            Ordering::Equal,
        ),
        (
            endpoint(-0.0, -0.0),
            endpoint(0.0, 0.0),
            Ordering::Equal,
            Ordering::Equal,
        ),
        (
            endpoint(1.0, 5.0),
            endpoint(1.0, -5.0),
            Ordering::Equal,
            Ordering::Greater,
        ),
        (
            endpoint(-1.0, 5.0),
            endpoint(1.0, -5.0),
            Ordering::Less,
            Ordering::Less,
        ),
    ] {
        let (value, counts) = counted(FilterId::EventEndpoints, || compare_event_x(left, right));
        assert_eq!((value, counts), (Ok(x), DECIDED));
        assert_eq!(value, b0r_reference_compare_event_x(left, right));
        let (value, counts) = counted(FilterId::EventEndpoints, || {
            compare_event_positions(left, right)
        });
        assert_eq!((value, counts), (Ok(positions), DECIDED));
        assert_eq!(value, b0r_reference_compare_event_positions(left, right));
    }
}

/// O2: errors keep their precedence. Both events are validated before either crossing is
/// classified, and the left crossing is classified before the right one; no filter runs.
#[test]
fn b0r_o2_error_precedence_is_unchanged() {
    let proper = unit_x(1.0, 1.0, 1.0);
    let touching = crossing(
        point(0.0, 0.0),
        point(1.0, 0.0),
        point(0.0, 0.0),
        point(0.0, 1.0),
    );
    let other_touching = crossing(
        point(0.0, 0.0),
        point(2.0, 0.0),
        point(1.0, 0.0),
        point(3.0, 0.0),
    );
    let nonfinite = endpoint(f64::INFINITY, 0.0);
    for (left, right, expected) in [
        (touching, nonfinite, EventError::NonFinite),
        (nonfinite, touching, EventError::NonFinite),
        (touching, proper, EventError::NotProperCrossing),
        (proper, other_touching, EventError::NotProperCrossing),
        (touching, other_touching, EventError::NotProperCrossing),
    ] {
        for comparison in COMPARISONS {
            let (value, counts) = counted(FilterId::EventCrossingX, || {
                compare(comparison, left, right, false)
            });
            assert_eq!(value, Err(expected));
            assert_eq!(value, compare(comparison, left, right, true));
            assert_eq!(counts, (0, 0), "no filter runs before an error");
        }
    }
}

/// O8 (1), F2.5 part: with R1 widening removed, the crossing enclosures miss exact values.
#[test]
fn b0r_o8_r1_widening_removed_is_detected_by_event_enclosures() {
    let tally = with_fault(Fault::R1WideningRemoved, || {
        differential(Comparison::X, 0x4230_5231_5400, 2_000, 1_000)
    });
    assert!(tally.containment_violations > 0, "{tally:?}");
}

/// Full O1 for F0.4 and F2.5: 10^7 random and 10^6 adversarial pairs per comparison.
#[test]
#[ignore = "B0R O1 full size; release profile via pnpm test:p3-fill-identity"]
fn b0r_oracle_full_o1_event_order() {
    const RANDOM: u64 = 10_000_000;
    const ADVERSARIAL: u64 = 1_000_000;
    let threads = ORACLE_SHARDS;
    let start = Instant::now();
    let mut failures = 0;
    for (offset, comparison) in COMPARISONS.into_iter().enumerate() {
        for (label, random, adversarial) in [("random", RANDOM, 0), ("adversarial", 0, ADVERSARIAL)]
        {
            let mut tally = EventTally::default();
            for shard in parallel(threads, move |index| {
                differential(
                    comparison,
                    0x4230_5231_7000
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
                "B0R O1 {comparison:?} {label}: {} cases ({} errors), {} disagreements; {} enclosures checked, {} containment violations, {} unbounded; {}",
                tally.cases,
                tally.errors,
                tally.disagreements,
                tally.enclosures,
                tally.containment_violations,
                tally.unbounded,
                rates.join(", ")
            );
            failures += tally.disagreements + tally.containment_violations;
        }
    }
    println!(
        "B0R O1 event order ({threads} shards, {:.1} s)",
        start.elapsed().as_secs_f64()
    );
    assert_eq!(failures, 0);
}
