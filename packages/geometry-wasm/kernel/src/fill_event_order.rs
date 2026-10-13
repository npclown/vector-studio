use core::cmp::Ordering;

use crate::fill_exact::{
    compare_ratios, crossing_position, endpoint_position, ExactEventPosition, Signed,
    EVENT_COMPARISON_LIMBS, HOMOGENEOUS_LIMBS, LINE_LIMBS,
};
use crate::fill_filter::{self, compare_enclosures, FilterId, Interval};
use crate::fill_predicates::{segment_relation, SegmentRelation};
use crate::geometry::Point;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum FillEvent {
    Endpoint(Point),
    Crossing {
        a: Point,
        b: Point,
        c: Point,
        d: Point,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EventError {
    NonFinite,
    NotProperCrossing,
}

/// Lexicographic exact comparison of two event positions, x then y.
///
/// The validation and the `ProperCrossing` checks run first, in the order of the exact routine
/// (both validations, then the left and the right classification), so error precedence is
/// unchanged. Then F0.4 or F2.5 may decide; otherwise the unchanged exact comparison runs.
pub(crate) fn compare_event_positions(
    left: FillEvent,
    right: FillEvent,
) -> Result<Ordering, EventError> {
    validate_event(left)?;
    validate_event(right)?;
    check_proper_crossing(left)?;
    check_proper_crossing(right)?;
    // F0.4: `endpoint_position` is (x, y, 1), so the exact comparison is of the represented
    // values, x then y; signed zeros compare equal in both.
    if let (FillEvent::Endpoint(left), FillEvent::Endpoint(right)) = (left, right) {
        fill_filter::record(FilterId::EventEndpoints, true);
        return Ok(compare_finite(left.x, right.x).then(compare_finite(left.y, right.y)));
    }
    // F2.5 tie rule: only disjoint x enclosures decide. Overlapping ones run the exact routine
    // for the whole comparison, x and then y; y is never compared on a filtered x.
    if let Some(order) = crossing_x_filter(left, right) {
        return Ok(order);
    }
    let left = checked_event_position(left);
    let right = checked_event_position(right);
    let x_order = compare_position_coordinate(left.x, left.w, right.x, right.w);
    if x_order != Ordering::Equal {
        return Ok(x_order);
    }
    Ok(compare_position_coordinate(
        left.y, left.w, right.y, right.w,
    ))
}

/// Exact comparison of two event x coordinates, with the same validation order as
/// `compare_event_positions`, then F0.4 or F2.5, then the unchanged exact comparison.
pub(crate) fn compare_event_x(left: FillEvent, right: FillEvent) -> Result<Ordering, EventError> {
    validate_event(left)?;
    validate_event(right)?;
    check_proper_crossing(left)?;
    check_proper_crossing(right)?;
    // F0.4, as in `compare_event_positions`.
    if let (FillEvent::Endpoint(left), FillEvent::Endpoint(right)) = (left, right) {
        fill_filter::record(FilterId::EventEndpoints, true);
        return Ok(compare_finite(left.x, right.x));
    }
    if let Some(order) = crossing_x_filter(left, right) {
        return Ok(order);
    }
    let left = checked_event_position(left);
    let right = checked_event_position(right);
    Ok(compare_position_coordinate(
        left.x, left.w, right.x, right.w,
    ))
}

pub(crate) fn exact_event_position(event: FillEvent) -> Result<ExactEventPosition, EventError> {
    validate_event(event)?;
    check_proper_crossing(event)?;
    Ok(checked_event_position(event))
}

/// The `ProperCrossing` check of a validated event; endpoints always pass.
fn check_proper_crossing(event: FillEvent) -> Result<(), EventError> {
    match event {
        FillEvent::Endpoint(_) => Ok(()),
        FillEvent::Crossing { a, b, c, d } => {
            if segment_relation(a, b, c, d).map_err(|_| EventError::NonFinite)?
                != SegmentRelation::ProperCrossing
            {
                return Err(EventError::NotProperCrossing);
            }
            Ok(())
        }
    }
}

/// The exact position of an event that passed validation and `check_proper_crossing`.
fn checked_event_position(event: FillEvent) -> ExactEventPosition {
    match event {
        FillEvent::Endpoint(point) => endpoint_position(point),
        FillEvent::Crossing { a, b, c, d } => crossing_position(a, b, c, d),
    }
}

/// Exact order of two finite binary64 values, with signed zeros equal.
fn compare_finite(left: f64, right: f64) -> Ordering {
    if left < right {
        Ordering::Less
    } else if left > right {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

/// F2.5: the order of the two x coordinates when their enclosures are disjoint, else `None`.
fn crossing_x_filter(left: FillEvent, right: FillEvent) -> Option<Ordering> {
    let decision = compare_enclosures(x_enclosure(left), x_enclosure(right));
    fill_filter::record(FilterId::EventCrossingX, decision.is_some());
    decision
}

/// An enclosure of an event's exact x coordinate. An endpoint's x is exact. A crossing's x is
/// X / W, enclosed by evaluating `crossing_position`'s formula from its four binary64 points in
/// interval arithmetic (R1, R2):
///
/// - `line(p, q)` = (py - qy, qx - px, px * qy - py * qx), the exact coefficients of
///   `fill_exact::line`;
/// - X = L.y * R.z - L.z * R.y and W = L.x * R.y - L.y * R.x, as in `crossing_position`.
///
/// The exact routine negates X and W together when W < 0, which leaves X / W unchanged, so the
/// quotient encloses x without that step. Division needs a W enclosure that excludes zero;
/// nearly parallel crossings and every overflow give the undecidable interval.
///
/// Width, to first order (the "decides when" column of section 3.7). Each rounded operation
/// widens by at most 2 ulps of its result. With M the largest coordinate magnitude, the
/// coefficients carry absolute errors of about 4u * M (x, y) and 8u * M^2 (z); X and W then
/// carry about 32u * M^3 and 16u * M^2, and the quotient a relative width of about
/// 64u * κ with κ = M^2 / |W| (times M / |x| for X), the crossing's condition number. Disjoint
/// enclosures therefore decide when |x1 - x2| > 64u * κ * (|x1| + |x2|).
fn x_enclosure(event: FillEvent) -> Interval {
    match event {
        FillEvent::Endpoint(point) => Interval::point(point.x),
        FillEvent::Crossing { a, b, c, d } => {
            let left = line_enclosure(a, b);
            let right = line_enclosure(c, d);
            let numerator = left.y.mul(right.z).sub(left.z.mul(right.y));
            let weight = left.x.mul(right.y).sub(left.y.mul(right.x));
            numerator.div(weight)
        }
    }
}

struct LineEnclosure {
    x: Interval,
    y: Interval,
    z: Interval,
}

fn line_enclosure(start: Point, end: Point) -> LineEnclosure {
    let ax = Interval::point(start.x);
    let ay = Interval::point(start.y);
    let bx = Interval::point(end.x);
    let by = Interval::point(end.y);
    LineEnclosure {
        x: ay.sub(by),
        y: bx.sub(ax),
        z: ax.mul(by).sub(ay.mul(bx)),
    }
}

fn compare_position_coordinate(
    left_numerator: Signed<HOMOGENEOUS_LIMBS>,
    left_weight: Signed<LINE_LIMBS>,
    right_numerator: Signed<HOMOGENEOUS_LIMBS>,
    right_weight: Signed<LINE_LIMBS>,
) -> Ordering {
    compare_ratios::<
        HOMOGENEOUS_LIMBS,
        LINE_LIMBS,
        HOMOGENEOUS_LIMBS,
        LINE_LIMBS,
        EVENT_COMPARISON_LIMBS,
    >(left_numerator, left_weight, right_numerator, right_weight)
}

fn validate_event(event: FillEvent) -> Result<(), EventError> {
    let finite = match event {
        FillEvent::Endpoint(point) => point_is_finite(point),
        FillEvent::Crossing { a, b, c, d } => {
            point_is_finite(a) && point_is_finite(b) && point_is_finite(c) && point_is_finite(d)
        }
    };
    finite.then_some(()).ok_or(EventError::NonFinite)
}

fn point_is_finite(point: Point) -> bool {
    point.x.is_finite() && point.y.is_finite()
}

// `cfg(test)` reference copies of the pre-U3 comparisons (B0R oracle O1): no F0.4 or F2.5, and
// the crossing classification through the pre-U3 `segment_relation`.

/// Pre-U3 `compare_event_positions`.
#[cfg(test)]
pub(crate) fn b0r_reference_compare_event_positions(
    left: FillEvent,
    right: FillEvent,
) -> Result<Ordering, EventError> {
    validate_event(left)?;
    validate_event(right)?;
    let left = b0r_reference_exact_event_position(left)?;
    let right = b0r_reference_exact_event_position(right)?;
    let x_order = compare_position_coordinate(left.x, left.w, right.x, right.w);
    if x_order != Ordering::Equal {
        return Ok(x_order);
    }
    Ok(compare_position_coordinate(
        left.y, left.w, right.y, right.w,
    ))
}

/// Pre-U3 `compare_event_x`.
#[cfg(test)]
pub(crate) fn b0r_reference_compare_event_x(
    left: FillEvent,
    right: FillEvent,
) -> Result<Ordering, EventError> {
    validate_event(left)?;
    validate_event(right)?;
    let left = b0r_reference_exact_event_position(left)?;
    let right = b0r_reference_exact_event_position(right)?;
    Ok(compare_position_coordinate(
        left.x, left.w, right.x, right.w,
    ))
}

/// Pre-U3 `exact_event_position`.
#[cfg(test)]
pub(crate) fn b0r_reference_exact_event_position(
    event: FillEvent,
) -> Result<ExactEventPosition, EventError> {
    validate_event(event)?;
    match event {
        FillEvent::Endpoint(point) => Ok(endpoint_position(point)),
        FillEvent::Crossing { a, b, c, d } => {
            if crate::fill_predicates::b0r_reference_segment_relation(a, b, c, d)
                .map_err(|_| EventError::NonFinite)?
                != SegmentRelation::ProperCrossing
            {
                return Err(EventError::NotProperCrossing);
            }
            Ok(crossing_position(a, b, c, d))
        }
    }
}

/// Test access to the F2.5 enclosure of an event's x coordinate.
#[cfg(test)]
pub(crate) fn b0r_test_x_enclosure(event: FillEvent) -> Interval {
    x_enclosure(event)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    #[test]
    fn endpoint_and_crossing_order_remains_exact_after_factoring() {
        let crossing = FillEvent::Crossing {
            a: point(0.0, 0.0),
            b: point(2.0, 2.0),
            c: point(0.0, 2.0),
            d: point(2.0, 0.0),
        };
        assert_eq!(
            compare_event_x(FillEvent::Endpoint(point(0.0, 9.0)), crossing),
            Ok(Ordering::Less)
        );
        assert_eq!(
            compare_event_positions(crossing, FillEvent::Endpoint(point(1.0, 1.0))),
            Ok(Ordering::Equal)
        );
        assert_eq!(
            compare_event_positions(crossing, FillEvent::Endpoint(point(1.0, 2.0))),
            Ok(Ordering::Less)
        );
    }

    #[test]
    fn both_operands_are_validated_before_crossing_classification() {
        let nonproper = FillEvent::Crossing {
            a: point(0.0, 0.0),
            b: point(1.0, 0.0),
            c: point(0.0, 1.0),
            d: point(1.0, 1.0),
        };
        let nonfinite = FillEvent::Endpoint(point(f64::NAN, 0.0));
        assert_eq!(
            compare_event_x(nonproper, nonfinite),
            Err(EventError::NonFinite)
        );
        assert_eq!(
            compare_event_positions(nonproper, nonfinite),
            Err(EventError::NonFinite)
        );
    }
}
