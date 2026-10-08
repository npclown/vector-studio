//! P3 B0 feasibility harness, frozen by
//! docs/plans/p3-b0-feasibility-benchmark-contract.md. The ignored tests run only
//! through `pnpm benchmark:p3-b0`; they read a framed corpus and write one JSON record.
//! The fixture test below is an independent second implementation of the corpus
//! generator for two named paths and runs in the ordinary test suite.
use core::hint::black_box;
use core::mem::size_of;
use std::env;
use std::fmt::Write as _;
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::time::Instant;

use crate::codec::{PathInput, Request};
use crate::cubic_fill::{CubicFillWorkspace, MAX_FLAT_COMMANDS};
use crate::line_fill::LineFillRule;
use crate::native_cubic_fill_tests::{FLATTEN_TOLERANCE, LIMITS, TOPOLOGY_TOLERANCE};

const MAGIC: &[u8; 8] = b"P3B0COR1";
const DECISION_PATHS: usize = 10;
const LINEARITY_CELL: &str = "P4/s=16";
const LINEARITY_PATHS: usize = 100;
const ORDER_SEED: u32 = 0x9e37_79b9;
const QUANTUM_PROBES: usize = 10_000;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Entry {
    Attempt,
    Transverse,
}

struct CorpusPath {
    verbs: Vec<u8>,
    point_bytes: Vec<u8>,
}

impl CorpusPath {
    fn input(&self) -> PathInput<'_> {
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

struct Cell {
    id: String,
    entry: Entry,
    paths: Vec<CorpusPath>,
}

impl Cell {
    fn is_decision(&self) -> bool {
        !self.id.starts_with("O1/") && !self.id.starts_with("X/")
    }

    #[cfg_attr(not(p3_b0_diag), allow(dead_code))]
    fn is_primary(&self) -> bool {
        ["P2/", "P4/", "P8/"]
            .iter()
            .any(|prefix| self.id.starts_with(prefix))
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl Reader<'_> {
    fn take(&mut self, count: usize) -> &[u8] {
        let end = self
            .offset
            .checked_add(count)
            .expect("corpus offset overflow");
        assert!(end <= self.bytes.len(), "truncated corpus");
        let slice = &self.bytes[self.offset..end];
        self.offset = end;
        slice
    }

    fn u8(&mut self) -> u8 {
        self.take(1)[0]
    }

    fn u32(&mut self) -> usize {
        let bytes: [u8; 4] = self.take(4).try_into().expect("u32 width");
        usize::try_from(u32::from_le_bytes(bytes)).expect("u32 fits usize")
    }
}

fn read_corpus(path: &str) -> Vec<Cell> {
    let bytes = fs::read(path).expect("read P3 B0 corpus");
    let mut reader = Reader {
        bytes: &bytes,
        offset: 0,
    };
    assert_eq!(reader.take(8), MAGIC, "corpus magic");
    let cell_count = reader.u32();
    let mut cells = Vec::with_capacity(cell_count);
    for _ in 0..cell_count {
        let id_len = reader.u32();
        let id = String::from_utf8(reader.take(id_len).to_vec()).expect("ASCII cell id");
        let entry = match reader.u8() {
            0 => Entry::Attempt,
            1 => Entry::Transverse,
            other => panic!("unknown corpus entry {other}"),
        };
        let _contours = reader.u32();
        let _cubics = reader.u32();
        let _lambda = reader.u32();
        let path_count = reader.u32();
        let mut paths = Vec::with_capacity(path_count);
        for _ in 0..path_count {
            let verb_count = reader.u32();
            let verbs = reader.take(verb_count).to_vec();
            let scalar_count = reader.u32();
            let point_bytes = reader
                .take(scalar_count.checked_mul(8).expect("scalar bytes"))
                .to_vec();
            paths.push(CorpusPath { verbs, point_bytes });
        }
        cells.push(Cell { id, entry, paths });
    }
    assert_eq!(reader.offset, bytes.len(), "trailing corpus bytes");
    cells
}

fn env_usize(name: &str) -> usize {
    env::var(name)
        .unwrap_or_else(|_| panic!("{name} is required"))
        .parse()
        .unwrap_or_else(|_| panic!("{name} must be an unsigned integer"))
}

fn nanos(start: Instant) -> u64 {
    u64::try_from(start.elapsed().as_nanos()).expect("duration fits u64")
}

fn clock_quantum() -> u64 {
    let mut smallest = u64::MAX;
    let mut previous = Instant::now();
    for _ in 0..QUANTUM_PROBES {
        let now = Instant::now();
        let step = u64::try_from(now.duration_since(previous).as_nanos()).expect("step fits");
        if step > 0 {
            smallest = smallest.min(step);
        }
        previous = now;
    }
    assert!(smallest != u64::MAX, "no positive clock increment observed");
    smallest
}

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

fn shuffled<T: Copy>(items: &[T], seed: u32) -> Vec<T> {
    let mut output = items.to_vec();
    let mut random = Xorshift32(seed);
    for index in (1..output.len()).rev() {
        // floor(u * (i + 1)) is at most i because u < 1.
        let pick = (random.next() * (index + 1) as f64).floor() as usize;
        output.swap(index, pick);
    }
    output
}

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

fn fnv(mut hash: u64, bytes: &[u8]) -> u64 {
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

/// One attempt through the cell's entry. It succeeds only when a nonempty mesh
/// was published; otherwise it returns the failure code.
fn attempt(
    workspace: &mut CubicFillWorkspace,
    cell: &Cell,
    path: &CorpusPath,
) -> Result<(), String> {
    let result = match cell.entry {
        Entry::Attempt => workspace.attempt(
            path.input(),
            LineFillRule::Nonzero,
            TOPOLOGY_TOLERANCE,
            MAX_FLAT_COMMANDS,
        ),
        Entry::Transverse => workspace.attempt_transverse(
            path.input(),
            LineFillRule::Nonzero,
            TOPOLOGY_TOLERANCE,
            MAX_FLAT_COMMANDS,
        ),
    };
    match result {
        Err(error) => Err(format!("{error:?}")),
        Ok(diagnostics) => match workspace.output() {
            Some(output)
                if !output.rounded.vertices.is_empty() && !output.rounded.indices.is_empty() =>
            {
                Ok(())
            }
            Some(_) => Err("EMPTY_MESH".to_owned()),
            None => Err(format!("NO_MESH(flat_status={})", diagnostics.flat_status)),
        },
    }
}

/// Times one path through the full attempt and folds its published mesh into the
/// checksum. It allocates nothing and returns false for a non-OK result.
fn timed_path(
    workspace: &mut CubicFillWorkspace,
    cell: &Cell,
    path: &CorpusPath,
    hash: &mut u64,
) -> bool {
    let ok = match cell.entry {
        Entry::Attempt => workspace.attempt(
            path.input(),
            LineFillRule::Nonzero,
            TOPOLOGY_TOLERANCE,
            MAX_FLAT_COMMANDS,
        ),
        Entry::Transverse => workspace.attempt_transverse(
            path.input(),
            LineFillRule::Nonzero,
            TOPOLOGY_TOLERANCE,
            MAX_FLAT_COMMANDS,
        ),
    }
    .is_ok();
    let Some(output) = workspace.output().filter(|_| ok) else {
        return false;
    };
    let mesh = output.rounded;
    let mut value = fnv(*hash, &0u32.to_le_bytes());
    let vertices = u32::try_from(mesh.vertices.len()).expect("vertex count fits u32");
    let triangles = u32::try_from(mesh.indices.len() / 3).expect("triangle count fits u32");
    value = fnv(value, &vertices.to_le_bytes());
    value = fnv(value, &triangles.to_le_bytes());
    for vertex in mesh.vertices {
        value = fnv(value, &vertex.x.to_bits().to_le_bytes());
        value = fnv(value, &vertex.y.to_bits().to_le_bytes());
    }
    for index in mesh.indices {
        value = fnv(value, &index.to_le_bytes());
    }
    *hash = value;
    true
}

/// A batch over the first `count` paths; returns (batch ns, checksum) and writes
/// individual path times into `path_ns`.
fn timed_batch(
    workspace: &mut CubicFillWorkspace,
    cell: &Cell,
    count: usize,
    path_ns: &mut Vec<u64>,
) -> (u64, u64) {
    let mut hash = FNV_OFFSET;
    let start = Instant::now();
    for path in &cell.paths[..count] {
        let path_start = Instant::now();
        let ok = timed_path(workspace, cell, path, &mut hash);
        path_ns.push(nanos(path_start));
        assert!(ok, "timed path of {} failed after admission", cell.id);
    }
    (nanos(start), black_box(hash))
}

struct Json(String);

impl Json {
    fn new() -> Self {
        Self(String::new())
    }

    fn raw(&mut self, value: &str) -> &mut Self {
        self.0.push_str(value);
        self
    }

    fn string(&mut self, value: &str) -> &mut Self {
        self.0.push('"');
        for character in value.chars() {
            match character {
                '"' => self.0.push_str("\\\""),
                '\\' => self.0.push_str("\\\\"),
                c if c.is_control() => {
                    let _ = write!(self.0, "\\u{:04x}", u32::from(c));
                }
                c => self.0.push(c),
            }
        }
        self.0.push('"');
        self
    }

    fn key(&mut self, name: &str) -> &mut Self {
        self.string(name).raw(":")
    }

    fn number<T: core::fmt::Display>(&mut self, value: T) -> &mut Self {
        let _ = write!(self.0, "{value}");
        self
    }

    #[cfg_attr(not(p3_b0_diag), allow(dead_code))]
    fn float(&mut self, value: f64) -> &mut Self {
        assert!(value.is_finite(), "nonfinite JSON number");
        let _ = write!(self.0, "{value:?}");
        self
    }

    fn numbers(&mut self, values: &[u64]) -> &mut Self {
        self.raw("[");
        for (index, value) in values.iter().enumerate() {
            if index > 0 {
                self.raw(",");
            }
            self.number(value);
        }
        self.raw("]")
    }

    fn hexes(&mut self, values: &[u64]) -> &mut Self {
        self.raw("[");
        for (index, value) in values.iter().enumerate() {
            if index > 0 {
                self.raw(",");
            }
            self.string(&format!("{value:016x}"));
        }
        self.raw("]")
    }
}

fn write_output(json: &Json) {
    let path = env::var("P3_B0_OUTPUT").expect("P3_B0_OUTPUT is required");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .expect("create exclusive P3 B0 output");
    file.write_all(json.0.as_bytes())
        .expect("write P3 B0 output");
    file.write_all(b"\n").expect("terminate P3 B0 output");
}

/// Admission pass over `count` paths: status, flat command count, mesh size,
/// topology selection and allocations per attempt. Returns whether paths 0-9 (the
/// decision admission) and whether all `count` paths (the linearity set) are OK.
fn admission(
    json: &mut Json,
    workspace: &mut CubicFillWorkspace,
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
        crate::allocation_test_support::start();
        let status = attempt(workspace, cell, path);
        let allocations = crate::allocation_test_support::stop();
        let diagnostics = workspace.diagnostics();
        json.raw("{").key("status");
        match &status {
            Ok(()) => {
                let output = workspace.output().expect("admitted output");
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
            }
            Err(code) => {
                all_ok = false;
                if index < DECISION_PATHS {
                    decision_ok = false;
                }
                json.string(code);
            }
        }
        json.raw(",")
            .key("rounded")
            .raw(if diagnostics.rounded_topology_selected {
                "true"
            } else {
                "false"
            })
            .raw(",")
            .key("transverse")
            .raw(if diagnostics.transverse_topology_selected {
                "true"
            } else {
                "false"
            })
            .raw(",")
            .key("allocations")
            .number(allocations)
            .raw("}");
    }
    json.raw("]}");
    (decision_ok, all_ok)
}

fn decision_cell(json: &mut Json, cell: &Cell, warmup: usize, timed: usize) {
    let construct = Instant::now();
    let mut workspace = CubicFillWorkspace::new(LIMITS).expect("construct B0 workspace");
    let workspace_ns = nanos(construct);
    let mut path_ns = Vec::with_capacity(timed * DECISION_PATHS);
    let mut scratch = Vec::with_capacity(DECISION_PATHS);
    for _ in 0..warmup {
        scratch.clear();
        timed_batch(&mut workspace, cell, DECISION_PATHS, &mut scratch);
    }
    let mut batch_ns = Vec::with_capacity(timed);
    let mut checksums = Vec::with_capacity(timed);
    for _ in 0..timed {
        let (ns, hash) = timed_batch(&mut workspace, cell, DECISION_PATHS, &mut path_ns);
        batch_ns.push(ns);
        checksums.push(hash);
    }
    // One further untimed batch with the allocation counter on.
    scratch.clear();
    crate::allocation_test_support::start();
    timed_batch(&mut workspace, cell, DECISION_PATHS, &mut scratch);
    let batch_allocations = crate::allocation_test_support::stop();
    json.raw("{")
        .key("cell")
        .string(&cell.id)
        .raw(",")
        .key("workspaceNs")
        .number(workspace_ns)
        .raw(",")
        .key("batchAllocations")
        .number(batch_allocations)
        .raw(",")
        .key("batchNs")
        .numbers(&batch_ns)
        .raw(",")
        .key("pathNs")
        .numbers(&path_ns)
        .raw(",")
        .key("checksums")
        .hexes(&checksums)
        .raw("}");
}

#[test]
#[ignore = "P3 B0 decision repetition; run only by pnpm benchmark:p3-b0"]
fn run_decision() {
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
        .key("clockQuantumNs")
        .number(quantum)
        .raw(",");

    let mut workspace = CubicFillWorkspace::new(LIMITS).expect("construct B0 workspace");
    json.key("workspace")
        .raw("{")
        .key("inlineBytes")
        .number(size_of::<CubicFillWorkspace>())
        .raw(",")
        .key("allocatedBytes")
        .number(workspace.allocated_bytes())
        .raw("},");

    json.key("admission").raw("[");
    let mut admitted = Vec::new();
    let mut linearity_ok = false;
    let decision: Vec<&Cell> = cells.iter().filter(|cell| cell.is_decision()).collect();
    for (index, cell) in decision.iter().enumerate() {
        if index > 0 {
            json.raw(",");
        }
        let count = if cell.id == LINEARITY_CELL {
            LINEARITY_PATHS
        } else {
            DECISION_PATHS
        };
        let (decision_ok, all_ok) = admission(&mut json, &mut workspace, cell, count);
        if cell.id == LINEARITY_CELL {
            linearity_ok = all_ok;
        }
        if decision_ok {
            admitted.push(index);
        }
    }
    json.raw("],");

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
    json.raw("],");

    json.key("linearity");
    match decision
        .iter()
        .position(|cell| cell.id == LINEARITY_CELL)
        .filter(|_| linearity_ok)
    {
        None => {
            json.raw("null");
        }
        Some(index) => {
            let cell = decision[index];
            let mut workspace = CubicFillWorkspace::new(LIMITS).expect("construct B0 workspace");
            let mut path_ns =
                Vec::with_capacity((timed + linearity_warmup + linearity_timed) * LINEARITY_PATHS);
            let mut small = Vec::with_capacity(timed);
            let mut small_sums = Vec::with_capacity(timed);
            for _ in 0..timed {
                let (ns, hash) = timed_batch(&mut workspace, cell, DECISION_PATHS, &mut path_ns);
                small.push(ns);
                small_sums.push(hash);
            }
            for _ in 0..linearity_warmup {
                timed_batch(&mut workspace, cell, LINEARITY_PATHS, &mut path_ns);
            }
            let mut large = Vec::with_capacity(linearity_timed);
            let mut large_sums = Vec::with_capacity(linearity_timed);
            for _ in 0..linearity_timed {
                let (ns, hash) = timed_batch(&mut workspace, cell, LINEARITY_PATHS, &mut path_ns);
                large.push(ns);
                large_sums.push(hash);
            }
            json.raw("{")
                .key("cell")
                .string(&cell.id)
                .raw(",")
                .key("batch10Ns")
                .numbers(&small)
                .raw(",")
                .key("checksums10")
                .hexes(&small_sums)
                .raw(",")
                .key("batch100Ns")
                .numbers(&large)
                .raw(",")
                .key("checksums100")
                .hexes(&large_sums)
                .raw("}");
        }
    }
    json.raw("}");
    write_output(&json);
}

#[cfg(not(p3_b0_diag))]
#[test]
#[ignore = "P3 B0 diagnostic run; needs --cfg p3_b0_diag"]
fn run_diagnostic() {
    panic!("the P3 B0 diagnostic run requires a build with --cfg p3_b0_diag");
}

#[cfg(p3_b0_diag)]
#[test]
#[ignore = "P3 B0 diagnostic run; run only by pnpm benchmark:p3-b0"]
fn run_diagnostic() {
    use crate::p3_b0_diag as diag;

    let cells = read_corpus(&env::var("P3_B0_INPUT").expect("P3_B0_INPUT is required"));
    let warmup = env_usize("P3_B0_DIAG_WARMUP");
    let timed = env_usize("P3_B0_DIAG_TIMED");
    let loops = env_usize("P3_B0_REPLAY_LOOPS");
    let calls = env_usize("P3_B0_REPLAY_CALLS");
    let quantum = clock_quantum();
    let mut json = Json::new();
    json.raw("{")
        .key("kind")
        .string("diagnostic")
        .raw(",")
        .key("clockQuantumNs")
        .number(quantum)
        .raw(",");

    let mut workspace = CubicFillWorkspace::new(LIMITS).expect("construct B0 workspace");
    json.key("observations").raw("[");
    let observed: Vec<&Cell> = cells.iter().filter(|cell| !cell.is_decision()).collect();
    for (index, cell) in observed.iter().enumerate() {
        if index > 0 {
            json.raw(",");
        }
        admission(&mut json, &mut workspace, cell, cell.paths.len());
    }
    json.raw("],");

    let primary: Vec<&Cell> = cells.iter().filter(|cell| cell.is_primary()).collect();
    json.key("stages").raw("[");
    for (index, cell) in primary.iter().enumerate() {
        if index > 0 {
            json.raw(",");
        }
        json.raw("{").key("cell").string(&cell.id);
        for (name, stage) in [
            ("s1Ns", diag::STAGE_S1),
            ("s2Ns", diag::STAGE_S2),
            ("s3Ns", diag::STAGE_FULL),
        ] {
            diag::set_stop_stage(stage);
            let mut samples = Vec::with_capacity(timed);
            for round in 0..warmup + timed {
                let mut hash = FNV_OFFSET;
                let start = Instant::now();
                for path in &cell.paths[..DECISION_PATHS] {
                    if stage == diag::STAGE_FULL {
                        assert!(timed_path(&mut workspace, cell, path, &mut hash));
                    } else {
                        black_box(
                            workspace
                                .attempt(
                                    path.input(),
                                    LineFillRule::Nonzero,
                                    TOPOLOGY_TOLERANCE,
                                    MAX_FLAT_COMMANDS,
                                )
                                .expect("stage prefix succeeds"),
                        );
                    }
                }
                let ns = nanos(start);
                black_box(hash);
                if round >= warmup {
                    samples.push(ns);
                }
            }
            json.raw(",").key(name).numbers(&samples);
        }
        diag::set_stop_stage(diag::STAGE_FULL);

        diag::set_counting(true);
        for path in &cell.paths[..DECISION_PATHS] {
            assert!(attempt(&mut workspace, cell, path).is_ok());
        }
        diag::set_counting(false);
        json.raw(",").key("counts").raw("[");
        for (index, ((routine, instance), count)) in diag::take_counts().into_iter().enumerate() {
            if index > 0 {
                json.raw(",");
            }
            json.raw("{")
                .key("routine")
                .string(routine)
                .raw(",")
                .key("instance")
                .string(instance)
                .raw(",")
                .key("calls")
                .number(count)
                .raw("}");
        }
        json.raw("]}");
    }
    json.raw("],");

    let capture_cell = cells
        .iter()
        .find(|cell| cell.id == LINEARITY_CELL)
        .expect("largest P4 cell present");
    diag::set_capturing(true);
    for path in &capture_cell.paths[..DECISION_PATHS] {
        assert!(attempt(&mut workspace, capture_cell, path).is_ok());
    }
    diag::set_capturing(false);
    let replay_means = |replays: &[Box<dyn Fn()>]| -> Vec<f64> {
        (0..loops)
            .map(|_| {
                let start = Instant::now();
                for call in 0..calls {
                    replays[call % replays.len()]();
                }
                nanos(start) as f64 / calls as f64
            })
            .collect()
    };
    let baseline: Vec<Box<dyn Fn()>> = vec![Box::new(|| {
        let _guard = diag::enter("baseline", "", || {});
        black_box(());
    })];
    let baseline_means = replay_means(&baseline);
    json.key("replay")
        .raw("{")
        .key("cell")
        .string(&capture_cell.id)
        .raw(",")
        .key("loops")
        .number(loops)
        .raw(",")
        .key("calls")
        .number(calls)
        .raw(",")
        .key("baselineNs")
        .raw("[");
    for (index, mean) in baseline_means.iter().enumerate() {
        if index > 0 {
            json.raw(",");
        }
        json.float(*mean);
    }
    json.raw("],").key("routines").raw("[");
    for (index, ((routine, instance), replays)) in diag::take_captured().into_iter().enumerate() {
        if index > 0 {
            json.raw(",");
        }
        let means = replay_means(&replays);
        json.raw("{")
            .key("routine")
            .string(routine)
            .raw(",")
            .key("instance")
            .string(instance)
            .raw(",")
            .key("captured")
            .number(replays.len())
            .raw(",")
            .key("meansNs")
            .raw("[");
        for (index, mean) in means.iter().enumerate() {
            if index > 0 {
                json.raw(",");
            }
            json.float(*mean);
        }
        json.raw("]}");
    }
    json.raw("]}}");
    write_output(&json);
}

/// Independent second implementation of the section 2 generator for the two
/// fixture paths. Its bits are committed in tests/geometry/p3-b0/fixtures.json,
/// which the TypeScript generator test also compares against.
mod fixture {
    use core::f64::consts::PI;

    const EDGE: f64 = 8.0;
    const TAU: f64 = 2.0 * PI;

    fn snap(value: f64) -> f64 {
        (value * 1024.0).round_ties_even() / 1024.0
    }

    pub(super) fn ring_path(contours: usize, sides: usize, bulge: f64) -> (Vec<u8>, Vec<f64>) {
        let mut random = super::Xorshift32(0x1234_5678);
        let mut verbs = Vec::new();
        let mut points = Vec::new();
        for contour in 0..contours {
            let rho = TAU * random.next();
            let radius = EDGE / (2.0 * (PI / sides as f64).sin());
            let centre = contour as f64 * (2.0 * (radius + bulge * EDGE) + 4.0);
            let vertices: Vec<[f64; 2]> = (0..sides)
                .map(|index| {
                    let phi = (TAU * index as f64) / sides as f64 + rho;
                    [centre + radius * phi.cos(), radius * phi.sin()]
                })
                .collect();
            let mut cubics: Vec<[[f64; 2]; 4]> = (0..sides)
                .map(|index| {
                    let start = vertices[index];
                    let end = vertices[(index + 1) % sides];
                    let dx = end[0] - start[0];
                    let dy = end[1] - start[1];
                    let length = (dx * dx + dy * dy).sqrt();
                    let (nx, ny) = (dy / length, -dx / length);
                    let offset = bulge * EDGE;
                    [
                        start,
                        [
                            start[0] + dx / 3.0 + offset * nx,
                            start[1] + dy / 3.0 + offset * ny,
                        ],
                        [
                            start[0] + (2.0 * dx) / 3.0 + offset * nx,
                            start[1] + (2.0 * dy) / 3.0 + offset * ny,
                        ],
                        end,
                    ]
                })
                .collect();
            if contour % 2 == 1 {
                cubics.reverse();
                for cubic in &mut cubics {
                    cubic.reverse();
                }
            }
            verbs.push(0);
            points.extend([snap(cubics[0][0][0]), snap(cubics[0][0][1])]);
            for cubic in &cubics {
                verbs.push(2);
                for point in &cubic[1..] {
                    points.extend([snap(point[0]), snap(point[1])]);
                }
            }
            verbs.push(3);
        }
        (verbs, points)
    }
}

fn fixture_bits(source: &str, name: &str) -> (Vec<u8>, Vec<u64>) {
    let start = source.find(&format!("\"{name}\"")).expect("fixture entry");
    let entry = &source[start..];
    let end = entry.find('}').expect("fixture entry end");
    let entry = &entry[..end];
    let list = |key: &str| -> &str {
        let at = entry.find(&format!("\"{key}\"")).expect("fixture key");
        let open = at + entry[at..].find('[').expect("list start");
        let close = open + entry[open..].find(']').expect("list end");
        &entry[open + 1..close]
    };
    let verbs = list("verbs")
        .split(',')
        .map(|value| value.trim().parse().expect("verb byte"))
        .collect();
    let bits = list("bits")
        .split(',')
        .map(|value| u64::from_str_radix(value.trim().trim_matches('"'), 16).expect("bit hex"))
        .collect();
    (verbs, bits)
}

#[test]
fn independent_generator_matches_committed_fixture_bits() {
    let source = include_str!("../../../../tests/geometry/p3-b0/fixtures.json");
    for (name, contours, sides) in [("P4/s=4#0", 1, 4), ("K2/s=3#0", 2, 3)] {
        let (verbs, points) = fixture::ring_path(contours, sides, 3.0 / 16.0);
        let (expected_verbs, expected_bits) = fixture_bits(source, name);
        assert_eq!(verbs, expected_verbs, "{name} verbs");
        let bits: Vec<u64> = points.iter().map(|value| value.to_bits()).collect();
        assert_eq!(bits, expected_bits, "{name} coordinate bits");
    }
}

#[test]
fn order_shuffle_is_a_permutation() {
    let items: Vec<usize> = (0..34).collect();
    let mut order = shuffled(&items, ORDER_SEED);
    order.sort_unstable();
    assert_eq!(order, items);
}
