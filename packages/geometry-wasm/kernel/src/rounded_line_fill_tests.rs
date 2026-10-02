use crate::geometry::Point;
use crate::line_fill::LineFillRule;
use crate::rounded_line_fill::*;

const LIMITS: RoundedFillLimits = RoundedFillLimits {
    max_contours: 16,
    max_input_vertices: 32,
    max_edges: 32,
    max_pairs: 496,
    max_events: 560,
    max_sections: 8192,
    max_nodes: 256,
    max_cells: 256,
    max_boundaries: 512,
    max_contributors: 16384,
    max_vertices: 256,
    max_triangles: 256,
    max_work: 2_000_000,
    max_bytes: 16 * 1024 * 1024,
};

const ZERO_LIMITS: RoundedFillLimits = RoundedFillLimits {
    max_contours: 0,
    max_input_vertices: 0,
    max_edges: 0,
    max_pairs: 0,
    max_events: 0,
    max_sections: 0,
    max_nodes: 0,
    max_cells: 0,
    max_boundaries: 0,
    max_contributors: 0,
    max_vertices: 0,
    max_triangles: 0,
    max_work: 0,
    max_bytes: 0,
};

#[derive(Clone)]
struct FixtureRow {
    id: String,
    rule_name: &'static str,
    rule: LineFillRule,
    tau_bits: String,
    tau: f64,
    expectation: &'static str,
    profile: String,
    contours: Vec<Vec<Point>>,
}

fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}

fn references(contours: &[Vec<Point>]) -> Vec<&[Point]> {
    contours.iter().map(Vec::as_slice).collect()
}

fn parse_fixture() -> Vec<FixtureRow> {
    let source = include_str!("../../../../tests/fixtures/p3-rounded-fill-v1.txt");
    let mut lines = source.lines();
    assert_eq!(lines.next(), Some("# p3-rounded-fill-v1"));
    assert_eq!(lines.next(), Some("# seed 50333245"));
    assert_eq!(lines.next(), Some("# rows 202"));
    let rows = lines
        .map(|line| {
            let mut pieces = line.split(" | ");
            let header = pieces.next().unwrap();
            let fields: Vec<_> = header.split(' ').collect();
            assert_eq!(fields.len(), 5);
            let (rule_name, rule) = match fields[1] {
                "nonzero" => ("nonzero", LineFillRule::Nonzero),
                "evenodd" => ("evenodd", LineFillRule::Evenodd),
                value => panic!("invalid fixture rule {value}"),
            };
            let tau_bits = fields[2].to_owned();
            let tau = f64::from_bits(u64::from_str_radix(fields[2], 16).unwrap());
            let expectation = match fields[3] {
                "OK" => "OK",
                "TOPOLOGY_AMBIGUOUS" => "TOPOLOGY_AMBIGUOUS",
                value => panic!("invalid fixture expectation {value}"),
            };
            let contours = pieces
                .map(|contour| {
                    contour
                        .split(' ')
                        .map(|entry| {
                            let (x, y) = entry.split_once(',').unwrap();
                            point(
                                f64::from_bits(u64::from_str_radix(x, 16).unwrap()),
                                f64::from_bits(u64::from_str_radix(y, 16).unwrap()),
                            )
                        })
                        .collect()
                })
                .collect();
            FixtureRow {
                id: fields[0].to_owned(),
                rule_name,
                rule,
                tau_bits,
                tau,
                expectation,
                profile: fields[4].to_owned(),
                contours,
            }
        })
        .collect::<Vec<_>>();
    assert_eq!(rows.len(), 202);
    rows
}

fn row<'a>(rows: &'a [FixtureRow], id: &str, rule: LineFillRule) -> &'a FixtureRow {
    rows.iter()
        .find(|row| row.id == id && row.rule == rule)
        .unwrap()
}

fn assert_positive_zero(value: f64) {
    if value == 0.0 {
        assert_eq!(value.to_bits(), 0);
    }
}

fn assert_normalized_output(output: RoundedFillOutput<'_>) {
    for column in output.columns {
        assert_positive_zero(column.x);
    }
    for node in output.nodes {
        assert_positive_zero(node.point.x);
        assert_positive_zero(node.point.y);
    }
    for vertex in output.vertices {
        assert_positive_zero(vertex.x);
        assert_positive_zero(vertex.y);
    }
    for value in [
        output.bounds.min_x,
        output.bounds.min_y,
        output.bounds.max_x,
        output.bounds.max_y,
        output.error_bound,
    ] {
        assert_positive_zero(value);
    }
}

#[test]
fn frozen_rows_have_required_success_ambiguity_caps_and_determinism() {
    let rows = parse_fixture();
    let mut workspace = RoundedFillWorkspace::new(LIMITS).unwrap();
    let mut successes = 0;
    let mut ambiguities = 0;
    for fixture in &rows {
        let refs = references(&fixture.contours);
        let expected = if fixture.expectation == "OK" {
            successes += 1;
            Ok(())
        } else {
            ambiguities += 1;
            Err(RoundedFillError::TopologyAmbiguous)
        };
        assert_eq!(
            workspace.tessellate(&refs, fixture.rule, fixture.tau),
            expected
        );
        if expected.is_err() {
            assert!(workspace.output().is_none());
            continue;
        }
        let output = workspace.output().unwrap();
        assert_normalized_output(output);
        assert!(output.source_edges.len() <= LIMITS.max_edges);
        assert!(output.columns.len() <= LIMITS.max_events);
        assert!(output.sections.len() <= LIMITS.max_sections);
        assert!(output.nodes.len() <= LIMITS.max_nodes);
        assert!(output.cells.len() <= LIMITS.max_cells);
        assert!(output.boundaries.len() <= LIMITS.max_boundaries);
        assert!(output.contributors.len() <= LIMITS.max_contributors);
        assert!(output.vertices.len() <= LIMITS.max_vertices);
        assert!(output.indices.len() / 3 <= LIMITS.max_triangles);
        assert!(workspace.stats().work_units <= LIMITS.max_work);

        let first = (
            output.vertices.to_vec(),
            output.indices.to_vec(),
            output.bounds,
            output.source_edges.to_vec(),
            output.columns.to_vec(),
            output.nodes.to_vec(),
            output.sections.to_vec(),
            output.cells.to_vec(),
            output.boundaries.to_vec(),
            output.spans.to_vec(),
            output.contributors.to_vec(),
            output.error_bound,
        );
        let first_stats = workspace.stats();
        assert_eq!(
            workspace.tessellate(&refs, fixture.rule, fixture.tau),
            Ok(())
        );
        let repeated = workspace.output().unwrap();
        assert_eq!(repeated.vertices, first.0);
        assert_eq!(repeated.indices, first.1);
        assert_eq!(repeated.bounds, first.2);
        assert_eq!(repeated.source_edges, first.3);
        assert_eq!(repeated.columns, first.4);
        assert_eq!(repeated.nodes, first.5);
        assert_eq!(repeated.sections, first.6);
        assert_eq!(repeated.cells, first.7);
        assert_eq!(repeated.boundaries, first.8);
        assert_eq!(repeated.spans, first.9);
        assert_eq!(repeated.contributors, first.10);
        assert_eq!(repeated.error_bound, first.11);
        assert_eq!(workspace.stats(), first_stats);
    }
    assert_eq!((successes, ambiguities), (198, 4));
}

#[test]
fn zero_cap_workspace_accepts_empty_and_cancelled_fill_retains_proof_only() {
    let mut zero = RoundedFillWorkspace::new(ZERO_LIMITS).unwrap();
    assert_eq!(
        zero.tessellate(&[], LineFillRule::Nonzero, f64::MIN_POSITIVE),
        Ok(())
    );
    let output = zero.output().unwrap();
    assert!(output.vertices.is_empty());
    assert!(output.indices.is_empty());
    assert!(output.nodes.is_empty());
    assert_eq!(zero.stats().work_units, 0);

    let rows = parse_fixture();
    let cancelled = row(&rows, "F05", LineFillRule::Evenodd);
    let mut workspace = RoundedFillWorkspace::new(LIMITS).unwrap();
    workspace
        .tessellate(
            &references(&cancelled.contours),
            cancelled.rule,
            cancelled.tau,
        )
        .unwrap();
    let output = workspace.output().unwrap();
    assert!(output.vertices.is_empty());
    assert!(output.indices.is_empty());
    assert!(!output.nodes.is_empty());
    assert!(!output.sections.is_empty());
    assert_normalized_output(output);
}

#[test]
fn exact_adjacent_cluster_extremes_and_signed_zero_succeed() {
    let rows = parse_fixture();
    let mut workspace = RoundedFillWorkspace::new(LIMITS).unwrap();
    for id in ["R03", "R04", "R05", "R06", "R07"] {
        let fixture = row(&rows, id, LineFillRule::Nonzero);
        assert_eq!(
            workspace.tessellate(&references(&fixture.contours), fixture.rule, fixture.tau),
            Ok(())
        );
        assert_normalized_output(workspace.output().unwrap());
    }
    let r05 = row(&rows, "R05", LineFillRule::Nonzero);
    assert!(r05
        .contours
        .iter()
        .flatten()
        .any(|value| value.x.to_bits() == 1 << 63 || value.y.to_bits() == 1 << 63));
}

#[test]
fn independent_workspaces_keep_borrowed_publication_isolated() {
    let rows = parse_fixture();
    let left = row(&rows, "F01", LineFillRule::Nonzero);
    let right = row(&rows, "R04", LineFillRule::Evenodd);
    let mut left_workspace = RoundedFillWorkspace::new(LIMITS).unwrap();
    let mut right_workspace = RoundedFillWorkspace::new(LIMITS).unwrap();
    left_workspace
        .tessellate(&references(&left.contours), left.rule, left.tau)
        .unwrap();
    let left_vertices = left_workspace.output().unwrap().vertices.to_vec();
    right_workspace
        .tessellate(&references(&right.contours), right.rule, right.tau)
        .unwrap();
    assert_eq!(left_workspace.output().unwrap().vertices, left_vertices);
    assert_ne!(
        left_workspace.output().unwrap().vertices,
        right_workspace.output().unwrap().vertices
    );
}

#[test]
fn invalid_input_tolerance_and_limit_precedence_clear_publication() {
    let square = vec![vec![
        point(0.0, 0.0),
        point(2.0, 0.0),
        point(2.0, 2.0),
        point(0.0, 2.0),
    ]];
    let mut workspace = RoundedFillWorkspace::new(LIMITS).unwrap();
    assert_eq!(
        workspace.tessellate(
            &references(&square),
            LineFillRule::Nonzero,
            f64::MIN_POSITIVE
        ),
        Ok(())
    );
    let invalid = vec![vec![point(f64::NAN, 0.0)]];
    assert_eq!(
        workspace.tessellate(&references(&invalid), LineFillRule::Nonzero, 1.0),
        Err(RoundedFillError::InvalidInput)
    );
    assert!(workspace.output().is_none());
    for tau in [0.0, -0.0, -1.0, f64::INFINITY, f64::NAN] {
        assert_eq!(
            workspace.tessellate(&references(&square), LineFillRule::Nonzero, tau),
            Err(RoundedFillError::InvalidTolerance)
        );
        assert!(workspace.output().is_none());
    }

    let over_input = vec![vec![point(f64::NAN, 0.0); 33]];
    assert_eq!(
        workspace.tessellate(&references(&over_input), LineFillRule::Nonzero, 0.0),
        Err(RoundedFillError::InputLimit)
    );
}

fn square() -> Vec<Vec<Point>> {
    vec![vec![
        point(0.0, 0.0),
        point(2.0, 0.0),
        point(2.0, 2.0),
        point(0.0, 2.0),
    ]]
}

#[test]
fn inclusive_record_output_and_work_limits_reject_one_below_atomically() {
    let contours = square();
    let refs = references(&contours);
    let mut baseline = RoundedFillWorkspace::new(LIMITS).unwrap();
    baseline
        .tessellate(&refs, LineFillRule::Nonzero, f64::MIN_POSITIVE)
        .unwrap();
    let stats = baseline.stats();
    let output = baseline.output().unwrap();
    let required_vertices = output.vertices.len();
    let required_triangles = output.indices.len() / 3;
    let checks = [
        ("events", stats.events, RoundedFillError::EventLimit),
        ("sections", stats.sections, RoundedFillError::SectionLimit),
        ("nodes", stats.nodes, RoundedFillError::NodeLimit),
        ("cells", stats.cells, RoundedFillError::CellLimit),
        (
            "boundaries",
            stats.boundaries,
            RoundedFillError::BoundaryLimit,
        ),
        (
            "contributors",
            stats.contributors,
            RoundedFillError::ContributorLimit,
        ),
        ("vertices", required_vertices, RoundedFillError::OutputLimit),
        (
            "triangles",
            required_triangles,
            RoundedFillError::OutputLimit,
        ),
    ];
    for (name, required, error) in checks {
        assert!(required > 0, "{name} fixture must exercise its cap");
        let mut exact_limits = LIMITS;
        match name {
            "events" => exact_limits.max_events = required,
            "sections" => exact_limits.max_sections = required,
            "nodes" => exact_limits.max_nodes = required,
            "cells" => exact_limits.max_cells = required,
            "boundaries" => exact_limits.max_boundaries = required,
            "contributors" => exact_limits.max_contributors = required,
            "vertices" => exact_limits.max_vertices = required,
            "triangles" => exact_limits.max_triangles = required,
            _ => unreachable!(),
        }
        let mut exact_workspace = RoundedFillWorkspace::new(exact_limits).unwrap();
        assert_eq!(
            exact_workspace.tessellate(&refs, LineFillRule::Nonzero, f64::MIN_POSITIVE),
            Ok(()),
            "inclusive {name}"
        );

        let mut limits = LIMITS;
        match name {
            "events" => limits.max_events = required - 1,
            "sections" => limits.max_sections = required - 1,
            "nodes" => limits.max_nodes = required - 1,
            "cells" => limits.max_cells = required - 1,
            "boundaries" => limits.max_boundaries = required - 1,
            "contributors" => limits.max_contributors = required - 1,
            "vertices" => limits.max_vertices = required - 1,
            "triangles" => limits.max_triangles = required - 1,
            _ => unreachable!(),
        }
        let mut workspace = RoundedFillWorkspace::new(limits).unwrap();
        assert_eq!(
            workspace.tessellate(&refs, LineFillRule::Nonzero, f64::MIN_POSITIVE),
            Err(error),
            "{name}"
        );
        assert!(workspace.output().is_none());
        let failed = workspace.stats();
        assert!(failed.events <= limits.max_events);
        assert!(failed.sections <= limits.max_sections);
        assert!(failed.nodes <= limits.max_nodes);
        assert!(failed.cells <= limits.max_cells);
        assert!(failed.boundaries <= limits.max_boundaries);
        assert!(failed.contributors <= limits.max_contributors);
    }

    let mut exact_work = LIMITS;
    exact_work.max_work = stats.work_units;
    let mut workspace = RoundedFillWorkspace::new(exact_work).unwrap();
    assert_eq!(
        workspace.tessellate(&refs, LineFillRule::Nonzero, f64::MIN_POSITIVE),
        Ok(())
    );
    exact_work.max_work -= 1;
    let mut workspace = RoundedFillWorkspace::new(exact_work).unwrap();
    let empty: Vec<&[Point]> = vec![];
    assert_eq!(
        workspace.tessellate(&empty, LineFillRule::Nonzero, 1.0),
        Ok(())
    );
    assert!(workspace.output().is_some());
    assert_eq!(
        workspace.tessellate(&refs, LineFillRule::Nonzero, f64::MIN_POSITIVE),
        Err(RoundedFillError::WorkLimit)
    );
    assert_eq!(workspace.stats().work_units, exact_work.max_work);
    assert!(workspace.output().is_none());

    assert_eq!(
        workspace.tessellate(&empty, LineFillRule::Nonzero, 1.0),
        Ok(())
    );
    assert!(workspace.output().is_some());
}

#[test]
fn input_edge_and_pair_caps_are_independent_and_inclusive() {
    let contours = square();
    let refs = references(&contours);
    for (limits, error) in [
        (
            RoundedFillLimits {
                max_contours: 0,
                ..LIMITS
            },
            RoundedFillError::InputLimit,
        ),
        (
            RoundedFillLimits {
                max_input_vertices: 3,
                ..LIMITS
            },
            RoundedFillError::InputLimit,
        ),
        (
            RoundedFillLimits {
                max_edges: 3,
                ..LIMITS
            },
            RoundedFillError::EdgeLimit,
        ),
        (
            RoundedFillLimits {
                max_pairs: 5,
                ..LIMITS
            },
            RoundedFillError::PairLimit,
        ),
    ] {
        let mut workspace = RoundedFillWorkspace::new(limits).unwrap();
        assert_eq!(
            workspace.tessellate(&refs, LineFillRule::Nonzero, f64::MIN_POSITIVE),
            Err(error)
        );
        assert!(workspace.output().is_none());
    }
    let exact = RoundedFillLimits {
        max_contours: 1,
        max_input_vertices: 4,
        max_edges: 4,
        max_pairs: 6,
        ..LIMITS
    };
    let mut workspace = RoundedFillWorkspace::new(exact).unwrap();
    assert_eq!(
        workspace.tessellate(&refs, LineFillRule::Nonzero, f64::MIN_POSITIVE),
        Ok(())
    );
}

#[test]
fn constructor_byte_accounting_and_invalid_arithmetic_are_exact() {
    let workspace = RoundedFillWorkspace::new(LIMITS).unwrap();
    let bytes = workspace.allocated_bytes();
    let mut exact = LIMITS;
    exact.max_bytes = bytes;
    assert_eq!(
        RoundedFillWorkspace::new(exact).unwrap().allocated_bytes(),
        bytes
    );
    exact.max_bytes = bytes - 1;
    assert!(matches!(
        RoundedFillWorkspace::new(exact),
        Err(RoundedFillError::ByteLimit)
    ));

    for limits in [
        RoundedFillLimits {
            max_events: usize::MAX,
            ..LIMITS
        },
        RoundedFillLimits {
            max_edges: usize::MAX,
            ..LIMITS
        },
        RoundedFillLimits {
            max_edges: 1,
            max_pairs: usize::MAX,
            ..LIMITS
        },
        RoundedFillLimits {
            max_cells: usize::MAX,
            ..LIMITS
        },
        RoundedFillLimits {
            max_cells: 1,
            max_nodes: usize::MAX,
            ..LIMITS
        },
        RoundedFillLimits {
            max_sections: usize::MAX,
            ..LIMITS
        },
        RoundedFillLimits {
            max_boundaries: usize::MAX,
            ..LIMITS
        },
        RoundedFillLimits {
            max_contributors: usize::MAX,
            ..LIMITS
        },
        RoundedFillLimits {
            max_triangles: usize::MAX,
            ..LIMITS
        },
        RoundedFillLimits {
            max_vertices: (u32::MAX as usize).checked_add(1).unwrap(),
            ..LIMITS
        },
    ] {
        assert!(matches!(
            RoundedFillWorkspace::new(limits),
            Err(RoundedFillError::InvalidLimits)
        ));
    }
}

#[test]
fn repeated_success_ambiguity_and_invalid_attempts_allocate_nothing() {
    let rows = parse_fixture();
    let success_contours = square();
    let success_refs = references(&success_contours);
    let late = row(&rows, "R04", LineFillRule::Nonzero);
    let ambiguity = row(&rows, "A01", LineFillRule::Nonzero);
    let late_refs = references(&late.contours);
    let ambiguity_refs = references(&ambiguity.contours);
    let invalid = vec![vec![point(f64::NAN, 0.0)]];
    let invalid_refs = references(&invalid);
    let mut measure = RoundedFillWorkspace::new(LIMITS).unwrap();
    measure
        .tessellate(&success_refs, LineFillRule::Nonzero, f64::MIN_POSITIVE)
        .unwrap();
    let success_work = measure.stats().work_units;
    assert_eq!(measure.tessellate(&late_refs, late.rule, late.tau), Ok(()));
    assert!(measure.stats().work_units > success_work);
    let mut limits = LIMITS;
    limits.max_work = success_work;
    let mut workspace = RoundedFillWorkspace::new(limits).unwrap();
    let mut ambiguity_workspace = RoundedFillWorkspace::new(LIMITS).unwrap();
    let bytes = workspace.allocated_bytes();
    let ambiguity_bytes = ambiguity_workspace.allocated_bytes();
    let mut correct = true;
    crate::allocation_test_support::start();
    for _ in 0..32 {
        correct &=
            workspace.tessellate(&success_refs, LineFillRule::Nonzero, f64::MIN_POSITIVE) == Ok(());
        correct &= workspace.tessellate(&late_refs, late.rule, late.tau)
            == Err(RoundedFillError::WorkLimit);
        correct &= ambiguity_workspace.tessellate(&ambiguity_refs, ambiguity.rule, ambiguity.tau)
            == Err(RoundedFillError::TopologyAmbiguous);
        correct &= workspace.tessellate(&invalid_refs, LineFillRule::Evenodd, 1.0)
            == Err(RoundedFillError::InvalidInput);
    }
    let allocations = crate::allocation_test_support::stop();
    assert!(correct);
    assert_eq!(allocations, 0);
    assert_eq!(workspace.allocated_bytes(), bytes);
    assert_eq!(ambiguity_workspace.allocated_bytes(), ambiguity_bytes);
    assert!(workspace.output().is_none());
    assert!(ambiguity_workspace.output().is_none());
}

fn print_point(value: Point) {
    print!("[{},{}]", value.x, value.y);
}

pub(super) fn print_points(values: &[Point]) {
    print!("[");
    for (index, value) in values.iter().copied().enumerate() {
        if index != 0 {
            print!(",");
        }
        print_point(value);
    }
    print!("]");
}

fn print_range(value: SourceRange) {
    print!("{{\"start\":{},\"count\":{}}}", value.start, value.count);
}

fn print_usizes(values: &[usize]) {
    print!("[");
    for (index, value) in values.iter().enumerate() {
        if index != 0 {
            print!(",");
        }
        print!("{value}");
    }
    print!("]");
}

pub(super) fn print_output(output: RoundedFillOutput<'_>) {
    print!("{{\"vertices\":");
    print_points(output.vertices);
    print!(",\"indices\":[");
    for (index, value) in output.indices.iter().enumerate() {
        if index != 0 {
            print!(",");
        }
        print!("{value}");
    }
    print!(
        "],\"bounds\":[{},{},{},{}]",
        output.bounds.min_x, output.bounds.min_y, output.bounds.max_x, output.bounds.max_y
    );
    print!(",\"source_edges\":[");
    for (index, value) in output.source_edges.iter().enumerate() {
        if index != 0 {
            print!(",");
        }
        print!(
            "{{\"contour\":{},\"start_vertex\":{},\"end_vertex\":{}}}",
            value.contour, value.start_vertex, value.end_vertex
        );
    }
    print!("],\"columns\":[");
    for (index, value) in output.columns.iter().enumerate() {
        if index != 0 {
            print!(",");
        }
        print!(
            "{{\"x\":{},\"node_start\":{},\"node_count\":{}}}",
            value.x, value.node_start, value.node_count
        );
    }
    print!("],\"nodes\":[");
    for (index, value) in output.nodes.iter().enumerate() {
        if index != 0 {
            print!(",");
        }
        print!("{{\"point\":");
        print_point(value.point);
        print!(",\"column\":{},\"vertex\":", value.column);
        if let Some(vertex) = value.vertex {
            print!("{vertex}");
        } else {
            print!("null");
        }
        print!("}}");
    }
    print!("],\"sections\":[");
    for (index, value) in output.sections.iter().enumerate() {
        if index != 0 {
            print!(",");
        }
        print!(
            "{{\"column\":{},\"node\":{},\"edge\":{},\"endpoint\":{}}}",
            value.column, value.node, value.edge, value.endpoint
        );
    }
    print!("],\"cells\":[");
    for (index, value) in output.cells.iter().enumerate() {
        if index != 0 {
            print!(",");
        }
        print!(
            "{{\"slab\":{},\"nodes\":[{},{},{},{}],\"lower_sources\":",
            value.slab, value.nodes[0], value.nodes[1], value.nodes[2], value.nodes[3]
        );
        print_range(value.lower_sources);
        print!(",\"upper_sources\":");
        print_range(value.upper_sources);
        print!(
            ",\"lower_before\":{},\"lower_after\":{},\"upper_before\":{},\"upper_after\":{}}}",
            value.lower_before, value.lower_after, value.upper_before, value.upper_after
        );
    }
    print!("],\"boundaries\":[");
    for (index, value) in output.boundaries.iter().enumerate() {
        if index != 0 {
            print!(",");
        }
        let kind = match value.kind {
            BoundaryKind::Lower => "Lower",
            BoundaryKind::Upper => "Upper",
            BoundaryKind::Vertical => "Vertical",
        };
        print!(
            "{{\"from\":{},\"to\":{},\"kind\":\"{}\",\"sources\":",
            value.from, value.to, kind
        );
        print_range(value.sources);
        print!(
            ",\"before_winding\":{},\"after_winding\":{}}}",
            value.before_winding, value.after_winding
        );
    }
    print!("],\"spans\":[");
    for (index, value) in output.spans.iter().enumerate() {
        if index != 0 {
            print!(",");
        }
        print!("{{\"column\":{},\"lower\":{},\"upper\":{},\"left_winding\":{},\"right_winding\":{},\"vertical_delta\":{},\"vertical_sources\":", value.column, value.lower, value.upper, value.left_winding, value.right_winding, value.vertical_delta);
        print_range(value.vertical_sources);
        print!("}}");
    }
    print!("],\"contributors\":");
    print_usizes(output.contributors);
    print!(",\"error_bound\":{}}}", output.error_bound);
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

pub(super) fn print_stats(stats: RoundedFillStats) {
    print!("{{\"input_vertices\":{},\"edges\":{},\"pair_checks\":{},\"events\":{},\"columns\":{},\"sections\":{},\"nodes\":{},\"cells\":{},\"boundaries\":{},\"contributors\":{},\"work_units\":{}}}", stats.input_vertices, stats.edges, stats.pair_checks, stats.events, stats.columns, stats.sections, stats.nodes, stats.cells, stats.boundaries, stats.contributors, stats.work_units);
}

#[test]
#[ignore]
fn emit_rounded_fill_meshes() {
    let rows = parse_fixture();
    let mut workspace = RoundedFillWorkspace::new(LIMITS).unwrap();
    println!("P3_ROUNDED_FILL_BEGIN");
    for fixture in rows {
        let result =
            workspace.tessellate(&references(&fixture.contours), fixture.rule, fixture.tau);
        print!(
            "{{\"id\":\"{}\",\"rule\":\"{}\",\"tau_bits\":\"{}\",\"profile\":\"{}\",\"contours\":",
            fixture.id, fixture.rule_name, fixture.tau_bits, fixture.profile
        );
        print_contours(&fixture.contours);
        match result {
            Ok(()) => {
                print!(",\"error\":null,\"output\":");
                print_output(workspace.output().unwrap());
            }
            Err(RoundedFillError::TopologyAmbiguous) => {
                print!(",\"error\":\"TopologyAmbiguous\",\"output\":null");
            }
            Err(error) => panic!("{}:{} failed: {error:?}", fixture.id, fixture.rule_name),
        }
        print!(",\"stats\":");
        print_stats(workspace.stats());
        println!("}}");
    }
    println!("P3_ROUNDED_FILL_END");
}
