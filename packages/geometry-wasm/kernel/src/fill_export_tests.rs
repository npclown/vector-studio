//! Native tests for the P3 D8 V2 fill-mesh transport v0
//! (`docs/plans/p3-v2-fill-mesh-transport-contract.md`, sections a, c, e, f, k).

use core::cmp::Ordering;

use crate::codec::{align_up, read_f64, read_u32, write_f64, write_u32, PathInput, Request};
use crate::cubic_fill::{CubicFillError, CubicFillWorkspace, MAX_FLAT_COMMANDS};
use crate::engine::{
    BATCH_ALLOCATION_FAILED, BATCH_DISPOSED, BATCH_INTERNAL_ERROR, BATCH_INVALID_BATCH, BATCH_OK,
    BATCH_OUTPUT_CAPACITY, BATCH_RESOURCE_LIMIT,
};
use crate::fill_export::FillRequest;
use crate::fill_export::{
    construction_status, map_attempt_error, map_flat_status, tolerances, FillEngine, Mapped,
    FILL_INPUT_MAGIC, FILL_OUTPUT_MAGIC, FILL_PATH_EMPTY, FILL_PATH_INVALID_PATH,
    FILL_PATH_INVALID_TOLERANCE, FILL_PATH_NUMERIC_RANGE, FILL_PATH_OK,
    FILL_PATH_UNSUPPORTED_GEOMETRY, FILL_PATH_WORK_LIMIT, FILL_V0_LIMITS, FILL_V0_REVISION,
    FILL_V0_VERSION, INPUT_CAP_BYTES, OUTPUT_CAP_BYTES,
};
use crate::fill_ladder::{with_ladder_faults, LadderFault, Reason, Rung};
use crate::fill_predicates::orient2d;
use crate::geometry::{
    Point, PATH_EMPTY, PATH_INVALID, PATH_INVALID_TOLERANCE, PATH_NUMERIC_RANGE, PATH_OK,
    PATH_WORK_LIMIT,
};
use crate::line_fill::LineFillRule;
use crate::rounded_line_fill::RoundedFillError;
use crate::simple_cubic_topology::TopologyError;

const MOVE: u8 = 0;
const LINE: u8 = 1;
const CUBIC: u8 = 2;
const CLOSE: u8 = 3;
const NONZERO: u32 = 0;
const EVENODD: u32 = 1;

#[derive(Clone, Debug, Default)]
struct TestPath {
    id: u32,
    rule: u32,
    exponent: i32,
    verbs: Vec<u8>,
    points: Vec<f64>,
}

impl TestPath {
    fn new(id: u32, rule: u32, exponent: i32) -> Self {
        Self {
            id,
            rule,
            exponent,
            ..Self::default()
        }
    }

    fn move_to(mut self, x: f64, y: f64) -> Self {
        self.verbs.push(MOVE);
        self.points.extend([x, y]);
        self
    }

    fn line_to(mut self, x: f64, y: f64) -> Self {
        self.verbs.push(LINE);
        self.points.extend([x, y]);
        self
    }

    fn cubic_to(mut self, points: [f64; 6]) -> Self {
        self.verbs.push(CUBIC);
        self.points.extend(points);
        self
    }

    /// A cubic whose controls trisect the chord, as the native fixtures use.
    fn linear_cubic_to(self, start: (f64, f64), end: (f64, f64)) -> Self {
        self.cubic_to([
            start.0 + (end.0 - start.0) / 3.0,
            start.1 + (end.1 - start.1) / 3.0,
            start.0 + 2.0 * (end.0 - start.0) / 3.0,
            start.1 + 2.0 * (end.1 - start.1) / 3.0,
            end.0,
            end.1,
        ])
    }

    fn close(mut self) -> Self {
        self.verbs.push(CLOSE);
        self
    }

    fn rectangle(self, x0: f64, y0: f64, x1: f64, y1: f64) -> Self {
        self.move_to(x0, y0)
            .line_to(x1, y0)
            .line_to(x1, y1)
            .line_to(x0, y1)
            .close()
    }

    fn reversed_rectangle(self, x0: f64, y0: f64, x1: f64, y1: f64) -> Self {
        self.move_to(x0, y0)
            .line_to(x0, y1)
            .line_to(x1, y1)
            .line_to(x1, y0)
            .close()
    }
}

/// Packs a fill-v0 input exactly as section a lays it out.
fn pack(paths: &[TestPath]) -> Vec<u8> {
    let path_count = paths.len();
    let verb_count: usize = paths.iter().map(|path| path.verbs.len()).sum();
    let point_count: usize = paths.iter().map(|path| path.points.len()).sum();
    let requests = 48;
    let path_offsets = requests + 16 * path_count;
    let point_offsets = path_offsets + 4 * (path_count + 1);
    let verbs = point_offsets + 4 * (path_count + 1);
    let points = align_up(verbs + verb_count, 8).unwrap();
    let total = points + 8 * point_count;
    let mut bytes = vec![0u8; total];
    let header = [
        FILL_INPUT_MAGIC,
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
        let request = requests + 16 * index;
        write_u32(&mut bytes, request, path.id).unwrap();
        write_u32(&mut bytes, request + 4, path.rule).unwrap();
        write_u32(&mut bytes, request + 8, path.exponent as u32).unwrap();
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
    fn point(&self, vertex: u32) -> (f64, f64) {
        let index = vertex as usize * 2;
        (self.positions[index], self.positions[index + 1])
    }

    fn boundary_points(&self) -> Vec<((f64, f64), (f64, f64))> {
        self.boundary
            .chunks_exact(2)
            .map(|pair| (self.point(pair[0]), self.point(pair[1])))
            .collect()
    }

    fn twice_area(&self) -> f64 {
        self.indices
            .chunks_exact(3)
            .map(|triangle| {
                let a = self.point(triangle[0]);
                let b = self.point(triangle[1]);
                let c = self.point(triangle[2]);
                (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0)
            })
            .sum()
    }
}

/// Decodes a published output and checks every framing rule of section a.
fn decode(output: &[u8], paths: &[TestPath]) -> Vec<Decoded> {
    assert_eq!(read_u32(output, 0), Some(FILL_OUTPUT_MAGIC));
    assert_eq!(read_u32(output, 4), Some(FILL_V0_VERSION));
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
        if status != FILL_PATH_OK {
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

fn load(engine: &mut FillEngine, input: &[u8], output_capacity: u32) {
    assert_eq!(
        engine.reserve(input.len() as u32, output_capacity),
        BATCH_OK
    );
    engine.input_bytes_mut()[..input.len()].copy_from_slice(input);
}

/// Runs one batch in a fresh engine with enough capacity.
fn run(paths: &[TestPath]) -> Vec<Decoded> {
    let input = pack(paths);
    let mut engine = FillEngine::new();
    load(&mut engine, &input, 1 << 20);
    assert_eq!(engine.process(input.len() as u32), BATCH_OK);
    decode(engine.output_bytes(), paths)
}

fn run_one(path: TestPath) -> Decoded {
    run(&[path]).remove(0)
}

fn status_of(path: TestPath) -> u32 {
    run_one(path).status
}

fn square(id: u32, rule: u32, exponent: i32) -> TestPath {
    TestPath::new(id, rule, exponent).rectangle(0.0, 0.0, 10.0, 10.0)
}

/// Independent mesh check in exact predicates: positive triangles, the
/// boundary equals the edges used exactly once, and conformity.
fn assert_mesh_invariants(mesh: &Decoded) {
    let point = |vertex: u32| {
        let (x, y) = mesh.point(vertex);
        Point { x, y }
    };
    let mut directed: Vec<(u32, u32)> = Vec::new();
    for triangle in mesh.indices.chunks_exact(3) {
        assert_eq!(
            orient2d(point(triangle[0]), point(triangle[1]), point(triangle[2])),
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
            let (pa, pb, pv) = (point(a), point(b), point(vertex));
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

#[test]
fn runtime_limits_equal_the_native_test_limits() {
    assert_eq!(FILL_V0_LIMITS, crate::native_cubic_fill_tests::LIMITS);
    assert_eq!(FILL_V0_VERSION, 0);
    assert_eq!(FILL_V0_REVISION, 2);
    assert_eq!(FILL_INPUT_MAGIC.to_le_bytes(), *b"VGF0");
    assert_eq!(FILL_OUTPUT_MAGIC.to_le_bytes(), *b"VGM0");
    let (slots, split, bytes) = FillEngine::scratch_sizes().unwrap();
    assert_eq!(slots, 3 * (256 + 2 * 256));
    assert_eq!(split, 512 + 256);
    assert!(bytes > 0);
}

#[test]
fn tolerances_are_exact_normal_powers_of_two() {
    for exponent in [-1021, -1020, -60, -3, -1, 0, 1, 52, 1022, 1023] {
        let (flatten, topology) = tolerances(exponent);
        assert!(flatten.is_normal() && topology.is_normal());
        assert_eq!(flatten, 2f64.powi(exponent));
        assert_eq!(topology * 2.0, flatten);
    }
    assert_eq!(tolerances(-1021).1, f64::MIN_POSITIVE);
    assert_eq!(tolerances(1023).0, 2f64.powi(1023));
}

#[test]
fn mapping_table_is_exhaustive_and_matches_section_e() {
    use CubicFillError as E;
    use RoundedFillError as R;
    use TopologyError as T;
    let work = Mapped::Path(FILL_PATH_WORK_LIMIT);
    let unsupported = Mapped::Path(FILL_PATH_UNSUPPORTED_GEOMETRY);
    let rows = [
        (E::SourceLimit, work),
        (E::CommandLimit, work),
        (E::ContourLimit, work),
        (E::PointLimit, work),
        (E::OwnerLimit, work),
        (E::UnsupportedSource, unsupported),
        (E::ZeroLengthLeaf, unsupported),
        (E::Topology(T::KnotMismatch), unsupported),
        (E::Topology(T::Unresolved), unsupported),
        (E::Topology(T::WorkLimit), work),
        (E::Topology(T::ByteLimit), work),
        (E::Rounded(R::InputLimit), work),
        (E::Rounded(R::EdgeLimit), work),
        (E::Rounded(R::PairLimit), work),
        (E::Rounded(R::EventLimit), work),
        (E::Rounded(R::SectionLimit), work),
        (E::Rounded(R::NodeLimit), work),
        (E::Rounded(R::CellLimit), work),
        (E::Rounded(R::BoundaryLimit), work),
        (E::Rounded(R::ContributorLimit), work),
        (E::Rounded(R::WorkLimit), work),
        (E::Rounded(R::OutputLimit), work),
        (E::Rounded(R::TopologyAmbiguous), unsupported),
        (
            E::Rounded(R::InvalidTolerance),
            Mapped::Path(FILL_PATH_INVALID_TOLERANCE),
        ),
        (E::EmissionStatus(PATH_NUMERIC_RANGE), Mapped::Internal),
        (E::Rounded(R::InvalidInput), Mapped::Internal),
        (E::PlanMismatch, Mapped::Internal),
        (E::BoundsMismatch, Mapped::Internal),
        (E::InvalidCommand, Mapped::Internal),
        (E::InvalidProvenance, Mapped::Internal),
        (E::TopologyOwnership, Mapped::Internal),
        (E::RoundedOwnership, Mapped::Internal),
        (E::Topology(T::InvalidInput), Mapped::Internal),
        (E::Topology(T::InvalidProvenance), Mapped::Internal),
        (E::Rounded(R::InternalInvariant), Mapped::Internal),
        (E::Topology(T::InvalidLimits), Mapped::Internal),
        (E::Topology(T::AllocationFailed), Mapped::Internal),
        (E::Rounded(R::InvalidLimits), Mapped::Internal),
        (E::Rounded(R::AllocationFailed), Mapped::Internal),
        (E::Rounded(R::ByteLimit), Mapped::Internal),
        (E::CombinedByteLimit, Mapped::Internal),
    ];
    // 15 plain CubicFillError variants (EmissionStatus counted once), 8
    // topology and 18 rounded variants.
    assert_eq!(rows.len(), 15 + 8 + 18);
    for (error, expected) in rows {
        assert_eq!(map_attempt_error(error), expected, "{error:?}");
    }
    assert_eq!(map_flat_status(PATH_OK), Mapped::Path(FILL_PATH_OK));
    assert_eq!(map_flat_status(PATH_EMPTY), Mapped::Path(FILL_PATH_EMPTY));
    assert_eq!(
        map_flat_status(PATH_INVALID),
        Mapped::Path(FILL_PATH_INVALID_PATH)
    );
    assert_eq!(
        map_flat_status(PATH_INVALID_TOLERANCE),
        Mapped::Path(FILL_PATH_INVALID_TOLERANCE)
    );
    assert_eq!(
        map_flat_status(PATH_NUMERIC_RANGE),
        Mapped::Path(FILL_PATH_NUMERIC_RANGE)
    );
    assert_eq!(
        map_flat_status(PATH_WORK_LIMIT),
        Mapped::Path(FILL_PATH_WORK_LIMIT)
    );
    assert_eq!(map_flat_status(99), Mapped::Internal);

    assert_eq!(
        construction_status(E::Topology(T::AllocationFailed)),
        BATCH_ALLOCATION_FAILED
    );
    assert_eq!(
        construction_status(E::Rounded(R::AllocationFailed)),
        BATCH_ALLOCATION_FAILED
    );
    for error in [
        E::Topology(T::InvalidLimits),
        E::Rounded(R::InvalidLimits),
        E::Rounded(R::ByteLimit),
        E::CombinedByteLimit,
    ] {
        assert_eq!(construction_status(error), BATCH_INTERNAL_ERROR);
    }
}

#[test]
fn input_framing_rejections_are_invalid_batch() {
    let paths = [
        square(1, NONZERO, 0),
        TestPath::new(2, EVENODD, -3).move_to(0.0, 0.0),
    ];
    let valid = pack(&paths);
    let points_offset = read_u32(&valid, 40).unwrap() as usize;
    let verbs_end = read_u32(&valid, 36).unwrap() as usize + paths[0].verbs.len() + 1;
    assert!(verbs_end < points_offset, "fixture needs verb padding");
    let path_offsets = read_u32(&valid, 28).unwrap() as usize;
    let point_offsets = read_u32(&valid, 32).unwrap() as usize;

    let mut cases: Vec<(&str, Vec<u8>)> = Vec::new();
    let mut corrupt = |name: &'static str, offset: usize, value: u32| {
        let mut bytes = valid.clone();
        write_u32(&mut bytes, offset, value).unwrap();
        cases.push((name, bytes));
    };
    corrupt("magic", 0, 0x3253_4756);
    corrupt("version", 4, 1);
    corrupt("total bytes", 8, valid.len() as u32 - 8);
    corrupt("path count", 12, 3);
    corrupt("verb count", 16, 11);
    corrupt("point count", 20, 9);
    corrupt("requests offset", 24, 56);
    corrupt("path offsets offset", 28, path_offsets as u32 + 4);
    corrupt("point offsets offset", 32, point_offsets as u32 + 4);
    corrupt("verbs offset", 36, read_u32(&valid, 36).unwrap() + 1);
    corrupt("points offset", 40, points_offset as u32 - 8);
    corrupt("header reserved", 44, 1);
    corrupt("fill rule", 48 + 4, 2);
    corrupt("request reserved", 48 + 16 + 12, 1);
    corrupt("first path offset", path_offsets, 1);
    corrupt("decreasing path offsets", path_offsets + 4, 7);
    corrupt("terminal path offset", path_offsets + 8, 5);
    corrupt("first point offset", point_offsets, 2);
    corrupt("decreasing point offsets", point_offsets + 4, 11);
    corrupt("terminal point offset", point_offsets + 8, 8);
    let mut padding = valid.clone();
    padding[verbs_end] = 1;
    cases.push(("verb padding", padding));
    let mut truncated = valid.clone();
    truncated.truncate(40);
    cases.push(("short header", truncated));

    for (name, bytes) in cases {
        let mut engine = FillEngine::new();
        load(&mut engine, &bytes, 1 << 16);
        assert_eq!(
            engine.process(bytes.len() as u32),
            BATCH_INVALID_BATCH,
            "{name}"
        );
        assert_eq!(engine.result_len(), 0, "{name}");
        assert_eq!(engine.required_output_bytes(), 0, "{name}");
    }

    let mut engine = FillEngine::new();
    load(&mut engine, &valid, 1 << 16);
    let beyond = engine.input_capacity() + 1;
    assert_eq!(engine.process(beyond), BATCH_INVALID_BATCH);
    assert_eq!(engine.process(valid.len() as u32), BATCH_OK);
}

#[test]
fn empty_batch_publishes_header_only_and_rejects_nothing() {
    let input = pack(&[]);
    assert_eq!(input.len(), 56);
    let mut engine = FillEngine::new();
    load(&mut engine, &input, 64);
    assert_eq!(engine.process(input.len() as u32), BATCH_OK);
    assert_eq!(engine.result_len(), 64);
    assert!(decode(engine.output_bytes(), &[]).is_empty());
}

#[test]
fn per_path_statuses_follow_the_stage_order() {
    let nan = TestPath::new(1, NONZERO, 0)
        .move_to(0.0, 0.0)
        .line_to(f64::NAN, 1.0);
    let mut odd = TestPath::new(2, NONZERO, 0).move_to(0.0, 0.0);
    odd.points.push(1.0);
    let mut unknown = TestPath::new(3, NONZERO, 0).move_to(0.0, 0.0);
    unknown.verbs.push(9);
    let grammar = TestPath::new(4, NONZERO, 0).line_to(1.0, 1.0);
    let repeated_close = square(5, NONZERO, 0).close();
    for path in [nan, odd, unknown, grammar, repeated_close] {
        assert_eq!(status_of(path), FILL_PATH_INVALID_PATH);
    }
    // invalid-path beats invalid-tolerance.
    assert_eq!(
        status_of(TestPath::new(6, NONZERO, 5000).line_to(1.0, 1.0)),
        FILL_PATH_INVALID_PATH
    );
    for exponent in [-1022, 1024, i32::MIN, i32::MAX] {
        assert_eq!(
            status_of(square(7, NONZERO, exponent)),
            FILL_PATH_INVALID_TOLERANCE
        );
        // invalid-tolerance beats empty.
        assert_eq!(
            status_of(TestPath::new(7, NONZERO, exponent)),
            FILL_PATH_INVALID_TOLERANCE
        );
    }
    for exponent in [-1021, 0, 1023] {
        assert_ne!(
            status_of(square(8, NONZERO, exponent)),
            FILL_PATH_INVALID_TOLERANCE
        );
    }
    assert_eq!(status_of(TestPath::new(9, NONZERO, 0)), FILL_PATH_EMPTY);
    assert_eq!(
        status_of(TestPath::new(10, NONZERO, 0).move_to(1.0, 2.0)),
        FILL_PATH_EMPTY
    );
    assert_eq!(
        status_of(
            TestPath::new(11, EVENODD, 0)
                .rectangle(0.0, 0.0, 10.0, 10.0)
                .rectangle(0.0, 0.0, 10.0, 10.0)
        ),
        FILL_PATH_EMPTY
    );
    assert_eq!(
        status_of(
            TestPath::new(12, NONZERO, 0)
                .rectangle(0.0, 0.0, 10.0, 10.0)
                .reversed_rectangle(0.0, 0.0, 10.0, 10.0)
        ),
        FILL_PATH_EMPTY
    );
}

#[test]
fn reachable_mapping_rows_have_fixtures() {
    // Sizing NUMERIC_RANGE: the P2 rounding guard reaches 2^-60.
    let cubic = TestPath::new(1, NONZERO, -60)
        .move_to(0.0, 0.0)
        .cubic_to([1.0, 2.0, 3.0, 2.0, 4.0, 0.0])
        .close();
    assert_eq!(status_of(cubic.clone()), FILL_PATH_NUMERIC_RANGE);
    // The same cubic at a coarse tolerance meshes.
    let mut coarse = cubic;
    coarse.exponent = -3;
    assert_eq!(status_of(coarse), FILL_PATH_OK);

    // Current-cap fixtures (B1 may re-baseline): source verbs 24 + 1.
    let mut source = TestPath::new(2, NONZERO, 0).move_to(0.0, 0.0);
    for index in 0..24 {
        source = source.line_to(f64::from(index + 1), f64::from(index % 2));
    }
    assert_eq!(source.verbs.len(), 25);
    assert_eq!(status_of(source), FILL_PATH_WORK_LIMIT);
    // Flat command cap: a fine cubic flattens to more than 72 commands.
    let fine = TestPath::new(3, NONZERO, -12)
        .move_to(0.0, 0.0)
        .cubic_to([0.0, 64.0, 64.0, 64.0, 64.0, 0.0])
        .close();
    assert_eq!(status_of(fine), FILL_PATH_WORK_LIMIT);
    // MOVE + 65,536 LINE = 65,537 output verbs, above P2's frozen 65,536 per
    // path (P2 counts the MOVE); today SourceLimit fires first. Both map to
    // work-limit, independent of B1.
    let mut long = TestPath::new(4, NONZERO, 0).move_to(0.0, 0.0);
    for index in 0..65_536 {
        long = long.line_to(f64::from(index % 7), f64::from(index % 5));
    }
    assert_eq!(long.verbs.len(), 65_537);
    assert_eq!(status_of(long), FILL_PATH_WORK_LIMIT);

    // v0 limitation: a MOVE-only subpath in a curved path.
    let curved_move = TestPath::new(5, NONZERO, -3)
        .move_to(5.0, 5.0)
        .move_to(0.0, 0.0)
        .cubic_to([1.0, 2.0, 3.0, 2.0, 4.0, 0.0])
        .close();
    assert_eq!(status_of(curved_move), FILL_PATH_UNSUPPORTED_GEOMETRY);
    let trailing_move = TestPath::new(6, NONZERO, -3)
        .move_to(0.0, 0.0)
        .cubic_to([1.0, 2.0, 3.0, 2.0, 4.0, 0.0])
        .close()
        .move_to(9.0, 9.0);
    assert_eq!(status_of(trailing_move), FILL_PATH_UNSUPPORTED_GEOMETRY);
    // A line-only path with a MOVE-only subpath is unaffected.
    let line_move = TestPath::new(7, NONZERO, 0)
        .move_to(50.0, 50.0)
        .rectangle(0.0, 0.0, 10.0, 10.0);
    let line_move = run_one(line_move);
    assert_eq!(line_move.status, FILL_PATH_OK);
    assert_eq!(line_move.twice_area(), 200.0);

    // Rounded TopologyAmbiguous: a one-ulp feature at topology tolerance 1.
    let next = f64::from_bits(1.0f64.to_bits() + 1);
    let ambiguous = TestPath::new(8, NONZERO, 1)
        .move_to(0.0, 1.0)
        .line_to(2.0, next)
        .close()
        .move_to(1.0, 1.0)
        .line_to(1.0, next)
        .close();
    assert_eq!(status_of(ambiguous), FILL_PATH_UNSUPPORTED_GEOMETRY);
}

/// The native adoption bowtie: four linear cubics that cross once.
fn cubic_bowtie(id: u32, rule: u32) -> TestPath {
    let corners = [(0.0, 0.0), (3.0, 3.0), (0.0, 3.0), (3.0, 0.0), (0.0, 0.0)];
    let mut path = TestPath::new(id, rule, -3).move_to(0.0, 0.0);
    for pair in corners.windows(2) {
        path = path.linear_cubic_to(pair[0], pair[1]);
    }
    path.close()
}

/// The native rounded-knot failure control.
fn rounded_failure(id: u32) -> TestPath {
    TestPath::new(id, NONZERO, -3)
        .move_to(0.0, 0.0)
        .cubic_to([1.0, 2f64.powi(-54), 2.0, 1.0, 3.0, 0.0])
        .linear_cubic_to((3.0, 0.0), (1.5, -3.0))
        .linear_cubic_to((1.5, -3.0), (0.0, 0.0))
        .close()
}

/// The native transverse bowtie: one contour of trisection cubics with one
/// transverse self-crossing.
fn transverse_bowtie(id: u32, rule: u32) -> TestPath {
    let vertices = [
        (-3.0, -3.0),
        (3.0, 3.0),
        (3.0, 4.5),
        (-3.0, 4.5),
        (-3.0, 3.0),
        (3.0, -3.0),
        (3.0, -4.5),
        (-3.0, -4.5),
        (-3.0, -3.0),
    ];
    let mut path = TestPath::new(id, rule, -3).move_to(-3.0, -3.0);
    for pair in vertices.windows(2) {
        let (start, end) = (pair[0], pair[1]);
        path = path.cubic_to([
            (2.0 * start.0 + end.0) / 3.0,
            (2.0 * start.1 + end.1) / 3.0,
            (start.0 + 2.0 * end.0) / 3.0,
            (start.1 + 2.0 * end.1) / 3.0,
            end.0,
            end.1,
        ]);
    }
    path.close()
}

fn point_bytes(points: &[f64]) -> Vec<u8> {
    points
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

type RawMesh = (Vec<[u64; 2]>, Vec<u32>);

fn direct(path: &TestPath, triangle_free: bool) -> (Result<(), CubicFillError>, Option<RawMesh>) {
    let mut workspace = CubicFillWorkspace::new(FILL_V0_LIMITS).unwrap();
    let bytes = point_bytes(&path.points);
    let (flatten, topology) = tolerances(path.exponent);
    let input = PathInput::from_parts(
        Request {
            request_id: 0,
            source_epoch: 0,
            source_revision: 0,
            tolerance: flatten,
        },
        &path.verbs,
        &bytes,
    );
    let rule = if path.rule == 0 {
        LineFillRule::Nonzero
    } else {
        LineFillRule::Evenodd
    };
    let result = if triangle_free {
        workspace.attempt_triangle_free(input, rule, topology, MAX_FLAT_COMMANDS)
    } else {
        workspace.attempt(input, rule, topology, MAX_FLAT_COMMANDS)
    };
    let output = workspace.output().map(|output| {
        (
            output
                .rounded
                .vertices
                .iter()
                .map(|point| [point.x.to_bits(), point.y.to_bits()])
                .collect(),
            output.rounded.indices.to_vec(),
        )
    });
    (result.map(|_| ()), output)
}

fn position_bits(mesh: &Decoded) -> Vec<[u64; 2]> {
    mesh.positions
        .chunks_exact(2)
        .map(|pair| [pair[0].to_bits(), pair[1].to_bits()])
        .collect()
}

#[test]
fn cascade_retries_triangle_free_only_after_knot_or_unresolved() {
    // Step 1 rejects the crossing bowtie as Unresolved; step 2 admits it.
    for rule in [NONZERO, EVENODD] {
        let bowtie = transverse_bowtie(1, rule);
        let (legacy, _) = direct(&bowtie, false);
        assert_eq!(
            legacy,
            Err(CubicFillError::Topology(TopologyError::Unresolved))
        );
        let (triangle_free, mesh) = direct(&bowtie, true);
        assert_eq!(triangle_free, Ok(()));
        let exported = run_one(bowtie);
        assert_eq!(exported.status, FILL_PATH_OK);
        assert_eq!(position_bits(&exported), mesh.unwrap().0);
        assert_mesh_invariants(&exported);
    }

    // A simple curved path is admitted by step 1; the mesh is legacy's and
    // the triangle-free mode is never invoked.
    let simple = TestPath::new(2, NONZERO, -3)
        .move_to(0.0, 0.0)
        .cubic_to([1.0, 2.0, 3.0, 2.0, 4.0, 0.0])
        .close();
    let (legacy, mesh) = direct(&simple, false);
    assert_eq!(legacy, Ok(()));
    let input = pack(std::slice::from_ref(&simple));
    let mut engine = FillEngine::new();
    load(&mut engine, &input, 1 << 16);
    assert_eq!(engine.process(input.len() as u32), BATCH_OK);
    let diagnostics = engine.workspace().unwrap().diagnostics();
    assert!(diagnostics.topology_invoked);
    assert!(!diagnostics.transverse_topology_invoked);
    let exported = decode(engine.output_bytes(), std::slice::from_ref(&simple)).remove(0);
    assert_eq!(position_bits(&exported), mesh.unwrap().0);

    // KnotMismatch is retried: the second attempt's result is reported.
    let knot = rounded_failure(3);
    let (legacy, _) = direct(&knot, false);
    assert_eq!(
        legacy,
        Err(CubicFillError::Topology(TopologyError::KnotMismatch))
    );
    let (second, _) = direct(&knot, true);
    let input = pack(std::slice::from_ref(&knot));
    let mut engine = FillEngine::new();
    load(&mut engine, &input, 1 << 16);
    assert_eq!(engine.process(input.len() as u32), BATCH_OK);
    assert!(
        engine
            .workspace()
            .unwrap()
            .diagnostics()
            .transverse_topology_invoked
    );
    let reported = decode(engine.output_bytes(), std::slice::from_ref(&knot))
        .remove(0)
        .status;
    let expected = match second {
        Ok(()) => FILL_PATH_OK,
        Err(error) => match map_attempt_error(error) {
            Mapped::Path(status) => status,
            Mapped::Internal => panic!("internal second attempt"),
        },
    };
    assert_eq!(reported, expected);

    // Both steps reject the linear-cubic bowtie: Unresolved twice is
    // reported as unsupported-geometry after the retry.
    let rejected = cubic_bowtie(6, NONZERO);
    assert_eq!(
        direct(&rejected, false).0,
        Err(CubicFillError::Topology(TopologyError::Unresolved))
    );
    assert_eq!(
        direct(&rejected, true).0,
        Err(CubicFillError::Topology(TopologyError::Unresolved))
    );
    let input = pack(std::slice::from_ref(&rejected));
    let mut engine = FillEngine::new();
    load(&mut engine, &input, 1 << 16);
    assert_eq!(engine.process(input.len() as u32), BATCH_OK);
    assert!(
        engine
            .workspace()
            .unwrap()
            .diagnostics()
            .transverse_topology_invoked
    );
    assert_eq!(
        decode(engine.output_bytes(), std::slice::from_ref(&rejected))[0].status,
        FILL_PATH_UNSUPPORTED_GEOMETRY
    );

    // Other errors are not retried.
    let unsupported = TestPath::new(4, NONZERO, -3)
        .move_to(5.0, 5.0)
        .move_to(0.0, 0.0)
        .cubic_to([1.0, 2.0, 3.0, 2.0, 4.0, 0.0])
        .close();
    let input = pack(std::slice::from_ref(&unsupported));
    let mut engine = FillEngine::new();
    load(&mut engine, &input, 1 << 16);
    assert_eq!(engine.process(input.len() as u32), BATCH_OK);
    assert!(
        !engine
            .workspace()
            .unwrap()
            .diagnostics()
            .transverse_topology_invoked
    );

    // Line-only paths skip topology in every mode.
    let input = pack(&[square(5, NONZERO, 0)]);
    let mut engine = FillEngine::new();
    engine.hooks().exact_only = true;
    load(&mut engine, &input, 1 << 16);
    assert_eq!(engine.process(input.len() as u32), BATCH_OK);
    let diagnostics = engine.workspace().unwrap().diagnostics();
    assert!(!diagnostics.topology_invoked);
    assert!(!diagnostics.transverse_topology_invoked);
}

#[test]
fn hanging_interior_split_edge_is_not_boundary() {
    for rule in [NONZERO, EVENODD] {
        let path = TestPath::new(1, rule, -3)
            .rectangle(0.0, 0.0, 4.0, 4.0)
            .rectangle(4.0, 1.0, 8.0, 3.0);
        // Positive control: the raw kernel mesh has a hanging vertex.
        let (result, raw) = direct(&path, false);
        assert_eq!(result, Ok(()));
        let (vertices, indices) = raw.unwrap();
        assert_eq!(indices.len(), 12);
        let raw_once = edges_used_once(&indices);
        let at = |bits: [u64; 2]| (f64::from_bits(bits[0]), f64::from_bits(bits[1]));
        assert!(raw_once.iter().any(|&(a, b)| {
            let (pa, pb) = (at(vertices[a as usize]), at(vertices[b as usize]));
            (pa, pb) == ((4.0, 1.0), (4.0, 3.0)) || (pa, pb) == ((4.0, 3.0), (4.0, 1.0))
        }));

        let mesh = run_one(path);
        assert_eq!(mesh.status, FILL_PATH_OK);
        assert_mesh_invariants(&mesh);
        assert_eq!(mesh.indices.len(), 18);
        assert_eq!(mesh.twice_area(), 2.0 * 24.0);
        let edges = mesh.boundary_points();
        assert!(!edges.iter().any(|&(a, b)| a.0 == 4.0 && b.0 == 4.0 && {
            let (low, high) = (a.1.min(b.1), a.1.max(b.1));
            low < 3.0 && high > 1.0
        }));
        assert!(edges.contains(&((4.0, 0.0), (4.0, 1.0))));
        assert!(edges.contains(&((4.0, 3.0), (4.0, 4.0))));
        assert_eq!(edges.len(), 8);
    }
}

#[test]
fn hanging_boundary_t_junction_is_split_at_its_vertex() {
    for rule in [NONZERO, EVENODD] {
        let path = TestPath::new(1, rule, -3)
            .rectangle(0.0, 0.0, 10.0, 10.0)
            .rectangle(-5.0, 0.0, 0.0, 5.0);
        let mesh = run_one(path);
        assert_eq!(mesh.status, FILL_PATH_OK);
        assert_mesh_invariants(&mesh);
        assert_eq!(mesh.twice_area(), 2.0 * 125.0);
        let edges = mesh.boundary_points();
        assert!(edges.contains(&((0.0, 10.0), (0.0, 5.0))));
        assert!(!edges
            .iter()
            .any(|&(a, b)| a.0 == 0.0 && b.0 == 0.0 && a.1.min(b.1) < 5.0));
        assert_eq!(edges.len(), 7);
    }
}

fn edges_used_once(indices: &[u32]) -> Vec<(u32, u32)> {
    let directed: Vec<(u32, u32)> = indices
        .chunks_exact(3)
        .flat_map(|t| [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])])
        .collect();
    directed
        .iter()
        .copied()
        .filter(|&(a, b)| {
            directed
                .iter()
                .filter(|&&(c, d)| (a == c && b == d) || (a == d && b == c))
                .count()
                == 1
        })
        .collect()
}

#[test]
fn integer_fixtures_mesh_their_exact_regions() {
    let f01 = |id, rule| TestPath::new(id, rule, -3).rectangle(0.0, 0.0, 10.0, 10.0);
    let f02 = |id, rule| f01(id, rule).rectangle(3.0, 3.0, 7.0, 7.0);
    let f03 = |id, rule| f01(id, rule).reversed_rectangle(3.0, 3.0, 7.0, 7.0);
    let f06 = |id, rule| {
        TestPath::new(id, rule, -3)
            .move_to(0.0, 0.0)
            .line_to(4.0, 4.0)
            .line_to(0.0, 4.0)
            .line_to(4.0, 0.0)
            .close()
    };
    let f07 = |id, rule| {
        TestPath::new(id, rule, -3)
            .rectangle(0.0, 0.0, 2.0, 2.0)
            .rectangle(2.0, 0.0, 4.0, 2.0)
    };
    let f10 = |id, rule| {
        TestPath::new(id, rule, -3)
            .rectangle(0.0, 0.0, 4.0, 4.0)
            .rectangle(2.0, 0.0, 6.0, 4.0)
    };
    let f10r = |id, rule| {
        TestPath::new(id, rule, -3)
            .rectangle(0.0, 0.0, 4.0, 4.0)
            .reversed_rectangle(2.0, 0.0, 6.0, 4.0)
    };
    let f11 = |id, rule| {
        TestPath::new(id, rule, -3)
            .rectangle(0.0, 0.0, 4.0, 4.0)
            .rectangle(2.0, 4.0, 6.0, 8.0)
    };
    let cases: [(TestPath, f64); 16] = [
        (f01(1, NONZERO), 100.0),
        (f01(2, EVENODD), 100.0),
        (f02(3, NONZERO), 100.0),
        (f02(4, EVENODD), 84.0),
        (f03(5, NONZERO), 84.0),
        (f03(6, EVENODD), 84.0),
        (f06(7, NONZERO), 8.0),
        (f06(8, EVENODD), 8.0),
        (f07(9, NONZERO), 8.0),
        (f07(10, EVENODD), 8.0),
        (f10(11, NONZERO), 24.0),
        (f10(12, EVENODD), 16.0),
        (f10r(13, NONZERO), 16.0),
        (f10r(14, EVENODD), 16.0),
        (f11(15, NONZERO), 32.0),
        (f11(16, EVENODD), 32.0),
    ];
    let paths: Vec<TestPath> = cases.iter().map(|(path, _)| path.clone()).collect();
    let meshes = run(&paths);
    for ((path, area), mesh) in cases.iter().zip(&meshes) {
        assert_eq!(mesh.status, FILL_PATH_OK, "{}", path.id);
        assert_mesh_invariants(mesh);
        assert_eq!(mesh.twice_area(), 2.0 * area, "{}", path.id);
    }
    // Isolation and position independence: each equals its single run.
    for (path, mesh) in paths.iter().zip(&meshes) {
        assert_eq!(&run_one(path.clone()), mesh);
    }
}

#[test]
fn capacity_retry_reports_the_exact_requirement() {
    let paths = [
        square(1, NONZERO, 0),
        TestPath::new(2, NONZERO, 0).line_to(1.0, 1.0),
        cubic_bowtie(3, EVENODD),
    ];
    let input = pack(&paths);
    let mut reference = FillEngine::new();
    load(&mut reference, &input, 1 << 16);
    assert_eq!(reference.process(input.len() as u32), BATCH_OK);
    let expected = reference.output_bytes().to_vec();
    let required = expected.len() as u32;

    for capacity in [0, 8, 64, 64 + 80 * 3 - 1, 64 + 80 * 3 + 8, required - 1] {
        let mut engine = FillEngine::new();
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
        engine.input_bytes_mut()[..input.len()].copy_from_slice(&input);
        assert_eq!(engine.process(input.len() as u32), BATCH_OK);
        assert_eq!(engine.result_len(), required);
        assert_eq!(engine.output_bytes(), expected.as_slice());
    }
}

#[test]
fn transport_caps_hold_at_limit_and_reject_limit_plus_one() {
    let mut engine = FillEngine::new();
    assert_eq!(engine.reserve(INPUT_CAP_BYTES + 1, 0), BATCH_RESOURCE_LIMIT);
    assert_eq!(
        engine.reserve(0, OUTPUT_CAP_BYTES + 1),
        BATCH_RESOURCE_LIMIT
    );
    assert_eq!(engine.input_capacity(), 0);
    assert_eq!(engine.output_capacity(), 0);
    assert_eq!(engine.reserve(INPUT_CAP_BYTES, OUTPUT_CAP_BYTES), BATCH_OK);
    assert_eq!(engine.input_capacity(), INPUT_CAP_BYTES);
    assert_eq!(engine.output_capacity(), OUTPUT_CAP_BYTES);
    assert_eq!(engine.reserve(u32::MAX, 0), BATCH_RESOURCE_LIMIT);
    assert_eq!(engine.input_capacity(), INPUT_CAP_BYTES);

    // Output total at the cap publishes; one byte above is RESOURCE_LIMIT
    // with no requirement. A test seam lowers the cap to a reachable size.
    let paths = [square(1, NONZERO, 0), square(2, EVENODD, 0)];
    let input = pack(&paths);
    let mut sizing = FillEngine::new();
    load(&mut sizing, &input, 1 << 16);
    assert_eq!(sizing.process(input.len() as u32), BATCH_OK);
    let total = sizing.result_len();
    for (cap, status) in [(total, BATCH_OK), (total - 1, BATCH_RESOURCE_LIMIT)] {
        let mut engine = FillEngine::new();
        engine.hooks().output_cap = Some(cap);
        load(&mut engine, &input, 1 << 16);
        assert_eq!(engine.process(input.len() as u32), status);
        if status == BATCH_RESOURCE_LIMIT {
            assert_eq!(engine.required_output_bytes(), 0);
            assert_eq!(engine.result_len(), 0);
        }
    }
    // RESOURCE_LIMIT beats OUTPUT_CAPACITY.
    let mut engine = FillEngine::new();
    engine.hooks().output_cap = Some(total - 1);
    load(&mut engine, &input, 8);
    assert_eq!(engine.process(input.len() as u32), BATCH_RESOURCE_LIMIT);
    assert_eq!(engine.required_output_bytes(), 0);
}

#[test]
fn epochs_advance_once_per_mutation_and_exhaustion_fails_closed() {
    let mut engine = FillEngine::new();
    assert_eq!(engine.memory_epoch(), 0);
    assert_eq!(engine.reserve(64, 64), BATCH_OK);
    assert_eq!(engine.memory_epoch(), 1);
    assert_eq!(engine.reserve(0, 0), BATCH_OK);
    assert_eq!(engine.memory_epoch(), 2);
    assert_eq!(engine.process(0), BATCH_INVALID_BATCH);
    assert_eq!(engine.memory_epoch(), 3);

    engine.set_epoch(u32::MAX - 1);
    assert_eq!(engine.reserve(0, 0), BATCH_OK);
    assert_eq!(engine.memory_epoch(), u32::MAX);
    assert_eq!(engine.process(0), BATCH_DISPOSED);
    assert_eq!(engine.memory_epoch(), u32::MAX);
    assert!(engine.is_disposed());
    assert_eq!(engine.dispose(), BATCH_OK);
    assert_eq!(engine.memory_epoch(), u32::MAX);
    assert_eq!(engine.input_capacity(), 0);
    assert!(engine.workspace().is_none());
}

#[test]
fn dispose_is_terminal_and_idempotent() {
    let input = pack(&[square(1, NONZERO, 0)]);
    let mut engine = FillEngine::new();
    load(&mut engine, &input, 1 << 12);
    assert!(engine.heap_bytes() > 0);
    let epoch = engine.memory_epoch();
    assert_eq!(engine.dispose(), BATCH_OK);
    assert_eq!(engine.memory_epoch(), epoch + 1);
    assert_eq!(engine.input_capacity(), 0);
    assert_eq!(engine.output_capacity(), 0);
    assert!(engine.workspace().is_none());
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
        let input = pack(&[square(1, NONZERO, 0)]);
        let mut engine = FillEngine::new();
        engine.hooks().fail_workspace = Some(status);
        assert_eq!(engine.reserve(input.len() as u32, 1 << 12), status);
        assert!(engine.workspace().is_none());
        assert_eq!(engine.input_capacity(), input.len() as u32);
        engine.input_bytes_mut()[..input.len()].copy_from_slice(&input);
        assert_eq!(engine.process(input.len() as u32), BATCH_ALLOCATION_FAILED);
        assert_eq!(engine.result_len(), 0);
        // INVALID_BATCH precedes the missing workspace.
        assert_eq!(engine.process(8), BATCH_INVALID_BATCH);
        assert_eq!(engine.reserve(0, 0), BATCH_OK);
        assert!(engine.workspace().is_some());
        engine.input_bytes_mut()[..input.len()].copy_from_slice(&input);
        assert_eq!(engine.process(input.len() as u32), BATCH_OK);
    }
}

#[test]
fn self_check_failure_is_internal_error_and_the_engine_recovers() {
    let paths = [square(1, NONZERO, 0), square(2, EVENODD, 0)];
    let input = pack(&paths);
    let mut engine = FillEngine::new();
    load(&mut engine, &input, 1 << 12);
    assert_eq!(engine.process(input.len() as u32), BATCH_OK);
    let expected = engine.output_bytes().to_vec();
    engine.hooks().fault_path = Some(1);
    assert_eq!(engine.process(input.len() as u32), BATCH_INTERNAL_ERROR);
    assert_eq!(engine.result_len(), 0);
    assert_eq!(engine.required_output_bytes(), 0);
    assert!(engine.raw_output()[..64].iter().all(|byte| *byte == 0));
    // INTERNAL_ERROR beats OUTPUT_CAPACITY.
    let mut small = FillEngine::new();
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
        square(1, NONZERO, 0),
        cubic_bowtie(2, NONZERO),
        TestPath::new(3, NONZERO, -3)
            .move_to(0.0, 0.0)
            .cubic_to([1.0, 2.0, 3.0, 2.0, 4.0, 0.0])
            .close(),
        TestPath::new(4, NONZERO, -3)
            .rectangle(0.0, 0.0, 4.0, 4.0)
            .rectangle(4.0, 1.0, 8.0, 3.0),
        rounded_failure(5),
        TestPath::new(6, NONZERO, 0).line_to(1.0, 1.0),
        // Alt-A1 AL-U3: fast-admitted paths and every fallback reason reachable through the
        // export (`DEVIATION` has no real input; `TRIANGLE` and `MESH_CHECK` are seeded below).
        square(7, NONZERO, 511),
        TestPath::new(8, NONZERO, -12)
            .move_to(0.0, 0.0)
            .cubic_to([0.0, 64.0, 64.0, 64.0, 64.0, 0.0])
            .close(),
        square(9, NONZERO, -3).move_to(20.0, 0.0).line_to(21.0, 0.0),
        TestPath {
            id: 10,
            rule: NONZERO,
            exponent: -3,
            verbs: vec![MOVE, CUBIC, CUBIC, CUBIC, CLOSE],
            points: [
                0xc012_27b6_d3c8_7953u64,
                0xbfeb_648e_a01d_d46e,
                0xc001_2bb4_ca0b_aa67,
                0xc000_bcae_9b60_b5bb,
                0x3fd7_b0c3_f399_470a,
                0xc007_cb78_b088_20a4,
                0x4008_15fa_31eb_8733,
                0xc00c_0581_e77d_b5d7,
                0x4007_147f_2212_f5d4,
                0xbfea_01cf_1150_8679,
                0x4003_2052_38a6_41eb,
                0x3ffc_ec88_1c04_529b,
                0x3ff8_72e6_eb4a_d6f4,
                0x4011_6f52_c7c2_9577,
                0xbfe7_a329_601d_2d99,
                0x4007_3d22_5fb4_d753,
                0xc006_166a_b719_6ac6,
                0x3ff2_aa69_450b_eea0,
                0xc012_27b6_d3c8_7953,
                0xbfeb_648e_a01d_d46e,
            ]
            .map(f64::from_bits)
            .to_vec(),
        },
        TestPath::new(11, NONZERO, -3)
            .rectangle(0.0, 0.0, 1.0, 1.0)
            .rectangle(1.25, 0.0, 2.25, 1.0),
        square(12, EVENODD, -3),
    ];
    let input = pack(&paths);
    let mut engine = FillEngine::new();
    load(&mut engine, &input, 8);
    let workspace_bytes = engine.workspace().unwrap().allocated_bytes();
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
    assert_eq!(
        engine.workspace().unwrap().allocated_bytes(),
        workspace_bytes
    );
    let decoded = decode(engine.output_bytes(), &paths);
    for mesh in decoded.iter().filter(|mesh| mesh.status == FILL_PATH_OK) {
        assert_mesh_invariants(mesh);
    }

    // Both rungs ran: the ladder record of each path, then the seeded `MESH_CHECK` and
    // `TRIANGLE` fallbacks of the fast paths inside the same allocation window.
    let reasons = |engine: &mut FillEngine| -> Vec<(Option<Rung>, Option<Reason>)> {
        paths
            .iter()
            .map(|path| {
                let request = FillRequest {
                    request_id: path.id,
                    rule: if path.rule == 0 {
                        LineFillRule::Nonzero
                    } else {
                        LineFillRule::Evenodd
                    },
                    exponent: path.exponent,
                };
                let built = engine
                    .build_one(request, &path.verbs, &point_bytes(&path.points))
                    .unwrap()
                    .unwrap();
                (built.rung, built.reason)
            })
            .collect()
    };
    let fallback = |reason| (Some(Rung::Exact), Some(reason));
    let fast = (Some(Rung::Fast), None);
    let mut expected = vec![
        fast,
        fallback(Reason::Monotone),
        fallback(Reason::Monotone),
        fallback(Reason::Crossing),
        fallback(Reason::Monotone),
        (None, None),
        fallback(Reason::Range),
        fallback(Reason::Prefix),
        fallback(Reason::Structure),
        fallback(Reason::Closure),
        fallback(Reason::Clearance),
        fast,
    ];
    assert_eq!(reasons(&mut engine), expected);
    for (fault, reason) in [
        (LadderFault::TriangleFlipped, Reason::MeshCheck),
        (LadderFault::Fr7OrientationRejected, Reason::Triangle),
    ] {
        with_ladder_faults(&[fault], || {
            let storage = engine.storage();
            crate::allocation_test_support::start();
            let status = engine.process(input.len() as u32);
            let allocations = crate::allocation_test_support::stop();
            assert_eq!(status, BATCH_OK);
            assert_eq!(allocations, 0, "process must not allocate");
            assert_eq!(engine.storage(), storage);
            for index in [0, 11] {
                expected[index] = fallback(reason);
            }
            assert_eq!(reasons(&mut engine), expected);
        });
    }
}

#[test]
fn results_are_deterministic_and_position_independent() {
    let a = cubic_bowtie(1, NONZERO);
    let b = TestPath::new(2, NONZERO, -3)
        .move_to(0.0, 0.0)
        .cubic_to([1.0, 2.0, 3.0, 2.0, 4.0, 0.0])
        .close();
    let c = TestPath::new(3, NONZERO, 0).line_to(1.0, 1.0);
    let first = run(&[a.clone(), b.clone(), c.clone()]);
    let second = run(&[c, b.clone(), a.clone()]);
    assert_eq!(first[0], second[2]);
    assert_eq!(first[1], second[1]);
    let input = pack(&[a, b]);
    let mut engine = FillEngine::new();
    load(&mut engine, &input, 1 << 16);
    assert_eq!(engine.process(input.len() as u32), BATCH_OK);
    let once = engine.output_bytes().to_vec();
    assert_eq!(engine.process(input.len() as u32), BATCH_OK);
    assert_eq!(engine.output_bytes(), once.as_slice());
}

#[test]
fn request_echo_and_record_fields_are_little_endian() {
    let paths = [
        square(0, NONZERO, -1021),
        TestPath::new(u32::MAX, EVENODD, i32::MIN),
        TestPath::new(0x1234_5678, NONZERO, 7),
    ];
    let decoded = run(&paths);
    assert_eq!(decoded[0].id, 0);
    assert_eq!(decoded[1].id, u32::MAX);
    assert_eq!(decoded[1].exponent, i32::MIN);
    assert_eq!(decoded[1].status, FILL_PATH_INVALID_TOLERANCE);
    assert_eq!(decoded[2].status, FILL_PATH_EMPTY);
    assert_eq!(decoded[2].exponent, 7);
}

/// The line-only star polygon {13/6}, radius 100, rounded to integers.
fn star_13_6() -> TestPath {
    let points = [
        100.0, 0.0, -97.0, 24.0, 89.0, -46.0, -75.0, 66.0, 57.0, -82.0, -35.0, 94.0, 12.0, -99.0,
        12.0, 99.0, -35.0, -94.0, 57.0, 82.0, -75.0, -66.0, 89.0, 46.0, -97.0, -24.0,
    ];
    let mut path = TestPath::new(1, NONZERO, -3).move_to(points[0], points[1]);
    for pair in points[2..].chunks_exact(2) {
        path = path.line_to(pair[0], pair[1]);
    }
    path.close()
}

/// The legacy attempt's kernel value: `Ok(flat_status)` or the error.
fn legacy_value(path: &TestPath) -> Result<u32, CubicFillError> {
    let mut workspace = CubicFillWorkspace::new(FILL_V0_LIMITS).unwrap();
    let bytes = point_bytes(&path.points);
    let (flatten, topology) = tolerances(path.exponent);
    let input = PathInput::from_parts(
        Request {
            request_id: 0,
            source_epoch: 0,
            source_revision: 0,
            tolerance: flatten,
        },
        &path.verbs,
        &bytes,
    );
    workspace
        .attempt(input, LineFillRule::Nonzero, topology, MAX_FLAT_COMMANDS)
        .map(|diagnostics| diagnostics.flat_status)
}

#[test]
fn mapping_row_fixtures_reach_their_kernel_values() {
    // Each fixture names the kernel value it reaches, then the port status.
    // Cap fixtures are current-cap fixtures that B1 may re-baseline.
    let mut source_limit = TestPath::new(1, NONZERO, 0).move_to(0.0, 0.0);
    for index in 0..24 {
        source_limit = source_limit.line_to(f64::from(index + 1), f64::from(index % 2));
    }
    let next = f64::from_bits(1.0f64.to_bits() + 1);
    let rows: Vec<(&str, TestPath, Result<u32, CubicFillError>, u32)> = vec![
        (
            "sizing NUMERIC_RANGE",
            TestPath::new(1, NONZERO, -60)
                .move_to(0.0, 0.0)
                .cubic_to([1.0, 2.0, 3.0, 2.0, 4.0, 0.0])
                .close(),
            Ok(PATH_NUMERIC_RANGE),
            FILL_PATH_NUMERIC_RANGE,
        ),
        (
            "sizing WORK_LIMIT (8,192 lines per cubic)",
            TestPath::new(1, NONZERO, -20)
                .move_to(0.0, 0.0)
                .cubic_to([0.0, 1.0e6, 1.0e6, 1.0e6, 1.0e6, 0.0])
                .close(),
            Ok(PATH_WORK_LIMIT),
            FILL_PATH_WORK_LIMIT,
        ),
        (
            "SourceLimit (24 source verbs + 1)",
            source_limit,
            Err(CubicFillError::SourceLimit),
            FILL_PATH_WORK_LIMIT,
        ),
        (
            "CommandLimit (72 flat commands)",
            TestPath::new(1, NONZERO, -12)
                .move_to(0.0, 0.0)
                .cubic_to([0.0, 64.0, 64.0, 64.0, 64.0, 0.0])
                .close(),
            Err(CubicFillError::CommandLimit),
            FILL_PATH_WORK_LIMIT,
        ),
        (
            // Current-cap fixture (B1 may re-baseline): the line-only star
            // polygon {13/6} of radius 100 exceeds the rounded node cap.
            "Rounded(NodeLimit) (star polygon {13/6})",
            star_13_6(),
            Err(CubicFillError::Rounded(RoundedFillError::NodeLimit)),
            FILL_PATH_WORK_LIMIT,
        ),
        (
            "UnsupportedSource (MOVE-only subpath in a curved path)",
            TestPath::new(1, NONZERO, -3)
                .move_to(5.0, 5.0)
                .move_to(0.0, 0.0)
                .cubic_to([1.0, 2.0, 3.0, 2.0, 4.0, 0.0])
                .close(),
            Err(CubicFillError::UnsupportedSource),
            FILL_PATH_UNSUPPORTED_GEOMETRY,
        ),
        (
            "ZeroLengthLeaf",
            TestPath::new(1, NONZERO, -3)
                .move_to(0.0, 0.0)
                .cubic_to([0.0, 0.0, 0.0, 0.0, 0.0, 0.0])
                .cubic_to([1.0, 0.0, 2.0, 0.0, 3.0, 0.0])
                .cubic_to([2.0, 1.0, 1.0, 2.0, 0.0, 3.0])
                .cubic_to([0.0, 2.0, 0.0, 1.0, 0.0, 0.0])
                .close(),
            Err(CubicFillError::ZeroLengthLeaf),
            FILL_PATH_UNSUPPORTED_GEOMETRY,
        ),
        (
            "Topology(Unresolved) in both cascade steps",
            cubic_bowtie(1, NONZERO),
            Err(CubicFillError::Topology(TopologyError::Unresolved)),
            FILL_PATH_UNSUPPORTED_GEOMETRY,
        ),
        (
            "Rounded(TopologyAmbiguous)",
            TestPath::new(1, NONZERO, 1)
                .move_to(0.0, 1.0)
                .line_to(2.0, next)
                .close()
                .move_to(1.0, 1.0)
                .line_to(1.0, next)
                .close(),
            Err(CubicFillError::Rounded(RoundedFillError::TopologyAmbiguous)),
            FILL_PATH_UNSUPPORTED_GEOMETRY,
        ),
    ];
    for (name, path, kernel_value, status) in rows {
        assert_eq!(legacy_value(&path), kernel_value, "{name}");
        assert_eq!(status_of(path), status, "{name}");
    }
}
