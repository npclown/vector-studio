use core::mem::size_of;
use std::env;
use std::fs::File;
use std::io::Read;

use crate::codec::{PathInput, Request};
use crate::cubic_fill::{
    CubicFillDiagnostics as AttemptDiagnostics, CubicFillError as BridgeError,
    CubicFillOutput as BridgeOutput, CubicFillWorkspace as BridgeWorkspace, DecodedSource,
    EdgeOwner, FlatCommand, MAX_FLAT_COMMANDS as MAX_COMMANDS,
};
use crate::geometry::{
    Plan, Point, WorkStatistics, PATH_EMPTY, PATH_INVALID, PATH_INVALID_TOLERANCE,
    PATH_NUMERIC_RANGE, PATH_OK, VERB_CLOSE, VERB_CUBIC, VERB_MOVE,
};
use crate::line_fill::LineFillRule;
use crate::rounded_line_fill::{
    RoundedBoundary, RoundedCell, RoundedColumnSpan, RoundedFillError, RoundedFillLimits,
    RoundedFillOutput, RoundedFillStats, RoundedFillWorkspace, RoundedSection, RoundedSourceEdge,
};
use crate::rounded_line_fill_tests::{print_output, print_points, print_stats};
use crate::simple_cubic_topology::{
    RoundedKnotCubicTopologyWorkspace, SimpleCubicTopologyWorkspace, TopologyError, TopologyLimits,
};

const INPUT_LIMIT_BYTES: usize = 512 * 1024;
const EXPECTED_ROWS: usize = 94;
const FLATTEN_TOLERANCE: f64 = 0.125;
const TOPOLOGY_TOLERANCE: f64 = 0.0625;
const MAX_CONTOURS: usize = 4;
const MAX_SOURCE_CUBICS: usize = 16;
const MAX_BRIDGE_HEAP_BYTES: usize = 16 * 1024 * 1024;

const LIMITS: RoundedFillLimits = RoundedFillLimits {
    max_contours: 4,
    max_input_vertices: 64,
    max_edges: 64,
    max_pairs: 2_016,
    max_events: 128,
    max_sections: 8_320,
    max_nodes: 256,
    max_cells: 256,
    max_boundaries: 512,
    max_contributors: 512,
    max_vertices: 256,
    max_triangles: 256,
    max_work: 2_000_000,
    max_bytes: 16 * 1024 * 1024,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExpectedStatus {
    Ok,
    PathNumericRange,
}

#[derive(Clone, Copy, Debug)]
struct SourceCubic {
    points: [Point; 4],
    bits: [u64; 8],
}

#[derive(Debug)]
struct SourceContour {
    cubics: Vec<SourceCubic>,
}

#[derive(Debug)]
struct SourceRow {
    id: String,
    rule: LineFillRule,
    expectation: ExpectedStatus,
    contours: Vec<SourceContour>,
    verbs: Vec<u8>,
    point_bytes: Vec<u8>,
}

#[derive(Debug)]
struct PreparedPath {
    verbs: Vec<u8>,
    point_bytes: Vec<u8>,
}

impl PreparedPath {
    fn path_input(&self) -> PathInput<'_> {
        PathInput::from_test_parts(
            Request {
                request_id: 0,
                source_epoch: 0,
                source_revision: 0,
                tolerance: FLATTEN_TOLERANCE,
            },
            &self.verbs,
            &self.point_bytes,
        )
    }
}

#[derive(Debug, PartialEq)]
struct NormalizedSnapshot {
    ranges: Vec<crate::cubic_fill::ContourRange>,
    point_bits: Vec<[u64; 2]>,
    rounded: RoundedCarrierSnapshot,
}

#[derive(Debug, PartialEq)]
struct RoundedCarrierSnapshot {
    vertex_bits: Vec<[u64; 2]>,
    indices: Vec<u32>,
    bounds_bits: [u64; 4],
    source_edges: Vec<RoundedSourceEdge>,
    columns: Vec<(u64, usize, usize)>,
    nodes: Vec<([u64; 2], usize, Option<u32>)>,
    sections: Vec<RoundedSection>,
    cells: Vec<RoundedCell>,
    boundaries: Vec<RoundedBoundary>,
    spans: Vec<RoundedColumnSpan>,
    contributors: Vec<usize>,
    error_bound_bits: u64,
    stats: RoundedFillStats,
}

impl SourceRow {
    fn path_input(&self) -> PathInput<'_> {
        PathInput::from_test_parts(
            Request {
                request_id: 0,
                source_epoch: 0,
                source_revision: 0,
                tolerance: FLATTEN_TOLERANCE,
            },
            &self.verbs,
            &self.point_bytes,
        )
    }

    fn rule_name(&self) -> &'static str {
        match self.rule {
            LineFillRule::Nonzero => "nonzero",
            LineFillRule::Evenodd => "evenodd",
        }
    }
}

fn same_point(left: Point, right: Point) -> bool {
    left.x == right.x && left.y == right.y
}

fn parse_fixture(source: &str, expected_rows: usize) -> Result<Vec<SourceRow>, String> {
    if source.len() > INPUT_LIMIT_BYTES {
        return Err("fixture exceeds 512 KiB".to_owned());
    }
    let mut lines = source.lines();
    if lines.next() != Some("# p3-native-cubic-v1") {
        return Err("invalid fixture header".to_owned());
    }
    let count_header = format!("# rows {expected_rows}");
    if lines.next() != Some(count_header.as_str()) {
        return Err("invalid fixture row count header".to_owned());
    }
    let mut rows = Vec::with_capacity(expected_rows);
    for line in lines {
        if line.is_empty() {
            return Err("empty fixture row".to_owned());
        }
        if rows.len() >= expected_rows {
            return Err("too many fixture rows".to_owned());
        }
        rows.push(parse_row(line)?);
    }
    if rows.len() != expected_rows {
        return Err(format!(
            "expected {expected_rows} fixture rows, received {}",
            rows.len()
        ));
    }
    Ok(rows)
}

fn parse_row(line: &str) -> Result<SourceRow, String> {
    let pieces: Vec<&str> = line.split(" | ").collect();
    if pieces.len() < 2 {
        return Err("fixture row requires at least one contour".to_owned());
    }
    let fields: Vec<&str> = pieces[0].split_ascii_whitespace().collect();
    if fields.len() != 3 || !valid_id(fields[0]) {
        return Err("invalid fixture row header".to_owned());
    }
    let rule = match fields[1] {
        "nonzero" => LineFillRule::Nonzero,
        "evenodd" => LineFillRule::Evenodd,
        _ => return Err("invalid fill rule".to_owned()),
    };
    let expectation = match fields[2] {
        "OK" => ExpectedStatus::Ok,
        "PATH_NUMERIC_RANGE" => ExpectedStatus::PathNumericRange,
        _ => return Err("invalid fixture expectation".to_owned()),
    };
    if pieces.len() - 1 > MAX_CONTOURS {
        return Err("too many contours".to_owned());
    }
    let mut contours = Vec::with_capacity(pieces.len() - 1);
    let mut cubic_count = 0usize;
    for text in &pieces[1..] {
        if text.is_empty() {
            return Err("empty contour".to_owned());
        }
        let mut cubics = Vec::new();
        let mut previous_end = None;
        for encoded in text.split(';') {
            if encoded.is_empty() {
                return Err("empty cubic".to_owned());
            }
            cubic_count += 1;
            if cubic_count > 16 {
                return Err("too many cubics".to_owned());
            }
            let cubic = parse_cubic(encoded)?;
            if previous_end.is_some_and(|end| !same_point(end, cubic.points[0])) {
                return Err("disconnected contour".to_owned());
            }
            previous_end = Some(cubic.points[3]);
            cubics.push(cubic);
        }
        if cubics.is_empty() {
            return Err("empty contour".to_owned());
        }
        contours.push(SourceContour { cubics });
    }
    let mut row = SourceRow {
        id: fields[0].to_owned(),
        rule,
        expectation,
        contours,
        verbs: Vec::new(),
        point_bytes: Vec::new(),
    };
    prepare_path(&mut row)?;
    Ok(row)
}

fn parse_cubic(encoded: &str) -> Result<SourceCubic, String> {
    let fields: Vec<&str> = encoded.split(',').collect();
    if fields.len() != 8 {
        return Err("cubic must contain eight coordinates".to_owned());
    }
    let mut bits = [0u64; 8];
    for (index, field) in fields.iter().enumerate() {
        if field.len() != 16
            || !field
                .as_bytes()
                .iter()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
        {
            return Err("coordinate must be lowercase 16-digit hex".to_owned());
        }
        bits[index] =
            u64::from_str_radix(field, 16).map_err(|_| "invalid coordinate hex".to_owned())?;
        if !f64::from_bits(bits[index]).is_finite() {
            return Err("nonfinite source control".to_owned());
        }
    }
    Ok(SourceCubic {
        points: [
            Point {
                x: f64::from_bits(bits[0]),
                y: f64::from_bits(bits[1]),
            },
            Point {
                x: f64::from_bits(bits[2]),
                y: f64::from_bits(bits[3]),
            },
            Point {
                x: f64::from_bits(bits[4]),
                y: f64::from_bits(bits[5]),
            },
            Point {
                x: f64::from_bits(bits[6]),
                y: f64::from_bits(bits[7]),
            },
        ],
        bits,
    })
}

fn prepare_path(row: &mut SourceRow) -> Result<(), String> {
    let mut verbs = Vec::new();
    let mut point_bytes = Vec::new();
    for contour in &row.contours {
        let first = contour
            .cubics
            .first()
            .ok_or_else(|| "empty contour".to_owned())?
            .points[0];
        verbs.push(VERB_MOVE);
        push_point_bytes(&mut point_bytes, first);
        for cubic in &contour.cubics {
            verbs.push(VERB_CUBIC);
            for point in &cubic.points[1..] {
                push_point_bytes(&mut point_bytes, *point);
            }
        }
        let last = contour.cubics.last().unwrap().points[3];
        if same_point(first, last) {
            verbs.push(VERB_CLOSE);
        }
    }
    row.verbs = verbs;
    row.point_bytes = point_bytes;
    Ok(())
}

fn prepare_toggled_path(row: &SourceRow) -> PreparedPath {
    let mut verbs = Vec::new();
    let mut point_bytes = Vec::new();
    for contour in &row.contours {
        let first = contour.cubics.first().unwrap().points[0];
        verbs.push(VERB_MOVE);
        push_point_bytes(&mut point_bytes, first);
        for cubic in &contour.cubics {
            verbs.push(VERB_CUBIC);
            for point in &cubic.points[1..] {
                push_point_bytes(&mut point_bytes, *point);
            }
        }
        let last = contour.cubics.last().unwrap().points[3];
        if !same_point(first, last) {
            verbs.push(VERB_CLOSE);
        }
    }
    assert!(verbs.len() <= 24, "{} alternate verb cap", row.id);
    assert!(
        point_bytes.len() / 8 <= 104,
        "{} alternate scalar cap",
        row.id
    );
    PreparedPath { verbs, point_bytes }
}

fn push_point_bytes(bytes: &mut Vec<u8>, point: Point) {
    bytes.extend_from_slice(&point.x.to_le_bytes());
    bytes.extend_from_slice(&point.y.to_le_bytes());
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'/' || *byte == b'-')
}

fn load_fixture() -> Vec<SourceRow> {
    load_fixture_from_env("P3_NATIVE_CUBIC_INPUT", EXPECTED_ROWS)
}

fn load_fixture_from_env(variable: &str, expected_rows: usize) -> Vec<SourceRow> {
    let path = env::var(variable).unwrap_or_else(|_| panic!("{variable} must be set"));
    let file = File::open(path).unwrap_or_else(|_| panic!("open {variable} fixture"));
    let mut bytes = Vec::new();
    file.take((INPUT_LIMIT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .unwrap_or_else(|_| panic!("read {variable} fixture"));
    assert!(bytes.len() <= INPUT_LIMIT_BYTES, "fixture exceeds 512 KiB");
    let source = core::str::from_utf8(&bytes).expect("fixture must be UTF-8");
    parse_fixture(source, expected_rows).unwrap_or_else(|error| panic!("parse {variable}: {error}"))
}

fn print_source_bits(row: &SourceRow) {
    print!("[");
    for (contour_index, contour) in row.contours.iter().enumerate() {
        if contour_index != 0 {
            print!(",");
        }
        print!("[");
        for (cubic_index, cubic) in contour.cubics.iter().enumerate() {
            if cubic_index != 0 {
                print!(",");
            }
            print!("[");
            for (index, bits) in cubic.bits.iter().enumerate() {
                if index != 0 {
                    print!(",");
                }
                print!("\"{bits:016x}\"");
            }
            print!("]");
        }
        print!("]");
    }
    print!("]");
}

fn print_plan(plan: Plan) {
    print!(
        "{{\"status\":{},\"verb_count\":{},\"point_count\":{}}}",
        plan.status, plan.verb_count, plan.point_count
    );
}

fn print_statistics(statistics: WorkStatistics) {
    print!("{{\"logical_cubics\":{},\"sizing_visits\":{},\"emission_visits\":{},\"emitted_cubic_lines\":{}}}", statistics.logical_cubics, statistics.sizing_visits, statistics.emission_visits, statistics.emitted_cubic_lines);
}

fn print_commands(commands: &[FlatCommand]) {
    print!("[");
    for (index, command) in commands.iter().enumerate() {
        if index != 0 {
            print!(",");
        }
        print!("{{\"verb\":{},\"point\":", command.verb);
        if let Some(point) = command.point {
            print!("[{},{}]", point.x, point.y);
        } else {
            print!("null");
        }
        print!(
            ",\"provenance\":{{\"source_verb\":{},\"end_numerator\":{},\"depth\":{}}}}}",
            command.provenance.source_verb,
            command.provenance.end_numerator,
            command.provenance.depth
        );
    }
    print!("]");
}

fn print_owners(owners: &[EdgeOwner]) {
    print!("[");
    for (index, owner) in owners.iter().enumerate() {
        if index != 0 {
            print!(",");
        }
        match owner {
            EdgeOwner::Line { source_verb } => {
                print!("{{\"kind\":\"Line\",\"source_verb\":{source_verb}}}")
            }
            EdgeOwner::CubicLeaf {
                source_verb,
                end_numerator,
                depth,
            } => print!("{{\"kind\":\"CubicLeaf\",\"source_verb\":{source_verb},\"end_numerator\":{end_numerator},\"depth\":{depth}}}"),
            EdgeOwner::ImplicitClosure { contour } => print!(
                "{{\"kind\":\"ImplicitClosure\",\"contour\":{contour}}}"
            ),
            EdgeOwner::ExplicitClose { source_verb } => print!(
                "{{\"kind\":\"ExplicitClose\",\"source_verb\":{source_verb}}}"
            ),
        }
    }
    print!("]");
}

fn print_contours(output: BridgeOutput<'_>) {
    print!("[");
    for (index, range) in output.ranges.iter().copied().enumerate() {
        if index != 0 {
            print!(",");
        }
        print_points(&output.points[range.start..range.start + range.count]);
    }
    print!("]");
}

fn print_rounded(row: &SourceRow, output: BridgeOutput<'_>) {
    print!(
        "{{\"id\":\"{}\",\"rule\":\"{}\",\"tau_bits\":\"{:016x}\",\"profile\":\"I\",\"contours\":",
        row.id,
        row.rule_name(),
        TOPOLOGY_TOLERANCE.to_bits()
    );
    print_contours(output);
    print!(",\"error\":null,\"output\":");
    print_output(output.rounded);
    print!(",\"stats\":");
    print_stats(output.rounded_stats);
    print!("}}");
}

fn print_native_cubic_row(
    row: &SourceRow,
    diagnostics: AttemptDiagnostics,
    output: Option<BridgeOutput<'_>>,
    allocations: usize,
    allocated_bytes: usize,
    inline_bytes: usize,
) {
    print!(
        "{{\"id\":\"{}\",\"rule\":\"{}\",\"source_bits\":",
        row.id,
        row.rule_name()
    );
    print_source_bits(row);
    print!(
        ",\"flatten_tolerance_bits\":\"{:016x}\",\"topology_tolerance_bits\":\"{:016x}\",\"flat_status\":{},\"sizing_plan\":",
        FLATTEN_TOLERANCE.to_bits(),
        TOPOLOGY_TOLERANCE.to_bits(),
        diagnostics.flat_status
    );
    print_plan(diagnostics.sizing_plan);
    print!(",\"emission_plan\":");
    if let Some(plan) = diagnostics.emission_plan {
        print_plan(plan);
    } else {
        print!("null");
    }
    print!(",\"statistics\":");
    print_statistics(diagnostics.statistics);
    if let Some(output) = output {
        let bounds = diagnostics.flat_bounds.expect("successful flat bounds");
        print!(
            ",\"flat_bounds\":[{},{},{},{}],\"commands\":",
            bounds.min_x, bounds.min_y, bounds.max_x, bounds.max_y
        );
        print_commands(output.commands);
        print!(",\"edge_owners\":");
        print_owners(output.owners);
        print!(",\"rounded\":");
        print_rounded(row, output);
    } else {
        print!(",\"flat_bounds\":null,\"commands\":null,\"edge_owners\":null,\"rounded\":null");
    }
    print!(
        ",\"allocations\":{allocations},\"allocated_bytes\":{allocated_bytes},\"inline_bytes\":{inline_bytes}}}"
    );
}

fn topology_error_name(error: TopologyError) -> &'static str {
    match error {
        TopologyError::InvalidLimits => "InvalidLimits",
        TopologyError::AllocationFailed => "AllocationFailed",
        TopologyError::ByteLimit => "ByteLimit",
        TopologyError::InvalidInput => "InvalidInput",
        TopologyError::InvalidProvenance => "InvalidProvenance",
        TopologyError::KnotMismatch => "KnotMismatch",
        TopologyError::Unresolved => "Unresolved",
        TopologyError::WorkLimit => "WorkLimit",
    }
}

fn assert_decoded_sources(row: &SourceRow, verbs: &[u8], output: BridgeOutput<'_>) {
    let expected_count: usize = row
        .contours
        .iter()
        .map(|contour| contour.cubics.len())
        .sum();
    assert_eq!(output.sources.len(), expected_count, "{}", row.id);
    let mut source_index = 0usize;
    let mut source_ordinal = 0u32;
    for (contour_index, contour) in row.contours.iter().enumerate() {
        source_ordinal += 1;
        let mut canonical_start = contour.cubics.first().unwrap().points[0];
        for cubic in &contour.cubics {
            let decoded = output.sources[source_index];
            assert_eq!(decoded.contour(), contour_index, "{}", row.id);
            assert_eq!(decoded.source_verb(), source_ordinal, "{}", row.id);
            let canonical = [
                canonical_start,
                cubic.points[1],
                cubic.points[2],
                cubic.points[3],
            ];
            let points = match decoded {
                DecodedSource::Cubic { points, .. } => points,
                DecodedSource::Line { .. } => panic!("{} decoded cubic as line", row.id),
            };
            for (actual, expected) in points.iter().zip(canonical) {
                assert_eq!(actual.x.to_bits(), expected.x.to_bits(), "{}", row.id);
                assert_eq!(actual.y.to_bits(), expected.y.to_bits(), "{}", row.id);
            }
            canonical_start = cubic.points[3];
            source_index += 1;
            source_ordinal += 1;
        }
        if verbs.get(usize::try_from(source_ordinal).unwrap()) == Some(&VERB_CLOSE) {
            source_ordinal += 1;
        }
    }
    assert_eq!(usize::try_from(source_ordinal).unwrap(), verbs.len());
}

fn assert_input_owners(row: &SourceRow, verbs: &[u8], output: BridgeOutput<'_>) {
    let mut expected = Vec::new();
    let mut source_ordinal = 0u32;
    let mut command_cursor = 0usize;
    for (contour_index, contour) in row.contours.iter().enumerate() {
        assert_eq!(verbs[usize::try_from(source_ordinal).unwrap()], VERB_MOVE);
        source_ordinal += 1;
        for _ in &contour.cubics {
            assert_eq!(verbs[usize::try_from(source_ordinal).unwrap()], VERB_CUBIC);
            while command_cursor < output.commands.len() {
                let command = output.commands[command_cursor];
                command_cursor += 1;
                if command.verb == crate::geometry::VERB_LINE
                    && command.provenance.source_verb == source_ordinal
                {
                    expected.push(EdgeOwner::CubicLeaf {
                        source_verb: source_ordinal,
                        end_numerator: command.provenance.end_numerator,
                        depth: command.provenance.depth,
                    });
                }
                if command_cursor == output.commands.len()
                    || output.commands[command_cursor].provenance.source_verb > source_ordinal
                {
                    break;
                }
            }
            source_ordinal += 1;
        }
        let first = contour.cubics.first().unwrap().points[0];
        let last = contour.cubics.last().unwrap().points[3];
        let has_close = verbs.get(usize::try_from(source_ordinal).unwrap()) == Some(&VERB_CLOSE);
        if !same_point(first, last) {
            expected.push(if has_close {
                EdgeOwner::ExplicitClose {
                    source_verb: source_ordinal,
                }
            } else {
                EdgeOwner::ImplicitClosure {
                    contour: contour_index,
                }
            });
        }
        if has_close {
            source_ordinal += 1;
        }
    }
    assert_eq!(
        usize::try_from(source_ordinal).unwrap(),
        verbs.len(),
        "{}",
        row.id
    );
    assert_eq!(output.owners, expected, "{}", row.id);
}

fn snapshot(output: BridgeOutput<'_>) -> NormalizedSnapshot {
    NormalizedSnapshot {
        ranges: output.ranges.to_vec(),
        point_bits: output
            .points
            .iter()
            .map(|point| [point.x.to_bits(), point.y.to_bits()])
            .collect(),
        rounded: rounded_carrier_snapshot(output.rounded, output.rounded_stats),
    }
}

fn rounded_carrier_snapshot(
    output: RoundedFillOutput<'_>,
    stats: RoundedFillStats,
) -> RoundedCarrierSnapshot {
    RoundedCarrierSnapshot {
        vertex_bits: output
            .vertices
            .iter()
            .map(|point| [point.x.to_bits(), point.y.to_bits()])
            .collect(),
        indices: output.indices.to_vec(),
        bounds_bits: [
            output.bounds.min_x.to_bits(),
            output.bounds.min_y.to_bits(),
            output.bounds.max_x.to_bits(),
            output.bounds.max_y.to_bits(),
        ],
        source_edges: output.source_edges.to_vec(),
        columns: output
            .columns
            .iter()
            .map(|column| (column.x.to_bits(), column.node_start, column.node_count))
            .collect(),
        nodes: output
            .nodes
            .iter()
            .map(|node| {
                (
                    [node.point.x.to_bits(), node.point.y.to_bits()],
                    node.column,
                    node.vertex,
                )
            })
            .collect(),
        sections: output.sections.to_vec(),
        cells: output.cells.to_vec(),
        boundaries: output.boundaries.to_vec(),
        spans: output.spans.to_vec(),
        contributors: output.contributors.to_vec(),
        error_bound_bits: output.error_bound.to_bits(),
        stats,
    }
}

#[test]
#[ignore]
fn emit_native_cubic_fill() {
    let rows = load_fixture();
    let mut workspace = BridgeWorkspace::new(LIMITS).expect("construct native cubic workspace");
    let allocated_bytes = workspace.allocated_bytes();
    let inline_bytes = size_of::<BridgeWorkspace>();
    assert!(inline_bytes < 64 * 1024);
    println!("P3_NATIVE_CUBIC_BEGIN");
    let mut paired_rows = 0usize;
    let mut paired_successes = 0usize;
    let mut paired_numeric_ranges = 0usize;
    for row in &rows {
        paired_rows += 1;
        let alternate = prepare_toggled_path(row);
        assert_eq!(alternate.point_bytes, row.point_bytes, "{}", row.id);
        assert!(row.verbs.len() <= 24, "{} original verb cap", row.id);
        assert!(
            row.point_bytes.len() / 8 <= 104,
            "{} original scalar cap",
            row.id
        );
        crate::allocation_test_support::start();
        let alternate_attempt = workspace.attempt(
            alternate.path_input(),
            row.rule,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        );
        let alternate_allocations = crate::allocation_test_support::stop();
        let alternate_diagnostics = alternate_attempt
            .unwrap_or_else(|error| panic!("{} alternate failed: {error:?}", row.id));
        assert!(
            !alternate_diagnostics.rounded_topology_invoked,
            "{}",
            row.id
        );
        assert!(
            !alternate_diagnostics.rounded_topology_selected,
            "{}",
            row.id
        );
        assert_eq!(
            alternate_diagnostics.rounded_topology_error, None,
            "{}",
            row.id
        );
        let alternate_output = workspace.output();
        match row.expectation {
            ExpectedStatus::Ok => {
                paired_successes += 1;
                assert_eq!(alternate_diagnostics.flat_status, PATH_OK, "{}", row.id);
                let output = alternate_output.expect("successful alternate output");
                assert_decoded_sources(row, &alternate.verbs, output);
                assert_input_owners(row, &alternate.verbs, output);
            }
            ExpectedStatus::PathNumericRange => {
                paired_numeric_ranges += 1;
                assert_eq!(
                    alternate_diagnostics.flat_status, PATH_NUMERIC_RANGE,
                    "{}",
                    row.id
                );
                assert!(alternate_diagnostics.emission_plan.is_none(), "{}", row.id);
                assert!(!alternate_diagnostics.emission_invoked, "{}", row.id);
                assert!(!alternate_diagnostics.topology_invoked, "{}", row.id);
                assert!(!alternate_diagnostics.rounded_invoked, "{}", row.id);
                assert!(alternate_output.is_none(), "{}", row.id);
            }
        }
        assert_eq!(
            alternate_allocations, 0,
            "{} alternate allocated during attempt",
            row.id
        );
        assert_eq!(workspace.allocated_bytes(), allocated_bytes);
        let alternate_snapshot = alternate_output.map(snapshot);
        let alternate_topology_stats = workspace.topology_stats();

        crate::allocation_test_support::start();
        let attempt =
            workspace.attempt(row.path_input(), row.rule, TOPOLOGY_TOLERANCE, MAX_COMMANDS);
        let allocations = crate::allocation_test_support::stop();
        let diagnostics = attempt.unwrap_or_else(|error| panic!("{} failed: {error:?}", row.id));
        assert!(!diagnostics.rounded_topology_invoked, "{}", row.id);
        assert!(!diagnostics.rounded_topology_selected, "{}", row.id);
        assert_eq!(diagnostics.rounded_topology_error, None, "{}", row.id);
        let output = workspace.output();
        match row.expectation {
            ExpectedStatus::Ok => {
                assert_eq!(diagnostics.flat_status, PATH_OK, "{}", row.id);
                assert!(diagnostics.emission_plan.is_some(), "{}", row.id);
                assert!(output.is_some(), "{}", row.id);
                let output = output.unwrap();
                assert_decoded_sources(row, &row.verbs, output);
                assert_input_owners(row, &row.verbs, output);
                assert_eq!(alternate_snapshot, Some(snapshot(output)), "{}", row.id);
                assert_eq!(
                    workspace.topology_stats(),
                    alternate_topology_stats,
                    "{}",
                    row.id
                );
                assert_eq!(
                    diagnostics.statistics, alternate_diagnostics.statistics,
                    "{}",
                    row.id
                );
                if row.id == "C05" || row.id.starts_with("C05/") {
                    assert_eq!(output.commands.len(), 72, "{}", row.id);
                    assert_eq!(
                        alternate_diagnostics.sizing_plan.verb_count, 68,
                        "{}",
                        row.id
                    );
                }
            }
            ExpectedStatus::PathNumericRange => {
                assert_eq!(diagnostics.flat_status, PATH_NUMERIC_RANGE, "{}", row.id);
                assert!(diagnostics.emission_plan.is_none(), "{}", row.id);
                assert!(!diagnostics.emission_invoked, "{}", row.id);
                assert!(!diagnostics.topology_invoked, "{}", row.id);
                assert!(!diagnostics.rounded_invoked, "{}", row.id);
                assert!(output.is_none(), "{}", row.id);
            }
        }
        assert_eq!(allocations, 0, "{} allocated during attempt", row.id);
        assert_eq!(workspace.allocated_bytes(), allocated_bytes);
        print_native_cubic_row(
            row,
            diagnostics,
            output,
            allocations,
            allocated_bytes,
            inline_bytes,
        );
        println!();
    }
    assert_eq!(paired_rows, EXPECTED_ROWS);
    assert_eq!(paired_successes, 92);
    assert_eq!(paired_numeric_ranges, 2);
    println!("P3_NATIVE_CUBIC_END");
}

fn adoption_mesh_area(output: RoundedFillOutput<'_>) -> f64 {
    assert_eq!(output.indices.len() % 3, 0);
    output
        .indices
        .chunks_exact(3)
        .map(|triangle| {
            let a = output.vertices[usize::try_from(triangle[0]).unwrap()];
            let b = output.vertices[usize::try_from(triangle[1]).unwrap()];
            let c = output.vertices[usize::try_from(triangle[2]).unwrap()];
            ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)).abs() / 2.0
        })
        .sum()
}

fn assert_adoption_output(
    row: &SourceRow,
    verbs: &[u8],
    diagnostics: AttemptDiagnostics,
    stats: crate::simple_cubic_topology::TopologyStats,
    output: BridgeOutput<'_>,
    rounded_route: bool,
) {
    assert_eq!(row.expectation, ExpectedStatus::Ok, "{}", row.id);
    assert_eq!(diagnostics.flat_status, PATH_OK, "{}", row.id);
    assert!(diagnostics.emission_invoked, "{}", row.id);
    assert!(diagnostics.topology_invoked, "{}", row.id);
    assert_eq!(
        diagnostics.rounded_topology_invoked, rounded_route,
        "{}",
        row.id
    );
    assert_eq!(
        diagnostics.rounded_topology_selected, rounded_route,
        "{}",
        row.id
    );
    assert_eq!(diagnostics.rounded_topology_error, None, "{}", row.id);
    assert!(diagnostics.rounded_invoked, "{}", row.id);
    assert_eq!(stats.leaves, 12, "{}", row.id);
    assert_eq!(stats.pairs, 66, "{}", row.id);
    assert_eq!(diagnostics.statistics.logical_cubics, 9, "{}", row.id);
    assert_eq!(diagnostics.statistics.sizing_visits, 15, "{}", row.id);
    assert_eq!(diagnostics.statistics.emission_visits, 15, "{}", row.id);
    assert_eq!(diagnostics.statistics.emitted_cubic_lines, 12, "{}", row.id);
    assert_eq!(output.sources.len(), 9, "{}", row.id);
    assert_eq!(output.owners.len(), 12, "{}", row.id);
    assert_eq!(output.ranges.len(), 1, "{}", row.id);
    assert_eq!(output.ranges[0].start, 0, "{}", row.id);
    assert_eq!(output.ranges[0].count, 12, "{}", row.id);
    assert_eq!(output.points.len(), 12, "{}", row.id);
    assert_eq!(output.commands.len(), verbs.len() + 3, "{}", row.id);
    assert_decoded_sources(row, verbs, output);
    assert_input_owners(row, verbs, output);

    let expected = [
        Point { x: 0.0, y: 0.0 },
        Point {
            x: 0.75,
            y: 9.0 / 64.0,
        },
        Point {
            x: 1.5,
            y: 3.0 / 8.0,
        },
        Point {
            x: 2.25,
            y: 27.0 / 64.0,
        },
        Point { x: 3.0, y: 0.0 },
        Point {
            x: 21.0 / 8.0,
            y: -3.0 / 4.0,
        },
        Point {
            x: 9.0 / 4.0,
            y: -3.0 / 2.0,
        },
        Point {
            x: 15.0 / 8.0,
            y: -9.0 / 4.0,
        },
        Point { x: 1.5, y: -3.0 },
        Point {
            x: 9.0 / 8.0,
            y: -9.0 / 4.0,
        },
        Point {
            x: 3.0 / 4.0,
            y: -3.0 / 2.0,
        },
        Point {
            x: 3.0 / 8.0,
            y: -3.0 / 4.0,
        },
    ];
    for (actual, expected) in output.points.iter().zip(expected) {
        assert_eq!(actual.x.to_bits(), expected.x.to_bits(), "{}", row.id);
        assert_eq!(actual.y.to_bits(), expected.y.to_bits(), "{}", row.id);
    }
    let upper_ends: Vec<Point> = output
        .commands
        .iter()
        .filter(|command| {
            command.verb == crate::geometry::VERB_LINE && command.provenance.source_verb == 1
        })
        .map(|command| command.point.unwrap())
        .collect();
    assert_eq!(upper_ends.len(), 4, "{}", row.id);
    for (actual, expected) in upper_ends.iter().zip(&expected[1..5]) {
        assert_eq!(actual.x.to_bits(), expected.x.to_bits(), "{}", row.id);
        assert_eq!(actual.y.to_bits(), expected.y.to_bits(), "{}", row.id);
    }
    assert_eq!(
        adoption_mesh_area(output.rounded),
        333.0 / 64.0,
        "{}",
        row.id
    );
}

#[test]
#[ignore]
fn emit_rounded_native_cubic_fill() {
    const ADOPTION_ROWS: usize = 4;
    let rows = load_fixture_from_env("P3_NATIVE_ROUNDED_CUBIC_INPUT", ADOPTION_ROWS);
    let expected = [
        ("adoption/exact", LineFillRule::Nonzero, false),
        ("adoption/exact", LineFillRule::Evenodd, false),
        ("adoption/rounded", LineFillRule::Nonzero, true),
        ("adoption/rounded", LineFillRule::Evenodd, true),
    ];
    let mut workspace = BridgeWorkspace::new(LIMITS).expect("construct rounded cubic workspace");
    let allocated_bytes = workspace.allocated_bytes();
    let inline_bytes = size_of::<BridgeWorkspace>();
    assert!(allocated_bytes <= MAX_BRIDGE_HEAP_BYTES);
    assert!(inline_bytes < 64 * 1024);
    println!("P3_NATIVE_ROUNDED_CUBIC_BEGIN");
    for (row, (expected_id, expected_rule, rounded_route)) in rows.iter().zip(expected) {
        assert_eq!(row.id, expected_id);
        assert_eq!(row.rule, expected_rule);
        assert_eq!(row.verbs.last(), Some(&VERB_CLOSE), "{}", row.id);
        assert_eq!(row.verbs.len(), 11, "{}", row.id);
        assert_eq!(row.point_bytes.len() / 8, 56, "{}", row.id);
        let alternate = prepare_toggled_path(row);
        assert_eq!(alternate.point_bytes, row.point_bytes, "{}", row.id);
        assert_eq!(alternate.verbs.len(), 10, "{}", row.id);
        assert_ne!(alternate.verbs.last(), Some(&VERB_CLOSE), "{}", row.id);

        crate::allocation_test_support::start();
        let alternate_result = workspace.attempt(
            alternate.path_input(),
            row.rule,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        );
        let alternate_allocations = crate::allocation_test_support::stop();
        let alternate_diagnostics = alternate_result
            .unwrap_or_else(|error| panic!("{} alternate failed: {error:?}", row.id));
        let alternate_stats = workspace.topology_stats();
        let alternate_output = workspace.output().expect("successful alternate output");
        assert_adoption_output(
            row,
            &alternate.verbs,
            alternate_diagnostics,
            alternate_stats,
            alternate_output,
            rounded_route,
        );
        assert_eq!(alternate_allocations, 0, "{}", row.id);
        assert_eq!(workspace.allocated_bytes(), allocated_bytes);
        let alternate_snapshot = snapshot(alternate_output);

        crate::allocation_test_support::start();
        let result =
            workspace.attempt(row.path_input(), row.rule, TOPOLOGY_TOLERANCE, MAX_COMMANDS);
        let allocations = crate::allocation_test_support::stop();
        let diagnostics = result.unwrap_or_else(|error| panic!("{} failed: {error:?}", row.id));
        let stats = workspace.topology_stats();
        let output = workspace.output().expect("successful closed output");
        assert_adoption_output(row, &row.verbs, diagnostics, stats, output, rounded_route);
        assert_eq!(snapshot(output), alternate_snapshot, "{}", row.id);
        assert_eq!(
            diagnostics.statistics, alternate_diagnostics.statistics,
            "{}",
            row.id
        );
        assert_eq!(allocations, 0, "{}", row.id);
        assert_eq!(workspace.allocated_bytes(), allocated_bytes);

        print!("{{\"carrier\":");
        print_native_cubic_row(
            row,
            diagnostics,
            Some(output),
            allocations,
            allocated_bytes,
            inline_bytes,
        );
        print!(
            ",\"topology\":{{\"topology_invoked\":{},\"rounded_topology_invoked\":{},\"rounded_topology_selected\":{},\"rounded_topology_error\":",
            diagnostics.topology_invoked,
            diagnostics.rounded_topology_invoked,
            diagnostics.rounded_topology_selected,
        );
        if let Some(error) = diagnostics.rounded_topology_error {
            print!("\"{}\"", topology_error_name(error));
        } else {
            print!("null");
        }
        print!(
            ",\"stats\":{{\"leaves\":{},\"pairs\":{}}}",
            stats.leaves, stats.pairs
        );
        println!("}}}}");
    }
    println!("P3_NATIVE_ROUNDED_CUBIC_END");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Debug, Default)]
    struct RawPath {
        verbs: Vec<u8>,
        point_bytes: Vec<u8>,
    }

    impl RawPath {
        fn input(&self, tolerance: f64) -> PathInput<'_> {
            PathInput::from_test_parts(
                Request {
                    request_id: 0,
                    source_epoch: 0,
                    source_revision: 0,
                    tolerance,
                },
                &self.verbs,
                &self.point_bytes,
            )
        }

        fn point_count(&self) -> usize {
            self.point_bytes.len() / 8
        }

        fn move_to(&mut self, point: Point) {
            self.verbs.push(VERB_MOVE);
            push_point_bytes(&mut self.point_bytes, point);
        }

        fn cubic_to(&mut self, one: Point, two: Point, end: Point) {
            self.verbs.push(VERB_CUBIC);
            push_point_bytes(&mut self.point_bytes, one);
            push_point_bytes(&mut self.point_bytes, two);
            push_point_bytes(&mut self.point_bytes, end);
        }

        fn line_to(&mut self, point: Point) {
            self.verbs.push(crate::geometry::VERB_LINE);
            push_point_bytes(&mut self.point_bytes, point);
        }

        fn close(&mut self) {
            self.verbs.push(VERB_CLOSE);
        }
    }

    fn measured_attempt(
        workspace: &mut BridgeWorkspace,
        row: &SourceRow,
        topology_tolerance: f64,
        command_capacity: usize,
    ) -> Result<AttemptDiagnostics, BridgeError> {
        let bytes = workspace.allocated_bytes();
        crate::allocation_test_support::start();
        let result = workspace.attempt(
            row.path_input(),
            row.rule,
            topology_tolerance,
            command_capacity,
        );
        let allocations = crate::allocation_test_support::stop();
        assert_eq!(allocations, 0, "bridge attempt allocated");
        assert_eq!(workspace.allocated_bytes(), bytes);
        result
    }

    fn measured_raw_attempt(
        workspace: &mut BridgeWorkspace,
        path: &RawPath,
        flatten_tolerance: f64,
        topology_tolerance: f64,
        command_capacity: usize,
    ) -> Result<AttemptDiagnostics, BridgeError> {
        measured_raw_rule_attempt(
            workspace,
            path,
            LineFillRule::Nonzero,
            flatten_tolerance,
            topology_tolerance,
            command_capacity,
        )
    }

    fn measured_raw_rule_attempt(
        workspace: &mut BridgeWorkspace,
        path: &RawPath,
        rule: LineFillRule,
        flatten_tolerance: f64,
        topology_tolerance: f64,
        command_capacity: usize,
    ) -> Result<AttemptDiagnostics, BridgeError> {
        let bytes = workspace.allocated_bytes();
        crate::allocation_test_support::start();
        let result = workspace.attempt(
            path.input(flatten_tolerance),
            rule,
            topology_tolerance,
            command_capacity,
        );
        let allocations = crate::allocation_test_support::stop();
        assert_eq!(allocations, 0, "cubic fill attempt allocated");
        assert_eq!(workspace.allocated_bytes(), bytes);
        result
    }

    fn linear(start: Point, one: Point, two: Point, end: Point) -> SourceCubic {
        let points = [start, one, two, end];
        let mut bits = [0u64; 8];
        for (index, point) in points.iter().enumerate() {
            bits[index * 2] = point.x.to_bits();
            bits[index * 2 + 1] = point.y.to_bits();
        }
        SourceCubic { points, bits }
    }

    fn point(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    fn cubic_points(source: DecodedSource) -> [Point; 4] {
        match source {
            DecodedSource::Cubic { points, .. } => points,
            DecodedSource::Line { .. } => panic!("expected cubic source"),
        }
    }

    fn append_linear(path: &mut RawPath, start: Point, end: Point) {
        path.cubic_to(
            point(
                start.x + (end.x - start.x) / 3.0,
                start.y + (end.y - start.y) / 3.0,
            ),
            point(
                start.x + 2.0 * (end.x - start.x) / 3.0,
                start.y + 2.0 * (end.y - start.y) / 3.0,
            ),
            end,
        );
    }

    fn rotate(point: Point) -> Point {
        Point {
            x: -point.y,
            y: point.x,
        }
    }

    fn append_diamond(path: &mut RawPath, dx: f64) {
        let mut quarter = [
            point(4.0, 0.0),
            point(4.0, 2.0),
            point(2.0, 4.0),
            point(0.0, 4.0),
        ];
        path.move_to(point(quarter[0].x + dx, quarter[0].y));
        for _ in 0..4 {
            path.cubic_to(
                point(quarter[1].x + dx, quarter[1].y),
                point(quarter[2].x + dx, quarter[2].y),
                point(quarter[3].x + dx, quarter[3].y),
            );
            quarter = quarter.map(rotate);
        }
        path.close();
    }

    fn raw_square() -> RawPath {
        let corners = [
            point(0.0, 0.0),
            point(3.0, 0.0),
            point(3.0, 3.0),
            point(0.0, 3.0),
        ];
        let mut path = RawPath::default();
        path.move_to(corners[0]);
        for index in 0..corners.len() {
            append_linear(
                &mut path,
                corners[index],
                corners[(index + 1) % corners.len()],
            );
        }
        path.close();
        path
    }

    fn raw_three_quarter_open() -> RawPath {
        let mut quarter = [
            point(4.0, 0.0),
            point(4.0, 2.0),
            point(2.0, 4.0),
            point(0.0, 4.0),
        ];
        let mut path = RawPath::default();
        path.move_to(quarter[0]);
        for _ in 0..3 {
            path.cubic_to(quarter[1], quarter[2], quarter[3]);
            quarter = quarter.map(rotate);
        }
        path
    }

    fn append_triangle(path: &mut RawPath, dx: f64, returning: bool, closed: bool) {
        path.move_to(point(dx, 0.0));
        path.cubic_to(
            point(dx + 1.0, 0.0),
            point(dx + 2.0, 0.0),
            point(dx + 3.0, 0.0),
        );
        path.cubic_to(point(dx + 2.0, 1.0), point(dx + 1.0, 2.0), point(dx, 3.0));
        if returning {
            path.cubic_to(point(dx, 2.0), point(dx, 1.0), point(dx, 0.0));
        }
        if closed {
            path.close();
        }
    }

    fn raw_triangle(returning: bool, closed: bool) -> RawPath {
        let mut path = RawPath::default();
        append_triangle(&mut path, 0.0, returning, closed);
        path
    }

    fn append_mixed_triangle(
        path: &mut RawPath,
        dx: f64,
        returning: bool,
        closed: bool,
        line_mask: u8,
    ) {
        let vertices = [point(dx, 0.0), point(dx + 3.0, 0.0), point(dx, 3.0)];
        path.move_to(vertices[0]);
        let segment_count = if returning { 3 } else { 2 };
        for index in 0..segment_count {
            let start = vertices[index];
            let end = vertices[(index + 1) % vertices.len()];
            if line_mask & (1 << index) != 0 {
                path.line_to(end);
            } else {
                append_linear(path, start, end);
            }
        }
        if closed {
            path.close();
        }
    }

    fn raw_mixed_triangle(returning: bool, closed: bool, line_mask: u8) -> RawPath {
        let mut path = RawPath::default();
        append_mixed_triangle(&mut path, 0.0, returning, closed, line_mask);
        path
    }

    fn append_segment(path: &mut RawPath, start: Point, end: Point, line: bool) {
        if line {
            path.line_to(end);
        } else {
            append_linear(path, start, end);
        }
    }

    fn mixed_sixteen_square(all_cubic: bool, seventeenth: bool) -> RawPath {
        let vertices = [
            point(0.0, 0.0),
            point(3.0, 0.0),
            point(6.0, 0.0),
            point(9.0, 0.0),
            point(12.0, 0.0),
            point(12.0, 3.0),
            point(12.0, 6.0),
            point(12.0, 9.0),
            point(12.0, 12.0),
            point(9.0, 12.0),
            point(6.0, 12.0),
            point(3.0, 12.0),
            point(0.0, 12.0),
            point(0.0, 9.0),
            point(0.0, 6.0),
            point(0.0, 3.0),
            point(0.0, 0.0),
        ];
        let mut path = RawPath::default();
        path.move_to(vertices[0]);
        for index in 0..16 {
            append_segment(
                &mut path,
                vertices[index],
                vertices[index + 1],
                !all_cubic && index % 2 == 0,
            );
        }
        if seventeenth {
            path.line_to(point(-3.0, 0.0));
        } else {
            path.close();
        }
        path
    }

    fn square_row(scale: f64) -> SourceRow {
        let mut row = SourceRow {
            id: "test-square".to_owned(),
            rule: LineFillRule::Nonzero,
            expectation: ExpectedStatus::Ok,
            contours: vec![SourceContour {
                cubics: vec![
                    linear(
                        point(0.0, 0.0),
                        point(scale, 0.0),
                        point(2.0 * scale, 0.0),
                        point(3.0 * scale, 0.0),
                    ),
                    linear(
                        point(3.0 * scale, 0.0),
                        point(3.0 * scale, scale),
                        point(3.0 * scale, 2.0 * scale),
                        point(3.0 * scale, 3.0 * scale),
                    ),
                    linear(
                        point(3.0 * scale, 3.0 * scale),
                        point(2.0 * scale, 3.0 * scale),
                        point(scale, 3.0 * scale),
                        point(0.0, 3.0 * scale),
                    ),
                    linear(
                        point(0.0, 3.0 * scale),
                        point(0.0, 2.0 * scale),
                        point(0.0, scale),
                        point(0.0, 0.0),
                    ),
                ],
            }],
            verbs: Vec::new(),
            point_bytes: Vec::new(),
        };
        prepare_path(&mut row).unwrap();
        row
    }

    fn bowtie_row() -> SourceRow {
        let corners = [
            point(0.0, 0.0),
            point(6.0, 6.0),
            point(0.0, 6.0),
            point(6.0, 0.0),
        ];
        let mut row = square_row(1.0);
        row.id = "test-topology-bowtie".to_owned();
        row.contours[0].cubics = corners
            .iter()
            .copied()
            .enumerate()
            .map(|(index, start)| {
                let end = corners[(index + 1) % corners.len()];
                let dx = (end.x - start.x) / 3.0;
                let dy = (end.y - start.y) / 3.0;
                linear(
                    start,
                    point(start.x + dx, start.y + dy),
                    point(start.x + 2.0 * dx, start.y + 2.0 * dy),
                    end,
                )
            })
            .collect();
        prepare_path(&mut row).unwrap();
        row
    }

    fn adoption_path(endpoint_perturbation: f64, closed: bool) -> RawPath {
        let a = point(0.0, 0.0);
        let b = point(3.0, 0.0);
        let lower = [
            point(21.0 / 8.0, -3.0 / 4.0),
            point(9.0 / 4.0, -3.0 / 2.0),
            point(15.0 / 8.0, -9.0 / 4.0),
            point(3.0 / 2.0, -3.0),
            point(9.0 / 8.0, -9.0 / 4.0),
            point(3.0 / 4.0, -3.0 / 2.0),
            point(3.0 / 8.0, -3.0 / 4.0),
            a,
        ];
        let mut path = RawPath::default();
        path.move_to(a);
        path.cubic_to(point(1.0, endpoint_perturbation), point(2.0, 1.0), b);
        let mut start = b;
        for end in lower {
            append_linear(&mut path, start, end);
            start = end;
        }
        if closed {
            path.close();
        }
        path
    }

    fn rounded_failure_path() -> RawPath {
        let a = point(0.0, 0.0);
        let b = point(3.0, 0.0);
        let c = point(1.5, -3.0);
        let mut path = RawPath::default();
        path.move_to(a);
        path.cubic_to(point(1.0, 2.0f64.powi(-54)), point(2.0, 1.0), b);
        append_linear(&mut path, b, c);
        append_linear(&mut path, c, a);
        path.close();
        path
    }

    fn adoption_bowtie() -> RawPath {
        let corners = [
            point(0.0, 0.0),
            point(3.0, 3.0),
            point(0.0, 3.0),
            point(3.0, 0.0),
            point(0.0, 0.0),
        ];
        let mut path = RawPath::default();
        path.move_to(corners[0]);
        for pair in corners.windows(2) {
            append_linear(&mut path, pair[0], pair[1]);
        }
        path.close();
        path
    }

    fn topology_skip_triangle() -> RawPath {
        let mut path = RawPath::default();
        path.move_to(point(0.0, 0.0));
        path.line_to(point(3.0, 0.0));
        path.line_to(point(1.5, -3.0));
        path.line_to(point(0.0, 0.0));
        path.close();
        path
    }

    #[test]
    fn strict_parser_preserves_signed_zero_and_rejects_malformed_rows() {
        let row = "signed-zero nonzero OK | 8000000000000000,0000000000000000,3ff0000000000000,0000000000000000,4000000000000000,0000000000000000,4008000000000000,0000000000000000";
        let source = format!("# p3-native-cubic-v1\n# rows 1\n{row}\n");
        let parsed = parse_fixture(&source, 1).unwrap();
        assert_eq!(parsed[0].contours[0].cubics[0].bits[0], 1u64 << 63);
        assert_eq!(
            parsed[0].contours[0].cubics[0].points[0].x.to_bits(),
            1u64 << 63
        );
        for invalid in [
            source.replace("# rows 1", "# rows 2"),
            source.replace("8000000000000000", "800000000000000G"),
            source.replace("8000000000000000", "7ff0000000000000"),
            source.replace(" nonzero ", " invalid "),
            source.replace(" OK ", " MAYBE "),
        ] {
            assert!(parse_fixture(&invalid, 1).is_err());
        }
    }

    #[test]
    fn constructor_accounts_all_three_retained_workspaces() {
        let workspace = BridgeWorkspace::new(LIMITS).unwrap();
        let rounded = RoundedFillWorkspace::new(LIMITS).unwrap();
        let exact = SimpleCubicTopologyWorkspace::new(TopologyLimits::default()).unwrap();
        let rounded_topology =
            RoundedKnotCubicTopologyWorkspace::new(TopologyLimits::default()).unwrap();
        assert_eq!(rounded_topology.allocated_bytes(), 224_256);
        let expected = rounded
            .allocated_bytes()
            .checked_add(exact.allocated_bytes())
            .and_then(|bytes| bytes.checked_add(rounded_topology.allocated_bytes()))
            .unwrap();
        assert_eq!(workspace.allocated_bytes(), expected);
        assert!(workspace.allocated_bytes() <= MAX_BRIDGE_HEAP_BYTES);
        assert!(size_of::<BridgeWorkspace>() < 64 * 1024);
    }

    #[test]
    fn rounded_topology_failure_preserves_exact_knot_mismatch_and_recovers() {
        let success = adoption_path(0.0, true);
        let failure = rounded_failure_path();
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();

        measured_raw_attempt(
            &mut workspace,
            &success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert!(workspace.output().is_some());
        assert!(!workspace.diagnostics().rounded_topology_invoked);
        assert_eq!(
            measured_raw_attempt(
                &mut workspace,
                &failure,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            ),
            Err(BridgeError::Topology(TopologyError::KnotMismatch))
        );
        let diagnostics = workspace.diagnostics();
        assert!(diagnostics.topology_invoked);
        assert!(diagnostics.rounded_topology_invoked);
        assert!(!diagnostics.rounded_topology_selected);
        assert_eq!(
            diagnostics.rounded_topology_error,
            Some(TopologyError::Unresolved)
        );
        assert!(!diagnostics.rounded_invoked);
        assert!(workspace.output().is_none());
        assert_eq!(workspace.topology_stats().leaves, 6);
        assert_eq!(workspace.topology_stats().pairs, 5);
        measured_raw_attempt(
            &mut workspace,
            &success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert!(workspace.output().is_some());
        assert!(!workspace.diagnostics().rounded_topology_invoked);
        assert_eq!(workspace.topology_stats().leaves, 12);
        assert_eq!(workspace.topology_stats().pairs, 66);
    }

    #[test]
    fn non_knot_topology_failure_never_invokes_rounded_fallback() {
        let success = adoption_path(0.0, true);
        let bowtie = adoption_bowtie();
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();
        measured_raw_attempt(
            &mut workspace,
            &success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert_eq!(
            measured_raw_attempt(
                &mut workspace,
                &bowtie,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            ),
            Err(BridgeError::Topology(TopologyError::Unresolved))
        );
        let diagnostics = workspace.diagnostics();
        assert!(diagnostics.topology_invoked);
        assert!(!diagnostics.rounded_topology_invoked);
        assert!(!diagnostics.rounded_topology_selected);
        assert_eq!(diagnostics.rounded_topology_error, None);
        assert!(!diagnostics.rounded_invoked);
        assert!(workspace.output().is_none());
        assert_eq!(workspace.topology_stats().leaves, 4);
        assert_eq!(workspace.topology_stats().pairs, 2);
        measured_raw_attempt(
            &mut workspace,
            &success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert!(workspace.output().is_some());
    }

    #[test]
    fn rounded_selection_resets_diagnostics_and_preserves_cached_stats_across_skips() {
        let rounded_success = adoption_path(2.0f64.powi(-54), true);
        let exact_success = adoption_path(0.0, true);
        let line_identity = topology_skip_triangle();
        let cheap_failure = RawPath {
            verbs: vec![VERB_MOVE; 25],
            point_bytes: vec![0; 50 * 8],
        };
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();

        measured_raw_attempt(
            &mut workspace,
            &rounded_success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert!(workspace.diagnostics().rounded_topology_invoked);
        assert!(workspace.diagnostics().rounded_topology_selected);
        assert_eq!(workspace.diagnostics().rounded_topology_error, None);
        assert_eq!(workspace.topology_stats().leaves, 12);
        assert_eq!(workspace.topology_stats().pairs, 66);
        let retained = workspace.topology_stats();

        assert_eq!(
            measured_raw_attempt(
                &mut workspace,
                &cheap_failure,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            ),
            Err(BridgeError::SourceLimit)
        );
        assert_eq!(workspace.diagnostics(), AttemptDiagnostics::default());
        assert_eq!(workspace.topology_stats(), retained);
        assert!(workspace.output().is_none());

        measured_raw_attempt(
            &mut workspace,
            &line_identity,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        let diagnostics = workspace.diagnostics();
        assert!(!diagnostics.topology_invoked);
        assert!(!diagnostics.rounded_topology_invoked);
        assert!(!diagnostics.rounded_topology_selected);
        assert_eq!(diagnostics.rounded_topology_error, None);
        assert!(diagnostics.rounded_invoked);
        assert_eq!(workspace.topology_stats(), retained);

        measured_raw_attempt(
            &mut workspace,
            &exact_success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert!(workspace.diagnostics().topology_invoked);
        assert!(!workspace.diagnostics().rounded_topology_invoked);
        assert_eq!(workspace.topology_stats().leaves, 12);
        assert_eq!(workspace.topology_stats().pairs, 66);
    }

    #[test]
    fn rounded_selection_rounding_failure_and_owned_source_recover() {
        let mut rounded_success = adoption_path(2.0f64.powi(-54), true);
        let exact_success = adoption_path(0.0, true);
        let mut first = BridgeWorkspace::new(LIMITS).unwrap();
        let mut second = BridgeWorkspace::new(LIMITS).unwrap();

        measured_raw_attempt(
            &mut first,
            &rounded_success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        measured_raw_attempt(
            &mut second,
            &exact_success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert_eq!(
            measured_raw_attempt(
                &mut first,
                &rounded_success,
                FLATTEN_TOLERANCE,
                0.0,
                MAX_COMMANDS,
            ),
            Err(BridgeError::Rounded(RoundedFillError::InvalidTolerance))
        );
        let diagnostics = first.diagnostics();
        assert!(diagnostics.topology_invoked);
        assert!(diagnostics.rounded_topology_invoked);
        assert!(diagnostics.rounded_topology_selected);
        assert_eq!(diagnostics.rounded_topology_error, None);
        assert!(diagnostics.rounded_invoked);
        assert!(first.output().is_none());
        assert_eq!(first.topology_stats().leaves, 12);
        assert_eq!(first.topology_stats().pairs, 66);
        measured_raw_attempt(
            &mut first,
            &rounded_success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        let retained = first.output().unwrap().sources[0];
        rounded_success.point_bytes.fill(0xff);
        drop(rounded_success);
        assert_eq!(first.output().unwrap().sources[0], retained);
        assert!(second.output().is_some());
        assert!(!second.diagnostics().rounded_topology_invoked);
    }

    #[test]
    fn canonical_source_caps_and_decoded_identity_are_exact() {
        let mut ceiling = RawPath::default();
        for dx in [0.0, 16.0, 32.0, 48.0] {
            append_diamond(&mut ceiling, dx);
        }
        assert_eq!(ceiling.verbs.len(), 24);
        assert_eq!(ceiling.point_count(), 104);
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();
        let diagnostics = measured_raw_attempt(
            &mut workspace,
            &ceiling,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            usize::MAX,
        )
        .unwrap();
        assert_eq!(diagnostics.flat_status, PATH_OK);
        assert_eq!(diagnostics.emission_plan.unwrap().verb_count, 72);
        assert!(diagnostics.topology_invoked);
        assert!(diagnostics.rounded_invoked);
        assert_eq!(workspace.topology_stats().leaves, 64);
        assert_eq!(workspace.topology_stats().pairs, 2_016);
        let output = workspace.output().unwrap();
        assert_eq!(output.commands.len(), 72);
        assert_eq!(output.sources.len(), 16);
        assert_eq!(output.owners.len(), 64);
        assert_eq!(output.sources[0].source_verb(), 1);
        assert_eq!(output.sources[4].source_verb(), 7);

        let mut seventeen = RawPath::default();
        let mut current = point(0.0, 0.0);
        seventeen.move_to(current);
        for index in 0..17 {
            // Three-unit spans keep both one-third controls integral, so P2 sees a=b=0.
            let end = point(3.0 * f64::from(index + 1), 0.0);
            append_linear(&mut seventeen, current, end);
            current = end;
        }
        assert_eq!(seventeen.verbs.len(), 18);
        assert_eq!(seventeen.point_count(), 104);
        assert_eq!(
            measured_raw_attempt(
                &mut workspace,
                &seventeen,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            ),
            Err(BridgeError::SourceLimit)
        );
        assert!(workspace.output().is_none());
        assert!(workspace.diagnostics().sizing_invoked);
        assert!(!workspace.diagnostics().emission_invoked);

        let mut five_contours = RawPath::default();
        for index in 0..5 {
            let start = point(f64::from(index * 12), 0.0);
            five_contours.move_to(start);
            append_linear(&mut five_contours, start, point(start.x + 3.0, 0.0));
        }
        assert_eq!(
            measured_raw_attempt(
                &mut workspace,
                &five_contours,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            ),
            Err(BridgeError::SourceLimit)
        );
        assert!(workspace.diagnostics().sizing_invoked);
        assert!(!workspace.diagnostics().emission_invoked);

        let cheap_verbs = RawPath {
            verbs: vec![VERB_MOVE; 25],
            point_bytes: vec![0; 50 * 8],
        };
        assert_eq!(
            measured_raw_attempt(
                &mut workspace,
                &cheap_verbs,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            ),
            Err(BridgeError::SourceLimit)
        );
        assert_eq!(workspace.diagnostics(), AttemptDiagnostics::default());

        let cheap_scalars = RawPath {
            verbs: Vec::new(),
            point_bytes: vec![0; 105 * 8],
        };
        assert_eq!(
            measured_raw_attempt(
                &mut workspace,
                &cheap_scalars,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            ),
            Err(BridgeError::SourceLimit)
        );
        assert_eq!(workspace.diagnostics(), AttemptDiagnostics::default());
    }

    #[test]
    fn restricted_grammar_is_left_to_right_and_path_status_precedes_decode() {
        let success = raw_square();
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();

        let malformed = RawPath {
            verbs: vec![VERB_CUBIC],
            point_bytes: vec![0; 6 * 8],
        };
        let diagnostics = measured_raw_attempt(
            &mut workspace,
            &malformed,
            f64::NAN,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert_eq!(diagnostics.flat_status, PATH_INVALID);
        assert!(!diagnostics.emission_invoked);

        let mut nonfinite = RawPath::default();
        nonfinite.move_to(point(f64::NAN, 0.0));
        let malformed_inputs = [
            RawPath {
                verbs: vec![255],
                point_bytes: Vec::new(),
            },
            nonfinite,
            RawPath {
                verbs: vec![VERB_MOVE],
                point_bytes: vec![0; 8],
            },
            RawPath {
                verbs: vec![VERB_MOVE],
                point_bytes: vec![0; 3 * 8],
            },
        ];
        for malformed in &malformed_inputs {
            let diagnostics = measured_raw_attempt(
                &mut workspace,
                malformed,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            )
            .unwrap();
            assert_eq!(diagnostics.flat_status, PATH_INVALID);
            assert!(!diagnostics.emission_invoked);
        }

        let mut move_only = RawPath::default();
        move_only.move_to(point(0.0, 0.0));
        let diagnostics = measured_raw_attempt(
            &mut workspace,
            &move_only,
            f64::NAN,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert_eq!(diagnostics.flat_status, PATH_INVALID_TOLERANCE);
        let diagnostics = measured_raw_attempt(
            &mut workspace,
            &move_only,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert!(!diagnostics.topology_invoked);
        assert!(diagnostics.rounded_invoked);
        assert!(workspace.output().is_some());

        let empty = RawPath::default();
        let diagnostics = measured_raw_attempt(
            &mut workspace,
            &empty,
            f64::NAN,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert_eq!(diagnostics.flat_status, PATH_INVALID_TOLERANCE);
        let diagnostics = measured_raw_attempt(
            &mut workspace,
            &empty,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert_eq!(diagnostics.flat_status, PATH_EMPTY);

        let mut consecutive_moves = RawPath::default();
        consecutive_moves.move_to(point(0.0, 0.0));
        consecutive_moves.move_to(point(1.0, 0.0));
        let diagnostics = measured_raw_attempt(
            &mut workspace,
            &consecutive_moves,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert!(workspace.diagnostics().sizing_invoked);
        assert!(workspace.diagnostics().emission_invoked);
        assert!(!diagnostics.topology_invoked);
        assert!(diagnostics.rounded_invoked);
        let output = workspace.output().unwrap();
        assert_eq!(output.ranges.len(), 2);
        assert_eq!(output.owners.len(), 0);

        let mut line_before_fifth = RawPath::default();
        line_before_fifth.move_to(point(0.0, 0.0));
        line_before_fifth.move_to(point(3.0, 0.0));
        line_before_fifth.line_to(point(6.0, 0.0));
        for x in [12.0, 24.0, 36.0, 48.0] {
            let start = point(x, 0.0);
            line_before_fifth.move_to(start);
            line_before_fifth.line_to(point(start.x + 3.0, 0.0));
        }
        assert_eq!(line_before_fifth.verbs.len(), 11);
        assert_eq!(line_before_fifth.point_count(), 22);
        assert_eq!(
            measured_raw_attempt(
                &mut workspace,
                &line_before_fifth,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            ),
            Err(BridgeError::SourceLimit)
        );

        let mut fifth_before_line = RawPath::default();
        for index in 0..4 {
            let start = point(f64::from(index * 12), 0.0);
            fifth_before_line.move_to(start);
            fifth_before_line.line_to(point(start.x + 3.0, 0.0));
        }
        fifth_before_line.move_to(point(48.0, 0.0));
        fifth_before_line.line_to(point(51.0, 0.0));
        assert_eq!(
            measured_raw_attempt(
                &mut workspace,
                &fifth_before_line,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            ),
            Err(BridgeError::SourceLimit)
        );

        measured_raw_attempt(
            &mut workspace,
            &success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert!(workspace.output().is_some());
    }

    #[test]
    fn canonical_implicit_closure_is_owned_and_source_p0_tracks_prior_p3() {
        let path = raw_three_quarter_open();
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();
        measured_raw_attempt(
            &mut workspace,
            &path,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        let output = workspace.output().unwrap();
        assert_eq!(output.sources.len(), 3);
        assert_eq!(output.sources[0].source_verb(), 1);
        assert_eq!(output.sources[1].source_verb(), 2);
        assert_eq!(output.sources[2].source_verb(), 3);
        for index in 1..output.sources.len() {
            let DecodedSource::Cubic {
                points: current, ..
            } = output.sources[index]
            else {
                panic!("expected cubic source")
            };
            let DecodedSource::Cubic {
                points: previous, ..
            } = output.sources[index - 1]
            else {
                panic!("expected cubic source")
            };
            assert_eq!(current[0].x.to_bits(), previous[3].x.to_bits());
            assert_eq!(current[0].y.to_bits(), previous[3].y.to_bits());
        }
        assert_eq!(
            output.owners.last(),
            Some(&EdgeOwner::ImplicitClosure { contour: 0 })
        );
    }

    fn assert_literal_triangle(output: BridgeOutput<'_>, dx: f64) {
        assert_eq!(output.ranges.len(), 1);
        assert_eq!(output.ranges[0].start, 0);
        assert_eq!(output.ranges[0].count, 3);
        assert_eq!(output.points.len(), 3);
        let expected = [point(dx, 0.0), point(dx + 3.0, 0.0), point(dx, 3.0)];
        for (actual, expected) in output.points.iter().zip(expected) {
            assert_eq!(actual.x.to_bits(), expected.x.to_bits());
            assert_eq!(actual.y.to_bits(), expected.y.to_bits());
        }
        assert_eq!(output.rounded.vertices.len(), 3);
        assert_eq!(output.rounded.indices.len(), 3);
        let mut triangle: Vec<(u64, u64)> = output
            .rounded
            .indices
            .iter()
            .map(|index| output.rounded.vertices[usize::try_from(*index).unwrap()])
            .map(|point| (point.x.to_bits(), point.y.to_bits()))
            .collect();
        triangle.sort_unstable();
        let mut expected_bits: Vec<(u64, u64)> = expected
            .iter()
            .map(|point| (point.x.to_bits(), point.y.to_bits()))
            .collect();
        expected_bits.sort_unstable();
        assert_eq!(triangle, expected_bits);
    }

    #[test]
    fn all_four_closure_forms_normalize_to_the_literal_triangle() {
        for rule in [LineFillRule::Nonzero, LineFillRule::Evenodd] {
            for (returning, closed, command_count, final_owner) in [
                (
                    true,
                    false,
                    4,
                    EdgeOwner::CubicLeaf {
                        source_verb: 3,
                        end_numerator: 1,
                        depth: 0,
                    },
                ),
                (
                    true,
                    true,
                    5,
                    EdgeOwner::CubicLeaf {
                        source_verb: 3,
                        end_numerator: 1,
                        depth: 0,
                    },
                ),
                (false, false, 3, EdgeOwner::ImplicitClosure { contour: 0 }),
                (false, true, 4, EdgeOwner::ExplicitClose { source_verb: 3 }),
            ] {
                let path = raw_triangle(returning, closed);
                let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();
                let diagnostics = measured_raw_rule_attempt(
                    &mut workspace,
                    &path,
                    rule,
                    FLATTEN_TOLERANCE,
                    TOPOLOGY_TOLERANCE,
                    MAX_COMMANDS,
                )
                .unwrap();
                assert_eq!(diagnostics.flat_status, PATH_OK);
                let output = workspace.output().unwrap();
                assert_eq!(output.commands.len(), command_count);
                assert_literal_triangle(output, 0.0);
                assert_eq!(
                    output.owners,
                    [
                        EdgeOwner::CubicLeaf {
                            source_verb: 1,
                            end_numerator: 1,
                            depth: 0,
                        },
                        EdgeOwner::CubicLeaf {
                            source_verb: 2,
                            end_numerator: 1,
                            depth: 0,
                        },
                        final_owner,
                    ]
                );
            }
        }
    }

    fn assert_mixed_triangle_source(
        output: BridgeOutput<'_>,
        returning: bool,
        closed: bool,
        line_mask: u8,
    ) {
        let vertices = [point(0.0, 0.0), point(3.0, 0.0), point(0.0, 3.0)];
        let cubics = [
            [
                point(0.0, 0.0),
                point(1.0, 0.0),
                point(2.0, 0.0),
                point(3.0, 0.0),
            ],
            [
                point(3.0, 0.0),
                point(2.0, 1.0),
                point(1.0, 2.0),
                point(0.0, 3.0),
            ],
            [
                point(0.0, 3.0),
                point(0.0, 2.0),
                point(0.0, 1.0),
                point(0.0, 0.0),
            ],
        ];
        let segment_count = if returning { 3 } else { 2 };
        assert_eq!(output.sources.len(), segment_count);
        assert_eq!(
            output.commands.len(),
            1 + segment_count + usize::from(closed)
        );
        assert_eq!(output.commands[0].verb, VERB_MOVE);
        assert_eq!(output.commands[0].provenance.source_verb, 0);
        assert_eq!(output.commands[0].provenance.end_numerator, 1);
        assert_eq!(output.commands[0].provenance.depth, 0);
        let move_point = output.commands[0].point.unwrap();
        assert_eq!(move_point.x.to_bits(), 0.0f64.to_bits());
        assert_eq!(move_point.y.to_bits(), 0.0f64.to_bits());
        for index in 0..segment_count {
            let ordinal = u32::try_from(index + 1).unwrap();
            let start = vertices[index];
            let end = vertices[(index + 1) % vertices.len()];
            let command = output.commands[index + 1];
            assert_eq!(command.verb, crate::geometry::VERB_LINE);
            assert_eq!(command.provenance.source_verb, ordinal);
            assert_eq!(command.provenance.end_numerator, 1);
            assert_eq!(command.provenance.depth, 0);
            let command_end = command.point.unwrap();
            assert_eq!(command_end.x.to_bits(), end.x.to_bits());
            assert_eq!(command_end.y.to_bits(), end.y.to_bits());
            if line_mask & (1 << index) != 0 {
                let DecodedSource::Line {
                    points,
                    source_verb,
                    contour,
                } = output.sources[index]
                else {
                    panic!("expected LINE source")
                };
                assert_eq!(source_verb, ordinal);
                assert_eq!(contour, 0);
                for (actual, expected) in points.iter().zip([start, end]) {
                    assert_eq!(actual.x.to_bits(), expected.x.to_bits());
                    assert_eq!(actual.y.to_bits(), expected.y.to_bits());
                }
                assert_eq!(
                    output.owners[index],
                    EdgeOwner::Line {
                        source_verb: ordinal
                    }
                );
            } else {
                let DecodedSource::Cubic {
                    points,
                    source_verb,
                    contour,
                } = output.sources[index]
                else {
                    panic!("expected CUBIC source")
                };
                assert_eq!(source_verb, ordinal);
                assert_eq!(contour, 0);
                let expected = cubics[index];
                for (actual, expected) in points.iter().zip(expected) {
                    assert_eq!(actual.x.to_bits(), expected.x.to_bits());
                    assert_eq!(actual.y.to_bits(), expected.y.to_bits());
                }
                assert_eq!(
                    output.owners[index],
                    EdgeOwner::CubicLeaf {
                        source_verb: ordinal,
                        end_numerator: 1,
                        depth: 0,
                    }
                );
            }
        }
        if closed {
            let close = output.commands.last().unwrap();
            assert_eq!(close.verb, VERB_CLOSE);
            assert_eq!(
                close.provenance.source_verb,
                u32::try_from(segment_count + 1).unwrap()
            );
            assert_eq!(close.provenance.end_numerator, 1);
            assert_eq!(close.provenance.depth, 0);
            assert!(close.point.is_none());
        }
        if !returning {
            assert_eq!(
                output.owners[2],
                if closed {
                    EdgeOwner::ExplicitClose { source_verb: 3 }
                } else {
                    EdgeOwner::ImplicitClosure { contour: 0 }
                }
            );
        }
        assert_literal_triangle(output, 0.0);
        let triangle = output.rounded.indices;
        let a = output.rounded.vertices[usize::try_from(triangle[0]).unwrap()];
        let b = output.rounded.vertices[usize::try_from(triangle[1]).unwrap()];
        let c = output.rounded.vertices[usize::try_from(triangle[2]).unwrap()];
        let twice_area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        assert_eq!(twice_area.abs(), 9.0);
    }

    #[test]
    fn every_triangle_source_kind_mask_matches_the_all_cubic_mesh() {
        let mut attempts = 0usize;
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();
        for rule in [LineFillRule::Nonzero, LineFillRule::Evenodd] {
            for returning in [true, false] {
                for closed in [false, true] {
                    let mask_count = if returning { 8 } else { 4 };
                    let mut all_cubic = None;
                    for line_mask in 0..mask_count {
                        let path = raw_mixed_triangle(returning, closed, line_mask);
                        measured_raw_rule_attempt(
                            &mut workspace,
                            &path,
                            rule,
                            FLATTEN_TOLERANCE,
                            TOPOLOGY_TOLERANCE,
                            MAX_COMMANDS,
                        )
                        .unwrap();
                        let output = workspace.output().unwrap();
                        assert_mixed_triangle_source(output, returning, closed, line_mask);
                        let current = snapshot(output);
                        if let Some(expected) = &all_cubic {
                            assert_eq!(&current, expected);
                        } else {
                            all_cubic = Some(current);
                        }
                        attempts += 1;
                    }
                }
            }
        }
        assert_eq!(attempts, 48);
    }

    #[test]
    fn next_move_finalizes_open_forms_and_preserves_shifted_ordinals() {
        let mut returning_then_explicit = RawPath::default();
        append_triangle(&mut returning_then_explicit, 0.0, true, false);
        append_triangle(&mut returning_then_explicit, 9.0, false, true);
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();
        measured_raw_attempt(
            &mut workspace,
            &returning_then_explicit,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        let output = workspace.output().unwrap();
        assert_eq!(output.ranges.len(), 2);
        assert_eq!(
            output.owners[2],
            EdgeOwner::CubicLeaf {
                source_verb: 3,
                end_numerator: 1,
                depth: 0,
            }
        );
        assert_eq!(
            output.owners[5],
            EdgeOwner::ExplicitClose { source_verb: 7 }
        );
        assert_eq!(output.sources[3].source_verb(), 5);

        let mut implicit_then_returning = RawPath::default();
        append_triangle(&mut implicit_then_returning, 0.0, false, false);
        append_triangle(&mut implicit_then_returning, 9.0, true, true);
        measured_raw_attempt(
            &mut workspace,
            &implicit_then_returning,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        let output = workspace.output().unwrap();
        assert_eq!(output.owners[2], EdgeOwner::ImplicitClosure { contour: 0 });
        assert_eq!(
            output.owners[5],
            EdgeOwner::CubicLeaf {
                source_verb: 6,
                end_numerator: 1,
                depth: 0,
            }
        );
        assert_eq!(output.sources[2].source_verb(), 4);
    }

    #[test]
    fn mixed_next_move_ordinals_and_signed_zero_line_bits_are_exact() {
        let mut two = RawPath::default();
        append_mixed_triangle(&mut two, 0.0, true, false, 0b101);
        append_mixed_triangle(&mut two, 9.0, false, true, 0b010);
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();
        measured_raw_attempt(
            &mut workspace,
            &two,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        let output = workspace.output().unwrap();
        assert_eq!(output.ranges.len(), 2);
        assert_eq!(output.sources.len(), 5);
        assert_eq!(output.sources[0].source_verb(), 1);
        assert_eq!(output.sources[1].source_verb(), 2);
        assert_eq!(output.sources[2].source_verb(), 3);
        assert_eq!(output.sources[3].source_verb(), 5);
        assert_eq!(output.sources[4].source_verb(), 6);
        assert_eq!(output.owners[0], EdgeOwner::Line { source_verb: 1 });
        assert_eq!(output.owners[2], EdgeOwner::Line { source_verb: 3 });
        assert_eq!(output.owners[4], EdgeOwner::Line { source_verb: 6 });
        assert_eq!(
            output.owners[5],
            EdgeOwner::ExplicitClose { source_verb: 7 }
        );

        let mut signed = RawPath::default();
        signed.move_to(point(-0.0, 0.0));
        signed.line_to(point(3.0, 0.0));
        signed.cubic_to(point(2.0, 1.0), point(1.0, 2.0), point(0.0, 3.0));
        signed.line_to(point(0.0, -0.0));
        measured_raw_attempt(
            &mut workspace,
            &signed,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        let output = workspace.output().unwrap();
        assert_eq!(output.points[0].x.to_bits(), 1u64 << 63);
        let move_point = output.commands[0].point.unwrap();
        assert_eq!(move_point.x.to_bits(), 1u64 << 63);
        assert_eq!(move_point.y.to_bits(), 0);
        let DecodedSource::Line {
            points: first_line, ..
        } = output.sources[0]
        else {
            panic!("expected first LINE source")
        };
        assert_eq!(first_line[0].x.to_bits(), 1u64 << 63);
        assert_eq!(first_line[0].y.to_bits(), 0);
        let DecodedSource::Line { points, .. } = output.sources[2] else {
            panic!("expected final LINE source")
        };
        assert_eq!(points[1].x.to_bits(), 0);
        assert_eq!(points[1].y.to_bits(), 1u64 << 63);
        let final_line = output
            .commands
            .iter()
            .find(|command| command.provenance.source_verb == 3)
            .unwrap()
            .point
            .unwrap();
        assert_eq!(final_line.x.to_bits(), 0);
        assert_eq!(final_line.y.to_bits(), 1u64 << 63);
        assert_eq!(output.owners[2], EdgeOwner::Line { source_verb: 3 });
        signed.point_bytes.fill(0xff);
        drop(signed);
        let output = workspace.output().unwrap();
        let DecodedSource::Line { points, .. } = output.sources[2] else {
            panic!("expected retained final LINE source")
        };
        assert_eq!(points[1].x.to_bits(), 0);
        assert_eq!(points[1].y.to_bits(), 1u64 << 63);
    }

    #[test]
    fn mixed_sixteen_segment_limit_and_geometry_are_exact() {
        let mixed = mixed_sixteen_square(false, false);
        let all_cubic = mixed_sixteen_square(true, false);
        let seventeenth = mixed_sixteen_square(false, true);
        assert!(seventeenth.verbs.len() <= 24);
        assert!(seventeenth.point_count() <= 104);
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();

        for rule in [LineFillRule::Nonzero, LineFillRule::Evenodd] {
            measured_raw_rule_attempt(
                &mut workspace,
                &all_cubic,
                rule,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            )
            .unwrap();
            let cubic_snapshot = snapshot(workspace.output().unwrap());
            measured_raw_rule_attempt(
                &mut workspace,
                &mixed,
                rule,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            )
            .unwrap();
            let output = workspace.output().unwrap();
            assert_eq!(output.commands.len(), 18);
            assert_eq!(output.sources.len(), 16);
            assert_eq!(output.points.len(), 16);
            assert_eq!(output.owners.len(), 16);
            for index in 0..16 {
                let ordinal = u32::try_from(index + 1).unwrap();
                if index % 2 == 0 {
                    assert!(matches!(output.sources[index], DecodedSource::Line { .. }));
                    assert_eq!(
                        output.owners[index],
                        EdgeOwner::Line {
                            source_verb: ordinal
                        }
                    );
                } else {
                    assert!(matches!(output.sources[index], DecodedSource::Cubic { .. }));
                    assert_eq!(
                        output.owners[index],
                        EdgeOwner::CubicLeaf {
                            source_verb: ordinal,
                            end_numerator: 1,
                            depth: 0,
                        }
                    );
                }
            }
            let mut twice_area = 0.0;
            for index in 0..output.points.len() {
                let a = output.points[index];
                let b = output.points[(index + 1) % output.points.len()];
                twice_area += a.x * b.y - a.y * b.x;
            }
            assert_eq!(twice_area.abs(), 288.0);
            assert_eq!(snapshot(output), cubic_snapshot);

            assert_eq!(
                measured_raw_rule_attempt(
                    &mut workspace,
                    &seventeenth,
                    rule,
                    FLATTEN_TOLERANCE,
                    TOPOLOGY_TOLERANCE,
                    MAX_COMMANDS,
                ),
                Err(BridgeError::SourceLimit)
            );
            let diagnostics = workspace.diagnostics();
            assert!(diagnostics.sizing_invoked);
            assert!(!diagnostics.emission_invoked);
            assert!(!diagnostics.topology_invoked);
            assert!(!diagnostics.rounded_invoked);
            assert!(workspace.output().is_none());
            measured_raw_rule_attempt(
                &mut workspace,
                &mixed,
                rule,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            )
            .unwrap();
            assert!(workspace.output().is_some());
        }
    }

    #[test]
    fn line_two_edge_forms_publish_empty_and_zero_line_triangle_normalizes() {
        let success = raw_mixed_triangle(true, true, 0b111);
        let mut one_line_close = RawPath::default();
        one_line_close.move_to(point(0.0, 0.0));
        one_line_close.line_to(point(3.0, 0.0));
        one_line_close.close();
        let mut two_line_open = RawPath::default();
        two_line_open.move_to(point(0.0, 0.0));
        two_line_open.line_to(point(3.0, 0.0));
        two_line_open.line_to(point(0.0, 0.0));
        let mut zero_line = RawPath::default();
        zero_line.move_to(point(0.0, 0.0));
        zero_line.line_to(point(0.0, 0.0));
        zero_line.line_to(point(3.0, 0.0));
        zero_line.line_to(point(0.0, 3.0));
        zero_line.line_to(point(0.0, 0.0));
        zero_line.close();
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();

        for degenerate in [&one_line_close, &two_line_open] {
            measured_raw_attempt(
                &mut workspace,
                &success,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            )
            .unwrap();
            let diagnostics = measured_raw_attempt(
                &mut workspace,
                degenerate,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            )
            .unwrap();
            assert!(diagnostics.emission_invoked);
            assert!(!diagnostics.topology_invoked);
            assert!(diagnostics.rounded_invoked);
            let output = workspace.output().unwrap();
            assert!(output.rounded.vertices.is_empty());
            assert!(output.rounded.indices.is_empty());
            assert_eq!(output.points.len(), 2);
            assert_eq!(output.owners.len(), 2);
            measured_raw_attempt(
                &mut workspace,
                &success,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            )
            .unwrap();
        }

        let diagnostics = measured_raw_attempt(
            &mut workspace,
            &zero_line,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert!(diagnostics.emission_invoked);
        assert!(!diagnostics.topology_invoked);
        assert!(diagnostics.rounded_invoked);
        let output = workspace.output().unwrap();
        assert_eq!(output.sources.len(), 4);
        assert_eq!(output.points.len(), 3);
        assert_eq!(output.owners.len(), 3);
        measured_raw_attempt(
            &mut workspace,
            &success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert!(workspace.output().is_some());
    }

    #[test]
    fn signed_zero_returning_endpoint_is_geometrically_equal_but_bit_exact_in_sources() {
        let mut path = RawPath::default();
        path.move_to(point(-0.0, 0.0));
        path.cubic_to(point(1.0, 0.0), point(2.0, 0.0), point(3.0, 0.0));
        path.cubic_to(point(2.0, 1.0), point(1.0, 2.0), point(0.0, 3.0));
        path.cubic_to(point(0.0, 2.0), point(0.0, 1.0), point(0.0, -0.0));
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();
        measured_raw_attempt(
            &mut workspace,
            &path,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        let output = workspace.output().unwrap();
        assert_eq!(output.points.len(), 3);
        assert_eq!(output.points[0].x.to_bits(), 1u64 << 63);
        let DecodedSource::Cubic { points: first, .. } = output.sources[0] else {
            panic!("expected cubic source")
        };
        let DecodedSource::Cubic { points: last, .. } = output.sources[2] else {
            panic!("expected cubic source")
        };
        assert_eq!(first[0].x.to_bits(), 1u64 << 63);
        assert_eq!(last[3].y.to_bits(), 1u64 << 63);
        assert_eq!(output.owners.len(), 3);
    }

    #[test]
    fn legacy_two_edge_forms_reach_topology_and_recover_atomically() {
        let success = raw_triangle(true, true);
        let mut nonreturning_close = RawPath::default();
        nonreturning_close.move_to(point(0.0, 0.0));
        append_linear(&mut nonreturning_close, point(0.0, 0.0), point(3.0, 0.0));
        nonreturning_close.close();
        let mut returning_open = RawPath::default();
        returning_open.move_to(point(0.0, 0.0));
        append_linear(&mut returning_open, point(0.0, 0.0), point(3.0, 0.0));
        append_linear(&mut returning_open, point(3.0, 0.0), point(0.0, 0.0));
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();

        for failure in [&nonreturning_close, &returning_open] {
            measured_raw_attempt(
                &mut workspace,
                &success,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            )
            .unwrap();
            assert!(workspace.output().is_some());
            assert_eq!(
                measured_raw_attempt(
                    &mut workspace,
                    failure,
                    FLATTEN_TOLERANCE,
                    TOPOLOGY_TOLERANCE,
                    MAX_COMMANDS,
                ),
                Err(BridgeError::Topology(TopologyError::Unresolved))
            );
            let diagnostics = workspace.diagnostics();
            assert!(diagnostics.sizing_invoked);
            assert!(diagnostics.emission_invoked);
            assert!(diagnostics.topology_invoked);
            assert!(!diagnostics.rounded_invoked);
            assert!(workspace.output().is_none());
            measured_raw_attempt(
                &mut workspace,
                &success,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            )
            .unwrap();
            assert!(workspace.output().is_some());
        }
    }

    #[test]
    fn malformed_close_and_zero_length_leaf_fail_without_stale_output() {
        let success = raw_triangle(true, true);
        let invalid_close = RawPath {
            verbs: vec![VERB_CLOSE],
            point_bytes: Vec::new(),
        };
        let mut repeated_close = success.clone();
        repeated_close.close();
        let mut zero_leaf = RawPath::default();
        zero_leaf.move_to(point(0.0, 0.0));
        zero_leaf.cubic_to(point(0.0, 0.0), point(0.0, 0.0), point(0.0, 0.0));
        zero_leaf.cubic_to(point(1.0, 0.0), point(2.0, 0.0), point(3.0, 0.0));
        zero_leaf.cubic_to(point(2.0, 1.0), point(1.0, 2.0), point(0.0, 3.0));
        zero_leaf.cubic_to(point(0.0, 2.0), point(0.0, 1.0), point(0.0, 0.0));
        zero_leaf.close();
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();

        for malformed in [&invalid_close, &repeated_close] {
            measured_raw_attempt(
                &mut workspace,
                &success,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            )
            .unwrap();
            let diagnostics = measured_raw_attempt(
                &mut workspace,
                malformed,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            )
            .unwrap();
            assert_eq!(diagnostics.flat_status, PATH_INVALID);
            assert!(!diagnostics.emission_invoked);
            assert!(!diagnostics.topology_invoked);
            assert!(!diagnostics.rounded_invoked);
            assert!(workspace.output().is_none());
            measured_raw_attempt(
                &mut workspace,
                &success,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            )
            .unwrap();
            assert!(workspace.output().is_some());
        }

        assert_eq!(
            measured_raw_attempt(
                &mut workspace,
                &zero_leaf,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            ),
            Err(BridgeError::ZeroLengthLeaf)
        );
        let diagnostics = workspace.diagnostics();
        assert!(diagnostics.sizing_invoked);
        assert!(diagnostics.emission_invoked);
        assert!(!diagnostics.topology_invoked);
        assert!(!diagnostics.rounded_invoked);
        assert!(workspace.output().is_none());
        measured_raw_attempt(
            &mut workspace,
            &success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert!(workspace.output().is_some());
    }

    #[test]
    fn source_and_command_failures_recover_without_dependent_work() {
        let success = raw_square();
        let source_limit = RawPath {
            verbs: vec![VERB_MOVE; 25],
            point_bytes: vec![0; 50 * 8],
        };
        let scalar_limit = RawPath {
            verbs: Vec::new(),
            point_bytes: vec![0; 105 * 8],
        };
        let mut unsupported = RawPath::default();
        unsupported.move_to(point(0.0, 0.0));
        unsupported.move_to(point(3.0, 0.0));
        append_linear(&mut unsupported, point(3.0, 0.0), point(6.0, 0.0));
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();

        measured_raw_attempt(
            &mut workspace,
            &success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert!(workspace.output().is_some());
        let topology_before = workspace.topology_stats();
        let rounded_before = workspace.rounded_stats();
        assert_eq!(
            measured_raw_attempt(
                &mut workspace,
                &source_limit,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            ),
            Err(BridgeError::SourceLimit)
        );
        assert!(workspace.output().is_none());
        assert_eq!(workspace.diagnostics(), AttemptDiagnostics::default());
        assert_eq!(workspace.topology_stats(), topology_before);
        assert_eq!(workspace.rounded_stats(), rounded_before);
        measured_raw_attempt(
            &mut workspace,
            &success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert!(workspace.output().is_some());

        assert_eq!(
            measured_raw_attempt(
                &mut workspace,
                &scalar_limit,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            ),
            Err(BridgeError::SourceLimit)
        );
        assert!(workspace.output().is_none());
        assert_eq!(workspace.diagnostics(), AttemptDiagnostics::default());
        assert_eq!(workspace.topology_stats(), topology_before);
        assert_eq!(workspace.rounded_stats(), rounded_before);
        measured_raw_attempt(
            &mut workspace,
            &success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert!(workspace.output().is_some());

        assert_eq!(
            measured_raw_attempt(
                &mut workspace,
                &unsupported,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            ),
            Err(BridgeError::UnsupportedSource)
        );
        assert!(workspace.output().is_none());
        assert!(workspace.diagnostics().sizing_invoked);
        assert!(!workspace.diagnostics().emission_invoked);
        assert_eq!(workspace.topology_stats(), topology_before);
        assert_eq!(workspace.rounded_stats(), rounded_before);
        measured_raw_attempt(
            &mut workspace,
            &success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();

        assert_eq!(
            measured_raw_attempt(
                &mut workspace,
                &success,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                1,
            ),
            Err(BridgeError::CommandLimit)
        );
        assert!(workspace.output().is_none());
        assert!(workspace.diagnostics().emission_invoked);
        assert!(!workspace.diagnostics().topology_invoked);
        assert!(!workspace.diagnostics().rounded_invoked);
        assert_eq!(workspace.topology_stats(), topology_before);
        assert_eq!(workspace.rounded_stats(), rounded_before);
        measured_raw_attempt(
            &mut workspace,
            &success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert!(workspace.output().is_some());
    }

    #[test]
    fn signed_zero_close_owned_sources_and_workspace_isolation() {
        let mut signed = RawPath::default();
        signed.move_to(point(-0.0, 0.0));
        append_linear(&mut signed, point(-0.0, 0.0), point(3.0, 0.0));
        append_linear(&mut signed, point(3.0, 0.0), point(0.0, 3.0));
        append_linear(&mut signed, point(0.0, 3.0), point(0.0, -0.0));
        signed.close();

        let mut first = BridgeWorkspace::new(LIMITS).unwrap();
        let mut second = BridgeWorkspace::new(LIMITS).unwrap();
        measured_raw_attempt(
            &mut first,
            &signed,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        measured_raw_attempt(
            &mut second,
            &signed,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert_eq!(
            cubic_points(first.output().unwrap().sources[0])[0]
                .x
                .to_bits(),
            1u64 << 63
        );
        assert_eq!(
            cubic_points(first.output().unwrap().sources[2])[3]
                .y
                .to_bits(),
            1u64 << 63
        );

        signed.point_bytes.fill(0xff);
        assert_eq!(
            cubic_points(first.output().unwrap().sources[0])[0]
                .x
                .to_bits(),
            1u64 << 63
        );
        drop(signed);
        assert_eq!(
            cubic_points(first.output().unwrap().sources[0])[0]
                .x
                .to_bits(),
            1u64 << 63
        );
        assert!(second.output().is_some());

        let too_many = RawPath {
            verbs: vec![VERB_MOVE; 25],
            point_bytes: vec![0; 50 * 8],
        };
        assert_eq!(
            measured_raw_attempt(
                &mut first,
                &too_many,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            ),
            Err(BridgeError::SourceLimit)
        );
        assert!(first.output().is_none());
        assert!(second.output().is_some());
    }

    #[test]
    fn attempt_is_allocation_free_and_owns_every_edge() {
        let row = square_row(1.0);
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();
        assert!(workspace.allocated_bytes() <= MAX_BRIDGE_HEAP_BYTES);
        let diagnostics =
            measured_attempt(&mut workspace, &row, TOPOLOGY_TOLERANCE, MAX_COMMANDS).unwrap();
        assert_eq!(diagnostics.flat_status, PATH_OK);
        let output = workspace.output().unwrap();
        assert_eq!(output.owners.len(), output.rounded.source_edges.len());
        assert!(output
            .rounded
            .contributors
            .iter()
            .all(|owner| *owner < output.owners.len()));
    }

    #[test]
    fn native_topology_guard_precedes_rounding_and_recovers() {
        let success = square_row(1.0);
        let bowtie = bowtie_row();
        let numeric = square_row(2.0f64.powi(1021));
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();
        measured_attempt(&mut workspace, &success, TOPOLOGY_TOLERANCE, MAX_COMMANDS).unwrap();
        assert!(workspace.output().is_some());
        let rounded_before = workspace.rounded_stats();

        // A zero rounded tolerance would fail if the topology guard were bypassed.
        assert_eq!(
            measured_attempt(&mut workspace, &bowtie, 0.0, MAX_COMMANDS),
            Err(BridgeError::Topology(TopologyError::Unresolved))
        );
        assert!(workspace.output().is_none());
        assert!(workspace.topology_stats().pairs > 0);
        assert_eq!(workspace.rounded_stats(), rounded_before);
        assert!(workspace.diagnostics().topology_invoked);
        assert!(!workspace.diagnostics().rounded_invoked);
        measured_attempt(&mut workspace, &success, TOPOLOGY_TOLERANCE, MAX_COMMANDS).unwrap();
        assert!(workspace.output().is_some());

        // Sizing failure returns before either dependent stage is invoked.
        let topology_before = workspace.topology_stats();
        let rounded_before = workspace.rounded_stats();
        let failure = measured_attempt(&mut workspace, &numeric, 0.0, MAX_COMMANDS).unwrap();
        assert_eq!(failure.flat_status, PATH_NUMERIC_RANGE);
        assert!(failure.emission_plan.is_none());
        assert!(workspace.output().is_none());
        assert_eq!(workspace.topology_stats(), topology_before);
        assert_eq!(workspace.rounded_stats(), rounded_before);
        assert!(!workspace.diagnostics().topology_invoked);
        assert!(!workspace.diagnostics().rounded_invoked);
        measured_attempt(&mut workspace, &success, TOPOLOGY_TOLERANCE, MAX_COMMANDS).unwrap();
        assert!(workspace.output().is_some());
    }

    #[test]
    fn success_failure_success_sequences_publish_atomically() {
        let success = square_row(1.0);
        let numeric = square_row(2.0f64.powi(1021));
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();
        assert!(
            measured_attempt(&mut workspace, &success, TOPOLOGY_TOLERANCE, MAX_COMMANDS)
                .unwrap()
                .emission_plan
                .is_some()
        );
        assert!(workspace.output().is_some());
        let failure =
            measured_attempt(&mut workspace, &numeric, TOPOLOGY_TOLERANCE, MAX_COMMANDS).unwrap();
        assert_eq!(failure.flat_status, PATH_NUMERIC_RANGE);
        assert!(failure.emission_plan.is_none());
        assert!(workspace.output().is_none());
        assert!(
            measured_attempt(&mut workspace, &success, TOPOLOGY_TOLERANCE, MAX_COMMANDS)
                .unwrap()
                .emission_plan
                .is_some()
        );
        assert!(workspace.output().is_some());

        assert_eq!(
            measured_attempt(&mut workspace, &success, 0.0, MAX_COMMANDS),
            Err(BridgeError::Rounded(RoundedFillError::InvalidTolerance))
        );
        assert!(workspace.output().is_none());
        assert!(
            measured_attempt(&mut workspace, &success, TOPOLOGY_TOLERANCE, MAX_COMMANDS).is_ok()
        );
        assert!(workspace.output().is_some());
    }

    #[test]
    fn bounded_command_work_and_output_failures_publish_nothing() {
        let row = square_row(1.0);
        let mut command_workspace = BridgeWorkspace::new(LIMITS).unwrap();
        assert_eq!(
            measured_attempt(&mut command_workspace, &row, TOPOLOGY_TOLERANCE, 1),
            Err(BridgeError::CommandLimit)
        );
        assert!(command_workspace.output().is_none());

        let mut work_workspace = BridgeWorkspace::new(RoundedFillLimits {
            max_work: 0,
            ..LIMITS
        })
        .unwrap();
        assert_eq!(
            measured_attempt(&mut work_workspace, &row, TOPOLOGY_TOLERANCE, MAX_COMMANDS,),
            Err(BridgeError::Rounded(RoundedFillError::WorkLimit))
        );
        assert!(work_workspace.output().is_none());

        let mut output_workspace = BridgeWorkspace::new(RoundedFillLimits {
            max_vertices: 0,
            ..LIMITS
        })
        .unwrap();
        assert_eq!(
            measured_attempt(
                &mut output_workspace,
                &row,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            ),
            Err(BridgeError::Rounded(RoundedFillError::OutputLimit))
        );
        assert!(output_workspace.output().is_none());
    }

    #[derive(Debug)]
    struct LineIdentityFixture {
        id: &'static str,
        contours: Vec<Vec<Point>>,
        areas: [f64; 2],
    }

    fn bridge_carrier_snapshot(output: BridgeOutput<'_>) -> RoundedCarrierSnapshot {
        rounded_carrier_snapshot(output.rounded, output.rounded_stats)
    }

    fn line_identity_fixtures() -> Vec<LineIdentityFixture> {
        let outer = vec![
            point(0.0, 0.0),
            point(10.0, 0.0),
            point(10.0, 10.0),
            point(0.0, 10.0),
        ];
        let inner = vec![
            point(3.0, 3.0),
            point(7.0, 3.0),
            point(7.0, 7.0),
            point(3.0, 7.0),
        ];
        let reversed_inner = vec![
            point(3.0, 7.0),
            point(7.0, 7.0),
            point(7.0, 3.0),
            point(3.0, 3.0),
        ];
        let reversed_outer = vec![
            point(0.0, 10.0),
            point(10.0, 10.0),
            point(10.0, 0.0),
            point(0.0, 0.0),
        ];
        let square_a = vec![
            point(0.0, 0.0),
            point(4.0, 0.0),
            point(4.0, 4.0),
            point(0.0, 4.0),
        ];
        let reversed_square_a = vec![
            point(0.0, 4.0),
            point(4.0, 4.0),
            point(4.0, 0.0),
            point(0.0, 0.0),
        ];
        let overlap_b = vec![
            point(2.0, 0.0),
            point(6.0, 0.0),
            point(6.0, 4.0),
            point(2.0, 4.0),
        ];
        let reversed_overlap_b = vec![
            point(2.0, 4.0),
            point(6.0, 4.0),
            point(6.0, 0.0),
            point(2.0, 0.0),
        ];
        let shared_b = vec![
            point(2.0, 4.0),
            point(6.0, 4.0),
            point(6.0, 8.0),
            point(2.0, 8.0),
        ];
        let bowtie = vec![
            point(0.0, 0.0),
            point(4.0, 4.0),
            point(0.0, 4.0),
            point(4.0, 0.0),
        ];
        let reversed_bowtie = vec![
            point(4.0, 0.0),
            point(0.0, 4.0),
            point(4.0, 4.0),
            point(0.0, 0.0),
        ];
        vec![
            LineIdentityFixture {
                id: "F01",
                contours: vec![outer.clone()],
                areas: [100.0, 100.0],
            },
            LineIdentityFixture {
                id: "F02",
                contours: vec![outer.clone(), inner.clone()],
                areas: [100.0, 84.0],
            },
            LineIdentityFixture {
                id: "F03",
                contours: vec![outer.clone(), reversed_inner],
                areas: [84.0, 84.0],
            },
            LineIdentityFixture {
                id: "F04",
                contours: vec![outer.clone(), outer.clone()],
                areas: [100.0, 0.0],
            },
            LineIdentityFixture {
                id: "F05",
                contours: vec![outer.clone(), reversed_outer.clone()],
                areas: [0.0, 0.0],
            },
            LineIdentityFixture {
                id: "F06",
                contours: vec![bowtie.clone()],
                areas: [8.0, 8.0],
            },
            LineIdentityFixture {
                id: "F07",
                contours: vec![
                    vec![
                        point(0.0, 0.0),
                        point(2.0, 0.0),
                        point(2.0, 2.0),
                        point(0.0, 2.0),
                    ],
                    vec![
                        point(2.0, 0.0),
                        point(4.0, 0.0),
                        point(4.0, 2.0),
                        point(2.0, 2.0),
                    ],
                ],
                areas: [8.0, 8.0],
            },
            LineIdentityFixture {
                id: "F08",
                contours: vec![vec![point(0.0, 0.0), point(8.0, 0.0), point(0.0, 8.0)]],
                areas: [32.0, 32.0],
            },
            LineIdentityFixture {
                id: "F09-permuted",
                contours: vec![inner, outer.clone()],
                areas: [100.0, 84.0],
            },
            LineIdentityFixture {
                id: "F10",
                contours: vec![square_a.clone(), overlap_b.clone()],
                areas: [24.0, 16.0],
            },
            LineIdentityFixture {
                id: "F10-reversed",
                contours: vec![square_a.clone(), reversed_overlap_b.clone()],
                areas: [16.0, 16.0],
            },
            LineIdentityFixture {
                id: "F11",
                contours: vec![square_a, shared_b],
                areas: [32.0, 32.0],
            },
            LineIdentityFixture {
                id: "F03-global-reversed",
                contours: vec![
                    reversed_outer,
                    vec![
                        point(3.0, 3.0),
                        point(7.0, 3.0),
                        point(7.0, 7.0),
                        point(3.0, 7.0),
                    ],
                ],
                areas: [84.0, 84.0],
            },
            LineIdentityFixture {
                id: "F06-global-reversed",
                contours: vec![reversed_bowtie],
                areas: [8.0, 8.0],
            },
            LineIdentityFixture {
                id: "F10-global-reversed",
                contours: vec![reversed_square_a, reversed_overlap_b],
                areas: [24.0, 16.0],
            },
        ]
    }

    fn line_path(contours: &[Vec<Point>], returning: bool, closed: bool) -> RawPath {
        let mut path = RawPath::default();
        for contour in contours {
            path.move_to(contour[0]);
            for endpoint in &contour[1..] {
                path.line_to(*endpoint);
            }
            if returning {
                path.line_to(contour[0]);
            }
            if closed {
                path.close();
            }
        }
        path
    }

    fn assert_line_identity_source(
        path: &RawPath,
        contours: &[Vec<Point>],
        returning: bool,
        closed: bool,
        output: BridgeOutput<'_>,
    ) {
        assert_eq!(output.commands.len(), path.verbs.len());
        assert_eq!(output.ranges.len(), contours.len());
        let mut ordinal = 0u32;
        let mut command_index = 0usize;
        let mut source_index = 0usize;
        let mut point_index = 0usize;
        let mut expected_owners = Vec::new();
        for (contour_index, contour) in contours.iter().enumerate() {
            let move_command = output.commands[command_index];
            assert_eq!(move_command.verb, VERB_MOVE);
            assert_eq!(move_command.provenance.source_verb, ordinal);
            assert_eq!(move_command.provenance.end_numerator, 1);
            assert_eq!(move_command.provenance.depth, 0);
            let actual_move = move_command.point.unwrap();
            assert_eq!(actual_move.x.to_bits(), contour[0].x.to_bits());
            assert_eq!(actual_move.y.to_bits(), contour[0].y.to_bits());
            ordinal += 1;
            command_index += 1;

            let endpoint_count = contour.len() - 1 + usize::from(returning);
            let mut start = contour[0];
            for endpoint_index in 0..endpoint_count {
                let end = if endpoint_index + 1 < contour.len() {
                    contour[endpoint_index + 1]
                } else {
                    contour[0]
                };
                let command = output.commands[command_index];
                assert_eq!(command.verb, crate::geometry::VERB_LINE);
                assert_eq!(command.provenance.source_verb, ordinal);
                assert_eq!(command.provenance.end_numerator, 1);
                assert_eq!(command.provenance.depth, 0);
                let actual_end = command.point.unwrap();
                assert_eq!(actual_end.x.to_bits(), end.x.to_bits());
                assert_eq!(actual_end.y.to_bits(), end.y.to_bits());
                let DecodedSource::Line {
                    points,
                    source_verb,
                    contour: source_contour,
                } = output.sources[source_index]
                else {
                    panic!("expected LINE source")
                };
                assert_eq!(source_verb, ordinal);
                assert_eq!(source_contour, contour_index);
                assert_eq!(points[0].x.to_bits(), start.x.to_bits());
                assert_eq!(points[0].y.to_bits(), start.y.to_bits());
                assert_eq!(points[1].x.to_bits(), end.x.to_bits());
                assert_eq!(points[1].y.to_bits(), end.y.to_bits());
                expected_owners.push(EdgeOwner::Line {
                    source_verb: ordinal,
                });
                start = end;
                ordinal += 1;
                command_index += 1;
                source_index += 1;
            }
            if closed {
                let close = output.commands[command_index];
                assert_eq!(close.verb, VERB_CLOSE);
                assert_eq!(close.provenance.source_verb, ordinal);
                assert_eq!(close.provenance.end_numerator, 1);
                assert_eq!(close.provenance.depth, 0);
                assert!(close.point.is_none());
                if !returning {
                    expected_owners.push(EdgeOwner::ExplicitClose {
                        source_verb: ordinal,
                    });
                }
                ordinal += 1;
                command_index += 1;
            } else if !returning {
                expected_owners.push(EdgeOwner::ImplicitClosure {
                    contour: contour_index,
                });
            }

            let range = output.ranges[contour_index];
            assert_eq!(range.start, point_index);
            assert_eq!(range.count, contour.len());
            for expected in contour {
                let actual = output.points[point_index];
                assert_eq!(actual.x.to_bits(), expected.x.to_bits());
                assert_eq!(actual.y.to_bits(), expected.y.to_bits());
                point_index += 1;
            }
        }
        assert_eq!(command_index, output.commands.len());
        assert_eq!(source_index, output.sources.len());
        assert_eq!(point_index, output.points.len());
        assert_eq!(expected_owners, output.owners);
    }

    fn mesh_area(output: RoundedFillOutput<'_>) -> f64 {
        assert_eq!(output.indices.len() % 3, 0);
        output
            .indices
            .chunks_exact(3)
            .map(|triangle| {
                let a = output.vertices[usize::try_from(triangle[0]).unwrap()];
                let b = output.vertices[usize::try_from(triangle[1]).unwrap()];
                let c = output.vertices[usize::try_from(triangle[2]).unwrap()];
                ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)).abs() / 2.0
            })
            .sum()
    }

    fn assert_direct_rounded_identity(
        direct: &mut RoundedFillWorkspace,
        contours: &[Vec<Point>],
        rule: LineFillRule,
        bridge: BridgeOutput<'_>,
    ) {
        let references: Vec<&[Point]> = contours.iter().map(|contour| contour.as_slice()).collect();
        direct
            .tessellate(&references, rule, TOPOLOGY_TOLERANCE)
            .unwrap();
        let direct_snapshot = rounded_carrier_snapshot(direct.output().unwrap(), direct.stats());
        assert_eq!(bridge_carrier_snapshot(bridge), direct_snapshot);
    }

    #[derive(Clone, Copy, Debug)]
    enum DegenerateLineEncoding {
        Move,
        Zero,
        Retrace { returning: bool },
    }

    fn append_degenerate_line(path: &mut RawPath, encoding: DegenerateLineEncoding, closed: bool) {
        let start = point(20.0, 0.0);
        path.move_to(start);
        match encoding {
            DegenerateLineEncoding::Move => {}
            DegenerateLineEncoding::Zero => path.line_to(start),
            DegenerateLineEncoding::Retrace { returning } => {
                path.line_to(point(23.0, 0.0));
                if returning {
                    path.line_to(start);
                }
            }
        }
        if closed {
            path.close();
        }
    }

    fn degenerate_line_contour(encoding: DegenerateLineEncoding) -> Vec<Point> {
        match encoding {
            DegenerateLineEncoding::Move | DegenerateLineEncoding::Zero => {
                vec![point(20.0, 0.0)]
            }
            DegenerateLineEncoding::Retrace { .. } => {
                vec![point(20.0, 0.0), point(23.0, 0.0)]
            }
        }
    }

    fn append_open_line_contour(path: &mut RawPath, contour: &[Point]) {
        path.move_to(contour[0]);
        for endpoint in &contour[1..] {
            path.line_to(*endpoint);
        }
    }

    fn assert_empty_rounded_mesh(output: RoundedFillOutput<'_>) {
        assert!(output.vertices.is_empty());
        assert!(output.indices.is_empty());
        assert_eq!(output.bounds.min_x.to_bits(), 0);
        assert_eq!(output.bounds.min_y.to_bits(), 0);
        assert_eq!(output.bounds.max_x.to_bits(), 0);
        assert_eq!(output.bounds.max_y.to_bits(), 0);
        assert_eq!(output.error_bound.to_bits(), 0);
    }

    fn assert_normalized_contours(output: BridgeOutput<'_>, contours: &[Vec<Point>]) {
        assert_eq!(output.ranges.len(), contours.len());
        let mut point_index = 0usize;
        for (range, contour) in output.ranges.iter().zip(contours) {
            assert_eq!(range.start, point_index);
            assert_eq!(range.count, contour.len());
            for expected in contour {
                assert_point_bits(output.points[point_index], *expected);
                point_index += 1;
            }
        }
        assert_eq!(point_index, output.points.len());
    }

    #[test]
    fn all_line_degenerates_match_direct_rounded_standalone() {
        let mut bridge = BridgeWorkspace::new(LIMITS).unwrap();
        let mut direct = RoundedFillWorkspace::new(LIMITS).unwrap();
        let mut attempts = 0usize;
        for encoding in [
            DegenerateLineEncoding::Move,
            DegenerateLineEncoding::Zero,
            DegenerateLineEncoding::Retrace { returning: false },
            DegenerateLineEncoding::Retrace { returning: true },
        ] {
            for closed in [false, true] {
                let mut path = RawPath::default();
                append_degenerate_line(&mut path, encoding, closed);
                let contour = degenerate_line_contour(encoding);
                let contours = vec![contour.clone()];
                for rule in [LineFillRule::Nonzero, LineFillRule::Evenodd] {
                    let diagnostics = measured_raw_rule_attempt(
                        &mut bridge,
                        &path,
                        rule,
                        FLATTEN_TOLERANCE,
                        TOPOLOGY_TOLERANCE,
                        MAX_COMMANDS,
                    )
                    .unwrap();
                    assert_eq!(diagnostics.flat_status, PATH_OK);
                    assert!(diagnostics.emission_invoked);
                    assert!(!diagnostics.topology_invoked);
                    assert!(!diagnostics.rounded_topology_invoked);
                    assert!(!diagnostics.rounded_topology_selected);
                    assert_eq!(diagnostics.rounded_topology_error, None);
                    assert!(diagnostics.rounded_invoked);
                    let output = bridge.output().unwrap();
                    assert_normalized_contours(output, &contours);
                    let expected_edges = if contour.len() >= 2 { contour.len() } else { 0 };
                    assert_eq!(output.owners.len(), expected_edges);
                    assert_eq!(output.rounded.source_edges.len(), expected_edges);
                    assert_depth_zero_original_identity(&path, output);
                    assert_empty_rounded_mesh(output.rounded);
                    assert_direct_rounded_identity(&mut direct, &contours, rule, output);
                    attempts += 1;
                }
            }
        }
        assert_eq!(attempts, 16);
    }

    #[test]
    fn all_line_degenerates_preserve_f02_composition_order_and_carrier() {
        let f02 = line_identity_fixtures()
            .into_iter()
            .find(|fixture| fixture.id == "F02")
            .unwrap();
        let mut bridge = BridgeWorkspace::new(LIMITS).unwrap();
        let mut direct = RoundedFillWorkspace::new(LIMITS).unwrap();
        let mut attempts = 0usize;
        for encoding in [
            DegenerateLineEncoding::Move,
            DegenerateLineEncoding::Zero,
            DegenerateLineEncoding::Retrace { returning: false },
            DegenerateLineEncoding::Retrace { returning: true },
        ] {
            for closed in [false, true] {
                for degenerate_index in 0..3 {
                    let mut path = RawPath::default();
                    let mut contours = Vec::new();
                    let mut ordinary_index = 0usize;
                    for contour_index in 0..3 {
                        if contour_index == degenerate_index {
                            append_degenerate_line(&mut path, encoding, closed);
                            contours.push(degenerate_line_contour(encoding));
                        } else {
                            let contour = &f02.contours[ordinary_index];
                            append_open_line_contour(&mut path, contour);
                            contours.push(contour.clone());
                            ordinary_index += 1;
                        }
                    }
                    for (rule_index, rule) in [LineFillRule::Nonzero, LineFillRule::Evenodd]
                        .into_iter()
                        .enumerate()
                    {
                        let diagnostics = measured_raw_rule_attempt(
                            &mut bridge,
                            &path,
                            rule,
                            FLATTEN_TOLERANCE,
                            TOPOLOGY_TOLERANCE,
                            MAX_COMMANDS,
                        )
                        .unwrap();
                        assert!(!diagnostics.topology_invoked);
                        assert!(!diagnostics.rounded_topology_invoked);
                        assert!(diagnostics.rounded_invoked);
                        let output = bridge.output().unwrap();
                        assert_normalized_contours(output, &contours);
                        let degenerate_edges = if contours[degenerate_index].len() >= 2 {
                            contours[degenerate_index].len()
                        } else {
                            0
                        };
                        assert_eq!(output.owners.len(), 8 + degenerate_edges);
                        assert_eq!(mesh_area(output.rounded), f02.areas[rule_index]);
                        assert_depth_zero_original_identity(&path, output);
                        assert_direct_rounded_identity(&mut direct, &contours, rule, output);
                        attempts += 1;
                    }
                }
            }
        }
        assert_eq!(attempts, 48);
    }

    #[test]
    fn all_line_degenerate_signed_zero_and_source_caps_are_exact() {
        let mut bridge = BridgeWorkspace::new(LIMITS).unwrap();
        let mut direct = RoundedFillWorkspace::new(LIMITS).unwrap();
        for closed in [false, true] {
            let mut signed = RawPath::default();
            signed.move_to(point(-0.0, 0.0));
            signed.line_to(point(0.0, -0.0));
            if closed {
                signed.close();
            }
            let contours = vec![vec![point(-0.0, 0.0)]];
            for rule in [LineFillRule::Nonzero, LineFillRule::Evenodd] {
                let diagnostics = measured_raw_rule_attempt(
                    &mut bridge,
                    &signed,
                    rule,
                    FLATTEN_TOLERANCE,
                    TOPOLOGY_TOLERANCE,
                    MAX_COMMANDS,
                )
                .unwrap();
                assert!(!diagnostics.topology_invoked);
                assert!(diagnostics.rounded_invoked);
                let output = bridge.output().unwrap();
                assert_eq!(output.ranges[0].count, 1);
                assert_eq!(output.points[0].x.to_bits(), 1u64 << 63);
                assert_eq!(output.points[0].y.to_bits(), 0);
                assert!(output.owners.is_empty());
                let DecodedSource::Line { points, .. } = output.sources[0] else {
                    panic!("expected signed-zero LINE source")
                };
                assert_eq!(points[0].x.to_bits(), 1u64 << 63);
                assert_eq!(points[1].x.to_bits(), 0);
                assert_eq!(points[1].y.to_bits(), 1u64 << 63);
                assert_depth_zero_original_identity(&signed, output);
                assert_empty_rounded_mesh(output.rounded);
                assert_direct_rounded_identity(&mut direct, &contours, rule, output);
            }
        }

        let mut four_moves = RawPath::default();
        for x in 0..4 {
            four_moves.move_to(point(f64::from(x), 0.0));
        }
        let mut five_moves = four_moves.clone();
        five_moves.move_to(point(4.0, 0.0));
        for rule in [LineFillRule::Nonzero, LineFillRule::Evenodd] {
            let diagnostics = measured_raw_rule_attempt(
                &mut bridge,
                &four_moves,
                rule,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            )
            .unwrap();
            assert!(!diagnostics.topology_invoked);
            assert!(diagnostics.rounded_invoked);
            let output = bridge.output().unwrap();
            assert_eq!(output.ranges.len(), 4);
            assert!(output.ranges.iter().all(|range| range.count == 1));
            assert_eq!(output.points.len(), 4);
            assert!(output.owners.is_empty());
            assert_empty_rounded_mesh(output.rounded);
            assert_eq!(
                measured_raw_rule_attempt(
                    &mut bridge,
                    &five_moves,
                    rule,
                    FLATTEN_TOLERANCE,
                    TOPOLOGY_TOLERANCE,
                    MAX_COMMANDS,
                ),
                Err(BridgeError::SourceLimit)
            );
            assert!(bridge.diagnostics().sizing_invoked);
            assert!(!bridge.diagnostics().emission_invoked);
            assert!(bridge.output().is_none());
        }

        let mut sixteen_zero_lines = RawPath::default();
        sixteen_zero_lines.move_to(point(0.0, 0.0));
        for _ in 0..16 {
            sixteen_zero_lines.line_to(point(0.0, 0.0));
        }
        let mut seventeen_zero_lines = sixteen_zero_lines.clone();
        seventeen_zero_lines.line_to(point(0.0, 0.0));
        for rule in [LineFillRule::Nonzero, LineFillRule::Evenodd] {
            let diagnostics = measured_raw_rule_attempt(
                &mut bridge,
                &sixteen_zero_lines,
                rule,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            )
            .unwrap();
            assert!(!diagnostics.topology_invoked);
            assert!(diagnostics.rounded_invoked);
            let output = bridge.output().unwrap();
            assert_eq!(output.sources.len(), 16);
            assert_eq!(output.ranges[0].count, 1);
            assert!(output.owners.is_empty());
            assert_empty_rounded_mesh(output.rounded);
            assert_eq!(
                measured_raw_rule_attempt(
                    &mut bridge,
                    &seventeen_zero_lines,
                    rule,
                    FLATTEN_TOLERANCE,
                    TOPOLOGY_TOLERANCE,
                    MAX_COMMANDS,
                ),
                Err(BridgeError::SourceLimit)
            );
            assert!(!bridge.diagnostics().emission_invoked);
            assert!(bridge.output().is_none());
        }
    }

    #[test]
    fn all_line_a02_retraces_retain_proof_and_rounded_ambiguity() {
        let next = f64::from_bits(1.0f64.to_bits() + 1);
        let contours = vec![
            vec![point(0.0, 1.0), point(2.0, next)],
            vec![point(1.0, 1.0), point(1.0, next)],
        ];
        let mut bridge = BridgeWorkspace::new(LIMITS).unwrap();
        let mut direct = RoundedFillWorkspace::new(LIMITS).unwrap();
        let mut attempts = 0usize;
        for (returning, closed) in [(false, false), (false, true), (true, false), (true, true)] {
            let path = line_path(&contours, returning, closed);
            for rule in [LineFillRule::Nonzero, LineFillRule::Evenodd] {
                let references: Vec<&[Point]> =
                    contours.iter().map(|contour| contour.as_slice()).collect();
                assert_eq!(
                    direct.tessellate(&references, rule, 1.0),
                    Err(RoundedFillError::TopologyAmbiguous)
                );
                let expected_stats = direct.stats();
                assert_eq!(
                    measured_raw_rule_attempt(
                        &mut bridge,
                        &path,
                        rule,
                        FLATTEN_TOLERANCE,
                        1.0,
                        MAX_COMMANDS,
                    ),
                    Err(BridgeError::Rounded(RoundedFillError::TopologyAmbiguous))
                );
                let diagnostics = bridge.diagnostics();
                assert!(diagnostics.emission_invoked);
                assert!(!diagnostics.topology_invoked);
                assert!(!diagnostics.rounded_topology_invoked);
                assert!(!diagnostics.rounded_topology_selected);
                assert_eq!(diagnostics.rounded_topology_error, None);
                assert!(diagnostics.rounded_invoked);
                assert_eq!(bridge.rounded_stats(), expected_stats);
                assert!(bridge.output().is_none());
                attempts += 1;
            }
        }
        assert_eq!(attempts, 8);
    }

    #[test]
    fn all_line_eligibility_does_not_migrate_mixed_empty_or_collapsed_contours() {
        let mut move_before = RawPath::default();
        move_before.move_to(point(20.0, 0.0));
        append_mixed_triangle(&mut move_before, 0.0, true, true, 0);
        let mut move_after = RawPath::default();
        append_mixed_triangle(&mut move_after, 0.0, true, true, 0);
        move_after.move_to(point(20.0, 0.0));
        let mut collapsed_before = RawPath::default();
        collapsed_before.move_to(point(20.0, 0.0));
        collapsed_before.line_to(point(20.0, 0.0));
        append_mixed_triangle(&mut collapsed_before, 0.0, true, true, 0);
        let mut collapsed_after = RawPath::default();
        append_mixed_triangle(&mut collapsed_after, 0.0, true, true, 0);
        collapsed_after.move_to(point(20.0, 0.0));
        collapsed_after.line_to(point(20.0, 0.0));
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();
        for rule in [LineFillRule::Nonzero, LineFillRule::Evenodd] {
            for path in [&move_before, &move_after] {
                assert_eq!(
                    measured_raw_rule_attempt(
                        &mut workspace,
                        path,
                        rule,
                        FLATTEN_TOLERANCE,
                        TOPOLOGY_TOLERANCE,
                        MAX_COMMANDS,
                    ),
                    Err(BridgeError::UnsupportedSource)
                );
                assert!(workspace.diagnostics().sizing_invoked);
                assert!(!workspace.diagnostics().emission_invoked);
                assert!(!workspace.diagnostics().topology_invoked);
                assert!(!workspace.diagnostics().rounded_invoked);
                assert!(workspace.output().is_none());
            }
            for path in [&collapsed_before, &collapsed_after] {
                assert_eq!(
                    measured_raw_rule_attempt(
                        &mut workspace,
                        path,
                        rule,
                        FLATTEN_TOLERANCE,
                        TOPOLOGY_TOLERANCE,
                        MAX_COMMANDS,
                    ),
                    Err(BridgeError::ZeroLengthLeaf)
                );
                assert!(workspace.diagnostics().emission_invoked);
                assert!(!workspace.diagnostics().topology_invoked);
                assert!(!workspace.diagnostics().rounded_invoked);
                assert!(workspace.output().is_none());
            }
        }
    }

    #[test]
    fn all_line_identity_matches_literal_rounded_carriers_in_all_closure_forms() {
        let fixtures = line_identity_fixtures();
        let mut bridge = BridgeWorkspace::new(LIMITS).unwrap();
        let mut direct = RoundedFillWorkspace::new(LIMITS).unwrap();
        let mut attempts = 0usize;
        for fixture in &fixtures {
            for (rule_index, rule) in [LineFillRule::Nonzero, LineFillRule::Evenodd]
                .into_iter()
                .enumerate()
            {
                for (returning, closed) in
                    [(false, false), (false, true), (true, false), (true, true)]
                {
                    let path = line_path(&fixture.contours, returning, closed);
                    let diagnostics = measured_raw_rule_attempt(
                        &mut bridge,
                        &path,
                        rule,
                        FLATTEN_TOLERANCE,
                        TOPOLOGY_TOLERANCE,
                        MAX_COMMANDS,
                    )
                    .unwrap_or_else(|error| panic!("{} failed: {error:?}", fixture.id));
                    assert_eq!(diagnostics.flat_status, PATH_OK, "{}", fixture.id);
                    assert!(diagnostics.emission_invoked, "{}", fixture.id);
                    assert!(!diagnostics.topology_invoked, "{}", fixture.id);
                    assert!(diagnostics.rounded_invoked, "{}", fixture.id);
                    let output = bridge.output().unwrap();
                    assert_line_identity_source(
                        &path,
                        &fixture.contours,
                        returning,
                        closed,
                        output,
                    );
                    assert_eq!(
                        mesh_area(output.rounded),
                        fixture.areas[rule_index],
                        "{}",
                        fixture.id
                    );
                    assert_direct_rounded_identity(&mut direct, &fixture.contours, rule, output);
                    attempts += 1;
                }
            }
        }
        assert_eq!(fixtures.len(), 15);
        assert_eq!(attempts, 120);
    }

    fn transform_contours(
        contours: &[Vec<Point>],
        transform: fn(Point) -> Point,
    ) -> Vec<Vec<Point>> {
        contours
            .iter()
            .map(|contour| contour.iter().copied().map(transform).collect())
            .collect()
    }

    fn translate_identity(point: Point) -> Point {
        Point {
            x: point.x + 32.0,
            y: point.y - 16.0,
        }
    }

    fn reflect_identity(point: Point) -> Point {
        Point {
            x: -point.x,
            y: point.y,
        }
    }

    #[test]
    fn translated_and_reflected_line_identity_matches_direct_rounded_carriers() {
        let fixtures = line_identity_fixtures();
        let mut bridge = BridgeWorkspace::new(LIMITS).unwrap();
        let mut direct = RoundedFillWorkspace::new(LIMITS).unwrap();
        let mut attempts = 0usize;
        for id in ["F06", "F10", "F11"] {
            let fixture = fixtures.iter().find(|fixture| fixture.id == id).unwrap();
            for transform in [
                translate_identity as fn(Point) -> Point,
                reflect_identity as fn(Point) -> Point,
            ] {
                let contours = transform_contours(&fixture.contours, transform);
                for (rule_index, rule) in [LineFillRule::Nonzero, LineFillRule::Evenodd]
                    .into_iter()
                    .enumerate()
                {
                    let path = line_path(&contours, false, false);
                    let diagnostics = measured_raw_rule_attempt(
                        &mut bridge,
                        &path,
                        rule,
                        FLATTEN_TOLERANCE,
                        TOPOLOGY_TOLERANCE,
                        MAX_COMMANDS,
                    )
                    .unwrap();
                    assert!(!diagnostics.topology_invoked);
                    assert!(diagnostics.rounded_invoked);
                    let output = bridge.output().unwrap();
                    assert_line_identity_source(&path, &contours, false, false, output);
                    assert_eq!(mesh_area(output.rounded), fixture.areas[rule_index]);
                    assert_direct_rounded_identity(&mut direct, &contours, rule, output);
                    attempts += 1;
                }
            }
        }
        assert_eq!(attempts, 12);
    }

    fn mixed_fallback_path(all_lines: bool) -> RawPath {
        let mut path = RawPath::default();
        path.move_to(point(0.0, 0.0));
        if all_lines {
            path.line_to(point(12.0, 12.0));
        } else {
            path.cubic_to(point(4.0, 4.0), point(8.0, 8.0), point(12.0, 12.0));
        }
        path.line_to(point(0.0, 12.0));
        path.line_to(point(12.0, 0.0));
        path
    }

    #[test]
    fn line_identity_does_not_bypass_mixed_cubic_topology() {
        let mixed = mixed_fallback_path(false);
        let lines = mixed_fallback_path(true);
        let contours = vec![vec![
            point(0.0, 0.0),
            point(12.0, 12.0),
            point(0.0, 12.0),
            point(12.0, 0.0),
        ]];
        let mut bridge = BridgeWorkspace::new(LIMITS).unwrap();
        let mut direct = RoundedFillWorkspace::new(LIMITS).unwrap();
        for rule in [LineFillRule::Nonzero, LineFillRule::Evenodd] {
            assert_eq!(
                measured_raw_rule_attempt(
                    &mut bridge,
                    &mixed,
                    rule,
                    FLATTEN_TOLERANCE,
                    TOPOLOGY_TOLERANCE,
                    MAX_COMMANDS,
                ),
                Err(BridgeError::Topology(TopologyError::Unresolved))
            );
            assert!(bridge.diagnostics().topology_invoked);
            assert!(!bridge.diagnostics().rounded_invoked);
            assert!(bridge.output().is_none());

            let diagnostics = measured_raw_rule_attempt(
                &mut bridge,
                &lines,
                rule,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            )
            .unwrap();
            assert!(!diagnostics.topology_invoked);
            assert!(diagnostics.rounded_invoked);
            let output = bridge.output().unwrap();
            assert_eq!(mesh_area(output.rounded), 72.0);
            assert_line_identity_source(&lines, &contours, false, false, output);
            assert_direct_rounded_identity(&mut direct, &contours, rule, output);
        }
    }

    #[test]
    fn repeated_line_square_normalizes_and_short_contours_publish_empty() {
        let fixtures = line_identity_fixtures();
        let f01 = fixtures.iter().find(|fixture| fixture.id == "F01").unwrap();
        let mut repeated = RawPath::default();
        repeated.move_to(point(0.0, 0.0));
        repeated.line_to(point(10.0, 0.0));
        repeated.line_to(point(10.0, 10.0));
        repeated.line_to(point(10.0, 10.0));
        repeated.line_to(point(0.0, 10.0));
        let mut one_line = RawPath::default();
        one_line.move_to(point(0.0, 0.0));
        one_line.line_to(point(3.0, 0.0));
        one_line.close();
        let mut two_lines = RawPath::default();
        two_lines.move_to(point(0.0, 0.0));
        two_lines.line_to(point(3.0, 0.0));
        two_lines.line_to(point(0.0, 0.0));
        let success = line_path(&f01.contours, false, false);
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();

        measured_raw_attempt(
            &mut workspace,
            &repeated,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert!(workspace.diagnostics().emission_invoked);
        assert!(!workspace.diagnostics().topology_invoked);
        assert!(workspace.diagnostics().rounded_invoked);
        let repeated_output = workspace.output().unwrap();
        assert_eq!(repeated_output.sources.len(), 4);
        assert_eq!(repeated_output.points.len(), 4);
        assert_eq!(repeated_output.owners.len(), 4);
        assert_eq!(mesh_area(repeated_output.rounded), 100.0);
        for path in [&one_line, &two_lines] {
            let diagnostics = measured_raw_attempt(
                &mut workspace,
                path,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            )
            .unwrap();
            assert!(!diagnostics.topology_invoked);
            assert!(diagnostics.rounded_invoked);
            let output = workspace.output().unwrap();
            assert!(output.rounded.vertices.is_empty());
            assert!(output.rounded.indices.is_empty());
            assert_eq!(output.points.len(), 2);
            assert_eq!(output.owners.len(), 2);
        }
        measured_raw_attempt(
            &mut workspace,
            &success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert!(!workspace.diagnostics().topology_invoked);
        assert!(workspace.output().is_some());
    }

    #[test]
    fn skipped_topology_retains_stats_and_line_rounding_failures_recover_atomically() {
        let cubic_success = raw_square();
        let fixtures = line_identity_fixtures();
        let f01 = fixtures.iter().find(|fixture| fixture.id == "F01").unwrap();
        let line_success = line_path(&f01.contours, false, false);
        let mut degenerate_success = RawPath::default();
        append_degenerate_line(&mut degenerate_success, DegenerateLineEncoding::Zero, true);
        let next = f64::from_bits(1.0f64.to_bits() + 1);
        let ambiguity_contours = vec![
            vec![point(0.0, 1.0), point(2.0, next)],
            vec![point(1.0, 1.0), point(1.0, next)],
        ];
        let ambiguity = line_path(&ambiguity_contours, false, false);
        let mixed_failure = mixed_fallback_path(false);
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();

        measured_raw_attempt(
            &mut workspace,
            &cubic_success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        let retained = workspace.topology_stats();
        assert!(retained.leaves > 0);
        measured_raw_attempt(
            &mut workspace,
            &degenerate_success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert!(!workspace.diagnostics().topology_invoked);
        assert!(!workspace.diagnostics().rounded_topology_invoked);
        assert!(workspace.diagnostics().rounded_invoked);
        assert_eq!(workspace.topology_stats(), retained);
        assert_empty_rounded_mesh(workspace.output().unwrap().rounded);
        assert_eq!(
            measured_raw_attempt(
                &mut workspace,
                &degenerate_success,
                FLATTEN_TOLERANCE,
                0.0,
                MAX_COMMANDS,
            ),
            Err(BridgeError::Rounded(RoundedFillError::InvalidTolerance))
        );
        assert!(!workspace.diagnostics().topology_invoked);
        assert!(workspace.diagnostics().rounded_invoked);
        assert_eq!(workspace.topology_stats(), retained);
        assert!(workspace.output().is_none());
        assert_eq!(
            measured_raw_attempt(
                &mut workspace,
                &ambiguity,
                FLATTEN_TOLERANCE,
                1.0,
                MAX_COMMANDS,
            ),
            Err(BridgeError::Rounded(RoundedFillError::TopologyAmbiguous))
        );
        assert!(!workspace.diagnostics().topology_invoked);
        assert!(!workspace.diagnostics().rounded_topology_invoked);
        assert!(workspace.diagnostics().rounded_invoked);
        assert_eq!(workspace.topology_stats(), retained);
        assert!(workspace.output().is_none());
        measured_raw_attempt(
            &mut workspace,
            &line_success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert!(!workspace.diagnostics().topology_invoked);
        assert!(workspace.diagnostics().rounded_invoked);
        assert_eq!(workspace.topology_stats(), retained);
        assert!(workspace.output().is_some());

        assert_eq!(
            measured_raw_attempt(
                &mut workspace,
                &mixed_failure,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            ),
            Err(BridgeError::Topology(TopologyError::Unresolved))
        );
        assert!(workspace.diagnostics().topology_invoked);
        assert!(!workspace.diagnostics().rounded_invoked);
        assert!(workspace.output().is_none());
        measured_raw_attempt(
            &mut workspace,
            &cubic_success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert!(workspace.diagnostics().topology_invoked);
        assert!(workspace.diagnostics().rounded_invoked);
        assert!(workspace.output().is_some());

        assert_eq!(
            measured_raw_attempt(
                &mut workspace,
                &line_success,
                FLATTEN_TOLERANCE,
                0.0,
                MAX_COMMANDS,
            ),
            Err(BridgeError::Rounded(RoundedFillError::InvalidTolerance))
        );
        assert!(!workspace.diagnostics().topology_invoked);
        assert!(workspace.diagnostics().rounded_invoked);
        assert!(workspace.output().is_none());
        measured_raw_attempt(
            &mut workspace,
            &line_success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert!(!workspace.diagnostics().topology_invoked);
        assert!(workspace.output().is_some());

        for (limits, expected) in [
            (
                RoundedFillLimits {
                    max_work: 0,
                    ..LIMITS
                },
                RoundedFillError::WorkLimit,
            ),
            (
                RoundedFillLimits {
                    max_triangles: 0,
                    ..LIMITS
                },
                RoundedFillError::OutputLimit,
            ),
        ] {
            let mut limited = BridgeWorkspace::new(limits).unwrap();
            assert_eq!(
                measured_raw_attempt(
                    &mut limited,
                    &line_success,
                    FLATTEN_TOLERANCE,
                    TOPOLOGY_TOLERANCE,
                    MAX_COMMANDS,
                ),
                Err(BridgeError::Rounded(expected))
            );
            assert!(!limited.diagnostics().topology_invoked);
            assert!(limited.diagnostics().rounded_invoked);
            assert!(limited.output().is_none());

            measured_raw_attempt(
                &mut workspace,
                &line_success,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            )
            .unwrap();
            assert!(!workspace.diagnostics().topology_invoked);
            assert!(workspace.diagnostics().rounded_invoked);
            assert!(workspace.output().is_some());
        }
    }

    #[test]
    fn degenerate_output_owns_caller_data_and_workspaces_are_independent() {
        let mut path = RawPath::default();
        path.move_to(point(-0.0, 0.0));
        path.line_to(point(0.0, -0.0));
        path.close();
        let mut first = BridgeWorkspace::new(LIMITS).unwrap();
        let mut second = BridgeWorkspace::new(LIMITS).unwrap();

        measured_raw_attempt(
            &mut first,
            &path,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        measured_raw_attempt(
            &mut second,
            &path,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        let expected = snapshot(second.output().unwrap());
        path.point_bytes.fill(0xff);
        drop(path);
        let first_output = first.output().unwrap();
        assert_eq!(snapshot(first_output), expected);
        assert_eq!(first_output.points[0].x.to_bits(), 1u64 << 63);
        let DecodedSource::Line { points, .. } = first_output.sources[0] else {
            panic!("expected retained zero LINE")
        };
        assert_eq!(points[0].x.to_bits(), 1u64 << 63);
        assert_eq!(points[1].y.to_bits(), 1u64 << 63);

        let mut fifth = RawPath::default();
        for x in 0..5 {
            fifth.move_to(point(f64::from(x), 0.0));
        }
        assert_eq!(
            measured_raw_attempt(
                &mut first,
                &fifth,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            ),
            Err(BridgeError::SourceLimit)
        );
        assert!(first.output().is_none());
        assert_eq!(snapshot(second.output().unwrap()), expected);
    }

    #[derive(Clone, Copy, Debug)]
    enum ZeroTriangleKind {
        Cubic,
        Mixed,
        Line,
    }

    #[derive(Clone, Copy, Debug)]
    enum ZeroPosition {
        AfterMove,
        AfterAb,
        Final,
    }

    fn raw_points(path: &RawPath) -> Vec<Point> {
        assert_eq!(path.point_bytes.len() % 16, 0);
        path.point_bytes
            .chunks_exact(16)
            .map(|bytes| Point {
                x: f64::from_le_bytes(bytes[..8].try_into().unwrap()),
                y: f64::from_le_bytes(bytes[8..].try_into().unwrap()),
            })
            .collect()
    }

    fn assert_point_bits(actual: Point, expected: Point) {
        assert_eq!(actual.x.to_bits(), expected.x.to_bits());
        assert_eq!(actual.y.to_bits(), expected.y.to_bits());
    }

    fn assert_depth_zero_original_identity(path: &RawPath, output: BridgeOutput<'_>) {
        let input_points = raw_points(path);
        let mut point_index = 0usize;
        let mut source_index = 0usize;
        let mut command_index = 0usize;
        let mut contour_index = 0usize;
        let mut original_current = None;
        let mut geometric_first = None;
        let mut geometric_current = None;
        let mut expected_owners = Vec::new();

        for (ordinal, verb) in path.verbs.iter().copied().enumerate() {
            let ordinal = u32::try_from(ordinal).unwrap();
            match verb {
                VERB_MOVE => {
                    if let (Some(first), Some(current)) = (geometric_first, geometric_current) {
                        if !same_point(first, current) {
                            expected_owners.push(EdgeOwner::ImplicitClosure {
                                contour: contour_index,
                            });
                        }
                        contour_index += 1;
                    }
                    let point = input_points[point_index];
                    point_index += 1;
                    let command = output.commands[command_index];
                    command_index += 1;
                    assert_eq!(command.verb, VERB_MOVE);
                    assert_eq!(command.provenance.source_verb, ordinal);
                    assert_eq!(command.provenance.end_numerator, 1);
                    assert_eq!(command.provenance.depth, 0);
                    assert_point_bits(command.point.unwrap(), point);
                    original_current = Some(point);
                    geometric_first = Some(point);
                    geometric_current = Some(point);
                }
                crate::geometry::VERB_LINE => {
                    let start = original_current.unwrap();
                    let end = input_points[point_index];
                    point_index += 1;
                    let command = output.commands[command_index];
                    command_index += 1;
                    assert_eq!(command.verb, crate::geometry::VERB_LINE);
                    assert_eq!(command.provenance.source_verb, ordinal);
                    assert_eq!(command.provenance.end_numerator, 1);
                    assert_eq!(command.provenance.depth, 0);
                    assert_point_bits(command.point.unwrap(), end);
                    let DecodedSource::Line {
                        points,
                        source_verb,
                        contour,
                    } = output.sources[source_index]
                    else {
                        panic!("expected original LINE source")
                    };
                    assert_eq!(source_verb, ordinal);
                    assert_eq!(contour, contour_index);
                    assert_point_bits(points[0], start);
                    assert_point_bits(points[1], end);
                    if !same_point(start, end) {
                        expected_owners.push(EdgeOwner::Line {
                            source_verb: ordinal,
                        });
                        geometric_current = Some(end);
                    }
                    original_current = Some(end);
                    source_index += 1;
                }
                VERB_CUBIC => {
                    let start = original_current.unwrap();
                    let one = input_points[point_index];
                    let two = input_points[point_index + 1];
                    let end = input_points[point_index + 2];
                    point_index += 3;
                    let command = output.commands[command_index];
                    command_index += 1;
                    assert_eq!(command.verb, crate::geometry::VERB_LINE);
                    assert_eq!(command.provenance.source_verb, ordinal);
                    assert_eq!(command.provenance.end_numerator, 1);
                    assert_eq!(command.provenance.depth, 0);
                    assert_point_bits(command.point.unwrap(), end);
                    let DecodedSource::Cubic {
                        points,
                        source_verb,
                        contour,
                    } = output.sources[source_index]
                    else {
                        panic!("expected original CUBIC source")
                    };
                    assert_eq!(source_verb, ordinal);
                    assert_eq!(contour, contour_index);
                    for (actual, expected) in points.iter().copied().zip([start, one, two, end]) {
                        assert_point_bits(actual, expected);
                    }
                    expected_owners.push(EdgeOwner::CubicLeaf {
                        source_verb: ordinal,
                        end_numerator: 1,
                        depth: 0,
                    });
                    original_current = Some(end);
                    geometric_current = Some(end);
                    source_index += 1;
                }
                VERB_CLOSE => {
                    let command = output.commands[command_index];
                    command_index += 1;
                    assert_eq!(command.verb, VERB_CLOSE);
                    assert_eq!(command.provenance.source_verb, ordinal);
                    assert_eq!(command.provenance.end_numerator, 1);
                    assert_eq!(command.provenance.depth, 0);
                    assert!(command.point.is_none());
                    if !same_point(geometric_first.unwrap(), geometric_current.unwrap()) {
                        expected_owners.push(EdgeOwner::ExplicitClose {
                            source_verb: ordinal,
                        });
                    }
                    original_current = None;
                    geometric_first = None;
                    geometric_current = None;
                    contour_index += 1;
                }
                _ => panic!("unexpected raw verb"),
            }
        }
        if let (Some(first), Some(current)) = (geometric_first, geometric_current) {
            if !same_point(first, current) {
                expected_owners.push(EdgeOwner::ImplicitClosure {
                    contour: contour_index,
                });
            }
            contour_index += 1;
        }
        assert_eq!(point_index, input_points.len());
        assert_eq!(source_index, output.sources.len());
        assert_eq!(command_index, output.commands.len());
        assert_eq!(contour_index, output.ranges.len());
        assert_eq!(expected_owners, output.owners);
    }

    fn append_zero_triangle_segment(
        path: &mut RawPath,
        kind: ZeroTriangleKind,
        index: usize,
        start: Point,
        end: Point,
    ) {
        let line = match kind {
            ZeroTriangleKind::Cubic => false,
            ZeroTriangleKind::Mixed => index != 1,
            ZeroTriangleKind::Line => true,
        };
        append_segment(path, start, end, line);
    }

    fn zero_triangle_path(
        kind: ZeroTriangleKind,
        zero: Option<ZeroPosition>,
        returning: bool,
        closed: bool,
    ) -> RawPath {
        let vertices = [point(0.0, 0.0), point(3.0, 0.0), point(0.0, 3.0)];
        let mut path = RawPath::default();
        path.move_to(vertices[0]);
        if matches!(zero, Some(ZeroPosition::AfterMove)) {
            path.line_to(vertices[0]);
        }
        let segment_count = if returning { 3 } else { 2 };
        for index in 0..segment_count {
            append_zero_triangle_segment(
                &mut path,
                kind,
                index,
                vertices[index],
                vertices[(index + 1) % vertices.len()],
            );
            if index == 0 && matches!(zero, Some(ZeroPosition::AfterAb)) {
                path.line_to(vertices[1]);
            }
        }
        if matches!(zero, Some(ZeroPosition::Final)) {
            path.line_to(if returning { vertices[0] } else { vertices[2] });
        }
        if closed {
            path.close();
        }
        path
    }

    #[test]
    fn zero_line_triangle_matrix_preserves_normalized_geometry_and_original_identity() {
        let mut attempts = 0usize;
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();
        for kind in [
            ZeroTriangleKind::Cubic,
            ZeroTriangleKind::Mixed,
            ZeroTriangleKind::Line,
        ] {
            for zero in [
                ZeroPosition::AfterMove,
                ZeroPosition::AfterAb,
                ZeroPosition::Final,
            ] {
                for (returning, closed) in
                    [(false, false), (false, true), (true, false), (true, true)]
                {
                    let baseline = zero_triangle_path(kind, None, returning, closed);
                    let repeated = zero_triangle_path(kind, Some(zero), returning, closed);
                    for rule in [LineFillRule::Nonzero, LineFillRule::Evenodd] {
                        let baseline_diagnostics = measured_raw_rule_attempt(
                            &mut workspace,
                            &baseline,
                            rule,
                            FLATTEN_TOLERANCE,
                            TOPOLOGY_TOLERANCE,
                            MAX_COMMANDS,
                        )
                        .unwrap();
                        let baseline_topology = workspace.topology_stats();
                        let baseline_snapshot = snapshot(workspace.output().unwrap());
                        let diagnostics = measured_raw_rule_attempt(
                            &mut workspace,
                            &repeated,
                            rule,
                            FLATTEN_TOLERANCE,
                            TOPOLOGY_TOLERANCE,
                            MAX_COMMANDS,
                        )
                        .unwrap();
                        assert_eq!(
                            diagnostics.topology_invoked,
                            baseline_diagnostics.topology_invoked
                        );
                        assert!(diagnostics.rounded_invoked);
                        assert_eq!(workspace.topology_stats(), baseline_topology);
                        let output = workspace.output().unwrap();
                        assert_eq!(snapshot(output), baseline_snapshot);
                        assert_eq!(mesh_area(output.rounded), 4.5);
                        assert_depth_zero_original_identity(&repeated, output);
                        attempts += 1;
                    }
                }
            }
        }
        assert_eq!(attempts, 72);
    }

    fn repeated_f01(returning: bool, closed: bool) -> RawPath {
        let mut path = RawPath::default();
        path.move_to(point(0.0, 0.0));
        path.line_to(point(10.0, 0.0));
        path.line_to(point(10.0, 10.0));
        path.line_to(point(10.0, 10.0));
        path.line_to(point(0.0, 10.0));
        if returning {
            path.line_to(point(0.0, 0.0));
        }
        if closed {
            path.close();
        }
        path
    }

    #[test]
    fn f09_repeat_matches_f01_in_all_rules_and_closure_forms() {
        let f01 = line_identity_fixtures()
            .into_iter()
            .find(|fixture| fixture.id == "F01")
            .unwrap();
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();
        let mut attempts = 0usize;
        for (returning, closed) in [(false, false), (false, true), (true, false), (true, true)] {
            let baseline = line_path(&f01.contours, returning, closed);
            let repeated = repeated_f01(returning, closed);
            for rule in [LineFillRule::Nonzero, LineFillRule::Evenodd] {
                measured_raw_rule_attempt(
                    &mut workspace,
                    &baseline,
                    rule,
                    FLATTEN_TOLERANCE,
                    TOPOLOGY_TOLERANCE,
                    MAX_COMMANDS,
                )
                .unwrap();
                let expected = snapshot(workspace.output().unwrap());
                let diagnostics = measured_raw_rule_attempt(
                    &mut workspace,
                    &repeated,
                    rule,
                    FLATTEN_TOLERANCE,
                    TOPOLOGY_TOLERANCE,
                    MAX_COMMANDS,
                )
                .unwrap();
                assert!(!diagnostics.topology_invoked);
                assert!(diagnostics.rounded_invoked);
                let output = workspace.output().unwrap();
                assert_eq!(snapshot(output), expected);
                assert_eq!(mesh_area(output.rounded), 100.0);
                assert_depth_zero_original_identity(&repeated, output);
                attempts += 1;
            }
        }
        assert_eq!(attempts, 8);
    }

    #[test]
    fn consecutive_and_signed_zero_lines_preserve_shifted_owners_and_compact_proof() {
        let baseline = zero_triangle_path(ZeroTriangleKind::Mixed, None, true, false);
        let mut consecutive = RawPath::default();
        consecutive.move_to(point(0.0, 0.0));
        consecutive.line_to(point(0.0, 0.0));
        consecutive.line_to(point(0.0, 0.0));
        consecutive.line_to(point(3.0, 0.0));
        consecutive.cubic_to(point(2.0, 1.0), point(1.0, 2.0), point(0.0, 3.0));
        consecutive.line_to(point(0.0, 0.0));
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();
        for rule in [LineFillRule::Nonzero, LineFillRule::Evenodd] {
            measured_raw_rule_attempt(
                &mut workspace,
                &baseline,
                rule,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            )
            .unwrap();
            let expected = snapshot(workspace.output().unwrap());
            measured_raw_rule_attempt(
                &mut workspace,
                &consecutive,
                rule,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            )
            .unwrap();
            let output = workspace.output().unwrap();
            assert_eq!(snapshot(output), expected);
            assert_eq!(
                output.owners,
                [
                    EdgeOwner::Line { source_verb: 3 },
                    EdgeOwner::CubicLeaf {
                        source_verb: 4,
                        end_numerator: 1,
                        depth: 0,
                    },
                    EdgeOwner::Line { source_verb: 5 },
                ]
            );
            assert_depth_zero_original_identity(&consecutive, output);
        }

        for closed in [false, true] {
            let mut signed = RawPath::default();
            signed.move_to(point(-0.0, 0.0));
            signed.line_to(point(0.0, -0.0));
            signed.line_to(point(3.0, 0.0));
            signed.cubic_to(point(2.0, 1.0), point(1.0, 2.0), point(0.0, 3.0));
            signed.line_to(point(0.0, -0.0));
            signed.line_to(point(-0.0, 0.0));
            if closed {
                signed.close();
            }
            measured_raw_attempt(
                &mut workspace,
                &signed,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            )
            .unwrap();
            assert!(workspace.diagnostics().topology_invoked);
            assert_eq!(workspace.topology_stats().leaves, 3);
            let output = workspace.output().unwrap();
            assert_eq!(output.sources.len(), 5);
            assert_eq!(
                output.owners,
                [
                    EdgeOwner::Line { source_verb: 2 },
                    EdgeOwner::CubicLeaf {
                        source_verb: 3,
                        end_numerator: 1,
                        depth: 0,
                    },
                    EdgeOwner::Line { source_verb: 4 },
                ]
            );
            assert_depth_zero_original_identity(&signed, output);
            let retained = output.sources;
            let DecodedSource::Line { points, .. } = retained[0] else {
                panic!("expected signed zero LINE")
            };
            assert_eq!(points[0].x.to_bits(), 1u64 << 63);
            assert_eq!(points[1].x.to_bits(), 0);
            assert_eq!(points[1].y.to_bits(), 1u64 << 63);
            signed.point_bytes.fill(0xff);
            drop(signed);
            let DecodedSource::Line { points, .. } = workspace.output().unwrap().sources[0] else {
                panic!("expected retained signed zero LINE")
            };
            assert_eq!(points[0].x.to_bits(), 1u64 << 63);
            assert_eq!(points[1].y.to_bits(), 1u64 << 63);
        }
    }

    #[test]
    fn two_contour_zero_lines_preserve_global_ordinals_and_fill_rules() {
        let contours = [
            vec![
                point(0.0, 0.0),
                point(10.0, 0.0),
                point(10.0, 10.0),
                point(0.0, 10.0),
            ],
            vec![
                point(3.0, 3.0),
                point(7.0, 3.0),
                point(7.0, 7.0),
                point(3.0, 7.0),
            ],
        ];
        let mut repeated = RawPath::default();
        repeated.move_to(point(0.0, 0.0));
        repeated.line_to(point(0.0, 0.0));
        repeated.line_to(point(10.0, 0.0));
        repeated.line_to(point(10.0, 10.0));
        repeated.line_to(point(0.0, 10.0));
        repeated.move_to(point(3.0, 3.0));
        repeated.line_to(point(7.0, 3.0));
        repeated.line_to(point(7.0, 7.0));
        repeated.line_to(point(7.0, 7.0));
        repeated.line_to(point(3.0, 7.0));
        repeated.close();
        let baseline = {
            let mut path = RawPath::default();
            path.move_to(contours[0][0]);
            for point in &contours[0][1..] {
                path.line_to(*point);
            }
            path.move_to(contours[1][0]);
            for point in &contours[1][1..] {
                path.line_to(*point);
            }
            path.close();
            path
        };
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();
        for (rule, area) in [
            (LineFillRule::Nonzero, 100.0),
            (LineFillRule::Evenodd, 84.0),
        ] {
            measured_raw_rule_attempt(
                &mut workspace,
                &baseline,
                rule,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            )
            .unwrap();
            let expected = snapshot(workspace.output().unwrap());
            measured_raw_rule_attempt(
                &mut workspace,
                &repeated,
                rule,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            )
            .unwrap();
            let output = workspace.output().unwrap();
            assert_eq!(snapshot(output), expected);
            assert_eq!(mesh_area(output.rounded), area);
            assert_eq!(
                output.owners,
                [
                    EdgeOwner::Line { source_verb: 2 },
                    EdgeOwner::Line { source_verb: 3 },
                    EdgeOwner::Line { source_verb: 4 },
                    EdgeOwner::ImplicitClosure { contour: 0 },
                    EdgeOwner::Line { source_verb: 6 },
                    EdgeOwner::Line { source_verb: 7 },
                    EdgeOwner::Line { source_verb: 9 },
                    EdgeOwner::ExplicitClose { source_verb: 10 },
                ]
            );
            assert_depth_zero_original_identity(&repeated, output);
        }
    }

    #[test]
    fn collapsed_lines_compose_while_mixed_and_decode_precedence_remain_bounded() {
        let success = zero_triangle_path(ZeroTriangleKind::Line, None, true, true);
        let mut collapsed_open = RawPath::default();
        collapsed_open.move_to(point(0.0, 0.0));
        collapsed_open.line_to(point(0.0, 0.0));
        let mut collapsed_closed = collapsed_open.clone();
        collapsed_closed.close();
        let mut two_edges = RawPath::default();
        two_edges.move_to(point(0.0, 0.0));
        two_edges.line_to(point(0.0, 0.0));
        two_edges.line_to(point(3.0, 0.0));
        two_edges.line_to(point(0.0, 0.0));
        let mut collapsed_then_cubic = collapsed_open.clone();
        append_mixed_triangle(&mut collapsed_then_cubic, 9.0, true, true, 0);
        assert!(collapsed_then_cubic.verbs.contains(&VERB_CUBIC));
        let mut fifth_move = collapsed_open.clone();
        for x in [12.0, 24.0, 36.0, 48.0] {
            fifth_move.move_to(point(x, 0.0));
            fifth_move.line_to(point(x + 3.0, 0.0));
        }
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();

        for collapsed in [&collapsed_open, &collapsed_closed] {
            measured_raw_attempt(
                &mut workspace,
                &success,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            )
            .unwrap();
            let diagnostics = measured_raw_attempt(
                &mut workspace,
                collapsed,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            )
            .unwrap();
            assert!(diagnostics.emission_invoked);
            assert!(!diagnostics.topology_invoked);
            assert!(diagnostics.rounded_invoked);
            let output = workspace.output().unwrap();
            assert_eq!(output.ranges[0].count, 1);
            assert_eq!(output.points.len(), 1);
            assert_eq!(output.owners.len(), 0);
            assert!(output.rounded.vertices.is_empty());
            assert!(output.rounded.indices.is_empty());
            measured_raw_attempt(
                &mut workspace,
                &success,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            )
            .unwrap();
            assert!(workspace.output().is_some());
        }
        let diagnostics = measured_raw_attempt(
            &mut workspace,
            &two_edges,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert!(diagnostics.emission_invoked);
        assert!(!diagnostics.topology_invoked);
        assert!(diagnostics.rounded_invoked);
        let output = workspace.output().unwrap();
        assert_eq!(output.points.len(), 2);
        assert_eq!(output.owners.len(), 2);
        assert!(output.rounded.vertices.is_empty());
        assert!(output.rounded.indices.is_empty());
        measured_raw_attempt(
            &mut workspace,
            &success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert!(workspace.output().is_some());
        assert_eq!(
            measured_raw_attempt(
                &mut workspace,
                &collapsed_then_cubic,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            ),
            Err(BridgeError::ZeroLengthLeaf)
        );
        assert!(workspace.diagnostics().emission_invoked);
        assert!(!workspace.diagnostics().topology_invoked);
        assert!(!workspace.diagnostics().rounded_invoked);
        assert!(workspace.output().is_none());
        measured_raw_attempt(
            &mut workspace,
            &success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert!(workspace.output().is_some());
        assert_eq!(
            measured_raw_attempt(
                &mut workspace,
                &fifth_move,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            ),
            Err(BridgeError::SourceLimit)
        );
        assert!(workspace.diagnostics().sizing_invoked);
        assert_eq!(workspace.diagnostics().flat_status, PATH_OK);
        assert!(!workspace.diagnostics().emission_invoked);
        assert!(!workspace.diagnostics().topology_invoked);
        assert!(!workspace.diagnostics().rounded_invoked);
        assert!(workspace.output().is_none());
        measured_raw_attempt(
            &mut workspace,
            &success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert!(workspace.output().is_some());
    }

    fn rounded_cubic_endpoint_line(original_zero: bool) -> RawPath {
        let endpoint = f64::from_bits(0x3c90_0000_0000_0000);
        let mut path = RawPath::default();
        path.move_to(point(1.0, 0.0));
        path.cubic_to(point(0.75, 0.0), point(0.25, 0.0), point(endpoint, 0.0));
        path.line_to(if original_zero {
            point(endpoint, 0.0)
        } else {
            point(0.0, 0.0)
        });
        path.line_to(point(0.0, 3.0));
        path.line_to(point(1.0, 0.0));
        path.close();
        path
    }

    #[test]
    fn zero_line_classification_uses_original_source_endpoints() {
        let success = zero_triangle_path(ZeroTriangleKind::Line, None, true, true);
        let original_zero = rounded_cubic_endpoint_line(true);
        let emitted_zero = rounded_cubic_endpoint_line(false);
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();

        measured_raw_attempt(
            &mut workspace,
            &success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert_eq!(
            measured_raw_attempt(
                &mut workspace,
                &original_zero,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            ),
            Err(BridgeError::Topology(TopologyError::KnotMismatch))
        );
        assert!(workspace.diagnostics().sizing_invoked);
        assert_eq!(workspace.diagnostics().flat_status, PATH_OK);
        assert!(workspace.diagnostics().emission_invoked);
        assert!(workspace.diagnostics().topology_invoked);
        assert!(!workspace.diagnostics().rounded_invoked);
        assert!(workspace.output().is_none());
        measured_raw_attempt(
            &mut workspace,
            &success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert!(workspace.output().is_some());

        assert_eq!(
            measured_raw_attempt(
                &mut workspace,
                &emitted_zero,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            ),
            Err(BridgeError::ZeroLengthLeaf)
        );
        assert!(workspace.diagnostics().sizing_invoked);
        assert_eq!(workspace.diagnostics().flat_status, PATH_OK);
        assert!(workspace.diagnostics().emission_invoked);
        assert!(!workspace.diagnostics().topology_invoked);
        assert!(!workspace.diagnostics().rounded_invoked);
        assert!(workspace.output().is_none());
        measured_raw_attempt(
            &mut workspace,
            &success,
            FLATTEN_TOLERANCE,
            TOPOLOGY_TOLERANCE,
            MAX_COMMANDS,
        )
        .unwrap();
        assert!(workspace.output().is_some());
    }

    fn zero_line_source_ceiling(zero_count: usize) -> RawPath {
        let mut path = RawPath::default();
        path.move_to(point(0.0, 0.0));
        for _ in 0..zero_count {
            path.line_to(point(0.0, 0.0));
        }
        path.line_to(point(3.0, 0.0));
        path.line_to(point(0.0, 3.0));
        path.line_to(point(0.0, 0.0));
        path.close();
        path
    }

    #[test]
    fn zero_lines_still_charge_the_shared_sixteen_source_limit() {
        let ceiling = zero_line_source_ceiling(13);
        let overflow = zero_line_source_ceiling(14);
        assert_eq!(ceiling.verbs.len(), 18);
        assert_eq!(ceiling.point_count(), 34);
        assert_eq!(overflow.verbs.len(), 19);
        assert_eq!(overflow.point_count(), 36);
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();
        for rule in [LineFillRule::Nonzero, LineFillRule::Evenodd] {
            let diagnostics = measured_raw_rule_attempt(
                &mut workspace,
                &ceiling,
                rule,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            )
            .unwrap();
            assert!(!diagnostics.topology_invoked);
            assert!(diagnostics.rounded_invoked);
            let output = workspace.output().unwrap();
            assert_eq!(output.sources.len(), 16);
            assert_eq!(output.owners.len(), 3);
            assert_eq!(mesh_area(output.rounded), 4.5);
            assert_depth_zero_original_identity(&ceiling, output);

            assert_eq!(
                measured_raw_rule_attempt(
                    &mut workspace,
                    &overflow,
                    rule,
                    FLATTEN_TOLERANCE,
                    TOPOLOGY_TOLERANCE,
                    MAX_COMMANDS,
                ),
                Err(BridgeError::SourceLimit)
            );
            assert!(workspace.diagnostics().sizing_invoked);
            assert!(!workspace.diagnostics().emission_invoked);
            assert!(workspace.output().is_none());
            measured_raw_rule_attempt(
                &mut workspace,
                &ceiling,
                rule,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            )
            .unwrap();
            assert!(workspace.output().is_some());
        }
    }
}
