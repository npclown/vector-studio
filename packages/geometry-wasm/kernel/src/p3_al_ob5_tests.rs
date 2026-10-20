//! Native tests for OB5-U1 of the P3 Alt-A1 AL-OB5 workload scenario
//! (`docs/plans/p3-al-ob5-workload-scenario-proposal.md`, sections 2.1, 2.4 and 7 OB5-Q7).
//!
//! Test-only. It holds (1) an implementation of B0's `p3-b0-ring/v1` generator that is
//! independent of the TypeScript `tests/geometry/p3-b0/corpus.ts`, at the same xorshift32
//! rotation draws, which produces the committed path-bit fixture; and (2) the admission test of
//! the three decision sets (3,000 paths) through the production fill path at the B1 caps, whose
//! per-set status, rung and count summary is the committed expectation of section 2.1, plus the
//! untimed unsnapped OB5-W8 observation. Nothing here is timed.

use core::f64::consts::{PI, TAU};

use crate::codec::{align_up, read_u32, write_f64, write_u32};
use crate::engine::{BATCH_OK, BATCH_OUTPUT_CAPACITY};
use crate::fill_export::{
    FillEngine, FillRequest, FILL_INPUT_MAGIC, FILL_OUTPUT_MAGIC, FILL_PATH_OK, FILL_V0_VERSION,
};
use crate::fill_ladder::Rung;
use crate::line_fill::LineFillRule;

const MOVE: u8 = 0;
const CUBIC: u8 = 2;
const CLOSE: u8 = 3;
const EDGE: f64 = 8.0;
const CUBICS: usize = 32;
const PATHS: usize = 1000;
const CELL_SEED: u32 = 0x1234_5678;
const EXPONENT: i32 = -3;

struct Set {
    id: &'static str,
    lambda: u32,
    bulge: f64,
    snapped: bool,
}

/// The decision sets in corpus order: bulges 3/64, 3/16 and 3/8 are B0's by density.
const DECISION: [Set; 3] = [
    Set {
        id: "OB5-W2",
        lambda: 2,
        bulge: 3.0 / 64.0,
        snapped: true,
    },
    Set {
        id: "OB5-W4",
        lambda: 4,
        bulge: 3.0 / 16.0,
        snapped: true,
    },
    Set {
        id: "OB5-W8",
        lambda: 8,
        bulge: 3.0 / 8.0,
        snapped: true,
    },
];

/// OB5-Q7 (a): OB5-W8 with `snapped: false`. Its bits come from this module's own `sin`/`cos`
/// and are not claimed to equal the TypeScript generator's unsnapped bits.
const OBSERVATION: Set = Set {
    id: "OB5-W8U",
    lambda: 8,
    bulge: 3.0 / 8.0,
    snapped: false,
};

/// xorshift32 with shifts 13, 17, 5; u = state / 2^32 drawn after each update.
struct Xorshift32(u32);

impl Xorshift32 {
    fn next(&mut self) -> f64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        f64::from(x) / 4_294_967_296.0
    }
}

#[derive(Clone)]
struct RingPath {
    verbs: Vec<u8>,
    points: Vec<f64>,
}

fn snap(value: f64) -> f64 {
    (value * 1024.0).round_ties_even() / 1024.0
}

/// One single-contour ring path of B0's generator, rotated by `rho` (contract section 2 steps
/// 1-6 with C = 1): vertices on the circumradius, right-hand-normal bulge, counterclockwise.
fn ring(set: &Set, rho: f64) -> RingPath {
    let emit = |points: &mut Vec<f64>, x: f64, y: f64| {
        if set.snapped {
            points.extend([snap(x), snap(y)]);
        } else {
            points.extend([x, y]);
        }
    };
    let radius = EDGE / (2.0 * (PI / CUBICS as f64).sin());
    let vertex = |index: usize| {
        let phi = TAU * (index % CUBICS) as f64 / CUBICS as f64 + rho;
        (radius * phi.cos(), radius * phi.sin())
    };
    let offset = set.bulge * EDGE;
    let mut verbs = vec![MOVE];
    let mut points = Vec::with_capacity(2 + 6 * CUBICS);
    let first = vertex(0);
    emit(&mut points, first.0, first.1);
    for index in 0..CUBICS {
        let (a, b) = (vertex(index), vertex(index + 1));
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        let length = (dx * dx + dy * dy).sqrt();
        let (nx, ny) = (dy / length, -dx / length);
        verbs.push(CUBIC);
        emit(
            &mut points,
            a.0 + dx / 3.0 + offset * nx,
            a.1 + dy / 3.0 + offset * ny,
        );
        emit(
            &mut points,
            a.0 + (2.0 * dx) / 3.0 + offset * nx,
            a.1 + (2.0 * dy) / 3.0 + offset * ny,
        );
        emit(&mut points, b.0, b.1);
    }
    verbs.push(CLOSE);
    RingPath { verbs, points }
}

/// The 1,000 paths of a set; the generator state resets to the seed at the start of the set and
/// each path draws one rotation, as B0 fixes.
fn set_paths(set: &Set) -> Vec<RingPath> {
    let mut random = Xorshift32(CELL_SEED);
    (0..PATHS).map(|_| ring(set, TAU * random.next())).collect()
}

fn point_bytes(points: &[f64]) -> Vec<u8> {
    points
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

/// Packs a fill-v0 input for requests 0.. with nonzero fill and `EXPONENT` (section a layout).
fn pack(paths: &[RingPath]) -> Vec<u8> {
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
        write_u32(&mut bytes, request, index as u32).unwrap();
        write_u32(&mut bytes, request + 4, 0).unwrap();
        write_u32(&mut bytes, request + 8, EXPONENT as u32).unwrap();
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

/// What one path produced: the output record's status and V, T and boundary-pair counts, and
/// the ladder rung that `build_one` reports for the same path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Outcome {
    status: u32,
    vertices: u32,
    triangles: u32,
    boundary_pairs: u32,
    rung: Option<Rung>,
}

/// Runs a set as one production batch (`FillEngine::process`) with enough capacity. Both calls,
/// the capacity query and the real one, are asserted allocation-free. Returns one outcome per
/// path, with the rung from the same engine's `build_one`.
fn run_set(paths: &[RingPath], expect_ok_batch: bool) -> Option<Vec<Outcome>> {
    let input = pack(paths);
    let mut engine = FillEngine::new();
    assert_eq!(engine.reserve(input.len() as u32, 8), BATCH_OK);
    engine.input_bytes_mut()[..input.len()].copy_from_slice(&input);
    let mut batch_ok = true;
    for first in [true, false] {
        if !first {
            let required = engine.required_output_bytes();
            assert_eq!(engine.reserve(input.len() as u32, required), BATCH_OK);
            engine.input_bytes_mut()[..input.len()].copy_from_slice(&input);
        }
        crate::allocation_test_support::start();
        let status = engine.process(input.len() as u32);
        let allocations = crate::allocation_test_support::stop();
        assert_eq!(allocations, 0, "process must not allocate");
        if first {
            assert_eq!(status, BATCH_OUTPUT_CAPACITY, "capacity query");
        } else if status != BATCH_OK {
            batch_ok = false;
            assert!(!expect_ok_batch, "batch status {status}");
        }
    }
    if !batch_ok {
        return None;
    }
    let output = engine.output_bytes().to_vec();
    assert_eq!(read_u32(&output, 0), Some(FILL_OUTPUT_MAGIC));
    assert_eq!(read_u32(&output, 4), Some(FILL_V0_VERSION));
    assert_eq!(read_u32(&output, 8), Some(output.len() as u32));
    assert_eq!(read_u32(&output, 12), Some(paths.len() as u32));
    let mut outcomes = Vec::with_capacity(paths.len());
    for (index, path) in paths.iter().enumerate() {
        let record = 64 + 80 * index;
        assert_eq!(read_u32(&output, record), Some(index as u32));
        let status = read_u32(&output, record + 4).unwrap();
        let vertices = read_u32(&output, record + 20).unwrap();
        let indices = read_u32(&output, record + 24).unwrap();
        let boundary = read_u32(&output, record + 28).unwrap();
        assert_eq!((indices % 3, boundary % 2), (0, 0));
        let bytes = point_bytes(&path.points);
        let built = engine
            .build_one(
                FillRequest {
                    request_id: index as u32,
                    rule: LineFillRule::Nonzero,
                    exponent: EXPONENT,
                },
                &path.verbs,
                &bytes,
            )
            .expect("engine reserved")
            .expect("no self-check failure");
        outcomes.push(Outcome {
            status,
            vertices,
            triangles: indices / 3,
            boundary_pairs: boundary / 2,
            rung: built.rung,
        });
    }
    Some(outcomes)
}

/// Per-set summary: how many paths had each (status, rung, V, T, B) tuple.
fn summarize(outcomes: &[Outcome]) -> Vec<(Outcome, usize)> {
    let mut rows: Vec<(Outcome, usize)> = Vec::new();
    for outcome in outcomes {
        match rows.iter_mut().find(|(known, _)| known == outcome) {
            Some((_, count)) => *count += 1,
            None => rows.push((*outcome, 1)),
        }
    }
    rows
}

fn describe(rows: &[(Outcome, usize)]) -> String {
    rows.iter()
        .map(|(o, n)| {
            format!(
                "{n} x status {} rung {:?} V {} T {} B {}",
                o.status, o.rung, o.vertices, o.triangles, o.boundary_pairs
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// The committed expectation of proposal section 2.1: every path of every decision set is `ok`
/// on rung 0 with V = 32 lambda, T = 32 lambda - 2 and 32 lambda boundary pairs. A failing path
/// is a finding to report, never a reason to change the generator.
#[test]
fn ob5_decision_sets_are_all_ok_on_rung_0_with_the_expected_counts() {
    for set in &DECISION {
        let leaves = CUBICS as u32 * set.lambda;
        let paths = set_paths(set);
        assert_eq!(paths.len(), PATHS);
        for path in &paths {
            assert_eq!(path.verbs.len(), 34);
            assert_eq!(path.points.len(), 194);
        }
        let outcomes = run_set(&paths, true).expect("decision batch is ok");
        let expected = Outcome {
            status: FILL_PATH_OK,
            vertices: leaves,
            triangles: leaves - 2,
            boundary_pairs: leaves,
            rung: Some(Rung::Fast),
        };
        let rows = summarize(&outcomes);
        eprintln!("{} summary: {}", set.id, describe(&rows));
        assert_eq!(
            rows,
            vec![(expected, PATHS)],
            "{}: {}",
            set.id,
            describe(&rows)
        );
    }
}

/// OB5-Q7 (a): admission, status and rung mix of the unsnapped OB5-W8, recorded as an
/// observation only. It asserts nothing about the outcome; the line printed is the record.
#[test]
fn ob5_unsnapped_observation_records_status_and_rung_mix() {
    let paths = set_paths(&OBSERVATION);
    match run_set(&paths, false) {
        Some(outcomes) => {
            eprintln!(
                "{} observation: {}",
                OBSERVATION.id,
                describe(&summarize(&outcomes))
            );
        }
        None => eprintln!("{} observation: batch did not complete", OBSERVATION.id),
    }
}

/// The path-bit fixture: the first and last path of each decision set, written with every
/// scalar as the 16-digit hex of its IEEE-754 bits (big-endian digit order).
fn fixture_json() -> String {
    let mut sets = Vec::new();
    for set in &DECISION {
        let paths = set_paths(set);
        let mut entries = Vec::new();
        for index in [0, PATHS - 1] {
            let path = &paths[index];
            let verbs: Vec<String> = path.verbs.iter().map(u8::to_string).collect();
            let bits: Vec<String> = path
                .points
                .iter()
                .map(|value| format!("\"{:016x}\"", value.to_bits()))
                .collect();
            entries.push(format!(
                "{{\n\"index\": {index},\n\"verbs\": [{}],\n\"bits\": [\n{}\n]\n}}",
                verbs.join(", "),
                bits.join(",\n")
            ));
        }
        sets.push(format!(
            "{{\n\"id\": \"{}\",\n\"paths\": [\n{}\n]\n}}",
            set.id,
            entries.join(",\n")
        ));
    }
    format!(
        "{{\n\"scenario\": \"p3-al-ob5-workload/v1\",\n\"generator\": \"independent Rust implementation of p3-b0-ring/v1 \
         (packages/geometry-wasm/kernel/src/p3_al_ob5_tests.rs), xorshift32 13/17/5, seed 0x12345678\",\n\
         \"sets\": [\n{}\n]\n}}\n",
        sets.join(",\n")
    )
}

fn without_whitespace(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect()
}

/// The committed fixture equals this generator's output (whitespace aside, since Prettier
/// formats the file). The TypeScript corpus is checked against the same file in Vitest.
#[test]
fn ob5_fixture_matches_the_independent_generator() {
    let committed = include_str!("../../../../tests/geometry/p3-al-ob5/fixture.json");
    assert_eq!(
        without_whitespace(committed),
        without_whitespace(&fixture_json())
    );
}

/// Writes the fixture; run once with `--ignored` before the first comparison, then format it.
#[test]
#[ignore = "writes tests/geometry/p3-al-ob5/fixture.json"]
fn emit_p3_al_ob5_fixture() {
    let target = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tests/geometry/p3-al-ob5/fixture.json");
    std::fs::write(target, fixture_json()).unwrap();
}
