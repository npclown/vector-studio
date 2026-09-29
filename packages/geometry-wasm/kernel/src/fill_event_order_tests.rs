use crate::fill_event_order::*;
use crate::geometry::Point;
use core::cmp::Ordering;
use std::hint::black_box;

const FIXTURE: &str = include_str!("../../../../tests/fixtures/p3-fill-event-order-v1.txt");

fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}

#[test]
fn x_comparison_ignores_y_without_changing_lexicographic_order() {
    let low = FillEvent::Endpoint(point(1.0, -5.0));
    let high = crossing(
        point(0.0, 3.0),
        point(2.0, 5.0),
        point(0.0, 5.0),
        point(2.0, 3.0),
    );
    assert_eq!(compare_event_positions(low, high), Ok(Ordering::Less));
    assert_eq!(compare_event_x(low, high), Ok(Ordering::Equal));
    assert_eq!(compare_event_x(high, low), Ok(Ordering::Equal));
    for (a, b, expected) in [
        (low, FillEvent::Endpoint(point(2.0, -100.0)), Ordering::Less),
        (
            FillEvent::Endpoint(point(-0.0, 1.0)),
            FillEvent::Endpoint(point(0.0, -1.0)),
            Ordering::Equal,
        ),
    ] {
        assert_eq!(compare_event_x(a, b), Ok(expected));
        assert_eq!(compare_event_x(b, a), Ok(expected.reverse()));
    }
}

#[test]
fn x_comparison_validates_both_events_before_classification() {
    let invalid = crossing(
        point(0.0, 0.0),
        point(1.0, 0.0),
        point(0.0, 1.0),
        point(1.0, 1.0),
    );
    let endpoint = FillEvent::Endpoint(point(0.0, 0.0));
    for nonfinite in [
        FillEvent::Endpoint(point(0.0, f64::NAN)),
        crossing(
            point(0.0, 0.0),
            point(1.0, 0.0),
            point(f64::INFINITY, 1.0),
            point(1.0, 1.0),
        ),
    ] {
        assert_eq!(
            compare_event_x(invalid, nonfinite),
            Err(EventError::NonFinite)
        );
        assert_eq!(
            compare_event_x(nonfinite, invalid),
            Err(EventError::NonFinite)
        );
    }
    assert_eq!(
        compare_event_x(invalid, endpoint),
        Err(EventError::NotProperCrossing)
    );
    assert_eq!(
        compare_event_x(endpoint, invalid),
        Err(EventError::NotProperCrossing)
    );
}

fn crossing(a: Point, b: Point, c: Point, d: Point) -> FillEvent {
    FillEvent::Crossing { a, b, c, d }
}

fn parse_point(fields: &[&str]) -> Point {
    assert_eq!(fields.len(), 2);
    point(
        f64::from_bits(u64::from_str_radix(fields[0], 16).unwrap()),
        f64::from_bits(u64::from_str_radix(fields[1], 16).unwrap()),
    )
}

fn parse_event(source: &str) -> FillEvent {
    let fields: Vec<_> = source.split_ascii_whitespace().collect();
    match fields.as_slice() {
        ["P", coordinates @ ..] => FillEvent::Endpoint(parse_point(coordinates)),
        ["X", coordinates @ ..] => {
            assert_eq!(coordinates.len(), 8);
            crossing(
                parse_point(&coordinates[0..2]),
                parse_point(&coordinates[2..4]),
                parse_point(&coordinates[4..6]),
                parse_point(&coordinates[6..8]),
            )
        }
        _ => panic!("invalid fixture event"),
    }
}

fn parse_fixture() -> Vec<(FillEvent, FillEvent, Ordering)> {
    FIXTURE
        .lines()
        .filter(|line| !line.starts_with('#'))
        .map(|line| {
            let fields: Vec<_> = line.split(" | ").collect();
            assert_eq!(fields.len(), 3);
            let expected = match fields[2] {
                "-1" => Ordering::Less,
                "0" => Ordering::Equal,
                "1" => Ordering::Greater,
                value => panic!("invalid fixture sign {value}"),
            };
            (parse_event(fields[0]), parse_event(fields[1]), expected)
        })
        .collect()
}

fn event_permutations(event: FillEvent) -> Vec<FillEvent> {
    let FillEvent::Crossing { a, b, c, d } = event else {
        return vec![event];
    };
    [
        [a, b, c, d],
        [b, a, c, d],
        [a, b, d, c],
        [b, a, d, c],
        [c, d, a, b],
        [d, c, a, b],
        [c, d, b, a],
        [d, c, b, a],
    ]
    .map(|[a, b, c, d]| crossing(a, b, c, d))
    .into()
}

#[test]
fn independent_fixture_matches_under_event_swap_and_all_crossing_permutations() {
    let rows = parse_fixture();
    assert_eq!(rows.len(), 528);
    for (left, right, expected) in rows {
        let left_variants = event_permutations(left);
        let right_variants = event_permutations(right);
        for &left_variant in &left_variants {
            for &right_variant in &right_variants {
                assert_eq!(
                    compare_event_positions(left_variant, right_variant),
                    Ok(expected)
                );
                assert_eq!(
                    compare_event_positions(right_variant, left_variant),
                    Ok(expected.reverse())
                );
            }
        }
    }
}

#[test]
fn every_pair_of_four_concurrent_lines_compares_equal() {
    let lines = [
        (point(0.0, 0.0), point(1.0, 1.0)),
        (point(0.0, 1.0), point(1.0, -1.0)),
        (point(-1.0, 1.0), point(1.0, 0.0)),
        (point(0.0, -1.0), point(1.0, 3.0)),
    ];
    let mut events = Vec::new();
    for first in 0..lines.len() {
        for second in first + 1..lines.len() {
            events.push(crossing(
                lines[first].0,
                lines[first].1,
                lines[second].0,
                lines[second].1,
            ));
        }
    }
    assert_eq!(events.len(), 6);
    for &left in &events {
        for &right in &events {
            assert_eq!(compare_event_positions(left, right), Ok(Ordering::Equal));
        }
    }
}

#[test]
fn endpoint_crossing_equality_and_equal_x_order_use_exact_y() {
    let diagonal = crossing(
        point(0.0, 0.0),
        point(4.0, 4.0),
        point(0.0, 4.0),
        point(4.0, 0.0),
    );
    assert_eq!(
        compare_event_positions(FillEvent::Endpoint(point(2.0, 2.0)), diagonal),
        Ok(Ordering::Equal)
    );
    let lower = crossing(
        point(0.0, 0.0),
        point(0.0, 4.0),
        point(-1.0, 1.0),
        point(1.0, 1.0),
    );
    let upper = crossing(
        point(0.0, 0.0),
        point(0.0, 4.0),
        point(-1.0, 2.0),
        point(1.0, 2.0),
    );
    assert_eq!(compare_event_positions(lower, upper), Ok(Ordering::Less));
}

fn transform_point(value: Point, scale: f64, translation: Point, reflect_x: bool) -> Point {
    point(
        (if reflect_x { -value.x } else { value.x }) * scale + translation.x,
        value.y * scale + translation.y,
    )
}

fn transform_event(event: FillEvent, scale: f64, translation: Point, reflect_x: bool) -> FillEvent {
    match event {
        FillEvent::Endpoint(value) => {
            FillEvent::Endpoint(transform_point(value, scale, translation, reflect_x))
        }
        FillEvent::Crossing { a, b, c, d } => crossing(
            transform_point(a, scale, translation, reflect_x),
            transform_point(b, scale, translation, reflect_x),
            transform_point(c, scale, translation, reflect_x),
            transform_point(d, scale, translation, reflect_x),
        ),
    }
}

#[test]
fn exact_scale_translation_reflection_and_half_ulp_crossing_preserve_order() {
    let endpoint = FillEvent::Endpoint(point(0.0, 0.0));
    let third = crossing(
        point(0.0, 0.0),
        point(1.0, 1.0),
        point(0.0, 1.0),
        point(1.0, -1.0),
    );
    for (scale, translation) in [(8.0, point(16.0, -24.0)), (0.125, point(0.0, 0.0))] {
        assert_eq!(
            compare_event_positions(
                transform_event(endpoint, scale, translation, false),
                transform_event(third, scale, translation, false),
            ),
            Ok(Ordering::Less)
        );
    }
    assert_eq!(
        compare_event_positions(
            transform_event(endpoint, 8.0, point(0.0, 0.0), true),
            transform_event(third, 8.0, point(0.0, 0.0), true),
        ),
        Ok(Ordering::Greater)
    );

    let base = 4_503_599_627_370_496.0;
    let half_ulp = crossing(
        point(base, base),
        point(base + 1.0, base + 1.0),
        point(base, base + 1.0),
        point(base + 1.0, base),
    );
    assert_eq!(
        compare_event_positions(half_ulp, FillEvent::Endpoint(point(base, base))),
        Ok(Ordering::Greater)
    );
}

fn replace_point_coordinate(value: &mut Point, coordinate: usize, replacement: f64) {
    if coordinate == 0 {
        value.x = replacement;
    } else {
        value.y = replacement;
    }
}

fn replace_event_coordinate(event: &mut FillEvent, coordinate: usize, replacement: f64) {
    match event {
        FillEvent::Endpoint(value) => replace_point_coordinate(value, coordinate, replacement),
        FillEvent::Crossing { a, b, c, d } => {
            let target = match coordinate / 2 {
                0 => a,
                1 => b,
                2 => c,
                3 => d,
                _ => panic!("crossing coordinate out of range"),
            };
            replace_point_coordinate(target, coordinate % 2, replacement);
        }
    }
}

#[test]
fn nonfinite_coordinates_in_both_variants_and_operands_precede_classification() {
    let endpoint = FillEvent::Endpoint(point(0.0, 0.0));
    let nonproper = crossing(
        point(0.0, 0.0),
        point(0.0, 0.0),
        point(1.0, 1.0),
        point(1.0, 1.0),
    );
    for nonfinite in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        for coordinate in 0..2 {
            let mut invalid = endpoint;
            replace_event_coordinate(&mut invalid, coordinate, nonfinite);
            assert_eq!(
                compare_event_positions(invalid, nonproper),
                Err(EventError::NonFinite)
            );
            assert_eq!(
                compare_event_positions(nonproper, invalid),
                Err(EventError::NonFinite)
            );
        }
        for coordinate in 0..8 {
            let mut invalid = nonproper;
            replace_event_coordinate(&mut invalid, coordinate, nonfinite);
            assert_eq!(
                compare_event_positions(invalid, endpoint),
                Err(EventError::NonFinite)
            );
            assert_eq!(
                compare_event_positions(endpoint, invalid),
                Err(EventError::NonFinite)
            );
            assert_eq!(
                compare_event_positions(invalid, nonproper),
                Err(EventError::NonFinite)
            );
            assert_eq!(
                compare_event_positions(nonproper, invalid),
                Err(EventError::NonFinite)
            );
        }
    }
}

#[test]
fn every_nonproper_crossing_relation_is_rejected_on_either_operand() {
    let endpoint = FillEvent::Endpoint(point(0.0, 0.0));
    let invalid = [
        crossing(
            point(0.0, 0.0),
            point(1.0, 0.0),
            point(0.0, 1.0),
            point(1.0, 1.0),
        ),
        crossing(
            point(0.0, 0.0),
            point(1.0, 1.0),
            point(1.0, 1.0),
            point(2.0, 0.0),
        ),
        crossing(
            point(0.0, 0.0),
            point(1.0, 0.0),
            point(1.0, 0.0),
            point(2.0, 0.0),
        ),
        crossing(
            point(0.0, 0.0),
            point(3.0, 0.0),
            point(1.0, 0.0),
            point(2.0, 0.0),
        ),
        crossing(
            point(1.0, 1.0),
            point(1.0, 1.0),
            point(0.0, 0.0),
            point(2.0, 2.0),
        ),
    ];
    for invalid_crossing in invalid {
        for variant in event_permutations(invalid_crossing) {
            assert_eq!(
                compare_event_positions(variant, endpoint),
                Err(EventError::NotProperCrossing)
            );
            assert_eq!(
                compare_event_positions(endpoint, variant),
                Err(EventError::NotProperCrossing)
            );
        }
    }
}

#[test]
fn endpoint_crossing_equal_and_error_comparisons_allocate_nothing() {
    let endpoint = FillEvent::Endpoint(point(0.0, 0.0));
    let endpoint_later = FillEvent::Endpoint(point(1.0, 0.0));
    let proper = crossing(
        point(0.0, 0.0),
        point(1.0, 1.0),
        point(0.0, 1.0),
        point(1.0, -1.0),
    );
    let proper_equal = crossing(
        point(0.0, 1.0),
        point(1.0, -1.0),
        point(-1.0, 1.0),
        point(1.0, 0.0),
    );
    let nonproper = crossing(
        point(0.0, 0.0),
        point(1.0, 0.0),
        point(0.0, 1.0),
        point(1.0, 1.0),
    );
    let nonfinite = FillEvent::Endpoint(point(f64::NAN, 0.0));
    let mut correct = true;
    crate::allocation_test_support::start();
    for _ in 0..128 {
        correct &=
            black_box(compare_event_positions(endpoint, endpoint_later)) == Ok(Ordering::Less);
        correct &= black_box(compare_event_positions(endpoint, proper)) == Ok(Ordering::Less);
        correct &= black_box(compare_event_positions(proper, proper_equal)) == Ok(Ordering::Equal);
        correct &= black_box(compare_event_positions(nonproper, endpoint))
            == Err(EventError::NotProperCrossing);
        correct &=
            black_box(compare_event_positions(nonfinite, nonproper)) == Err(EventError::NonFinite);
    }
    let allocations = crate::allocation_test_support::stop();
    assert!(correct);
    assert_eq!(allocations, 0);
}
