//! D9 E16-U1 tests (`docs/plans/d9-e16-fill-rejection-remedy-contract.md`, section 7): the
//! fixtures E16-F1 to E16-F9 read natively through `build_path` (E16-A2) and the seeded defects
//! E16-D1 to E16-D4 (E16-A5). The corpus fixtures are the sweep requests in
//! `tests/fixtures/e16-fill-remedy-v1.txt`; E16-A7 for the release WASM is
//! `tests/geometry/e16-fill-remedy.test.ts`.
use crate::codec::{PathInput, Request};
use crate::cubic_fill::{
    with_line_caps_on_cubic_paths, CubicFillError, CubicFillWorkspace, MAX_EXACT_FLAT_COMMANDS,
};
use crate::engine::BATCH_OK;
use crate::fill_export::{
    exact_rung, refinement_exponents, tolerances, with_e16_defect, BuiltPath, E16Defect,
    FillEngine, FillRequest, PathOutcome, FILL_PATH_UNSUPPORTED_GEOMETRY, FILL_PATH_WORK_LIMIT,
    FILL_V0_LIMITS, MIN_TOLERANCE_EXPONENT,
};
use crate::fill_ladder::{ExactStep, Reason, Rung};
use crate::geometry::{VERB_CLOSE, VERB_CUBIC, VERB_LINE, VERB_MOVE};
use crate::line_fill::LineFillRule;
use crate::simple_cubic_topology::TopologyError;

const FIXTURES: &str = include_str!("../../../../tests/fixtures/e16-fill-remedy-v1.txt");

#[derive(Clone)]
pub(crate) struct Fixture {
    pub(crate) exponent: i32,
    pub(crate) rule: LineFillRule,
    pub(crate) verbs: Vec<u8>,
    pub(crate) points: Vec<f64>,
}

impl Fixture {
    fn new(exponent: i32) -> Self {
        Self {
            exponent,
            rule: LineFillRule::Nonzero,
            verbs: Vec::new(),
            points: Vec::new(),
        }
    }

    fn push(mut self, verb: u8, points: &[f64]) -> Self {
        self.verbs.push(verb);
        self.points.extend_from_slice(points);
        self
    }

    fn point_bytes(&self) -> Vec<u8> {
        self.points
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect()
    }

    fn request(&self) -> FillRequest {
        FillRequest {
            request_id: 0,
            rule: self.rule,
            exponent: self.exponent,
        }
    }

    fn segments(&self) -> usize {
        self.verbs
            .iter()
            .filter(|verb| matches!(**verb, VERB_LINE | VERB_CUBIC))
            .count()
    }

    fn contours(&self) -> usize {
        self.verbs.iter().filter(|verb| **verb == VERB_MOVE).count()
    }
}

/// A corpus fixture of the fixture file by its id (`E16-F1`, ...).
pub(crate) fn corpus(name: &str) -> Fixture {
    let line = FIXTURES
        .lines()
        .find(|line| line.split('\t').next() == Some(name))
        .unwrap_or_else(|| panic!("{name} not in the fixture file"));
    let fields: Vec<&str> = line.split('\t').collect();
    let mut path = Fixture::new(fields[2].parse().expect("exponent"));
    path.rule = match fields[3] {
        "nonzero" => LineFillRule::Nonzero,
        "evenodd" => LineFillRule::Evenodd,
        rule => panic!("rule {rule}"),
    };
    path.verbs = fields[4]
        .split(',')
        .map(|verb| verb.parse().expect("verb"))
        .collect();
    path.points = fields[5]
        .split(',')
        .map(|bits| f64::from_bits(u64::from_str_radix(bits, 16).expect("scalar")))
        .collect();
    path
}

/// One bowtie at (x, y): `M L L L` with `explicit_close` adding the closing `L`, then `Z`
/// unless `close` is false; `extra` adds a fifth `L` before the closing one.
fn bowtie(
    path: Fixture,
    x: f64,
    y: f64,
    explicit_close: bool,
    close: bool,
    extra: bool,
) -> Fixture {
    let mut path = path
        .push(VERB_MOVE, &[x, y])
        .push(VERB_LINE, &[x + 8.0, y + 8.0])
        .push(VERB_LINE, &[x + 8.0, y]);
    if extra {
        path = path.push(VERB_LINE, &[x + 4.0, y - 2.0]);
    }
    path = path.push(VERB_LINE, &[x, y + 8.0]);
    if explicit_close {
        path = path.push(VERB_LINE, &[x, y]);
    }
    if close {
        path = path.push(VERB_CLOSE, &[]);
    }
    path
}

/// One square at (x, y), `M L L L L Z` with an explicit closing `L`.
fn square(path: Fixture, x: f64, y: f64) -> Fixture {
    path.push(VERB_MOVE, &[x, y])
        .push(VERB_LINE, &[x + 8.0, y])
        .push(VERB_LINE, &[x + 8.0, y + 8.0])
        .push(VERB_LINE, &[x, y + 8.0])
        .push(VERB_LINE, &[x, y])
        .push(VERB_CLOSE, &[])
}

/// E16-F3: (a) 64 four-segment squares (a departure from the contract's bowties, see
/// `e16_f3_caps_are_inclusive`), (b) 65 three-segment bowties, (c) 64 four-segment bowties
/// with a fifth `L` in contour 0 and the `Z` of contour 1 dropped.
fn f3(case: char) -> Fixture {
    let count = if case == 'b' { 65 } else { 64 };
    let mut path = Fixture::new(-3);
    for index in 0..count {
        let (x, y) = (f64::from(index % 8) * 16.0, f64::from(index / 8) * 16.0);
        path = match case {
            'a' => square(path, x, y),
            'b' => bowtie(path, x, y, false, true, false),
            _ => bowtie(path, x, y, true, index != 1, index == 0),
        };
    }
    path
}

/// E16-F4: five ellipses of four cubics each, rotated by 36° about a common center, so every
/// pair crosses.
fn f4() -> Fixture {
    const KAPPA: f64 = 0.552_284_749_8;
    let mut path = Fixture::new(0);
    for index in 0..5 {
        let angle = f64::from(index) * core::f64::consts::PI / 5.0;
        let (sin, cos) = angle.sin_cos();
        let at = |u: f64, v: f64| {
            [
                32.0 + 24.0 * u * cos - 8.0 * v * sin,
                32.0 + 24.0 * u * sin + 8.0 * v * cos,
            ]
        };
        let ring = [(1.0, 0.0), (0.0, 1.0), (-1.0, 0.0), (0.0, -1.0)];
        path = path.push(VERB_MOVE, &at(1.0, 0.0));
        for quarter in 0..4 {
            let (u0, v0) = ring[quarter];
            let (u1, v1) = ring[(quarter + 1) % 4];
            let mut controls = Vec::new();
            controls.extend(at(u0 + KAPPA * u1, v0 + KAPPA * v1));
            controls.extend(at(u1 + KAPPA * u0, v1 + KAPPA * v0));
            controls.extend(at(u1, v1));
            path = path.push(VERB_CUBIC, &controls);
        }
        path = path.push(VERB_CLOSE, &[]);
    }
    path
}

fn engine() -> FillEngine {
    let mut engine = FillEngine::new();
    assert_eq!(engine.reserve(1 << 18, 1 << 20), BATCH_OK);
    engine
}

fn built(path: &Fixture) -> BuiltPath {
    engine()
        .build_one(path.request(), &path.verbs, &path.point_bytes())
        .expect("reserved engine")
        .expect("no self-check failure")
}

/// The exact rung (with E16-K2's retries) on a fresh workspace, and its mesh's rounded vertex
/// count.
fn exact(path: &Fixture) -> (crate::fill_ladder::ExactOutcome, Option<usize>) {
    let mut workspace = CubicFillWorkspace::new(FILL_V0_LIMITS).expect("workspace");
    let outcome = exact_rung(
        &mut workspace,
        path.request(),
        &path.verbs,
        &path.point_bytes(),
        false,
    );
    let vertices = outcome
        .result
        .is_ok()
        .then(|| {
            workspace
                .output()
                .map(|output| output.rounded.vertices.len())
        })
        .flatten();
    (outcome, vertices)
}

/// The exact rung's Legacy attempt at e (no retries), and its diagnostics' emission flag.
fn attempt(path: &Fixture) -> (Result<(), CubicFillError>, bool) {
    let mut workspace = CubicFillWorkspace::new(FILL_V0_LIMITS).expect("workspace");
    let bytes = path.point_bytes();
    let (flatten, topology) = tolerances(path.exponent);
    let input = PathInput::from_test_parts(
        Request {
            request_id: 0,
            source_epoch: 0,
            source_revision: 0,
            tolerance: flatten,
        },
        &path.verbs,
        &bytes,
    );
    let result = workspace
        .attempt(input, path.rule, topology, MAX_EXACT_FLAT_COMMANDS)
        .map(|_| ());
    (result, workspace.diagnostics().emission_invoked)
}

type Row = (
    PathOutcome,
    Option<Rung>,
    Option<Reason>,
    Option<CubicFillError>,
    u32,
);

fn row(path: &Fixture) -> Row {
    let record = built(path);
    (
        record.outcome,
        record.rung,
        record.reason,
        record.error,
        record.depth,
    )
}

const WORK_LIMIT: PathOutcome = PathOutcome::Status(FILL_PATH_WORK_LIMIT);
const UNSUPPORTED: PathOutcome = PathOutcome::Status(FILL_PATH_UNSUPPORTED_GEOMETRY);

#[test]
fn e16_f1_f2_line_only_source_caps() {
    let f1 = corpus("E16-F1");
    assert_eq!((f1.contours(), f1.segments()), (1, 199));
    assert_eq!(
        row(&f1),
        (PathOutcome::Mesh, Some(Rung::Fast), None, None, 0)
    );
    let f2 = corpus("E16-F2");
    assert_eq!(f2.contours(), 16);
    assert_eq!(
        row(&f2),
        (
            PathOutcome::Mesh,
            Some(Rung::Exact),
            Some(Reason::Crossing),
            None,
            0
        )
    );
}

/// E16-F3 (a) is read with rung 0 skipped (`exact_only`): at E = 256 edges the exact rung's
/// event cap (2 E endpoint events) leaves no room for a crossing event, so 64 bowties end at
/// `EventLimit` and no crossing path can mesh at the caps. Squares test the inclusive source
/// caps instead.
#[test]
fn e16_f3_caps_are_inclusive() {
    let a = f3('a');
    assert_eq!((a.contours(), a.segments(), a.verbs.len()), (64, 256, 384));
    let mut engine = engine();
    engine.hooks().exact_only = true;
    let record = engine
        .build_one(a.request(), &a.verbs, &a.point_bytes())
        .expect("reserved engine")
        .expect("no self-check failure");
    assert_eq!(
        (record.outcome, record.rung, record.error, record.depth),
        (PathOutcome::Mesh, Some(Rung::Exact), None, 0)
    );
    let b = f3('b');
    assert_eq!((b.contours(), b.segments()), (65, 195));
    let c = f3('c');
    assert_eq!((c.contours(), c.segments(), c.verbs.len()), (64, 257, 384));
    // Rung 0 stops at `MONOTONE` (FR4 runs before FR5's crossing check), not `CROSSING`.
    for (name, path) in [("E16-F3 (b)", b), ("E16-F3 (c)", c)] {
        assert_eq!(
            row(&path),
            (
                WORK_LIMIT,
                Some(Rung::Exact),
                Some(Reason::Monotone),
                Some(CubicFillError::SourceLimit),
                0
            ),
            "{name}"
        );
    }
}

#[test]
fn e16_f4_cubic_paths_keep_b1_caps() {
    let path = f4();
    assert_eq!((path.contours(), path.segments()), (5, 20));
    assert_eq!(
        row(&path),
        (
            WORK_LIMIT,
            Some(Rung::Exact),
            Some(Reason::Crossing),
            Some(CubicFillError::SourceLimit),
            0
        )
    );
}

#[test]
fn e16_f5_to_f8_refinement_retries() {
    for (name, reason, step, depth) in [
        ("E16-F5", Reason::Monotone, ExactStep::TriangleFree, 4),
        ("E16-F6", Reason::Monotone, ExactStep::Legacy, 1),
        ("E16-F7", Reason::Structure, ExactStep::Legacy, 2),
    ] {
        let path = corpus(name);
        let record = built(&path);
        assert_eq!(
            (
                record.outcome,
                record.rung,
                record.reason,
                record.step,
                record.error,
                record.depth
            ),
            (
                PathOutcome::Mesh,
                Some(Rung::Exact),
                Some(reason),
                Some(step),
                None,
                depth
            ),
            "{name}"
        );
    }
    // E16-F8: the retries stop at `CommandLimit`; the outcome at e is kept, with depth 0.
    let path = corpus("E16-F8");
    let record = built(&path);
    assert_eq!(
        (record.outcome, record.rung, record.step, record.depth),
        (
            UNSUPPORTED,
            Some(Rung::Exact),
            Some(ExactStep::TriangleFree),
            0
        )
    );
    assert!(
        matches!(
            record.error,
            Some(CubicFillError::Topology(
                TopologyError::Unresolved | TopologyError::KnotMismatch
            ))
        ),
        "{:?}",
        record.error
    );
}

#[test]
fn e16_f9_clearance_stays_work_limit() {
    let path = corpus("E16-F9");
    assert_eq!(path.segments(), 321);
    let record = built(&path);
    assert_eq!(
        (record.outcome, record.rung, record.reason, record.depth),
        (WORK_LIMIT, Some(Rung::Exact), Some(Reason::Clearance), 0)
    );
    // Over the line-only exact rung's 256 segments, so the decoding refuses it.
    assert_eq!(record.error, Some(CubicFillError::SourceLimit));
}

/// E16-D1: the cubic path given the line-only caps. E16-F4 fails in `decode_sources`, before
/// emission; under the defect it passes decoding and stops at `certify_topology`'s guard.
#[test]
fn e16_d1_line_caps_on_a_cubic_path_is_caught() {
    let path = f4();
    assert_eq!(attempt(&path), (Err(CubicFillError::SourceLimit), false));
    let seeded = with_line_caps_on_cubic_paths(|| attempt(&path));
    assert_eq!(
        seeded,
        (Err(CubicFillError::SourceLimit), true),
        "E16-D1 not caught"
    );
}

/// E16-D2: a stopped retry returns its own error. E16-F8 becomes `work-limit`.
#[test]
fn e16_d2_stopped_retry_own_result_is_caught() {
    let path = corpus("E16-F8");
    let seeded = with_e16_defect(E16Defect::RetryOwnResult, || built(&path));
    assert_eq!(
        (seeded.outcome, seeded.error),
        (WORK_LIMIT, Some(CubicFillError::CommandLimit)),
        "E16-D2 not caught"
    );
}

/// E16-D3: retries after a success at e. An `ok` exact mesh (one ellipse of E16-F4) changes.
#[test]
fn e16_d3_retry_after_success_is_caught() {
    let path = f4_single_cubic();
    let (outcome, vertices) = exact(&path);
    assert_eq!((outcome.result.is_ok(), outcome.depth), (true, 0));
    let (seeded, seeded_vertices) = with_e16_defect(E16Defect::RetryAfterSuccess, || exact(&path));
    assert_eq!(seeded.depth, 1, "E16-D3 not caught");
    assert_ne!(seeded_vertices, vertices, "E16-D3 mesh unchanged");
}

/// One ellipse of E16-F4: a cubic path whose exact cascade succeeds at e.
fn f4_single_cubic() -> Fixture {
    let five = f4();
    let mut path = Fixture::new(five.exponent);
    path.verbs = five.verbs[..6].to_vec();
    path.points = five.points[..2 + 4 * 6].to_vec();
    path
}

/// E16-D4: the retry schedule at e = `MIN_TOLERANCE_EXPONENT` + 2 ends at the minimum; without
/// the bound it goes below.
#[test]
fn e16_d4_exponent_bound_is_caught() {
    let exponent = MIN_TOLERANCE_EXPONENT + 2;
    let schedule: Vec<i32> = refinement_exponents(exponent).collect();
    assert_eq!(schedule, vec![exponent - 1, exponent - 2]);
    assert_eq!(refinement_exponents(-3).count(), 16);
    let seeded: Vec<i32> = with_e16_defect(E16Defect::NoExponentBound, || {
        refinement_exponents(exponent).collect()
    });
    assert!(
        seeded.iter().any(|value| *value < MIN_TOLERANCE_EXPONENT),
        "E16-D4 not caught"
    );
}
