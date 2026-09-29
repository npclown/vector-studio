use core::cmp::Ordering;

use crate::fill_exact::{
    compare_ratios, crossing_position, endpoint_position, ExactEventPosition, Signed,
    EVENT_COMPARISON_LIMBS, HOMOGENEOUS_LIMBS, LINE_LIMBS,
};
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

pub(crate) fn compare_event_positions(
    left: FillEvent,
    right: FillEvent,
) -> Result<Ordering, EventError> {
    validate_event(left)?;
    validate_event(right)?;
    let left = exact_event_position(left)?;
    let right = exact_event_position(right)?;
    let x_order = compare_position_coordinate(left.x, left.w, right.x, right.w);
    if x_order != Ordering::Equal {
        return Ok(x_order);
    }
    Ok(compare_position_coordinate(
        left.y, left.w, right.y, right.w,
    ))
}

pub(crate) fn compare_event_x(left: FillEvent, right: FillEvent) -> Result<Ordering, EventError> {
    validate_event(left)?;
    validate_event(right)?;
    let left = exact_event_position(left)?;
    let right = exact_event_position(right)?;
    Ok(compare_position_coordinate(
        left.x, left.w, right.x, right.w,
    ))
}

pub(crate) fn exact_event_position(event: FillEvent) -> Result<ExactEventPosition, EventError> {
    validate_event(event)?;
    match event {
        FillEvent::Endpoint(point) => Ok(endpoint_position(point)),
        FillEvent::Crossing { a, b, c, d } => {
            if segment_relation(a, b, c, d).map_err(|_| EventError::NonFinite)?
                != SegmentRelation::ProperCrossing
            {
                return Err(EventError::NotProperCrossing);
            }
            Ok(crossing_position(a, b, c, d))
        }
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
