//! P3 Alt-A1 unit AL-U3 tests (`docs/plans/p3-alt-a1-fill-ladder-contract.md` sections 3.5 to
//! 3.8, 4.3 and 4.4): the ladder through the fill export at revision 2.
//!
//! - Section 3.7: fixtures that must stay on the exact rung fall back on rung 0, each with the
//!   reason fixed in this file before its first execution, and the export output of every
//!   fallback path equals the `exact_only` output (AL-I2), byte for byte in a one-path batch
//!   and per path, without `blockOffset`, in a multi-path batch. AL-F7's real inputs, AL-F1 and
//!   AL-F8 run through the export the same way.
//! - Siblings of the existing tests whose engine now sets `exact_only`, and AL-F2, AL-F5 and
//!   AL-F9 through the export: a fast mesh publishes rung 0's vertices and triangles and the
//!   edges used once of V2's own `collect_boundary`, with no cell-ladder refinement.
//! - The seeded defects (14) and (15) with their detectors.
//! - The reserve-time storage of rung 0 (section 3.4).
//!
//! The existing `fill_export_tests.rs` keeps its assertions; these tests are new.
use crate::codec::{align_up, read_u32, write_f64, write_u32};
use crate::engine::{BATCH_INTERNAL_ERROR, BATCH_OK};
use crate::fill_export::{
    FillEngine, FillRequest, PathOutcome, FILL_INPUT_MAGIC, FILL_PATH_OK, FILL_V0_REVISION,
};
use crate::fill_ladder::{with_ladder_faults, ExactStep, FastRung, LadderFault, Reason, Rung};
use crate::line_fill::LineFillRule;

const MOVE: u8 = 0;
const LINE: u8 = 1;
const CUBIC: u8 = 2;
const CLOSE: u8 = 3;

#[derive(Clone, Debug)]
struct Path {
    name: &'static str,
    rule: LineFillRule,
    exponent: i32,
    verbs: Vec<u8>,
    points: Vec<f64>,
}

impl Path {
    fn new(name: &'static str, rule: LineFillRule, exponent: i32) -> Self {
        Self {
            name,
            rule,
            exponent,
            verbs: Vec::new(),
            points: Vec::new(),
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

    fn with_rule(mut self, rule: LineFillRule) -> Self {
        self.rule = rule;
        self
    }

    fn at(mut self, exponent: i32) -> Self {
        self.exponent = exponent;
        self
    }

    fn request(&self, request_id: u32) -> FillRequest {
        FillRequest {
            request_id,
            rule: self.rule,
            exponent: self.exponent,
        }
    }

    fn point_bytes(&self) -> Vec<u8> {
        self.points
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect()
    }
}

const NONZERO: LineFillRule = LineFillRule::Nonzero;
const EVENODD: LineFillRule = LineFillRule::Evenodd;

/// Packs a fill-v0 input as V2 section a lays it out; request ids are the path indices.
fn pack(paths: &[Path]) -> Vec<u8> {
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
    let (mut verb_cursor, mut point_cursor) = (0usize, 0usize);
    for (index, path) in paths.iter().enumerate() {
        let request = requests + 16 * index;
        let rule = match path.rule {
            LineFillRule::Nonzero => 0,
            LineFillRule::Evenodd => 1,
        };
        write_u32(&mut bytes, request, index as u32).unwrap();
        write_u32(&mut bytes, request + 4, rule).unwrap();
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
    let path_end = path_offsets + 4 * path_count;
    write_u32(&mut bytes, path_end, verb_cursor as u32).unwrap();
    write_u32(
        &mut bytes,
        point_offsets + 4 * path_count,
        point_cursor as u32,
    )
    .unwrap();
    bytes
}

fn engine(exact_only: bool) -> FillEngine {
    let mut engine = FillEngine::new();
    engine.hooks().exact_only = exact_only;
    assert_eq!(engine.reserve(1 << 16, 1 << 20), BATCH_OK);
    engine
}

/// The batch status and, on `BATCH_OK`, the published bytes.
fn process(engine: &mut FillEngine, paths: &[Path]) -> (u32, Vec<u8>) {
    let input = pack(paths);
    engine.input_bytes_mut()[..input.len()].copy_from_slice(&input);
    let status = engine.process(input.len() as u32);
    (status, engine.output_bytes().to_vec())
}

/// AL-I2 in a multi-path batch: per path, the record without `blockOffset` (bytes 16-19) and
/// the block bytes.
fn path_view(output: &[u8], index: usize) -> (Vec<u8>, Vec<u8>) {
    let record = 64 + 80 * index;
    let mut fields = output[record..record + 16].to_vec();
    fields.extend_from_slice(&output[record + 20..record + 80]);
    let offset = read_u32(output, record + 16).unwrap() as usize;
    let length = read_u32(output, record + 32).unwrap() as usize;
    (fields, output[offset..offset + length].to_vec())
}

fn status_of(output: &[u8], index: usize) -> u32 {
    read_u32(output, 64 + 80 * index + 4).unwrap()
}

/// The decoded block of an `ok` path: position bits, indices and boundary pairs.
type Block = (Vec<[u64; 2]>, Vec<u32>, Vec<[u32; 2]>);

fn block(output: &[u8], index: usize) -> Block {
    let record = 64 + 80 * index;
    let offset = read_u32(output, record + 16).unwrap() as usize;
    let vertices = read_u32(output, record + 20).unwrap() as usize;
    let indices = read_u32(output, record + 24).unwrap() as usize;
    let boundary = read_u32(output, record + 28).unwrap() as usize;
    let word = |at: usize| u64::from_le_bytes(output[at..at + 8].try_into().unwrap());
    let positions = (0..vertices)
        .map(|vertex| [word(offset + 16 * vertex), word(offset + 16 * vertex + 8)])
        .collect();
    let index_start = offset + 16 * vertices;
    let triangles = (0..indices)
        .map(|slot| read_u32(output, index_start + 4 * slot).unwrap())
        .collect();
    let pair_start = index_start + 4 * indices;
    let pairs = (0..boundary / 2)
        .map(|pair| {
            [
                read_u32(output, pair_start + 8 * pair).unwrap(),
                read_u32(output, pair_start + 8 * pair + 4).unwrap(),
            ]
        })
        .collect();
    (positions, triangles, pairs)
}

fn twice_area(mesh: &Block) -> f64 {
    let point = |vertex: u32| {
        let [x, y] = mesh.0[vertex as usize];
        (f64::from_bits(x), f64::from_bits(y))
    };
    mesh.1
        .chunks_exact(3)
        .map(|triangle| {
            let (a, b, c) = (point(triangle[0]), point(triangle[1]), point(triangle[2]));
            (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0)
        })
        .sum()
}

/// The ladder record of one path through `build_path` on a fresh engine (section 3.6).
fn built(path: &Path, exact_only: bool) -> crate::fill_export::BuiltPath {
    let mut engine = engine(exact_only);
    let points = path.point_bytes();
    engine
        .build_one(path.request(0), &path.verbs, &points)
        .expect("reserved engine")
        .expect("no self-check failure")
}

// ------------------------------------------------------------------------------------------
// Fixtures.

fn f01(rule: LineFillRule) -> Path {
    Path::new("F01", rule, -3).rectangle(0.0, 0.0, 10.0, 10.0)
}

/// V2's transverse bowtie: trisection cubics with one transverse self-crossing; Legacy
/// returns `Unresolved` and triangle-free admits it.
fn transverse_bowtie(rule: LineFillRule) -> Path {
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
    let mut path = Path::new("transverse-bowtie", rule, -3).move_to(-3.0, -3.0);
    for pair in vertices.windows(2) {
        path = path.linear_cubic_to(pair[0], pair[1]);
    }
    path.close()
}

/// V2's linear-cubic bowtie, `Unresolved` in both cascade steps.
fn cubic_bowtie() -> Path {
    let corners = [(0.0, 0.0), (3.0, 3.0), (0.0, 3.0), (3.0, 0.0), (0.0, 0.0)];
    let mut path = Path::new("cubic-bowtie", NONZERO, -3).move_to(0.0, 0.0);
    for pair in corners.windows(2) {
        path = path.linear_cubic_to(pair[0], pair[1]);
    }
    path.close()
}

/// V2's rounded-knot control, `KnotMismatch` in Legacy.
fn rounded_failure() -> Path {
    Path::new("rounded-failure", NONZERO, -3)
        .move_to(0.0, 0.0)
        .cubic_to([1.0, 2f64.powi(-54), 2.0, 1.0, 3.0, 0.0])
        .linear_cubic_to((3.0, 0.0), (1.5, -3.0))
        .linear_cubic_to((1.5, -3.0), (0.0, 0.0))
        .close()
}

/// AL-F6: V2's simple curved path; Legacy admits it.
fn al_f6() -> Path {
    Path::new("AL-F6", NONZERO, -3)
        .move_to(0.0, 0.0)
        .cubic_to([1.0, 2.0, 3.0, 2.0, 4.0, 0.0])
        .close()
}

/// AL-F7 `CLOSURE`: the B0 corpus path `O1/P2/s=3#0` (the first of the spike record's 73 O1
/// `CLOSURE` paths), its scalars as bits from `tests/geometry/p3-b0/corpus.ts`.
fn o1_p2_s3_0() -> Path {
    const BITS: [u64; 20] = [
        0xc012_27b6_d3c8_7953,
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
    ];
    Path {
        name: "O1/P2/s=3#0",
        rule: NONZERO,
        exponent: -3,
        verbs: vec![MOVE, CUBIC, CUBIC, CUBIC, CLOSE],
        points: BITS.iter().map(|bits| f64::from_bits(*bits)).collect(),
    }
}

/// Section 3.7 and AL-F7: every input that must take the exact rung, with the rung-0 reason
/// fixed before the first execution of this test.
fn fallback_fixtures() -> Vec<(Path, Reason)> {
    let mut fixtures = Vec::new();
    for rule in [NONZERO, EVENODD] {
        // C15's hanging fixtures (touching rectangles).
        fixtures.push((
            Path::new("C15-interior", rule, -3)
                .rectangle(0.0, 0.0, 4.0, 4.0)
                .rectangle(4.0, 1.0, 8.0, 3.0),
            Reason::Crossing,
        ));
        fixtures.push((
            Path::new("C15-boundary", rule, -3)
                .rectangle(0.0, 0.0, 10.0, 10.0)
                .rectangle(-5.0, 0.0, 0.0, 5.0),
            Reason::Crossing,
        ));
        // V2's `Unresolved` control.
        fixtures.push((transverse_bowtie(rule), Reason::Crossing));
        // F04, F05, F07, F10 (and B reversed) and F11 of the private contract.
        fixtures.push((
            Path::new("F04", rule, -3)
                .rectangle(0.0, 0.0, 10.0, 10.0)
                .rectangle(0.0, 0.0, 10.0, 10.0),
            Reason::Crossing,
        ));
        fixtures.push((
            Path::new("F05", rule, -3)
                .rectangle(0.0, 0.0, 10.0, 10.0)
                .reversed_rectangle(0.0, 0.0, 10.0, 10.0),
            Reason::Crossing,
        ));
        fixtures.push((
            Path::new("F07", rule, -3)
                .rectangle(0.0, 0.0, 2.0, 2.0)
                .rectangle(2.0, 0.0, 4.0, 2.0),
            Reason::Crossing,
        ));
        fixtures.push((
            Path::new("F10", rule, -3)
                .rectangle(0.0, 0.0, 4.0, 4.0)
                .rectangle(2.0, 0.0, 6.0, 4.0),
            Reason::Crossing,
        ));
        fixtures.push((
            Path::new("F10r", rule, -3)
                .rectangle(0.0, 0.0, 4.0, 4.0)
                .reversed_rectangle(2.0, 0.0, 6.0, 4.0),
            Reason::Crossing,
        ));
        fixtures.push((
            Path::new("F11", rule, -3)
                .rectangle(0.0, 0.0, 4.0, 4.0)
                .rectangle(2.0, 4.0, 6.0, 8.0),
            Reason::Crossing,
        ));
        // AL-F1: the square outside AL-FR0's range.
        fixtures.push((f01(rule).at(511), Reason::Range));
        fixtures.push((f01(rule).at(-512), Reason::Range));
    }
    // V2's other `Unresolved` control (both steps) and its `KnotMismatch` control: both turn
    // by 90° or more against a long neighbour edge, so SL-C2 is not proved.
    fixtures.push((cubic_bowtie(), Reason::Monotone));
    fixtures.push((rounded_failure(), Reason::Monotone));
    // AL-F7, one real export input per reachable reason.
    fixtures.push((
        Path::new("command-limit", NONZERO, -12)
            .move_to(0.0, 0.0)
            .cubic_to([0.0, 64.0, 64.0, 64.0, 64.0, 0.0])
            .close(),
        Reason::Prefix,
    ));
    let mut source_limit = Path::new("source-limit", NONZERO, 0).move_to(0.0, 0.0);
    for index in 0..72 {
        source_limit = source_limit.line_to(f64::from(index + 1), f64::from(index % 2));
    }
    fixtures.push((source_limit, Reason::Prefix));
    fixtures.push((
        Path::new("SL-F15", NONZERO, -3)
            .rectangle(0.0, 0.0, 10.0, 10.0)
            .move_to(20.0, 0.0)
            .line_to(21.0, 0.0),
        Reason::Structure,
    ));
    fixtures.push((o1_p2_s3_0(), Reason::Closure));
    fixtures.push((al_f6(), Reason::Monotone));
    fixtures.push((
        Path::new("F06", NONZERO, -3)
            .move_to(0.0, 0.0)
            .line_to(4.0, 4.0)
            .line_to(0.0, 4.0)
            .line_to(4.0, 0.0)
            .close(),
        Reason::Monotone,
    ));
    fixtures.push((
        Path::new("SL-F3", NONZERO, -3)
            .rectangle(0.0, 0.0, 1.0, 1.0)
            .rectangle(1.25, 0.0, 2.25, 1.0),
        Reason::Clearance,
    ));
    fixtures
}

// ------------------------------------------------------------------------------------------
// Section 3.7 and AL-I2.

#[test]
fn al_u3_fallback_fixtures_take_the_exact_rung_and_equal_exact_only() {
    assert_eq!(FILL_V0_REVISION, 2);
    let fixtures = fallback_fixtures();
    for (path, expected) in &fixtures {
        let record = built(path, false);
        assert_eq!(record.rung, Some(Rung::Exact), "{}", path.name);
        assert_eq!(record.reason, Some(*expected), "{}", path.name);
        let exact = built(path, true);
        assert_eq!(
            (record.outcome, record.step),
            (exact.outcome, exact.step),
            "{}",
            path.name
        );
        assert_eq!(exact.reason, None, "{}", path.name);
        // One-path batch: the whole output byte for byte.
        let one = std::slice::from_ref(path);
        let ladder = process(&mut engine(false), one);
        assert_eq!(ladder.0, BATCH_OK, "{}", path.name);
        assert_eq!(ladder, process(&mut engine(true), one), "{}", path.name);
    }
    // A multi-path batch behind a fast path: per path, without `blockOffset`.
    let mut paths = vec![f01(NONZERO)];
    paths.extend(fixtures.iter().map(|(path, _)| path.clone()));
    let (status, ladder) = process(&mut engine(false), &paths);
    let (exact_status, exact) = process(&mut engine(true), &paths);
    assert_eq!((status, exact_status), (BATCH_OK, BATCH_OK));
    for (index, path) in paths.iter().enumerate().skip(1) {
        assert_eq!(
            path_view(&ladder, index),
            path_view(&exact, index),
            "{}",
            path.name
        );
    }
    // The cell-ladder refinement and the cascade stay exercised: the hanging fixtures and the
    // transverse bowtie publish an exact-rung mesh (the bowtie through triangle-free).
    assert_eq!(status_of(&ladder, 1), FILL_PATH_OK);
    assert_eq!(block(&ladder, 1).1.len(), 18);
    let bowtie = built(&transverse_bowtie(NONZERO), false);
    assert_eq!(
        (bowtie.outcome, bowtie.step),
        (PathOutcome::Mesh, Some(ExactStep::TriangleFree))
    );
    assert_eq!(built(&al_f6(), false).step, Some(ExactStep::Legacy));
}

#[test]
fn al_u3_al_f8_mesh_check_through_the_export_equals_exact_only() {
    // AL-F8 (item 1) on F01, and AL-F8b (a) on F01 and (c) on SL-F4 (item 3), as AL-U1 runs
    // them at module level.
    let sl_f4 = |rule| {
        let gap = 1.25 + 2f64.powi(-20);
        Path::new("SL-F4", rule, -3)
            .rectangle(0.0, 0.0, 1.0, 1.0)
            .rectangle(gap, 0.0, gap + 1.0, 1.0)
    };
    for (fault, paths) in [
        (LadderFault::TriangleFlipped, [f01(NONZERO), f01(EVENODD)]),
        (LadderFault::TriangleDropped, [f01(NONZERO), f01(EVENODD)]),
        (
            LadderFault::VertexSubstituted,
            [sl_f4(NONZERO), sl_f4(EVENODD)],
        ),
    ] {
        for path in paths {
            let one = std::slice::from_ref(&path);
            let (record, ladder) = with_ladder_faults(&[fault], || {
                (built(&path, false), process(&mut engine(false), one))
            });
            assert_eq!(
                (record.rung, record.reason),
                (Some(Rung::Exact), Some(Reason::MeshCheck)),
                "{fault:?}"
            );
            assert_eq!(ladder, process(&mut engine(true), one), "{fault:?}");
        }
    }
}

// ------------------------------------------------------------------------------------------
// Fast meshes through the export (sections 3.5 and 3.8).

#[test]
fn al_u3_fast_square_publishes_rung_zero_without_refinement() {
    for rule in [NONZERO, EVENODD] {
        // AL-F5 and the sibling of `integer_fixtures_mesh_their_exact_regions` for F01.
        let path = f01(rule);
        let record = built(&path, false);
        assert_eq!(
            (record.outcome, record.rung, record.reason, record.step),
            (PathOutcome::Mesh, Some(Rung::Fast), None, None)
        );
        let mut fast = engine(false);
        let (status, output) = process(&mut fast, std::slice::from_ref(&path));
        assert_eq!(status, BATCH_OK);
        let mesh = block(&output, 0);
        let (vertices, triangles) = fast.fast_mesh().expect("published fast mesh");
        let bits: Vec<[u64; 2]> = vertices
            .iter()
            .map(|point| [point.x.to_bits(), point.y.to_bits()])
            .collect();
        assert_eq!(mesh.0, bits);
        assert_eq!(mesh.1, triangles.as_flattened());
        assert_eq!(
            mesh.0,
            [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]]
                .map(|[x, y]: [f64; 2]| [x.to_bits(), y.to_bits()])
        );
        let mut pairs = mesh.2.clone();
        pairs.sort_unstable();
        assert_eq!(pairs, vec![[0, 1], [1, 2], [2, 3], [3, 0]]);
        assert_eq!(twice_area(&mesh), 200.0);
        // No Steiner vertex and no refinement: two triangles over the four corners.
        assert_eq!(mesh.1.len(), 6);
        // The exact rung of the same input is the cell mesh of revision 1, same area.
        let (_, exact) = process(&mut engine(true), std::slice::from_ref(&path));
        assert_eq!(twice_area(&block(&exact, 0)), 200.0);
    }
}

#[test]
fn al_u3_line_only_square_takes_rung_zero_and_no_topology() {
    // Sibling of `cascade_retries_triangle_free_only_after_knot_or_unresolved`'s line-only
    // engine, which now sets `exact_only`: through the ladder the square at e = 0 is fast,
    // and only the S1 prefix ran on the workspace, so no topology stage was invoked.
    let path = f01(NONZERO).at(0);
    assert_eq!(built(&path, false).rung, Some(Rung::Fast));
    let mut fast = engine(false);
    assert_eq!(process(&mut fast, std::slice::from_ref(&path)).0, BATCH_OK);
    let diagnostics = fast.workspace().unwrap().diagnostics();
    assert!(!diagnostics.topology_invoked);
    assert!(!diagnostics.transverse_topology_invoked);
}

#[test]
fn al_u3_al_f2_range_ends_through_the_export() {
    // e = 510: CLEARANCE, then the exact rung, equal to exact_only.
    let high = f01(NONZERO).at(510);
    assert_eq!(built(&high, false).reason, Some(Reason::Clearance));
    let one = std::slice::from_ref(&high);
    assert_eq!(
        process(&mut engine(false), one),
        process(&mut engine(true), one)
    );
    // e = −511: fast, area 100.
    let low = f01(NONZERO).at(-511);
    assert_eq!(built(&low, false).rung, Some(Rung::Fast));
    let (status, output) = process(&mut engine(false), std::slice::from_ref(&low));
    assert_eq!(status, BATCH_OK);
    assert_eq!(twice_area(&block(&output, 0)), 200.0);
}

#[test]
fn al_u3_al_f9_b0_fixture_paths_are_fast_through_the_export() {
    let source = include_str!("../../../../tests/geometry/p3-b0/fixtures.json");
    for name in ["P4/s=4#0", "K2/s=3#0"] {
        let start = source.find(&format!("\"{name}\"")).expect("fixture entry");
        let entry = &source[start..];
        let entry = &entry[..entry.find('}').expect("fixture entry end")];
        let list = |key: &str| -> &str {
            let at = entry.find(&format!("\"{key}\"")).expect("fixture key");
            let open = at + entry[at..].find('[').expect("list start");
            let close = open + entry[open..].find(']').expect("list end");
            &entry[open + 1..close]
        };
        let path = Path {
            name: "AL-F9",
            rule: NONZERO,
            exponent: -3,
            verbs: list("verbs")
                .split(',')
                .map(|value| value.trim().parse().expect("verb byte"))
                .collect(),
            points: list("bits")
                .split(',')
                .map(|value| {
                    f64::from_bits(
                        u64::from_str_radix(value.trim().trim_matches('"'), 16).expect("hex"),
                    )
                })
                .collect(),
        };
        assert_eq!(built(&path, false).rung, Some(Rung::Fast), "{name}");
        let one = std::slice::from_ref(&path);
        let (status, fast) = process(&mut engine(false), one);
        let (exact_status, exact) = process(&mut engine(true), one);
        assert_eq!((status, exact_status), (BATCH_OK, BATCH_OK), "{name}");
        assert_eq!(
            (status_of(&fast, 0), status_of(&exact, 0)),
            (FILL_PATH_OK, FILL_PATH_OK),
            "{name}"
        );
        // A different triangulation of the region; the exact rung has Steiner vertices.
        assert_ne!(block(&fast, 0), block(&exact, 0), "{name}");
    }
}

// ------------------------------------------------------------------------------------------
// Seeded defects (14) and (15), section 4.3.

fn transverse_invoked(path: &Path, defect: bool) -> bool {
    let mut engine = engine(false);
    engine.hooks().defect_cascade_inverted = defect;
    assert_eq!(process(&mut engine, std::slice::from_ref(path)).0, BATCH_OK);
    engine
        .workspace()
        .unwrap()
        .diagnostics()
        .transverse_topology_invoked
}

#[test]
fn al_u3_defect_14_cascade_inverted_is_detected() {
    // The contract's first detector, AL-F6's `!transverse_topology_invoked`
    // (`cascade_retries_triangle_free_only_after_knot_or_unresolved`), does not fire on the
    // inverted cascade: `attempt_triangle_free` returns `Unresolved` on AL-F6, so the inverted
    // cascade retries Legacy, which admits it with V2's mesh and resets the diagnostics. The
    // output and that flag are unchanged; the inversion shows in the native ladder record
    // instead (section 3.6): AL-F6's exact step becomes a retry.
    //
    // E8-C5 (docs/plans/p3-rounded-knot-topology-contract.md, E8 addendum E8.6): under E8-U1,
    // `attempt_triangle_free` admits AL-F6 and the linear-cubic bowtie, so the inverted cascade
    // no longer retries on either and neither detector fires. The crossing replacement (step 1
    // KnotMismatch, step 2 success) takes AL-F6's place: its record step is TriangleFree, and
    // the inverted cascade, which runs triangle-free first and succeeds, records Legacy. The M1'
    // path E8-C1, Unresolved in both steps, takes the bowtie's place. The old paths are kept as
    // positives.
    let old = al_f6();
    assert_eq!(built(&old, false).reason, Some(Reason::Monotone));
    assert_eq!(built(&old, false).step, Some(ExactStep::Legacy));
    let mut defective = engine(false);
    defective.hooks().defect_cascade_inverted = true;
    let points = old.point_bytes();
    let record = defective
        .build_one(old.request(0), &old.verbs, &points)
        .unwrap()
        .unwrap();
    assert_eq!(record.step, Some(ExactStep::Legacy));
    assert_eq!(record.outcome, PathOutcome::Mesh);
    let old_bowtie = cubic_bowtie();
    assert_eq!(built(&old_bowtie, false).outcome, PathOutcome::Mesh);
    assert!(transverse_invoked(&old_bowtie, true));

    let path = e8_crossing_replacement();
    assert_eq!(built(&path, false).rung, Some(Rung::Exact));
    assert_eq!(built(&path, false).step, Some(ExactStep::TriangleFree));
    assert_eq!(built(&path, false).outcome, PathOutcome::Mesh);
    let mut defective = engine(false);
    defective.hooks().defect_cascade_inverted = true;
    let points = path.point_bytes();
    let record = defective
        .build_one(path.request(0), &path.verbs, &points)
        .unwrap()
        .unwrap();
    assert_eq!(
        record.step,
        Some(ExactStep::Legacy),
        "defect (14) undetected on the crossing replacement's ladder record"
    );
    // The contract's second detector, which fires: E8-C1, `Unresolved` in both steps, whose
    // assertion is `transverse_topology_invoked` after the cascade.
    let bowtie = e8_c1();
    assert_eq!(built(&bowtie, false).rung, Some(Rung::Exact));
    assert!(transverse_invoked(&bowtie, false));
    assert!(
        !transverse_invoked(&bowtie, true),
        "defect (14) undetected on E8-C1"
    );
}

/// E8-C1 (E8 addendum E8.6), the M1' path `M 0 0 C 0 -100 100 -100 100 -50 S 200 0 200 -50
/// L 200 50 L 0 50 Z`: the S reflects (100, -100) about (100, -50) to (100, 0).
fn e8_c1() -> Path {
    Path::new("E8-C1", NONZERO, -3)
        .move_to(0.0, 0.0)
        .cubic_to([0.0, -100.0, 100.0, -100.0, 100.0, -50.0])
        .cubic_to([100.0, 0.0, 200.0, 0.0, 200.0, -50.0])
        .line_to(200.0, 50.0)
        .line_to(0.0, 50.0)
        .close()
}

/// The E8-C5 crossing replacement, as `fill_export_tests::e8_crossing_replacement` builds it:
/// the transverse bowtie with its top edge bowed to controls at y = 6, the second offset by
/// 2^-50.
fn e8_crossing_replacement() -> Path {
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
    let mut path = Path::new("e8-crossing-replacement", NONZERO, -3).move_to(-3.0, -3.0);
    for (edge, pair) in vertices.windows(2).enumerate() {
        path = if edge == 2 {
            path.cubic_to([1.0, 6.0, -1.0, 6.0 + 2f64.powi(-50), pair[1].0, pair[1].1])
        } else {
            path.linear_cubic_to(pair[0], pair[1])
        };
    }
    path.close()
}

#[test]
fn al_u3_defect_15_fallback_from_partial_state_is_detected() {
    let mut detected = 0usize;
    for (path, _) in fallback_fixtures() {
        if built(&path, true).outcome != PathOutcome::Mesh {
            continue;
        }
        // Behind a fast path, so rung 0's scratch holds a fast mesh when the fallback runs.
        let paths = [f01(NONZERO), path.clone()];
        let exact = process(&mut engine(true), &paths);
        let clean = process(&mut engine(false), &paths);
        assert_eq!(
            path_view(&clean.1, 1),
            path_view(&exact.1, 1),
            "{}",
            path.name
        );
        let mut defective = engine(false);
        defective.hooks().defect_fallback_partial = true;
        let (status, output) = process(&mut defective, &paths);
        assert!(
            status == BATCH_INTERNAL_ERROR
                || (status == BATCH_OK && path_view(&output, 1) != path_view(&exact.1, 1)),
            "defect (15) undetected on {}",
            path.name
        );
        detected += 1;
    }
    assert!(
        detected >= 10,
        "{detected} fallback fixtures with an exact mesh"
    );
}

// ------------------------------------------------------------------------------------------
// Storage (section 3.4).

#[test]
fn al_u3_rung_zero_storage_is_reserved_with_the_engine() {
    let mut engine = FillEngine::new();
    assert!(engine.fast_mesh().is_none());
    assert_eq!(engine.reserve(64, 64), BATCH_OK);
    let workspace = engine.workspace().unwrap().allocated_bytes();
    let (_, _, scratch) = FillEngine::scratch_sizes().unwrap();
    assert_eq!(
        engine.heap_bytes(),
        workspace + scratch + core::mem::size_of::<FastRung>()
    );
    let ladder = engine.storage()[6];
    assert_ne!(ladder.0, 0);
    assert_eq!(ladder.1, core::mem::size_of::<FastRung>());
    assert_eq!(engine.dispose(), BATCH_OK);
    assert_eq!(engine.storage()[6], (0, 0));
    assert_eq!(engine.heap_bytes(), 0);
}
