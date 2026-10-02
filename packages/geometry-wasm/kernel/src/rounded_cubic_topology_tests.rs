use core::mem::size_of;
use std::env;

use crate::geometry::{Point, Provenance};
use crate::simple_cubic_topology::{
    RoundedKnotCubicTopologyWorkspace, TopologyCubic, TopologyError, TopologyInput, TopologyLeaf,
    TopologyLimits, TopologyRange, TopologyStats,
};
use crate::simple_cubic_topology_tests::{
    print_input_tokens, print_output, read_topology_fixture, status_name,
};

const EXPECTED_ROWS: usize = 29;
const HEADER: &str = "# p3-native-rounded-topology-v1";

fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}

fn linear(start: Point, end: Point) -> [Point; 4] {
    [
        start,
        point((2.0 * start.x + end.x) / 3.0, (2.0 * start.y + end.y) / 3.0),
        point((start.x + 2.0 * end.x) / 3.0, (start.y + 2.0 * end.y) / 3.0),
        end,
    ]
}

fn depth_two_linear_leaves(start: Point, end: Point, source_verb: u32) -> [TopologyLeaf; 4] {
    core::array::from_fn(|index| {
        let numerator = index + 1;
        let t = numerator as f64 / 4.0;
        TopologyLeaf {
            end: point(
                start.x + (end.x - start.x) * t,
                start.y + (end.y - start.y) * t,
            ),
            provenance: Provenance {
                source_verb,
                end_numerator: numerator as u32,
                depth: 2,
            },
        }
    })
}

fn append_triangle(
    offset: f64,
    first_ordinal: u32,
    contours: &mut Vec<TopologyRange>,
    cubics: &mut Vec<TopologyCubic>,
    leaves: &mut Vec<TopologyLeaf>,
) {
    let corners = [
        point(offset, 0.0),
        point(offset + 3.0, 0.0),
        point(offset + 1.5, -3.0),
    ];
    let sources = [
        [
            corners[0],
            point(offset + 1.0, 0.0),
            point(offset + 2.0, 1.0),
            corners[1],
        ],
        linear(corners[1], corners[2]),
        linear(corners[2], corners[0]),
    ];
    let cubic_start = cubics.len();
    for index in 0..3 {
        let source_verb = first_ordinal + index as u32;
        let start = corners[index];
        let end = corners[(index + 1) % corners.len()];
        let leaf_start = leaves.len();
        if index == 0 {
            for (numerator, end) in [
                point(offset + 0.75, 9.0 / 64.0),
                point(offset + 1.5, 3.0 / 8.0),
                point(offset + 2.25, 27.0 / 64.0),
                end,
            ]
            .into_iter()
            .enumerate()
            {
                leaves.push(TopologyLeaf {
                    end,
                    provenance: Provenance {
                        source_verb,
                        end_numerator: (numerator + 1) as u32,
                        depth: 2,
                    },
                });
            }
        } else {
            leaves.extend(depth_two_linear_leaves(start, end, source_verb));
        }
        cubics.push(TopologyCubic {
            points: sources[index],
            source_verb,
            leaves: TopologyRange {
                start: leaf_start,
                count: 4,
            },
        });
    }
    contours.push(TopologyRange {
        start: cubic_start,
        count: 3,
    });
}

fn triangle() -> (Vec<TopologyRange>, Vec<TopologyCubic>, Vec<TopologyLeaf>) {
    let mut contours = Vec::new();
    let mut cubics = Vec::new();
    let mut leaves = Vec::new();
    append_triangle(0.0, 1, &mut contours, &mut cubics, &mut leaves);
    (contours, cubics, leaves)
}

fn four_triangles() -> (Vec<TopologyRange>, Vec<TopologyCubic>, Vec<TopologyLeaf>) {
    let mut contours = Vec::new();
    let mut cubics = Vec::new();
    let mut leaves = Vec::new();
    for index in 0..4 {
        append_triangle(
            index as f64 * 16.0,
            1 + index * 3,
            &mut contours,
            &mut cubics,
            &mut leaves,
        );
    }
    (contours, cubics, leaves)
}

fn stationary_triangle() -> ([TopologyRange; 1], [TopologyCubic; 3], [TopologyLeaf; 3]) {
    let corners = [point(0.0, 0.0), point(3.0, 0.0), point(1.5, -3.0)];
    let cubics = core::array::from_fn(|index| {
        let start = corners[index];
        let end = corners[(index + 1) % corners.len()];
        TopologyCubic {
            points: [start, start, end, end],
            source_verb: (index + 1) as u32,
            leaves: TopologyRange {
                start: index,
                count: 1,
            },
        }
    });
    let leaves = core::array::from_fn(|index| TopologyLeaf {
        end: corners[(index + 1) % corners.len()],
        provenance: Provenance {
            source_verb: (index + 1) as u32,
            end_numerator: 1,
            depth: 0,
        },
    });
    ([TopologyRange { start: 0, count: 3 }], cubics, leaves)
}

fn closure_positive() -> ([TopologyRange; 1], [TopologyCubic; 2], [TopologyLeaf; 8]) {
    let a = point(0.0, 0.0);
    let b = point(3.0, 0.0);
    let c = point(0.0, -1.5);
    let e = 2.0f64.powi(-54);
    let first = [a, point(1.0, e), point(2.0, 1.0), b];
    let second = [b, point(2.0, -0.5), point(1.0, -1.0), c];
    let first_ends = [
        point(0.75, 9.0 / 64.0 + 2.0f64.powi(-55)),
        point(1.5, 3.0 / 8.0),
        point(2.25, 27.0 / 64.0),
        b,
    ];
    let second_ends = [
        point(2.25, -3.0 / 8.0),
        point(1.5, -3.0 / 4.0),
        point(0.75, -9.0 / 8.0),
        c,
    ];
    let leaves = core::array::from_fn(|index| {
        let (source_verb, local, end) = if index < 4 {
            (20, index, first_ends[index])
        } else {
            (21, index - 4, second_ends[index - 4])
        };
        TopologyLeaf {
            end,
            provenance: Provenance {
                source_verb,
                end_numerator: (local + 1) as u32,
                depth: 2,
            },
        }
    });
    let cubics = [
        TopologyCubic {
            points: first,
            source_verb: 20,
            leaves: TopologyRange { start: 0, count: 4 },
        },
        TopologyCubic {
            points: second,
            source_verb: 21,
            leaves: TopologyRange { start: 4, count: 4 },
        },
    ];
    ([TopologyRange { start: 0, count: 2 }], cubics, leaves)
}

fn input<'a>(
    contours: &'a [TopologyRange],
    cubics: &'a [TopologyCubic],
    leaves: &'a [TopologyLeaf],
) -> TopologyInput<'a> {
    TopologyInput {
        contours,
        cubics,
        leaves,
    }
}

fn measured_certify(
    workspace: &mut RoundedKnotCubicTopologyWorkspace,
    input: TopologyInput<'_>,
) -> Result<(), TopologyError> {
    let bytes = workspace.allocated_bytes();
    crate::allocation_test_support::start();
    let result = workspace.certify(input);
    let allocations = crate::allocation_test_support::stop();
    assert_eq!(allocations, 0, "rounded topology certification allocated");
    assert_eq!(workspace.allocated_bytes(), bytes);
    assert_eq!(workspace.output().is_some(), result.is_ok());
    result
}

fn certify_checked(
    limits: TopologyLimits,
    contours: &[TopologyRange],
    cubics: &[TopologyCubic],
    leaves: &[TopologyLeaf],
    expected: Result<(), TopologyError>,
    expected_stats: TopologyStats,
) {
    let mut workspace = RoundedKnotCubicTopologyWorkspace::new(limits).unwrap();
    assert_eq!(
        measured_certify(&mut workspace, input(contours, cubics, leaves)),
        expected
    );
    assert_eq!(workspace.stats(), expected_stats);
}

#[test]
fn rounded_constructor_limits_and_retained_capacity_are_stable() {
    assert!(matches!(
        RoundedKnotCubicTopologyWorkspace::new(TopologyLimits {
            max_contours: 0,
            ..TopologyLimits::default()
        }),
        Err(TopologyError::InvalidLimits)
    ));
    assert!(matches!(
        RoundedKnotCubicTopologyWorkspace::new(TopologyLimits {
            max_bytes: 1024 * 1024 + 1,
            ..TopologyLimits::default()
        }),
        Err(TopologyError::InvalidLimits)
    ));
    assert!(matches!(
        RoundedKnotCubicTopologyWorkspace::new(TopologyLimits {
            max_bytes: 0,
            ..TopologyLimits::default()
        }),
        Err(TopologyError::ByteLimit)
    ));

    let workspace = RoundedKnotCubicTopologyWorkspace::new(TopologyLimits::default()).unwrap();
    let bytes = workspace.allocated_bytes();
    assert!(bytes > 0 && bytes < 1024 * 1024);
    assert!(RoundedKnotCubicTopologyWorkspace::new(TopologyLimits {
        max_bytes: bytes,
        ..TopologyLimits::default()
    })
    .is_ok());
    assert!(matches!(
        RoundedKnotCubicTopologyWorkspace::new(TopologyLimits {
            max_bytes: bytes - 1,
            ..TopologyLimits::default()
        }),
        Err(TopologyError::ByteLimit)
    ));
}

#[test]
fn rounded_exact_triangle_and_four_copy_limits_are_inclusive() {
    let (contours, cubics, leaves) = triangle();
    certify_checked(
        TopologyLimits {
            max_leaves: 12,
            max_pairs: 66,
            ..TopologyLimits::default()
        },
        &contours,
        &cubics,
        &leaves,
        Ok(()),
        TopologyStats {
            leaves: 12,
            pairs: 66,
        },
    );
    certify_checked(
        TopologyLimits {
            max_leaves: 11,
            ..TopologyLimits::default()
        },
        &contours,
        &cubics,
        &leaves,
        Err(TopologyError::WorkLimit),
        TopologyStats::default(),
    );
    certify_checked(
        TopologyLimits {
            max_pairs: 65,
            ..TopologyLimits::default()
        },
        &contours,
        &cubics,
        &leaves,
        Err(TopologyError::WorkLimit),
        TopologyStats {
            leaves: 12,
            pairs: 65,
        },
    );
    certify_checked(
        TopologyLimits {
            max_pairs: 0,
            ..TopologyLimits::default()
        },
        &contours,
        &cubics,
        &leaves,
        Err(TopologyError::WorkLimit),
        TopologyStats {
            leaves: 12,
            pairs: 0,
        },
    );

    let (contours, cubics, leaves) = four_triangles();
    certify_checked(
        TopologyLimits {
            max_contours: 4,
            max_cubics: 12,
            max_leaves: 48,
            max_pairs: 1_128,
            ..TopologyLimits::default()
        },
        &contours,
        &cubics,
        &leaves,
        Ok(()),
        TopologyStats {
            leaves: 48,
            pairs: 1_128,
        },
    );
    for limits in [
        TopologyLimits {
            max_contours: 3,
            ..TopologyLimits::default()
        },
        TopologyLimits {
            max_cubics: 11,
            ..TopologyLimits::default()
        },
        TopologyLimits {
            max_leaves: 47,
            ..TopologyLimits::default()
        },
    ] {
        certify_checked(
            limits,
            &contours,
            &cubics,
            &leaves,
            Err(TopologyError::WorkLimit),
            TopologyStats::default(),
        );
    }
    certify_checked(
        TopologyLimits {
            max_pairs: 1_127,
            ..TopologyLimits::default()
        },
        &contours,
        &cubics,
        &leaves,
        Err(TopologyError::WorkLimit),
        TopologyStats {
            leaves: 48,
            pairs: 1_127,
        },
    );
}

#[test]
fn rounded_stationary_endpoint_tangents_allow_zero_coefficients_with_positive_sum() {
    let (contours, cubics, leaves) = stationary_triangle();
    let mut workspace = RoundedKnotCubicTopologyWorkspace::new(TopologyLimits::default()).unwrap();
    measured_certify(&mut workspace, input(&contours, &cubics, &leaves)).unwrap();
    assert_eq!(
        workspace.stats(),
        TopologyStats {
            leaves: 3,
            pairs: 3,
        }
    );
    let output = workspace.output().unwrap();
    assert_eq!(
        output.points,
        &[point(0.0, 0.0), point(3.0, 0.0), point(1.5, -3.0)]
    );
    assert_eq!(output.orientations, &[-1]);

    // Every [A,A,B,B] source has derivative coefficients 0, B-A, 0. Across the
    // three directed joins every central dot is positive: either 9/2 or 27/4.
    measured_certify(&mut workspace, input(&contours, &cubics, &leaves)).unwrap();
}

#[test]
fn rounded_earlier_closure_consumes_declared_leaf_cap_before_later_projection() {
    let (valid_contours, valid_cubics, valid_leaves) = stationary_triangle();
    let (first_contours, first_cubics, first_leaves) = closure_positive();
    let (second_contours, mut second_cubics, mut second_leaves) = triangle();
    for cubic in &mut second_cubics {
        for point in &mut cubic.points {
            point.x += 16.0;
        }
    }
    for leaf in &mut second_leaves {
        leaf.end.x += 16.0;
    }
    second_leaves[0].end = second_cubics[0].points[0];
    let contours = [
        first_contours[0],
        TopologyRange {
            start: first_cubics.len(),
            count: second_contours[0].count,
        },
    ];
    let mut cubics = first_cubics.to_vec();
    cubics.extend(second_cubics.iter().map(|cubic| TopologyCubic {
        leaves: TopologyRange {
            start: cubic.leaves.start + first_leaves.len(),
            count: cubic.leaves.count,
        },
        ..*cubic
    }));
    let mut leaves = first_leaves.to_vec();
    leaves.extend(second_leaves);
    assert_eq!(leaves.len(), 20);
    let mut workspace = RoundedKnotCubicTopologyWorkspace::new(TopologyLimits {
        max_contours: 2,
        max_cubics: 5,
        max_leaves: 20,
        max_pairs: 3,
        ..TopologyLimits::default()
    })
    .unwrap();
    measured_certify(
        &mut workspace,
        input(&valid_contours, &valid_cubics, &valid_leaves),
    )
    .unwrap();
    assert_eq!(
        measured_certify(&mut workspace, input(&contours, &cubics, &leaves)),
        Err(TopologyError::WorkLimit)
    );
    assert_eq!(
        workspace.stats(),
        TopologyStats {
            leaves: 20,
            pairs: 0,
        }
    );
    measured_certify(
        &mut workspace,
        input(&valid_contours, &valid_cubics, &valid_leaves),
    )
    .unwrap();

    let mut uncapped = RoundedKnotCubicTopologyWorkspace::new(TopologyLimits {
        max_contours: 2,
        max_cubics: 5,
        max_leaves: 21,
        max_pairs: 145,
        ..TopologyLimits::default()
    })
    .unwrap();
    measured_certify(
        &mut uncapped,
        input(&valid_contours, &valid_cubics, &valid_leaves),
    )
    .unwrap();
    assert_eq!(
        measured_certify(&mut uncapped, input(&contours, &cubics, &leaves)),
        Err(TopologyError::Unresolved)
    );
    assert_eq!(
        uncapped.stats(),
        TopologyStats {
            leaves: 21,
            pairs: 145,
        }
    );
    measured_certify(
        &mut uncapped,
        input(&valid_contours, &valid_cubics, &valid_leaves),
    )
    .unwrap();
}

#[test]
fn rounded_closure_is_charged_and_later_capacity_precedes_earlier_minimum() {
    let (contours, cubics, leaves) = closure_positive();
    certify_checked(
        TopologyLimits::default(),
        &contours,
        &cubics,
        &leaves,
        Ok(()),
        TopologyStats {
            leaves: 9,
            pairs: 36,
        },
    );
    certify_checked(
        TopologyLimits {
            max_leaves: 8,
            ..TopologyLimits::default()
        },
        &contours,
        &cubics,
        &leaves,
        Err(TopologyError::WorkLimit),
        TopologyStats {
            leaves: 8,
            pairs: 0,
        },
    );

    let constant_point = point(-16.0, 0.0);
    let mut combined_contours = vec![TopologyRange { start: 0, count: 1 }];
    combined_contours.push(TopologyRange { start: 1, count: 2 });
    let mut combined_cubics = vec![TopologyCubic {
        points: [constant_point; 4],
        source_verb: 1,
        leaves: TopologyRange { start: 0, count: 1 },
    }];
    combined_cubics.extend(cubics.iter().map(|cubic| TopologyCubic {
        source_verb: cubic.source_verb + 100,
        leaves: TopologyRange {
            start: cubic.leaves.start + 1,
            count: cubic.leaves.count,
        },
        ..*cubic
    }));
    let mut combined_leaves = vec![TopologyLeaf {
        end: constant_point,
        provenance: Provenance {
            source_verb: 1,
            end_numerator: 1,
            depth: 0,
        },
    }];
    combined_leaves.extend(leaves.iter().map(|leaf| TopologyLeaf {
        provenance: Provenance {
            source_verb: leaf.provenance.source_verb + 100,
            ..leaf.provenance
        },
        ..*leaf
    }));
    certify_checked(
        TopologyLimits {
            max_leaves: 9,
            ..TopologyLimits::default()
        },
        &combined_contours,
        &combined_cubics,
        &combined_leaves,
        Err(TopologyError::WorkLimit),
        TopologyStats {
            leaves: 9,
            pairs: 0,
        },
    );
}

#[test]
fn rounded_preflight_precedence_is_global_and_publication_recovers() {
    let (contours, cubics, leaves) = triangle();
    let mut workspace = RoundedKnotCubicTopologyWorkspace::new(TopologyLimits::default()).unwrap();
    measured_certify(&mut workspace, input(&contours, &cubics, &leaves)).unwrap();

    let mut invalid_ranges = contours.clone();
    invalid_ranges[0].count = 0;
    assert_eq!(
        measured_certify(&mut workspace, input(&invalid_ranges, &cubics, &leaves)),
        Err(TopologyError::InvalidInput)
    );
    assert_eq!(workspace.stats(), TopologyStats::default());
    measured_certify(&mut workspace, input(&contours, &cubics, &leaves)).unwrap();

    let mut invalid_provenance = leaves.clone();
    invalid_provenance[11].provenance.source_verb = 999;
    assert_eq!(
        measured_certify(
            &mut workspace,
            input(&contours, &cubics, &invalid_provenance)
        ),
        Err(TopologyError::InvalidProvenance)
    );
    assert_eq!(workspace.stats(), TopologyStats::default());
    measured_certify(&mut workspace, input(&contours, &cubics, &leaves)).unwrap();

    let mut knot_mismatch = leaves.clone();
    knot_mismatch[11].end.y = f64::from_bits(1);
    assert_eq!(
        measured_certify(&mut workspace, input(&contours, &cubics, &knot_mismatch)),
        Err(TopologyError::KnotMismatch)
    );
    assert_eq!(workspace.stats(), TopologyStats::default());
    measured_certify(&mut workspace, input(&contours, &cubics, &leaves)).unwrap();

    let mut earlier_knot_later_invalid_input = leaves.clone();
    earlier_knot_later_invalid_input[3].end.y = f64::from_bits(1);
    let mut malformed_cubics = cubics.clone();
    malformed_cubics[2].points[1].x = f64::NAN;
    assert_eq!(
        measured_certify(
            &mut workspace,
            input(
                &contours,
                &malformed_cubics,
                &earlier_knot_later_invalid_input,
            )
        ),
        Err(TopologyError::InvalidInput)
    );
    assert_eq!(workspace.stats(), TopologyStats::default());
    measured_certify(&mut workspace, input(&contours, &cubics, &leaves)).unwrap();

    let mut earlier_knot_later_invalid_provenance = earlier_knot_later_invalid_input.clone();
    earlier_knot_later_invalid_provenance[11]
        .provenance
        .source_verb = 999;
    assert_eq!(
        measured_certify(
            &mut workspace,
            input(&contours, &cubics, &earlier_knot_later_invalid_provenance,)
        ),
        Err(TopologyError::InvalidProvenance)
    );
    assert_eq!(workspace.stats(), TopologyStats::default());
    measured_certify(&mut workspace, input(&contours, &cubics, &leaves)).unwrap();

    let mut earlier_geometric_later_knot = leaves.clone();
    earlier_geometric_later_knot[0].end = cubics[0].points[0];
    earlier_geometric_later_knot[11].end.y = f64::from_bits(1);
    assert_eq!(
        measured_certify(
            &mut workspace,
            input(&contours, &cubics, &earlier_geometric_later_knot)
        ),
        Err(TopologyError::KnotMismatch)
    );
    assert_eq!(workspace.stats(), TopologyStats::default());
    measured_certify(&mut workspace, input(&contours, &cubics, &leaves)).unwrap();

    let constant_point = point(0.0, 0.0);
    let constant_contours = [TopologyRange { start: 0, count: 1 }];
    let constant_cubics = [TopologyCubic {
        points: [constant_point; 4],
        source_verb: 90,
        leaves: TopologyRange { start: 0, count: 1 },
    }];
    let constant_leaves = [TopologyLeaf {
        end: constant_point,
        provenance: Provenance {
            source_verb: 90,
            end_numerator: 1,
            depth: 0,
        },
    }];
    assert_eq!(
        measured_certify(
            &mut workspace,
            input(&constant_contours, &constant_cubics, &constant_leaves)
        ),
        Err(TopologyError::Unresolved)
    );
    assert_eq!(workspace.stats().leaves, 1);
    assert_eq!(workspace.stats().pairs, 0);
    measured_certify(&mut workspace, input(&contours, &cubics, &leaves)).unwrap();

    let (many_contours, many_cubics, many_leaves) = four_triangles();
    let mut pair_limited = RoundedKnotCubicTopologyWorkspace::new(TopologyLimits {
        max_pairs: 66,
        ..TopologyLimits::default()
    })
    .unwrap();
    measured_certify(&mut pair_limited, input(&contours, &cubics, &leaves)).unwrap();
    assert_eq!(
        measured_certify(
            &mut pair_limited,
            input(&many_contours, &many_cubics, &many_leaves)
        ),
        Err(TopologyError::WorkLimit)
    );
    assert_eq!(pair_limited.stats().leaves, 48);
    assert_eq!(pair_limited.stats().pairs, 66);
    measured_certify(&mut pair_limited, input(&contours, &cubics, &leaves)).unwrap();
}

#[test]
fn rounded_output_is_owned_and_caller_mutation_cannot_change_it() {
    let (contours, mut cubics, mut leaves) = triangle();
    let mut workspace = RoundedKnotCubicTopologyWorkspace::new(TopologyLimits::default()).unwrap();
    measured_certify(&mut workspace, input(&contours, &cubics, &leaves)).unwrap();
    let first_bits = workspace.output().unwrap().points[0].x.to_bits();
    cubics[0].points[0].x = 99.0;
    leaves[0].end.x = 99.0;
    assert_eq!(
        workspace.output().unwrap().points[0].x.to_bits(),
        first_bits
    );
}

#[test]
fn rounded_depth_twenty_partition_uses_exact_restrictions() {
    let scale = 2.0f64.powi(20);
    let corners = [
        point(0.0, 0.0),
        point(3.0 * scale, 0.0),
        point(3.0 * scale, -3.0 * scale),
        point(0.0, -3.0 * scale),
    ];
    let mut leaves = Vec::new();
    leaves.push(TopologyLeaf {
        end: point(3.0, 0.0),
        provenance: Provenance {
            source_verb: 1,
            end_numerator: 1,
            depth: 20,
        },
    });
    leaves.push(TopologyLeaf {
        end: point(6.0, 0.0),
        provenance: Provenance {
            source_verb: 1,
            end_numerator: 2,
            depth: 20,
        },
    });
    for depth in (1..20).rev() {
        leaves.push(TopologyLeaf {
            end: point(3.0 * 2.0f64.powi(20 - depth as i32 + 1), 0.0),
            provenance: Provenance {
                source_verb: 1,
                end_numerator: 2,
                depth,
            },
        });
    }
    for index in 1..4 {
        leaves.push(TopologyLeaf {
            end: corners[(index + 1) % corners.len()],
            provenance: Provenance {
                source_verb: (index + 1) as u32,
                end_numerator: 1,
                depth: 0,
            },
        });
    }
    let cubics = [
        TopologyCubic {
            points: [
                corners[0],
                point(scale, 0.0),
                point(2.0 * scale, 0.0),
                corners[1],
            ],
            source_verb: 1,
            leaves: TopologyRange {
                start: 0,
                count: 21,
            },
        },
        TopologyCubic {
            points: linear(corners[1], corners[2]),
            source_verb: 2,
            leaves: TopologyRange {
                start: 21,
                count: 1,
            },
        },
        TopologyCubic {
            points: linear(corners[2], corners[3]),
            source_verb: 3,
            leaves: TopologyRange {
                start: 22,
                count: 1,
            },
        },
        TopologyCubic {
            points: linear(corners[3], corners[0]),
            source_verb: 4,
            leaves: TopologyRange {
                start: 23,
                count: 1,
            },
        },
    ];
    let contours = [TopologyRange { start: 0, count: 4 }];
    certify_checked(
        TopologyLimits::default(),
        &contours,
        &cubics,
        &leaves,
        Ok(()),
        TopologyStats {
            leaves: 24,
            pairs: 276,
        },
    );
}

#[test]
#[ignore]
fn emit_rounded_cubic_topology() {
    let path = env::var("P3_NATIVE_ROUNDED_TOPOLOGY_INPUT")
        .expect("P3_NATIVE_ROUNDED_TOPOLOGY_INPUT required");
    let rows = read_topology_fixture(&path, HEADER, EXPECTED_ROWS);
    let mut workspace = RoundedKnotCubicTopologyWorkspace::new(TopologyLimits::default()).unwrap();
    let allocated_bytes = workspace.allocated_bytes();
    let inline_bytes = size_of::<RoundedKnotCubicTopologyWorkspace>();
    println!("P3_NATIVE_ROUNDED_TOPOLOGY_BEGIN");
    for row in rows {
        let input = TopologyInput {
            contours: &row.contours,
            cubics: &row.cubics,
            leaves: &row.leaves,
        };
        crate::allocation_test_support::start();
        let result = workspace.certify(input);
        let allocations = crate::allocation_test_support::stop();
        let stats = workspace.stats();
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
    println!("P3_NATIVE_ROUNDED_TOPOLOGY_END");
}
