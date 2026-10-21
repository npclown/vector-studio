//! ST-U5 native tests of the stroke-mesh transport v0 (`docs/plans/p3-b2-stroke-contract.md`,
//! sections 7 and 11.2 "Transport fixtures"): identity, framing rejections, the per-path stage
//! order and status mapping, capacity sizing and the exact retry, transport caps at the limit
//! and limit + 1, epochs and their exhaustion, dispose, construction failures, the heap cap,
//! zero allocation in `process`, determinism, echoes, and the export's meshes against the
//! workspace and their literal fixture areas. Every result is functional evidence; precision is
//! UNVERIFIED against the 0.25 physical-pixel target until B4.

use core::cmp::Ordering;

use crate::codec::{align_up, read_f64, read_u32, write_f64, write_u32};
use crate::engine::{
    BATCH_ALLOCATION_FAILED, BATCH_DISPOSED, BATCH_INTERNAL_ERROR, BATCH_INVALID_BATCH, BATCH_OK,
    BATCH_OUTPUT_CAPACITY, BATCH_RESOURCE_LIMIT,
};
use crate::fill_export::{Mapped, INPUT_CAP_BYTES, OUTPUT_CAP_BYTES};
use crate::fill_predicates::orient2d;
use crate::geometry::Point;
use crate::rounded_line_fill::RoundedFillError;
use crate::stroke_export::{
    StrokeEngine, StrokeInput, STROKE_INPUT_MAGIC, STROKE_OUTPUT_MAGIC, STROKE_REQUEST_BYTES,
    STROKE_V0_REVISION, STROKE_V0_VERSION,
};
use crate::stroke_outline::{
    map_front_end_error, map_rounded_error, FrontEndError, StrokeCap, StrokeJoin, StrokeOutcome,
    StrokeRequest, StrokeWorkspace, STROKE_MAX_TOLERANCE_EXPONENT, STROKE_MIN_TOLERANCE_EXPONENT,
    STROKE_PATH_EMPTY, STROKE_PATH_INVALID_PATH, STROKE_PATH_INVALID_STROKE,
    STROKE_PATH_INVALID_TOLERANCE, STROKE_PATH_NUMERIC_RANGE, STROKE_PATH_OK,
    STROKE_PATH_UNSUPPORTED_GEOMETRY, STROKE_PATH_WORK_LIMIT, STROKE_V0_HEAP_CAP,
};

const MOVE: u8 = 0;
const LINE: u8 = 1;
const CLOSE: u8 = 3;

const BUTT: u32 = 0;
const ROUND: u32 = 1;
const SQUARE: u32 = 2;
const MITER: u32 = 0;
const ROUND_JOIN: u32 = 1;
const BEVEL: u32 = 2;

/// Area of the 16-gon at r = 1, its half and its quarter (section 11.2).
const SIXTEEN_GON: f64 = 3.061_467_458_920_718_3;
const HALF_SIXTEEN_GON: f64 = 1.530_733_729_460_359_1;
const QUARTER_SIXTEEN_GON: f64 = 0.765_366_864_730_179_6;
const CLOSE_AREA: f64 = 1e-12;

#[derive(Clone, Debug)]
struct TestPath {
    id: u32,
    cap: u32,
    join: u32,
    exponent: i32,
    width: f64,
    miter_limit: f64,
    verbs: Vec<u8>,
    points: Vec<f64>,
}

impl TestPath {
    /// `w = 2`, butt, miter `L = 4`, `e = -3`: section 11.2's defaults.
    fn new(id: u32) -> Self {
        Self {
            id,
            cap: BUTT,
            join: MITER,
            exponent: -3,
            width: 2.0,
            miter_limit: 4.0,
            verbs: Vec::new(),
            points: Vec::new(),
        }
    }

    fn style(mut self, cap: u32, join: u32, miter_limit: f64) -> Self {
        self.cap = cap;
        self.join = join;
        self.miter_limit = miter_limit;
        self
    }

    fn width(mut self, width: f64) -> Self {
        self.width = width;
        self
    }

    fn exponent(mut self, exponent: i32) -> Self {
        self.exponent = exponent;
        self
    }

    fn m(mut self, x: f64, y: f64) -> Self {
        self.verbs.push(MOVE);
        self.points.extend([x, y]);
        self
    }

    fn l(mut self, x: f64, y: f64) -> Self {
        self.verbs.push(LINE);
        self.points.extend([x, y]);
        self
    }

    fn c(mut self, controls: [f64; 6]) -> Self {
        self.verbs.push(2);
        self.points.extend(controls);
        self
    }

    fn z(mut self) -> Self {
        self.verbs.push(CLOSE);
        self
    }

    fn point_bytes(&self) -> Vec<u8> {
        self.points
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect()
    }

    fn request(&self) -> StrokeRequest {
        let cap = match self.cap {
            BUTT => StrokeCap::Butt,
            ROUND => StrokeCap::Round,
            _ => StrokeCap::Square,
        };
        let join = match self.join {
            MITER => StrokeJoin::Miter,
            ROUND_JOIN => StrokeJoin::Round,
            _ => StrokeJoin::Bevel,
        };
        StrokeRequest {
            request_id: self.id,
            width: self.width,
            cap,
            join,
            miter_limit: self.miter_limit,
            exponent: self.exponent,
        }
    }
}

// Section 11.2 line fixtures used here.
fn f1(id: u32) -> TestPath {
    TestPath::new(id).m(0.0, 0.0).l(4.0, 0.0)
}

fn f4(id: u32) -> TestPath {
    TestPath::new(id).m(0.0, 0.0).l(4.0, 0.0).l(4.0, 4.0)
}

fn f6(id: u32) -> TestPath {
    TestPath::new(id).m(0.0, 0.0).l(4.0, 0.0).l(0.0, 0.0)
}

fn f11(id: u32) -> TestPath {
    TestPath::new(id)
        .m(0.0, 0.0)
        .l(4.0, 0.0)
        .l(4.0, 4.0)
        .l(0.0, 4.0)
        .z()
}

fn f14a(id: u32) -> TestPath {
    TestPath::new(id)
        .m(0.0, 2.0)
        .l(4.0, 2.0)
        .m(2.0, 0.0)
        .l(2.0, 4.0)
}

fn f14b(id: u32) -> TestPath {
    TestPath::new(id)
        .m(0.0, 2.0)
        .l(4.0, 2.0)
        .l(4.0, 4.0)
        .l(2.0, 4.0)
        .l(2.0, 0.0)
        .style(BUTT, MITER, 2.0)
}

fn f23(id: u32) -> TestPath {
    let base = 1_152_921_504_606_846_976.0; // 2^60
    TestPath::new(id).m(base, 0.0).l(base + 1_048_576.0, 0.0)
}

fn long_lines(id: u32, count: usize) -> TestPath {
    let mut path = TestPath::new(id).m(0.0, 0.0);
    for index in 0..count {
        path = path.l((index % 7) as f64, (index % 5) as f64);
    }
    path
}

/// Packs a stroke-v0 input exactly as section 7.3 lays it out.
fn pack(paths: &[TestPath]) -> Vec<u8> {
    let path_count = paths.len();
    let verb_count: usize = paths.iter().map(|path| path.verbs.len()).sum();
    let point_count: usize = paths.iter().map(|path| path.points.len()).sum();
    let requests = 48;
    let path_offsets = requests + STROKE_REQUEST_BYTES * path_count;
    let point_offsets = path_offsets + 4 * (path_count + 1);
    let verbs = point_offsets + 4 * (path_count + 1);
    let points = align_up(verbs + verb_count, 8).unwrap();
    let total = points + 8 * point_count;
    let mut bytes = vec![0u8; total];
    let header = [
        STROKE_INPUT_MAGIC,
        0,
        total as u32,
        path_count as u32,
        verb_count as u32,
        point_count as u32,
        requests as u32,
        path_offsets as u32,
        point_offsets as u32,
        verbs as u32,
        points as u32,
        0,
    ];
    for (index, value) in header.into_iter().enumerate() {
        write_u32(&mut bytes, index * 4, value).unwrap();
    }
    let mut verb_cursor = 0usize;
    let mut point_cursor = 0usize;
    for (index, path) in paths.iter().enumerate() {
        let request = requests + STROKE_REQUEST_BYTES * index;
        write_u32(&mut bytes, request, path.id).unwrap();
        write_u32(&mut bytes, request + 4, path.cap).unwrap();
        write_u32(&mut bytes, request + 8, path.join).unwrap();
        write_u32(&mut bytes, request + 12, path.exponent as u32).unwrap();
        write_f64(&mut bytes, request + 16, path.width).unwrap();
        write_f64(&mut bytes, request + 24, path.miter_limit).unwrap();
        write_u32(&mut bytes, path_offsets + 4 * index, verb_cursor as u32).unwrap();
        write_u32(&mut bytes, point_offsets + 4 * index, point_cursor as u32).unwrap();
        bytes[verbs + verb_cursor..verbs + verb_cursor + path.verbs.len()]
            .copy_from_slice(&path.verbs);
        for (offset, value) in path.points.iter().enumerate() {
            write_f64(&mut bytes, points + 8 * (point_cursor + offset), *value).unwrap();
        }
        verb_cursor += path.verbs.len();
        point_cursor += path.points.len();
    }
    write_u32(
        &mut bytes,
        path_offsets + 4 * path_count,
        verb_cursor as u32,
    )
    .unwrap();
    write_u32(
        &mut bytes,
        point_offsets + 4 * path_count,
        point_cursor as u32,
    )
    .unwrap();
    bytes
}

#[derive(Clone, Debug, PartialEq)]
struct Decoded {
    id: u32,
    status: u32,
    exponent: i32,
    positions: Vec<f64>,
    indices: Vec<u32>,
    boundary: Vec<u32>,
    bounds: [f64; 4],
}

impl Decoded {
    fn point(&self, vertex: u32) -> Point {
        let index = vertex as usize * 2;
        Point {
            x: self.positions[index],
            y: self.positions[index + 1],
        }
    }

    fn area(&self) -> f64 {
        let twice: f64 = self
            .indices
            .chunks_exact(3)
            .map(|triangle| {
                let a = self.point(triangle[0]);
                let b = self.point(triangle[1]);
                let c = self.point(triangle[2]);
                (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
            })
            .sum();
        twice / 2.0
    }

    fn bits(&self) -> (Vec<u64>, &[u32], &[u32]) {
        (
            self.positions.iter().map(|value| value.to_bits()).collect(),
            &self.indices,
            &self.boundary,
        )
    }
}

/// Decodes a published output and checks every framing rule of section 7.4 (V2's).
fn decode(output: &[u8], paths: &[TestPath]) -> Vec<Decoded> {
    assert_eq!(read_u32(output, 0), Some(STROKE_OUTPUT_MAGIC));
    assert_eq!(read_u32(output, 4), Some(STROKE_V0_VERSION));
    let total = read_u32(output, 8).unwrap() as usize;
    assert_eq!(total, output.len());
    let count = read_u32(output, 12).unwrap() as usize;
    assert_eq!(count, paths.len());
    assert_eq!(read_u32(output, 16), Some(64));
    let data_offset = read_u32(output, 20).unwrap() as usize;
    assert_eq!(data_offset, 64 + 80 * count);
    for field in 6..16 {
        assert_eq!(read_u32(output, field * 4), Some(0), "header reserved");
    }
    let mut cursor = data_offset;
    let mut decoded = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        let record = 64 + 80 * index;
        let id = read_u32(output, record).unwrap();
        let status = read_u32(output, record + 4).unwrap();
        let exponent = read_u32(output, record + 8).unwrap() as i32;
        assert_eq!(id, path.id);
        assert_eq!(exponent, path.exponent);
        for reserved in [12, 36, 40, 44] {
            assert_eq!(read_u32(output, record + reserved), Some(0));
        }
        let block_offset = read_u32(output, record + 16).unwrap() as usize;
        let vertex_count = read_u32(output, record + 20).unwrap() as usize;
        let index_count = read_u32(output, record + 24).unwrap() as usize;
        let boundary_count = read_u32(output, record + 28).unwrap() as usize;
        let block_bytes = read_u32(output, record + 32).unwrap() as usize;
        let bounds = [
            read_f64(output, record + 48).unwrap(),
            read_f64(output, record + 56).unwrap(),
            read_f64(output, record + 64).unwrap(),
            read_f64(output, record + 72).unwrap(),
        ];
        if status != STROKE_PATH_OK {
            assert_eq!(
                (
                    block_offset,
                    vertex_count,
                    index_count,
                    boundary_count,
                    block_bytes
                ),
                (0, 0, 0, 0, 0)
            );
            assert!(bounds.iter().all(|value| value.to_bits() == 0));
            decoded.push(Decoded {
                id,
                status,
                exponent,
                positions: Vec::new(),
                indices: Vec::new(),
                boundary: Vec::new(),
                bounds,
            });
            continue;
        }
        assert_eq!(block_offset, cursor, "blocks are contiguous");
        assert!(vertex_count > 0 && index_count > 0);
        assert_eq!(index_count % 3, 0);
        assert_eq!(boundary_count % 2, 0);
        let payload = 16 * vertex_count + 4 * (index_count + boundary_count);
        assert_eq!(block_bytes, payload.div_ceil(8) * 8);
        assert!(output[block_offset + payload..block_offset + block_bytes]
            .iter()
            .all(|byte| *byte == 0));
        let positions: Vec<f64> = (0..2 * vertex_count)
            .map(|scalar| read_f64(output, block_offset + 8 * scalar).unwrap())
            .collect();
        let indices_start = block_offset + 16 * vertex_count;
        let indices: Vec<u32> = (0..index_count)
            .map(|slot| read_u32(output, indices_start + 4 * slot).unwrap())
            .collect();
        let boundary_start = indices_start + 4 * index_count;
        let boundary: Vec<u32> = (0..boundary_count)
            .map(|slot| read_u32(output, boundary_start + 4 * slot).unwrap())
            .collect();
        assert!(indices
            .iter()
            .chain(&boundary)
            .all(|vertex| (*vertex as usize) < vertex_count));
        let mut expected = [
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ];
        for pair in positions.chunks_exact(2) {
            expected[0] = expected[0].min(pair[0]);
            expected[1] = expected[1].min(pair[1]);
            expected[2] = expected[2].max(pair[0]);
            expected[3] = expected[3].max(pair[1]);
        }
        assert_eq!(bounds, expected);
        cursor += block_bytes;
        decoded.push(Decoded {
            id,
            status,
            exponent,
            positions,
            indices,
            boundary,
            bounds,
        });
    }
    assert_eq!(cursor, total);
    decoded
}

fn load(engine: &mut StrokeEngine, input: &[u8], output_capacity: u32) {
    assert_eq!(
        engine.reserve(input.len() as u32, output_capacity),
        BATCH_OK
    );
    engine.input_bytes_mut()[..input.len()].copy_from_slice(input);
}

/// Runs one batch in a fresh engine with enough capacity.
fn run(paths: &[TestPath]) -> Vec<Decoded> {
    let input = pack(paths);
    let mut engine = StrokeEngine::new();
    load(&mut engine, &input, 1 << 22);
    assert_eq!(engine.process(input.len() as u32), BATCH_OK);
    let decoded = decode(engine.output_bytes(), paths);
    for mesh in decoded.iter().filter(|mesh| mesh.status == STROKE_PATH_OK) {
        assert_mesh_invariants(mesh);
    }
    decoded
}

fn run_one(path: TestPath) -> Decoded {
    run(&[path]).remove(0)
}

fn status_of(path: TestPath) -> u32 {
    run_one(path).status
}

/// Independent mesh check in exact predicates: positive triangles, the boundary equals the
/// edges used exactly once, and conformity.
fn assert_mesh_invariants(mesh: &Decoded) {
    let mut directed: Vec<(u32, u32)> = Vec::new();
    for triangle in mesh.indices.chunks_exact(3) {
        assert_eq!(
            orient2d(
                mesh.point(triangle[0]),
                mesh.point(triangle[1]),
                mesh.point(triangle[2])
            ),
            Ok(Ordering::Greater)
        );
        for edge in 0..3 {
            directed.push((triangle[edge], triangle[(edge + 1) % 3]));
        }
    }
    let mut once: Vec<(u32, u32)> = directed
        .iter()
        .copied()
        .filter(|(a, b)| {
            directed
                .iter()
                .filter(|(c, d)| (a == c && b == d) || (a == d && b == c))
                .count()
                == 1
        })
        .collect();
    let mut listed: Vec<(u32, u32)> = mesh
        .boundary
        .chunks_exact(2)
        .map(|pair| (pair[0], pair[1]))
        .collect();
    once.sort_unstable();
    listed.sort_unstable();
    assert_eq!(listed, once);
    for &(a, b) in &directed {
        for vertex in 0..(mesh.positions.len() / 2) as u32 {
            if vertex == a || vertex == b {
                continue;
            }
            let (pa, pb, pv) = (mesh.point(a), mesh.point(b), mesh.point(vertex));
            if orient2d(pa, pb, pv) == Ok(Ordering::Equal) {
                let inside_x =
                    (pv.x - pa.x) * (pv.x - pb.x) < 0.0 || (pa.x == pb.x && pv.x == pa.x);
                let inside_y =
                    (pv.y - pa.y) * (pv.y - pb.y) < 0.0 || (pa.y == pb.y && pv.y == pa.y);
                assert!(!(inside_x && inside_y), "hanging vertex on a mesh edge");
            }
        }
    }
}

fn assert_area(mesh: &Decoded, expected: f64, tolerance: f64, name: &str) {
    assert_eq!(mesh.status, STROKE_PATH_OK, "{name}");
    let area = mesh.area();
    assert!(
        (area - expected).abs() <= tolerance,
        "{name}: area {area}, expected {expected}"
    );
}

#[test]
fn identity_constants_match_section_7_1() {
    assert_eq!(STROKE_V0_VERSION, 0);
    assert_eq!(STROKE_V0_REVISION, 3);
    assert_eq!(STROKE_INPUT_MAGIC, 0x3054_4756);
    assert_eq!(STROKE_OUTPUT_MAGIC, 0x3055_4756);
    assert_eq!(STROKE_INPUT_MAGIC.to_le_bytes(), *b"VGT0");
    assert_eq!(STROKE_OUTPUT_MAGIC.to_le_bytes(), *b"VGU0");
    // Distinct from P2's VGS2/VGR2 and fill's VGF0/VGM0.
    for other in [*b"VGS2", *b"VGR2", *b"VGF0", *b"VGM0"] {
        assert_ne!(STROKE_INPUT_MAGIC.to_le_bytes(), other);
        assert_ne!(STROKE_OUTPUT_MAGIC.to_le_bytes(), other);
    }
    assert_eq!(STROKE_REQUEST_BYTES, 32);
    assert_eq!(
        (STROKE_MIN_TOLERANCE_EXPONENT, STROKE_MAX_TOLERANCE_EXPONENT),
        (-1020, 1023)
    );
    assert_eq!(STROKE_V0_HEAP_CAP, 48 * 1024 * 1024);
    assert_eq!(
        (INPUT_CAP_BYTES, OUTPUT_CAP_BYTES),
        (64 * 1024 * 1024, 256 * 1024 * 1024)
    );
    let statuses = [
        STROKE_PATH_OK,
        STROKE_PATH_EMPTY,
        STROKE_PATH_INVALID_PATH,
        STROKE_PATH_INVALID_TOLERANCE,
        STROKE_PATH_NUMERIC_RANGE,
        STROKE_PATH_WORK_LIMIT,
        STROKE_PATH_UNSUPPORTED_GEOMETRY,
        STROKE_PATH_INVALID_STROKE,
    ];
    assert_eq!(statuses, [0, 1, 2, 3, 4, 5, 6, 7]);
}

#[test]
fn status_mapping_rows_of_section_7_8() {
    // Front-end values that are stable across ST-U3 and ST-U4. ST-U3's interim
    // `UnsupportedCubic` is left out on purpose: ST-U4 replaces it.
    let work = Mapped::Path(STROKE_PATH_WORK_LIMIT);
    for error in [
        FrontEndError::SourceLimit,
        FrontEndError::SegmentLimit,
        FrontEndError::SubpathLimit,
        FrontEndError::DepthLimit,
        FrontEndError::PieceLimit,
        FrontEndError::DiskLimit,
    ] {
        assert_eq!(map_front_end_error(error), work, "{error:?}");
    }
    assert_eq!(
        map_front_end_error(FrontEndError::NumericRange),
        Mapped::Path(STROKE_PATH_NUMERIC_RANGE)
    );
    assert_eq!(
        map_front_end_error(FrontEndError::Invariant),
        Mapped::Internal
    );
    use RoundedFillError as R;
    let rows = [
        (R::InputLimit, work),
        (R::EdgeLimit, work),
        (R::PairLimit, work),
        (R::EventLimit, work),
        (R::SectionLimit, work),
        (R::NodeLimit, work),
        (R::CellLimit, work),
        (R::BoundaryLimit, work),
        (R::ContributorLimit, work),
        (R::WorkLimit, work),
        (R::OutputLimit, work),
        (
            R::TopologyAmbiguous,
            Mapped::Path(STROKE_PATH_UNSUPPORTED_GEOMETRY),
        ),
        (
            R::InvalidTolerance,
            Mapped::Path(STROKE_PATH_INVALID_TOLERANCE),
        ),
        (R::InvalidInput, Mapped::Internal),
        (R::InternalInvariant, Mapped::Internal),
        (R::InvalidLimits, Mapped::Internal),
        (R::AllocationFailed, Mapped::Internal),
        (R::ByteLimit, Mapped::Internal),
    ];
    assert_eq!(rows.len(), 18);
    for (error, expected) in rows {
        assert_eq!(map_rounded_error(error), expected, "{error:?}");
    }
}

#[test]
fn input_framing_rejections_are_invalid_batch() {
    let paths = [f1(1), TestPath::new(2).m(0.0, 0.0)];
    let valid = pack(&paths);
    let points_offset = read_u32(&valid, 40).unwrap() as usize;
    let verbs_end = read_u32(&valid, 36).unwrap() as usize + paths[0].verbs.len() + 1;
    assert!(verbs_end < points_offset, "fixture needs verb padding");
    let path_offsets = read_u32(&valid, 28).unwrap() as usize;
    let point_offsets = read_u32(&valid, 32).unwrap() as usize;
    assert!(StrokeInput::parse(&valid).is_some());

    let mut cases: Vec<(&str, Vec<u8>)> = Vec::new();
    let mut corrupt = |name: &'static str, offset: usize, value: u32| {
        let mut bytes = valid.clone();
        write_u32(&mut bytes, offset, value).unwrap();
        cases.push((name, bytes));
    };
    corrupt("fill magic", 0, 0x3046_4756);
    corrupt("P2 magic", 0, 0x3253_4756);
    corrupt("version", 4, 1);
    corrupt("total bytes", 8, valid.len() as u32 - 8);
    corrupt("path count", 12, 3);
    corrupt("verb count", 16, 4);
    corrupt("point count", 20, 9);
    corrupt("requests offset", 24, 56);
    corrupt("path offsets offset", 28, path_offsets as u32 + 4);
    corrupt("point offsets offset", 32, point_offsets as u32 + 4);
    corrupt("verbs offset", 36, read_u32(&valid, 36).unwrap() + 1);
    corrupt("points offset", 40, points_offset as u32 - 8);
    corrupt("header reserved", 44, 1);
    corrupt("cap above 2", 48 + 4, 3);
    corrupt("join above 2", 48 + 8, 3);
    corrupt("second cap above 2", 48 + 32 + 4, u32::MAX);
    corrupt("second join above 2", 48 + 32 + 8, 7);
    corrupt("first path offset", path_offsets, 1);
    corrupt("decreasing path offsets", path_offsets + 4, 4);
    corrupt("terminal path offset", path_offsets + 8, 2);
    corrupt("first point offset", point_offsets, 2);
    corrupt("decreasing point offsets", point_offsets + 4, 7);
    corrupt("terminal point offset", point_offsets + 8, 4);
    let mut padding = valid.clone();
    padding[verbs_end] = 1;
    cases.push(("verb padding", padding));
    let mut truncated = valid.clone();
    truncated.truncate(40);
    cases.push(("short header", truncated));

    for (name, bytes) in cases {
        assert!(StrokeInput::parse(&bytes).is_none(), "{name}");
        let mut engine = StrokeEngine::new();
        load(&mut engine, &bytes, 1 << 16);
        assert_eq!(
            engine.process(bytes.len() as u32),
            BATCH_INVALID_BATCH,
            "{name}"
        );
        assert_eq!(engine.result_len(), 0, "{name}");
        assert_eq!(engine.required_output_bytes(), 0, "{name}");
    }

    // Width and miter-limit bits are path content, not framing.
    let mut engine = StrokeEngine::new();
    let content = [
        f1(1).width(f64::NAN),
        f1(2).style(BUTT, MITER, f64::NEG_INFINITY),
    ];
    let input = pack(&content);
    load(&mut engine, &input, 1 << 16);
    assert_eq!(engine.process(input.len() as u32), BATCH_OK);
    let decoded = decode(engine.output_bytes(), &content);
    assert!(decoded
        .iter()
        .all(|path| path.status == STROKE_PATH_INVALID_STROKE));

    let mut engine = StrokeEngine::new();
    load(&mut engine, &valid, 1 << 16);
    let beyond = engine.input_capacity() + 1;
    assert_eq!(engine.process(beyond), BATCH_INVALID_BATCH);
    assert_eq!(engine.process(valid.len() as u32), BATCH_OK);
}

#[test]
fn empty_batch_publishes_header_only() {
    let input = pack(&[]);
    assert_eq!(input.len(), 56);
    let mut engine = StrokeEngine::new();
    load(&mut engine, &input, 64);
    assert_eq!(engine.process(input.len() as u32), BATCH_OK);
    assert_eq!(engine.result_len(), 64);
    assert!(decode(engine.output_bytes(), &[]).is_empty());
}

#[test]
fn per_path_statuses_follow_the_stage_order() {
    // 1. Grammar and values.
    let nan = TestPath::new(1).m(0.0, 0.0).l(f64::NAN, 1.0);
    let mut odd = TestPath::new(2).m(0.0, 0.0);
    odd.points.push(1.0);
    let mut unknown = TestPath::new(3).m(0.0, 0.0);
    unknown.verbs.push(9);
    let grammar = TestPath::new(4).l(1.0, 1.0);
    for path in [nan, odd, unknown, grammar] {
        assert_eq!(status_of(path), STROKE_PATH_INVALID_PATH);
    }
    // invalid-path beats invalid-stroke beats invalid-tolerance.
    assert_eq!(
        status_of(
            TestPath::new(5)
                .l(1.0, 1.0)
                .width(-1.0)
                .style(BUTT, MITER, 0.5)
                .exponent(5000)
        ),
        STROKE_PATH_INVALID_PATH
    );
    // 2. Stroke values.
    for width in [-1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert_eq!(
            status_of(f1(6).width(width).exponent(5000)),
            STROKE_PATH_INVALID_STROKE
        );
    }
    for limit in [0.5, 0.999_999_999_999_999_9, f64::NAN, f64::INFINITY] {
        assert_eq!(
            status_of(f1(7).style(BUTT, BEVEL, limit).exponent(5000)),
            STROKE_PATH_INVALID_STROKE
        );
    }
    // invalid-stroke beats empty.
    assert_eq!(
        status_of(TestPath::new(8).width(f64::NAN)),
        STROKE_PATH_INVALID_STROKE
    );
    // 3. Tolerance range; invalid-tolerance beats empty.
    for exponent in [-1021, 1024, i32::MIN, i32::MAX] {
        assert_eq!(
            status_of(f1(9).exponent(exponent)),
            STROKE_PATH_INVALID_TOLERANCE
        );
        assert_eq!(
            status_of(TestPath::new(9).exponent(exponent)),
            STROKE_PATH_INVALID_TOLERANCE
        );
    }
    for exponent in [-1020, 0, 1023] {
        assert_ne!(
            status_of(f1(10).exponent(exponent)),
            STROKE_PATH_INVALID_TOLERANCE
        );
    }
    // 4. Empty: no verbs, width 0 (both signs), MOVE-only.
    assert_eq!(status_of(TestPath::new(11)), STROKE_PATH_EMPTY);
    assert_eq!(status_of(f1(12).width(0.0)), STROKE_PATH_EMPTY);
    assert_eq!(status_of(f1(13).width(-0.0)), STROKE_PATH_EMPTY);
    for cap in [BUTT, ROUND, SQUARE] {
        for join in [MITER, ROUND_JOIN, BEVEL] {
            // ST-F7 and ST-F9.
            let style = |path: TestPath| path.style(cap, join, 4.0);
            assert_eq!(
                status_of(style(TestPath::new(14).m(4.0, 5.0))),
                STROKE_PATH_EMPTY
            );
            assert_eq!(
                status_of(style(TestPath::new(15).m(4.0, 5.0).l(4.0, 5.0).z())),
                STROKE_PATH_EMPTY
            );
        }
    }
    // 5. Front end: numeric-range (ST-F23) and the source caps.
    for cap in [BUTT, ROUND, SQUARE] {
        assert_eq!(
            status_of(f23(16).style(cap, MITER, 4.0)),
            STROKE_PATH_NUMERIC_RANGE
        );
    }
    assert_eq!(status_of(long_lines(17, 1_024)), STROKE_PATH_WORK_LIMIT);
    // ST-F26's disk limit: round caps at w = 1000 need n = 512.
    assert_eq!(
        status_of(f1(18).width(1_000.0).style(ROUND, MITER, 4.0)),
        STROKE_PATH_WORK_LIMIT
    );
    // 8. ST-F22 collapses to `empty`.
    let big = 1_099_511_627_776.0; // 2^40
    assert_eq!(
        status_of(
            TestPath::new(19)
                .m(big, big)
                .l(big + 1.0, big + 1.0)
                .width(4.547_473_508_864_641e-13) // 2^-41
        ),
        STROKE_PATH_EMPTY
    );
}

#[test]
fn export_meshes_equal_the_workspace_and_their_fixture_areas() {
    // ST-F1 to ST-F4, ST-F6, ST-F8, ST-F11 and ST-F14 through the export.
    let cases: Vec<(&str, TestPath, f64, f64)> = vec![
        ("ST-F1", f1(1), 8.0, 0.0),
        ("ST-F2", f1(2).style(SQUARE, MITER, 4.0), 12.0, 0.0),
        (
            "ST-F3",
            f1(3).style(ROUND, MITER, 4.0),
            8.0 + SIXTEEN_GON,
            CLOSE_AREA,
        ),
        ("ST-F4 miter 2", f4(4).style(BUTT, MITER, 2.0), 16.0, 0.0),
        ("ST-F4 miter 1", f4(5).style(BUTT, MITER, 1.0), 15.5, 0.0),
        ("ST-F4 bevel", f4(6).style(BUTT, BEVEL, 4.0), 15.5, 0.0),
        (
            "ST-F4 round",
            f4(7).style(BUTT, ROUND_JOIN, 4.0),
            15.0 + QUARTER_SIXTEEN_GON,
            CLOSE_AREA,
        ),
        ("ST-F6 miter", f6(8), 8.0, 0.0),
        ("ST-F6 bevel", f6(9).style(BUTT, BEVEL, 4.0), 8.0, 0.0),
        (
            "ST-F6 round",
            f6(10).style(BUTT, ROUND_JOIN, 4.0),
            8.0 + HALF_SIXTEEN_GON,
            CLOSE_AREA,
        ),
        (
            "ST-F8 square",
            TestPath::new(11)
                .m(4.0, 5.0)
                .l(4.0, 5.0)
                .style(SQUARE, MITER, 4.0),
            4.0,
            0.0,
        ),
        (
            "ST-F8 round",
            TestPath::new(12)
                .m(4.0, 5.0)
                .l(4.0, 5.0)
                .style(ROUND, MITER, 4.0),
            SIXTEEN_GON,
            CLOSE_AREA,
        ),
        ("ST-F11 miter", f11(13).style(BUTT, MITER, 2.0), 32.0, 0.0),
        ("ST-F11 bevel", f11(14).style(SQUARE, BEVEL, 2.0), 30.0, 0.0),
        (
            "ST-F11 round",
            f11(15).style(ROUND, ROUND_JOIN, 2.0),
            28.0 + SIXTEEN_GON,
            CLOSE_AREA,
        ),
        ("ST-F14a", f14a(16), 12.0, 0.0),
        ("ST-F14b", f14b(17), 20.0, 0.0),
        (
            "ST-F21",
            f1(18).width(9.536_743_164_062_5e-7), // 2^-20
            3.814_697_265_625e-6,                 // 2^-18
            0.0,
        ),
    ];
    let paths: Vec<TestPath> = cases.iter().map(|case| case.1.clone()).collect();
    let decoded = run(&paths);
    let mut workspace = StrokeWorkspace::new().unwrap();
    for ((name, path, area, tolerance), mesh) in cases.iter().zip(&decoded) {
        assert_area(mesh, *area, *tolerance, name);
        // The export publishes the workspace's own mesh, bit for bit.
        assert_eq!(
            workspace.build(path.request(), &path.verbs, &path.point_bytes()),
            Ok(StrokeOutcome::Mesh),
            "{name}"
        );
        let (vertices, triangles, boundary) = workspace.mesh().unwrap();
        let positions: Vec<u64> = vertices
            .iter()
            .flat_map(|point| [point.x.to_bits(), point.y.to_bits()])
            .collect();
        let pairs: Vec<u32> = boundary.iter().flatten().copied().collect();
        assert_eq!(
            mesh.bits(),
            (positions, triangles, pairs.as_slice()),
            "{name}"
        );
    }
    assert_eq!(decoded[0].bounds, [0.0, -1.0, 4.0, 1.0]);
    assert_eq!(decoded[1].bounds, [-1.0, -1.0, 5.0, 1.0]);
    assert_eq!(decoded[10].bounds, [3.0, 4.0, 5.0, 6.0]);
}

#[test]
fn capacity_retry_reports_the_exact_requirement() {
    let paths = [
        f1(1),
        TestPath::new(2).l(1.0, 1.0),
        f11(3).style(ROUND, ROUND_JOIN, 4.0),
    ];
    let input = pack(&paths);
    let mut reference = StrokeEngine::new();
    load(&mut reference, &input, 1 << 20);
    assert_eq!(reference.process(input.len() as u32), BATCH_OK);
    let expected = reference.output_bytes().to_vec();
    let required = expected.len() as u32;

    for capacity in [0, 8, 64, 64 + 80 * 3 - 1, 64 + 80 * 3 + 8, required - 1] {
        let mut engine = StrokeEngine::new();
        load(&mut engine, &input, capacity);
        assert_eq!(
            engine.process(input.len() as u32),
            BATCH_OUTPUT_CAPACITY,
            "{capacity}"
        );
        assert_eq!(engine.required_output_bytes(), required);
        assert_eq!(engine.result_len(), 0);
        let epoch = engine.memory_epoch();
        assert_eq!(engine.reserve(input.len() as u32, required), BATCH_OK);
        assert_eq!(engine.memory_epoch(), epoch + 1);
        assert_eq!(engine.required_output_bytes(), 0);
        engine.input_bytes_mut()[..input.len()].copy_from_slice(&input);
        assert_eq!(engine.process(input.len() as u32), BATCH_OK);
        assert_eq!(engine.result_len(), required);
        assert_eq!(engine.output_bytes(), expected.as_slice());
    }
    // Reserve never shrinks the arenas.
    let mut engine = StrokeEngine::new();
    load(&mut engine, &input, required);
    assert_eq!(engine.reserve(8, 8), BATCH_OK);
    assert_eq!(engine.output_capacity(), required);
    assert_eq!(engine.input_capacity(), input.len() as u32);
}

#[test]
fn transport_caps_hold_at_limit_and_reject_limit_plus_one() {
    let mut engine = StrokeEngine::new();
    assert_eq!(engine.reserve(INPUT_CAP_BYTES + 1, 0), BATCH_RESOURCE_LIMIT);
    assert_eq!(
        engine.reserve(0, OUTPUT_CAP_BYTES + 1),
        BATCH_RESOURCE_LIMIT
    );
    assert_eq!(engine.input_capacity(), 0);
    assert_eq!(engine.output_capacity(), 0);
    assert!(!engine.has_workspace());
    assert_eq!(engine.reserve(INPUT_CAP_BYTES, OUTPUT_CAP_BYTES), BATCH_OK);
    assert_eq!(engine.input_capacity(), INPUT_CAP_BYTES);
    assert_eq!(engine.output_capacity(), OUTPUT_CAP_BYTES);
    assert_eq!(engine.reserve(u32::MAX, 0), BATCH_RESOURCE_LIMIT);
    assert_eq!(engine.input_capacity(), INPUT_CAP_BYTES);

    // Output total at the cap publishes; one byte above is RESOURCE_LIMIT with no
    // requirement. A test seam lowers the cap to a reachable size.
    let paths = [f1(1), f4(2)];
    let input = pack(&paths);
    let mut sizing = StrokeEngine::new();
    load(&mut sizing, &input, 1 << 16);
    assert_eq!(sizing.process(input.len() as u32), BATCH_OK);
    let total = sizing.result_len();
    for (cap, status) in [(total, BATCH_OK), (total - 1, BATCH_RESOURCE_LIMIT)] {
        let mut engine = StrokeEngine::new();
        engine.hooks().output_cap = Some(cap);
        load(&mut engine, &input, 1 << 16);
        assert_eq!(engine.process(input.len() as u32), status);
        if status == BATCH_RESOURCE_LIMIT {
            assert_eq!(engine.required_output_bytes(), 0);
            assert_eq!(engine.result_len(), 0);
        }
    }
    // RESOURCE_LIMIT beats OUTPUT_CAPACITY.
    let mut engine = StrokeEngine::new();
    engine.hooks().output_cap = Some(total - 1);
    load(&mut engine, &input, 8);
    assert_eq!(engine.process(input.len() as u32), BATCH_RESOURCE_LIMIT);
    assert_eq!(engine.required_output_bytes(), 0);
}

#[test]
fn epochs_advance_once_per_mutation_and_exhaustion_fails_closed() {
    let mut engine = StrokeEngine::new();
    assert_eq!(engine.memory_epoch(), 0);
    assert_eq!(engine.reserve(64, 64), BATCH_OK);
    assert_eq!(engine.memory_epoch(), 1);
    assert_eq!(engine.reserve(0, 0), BATCH_OK);
    assert_eq!(engine.memory_epoch(), 2);
    assert_eq!(engine.process(0), BATCH_INVALID_BATCH);
    assert_eq!(engine.memory_epoch(), 3);
    // Reads do not advance the epoch.
    let _ = (
        engine.input_ptr(),
        engine.output_ptr(),
        engine.result_len(),
        engine.required_output_bytes(),
    );
    assert_eq!(engine.memory_epoch(), 3);

    engine.set_epoch(u32::MAX - 1);
    assert_eq!(engine.reserve(0, 0), BATCH_OK);
    assert_eq!(engine.memory_epoch(), u32::MAX);
    assert_eq!(engine.process(0), BATCH_DISPOSED);
    assert_eq!(engine.memory_epoch(), u32::MAX);
    assert!(engine.is_disposed());
    assert_eq!(engine.reserve(64, 64), BATCH_DISPOSED);
    assert_eq!(engine.dispose(), BATCH_OK);
    assert_eq!(engine.memory_epoch(), u32::MAX);
    assert_eq!(engine.input_capacity(), 0);
    assert!(!engine.has_workspace());
}

#[test]
fn dispose_is_terminal_and_idempotent() {
    let input = pack(&[f1(1)]);
    let mut engine = StrokeEngine::new();
    load(&mut engine, &input, 1 << 12);
    assert!(engine.heap_bytes() > 0);
    assert_eq!(Some(engine.heap_bytes()), engine.workspace_bytes());
    let epoch = engine.memory_epoch();
    assert_eq!(engine.dispose(), BATCH_OK);
    assert_eq!(engine.memory_epoch(), epoch + 1);
    assert_eq!(engine.input_capacity(), 0);
    assert_eq!(engine.output_capacity(), 0);
    assert!(!engine.has_workspace());
    assert_eq!(engine.heap_bytes(), 0);
    assert_eq!(engine.reserve(64, 64), BATCH_DISPOSED);
    assert_eq!(engine.process(0), BATCH_DISPOSED);
    assert_eq!(engine.memory_epoch(), epoch + 3);
    assert_eq!(engine.dispose(), BATCH_OK);
    assert_eq!(engine.memory_epoch(), epoch + 4);
    assert_eq!(engine.result_len(), 0);
}

#[test]
fn workspace_construction_failure_keeps_no_workspace_and_retries() {
    for status in [BATCH_ALLOCATION_FAILED, BATCH_INTERNAL_ERROR] {
        let input = pack(&[f1(1)]);
        let mut engine = StrokeEngine::new();
        engine.hooks().fail_workspace = Some(status);
        assert_eq!(engine.reserve(input.len() as u32, 1 << 12), status);
        assert!(!engine.has_workspace());
        assert_eq!(engine.heap_bytes(), 0);
        assert_eq!(engine.input_capacity(), input.len() as u32);
        engine.input_bytes_mut()[..input.len()].copy_from_slice(&input);
        assert_eq!(engine.process(input.len() as u32), BATCH_ALLOCATION_FAILED);
        assert_eq!(engine.result_len(), 0);
        // INVALID_BATCH precedes the missing workspace.
        assert_eq!(engine.process(8), BATCH_INVALID_BATCH);
        assert_eq!(engine.reserve(0, 0), BATCH_OK);
        assert!(engine.has_workspace());
        engine.input_bytes_mut()[..input.len()].copy_from_slice(&input);
        assert_eq!(engine.process(input.len() as u32), BATCH_OK);
    }
}

#[test]
fn heap_cap_is_checked_at_reserve() {
    let input = pack(&[f1(1)]);
    let mut engine = StrokeEngine::new();
    load(&mut engine, &input, 1 << 12);
    let heap = engine.heap_bytes();
    assert!(heap > 0 && heap <= STROKE_V0_HEAP_CAP);
    // A cap one byte below the real heap refuses the workspace with INTERNAL_ERROR.
    let mut engine = StrokeEngine::new();
    engine.hooks().heap_cap = Some(heap - 1);
    assert_eq!(engine.reserve(64, 64), BATCH_INTERNAL_ERROR);
    assert!(!engine.has_workspace());
    // At the cap exactly it builds.
    let mut engine = StrokeEngine::new();
    engine.hooks().heap_cap = Some(heap);
    assert_eq!(engine.reserve(64, 64), BATCH_OK);
    assert!(engine.has_workspace());
}

#[test]
fn self_check_failure_is_internal_error_and_the_engine_recovers() {
    let paths = [f1(1), f4(2)];
    let input = pack(&paths);
    let mut engine = StrokeEngine::new();
    load(&mut engine, &input, 1 << 14);
    assert_eq!(engine.process(input.len() as u32), BATCH_OK);
    let expected = engine.output_bytes().to_vec();
    engine.hooks().fault_path = Some(1);
    assert_eq!(engine.process(input.len() as u32), BATCH_INTERNAL_ERROR);
    assert_eq!(engine.result_len(), 0);
    assert_eq!(engine.required_output_bytes(), 0);
    assert!(engine.raw_output()[..64].iter().all(|byte| *byte == 0));
    // INTERNAL_ERROR beats OUTPUT_CAPACITY.
    let mut small = StrokeEngine::new();
    small.hooks().fault_path = Some(1);
    load(&mut small, &input, 8);
    assert_eq!(small.process(input.len() as u32), BATCH_INTERNAL_ERROR);
    engine.hooks().fault_path = None;
    assert_eq!(engine.process(input.len() as u32), BATCH_OK);
    assert_eq!(engine.output_bytes(), expected.as_slice());
}

#[test]
fn process_does_not_allocate_or_move_storage() {
    let paths = [
        f1(1).style(ROUND, ROUND_JOIN, 4.0),
        f4(2).style(SQUARE, MITER, 2.0),
        f6(3).style(BUTT, ROUND_JOIN, 4.0),
        f11(4),
        f14a(5),
        f14b(6),
        TestPath::new(7).l(1.0, 1.0),
        f1(8).width(f64::NAN),
        f1(9).exponent(2000),
        TestPath::new(10),
        f23(11),
        long_lines(12, 1_100),
        f1(13).width(1_000.0).style(ROUND, MITER, 4.0),
        TestPath::new(14)
            .m(4.0, 5.0)
            .l(4.0, 5.0)
            .style(SQUARE, MITER, 4.0),
    ];
    let input = pack(&paths);
    let mut engine = StrokeEngine::new();
    load(&mut engine, &input, 8);
    let workspace_bytes = engine.workspace_bytes();
    let storage = engine.storage();
    crate::allocation_test_support::start();
    let first = engine.process(input.len() as u32);
    let allocations = crate::allocation_test_support::stop();
    assert_eq!(first, BATCH_OUTPUT_CAPACITY);
    assert_eq!(allocations, 0, "process must not allocate");
    assert_eq!(engine.storage(), storage);
    let required = engine.required_output_bytes();
    assert_eq!(engine.reserve(input.len() as u32, required), BATCH_OK);
    engine.input_bytes_mut()[..input.len()].copy_from_slice(&input);
    let storage = engine.storage();
    crate::allocation_test_support::start();
    let second = engine.process(input.len() as u32);
    let allocations = crate::allocation_test_support::stop();
    assert_eq!(second, BATCH_OK);
    assert_eq!(allocations, 0, "process must not allocate");
    assert_eq!(engine.storage(), storage);
    assert_eq!(engine.workspace_bytes(), workspace_bytes);
    let decoded = decode(engine.output_bytes(), &paths);
    let statuses: Vec<u32> = decoded.iter().map(|path| path.status).collect();
    assert_eq!(
        statuses,
        [
            STROKE_PATH_OK,
            STROKE_PATH_OK,
            STROKE_PATH_OK,
            STROKE_PATH_OK,
            STROKE_PATH_OK,
            STROKE_PATH_OK,
            STROKE_PATH_INVALID_PATH,
            STROKE_PATH_INVALID_STROKE,
            STROKE_PATH_INVALID_TOLERANCE,
            STROKE_PATH_EMPTY,
            STROKE_PATH_NUMERIC_RANGE,
            STROKE_PATH_WORK_LIMIT,
            STROKE_PATH_WORK_LIMIT,
            STROKE_PATH_OK,
        ]
    );
    for mesh in decoded.iter().filter(|mesh| mesh.status == STROKE_PATH_OK) {
        assert_mesh_invariants(mesh);
    }
}

#[test]
fn results_are_deterministic_and_position_independent() {
    let a = f11(1).style(ROUND, ROUND_JOIN, 4.0);
    let b = f14b(2);
    let c = TestPath::new(3).l(1.0, 1.0);
    let first = run(&[a.clone(), b.clone(), c.clone()]);
    let second = run(&[c, b.clone(), a.clone()]);
    assert_eq!(first[0], second[2]);
    assert_eq!(first[1], second[1]);
    let input = pack(&[a, b]);
    let mut engine = StrokeEngine::new();
    load(&mut engine, &input, 1 << 20);
    assert_eq!(engine.process(input.len() as u32), BATCH_OK);
    let once = engine.output_bytes().to_vec();
    assert_eq!(engine.process(input.len() as u32), BATCH_OK);
    assert_eq!(engine.output_bytes(), once.as_slice());
}

#[test]
fn request_echo_and_record_fields_are_little_endian() {
    let paths = [
        f1(0).exponent(-1020),
        TestPath::new(u32::MAX).exponent(i32::MIN),
        TestPath::new(0x1234_5678).exponent(7),
    ];
    let decoded = run(&paths);
    assert_eq!(decoded[0].id, 0);
    assert_eq!(decoded[0].exponent, -1020);
    assert_ne!(decoded[0].status, STROKE_PATH_INVALID_TOLERANCE);
    assert_eq!(decoded[1].id, u32::MAX);
    assert_eq!(decoded[1].exponent, i32::MIN);
    assert_eq!(decoded[1].status, STROKE_PATH_INVALID_TOLERANCE);
    assert_eq!(decoded[2].status, STROKE_PATH_EMPTY);
    assert_eq!(decoded[2].exponent, 7);
    // The request record's field offsets (section 7.3).
    let input = pack(&[f1(0xA1B2_C3D4)
        .style(SQUARE, BEVEL, 1.5)
        .width(3.25)
        .exponent(-9)]);
    assert_eq!(read_u32(&input, 48), Some(0xA1B2_C3D4));
    assert_eq!(read_u32(&input, 52), Some(SQUARE));
    assert_eq!(read_u32(&input, 56), Some(BEVEL));
    assert_eq!(read_u32(&input, 60), Some((-9i32) as u32));
    assert_eq!(read_f64(&input, 64), Some(3.25));
    assert_eq!(read_f64(&input, 72), Some(1.5));
    let parsed = StrokeInput::parse(&input).unwrap().request(0).unwrap();
    assert_eq!(
        parsed,
        StrokeRequest {
            request_id: 0xA1B2_C3D4,
            width: 3.25,
            cap: StrokeCap::Square,
            join: StrokeJoin::Bevel,
            miter_limit: 1.5,
            exponent: -9,
        }
    );
}

#[test]
fn p2_v1_verb_limit_paths_are_work_limit() {
    // SC17: 65,537 LINE verbs exceed P2 v1's 65,536 output verbs per path and so every
    // stroke source cap.
    let path = long_lines(1, 65_537).exponent(0);
    assert_eq!(path.verbs.len(), 65_538);
    assert_eq!(status_of(path), STROKE_PATH_WORK_LIMIT);
}

#[test]
fn former_interim_cubics_are_ok_through_the_export() {
    // ST-U3 returned its interim `unsupported-geometry` for any cubic that is not zero-length;
    // since ST-U4 these reach the export as meshes. ST-F16p (cusp; ST-F16's curve at e = -5),
    // ST-F17 (collinear reversal) and ST-F19 (collinear continuation, exact area 4), each
    // through the export and equal to the workspace's mesh.
    let cases = [
        TestPath::new(1)
            .m(0.0, 0.0)
            .c([1.0, 1.0, 0.0, 1.0, 1.0, 0.0])
            .width(0.125)
            .exponent(-5),
        TestPath::new(2)
            .m(3.0, 0.0)
            .c([-1.0, 0.0, -1.0, 0.0, 3.0, 0.0]),
        TestPath::new(3)
            .m(-1.0, 0.0)
            .c([1.0, 0.0, -1.0, 0.0, 1.0, 0.0]),
    ];
    let decoded = run(&cases);
    let mut workspace = StrokeWorkspace::new().unwrap();
    for (path, mesh) in cases.iter().zip(&decoded) {
        assert_eq!(mesh.status, STROKE_PATH_OK, "path {}", path.id);
        assert_ne!(mesh.status, STROKE_PATH_UNSUPPORTED_GEOMETRY);
        assert_eq!(
            workspace.build(path.request(), &path.verbs, &path.point_bytes()),
            Ok(StrokeOutcome::Mesh)
        );
        let (vertices, triangles, _) = workspace.mesh().unwrap();
        assert_eq!(mesh.positions.len(), 2 * vertices.len());
        assert_eq!(mesh.indices, triangles);
    }
    assert_area(
        &decoded[1],
        6.0 + HALF_SIXTEEN_GON,
        CLOSE_AREA,
        "ST-F17 butt",
    );
    assert_area(&decoded[2], 4.0, 0.0, "ST-F19");
    // ST-F16 itself (e = -8) is a labelled current-cap fixture since the 2026-10-20 decision:
    // `work-limit` at STROKE_V0_LIMITS, never `unsupported-geometry`.
    let f16 = TestPath::new(5)
        .m(0.0, 0.0)
        .c([1.0, 1.0, 0.0, 1.0, 1.0, 0.0])
        .width(0.125)
        .exponent(-8);
    assert_eq!(status_of(f16), STROKE_PATH_WORK_LIMIT);
    // ST-U3's own interim fixture (w = 2, e = -3) is now also a current-cap `work-limit`.
    let interim = TestPath::new(4)
        .m(0.0, 0.0)
        .c([1.0, 1.0, 0.0, 1.0, 1.0, 0.0]);
    assert_eq!(status_of(interim), STROKE_PATH_WORK_LIMIT);
}
