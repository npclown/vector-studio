use core::cmp::Ordering;

use crate::fill_filter::{self, Fault, FilterId};
use crate::geometry::Point;

// A shifted significand product is below 2^4196. Even six same-sign terms
// sum below 2^4199, leaving 25 spare high bits in this 4224-bit accumulator.
const LIMB_COUNT: usize = 66;
const PRODUCT_EXPONENT_BIAS: i32 = 2_148;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PredicateError {
    NonFinite,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SegmentRelation {
    Disjoint,
    Touch,
    ProperCrossing,
    CollinearPoint,
    CollinearOverlap,
}

pub(crate) fn orient2d(a: Point, b: Point, c: Point) -> Result<Ordering, PredicateError> {
    #[cfg(p3_b0_diag)]
    let _diag = crate::p3_b0_diag::enter("fill_predicates::orient2d", "", move || {
        let _ = core::hint::black_box(orient2d(
            core::hint::black_box(a),
            core::hint::black_box(b),
            core::hint::black_box(c),
        ));
    });
    validate_points(&[a, b, c])?;
    Ok(orient2d_filtered(a, b, c))
}

pub(crate) fn point_on_segment(
    point: Point,
    start: Point,
    end: Point,
) -> Result<bool, PredicateError> {
    validate_points(&[point, start, end])?;
    Ok(point_on_segment_finite(point, start, end))
}

pub(crate) fn segment_relation(
    a: Point,
    b: Point,
    c: Point,
    d: Point,
) -> Result<SegmentRelation, PredicateError> {
    #[cfg(p3_b0_diag)]
    let _diag = crate::p3_b0_diag::enter("fill_predicates::segment_relation", "", move || {
        let _ = core::hint::black_box(segment_relation(
            core::hint::black_box(a),
            core::hint::black_box(b),
            core::hint::black_box(c),
            core::hint::black_box(d),
        ));
    });
    validate_points(&[a, b, c, d])?;

    // F0.3: every non-Disjoint result below needs a common point of the two closed segments (a
    // point on a segment, a crossing, a touch or a collinear overlap), and both closed boxes
    // contain it. A point segment is CollinearPoint only on the other closed segment, and
    // collinear segments with disjoint boxes have disjoint projections. The comparisons are of
    // the represented values, with signed zeros equal, as in the exact branches.
    let disjoint_boxes = segment_boxes_disjoint(a, b, c, d);
    fill_filter::record(FilterId::SegmentBoxes, disjoint_boxes);
    if disjoint_boxes {
        return Ok(SegmentRelation::Disjoint);
    }

    let ab_is_point = same_point(a, b);
    let cd_is_point = same_point(c, d);
    if ab_is_point {
        return Ok(if point_on_segment_finite(a, c, d) {
            SegmentRelation::CollinearPoint
        } else {
            SegmentRelation::Disjoint
        });
    }
    if cd_is_point {
        return Ok(if point_on_segment_finite(c, a, b) {
            SegmentRelation::CollinearPoint
        } else {
            SegmentRelation::Disjoint
        });
    }

    let abc = orient2d_filtered(a, b, c);
    let abd = orient2d_filtered(a, b, d);
    let cda = orient2d_filtered(c, d, a);
    let cdb = orient2d_filtered(c, d, b);

    if abc == Ordering::Equal
        && abd == Ordering::Equal
        && cda == Ordering::Equal
        && cdb == Ordering::Equal
    {
        return Ok(collinear_relation(a, b, c, d));
    }

    if opposite(abc, abd) && opposite(cda, cdb) {
        return Ok(SegmentRelation::ProperCrossing);
    }

    if (abc == Ordering::Equal && within_bounds(c, a, b))
        || (abd == Ordering::Equal && within_bounds(d, a, b))
        || (cda == Ordering::Equal && within_bounds(a, c, d))
        || (cdb == Ordering::Equal && within_bounds(b, c, d))
    {
        return Ok(SegmentRelation::Touch);
    }

    Ok(SegmentRelation::Disjoint)
}

fn validate_points(points: &[Point]) -> Result<(), PredicateError> {
    if points
        .iter()
        .all(|point| point.x.is_finite() && point.y.is_finite())
    {
        Ok(())
    } else {
        Err(PredicateError::NonFinite)
    }
}

/// u = 2^-53, the unit roundoff of binary64 round-to-nearest.
const UNIT_ROUNDOFF: f64 = f64::EPSILON / 2.0;

/// Shewchuk's stage-A bound `ccwerrboundA = (3 + 16u) * u`; every operation here is exact.
const ORIENT_ERROR_BOUND: f64 = (3.0 + 16.0 * UNIT_ROUNDOFF) * UNIT_ROUNDOFF;

/// F1 guard: the largest input magnitude, 2^500.
const F1_INPUT_LIMIT: f64 = f64::from_bits((1023 + 500) << 52);

/// F1 guard: the smallest nonzero `|detleft| + |detright|`, 2^-900.
const F1_SUM_FLOOR: f64 = f64::from_bits((1023 - 900) << 52);

/// Orientation of three finite points: F0.2, then F1, then the unchanged exact accumulator
/// `orient2d_finite`, which runs once when neither decides.
fn orient2d_filtered(a: Point, b: Point, c: Point) -> Ordering {
    // F0.2: the cross product of a zero vector, or of a vector with itself, is exactly zero.
    // `same_point` treats signed zeros as equal, as the exact routine does.
    if same_point(a, b) || same_point(a, c) || same_point(b, c) {
        fill_filter::record(FilterId::PredicateOrientIdentity, true);
        return Ordering::Equal;
    }
    match orient2d_static_filter(a, b, c) {
        Some(value) => {
            fill_filter::record(FilterId::PredicateOrient, true);
            value
        }
        None => {
            fill_filter::record(FilterId::PredicateOrient, false);
            orient2d_finite(a, b, c)
        }
    }
}

/// F1 (B0R contract section 3.6): Shewchuk's stage A (Shewchuk 1997, section 4).
///
/// With `detleft = (ax - cx)(by - cy)`, `detright = (ay - cy)(bx - cx)` and
/// `det = detleft - detright` in binary64, `|det| > ccwerrboundA * (|detleft| + |detright|)`
/// proves that `det` has the sign of the exact determinant. The translated determinant expands
/// to the six terms `orient2d_finite` accumulates, so both have the same sign. Only stage A is
/// used; the exact accumulator replaces stages B to D.
///
/// Guard. The bound assumes that no operation overflows or underflows, so F1 runs only when
/// every input magnitude is at most 2^500 and `|detleft| + |detright|` is 0 or at least 2^-900:
/// - with inputs at most 2^500, differences are at most 2^501 and products at most 2^1002, so
///   nothing overflows;
/// - a difference that falls in the subnormal range is exact (gradual underflow, Sterbenz);
/// - a product that underflows carries an absolute error of at most 2^-1075, which is outside
///   the relative bound. When `|detleft| + |detright|` is at least 2^-900, the bound itself is
///   at least 3u * 2^-900 > 2^-955, so such errors are absorbed with a margin of more than
///   2^100. When the sum is 0, `det` is 0, the strict test fails and the exact routine runs.
///   A sum below 2^-900 also goes to the exact routine.
fn orient2d_static_filter(a: Point, b: Point, c: Point) -> Option<Ordering> {
    if [a.x, a.y, b.x, b.y, c.x, c.y]
        .iter()
        .any(|value| value.abs() > F1_INPUT_LIMIT)
    {
        return None;
    }
    let detleft = (a.x - c.x) * (b.y - c.y);
    let detright = (a.y - c.y) * (b.x - c.x);
    let det = detleft - detright;
    let sum = detleft.abs() + detright.abs();
    if sum < F1_SUM_FLOOR {
        return None;
    }
    let mut bound = ORIENT_ERROR_BOUND * sum;
    if fill_filter::fault_active(Fault::F1BoundHalved) {
        bound *= 0.5;
    }
    if det > bound {
        Some(Ordering::Greater)
    } else if -det > bound {
        Some(Ordering::Less)
    } else {
        None
    }
}

fn orient2d_finite(a: Point, b: Point, c: Point) -> Ordering {
    let mut positive = [0u64; LIMB_COUNT];
    let mut negative = [0u64; LIMB_COUNT];

    accumulate_product(&mut positive, &mut negative, a.x, b.y, false);
    accumulate_product(&mut positive, &mut negative, a.y, b.x, true);
    accumulate_product(&mut positive, &mut negative, b.x, c.y, false);
    accumulate_product(&mut positive, &mut negative, b.y, c.x, true);
    accumulate_product(&mut positive, &mut negative, c.x, a.y, false);
    accumulate_product(&mut positive, &mut negative, c.y, a.x, true);

    compare_limbs(&positive, &negative)
}

fn accumulate_product(
    positive: &mut [u64; LIMB_COUNT],
    negative: &mut [u64; LIMB_COUNT],
    left: f64,
    right: f64,
    negate: bool,
) {
    let left = decode_finite(left);
    let right = decode_finite(right);
    if left.significand == 0 || right.significand == 0 {
        return;
    }

    let product = u128::from(left.significand) * u128::from(right.significand);
    let shift = usize::try_from(left.exponent + right.exponent + PRODUCT_EXPONENT_BIAS)
        .expect("finite binary64 product shift is nonnegative");
    let is_negative = left.negative ^ right.negative ^ negate;
    let accumulator = if is_negative { negative } else { positive };
    add_shifted_product(accumulator, product, shift);
}

#[derive(Clone, Copy)]
struct FiniteFloat {
    negative: bool,
    significand: u64,
    exponent: i32,
}

fn decode_finite(value: f64) -> FiniteFloat {
    let bits = value.to_bits();
    let raw_exponent = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1u64 << 52) - 1);
    debug_assert!(raw_exponent != 0x7ff);

    if raw_exponent == 0 {
        FiniteFloat {
            negative: bits >> 63 != 0,
            significand: fraction,
            exponent: -1_074,
        }
    } else {
        FiniteFloat {
            negative: bits >> 63 != 0,
            significand: (1u64 << 52) | fraction,
            exponent: raw_exponent - 1_075,
        }
    }
}

fn add_shifted_product(accumulator: &mut [u64; LIMB_COUNT], product: u128, shift: usize) {
    let limb = shift / 64;
    let bits = shift % 64;
    let low = product as u64;
    let high = (product >> 64) as u64;

    if bits == 0 {
        add_word(accumulator, limb, low);
        add_word(accumulator, limb + 1, high);
    } else {
        add_word(accumulator, limb, low << bits);
        add_word(accumulator, limb + 1, (high << bits) | (low >> (64 - bits)));
        add_word(accumulator, limb + 2, high >> (64 - bits));
    }
}

fn add_word(accumulator: &mut [u64; LIMB_COUNT], mut index: usize, mut value: u64) {
    while value != 0 {
        assert!(index < LIMB_COUNT, "exact orientation accumulator overflow");
        let (sum, carry) = accumulator[index].overflowing_add(value);
        accumulator[index] = sum;
        value = u64::from(carry);
        index += 1;
    }
}

fn compare_limbs(left: &[u64; LIMB_COUNT], right: &[u64; LIMB_COUNT]) -> Ordering {
    for index in (0..LIMB_COUNT).rev() {
        match left[index].cmp(&right[index]) {
            Ordering::Equal => {}
            ordering => return ordering,
        }
    }
    Ordering::Equal
}

fn point_on_segment_finite(point: Point, start: Point, end: Point) -> bool {
    orient2d_filtered(start, end, point) == Ordering::Equal && within_bounds(point, start, end)
}

/// F0.3: the closed coordinate boxes of segments ab and cd are disjoint.
fn segment_boxes_disjoint(a: Point, b: Point, c: Point, d: Point) -> bool {
    a.x.max(b.x) < c.x.min(d.x)
        || c.x.max(d.x) < a.x.min(b.x)
        || a.y.max(b.y) < c.y.min(d.y)
        || c.y.max(d.y) < a.y.min(b.y)
}

fn same_point(left: Point, right: Point) -> bool {
    left.x == right.x && left.y == right.y
}

fn within_bounds(point: Point, start: Point, end: Point) -> bool {
    point.x >= start.x.min(end.x)
        && point.x <= start.x.max(end.x)
        && point.y >= start.y.min(end.y)
        && point.y <= start.y.max(end.y)
}

fn opposite(left: Ordering, right: Ordering) -> bool {
    matches!(
        (left, right),
        (Ordering::Less, Ordering::Greater) | (Ordering::Greater, Ordering::Less)
    )
}

fn collinear_relation(a: Point, b: Point, c: Point, d: Point) -> SegmentRelation {
    let (a0, a1, c0, c1) = if a.x != b.x {
        (a.x, b.x, c.x, d.x)
    } else {
        (a.y, b.y, c.y, d.y)
    };
    let lower = a0.min(a1).max(c0.min(c1));
    let upper = a0.max(a1).min(c0.max(c1));

    if lower < upper {
        SegmentRelation::CollinearOverlap
    } else if lower == upper {
        SegmentRelation::CollinearPoint
    } else {
        SegmentRelation::Disjoint
    }
}

// `cfg(test)` reference copies of the pre-U3 routines (B0R oracle O1): the same statements, with
// every orientation through the unchanged exact accumulator and no F0.2, F0.3 or F1.

/// Pre-U3 `orient2d`, the reference of the filtered entry.
#[cfg(test)]
pub(crate) fn b0r_reference_orient2d(
    a: Point,
    b: Point,
    c: Point,
) -> Result<Ordering, PredicateError> {
    validate_points(&[a, b, c])?;
    Ok(orient2d_finite(a, b, c))
}

/// Pre-U3 `point_on_segment`.
#[cfg(test)]
pub(crate) fn b0r_reference_point_on_segment(
    point: Point,
    start: Point,
    end: Point,
) -> Result<bool, PredicateError> {
    validate_points(&[point, start, end])?;
    Ok(reference_point_on_segment_finite(point, start, end))
}

/// Pre-U3 `segment_relation`.
#[cfg(test)]
pub(crate) fn b0r_reference_segment_relation(
    a: Point,
    b: Point,
    c: Point,
    d: Point,
) -> Result<SegmentRelation, PredicateError> {
    validate_points(&[a, b, c, d])?;

    let ab_is_point = same_point(a, b);
    let cd_is_point = same_point(c, d);
    if ab_is_point {
        return Ok(if reference_point_on_segment_finite(a, c, d) {
            SegmentRelation::CollinearPoint
        } else {
            SegmentRelation::Disjoint
        });
    }
    if cd_is_point {
        return Ok(if reference_point_on_segment_finite(c, a, b) {
            SegmentRelation::CollinearPoint
        } else {
            SegmentRelation::Disjoint
        });
    }

    let abc = orient2d_finite(a, b, c);
    let abd = orient2d_finite(a, b, d);
    let cda = orient2d_finite(c, d, a);
    let cdb = orient2d_finite(c, d, b);

    if abc == Ordering::Equal
        && abd == Ordering::Equal
        && cda == Ordering::Equal
        && cdb == Ordering::Equal
    {
        return Ok(collinear_relation(a, b, c, d));
    }

    if opposite(abc, abd) && opposite(cda, cdb) {
        return Ok(SegmentRelation::ProperCrossing);
    }

    if (abc == Ordering::Equal && within_bounds(c, a, b))
        || (abd == Ordering::Equal && within_bounds(d, a, b))
        || (cda == Ordering::Equal && within_bounds(a, c, d))
        || (cdb == Ordering::Equal && within_bounds(b, c, d))
    {
        return Ok(SegmentRelation::Touch);
    }

    Ok(SegmentRelation::Disjoint)
}

#[cfg(test)]
fn reference_point_on_segment_finite(point: Point, start: Point, end: Point) -> bool {
    orient2d_finite(start, end, point) == Ordering::Equal && within_bounds(point, start, end)
}
