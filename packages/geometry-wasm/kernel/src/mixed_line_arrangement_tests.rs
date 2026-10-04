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

const HEADER: &str = "# p3-native-mixed-line-arrangement-v1";
const EXPECTED_ROWS: usize = 53;

#[derive(Clone)]
struct OwnedInput {
    contours: Vec<TopologyRange>,
    cubics: Vec<TopologyCubic>,
    leaves: Vec<TopologyLeaf>,
}

fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}

fn input(owned: &OwnedInput) -> TopologyInput<'_> {
    TopologyInput {
        contours: &owned.contours,
        cubics: &owned.cubics,
        leaves: &owned.leaves,
    }
}

fn linear_cubic(start: Point, end: Point) -> [Point; 4] {
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

fn n_vertices() -> [Point; 8] {
    [
        point(-3.0, -3.0),
        point(3.0, 3.0),
        point(3.0, 4.5),
        point(-3.0, 4.5),
        point(-3.0, 3.0),
        point(3.0, -3.0),
        point(3.0, -4.5),
        point(-3.0, -4.5),
    ]
}

fn nonlinear_n() -> [[Point; 4]; 8] {
    let vertices = n_vertices();
    core::array::from_fn(|index| {
        let start = vertices[index];
        let end = vertices[(index + 1) % vertices.len()];
        match index {
            0 => [
                start,
                point(-1.0, -1.0 + 1.0 / 16.0),
                point(1.0, 1.0 - 1.0 / 16.0),
                end,
            ],
            4 => [
                start,
                point(-1.0, 1.0 + 1.0 / 16.0),
                point(1.0, -1.0 - 1.0 / 16.0),
                end,
            ],
            _ => linear_cubic(start, end),
        }
    })
}

fn mark_sources(mut sources: [[Point; 4]; 8], kinds: &[bool; 8]) -> [[Point; 4]; 8] {
    for (source, &kind) in sources.iter_mut().zip(kinds) {
        if kind {
            *source = line_adapter(source[0], source[3]);
        }
    }
    sources
}

fn append_contour(sources: &[[Point; 4]], first_ordinal: u32, owned: &mut OwnedInput) {
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

fn owned_contour(sources: &[[Point; 4]], first_ordinal: u32) -> OwnedInput {
    let mut owned = OwnedInput {
        contours: Vec::new(),
        cubics: Vec::new(),
        leaves: Vec::new(),
    };
    append_contour(sources, first_ordinal, &mut owned);
    owned
}

fn line_cubic() -> (OwnedInput, [bool; 8]) {
    let kinds = [true, false, false, false, false, false, false, false];
    (
        owned_contour(&mark_sources(nonlinear_n(), &kinds), 1),
        kinds,
    )
}

fn line_line() -> (OwnedInput, [bool; 8]) {
    let kinds = [true, false, false, false, true, false, false, false];
    (
        owned_contour(&mark_sources(nonlinear_n(), &kinds), 1),
        kinds,
    )
}

fn line_closure() -> (OwnedInput, [bool; 7]) {
    let kinds = [false, false, false, true, false, false, false];
    let marked = mark_sources(
        nonlinear_n(),
        &[false, false, false, false, true, false, false, false],
    );
    (owned_contour(&marked[1..], 1), kinds)
}

fn two_closures() -> (OwnedInput, [bool; 14]) {
    let (first, kinds) = line_closure();
    let mut owned = OwnedInput {
        contours: Vec::new(),
        cubics: Vec::new(),
        leaves: Vec::new(),
    };
    let first_sources: Vec<_> = first.cubics.iter().map(|cubic| cubic.points).collect();
    append_contour(&first_sources, 1, &mut owned);
    let translated: Vec<_> = first_sources
        .iter()
        .map(|source| source.map(|value| point(value.x + 30.0, value.y)))
        .collect();
    append_contour(&translated, 9, &mut owned);
    let mut both = [false; 14];
    both[..7].copy_from_slice(&kinds);
    both[7..].copy_from_slice(&kinds);
    (owned, both)
}

fn all_line_multiple_partners() -> (OwnedInput, [bool; 8]) {
    let vertices = [
        point(-9.0, 0.0),
        point(9.0, 0.0),
        point(9.0, 9.0),
        point(-3.0, 9.0),
        point(-3.0, -3.0),
        point(3.0, -3.0),
        point(3.0, 6.0),
        point(-9.0, 6.0),
    ];
    let sources: [[Point; 4]; 8] = core::array::from_fn(|index| {
        line_adapter(vertices[index], vertices[(index + 1) % vertices.len()])
    });
    (owned_contour(&sources, 1), [true; 8])
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
    assert_eq!(allocations, 0, "mixed arrangement certification allocated");
    assert_eq!(workspace.allocated_bytes(), bytes);
    result
}

fn assert_mixed_attempt(
    workspace: &mut TransverseArrangementWorkspace,
    owned: &OwnedInput,
    kinds: &[bool],
    expected: Result<(), TopologyError>,
    stats: TopologyStats,
) {
    let result = measured_mixed(workspace, owned, kinds);
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

#[test]
fn mixed_line_successes_preserve_source_identity_and_owned_output() {
    let (mut line_cubic, kinds) = line_cubic();
    let mut workspace = TransverseArrangementWorkspace::new(TopologyLimits::default()).unwrap();
    assert_mixed_attempt(
        &mut workspace,
        &line_cubic,
        &kinds,
        Ok(()),
        TopologyStats {
            leaves: 8,
            pairs: 28,
        },
    );
    let output = workspace.output().unwrap();
    assert_eq!(point_bits(output.points), point_bits(&n_vertices()));
    assert_eq!(output.contours, &[TopologyRange { start: 0, count: 8 }]);
    assert_eq!(
        output.crossings,
        &[ArrangementCrossing {
            left_leaf: 0,
            right_leaf: 4,
            orientation: -1,
        }]
    );
    let saved_points = output.points.to_vec();
    let saved_crossings = output.crossings.to_vec();

    line_cubic.leaves[0].end = point(99.0, 99.0);
    assert_eq!(workspace.output().unwrap().points, saved_points);
    assert_eq!(workspace.output().unwrap().crossings, saved_crossings);

    let (line_line, line_line_kinds) = line_line();
    let mut independent = TransverseArrangementWorkspace::new(TopologyLimits::default()).unwrap();
    assert_mixed_attempt(
        &mut independent,
        &line_line,
        &line_line_kinds,
        Ok(()),
        TopologyStats {
            leaves: 8,
            pairs: 28,
        },
    );
    assert_eq!(independent.output().unwrap().crossings, &saved_crossings);
}

#[test]
fn mixed_line_preflight_shape_and_final_precedence_are_frozen() {
    let (base, kinds) = line_cubic();
    let mut workspace = TransverseArrangementWorkspace::new(TopologyLimits::default()).unwrap();
    for malformed_kinds in [&kinds[..7], &[false; 9][..]] {
        assert_mixed_attempt(
            &mut workspace,
            &base,
            malformed_kinds,
            Err(TopologyError::InvalidInput),
            TopologyStats::default(),
        );
    }

    let mut nonlinear_marked = kinds;
    nonlinear_marked[4] = true;
    assert_mixed_attempt(
        &mut workspace,
        &base,
        &nonlinear_marked,
        Err(TopologyError::InvalidInput),
        TopologyStats::default(),
    );

    let mut zero_prefix = owned_contour(&nonlinear_n(), 2);
    for cubic in &mut zero_prefix.cubics {
        cubic.leaves.start += 1;
    }
    zero_prefix.contours[0].count += 1;
    let a = base.cubics[0].points[0];
    zero_prefix.cubics.insert(
        0,
        TopologyCubic {
            points: [a; 4],
            source_verb: 1,
            leaves: TopologyRange { start: 0, count: 1 },
        },
    );
    zero_prefix.leaves.insert(
        0,
        TopologyLeaf {
            end: a,
            provenance: Provenance {
                source_verb: 1,
                end_numerator: 1,
                depth: 0,
            },
        },
    );
    let mut zero_kinds = [false; 9];
    zero_kinds[0] = true;
    assert_mixed_attempt(
        &mut workspace,
        &zero_prefix,
        &zero_kinds,
        Err(TopologyError::InvalidInput),
        TopologyStats::default(),
    );

    let mut two_leaf = base.clone();
    let source = two_leaf.cubics[0].source_verb;
    let end = two_leaf.leaves[0].end;
    two_leaf.leaves[0] = TopologyLeaf {
        end: point(0.0, 0.0),
        provenance: Provenance {
            source_verb: source,
            end_numerator: 1,
            depth: 1,
        },
    };
    two_leaf.leaves.insert(
        1,
        TopologyLeaf {
            end,
            provenance: Provenance {
                source_verb: source,
                end_numerator: 2,
                depth: 1,
            },
        },
    );
    two_leaf.cubics[0].leaves.count = 2;
    for cubic in &mut two_leaf.cubics[1..] {
        cubic.leaves.start += 1;
    }
    assert_mixed_attempt(
        &mut workspace,
        &two_leaf,
        &kinds,
        Err(TopologyError::InvalidInput),
        TopologyStats::default(),
    );

    let mut knot = base.clone();
    knot.leaves[0].end.x += 1.0 / 16.0;
    assert_mixed_attempt(
        &mut workspace,
        &knot,
        &kinds,
        Err(TopologyError::KnotMismatch),
        TopologyStats::default(),
    );

    let knot_before_shape = knot.clone();
    let mut later_marked = kinds;
    later_marked[4] = true;
    assert_mixed_attempt(
        &mut workspace,
        &knot_before_shape,
        &later_marked,
        Err(TopologyError::InvalidInput),
        TopologyStats::default(),
    );

    let mut shape_before_provenance = base.clone();
    shape_before_provenance.cubics[0].points[1].x += 1.0 / 32.0;
    shape_before_provenance.leaves[7].provenance.source_verb = 999;
    assert_mixed_attempt(
        &mut workspace,
        &shape_before_provenance,
        &kinds,
        Err(TopologyError::InvalidProvenance),
        TopologyStats::default(),
    );

    let mut source_short = TransverseArrangementWorkspace::new(TopologyLimits {
        max_cubics: 7,
        ..TopologyLimits::default()
    })
    .unwrap();
    assert_mixed_attempt(
        &mut source_short,
        &base,
        &kinds[..7],
        Err(TopologyError::WorkLimit),
        TopologyStats::default(),
    );
}

#[test]
fn mixed_line_caps_closures_and_multiple_partner_order_are_frozen() {
    let (line_cubic, kinds) = line_cubic();
    let mut exact = TransverseArrangementWorkspace::new(TopologyLimits {
        max_contours: 1,
        max_cubics: 8,
        max_leaves: 8,
        max_pairs: 28,
        ..TopologyLimits::default()
    })
    .unwrap();
    assert_mixed_attempt(
        &mut exact,
        &line_cubic,
        &kinds,
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
        assert_mixed_attempt(
            &mut workspace,
            &line_cubic,
            &kinds,
            Err(TopologyError::WorkLimit),
            TopologyStats::default(),
        );
    }
    for expected_pairs in [27, 0] {
        let mut workspace = TransverseArrangementWorkspace::new(TopologyLimits {
            max_pairs: expected_pairs,
            ..TopologyLimits::default()
        })
        .unwrap();
        assert_mixed_attempt(
            &mut workspace,
            &line_cubic,
            &kinds,
            Err(TopologyError::WorkLimit),
            TopologyStats {
                leaves: 8,
                pairs: expected_pairs,
            },
        );
    }

    let (closure, closure_kinds) = line_closure();
    for (max_leaves, expected, stats) in [
        (
            7,
            Err(TopologyError::WorkLimit),
            TopologyStats {
                leaves: 7,
                pairs: 0,
            },
        ),
        (
            8,
            Ok(()),
            TopologyStats {
                leaves: 8,
                pairs: 28,
            },
        ),
    ] {
        let mut workspace = TransverseArrangementWorkspace::new(TopologyLimits {
            max_contours: 1,
            max_cubics: 7,
            max_leaves,
            max_pairs: 28,
            ..TopologyLimits::default()
        })
        .unwrap();
        assert_mixed_attempt(&mut workspace, &closure, &closure_kinds, expected, stats);
    }

    let (two, two_kinds) = two_closures();
    let mut exact_two = TransverseArrangementWorkspace::new(TopologyLimits {
        max_contours: 2,
        max_cubics: 14,
        max_leaves: 16,
        max_pairs: 120,
        ..TopologyLimits::default()
    })
    .unwrap();
    assert_mixed_attempt(
        &mut exact_two,
        &two,
        &two_kinds,
        Ok(()),
        TopologyStats {
            leaves: 16,
            pairs: 120,
        },
    );
    for limits in [
        TopologyLimits {
            max_contours: 1,
            ..TopologyLimits::default()
        },
        TopologyLimits {
            max_cubics: 13,
            ..TopologyLimits::default()
        },
    ] {
        let mut workspace = TransverseArrangementWorkspace::new(limits).unwrap();
        assert_mixed_attempt(
            &mut workspace,
            &two,
            &two_kinds,
            Err(TopologyError::WorkLimit),
            TopologyStats::default(),
        );
    }
    for (limits, stats) in [
        (
            TopologyLimits {
                max_leaves: 15,
                ..TopologyLimits::default()
            },
            TopologyStats {
                leaves: 15,
                pairs: 0,
            },
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
        assert_mixed_attempt(
            &mut workspace,
            &two,
            &two_kinds,
            Err(TopologyError::WorkLimit),
            stats,
        );
    }

    let (multiple, all_lines) = all_line_multiple_partners();
    let mut workspace = TransverseArrangementWorkspace::new(TopologyLimits::default()).unwrap();
    assert_mixed_attempt(
        &mut workspace,
        &multiple,
        &all_lines,
        Err(TopologyError::Unresolved),
        TopologyStats {
            leaves: 8,
            pairs: 5,
        },
    );
}

#[test]
fn mixed_line_lifecycle_old_entry_and_resource_accounting_are_frozen() {
    assert_eq!(
        TransverseArrangementWorkspace::new(TopologyLimits {
            max_bytes: 0,
            ..TopologyLimits::default()
        })
        .err(),
        Some(TopologyError::ByteLimit)
    );
    let (success, kinds) = line_cubic();
    let (multiple, all_lines) = all_line_multiple_partners();
    let cubic_kinds = [false; 8];
    let mut malformed = success.clone();
    malformed.leaves[7].provenance.source_verb = 999;
    let mut knot = success.clone();
    knot.leaves[0].end.x += 1.0 / 16.0;

    let mut workspace = TransverseArrangementWorkspace::new(TopologyLimits::default()).unwrap();
    let mut independent = TransverseArrangementWorkspace::new(TopologyLimits::default()).unwrap();
    assert_eq!(workspace.allocated_bytes(), 224_256);
    assert_eq!(size_of::<TransverseArrangementWorkspace>(), 2_512);
    assert_mixed_attempt(
        &mut independent,
        &success,
        &kinds,
        Ok(()),
        TopologyStats {
            leaves: 8,
            pairs: 28,
        },
    );
    let independent_points = independent.output().unwrap().points.to_vec();
    let independent_crossings = independent.output().unwrap().crossings.to_vec();

    assert_mixed_attempt(
        &mut workspace,
        &success,
        &kinds,
        Ok(()),
        TopologyStats {
            leaves: 8,
            pairs: 28,
        },
    );
    let saved_points = workspace.output().unwrap().points.to_vec();
    let saved_crossings = workspace.output().unwrap().crossings.to_vec();
    for (owned, attempt_kinds, error, stats) in [
        (
            &success,
            &kinds[..7],
            Err(TopologyError::InvalidInput),
            TopologyStats::default(),
        ),
        (
            &malformed,
            &kinds[..],
            Err(TopologyError::InvalidProvenance),
            TopologyStats::default(),
        ),
        (
            &knot,
            &kinds[..],
            Err(TopologyError::KnotMismatch),
            TopologyStats::default(),
        ),
        (
            &success,
            &cubic_kinds[..],
            Err(TopologyError::Unresolved),
            TopologyStats {
                leaves: 8,
                pairs: 4,
            },
        ),
        (
            &multiple,
            &all_lines[..],
            Err(TopologyError::Unresolved),
            TopologyStats {
                leaves: 8,
                pairs: 5,
            },
        ),
    ] {
        assert_mixed_attempt(
            &mut workspace,
            &success,
            &kinds,
            Ok(()),
            TopologyStats {
                leaves: 8,
                pairs: 28,
            },
        );
        assert_mixed_attempt(&mut workspace, owned, attempt_kinds, error, stats);
        assert_eq!(point_bits(&saved_points), point_bits(&n_vertices()));
        assert_eq!(
            saved_crossings,
            [ArrangementCrossing {
                left_leaf: 0,
                right_leaf: 4,
                orientation: -1,
            }]
        );
        assert_mixed_attempt(
            &mut workspace,
            &success,
            &kinds,
            Ok(()),
            TopologyStats {
                leaves: 8,
                pairs: 28,
            },
        );
        assert_eq!(workspace.output().unwrap().points, saved_points);
        assert_eq!(workspace.output().unwrap().crossings, saved_crossings);
    }

    assert_eq!(independent.output().unwrap().points, independent_points);
    assert_eq!(
        independent.output().unwrap().crossings,
        independent_crossings
    );

    crate::allocation_test_support::start();
    let old = workspace.certify(input(&success));
    let old_allocations = crate::allocation_test_support::stop();
    assert_eq!(
        old_allocations, 0,
        "legacy arrangement certification allocated"
    );
    assert_eq!(old, Err(TopologyError::Unresolved));
    assert_eq!(
        workspace.stats(),
        TopologyStats {
            leaves: 8,
            pairs: 4
        }
    );
    assert!(workspace.output().is_none());
    assert_mixed_attempt(
        &mut workspace,
        &success,
        &kinds,
        Ok(()),
        TopologyStats {
            leaves: 8,
            pairs: 28,
        },
    );

    let (two, two_kinds) = two_closures();
    let mut limited = TransverseArrangementWorkspace::new(TopologyLimits {
        max_leaves: 15,
        ..TopologyLimits::default()
    })
    .unwrap();
    assert_mixed_attempt(
        &mut limited,
        &success,
        &kinds,
        Ok(()),
        TopologyStats {
            leaves: 8,
            pairs: 28,
        },
    );
    assert_mixed_attempt(
        &mut limited,
        &two,
        &two_kinds,
        Err(TopologyError::WorkLimit),
        TopologyStats {
            leaves: 15,
            pairs: 0,
        },
    );
    assert_mixed_attempt(
        &mut limited,
        &success,
        &kinds,
        Ok(()),
        TopologyStats {
            leaves: 8,
            pairs: 28,
        },
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
fn emit_mixed_line_arrangement() {
    let path = env::var("P3_NATIVE_MIXED_LINE_ARRANGEMENT_INPUT")
        .expect("P3_NATIVE_MIXED_LINE_ARRANGEMENT_INPUT required");
    let rows = read_topology_fixture_with_kinds(&path, HEADER, EXPECTED_ROWS);
    let mut workspace = TransverseArrangementWorkspace::new(TopologyLimits::default()).unwrap();
    let allocated_bytes = workspace.allocated_bytes();
    let inline_bytes = size_of::<TransverseArrangementWorkspace>();
    println!("P3_NATIVE_MIXED_LINE_ARRANGEMENT_BEGIN");
    for row in rows {
        let input = TopologyInput {
            contours: &row.contours,
            cubics: &row.cubics,
            leaves: &row.leaves,
        };
        let kinds = row.source_kinds.as_deref().expect("required source kinds");
        crate::allocation_test_support::start();
        let result = workspace.certify_mixed(input, kinds);
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
    println!("P3_NATIVE_MIXED_LINE_ARRANGEMENT_END");
}
