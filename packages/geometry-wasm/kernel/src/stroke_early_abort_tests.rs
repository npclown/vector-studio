//! P3 rendering-track item E1, unit ST-U10 (`docs/plans/p3-b2-stroke-contract.md`, the ST-U9
//! addendum E1.3 to E1.5): the native fixtures E1-F1 to E1-F8 of the E1-K1 early abort, with
//! the literal expectations the addendum fixes, and the ignored on-off differential and
//! `max_work` sweep over the corpus E1-C1 (`tooling/p3-stroke-e1-corpus.mjs c1`).
//!
//! E1-K1 runs only in the stroke arrangement (`RoundedFillWorkspace::new_stroke`). The
//! `cfg(test)` switch `with_early_abort_disabled` gives the "off" side of the differential;
//! the probe (`take_early_abort_probe`) counts each run that reaches E1-K1, each abort ("E1-K1
//! fired"), each guard block, and each span loop that completes with the forecast exactness
//! assertion (E1.4 item 3), which is a kernel `assert_eq!` in test builds.
//!
//! The ignored sweep runs by hand, in the release profile:
//!
//! ```text
//! node tooling/p3-stroke-e1-corpus.mjs c1 <e1-c1.txt>
//! P3_E1_CORPUS=<e1-c1.txt> cargo test --release --lib e1_ -- --ignored --nocapture
//! ```

use std::env;

use crate::geometry::{VERB_LINE, VERB_MOVE};
use crate::rounded_line_fill::{
    take_early_abort_probe, with_early_abort_disabled, EarlyAbortProbe, RoundedFillError,
    RoundedFillLimits, RoundedFillStats,
};
use crate::stroke_cubic_tests::WIDE_TEST_LIMITS;
use crate::stroke_outline::{
    StrokeCap, StrokeError, StrokeJoin, StrokeOutcome, StrokeRequest, StrokeWorkspace,
    STROKE_PATH_UNSUPPORTED_GEOMETRY, STROKE_PATH_WORK_LIMIT, STROKE_V0_LIMITS,
};
use crate::stroke_outline_tests::{f26_cases, request, PathSpec};

/// `edges-1024` at E1-K1 (ST-U9 addendum E1.1 and E1.5).
const EDGES_1024_W: u64 = 1_531_479;
const EDGES_1024_F_L: u64 = 122_461_184;
const EDGES_1024_TOTAL: u64 = 123_993_047;
const EDGES_1024_CELLS: usize = 192;
/// 640 nodes in 4 columns: `S = 640 - 4`.
const EDGES_1024_SPANS: usize = 636;
const EDGES_1024_VERTICAL: usize = 640;
/// The full run's boundaries at `max_work = W + F_L - 1` (E1-F3).
const EDGES_1024_OFF_BOUNDARIES: usize = 511;

/// A mesh as vertex bits, triangle indices and boundary pairs.
type MeshBits = (Vec<u64>, Vec<u32>, Vec<[u32; 2]>);

/// One build's observable result: outcome, cause, arrangement stats, mesh bits and probe.
#[derive(Clone, Debug, PartialEq)]
struct Observation {
    /// The per-path status (0 for `ok`), or `None` for a batch `internal-error`.
    status: Option<u32>,
    error: Option<StrokeError>,
    /// `None` when the arrangement did not run.
    stats: Option<RoundedFillStats>,
    mesh: Option<MeshBits>,
    probe: EarlyAbortProbe,
}

fn observe(
    workspace: &mut StrokeWorkspace,
    verbs: &[u8],
    bytes: &[u8],
    request: StrokeRequest,
    off: bool,
) -> Observation {
    take_early_abort_probe();
    let outcome = if off {
        with_early_abort_disabled(|| workspace.build(request, verbs, bytes))
    } else {
        workspace.build(request, verbs, bytes)
    };
    let probe = take_early_abort_probe();
    let status = outcome.ok().map(|outcome| match outcome {
        StrokeOutcome::Mesh => 0,
        StrokeOutcome::Status(status) => status,
    });
    let mesh = (status == Some(0)).then(|| {
        let (vertices, triangles, boundary) = workspace.mesh().expect("an ok mesh");
        (
            vertices
                .iter()
                .flat_map(|point| [point.x.to_bits(), point.y.to_bits()])
                .collect(),
            triangles.to_vec(),
            boundary.to_vec(),
        )
    });
    Observation {
        status,
        error: workspace.last_error(),
        stats: workspace
            .last_tau()
            .is_some()
            .then(|| workspace.rounded_stats()),
        mesh,
        probe,
    }
}

fn observe_path(
    workspace: &mut StrokeWorkspace,
    path: &PathSpec,
    request: StrokeRequest,
    off: bool,
) -> Observation {
    observe(workspace, &path.verbs, &path.bytes(), request, off)
}

/// A workspace on the `stroke-v0+r4` arrangement input (no E2-K1 seam merge). The E1 fixtures
/// and E1-C1 were fixed on that input, and E1-K1 is a property of the arrangement, so since D9
/// E2 unit E2-U1 they run on it through the A/B switch `unmerged`.
fn with_limits(limits: RoundedFillLimits) -> StrokeWorkspace {
    let mut workspace = StrokeWorkspace::with_limits(limits).expect("the test workspace reserves");
    workspace.defects_mut().unmerged = true;
    workspace
}

fn limits_with_work(max_work: u64) -> RoundedFillLimits {
    RoundedFillLimits {
        max_work,
        ..STROKE_V0_LIMITS
    }
}

/// E1.4 item 2: on and off give equal outcomes, causes, meshes and stats, except
/// `boundaries` and `contributors` on a run that E1-K1 aborted. An abort must leave
/// `WorkLimit` with `work_units = max_work`, which the off run must also reach.
fn assert_on_off_equal(on: &Observation, off: &Observation, max_work: u64, label: &str) {
    assert_eq!(on.status, off.status, "{label}: status");
    assert_eq!(on.error, off.error, "{label}: cause");
    assert_eq!(on.mesh, off.mesh, "{label}: mesh");
    assert_eq!(off.probe.fired, 0, "{label}: the off run never aborts");
    assert_eq!(on.probe.reached, off.probe.reached, "{label}: reached");
    assert_eq!(
        on.probe.fired, off.probe.certain,
        "{label}: fired = certain"
    );
    assert_eq!(on.probe.blocked, off.probe.blocked, "{label}: blocked");
    if on.probe.fired > 0 {
        assert_eq!(
            on.error,
            Some(StrokeError::Rounded(RoundedFillError::WorkLimit)),
            "{label}: an abort is WorkLimit"
        );
        assert_eq!(on.probe.span_loops, 0, "{label}: no span-loop charge");
        let mut on_stats = on.stats.expect("the arrangement ran");
        let off_stats = off.stats.expect("the arrangement ran");
        assert_eq!(on_stats.work_units, max_work, "{label}: work_units");
        assert_eq!(on_stats.boundaries, on.probe.last.boundaries, "{label}");
        assert_eq!(on_stats.contributors, on.probe.last.contributors, "{label}");
        on_stats.boundaries = off_stats.boundaries;
        on_stats.contributors = off_stats.contributors;
        assert_eq!(on_stats, off_stats, "{label}: stats");
    } else {
        assert_eq!(on.stats, off.stats, "{label}: stats");
        assert_eq!(on.probe, off.probe, "{label}: probe");
    }
}

fn on_off(
    workspace: &mut StrokeWorkspace,
    path: &PathSpec,
    request: StrokeRequest,
    max_work: u64,
    label: &str,
) -> (Observation, Observation) {
    let on = observe_path(workspace, path, request, false);
    let off = observe_path(workspace, path, request, true);
    assert_on_off_equal(&on, &off, max_work, label);
    (on, off)
}

fn edges_1024() -> (PathSpec, StrokeRequest) {
    let (_, path, request, _) = f26_cases()
        .into_iter()
        .find(|case| case.0 == "edges-1024")
        .expect("ST-F26 edges-1024");
    (path, request)
}

fn work_limit() -> Option<StrokeError> {
    Some(StrokeError::Rounded(RoundedFillError::WorkLimit))
}

fn assert_edges_1024_record(observation: &Observation, label: &str) {
    let record = observation.probe.last;
    assert_eq!(observation.probe.reached, 1, "{label}: reached");
    assert_eq!(record.work, EDGES_1024_W, "{label}: W");
    assert_eq!(record.forecast, EDGES_1024_F_L, "{label}: F_L");
    assert_eq!(record.edges, 1_024, "{label}: E");
    assert_eq!(record.cells, EDGES_1024_CELLS, "{label}: cells");
    assert_eq!(
        record.boundaries,
        2 * EDGES_1024_CELLS,
        "{label}: boundaries"
    );
    assert_eq!(record.contributors, 384, "{label}: contributors at E1-K1");
    assert_eq!(record.spans, EDGES_1024_SPANS, "{label}: S");
    assert_eq!(
        record.vertical_contributors,
        Some(EDGES_1024_VERTICAL),
        "{label}: vertical sum"
    );
}

/// E1-F1 and E1-A4: `edges-1024` at `STROKE_V0_LIMITS` aborts at E1-K1 with no span-loop
/// charge.
#[test]
fn e1_f1_edges_1024_aborts_at_k1() {
    let (path, request) = edges_1024();
    let mut ws = with_limits(STROKE_V0_LIMITS);
    let on = observe_path(&mut ws, &path, request, false);
    assert_eq!(on.status, Some(STROKE_PATH_WORK_LIMIT));
    assert_eq!(on.error, work_limit());
    let stats = on.stats.expect("the arrangement ran");
    assert_eq!(stats.work_units, STROKE_V0_LIMITS.max_work);
    assert_eq!(stats.cells, EDGES_1024_CELLS);
    assert_eq!(stats.boundaries, 2 * EDGES_1024_CELLS);
    assert_eq!(stats.boundaries, 384);
    assert_eq!(stats.contributors, 384);
    assert_eq!(on.probe.fired, 1, "E1-K1 fired");
    assert_eq!(on.probe.span_loops, 0, "E1-A4: the ledger makes no charge");
    assert_eq!(on.probe.exact_checks, 0);
    assert_edges_1024_record(&on, "E1-F1");
    // The production workspace aborts the same way.
    let mut production = StrokeWorkspace::new().expect("the stroke workspace reserves");
    production.defects_mut().unmerged = true;
    assert_eq!(observe_path(&mut production, &path, request, false), on);
    let off = observe_path(&mut ws, &path, request, true);
    assert_on_off_equal(&on, &off, STROKE_V0_LIMITS.max_work, "E1-F1");
}

/// E1-F2: under `WIDE_TEST_LIMITS` `edges-1024` is `ok`, E1-K1 does not fire, and the mesh is
/// bit-identical to the switch-off run.
#[test]
fn e1_f2_edges_1024_wide_is_ok_and_identical() {
    let (path, request) = edges_1024();
    let mut ws = with_limits(WIDE_TEST_LIMITS);
    let (on, off) = on_off(&mut ws, &path, request, WIDE_TEST_LIMITS.max_work, "E1-F2");
    assert_eq!(on.status, Some(0));
    assert!(on.mesh.is_some());
    assert_eq!(on.mesh, off.mesh);
    assert_eq!(on.probe.fired, 0);
    assert_eq!(on.probe.certain, 0);
    assert_eq!(on.probe.span_loops, 1);
    assert_eq!(on.probe.exact_checks, 1, "E1.4 item 3 ran");
    assert_eq!(
        on.stats.expect("the arrangement ran").work_units,
        EDGES_1024_TOTAL
    );
    assert_edges_1024_record(&on, "E1-F2");
}

/// E1-F3: the boundary trio, as literals.
#[test]
fn e1_f3_edges_1024_boundary_trio() {
    let (path, request) = edges_1024();
    assert_eq!(EDGES_1024_W + EDGES_1024_F_L - 1, 123_992_662);

    // W + F_L - 1: E1-K1 fires; the switch-off run also gives WorkLimit, with 511 boundaries.
    let max_work = 123_992_662;
    let mut ws = with_limits(limits_with_work(max_work));
    let (on, off) = on_off(&mut ws, &path, request, max_work, "E1-F3 W+F_L-1");
    assert_eq!(on.status, Some(STROKE_PATH_WORK_LIMIT));
    assert_eq!(on.error, work_limit());
    assert_eq!(on.probe.fired, 1, "E1-K1 fired");
    assert_eq!(on.stats.unwrap().work_units, max_work);
    assert_eq!(off.error, work_limit());
    let off_stats = off.stats.unwrap();
    assert_eq!(off_stats.work_units, max_work);
    assert_eq!(off_stats.boundaries, EDGES_1024_OFF_BOUNDARIES);
    assert_eq!(off.probe.exact_checks, 0, "the span loop fails");

    // W + F_L: E1-K1 does not fire; the run fails with WorkLimit in build_mesh.
    let max_work = 123_992_663;
    let mut ws = with_limits(limits_with_work(max_work));
    let (on, off) = on_off(&mut ws, &path, request, max_work, "E1-F3 W+F_L");
    assert_eq!(on.status, Some(STROKE_PATH_WORK_LIMIT));
    assert_eq!(on.error, work_limit());
    assert_eq!(on.probe.fired, 0, "E1-K1 did not fire");
    assert_eq!(on.probe.certain, 0);
    assert_eq!(on.probe.span_loops, 1);
    assert_eq!(on.probe.exact_checks, 1, "the span loop completed");
    assert_eq!(on.stats.unwrap().work_units, max_work);
    assert_eq!(off.stats.unwrap().work_units, max_work);

    // The run's total charges: ok.
    let max_work = EDGES_1024_TOTAL;
    let mut ws = with_limits(limits_with_work(max_work));
    let (on, _) = on_off(&mut ws, &path, request, max_work, "E1-F3 total");
    assert_eq!(on.status, Some(0));
    assert_eq!(on.probe.fired, 0);
    assert_eq!(on.stats.unwrap().work_units, max_work);
}

/// E1-F4: the bounds guard. With `W + F_L > max_work`, a full run that fails inside the span
/// loop with `BoundaryLimit` or `ContributorLimit` keeps that cause; E1-K1 does not fire.
#[test]
fn e1_f4_edges_1024_bounds_guard() {
    let (path, request) = edges_1024();
    let max_work = 123_992_662;
    // BoundaryLimit: 2·cells <= max_boundaries < 2·cells + 127 (127 of the 128 vertical
    // boundaries are emitted before WorkLimit at W+F_L−1), the window 384 to 511.
    for max_boundaries in [384, 510] {
        let limits = RoundedFillLimits {
            max_work,
            max_boundaries,
            ..STROKE_V0_LIMITS
        };
        let label = format!("E1-F4 max_boundaries {max_boundaries}");
        let mut ws = with_limits(limits);
        let (on, _) = on_off(&mut ws, &path, request, max_work, &label);
        assert_eq!(on.status, Some(STROKE_PATH_WORK_LIMIT), "{label}");
        assert_eq!(
            on.error,
            Some(StrokeError::Rounded(RoundedFillError::BoundaryLimit)),
            "{label}"
        );
        assert_eq!(on.probe.fired, 0, "{label}: E1-K1 did not fire");
        assert_eq!(on.probe.blocked, 1, "{label}: the guard blocked");
    }
    // ContributorLimit: 384 cells' contributors + 640 vertical > 1,000 >= 640.
    let limits = RoundedFillLimits {
        max_work,
        max_contributors: 1_000,
        ..STROKE_V0_LIMITS
    };
    let mut ws = with_limits(limits);
    let (on, _) = on_off(&mut ws, &path, request, max_work, "E1-F4 contributors");
    assert_eq!(on.status, Some(STROKE_PATH_WORK_LIMIT));
    assert_eq!(
        on.error,
        Some(StrokeError::Rounded(RoundedFillError::ContributorLimit))
    );
    assert_eq!(on.probe.fired, 0, "E1-K1 did not fire");
    assert_eq!(on.probe.blocked, 1, "the guard blocked");
    assert_edges_1024_record(&on, "E1-F4 contributors");
}

/// The ST-U3b chords polyline (`stroke_probe_tests.rs`): `segments` LINE verbs on a circle of
/// radius 100 at multiples of the golden angle.
fn chords(segments: usize) -> PathSpec {
    const CHORD_RADIUS: f64 = 100.0;
    const GOLDEN_ANGLE: f64 = 2.399_963_229_728_653;
    let mut path = PathSpec::new();
    for index in 0..=segments {
        let angle = GOLDEN_ANGLE * index as f64;
        let (x, y) = (CHORD_RADIUS * angle.cos(), CHORD_RADIUS * angle.sin());
        path = if index == 0 {
            path.m(x, y)
        } else {
            path.l(x, y)
        };
    }
    path
}

/// E1-F5: the `NodeLimit` cases of E1.1 keep their status and cause; E1-K1 does not fire.
#[test]
fn e1_f5_node_limit_cases_are_unchanged() {
    let f16 = PathSpec::new()
        .m(0.0, 0.0)
        .c([1.0, 1.0, 0.0, 1.0, 1.0, 0.0]);
    let cases = [
        (
            "ST-F16 e=-8",
            f16,
            request(0.125, StrokeCap::Butt, StrokeJoin::Miter, 4.0, -8),
        ),
        (
            "chords-16 miter/butt",
            chords(16),
            request(2.0, StrokeCap::Butt, StrokeJoin::Miter, 4.0, -3),
        ),
        (
            "chords-16 round/round",
            chords(16),
            request(2.0, StrokeCap::Round, StrokeJoin::Round, 4.0, -3),
        ),
        (
            "chords-16 bevel/butt",
            chords(16),
            request(2.0, StrokeCap::Butt, StrokeJoin::Bevel, 4.0, -3),
        ),
        (
            "chords-32 miter/butt",
            chords(32),
            request(2.0, StrokeCap::Butt, StrokeJoin::Miter, 4.0, -3),
        ),
    ];
    let mut ws = with_limits(STROKE_V0_LIMITS);
    for (label, path, request) in cases {
        let (on, _) = on_off(&mut ws, &path, request, STROKE_V0_LIMITS.max_work, label);
        assert_eq!(on.status, Some(STROKE_PATH_WORK_LIMIT), "{label}");
        assert_eq!(
            on.error,
            Some(StrokeError::Rounded(RoundedFillError::NodeLimit)),
            "{label}"
        );
        assert_eq!(on.probe.reached, 0, "{label}: the ledger is not reached");
        assert_eq!(on.probe.fired, 0, "{label}");
    }
}

/// E1-F6: ST-U3f `chev-1.40625` stays `unsupported-geometry` with `TopologyAmbiguous`.
#[test]
fn e1_f6_chev_1_40625_is_unchanged() {
    let path = PathSpec::new()
        .m(-4.401_143_883_191_439, 1_051.984_338_572_202_7)
        .l(-3.125, 1000.0)
        .l(-1.848_856_116_808_561, 1_051.984_338_572_202_7);
    let mut ws = with_limits(STROKE_V0_LIMITS);
    for exponent in [-3, 0] {
        let label = format!("chev-1.40625 e={exponent}");
        let request = request(12.0, StrokeCap::Round, StrokeJoin::Round, 4.0, exponent);
        let (on, _) = on_off(&mut ws, &path, request, STROKE_V0_LIMITS.max_work, &label);
        assert_eq!(on.status, Some(STROKE_PATH_UNSUPPORTED_GEOMETRY), "{label}");
        assert_eq!(
            on.error,
            Some(StrokeError::Rounded(RoundedFillError::TopologyAmbiguous)),
            "{label}"
        );
        assert_eq!(on.probe.fired, 0, "{label}");
    }
}

/// `edges-N`: `N` square-capped horizontal subpaths, as ST-F26's `edges-1024` (`N = 64`).
fn edges_stack(stack: u32) -> PathSpec {
    let mut path = PathSpec::new();
    for row in 0..stack {
        let y = f64::from(row) * 4.0;
        path = path.m(0.0, y).l(4.0, y);
    }
    path
}

/// E1-F7: the swept path (`E <= 64`). `edges-4` has 64 edges; at `max_work = W + F_L - 1`
/// E1-K1 fires and on and off are equal, at `W + F_L` it does not fire.
#[test]
fn e1_f7_swept_path_fires() {
    let path = edges_stack(4);
    let request = request(2.0, StrokeCap::Square, StrokeJoin::Miter, 4.0, -3);
    let mut ws = with_limits(STROKE_V0_LIMITS);
    let base = observe_path(&mut ws, &path, request, true);
    assert_eq!(base.probe.reached, 1, "edges-4 reaches E1-K1");
    let record = base.probe.last;
    assert!(record.edges <= 64, "the swept path: E = {}", record.edges);
    assert_eq!(base.probe.exact_checks, 1);
    let fire = record.work + record.forecast - 1;
    let mut ws = with_limits(limits_with_work(fire));
    let (on, _) = on_off(&mut ws, &path, request, fire, "E1-F7 W+F_L-1");
    assert_eq!(on.probe.fired, 1, "E1-K1 fired");
    assert_eq!(on.error, work_limit());
    let exact = record.work + record.forecast;
    let mut ws = with_limits(limits_with_work(exact));
    let (on, _) = on_off(&mut ws, &path, request, exact, "E1-F7 W+F_L");
    assert_eq!(on.probe.fired, 0, "E1-K1 did not fire");
    assert_eq!(on.probe.exact_checks, 1);
}

/// E1-F8: vertical edges with a nonzero contributor sum, firing (`STROKE_V0_LIMITS`) and not
/// firing (`max_work = W + F_L`): `edges-1024`, 640 vertical contributors.
#[test]
fn e1_f8_vertical_edges_fire_and_not_fire() {
    let (path, request) = edges_1024();
    let mut ws = with_limits(STROKE_V0_LIMITS);
    let (on, _) = on_off(
        &mut ws,
        &path,
        request,
        STROKE_V0_LIMITS.max_work,
        "E1-F8 fire",
    );
    assert_eq!(on.probe.fired, 1);
    assert_eq!(
        on.probe.last.vertical_contributors,
        Some(EDGES_1024_VERTICAL)
    );
    let max_work = EDGES_1024_W + EDGES_1024_F_L;
    let mut ws = with_limits(limits_with_work(max_work));
    let (on, off) = on_off(&mut ws, &path, request, max_work, "E1-F8 no fire");
    assert_eq!(on.probe.fired, 0);
    assert_eq!(
        on.probe.last.vertical_contributors,
        Some(EDGES_1024_VERTICAL)
    );
    // The span loop pushed exactly the forecast vertical contributors.
    assert_eq!(
        off.stats.unwrap().contributors,
        on.probe.last.contributors + EDGES_1024_VERTICAL
    );
}

/// Fill is untouched: `RoundedFillWorkspace::new` has no E1-K1, so a fill-side arrangement
/// never reaches the probe.
#[test]
fn e1_fill_workspace_has_no_checkpoint() {
    use crate::geometry::Point;
    use crate::line_fill::LineFillRule;
    use crate::rounded_line_fill::RoundedFillWorkspace;
    let mut fill = RoundedFillWorkspace::new(STROKE_V0_LIMITS).expect("reserves");
    let square = [
        Point { x: 0.0, y: 0.0 },
        Point { x: 4.0, y: 0.0 },
        Point { x: 4.0, y: 4.0 },
        Point { x: 0.0, y: 4.0 },
    ];
    take_early_abort_probe();
    assert_eq!(
        fill.tessellate(&[&square], LineFillRule::Nonzero, 0.25),
        Ok(())
    );
    assert_eq!(take_early_abort_probe(), EarlyAbortProbe::default());
}

// ---- The ignored on-off differential and max_work sweep over E1-C1 (E1.4 item 2, E1.5) ----

#[derive(Clone, Debug)]
pub(crate) struct CorpusCase {
    pub(crate) name: String,
    pub(crate) request: StrokeRequest,
    pub(crate) verbs: Vec<u8>,
    pub(crate) bytes: Vec<u8>,
}

fn parse_bits(text: &str) -> f64 {
    f64::from_bits(u64::from_str_radix(text, 16).unwrap_or_else(|_| panic!("bits {text}")))
}

/// The `P3STKIN1` input format of `stroke_dump_tests` (no flags).
pub(crate) fn read_corpus(text: &str) -> Vec<CorpusCase> {
    let mut lines = text.lines();
    assert_eq!(lines.next(), Some("P3STKIN1"), "input magic");
    lines
        .filter(|line| !line.is_empty())
        .map(|line| {
            let fields: Vec<&str> = line.split('\t').collect();
            assert_eq!(fields.len(), 8, "case fields: {line}");
            let cap = match fields[3] {
                "butt" => StrokeCap::Butt,
                "round" => StrokeCap::Round,
                "square" => StrokeCap::Square,
                other => panic!("cap {other}"),
            };
            let join = match fields[4] {
                "miter" => StrokeJoin::Miter,
                "round" => StrokeJoin::Round,
                "bevel" => StrokeJoin::Bevel,
                other => panic!("join {other}"),
            };
            let verbs: Vec<u8> = fields[6]
                .bytes()
                .map(|digit| {
                    assert!(digit.is_ascii_digit());
                    digit - b'0'
                })
                .collect();
            let bytes = fields[7]
                .split(',')
                .filter(|text| !text.is_empty())
                .flat_map(|text| parse_bits(text).to_le_bytes())
                .collect();
            CorpusCase {
                name: fields[0].to_owned(),
                request: StrokeRequest {
                    request_id: 0,
                    width: parse_bits(fields[2]),
                    cap,
                    join,
                    miter_limit: parse_bits(fields[5]),
                    exponent: fields[1].parse().expect("exponent"),
                },
                verbs,
                bytes,
            }
        })
        .collect()
}

#[derive(Clone, Copy, Debug, Default)]
struct SweepTally {
    cases: u64,
    reaching: u64,
    runs: u64,
    fired_small: u64,
    fired_large: u64,
    blocked: u64,
    vertical_reaching: u64,
    exact_checks: u64,
}

impl SweepTally {
    fn merge(&mut self, other: Self) {
        self.cases += other.cases;
        self.reaching += other.reaching;
        self.runs += other.runs;
        self.fired_small += other.fired_small;
        self.fired_large += other.fired_large;
        self.blocked += other.blocked;
        self.vertical_reaching += other.vertical_reaching;
        self.exact_checks += other.exact_checks;
    }
}

fn sweep_point(case: &CorpusCase, limits: RoundedFillLimits, label: &str, tally: &mut SweepTally) {
    let mut ws = with_limits(limits);
    let on = observe(&mut ws, &case.verbs, &case.bytes, case.request, false);
    let off = observe(&mut ws, &case.verbs, &case.bytes, case.request, true);
    assert_on_off_equal(&on, &off, limits.max_work, label);
    tally.runs += 2;
    tally.exact_checks += on.probe.exact_checks + off.probe.exact_checks;
    if on.probe.fired > 0 {
        if on.probe.last.edges <= 64 {
            tally.fired_small += 1;
        } else {
            tally.fired_large += 1;
        }
    }
    tally.blocked += on.probe.blocked;
}

fn sweep_case(case: &CorpusCase, tally: &mut SweepTally) {
    tally.cases += 1;
    let mut base = with_limits(STROKE_V0_LIMITS);
    let on = observe(&mut base, &case.verbs, &case.bytes, case.request, false);
    let off = observe(&mut base, &case.verbs, &case.bytes, case.request, true);
    assert_on_off_equal(&on, &off, STROKE_V0_LIMITS.max_work, &case.name);
    tally.runs += 2;
    tally.exact_checks += on.probe.exact_checks + off.probe.exact_checks;
    if on.probe.fired > 0 {
        if on.probe.last.edges <= 64 {
            tally.fired_small += 1;
        } else {
            tally.fired_large += 1;
        }
    }
    tally.blocked += on.probe.blocked;
    if off.probe.reached == 0 {
        return;
    }
    // The ledger is reached: the max_work sweep, then one blocking point per guard.
    tally.reaching += 1;
    let record = off.probe.last;
    if record.vertical_contributors.is_some_and(|sum| sum > 0) {
        tally.vertical_reaching += 1;
    }
    let total = record.work + record.forecast;
    let mut points: Vec<u64> = (16..=26).map(|k| 1u64 << k).collect();
    points.extend([total - 1, total]);
    for max_work in points {
        let label = format!("{} max_work {max_work}", case.name);
        sweep_point(case, limits_with_work(max_work), &label, tally);
    }
    if record.spans > 0 {
        let limits = RoundedFillLimits {
            max_work: total - 1,
            max_boundaries: record.boundaries + record.spans - 1,
            ..STROKE_V0_LIMITS
        };
        let label = format!("{} boundary guard", case.name);
        sweep_point(case, limits, &label, tally);
    }
    if let Some(vertical) = record.vertical_contributors.filter(|sum| *sum > 0) {
        let limits = RoundedFillLimits {
            max_work: total - 1,
            max_contributors: record.contributors + vertical - 1,
            ..STROKE_V0_LIMITS
        };
        let label = format!("{} contributor guard", case.name);
        sweep_point(case, limits, &label, tally);
    }
}

/// E1.4 item 2 and E1.5: for every case of E1-C1 and, wherever the ledger is reached, at
/// `max_work ∈ {2^k : 16 <= k <= 26} ∪ {W + F_L - 1, W + F_L}` (and one blocking point per
/// guard), on and off are equal; the coverage floor holds.
#[test]
#[ignore = "ST-U10 differential sweep; needs P3_E1_CORPUS (tooling/p3-stroke-e1-corpus.mjs c1)"]
fn e1_c1_differential_sweep() {
    let input = env::var("P3_E1_CORPUS").expect("P3_E1_CORPUS is required");
    let text =
        std::fs::read_to_string(&input).unwrap_or_else(|error| panic!("read {input}: {error}"));
    let cases = read_corpus(&text);
    let threads = std::thread::available_parallelism()
        .map_or(4, usize::from)
        .clamp(1, 8);
    let mut tally = SweepTally::default();
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..threads)
            .map(|thread| {
                let cases = &cases;
                scope.spawn(move || {
                    let mut tally = SweepTally::default();
                    for case in cases.iter().skip(thread).step_by(threads) {
                        sweep_case(case, &mut tally);
                    }
                    tally
                })
            })
            .collect();
        for handle in handles {
            tally.merge(handle.join().expect("a sweep thread"));
        }
    });
    println!("E1-C1 sweep: {} cases, {tally:?}", cases.len());
    assert_eq!(tally.cases, cases.len() as u64);
    assert!(tally.fired_small >= 1, "coverage: E1-K1 fires with E <= 64");
    assert!(tally.fired_large >= 1, "coverage: E1-K1 fires with E > 64");
    assert!(tally.blocked >= 1, "coverage: a guard blocks");
    assert!(
        tally.vertical_reaching >= 1,
        "coverage: a case reaching E1-K1 has vertical edges"
    );
}

/// The corpus reader of the sweep reads `stroke_dump_tests`' input format.
#[test]
fn e1_corpus_reader_reads_the_input_format() {
    let bits = |value: f64| format!("{:016x}", value.to_bits());
    let points = [0.0, 0.0, 4.0, 0.0].map(bits).join(",");
    let text = format!(
        "P3STKIN1\nedges-1\t-3\t{}\tsquare\tmiter\t{}\t01\t{points}\n",
        bits(2.0),
        bits(4.0)
    );
    let cases = read_corpus(&text);
    assert_eq!(cases.len(), 1);
    assert_eq!(cases[0].name, "edges-1");
    assert_eq!(cases[0].verbs, [VERB_MOVE, VERB_LINE]);
    assert_eq!(cases[0].bytes.len(), 32);
    assert_eq!(cases[0].request.exponent, -3);
    let mut ws = with_limits(STROKE_V0_LIMITS);
    let case = &cases[0];
    let on = observe(&mut ws, &case.verbs, &case.bytes, case.request, false);
    assert_eq!(on.status, Some(0));
    assert_eq!(on.probe.exact_checks, 1);
}

/// D9 E2-U1 review S3: E1-K1 on the seam-merged input (shipped since `stroke-v0+r5`),
/// not only on the `r4` input. `edges-1024` is `ok` at r5; with `max_work` one below its
/// `W + F_L` at the ledger the abort is certain, and on and off agree.
#[test]
fn e1_k1_on_the_r5_merged_input() {
    let (path, request) = edges_1024();
    // Family A only (E2-K3 would mesh `edges-1024` before the arrangement runs).
    let r5 = |limits| {
        let mut ws = StrokeWorkspace::with_limits(limits).expect("the test workspace reserves");
        ws.defects_mut().no_family_b = true;
        ws
    };
    let mut ws = r5(STROKE_V0_LIMITS);
    let (full, _) = on_off(
        &mut ws,
        &path,
        request,
        STROKE_V0_LIMITS.max_work,
        "r5 edges-1024",
    );
    assert_eq!(full.status, Some(0));
    assert_eq!(full.probe.reached, 1, "the ledger is reached");
    let total = full.probe.last.work + full.probe.last.forecast;
    let max_work = total - 1;
    let mut ws = r5(limits_with_work(max_work));
    let (on, _) = on_off(
        &mut ws,
        &path,
        request,
        max_work,
        "r5 edges-1024, W + F_L - 1",
    );
    println!(
        "r5 edges-1024: total work {total}, probe at total - 1 {:?}",
        on.probe
    );
    assert_eq!(on.status, Some(STROKE_PATH_WORK_LIMIT));
    assert_eq!(on.probe.fired, 1, "E1-K1 fired");
}
