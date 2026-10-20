//! P3 Alt-A1 unit AL-U2 (`docs/plans/p3-alt-a1-fill-ladder-contract.md` section 4.2): the
//! hand-off of the permanent oracles, `emit_fill_ladder_dump`.
//!
//! The ignored test reads the `P3FLDIN1` input named by `P3_FILL_LADDER_INPUT` (written by
//! `tests/geometry/p3-fill-ladder/corpus.ts`) and writes one framed JSON line per entry to the
//! new file named by `P3_FILL_LADDER_DUMP`. A real path runs:
//!
//! - the ladder, `FillLadder::run` (rung 0, then on a fallback V2's unchanged cascade), with a
//!   tracking-allocator window around the call: rung, reason, certified bound, fast mesh and
//!   the edges used once that AL-FR9's scan derived;
//! - the S1 prefix alone, for the path's S1 view;
//! - the exact rung alone (`exact_cascade` on its own workspace, the module-level counterpart of
//!   AL-U3's `exact_only`): its topology step, status, published polygon and mesh, and whether
//!   the ladder's own exact result equals it (AL-I2 at module level);
//! - the frozen spike's rung 0 at the path's own δ (AL-I3);
//! - the export, one `FillEngine::process` call on the one-path batch: its status, positions,
//!   indices and boundary pairs. With `fill_v0_revision()` 1 the export does not run the ladder
//!   yet, so the oracles read the module's fast mesh; from revision 2 they read the export's.
//!
//! A synthetic view runs rung 0 alone, `FastRung::load` and `run(Stage::Fr9)`, and the spike's
//! rung 0. Faults listed with an entry are switched on around the whole entry.
//!
//! `OnceScan` is AL-FR9 item 2 for test harnesses: a statement-for-statement copy of V2's
//! `FillScratch::collect_boundary` on its own reserved buffers, as `fill_ladder_tests.rs`'s
//! `TestScan` is (that one is private to its file). `fill_ladder_identity.rs` uses it too.
use std::env;
use std::fmt::Write as _;
use std::fs::OpenOptions;
use std::io::Write as _;

use crate::codec::{PathInput, Request};
use crate::cubic_fill::{
    ContourRange, CubicFillDiagnostics, CubicFillError, CubicFillWorkspace, DecodedSource,
    EdgeOwner, S1View, MAX_FLAT_COMMANDS,
};
use crate::engine::BATCH_OK;
use crate::fill_export::{
    tolerances, FillEngine, FillRequest, FILL_INPUT_MAGIC, FILL_V0_REVISION, PRE_B1_FILL_V0_LIMITS,
};
use crate::fill_ladder::{
    exact_cascade, with_ladder_faults, BoundaryScan, ExactOutcome, ExactStep, FastRung, FillLadder,
    LadderFault, Reason, Rung, Stage, MAX_BOUNDARY_RECORDS,
};
use crate::geometry::Point;
use crate::line_fill::LineFillRule;
use crate::p3_b0_bench::Reader;
use crate::p3_b0_spike;

const INPUT_MAGIC: &[u8; 8] = b"P3FLDIN1";
const DUMP_SCHEMA: &str = "p3-fill-ladder-dump/1";
const FRAME_BEGIN: &str = "P3_FILL_LADDER_DUMP_BEGIN";
const FRAME_END: &str = "P3_FILL_LADDER_DUMP_END";
const ENGINE_INPUT_BYTES: u32 = 64 * 1024;
const ENGINE_OUTPUT_BYTES: u32 = 1024 * 1024;
const OUTPUT_HEADER_BYTES: usize = 64;

// ------------------------------------------------------------------------------------------
// AL-FR9 item 2 for the harnesses: a copy of V2's `FillScratch::collect_boundary`.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct DirectedEdge {
    low: u32,
    high: u32,
    position: u32,
    forward: bool,
}

const UNUSED_PAIR: [u32; 2] = [u32::MAX, u32::MAX];

/// The once-only scan of V2 section f on reserved buffers: same records, same sort key, same
/// group rule (one record: boundary; two of opposite direction: interior; otherwise failure).
pub(crate) struct OnceScan {
    edges: Vec<DirectedEdge>,
    boundary: Vec<[u32; 2]>,
}

impl OnceScan {
    pub(crate) fn new() -> Self {
        Self {
            edges: Vec::with_capacity(MAX_BOUNDARY_RECORDS),
            boundary: Vec::with_capacity(MAX_BOUNDARY_RECORDS),
        }
    }

    /// The edges used once of the last successful scan, in triangle order.
    pub(crate) fn boundary(&self) -> &[[u32; 2]] {
        &self.boundary
    }
}

impl BoundaryScan for OnceScan {
    fn scan(&mut self, triangles: &[u32]) -> Option<&[[u32; 2]]> {
        self.edges.clear();
        self.boundary.clear();
        let slots = triangles.len();
        if slots > self.edges.capacity() || slots > self.boundary.capacity() {
            return None;
        }
        for position in 0..slots {
            let triangle = position - position % 3;
            let a = triangles[position];
            let b = triangles[triangle + (position % 3 + 1) % 3];
            if a == b {
                return None;
            }
            self.edges.push(DirectedEdge {
                low: a.min(b),
                high: a.max(b),
                position: u32::try_from(position).ok()?,
                forward: a < b,
            });
            self.boundary.push(UNUSED_PAIR);
        }
        self.edges
            .sort_unstable_by_key(|edge| (edge.low, edge.high, edge.position));
        let mut cursor = 0usize;
        while cursor < self.edges.len() {
            let first = self.edges[cursor];
            let mut end = cursor + 1;
            while end < self.edges.len()
                && self.edges[end].low == first.low
                && self.edges[end].high == first.high
            {
                end += 1;
            }
            match end - cursor {
                1 => {
                    let position = first.position as usize;
                    let triangle = position - position % 3;
                    self.boundary[position] = [
                        triangles[position],
                        triangles[triangle + (position % 3 + 1) % 3],
                    ];
                }
                2 if self.edges[cursor + 1].forward != first.forward => {}
                _ => return None,
            }
            cursor = end;
        }
        let mut written = 0usize;
        for position in 0..self.boundary.len() {
            let pair = self.boundary[position];
            if pair != UNUSED_PAIR {
                self.boundary[written] = pair;
                written += 1;
            }
        }
        self.boundary.truncate(written);
        Some(&self.boundary)
    }
}

// ------------------------------------------------------------------------------------------
// The `P3FLDIN1` input.

/// Every `LadderFault` variant, matched by its `Debug` name in the input.
const FAULTS: [LadderFault; 16] = [
    LadderFault::ClearanceGreaterEqual,
    LadderFault::KnotErrorsOmitted,
    LadderFault::MonotoneChordsOnly,
    LadderFault::SimplicityOnly,
    LadderFault::ConeInverted,
    LadderFault::NestingFromOrientation,
    LadderFault::TriangleFlipped,
    LadderFault::NonBoundaryTriangulated,
    LadderFault::ScanBoundWithoutRadius,
    LadderFault::SkipTwoApart,
    LadderFault::AlM5Omitted,
    LadderFault::RangeOmitted,
    LadderFault::MeshCheckItem3Disabled,
    LadderFault::TriangleDropped,
    LadderFault::VertexSubstituted,
    LadderFault::Fr7OrientationRejected,
];

#[derive(Clone, Debug)]
pub(crate) struct OwnedView {
    ranges: Vec<ContourRange>,
    points: Vec<Point>,
    owners: Vec<EdgeOwner>,
    sources: Vec<DecodedSource>,
}

impl OwnedView {
    fn view(&self) -> S1View<'_> {
        S1View {
            commands: &[],
            ranges: &self.ranges,
            points: &self.points,
            owners: &self.owners,
            sources: &self.sources,
        }
    }

    fn spike_view(&self) -> p3_b0_spike::S1View<'_> {
        p3_b0_spike::S1View {
            commands: &[],
            ranges: &self.ranges,
            points: &self.points,
            owners: &self.owners,
            sources: &self.sources,
        }
    }
}

pub(crate) enum Body {
    Path {
        verbs: Vec<u8>,
        point_bytes: Vec<u8>,
    },
    View(OwnedView),
}

pub(crate) struct InputEntry {
    pub(crate) name: String,
    pub(crate) rule: LineFillRule,
    pub(crate) exponent: i32,
    pub(crate) faults: Vec<LadderFault>,
    pub(crate) body: Body,
}

fn i32_le(reader: &mut Reader<'_>) -> i32 {
    i32::from_le_bytes(reader.take(4).try_into().expect("i32 width"))
}

fn f64_le(reader: &mut Reader<'_>) -> f64 {
    f64::from_le_bytes(reader.take(8).try_into().expect("f64 width"))
}

fn text(reader: &mut Reader<'_>) -> String {
    let length = reader.u32();
    String::from_utf8(reader.take(length).to_vec()).expect("UTF-8 text")
}

fn point(reader: &mut Reader<'_>) -> Point {
    let x = f64_le(reader);
    let y = f64_le(reader);
    Point { x, y }
}

fn u32_field(reader: &mut Reader<'_>) -> u32 {
    u32::try_from(reader.u32()).expect("u32 field")
}

/// Parses a `P3FLDIN1` input (frame documented in `tests/geometry/p3-fill-ladder/corpus.ts`).
pub(crate) fn read_input(bytes: &[u8]) -> Vec<InputEntry> {
    let mut reader = Reader { bytes, offset: 0 };
    assert_eq!(reader.take(8), INPUT_MAGIC, "dump input magic");
    let count = reader.u32();
    let mut entries = Vec::with_capacity(count);
    for _ in 0..count {
        let name = text(&mut reader);
        let kind = reader.u8();
        let rule = match reader.u8() {
            0 => LineFillRule::Nonzero,
            1 => LineFillRule::Evenodd,
            other => panic!("unknown fill rule {other}"),
        };
        let exponent = i32_le(&mut reader);
        let faults = text(&mut reader)
            .split(',')
            .filter(|item| !item.is_empty())
            .map(|item| {
                *FAULTS
                    .iter()
                    .find(|fault| format!("{fault:?}") == item)
                    .unwrap_or_else(|| panic!("unknown fault {item}"))
            })
            .collect();
        let body = match kind {
            0 => {
                let verb_count = reader.u32();
                let verbs = reader.take(verb_count).to_vec();
                let scalars = reader.u32();
                let point_bytes = reader.take(scalars * 8).to_vec();
                Body::Path { verbs, point_bytes }
            }
            1 => {
                let ranges = (0..reader.u32())
                    .map(|_| ContourRange {
                        start: reader.u32(),
                        count: reader.u32(),
                    })
                    .collect();
                let points = (0..reader.u32()).map(|_| point(&mut reader)).collect();
                let owners = (0..reader.u32())
                    .map(|_| {
                        let tag = reader.u8();
                        let (a, b, c) = (
                            u32_field(&mut reader),
                            u32_field(&mut reader),
                            u32_field(&mut reader),
                        );
                        match tag {
                            0 => EdgeOwner::Line { source_verb: a },
                            1 => EdgeOwner::CubicLeaf {
                                source_verb: a,
                                end_numerator: b,
                                depth: c,
                            },
                            2 => EdgeOwner::ImplicitClosure {
                                contour: a as usize,
                            },
                            3 => EdgeOwner::ExplicitClose { source_verb: a },
                            other => panic!("unknown owner tag {other}"),
                        }
                    })
                    .collect();
                let sources = (0..reader.u32())
                    .map(|_| {
                        let tag = reader.u8();
                        let source_verb = u32_field(&mut reader);
                        let contour = reader.u32();
                        match tag {
                            0 => DecodedSource::Line {
                                points: [point(&mut reader), point(&mut reader)],
                                source_verb,
                                contour,
                            },
                            1 => DecodedSource::Cubic {
                                points: [
                                    point(&mut reader),
                                    point(&mut reader),
                                    point(&mut reader),
                                    point(&mut reader),
                                ],
                                source_verb,
                                contour,
                            },
                            other => panic!("unknown source tag {other}"),
                        }
                    })
                    .collect();
                Body::View(OwnedView {
                    ranges,
                    points,
                    owners,
                    sources,
                })
            }
            other => panic!("unknown entry kind {other}"),
        };
        entries.push(InputEntry {
            name,
            rule,
            exponent,
            faults,
            body,
        });
    }
    assert_eq!(reader.offset, bytes.len(), "trailing dump input bytes");
    entries
}

// ------------------------------------------------------------------------------------------
// JSON, in the field shapes of the spike hand-off (`p3-b0-spike-fixtures/1`).

fn hex(value: f64) -> String {
    format!("\"{:016x}\"", value.to_bits())
}

fn json_string(value: &str) -> String {
    let mut out = String::from("\"");
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            other if (other as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", other as u32);
            }
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

fn json_points(points: &[Point]) -> String {
    let items: Vec<String> = points
        .iter()
        .map(|point| format!("[{},{}]", hex(point.x), hex(point.y)))
        .collect();
    format!("[{}]", items.join(","))
}

fn json_view(
    ranges: &[ContourRange],
    points: &[Point],
    owners: &[EdgeOwner],
    sources: &[DecodedSource],
) -> String {
    let ranges: Vec<String> = ranges
        .iter()
        .map(|range| format!("[{},{}]", range.start, range.count))
        .collect();
    let owners: Vec<String> = owners
        .iter()
        .map(|owner| match *owner {
            EdgeOwner::Line { source_verb } => {
                format!("{{\"kind\":\"line\",\"sourceVerb\":{source_verb}}}")
            }
            EdgeOwner::CubicLeaf {
                source_verb,
                end_numerator,
                depth,
            } => format!(
                "{{\"kind\":\"cubicLeaf\",\"sourceVerb\":{source_verb},\"endNumerator\":{end_numerator},\"depth\":{depth}}}"
            ),
            EdgeOwner::ImplicitClosure { contour } => {
                format!("{{\"kind\":\"implicitClosure\",\"contour\":{contour}}}")
            }
            EdgeOwner::ExplicitClose { source_verb } => {
                format!("{{\"kind\":\"explicitClose\",\"sourceVerb\":{source_verb}}}")
            }
        })
        .collect();
    let sources: Vec<String> = sources
        .iter()
        .map(|source| {
            let (kind, points, source_verb, contour): (&str, &[Point], u32, usize) = match source {
                DecodedSource::Line {
                    points,
                    source_verb,
                    contour,
                } => ("line", points, *source_verb, *contour),
                DecodedSource::Cubic {
                    points,
                    source_verb,
                    contour,
                } => ("cubic", points, *source_verb, *contour),
            };
            format!(
                "{{\"kind\":\"{kind}\",\"sourceVerb\":{source_verb},\"contour\":{contour},\"points\":{}}}",
                json_points(points)
            )
        })
        .collect();
    format!(
        "{{\"ranges\":[{}],\"points\":{},\"owners\":[{}],\"sources\":[{}]}}",
        ranges.join(","),
        json_points(points),
        owners.join(","),
        sources.join(",")
    )
}

fn json_triangles(triangles: impl Iterator<Item = [u32; 3]>) -> String {
    let items: Vec<String> = triangles
        .map(|[a, b, c]| format!("[{a},{b},{c}]"))
        .collect();
    format!("[{}]", items.join(","))
}

fn json_pairs(pairs: &[[u32; 2]]) -> String {
    let items: Vec<String> = pairs.iter().map(|[a, b]| format!("[{a},{b}]")).collect();
    format!("[{}]", items.join(","))
}

fn json_mesh(vertices: &[Point], triangles: impl Iterator<Item = [u32; 3]>) -> String {
    format!(
        "{{\"vertices\":{},\"triangles\":{}}}",
        json_points(vertices),
        json_triangles(triangles)
    )
}

fn rule_name(rule: LineFillRule) -> &'static str {
    match rule {
        LineFillRule::Nonzero => "nonzero",
        LineFillRule::Evenodd => "evenodd",
    }
}

type OwnedMesh = (Vec<(u64, u64)>, Vec<[u32; 3]>);

fn owned_mesh(mesh: Option<(&[Point], &[[u32; 3]])>) -> Option<OwnedMesh> {
    mesh.map(|(vertices, triangles)| {
        (
            vertices
                .iter()
                .map(|point| (point.x.to_bits(), point.y.to_bits()))
                .collect(),
            triangles.to_vec(),
        )
    })
}

/// B0's status code of an exact result: OK only for a published nonempty mesh.
fn exact_status(
    workspace: &CubicFillWorkspace,
    result: Result<CubicFillDiagnostics, CubicFillError>,
) -> String {
    match result {
        Err(error) => format!("{error:?}"),
        Ok(diagnostics) => match workspace.output() {
            Some(output)
                if !output.rounded.vertices.is_empty() && !output.rounded.indices.is_empty() =>
            {
                "OK".to_owned()
            }
            Some(_) => "EMPTY_MESH".to_owned(),
            None => format!("NO_MESH(flat_status={})", diagnostics.flat_status),
        },
    }
}

/// The exact rung's result as JSON: step, status, published polygon and mesh.
fn json_exact(workspace: &CubicFillWorkspace, outcome: ExactOutcome) -> String {
    let step = match outcome.step {
        ExactStep::Legacy => "Legacy",
        ExactStep::TriangleFree => "TriangleFree",
    };
    let (published, mesh) = match workspace.output() {
        Some(output) => (
            json_view(output.ranges, output.points, output.owners, output.sources),
            json_mesh(
                output.rounded.vertices,
                output
                    .rounded
                    .indices
                    .chunks(3)
                    .map(|chunk| [chunk[0], chunk[1], chunk[2]]),
            ),
        ),
        None => ("null".to_owned(), "null".to_owned()),
    };
    format!(
        "{{\"step\":\"{step}\",\"status\":{},\"published\":{published},\"mesh\":{mesh}}}",
        json_string(&exact_status(workspace, outcome.result))
    )
}

// ------------------------------------------------------------------------------------------
// One entry.

/// The spike's rung 0 on one S1 view at δ, stopped after `stop`.
fn spike_view_rung(
    spike: &mut p3_b0_spike::FastRung,
    view: p3_b0_spike::S1View<'_>,
    delta: f64,
    rule: LineFillRule,
    stop: p3_b0_spike::Stage,
) -> Result<(), &'static str> {
    spike
        .load(view, delta, rule)
        .and_then(|()| spike.run(stop))
        .map_err(p3_b0_spike::Reason::code)
}

/// The spike's rung 0 and FR3 result as JSON, compared with the production outcome.
fn json_spike(
    spike: Result<(), &'static str>,
    spike_mesh: Option<OwnedMesh>,
    passes_fr3: bool,
    production: Result<(), Reason>,
    production_mesh: &Option<OwnedMesh>,
) -> String {
    let (rung, reason) = match spike {
        Ok(()) => ("fast", "null".to_owned()),
        Err(code) => ("fallback", json_string(code)),
    };
    let same_mesh = production.is_ok() && spike.is_ok() && spike_mesh == *production_mesh;
    format!(
        "{{\"rung\":\"{rung}\",\"reason\":{reason},\"sameMesh\":{same_mesh},\"passesFr3\":{passes_fr3}}}"
    )
}

/// A one-path fill-v0 input (V2 contract section a).
fn pack(rule: LineFillRule, exponent: i32, verbs: &[u8], point_bytes: &[u8]) -> Vec<u8> {
    let requests = 48usize;
    let path_offsets = requests + 16;
    let point_offsets = path_offsets + 8;
    let verbs_offset = point_offsets + 8;
    let points_offset = (verbs_offset + verbs.len()).next_multiple_of(8);
    let total = points_offset + point_bytes.len();
    let as_u32 = |value: usize| u32::try_from(value).expect("fill-v0 field fits u32");
    let mut bytes = vec![0u8; total];
    let mut put = |offset: usize, value: u32| {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    };
    let header = [
        FILL_INPUT_MAGIC,
        0,
        as_u32(total),
        1,
        as_u32(verbs.len()),
        as_u32(point_bytes.len() / 8),
        as_u32(requests),
        as_u32(path_offsets),
        as_u32(point_offsets),
        as_u32(verbs_offset),
        as_u32(points_offset),
        0,
    ];
    for (index, value) in header.into_iter().enumerate() {
        put(index * 4, value);
    }
    put(requests + 4, u32::from(rule == LineFillRule::Evenodd));
    put(requests + 8, exponent as u32);
    put(path_offsets + 4, as_u32(verbs.len()));
    put(point_offsets + 4, as_u32(point_bytes.len() / 8));
    bytes[verbs_offset..verbs_offset + verbs.len()].copy_from_slice(verbs);
    bytes[points_offset..].copy_from_slice(point_bytes);
    bytes
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("u32 width"))
}

/// The export's result on a one-path batch: batch and path status, and on `ok` the block's
/// positions, indices and boundary pairs, decoded as V2 section g lays them out.
fn json_export(engine: &mut FillEngine, input: &[u8]) -> String {
    engine.input_bytes_mut()[..input.len()].copy_from_slice(input);
    let status = engine.process(u32::try_from(input.len()).expect("input length"));
    if status != BATCH_OK {
        return format!("{{\"batchStatus\":{status},\"pathStatus\":null,\"positions\":null,\"triangles\":null,\"boundaryEdges\":null}}");
    }
    let output = engine.output_bytes();
    let record = OUTPUT_HEADER_BYTES;
    let path_status = read_u32(output, record + 4);
    if path_status != 0 {
        return format!("{{\"batchStatus\":{status},\"pathStatus\":{path_status},\"positions\":null,\"triangles\":null,\"boundaryEdges\":null}}");
    }
    let offset = read_u32(output, record + 16) as usize;
    let vertices = read_u32(output, record + 20) as usize;
    let indices = read_u32(output, record + 24) as usize;
    let boundary = read_u32(output, record + 28) as usize;
    let positions: Vec<Point> = (0..vertices)
        .map(|index| {
            let at = offset + 16 * index;
            Point {
                x: f64::from_le_bytes(output[at..at + 8].try_into().expect("x")),
                y: f64::from_le_bytes(output[at + 8..at + 16].try_into().expect("y")),
            }
        })
        .collect();
    let index_start = offset + 16 * vertices;
    let triangles: Vec<[u32; 3]> = (0..indices / 3)
        .map(|triangle| {
            let at = index_start + 12 * triangle;
            [
                read_u32(output, at),
                read_u32(output, at + 4),
                read_u32(output, at + 8),
            ]
        })
        .collect();
    let pair_start = index_start + 4 * indices;
    let pairs: Vec<[u32; 2]> = (0..boundary / 2)
        .map(|pair| {
            let at = pair_start + 8 * pair;
            [read_u32(output, at), read_u32(output, at + 4)]
        })
        .collect();
    format!(
        "{{\"batchStatus\":{status},\"pathStatus\":0,\"positions\":{},\"triangles\":{},\"boundaryEdges\":{}}}",
        json_points(&positions),
        json_triangles(triangles.into_iter()),
        json_pairs(&pairs)
    )
}

/// The harness of one dump run: every workspace reserved once.
pub(crate) struct DumpHarness {
    ladder: FillLadder,
    workspace: CubicFillWorkspace,
    probe: CubicFillWorkspace,
    exact: CubicFillWorkspace,
    spike_workspace: CubicFillWorkspace,
    fast: Box<FastRung>,
    spike: Box<p3_b0_spike::FastRung>,
    scan: OnceScan,
    engine: FillEngine,
}

impl DumpHarness {
    pub(crate) fn new() -> Self {
        let mut engine = FillEngine::new();
        // B1: the AL-U2 oracle dump (SL-O1 to SL-O3, AL-I3 against the frozen spike) runs at
        // the pre-B1 caps, so it compares like with like.
        engine.hooks().pre_b1_caps = true;
        assert_eq!(
            engine.reserve(ENGINE_INPUT_BYTES, ENGINE_OUTPUT_BYTES),
            BATCH_OK,
            "reserve the fill-v0 engine"
        );
        let workspace =
            || CubicFillWorkspace::new_pre_b1(PRE_B1_FILL_V0_LIMITS).expect("workspace");
        Self {
            ladder: FillLadder::reserve(PRE_B1_FILL_V0_LIMITS).expect("ladder"),
            workspace: workspace(),
            probe: workspace(),
            exact: workspace(),
            spike_workspace: workspace(),
            fast: Box::new(FastRung::new()),
            spike: Box::new(p3_b0_spike::FastRung::new()),
            scan: OnceScan::new(),
            engine,
        }
    }

    /// One dump line (without the newline).
    pub(crate) fn entry(&mut self, entry: &InputEntry) -> String {
        with_ladder_faults(&entry.faults, || match &entry.body {
            Body::Path { verbs, point_bytes } => self.path(entry, verbs, point_bytes),
            Body::View(view) => self.view(entry, view),
        })
    }

    fn head(entry: &InputEntry, kind: &str) -> String {
        let faults: Vec<String> = entry
            .faults
            .iter()
            .map(|fault| json_string(&format!("{fault:?}")))
            .collect();
        format!(
            "\"name\":{},\"kind\":\"{kind}\",\"rule\":\"{}\",\"exponent\":{},\"faults\":[{}]",
            json_string(&entry.name),
            rule_name(entry.rule),
            entry.exponent,
            faults.join(",")
        )
    }

    fn rung_fields(
        result: Result<(), Reason>,
        fast: &FastRung,
        mesh: &Option<OwnedMesh>,
        boundary: Option<&[[u32; 2]]>,
        allocations: usize,
    ) -> String {
        let stats = fast.stats();
        let (rung, reason) = match result {
            Ok(()) => ("fast", "null".to_owned()),
            Err(reason) => ("fallback", json_string(reason.code())),
        };
        let (fast_mesh, bound, pairs) = match (fast.mesh(), boundary) {
            (Some((vertices, triangles)), Some(pairs)) if mesh.is_some() => (
                json_mesh(vertices, triangles.iter().copied()),
                hex(stats.max_deviation_squared),
                json_pairs(pairs),
            ),
            _ => ("null".to_owned(), "null".to_owned(), "null".to_owned()),
        };
        format!(
            "\"rung\":\"{rung}\",\"reason\":{reason},\"meshCheckItem\":{},\"allocations\":{allocations},\"maxDeviationSquared\":{bound},\"fastMesh\":{fast_mesh},\"boundaryEdges\":{pairs}",
            stats.mesh_check_item
        )
    }

    fn view(&mut self, entry: &InputEntry, view: &OwnedView) -> String {
        let delta = tolerances(entry.exponent).0;
        crate::allocation_test_support::start();
        let result = self
            .fast
            .load(view.view(), delta, entry.rule)
            .and_then(|()| self.fast.run(Stage::Fr9, &mut self.scan));
        let allocations = crate::allocation_test_support::stop();
        let mesh = owned_mesh(self.fast.mesh());
        let rung = Self::rung_fields(
            result,
            &self.fast,
            &mesh,
            Some(self.scan.boundary()),
            allocations,
        );
        let spike = spike_view_rung(
            &mut self.spike,
            view.spike_view(),
            delta,
            entry.rule,
            p3_b0_spike::Stage::Fr8,
        );
        let spike_mesh = owned_mesh(self.spike.mesh());
        let passes_fr3 = spike_view_rung(
            &mut self.spike,
            view.spike_view(),
            delta,
            entry.rule,
            p3_b0_spike::Stage::Fr3,
        )
        .is_ok();
        format!(
            "{{{},{rung},\"view\":{},\"prefixFailure\":null,\"spike\":{},\"exact\":null,\"export\":null}}",
            Self::head(entry, "view"),
            json_view(&view.ranges, &view.points, &view.owners, &view.sources),
            json_spike(spike, spike_mesh, passes_fr3, result, &mesh)
        )
    }

    fn path(&mut self, entry: &InputEntry, verbs: &[u8], point_bytes: &[u8]) -> String {
        assert!(
            (-1021..=1023).contains(&entry.exponent),
            "{}: exponent outside fill-v0's range",
            entry.name
        );
        let request = FillRequest {
            request_id: 0,
            rule: entry.rule,
            exponent: entry.exponent,
        };
        // The ladder: rung 0, then the exact cascade on a fallback.
        crate::allocation_test_support::start();
        let outcome = self.ladder.run(
            &mut self.workspace,
            request,
            verbs,
            point_bytes,
            &mut self.scan,
        );
        let allocations = crate::allocation_test_support::stop();
        let result = match (outcome.rung, outcome.reason) {
            (Rung::Fast, _) => Ok(()),
            (Rung::Exact, Some(reason)) => Err(reason),
            (Rung::Exact, None) => panic!("{}: fallback without a reason", entry.name),
        };
        let mesh = owned_mesh(self.ladder.mesh());
        let rung = Self::rung_fields(
            result,
            self.ladder.fast(),
            &mesh,
            Some(self.scan.boundary()),
            allocations,
        );
        let ladder_exact = outcome
            .exact
            .map(|exact| json_exact(&self.workspace, exact));

        // The S1 view alone.
        let (flatten, _) = tolerances(entry.exponent);
        let input = PathInput::from_parts(
            Request {
                request_id: 0,
                source_epoch: 0,
                source_revision: 0,
                tolerance: flatten,
            },
            verbs,
            point_bytes,
        );
        let (view, prefix_failure) = match self.probe.prepare_prefix(input, MAX_FLAT_COMMANDS) {
            Ok(view) => (
                json_view(view.ranges, view.points, view.owners, view.sources),
                "null".to_owned(),
            ),
            Err(failure) => ("null".to_owned(), json_string(&format!("{failure:?}"))),
        };

        // The exact rung alone, and whether the ladder's exact result equals it (AL-I2).
        let direct = exact_cascade(&mut self.exact, request, verbs, point_bytes);
        let exact = json_exact(&self.exact, direct);
        let ladder_agrees = match ladder_exact {
            None => outcome.exact.is_none(),
            Some(text) => outcome.exact == Some(direct) && text == exact,
        };

        // The frozen spike's rung 0 at the path's own δ.
        let spike = match self
            .spike_workspace
            .prepare_for_spike(input, MAX_FLAT_COMMANDS)
        {
            Ok(view) => spike_view_rung(
                &mut self.spike,
                view,
                flatten,
                entry.rule,
                p3_b0_spike::Stage::Fr8,
            ),
            Err(_) => Err("PREFIX"),
        };
        let spike_mesh = owned_mesh(self.spike.mesh());
        let passes_fr3 = match self
            .spike_workspace
            .prepare_for_spike(input, MAX_FLAT_COMMANDS)
        {
            Ok(view) => spike_view_rung(
                &mut self.spike,
                view,
                flatten,
                entry.rule,
                p3_b0_spike::Stage::Fr3,
            )
            .is_ok(),
            Err(_) => false,
        };

        // The export on the one-path batch.
        let export = json_export(
            &mut self.engine,
            &pack(entry.rule, entry.exponent, verbs, point_bytes),
        );
        format!(
            "{{{},{rung},\"view\":{view},\"prefixFailure\":{prefix_failure},\"spike\":{},\"exact\":{exact},\"ladderExactAgrees\":{ladder_agrees},\"export\":{export}}}",
            Self::head(entry, "path"),
            json_spike(spike, spike_mesh, passes_fr3, result, &mesh)
        )
    }
}

/// The whole framed dump of `entries`.
pub(crate) fn dump(entries: &[InputEntry]) -> String {
    let mut harness = DumpHarness::new();
    let mut out = format!(
        "{FRAME_BEGIN}\n{{\"schema\":\"{DUMP_SCHEMA}\",\"revision\":{FILL_V0_REVISION},\"entries\":{}}}\n",
        entries.len()
    );
    for entry in entries {
        out.push_str(&harness.entry(entry));
        out.push('\n');
    }
    out.push_str(FRAME_END);
    out.push('\n');
    out
}

/// The oracles' hand-off (contract section 4.2): run by `tests/geometry/p3-fill-ladder-oracle.test.ts`
/// and by `pnpm test:p3-fill-identity --revision-change`.
#[test]
#[ignore = "AL-U2 oracle hand-off; needs P3_FILL_LADDER_INPUT and P3_FILL_LADDER_DUMP"]
fn emit_fill_ladder_dump() {
    let input = env::var("P3_FILL_LADDER_INPUT").expect("P3_FILL_LADDER_INPUT is required");
    let bytes = std::fs::read(&input).unwrap_or_else(|error| panic!("read {input}: {error}"));
    let entries = read_input(&bytes);
    let text = dump(&entries);
    let path = env::var("P3_FILL_LADDER_DUMP").expect("P3_FILL_LADDER_DUMP is required");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .expect("create the exclusive ladder dump");
    file.write_all(text.as_bytes())
        .expect("write the ladder dump");
    println!(
        "p3-fill-ladder dump: {} entries, {} bytes",
        entries.len(),
        text.len()
    );
}

/// The debug layer's check of the hand-off: a `P3FLDIN1` input built here with one real path
/// (F01) and one view (F01's S1 view) dumps two framed lines, both fast.
#[test]
fn dump_reads_its_input_and_frames_each_entry() {
    let scalars: Vec<u8> = [0.0f64, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 10.0]
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect();
    let mut bytes = INPUT_MAGIC.to_vec();
    let put = |bytes: &mut Vec<u8>, value: u32| bytes.extend(value.to_le_bytes());
    put(&mut bytes, 2);
    // A path.
    put(&mut bytes, 3);
    bytes.extend(b"F01");
    bytes.extend([0, 0]);
    bytes.extend((-3i32).to_le_bytes());
    put(&mut bytes, 0);
    put(&mut bytes, 5);
    bytes.extend([0, 1, 1, 1, 3]);
    put(&mut bytes, 8);
    bytes.extend(&scalars);
    // A view: the square with four line owners and sources, closed by its last line.
    put(&mut bytes, 4);
    bytes.extend(b"view");
    bytes.extend([1, 0]);
    bytes.extend((-3i32).to_le_bytes());
    put(&mut bytes, 0);
    put(&mut bytes, 1);
    put(&mut bytes, 0);
    put(&mut bytes, 4);
    put(&mut bytes, 4);
    bytes.extend(&scalars);
    put(&mut bytes, 4);
    for verb in 1..=4u32 {
        bytes.push(0);
        put(&mut bytes, verb);
        put(&mut bytes, 0);
        put(&mut bytes, 0);
    }
    put(&mut bytes, 4);
    let corners = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)];
    for verb in 0..4usize {
        bytes.push(0);
        put(&mut bytes, verb as u32 + 1);
        put(&mut bytes, 0);
        for (x, y) in [corners[verb], corners[(verb + 1) % 4]] {
            bytes.extend(f64::to_le_bytes(x));
            bytes.extend(f64::to_le_bytes(y));
        }
    }
    let entries = read_input(&bytes);
    assert_eq!(entries.len(), 2);
    let text = dump(&entries);
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 5, "{text}");
    assert_eq!(lines[0], FRAME_BEGIN);
    assert!(lines[1].contains(DUMP_SCHEMA));
    for line in &lines[2..4] {
        assert!(line.contains("\"rung\":\"fast\""), "{line}");
        assert!(line.contains("\"allocations\":0"), "{line}");
        assert!(
            line.contains("\"sameMesh\":true,\"passesFr3\":true"),
            "{line}"
        );
    }
    assert!(lines[2].contains("\"ladderExactAgrees\":true"));
    let boundary = &lines[2][lines[2].find("\"boundaryEdges\":").expect("boundary")..];
    let boundary = &boundary[..boundary.find("]]").expect("boundary end") + 2];
    for pair in ["[0,1]", "[1,2]", "[2,3]", "[3,0]"] {
        assert!(boundary.contains(pair), "{boundary}");
    }
    assert_eq!(boundary.matches('[').count(), 5, "{boundary}");
    assert_eq!(lines[4], FRAME_END);
}
