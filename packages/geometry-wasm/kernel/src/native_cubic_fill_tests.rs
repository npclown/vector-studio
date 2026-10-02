use core::mem::size_of;
use std::env;
use std::fs::File;
use std::io::Read;

use crate::codec::{PathInput, Request};
use crate::geometry::{
    run_path, Bounds, Pass, Plan, Point, Provenance, WorkStatistics, PATH_NUMERIC_RANGE, PATH_OK,
    VERB_CLOSE, VERB_CUBIC, VERB_LINE, VERB_MOVE,
};
use crate::line_fill::LineFillRule;
use crate::rounded_line_fill::{
    RoundedFillError, RoundedFillLimits, RoundedFillOutput, RoundedFillStats, RoundedFillWorkspace,
};
use crate::rounded_line_fill_tests::{print_output, print_points, print_stats};

const INPUT_LIMIT_BYTES: usize = 512 * 1024;
const EXPECTED_ROWS: usize = 94;
const FLATTEN_TOLERANCE: f64 = 0.125;
const TOPOLOGY_TOLERANCE: f64 = 0.0625;
const MAX_COMMANDS: usize = 72;
const MAX_CONTOUR_POINTS: usize = 68;
const MAX_CONTOURS: usize = 4;
const MAX_EDGE_OWNERS: usize = 64;

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
enum SourceVerb {
    Move { contour: usize, point: Point },
    Cubic { contour: usize },
    Close { contour: usize },
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
    source_verbs: Vec<SourceVerb>,
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

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct FlatCommand {
    verb: u8,
    point: Option<Point>,
    provenance: Provenance,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ContourRange {
    start: usize,
    count: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EdgeOwner {
    CubicLeaf {
        source_verb: u32,
        end_numerator: u32,
        depth: u32,
    },
    ImplicitClosure {
        contour: usize,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BridgeError {
    CommandLimit,
    EmissionStatus(u32),
    PlanMismatch,
    BoundsMismatch,
    InvalidCommand,
    InvalidProvenance,
    ContourLimit,
    PointLimit,
    OwnerLimit,
    ZeroLengthLeaf,
    Rounded(RoundedFillError),
    RoundedOwnership,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct AttemptDiagnostics {
    flat_status: u32,
    sizing_plan: Plan,
    emission_plan: Option<Plan>,
    flat_bounds: Option<Bounds>,
    statistics: WorkStatistics,
}

#[derive(Clone, Copy)]
struct BridgeOutput<'a> {
    commands: &'a [FlatCommand],
    ranges: &'a [ContourRange],
    points: &'a [Point],
    owners: &'a [EdgeOwner],
    rounded: RoundedFillOutput<'a>,
    rounded_stats: RoundedFillStats,
}

#[derive(Clone, Copy)]
struct ActiveContour {
    source_contour: usize,
    point_start: usize,
    previous: Point,
}

struct BridgeWorkspace {
    rounded: RoundedFillWorkspace,
    commands: [FlatCommand; MAX_COMMANDS],
    command_len: usize,
    contour_points: [Point; MAX_CONTOUR_POINTS],
    point_len: usize,
    contour_ranges: [ContourRange; MAX_CONTOURS],
    range_len: usize,
    edge_owners: [EdgeOwner; MAX_EDGE_OWNERS],
    owner_len: usize,
    published: bool,
}

impl BridgeWorkspace {
    fn new(limits: RoundedFillLimits) -> Result<Self, RoundedFillError> {
        Ok(Self {
            rounded: RoundedFillWorkspace::new(limits)?,
            commands: [FlatCommand::default(); MAX_COMMANDS],
            command_len: 0,
            contour_points: [Point::default(); MAX_CONTOUR_POINTS],
            point_len: 0,
            contour_ranges: [ContourRange::default(); MAX_CONTOURS],
            range_len: 0,
            edge_owners: [EdgeOwner::ImplicitClosure { contour: 0 }; MAX_EDGE_OWNERS],
            owner_len: 0,
            published: false,
        })
    }

    fn allocated_bytes(&self) -> usize {
        self.rounded.allocated_bytes()
    }

    fn begin_attempt(&mut self) {
        self.command_len = 0;
        self.point_len = 0;
        self.range_len = 0;
        self.owner_len = 0;
        self.published = false;
    }

    fn attempt(
        &mut self,
        row: &SourceRow,
        topology_tolerance: f64,
        command_capacity: usize,
    ) -> Result<AttemptDiagnostics, BridgeError> {
        self.begin_attempt();
        let mut statistics = WorkStatistics::default();
        let (sizing_plan, sizing_bounds) = run_path(
            row.path_input(),
            Pass::Sizing,
            &mut statistics,
            |_, _, _| true,
        );
        if sizing_plan.status != PATH_OK {
            return Ok(AttemptDiagnostics {
                flat_status: sizing_plan.status,
                sizing_plan,
                emission_plan: None,
                flat_bounds: None,
                statistics,
            });
        }

        let bounded_capacity = command_capacity.min(MAX_COMMANDS);
        let mut exhausted = false;
        let commands = &mut self.commands;
        let command_len = &mut self.command_len;
        let (emission_plan, emission_bounds) = run_path(
            row.path_input(),
            Pass::Emission,
            &mut statistics,
            |verb, point, provenance| {
                if *command_len >= bounded_capacity {
                    exhausted = true;
                    return false;
                }
                commands[*command_len] = FlatCommand {
                    verb,
                    point,
                    provenance,
                };
                *command_len += 1;
                true
            },
        );
        if exhausted {
            return Err(BridgeError::CommandLimit);
        }
        if emission_plan.status != PATH_OK {
            return Err(BridgeError::EmissionStatus(emission_plan.status));
        }
        if sizing_plan != emission_plan
            || usize::try_from(emission_plan.verb_count).ok() != Some(self.command_len)
            || usize::try_from(emission_plan.point_count).ok()
                != Some(
                    self.commands[..self.command_len]
                        .iter()
                        .map(|command| usize::from(command.point.is_some()) * 2)
                        .sum(),
                )
        {
            return Err(BridgeError::PlanMismatch);
        }
        if !same_bounds_bits(sizing_bounds, emission_bounds) {
            return Err(BridgeError::BoundsMismatch);
        }

        self.collect_contours(row)?;
        self.validate_leaf_partitions(row)?;
        let mut references: [&[Point]; MAX_CONTOURS] = [&[]; MAX_CONTOURS];
        for (index, range) in self.contour_ranges[..self.range_len]
            .iter()
            .copied()
            .enumerate()
        {
            references[index] = &self.contour_points[range.start..range.start + range.count];
        }
        self.rounded
            .tessellate(&references[..self.range_len], row.rule, topology_tolerance)
            .map_err(BridgeError::Rounded)?;
        self.validate_rounded_ownership()?;
        self.published = true;
        Ok(AttemptDiagnostics {
            flat_status: PATH_OK,
            sizing_plan,
            emission_plan: Some(emission_plan),
            flat_bounds: Some(emission_bounds),
            statistics,
        })
    }

    fn collect_contours(&mut self, row: &SourceRow) -> Result<(), BridgeError> {
        let mut active = None;
        for command_index in 0..self.command_len {
            let command = self.commands[command_index];
            match command.verb {
                VERB_MOVE => {
                    if let Some(open) = active.take() {
                        self.finish_open_contour(open)?;
                    }
                    if self.range_len >= MAX_CONTOURS {
                        return Err(BridgeError::ContourLimit);
                    }
                    let point = command.point.ok_or(BridgeError::InvalidCommand)?;
                    if !finite_point(point)
                        || command.provenance.end_numerator != 1
                        || command.provenance.depth != 0
                    {
                        return Err(BridgeError::InvalidCommand);
                    }
                    match source_verb(row, command.provenance.source_verb)? {
                        SourceVerb::Move {
                            contour,
                            point: expected,
                        } if contour == self.range_len && same_point_bits(point, expected) => {}
                        _ => return Err(BridgeError::InvalidProvenance),
                    }
                    self.push_point(point)?;
                    active = Some(ActiveContour {
                        source_contour: self.range_len,
                        point_start: self.point_len - 1,
                        previous: point,
                    });
                }
                VERB_LINE => {
                    let mut open = active.ok_or(BridgeError::InvalidCommand)?;
                    let point = command.point.ok_or(BridgeError::InvalidCommand)?;
                    if !finite_point(point) {
                        return Err(BridgeError::InvalidCommand);
                    }
                    match source_verb(row, command.provenance.source_verb)? {
                        SourceVerb::Cubic { contour } if contour == open.source_contour => {}
                        _ => return Err(BridgeError::InvalidProvenance),
                    }
                    if same_point(open.previous, point) {
                        return Err(BridgeError::ZeroLengthLeaf);
                    }
                    self.push_owner(EdgeOwner::CubicLeaf {
                        source_verb: command.provenance.source_verb,
                        end_numerator: command.provenance.end_numerator,
                        depth: command.provenance.depth,
                    })?;
                    self.push_point(point)?;
                    open.previous = point;
                    active = Some(open);
                }
                VERB_CLOSE => {
                    let open = active.take().ok_or(BridgeError::InvalidCommand)?;
                    if command.point.is_some()
                        || command.provenance.end_numerator != 1
                        || command.provenance.depth != 0
                    {
                        return Err(BridgeError::InvalidCommand);
                    }
                    match source_verb(row, command.provenance.source_verb)? {
                        SourceVerb::Close { contour } if contour == open.source_contour => {}
                        _ => return Err(BridgeError::InvalidProvenance),
                    }
                    self.finish_closed_contour(open)?;
                }
                _ => return Err(BridgeError::InvalidCommand),
            }
        }
        if let Some(open) = active {
            self.finish_open_contour(open)?;
        }
        if self.range_len != row.contours.len()
            || self.owner_len
                != self.contour_ranges[..self.range_len]
                    .iter()
                    .map(|range| range.count)
                    .sum()
        {
            return Err(BridgeError::RoundedOwnership);
        }
        Ok(())
    }

    fn finish_closed_contour(&mut self, open: ActiveContour) -> Result<(), BridgeError> {
        let first = self.contour_points[open.point_start];
        if !same_point(first, open.previous)
            || self.point_len <= open.point_start + 1
            || open.source_contour != self.range_len
        {
            return Err(BridgeError::InvalidCommand);
        }
        self.point_len -= 1;
        self.push_range(ContourRange {
            start: open.point_start,
            count: self.point_len - open.point_start,
        })
    }

    fn finish_open_contour(&mut self, open: ActiveContour) -> Result<(), BridgeError> {
        let first = self.contour_points[open.point_start];
        if same_point(first, open.previous)
            || self.point_len <= open.point_start + 1
            || open.source_contour != self.range_len
        {
            return Err(BridgeError::InvalidCommand);
        }
        self.push_owner(EdgeOwner::ImplicitClosure {
            contour: open.source_contour,
        })?;
        self.push_range(ContourRange {
            start: open.point_start,
            count: self.point_len - open.point_start,
        })
    }

    fn push_point(&mut self, point: Point) -> Result<(), BridgeError> {
        if self.point_len >= MAX_CONTOUR_POINTS {
            return Err(BridgeError::PointLimit);
        }
        self.contour_points[self.point_len] = point;
        self.point_len += 1;
        Ok(())
    }

    fn push_owner(&mut self, owner: EdgeOwner) -> Result<(), BridgeError> {
        if self.owner_len >= MAX_EDGE_OWNERS {
            return Err(BridgeError::OwnerLimit);
        }
        self.edge_owners[self.owner_len] = owner;
        self.owner_len += 1;
        Ok(())
    }

    fn push_range(&mut self, range: ContourRange) -> Result<(), BridgeError> {
        if self.range_len >= MAX_CONTOURS {
            return Err(BridgeError::ContourLimit);
        }
        self.contour_ranges[self.range_len] = range;
        self.range_len += 1;
        Ok(())
    }

    fn validate_leaf_partitions(&self, row: &SourceRow) -> Result<(), BridgeError> {
        let mut previous_source = None;
        for command in &self.commands[..self.command_len] {
            if command.verb != VERB_LINE {
                continue;
            }
            if previous_source.is_some_and(|source| command.provenance.source_verb < source) {
                return Err(BridgeError::InvalidProvenance);
            }
            previous_source = Some(command.provenance.source_verb);
        }
        for (ordinal, source) in row.source_verbs.iter().enumerate() {
            if !matches!(source, SourceVerb::Cubic { .. }) {
                continue;
            }
            let ordinal = u32::try_from(ordinal).map_err(|_| BridgeError::InvalidProvenance)?;
            let mut previous_numerator = 0u64;
            let mut previous_denominator = 1u64;
            let mut count = 0usize;
            for command in &self.commands[..self.command_len] {
                if command.verb != VERB_LINE || command.provenance.source_verb != ordinal {
                    continue;
                }
                if command.provenance.depth > 20 {
                    return Err(BridgeError::InvalidProvenance);
                }
                let denominator = 1u64 << command.provenance.depth;
                let numerator = u64::from(command.provenance.end_numerator);
                if numerator == 0
                    || numerator > denominator
                    || previous_numerator * denominator != (numerator - 1) * previous_denominator
                {
                    return Err(BridgeError::InvalidProvenance);
                }
                previous_numerator = numerator;
                previous_denominator = denominator;
                count += 1;
            }
            if count == 0 || previous_numerator != previous_denominator {
                return Err(BridgeError::InvalidProvenance);
            }
        }
        Ok(())
    }

    fn validate_rounded_ownership(&self) -> Result<(), BridgeError> {
        let output = self.rounded.output().ok_or(BridgeError::RoundedOwnership)?;
        if output.source_edges.len() != self.owner_len {
            return Err(BridgeError::RoundedOwnership);
        }
        let mut edge_index = 0usize;
        for (contour, range) in self.contour_ranges[..self.range_len]
            .iter()
            .copied()
            .enumerate()
        {
            for start_vertex in 0..range.count {
                let source = output
                    .source_edges
                    .get(edge_index)
                    .ok_or(BridgeError::RoundedOwnership)?;
                if source.contour != contour
                    || source.start_vertex != start_vertex
                    || source.end_vertex != (start_vertex + 1) % range.count
                {
                    return Err(BridgeError::RoundedOwnership);
                }
                match self.edge_owners[edge_index] {
                    EdgeOwner::CubicLeaf { source_verb, .. } => {
                        if !self.commands[..self.command_len].iter().any(|command| {
                            command.verb == VERB_LINE
                                && command.provenance.source_verb == source_verb
                        }) {
                            return Err(BridgeError::RoundedOwnership);
                        }
                    }
                    EdgeOwner::ImplicitClosure { contour: owner } if owner == contour => {}
                    EdgeOwner::ImplicitClosure { .. } => {
                        return Err(BridgeError::RoundedOwnership);
                    }
                }
                edge_index += 1;
            }
        }
        if edge_index != self.owner_len
            || output
                .contributors
                .iter()
                .any(|owner| *owner >= self.owner_len)
        {
            return Err(BridgeError::RoundedOwnership);
        }
        Ok(())
    }

    fn output(&self) -> Option<BridgeOutput<'_>> {
        if !self.published {
            return None;
        }
        Some(BridgeOutput {
            commands: &self.commands[..self.command_len],
            ranges: &self.contour_ranges[..self.range_len],
            points: &self.contour_points[..self.point_len],
            owners: &self.edge_owners[..self.owner_len],
            rounded: self.rounded.output()?,
            rounded_stats: self.rounded.stats(),
        })
    }
}

fn source_verb(row: &SourceRow, ordinal: u32) -> Result<SourceVerb, BridgeError> {
    row.source_verbs
        .get(usize::try_from(ordinal).map_err(|_| BridgeError::InvalidProvenance)?)
        .copied()
        .ok_or(BridgeError::InvalidProvenance)
}

fn same_bounds_bits(left: Bounds, right: Bounds) -> bool {
    left.min_x.to_bits() == right.min_x.to_bits()
        && left.min_y.to_bits() == right.min_y.to_bits()
        && left.max_x.to_bits() == right.max_x.to_bits()
        && left.max_y.to_bits() == right.max_y.to_bits()
}

fn same_point(left: Point, right: Point) -> bool {
    left.x == right.x && left.y == right.y
}

fn same_point_bits(left: Point, right: Point) -> bool {
    left.x.to_bits() == right.x.to_bits() && left.y.to_bits() == right.y.to_bits()
}

fn finite_point(point: Point) -> bool {
    point.x.is_finite() && point.y.is_finite()
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
        source_verbs: Vec::new(),
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
    let mut source_verbs = Vec::new();
    for (contour_index, contour) in row.contours.iter().enumerate() {
        let first = contour
            .cubics
            .first()
            .ok_or_else(|| "empty contour".to_owned())?
            .points[0];
        push_source_verb(
            &mut verbs,
            &mut source_verbs,
            VERB_MOVE,
            SourceVerb::Move {
                contour: contour_index,
                point: first,
            },
        );
        push_point_bytes(&mut point_bytes, first);
        for cubic in &contour.cubics {
            push_source_verb(
                &mut verbs,
                &mut source_verbs,
                VERB_CUBIC,
                SourceVerb::Cubic {
                    contour: contour_index,
                },
            );
            for point in &cubic.points[1..] {
                push_point_bytes(&mut point_bytes, *point);
            }
        }
        let last = contour.cubics.last().unwrap().points[3];
        if same_point(first, last) {
            push_source_verb(
                &mut verbs,
                &mut source_verbs,
                VERB_CLOSE,
                SourceVerb::Close {
                    contour: contour_index,
                },
            );
        }
    }
    row.verbs = verbs;
    row.point_bytes = point_bytes;
    row.source_verbs = source_verbs;
    Ok(())
}

fn push_source_verb(
    verbs: &mut Vec<u8>,
    source_verbs: &mut Vec<SourceVerb>,
    verb: u8,
    source: SourceVerb,
) {
    verbs.push(verb);
    source_verbs.push(source);
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

#[test]
#[ignore]
fn emit_native_cubic_fill() {
    let rows = load_fixture();
    let mut workspace = BridgeWorkspace::new(LIMITS).expect("construct native cubic workspace");
    let allocated_bytes = workspace.allocated_bytes();
    let inline_bytes = size_of::<BridgeWorkspace>();
    assert!(inline_bytes < 64 * 1024);
    println!("P3_NATIVE_CUBIC_BEGIN");
    for row in &rows {
        crate::allocation_test_support::start();
        let attempt = workspace.attempt(row, TOPOLOGY_TOLERANCE, MAX_COMMANDS);
        let allocations = crate::allocation_test_support::stop();
        let diagnostics = attempt.unwrap_or_else(|error| panic!("{} failed: {error:?}", row.id));
        let output = workspace.output();
        match row.expectation {
            ExpectedStatus::Ok => {
                assert_eq!(diagnostics.flat_status, PATH_OK, "{}", row.id);
                assert!(diagnostics.emission_plan.is_some(), "{}", row.id);
                assert!(output.is_some(), "{}", row.id);
            }
            ExpectedStatus::PathNumericRange => {
                assert_eq!(diagnostics.flat_status, PATH_NUMERIC_RANGE, "{}", row.id);
                assert!(diagnostics.emission_plan.is_none(), "{}", row.id);
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
    println!("P3_NATIVE_CUBIC_END");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn measured_attempt(
        workspace: &mut BridgeWorkspace,
        row: &SourceRow,
        topology_tolerance: f64,
        command_capacity: usize,
    ) -> Result<AttemptDiagnostics, BridgeError> {
        let bytes = workspace.allocated_bytes();
        crate::allocation_test_support::start();
        let result = workspace.attempt(row, topology_tolerance, command_capacity);
        let allocations = crate::allocation_test_support::stop();
        assert_eq!(allocations, 0, "bridge attempt allocated");
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
            source_verbs: Vec::new(),
        };
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
    fn attempt_is_allocation_free_and_owns_every_edge() {
        let row = square_row(1.0);
        let mut workspace = BridgeWorkspace::new(LIMITS).unwrap();
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
