use crate::fill_intersections::*;
use crate::geometry::{Bounds, Point};
use std::hint::black_box;

const FIXTURE: &str = include_str!("../../../../tests/fixtures/p3-fill-intersections-v1.txt");
const TOLERANCE: f64 = 1.0e-8;

#[derive(Clone, Copy)]
struct FixtureRow {
    points: [Point; 4],
    directed: [f64; 4],
}

fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}

fn parse_fixture() -> Vec<FixtureRow> {
    FIXTURE
        .lines()
        .filter(|line| !line.starts_with('#'))
        .map(|line| {
            let fields: Vec<_> = line.split_ascii_whitespace().collect();
            assert_eq!(fields.len(), 12);
            let bits: Vec<_> = fields
                .iter()
                .map(|field| u64::from_str_radix(field, 16).unwrap())
                .collect();
            FixtureRow {
                points: [
                    point(f64::from_bits(bits[0]), f64::from_bits(bits[1])),
                    point(f64::from_bits(bits[2]), f64::from_bits(bits[3])),
                    point(f64::from_bits(bits[4]), f64::from_bits(bits[5])),
                    point(f64::from_bits(bits[6]), f64::from_bits(bits[7])),
                ],
                directed: [
                    f64::from_bits(bits[8]),
                    f64::from_bits(bits[9]),
                    f64::from_bits(bits[10]),
                    f64::from_bits(bits[11]),
                ],
            }
        })
        .collect()
}

fn permutations([a, b, c, d]: [Point; 4]) -> [[Point; 4]; 8] {
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
}

fn point_bits(value: Point) -> [u64; 2] {
    [value.x.to_bits(), value.y.to_bits()]
}

fn assert_bit_identical(actual: &SegmentIntersection, expected: &SegmentIntersection) {
    match (actual, expected) {
        (SegmentIntersection::Disjoint, SegmentIntersection::Disjoint) => {}
        (SegmentIntersection::Point(actual), SegmentIntersection::Point(expected)) => {
            assert_eq!(point_bits(actual.point), point_bits(expected.point));
            assert_eq!(
                actual.enclosure.min_x.to_bits(),
                expected.enclosure.min_x.to_bits()
            );
            assert_eq!(
                actual.enclosure.min_y.to_bits(),
                expected.enclosure.min_y.to_bits()
            );
            assert_eq!(
                actual.enclosure.max_x.to_bits(),
                expected.enclosure.max_x.to_bits()
            );
            assert_eq!(
                actual.enclosure.max_y.to_bits(),
                expected.enclosure.max_y.to_bits()
            );
            assert_eq!(actual.error_bound.to_bits(), expected.error_bound.to_bits());
        }
        (
            SegmentIntersection::Overlap {
                start: actual_start,
                end: actual_end,
            },
            SegmentIntersection::Overlap {
                start: expected_start,
                end: expected_end,
            },
        ) => {
            assert_eq!(point_bits(*actual_start), point_bits(*expected_start));
            assert_eq!(point_bits(*actual_end), point_bits(*expected_end));
        }
        _ => panic!("intersection variants differ: {actual:?} != {expected:?}"),
    }
}

fn certified(value: Point) -> SegmentIntersection {
    SegmentIntersection::Point(CertifiedPoint {
        point: value,
        enclosure: Bounds {
            min_x: value.x,
            min_y: value.y,
            max_x: value.x,
            max_y: value.y,
        },
        error_bound: 0.0,
    })
}

fn overlap(start: Point, end: Point) -> SegmentIntersection {
    SegmentIntersection::Overlap { start, end }
}

fn assert_success_permutations(points: [Point; 4], expected: &SegmentIntersection) {
    for [a, b, c, d] in permutations(points) {
        let actual = segment_intersection(a, b, c, d, TOLERANCE).unwrap();
        assert_bit_identical(&actual, expected);
    }
}

fn assert_error_permutations(points: [Point; 4], expected: IntersectionError) {
    for [a, b, c, d] in permutations(points) {
        assert_eq!(segment_intersection(a, b, c, d, TOLERANCE), Err(expected));
    }
}

#[test]
fn independent_crossing_fixture_resolves_with_directed_bounds_and_permutation_identity() {
    let rows = parse_fixture();
    assert_eq!(rows.len(), 260);
    for FixtureRow { points, directed } in rows {
        let baseline =
            segment_intersection(points[0], points[1], points[2], points[3], TOLERANCE).unwrap();
        let SegmentIntersection::Point(certified) = baseline else {
            panic!("proper crossing did not produce a certified point");
        };
        let [x_floor, x_ceil, y_floor, y_ceil] = directed;
        assert!(certified.enclosure.min_x <= x_floor);
        assert!(certified.enclosure.max_x >= x_ceil);
        assert!(certified.enclosure.min_y <= y_floor);
        assert!(certified.enclosure.max_y >= y_ceil);
        assert!(certified.point.x >= certified.enclosure.min_x);
        assert!(certified.point.x <= certified.enclosure.max_x);
        assert!(certified.point.y >= certified.enclosure.min_y);
        assert!(certified.point.y <= certified.enclosure.max_y);
        assert!(certified.error_bound.is_finite());
        assert!(certified.error_bound >= 0.0 && certified.error_bound <= TOLERANCE);
        for [a, b, c, d] in permutations(points) {
            let actual = segment_intersection(a, b, c, d, TOLERANCE).unwrap();
            assert_bit_identical(&actual, &baseline);
        }
    }
}

#[test]
fn exact_points_degeneracies_and_disjoint_segments_are_canonical() {
    assert_success_permutations(
        [
            point(0.0, 0.0),
            point(1.0, 1.0),
            point(1.0, 1.0),
            point(2.0, 0.0),
        ],
        &certified(point(1.0, 1.0)),
    );
    assert_success_permutations(
        [
            point(0.0, 0.0),
            point(1.0, 1.0),
            point(1.0, 1.0),
            point(2.0, 2.0),
        ],
        &certified(point(1.0, 1.0)),
    );
    assert_success_permutations(
        [
            point(0.0, 0.0),
            point(2.0, 0.0),
            point(1.0, 0.0),
            point(1.0, 2.0),
        ],
        &certified(point(1.0, 0.0)),
    );
    assert_success_permutations(
        [
            point(-0.0, 0.0),
            point(0.0, -0.0),
            point(0.0, 0.0),
            point(0.0, 0.0),
        ],
        &certified(point(0.0, 0.0)),
    );
    assert_success_permutations(
        [
            point(1.0, 1.0),
            point(1.0, 1.0),
            point(0.0, 0.0),
            point(2.0, 2.0),
        ],
        &certified(point(1.0, 1.0)),
    );
    assert_success_permutations(
        [
            point(3.0, 3.0),
            point(3.0, 3.0),
            point(0.0, 0.0),
            point(2.0, 2.0),
        ],
        &SegmentIntersection::Disjoint,
    );
    assert_success_permutations(
        [
            point(1.0, 1.0),
            point(1.0, 1.0),
            point(2.0, 2.0),
            point(2.0, 2.0),
        ],
        &SegmentIntersection::Disjoint,
    );
    assert_success_permutations(
        [
            point(0.0, 0.0),
            point(1.0, 0.0),
            point(0.0, 1.0),
            point(1.0, 1.0),
        ],
        &SegmentIntersection::Disjoint,
    );

    let minimum = f64::from_bits(1);
    assert_success_permutations(
        [
            point(0.0, 0.0),
            point(minimum, minimum),
            point(minimum, minimum),
            point(minimum, 0.0),
        ],
        &certified(point(minimum, minimum)),
    );
    assert_success_permutations(
        [
            point(-f64::MAX, 1.0),
            point(f64::MAX, 1.0),
            point(f64::MAX, 1.0),
            point(f64::MAX, 2.0),
        ],
        &certified(point(f64::MAX, 1.0)),
    );
}

#[test]
fn exact_overlap_forms_use_existing_lexicographic_endpoints() {
    assert_success_permutations(
        [
            point(0.0, 0.0),
            point(3.0, 0.0),
            point(2.0, 0.0),
            point(4.0, 0.0),
        ],
        &overlap(point(2.0, 0.0), point(3.0, 0.0)),
    );
    assert_success_permutations(
        [
            point(0.0, 0.0),
            point(3.0, 0.0),
            point(0.0, 0.0),
            point(3.0, 0.0),
        ],
        &overlap(point(0.0, 0.0), point(3.0, 0.0)),
    );
    assert_success_permutations(
        [
            point(0.0, 0.0),
            point(4.0, 0.0),
            point(1.0, 0.0),
            point(3.0, 0.0),
        ],
        &overlap(point(1.0, 0.0), point(3.0, 0.0)),
    );
    assert_success_permutations(
        [
            point(2.0, -2.0),
            point(2.0, 4.0),
            point(2.0, -1.0),
            point(2.0, 3.0),
        ],
        &overlap(point(2.0, -1.0), point(2.0, 3.0)),
    );
    assert_success_permutations(
        [
            point(-0.0, 0.0),
            point(2.0, 0.0),
            point(0.0, -0.0),
            point(1.0, 0.0),
        ],
        &overlap(point(0.0, 0.0), point(1.0, 0.0)),
    );
}

fn assert_encloses_exact_crossing(points: [Point; 4], expected: Point) {
    let result =
        segment_intersection(points[0], points[1], points[2], points[3], TOLERANCE).unwrap();
    let SegmentIntersection::Point(certified) = result else {
        panic!("transformed crossing did not produce a point");
    };
    assert!(certified.enclosure.min_x <= expected.x && expected.x <= certified.enclosure.max_x);
    assert!(certified.enclosure.min_y <= expected.y && expected.y <= certified.enclosure.max_y);
    assert!(certified.error_bound <= TOLERANCE);
    assert_success_permutations(points, &result);
}

#[test]
fn exact_scale_translation_and_reflection_have_independent_expected_crossings() {
    assert_encloses_exact_crossing(
        [
            point(8.0, -16.0),
            point(40.0, 16.0),
            point(8.0, 16.0),
            point(40.0, -16.0),
        ],
        point(24.0, 0.0),
    );
    assert_encloses_exact_crossing(
        [
            point(-8.0, -16.0),
            point(-40.0, 16.0),
            point(-8.0, 16.0),
            point(-40.0, -16.0),
        ],
        point(-24.0, 0.0),
    );
    assert_encloses_exact_crossing(
        [
            point(3.0, 5.0),
            point(7.0, 9.0),
            point(3.0, 9.0),
            point(7.0, 5.0),
        ],
        point(5.0, 7.0),
    );
}

#[test]
fn uncertain_proper_crossings_fail_for_every_permutation() {
    assert_error_permutations(
        [
            point(-f64::MAX, -f64::MAX),
            point(f64::MAX, f64::MAX),
            point(-f64::MAX, f64::MAX),
            point(f64::MAX, -f64::MAX),
        ],
        IntersectionError::Unresolved,
    );
    let minimum = f64::from_bits(1);
    assert_error_permutations(
        [
            point(0.0, 0.0),
            point(minimum, minimum),
            point(0.0, minimum),
            point(minimum, 0.0),
        ],
        IntersectionError::Unresolved,
    );
    assert_error_permutations(
        [
            point(0.0, 0.0),
            point(1.0, 1.0),
            point(0.0, f64::EPSILON),
            point(1.0, 1.0 - f64::EPSILON),
        ],
        IntersectionError::Unresolved,
    );
}

fn replace_coordinate(points: &mut [Point; 4], index: usize, value: f64) {
    if index.is_multiple_of(2) {
        points[index / 2].x = value;
    } else {
        points[index / 2].y = value;
    }
}

#[test]
fn nonfinite_coordinates_precede_invalid_tolerance_in_all_positions() {
    for nonfinite in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        for coordinate in 0..8 {
            let mut points = [point(0.0, 0.0); 4];
            replace_coordinate(&mut points, coordinate, nonfinite);
            assert_eq!(
                segment_intersection(points[0], points[1], points[2], points[3], 0.0),
                Err(IntersectionError::NonFinite)
            );
        }
    }
}

#[test]
fn every_relation_rejects_nan_infinite_zero_and_negative_tolerance() {
    let relations = [
        [
            point(0.0, 0.0),
            point(1.0, 0.0),
            point(0.0, 1.0),
            point(1.0, 1.0),
        ],
        [
            point(0.0, 0.0),
            point(1.0, 1.0),
            point(1.0, 1.0),
            point(2.0, 0.0),
        ],
        [
            point(0.0, 0.0),
            point(3.0, 0.0),
            point(1.0, 0.0),
            point(2.0, 0.0),
        ],
        [
            point(0.0, 0.0),
            point(1.0, 1.0),
            point(1.0, 1.0),
            point(2.0, 2.0),
        ],
        [
            point(0.0, 0.0),
            point(4.0, 4.0),
            point(0.0, 4.0),
            point(4.0, 0.0),
        ],
    ];
    for tolerance in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.0, -0.0, -1.0] {
        for points in relations {
            for [a, b, c, d] in permutations(points) {
                assert_eq!(
                    segment_intersection(a, b, c, d, tolerance),
                    Err(IntersectionError::InvalidTolerance)
                );
            }
        }
    }
}

fn next_down_positive(value: f64) -> f64 {
    assert!(value > 0.0 && value.is_finite());
    f64::from_bits(value.to_bits() - 1)
}

#[test]
fn positive_certificate_is_the_tolerance_acceptance_boundary() {
    let points = [
        point(0.0, 0.0),
        point(1.0, 1.0),
        point(0.0, 1.0),
        point(1.0, -1.0),
    ];
    let result =
        segment_intersection(points[0], points[1], points[2], points[3], TOLERANCE).unwrap();
    let SegmentIntersection::Point(certified) = result else {
        panic!("non-dyadic crossing did not return a point");
    };
    assert!(certified.error_bound > 0.0);
    assert!(segment_intersection(
        points[0],
        points[1],
        points[2],
        points[3],
        certified.error_bound,
    )
    .is_ok());
    let below = next_down_positive(certified.error_bound);
    let expected = if below == 0.0 {
        IntersectionError::InvalidTolerance
    } else {
        IntersectionError::Unresolved
    };
    assert_eq!(
        segment_intersection(points[0], points[1], points[2], points[3], below),
        Err(expected)
    );
}

#[test]
fn successful_and_error_intersections_allocate_nothing() {
    let crossing = [
        point(0.0, 0.0),
        point(4.0, 4.0),
        point(0.0, 4.0),
        point(4.0, 0.0),
    ];
    let disjoint = [
        point(0.0, 0.0),
        point(1.0, 0.0),
        point(0.0, 1.0),
        point(1.0, 1.0),
    ];
    let exact_overlap = [
        point(0.0, 0.0),
        point(3.0, 0.0),
        point(1.0, 0.0),
        point(2.0, 0.0),
    ];
    let minimum = f64::from_bits(1);
    let unresolved = [
        point(0.0, 0.0),
        point(minimum, minimum),
        point(0.0, minimum),
        point(minimum, 0.0),
    ];
    let invalid = [point(f64::NAN, 0.0); 4];
    let mut correct = true;
    crate::allocation_test_support::start();
    for _ in 0..256 {
        correct &= matches!(
            black_box(segment_intersection(
                crossing[0],
                crossing[1],
                crossing[2],
                crossing[3],
                TOLERANCE,
            )),
            Ok(SegmentIntersection::Point(_))
        );
        correct &= black_box(segment_intersection(
            disjoint[0],
            disjoint[1],
            disjoint[2],
            disjoint[3],
            TOLERANCE,
        )) == Ok(SegmentIntersection::Disjoint);
        correct &= matches!(
            black_box(segment_intersection(
                exact_overlap[0],
                exact_overlap[1],
                exact_overlap[2],
                exact_overlap[3],
                TOLERANCE,
            )),
            Ok(SegmentIntersection::Overlap { .. })
        );
        correct &= black_box(segment_intersection(
            unresolved[0],
            unresolved[1],
            unresolved[2],
            unresolved[3],
            TOLERANCE,
        )) == Err(IntersectionError::Unresolved);
        correct &= black_box(segment_intersection(
            invalid[0], invalid[1], invalid[2], invalid[3], 0.0,
        )) == Err(IntersectionError::NonFinite);
    }
    let allocations = crate::allocation_test_support::stop();
    assert!(correct);
    assert_eq!(allocations, 0);
}

#[test]
#[ignore]
fn emit_certified_intersections() {
    let rows = parse_fixture();
    println!("P3_INTERSECTIONS_BEGIN");
    for (index, FixtureRow { points, .. }) in rows.into_iter().enumerate() {
        let result =
            segment_intersection(points[0], points[1], points[2], points[3], TOLERANCE).unwrap();
        let SegmentIntersection::Point(certified) = result else {
            panic!("fixture row {index} did not produce a point");
        };
        println!(
            "{index} {:016x} {:016x} {:016x} {:016x} {:016x} {:016x} {:016x}",
            certified.point.x.to_bits(),
            certified.point.y.to_bits(),
            certified.enclosure.min_x.to_bits(),
            certified.enclosure.min_y.to_bits(),
            certified.enclosure.max_x.to_bits(),
            certified.enclosure.max_y.to_bits(),
            certified.error_bound.to_bits(),
        );
    }
    println!("P3_INTERSECTIONS_END");
}
