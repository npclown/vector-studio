use crate::geometry::Point;
use crate::line_fill::*;

const LIMITS: LineFillLimits = LineFillLimits {
    max_contours: 16,
    max_input_vertices: 32,
    max_edges: 32,
    max_pairs: 496,
    max_events: 560,
    max_work: 1_000_000,
    max_vertices: 256,
    max_triangles: 80,
};

const ZERO_LIMITS: LineFillLimits = LineFillLimits {
    max_contours: 0,
    max_input_vertices: 0,
    max_edges: 0,
    max_pairs: 0,
    max_events: 0,
    max_work: 0,
    max_vertices: 0,
    max_triangles: 0,
};

const SQUARE_LIMITS: LineFillLimits = LineFillLimits {
    max_contours: 1,
    max_input_vertices: 4,
    max_edges: 4,
    max_pairs: 6,
    max_events: 8,
    max_work: 1_000,
    max_vertices: 6,
    max_triangles: 2,
};

fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}

fn rectangle(left: f64, bottom: f64, right: f64, top: f64) -> Vec<Point> {
    vec![
        point(left, bottom),
        point(right, bottom),
        point(right, top),
        point(left, top),
    ]
}

fn reversed(points: &[Point]) -> Vec<Point> {
    points.iter().copied().rev().collect()
}

fn references(contours: &[Vec<Point>]) -> Vec<&[Point]> {
    contours.iter().map(Vec::as_slice).collect()
}

fn zero_stats() -> LineFillStats {
    LineFillStats {
        input_vertices: 0,
        edges: 0,
        pair_checks: 0,
        events: 0,
        columns: 0,
        work_units: 0,
    }
}

fn twice_area(vertices: &[Point], indices: &[u32]) -> f64 {
    indices
        .chunks_exact(3)
        .map(|triangle| {
            let a = vertices[triangle[0] as usize];
            let b = vertices[triangle[1] as usize];
            let c = vertices[triangle[2] as usize];
            (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
        })
        .sum()
}

fn assert_area(
    workspace: &mut LineFillWorkspace,
    contours: &[Vec<Point>],
    rule: LineFillRule,
    expected_area: f64,
) {
    let refs = references(contours);
    assert_eq!(workspace.tessellate(&refs, rule), Ok(()));
    let mesh = workspace.mesh().expect("successful mesh must be published");
    assert_eq!(twice_area(mesh.vertices, mesh.indices), expected_area * 2.0);
    assert!(mesh
        .indices
        .iter()
        .copied()
        .eq(0..mesh.vertices.len() as u32));
    if expected_area == 0.0 {
        assert!(mesh.vertices.is_empty());
        assert!(mesh.indices.is_empty());
        assert_eq!(
            [
                mesh.bounds.min_x.to_bits(),
                mesh.bounds.min_y.to_bits(),
                mesh.bounds.max_x.to_bits(),
                mesh.bounds.max_y.to_bits(),
            ],
            [0; 4]
        );
    } else {
        for triangle in mesh.indices.chunks_exact(3) {
            let a = mesh.vertices[triangle[0] as usize];
            let b = mesh.vertices[triangle[1] as usize];
            let c = mesh.vertices[triangle[2] as usize];
            assert!((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) > 0.0);
        }
    }
}

#[test]
fn empty_degenerate_retrace_and_repeated_close_inputs_have_fixed_semantics() {
    let mut workspace = LineFillWorkspace::new(LIMITS).unwrap();
    let empty: Vec<Vec<Point>> = vec![];
    assert_area(&mut workspace, &empty, LineFillRule::Nonzero, 0.0);
    assert_eq!(workspace.stats(), zero_stats());
    assert_area(
        &mut workspace,
        &[vec![point(4.0, 5.0)]],
        LineFillRule::Evenodd,
        0.0,
    );
    assert_area(
        &mut workspace,
        &[vec![point(1.0, 1.0); 4]],
        LineFillRule::Nonzero,
        0.0,
    );
    assert_area(
        &mut workspace,
        &[vec![point(0.0, 0.0), point(1.0, 0.0), point(2.0, 0.0)]],
        LineFillRule::Evenodd,
        0.0,
    );
    assert_area(
        &mut workspace,
        &[vec![point(1.0, 0.0), point(1.0, 2.0)]],
        LineFillRule::Nonzero,
        0.0,
    );
    let repeated_close = vec![
        point(0.0, 0.0),
        point(2.0, 0.0),
        point(2.0, 2.0),
        point(0.0, 2.0),
        point(0.0, 0.0),
    ];
    assert_area(
        &mut workspace,
        &[repeated_close],
        LineFillRule::Nonzero,
        4.0,
    );
}

#[test]
fn exact_crossing_coincident_touch_and_multiplicity_fixtures_resolve() {
    let mut workspace = LineFillWorkspace::new(LIMITS).unwrap();
    let bowtie = vec![
        point(0.0, 0.0),
        point(4.0, 4.0),
        point(0.0, 4.0),
        point(4.0, 0.0),
    ];
    assert_area(
        &mut workspace,
        std::slice::from_ref(&bowtie),
        LineFillRule::Nonzero,
        8.0,
    );
    assert_area(
        &mut workspace,
        &[bowtie.clone(), bowtie],
        LineFillRule::Nonzero,
        8.0,
    );
    let duplicated = vec![
        vec![
            point(0.0, 0.0),
            point(4.0, 4.0),
            point(0.0, 4.0),
            point(4.0, 0.0),
        ],
        vec![
            point(0.0, 0.0),
            point(4.0, 4.0),
            point(0.0, 4.0),
            point(4.0, 0.0),
        ],
    ];
    assert_area(&mut workspace, &duplicated, LineFillRule::Evenodd, 0.0);
    let equal_x_different_y = vec![rectangle(0.0, 0.0, 2.0, 2.0), rectangle(0.0, 2.0, 2.0, 4.0)];
    assert_area(
        &mut workspace,
        &equal_x_different_y,
        LineFillRule::Evenodd,
        8.0,
    );
    let endpoint_on_edge = vec![
        rectangle(0.0, 0.0, 4.0, 4.0),
        vec![point(4.0, 2.0), point(6.0, 1.0), point(6.0, 3.0)],
    ];
    assert_area(
        &mut workspace,
        &endpoint_on_edge,
        LineFillRule::Nonzero,
        18.0,
    );
    let overlap = vec![rectangle(0.0, 0.0, 4.0, 4.0), rectangle(2.0, 0.0, 6.0, 4.0)];
    assert_area(&mut workspace, &overlap, LineFillRule::Nonzero, 24.0);
    assert_area(&mut workspace, &overlap, LineFillRule::Evenodd, 16.0);
}

#[test]
fn horizontal_probe_touch_and_signed_zero_outputs_are_exact() {
    let contours = vec![vec![
        point(-0.0, -0.0),
        point(2.0, 0.0),
        point(2.0, 2.0),
        point(1.0, 2.0),
        point(0.0, 2.0),
    ]];
    let mut workspace = LineFillWorkspace::new(LIMITS).unwrap();
    assert_area(&mut workspace, &contours, LineFillRule::Nonzero, 4.0);
    let mesh = workspace.mesh().unwrap();
    for vertex in mesh.vertices {
        if vertex.x == 0.0 {
            assert_eq!(vertex.x.to_bits(), 0);
        }
        if vertex.y == 0.0 {
            assert_eq!(vertex.y.to_bits(), 0);
        }
    }
}

#[test]
fn repeated_calls_are_deterministic_and_workspaces_are_independent() {
    let contours = vec![rectangle(0.0, 0.0, 4.0, 4.0), rectangle(2.0, 0.0, 6.0, 4.0)];
    let refs = references(&contours);
    let mut first = LineFillWorkspace::new(LIMITS).unwrap();
    let mut second = LineFillWorkspace::new(LIMITS).unwrap();
    first.tessellate(&refs, LineFillRule::Evenodd).unwrap();
    let first_bits = first
        .mesh()
        .unwrap()
        .vertices
        .iter()
        .map(|value| [value.x.to_bits(), value.y.to_bits()])
        .collect::<Vec<_>>();
    let first_indices = first.mesh().unwrap().indices.to_vec();
    let first_stats = first.stats();
    second.tessellate(&refs, LineFillRule::Evenodd).unwrap();
    assert_eq!(
        second
            .mesh()
            .unwrap()
            .vertices
            .iter()
            .map(|value| [value.x.to_bits(), value.y.to_bits()])
            .collect::<Vec<_>>(),
        first_bits
    );
    assert_eq!(second.mesh().unwrap().indices, first_indices);
    assert_eq!(second.stats(), first_stats);
    first.tessellate(&refs, LineFillRule::Evenodd).unwrap();
    assert_eq!(first.stats(), first_stats);
    assert_eq!(
        first
            .mesh()
            .unwrap()
            .vertices
            .iter()
            .map(|value| [value.x.to_bits(), value.y.to_bits()])
            .collect::<Vec<_>>(),
        first_bits
    );
}

fn unresolved_nonrepresentable_crossing() -> Vec<Vec<Point>> {
    vec![vec![
        point(0.0, 0.0),
        point(1.0, 1.0),
        point(0.0, 1.0),
        point(1.0, -1.0),
    ]]
}

fn unresolved_nonrepresentable_cut(include_earlier_rectangle: bool) -> Vec<Vec<Point>> {
    let mut contours = Vec::new();
    if include_earlier_rectangle {
        contours.push(rectangle(-4.0, 0.0, -2.0, 2.0));
    }
    contours.push(vec![point(0.0, 0.0), point(3.0, 1.0), point(3.0, 0.0)]);
    contours.push(vec![point(1.0, 0.0), point(1.0, 1.0)]);
    contours
}

fn unresolved_adjacent_columns() -> Vec<Vec<Point>> {
    let next = f64::from_bits(1.0f64.to_bits() + 1);
    vec![rectangle(1.0, 0.0, next, 1.0)]
}

#[test]
fn unresolved_controls_and_late_failures_publish_no_mesh() {
    let mut workspace = LineFillWorkspace::new(LIMITS).unwrap();
    for contours in [
        unresolved_nonrepresentable_crossing(),
        unresolved_nonrepresentable_cut(false),
        unresolved_adjacent_columns(),
        unresolved_nonrepresentable_cut(true),
    ] {
        let refs = references(&contours);
        assert_eq!(
            workspace.tessellate(&refs, LineFillRule::Nonzero),
            Err(LineFillError::Unresolved)
        );
        assert!(workspace.mesh().is_none());
    }

    let successful = vec![rectangle(0.0, 0.0, 2.0, 2.0)];
    workspace
        .tessellate(&references(&successful), LineFillRule::Nonzero)
        .unwrap();
    assert!(workspace.mesh().is_some());
    let failed = unresolved_nonrepresentable_cut(true);
    assert_eq!(
        workspace.tessellate(&references(&failed), LineFillRule::Nonzero),
        Err(LineFillError::Unresolved)
    );
    assert!(workspace.mesh().is_none());
}

#[test]
fn construction_rejects_unrepresentable_limits_and_zero_capacity_accepts_empty() {
    let mut workspace = LineFillWorkspace::new(ZERO_LIMITS).unwrap();
    assert_eq!(workspace.tessellate(&[], LineFillRule::Nonzero), Ok(()));
    assert!(workspace.mesh().unwrap().vertices.is_empty());

    if usize::BITS > 32 {
        let invalid_vertices = LineFillLimits {
            max_vertices: u32::MAX as usize + 1,
            ..ZERO_LIMITS
        };
        assert!(matches!(
            LineFillWorkspace::new(invalid_vertices),
            Err(LineFillError::InvalidLimits)
        ));
    }
    let invalid_triangles = LineFillLimits {
        max_triangles: usize::MAX,
        ..ZERO_LIMITS
    };
    assert!(matches!(
        LineFillWorkspace::new(invalid_triangles),
        Err(LineFillError::InvalidLimits)
    ));
    let invalid_edges = LineFillLimits {
        max_edges: usize::MAX,
        max_pairs: usize::MAX,
        ..ZERO_LIMITS
    };
    assert!(matches!(
        LineFillWorkspace::new(invalid_edges),
        Err(LineFillError::InvalidLimits)
    ));
    let invalid_events = LineFillLimits {
        max_events: usize::MAX,
        ..ZERO_LIMITS
    };
    assert!(matches!(
        LineFillWorkspace::new(invalid_events),
        Err(LineFillError::InvalidLimits)
    ));
    let invalid_event_sum = LineFillLimits {
        max_edges: 1,
        max_pairs: usize::MAX,
        ..ZERO_LIMITS
    };
    assert!(matches!(
        LineFillWorkspace::new(invalid_event_sum),
        Err(LineFillError::InvalidLimits)
    ));
}

#[test]
fn input_edge_pair_and_event_limits_are_inclusive_with_partial_stats() {
    let square = vec![rectangle(0.0, 0.0, 2.0, 2.0)];
    let refs = references(&square);

    let mut contour_limit = LineFillWorkspace::new(LineFillLimits {
        max_contours: 0,
        ..SQUARE_LIMITS
    })
    .unwrap();
    assert_eq!(
        contour_limit.tessellate(&refs, LineFillRule::Nonzero),
        Err(LineFillError::InputLimit)
    );
    assert_eq!(contour_limit.stats(), zero_stats());

    let mut input_limit = LineFillWorkspace::new(LineFillLimits {
        max_input_vertices: 3,
        ..SQUARE_LIMITS
    })
    .unwrap();
    assert_eq!(
        input_limit.tessellate(&refs, LineFillRule::Nonzero),
        Err(LineFillError::InputLimit)
    );
    assert_eq!(input_limit.stats(), zero_stats());

    let mut edge_limit = LineFillWorkspace::new(LineFillLimits {
        max_edges: 3,
        max_pairs: 3,
        max_events: 6,
        ..SQUARE_LIMITS
    })
    .unwrap();
    assert_eq!(
        edge_limit.tessellate(&refs, LineFillRule::Nonzero),
        Err(LineFillError::EdgeLimit)
    );
    assert_eq!(edge_limit.stats().input_vertices, 4);
    assert_eq!(edge_limit.stats().edges, 3);

    let mut pair_limit = LineFillWorkspace::new(LineFillLimits {
        max_pairs: 5,
        ..SQUARE_LIMITS
    })
    .unwrap();
    assert_eq!(
        pair_limit.tessellate(&refs, LineFillRule::Nonzero),
        Err(LineFillError::PairLimit)
    );
    assert_eq!(
        pair_limit.stats(),
        LineFillStats {
            input_vertices: 4,
            edges: 4,
            pair_checks: 0,
            events: 0,
            columns: 0,
            work_units: 0,
        }
    );

    let mut event_limit = LineFillWorkspace::new(LineFillLimits {
        max_events: 7,
        ..SQUARE_LIMITS
    })
    .unwrap();
    assert_eq!(
        event_limit.tessellate(&refs, LineFillRule::Nonzero),
        Err(LineFillError::EventLimit)
    );
    assert_eq!(event_limit.stats().input_vertices, 4);
    assert_eq!(event_limit.stats().edges, 4);
    assert_eq!(event_limit.stats().events, 7);

    let mut inclusive = LineFillWorkspace::new(SQUARE_LIMITS).unwrap();
    assert_eq!(inclusive.tessellate(&refs, LineFillRule::Nonzero), Ok(()));
    assert_eq!(inclusive.stats().input_vertices, 4);
    assert_eq!(inclusive.stats().edges, 4);
    assert_eq!(inclusive.stats().pair_checks, 6);
    assert_eq!(inclusive.stats().events, 8);
}

#[test]
fn work_and_independent_output_limits_are_atomic_at_the_boundary() {
    let square = vec![rectangle(0.0, 0.0, 2.0, 2.0)];
    let refs = references(&square);
    let mut baseline = LineFillWorkspace::new(LIMITS).unwrap();
    baseline.tessellate(&refs, LineFillRule::Nonzero).unwrap();
    let required_work = baseline.stats().work_units;
    assert!(required_work > 1);

    let mut exact_work = LineFillWorkspace::new(LineFillLimits {
        max_work: required_work,
        ..LIMITS
    })
    .unwrap();
    assert_eq!(exact_work.tessellate(&refs, LineFillRule::Nonzero), Ok(()));
    assert_eq!(exact_work.stats().work_units, required_work);

    let mut below_work = LineFillWorkspace::new(LineFillLimits {
        max_work: required_work - 1,
        ..LIMITS
    })
    .unwrap();
    assert_eq!(
        below_work.tessellate(&refs, LineFillRule::Nonzero),
        Err(LineFillError::WorkLimit)
    );
    assert_eq!(below_work.stats().work_units, required_work - 1);
    assert!(below_work.mesh().is_none());

    for limits in [
        LineFillLimits {
            max_vertices: 5,
            max_triangles: 2,
            ..LIMITS
        },
        LineFillLimits {
            max_vertices: 6,
            max_triangles: 1,
            ..LIMITS
        },
    ] {
        let mut workspace = LineFillWorkspace::new(limits).unwrap();
        assert_eq!(
            workspace.tessellate(&refs, LineFillRule::Nonzero),
            Err(LineFillError::OutputLimit)
        );
        assert!(workspace.mesh().is_none());
    }
    let mut inclusive = LineFillWorkspace::new(LineFillLimits {
        max_vertices: 6,
        max_triangles: 2,
        ..LIMITS
    })
    .unwrap();
    assert_eq!(inclusive.tessellate(&refs, LineFillRule::Nonzero), Ok(()));
    assert_eq!(inclusive.mesh().unwrap().vertices.len(), 6);
    assert_eq!(inclusive.mesh().unwrap().indices.len(), 6);
}

#[test]
fn finite_validation_precedes_geometry_and_each_attempt_clears_publication() {
    let square = vec![rectangle(0.0, 0.0, 2.0, 2.0)];
    let mut workspace = LineFillWorkspace::new(LIMITS).unwrap();
    workspace
        .tessellate(&references(&square), LineFillRule::Nonzero)
        .unwrap();
    let invalid = vec![vec![point(f64::NAN, 0.0)]];
    assert_eq!(
        workspace.tessellate(&references(&invalid), LineFillRule::Nonzero),
        Err(LineFillError::InvalidInput)
    );
    assert!(workspace.mesh().is_none());
    assert_eq!(workspace.stats().input_vertices, 1);
    assert_eq!(workspace.stats().edges, 0);

    let over_input = vec![vec![point(f64::NAN, 0.0); 33]];
    assert_eq!(
        workspace.tessellate(&references(&over_input), LineFillRule::Nonzero),
        Err(LineFillError::InputLimit)
    );
    assert_eq!(workspace.stats(), zero_stats());
}

#[test]
fn tessellation_never_allocates_and_capacity_bytes_remain_stable() {
    let square = vec![rectangle(0.0, 0.0, 2.0, 2.0)];
    let square_refs = references(&square);
    let unresolved = unresolved_nonrepresentable_crossing();
    let unresolved_refs = references(&unresolved);
    let invalid = vec![vec![point(f64::NAN, 0.0)]];
    let invalid_refs = references(&invalid);
    let mut workspace = LineFillWorkspace::new(LIMITS).unwrap();
    let allocated = workspace.allocated_bytes();
    let mut correct = true;
    crate::allocation_test_support::start();
    for _ in 0..64 {
        correct &= workspace.tessellate(&square_refs, LineFillRule::Nonzero) == Ok(());
        correct &= workspace.tessellate(&unresolved_refs, LineFillRule::Nonzero)
            == Err(LineFillError::Unresolved);
        correct &= workspace.tessellate(&invalid_refs, LineFillRule::Evenodd)
            == Err(LineFillError::InvalidInput);
    }
    let allocations = crate::allocation_test_support::stop();
    assert!(correct);
    assert_eq!(allocations, 0);
    assert_eq!(workspace.allocated_bytes(), allocated);
}

struct EmitCase {
    id: &'static str,
    contours: Vec<Vec<Point>>,
}

fn emit_cases() -> Vec<EmitCase> {
    let outer = rectangle(0.0, 0.0, 10.0, 10.0);
    let inner = rectangle(3.0, 3.0, 7.0, 7.0);
    let square_a = rectangle(0.0, 0.0, 4.0, 4.0);
    let overlap_b = rectangle(2.0, 0.0, 6.0, 4.0);
    let shared_b = rectangle(2.0, 4.0, 6.0, 8.0);
    let bowtie = vec![
        point(0.0, 0.0),
        point(4.0, 4.0),
        point(0.0, 4.0),
        point(4.0, 0.0),
    ];
    vec![
        EmitCase {
            id: "F01",
            contours: vec![outer.clone()],
        },
        EmitCase {
            id: "F02",
            contours: vec![outer.clone(), inner.clone()],
        },
        EmitCase {
            id: "F03",
            contours: vec![outer.clone(), reversed(&inner)],
        },
        EmitCase {
            id: "F04",
            contours: vec![outer.clone(), outer.clone()],
        },
        EmitCase {
            id: "F05",
            contours: vec![outer.clone(), reversed(&outer)],
        },
        EmitCase {
            id: "F06",
            contours: vec![bowtie.clone()],
        },
        EmitCase {
            id: "F07",
            contours: vec![rectangle(0.0, 0.0, 2.0, 2.0), rectangle(2.0, 0.0, 4.0, 2.0)],
        },
        EmitCase {
            id: "F08",
            contours: vec![vec![point(0.0, 0.0), point(8.0, 0.0), point(0.0, 8.0)]],
        },
        EmitCase {
            id: "F09-repeat",
            contours: vec![vec![
                point(0.0, 0.0),
                point(10.0, 0.0),
                point(10.0, 10.0),
                point(10.0, 10.0),
                point(0.0, 10.0),
            ]],
        },
        EmitCase {
            id: "F09-permuted",
            contours: vec![inner.clone(), outer.clone()],
        },
        EmitCase {
            id: "F10",
            contours: vec![square_a.clone(), overlap_b.clone()],
        },
        EmitCase {
            id: "F10-reversed",
            contours: vec![square_a.clone(), reversed(&overlap_b)],
        },
        EmitCase {
            id: "F11",
            contours: vec![square_a.clone(), shared_b],
        },
        EmitCase {
            id: "F03-global-reversed",
            contours: vec![reversed(&outer), inner],
        },
        EmitCase {
            id: "F06-global-reversed",
            contours: vec![reversed(&bowtie)],
        },
        EmitCase {
            id: "F10-global-reversed",
            contours: vec![reversed(&square_a), reversed(&overlap_b)],
        },
    ]
}

fn print_point(value: Point) {
    print!("[{},{}]", value.x, value.y);
}

fn print_points(points: &[Point]) {
    print!("[");
    for (index, value) in points.iter().copied().enumerate() {
        if index != 0 {
            print!(",");
        }
        print_point(value);
    }
    print!("]");
}

fn print_contours(contours: &[Vec<Point>]) {
    print!("[");
    for (index, contour) in contours.iter().enumerate() {
        if index != 0 {
            print!(",");
        }
        print_points(contour);
    }
    print!("]");
}

#[test]
#[ignore]
fn emit_line_fill_meshes() {
    let mut workspace = LineFillWorkspace::new(LIMITS).unwrap();
    println!("P3_LINE_FILL_BEGIN");
    for case in emit_cases() {
        for (rule_name, rule) in [
            ("nonzero", LineFillRule::Nonzero),
            ("evenodd", LineFillRule::Evenodd),
        ] {
            workspace
                .tessellate(&references(&case.contours), rule)
                .unwrap();
            let mesh = workspace.mesh().unwrap();
            print!(
                "{{\"id\":\"{}\",\"rule\":\"{}\",\"contours\":",
                case.id, rule_name
            );
            print_contours(&case.contours);
            print!(",\"vertices\":");
            print_points(mesh.vertices);
            print!(",\"indices\":[");
            for (index, value) in mesh.indices.iter().enumerate() {
                if index != 0 {
                    print!(",");
                }
                print!("{value}");
            }
            println!(
                "],\"bounds\":[{},{},{},{}]}}",
                mesh.bounds.min_x, mesh.bounds.min_y, mesh.bounds.max_x, mesh.bounds.max_y
            );
        }
    }
    println!("P3_LINE_FILL_END");
}
