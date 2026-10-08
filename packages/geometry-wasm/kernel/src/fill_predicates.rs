use core::cmp::Ordering;

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
    Ok(orient2d_finite(a, b, c))
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
    orient2d_finite(start, end, point) == Ordering::Equal && within_bounds(point, start, end)
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
