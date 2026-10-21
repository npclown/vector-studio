//! ST-U3 native tests of the line-stroke front end (`docs/plans/p3-b2-stroke-contract.md`
//! sections 2-4 and 11): the line fixtures of section 11.2 with their literal expectations,
//! the seeded defects of section 11.3 assigned to ST-U3, memory, determinism and allocation.

use core::cmp::Ordering;

use crate::fill_predicates::orient2d;
use crate::geometry::{Point, VERB_CLOSE, VERB_CUBIC, VERB_LINE, VERB_MOVE};
use crate::rounded_line_fill::RoundedFillError;
use crate::stroke_outline::{
    build_directions, disk_level, miter_kept, power_of_two, tip_guard_at, FrontEndError, PieceKind,
    StrokeCap, StrokeError, StrokeJoin, StrokeOutcome, StrokeRequest, StrokeWorkspace, MAX_PIECES,
    STROKE_PATH_EMPTY, STROKE_PATH_INVALID_PATH, STROKE_PATH_INVALID_STROKE,
    STROKE_PATH_INVALID_TOLERANCE, STROKE_PATH_NUMERIC_RANGE, STROKE_PATH_WORK_LIMIT,
    STROKE_V0_HEAP_CAP, STROKE_V0_LIMITS,
};

pub(crate) const SIXTEEN_GON: f64 = 3.061_467_458_920_718_3;
pub(crate) const HALF_SIXTEEN_GON: f64 = 1.530_733_729_460_359_1;
pub(crate) const QUARTER_SIXTEEN_GON: f64 = 0.765_366_864_730_179_6;
const CLOSE_AREA: f64 = 1e-12;

pub(crate) const CAPS: [StrokeCap; 3] = [StrokeCap::Butt, StrokeCap::Round, StrokeCap::Square];
pub(crate) const JOINS: [StrokeJoin; 3] = [StrokeJoin::Miter, StrokeJoin::Round, StrokeJoin::Bevel];

/// A source path as verbs and interleaved points.
#[derive(Clone, Debug, Default)]
pub(crate) struct PathSpec {
    pub(crate) verbs: Vec<u8>,
    pub(crate) points: Vec<f64>,
}

impl PathSpec {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn m(mut self, x: f64, y: f64) -> Self {
        self.verbs.push(VERB_MOVE);
        self.points.extend([x, y]);
        self
    }

    pub(crate) fn l(mut self, x: f64, y: f64) -> Self {
        self.verbs.push(VERB_LINE);
        self.points.extend([x, y]);
        self
    }

    pub(crate) fn c(mut self, p: [f64; 6]) -> Self {
        self.verbs.push(VERB_CUBIC);
        self.points.extend(p);
        self
    }

    pub(crate) fn z(mut self) -> Self {
        self.verbs.push(VERB_CLOSE);
        self
    }

    pub(crate) fn bytes(&self) -> Vec<u8> {
        self.points
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect()
    }
}

pub(crate) fn request(
    width: f64,
    cap: StrokeCap,
    join: StrokeJoin,
    limit: f64,
    exponent: i32,
) -> StrokeRequest {
    StrokeRequest {
        request_id: 7,
        width,
        cap,
        join,
        miter_limit: limit,
        exponent,
    }
}

pub(crate) fn run(
    workspace: &mut StrokeWorkspace,
    path: &PathSpec,
    request: StrokeRequest,
) -> StrokeOutcome {
    workspace
        .build(request, &path.verbs, &path.bytes())
        .expect("no self-check failure")
}

fn status(workspace: &mut StrokeWorkspace, path: &PathSpec, request: StrokeRequest) -> u32 {
    match run(workspace, path, request) {
        StrokeOutcome::Mesh => 0,
        StrokeOutcome::Status(status) => status,
    }
}

/// The mesh region's area (sum of triangle areas, Float64).
pub(crate) fn area(workspace: &StrokeWorkspace) -> f64 {
    let (vertices, triangles, _) = workspace.mesh().expect("a mesh");
    let mut twice = 0.0;
    for triangle in triangles.chunks_exact(3) {
        let [a, b, c] = [
            vertices[triangle[0] as usize],
            vertices[triangle[1] as usize],
            vertices[triangle[2] as usize],
        ];
        twice += (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    }
    twice * 0.5
}

pub(crate) fn mesh_bounds(workspace: &StrokeWorkspace) -> [f64; 4] {
    let (vertices, _, _) = workspace.mesh().expect("a mesh");
    let mut bounds = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    for point in vertices {
        bounds[0] = bounds[0].min(point.x);
        bounds[1] = bounds[1].min(point.y);
        bounds[2] = bounds[2].max(point.x);
        bounds[3] = bounds[3].max(point.y);
    }
    bounds
}

/// ST-O5 natively: exact closed-triangle membership.
pub(crate) fn inside(workspace: &StrokeWorkspace, point: Point) -> bool {
    let (vertices, triangles, _) = workspace.mesh().expect("a mesh");
    triangles.chunks_exact(3).any(|triangle| {
        (0..3).all(|edge| {
            let a = vertices[triangle[edge] as usize];
            let b = vertices[triangle[(edge + 1) % 3] as usize];
            orient2d(a, b, point).unwrap() != Ordering::Less
        })
    })
}

/// Number of closed loops formed by the boundary pairs.
pub(crate) fn boundary_loops(workspace: &StrokeWorkspace) -> usize {
    let (_, _, boundary) = workspace.mesh().expect("a mesh");
    let mut used = vec![false; boundary.len()];
    let mut loops = 0;
    for first in 0..boundary.len() {
        if used[first] {
            continue;
        }
        used[first] = true;
        let start = boundary[first][0];
        let mut end = boundary[first][1];
        while end != start {
            let next = (0..boundary.len())
                .find(|&index| !used[index] && boundary[index][0] == end)
                .expect("boundary pairs form closed loops");
            used[next] = true;
            end = boundary[next][1];
        }
        loops += 1;
    }
    loops
}

fn kinds(workspace: &StrokeWorkspace) -> Vec<PieceKind> {
    workspace.pieces().iter().map(|piece| piece.kind).collect()
}

fn workspace() -> StrokeWorkspace {
    StrokeWorkspace::new().expect("the stroke workspace reserves")
}

fn assert_area(
    workspace: &mut StrokeWorkspace,
    path: &PathSpec,
    request: StrokeRequest,
    expected: f64,
    exact: bool,
) {
    assert_eq!(
        run(workspace, path, request),
        StrokeOutcome::Mesh,
        "{request:?}"
    );
    let found = area(workspace);
    if exact {
        assert_eq!(found, expected, "{request:?}");
    } else {
        assert!(
            (found - expected).abs() <= CLOSE_AREA,
            "{request:?}: {found} vs {expected}"
        );
    }
}

pub(crate) fn f1() -> PathSpec {
    PathSpec::new().m(0.0, 0.0).l(4.0, 0.0)
}

pub(crate) fn f4() -> PathSpec {
    PathSpec::new().m(0.0, 0.0).l(4.0, 0.0).l(4.0, 4.0)
}

pub(crate) fn f5() -> PathSpec {
    PathSpec::new().m(0.0, 0.0).l(25.0, 0.0).l(32.0, 24.0)
}

pub(crate) fn f6() -> PathSpec {
    PathSpec::new().m(0.0, 0.0).l(4.0, 0.0).l(0.0, 0.0)
}

pub(crate) fn f10() -> PathSpec {
    PathSpec::new()
        .m(0.0, 0.0)
        .l(4.0, 0.0)
        .l(4.0, 0.0)
        .l(4.0, 4.0)
}

pub(crate) fn f11() -> PathSpec {
    PathSpec::new()
        .m(0.0, 0.0)
        .l(4.0, 0.0)
        .l(4.0, 4.0)
        .l(0.0, 4.0)
        .z()
}

pub(crate) fn f12() -> PathSpec {
    PathSpec::new().m(0.0, 0.0).l(8.0, 0.0).l(0.0, 8.0)
}

pub(crate) fn f13() -> PathSpec {
    PathSpec::new().m(0.0, 0.0).l(3.0, 1.0).l(12.0, 4.0)
}

/// ST-U3 supplementary continuation fixture: `(1, 1)` and `(3, 3)` have different binary64
/// unit vectors, so only the shared triple keeps the seam closed.
pub(crate) fn f13x() -> PathSpec {
    PathSpec::new().m(0.0, 0.0).l(1.0, 1.0).l(4.0, 4.0)
}

pub(crate) fn f14a() -> PathSpec {
    PathSpec::new()
        .m(0.0, 2.0)
        .l(4.0, 2.0)
        .m(2.0, 0.0)
        .l(2.0, 4.0)
}

pub(crate) fn f14b() -> PathSpec {
    PathSpec::new()
        .m(0.0, 2.0)
        .l(4.0, 2.0)
        .l(4.0, 4.0)
        .l(2.0, 4.0)
        .l(2.0, 0.0)
}

pub(crate) fn f24() -> PathSpec {
    PathSpec::new()
        .m(0.0, 0.0)
        .l(1.0, 0.0)
        .l(0.0, power_of_two(-20))
}

const BUTT: StrokeCap = StrokeCap::Butt;
const MITER: StrokeJoin = StrokeJoin::Miter;

#[test]
fn st_f1_to_f3_caps_give_their_areas_and_bounds() {
    let mut ws = workspace();
    assert_area(
        &mut ws,
        &f1(),
        request(2.0, BUTT, MITER, 4.0, -3),
        8.0,
        true,
    );
    assert_eq!(mesh_bounds(&ws), [0.0, -1.0, 4.0, 1.0]);
    assert_eq!(boundary_loops(&ws), 1);
    assert_area(
        &mut ws,
        &f1(),
        request(2.0, StrokeCap::Square, MITER, 4.0, -3),
        12.0,
        true,
    );
    assert_eq!(mesh_bounds(&ws), [-1.0, -1.0, 5.0, 1.0]);
    assert_area(
        &mut ws,
        &f1(),
        request(2.0, StrokeCap::Round, MITER, 4.0, -3),
        8.0 + SIXTEEN_GON,
        false,
    );
    let disks: Vec<usize> = ws
        .pieces()
        .iter()
        .filter(|piece| piece.kind == PieceKind::RoundCap)
        .map(|piece| piece.disk_vertices)
        .collect();
    assert_eq!(disks, [16, 16]);
}

#[test]
fn st_f4_joins_give_their_areas_and_the_miter_tip() {
    let mut ws = workspace();
    assert_area(
        &mut ws,
        &f4(),
        request(2.0, BUTT, MITER, 2.0, -3),
        16.0,
        true,
    );
    let miter = ws
        .pieces()
        .iter()
        .find(|piece| piece.kind == PieceKind::Miter)
        .copied()
        .unwrap();
    assert!(ws
        .piece_points(&miter)
        .unwrap()
        .contains(&Point { x: 5.0, y: -1.0 }));
    assert_area(
        &mut ws,
        &f4(),
        request(2.0, BUTT, MITER, 1.0, -3),
        15.5,
        true,
    );
    assert_eq!(
        kinds(&ws),
        [PieceKind::LineSweep, PieceKind::Bevel, PieceKind::LineSweep]
    );
    assert_area(
        &mut ws,
        &f4(),
        request(2.0, BUTT, StrokeJoin::Bevel, 4.0, -3),
        15.5,
        true,
    );
    assert_area(
        &mut ws,
        &f4(),
        request(2.0, BUTT, StrokeJoin::Round, 4.0, -3),
        15.0 + QUARTER_SIXTEEN_GON,
        false,
    );
}

#[test]
fn st_f5_exact_miter_predicate_on_the_ratio_five_quarters() {
    let u = (Point { x: 0.0, y: 0.0 }, Point { x: 25.0, y: 0.0 });
    let v = (Point { x: 0.0, y: 0.0 }, Point { x: 7.0, y: 24.0 });
    let below = 1.249_999_999_999_999_8;
    let above = 1.250_000_000_000_000_2;
    assert_eq!(f64::from_bits(1.25f64.to_bits() - 1), below);
    assert_eq!(f64::from_bits(1.25f64.to_bits() + 1), above);
    assert!(miter_kept(u, v, 1.25, false));
    assert!(!miter_kept(u, v, below, false));
    assert!(miter_kept(u, v, above, false));

    let mut ws = workspace();
    for (limit, miter) in [(1.25, true), (below, false), (above, true)] {
        assert_eq!(
            run(&mut ws, &f5(), request(2.0, BUTT, MITER, limit, -3)),
            StrokeOutcome::Mesh
        );
        let found = ws
            .pieces()
            .iter()
            .find(|piece| matches!(piece.kind, PieceKind::Miter | PieceKind::Bevel))
            .copied()
            .unwrap();
        assert_eq!(found.kind == PieceKind::Miter, miter, "L = {limit}");
        if miter {
            // The tip within g_tip of (25.75, -1).
            let g_tip = 64.0 * power_of_two(-53) * (25.0 + limit * limit * limit);
            let tip = ws
                .piece_points(&found)
                .unwrap()
                .iter()
                .copied()
                .find(|point| point.x > 25.5)
                .unwrap();
            assert!(
                (tip.x - 25.75).abs() <= g_tip && (tip.y + 1.0).abs() <= g_tip,
                "{tip:?}"
            );
        }
    }
}

#[test]
fn st_f6_reversal_adds_no_miter_or_bevel_and_a_round_disk() {
    let mut ws = workspace();
    for join in [MITER, StrokeJoin::Bevel] {
        assert_area(&mut ws, &f6(), request(2.0, BUTT, join, 4.0, -3), 8.0, true);
        assert_eq!(mesh_bounds(&ws), [0.0, -1.0, 4.0, 1.0]);
        assert_eq!(kinds(&ws), [PieceKind::LineSweep, PieceKind::LineSweep]);
    }
    assert_area(
        &mut ws,
        &f6(),
        request(2.0, BUTT, StrokeJoin::Round, 4.0, -3),
        8.0 + HALF_SIXTEEN_GON,
        false,
    );
}

#[test]
fn st_f7_f8_f9_move_only_zero_length_and_collapsed() {
    let mut ws = workspace();
    let f7 = PathSpec::new().m(4.0, 5.0);
    let f8 = PathSpec::new().m(4.0, 5.0).l(4.0, 5.0);
    let f9 = PathSpec::new().m(4.0, 5.0).l(4.0, 5.0).z();
    for cap in CAPS {
        for join in JOINS {
            let request = request(2.0, cap, join, 4.0, -3);
            assert_eq!(
                run(&mut ws, &f7, request),
                StrokeOutcome::Status(STROKE_PATH_EMPTY)
            );
            assert_eq!(
                run(&mut ws, &f9, request),
                StrokeOutcome::Status(STROKE_PATH_EMPTY)
            );
        }
    }
    assert_eq!(
        run(&mut ws, &f8, request(2.0, BUTT, MITER, 4.0, -3)),
        StrokeOutcome::Status(STROKE_PATH_EMPTY)
    );
    assert_area(
        &mut ws,
        &f8,
        request(2.0, StrokeCap::Round, MITER, 4.0, -3),
        SIXTEEN_GON,
        false,
    );
    assert_area(
        &mut ws,
        &f8,
        request(2.0, StrokeCap::Square, MITER, 4.0, -3),
        4.0,
        true,
    );
    assert_eq!(mesh_bounds(&ws), [3.0, 4.0, 5.0, 6.0]);
}

#[test]
fn st_f10_zero_length_segments_are_removed_before_joins() {
    let mut ws = workspace();
    assert_area(
        &mut ws,
        &f10(),
        request(2.0, BUTT, MITER, 2.0, -3),
        16.0,
        true,
    );
    assert_eq!(
        kinds(&ws),
        [PieceKind::LineSweep, PieceKind::Miter, PieceKind::LineSweep]
    );
}

#[test]
fn st_f11_closed_square_ignores_caps() {
    let mut ws = workspace();
    for cap in CAPS {
        assert_area(
            &mut ws,
            &f11(),
            request(2.0, cap, MITER, 2.0, -3),
            32.0,
            true,
        );
        assert_eq!(mesh_bounds(&ws), [-1.0, -1.0, 5.0, 5.0]);
        assert_eq!(boundary_loops(&ws), 2);
        assert!(!inside(&ws, Point { x: 2.0, y: 2.0 }));
        assert_area(
            &mut ws,
            &f11(),
            request(2.0, cap, StrokeJoin::Bevel, 2.0, -3),
            30.0,
            true,
        );
        assert_area(
            &mut ws,
            &f11(),
            request(2.0, cap, StrokeJoin::Round, 2.0, -3),
            28.0 + SIXTEEN_GON,
            false,
        );
    }
}

pub(crate) fn f12_holds(ws: &StrokeWorkspace) -> bool {
    !inside(ws, Point { x: 0.0, y: 4.0 })
        && !inside(ws, Point { x: -0.5, y: 4.0 })
        && inside(ws, Point { x: 4.0, y: 4.0 })
        && inside(ws, Point { x: 4.0, y: 0.5 })
}

#[test]
fn st_f12_implicit_closing_edge_is_not_stroked() {
    let mut ws = workspace();
    assert_eq!(
        run(
            &mut ws,
            &f12(),
            request(2.0, BUTT, StrokeJoin::Bevel, 4.0, -3)
        ),
        StrokeOutcome::Mesh
    );
    assert!(f12_holds(&ws));
}

pub(crate) fn f13_triples_shared(ws: &StrokeWorkspace) -> bool {
    let segments = ws.segments();
    segments.len() == 2 && segments[1].start == segments[0].end
}

#[test]
fn st_f13_forward_continuation_shares_the_triple() {
    let mut ws = workspace();
    let expected = 2.0 * 160f64.sqrt();
    assert_eq!(expected, 25.298_221_281_347_036);
    assert_area(
        &mut ws,
        &f13(),
        request(2.0, BUTT, MITER, 4.0, -3),
        expected,
        false,
    );
    assert_eq!(kinds(&ws), [PieceKind::LineSweep, PieceKind::LineSweep]);
    assert!(f13_triples_shared(&ws));
    let start = ws.segments()[1].start;
    let end = ws.segments()[0].end;
    for (left, right) in [
        (start.minus, end.minus),
        (start.center, end.center),
        (start.plus, end.plus),
    ] {
        assert_eq!(left.x.to_bits(), right.x.to_bits());
        assert_eq!(left.y.to_bits(), right.y.to_bits());
    }
    assert_eq!(boundary_loops(&ws), 1);

    // ST-F13x (ST-U3 supplementary): same rules where the two normals differ in binary64. Its
    // slanted sections at interior columns are rounded by the arrangement, so its area is
    // checked by ST-O3's tau band (perimeter times tau), not to 1e-12.
    let expected = 2.0 * 32f64.sqrt();
    let band = 2.0 * (32f64.sqrt() + 2.0) * power_of_two(-5);
    assert_eq!(
        run(&mut ws, &f13x(), request(2.0, BUTT, MITER, 4.0, -3)),
        StrokeOutcome::Mesh
    );
    assert!((area(&ws) - expected).abs() <= band, "{}", area(&ws));
    assert_eq!(kinds(&ws), [PieceKind::LineSweep, PieceKind::LineSweep]);
    assert!(f13_triples_shared(&ws));
    assert_eq!(boundary_loops(&ws), 1);
}

#[test]
fn st_f14_overlaps_are_counted_once() {
    let mut ws = workspace();
    assert_area(
        &mut ws,
        &f14a(),
        request(2.0, BUTT, MITER, 2.0, -3),
        12.0,
        true,
    );
    assert_area(
        &mut ws,
        &f14b(),
        request(2.0, BUTT, MITER, 2.0, -3),
        20.0,
        true,
    );
    let miters = kinds(&ws)
        .iter()
        .filter(|kind| **kind == PieceKind::Miter)
        .count();
    assert_eq!(miters, 3);
}

#[test]
fn st_f21_to_f24_thin_collapse_and_numeric_range() {
    let mut ws = workspace();
    let thin = power_of_two(-20);
    assert_area(
        &mut ws,
        &f1(),
        request(thin, BUTT, MITER, 4.0, -3),
        power_of_two(-18),
        true,
    );

    let big = power_of_two(40);
    let f22 = PathSpec::new().m(big, big).l(big + 1.0, big + 1.0);
    assert_eq!(
        run(
            &mut ws,
            &f22,
            request(power_of_two(-41), BUTT, MITER, 4.0, -3)
        ),
        StrokeOutcome::Status(STROKE_PATH_EMPTY)
    );

    let huge = power_of_two(60);
    let f23 = PathSpec::new().m(huge, 0.0).l(huge + power_of_two(20), 0.0);
    for cap in CAPS {
        assert_eq!(
            run(&mut ws, &f23, request(2.0, cap, MITER, 4.0, -3)),
            StrokeOutcome::Status(STROKE_PATH_NUMERIC_RANGE)
        );
    }

    assert_eq!(
        run(
            &mut ws,
            &f24(),
            request(2.0, BUTT, MITER, power_of_two(30), -3)
        ),
        StrokeOutcome::Status(STROKE_PATH_NUMERIC_RANGE)
    );
    assert_eq!(
        run(&mut ws, &f24(), request(2.0, BUTT, MITER, 4.0, -3)),
        StrokeOutcome::Mesh
    );
    assert!(kinds(&ws).contains(&PieceKind::Bevel));
}

/// ST-F25: the turns with ratios `sqrt 2`, `5/3` and `sqrt 50` against `L` in
/// `1, SQRT_2, 4, 100`; miter exactly where the ratio is at most `L`.
pub(crate) fn f25_cases() -> Vec<(PathSpec, f64, f64, bool)> {
    let turns = [
        (f4(), 2f64.sqrt()),
        (
            PathSpec::new().m(0.0, 0.0).l(25.0, 0.0).l(18.0, 24.0),
            5.0 / 3.0,
        ),
        (
            PathSpec::new().m(0.0, 0.0).l(25.0, 0.0).l(1.0, 7.0),
            50f64.sqrt(),
        ),
    ];
    let mut cases = Vec::new();
    for (path, ratio) in turns {
        for limit in [1.0, core::f64::consts::SQRT_2, 4.0, 100.0] {
            // Exact decisions: SQRT_2 rounds above sqrt 2, so it keeps the 90 degree miter.
            let miter = if ratio == 2f64.sqrt() {
                limit >= core::f64::consts::SQRT_2
            } else {
                ratio <= limit
            };
            cases.push((path.clone(), ratio, limit, miter));
        }
    }
    cases
}

#[test]
fn st_f25_miter_exactly_where_the_ratio_is_at_most_the_limit() {
    let mut ws = workspace();
    for (path, ratio, limit, miter) in f25_cases() {
        assert_eq!(
            run(&mut ws, &path, request(2.0, BUTT, MITER, limit, -3)),
            StrokeOutcome::Mesh
        );
        assert_eq!(
            kinds(&ws).contains(&PieceKind::Miter),
            miter,
            "ratio {ratio}, L {limit}"
        );
        assert_eq!(
            kinds(&ws).contains(&PieceKind::Bevel),
            !miter,
            "ratio {ratio}, L {limit}"
        );
    }
}

/// ST-F26 current-cap fixtures: `(name, path, request, expected status)`.
pub(crate) fn f26_cases() -> Vec<(&'static str, PathSpec, StrokeRequest, u32)> {
    let mut cases = Vec::new();
    // Pieces 512: a closed 256-gon with bevel joins (256 sweeps and 256 joins).
    let mut polygon = PathSpec::new();
    for vertex in 0..256u32 {
        // Points on a convex "staircase" polygon with integer coordinates: a turn at each.
        let (x, y) = convex_vertex(vertex);
        polygon = if vertex == 0 {
            polygon.m(x, y)
        } else {
            polygon.l(x, y)
        };
    }
    let polygon = polygon.z();
    cases.push((
        "pieces-512",
        polygon,
        request(2.0, BUTT, StrokeJoin::Bevel, 4.0, -3),
        STROKE_PATH_WORK_LIMIT,
    ));
    // Pieces 513: an open 257-point staircase with square caps (256 sweeps, 255 joins, 2 caps).
    let mut open = PathSpec::new().m(0.0, 0.0);
    for step in 1..=256u32 {
        let x = f64::from(step.div_ceil(2)) * 4.0;
        let y = f64::from(step / 2) * 4.0;
        open = open.l(x, y);
    }
    cases.push((
        "pieces-513",
        open,
        request(2.0, StrokeCap::Square, StrokeJoin::Bevel, 4.0, -3),
        STROKE_PATH_WORK_LIMIT,
    ));
    // Edges 1,024: 64 horizontal square-capped subpaths of 16 vertices each.
    let mut edges = PathSpec::new();
    for row in 0..64u32 {
        let y = f64::from(row) * 4.0;
        edges = edges.m(0.0, y).l(4.0, y);
    }
    cases.push((
        "edges-1024",
        edges,
        request(2.0, StrokeCap::Square, MITER, 4.0, -3),
        STROKE_PATH_WORK_LIMIT,
    ));
    // Edges 1,025: 62 such subpaths, one two-segment bevel staircase (25) and two square
    // points (4 each).
    let mut edges = PathSpec::new();
    for row in 0..62u32 {
        let y = f64::from(row) * 4.0;
        edges = edges.m(0.0, y).l(4.0, y);
    }
    let edges = edges
        .m(0.0, 300.0)
        .l(4.0, 300.0)
        .l(4.0, 304.0)
        .m(10.0, 310.0)
        .l(10.0, 310.0)
        .m(20.0, 310.0)
        .l(20.0, 310.0);
    cases.push((
        "edges-1025",
        edges,
        request(2.0, StrokeCap::Square, StrokeJoin::Bevel, 4.0, -3),
        STROKE_PATH_WORK_LIMIT,
    ));
    // n = 256: round caps at r = 200; the next width (r = 500) needs 512 vertices.
    cases.push((
        "disk-256",
        f1(),
        request(400.0, StrokeCap::Round, MITER, 4.0, -3),
        0,
    ));
    cases.push((
        "disk-512",
        f1(),
        request(1000.0, StrokeCap::Round, MITER, 4.0, -3),
        STROKE_PATH_WORK_LIMIT,
    ));
    cases
}

/// A vertex of a convex 256-gon with integer coordinates: four arcs of 64 steps with strictly
/// changing slopes `(64 - i, i)` style edge vectors.
fn convex_vertex(vertex: u32) -> (f64, f64) {
    // Edge vectors e_j for j = 0..256 rotate through all four quadrants with distinct slopes.
    let mut x = 0i64;
    let mut y = 0i64;
    for j in 0..vertex {
        let (dx, dy) = convex_edge(j);
        x += dx;
        y += dy;
    }
    (x as f64, y as f64)
}

fn convex_edge(j: u32) -> (i64, i64) {
    let quadrant = j / 64;
    let i = i64::from(j % 64);
    let (dx, dy) = (64 - i, i + 1);
    match quadrant {
        0 => (dx, dy),
        1 => (-dy, dx),
        2 => (-dx, -dy),
        _ => (dy, -dx),
    }
}

#[test]
fn st_f26_current_cap_fixtures() {
    // ST-U6 (contract section 11.2 note, ST-A0 M3): each at-limit status and its cause is
    // asserted as observed at STROKE_V0_LIMITS. These are current-cap observations that a limit
    // raise may re-baseline.
    let causes = [
        (
            "pieces-512",
            Some(StrokeError::Rounded(RoundedFillError::InputLimit)),
        ),
        (
            "pieces-513",
            Some(StrokeError::Front(FrontEndError::PieceLimit)),
        ),
        (
            "edges-1024",
            Some(StrokeError::Rounded(RoundedFillError::WorkLimit)),
        ),
        (
            "edges-1025",
            Some(StrokeError::Rounded(RoundedFillError::InputLimit)),
        ),
        ("disk-256", None),
        (
            "disk-512",
            Some(StrokeError::Front(FrontEndError::DiskLimit)),
        ),
    ];
    let mut ws = workspace();
    let cases = f26_cases();
    assert_eq!(cases.len(), causes.len());
    for ((name, path, request, expected), (cause_name, cause)) in cases.into_iter().zip(causes) {
        assert_eq!(name, cause_name);
        let found = status(&mut ws, &path, request);
        let pieces = ws.pieces().len();
        println!(
            "ST-F26 {name}: status {found}, cause {:?}, pieces {pieces}, stats {:?}",
            ws.last_error(),
            ws.rounded_stats()
        );
        assert_eq!(found, expected, "{name}");
        assert_eq!(ws.last_error(), cause, "{name}: cause");
        match name {
            "pieces-513" => assert_eq!(pieces, MAX_PIECES, "{name}: stops at the cap"),
            "pieces-512" => assert_eq!(pieces, 512, "{name}"),
            // The arrangement stops with its whole work budget spent (max_work exhausted).
            "edges-1024" => assert_eq!(
                ws.rounded_stats().work_units,
                STROKE_V0_LIMITS.max_work,
                "{name}"
            ),
            "disk-256" => {
                assert_eq!(found, 0, "{name}");
                assert!(ws.pieces().iter().any(|piece| piece.disk_vertices == 256));
            }
            _ => {}
        }
    }
    // The vertex totals the edge fixtures were designed for.
    assert_eq!(vertex_total(&mut ws, "edges-1024"), 1_024);
    assert_eq!(vertex_total(&mut ws, "edges-1025"), 1_025);
}

fn vertex_total(ws: &mut StrokeWorkspace, name: &str) -> usize {
    let (_, path, request, _) = f26_cases().into_iter().find(|case| case.0 == name).unwrap();
    let _ = status(ws, &path, request);
    ws.pieces().iter().map(|piece| piece.count).sum()
}

#[test]
fn stage_order_and_value_statuses() {
    let mut ws = workspace();
    let bad_grammar = PathSpec::new().l(1.0, 1.0);
    assert_eq!(
        status(&mut ws, &bad_grammar, request(-1.0, BUTT, MITER, 0.5, 5000)),
        STROKE_PATH_INVALID_PATH
    );
    for width in [-1.0, f64::NAN, f64::INFINITY] {
        assert_eq!(
            status(&mut ws, &f1(), request(width, BUTT, MITER, 4.0, 5000)),
            STROKE_PATH_INVALID_STROKE
        );
    }
    for limit in [0.5, f64::NAN, f64::INFINITY] {
        assert_eq!(
            status(&mut ws, &f1(), request(2.0, BUTT, MITER, limit, 5000)),
            STROKE_PATH_INVALID_STROKE
        );
    }
    for exponent in [-1021, 1024] {
        assert_eq!(
            status(&mut ws, &f1(), request(2.0, BUTT, MITER, 4.0, exponent)),
            STROKE_PATH_INVALID_TOLERANCE
        );
    }
    for exponent in [-1020, 0, 1023] {
        assert_ne!(
            status(&mut ws, &f1(), request(2.0, BUTT, MITER, 4.0, exponent)),
            STROKE_PATH_INVALID_TOLERANCE
        );
    }
    assert_eq!(
        status(
            &mut ws,
            &PathSpec::new(),
            request(2.0, BUTT, MITER, 4.0, -3)
        ),
        STROKE_PATH_EMPTY
    );
    assert_eq!(
        status(&mut ws, &f1(), request(0.0, BUTT, MITER, 4.0, -3)),
        STROKE_PATH_EMPTY
    );
    assert_eq!(
        status(&mut ws, &f1(), request(-0.0, BUTT, MITER, 4.0, -3)),
        STROKE_PATH_EMPTY
    );
    // ST-U4 strokes cubics (ST-U3's interim unsupported-geometry is gone): ST-F18 is ok, and a
    // zero-length cubic is removed.
    let cubic = PathSpec::new()
        .m(0.0, 0.0)
        .c([0.0, 0.0, 1.0, 0.0, 3.0, 1.0]);
    assert_eq!(
        status(&mut ws, &cubic, request(2.0, BUTT, MITER, 4.0, -3)),
        0
    );
    let point = PathSpec::new()
        .m(1.0, 1.0)
        .c([1.0, 1.0, 1.0, 1.0, 1.0, 1.0]);
    assert_eq!(
        status(
            &mut ws,
            &point,
            request(2.0, StrokeCap::Square, MITER, 4.0, -3)
        ),
        0
    );
    assert_eq!(area(&ws), 4.0);
}

#[test]
fn source_caps_are_work_limits() {
    let mut ws = workspace();
    let mut verbs = PathSpec::new().m(0.0, 0.0);
    for index in 0..1_024 {
        verbs = verbs.l(f64::from(index % 2), 0.0);
    }
    assert_eq!(
        status(&mut ws, &verbs, request(2.0, BUTT, MITER, 4.0, -3)),
        STROKE_PATH_WORK_LIMIT
    );
    let mut segments = PathSpec::new().m(0.0, 0.0);
    for index in 1..=513 {
        segments = segments.l(f64::from(index), 0.0);
    }
    assert_eq!(
        status(&mut ws, &segments, request(2.0, BUTT, MITER, 4.0, -3)),
        STROKE_PATH_WORK_LIMIT
    );
    let mut subpaths = PathSpec::new();
    for index in 0..257 {
        subpaths = subpaths.m(f64::from(index), 0.0);
    }
    assert_eq!(
        status(&mut ws, &subpaths, request(2.0, BUTT, MITER, 4.0, -3)),
        STROKE_PATH_WORK_LIMIT
    );
}

#[test]
fn disk_directions_and_count_rule() {
    let directions = build_directions();
    assert_eq!(directions[0], Point { x: 1.0, y: 0.0 });
    assert_eq!(directions[64], Point { x: 0.0, y: 1.0 });
    for (index, direction) in directions.iter().enumerate() {
        let length = (direction.x * direction.x + direction.y * direction.y).sqrt();
        assert!((length - 1.0).abs() <= 4.0 * f64::EPSILON, "{index}");
        // Symmetric bisection: direction j mirrors direction 64 - j bit for bit.
        assert_eq!(
            direction.x.to_bits(),
            directions[64 - index].y.to_bits(),
            "{index}"
        );
    }
    let origin = Point { x: 0.0, y: 0.0 };
    let quarter = |e: i32| power_of_two(e - 2);
    assert_eq!(disk_level(origin, 1.0, quarter(-3)), Ok(2)); // n = 16 (ST-F3)
    assert_eq!(disk_level(origin, 0.0625, quarter(-8)), Ok(3)); // n = 32 (ST-F16)
    assert_eq!(disk_level(origin, 200.0, quarter(-3)), Ok(6)); // n = 256
    assert!(disk_level(origin, 500.0, quarter(-3)).is_err()); // needs 512
}

#[test]
fn tip_guard_values() {
    let center = Point { x: 25.0, y: 0.0 };
    // A denominator of 0 certifies nothing, so the bound falls back to the limit L.
    assert!(tip_guard_at(center, 1.0, 100.0, 0.0, -3));
    assert!(!tip_guard_at(center, 1.0, power_of_two(30), 0.0, -3));
    assert!(
        !tip_guard_at(center, 1e-30, power_of_two(25), 0.0, -3),
        "a ratio bound above 2^24 always fails"
    );
    // ST-U4 correction (ST-A0 review): the guard uses the certified ratio, not L. A 90 degree
    // turn (1 + d = 1, ratio sqrt 2) passes with L = 1e4 or 2^30.
    assert!(tip_guard_at(center, 10.0, 1e4, 1.0, -3));
    assert!(tip_guard_at(center, 10.0, power_of_two(30), 1.0, -3));
    // ...and a near-reversal still fails: 1 + d = 2^-41 gives a ratio of about 2^21.
    assert!(!tip_guard_at(
        center,
        1.0,
        power_of_two(30),
        power_of_two(-41),
        -3
    ));
    // The rho <= 2^24 boundary (V4 review M2): with fl(1 + d) = 79u the certified lower bound
    // of c^2 is 64u (1 - 2^-40) / 2, so rho is just above 2^24 and the miter is refused; with
    // 80u, rho = 2^27 / sqrt 65 (about 0.993 * 2^24) passes. r = 1e-12 keeps g_tip far below
    // 2^(e-1), so only the ratio check decides.
    let unit = power_of_two(-53);
    assert!(
        !tip_guard_at(center, 1e-12, power_of_two(30), 79.0 * unit, -3),
        "den = 79u: rho above 2^24"
    );
    assert!(
        tip_guard_at(center, 1e-12, power_of_two(30), 80.0 * unit, -3),
        "den = 80u: rho below 2^24"
    );
}

/// ST-U4 (ST-A0 review S2): `M(0,0) L(10,0) L(10,10)`, `w = 20`, miter limit `1e4`, `e = -3`.
/// The ratio is sqrt 2, so the miter is kept, the tip is `(20, -10)` up to `g_tip`, and the
/// result is `ok` (ST-U3's `L^3` guard made it `numeric-range`).
#[test]
fn tip_guard_uses_the_actual_ratio() {
    let mut ws = workspace();
    let path = PathSpec::new().m(0.0, 0.0).l(10.0, 0.0).l(10.0, 10.0);
    let outcome = run(&mut ws, &path, request(20.0, BUTT, MITER, 1e4, -3));
    assert_eq!(outcome, StrokeOutcome::Mesh);
    assert_eq!(
        kinds(&ws),
        [PieceKind::LineSweep, PieceKind::Miter, PieceKind::LineSweep]
    );
    let tip = ws.pieces()[1].extra[2];
    assert!(
        (tip.x - 20.0).abs() <= 1e-12 && (tip.y + 10.0).abs() <= 1e-12,
        "{tip:?}"
    );
    // Sweeps [0,10]x[-10,10] and [0,20]x[0,10] overlap in 100; the miter adds [10,20]x[-10,0].
    assert!((area(&ws) - 400.0).abs() <= 1e-9, "{}", area(&ws));
}

#[test]
fn arrangement_tolerance_is_a_quarter_of_the_curve_share() {
    let mut ws = workspace();
    assert!(st_d12_check(&mut ws));
}

pub(crate) fn st_d12_check(ws: &mut StrokeWorkspace) -> bool {
    let mut ok = true;
    for exponent in [-3, -8, 0, 10] {
        let _ = run(ws, &f1(), request(2.0, BUTT, MITER, 4.0, exponent));
        ok &= ws.last_tau() == Some(power_of_two(exponent - 2));
    }
    ok
}

#[test]
fn every_piece_is_positive_convex_and_hull_ordered() {
    let mut ws = workspace();
    let paths = [f1(), f4(), f5(), f6(), f11(), f12(), f13(), f14a(), f14b()];
    for path in &paths {
        for cap in CAPS {
            for join in JOINS {
                let _ = run(&mut ws, path, request(2.0, cap, join, 4.0, -3));
                for piece in ws.pieces() {
                    let points = ws.piece_points(piece).unwrap();
                    assert!(points.len() >= 3);
                    // Starts at the lexicographically smallest point.
                    assert!(points
                        .iter()
                        .all(|point| (point.x, point.y) >= (points[0].x, points[0].y)));
                    for index in 0..points.len() {
                        let a = points[index];
                        let b = points[(index + 1) % points.len()];
                        let c = points[(index + 2) % points.len()];
                        assert_ne!(orient2d(a, b, c).unwrap(), Ordering::Less, "{piece:?}");
                    }
                }
            }
        }
    }
}

#[test]
fn deterministic_and_batch_independent() {
    let mut ws = workspace();
    let request = request(2.0, StrokeCap::Round, StrokeJoin::Round, 4.0, -3);
    let snapshot = |ws: &StrokeWorkspace| {
        let (vertices, triangles, boundary) = ws.mesh().unwrap();
        (
            vertices
                .iter()
                .flat_map(|point| [point.x.to_bits(), point.y.to_bits()])
                .collect::<Vec<_>>(),
            triangles.to_vec(),
            boundary.to_vec(),
        )
    };
    assert_eq!(run(&mut ws, &f14b(), request), StrokeOutcome::Mesh);
    let first = snapshot(&ws);
    let _ = run(&mut ws, &f11(), request);
    assert_eq!(run(&mut ws, &f14b(), request), StrokeOutcome::Mesh);
    assert_eq!(snapshot(&ws), first);
    let mut fresh = workspace();
    assert_eq!(run(&mut fresh, &f14b(), request), StrokeOutcome::Mesh);
    assert_eq!(snapshot(&fresh), first);
}

#[test]
fn build_allocates_nothing() {
    let mut ws = workspace();
    let paths = [f1(), f11(), f14b()];
    let bytes: Vec<Vec<u8>> = paths.iter().map(PathSpec::bytes).collect();
    let request = request(2.0, StrokeCap::Round, StrokeJoin::Round, 4.0, -3);
    let limited = f26_cases();
    let limited_bytes: Vec<Vec<u8>> = limited.iter().map(|case| case.1.bytes()).collect();
    crate::allocation_test_support::start();
    for (path, points) in paths.iter().zip(&bytes) {
        let _ = ws.build(request, &path.verbs, points);
    }
    for (case, points) in limited.iter().zip(&limited_bytes) {
        let _ = ws.build(case.2, &case.1.verbs, points);
    }
    assert_eq!(crate::allocation_test_support::stop(), 0);
}

/// Section 7.6: the real memory of `STROKE_V0_LIMITS` (recorded in the plan entry).
#[test]
fn stroke_v0_limits_fit_the_workspace_and_heap_caps() {
    let ws = workspace();
    let (front, rounded, scratch) = ws.byte_parts();
    let total = ws.allocated_bytes().unwrap();
    println!(
        "STROKE_V0_LIMITS memory ({}): front end {front} B, RoundedFillWorkspace {rounded} B, FillScratch {scratch} B, total {total} B",
        std::env::consts::ARCH
    );
    assert!(rounded <= STROKE_V0_LIMITS.max_bytes);
    assert!(total <= STROKE_V0_HEAP_CAP);
}

// ---- Seeded defects (section 11.3) assigned to ST-U3 ----

fn with_defect(set: impl FnOnce(&mut crate::stroke_outline::StrokeDefects)) -> StrokeWorkspace {
    let mut ws = workspace();
    set(ws.defects_mut());
    ws
}

/// ST-F5's three answers through the kernel.
pub(crate) fn f5_holds(ws: &mut StrokeWorkspace) -> bool {
    [
        (1.25, true),
        (1.249_999_999_999_999_8, false),
        (1.250_000_000_000_000_2, true),
    ]
    .into_iter()
    .all(|(limit, miter)| {
        run(ws, &f5(), request(2.0, BUTT, MITER, limit, -3)) == StrokeOutcome::Mesh
            && kinds(ws).contains(&PieceKind::Miter) == miter
    })
}

fn area_is(
    ws: &mut StrokeWorkspace,
    path: &PathSpec,
    request: StrokeRequest,
    expected: f64,
) -> bool {
    run(ws, path, request) == StrokeOutcome::Mesh && (area(ws) - expected).abs() <= CLOSE_AREA
}

#[test]
fn seeded_defects_fail_their_named_tests() {
    // Controls: the production workspace passes every check below.
    let mut clean = workspace();
    assert!(f5_holds(&mut clean));
    assert!(area_is(
        &mut clean,
        &f4(),
        request(2.0, BUTT, MITER, 2.0, -3),
        16.0
    ));
    assert!(st_d12_check(&mut clean));

    // ST-D1: Float64 miter with an epsilon; caught by the ST-F5 neighbours.
    let mut ws = with_defect(|d| d.float_miter = true);
    assert!(!f5_holds(&mut ws), "ST-D1");
    // ST-D2: equality treated as bevel; caught by ST-F5 at L = 1.25.
    let mut ws = with_defect(|d| d.equality_bevel = true);
    assert!(!f5_holds(&mut ws), "ST-D2");
    // ST-D3: continuation triple not shared. On ST-F13 itself the two directions (3, 1) and
    // (9, 3) normalize to the same binary64 unit vector, so recomputed triples coincide bit
    // for bit and its triple equality cannot see the defect; the ST-U3 supplementary fixture
    // ST-F13x, whose directions (1, 1) and (3, 3) normalize differently, catches it.
    let mut ws = with_defect(|d| d.unshared_continuation = true);
    assert_eq!(
        run(&mut ws, &f13(), request(2.0, BUTT, MITER, 4.0, -3)),
        StrokeOutcome::Mesh
    );
    assert!(
        f13_triples_shared(&ws),
        "ST-F13 is blind to ST-D3 (equal normals)"
    );
    assert_eq!(
        run(&mut ws, &f13x(), request(2.0, BUTT, MITER, 4.0, -3)),
        StrokeOutcome::Mesh
    );
    assert!(!f13_triples_shared(&ws), "ST-D3");
    // ST-D4: implicit closing edge stroked; caught by ST-F12.
    let mut ws = with_defect(|d| d.stroke_implicit_close = true);
    assert!(
        run(
            &mut ws,
            &f12(),
            request(2.0, BUTT, StrokeJoin::Bevel, 4.0, -3)
        ) != StrokeOutcome::Mesh
            || !f12_holds(&ws),
        "ST-D4"
    );
    // ST-D5: zero-length segments kept. Caught by the guard: on ST-F10 the defect ends in
    // `numeric-range` before ST-F10's area check can run (#169 review M4).
    let mut ws = with_defect(|d| d.keep_zero_length = true);
    assert_eq!(
        run(&mut ws, &f10(), request(2.0, BUTT, MITER, 2.0, -3)),
        StrokeOutcome::Status(STROKE_PATH_NUMERIC_RANGE),
        "ST-D5"
    );
    // ST-D9: disk count halved; caught by ST-F3's area.
    let mut ws = with_defect(|d| d.halve_disk = true);
    assert!(
        !area_is(
            &mut ws,
            &f1(),
            request(2.0, StrokeCap::Round, MITER, 4.0, -3),
            8.0 + SIXTEEN_GON
        ),
        "ST-D9"
    );
    // ST-D10: square cap along the normal; caught by ST-F2.
    let mut ws = with_defect(|d| d.square_along_normal = true);
    assert!(
        !area_is(
            &mut ws,
            &f1(),
            request(2.0, StrokeCap::Square, MITER, 4.0, -3),
            12.0
        ),
        "ST-D10"
    );
    // ST-D11: reversal as a miter turn. Caught by the guard: on ST-F6 the defect ends in
    // `numeric-range` before ST-F6's area check can run (#169 review M4).
    let mut ws = with_defect(|d| d.reversal_as_turn = true);
    assert_eq!(
        run(&mut ws, &f6(), request(2.0, BUTT, MITER, 4.0, -3)),
        StrokeOutcome::Status(STROKE_PATH_NUMERIC_RANGE),
        "ST-D11"
    );
    // ST-D12: arrangement tolerance 2^(e-1); caught by the native tau assertion.
    let mut ws = with_defect(|d| d.fill_tolerance = true);
    assert!(!st_d12_check(&mut ws), "ST-D12");
    // ST-D13: a piece emitted clockwise; caught by ST-F14 (b)'s area.
    let mut ws = with_defect(|d| d.clockwise_piece = true);
    assert!(
        !area_is(&mut ws, &f14b(), request(2.0, BUTT, MITER, 2.0, -3), 20.0),
        "ST-D13"
    );
    // ST-D14: tip guard skipped; caught by ST-F24 at L = 2^30.
    let mut ws = with_defect(|d| d.skip_tip_guard = true);
    assert_ne!(
        run(
            &mut ws,
            &f24(),
            request(2.0, BUTT, MITER, power_of_two(30), -3)
        ),
        StrokeOutcome::Status(STROKE_PATH_NUMERIC_RANGE),
        "ST-D14"
    );
}

// ---- ST-U3c round-join shared vertex (ST-U8 review follow-up) ----

/// The ST-U8 playground path `join-round`, `chevron(45, 52, -26)`: arms at the disk-table
/// direction 45 degrees, so the inner offset points of both sweeps coincide geometrically
/// with join-disk vertices. Before ST-U3c they differed by one ulp and the arrangement
/// returned `Rounded(TopologyAmbiguous)`.
const JOIN_ROUND_ENDS: [[f64; 2]; 2] = [
    [-36.769_552_621_700_47, 10.769_552_621_700_477],
    [36.769_552_621_700_47, 10.769_552_621_700_477],
];
/// `chevron(11.25, 52, -26)`, the reviewer's half-angle 11.25 reproduction.
const HALF_ANGLE_11_25_ENDS: [[f64; 2]; 2] = [
    [-10.144_696_744_838_669, 25.000_834_580_967_982],
    [10.144_696_744_838_669, 25.000_834_580_967_982],
];
/// The ideal areas are the union of the two sweep rectangles and the inscribed 32-gons
/// (inclusion-exclusion over convex intersections). The mesh is resolved under the
/// arrangement's `tau = 2^(e-2)` rounding, so its area may differ from the union of the pieces
/// by up to `tau` times the boundary length, which is below 256 for these paths. The band is
/// `256 tau` (8 at `e = -3`). The first run used `1e-9`, which only an exactly representable
/// region meets; the observed differences were 0.12 to 0.47 for the 45-degree fixtures and
/// 0.006 for half-angle 11.25 (plan: B2 ST-U3c).
const U3C_AREA_BAND: f64 = 256.0 / 32.0;

fn chevron(ends: [[f64; 2]; 2]) -> PathSpec {
    PathSpec::new()
        .m(ends[0][0], ends[0][1])
        .l(0.0, -26.0)
        .l(ends[1][0], ends[1][1])
}

/// `(name, path, request, area, inside, outside)`. Every literal was fixed before its first
/// run (plan: B2 ST-U3c round-join shared vertex).
type SharedVertexCase = (
    &'static str,
    PathSpec,
    StrokeRequest,
    Option<f64>,
    Vec<Point>,
    Vec<Point>,
);

fn shared_vertex_cases() -> Vec<SharedVertexCase> {
    let round = StrokeJoin::Round;
    let p = |x: f64, y: f64| Point { x, y };
    // B, a point 5.5 beyond B on the outer side, a point inside the inner corner (which is at
    // (0, -26 + 6 sqrt 2) for the 45-degree arms).
    let probes_45 = vec![p(0.0, -26.0), p(0.0, -31.5), p(0.0, -18.0)];
    let outside_45 = vec![p(0.0, -32.5), p(0.0, -17.0)];
    let mut cases: Vec<SharedVertexCase> = vec![
        (
            "ST-U3c/join-round",
            chevron(JOIN_ROUND_ENDS),
            request(12.0, BUTT, round, 4.0, -3),
            Some(1_240.093_006_370_322_7),
            probes_45.clone(),
            outside_45.clone(),
        ),
        (
            "ST-U3c/chevron-45-exact",
            chevron([[-36.0, 10.0], [36.0, 10.0]]),
            request(12.0, BUTT, round, 4.0, -3),
            Some(1_213.973_524_260_676_4),
            probes_45.clone(),
            outside_45.clone(),
        ),
        (
            "ST-U3c/half-angle-11.25",
            chevron(HALF_ANGLE_11_25_ENDS),
            request(12.0, BUTT, round, 4.0, -3),
            Some(1_116.178_539_431_534),
            vec![p(0.0, -26.0), p(0.0, -31.5), p(0.0, 0.0)],
            vec![p(0.0, -32.5), p(0.0, 6.0)],
        ),
        (
            "ST-U3c/join-round-round-caps",
            chevron(JOIN_ROUND_ENDS),
            request(12.0, StrokeCap::Round, round, 4.0, -3),
            Some(1_352.465_031_851_612_8),
            // Also 5.5 beyond the start along the outward tangent.
            [probes_45.clone(), vec![p(-40.658_627_7, 14.658_627_7)]].concat(),
            [outside_45.clone(), vec![p(-41.365_734_5, 15.365_734_5)]].concat(),
        ),
    ];
    // The reviewer's other tolerances and width: `ok` with B and the inner overlap inside.
    for (name, width, exponent) in [
        ("ST-U3c/join-round-e-5", 12.0, -5),
        ("ST-U3c/join-round-e-1", 12.0, -1),
        ("ST-U3c/join-round-e3", 12.0, 3),
        ("ST-U3c/join-round-w4", 4.0, -3),
    ] {
        cases.push((
            name,
            chevron(JOIN_ROUND_ENDS),
            request(width, BUTT, round, 4.0, exponent),
            None,
            vec![p(0.0, -26.0), p(0.0, -25.0)],
            vec![],
        ));
    }
    cases
}

#[test]
fn st_u3c_round_join_shared_vertex_fixtures_are_ok() {
    let mut ws = workspace();
    for (name, path, request, expected, inner, outer) in shared_vertex_cases() {
        assert_eq!(run(&mut ws, &path, request), StrokeOutcome::Mesh, "{name}");
        if let Some(expected) = expected {
            let found = area(&ws);
            assert!(
                (found - expected).abs() <= U3C_AREA_BAND,
                "{name}: area {found} vs {expected}"
            );
        }
        for probe in inner {
            assert!(inside(&ws, probe), "{name}: {probe:?} inside");
        }
        for probe in outer {
            assert!(!inside(&ws, probe), "{name}: {probe:?} outside");
        }
    }
}

/// Section 4.2 sharing, bit for bit: in every ST-U3c fixture, each offset point `E-`, `E+` of
/// a triple adjacent to a round join or cap that lies on the disk piece at all is one of its
/// vertices exactly, and no two distinct piece vertices of the path are within `1e-9`.
#[test]
fn st_u3c_disk_vertices_share_the_sweep_offset_points() {
    let mut ws = workspace();
    for (name, path, request, ..) in shared_vertex_cases() {
        assert_eq!(run(&mut ws, &path, request), StrokeOutcome::Mesh, "{name}");
        let bits = |p: Point| (p.x.to_bits(), p.y.to_bits());
        let mut all: Vec<Point> = Vec::new();
        let mut shared = 0;
        for piece in ws.pieces().iter().filter(|piece| !piece.dropped) {
            let points = ws.piece_points(piece).unwrap();
            all.extend_from_slice(points);
            let segment = ws.segments()[piece.segment];
            let triples = match piece.kind {
                PieceKind::RoundJoin => {
                    let next = segment.join_after.unwrap().next;
                    vec![segment.end, ws.segments()[next].start]
                }
                PieceKind::RoundCap if piece.t0 == 0.0 => vec![segment.start],
                PieceKind::RoundCap => vec![segment.end],
                _ => continue,
            };
            for triple in triples {
                for target in [triple.minus, triple.plus] {
                    let exact = points.iter().any(|v| bits(*v) == bits(target));
                    let near = points
                        .iter()
                        .any(|v| (v.x - target.x).abs().max((v.y - target.y).abs()) <= 1e-9);
                    assert_eq!(exact, near, "{name}: {target:?} shared bit for bit");
                    shared += usize::from(exact);
                }
            }
        }
        // Each join shares its two outer and two inner points; each round cap its two.
        let caps = if request.cap == StrokeCap::Round {
            4
        } else {
            0
        };
        assert_eq!(shared, 4 + caps, "{name}: shared offset points");
        for (index, a) in all.iter().enumerate() {
            for b in &all[index + 1..] {
                let close = (a.x - b.x).abs().max((a.y - b.y).abs()) <= 1e-9;
                assert!(
                    !close || bits(*a) == bits(*b),
                    "{name}: {a:?} and {b:?} are distinct but within 1e-9"
                );
            }
        }
    }
}
