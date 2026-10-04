use core::mem::size_of;
use std::env;

use crate::geometry::{Point, Provenance};
use crate::rounded_line_fill_tests::print_points;
use crate::simple_cubic_topology::{
    ArrangementCrossing, ArrangementOutput, TopologyCubic, TopologyError, TopologyInput,
    TopologyLeaf, TopologyLimits, TopologyRange, TopologyStats, TransverseArrangementWorkspace,
};
use crate::simple_cubic_topology_tests::{
    print_input_tokens, print_ranges, read_topology_fixture_with_kinds, status_name,
};

const HEADER: &str = "# p3-native-triangle-free-arrangement-v1";
const EXPECTED_ROWS: usize = 42;

#[derive(Clone)]
struct OwnedInput {
    contours: Vec<TopologyRange>,
    cubics: Vec<TopologyCubic>,
    leaves: Vec<TopologyLeaf>,
}

fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}

fn quarter_cubic(start: Point, end: Point) -> [Point; 4] {
    [
        start,
        point((3.0 * start.x + end.x) / 4.0, (3.0 * start.y + end.y) / 4.0),
        point((start.x + 3.0 * end.x) / 4.0, (start.y + 3.0 * end.y) / 4.0),
        end,
    ]
}

fn third_cubic(start: Point, end: Point) -> [Point; 4] {
    [
        start,
        point((2.0 * start.x + end.x) / 3.0, (2.0 * start.y + end.y) / 3.0),
        point((start.x + 2.0 * end.x) / 3.0, (start.y + 2.0 * end.y) / 3.0),
        end,
    ]
}

fn line_adapter(start: Point, end: Point) -> [Point; 4] {
    [start, start, end, end]
}

fn empty_input() -> OwnedInput {
    OwnedInput {
        contours: Vec::new(),
        cubics: Vec::new(),
        leaves: Vec::new(),
    }
}

fn append_sources(owned: &mut OwnedInput, sources: &[[Point; 4]], first_ordinal: u32) {
    let cubic_start = owned.cubics.len();
    for (index, &points) in sources.iter().enumerate() {
        let source_verb = first_ordinal + index as u32;
        let leaf_start = owned.leaves.len();
        owned.leaves.push(TopologyLeaf {
            end: points[3],
            provenance: Provenance {
                source_verb,
                end_numerator: 1,
                depth: 0,
            },
        });
        owned.cubics.push(TopologyCubic {
            points,
            source_verb,
            leaves: TopologyRange {
                start: leaf_start,
                count: 1,
            },
        });
    }
    owned.contours.push(TopologyRange {
        start: cubic_start,
        count: sources.len(),
    });
}

fn contour_sources(vertices: &[Point], explicit_return: bool) -> Vec<[Point; 4]> {
    let source_count = if explicit_return {
        vertices.len()
    } else {
        vertices.len() - 1
    };
    (0..source_count)
        .map(|index| quarter_cubic(vertices[index], vertices[(index + 1) % vertices.len()]))
        .collect()
}

fn star_vertices() -> ([Point; 3], [Point; 4]) {
    (
        [point(-3.0, 0.0), point(3.0, 0.0), point(0.0, -10.0)],
        [
            point(-1.0, -1.0),
            point(1.0, -1.0),
            point(1.0, 1.0),
            point(-1.0, 1.0),
        ],
    )
}

fn build_star(
    left_vertices: Vec<Point>,
    right_vertices: Vec<Point>,
    explicit_return: bool,
    source_kinds: &[bool],
    curved_first: bool,
) -> OwnedInput {
    let mut left = contour_sources(&left_vertices, explicit_return);
    let mut right = contour_sources(&right_vertices, explicit_return);
    if curved_first {
        left[0] = [
            left_vertices[0],
            point(-1.0, 1.0 / 16.0),
            point(1.0, -1.0 / 16.0),
            left_vertices[1],
        ];
    }
    for (source, &marked) in left.iter_mut().chain(right.iter_mut()).zip(source_kinds) {
        if marked {
            *source = line_adapter(source[0], source[3]);
        }
    }
    let mut owned = empty_input();
    append_sources(&mut owned, &left, 1);
    append_sources(&mut owned, &right, 1 + left.len() as u32);
    owned
}

fn star() -> (OwnedInput, [bool; 7]) {
    let (left, right) = star_vertices();
    let kinds = [false; 7];
    (
        build_star(left.to_vec(), right.to_vec(), true, &kinds, false),
        kinds,
    )
}

fn reflected_star() -> (OwnedInput, [bool; 7]) {
    let (left, right) = star_vertices();
    let reflect = |value: Point| point(-value.x, value.y);
    let kinds = [false; 7];
    (
        build_star(
            left.map(reflect).to_vec(),
            right.map(reflect).to_vec(),
            true,
            &kinds,
            false,
        ),
        kinds,
    )
}

fn reversed_star() -> (OwnedInput, [bool; 7]) {
    let (left, right) = star_vertices();
    let reversed_left = vec![left[0], left[2], left[1]];
    let reversed_right = vec![right[0], right[3], right[2], right[1]];
    let kinds = [false; 7];
    (
        build_star(reversed_left, reversed_right, true, &kinds, false),
        kinds,
    )
}

fn implicit_star() -> (OwnedInput, [bool; 5]) {
    let (left, right) = star_vertices();
    let kinds = [false; 5];
    (
        build_star(left.to_vec(), right.to_vec(), false, &kinds, false),
        kinds,
    )
}

fn mixed_star() -> (OwnedInput, [bool; 7]) {
    let (left, right) = star_vertices();
    let kinds = [true, false, false, false, false, false, false];
    (
        build_star(left.to_vec(), right.to_vec(), true, &kinds, false),
        kinds,
    )
}

fn all_line_star() -> (OwnedInput, [bool; 7]) {
    let (left, right) = star_vertices();
    let kinds = [true; 7];
    (
        build_star(left.to_vec(), right.to_vec(), true, &kinds, false),
        kinds,
    )
}

fn curved_star() -> (OwnedInput, [bool; 7]) {
    let (left, right) = star_vertices();
    let kinds = [false; 7];
    (
        build_star(left.to_vec(), right.to_vec(), true, &kinds, true),
        kinds,
    )
}

fn cap_input(p: f64, q: f64) -> (OwnedInput, [bool; 16]) {
    let left = [
        point(-20.0, -2.0),
        point(20.0, -1.0),
        point(-20.0, 0.0),
        point(20.0, 1.0),
        point(-20.0, 2.0),
        point(20.0, 3.0),
        point(20.0, 4.0),
        point(-20.5, 4.0),
    ];
    let right = [
        point(-8.0, -5.0),
        point(-4.0, p),
        point(0.0, -5.0),
        point(4.0, q),
        point(8.0, -5.0),
        point(12.0, 5.0),
        point(16.0, 5.0),
        point(16.0, -6.0),
    ];
    let kinds = [false; 16];
    (
        build_star(left.to_vec(), right.to_vec(), true, &kinds, false),
        kinds,
    )
}

fn triangle(concurrent: bool) -> (OwnedInput, [bool; 7]) {
    let vertices = if concurrent {
        [
            point(0.0, 0.0),
            point(6.0, 6.0),
            point(6.0, -2.0),
            point(-1.0, 5.0),
            point(7.5, 2.0),
            point(-2.0, 2.0),
            point(-3.0, -2.0),
        ]
    } else {
        [
            point(0.0, 0.0),
            point(5.0, 6.0),
            point(5.0, -1.0),
            point(-1.0, 5.0),
            point(7.0, 2.0),
            point(-2.0, 2.0),
            point(-3.0, -2.0),
        ]
    };
    let kinds = [false; 7];
    let mut owned = empty_input();
    append_sources(&mut owned, &contour_sources(&vertices, true), 1);
    (owned, kinds)
}

fn n_line_cubic() -> (OwnedInput, [bool; 8]) {
    let vertices = [
        point(-3.0, -3.0),
        point(3.0, 3.0),
        point(3.0, 4.5),
        point(-3.0, 4.5),
        point(-3.0, 3.0),
        point(3.0, -3.0),
        point(3.0, -4.5),
        point(-3.0, -4.5),
    ];
    let kinds = [true, false, false, false, false, false, false, false];
    let mut sources: Vec<_> = (0..vertices.len())
        .map(|index| {
            let start = vertices[index];
            let end = vertices[(index + 1) % vertices.len()];
            if index == 4 {
                [
                    start,
                    point(-1.0, 1.0 + 1.0 / 16.0),
                    point(1.0, -1.0 - 1.0 / 16.0),
                    end,
                ]
            } else {
                third_cubic(start, end)
            }
        })
        .collect();
    sources[0] = line_adapter(sources[0][0], sources[0][3]);
    let mut owned = empty_input();
    append_sources(&mut owned, &sources, 1);
    (owned, kinds)
}

#[test]
fn triangle_free_star_variants_preserve_crossing_order_and_ranges() {
    let fixtures: Vec<(OwnedInput, Vec<bool>, [ArrangementCrossing; 2])> = vec![
        (
            star().0,
            star().1.to_vec(),
            [
                ArrangementCrossing {
                    left_leaf: 0,
                    right_leaf: 4,
                    orientation: 1,
                },
                ArrangementCrossing {
                    left_leaf: 0,
                    right_leaf: 6,
                    orientation: -1,
                },
            ],
        ),
        (
            reflected_star().0,
            reflected_star().1.to_vec(),
            [
                ArrangementCrossing {
                    left_leaf: 0,
                    right_leaf: 4,
                    orientation: -1,
                },
                ArrangementCrossing {
                    left_leaf: 0,
                    right_leaf: 6,
                    orientation: 1,
                },
            ],
        ),
        (
            reversed_star().0,
            reversed_star().1.to_vec(),
            [
                ArrangementCrossing {
                    left_leaf: 2,
                    right_leaf: 3,
                    orientation: -1,
                },
                ArrangementCrossing {
                    left_leaf: 2,
                    right_leaf: 5,
                    orientation: 1,
                },
            ],
        ),
        (
            implicit_star().0,
            implicit_star().1.to_vec(),
            [
                ArrangementCrossing {
                    left_leaf: 0,
                    right_leaf: 4,
                    orientation: 1,
                },
                ArrangementCrossing {
                    left_leaf: 0,
                    right_leaf: 6,
                    orientation: -1,
                },
            ],
        ),
        (
            mixed_star().0,
            mixed_star().1.to_vec(),
            [
                ArrangementCrossing {
                    left_leaf: 0,
                    right_leaf: 4,
                    orientation: 1,
                },
                ArrangementCrossing {
                    left_leaf: 0,
                    right_leaf: 6,
                    orientation: -1,
                },
            ],
        ),
        (
            all_line_star().0,
            all_line_star().1.to_vec(),
            [
                ArrangementCrossing {
                    left_leaf: 0,
                    right_leaf: 4,
                    orientation: 1,
                },
                ArrangementCrossing {
                    left_leaf: 0,
                    right_leaf: 6,
                    orientation: -1,
                },
            ],
        ),
        (
            curved_star().0,
            curved_star().1.to_vec(),
            [
                ArrangementCrossing {
                    left_leaf: 0,
                    right_leaf: 4,
                    orientation: 1,
                },
                ArrangementCrossing {
                    left_leaf: 0,
                    right_leaf: 6,
                    orientation: -1,
                },
            ],
        ),
    ];
    for (owned, kinds, expected_crossings) in fixtures {
        let mut workspace = TransverseArrangementWorkspace::new(TopologyLimits::default()).unwrap();
        assert_triangle_attempt(
            &mut workspace,
            &owned,
            &kinds,
            Ok(()),
            TopologyStats {
                leaves: 7,
                pairs: 21,
            },
        );
        let output = workspace.output().unwrap();
        assert_eq!(
            output.contours,
            &[
                TopologyRange { start: 0, count: 3 },
                TopologyRange { start: 3, count: 4 }
            ]
        );
        assert_eq!(output.points.len(), 7);
        assert_eq!(output.crossings, expected_crossings);
    }
}

#[test]
fn triangle_free_limits_triangle_and_crossing_capacity_are_inclusive() {
    let (star, star_kinds) = star();
    let mut exact = TransverseArrangementWorkspace::new(TopologyLimits {
        max_contours: 2,
        max_cubics: 7,
        max_leaves: 7,
        max_pairs: 21,
        ..TopologyLimits::default()
    })
    .unwrap();
    assert_triangle_attempt(
        &mut exact,
        &star,
        &star_kinds,
        Ok(()),
        TopologyStats {
            leaves: 7,
            pairs: 21,
        },
    );
    for limits in [
        TopologyLimits {
            max_contours: 1,
            ..TopologyLimits::default()
        },
        TopologyLimits {
            max_cubics: 6,
            ..TopologyLimits::default()
        },
        TopologyLimits {
            max_leaves: 6,
            ..TopologyLimits::default()
        },
    ] {
        let mut workspace = TransverseArrangementWorkspace::new(limits).unwrap();
        assert_triangle_attempt(
            &mut workspace,
            &star,
            &star_kinds,
            Err(TopologyError::WorkLimit),
            TopologyStats::default(),
        );
    }
    for max_pairs in [20, 0] {
        let mut workspace = TransverseArrangementWorkspace::new(TopologyLimits {
            max_pairs,
            ..TopologyLimits::default()
        })
        .unwrap();
        assert_triangle_attempt(
            &mut workspace,
            &star,
            &star_kinds,
            Err(TopologyError::WorkLimit),
            TopologyStats {
                leaves: 7,
                pairs: max_pairs,
            },
        );
    }

    let (implicit, implicit_kinds) = implicit_star();
    for (max_leaves, expected, stats) in [
        (
            6,
            Err(TopologyError::WorkLimit),
            TopologyStats {
                leaves: 6,
                pairs: 0,
            },
        ),
        (
            7,
            Ok(()),
            TopologyStats {
                leaves: 7,
                pairs: 21,
            },
        ),
    ] {
        let mut workspace = TransverseArrangementWorkspace::new(TopologyLimits {
            max_cubics: 5,
            max_leaves,
            max_pairs: 21,
            ..TopologyLimits::default()
        })
        .unwrap();
        assert_triangle_attempt(&mut workspace, &implicit, &implicit_kinds, expected, stats);
    }

    let (cap, cap_kinds) = cap_input(3.5, 3.5);
    let mut cap_workspace = TransverseArrangementWorkspace::new(TopologyLimits::default()).unwrap();
    assert_triangle_attempt(
        &mut cap_workspace,
        &cap,
        &cap_kinds,
        Ok(()),
        TopologyStats {
            leaves: 16,
            pairs: 120,
        },
    );
    assert_eq!(cap_workspace.output().unwrap().crossings.len(), 32);
    for (limits, stats) in [
        (
            TopologyLimits {
                max_cubics: 15,
                ..TopologyLimits::default()
            },
            TopologyStats::default(),
        ),
        (
            TopologyLimits {
                max_pairs: 119,
                ..TopologyLimits::default()
            },
            TopologyStats {
                leaves: 16,
                pairs: 119,
            },
        ),
    ] {
        let mut workspace = TransverseArrangementWorkspace::new(limits).unwrap();
        assert_triangle_attempt(
            &mut workspace,
            &cap,
            &cap_kinds,
            Err(TopologyError::WorkLimit),
            stats,
        );
    }

    let (overflow, overflow_kinds) = cap_input(3.5, 5.0);
    for (max_pairs, expected_pairs) in [(80, 80), (81, 81), (2_016, 81)] {
        let mut workspace = TransverseArrangementWorkspace::new(TopologyLimits {
            max_pairs,
            ..TopologyLimits::default()
        })
        .unwrap();
        assert_triangle_attempt(
            &mut workspace,
            &overflow,
            &overflow_kinds,
            Err(TopologyError::WorkLimit),
            TopologyStats {
                leaves: 16,
                pairs: expected_pairs,
            },
        );
    }

    for concurrent in [false, true] {
        let (triangle, triangle_kinds) = triangle(concurrent);
        for (max_pairs, expected) in [
            (12, TopologyError::WorkLimit),
            (13, TopologyError::Unresolved),
            (2_016, TopologyError::Unresolved),
        ] {
            let mut workspace = TransverseArrangementWorkspace::new(TopologyLimits {
                max_pairs,
                ..TopologyLimits::default()
            })
            .unwrap();
            assert_triangle_attempt(
                &mut workspace,
                &triangle,
                &triangle_kinds,
                Err(expected),
                TopologyStats {
                    leaves: 7,
                    pairs: max_pairs.min(13),
                },
            );
        }
    }
}

#[test]
fn triangle_free_preflight_kind_shape_and_knot_precedence_are_frozen() {
    let (base, kinds) = mixed_star();
    let mut workspace = TransverseArrangementWorkspace::new(TopologyLimits::default()).unwrap();
    for malformed_kinds in [&kinds[..6], &[false; 8][..]] {
        assert_triangle_attempt(
            &mut workspace,
            &base,
            malformed_kinds,
            Err(TopologyError::InvalidInput),
            TopologyStats::default(),
        );
    }

    let mut noncanonical = base.clone();
    noncanonical.cubics[0].points[1].x = noncanonical.cubics[0].points[1].x.next_up();
    assert_triangle_attempt(
        &mut workspace,
        &noncanonical,
        &kinds,
        Err(TopologyError::InvalidInput),
        TopologyStats::default(),
    );

    let mut multi_leaf = base.clone();
    let old_leaf = multi_leaf.leaves[0];
    multi_leaf.leaves[0] = TopologyLeaf {
        end: point(0.0, 0.0),
        provenance: Provenance {
            source_verb: old_leaf.provenance.source_verb,
            end_numerator: 1,
            depth: 1,
        },
    };
    multi_leaf.leaves.insert(
        1,
        TopologyLeaf {
            end: old_leaf.end,
            provenance: Provenance {
                source_verb: old_leaf.provenance.source_verb,
                end_numerator: 2,
                depth: 1,
            },
        },
    );
    multi_leaf.cubics[0].leaves.count = 2;
    for cubic in &mut multi_leaf.cubics[1..] {
        cubic.leaves.start += 1;
    }
    assert_triangle_attempt(
        &mut workspace,
        &multi_leaf,
        &kinds,
        Err(TopologyError::InvalidInput),
        TopologyStats::default(),
    );

    let mut nonfinite = base.clone();
    nonfinite.cubics[3].points[2].x = f64::INFINITY;
    let mut duplicate = base.clone();
    duplicate.cubics[6].source_verb = duplicate.cubics[0].source_verb;
    let mut disconnected = base.clone();
    disconnected.cubics[1].points[0].x = disconnected.cubics[1].points[0].x.next_up();
    for malformed in [&nonfinite, &duplicate, &disconnected] {
        assert_triangle_attempt(
            &mut workspace,
            malformed,
            &kinds,
            Err(TopologyError::InvalidInput),
            TopologyStats::default(),
        );
    }

    let mut provenance = base.clone();
    provenance.leaves[6].provenance.source_verb = 999;
    let mut shape_and_provenance = noncanonical.clone();
    shape_and_provenance.leaves[6].provenance.source_verb = 999;
    for malformed in [&provenance, &shape_and_provenance] {
        assert_triangle_attempt(
            &mut workspace,
            malformed,
            &kinds,
            Err(TopologyError::InvalidProvenance),
            TopologyStats::default(),
        );
    }

    let mut knot = base.clone();
    knot.leaves[0].end.x = knot.leaves[0].end.x.next_up();
    assert_triangle_attempt(
        &mut workspace,
        &knot,
        &kinds,
        Err(TopologyError::KnotMismatch),
        TopologyStats::default(),
    );
    let mut malformed_range_before_knot = knot.clone();
    malformed_range_before_knot.cubics[6].leaves.start -= 1;
    let mut nonfinite_before_knot = knot.clone();
    nonfinite_before_knot.cubics[5].points[2].y = f64::NAN;
    let mut duplicate_before_knot = knot.clone();
    duplicate_before_knot.cubics[6].source_verb = duplicate_before_knot.cubics[0].source_verb;
    let mut connectivity_before_knot = knot.clone();
    connectivity_before_knot.cubics[4].points[0].x =
        connectivity_before_knot.cubics[4].points[0].x.next_up();
    for malformed in [
        &malformed_range_before_knot,
        &nonfinite_before_knot,
        &duplicate_before_knot,
        &connectivity_before_knot,
    ] {
        assert_triangle_attempt(
            &mut workspace,
            malformed,
            &kinds,
            Err(TopologyError::InvalidInput),
            TopologyStats::default(),
        );
    }
    let mut provenance_before_knot = knot.clone();
    provenance_before_knot.leaves[6].provenance.source_verb = 999;
    assert_triangle_attempt(
        &mut workspace,
        &provenance_before_knot,
        &kinds,
        Err(TopologyError::InvalidProvenance),
        TopologyStats::default(),
    );
    let mut invalid_later_kind = kinds;
    invalid_later_kind[4] = true;
    assert_triangle_attempt(
        &mut workspace,
        &knot,
        &invalid_later_kind,
        Err(TopologyError::InvalidInput),
        TopologyStats::default(),
    );
}

fn assert_matching_restriction(owned: &OwnedInput, kinds: &[bool], expected_pairs: usize) {
    let mut workspace = TransverseArrangementWorkspace::new(TopologyLimits::default()).unwrap();
    assert_eq!(
        measured_mixed(&mut workspace, owned, kinds),
        Err(TopologyError::Unresolved)
    );
    assert_eq!(
        workspace.stats(),
        TopologyStats {
            leaves: owned.leaves.len(),
            pairs: expected_pairs
        }
    );
    assert!(workspace.output().is_none());
    assert_eq!(
        measured_old(&mut workspace, owned),
        Err(TopologyError::Unresolved)
    );
    assert_eq!(
        workspace.stats(),
        TopologyStats {
            leaves: owned.leaves.len(),
            pairs: expected_pairs
        }
    );
    assert!(workspace.output().is_none());
}

#[test]
fn old_matching_modes_retain_all_multiple_partner_restrictions() {
    let (star, kinds) = star();
    assert_matching_restriction(&star, &kinds, 6);
    let (reverse, reverse_kinds) = reversed_star();
    assert_matching_restriction(&reverse, &reverse_kinds, 14);
    for concurrent in [false, true] {
        let (triangle, triangle_kinds) = triangle(concurrent);
        assert_matching_restriction(&triangle, &triangle_kinds, 3);
    }
    for (p, q) in [(3.5, 3.5), (3.5, 5.0)] {
        let (cap, cap_kinds) = cap_input(p, q);
        assert_matching_restriction(&cap, &cap_kinds, 9);
    }
}

fn assert_cap_success(
    workspace: &mut TransverseArrangementWorkspace,
    cap: &OwnedInput,
    kinds: &[bool; 16],
) -> (Vec<[u64; 2]>, Vec<ArrangementCrossing>) {
    assert_triangle_attempt(
        workspace,
        cap,
        kinds,
        Ok(()),
        TopologyStats {
            leaves: 16,
            pairs: 120,
        },
    );
    let output = workspace.output().unwrap();
    assert_eq!(output.crossings.len(), 32);
    (point_bits(output.points), output.crossings.to_vec())
}

fn assert_cap_failure_recovery(
    workspace: &mut TransverseArrangementWorkspace,
    cap: &OwnedInput,
    cap_kinds: &[bool; 16],
    failure: impl FnOnce(&mut TransverseArrangementWorkspace),
) {
    let expected = assert_cap_success(workspace, cap, cap_kinds);
    failure(workspace);
    assert!(workspace.output().is_none());
    assert_eq!(assert_cap_success(workspace, cap, cap_kinds), expected);
}

#[test]
fn triangle_free_lifecycle_is_atomic_allocation_free_and_isolated() {
    assert_eq!(
        TransverseArrangementWorkspace::new(TopologyLimits {
            max_bytes: 0,
            ..TopologyLimits::default()
        })
        .err(),
        Some(TopologyError::ByteLimit)
    );
    let (cap, cap_kinds) = cap_input(3.5, 3.5);
    let (overflow, overflow_kinds) = cap_input(3.5, 5.0);
    let (triangle, triangle_kinds) = triangle(false);
    let mut invalid = cap.clone();
    invalid.cubics[15].source_verb = invalid.cubics[0].source_verb;
    let mut provenance = cap.clone();
    provenance.leaves[15].provenance.source_verb = 999;
    let mut knot = cap.clone();
    knot.leaves[15].end.x = knot.leaves[15].end.x.next_up();
    let mut invalid_kinds = cap_kinds;
    invalid_kinds[0] = true;

    let mut workspace = TransverseArrangementWorkspace::new(TopologyLimits::default()).unwrap();
    let mut independent = TransverseArrangementWorkspace::new(TopologyLimits::default()).unwrap();
    assert_eq!(workspace.allocated_bytes(), 224_256);
    assert_eq!(size_of::<TransverseArrangementWorkspace>(), 2_512);
    let independent_expected = assert_cap_success(&mut independent, &cap, &cap_kinds);

    assert_cap_failure_recovery(&mut workspace, &cap, &cap_kinds, |workspace| {
        assert_triangle_attempt(
            workspace,
            &invalid,
            &cap_kinds,
            Err(TopologyError::InvalidInput),
            TopologyStats::default(),
        );
    });
    assert_cap_failure_recovery(&mut workspace, &cap, &cap_kinds, |workspace| {
        assert_triangle_attempt(
            workspace,
            &cap,
            &invalid_kinds,
            Err(TopologyError::InvalidInput),
            TopologyStats::default(),
        );
    });
    assert_cap_failure_recovery(&mut workspace, &cap, &cap_kinds, |workspace| {
        assert_triangle_attempt(
            workspace,
            &provenance,
            &cap_kinds,
            Err(TopologyError::InvalidProvenance),
            TopologyStats::default(),
        );
    });
    assert_cap_failure_recovery(&mut workspace, &cap, &cap_kinds, |workspace| {
        assert_triangle_attempt(
            workspace,
            &knot,
            &cap_kinds,
            Err(TopologyError::KnotMismatch),
            TopologyStats::default(),
        );
    });
    assert_cap_failure_recovery(&mut workspace, &cap, &cap_kinds, |workspace| {
        assert_triangle_attempt(
            workspace,
            &triangle,
            &triangle_kinds,
            Err(TopologyError::Unresolved),
            TopologyStats {
                leaves: 7,
                pairs: 13,
            },
        );
    });
    assert_cap_failure_recovery(&mut workspace, &cap, &cap_kinds, |workspace| {
        assert_triangle_attempt(
            workspace,
            &overflow,
            &overflow_kinds,
            Err(TopologyError::WorkLimit),
            TopologyStats {
                leaves: 16,
                pairs: 81,
            },
        );
    });
    assert_eq!(
        assert_cap_success(&mut independent, &cap, &cap_kinds),
        independent_expected
    );

    let (mut caller_owned, mut caller_kinds) = cap_input(3.5, 3.5);
    let caller_expected = assert_cap_success(&mut workspace, &caller_owned, &caller_kinds);
    caller_owned.cubics[0].points.fill(point(99.0, 99.0));
    caller_owned.leaves[0].end = point(-99.0, -99.0);
    caller_kinds.fill(true);
    let output = workspace.output().unwrap();
    assert_eq!(point_bits(output.points), caller_expected.0);
    assert_eq!(output.crossings, caller_expected.1);

    let (star, star_kinds) = star();
    let mut pair_limited = TransverseArrangementWorkspace::new(TopologyLimits {
        max_pairs: 119,
        ..TopologyLimits::default()
    })
    .unwrap();
    assert_triangle_attempt(
        &mut pair_limited,
        &star,
        &star_kinds,
        Ok(()),
        TopologyStats {
            leaves: 7,
            pairs: 21,
        },
    );
    assert_triangle_attempt(
        &mut pair_limited,
        &cap,
        &cap_kinds,
        Err(TopologyError::WorkLimit),
        TopologyStats {
            leaves: 16,
            pairs: 119,
        },
    );
    assert_triangle_attempt(
        &mut pair_limited,
        &star,
        &star_kinds,
        Ok(()),
        TopologyStats {
            leaves: 7,
            pairs: 21,
        },
    );
}

#[test]
fn triangle_free_alternates_with_old_modes_and_preserves_stationary_regression() {
    let (line_cubic, kinds) = n_line_cubic();
    let mut workspace = TransverseArrangementWorkspace::new(TopologyLimits::default()).unwrap();
    assert_triangle_attempt(
        &mut workspace,
        &line_cubic,
        &kinds,
        Ok(()),
        TopologyStats {
            leaves: 8,
            pairs: 28,
        },
    );
    assert_eq!(
        measured_old(&mut workspace, &line_cubic),
        Err(TopologyError::Unresolved)
    );
    assert_eq!(
        workspace.stats(),
        TopologyStats {
            leaves: 8,
            pairs: 4
        }
    );
    assert!(workspace.output().is_none());
    assert_triangle_attempt(
        &mut workspace,
        &line_cubic,
        &kinds,
        Ok(()),
        TopologyStats {
            leaves: 8,
            pairs: 28,
        },
    );
    assert_eq!(measured_mixed(&mut workspace, &line_cubic, &kinds), Ok(()));
    assert_eq!(
        workspace.stats(),
        TopologyStats {
            leaves: 8,
            pairs: 28
        }
    );
    assert_triangle_attempt(
        &mut workspace,
        &line_cubic,
        &kinds,
        Ok(()),
        TopologyStats {
            leaves: 8,
            pairs: 28,
        },
    );

    let (star, star_kinds) = star();
    assert_triangle_attempt(
        &mut workspace,
        &star,
        &star_kinds,
        Ok(()),
        TopologyStats {
            leaves: 7,
            pairs: 21,
        },
    );
    assert_eq!(
        measured_mixed(&mut workspace, &star, &star_kinds),
        Err(TopologyError::Unresolved)
    );
    assert_eq!(
        workspace.stats(),
        TopologyStats {
            leaves: 7,
            pairs: 6
        }
    );
    assert_triangle_attempt(
        &mut workspace,
        &star,
        &star_kinds,
        Ok(()),
        TopologyStats {
            leaves: 7,
            pairs: 21,
        },
    );
}

fn input(owned: &OwnedInput) -> TopologyInput<'_> {
    TopologyInput {
        contours: &owned.contours,
        cubics: &owned.cubics,
        leaves: &owned.leaves,
    }
}

fn measured_triangle_free(
    workspace: &mut TransverseArrangementWorkspace,
    owned: &OwnedInput,
    kinds: &[bool],
) -> Result<(), TopologyError> {
    let bytes = workspace.allocated_bytes();
    crate::allocation_test_support::start();
    let result = workspace.certify_triangle_free(input(owned), kinds);
    let allocations = crate::allocation_test_support::stop();
    assert_eq!(allocations, 0, "triangle-free certification allocated");
    assert_eq!(workspace.allocated_bytes(), bytes);
    result
}

fn measured_mixed(
    workspace: &mut TransverseArrangementWorkspace,
    owned: &OwnedInput,
    kinds: &[bool],
) -> Result<(), TopologyError> {
    let bytes = workspace.allocated_bytes();
    crate::allocation_test_support::start();
    let result = workspace.certify_mixed(input(owned), kinds);
    let allocations = crate::allocation_test_support::stop();
    assert_eq!(allocations, 0, "matching mixed certification allocated");
    assert_eq!(workspace.allocated_bytes(), bytes);
    result
}

fn measured_old(
    workspace: &mut TransverseArrangementWorkspace,
    owned: &OwnedInput,
) -> Result<(), TopologyError> {
    let bytes = workspace.allocated_bytes();
    crate::allocation_test_support::start();
    let result = workspace.certify(input(owned));
    let allocations = crate::allocation_test_support::stop();
    assert_eq!(allocations, 0, "old matching certification allocated");
    assert_eq!(workspace.allocated_bytes(), bytes);
    result
}

fn assert_triangle_attempt(
    workspace: &mut TransverseArrangementWorkspace,
    owned: &OwnedInput,
    kinds: &[bool],
    expected: Result<(), TopologyError>,
    stats: TopologyStats,
) {
    let result = measured_triangle_free(workspace, owned, kinds);
    assert_eq!(result, expected);
    assert_eq!(workspace.stats(), stats);
    assert_eq!(workspace.output().is_some(), result.is_ok());
}

fn point_bits(points: &[Point]) -> Vec<[u64; 2]> {
    points
        .iter()
        .map(|value| [value.x.to_bits(), value.y.to_bits()])
        .collect()
}

fn print_crossings(crossings: &[ArrangementCrossing]) {
    print!("[");
    for (index, crossing) in crossings.iter().enumerate() {
        if index != 0 {
            print!(",");
        }
        print!(
            "{{\"left_leaf\":{},\"right_leaf\":{},\"orientation\":{}}}",
            crossing.left_leaf, crossing.right_leaf, crossing.orientation
        );
    }
    print!("]");
}

fn print_output(output: ArrangementOutput<'_>) {
    print!("{{\"points\":");
    print_points(output.points);
    print!(",\"contours\":");
    print_ranges(output.contours);
    print!(",\"crossings\":");
    print_crossings(output.crossings);
    print!("}}");
}

#[test]
#[ignore]
fn emit_triangle_free_arrangement() {
    let path = env::var("P3_NATIVE_TRIANGLE_FREE_ARRANGEMENT_INPUT")
        .expect("P3_NATIVE_TRIANGLE_FREE_ARRANGEMENT_INPUT required");
    let rows = read_topology_fixture_with_kinds(&path, HEADER, EXPECTED_ROWS);
    let mut workspace = TransverseArrangementWorkspace::new(TopologyLimits::default()).unwrap();
    let allocated_bytes = workspace.allocated_bytes();
    let inline_bytes = size_of::<TransverseArrangementWorkspace>();
    assert_eq!(allocated_bytes, 224_256);
    assert_eq!(inline_bytes, 2_512);
    println!("P3_NATIVE_TRIANGLE_FREE_ARRANGEMENT_BEGIN");
    for row in rows {
        let input = TopologyInput {
            contours: &row.contours,
            cubics: &row.cubics,
            leaves: &row.leaves,
        };
        let kinds = row.source_kinds.as_deref().expect("required source kinds");
        crate::allocation_test_support::start();
        let result = workspace.certify_triangle_free(input, kinds);
        let allocations = crate::allocation_test_support::stop();
        let stats = workspace.stats();
        assert_eq!(allocations, 0, "triangle-free certification allocated");
        assert_eq!(workspace.allocated_bytes(), allocated_bytes);
        print!("{{\"id\":\"{}\",\"input_tokens\":", row.id);
        print_input_tokens(&row);
        print!(
            ",\"status\":\"{}\",\"leaves\":{},\"pairs\":{},\"output\":",
            status_name(result),
            stats.leaves,
            stats.pairs
        );
        match workspace.output() {
            Some(output) => print_output(output),
            None => print!("null"),
        }
        println!(
            ",\"allocations\":{allocations},\"allocated_bytes\":{allocated_bytes},\"inline_bytes\":{inline_bytes}}}"
        );
    }
    println!("P3_NATIVE_TRIANGLE_FREE_ARRANGEMENT_END");
}
