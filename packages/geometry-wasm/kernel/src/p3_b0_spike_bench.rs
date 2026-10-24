//! P3 B0 spike harness, unit SL-U3 of the frozen contract
//! `docs/plans/p3-b0-spike-ladder-contract.md` (section 5). The ignored tests run only through
//! `pnpm benchmark:p3-b0-spike`; each reads the framed B0 corpus and writes one JSON record:
//!
//! - `run_spike_decision`: one repetition (sections 5.3-5.5): the admission pre-check through
//!   the ladder, the shuffled timed cells and the linearity batches, with B0's sampling and the
//!   ladder checksum of section 5.5 (the status word replaced by the rung).
//! - `run_spike_diagnostic`: the stage stops SL-D1 to SL-D4 of section 5.8, the exact rung alone
//!   as a same-process baseline, and the per-path sweep, clearance and filter counts.
//! - `run_spike_oracle`: the untimed oracle run of section 5.9 over every corpus path. It writes
//!   the dump for the TypeScript oracles SL-O1 to SL-O7, the exact rung's B0 checksums and
//!   outcomes for SL-O4, the corpus-wide S1 accessor equality test of section 2.2 and the
//!   allocation-free ladder check of SL-A7.
//!
//! Test-only (`lib.rs` declares it under `cfg(test)`). It reuses `p3_b0_bench.rs`'s corpus
//! reader, clock-quantum probe, shuffle, FNV and output helpers (section 5.10). Nothing inside a
//! timed batch or a ladder call allocates; failure codes are formatted outside the
//! allocation-counter window (SL-A7).
use core::hint::black_box;
use core::mem::size_of;
use std::env;
use std::fs::OpenOptions;
use std::io::Write as _;
use std::time::Instant;

use crate::cubic_fill::{
    ContourRange, CubicFillDiagnostics, CubicFillError, CubicFillWorkspace, DecodedSource,
    EdgeOwner, MAX_FLAT_COMMANDS,
};
use crate::fill_filter::{self, FilterId};
use crate::geometry::{Point, PATH_OK};
use crate::line_fill::LineFillRule;
use crate::native_cubic_fill_tests::{LIMITS, TOPOLOGY_TOLERANCE};
use crate::p3_b0_bench::{
    clock_quantum, env_usize, fnv, nanos, read_corpus, shuffled, write_output, Cell, CorpusPath,
    Entry, Json, FNV_OFFSET,
};
use crate::p3_b0_spike::{
    ExactEntry, FastRung, LadderOutcome, PrefixFailure, Reason, Rung, SpikeLadder, Stage,
};

const DECISION_PATHS: usize = 10;
const LINEARITY_CELL: &str = "P4/s=16";
const LINEARITY_PATHS: usize = 100;
const ORDER_SEED: u32 = 0x9e37_79b9;
const RULE: LineFillRule = LineFillRule::Nonzero;

fn exact_entry(cell: &Cell) -> ExactEntry {
    match cell.entry {
        Entry::Attempt => ExactEntry::Attempt,
        Entry::Transverse => ExactEntry::Transverse,
    }
}

fn new_ladder() -> Box<SpikeLadder> {
    Box::new(SpikeLadder::new(LIMITS).expect("construct the spike ladder"))
}

/// One path through the ladder with the cell's exact entry (section 2.4).
fn run_ladder(ladder: &mut SpikeLadder, cell: &Cell, path: &CorpusPath) -> LadderOutcome {
    ladder.run(
        path.input(),
        exact_entry(cell),
        RULE,
        TOPOLOGY_TOLERANCE,
        MAX_FLAT_COMMANDS,
    )
}

/// The exact rung alone, as `p3_b0_bench.rs` calls it (section 2.4).
fn run_exact(
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

/// B0's status code of an exact attempt: OK only for a published nonempty mesh, otherwise the
/// failure code exactly as `p3_b0_bench.rs` formats it. Allocates; never inside a counted window.
fn exact_status(
    workspace: &CubicFillWorkspace,
    result: Result<CubicFillDiagnostics, CubicFillError>,
) -> Result<(usize, usize, usize), String> {
    match result {
        Err(error) => Err(format!("{error:?}")),
        Ok(diagnostics) => match workspace.output() {
            Some(output)
                if !output.rounded.vertices.is_empty() && !output.rounded.indices.is_empty() =>
            {
                Ok((
                    output.commands.len(),
                    output.rounded.vertices.len(),
                    output.rounded.indices.len() / 3,
                ))
            }
            Some(_) => Err("EMPTY_MESH".to_owned()),
            None => Err(format!("NO_MESH(flat_status={})", diagnostics.flat_status)),
        },
    }
}

/// The ladder's published mesh size, or the status code of section 5.4 (B0's code list applied
/// to the exact rung's error). Returns (vertices, triangles).
fn ladder_status(ladder: &SpikeLadder, outcome: &LadderOutcome) -> Result<(usize, usize), String> {
    match outcome.rung {
        Rung::Fast => match ladder.fast().mesh() {
            Some((vertices, triangles)) if !vertices.is_empty() && !triangles.is_empty() => {
                Ok((vertices.len(), triangles.len()))
            }
            Some(_) => Err("EMPTY_MESH".to_owned()),
            None => Err("NO_FAST_MESH".to_owned()),
        },
        Rung::Exact => {
            let result = outcome.exact.expect("exact result on fallback");
            exact_status(ladder.exact(), result)
                .map(|(_, vertices, triangles)| (vertices, triangles))
        }
    }
}

/// Folds one published ladder mesh into the batch checksum (section 5.5): B0's FNV-1a 64 fold
/// with the status word replaced by the rung (0 fast, 1 exact) as a u32 LE, then V and T as u32
/// LE, the vertex x and y f64 bits LE and the indices u32 LE. Allocates nothing; false when the
/// ladder published no nonempty mesh.
fn fold_ladder(ladder: &SpikeLadder, outcome: &LadderOutcome, hash: &mut u64) -> bool {
    let mut value = *hash;
    match outcome.rung {
        Rung::Fast => {
            let Some((vertices, triangles)) = ladder.fast().mesh() else {
                return false;
            };
            if vertices.is_empty() || triangles.is_empty() {
                return false;
            }
            value = fnv(value, &0u32.to_le_bytes());
            let count = u32::try_from(vertices.len()).expect("vertex count fits u32");
            value = fnv(value, &count.to_le_bytes());
            let count = u32::try_from(triangles.len()).expect("triangle count fits u32");
            value = fnv(value, &count.to_le_bytes());
            for vertex in vertices {
                value = fnv(value, &vertex.x.to_bits().to_le_bytes());
                value = fnv(value, &vertex.y.to_bits().to_le_bytes());
            }
            for triangle in triangles {
                for index in triangle {
                    value = fnv(value, &index.to_le_bytes());
                }
            }
        }
        Rung::Exact => {
            if !matches!(outcome.exact, Some(Ok(_))) {
                return false;
            }
            let Some(output) = ladder.exact().output() else {
                return false;
            };
            let mesh = output.rounded;
            if mesh.vertices.is_empty() || mesh.indices.is_empty() {
                return false;
            }
            value = fnv(value, &1u32.to_le_bytes());
            fold_mesh(&mut value, mesh.vertices, mesh.indices);
        }
    }
    *hash = value;
    true
}

/// V, T, vertex bits and indices of an exact mesh, as B0's `timed_path` folds them.
fn fold_mesh(value: &mut u64, vertices: &[Point], indices: &[u32]) {
    let count = u32::try_from(vertices.len()).expect("vertex count fits u32");
    *value = fnv(*value, &count.to_le_bytes());
    let count = u32::try_from(indices.len() / 3).expect("triangle count fits u32");
    *value = fnv(*value, &count.to_le_bytes());
    for vertex in vertices {
        *value = fnv(*value, &vertex.x.to_bits().to_le_bytes());
        *value = fnv(*value, &vertex.y.to_bits().to_le_bytes());
    }
    for index in indices {
        *value = fnv(*value, &index.to_le_bytes());
    }
}

/// One timed ladder path, mesh folded into the checksum; false for a non-OK result.
fn timed_path(ladder: &mut SpikeLadder, cell: &Cell, path: &CorpusPath, hash: &mut u64) -> bool {
    let outcome = run_ladder(ladder, cell, path);
    fold_ladder(ladder, &outcome, hash)
}

/// A batch over the first `count` paths; returns (batch ns, checksum) and writes the
/// individual path times into `path_ns` (preallocated by the caller).
fn timed_batch(
    ladder: &mut SpikeLadder,
    cell: &Cell,
    count: usize,
    path_ns: &mut Vec<u64>,
) -> (u64, u64) {
    let mut hash = FNV_OFFSET;
    let start = Instant::now();
    for path in &cell.paths[..count] {
        let path_start = Instant::now();
        let ok = timed_path(ladder, cell, path, &mut hash);
        path_ns.push(nanos(path_start));
        assert!(ok, "timed path of {} failed after admission", cell.id);
    }
    (nanos(start), black_box(hash))
}

fn boolean(value: bool) -> &'static str {
    if value {
        "true"
    } else {
        "false"
    }
}

fn rung_name(rung: Rung) -> &'static str {
    match rung {
        Rung::Fast => "fast",
        Rung::Exact => "exact",
    }
}

/// Admission pre-check over `count` paths (section 5.4): per path the ladder status, the rung,
/// the fallback reason, the flat command count of the S1 prefix (from a separate probe run,
/// outside the counted window), V and T, on fallback the exact rung's topology selection (false
/// on the fast rung), and the allocations counted around the ladder call only. Returns whether
/// paths 0-9 and whether all `count` paths are OK.
fn admission(
    json: &mut Json,
    ladder: &mut SpikeLadder,
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
        crate::allocation_test_support::start();
        let outcome = run_ladder(ladder, cell, path);
        let allocations = crate::allocation_test_support::stop();
        let status = ladder_status(ladder, &outcome);
        let (rounded, transverse) = if outcome.rung == Rung::Exact {
            let diagnostics = ladder.exact().diagnostics();
            (
                diagnostics.rounded_topology_selected,
                diagnostics.transverse_topology_selected,
            )
        } else {
            (false, false)
        };
        let flat = probe
            .prepare_for_spike(path.input(), MAX_FLAT_COMMANDS)
            .ok()
            .map(|view| view.commands.len());
        json.raw("{").key("status");
        match &status {
            Ok(_) => {
                json.string("OK");
            }
            Err(code) => {
                all_ok = false;
                if index < DECISION_PATHS {
                    decision_ok = false;
                }
                json.string(code);
            }
        }
        json.raw(",").key("rung").string(rung_name(outcome.rung));
        json.raw(",").key("reason");
        match outcome.reason {
            Some(reason) => json.string(reason.code()),
            None => json.raw("null"),
        };
        if let Some(flat) = flat {
            json.raw(",").key("flatCommands").number(flat);
        }
        if let Ok((vertices, triangles)) = status {
            json.raw(",")
                .key("vertices")
                .number(vertices)
                .raw(",")
                .key("triangles")
                .number(triangles);
        }
        json.raw(",")
            .key("rounded")
            .raw(boolean(rounded))
            .raw(",")
            .key("transverse")
            .raw(boolean(transverse))
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
    let mut ladder = new_ladder();
    let workspace_ns = nanos(construct);
    let mut path_ns = Vec::with_capacity(timed * DECISION_PATHS);
    let mut scratch = Vec::with_capacity(DECISION_PATHS);
    for _ in 0..warmup {
        scratch.clear();
        timed_batch(&mut ladder, cell, DECISION_PATHS, &mut scratch);
    }
    let mut batch_ns = Vec::with_capacity(timed);
    let mut checksums = Vec::with_capacity(timed);
    for _ in 0..timed {
        let (ns, hash) = timed_batch(&mut ladder, cell, DECISION_PATHS, &mut path_ns);
        batch_ns.push(ns);
        checksums.push(hash);
    }
    // One further untimed batch with the allocation counter on (SL-A7, section 5.10).
    scratch.clear();
    crate::allocation_test_support::start();
    timed_batch(&mut ladder, cell, DECISION_PATHS, &mut scratch);
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
#[ignore = "P3 B0 spike decision repetition; run only by pnpm benchmark:p3-b0-spike"]
fn run_spike_decision() {
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

    // E5: the ladder workspace's inline size and its exact workspace's allocation.
    let mut ladder = new_ladder();
    let mut probe = CubicFillWorkspace::new_pre_b1(LIMITS).expect("construct the prefix probe");
    json.key("workspace")
        .raw("{")
        .key("inlineBytes")
        .number(size_of::<SpikeLadder>())
        .raw(",")
        .key("allocatedBytes")
        .number(ladder.exact().allocated_bytes())
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
        let (decision_ok, all_ok) = admission(&mut json, &mut ladder, &mut probe, cell, count);
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
            let mut ladder = new_ladder();
            let mut path_ns =
                Vec::with_capacity((timed + linearity_warmup + linearity_timed) * LINEARITY_PATHS);
            let mut small = Vec::with_capacity(timed);
            let mut small_sums = Vec::with_capacity(timed);
            for _ in 0..timed {
                let (ns, hash) = timed_batch(&mut ladder, cell, DECISION_PATHS, &mut path_ns);
                small.push(ns);
                small_sums.push(hash);
            }
            for _ in 0..linearity_warmup {
                timed_batch(&mut ladder, cell, LINEARITY_PATHS, &mut path_ns);
            }
            let mut large = Vec::with_capacity(linearity_timed);
            let mut large_sums = Vec::with_capacity(linearity_timed);
            for _ in 0..linearity_timed {
                let (ns, hash) = timed_batch(&mut ladder, cell, LINEARITY_PATHS, &mut path_ns);
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

/// Section 5.8's nested stops of the fast rung alone: SL-D1 the S1 prefix, SL-D2 through FR5
/// (the certificate), SL-D3 through FR6 (classification), SL-D4 through FR8 (the full rung).
const DIAGNOSTIC_STOPS: [(&str, Stage); 4] = [
    ("d1Ns", Stage::S1),
    ("d2Ns", Stage::Fr5),
    ("d3Ns", Stage::Fr6),
    ("d4Ns", Stage::Fr8),
];

/// The fast rung alone up to `stop`: the S1 prefix, the copy into the rung and its stages, as
/// `SpikeLadder::run_until` runs them, but without the exact rung on a fallback.
fn fast_alone(
    prefix: &mut CubicFillWorkspace,
    fast: &mut FastRung,
    path: &CorpusPath,
    stop: Stage,
) -> Result<(), Reason> {
    let input = path.input();
    match prefix.prepare_for_spike(input, MAX_FLAT_COMMANDS) {
        Ok(view) => fast
            .load(view, input.request.tolerance, RULE)
            .and_then(|()| fast.run(stop)),
        Err(_) => Err(Reason::Prefix),
    }
}

/// Filters whose decided and fallback counts the diagnostic run records per path: F1 (the
/// orientation filter of `orient2d`), with F0.2 (its equal-point identity) and F0.3
/// (`segment_relation`'s disjoint-box filter) beside it.
const DIAGNOSTIC_FILTERS: [(&str, FilterId); 3] = [
    ("F0.2", FilterId::PredicateOrientIdentity),
    ("F1", FilterId::PredicateOrient),
    ("F0.3", FilterId::SegmentBoxes),
];

#[test]
#[ignore = "P3 B0 spike diagnostic run; run only by pnpm benchmark:p3-b0-spike"]
fn run_spike_diagnostic() {
    let cells = read_corpus(&env::var("P3_B0_INPUT").expect("P3_B0_INPUT is required"));
    let warmup = env_usize("P3_B0_DIAG_WARMUP");
    let timed = env_usize("P3_B0_DIAG_TIMED");
    let quantum = clock_quantum();
    let mut ladder = new_ladder();
    let mut exact = CubicFillWorkspace::new_pre_b1(LIMITS).expect("construct the exact workspace");
    // The fast rung alone (section 5.8): its own prefix workspace and rung, no exact rung on a
    // fallback, so a stage stop never includes exact-rung time.
    let mut prefix =
        CubicFillWorkspace::new_pre_b1(LIMITS).expect("construct the prefix workspace");
    let mut fast = Box::new(FastRung::new());
    let mut json = Json::new();
    json.raw("{")
        .key("kind")
        .string("diagnostic")
        .raw(",")
        .key("clockQuantumNs")
        .number(quantum)
        .raw(",")
        .key("stages")
        .raw("[");
    let primary: Vec<&Cell> = cells.iter().filter(|cell| cell.is_primary()).collect();
    for (index, cell) in primary.iter().enumerate() {
        if index > 0 {
            json.raw(",");
        }
        json.raw("{").key("cell").string(&cell.id);
        let paths = &cell.paths[..DECISION_PATHS];
        let mut fallbacks = [0usize; DIAGNOSTIC_STOPS.len()];
        for (slot, (name, stop)) in DIAGNOSTIC_STOPS.iter().enumerate() {
            let mut samples = Vec::with_capacity(timed);
            for round in 0..warmup + timed {
                let start = Instant::now();
                for path in paths {
                    let outcome = fast_alone(&mut prefix, &mut fast, path, *stop);
                    if round == 0 && outcome.is_err() {
                        fallbacks[slot] += 1;
                    }
                    let _ = black_box(outcome);
                }
                let ns = nanos(start);
                if round >= warmup {
                    samples.push(ns);
                }
            }
            json.raw(",").key(name).numbers(&samples);
        }
        // The exact rung alone on the same paths, as a same-process baseline.
        let mut samples = Vec::with_capacity(timed);
        for round in 0..warmup + timed {
            let start = Instant::now();
            for path in paths {
                black_box(run_exact(&mut exact, cell, path).is_ok());
            }
            let ns = nanos(start);
            if round >= warmup {
                samples.push(ns);
            }
        }
        json.raw(",").key("exactNs").numbers(&samples);
        json.raw(",").key("fallbacks").raw("{");
        for (slot, (name, _)) in DIAGNOSTIC_STOPS.iter().enumerate() {
            if slot > 0 {
                json.raw(",");
            }
            json.key(name).number(fallbacks[slot]);
        }
        json.raw("}");
        // Per-path counts of one full ladder call each.
        json.raw(",").key("counts").raw("[");
        for (path_index, path) in paths.iter().enumerate() {
            if path_index > 0 {
                json.raw(",");
            }
            fill_filter::reset_counters();
            let outcome = run_ladder(&mut ladder, cell, path);
            let stats = ladder.fast().stats();
            json.raw("{")
                .key("rung")
                .string(rung_name(outcome.rung))
                .raw(",")
                .key("sweepCandidates")
                .number(stats.sweep_candidates)
                .raw(",")
                .key("clearanceStep2")
                .number(stats.clearance_step2)
                .raw(",")
                .key("clearanceStep3")
                .number(stats.clearance_step3)
                .raw(",")
                .key("diagonals")
                .number(stats.diagonals)
                .raw(",")
                .key("filters")
                .raw("[");
            for (filter_index, (name, id)) in DIAGNOSTIC_FILTERS.iter().enumerate() {
                if filter_index > 0 {
                    json.raw(",");
                }
                let (decided, fallback) = fill_filter::counts(*id);
                json.raw("{")
                    .key("filter")
                    .string(name)
                    .raw(",")
                    .key("decided")
                    .number(decided)
                    .raw(",")
                    .key("fallback")
                    .number(fallback)
                    .raw("}");
            }
            json.raw("]}");
        }
        json.raw("]}");
    }
    json.raw("]}");
    write_output(&json);
}

// ------------------------------------------------------------------------------------------
// The oracle run (section 5.9).

fn hex(json: &mut Json, value: f64) {
    json.string(&format!("{:016x}", value.to_bits()));
}

fn json_points(json: &mut Json, points: &[Point]) {
    json.raw("[");
    for (index, point) in points.iter().enumerate() {
        if index > 0 {
            json.raw(",");
        }
        json.raw("[");
        hex(json, point.x);
        json.raw(",");
        hex(json, point.y);
        json.raw("]");
    }
    json.raw("]");
}

/// The S1 view fields in the schema of the SL-U2 hand-off (`p3-b0-spike-fixtures/1`), so that
/// the TypeScript oracles read them unchanged.
fn json_view(
    json: &mut Json,
    ranges: &[ContourRange],
    points: &[Point],
    owners: &[EdgeOwner],
    sources: &[DecodedSource],
) {
    json.raw("{").key("ranges").raw("[");
    for (index, range) in ranges.iter().enumerate() {
        if index > 0 {
            json.raw(",");
        }
        json.raw("[")
            .number(range.start)
            .raw(",")
            .number(range.count)
            .raw("]");
    }
    json.raw("],").key("points");
    json_points(json, points);
    json.raw(",").key("owners").raw("[");
    for (index, owner) in owners.iter().enumerate() {
        if index > 0 {
            json.raw(",");
        }
        match *owner {
            EdgeOwner::Line { source_verb } => {
                json.raw("{")
                    .key("kind")
                    .string("line")
                    .raw(",")
                    .key("sourceVerb")
                    .number(source_verb)
                    .raw("}");
            }
            EdgeOwner::CubicLeaf {
                source_verb,
                end_numerator,
                depth,
            } => {
                json.raw("{")
                    .key("kind")
                    .string("cubicLeaf")
                    .raw(",")
                    .key("sourceVerb")
                    .number(source_verb)
                    .raw(",")
                    .key("endNumerator")
                    .number(end_numerator)
                    .raw(",")
                    .key("depth")
                    .number(depth)
                    .raw("}");
            }
            EdgeOwner::ImplicitClosure { contour } => {
                json.raw("{")
                    .key("kind")
                    .string("implicitClosure")
                    .raw(",")
                    .key("contour")
                    .number(contour)
                    .raw("}");
            }
            EdgeOwner::ExplicitClose { source_verb } => {
                json.raw("{")
                    .key("kind")
                    .string("explicitClose")
                    .raw(",")
                    .key("sourceVerb")
                    .number(source_verb)
                    .raw("}");
            }
        }
    }
    json.raw("],").key("sources").raw("[");
    for (index, source) in sources.iter().enumerate() {
        if index > 0 {
            json.raw(",");
        }
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
        json.raw("{")
            .key("kind")
            .string(kind)
            .raw(",")
            .key("sourceVerb")
            .number(source_verb)
            .raw(",")
            .key("contour")
            .number(contour)
            .raw(",")
            .key("points");
        json_points(json, points);
        json.raw("}");
    }
    json.raw("]}");
}

fn json_mesh(json: &mut Json, vertices: &[Point], triangles: impl Iterator<Item = [u32; 3]>) {
    json.raw("{").key("vertices");
    json_points(json, vertices);
    json.raw(",").key("triangles").raw("[");
    for (index, [a, b, c]) in triangles.enumerate() {
        if index > 0 {
            json.raw(",");
        }
        json.raw("[")
            .number(a)
            .raw(",")
            .number(b)
            .raw(",")
            .number(c)
            .raw("]");
    }
    json.raw("]}");
}

type PublishedView = (Vec<ContourRange>, Vec<u64>, Vec<EdgeOwner>);

fn owned_view(ranges: &[ContourRange], points: &[Point], owners: &[EdgeOwner]) -> PublishedView {
    (
        ranges.to_vec(),
        points
            .iter()
            .flat_map(|point| [point.x.to_bits(), point.y.to_bits()])
            .collect(),
        owners.to_vec(),
    )
}

/// Section 2.2's S1 accessor equality, corpus-wide: on a path whose exact attempt published,
/// the accessor's points, ranges and owners equal the output's bit for bit; otherwise the
/// accessor succeeds (a failure after S1) or fails exactly as the attempt did in its prefix.
fn accessor_matches(
    probe: &mut CubicFillWorkspace,
    path: &CorpusPath,
    published: Option<&PublishedView>,
    result: Result<CubicFillDiagnostics, CubicFillError>,
    diagnostics: CubicFillDiagnostics,
) -> bool {
    // Since E8-U2 (2026-10-24) a published exact attempt carries the canonical source-final
    // knots; it then equals the production exact prefix, and the spike accessor equals the
    // production fast prefix (E8 addendum E8.4: the fast rung's prefix is unchanged).
    if let Some((ranges, points, owners)) = published {
        let exact = probe
            .prepare_exact_prefix(path.input(), MAX_FLAT_COMMANDS)
            .ok()
            .map(|view| owned_view(view.ranges, view.points, view.owners));
        if exact.as_ref() == Some(&(ranges.clone(), points.clone(), owners.clone())) {
            // The spike accessor reports a prefix failure as its own enum; compare by Debug text.
            let fast = probe
                .prepare_prefix(path.input(), MAX_FLAT_COMMANDS)
                .map(|view| owned_view(view.ranges, view.points, view.owners))
                .map_err(|failure| format!("{failure:?}"));
            let accessor = probe
                .prepare_for_spike(path.input(), MAX_FLAT_COMMANDS)
                .map(|view| owned_view(view.ranges, view.points, view.owners))
                .map_err(|failure| format!("{failure:?}"));
            return fast == accessor;
        }
    }
    let accessor = probe.prepare_for_spike(path.input(), MAX_FLAT_COMMANDS);
    match (published, accessor) {
        (Some((ranges, points, owners)), Ok(view)) => {
            view.ranges == ranges.as_slice()
                && view.owners == owners.as_slice()
                && view.points.len() * 2 == points.len()
                && view
                    .points
                    .iter()
                    .flat_map(|point| [point.x.to_bits(), point.y.to_bits()])
                    .eq(points.iter().copied())
        }
        (Some(_), Err(_)) => false,
        // The prefix succeeded, so the attempt must have got past S1: an Ok sizing status, or
        // a failure after `validate_leaf_partitions` (topology or rounded fill invoked).
        (None, Ok(_)) => match result {
            Ok(outcome) => outcome.flat_status == PATH_OK,
            Err(_) => diagnostics.topology_invoked || diagnostics.rounded_invoked,
        },
        (None, Err(PrefixFailure::Error(error))) => result == Err(error),
        (None, Err(PrefixFailure::Sizing(status))) => {
            status != PATH_OK && result.is_ok_and(|diagnostics| diagnostics.flat_status == status)
        }
    }
}

fn write_dump(text: &str) {
    let path = env::var("P3_B0_SPIKE_DUMP").expect("P3_B0_SPIKE_DUMP is required");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .expect("create the exclusive spike oracle dump");
    file.write_all(text.as_bytes())
        .expect("write the spike oracle dump");
    file.write_all(b"\n")
        .expect("terminate the spike oracle dump");
}

/// The untimed oracle run of section 5.9 over every corpus path (the list of section 4 is the
/// whole corpus: paths 0-9 of every decision cell, 0-99 of P4/s=16, 0-29 of every O1 cell and
/// every X path). Per path it runs the ladder (allocation counter on around the call only,
/// SL-A7), the exact rung alone in a separate workspace (SL-O3, SL-O4) and the S1 accessor
/// check (section 2.2), and dumps the view, both meshes, the rung, the reason and the certified
/// deviation for the TypeScript oracles.
#[test]
#[ignore = "P3 B0 spike oracle run; run only by pnpm benchmark:p3-b0-spike"]
fn run_spike_oracle() {
    let cells = read_corpus(&env::var("P3_B0_INPUT").expect("P3_B0_INPUT is required"));
    let mut ladder = new_ladder();
    let mut exact = CubicFillWorkspace::new_pre_b1(LIMITS).expect("construct the exact workspace");
    let mut probe = CubicFillWorkspace::new_pre_b1(LIMITS).expect("construct the prefix probe");
    let mut dump = Json::new();
    dump.raw("{")
        .key("schema")
        .string("p3-b0-spike-dump/1")
        .raw(",")
        .key("paths")
        .raw("[");
    let mut ladder_calls = 0usize;
    let mut allocating = Vec::new();
    let mut accessor_published = 0usize;
    let mut accessor_other = 0usize;
    let mut accessor_failures = Vec::new();
    let mut checksums = Json::new();
    checksums.raw("[");
    let mut first_path = true;
    let mut first_checksum = true;
    for cell in &cells {
        let mut exact_hash = FNV_OFFSET;
        let mut exact_hash_ok = true;
        for (index, path) in cell.paths.iter().enumerate() {
            let name = format!("{}#{index}", cell.id);
            crate::allocation_test_support::start();
            let outcome = run_ladder(&mut ladder, cell, path);
            let allocations = crate::allocation_test_support::stop();
            ladder_calls += 1;
            if allocations != 0 {
                allocating.push(name.clone());
            }
            let status = ladder_status(&ladder, &outcome);
            if !first_path {
                dump.raw(",");
            }
            first_path = false;
            dump.raw("{")
                .key("cell")
                .string(&cell.id)
                .raw(",")
                .key("path")
                .number(index)
                .raw(",")
                .key("rung")
                .string(rung_name(outcome.rung))
                .raw(",")
                .key("reason");
            match outcome.reason {
                Some(reason) => dump.string(reason.code()),
                None => dump.raw("null"),
            };
            dump.raw(",").key("ladderStatus");
            match &status {
                Ok(_) => dump.string("OK"),
                Err(code) => dump.string(code),
            };
            dump.raw(",").key("allocations").number(allocations);
            dump.raw(",").key("fastMesh");
            match (outcome.rung, ladder.fast().mesh()) {
                (Rung::Fast, Some((vertices, triangles))) => {
                    json_mesh(&mut dump, vertices, triangles.iter().copied());
                    dump.raw(",").key("maxDeviationSquared");
                    hex(&mut dump, ladder.fast().stats().max_deviation_squared);
                }
                _ => {
                    dump.raw("null,").key("maxDeviationSquared").raw("null");
                }
            }

            // The exact rung alone, untimed, in its own workspace.
            let result = run_exact(&mut exact, cell, path);
            let diagnostics = exact.diagnostics();
            let exact_code = exact_status(&exact, result);
            let published: Option<PublishedView> = exact.output().map(|output| {
                (
                    output.ranges.to_vec(),
                    output
                        .points
                        .iter()
                        .flat_map(|point| [point.x.to_bits(), point.y.to_bits()])
                        .collect(),
                    output.owners.to_vec(),
                )
            });
            // B0's 100-path linearity batch of P4/s=16, folded in path order (SL-O4).
            if cell.id == LINEARITY_CELL && index < LINEARITY_PATHS {
                match exact.output() {
                    Some(output) if exact_code.is_ok() => {
                        exact_hash = fnv(exact_hash, &0u32.to_le_bytes());
                        fold_mesh(
                            &mut exact_hash,
                            output.rounded.vertices,
                            output.rounded.indices,
                        );
                    }
                    _ => exact_hash_ok = false,
                }
            }
            dump.raw(",").key("exact").raw("{").key("status");
            match &exact_code {
                Ok(_) => dump.string("OK"),
                Err(code) => dump.string(code),
            };
            if let Ok((flat, vertices, triangles)) = exact_code {
                dump.raw(",")
                    .key("flatCommands")
                    .number(flat)
                    .raw(",")
                    .key("vertices")
                    .number(vertices)
                    .raw(",")
                    .key("triangles")
                    .number(triangles);
            }
            dump.raw(",")
                .key("rounded")
                .raw(boolean(diagnostics.rounded_topology_selected))
                .raw(",")
                .key("transverse")
                .raw(boolean(diagnostics.transverse_topology_selected))
                .raw(",")
                .key("published");
            match exact.output() {
                Some(output) => {
                    json_view(
                        &mut dump,
                        output.ranges,
                        output.points,
                        output.owners,
                        output.sources,
                    );
                    dump.raw(",").key("mesh");
                    json_mesh(
                        &mut dump,
                        output.rounded.vertices,
                        output
                            .rounded
                            .indices
                            .chunks(3)
                            .map(|chunk| [chunk[0], chunk[1], chunk[2]]),
                    );
                }
                None => {
                    dump.raw("null,").key("mesh").raw("null");
                }
            }
            dump.raw("}");

            // The S1 view, and the corpus-wide accessor equality (section 2.2).
            if accessor_matches(&mut probe, path, published.as_ref(), result, diagnostics) {
                if published.is_some() {
                    accessor_published += 1;
                } else {
                    accessor_other += 1;
                }
            } else {
                accessor_failures.push(name);
            }
            dump.raw(",").key("view");
            match probe.prepare_for_spike(path.input(), MAX_FLAT_COMMANDS) {
                Ok(view) => {
                    json_view(
                        &mut dump,
                        view.ranges,
                        view.points,
                        view.owners,
                        view.sources,
                    );
                    dump.raw(",")
                        .key("flatCommands")
                        .number(view.commands.len());
                }
                Err(failure) => {
                    dump.raw("null,")
                        .key("prefixFailure")
                        .string(&format!("{failure:?}"));
                }
            }
            dump.raw("}");
        }
        if cell.is_decision() {
            if !first_checksum {
                checksums.raw(",");
            }
            first_checksum = false;
            let count = if cell.id == LINEARITY_CELL {
                LINEARITY_PATHS
            } else {
                DECISION_PATHS
            };
            // Paths 0-9 (B0's batch); for P4/s=16 also paths 0-99 (B0's linearity batch).
            let mut hash10 = FNV_OFFSET;
            let mut ok10 = true;
            let mut workspace = CubicFillWorkspace::new_pre_b1(LIMITS).expect("checksum workspace");
            for path in &cell.paths[..DECISION_PATHS] {
                ok10 &= fold_exact_path(&mut workspace, cell, path, &mut hash10);
            }
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
            if count == LINEARITY_PATHS {
                checksums.raw(",").key("checksum100");
                if exact_hash_ok {
                    checksums.string(&format!("{exact_hash:016x}"));
                } else {
                    checksums.raw("null");
                }
            }
            checksums.raw("}");
        }
    }
    dump.raw("]}");
    checksums.raw("]");
    write_dump(&dump.0);

    let mut json = Json::new();
    json.raw("{")
        .key("kind")
        .string("oracle")
        .raw(",")
        .key("ladderCalls")
        .number(ladder_calls)
        .raw(",")
        .key("allocatingCalls")
        .raw("[");
    for (index, name) in allocating.iter().enumerate() {
        if index > 0 {
            json.raw(",");
        }
        json.string(name);
    }
    json.raw("],")
        .key("s1Accessor")
        .raw("{")
        .key("published")
        .number(accessor_published)
        .raw(",")
        .key("other")
        .number(accessor_other)
        .raw(",")
        .key("failures")
        .raw("[");
    for (index, name) in accessor_failures.iter().enumerate() {
        if index > 0 {
            json.raw(",");
        }
        json.string(name);
    }
    json.raw("]},")
        .key("exactChecksums")
        .raw(&checksums.0)
        .raw("}");
    write_output(&json);
}

/// One exact-rung path folded with B0's own checksum definition (status word 0), for SL-O4.
fn fold_exact_path(
    workspace: &mut CubicFillWorkspace,
    cell: &Cell,
    path: &CorpusPath,
    hash: &mut u64,
) -> bool {
    let ok = run_exact(workspace, cell, path).is_ok();
    let Some(output) = workspace.output().filter(|_| ok) else {
        return false;
    };
    *hash = fnv(*hash, &0u32.to_le_bytes());
    fold_mesh(hash, output.rounded.vertices, output.rounded.indices);
    true
}
