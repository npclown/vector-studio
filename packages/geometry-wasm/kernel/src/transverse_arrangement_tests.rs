use core::mem::size_of;
use std::env;

use crate::geometry::{Point, Provenance};
use crate::rounded_line_fill_tests::print_points;
use crate::simple_cubic_topology::{
    certify_transverse_test_pair, ArrangementCrossing, ArrangementOutput,
    RoundedKnotCubicTopologyWorkspace, TopologyCubic, TopologyError, TopologyInput, TopologyLeaf,
    TopologyLimits, TopologyRange, TopologyStats, TransverseArrangementWorkspace,
};
use crate::simple_cubic_topology_tests::{
    print_input_tokens, print_ranges, read_topology_fixture, status_name,
};

const HEADER: &str = "# p3-native-transverse-arrangement-v1";
const EXPECTED_ROWS: usize = 39;

type OwnedInput = (Vec<TopologyRange>, Vec<TopologyCubic>, Vec<TopologyLeaf>);

fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}

fn input<'a>(owned: &'a OwnedInput) -> TopologyInput<'a> {
    TopologyInput {
        contours: &owned.0,
        cubics: &owned.1,
        leaves: &owned.2,
    }
}

fn straight_cubic(start: Point, end: Point) -> [Point; 4] {
    [
        start,
        point((3.0 * start.x + end.x) / 4.0, (3.0 * start.y + end.y) / 4.0),
        point((start.x + 3.0 * end.x) / 4.0, (start.y + 3.0 * end.y) / 4.0),
        end,
    ]
}

fn linear_cubic(start: Point, end: Point) -> [Point; 4] {
    [
        start,
        point((2.0 * start.x + end.x) / 3.0, (2.0 * start.y + end.y) / 3.0),
        point((start.x + 2.0 * end.x) / 3.0, (start.y + 2.0 * end.y) / 3.0),
        end,
    ]
}

fn append_polygon(
    vertices: &[Point],
    explicit: bool,
    next_ordinal: &mut u32,
    contours: &mut Vec<TopologyRange>,
    cubics: &mut Vec<TopologyCubic>,
    leaves: &mut Vec<TopologyLeaf>,
) {
    let cubic_start = cubics.len();
    let count = if explicit {
        vertices.len()
    } else {
        vertices.len() - 1
    };
    for index in 0..count {
        let start = vertices[index];
        let end = vertices[(index + 1) % vertices.len()];
        let source_verb = *next_ordinal;
        *next_ordinal += 1;
        let leaf_start = leaves.len();
        leaves.push(TopologyLeaf {
            end,
            provenance: Provenance {
                source_verb,
                end_numerator: 1,
                depth: 0,
            },
        });
        cubics.push(TopologyCubic {
            points: straight_cubic(start, end),
            source_verb,
            leaves: TopologyRange {
                start: leaf_start,
                count: 1,
            },
        });
    }
    contours.push(TopologyRange {
        start: cubic_start,
        count,
    });
}

fn polygon(vertices: &[Point], explicit: bool) -> OwnedInput {
    let mut contours = Vec::new();
    let mut cubics = Vec::new();
    let mut leaves = Vec::new();
    let mut next_ordinal = 1;
    append_polygon(
        vertices,
        explicit,
        &mut next_ordinal,
        &mut contours,
        &mut cubics,
        &mut leaves,
    );
    (contours, cubics, leaves)
}

fn bowtie_vertices() -> [Point; 8] {
    [
        point(-2.0, -2.0),
        point(2.0, 2.0),
        point(2.0, 3.0),
        point(-2.0, 3.0),
        point(-2.0, 2.0),
        point(2.0, -2.0),
        point(2.0, -3.0),
        point(-2.0, -3.0),
    ]
}

fn bowtie(explicit: bool) -> OwnedInput {
    polygon(&bowtie_vertices(), explicit)
}

fn two_squares() -> OwnedInput {
    let mut contours = Vec::new();
    let mut cubics = Vec::new();
    let mut leaves = Vec::new();
    let mut next_ordinal = 1;
    append_polygon(
        &[
            point(0.0, 0.0),
            point(4.0, 0.0),
            point(4.0, 4.0),
            point(0.0, 4.0),
        ],
        true,
        &mut next_ordinal,
        &mut contours,
        &mut cubics,
        &mut leaves,
    );
    append_polygon(
        &[
            point(2.0, -2.0),
            point(6.0, -2.0),
            point(6.0, 2.0),
            point(2.0, 2.0),
        ],
        true,
        &mut next_ordinal,
        &mut contours,
        &mut cubics,
        &mut leaves,
    );
    (contours, cubics, leaves)
}

fn coincident_squares() -> OwnedInput {
    let mut contours = Vec::new();
    let mut cubics = Vec::new();
    let mut leaves = Vec::new();
    let mut next_ordinal = 1;
    let square = [
        point(0.0, 0.0),
        point(4.0, 0.0),
        point(4.0, 4.0),
        point(0.0, 4.0),
    ];
    append_polygon(
        &square,
        true,
        &mut next_ordinal,
        &mut contours,
        &mut cubics,
        &mut leaves,
    );
    append_polygon(
        &square,
        true,
        &mut next_ordinal,
        &mut contours,
        &mut cubics,
        &mut leaves,
    );
    (contours, cubics, leaves)
}

fn multiple_partners() -> OwnedInput {
    polygon(
        &[
            point(-3.0, 0.0),
            point(3.0, 0.0),
            point(3.0, 3.0),
            point(-1.0, 3.0),
            point(-1.0, -1.0),
            point(1.0, -1.0),
            point(1.0, 2.0),
            point(-3.0, 2.0),
        ],
        true,
    )
}

fn depth_two_leaves(start: Point, end: Point, source_verb: u32) -> [TopologyLeaf; 4] {
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

fn append_depth_two_triangle(
    offset: f64,
    next_ordinal: &mut u32,
    contours: &mut Vec<TopologyRange>,
    cubics: &mut Vec<TopologyCubic>,
    leaves: &mut Vec<TopologyLeaf>,
) {
    let vertices = [
        point(offset, 0.0),
        point(offset + 3.0, 0.0),
        point(offset + 1.5, -3.0),
    ];
    let sources = [
        [
            vertices[0],
            point(offset + 1.0, 0.0),
            point(offset + 2.0, 1.0),
            vertices[1],
        ],
        linear_cubic(vertices[1], vertices[2]),
        linear_cubic(vertices[2], vertices[0]),
    ];
    let cubic_start = cubics.len();
    for index in 0..3 {
        let source_verb = *next_ordinal;
        *next_ordinal += 1;
        let start = vertices[index];
        let end = vertices[(index + 1) % vertices.len()];
        let leaf_start = leaves.len();
        if index == 0 {
            for (local, end) in [
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
                        end_numerator: local as u32 + 1,
                        depth: 2,
                    },
                });
            }
        } else {
            leaves.extend(depth_two_leaves(start, end, source_verb));
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

fn four_triangles() -> OwnedInput {
    let mut contours = Vec::new();
    let mut cubics = Vec::new();
    let mut leaves = Vec::new();
    let mut next_ordinal = 1;
    for index in 0..4 {
        append_depth_two_triangle(
            index as f64 * 16.0,
            &mut next_ordinal,
            &mut contours,
            &mut cubics,
            &mut leaves,
        );
    }
    (contours, cubics, leaves)
}

fn signed_zero_triangle() -> OwnedInput {
    let mut contours = Vec::new();
    let mut cubics = Vec::new();
    let mut leaves = Vec::new();
    let mut next_ordinal = 1;
    append_depth_two_triangle(
        0.0,
        &mut next_ordinal,
        &mut contours,
        &mut cubics,
        &mut leaves,
    );
    leaves[3].end.y = -0.0;
    (contours, cubics, leaves)
}

fn closure_positive() -> OwnedInput {
    let a = point(0.0, 0.0);
    let b = point(3.0, 0.0);
    let c = point(0.0, -1.5);
    let e = 2.0f64.powi(-54);
    let sources = [
        [a, point(1.0, e), point(2.0, 1.0), b],
        [b, point(2.0, -0.5), point(1.0, -1.0), c],
    ];
    let ends = [
        point(0.75, 9.0 / 64.0 + 2.0f64.powi(-55)),
        point(1.5, 3.0 / 8.0),
        point(2.25, 27.0 / 64.0),
        b,
        point(2.25, -3.0 / 8.0),
        point(1.5, -3.0 / 4.0),
        point(0.75, -9.0 / 8.0),
        c,
    ];
    let mut leaves = Vec::new();
    let mut cubics = Vec::new();
    for (source_index, source_verb) in [20u32, 21].into_iter().enumerate() {
        let leaf_start = leaves.len();
        for local in 0..4 {
            leaves.push(TopologyLeaf {
                end: ends[source_index * 4 + local],
                provenance: Provenance {
                    source_verb,
                    end_numerator: (local + 1) as u32,
                    depth: 2,
                },
            });
        }
        cubics.push(TopologyCubic {
            points: sources[source_index],
            source_verb,
            leaves: TopologyRange {
                start: leaf_start,
                count: 4,
            },
        });
    }
    (vec![TopologyRange { start: 0, count: 2 }], cubics, leaves)
}

fn late_closure_exhaustion() -> OwnedInput {
    let constant = point(100.0, 0.0);
    let (mut contours, mut cubics, mut leaves) = closure_positive();
    contours[0].start += 1;
    let mut combined_contours = vec![TopologyRange { start: 0, count: 1 }];
    combined_contours.extend(contours);
    let mut combined_cubics = vec![TopologyCubic {
        points: [constant; 4],
        source_verb: 1,
        leaves: TopologyRange { start: 0, count: 1 },
    }];
    for cubic in &mut cubics {
        cubic.source_verb += 100;
        cubic.leaves.start += 1;
    }
    combined_cubics.extend(cubics);
    let mut combined_leaves = vec![TopologyLeaf {
        end: constant,
        provenance: Provenance {
            source_verb: 1,
            end_numerator: 1,
            depth: 0,
        },
    }];
    for leaf in &mut leaves {
        leaf.provenance.source_verb += 100;
    }
    combined_leaves.extend(leaves);
    (combined_contours, combined_cubics, combined_leaves)
}

fn measured_certify(
    workspace: &mut TransverseArrangementWorkspace,
    value: TopologyInput<'_>,
) -> Result<(), TopologyError> {
    let bytes = workspace.allocated_bytes();
    crate::allocation_test_support::start();
    let result = workspace.certify(value);
    let allocations = crate::allocation_test_support::stop();
    assert_eq!(
        allocations, 0,
        "transverse arrangement certification allocated"
    );
    assert_eq!(workspace.allocated_bytes(), bytes);
    result
}

fn assert_attempt(
    workspace: &mut TransverseArrangementWorkspace,
    owned: &OwnedInput,
    expected: Result<(), TopologyError>,
    stats: TopologyStats,
) {
    let result = measured_certify(workspace, input(owned));
    assert_eq!(result, expected);
    assert_eq!(workspace.stats(), stats);
    assert_eq!(workspace.output().is_some(), result.is_ok());
}

fn point_bits(points: &[Point]) -> Vec<[u64; 2]> {
    points
        .iter()
        .map(|point| [point.x.to_bits(), point.y.to_bits()])
        .collect()
}

#[test]
fn direct_borrowed_pair_helper_covers_line_and_cubic_generator_counts() {
    let left_start = point(-2.0, -2.0);
    let left_end = point(2.0, 2.0);
    let right_start = point(-2.0, 2.0);
    let right_end = point(2.0, -2.0);
    let left_line = [
        left_start, left_start, left_end, left_end, left_start, left_end,
    ];
    let left_cubic = [
        left_start,
        point(-1.0, -1.0),
        point(1.0, 1.0),
        left_end,
        left_start,
        left_end,
    ];
    let right_line = [
        right_start,
        right_start,
        right_end,
        right_end,
        right_start,
        right_end,
    ];
    assert_eq!(
        certify_transverse_test_pair(left_line, true, right_line, true),
        Some(-1)
    );
    assert_eq!(
        certify_transverse_test_pair(left_cubic, false, right_line, true),
        Some(-1)
    );

    let reflect = |record: [Point; 6]| record.map(|value| point(-value.x, value.y));
    assert_eq!(
        certify_transverse_test_pair(reflect(left_line), true, reflect(right_line), true),
        Some(1)
    );
    assert_eq!(
        certify_transverse_test_pair(reflect(left_cubic), false, reflect(right_line), true),
        Some(1)
    );
}

#[test]
fn constructor_storage_and_byte_boundaries_are_owned_once() {
    for limits in [
        TopologyLimits {
            max_contours: 0,
            ..TopologyLimits::default()
        },
        TopologyLimits {
            max_cubics: 0,
            ..TopologyLimits::default()
        },
        TopologyLimits {
            max_leaves: 0,
            ..TopologyLimits::default()
        },
        TopologyLimits {
            max_pairs: 2_017,
            ..TopologyLimits::default()
        },
        TopologyLimits {
            max_bytes: 1024 * 1024 + 1,
            ..TopologyLimits::default()
        },
    ] {
        assert!(matches!(
            TransverseArrangementWorkspace::new(limits),
            Err(TopologyError::InvalidLimits)
        ));
    }

    let workspace = TransverseArrangementWorkspace::new(TopologyLimits::default()).unwrap();
    let rounded = RoundedKnotCubicTopologyWorkspace::new(TopologyLimits::default()).unwrap();
    let bytes = workspace.allocated_bytes();
    assert_eq!(bytes, rounded.allocated_bytes());
    assert!(size_of::<TransverseArrangementWorkspace>() <= 4 * 1024);
    drop(workspace);
    drop(rounded);
    assert!(TransverseArrangementWorkspace::new(TopologyLimits {
        max_bytes: bytes,
        ..TopologyLimits::default()
    })
    .is_ok());
    assert!(matches!(
        TransverseArrangementWorkspace::new(TopologyLimits {
            max_bytes: bytes - 1,
            ..TopologyLimits::default()
        }),
        Err(TopologyError::ByteLimit)
    ));
    assert!(matches!(
        TransverseArrangementWorkspace::new(TopologyLimits {
            max_bytes: 0,
            ..TopologyLimits::default()
        }),
        Err(TopologyError::ByteLimit)
    ));
}

#[test]
fn success_failure_reset_copy_ownership_and_recovery_are_atomic() {
    let mut success = bowtie(true);
    let mut workspace = TransverseArrangementWorkspace::new(TopologyLimits::default()).unwrap();
    assert_attempt(
        &mut workspace,
        &success,
        Ok(()),
        TopologyStats {
            leaves: 8,
            pairs: 28,
        },
    );
    let output = workspace.output().unwrap();
    assert_eq!(point_bits(output.points), point_bits(&bowtie_vertices()));
    assert_eq!(output.contours, &[TopologyRange { start: 0, count: 8 }]);
    assert_eq!(
        output.crossings,
        &[ArrangementCrossing {
            left_leaf: 0,
            right_leaf: 4,
            orientation: -1,
        }]
    );
    let saved_points = point_bits(output.points);
    let saved_ranges = output.contours.to_vec();
    let saved_crossings = output.crossings.to_vec();

    success.1[0].points[0].x = 99.0;
    success.2[0].end.x = 99.0;
    let output = workspace.output().unwrap();
    assert_eq!(point_bits(output.points), saved_points);
    assert_eq!(output.contours, saved_ranges);
    assert_eq!(output.crossings, saved_crossings);

    let mut invalid_input = bowtie(true);
    invalid_input.0[0].count = 0;
    assert_attempt(
        &mut workspace,
        &invalid_input,
        Err(TopologyError::InvalidInput),
        TopologyStats::default(),
    );
    let mut invalid_provenance = bowtie(true);
    invalid_provenance.2[7].provenance.source_verb = 999;
    assert_attempt(
        &mut workspace,
        &invalid_provenance,
        Err(TopologyError::InvalidProvenance),
        TopologyStats::default(),
    );
    let mut knot = bowtie(true);
    knot.2[7].end.y = f64::from_bits(1);
    assert_attempt(
        &mut workspace,
        &knot,
        Err(TopologyError::KnotMismatch),
        TopologyStats::default(),
    );
    assert_attempt(
        &mut workspace,
        &coincident_squares(),
        Err(TopologyError::Unresolved),
        TopologyStats {
            leaves: 8,
            pairs: 4,
        },
    );
    assert_attempt(
        &mut workspace,
        &multiple_partners(),
        Err(TopologyError::Unresolved),
        TopologyStats {
            leaves: 8,
            pairs: 5,
        },
    );

    let recovered = bowtie(true);
    assert_attempt(
        &mut workspace,
        &recovered,
        Ok(()),
        TopologyStats {
            leaves: 8,
            pairs: 28,
        },
    );
    assert_eq!(point_bits(workspace.output().unwrap().points), saved_points);
    assert_eq!(saved_ranges, &[TopologyRange { start: 0, count: 8 }]);
    assert_eq!(saved_crossings[0].orientation, -1);

    let mut signed_zero = signed_zero_triangle();
    assert_attempt(
        &mut workspace,
        &signed_zero,
        Ok(()),
        TopologyStats {
            leaves: 12,
            pairs: 66,
        },
    );
    let signed_zero_bits = point_bits(workspace.output().unwrap().points);
    assert_eq!(signed_zero_bits[4][1], (-0.0f64).to_bits());
    signed_zero.1[0].points[0].x = 99.0;
    signed_zero.2[3].end.y = 0.0;
    assert_eq!(
        point_bits(workspace.output().unwrap().points),
        signed_zero_bits
    );
    assert_attempt(
        &mut workspace,
        &multiple_partners(),
        Err(TopologyError::Unresolved),
        TopologyStats {
            leaves: 8,
            pairs: 5,
        },
    );
    assert_eq!(signed_zero_bits[4][1], (-0.0f64).to_bits());
    let recovered_signed_zero = signed_zero_triangle();
    assert_attempt(
        &mut workspace,
        &recovered_signed_zero,
        Ok(()),
        TopologyStats {
            leaves: 12,
            pairs: 66,
        },
    );
    assert_eq!(
        point_bits(workspace.output().unwrap().points),
        signed_zero_bits
    );
}

#[test]
fn limits_precedence_closure_charge_and_rounded_capacity_are_frozen() {
    let explicit = bowtie(true);
    let mut exact = TransverseArrangementWorkspace::new(TopologyLimits {
        max_contours: 1,
        max_cubics: 8,
        max_leaves: 8,
        max_pairs: 28,
        ..TopologyLimits::default()
    })
    .unwrap();
    assert_attempt(
        &mut exact,
        &explicit,
        Ok(()),
        TopologyStats {
            leaves: 8,
            pairs: 28,
        },
    );
    for limits in [
        TopologyLimits {
            max_cubics: 7,
            ..TopologyLimits::default()
        },
        TopologyLimits {
            max_leaves: 7,
            ..TopologyLimits::default()
        },
    ] {
        let mut workspace = TransverseArrangementWorkspace::new(limits).unwrap();
        assert_attempt(
            &mut workspace,
            &explicit,
            Err(TopologyError::WorkLimit),
            TopologyStats::default(),
        );
    }
    for (max_pairs, expected_pairs) in [(27, 27), (0, 0)] {
        let mut workspace = TransverseArrangementWorkspace::new(TopologyLimits {
            max_pairs,
            ..TopologyLimits::default()
        })
        .unwrap();
        assert_attempt(
            &mut workspace,
            &explicit,
            Err(TopologyError::WorkLimit),
            TopologyStats {
                leaves: 8,
                pairs: expected_pairs,
            },
        );
    }
    let mut contour_short = TransverseArrangementWorkspace::new(TopologyLimits {
        max_contours: 1,
        ..TopologyLimits::default()
    })
    .unwrap();
    assert_attempt(
        &mut contour_short,
        &two_squares(),
        Err(TopologyError::WorkLimit),
        TopologyStats::default(),
    );

    let implicit = bowtie(false);
    let mut leaf_short = TransverseArrangementWorkspace::new(TopologyLimits {
        max_leaves: 7,
        ..TopologyLimits::default()
    })
    .unwrap();
    assert_attempt(
        &mut leaf_short,
        &implicit,
        Err(TopologyError::WorkLimit),
        TopologyStats {
            leaves: 7,
            pairs: 0,
        },
    );
    let mut implicit_exact = TransverseArrangementWorkspace::new(TopologyLimits {
        max_leaves: 8,
        max_pairs: 28,
        ..TopologyLimits::default()
    })
    .unwrap();
    assert_attempt(
        &mut implicit_exact,
        &implicit,
        Ok(()),
        TopologyStats {
            leaves: 8,
            pairs: 28,
        },
    );

    let rounded = four_triangles();
    let mut rounded_exact = TransverseArrangementWorkspace::new(TopologyLimits {
        max_contours: 4,
        max_cubics: 12,
        max_leaves: 48,
        max_pairs: 1_128,
        ..TopologyLimits::default()
    })
    .unwrap();
    assert_attempt(
        &mut rounded_exact,
        &rounded,
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
        let mut workspace = TransverseArrangementWorkspace::new(limits).unwrap();
        assert_attempt(
            &mut workspace,
            &rounded,
            Err(TopologyError::WorkLimit),
            TopologyStats::default(),
        );
    }
    let mut pair_short = TransverseArrangementWorkspace::new(TopologyLimits {
        max_pairs: 1_127,
        ..TopologyLimits::default()
    })
    .unwrap();
    assert_attempt(
        &mut pair_short,
        &explicit,
        Ok(()),
        TopologyStats {
            leaves: 8,
            pairs: 28,
        },
    );
    let saved_crossing = pair_short.output().unwrap().crossings[0];
    assert_attempt(
        &mut pair_short,
        &rounded,
        Err(TopologyError::WorkLimit),
        TopologyStats {
            leaves: 48,
            pairs: 1_127,
        },
    );
    assert_attempt(
        &mut pair_short,
        &explicit,
        Ok(()),
        TopologyStats {
            leaves: 8,
            pairs: 28,
        },
    );
    assert_eq!(pair_short.output().unwrap().crossings, &[saved_crossing]);

    let mut closure_short = TransverseArrangementWorkspace::new(TopologyLimits {
        max_leaves: 9,
        ..TopologyLimits::default()
    })
    .unwrap();
    assert_attempt(
        &mut closure_short,
        &late_closure_exhaustion(),
        Err(TopologyError::WorkLimit),
        TopologyStats {
            leaves: 9,
            pairs: 0,
        },
    );

    let mut precedence = bowtie(true);
    precedence.2[0].end.y += 1.0;
    precedence.2[7].provenance.source_verb = 999;
    let mut workspace = TransverseArrangementWorkspace::new(TopologyLimits::default()).unwrap();
    assert_attempt(
        &mut workspace,
        &precedence,
        Err(TopologyError::InvalidProvenance),
        TopologyStats::default(),
    );
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
fn emit_transverse_arrangement() {
    let path = env::var("P3_NATIVE_TRANSVERSE_ARRANGEMENT_INPUT")
        .expect("P3_NATIVE_TRANSVERSE_ARRANGEMENT_INPUT required");
    let rows = read_topology_fixture(&path, HEADER, EXPECTED_ROWS);
    let mut workspace = TransverseArrangementWorkspace::new(TopologyLimits::default()).unwrap();
    let allocated_bytes = workspace.allocated_bytes();
    let inline_bytes = size_of::<TransverseArrangementWorkspace>();
    println!("P3_NATIVE_TRANSVERSE_ARRANGEMENT_BEGIN");
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
    println!("P3_NATIVE_TRANSVERSE_ARRANGEMENT_END");
}
