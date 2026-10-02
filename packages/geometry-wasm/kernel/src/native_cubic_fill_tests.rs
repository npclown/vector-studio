use core::mem::size_of;
use std::env;
use std::fs::File;
use std::io::Read;

use crate::codec::{PathInput, Request};
use crate::cubic_fill::{
    CubicFillDiagnostics as AttemptDiagnostics, CubicFillError as BridgeError,
    CubicFillOutput as BridgeOutput, CubicFillWorkspace as BridgeWorkspace, EdgeOwner, FlatCommand,
    MAX_FLAT_COMMANDS as MAX_COMMANDS,
};
use crate::geometry::{
    Plan, Point, WorkStatistics, PATH_EMPTY, PATH_INVALID, PATH_INVALID_TOLERANCE,
    PATH_NUMERIC_RANGE, PATH_OK, VERB_CLOSE, VERB_CUBIC, VERB_MOVE,
};
use crate::line_fill::LineFillRule;
use crate::rounded_line_fill::{
    RoundedBoundary, RoundedCell, RoundedColumnSpan, RoundedFillError, RoundedFillLimits,
    RoundedFillStats, RoundedSection, RoundedSourceEdge,
};
use crate::rounded_line_fill_tests::{print_output, print_points, print_stats};
use crate::simple_cubic_topology::TopologyError;

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
    let path = env::var("P3_NATIVE_CUBIC_INPUT").expect("P3_NATIVE_CUBIC_INPUT must be set");
    let file = File::open(path).expect("open P3 native cubic fixture");
    let mut bytes = Vec::new();
    file.take((INPUT_LIMIT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .expect("read P3 native cubic fixture");
    assert!(bytes.len() <= INPUT_LIMIT_BYTES, "fixture exceeds 512 KiB");
    let source = core::str::from_utf8(&bytes).expect("fixture must be UTF-8");
    parse_fixture(source, EXPECTED_ROWS).expect("parse P3 native cubic fixture")
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
            assert_eq!(decoded.contour, contour_index, "{}", row.id);
            assert_eq!(decoded.source_verb, source_ordinal, "{}", row.id);
            let canonical = [
                canonical_start,
                cubic.points[1],
                cubic.points[2],
                cubic.points[3],
            ];
            for (actual, expected) in decoded.points.iter().zip(canonical) {
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
        vertex_bits: output
            .rounded
            .vertices
            .iter()
            .map(|point| [point.x.to_bits(), point.y.to_bits()])
            .collect(),
        indices: output.rounded.indices.to_vec(),
        bounds_bits: [
            output.rounded.bounds.min_x.to_bits(),
            output.rounded.bounds.min_y.to_bits(),
            output.rounded.bounds.max_x.to_bits(),
            output.rounded.bounds.max_y.to_bits(),
        ],
        source_edges: output.rounded.source_edges.to_vec(),
        columns: output
            .rounded
            .columns
            .iter()
            .map(|column| (column.x.to_bits(), column.node_start, column.node_count))
            .collect(),
        nodes: output
            .rounded
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
        sections: output.rounded.sections.to_vec(),
        cells: output.rounded.cells.to_vec(),
        boundaries: output.rounded.boundaries.to_vec(),
        spans: output.rounded.spans.to_vec(),
        contributors: output.rounded.contributors.to_vec(),
        error_bound_bits: output.rounded.error_bound.to_bits(),
        stats: output.rounded_stats,
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
        println!(
            ",\"allocations\":{allocations},\"allocated_bytes\":{allocated_bytes},\"inline_bytes\":{inline_bytes}}}"
        );
    }
    assert_eq!(paired_rows, EXPECTED_ROWS);
    assert_eq!(paired_successes, 92);
    assert_eq!(paired_numeric_ranges, 2);
    println!("P3_NATIVE_CUBIC_END");
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
        assert_eq!(output.sources[0].source_verb, 1);
        assert_eq!(output.sources[4].source_verb, 7);

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
        assert_eq!(
            measured_raw_attempt(
                &mut workspace,
                &move_only,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            ),
            Err(BridgeError::UnsupportedSource)
        );

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

        let mut line = RawPath::default();
        line.move_to(point(0.0, 0.0));
        line.line_to(point(1.0, 0.0));
        let mut consecutive_moves = RawPath::default();
        consecutive_moves.move_to(point(0.0, 0.0));
        consecutive_moves.move_to(point(1.0, 0.0));
        for unsupported in [&line, &consecutive_moves] {
            assert_eq!(
                measured_raw_attempt(
                    &mut workspace,
                    unsupported,
                    FLATTEN_TOLERANCE,
                    TOPOLOGY_TOLERANCE,
                    MAX_COMMANDS,
                ),
                Err(BridgeError::UnsupportedSource)
            );
            assert!(workspace.diagnostics().sizing_invoked);
            assert!(!workspace.diagnostics().emission_invoked);
        }

        let mut line_before_fifth = RawPath::default();
        line_before_fifth.move_to(point(0.0, 0.0));
        append_linear(&mut line_before_fifth, point(0.0, 0.0), point(3.0, 0.0));
        line_before_fifth.line_to(point(6.0, 0.0));
        for index in 1..5 {
            let start = point(f64::from(index * 12), 0.0);
            line_before_fifth.move_to(start);
            append_linear(&mut line_before_fifth, start, point(start.x + 3.0, 0.0));
        }
        assert_eq!(
            measured_raw_attempt(
                &mut workspace,
                &line_before_fifth,
                FLATTEN_TOLERANCE,
                TOPOLOGY_TOLERANCE,
                MAX_COMMANDS,
            ),
            Err(BridgeError::UnsupportedSource)
        );

        let mut fifth_before_line = RawPath::default();
        for index in 0..4 {
            let start = point(f64::from(index * 12), 0.0);
            fifth_before_line.move_to(start);
            append_linear(&mut fifth_before_line, start, point(start.x + 3.0, 0.0));
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
        assert_eq!(output.sources[0].source_verb, 1);
        assert_eq!(output.sources[1].source_verb, 2);
        assert_eq!(output.sources[2].source_verb, 3);
        for index in 1..output.sources.len() {
            assert_eq!(
                output.sources[index].points[0].x.to_bits(),
                output.sources[index - 1].points[3].x.to_bits()
            );
            assert_eq!(
                output.sources[index].points[0].y.to_bits(),
                output.sources[index - 1].points[3].y.to_bits()
            );
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
        assert_eq!(output.sources[3].source_verb, 5);

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
        assert_eq!(output.sources[2].source_verb, 4);
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
        assert_eq!(output.sources[0].points[0].x.to_bits(), 1u64 << 63);
        assert_eq!(output.sources[2].points[3].y.to_bits(), 1u64 << 63);
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
        unsupported.line_to(point(1.0, 0.0));
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
            first.output().unwrap().sources[0].points[0].x.to_bits(),
            1u64 << 63
        );
        assert_eq!(
            first.output().unwrap().sources[2].points[3].y.to_bits(),
            1u64 << 63
        );

        signed.point_bytes.fill(0xff);
        assert_eq!(
            first.output().unwrap().sources[0].points[0].x.to_bits(),
            1u64 << 63
        );
        drop(signed);
        assert_eq!(
            first.output().unwrap().sources[0].points[0].x.to_bits(),
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
}
