//! P3 Alt-A1 AL-OB5 unit OB5-U2 (`docs/plans/p3-al-ob5-workload-scenario-proposal.md`
//! sections 3 and 5): the native leg of scenario `p3-al-ob5-workload` v1 on the **production
//! caps** (B1). AL-S1's harness (`p3_fill_ladder_bench.rs`) stays pinned to the pre-B1 cap mode
//! and is not used here. The ignored tests run only through `pnpm benchmark:p3-al-ob5`; each
//! reads the framed TypeScript-encoded corpus bytes the runner wrote and writes one JSON record:
//!
//! - `run_ob5_native`: one repetition, report-only timing and the browser oracle (OB5-V1). Per
//!   set, in B0's shuffled set order: one untimed preparation call on the set's 1,000 requests
//!   (it sizes the engine), warm-up and timed calls of that batch, each window ending after the
//!   decoded fold of its output; three untimed one-path calls (paths 0-2), then every edit path
//!   timed once in the order shuffled by `0x0b5e0000 + r`; the allocation counter around every
//!   timed and warm-up call (outside its window); the storage before and after; and per path the
//!   status, counts, its own fold, the flat command count and the ladder record through
//!   `build_path` (`FillEngine::build_one`) for the rung mix (OB5-V6).
//! - `run_ob5_observation`: OB5-Q7 (a), untimed: the unsnapped OB5-W8U corpus, status and rung
//!   mix per path. Outside the verdict.
//! - `run_ob5_oracle`: the untimed oracle run (OB5-V7): the AL-U2 dump format on the production
//!   caps (`fill_ladder_dump_tests::dump_production`) of the `P3FLDIN1` input the runner built,
//!   then per entry the ladder record through `build_path` and AL-I2 at export level (on a
//!   fallback, the one-path export output equals the `exact_only` output byte for byte).
//!
//! Test-only (`lib.rs` declares it under `cfg(test)`, at the end of the file). Every input is
//! framed before any window and copied into the engine outside it; nothing inside a timed window
//! allocates.
use core::hint::black_box;
use std::env;
use std::fs;
use std::time::Instant;

use crate::cubic_fill::CubicFillWorkspace;
use crate::engine::{BATCH_OK, BATCH_OUTPUT_CAPACITY};
use crate::fill_export::{
    FillEngine, FillRequest, PathOutcome, FILL_INPUT_MAGIC, FILL_PATH_OK, FILL_V0_LIMITS,
    FILL_V0_REVISION, INPUT_HEADER_BYTES, OUTPUT_HEADER_BYTES, REQUEST_BYTES, RESULT_BYTES,
};
use crate::fill_ladder::{ExactStep, Rung};
use crate::fill_ladder_dump_tests::{dump_production, read_input, Body};
use crate::line_fill::LineFillRule;
use crate::p3_b0_bench::{
    clock_quantum, env_usize, fnv, nanos, read_corpus, shuffled, write_output, Cell, CorpusPath,
    Json, FNV_OFFSET,
};

/// Section 3.3: B0's set-order seed and the new edit-order seed, each plus the repetition.
const ORDER_SEED: u32 = 0x9e37_79b9;
const EDIT_SEED: u32 = 0x0b5e_0000;
/// Section 3.3: the untimed one-path calls before the timed edits.
const EDIT_WARMUP_PATHS: usize = 3;
/// Section 2.1: nonzero at e = -3.
const RULE: LineFillRule = LineFillRule::Nonzero;
const EXPONENT: i32 = -3;
/// The first output reservation; the preparation call grows it to what a set needs.
const INITIAL_OUTPUT_BYTES: u32 = 1024 * 1024;
const ORACLE_ENGINE_INPUT_BYTES: u32 = 64 * 1024;

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("u32 width"))
}

fn as_u32(value: usize) -> u32 {
    u32::try_from(value).expect("fill-v0 field fits u32")
}

/// One path of a framed input: its verbs and the little-endian f64 bytes of its scalars.
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

/// The fill-v0 input of `paths` in V2 section a's layout (request id = the path's index in the
/// input), every padding byte zero; the same layout as AL-S1's `frame`.
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

/// One production-cap fill-v0 engine (no pre-B1 hook).
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

    /// The untimed preparation call: runs `input`, growing the output to what it needs.
    /// Returns the status of the last call.
    fn prepare(&mut self, input: &[u8]) -> u32 {
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
        status
    }
}

/// Folds path `index` of a published output, as AL-S2's decoded fold does per path: the status
/// as u32 LE; on `OK` also V, T and the boundary pair count as u32 LE, then the block's bytes
/// (the positions' f64 bits LE, the indices u32 LE and the boundary pairs u32 LE).
fn fold_path(output: &[u8], index: usize, mut hash: u64) -> u64 {
    let at = OUTPUT_HEADER_BYTES + index * RESULT_BYTES;
    let status = read_u32(output, at + 4);
    hash = fnv(hash, &status.to_le_bytes());
    if status != FILL_PATH_OK {
        return hash;
    }
    let offset = read_u32(output, at + 16) as usize;
    let vertices = read_u32(output, at + 20);
    let indices = read_u32(output, at + 24);
    let boundary = read_u32(output, at + 28);
    hash = fnv(hash, &vertices.to_le_bytes());
    hash = fnv(hash, &(indices / 3).to_le_bytes());
    hash = fnv(hash, &(boundary / 2).to_le_bytes());
    let length = 16 * vertices as usize + 4 * indices as usize + 4 * boundary as usize;
    fnv(hash, &output[offset..offset + length])
}

/// The decoded fold of a whole output, path by path in output order; allocates nothing.
fn fold_decoded(output: &[u8], mut hash: u64) -> u64 {
    let count = read_u32(output, 12) as usize;
    for index in 0..count {
        hash = fold_path(output, index, hash);
    }
    hash
}

/// One timed call on the loaded input: the allocation counter is switched on outside the
/// window, the window covers `process` and the decoded fold. Returns (ns, status, hash,
/// allocations); the hash is that of the published output, or the offset on a failed batch.
fn timed_call(harness: &mut Harness, length: u32) -> (u64, u32, u64, usize) {
    crate::allocation_test_support::start();
    let start = Instant::now();
    let status = harness.engine.process(length);
    let hash = if status == BATCH_OK {
        fold_decoded(harness.engine.output_bytes(), FNV_OFFSET)
    } else {
        FNV_OFFSET
    };
    let ns = nanos(start);
    let allocations = crate::allocation_test_support::stop();
    (ns, status, black_box(hash), allocations)
}

fn hex(value: u64) -> String {
    format!("{value:016x}")
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

fn nullable_string(json: &mut Json, value: Option<&str>) {
    match value {
        Some(text) => json.string(text),
        None => json.raw("null"),
    };
}

fn strings(json: &mut Json, values: &[Option<&str>]) {
    json.raw("[");
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            json.raw(",");
        }
        nullable_string(json, *value);
    }
    json.raw("]");
}

fn usizes(json: &mut Json, values: &[usize]) {
    let values: Vec<u64> = values.iter().map(|value| *value as u64).collect();
    json.numbers(&values);
}

/// The ladder record of one path through `build_path`, untimed: rung, reason and exact step.
struct LadderRecord {
    rung: Option<Rung>,
    reason: Option<&'static str>,
    step: Option<ExactStep>,
    mesh: bool,
}

fn ladder_record(engine: &mut FillEngine, path: FramePath<'_>, index: usize) -> LadderRecord {
    let built = engine
        .build_one(
            FillRequest {
                request_id: as_u32(index),
                rule: path.rule,
                exponent: path.exponent,
            },
            path.verbs,
            path.point_bytes,
        )
        .expect("a reserved engine")
        .expect("no self-check failure");
    LadderRecord {
        rung: built.rung,
        reason: built.reason.map(|reason| reason.code()),
        step: built.step,
        mesh: built.outcome == PathOutcome::Mesh,
    }
}

/// A sequence of calls with their times, checksums, statuses and allocations.
#[derive(Default)]
struct Samples {
    ns: Vec<u64>,
    checksums: Vec<u64>,
    statuses: Vec<u64>,
    allocations: Vec<u64>,
}

impl Samples {
    fn with_capacity(count: usize) -> Self {
        Self {
            ns: Vec::with_capacity(count),
            checksums: Vec::with_capacity(count),
            statuses: Vec::with_capacity(count),
            allocations: Vec::with_capacity(count),
        }
    }

    fn push(&mut self, (ns, status, hash, allocations): (u64, u32, u64, usize)) {
        self.ns.push(ns);
        self.checksums.push(hash);
        self.statuses.push(u64::from(status));
        self.allocations.push(allocations as u64);
    }

    fn json(&self, json: &mut Json) {
        json.raw("{")
            .key("ns")
            .numbers(&self.ns)
            .raw(",")
            .key("checksums")
            .hexes(&self.checksums)
            .raw(",")
            .key("batchStatuses")
            .numbers(&self.statuses)
            .raw(",")
            .key("allocations")
            .numbers(&self.allocations)
            .raw("}");
    }
}

/// One decision set of one repetition (section 3.3), written as one JSON object.
fn native_set(
    json: &mut Json,
    cell: &Cell,
    repetition: u32,
    warmup: usize,
    timed: usize,
    edit_paths: usize,
) {
    let paths: Vec<FramePath<'_>> = cell.paths.iter().map(FramePath::corpus).collect();
    assert!(edit_paths <= paths.len() && EDIT_WARMUP_PATHS <= paths.len());
    let batch = frame(&paths);
    let singles: Vec<Vec<u8>> = paths.iter().map(|path| frame(&[*path])).collect();
    let mut harness = Harness::new(batch.len());

    // The untimed preparation call: it sizes the output, then its result is read per path.
    let start = Instant::now();
    let preparation_status = harness.prepare(&batch);
    let preparation_ns = nanos(start);
    let mut statuses = Vec::with_capacity(paths.len());
    let mut vertices = Vec::with_capacity(paths.len());
    let mut triangles = Vec::with_capacity(paths.len());
    let mut boundary_pairs = Vec::with_capacity(paths.len());
    let mut path_checksums = Vec::with_capacity(paths.len());
    let preparation_checksum = if preparation_status == BATCH_OK {
        let output = harness.engine.output_bytes();
        assert_eq!(read_u32(output, 12) as usize, paths.len());
        for index in 0..paths.len() {
            let at = OUTPUT_HEADER_BYTES + index * RESULT_BYTES;
            assert_eq!(read_u32(output, at) as usize, index, "request echo");
            statuses.push(u64::from(read_u32(output, at + 4)));
            vertices.push(u64::from(read_u32(output, at + 20)));
            triangles.push(u64::from(read_u32(output, at + 24) / 3));
            boundary_pairs.push(u64::from(read_u32(output, at + 28) / 2));
            path_checksums.push(fold_path(output, index, FNV_OFFSET));
        }
        Some(fold_decoded(output, FNV_OFFSET))
    } else {
        None
    };
    let storage = harness.engine.storage();
    let length = as_u32(batch.len());

    let mut warmup_samples = Samples::with_capacity(warmup);
    for _ in 0..warmup {
        harness.load(&batch);
        warmup_samples.push(timed_call(&mut harness, length));
    }
    let mut timed_samples = Samples::with_capacity(timed);
    for _ in 0..timed {
        harness.load(&batch);
        timed_samples.push(timed_call(&mut harness, length));
    }

    // Edits: three untimed one-path calls, then every edit path timed once, shuffled.
    let mut edit_warmup = Vec::with_capacity(EDIT_WARMUP_PATHS);
    for single in singles.iter().take(EDIT_WARMUP_PATHS) {
        harness.load(single);
        let status = harness.engine.process(as_u32(single.len()));
        edit_warmup.push(if status == BATCH_OK {
            fold_decoded(harness.engine.output_bytes(), FNV_OFFSET)
        } else {
            FNV_OFFSET
        });
    }
    let indices: Vec<usize> = (0..edit_paths).collect();
    let order = shuffled(&indices, EDIT_SEED.wrapping_add(repetition));
    let mut edits = Samples::with_capacity(order.len());
    let mut chain = FNV_OFFSET;
    for path in &order {
        let single = &singles[*path];
        harness.load(single);
        let call = timed_call(&mut harness, as_u32(single.len()));
        if call.1 == BATCH_OK {
            chain = fold_decoded(harness.engine.output_bytes(), chain);
        }
        edits.push(call);
    }
    let storage_stable = harness.engine.storage() == storage;

    // The rung mix through build_path and the S1 flat command count, untimed, after the samples.
    let mut probe = CubicFillWorkspace::new(FILL_V0_LIMITS).expect("construct the prefix probe");
    let mut rungs = Vec::with_capacity(paths.len());
    let mut reasons = Vec::with_capacity(paths.len());
    let mut steps = Vec::with_capacity(paths.len());
    let mut meshes = Vec::with_capacity(paths.len());
    let mut flat_commands = Vec::with_capacity(paths.len());
    for (index, path) in paths.iter().enumerate() {
        let record = ladder_record(&mut harness.engine, *path, index);
        rungs.push(Some(rung_name(record.rung)));
        reasons.push(record.reason);
        steps.push(step_name(record.step));
        meshes.push(usize::from(record.mesh));
        flat_commands.push(
            probe
                .prepare_prefix(cell.paths[index].input(), probe.fast_flat_commands())
                .map_or(0, |view| view.commands.len()),
        );
    }

    json.raw("{")
        .key("set")
        .string(&cell.id)
        .raw(",")
        .key("paths")
        .number(paths.len())
        .raw(",")
        .key("inputBytes")
        .number(batch.len())
        .raw(",")
        .key("preparation")
        .raw("{")
        .key("ns")
        .number(preparation_ns)
        .raw(",")
        .key("batchStatus")
        .number(preparation_status)
        .raw(",")
        .key("checksum");
    nullable_string(json, preparation_checksum.map(hex).as_deref());
    json.raw("},").key("statuses").numbers(&statuses);
    json.raw(",").key("vertices").numbers(&vertices);
    json.raw(",").key("triangles").numbers(&triangles);
    json.raw(",").key("boundaryPairs").numbers(&boundary_pairs);
    json.raw(",").key("pathChecksums").hexes(&path_checksums);
    json.raw(",").key("warmup");
    warmup_samples.json(json);
    json.raw(",").key("timed");
    timed_samples.json(json);
    json.raw(",")
        .key("editWarmup")
        .raw("{")
        .key("paths")
        .raw("[0,1,2]")
        .raw(",")
        .key("checksums")
        .hexes(&edit_warmup)
        .raw("},")
        .key("editOrder");
    usizes(json, &order);
    json.raw(",").key("edits");
    edits.json(json);
    json.raw(",")
        .key("editChain")
        .string(&hex(chain))
        .raw(",")
        .key("storageStable")
        .raw(if storage_stable { "true" } else { "false" })
        .raw(",")
        .key("rungs");
    strings(json, &rungs);
    json.raw(",").key("reasons");
    strings(json, &reasons);
    json.raw(",").key("steps");
    strings(json, &steps);
    json.raw(",").key("meshes");
    usizes(json, &meshes);
    json.raw(",").key("flatCommands");
    usizes(json, &flat_commands);
    json.raw("}");
}

/// The corpus file's size and FNV-1a 64, so that the record ties the native leg to the bytes
/// the runner hashed (OB5-V4).
fn corpus_identity(json: &mut Json, path: &str) {
    let bytes = fs::read(path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    json.key("corpus")
        .raw("{")
        .key("bytes")
        .number(bytes.len())
        .raw(",")
        .key("fnv")
        .string(&hex(fnv(FNV_OFFSET, &bytes)))
        .raw("}");
}

#[test]
#[ignore = "P3 AL-OB5 native leg repetition; run only by pnpm benchmark:p3-al-ob5"]
fn run_ob5_native() {
    let input = env::var("P3_B0_INPUT").expect("P3_B0_INPUT is required");
    let cells = read_corpus(&input);
    let repetition = u32::try_from(env_usize("P3_B0_REPETITION")).expect("repetition fits u32");
    let warmup = env_usize("P3_OB5_WARMUP");
    let timed = env_usize("P3_OB5_TIMED");
    let edit_paths = env_usize("P3_OB5_EDIT_PATHS");
    let quantum = clock_quantum();
    let indices: Vec<usize> = (0..cells.len()).collect();
    let order = shuffled(&indices, ORDER_SEED.wrapping_add(repetition));

    let mut json = Json::new();
    json.raw("{")
        .key("kind")
        .string("ob5-native")
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
    corpus_identity(&mut json, &input);
    json.raw(",").key("setOrder").raw("[");
    for (index, cell) in order.iter().enumerate() {
        if index > 0 {
            json.raw(",");
        }
        json.string(&cells[*cell].id);
    }
    json.raw("],").key("sets").raw("[");
    for (index, cell) in order.iter().enumerate() {
        if index > 0 {
            json.raw(",");
        }
        native_set(
            &mut json,
            &cells[*cell],
            repetition,
            warmup,
            timed,
            edit_paths,
        );
    }
    json.raw("]}");
    write_output(&json);
}

#[test]
#[ignore = "P3 AL-OB5 OB5-Q7 (a) observation; run only by pnpm benchmark:p3-al-ob5"]
fn run_ob5_observation() {
    let input = env::var("P3_B0_INPUT").expect("P3_B0_INPUT is required");
    let cells = read_corpus(&input);
    let mut json = Json::new();
    json.raw("{")
        .key("kind")
        .string("ob5-observation")
        .raw(",")
        .key("revision")
        .number(FILL_V0_REVISION)
        .raw(",");
    corpus_identity(&mut json, &input);
    json.raw(",").key("sets").raw("[");
    for (cell_index, cell) in cells.iter().enumerate() {
        if cell_index > 0 {
            json.raw(",");
        }
        let paths: Vec<FramePath<'_>> = cell.paths.iter().map(FramePath::corpus).collect();
        let batch = frame(&paths);
        let mut harness = Harness::new(batch.len());
        let batch_status = harness.prepare(&batch);
        let statuses: Vec<u64> = if batch_status == BATCH_OK {
            let output = harness.engine.output_bytes();
            (0..paths.len())
                .map(|index| {
                    u64::from(read_u32(
                        output,
                        OUTPUT_HEADER_BYTES + index * RESULT_BYTES + 4,
                    ))
                })
                .collect()
        } else {
            Vec::new()
        };
        let mut rungs = Vec::with_capacity(paths.len());
        let mut reasons = Vec::with_capacity(paths.len());
        for (index, path) in paths.iter().enumerate() {
            let record = ladder_record(&mut harness.engine, *path, index);
            rungs.push(Some(rung_name(record.rung)));
            reasons.push(record.reason);
        }
        json.raw("{")
            .key("set")
            .string(&cell.id)
            .raw(",")
            .key("paths")
            .number(paths.len())
            .raw(",")
            .key("batchStatus")
            .number(batch_status)
            .raw(",")
            .key("statuses")
            .numbers(&statuses)
            .raw(",")
            .key("rungs");
        strings(&mut json, &rungs);
        json.raw(",").key("reasons");
        strings(&mut json, &reasons);
        json.raw("}");
    }
    json.raw("]}");
    write_output(&json);
}

/// One one-path export call on a reserved engine; the published output, or the batch status.
fn export_one(harness: &mut Harness, input: &[u8]) -> Result<Vec<u8>, u32> {
    harness.load(input);
    let status = harness.engine.process(as_u32(input.len()));
    if status == BATCH_OK {
        Ok(harness.engine.output_bytes().to_vec())
    } else {
        Err(status)
    }
}

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

/// The untimed oracle run of OB5-V7 on the production caps: the dump of the `P3FLDIN1` input
/// in the AL-U2 format, then per path entry the ladder record through `build_path` and the
/// export-level AL-I2 comparison with `exact_only` on every path the fast rung does not serve.
#[test]
#[ignore = "P3 AL-OB5 oracle run; run only by pnpm benchmark:p3-al-ob5"]
fn run_ob5_oracle() {
    let input = env::var("P3_FILL_LADDER_INPUT").expect("P3_FILL_LADDER_INPUT is required");
    let bytes = fs::read(&input).unwrap_or_else(|error| panic!("read {input}: {error}"));
    let entries = read_input(&bytes);
    let dump = dump_production(&entries);
    let dump_path = env::var("P3_FILL_LADDER_DUMP").expect("P3_FILL_LADDER_DUMP is required");
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&dump_path)
        .and_then(|mut file| std::io::Write::write_all(&mut file, dump.as_bytes()))
        .expect("write the exclusive AL-OB5 oracle dump");

    let mut ladder = Harness::new(ORACLE_ENGINE_INPUT_BYTES as usize);
    let mut exact = Harness::new(ORACLE_ENGINE_INPUT_BYTES as usize);
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
        let framed = frame(&[path]);
        let produced = export_one(&mut ladder, &framed);
        let record = ladder_record(&mut ladder.engine, path, 0);
        let status = match &produced {
            Ok(output) => status_name(read_u32(output, OUTPUT_HEADER_BYTES + 4)).to_owned(),
            Err(status) => format!("BATCH_STATUS({status})"),
        };
        let compared = record.rung != Some(Rung::Fast);
        if compared {
            checked += 1;
            if produced != export_one(&mut exact, &framed) {
                failures.push(entry.name.clone());
            }
        }
        if !first {
            json.raw(",");
        }
        first = false;
        json.raw("{")
            .key("name")
            .string(&entry.name)
            .raw(",")
            .key("rung")
            .string(rung_name(record.rung))
            .raw(",")
            .key("reason");
        nullable_string(&mut json, record.reason);
        json.raw(",").key("step");
        nullable_string(&mut json, step_name(record.step));
        json.raw(",")
            .key("status")
            .string(&status)
            .raw(",")
            .key("mesh")
            .raw(if record.mesh { "true" } else { "false" })
            .raw(",")
            .key("alI2")
            .raw(if compared { "true" } else { "false" })
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
    json.raw("]}}");
    write_output(&json);
}

// ------------------------------------------------------------------------------------------
// Debug-layer check, in the ordinary test suite.

/// A two-path frame runs on the production caps; the per-path folds chain to the whole fold,
/// and a one-path call reproduces path 0's fold, so the edit and batch folds are comparable.
#[test]
fn ob5_frame_and_path_folds_compose() {
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
            rule: RULE,
            exponent: EXPONENT,
            verbs: &triangle,
            point_bytes: &small,
        },
    ];
    let batch = frame(&paths);
    let mut harness = Harness::new(batch.len());
    assert_eq!(harness.prepare(&batch), BATCH_OK);
    let output = harness.engine.output_bytes().to_vec();
    let first = fold_path(&output, 0, FNV_OFFSET);
    let chained = fold_path(&output, 1, first);
    assert_eq!(chained, fold_decoded(&output, FNV_OFFSET));
    let single = frame(&paths[..1]);
    assert_eq!(harness.prepare(&single), BATCH_OK);
    assert_eq!(
        fold_decoded(harness.engine.output_bytes(), FNV_OFFSET),
        first
    );
    let record = ladder_record(&mut harness.engine, paths[0], 0);
    assert_eq!(record.rung, Some(Rung::Fast));
    assert!(record.mesh && record.reason.is_none() && record.step.is_none());
}
