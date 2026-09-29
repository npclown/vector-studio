use crate::fill_predicates::*;
use crate::geometry::Point;
use core::cmp::Ordering;
use std::hint::black_box;

const FIXTURE: &str = include_str!("../../../../tests/fixtures/p3-fill-orientation-v1.txt");

fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}

fn ordering(sign: i8) -> Ordering {
    match sign {
        -1 => Ordering::Less,
        0 => Ordering::Equal,
        1 => Ordering::Greater,
        _ => panic!("invalid sign {sign}"),
    }
}

fn parse_fixture() -> Vec<([Point; 3], Ordering)> {
    FIXTURE
        .lines()
        .filter(|line| !line.starts_with('#'))
        .map(|line| {
            let fields: Vec<_> = line.split_ascii_whitespace().collect();
            assert_eq!(fields.len(), 7);
            let bits: Vec<_> = fields[..6]
                .iter()
                .map(|field| u64::from_str_radix(field, 16).unwrap())
                .collect();
            let sign = fields[6].parse::<i8>().unwrap();
            (
                [
                    point(f64::from_bits(bits[0]), f64::from_bits(bits[1])),
                    point(f64::from_bits(bits[2]), f64::from_bits(bits[3])),
                    point(f64::from_bits(bits[4]), f64::from_bits(bits[5])),
                ],
                ordering(sign),
            )
        })
        .collect()
}

fn reverse(value: Ordering) -> Ordering {
    value.reverse()
}

#[test]
fn independent_fixture_and_all_permutations_match_exactly() {
    let rows = parse_fixture();
    assert_eq!(rows.len(), 4_112);
    for ([a, b, c], expected) in rows {
        let cases = [
            ([a, b, c], expected),
            ([b, c, a], expected),
            ([c, a, b], expected),
            ([a, c, b], reverse(expected)),
            ([c, b, a], reverse(expected)),
            ([b, a, c], reverse(expected)),
        ];
        for ([p, q, r], sign) in cases {
            assert_eq!(orient2d(p, q, r), Ok(sign));
        }
    }
}

fn assert_relation_symmetries(a: Point, b: Point, c: Point, d: Point, expected: SegmentRelation) {
    for (p, q) in [(a, b), (b, a)] {
        for (r, s) in [(c, d), (d, c)] {
            assert_eq!(segment_relation(p, q, r, s), Ok(expected));
            assert_eq!(segment_relation(r, s, p, q), Ok(expected));
        }
    }
}

#[test]
fn point_membership_is_exact_inclusive_and_handles_degenerate_segments() {
    assert_eq!(
        point_on_segment(point(1.0, 1.0), point(0.0, 0.0), point(2.0, 2.0)),
        Ok(true)
    );
    assert_eq!(
        point_on_segment(point(0.0, 0.0), point(0.0, 0.0), point(2.0, 2.0)),
        Ok(true)
    );
    assert_eq!(
        point_on_segment(point(2.0, 2.0), point(0.0, 0.0), point(2.0, 2.0)),
        Ok(true)
    );
    assert_eq!(
        point_on_segment(
            point(1.0, 1.0 + f64::EPSILON),
            point(0.0, 0.0),
            point(2.0, 2.0)
        ),
        Ok(false)
    );
    assert_eq!(
        point_on_segment(point(-0.0, 0.0), point(0.0, -0.0), point(0.0, 0.0)),
        Ok(true)
    );
    assert_eq!(
        point_on_segment(point(0.0, 1.0), point(0.0, 0.0), point(0.0, 2.0)),
        Ok(true)
    );
    assert_eq!(
        point_on_segment(point(1.0, 0.0), point(0.0, 0.0), point(2.0, 0.0)),
        Ok(true)
    );
    assert_eq!(
        point_on_segment(point(2.0, 2.0), point(1.0, 1.0), point(1.0, 1.0)),
        Ok(false)
    );
}

#[test]
fn all_segment_relations_obey_endpoint_and_segment_symmetry() {
    assert_relation_symmetries(
        point(0.0, 0.0),
        point(1.0, 0.0),
        point(0.0, 1.0),
        point(1.0, 1.0),
        SegmentRelation::Disjoint,
    );
    assert_relation_symmetries(
        point(0.0, 0.0),
        point(2.0, 0.0),
        point(1.0, -1.0),
        point(1.0, 0.0),
        SegmentRelation::Touch,
    );
    assert_relation_symmetries(
        point(0.0, 0.0),
        point(2.0, 2.0),
        point(0.0, 2.0),
        point(2.0, 0.0),
        SegmentRelation::ProperCrossing,
    );
    assert_relation_symmetries(
        point(0.0, 0.0),
        point(1.0, 0.0),
        point(1.0, 0.0),
        point(2.0, 0.0),
        SegmentRelation::CollinearPoint,
    );
    assert_relation_symmetries(
        point(0.0, 0.0),
        point(3.0, 0.0),
        point(1.0, 0.0),
        point(2.0, 0.0),
        SegmentRelation::CollinearOverlap,
    );
}

#[test]
fn segment_degeneracies_and_extreme_exact_cases_are_classified() {
    assert_relation_symmetries(
        point(-0.0, 0.0),
        point(0.0, -0.0),
        point(0.0, 0.0),
        point(0.0, 0.0),
        SegmentRelation::CollinearPoint,
    );
    assert_relation_symmetries(
        point(1.0, 1.0),
        point(1.0, 1.0),
        point(0.0, 0.0),
        point(2.0, 2.0),
        SegmentRelation::CollinearPoint,
    );
    assert_relation_symmetries(
        point(3.0, 3.0),
        point(3.0, 3.0),
        point(0.0, 0.0),
        point(2.0, 2.0),
        SegmentRelation::Disjoint,
    );
    assert_relation_symmetries(
        point(0.0, f64::MIN_POSITIVE),
        point(0.0, f64::MIN_POSITIVE * 3.0),
        point(0.0, f64::MIN_POSITIVE * 2.0),
        point(0.0, f64::MIN_POSITIVE * 4.0),
        SegmentRelation::CollinearOverlap,
    );
    assert_relation_symmetries(
        point(-f64::MAX, 1.0),
        point(f64::MAX, 1.0),
        point(0.0, 1.0),
        point(f64::MAX, 1.0),
        SegmentRelation::CollinearOverlap,
    );
    assert_relation_symmetries(
        point(0.0, 0.0),
        point(4_503_599_627_370_496.0, 4_503_599_627_370_495.0),
        point(0.0, 1.0),
        point(4_503_599_627_370_497.0, 4_503_599_627_370_496.0),
        SegmentRelation::Disjoint,
    );
}

fn replace_coordinate<const N: usize>(points: &mut [Point; N], index: usize, value: f64) {
    if index.is_multiple_of(2) {
        points[index / 2].x = value;
    } else {
        points[index / 2].y = value;
    }
}

#[test]
fn every_nonfinite_coordinate_is_rejected_before_degenerate_shortcuts() {
    for nonfinite in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        for coordinate in 0..6 {
            let mut points = [point(0.0, 0.0); 3];
            replace_coordinate(&mut points, coordinate, nonfinite);
            assert_eq!(
                orient2d(points[0], points[1], points[2]),
                Err(PredicateError::NonFinite)
            );
            assert_eq!(
                point_on_segment(points[0], points[1], points[2]),
                Err(PredicateError::NonFinite)
            );
        }
        for coordinate in 0..8 {
            let mut points = [point(-0.0, 0.0); 4];
            replace_coordinate(&mut points, coordinate, nonfinite);
            assert_eq!(
                segment_relation(points[0], points[1], points[2], points[3]),
                Err(PredicateError::NonFinite)
            );
        }
    }
    assert_eq!(
        segment_relation(
            point(-f64::MAX, f64::from_bits(1)),
            point(f64::MAX, f64::from_bits(2)),
            point(0.0, f64::from_bits(1)),
            point(0.0, f64::from_bits(3)),
        ),
        Ok(SegmentRelation::ProperCrossing)
    );
}

fn transform(value: Point, scale: f64, translate: Point, reflect_x: bool) -> Point {
    Point {
        x: (if reflect_x { -value.x } else { value.x }) * scale + translate.x,
        y: value.y * scale + translate.y,
    }
}

#[test]
fn exact_translations_scales_and_reflection_obey_metamorphic_relations() {
    let triangle = [point(1.0, 2.0), point(5.0, 3.0), point(2.0, 7.0)];
    let transforms = [
        (1.0, point(8.0, -16.0), false, Ordering::Greater),
        (8.0, point(0.0, 0.0), false, Ordering::Greater),
        (0.125, point(0.0, 0.0), false, Ordering::Greater),
        (1.0, point(0.0, 0.0), true, Ordering::Less),
    ];
    for (scale, translate, reflect_x, expected) in transforms {
        let [a, b, c] = triangle.map(|value| transform(value, scale, translate, reflect_x));
        assert_eq!(orient2d(a, b, c), Ok(expected));
    }

    let segments = [
        point(0.0, 0.0),
        point(4.0, 4.0),
        point(0.0, 4.0),
        point(4.0, 0.0),
    ];
    for (scale, translate, reflect_x, _) in transforms {
        let [a, b, c, d] = segments.map(|value| transform(value, scale, translate, reflect_x));
        assert_eq!(
            segment_relation(a, b, c, d),
            Ok(SegmentRelation::ProperCrossing)
        );
    }
}

#[test]
fn shifted_product_boundaries_and_highest_limb_have_exact_signs() {
    let origin = point(0.0, 0.0);
    for shift in [0_u64, 63, 64, 127] {
        let b = point(f64::from_bits(1), 0.0);
        let c = point(0.0, f64::from_bits((shift + 1) << 52));
        assert_eq!(orient2d(origin, b, c), Ok(Ordering::Greater));
        assert_eq!(orient2d(origin, c, b), Ok(Ordering::Less));
    }
    assert_eq!(
        orient2d(origin, point(f64::MAX, 0.0), point(0.0, f64::MAX)),
        Ok(Ordering::Greater)
    );
    assert_eq!(
        orient2d(
            point(-f64::MAX, -f64::MAX),
            point(f64::MAX, -f64::MAX),
            point(-f64::MAX, f64::MAX),
        ),
        Ok(Ordering::Greater)
    );
}

#[test]
fn successful_and_error_predicates_allocate_nothing() {
    let finite = [
        point(0.0, 0.0),
        point(2.0, 0.0),
        point(1.0, 1.0),
        point(1.0, -1.0),
    ];
    let invalid = point(f64::NAN, 0.0);
    let mut correct = true;
    crate::allocation_test_support::start();
    for _ in 0..256 {
        correct &= black_box(orient2d(finite[0], finite[1], finite[2])) == Ok(Ordering::Greater);
        correct &= black_box(point_on_segment(finite[0], finite[0], finite[1])) == Ok(true);
        correct &= black_box(segment_relation(finite[0], finite[1], finite[2], finite[3]))
            == Ok(SegmentRelation::ProperCrossing);
        correct &=
            black_box(orient2d(invalid, finite[0], finite[1])) == Err(PredicateError::NonFinite);
        correct &= black_box(point_on_segment(finite[0], invalid, invalid))
            == Err(PredicateError::NonFinite);
        correct &= black_box(segment_relation(invalid, invalid, finite[0], finite[0]))
            == Err(PredicateError::NonFinite);
    }
    let allocations = crate::allocation_test_support::stop();
    assert!(correct);
    assert_eq!(allocations, 0);
}
