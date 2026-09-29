use core::cmp::Ordering;

use crate::fill_predicates::{point_on_segment, segment_relation, SegmentRelation};
use crate::geometry::{Bounds, Point};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum IntersectionError {
    NonFinite,
    InvalidTolerance,
    Unresolved,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct CertifiedPoint {
    pub(crate) point: Point,
    pub(crate) enclosure: Bounds,
    pub(crate) error_bound: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum SegmentIntersection {
    Disjoint,
    Point(CertifiedPoint),
    Overlap { start: Point, end: Point },
}

pub(crate) fn segment_intersection(
    a: Point,
    b: Point,
    c: Point,
    d: Point,
    tolerance: f64,
) -> Result<SegmentIntersection, IntersectionError> {
    validate_points(&[a, b, c, d])?;
    if !tolerance.is_finite() || tolerance <= 0.0 {
        return Err(IntersectionError::InvalidTolerance);
    }

    let ((a, b), (c, d)) = canonical_segments(a, b, c, d);
    let relation = segment_relation(a, b, c, d).map_err(|_| IntersectionError::NonFinite)?;
    match relation {
        SegmentRelation::Disjoint => Ok(SegmentIntersection::Disjoint),
        SegmentRelation::Touch | SegmentRelation::CollinearPoint => {
            let point = shared_endpoint(a, b, c, d).ok_or(IntersectionError::Unresolved)?;
            Ok(SegmentIntersection::Point(exact_point(point)))
        }
        SegmentRelation::CollinearOverlap => {
            let (start, end) = overlap_endpoints(a, b, c, d)?;
            Ok(SegmentIntersection::Overlap { start, end })
        }
        SegmentRelation::ProperCrossing => {
            certified_crossing(a, b, c, d, tolerance).map(SegmentIntersection::Point)
        }
    }
}

fn validate_points(points: &[Point]) -> Result<(), IntersectionError> {
    if points
        .iter()
        .all(|point| point.x.is_finite() && point.y.is_finite())
    {
        Ok(())
    } else {
        Err(IntersectionError::NonFinite)
    }
}

fn canonical_segments(a: Point, b: Point, c: Point, d: Point) -> ((Point, Point), (Point, Point)) {
    let first = canonical_segment(normalize_point(a), normalize_point(b));
    let second = canonical_segment(normalize_point(c), normalize_point(d));
    if compare_segments(first, second) == Ordering::Greater {
        (second, first)
    } else {
        (first, second)
    }
}

fn canonical_segment(a: Point, b: Point) -> (Point, Point) {
    if compare_points(a, b) == Ordering::Greater {
        (b, a)
    } else {
        (a, b)
    }
}

fn compare_segments(left: (Point, Point), right: (Point, Point)) -> Ordering {
    compare_points(left.0, right.0).then_with(|| compare_points(left.1, right.1))
}

fn compare_points(left: Point, right: Point) -> Ordering {
    compare_scalar(left.x, right.x).then_with(|| compare_scalar(left.y, right.y))
}

fn compare_scalar(left: f64, right: f64) -> Ordering {
    if left < right {
        Ordering::Less
    } else if left > right {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

fn normalize_point(point: Point) -> Point {
    Point {
        x: normalize_zero(point.x),
        y: normalize_zero(point.y),
    }
}

fn normalize_zero(value: f64) -> f64 {
    if value == 0.0 {
        0.0
    } else {
        value
    }
}

fn shared_endpoint(a: Point, b: Point, c: Point, d: Point) -> Option<Point> {
    [a, b, c, d].into_iter().find(|point| {
        matches!(point_on_segment(*point, a, b), Ok(true))
            && matches!(point_on_segment(*point, c, d), Ok(true))
    })
}

fn overlap_endpoints(
    a: Point,
    b: Point,
    c: Point,
    d: Point,
) -> Result<(Point, Point), IntersectionError> {
    let mut start = None;
    let mut end = None;
    for point in [a, b, c, d] {
        if point_on_segment(point, a, b).map_err(|_| IntersectionError::NonFinite)?
            && point_on_segment(point, c, d).map_err(|_| IntersectionError::NonFinite)?
        {
            if start.is_none_or(|current| compare_points(point, current) == Ordering::Less) {
                start = Some(point);
            }
            if end.is_none_or(|current| compare_points(point, current) == Ordering::Greater) {
                end = Some(point);
            }
        }
    }
    match (start, end) {
        (Some(start), Some(end)) if compare_points(start, end) == Ordering::Less => {
            Ok((start, end))
        }
        _ => Err(IntersectionError::Unresolved),
    }
}

fn exact_point(point: Point) -> CertifiedPoint {
    CertifiedPoint {
        point,
        enclosure: Bounds {
            min_x: point.x,
            min_y: point.y,
            max_x: point.x,
            max_y: point.y,
        },
        error_bound: 0.0,
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Interval {
    lo: f64,
    hi: f64,
}

impl Interval {
    fn singleton(value: f64) -> Self {
        debug_assert!(value.is_finite());
        Self {
            lo: normalize_zero(value),
            hi: normalize_zero(value),
        }
    }

    fn new(lo: f64, hi: f64) -> Result<Self, IntersectionError> {
        if lo.is_finite() && hi.is_finite() && lo <= hi {
            Ok(Self {
                lo: normalize_zero(lo),
                hi: normalize_zero(hi),
            })
        } else {
            Err(IntersectionError::Unresolved)
        }
    }

    fn intersect(self, other: Self) -> Result<Self, IntersectionError> {
        Self::new(self.lo.max(other.lo), self.hi.min(other.hi))
    }

    fn contains_zero(self) -> bool {
        self.lo <= 0.0 && self.hi >= 0.0
    }
}

#[derive(Clone, Copy)]
struct IntervalPoint {
    x: Interval,
    y: Interval,
}

fn certified_crossing(
    a: Point,
    b: Point,
    c: Point,
    d: Point,
    tolerance: f64,
) -> Result<CertifiedPoint, IntersectionError> {
    let a_interval = interval_point(a);
    let b_interval = interval_point(b);
    let c_interval = interval_point(c);
    let d_interval = interval_point(d);
    let r = subtract_points(b_interval, a_interval)?;
    let s = subtract_points(d_interval, c_interval)?;
    let q = subtract_points(c_interval, a_interval)?;
    let denominator = cross(r, s)?;
    if denominator.contains_zero() {
        return Err(IntersectionError::Unresolved);
    }

    let unit = Interval { lo: 0.0, hi: 1.0 };
    let t = divide(cross(q, s)?, denominator)?.intersect(unit)?;
    let u = divide(cross(q, r)?, denominator)?.intersect(unit)?;
    let one_minus_t = subtract(Interval::singleton(1.0), t)?;
    let one_minus_u = subtract(Interval::singleton(1.0), u)?;

    let from_a = add_points(a_interval, scale_point(t, r)?)?;
    let from_b = subtract_points(b_interval, scale_point(one_minus_t, r)?)?;
    let from_c = add_points(c_interval, scale_point(u, s)?)?;
    let from_d = subtract_points(d_interval, scale_point(one_minus_u, s)?)?;
    let source_box = common_source_box(a, b, c, d)?;
    let enclosure = intersect_points(
        intersect_points(intersect_points(from_a, from_b)?, from_c)?,
        from_d,
    )?;
    let enclosure = intersect_points(enclosure, source_box)?;

    let x = midpoint(enclosure.x)?;
    let y = midpoint(enclosure.y)?;
    let x_error = coordinate_error(x, enclosure.x)?;
    let y_error = coordinate_error(y, enclosure.y)?;
    let error_bound = outward_nonnegative_sum(x_error, y_error)?;
    if error_bound > tolerance {
        return Err(IntersectionError::Unresolved);
    }

    Ok(CertifiedPoint {
        point: Point { x, y },
        enclosure: Bounds {
            min_x: enclosure.x.lo,
            min_y: enclosure.y.lo,
            max_x: enclosure.x.hi,
            max_y: enclosure.y.hi,
        },
        error_bound,
    })
}

fn interval_point(point: Point) -> IntervalPoint {
    IntervalPoint {
        x: Interval::singleton(point.x),
        y: Interval::singleton(point.y),
    }
}

fn add_points(
    left: IntervalPoint,
    right: IntervalPoint,
) -> Result<IntervalPoint, IntersectionError> {
    Ok(IntervalPoint {
        x: add(left.x, right.x)?,
        y: add(left.y, right.y)?,
    })
}

fn subtract_points(
    left: IntervalPoint,
    right: IntervalPoint,
) -> Result<IntervalPoint, IntersectionError> {
    Ok(IntervalPoint {
        x: subtract(left.x, right.x)?,
        y: subtract(left.y, right.y)?,
    })
}

fn scale_point(scalar: Interval, point: IntervalPoint) -> Result<IntervalPoint, IntersectionError> {
    Ok(IntervalPoint {
        x: multiply(scalar, point.x)?,
        y: multiply(scalar, point.y)?,
    })
}

fn intersect_points(
    left: IntervalPoint,
    right: IntervalPoint,
) -> Result<IntervalPoint, IntersectionError> {
    Ok(IntervalPoint {
        x: left.x.intersect(right.x)?,
        y: left.y.intersect(right.y)?,
    })
}

fn common_source_box(
    a: Point,
    b: Point,
    c: Point,
    d: Point,
) -> Result<IntervalPoint, IntersectionError> {
    Ok(IntervalPoint {
        x: Interval::new(
            a.x.min(b.x).max(c.x.min(d.x)),
            a.x.max(b.x).min(c.x.max(d.x)),
        )?,
        y: Interval::new(
            a.y.min(b.y).max(c.y.min(d.y)),
            a.y.max(b.y).min(c.y.max(d.y)),
        )?,
    })
}

fn cross(left: IntervalPoint, right: IntervalPoint) -> Result<Interval, IntersectionError> {
    subtract(multiply(left.x, right.y)?, multiply(left.y, right.x)?)
}

fn add(left: Interval, right: Interval) -> Result<Interval, IntersectionError> {
    widened(left.lo + right.lo, left.hi + right.hi)
}

fn subtract(left: Interval, right: Interval) -> Result<Interval, IntersectionError> {
    if left.lo == left.hi && right.lo == right.hi && left.lo == right.lo {
        return Ok(Interval::singleton(0.0));
    }
    widened(left.lo - right.hi, left.hi - right.lo)
}

fn multiply(left: Interval, right: Interval) -> Result<Interval, IntersectionError> {
    if is_singleton_zero(left) || is_singleton_zero(right) {
        return Ok(Interval::singleton(0.0));
    }
    let products = [
        left.lo * right.lo,
        left.lo * right.hi,
        left.hi * right.lo,
        left.hi * right.hi,
    ];
    extrema_widened(products)
}

fn divide(left: Interval, right: Interval) -> Result<Interval, IntersectionError> {
    if right.contains_zero() {
        return Err(IntersectionError::Unresolved);
    }
    let quotients = [
        left.lo / right.lo,
        left.lo / right.hi,
        left.hi / right.lo,
        left.hi / right.hi,
    ];
    extrema_widened(quotients)
}

fn is_singleton_zero(interval: Interval) -> bool {
    interval.lo == 0.0 && interval.hi == 0.0
}

fn extrema_widened(values: [f64; 4]) -> Result<Interval, IntersectionError> {
    if !values.iter().all(|value| value.is_finite()) {
        return Err(IntersectionError::Unresolved);
    }
    // next_down and next_up are monotone, so widening the finite extrema is
    // equivalent to widening every candidate before selecting the extrema.
    let lo = values.into_iter().fold(f64::INFINITY, f64::min);
    let hi = values.into_iter().fold(f64::NEG_INFINITY, f64::max);
    widened(lo, hi)
}

fn widened(lo: f64, hi: f64) -> Result<Interval, IntersectionError> {
    if !lo.is_finite() || !hi.is_finite() {
        return Err(IntersectionError::Unresolved);
    }
    Interval::new(lo.next_down(), hi.next_up())
}

fn midpoint(interval: Interval) -> Result<f64, IntersectionError> {
    let value = if interval.contains_zero() {
        (interval.lo + interval.hi) * 0.5
    } else {
        interval.lo * 0.5 + interval.hi * 0.5
    };
    if !value.is_finite() {
        return Err(IntersectionError::Unresolved);
    }
    Ok(normalize_zero(value.clamp(interval.lo, interval.hi)))
}

fn coordinate_error(point: f64, interval: Interval) -> Result<f64, IntersectionError> {
    let lower = outward_nonnegative_difference(point, interval.lo)?;
    let upper = outward_nonnegative_difference(interval.hi, point)?;
    Ok(lower.max(upper))
}

fn outward_nonnegative_difference(larger: f64, smaller: f64) -> Result<f64, IntersectionError> {
    if larger == smaller {
        return Ok(0.0);
    }
    let difference = larger - smaller;
    if !difference.is_finite() || difference < 0.0 {
        return Err(IntersectionError::Unresolved);
    }
    let upper = difference.next_up();
    upper
        .is_finite()
        .then_some(upper)
        .ok_or(IntersectionError::Unresolved)
}

fn outward_nonnegative_sum(left: f64, right: f64) -> Result<f64, IntersectionError> {
    if left == 0.0 {
        return Ok(right);
    }
    if right == 0.0 {
        return Ok(left);
    }
    let sum = left + right;
    if !sum.is_finite() {
        return Err(IntersectionError::Unresolved);
    }
    let upper = sum.next_up();
    upper
        .is_finite()
        .then_some(upper)
        .ok_or(IntersectionError::Unresolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn widening_covers_zero_subnormal_normal_and_maximum_transitions() {
        assert_eq!(
            widened(0.0, 0.0).unwrap(),
            Interval {
                lo: f64::from_bits(0x8000_0000_0000_0001),
                hi: f64::from_bits(0x0000_0000_0000_0001),
            }
        );
        let maximum_subnormal = f64::from_bits(0x000f_ffff_ffff_ffff);
        assert_eq!(
            widened(maximum_subnormal, maximum_subnormal).unwrap(),
            Interval {
                lo: f64::from_bits(0x000f_ffff_ffff_fffe),
                hi: f64::from_bits(0x0010_0000_0000_0000),
            }
        );
        assert_eq!(
            widened(f64::MIN_POSITIVE, f64::MIN_POSITIVE).unwrap(),
            Interval {
                lo: f64::from_bits(0x000f_ffff_ffff_ffff),
                hi: f64::from_bits(0x0010_0000_0000_0001),
            }
        );
        assert_eq!(
            widened(1.0, 1.0).unwrap(),
            Interval {
                lo: f64::from_bits(0x3fef_ffff_ffff_ffff),
                hi: f64::from_bits(0x3ff0_0000_0000_0001),
            }
        );
        assert_eq!(
            widened(f64::MAX, f64::MAX),
            Err(IntersectionError::Unresolved)
        );
    }

    #[test]
    fn arithmetic_widens_and_preserves_permitted_exact_zero_results() {
        let one = Interval::singleton(1.0);
        let exact_two = Interval::singleton(2.0);
        let two = add(one, one).unwrap();
        assert_eq!(two.lo.to_bits(), 0x3fff_ffff_ffff_ffff);
        assert_eq!(two.hi.to_bits(), 0x4000_0000_0000_0001);
        let product = multiply(one, exact_two).unwrap();
        assert_eq!(product.lo.to_bits(), 0x3fff_ffff_ffff_ffff);
        assert_eq!(product.hi.to_bits(), 0x4000_0000_0000_0001);
        let quotient = divide(one, exact_two).unwrap();
        assert_eq!(quotient.lo.to_bits(), 0x3fdf_ffff_ffff_ffff);
        assert_eq!(quotient.hi.to_bits(), 0x3fe0_0000_0000_0001);
        assert_eq!(
            multiply(
                Interval::singleton(f64::from_bits(1)),
                Interval::singleton(f64::from_bits(1)),
            )
            .unwrap(),
            Interval {
                lo: f64::from_bits(0x8000_0000_0000_0001),
                hi: f64::from_bits(0x0000_0000_0000_0001),
            }
        );
        assert_eq!(subtract(one, one).unwrap(), Interval::singleton(0.0));
        assert_eq!(
            multiply(Interval::singleton(0.0), two).unwrap(),
            Interval::singleton(0.0)
        );
        assert_eq!(
            multiply(Interval::singleton(f64::MAX), one),
            Err(IntersectionError::Unresolved)
        );
    }

    #[test]
    fn division_rejects_every_interval_containing_zero() {
        let numerator = Interval::singleton(1.0);
        for denominator in [
            Interval { lo: 0.0, hi: 1.0 },
            Interval { lo: -1.0, hi: 0.0 },
            Interval { lo: -1.0, hi: 1.0 },
        ] {
            assert_eq!(
                divide(numerator, denominator),
                Err(IntersectionError::Unresolved)
            );
        }
    }
}
