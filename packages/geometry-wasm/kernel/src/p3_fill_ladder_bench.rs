//! P3 Alt-A1 unit AL-U5 of the frozen contract `docs/plans/p3-alt-a1-fill-ladder-contract.md`:
//! the harness of scenario AL-S1, `p3-fill-ladder` v1 (section 5.3), and its ratio mode for
//! AL-S2's native leg (section 5.2). The ignored tests run only through
//! `pnpm benchmark:p3-fill-ladder` (the ratio mode through AL-S2's runner, which imports the
//! AL-S1 runner's `runRatioMode`); each reads the framed B0 corpus and writes one JSON record:
//!
//! - `run_ladder_decision`: one repetition with B0's sampling. E5 (`size_of::<FillEngine>()`
//!   and `heap_bytes()`); the admission pre-check through the export, one one-path
//!   `FillEngine::process` call per path with the allocation counter around the call only,
//!   and the ladder record of each path through `build_path` (`FillEngine::build_one`); then
//!   B0's shuffled order, warm-up, timed and linearity samples. A timed sample is one
//!   `process` call on the cell's framed 10-path input (E1), then the ten individually timed
//!   one-path calls (E3); each call's window ends after the FNV-1a fold of its output bytes.
//! - `run_ladder_ratio`: the ratio mode, outside AL-S1's verdict: per sample R consecutive
//!   `process` calls on a cell's 10-path input, or on path 0 alone, each followed by the fold
//!   of its decoded output (status, counts, position bits, indices and boundary pairs), as the
//!   browser leg folds the adapter's results.
//! - `run_ladder_oracle`: the untimed oracle run: the AL-U2 dump of the full dump set (written
//!   by `fill_ladder_dump_tests::dump`), AL-I2 on every fallback path (the one-path export
//!   output byte for byte against `exact_only`), the ladder record through `build_path` of
//!   every path, and the exact rung's B0 outcomes and batch checksums for SL-O4.
//!
//! Test-only (`lib.rs` declares it under `cfg(test)`, at the end of the file). Every engine is
//! constructed, reserved and sized in an untimed preparation sample, and every input is copied
//! into the engine outside the timed window; nothing inside a timed window allocates.
use core::hint::black_box;
use core::mem::size_of;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::time::Instant;

use crate::cubic_fill::{
    CubicFillDiagnostics, CubicFillError, CubicFillWorkspace, MAX_FLAT_COMMANDS,
};
use crate::engine::{BATCH_OK, BATCH_OUTPUT_CAPACITY};
use crate::fill_export::{
    FillEngine, FillRequest, PathOutcome, FILL_INPUT_MAGIC, FILL_PATH_OK, FILL_V0_REVISION,
    INPUT_HEADER_BYTES, OUTPUT_HEADER_BYTES, REQUEST_BYTES, RESULT_BYTES,
};
use crate::fill_ladder::{ExactStep, Rung};
use crate::fill_ladder_dump_tests::{dump, read_input, Body};
use crate::geometry::Point;
use crate::line_fill::LineFillRule;
use crate::native_cubic_fill_tests::{FLATTEN_TOLERANCE, LIMITS, TOPOLOGY_TOLERANCE};
use crate::p3_b0_bench::{
    clock_quantum, env_usize, fnv, nanos, read_corpus, shuffled, write_output, Cell, CorpusPath,
    Entry, Json, FNV_OFFSET,
};

const DECISION_PATHS: usize = 10;
const LINEARITY_CELL: &str = "P4/s=16";
const LINEARITY_PATHS: usize = 100;
const ORDER_SEED: u32 = 0x9e37_79b9;
/// Section 5.3: B0's requests, nonzero at e = −3 (δ = 0.125, topology tolerance 0.0625).
const RULE: LineFillRule = LineFillRule::Nonzero;
const EXPONENT: i32 = -3;
/// The first output reservation; the preparation sample grows it to what a cell needs.
const INITIAL_OUTPUT_BYTES: u32 = 1024 * 1024;

const _: () = assert!(FLATTEN_TOLERANCE == 0.125 && TOPOLOGY_TOLERANCE == 0.0625);

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("u32 width"))
}

fn as_u32(value: usize) -> u32 {
    u32::try_from(value).expect("fill-v0 field fits u32")
}

/// One path of a framed fill-v0 input.
#[derive(Clone, Copy)]
struct FramePath<'a> {
    rule: LineFillRule,
    exponent: i32,
    verbs: &'a [u8],
    point_bytes: &'a [u8],
}

impl<'a> FramePath<'a> {
    fn corpus(path: &'a CorpusPath) -> Self {
        Self {
            rule: RULE,
            exponent: EXPONENT,
            verbs: &path.verbs,
            point_bytes: &path.point_bytes,
        }
    }
}

/// The fill-v0 input of `paths` in V2 section a's layout: header, requests (request id = the
/// path's index in the input), the verb and scalar offset tables, the verbs, then the scalars
/// at an 8-byte boundary, every padding byte zero.
fn frame(paths: &[FramePath<'_>]) -> Vec<u8> {
    let count = paths.len();
    let verb_total: usize = paths.iter().map(|path| path.verbs.len()).sum();
    let scalar_total: usize = paths.iter().map(|path| path.point_bytes.len() / 8).sum();
    let requests = INPUT_HEADER_BYTES;
    let path_offsets = (requests + REQUEST_BYTES * count).next_multiple_of(4);
    let point_offsets = path_offsets + 4 * (count + 1);
    let verbs_offset = point_offsets + 4 * (count + 1);
    let points_offset = (verbs_offset + verb_total).next_multiple_of(8);
    let total = points_offset + 8 * scalar_total;
    let mut bytes = vec![0u8; total];
    let put = |bytes: &mut [u8], offset: usize, value: u32| {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    };
    let header = [
        FILL_INPUT_MAGIC,
        0,
        as_u32(total),
        as_u32(count),
        as_u32(verb_total),
        as_u32(scalar_total),
        as_u32(requests),
        as_u32(path_offsets),
        as_u32(point_offsets),
        as_u32(verbs_offset),
        as_u32(points_offset),
        0,
    ];
    for (index, value) in header.into_iter().enumerate() {
        put(&mut bytes, index * 4, value);
    }
    let (mut verbs, mut scalars) = (0usize, 0usize);
    for (index, path) in paths.iter().enumerate() {
        let request = requests + REQUEST_BYTES * index;
        put(&mut bytes, request, as_u32(index));
        put(
            &mut bytes,
            request + 4,
            u32::from(path.rule == LineFillRule::Evenodd),
        );
        put(&mut bytes, request + 8, path.exponent as u32);
        bytes[verbs_offset + verbs..verbs_offset + verbs + path.verbs.len()]
            .copy_from_slice(path.verbs);
        let start = points_offset + 8 * scalars;
        bytes[start..start + path.point_bytes.len()].copy_from_slice(path.point_bytes);
        verbs += path.verbs.len();
        scalars += path.point_bytes.len() / 8;
        put(&mut bytes, path_offsets + 4 * (index + 1), as_u32(verbs));
        put(&mut bytes, point_offsets + 4 * (index + 1), as_u32(scalars));
    }
    bytes
}

/// A cell's framed inputs: the batch of its first `count` paths, and each path alone.
struct CellInputs {
    batch: Vec<u8>,
    singles: Vec<Vec<u8>>,
}

fn cell_inputs(cell: &Cell, count: usize) -> CellInputs {
    let paths: Vec<FramePath<'_>> = cell.paths[..count].iter().map(FramePath::corpus).collect();
    CellInputs {
        batch: frame(&paths),
        singles: paths.iter().map(|path| frame(&[*path])).collect(),
    }
}

/// One reserved fill-v0 engine.
struct Harness {
    engine: FillEngine,
}

impl Harness {
    fn new(input_bytes: usize) -> Self {
        let mut engine = FillEngine::new();
        assert_eq!(
            engine.reserve(as_u32(input_bytes), INITIAL_OUTPUT_BYTES),
            BATCH_OK,
            "reserve the fill-v0 engine"
        );
        Self { engine }
    }

    /// Copies `input` into the engine's input; never inside a timed window.
    fn load(&mut self, input: &[u8]) {
        self.engine.input_bytes_mut()[..input.len()].copy_from_slice(input);
    }

    /// The preparation sample, untimed: runs `input` once and grows the output reservation to
    /// what the batch needs, so that no timed call can meet `BATCH_OUTPUT_CAPACITY`.
    fn prepare(&mut self, input: &[u8]) {
        self.load(input);
        let mut status = self.engine.process(as_u32(input.len()));
        if status == BATCH_OUTPUT_CAPACITY {
            let required = self.engine.required_output_bytes();
            assert_eq!(
                self.engine.reserve(0, required),
                BATCH_OK,
                "grow the output"
            );
            self.load(input);
            status = self.engine.process(as_u32(input.len()));
        }
        assert_eq!(status, BATCH_OK, "preparation sample");
    }

    /// Storage identity (addresses and capacities), compared before and after the samples.
    fn storage(&self) -> [(usize, usize); 7] {
        self.engine.storage()
    }
}

fn largest(inputs: &CellInputs) -> usize {
    inputs
        .singles
        .iter()
        .map(Vec::len)
        .chain([inputs.batch.len()])
        .max()
        .expect("nonempty inputs")
}

/// One timed call, already loaded: `process`, then the FNV-1a fold of the output bytes
/// `[0, result_len)`, inside the window. Returns (ns, status, hash).
fn timed_call(harness: &mut Harness, length: u32, hash: u64) -> (u64, u32, u64) {
    let start = Instant::now();
    let status = harness.engine.process(length);
    let hash = fnv(hash, harness.engine.output_bytes());
    (nanos(start), status, hash)
}

/// One timed sample of section 5.3: the 10-path batch (E1), then each path alone (E3), each
/// copied in before its window. Returns (batch ns, batch checksum, chained path checksum) and
/// appends the path times to `path_ns` (preallocated by the caller).
fn timed_sample(
    harness: &mut Harness,
    inputs: &CellInputs,
    path_ns: &mut Vec<u64>,
) -> (u64, u64, u64) {
    harness.load(&inputs.batch);
    let (batch_ns, status, batch_hash) =
        timed_call(harness, as_u32(inputs.batch.len()), FNV_OFFSET);
    assert_eq!(status, BATCH_OK, "timed batch");
    let mut path_hash = FNV_OFFSET;
    for single in &inputs.singles {
        harness.load(single);
        let (ns, status, hash) = timed_call(harness, as_u32(single.len()), path_hash);
        assert_eq!(status, BATCH_OK, "timed path");
        path_hash = hash;
        path_ns.push(ns);
    }
    (batch_ns, black_box(batch_hash), black_box(path_hash))
}

/// A batch-only timed sample (the linearity batches of B0 section 3).
fn timed_batch(harness: &mut Harness, input: &[u8]) -> (u64, u64) {
    harness.load(input);
    let (ns, status, hash) = timed_call(harness, as_u32(input.len()), FNV_OFFSET);
    assert_eq!(status, BATCH_OK, "timed batch");
    (ns, black_box(hash))
}

fn boolean(value: bool) -> &'static str {
    if value {
        "true"
    } else {
        "false"
    }
}

fn rung_name(rung: Option<Rung>) -> &'static str {
    match rung {
        Some(Rung::Fast) => "fast",
        Some(Rung::Exact) => "exact",
        None => "none",
    }
}

fn step_name(step: Option<ExactStep>) -> Option<&'static str> {
    step.map(|step| match step {
        ExactStep::Legacy => "Legacy",
        ExactStep::TriangleFree => "TriangleFree",
    })
}

/// The admission status of section 5.3: the fill-v0 path status by its V2 name, `OK` only for
/// a published nonempty mesh, or `BATCH_STATUS(n)` when the call itself failed.
fn status_name(status: u32) -> &'static str {
    match status {
        0 => "OK",
        1 => "EMPTY",
        2 => "INVALID_PATH",
        3 => "INVALID_TOLERANCE",
        4 => "NUMERIC_RANGE",
        5 => "WORK_LIMIT",
        6 => "UNSUPPORTED_GEOMETRY",
        _ => "UNKNOWN_STATUS",
    }
}

/// Path `index` of a published output: (status, V, T, boundary pairs).
fn record(output: &[u8], index: usize) -> (u32, usize, usize, usize) {
    let at = OUTPUT_HEADER_BYTES + index * RESULT_BYTES;
    (
        read_u32(output, at + 4),
        read_u32(output, at + 20) as usize,
        read_u32(output, at + 24) as usize / 3,
        read_u32(output, at + 28) as usize / 2,
    )
}

/// The ladder record of one path through `build_path` (Alt-A1 section 3.6), untimed: rung,
/// reason, exact step, and on the exact rung the topology selection of its workspace.
struct LadderRecord {
    rung: Option<Rung>,
    reason: Option<&'static str>,
    step: Option<ExactStep>,
    mesh: bool,
    rounded: bool,
    transverse: bool,
}

fn ladder_record(engine: &mut FillEngine, path: FramePath<'_>, index: usize) -> LadderRecord {
    let request = FillRequest {
        request_id: as_u32(index),
        rule: path.rule,
        exponent: path.exponent,
    };
    let built = engine
        .build_one(request, path.verbs, path.point_bytes)
        .expect("a reserved engine")
        .expect("no self-check failure");
    let (rounded, transverse) = if built.rung == Some(Rung::Exact) {
        let diagnostics = engine.workspace().expect("workspace").diagnostics();
        (
            diagnostics.rounded_topology_selected,
            diagnostics.transverse_topology_selected,
        )
    } else {
        (false, false)
    };
    LadderRecord {
        rung: built.rung,
        reason: built.reason.map(|reason| reason.code()),
        step: built.step,
        mesh: built.outcome == PathOutcome::Mesh,
        rounded,
        transverse,
    }
}

fn json_ladder(json: &mut Json, ladder: &LadderRecord) {
    json.key("rung").string(rung_name(ladder.rung));
    json.raw(",").key("reason");
    match ladder.reason {
        Some(code) => json.string(code),
        None => json.raw("null"),
    };
    json.raw(",").key("step");
    match step_name(ladder.step) {
        Some(name) => json.string(name),
        None => json.raw("null"),
    };
}

/// Admission pre-check over `count` paths (section 5.3, as B0's): per path the export status
/// of a one-path call (allocations counted around the call only), V, T and the boundary pairs,
/// the S1 flat command count from a separate prefix probe, and the ladder record through
/// `build_path`. Returns whether paths 0-9 and whether all `count` paths are OK.
fn admission(
    json: &mut Json,
    harness: &mut Harness,
    probe: &mut CubicFillWorkspace,
    cell: &Cell,
    count: usize,
) -> (bool, bool) {
    let mut decision_ok = true;
    let mut all_ok = true;
    json.raw("{")
        .key("cell")
        .string(&cell.id)
        .raw(",")
        .key("paths")
        .raw("[");
    for (index, path) in cell.paths[..count].iter().enumerate() {
        if index > 0 {
            json.raw(",");
        }
        let input = frame(&[FramePath::corpus(path)]);
        harness.load(&input);
        crate::allocation_test_support::start();
        let status = harness.engine.process(as_u32(input.len()));
        let allocations = crate::allocation_test_support::stop();
        let outcome = (status == BATCH_OK).then(|| record(harness.engine.output_bytes(), 0));
        let ok = matches!(
            outcome,
            Some((FILL_PATH_OK, vertices, triangles, _)) if vertices > 0 && triangles > 0
        );
        if !ok {
            all_ok = false;
            if index < DECISION_PATHS {
                decision_ok = false;
            }
        }
        json.raw("{").key("status");
        match outcome {
            Some((path_status, _, _, _)) => json.string(status_name(path_status)),
            None => json.string(&format!("BATCH_STATUS({status})")),
        };
        json.raw(",");
        let ladder = ladder_record(&mut harness.engine, FramePath::corpus(path), 0);
        json_ladder(json, &ladder);
        let flat = probe
            .prepare_prefix(path.input(), MAX_FLAT_COMMANDS)
            .ok()
            .map(|view| view.commands.len());
        if let Some(flat) = flat {
            json.raw(",").key("flatCommands").number(flat);
        }
        if let Some((FILL_PATH_OK, vertices, triangles, pairs)) = outcome {
            json.raw(",")
                .key("vertices")
                .number(vertices)
                .raw(",")
                .key("triangles")
                .number(triangles)
                .raw(",")
                .key("boundaryPairs")
                .number(pairs);
        }
        json.raw(",")
            .key("rounded")
            .raw(boolean(ladder.rounded))
            .raw(",")
            .key("transverse")
            .raw(boolean(ladder.transverse))
            .raw(",")
            .key("allocations")
            .number(allocations)
            .raw("}");
    }
    json.raw("]}");
    (decision_ok, all_ok)
}

fn decision_cell(json: &mut Json, cell: &Cell, warmup: usize, timed: usize) {
    let inputs = cell_inputs(cell, DECISION_PATHS);
    let construct = Instant::now();
    let mut harness = Harness::new(largest(&inputs));
    let engine_ns = nanos(construct);
    harness.prepare(&inputs.batch);
    for single in &inputs.singles {
        harness.prepare(single);
    }
    let storage = harness.storage();
    let mut path_ns = Vec::with_capacity(timed * DECISION_PATHS);
    let mut scratch = Vec::with_capacity(DECISION_PATHS);
    for _ in 0..warmup {
        scratch.clear();
        timed_sample(&mut harness, &inputs, &mut scratch);
    }
    let mut batch_ns = Vec::with_capacity(timed);
    let mut checksums = Vec::with_capacity(timed);
    let mut path_checksums = Vec::with_capacity(timed);
    for _ in 0..timed {
        let (ns, hash, paths) = timed_sample(&mut harness, &inputs, &mut path_ns);
        batch_ns.push(ns);
        checksums.push(hash);
        path_checksums.push(paths);
    }
    // One further untimed sample with the allocation counter on (AL-A6, B0 section 3).
    scratch.clear();
    crate::allocation_test_support::start();
    timed_sample(&mut harness, &inputs, &mut scratch);
    let batch_allocations = crate::allocation_test_support::stop();
    let storage_stable = harness.storage() == storage;
    json.raw("{")
        .key("cell")
        .string(&cell.id)
        .raw(",")
        .key("engineNs")
        .number(engine_ns)
        .raw(",")
        .key("batchAllocations")
        .number(batch_allocations)
        .raw(",")
        .key("storageStable")
        .raw(boolean(storage_stable))
        .raw(",")
        .key("batchNs")
        .numbers(&batch_ns)
        .raw(",")
        .key("pathNs")
        .numbers(&path_ns)
        .raw(",")
        .key("checksums")
        .hexes(&checksums)
        .raw(",")
        .key("pathChecksums")
        .hexes(&path_checksums)
        .raw("}");
}

fn linearity(json: &mut Json, cell: &Cell, timed: usize, warmup: usize, linearity_timed: usize) {
    let small = cell_inputs(cell, DECISION_PATHS).batch;
    let paths: Vec<FramePath<'_>> = cell.paths[..LINEARITY_PATHS]
        .iter()
        .map(FramePath::corpus)
        .collect();
    let large = frame(&paths);
    let mut harness = Harness::new(small.len().max(large.len()));
    harness.prepare(&small);
    harness.prepare(&large);
    let storage = harness.storage();
    let mut small_ns = Vec::with_capacity(timed);
    let mut small_sums = Vec::with_capacity(timed);
    for _ in 0..timed {
        let (ns, hash) = timed_batch(&mut harness, &small);
        small_ns.push(ns);
        small_sums.push(hash);
    }
    for _ in 0..warmup {
        timed_batch(&mut harness, &large);
    }
    let mut large_ns = Vec::with_capacity(linearity_timed);
    let mut large_sums = Vec::with_capacity(linearity_timed);
    for _ in 0..linearity_timed {
        let (ns, hash) = timed_batch(&mut harness, &large);
        large_ns.push(ns);
        large_sums.push(hash);
    }
    json.raw("{")
        .key("cell")
        .string(&cell.id)
        .raw(",")
        .key("storageStable")
        .raw(boolean(harness.storage() == storage))
        .raw(",")
        .key("batch10Ns")
        .numbers(&small_ns)
        .raw(",")
        .key("checksums10")
        .hexes(&small_sums)
        .raw(",")
        .key("batch100Ns")
        .numbers(&large_ns)
        .raw(",")
        .key("checksums100")
        .hexes(&large_sums)
        .raw("}");
}

#[test]
#[ignore = "P3 Alt-A1 AL-S1 decision repetition; run only by pnpm benchmark:p3-fill-ladder"]
fn run_ladder_decision() {
    let cells = read_corpus(&env::var("P3_B0_INPUT").expect("P3_B0_INPUT is required"));
    let repetition = u32::try_from(env_usize("P3_B0_REPETITION")).expect("repetition fits u32");
    let warmup = env_usize("P3_B0_WARMUP");
    let timed = env_usize("P3_B0_TIMED");
    let linearity_warmup = env_usize("P3_B0_LIN_WARMUP");
    let linearity_timed = env_usize("P3_B0_LIN_TIMED");
    let quantum = clock_quantum();

    let mut json = Json::new();
    json.raw("{")
        .key("kind")
        .string("decision")
        .raw(",")
        .key("repetition")
        .number(repetition)
        .raw(",")
        .key("revision")
        .number(FILL_V0_REVISION)
        .raw(",")
        .key("clockQuantumNs")
        .number(quantum)
        .raw(",");

    // E5: the engine's inline size and `heap_bytes()` (workspace, scratch and ladder).
    let decision: Vec<&Cell> = cells.iter().filter(|cell| cell.is_decision()).collect();
    let mut harness = Harness::new(64 * 1024);
    json.key("engine")
        .raw("{")
        .key("inlineBytes")
        .number(size_of::<FillEngine>())
        .raw(",")
        .key("heapBytes")
        .number(harness.engine.heap_bytes())
        .raw("},");

    let mut probe = CubicFillWorkspace::new(LIMITS).expect("construct the prefix probe");
    json.key("admission").raw("[");
    let mut admitted = Vec::new();
    let mut linearity_ok = false;
    for (index, cell) in decision.iter().enumerate() {
        if index > 0 {
            json.raw(",");
        }
        let count = if cell.id == LINEARITY_CELL {
            LINEARITY_PATHS
        } else {
            DECISION_PATHS
        };
        let (decision_ok, all_ok) = admission(&mut json, &mut harness, &mut probe, cell, count);
        if cell.id == LINEARITY_CELL {
            linearity_ok = all_ok;
        }
        if decision_ok {
            admitted.push(index);
        }
    }
    json.raw("],");
    drop(harness);

    let order = shuffled(&admitted, ORDER_SEED.wrapping_add(repetition));
    json.key("order").raw("[");
    for (index, cell) in order.iter().enumerate() {
        if index > 0 {
            json.raw(",");
        }
        json.string(&decision[*cell].id);
    }
    json.raw("],").key("cells").raw("[");
    for (index, cell) in order.iter().enumerate() {
        if index > 0 {
            json.raw(",");
        }
        decision_cell(&mut json, decision[*cell], warmup, timed);
    }
    json.raw("],").key("linearity");
    match decision
        .iter()
        .find(|cell| cell.id == LINEARITY_CELL)
        .filter(|_| linearity_ok)
    {
        None => {
            json.raw("null");
        }
        Some(cell) => linearity(&mut json, cell, timed, linearity_warmup, linearity_timed),
    }
    json.raw("}");
    write_output(&json);
}

// ------------------------------------------------------------------------------------------
// The ratio mode (section 5.2), outside AL-S1's verdict.

/// Folds a published output's decoded results, as AL-S2's browser leg folds the adapter's:
/// per path in output order the status as a u32 LE; on `OK` also V, T and the boundary pair
/// count as u32 LE, then the block's bytes, which are the positions' f64 bits LE (x, y), the
/// indices u32 LE and the boundary pairs u32 LE in V2 section g's order. Allocates nothing.
fn fold_decoded(output: &[u8], mut hash: u64) -> u64 {
    let count = read_u32(output, 12) as usize;
    for index in 0..count {
        let at = OUTPUT_HEADER_BYTES + index * RESULT_BYTES;
        let status = read_u32(output, at + 4);
        hash = fnv(hash, &status.to_le_bytes());
        if status != FILL_PATH_OK {
            continue;
        }
        let offset = read_u32(output, at + 16) as usize;
        let vertices = read_u32(output, at + 20);
        let indices = read_u32(output, at + 24);
        let boundary = read_u32(output, at + 28);
        hash = fnv(hash, &vertices.to_le_bytes());
        hash = fnv(hash, &(indices / 3).to_le_bytes());
        hash = fnv(hash, &(boundary / 2).to_le_bytes());
        let length = 16 * vertices as usize + 4 * indices as usize + 4 * boundary as usize;
        hash = fnv(hash, &output[offset..offset + length]);
    }
    hash
}

/// One ratio sample: `calls` consecutive `process` calls on the loaded input, each followed by
/// the decoded fold; the window ends after the last call's fold. Returns (ns, checksum).
fn ratio_sample(harness: &mut Harness, length: u32, calls: usize) -> (u64, u64) {
    let start = Instant::now();
    let mut hash = FNV_OFFSET;
    for _ in 0..calls {
        let status = harness.engine.process(length);
        assert_eq!(status, BATCH_OK, "ratio call");
        hash = fold_decoded(harness.engine.output_bytes(), hash);
    }
    (nanos(start), black_box(hash))
}

/// One ratio cell: a fresh engine, the untimed preparation sample, warm-up and timed samples,
/// then an allocation-counted untimed sample and the storage comparison.
fn ratio_cell(
    json: &mut Json,
    cell: &Cell,
    input: &[u8],
    calls: usize,
    warmup: usize,
    timed: usize,
) {
    let mut harness = Harness::new(input.len());
    harness.prepare(input);
    let storage = harness.storage();
    harness.load(input);
    let length = as_u32(input.len());
    for _ in 0..warmup {
        ratio_sample(&mut harness, length, calls);
    }
    let mut sample_ns = Vec::with_capacity(timed);
    let mut checksums = Vec::with_capacity(timed);
    for _ in 0..timed {
        let (ns, hash) = ratio_sample(&mut harness, length, calls);
        sample_ns.push(ns);
        checksums.push(hash);
    }
    crate::allocation_test_support::start();
    ratio_sample(&mut harness, length, calls);
    let allocations = crate::allocation_test_support::stop();
    json.raw("{")
        .key("cell")
        .string(&cell.id)
        .raw(",")
        .key("allocations")
        .number(allocations)
        .raw(",")
        .key("storageStable")
        .raw(boolean(harness.storage() == storage))
        .raw(",")
        .key("sampleNs")
        .numbers(&sample_ns)
        .raw(",")
        .key("checksums")
        .hexes(&checksums)
        .raw("}");
}

#[test]
#[ignore = "P3 Alt-A1 AL-S2 native leg (AL-S1 ratio mode); run only by the AL-S2 runner"]
fn run_ladder_ratio() {
    let cells = read_corpus(&env::var("P3_B0_INPUT").expect("P3_B0_INPUT is required"));
    let repetition = u32::try_from(env_usize("P3_B0_REPETITION")).expect("repetition fits u32");
    let warmup = env_usize("P3_B0_WARMUP");
    let timed = env_usize("P3_B0_TIMED");
    let calls = env_usize("P3_FL_RATIO_CALLS");
    let one_path_calls = env_usize("P3_FL_RATIO_ONE_PATH_CALLS");
    let one_path_cells =
        env::var("P3_FL_RATIO_ONE_PATH_CELLS").expect("P3_FL_RATIO_ONE_PATH_CELLS is required");
    let one_path_cells: Vec<&str> = one_path_cells.split(',').collect();
    let quantum = clock_quantum();
    let decision: Vec<&Cell> = cells.iter().filter(|cell| cell.is_decision()).collect();
    let indices: Vec<usize> = (0..decision.len()).collect();
    let order = shuffled(&indices, ORDER_SEED.wrapping_add(repetition));
    let one_path: Vec<usize> = one_path_cells
        .iter()
        .map(|id| {
            decision
                .iter()
                .position(|cell| cell.id == *id)
                .unwrap_or_else(|| panic!("unknown one-path cell {id}"))
        })
        .collect();
    let one_path_order = shuffled(&one_path, ORDER_SEED.wrapping_add(repetition));

    let mut json = Json::new();
    json.raw("{")
        .key("kind")
        .string("ratio")
        .raw(",")
        .key("repetition")
        .number(repetition)
        .raw(",")
        .key("revision")
        .number(FILL_V0_REVISION)
        .raw(",")
        .key("clockQuantumNs")
        .number(quantum)
        .raw(",")
        .key("calls")
        .number(calls)
        .raw(",")
        .key("onePathCalls")
        .number(one_path_calls)
        .raw(",")
        .key("order")
        .raw("[");
    for (index, cell) in order.iter().enumerate() {
        if index > 0 {
            json.raw(",");
        }
        json.string(&decision[*cell].id);
    }
    json.raw("],").key("cells").raw("[");
    for (index, cell) in order.iter().enumerate() {
        if index > 0 {
            json.raw(",");
        }
        let cell = decision[*cell];
        let input = cell_inputs(cell, DECISION_PATHS).batch;
        ratio_cell(&mut json, cell, &input, calls, warmup, timed);
    }
    json.raw("],").key("onePath").raw("[");
    for (index, cell) in one_path_order.iter().enumerate() {
        if index > 0 {
            json.raw(",");
        }
        let cell = decision[*cell];
        let input = frame(&[FramePath::corpus(&cell.paths[0])]);
        ratio_cell(&mut json, cell, &input, one_path_calls, warmup, timed);
    }
    json.raw("]}");
    write_output(&json);
}

// ------------------------------------------------------------------------------------------
// The oracle run (section 5.3).

/// The exact rung as B0 called it (B0 section 2), for SL-O4: `attempt`, or `attempt_transverse`
/// on X cells, with B0's limits and tolerances.
fn b0_exact(
    workspace: &mut CubicFillWorkspace,
    cell: &Cell,
    path: &CorpusPath,
) -> Result<CubicFillDiagnostics, CubicFillError> {
    match cell.entry {
        Entry::Attempt => {
            workspace.attempt(path.input(), RULE, TOPOLOGY_TOLERANCE, MAX_FLAT_COMMANDS)
        }
        Entry::Transverse => {
            workspace.attempt_transverse(path.input(), RULE, TOPOLOGY_TOLERANCE, MAX_FLAT_COMMANDS)
        }
    }
}

/// B0's checksum fold of one published exact mesh: the status word 0, V, T, vertex bits,
/// indices.
fn fold_b0_mesh(hash: u64, vertices: &[Point], indices: &[u32]) -> u64 {
    let mut value = fnv(hash, &0u32.to_le_bytes());
    value = fnv(value, &as_u32(vertices.len()).to_le_bytes());
    value = fnv(value, &as_u32(indices.len() / 3).to_le_bytes());
    for vertex in vertices {
        value = fnv(value, &vertex.x.to_bits().to_le_bytes());
        value = fnv(value, &vertex.y.to_bits().to_le_bytes());
    }
    for index in indices {
        value = fnv(value, &index.to_le_bytes());
    }
    value
}

/// One B0 exact outcome as JSON, with B0's status codes (OK only for a published nonempty
/// mesh). Returns whether it is OK; the workspace keeps the published output.
fn json_b0_outcome(
    json: &mut Json,
    workspace: &mut CubicFillWorkspace,
    cell: &Cell,
    path: &CorpusPath,
) -> bool {
    let result = b0_exact(workspace, cell, path);
    let diagnostics = workspace.diagnostics();
    let published = match (result, workspace.output()) {
        (Ok(_), Some(output))
            if !output.rounded.vertices.is_empty() && !output.rounded.indices.is_empty() =>
        {
            Ok(output)
        }
        (Ok(_), Some(_)) => Err("EMPTY_MESH".to_owned()),
        (Ok(outcome), None) => Err(format!("NO_MESH(flat_status={})", outcome.flat_status)),
        (Err(error), _) => Err(format!("{error:?}")),
    };
    json.raw("{").key("status");
    let ok = match published {
        Ok(output) => {
            json.string("OK")
                .raw(",")
                .key("flatCommands")
                .number(output.commands.len())
                .raw(",")
                .key("vertices")
                .number(output.rounded.vertices.len())
                .raw(",")
                .key("triangles")
                .number(output.rounded.indices.len() / 3);
            true
        }
        Err(code) => {
            json.string(&code);
            false
        }
    };
    json.raw(",")
        .key("rounded")
        .raw(boolean(diagnostics.rounded_topology_selected))
        .raw(",")
        .key("transverse")
        .raw(boolean(diagnostics.transverse_topology_selected))
        .raw("}");
    ok
}

/// One one-path export call on a reserved engine; the published output, or the batch status.
fn export_one<'a>(harness: &'a mut Harness, input: &[u8]) -> Result<&'a [u8], u32> {
    harness.load(input);
    let status = harness.engine.process(as_u32(input.len()));
    if status == BATCH_OK {
        Ok(harness.engine.output_bytes())
    } else {
        Err(status)
    }
}

fn write_dump(text: &str) {
    let path = env::var("P3_FILL_LADDER_DUMP").expect("P3_FILL_LADDER_DUMP is required");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .expect("create the exclusive ladder oracle dump");
    file.write_all(text.as_bytes())
        .expect("write the ladder oracle dump");
}

/// The untimed oracle run of section 5.3. It writes the AL-U2 dump of the `P3FLDIN1` input
/// (the full dump set of section 4.2, built by the runner), then per path entry the ladder
/// record through `build_path` and AL-I2 (on a fallback, or a status decided before rung 0,
/// the one-path export output equals the `exact_only` output byte for byte), and over the B0
/// corpus the exact rung's B0 outcomes and batch checksums for SL-O4.
#[test]
#[ignore = "P3 Alt-A1 AL-S1 oracle run; run only by pnpm benchmark:p3-fill-ladder"]
fn run_ladder_oracle() {
    let cells = read_corpus(&env::var("P3_B0_INPUT").expect("P3_B0_INPUT is required"));
    let input = env::var("P3_FILL_LADDER_INPUT").expect("P3_FILL_LADDER_INPUT is required");
    let bytes = fs::read(&input).unwrap_or_else(|error| panic!("read {input}: {error}"));
    let entries = read_input(&bytes);
    write_dump(&dump(&entries));

    let mut ladder = Harness::new(64 * 1024);
    let mut exact = Harness::new(64 * 1024);
    exact.engine.hooks().exact_only = true;
    let mut json = Json::new();
    json.raw("{")
        .key("kind")
        .string("oracle")
        .raw(",")
        .key("revision")
        .number(FILL_V0_REVISION)
        .raw(",")
        .key("entries")
        .number(entries.len())
        .raw(",")
        .key("paths")
        .raw("[");
    let mut first = true;
    let mut checked = 0usize;
    let mut failures = Vec::new();
    for entry in &entries {
        let Body::Path { verbs, point_bytes } = &entry.body else {
            continue;
        };
        let path = FramePath {
            rule: entry.rule,
            exponent: entry.exponent,
            verbs,
            point_bytes,
        };
        let input = frame(&[path]);
        let produced = export_one(&mut ladder, &input).map(<[u8]>::to_vec);
        let record_ladder = ladder_record(&mut ladder.engine, path, 0);
        let status = match &produced {
            Ok(output) => status_name(record(output, 0).0).to_owned(),
            Err(status) => format!("BATCH_STATUS({status})"),
        };
        let compared = record_ladder.rung != Some(Rung::Fast);
        if compared {
            checked += 1;
            let reference = export_one(&mut exact, &input).map(<[u8]>::to_vec);
            if produced != reference {
                failures.push(entry.name.clone());
            }
        }
        if !first {
            json.raw(",");
        }
        first = false;
        json.raw("{").key("name").string(&entry.name).raw(",");
        json_ladder(&mut json, &record_ladder);
        json.raw(",")
            .key("status")
            .string(&status)
            .raw(",")
            .key("mesh")
            .raw(boolean(record_ladder.mesh))
            .raw(",")
            .key("alI2")
            .raw(boolean(compared))
            .raw("}");
    }
    json.raw("],")
        .key("alI2")
        .raw("{")
        .key("checked")
        .number(checked)
        .raw(",")
        .key("failures")
        .raw("[");
    for (index, name) in failures.iter().enumerate() {
        if index > 0 {
            json.raw(",");
        }
        json.string(name);
    }
    json.raw("]},").key("exactOutcomes").raw("[");
    let mut workspace = CubicFillWorkspace::new(LIMITS).expect("construct the exact workspace");
    let mut checksums = Json::new();
    checksums.raw("[");
    let mut first_checksum = true;
    for (cell_index, cell) in cells.iter().enumerate() {
        if cell_index > 0 {
            json.raw(",");
        }
        json.raw("{")
            .key("cell")
            .string(&cell.id)
            .raw(",")
            .key("paths")
            .raw("[");
        let (mut hash10, mut ok10) = (FNV_OFFSET, true);
        let (mut hash100, mut ok100) = (FNV_OFFSET, true);
        for (index, path) in cell.paths.iter().enumerate() {
            if index > 0 {
                json.raw(",");
            }
            let ok = json_b0_outcome(&mut json, &mut workspace, cell, path);
            // B0's batch is paths 0-9 in order; for P4/s=16 its linearity batch is 0-99.
            if index < DECISION_PATHS {
                ok10 &= ok;
                hash10 = fold_published(&workspace, hash10, ok);
            }
            if cell.id == LINEARITY_CELL && index < LINEARITY_PATHS {
                ok100 &= ok;
                hash100 = fold_published(&workspace, hash100, ok);
            }
        }
        json.raw("]}");
        if cell.is_decision() {
            if !first_checksum {
                checksums.raw(",");
            }
            first_checksum = false;
            checksums
                .raw("{")
                .key("cell")
                .string(&cell.id)
                .raw(",")
                .key("checksum10");
            if ok10 {
                checksums.string(&format!("{hash10:016x}"));
            } else {
                checksums.raw("null");
            }
            if cell.id == LINEARITY_CELL {
                checksums.raw(",").key("checksum100");
                if ok100 {
                    checksums.string(&format!("{hash100:016x}"));
                } else {
                    checksums.raw("null");
                }
            }
            checksums.raw("}");
        }
    }
    checksums.raw("]");
    json.raw("],")
        .key("exactChecksums")
        .raw(&checksums.0)
        .raw("}");
    write_output(&json);
}

/// Continues a B0 batch hash with one path's exact mesh, which the workspace still holds from
/// `json_b0_outcome`; an unpublished path leaves the hash (its batch is then reported null).
fn fold_published(workspace: &CubicFillWorkspace, hash: u64, ok: bool) -> u64 {
    match workspace.output() {
        Some(output) if ok => fold_b0_mesh(hash, output.rounded.vertices, output.rounded.indices),
        _ => hash,
    }
}

// ------------------------------------------------------------------------------------------
// Debug-layer checks, in the ordinary test suite.

/// The framing equals the AL-U2 dump harness's one-path layout and parses with two paths; the
/// decoded fold covers status, counts and the block bytes.
#[test]
fn frames_multi_path_inputs_and_folds_the_decoded_output() {
    let square: Vec<u8> = [0.0f64, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 10.0]
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect();
    let small: Vec<u8> = [20.0f64, 0.0, 22.0, 0.0, 22.0, 2.0]
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect();
    let verbs = [0u8, 1, 1, 1, 3];
    let triangle = [0u8, 1, 1, 3];
    let paths = [
        FramePath {
            rule: RULE,
            exponent: EXPONENT,
            verbs: &verbs,
            point_bytes: &square,
        },
        FramePath {
            rule: LineFillRule::Evenodd,
            exponent: EXPONENT,
            verbs: &triangle,
            point_bytes: &small,
        },
    ];
    let input = frame(&paths);
    let mut harness = Harness::new(input.len());
    harness.prepare(&input);
    let output = harness.engine.output_bytes().to_vec();
    assert_eq!(read_u32(&output, 12), 2);
    let first = record(&output, 0);
    let second = record(&output, 1);
    assert_eq!(first, (FILL_PATH_OK, 4, 2, 4));
    assert_eq!(second, (FILL_PATH_OK, 3, 1, 3));
    // The decoded fold differs from the raw-bytes fold and changes with any block byte.
    let decoded = fold_decoded(&output, FNV_OFFSET);
    assert_ne!(decoded, fnv(FNV_OFFSET, &output));
    let mut changed = output.clone();
    let block = read_u32(&output, OUTPUT_HEADER_BYTES + 16) as usize;
    changed[block] ^= 1;
    assert_ne!(fold_decoded(&changed, FNV_OFFSET), decoded);
    // A one-path frame round-trips through the export exactly as a batch of one.
    let single = frame(&paths[..1]);
    let mut one = Harness::new(single.len());
    one.prepare(&single);
    assert_eq!(record(one.engine.output_bytes(), 0), first);
    let ladder = ladder_record(&mut one.engine, paths[0], 0);
    assert_eq!(ladder.rung, Some(Rung::Fast));
    assert!(ladder.mesh && ladder.reason.is_none());
}
