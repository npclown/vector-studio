//! ST-U4 native tests of the cubic stroke front end (`docs/plans/p3-b2-stroke-contract.md`
//! sections 4.5, 4.6 and 11): the exact stationary classification, the cubic fixtures ST-F15 to
//! ST-F20 with their literal expectations, ST-G5 and the cubic range condition, the seeded defects
//! ST-D6 to ST-D8, determinism and allocation. ST-O1 to ST-O4 run on the same cases through the
//! dump hand-off in `tests/geometry/stroke-oracle.test.ts`.

use crate::geometry::Point;
use crate::rounded_line_fill::{RoundedFillError, RoundedFillLimits};
use crate::stroke_cubic::{classify_cubic, CubicClass};
use crate::stroke_outline::{
    FrontEndError, PieceKind, StrokeCap, StrokeError, StrokeJoin, StrokeOutcome, StrokeWorkspace,
    STROKE_PATH_NUMERIC_RANGE, STROKE_PATH_WORK_LIMIT,
};
use crate::stroke_outline_tests::{
    area, inside, mesh_bounds, request, run, PathSpec, CAPS, HALF_SIXTEEN_GON, SIXTEEN_GON,
};

const CLOSE_AREA: f64 = 1e-12;
const BUTT: StrokeCap = StrokeCap::Butt;
const MITER: StrokeJoin = StrokeJoin::Miter;

/// Test-only arrangement limits wider than `STROKE_V0_LIMITS` (same input-vertex, edge and
/// contour caps). They let a fixture that `STROKE_V0_LIMITS` stops in the arrangement show its
/// literal expectation; they are never a production configuration.
pub(crate) const WIDE_TEST_LIMITS: RoundedFillLimits = RoundedFillLimits {
    max_contours: 512,
    max_input_vertices: 1_024,
    max_edges: 1_024,
    max_pairs: 523_776,
    max_events: 65_536,
    max_sections: 4_194_304,
    max_nodes: 262_144,
    max_cells: 262_144,
    max_boundaries: 524_288,
    max_contributors: 524_288,
    max_vertices: 262_144,
    max_triangles: 262_144,
    max_work: 4_000_000_000,
    max_bytes: 1 << 30,
};

fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}

fn cubic(p: [[f64; 2]; 4]) -> PathSpec {
    PathSpec::new()
        .m(p[0][0], p[0][1])
        .c([p[1][0], p[1][1], p[2][0], p[2][1], p[3][0], p[3][1]])
}

fn controls(p: [[f64; 2]; 4]) -> [Point; 4] {
    p.map(|[x, y]| point(x, y))
}

const F16: [[f64; 2]; 4] = [[0.0, 0.0], [1.0, 1.0], [0.0, 1.0], [1.0, 0.0]];
const F17: [[f64; 2]; 4] = [[3.0, 0.0], [-1.0, 0.0], [-1.0, 0.0], [3.0, 0.0]];
const F18: [[f64; 2]; 4] = [[0.0, 0.0], [0.0, 0.0], [1.0, 0.0], [3.0, 1.0]];
const F19: [[f64; 2]; 4] = [[-1.0, 0.0], [1.0, 0.0], [-1.0, 0.0], [1.0, 0.0]];
const R3: [[f64; 2]; 4] = [[0.0, 0.0], [1.0, 0.0], [2.0, 1.0 / 64.0], [3.0, 3.0 / 64.0]];
/// ST-U4's synthetic folded-band fixture for ST-D8 (see `tests/geometry/stroke-oracle/fixtures.ts`).
const FOLDED_ARC: [[f64; 2]; 4] = [
    [0.995_004_165_278_025_7, -0.099_833_416_646_828_15],
    [1.001_665_278_240_658, -0.033_444_472_285_109_01],
    [1.001_665_278_240_658, 0.033_444_472_285_109_01],
    [0.995_004_165_278_025_7, 0.099_833_416_646_828_15],
];

/// The s2 regular families R1-R6 with their stated widths (section 11.2, ST-F15).
fn families() -> [(&'static str, [[f64; 2]; 4], f64); 6] {
    let r1 = [[0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [3.0, 0.0]];
    let r5 = [[0.0, 0.0], [1.0, 1.0], [2.0, -1.0], [3.0, 0.0]];
    let r6 = [
        [3.0, -3.0 / 64.0],
        [-1.0, -1.0 / 64.0],
        [-1.0, 1.0 / 64.0],
        [3.0, 3.0 / 64.0],
    ];
    [
        ("R1", r1, 2.0),
        ("R2", r1, 64.0),
        ("R3", R3, 2.0),
        ("R4", R3, 64.0),
        ("R5", r5, 2.0),
        ("R6", r6, 2.0),
    ]
}

/// `e` at the nine s2 zoom/DPR pairs.
const S2_EXPONENTS: [i32; 9] = [3, 2, 2, -3, -4, -5, -9, -10, -11];

fn workspace() -> StrokeWorkspace {
    StrokeWorkspace::new().expect("the stroke workspace reserves")
}

fn wide() -> StrokeWorkspace {
    StrokeWorkspace::with_limits(WIDE_TEST_LIMITS).expect("the wide test workspace reserves")
}

fn status(outcome: StrokeOutcome) -> u32 {
    match outcome {
        StrokeOutcome::Mesh => 0,
        StrokeOutcome::Status(status) => status,
    }
}

fn count(ws: &StrokeWorkspace, kind: PieceKind) -> usize {
    ws.pieces()
        .iter()
        .filter(|piece| piece.kind == kind)
        .count()
}

#[test]
fn stationary_classification_is_exact() {
    assert_eq!(
        classify_cubic(controls(F16)),
        Ok(CubicClass::Cusp { split: 0.5 })
    );
    assert_eq!(
        classify_cubic(controls(F17)),
        Ok(CubicClass::Collinear {
            turning: [0.5, 0.0],
            count: 1
        })
    );
    assert_eq!(
        classify_cubic(controls(F19)),
        Ok(CubicClass::Collinear {
            turning: [0.0, 0.0],
            count: 0
        })
    );
    assert_eq!(
        classify_cubic(controls(F18)),
        Ok(CubicClass::StationaryStart)
    );
    let mut reversed = F18;
    reversed.reverse();
    assert_eq!(
        classify_cubic(controls(reversed)),
        Ok(CubicClass::StationaryEnd)
    );
    for (name, family, _) in families() {
        let expected = if name == "R1" || name == "R2" {
            CubicClass::Collinear {
                turning: [0.0, 0.0],
                count: 0,
            }
        } else {
            CubicClass::Regular
        };
        assert_eq!(classify_cubic(controls(family)), Ok(expected), "{name}");
    }
    // A reversal at the rational t* = 1/3: C'(t)/3 = (t - 1/3)(3t, 3) by construction.
    let third = [[0.0, 0.0], [0.0, -1.0], [-0.5, -0.5], [1.5, 1.5]];
    assert_eq!(
        classify_cubic(controls(third)),
        Ok(CubicClass::Cusp { split: 1.0 / 3.0 })
    );
    // Collinear with two irrational turning points (10 t^2 - 10 t + 2 = 0, t = 1/2 -+ sqrt(5)/10):
    // each split is the largest binary64 at or below its root.
    let irrational = [[0.0, 0.0], [2.0, 0.0], [-1.0, 0.0], [1.0, 0.0]];
    let Ok(CubicClass::Collinear { turning, count }) = classify_cubic(controls(irrational)) else {
        panic!("collinear");
    };
    assert_eq!(count, 2);
    let roots = [0.5 - 5f64.sqrt() / 10.0, 0.5 + 5f64.sqrt() / 10.0];
    for (split, root) in turning.iter().zip(roots) {
        assert!((split - root).abs() <= 2.0 * f64::EPSILON, "{split} {root}");
    }
    // A common root outside [0, 1] leaves the cubic regular: C'(t)/3 = (t + 1/2)(3t, 3).
    let outside = [[0.0, 0.0], [0.0, 1.5], [0.75, 4.5], [5.25, 9.0]];
    assert_eq!(classify_cubic(controls(outside)), Ok(CubicClass::Regular));
}

#[test]
fn st_f16_cusp_disk_under_wide_limits_and_the_production_node_limit() {
    let path = cubic(F16);
    let request = request(0.125, BUTT, MITER, 4.0, -8);
    // STROKE_V0_LIMITS: the arrangement's node cap stops ST-F16 (a recorded blocker, see the
    // plan entry). The front end completes.
    let mut ws = workspace();
    assert_eq!(status(run(&mut ws, &path, request)), STROKE_PATH_WORK_LIMIT);
    assert_eq!(
        ws.last_error(),
        Some(StrokeError::Rounded(RoundedFillError::NodeLimit))
    );
    // Its literal expectation under the test-only wide limits.
    let mut ws = wide();
    assert_eq!(run(&mut ws, &path, request), StrokeOutcome::Mesh);
    let disks: Vec<_> = ws
        .pieces()
        .iter()
        .filter(|piece| piece.kind == PieceKind::CuspDisk)
        .collect();
    assert_eq!(disks.len(), 1);
    assert_eq!(disks[0].t0, 0.5);
    assert_eq!(disks[0].meta.samples[0].center, point(0.5, 0.75));
    assert_eq!(disks[0].disk_vertices, 32);
    assert!(inside(&ws, point(0.5, 0.8)));
    // Leaves tile [0, 0.5] and [0.5, 1], the disk between them (section 4.9).
    let position = ws
        .pieces()
        .iter()
        .position(|piece| piece.kind == PieceKind::CuspDisk)
        .unwrap();
    assert!(ws.pieces()[..position]
        .iter()
        .all(|piece| piece.kind == PieceKind::CubicLeaf && piece.meta.range == (0.0, 0.5)));
    assert!(ws.pieces()[position + 1..]
        .iter()
        .all(|piece| piece.kind == PieceKind::CubicLeaf && piece.meta.range == (0.5, 1.0)));
    assert_eq!(
        count(&ws, PieceKind::Bevel) + count(&ws, PieceKind::Miter),
        0
    );
}

#[test]
fn st_f17_collinear_reversal_areas() {
    let mut ws = workspace();
    for (cap, expected) in [
        (StrokeCap::Butt, 6.0 + HALF_SIXTEEN_GON),
        (StrokeCap::Square, 8.0 + HALF_SIXTEEN_GON),
        (StrokeCap::Round, 6.0 + SIXTEEN_GON),
    ] {
        let outcome = run(&mut ws, &cubic(F17), request(2.0, cap, MITER, 4.0, -3));
        assert_eq!(outcome, StrokeOutcome::Mesh, "{cap:?}");
        assert!(
            (area(&ws) - expected).abs() <= CLOSE_AREA,
            "{cap:?} {}",
            area(&ws)
        );
        let disk = ws
            .pieces()
            .iter()
            .find(|piece| piece.kind == PieceKind::CuspDisk)
            .unwrap();
        assert_eq!(disk.meta.samples[0].center, point(0.0, 0.0));
        assert_eq!(count(&ws, PieceKind::CuspDisk), 1);
        assert_eq!(count(&ws, PieceKind::LineSweep), 2);
    }
}

#[test]
fn st_f18_stationary_start_tangent_and_membership() {
    let mut ws = workspace();
    let outcome = run(
        &mut ws,
        &cubic(F18),
        request(2.0, StrokeCap::Square, MITER, 4.0, -3),
    );
    assert_eq!(outcome, StrokeOutcome::Mesh);
    assert_eq!(ws.segments()[0].start_unit, point(1.0, 0.0));
    assert!(inside(&ws, point(-0.9, 0.9)));
    assert!(!inside(&ws, point(-1.1, 0.0)));
    assert!(!inside(&ws, point(-0.5, 1.1)));
}

#[test]
fn st_f19_collinear_continuation_has_no_disk() {
    let mut ws = workspace();
    let outcome = run(&mut ws, &cubic(F19), request(2.0, BUTT, MITER, 4.0, -3));
    assert_eq!(outcome, StrokeOutcome::Mesh);
    assert_eq!(area(&ws), 4.0);
    assert_eq!(mesh_bounds(&ws), [-1.0, -1.0, 1.0, 1.0]);
    assert_eq!(count(&ws, PieceKind::CuspDisk), 0);
    assert_eq!(count(&ws, PieceKind::LineSweep), 1);
}

#[test]
fn st_f20_the_s2_stationary_probes_are_ok() {
    let mut ws = workspace();
    for cap in CAPS {
        for (shape, class) in [
            (F18, CubicClass::StationaryStart),
            (
                F17,
                CubicClass::Collinear {
                    turning: [0.5, 0.0],
                    count: 1,
                },
            ),
            (
                F19,
                CubicClass::Collinear {
                    turning: [0.0, 0.0],
                    count: 0,
                },
            ),
        ] {
            let outcome = run(&mut ws, &cubic(shape), request(2.0, cap, MITER, 4.0, -3));
            assert_eq!(outcome, StrokeOutcome::Mesh, "{cap:?} {class:?}");
            assert_eq!(ws.segments()[0].class, class);
        }
    }
}

/// ST-F15's statuses, natively: R1 and R2 `ok` at every `e`, R3 and R4 `ok` at `e = -3`, every
/// other case `ok` or `work-limit` (listed in the plan entry).
#[test]
fn st_f15_s2_families_ok_or_work_limit() {
    let mut ws = workspace();
    for (name, family, width) in families() {
        for exponent in S2_EXPONENTS {
            let outcome = run(
                &mut ws,
                &cubic(family),
                request(width, BUTT, MITER, 4.0, exponent),
            );
            let code = status(outcome);
            let required =
                name == "R1" || name == "R2" || (exponent == -3 && (name == "R3" || name == "R4"));
            if required {
                assert_eq!(code, 0, "{name} e={exponent}");
            } else {
                assert!(
                    code == 0 || code == STROKE_PATH_WORK_LIMIT,
                    "{name} e={exponent}: {code}"
                );
            }
            println!(
                "ST-F15 {name} e={exponent}: status {code}, pieces {}, failure {:?}",
                ws.pieces().len(),
                ws.last_error()
            );
        }
    }
}

#[test]
fn st_g5_and_the_cubic_range_condition_are_numeric_range() {
    let mut ws = workspace();
    // ST-G5: a reversal with M = 2^40 at e = -4 passes ST-G1 (16u(M + r) <= 2^-8) but not
    // 2 eta = 128 u M = 2^-6 <= 2^-8.
    let scale = 1_099_511_627_776.0; // 2^40
    let scaled = F16.map(|[x, y]| [x * scale, y * scale]);
    let outcome = run(&mut ws, &cubic(scaled), request(1e-6, BUTT, MITER, 4.0, -4));
    assert_eq!(status(outcome), STROKE_PATH_NUMERIC_RANGE);
    assert_eq!(
        ws.last_error(),
        Some(StrokeError::Front(FrontEndError::NumericRange))
    );
    // The same magnitude without a stationary point is not stopped by ST-G5.
    // (R3 has |x| up to 3, so it is scaled by 2^38 to keep the same ST-G1 margin.)
    let regular = R3.map(|[x, y]| [x * scale / 4.0, y * scale / 4.0]);
    let outcome = run(
        &mut ws,
        &cubic(regular),
        request(1e-6, BUTT, MITER, 4.0, -4),
    );
    assert_ne!(status(outcome), STROKE_PATH_NUMERIC_RANGE);
    // ST-U4's range condition for a non-collinear cubic: 2^-250 <= M <= 2^250.
    let big = 2f64.powi(260);
    let large = R3.map(|[x, y]| [x * big, y * big]);
    let outcome = run(
        &mut ws,
        &cubic(large),
        request(2.0, BUTT, MITER, 4.0, 1_000),
    );
    assert_eq!(status(outcome), STROKE_PATH_NUMERIC_RANGE);
    let small = 2f64.powi(-260);
    let tiny = R3.map(|[x, y]| [x * small, y * small]);
    let outcome = run(
        &mut ws,
        &cubic(tiny),
        request(small, BUTT, MITER, 4.0, -300),
    );
    assert_eq!(status(outcome), STROKE_PATH_NUMERIC_RANGE);
    // A collinear cubic has no such condition (its sweeps are lines).
    let line =
        [[0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [3.0, 0.0]].map(|[x, y]| [x * small, y * small]);
    let outcome = run(
        &mut ws,
        &cubic(line),
        request(small, BUTT, MITER, 4.0, -300),
    );
    assert_eq!(outcome, StrokeOutcome::Mesh);
}

#[test]
fn leaves_share_their_knot_triples_and_tile_their_range() {
    let mut ws = workspace();
    let outcome = run(&mut ws, &cubic(R3), request(2.0, BUTT, MITER, 4.0, -9));
    assert_eq!(outcome, StrokeOutcome::Mesh);
    let leaves: Vec<_> = ws.pieces().iter().collect();
    assert!(leaves.len() > 8);
    assert!(leaves
        .iter()
        .all(|piece| piece.kind == PieceKind::CubicLeaf));
    let segment = ws.segments()[0];
    assert_eq!(leaves[0].meta.samples[0], segment.start);
    assert_eq!(leaves[leaves.len() - 1].meta.samples[1], segment.end);
    let mut next = 0.0f64;
    for pair in leaves.windows(2) {
        assert_eq!(pair[0].meta.samples[1], pair[1].meta.samples[0]);
    }
    for leaf in &leaves {
        let scale = 2f64.powi(-(leaf.meta.depth as i32));
        assert_eq!(f64::from(leaf.meta.index) * scale, next);
        next = f64::from(leaf.meta.index + 1) * scale;
    }
    assert_eq!(next, 1.0);
}

#[test]
fn deterministic_and_allocation_free_on_cubics() {
    let cases = [
        (cubic(F17), request(2.0, StrokeCap::Round, MITER, 4.0, -3)),
        (cubic(F18), request(2.0, StrokeCap::Square, MITER, 4.0, -3)),
        (cubic(F16), request(0.125, BUTT, MITER, 4.0, -8)),
        (cubic(families()[4].1), request(2.0, BUTT, MITER, 4.0, -3)),
        (cubic(families()[5].1), request(2.0, BUTT, MITER, 4.0, -4)),
        (cubic(R3), request(64.0, BUTT, MITER, 4.0, -9)),
    ];
    let bytes: Vec<Vec<u8>> = cases.iter().map(|case| case.0.bytes()).collect();
    let mut ws = workspace();
    let snapshot = |ws: &StrokeWorkspace| {
        ws.mesh().map(|(vertices, triangles, boundary)| {
            (
                vertices
                    .iter()
                    .map(|v| (v.x.to_bits(), v.y.to_bits()))
                    .collect::<Vec<_>>(),
                triangles.to_vec(),
                boundary.to_vec(),
            )
        })
    };
    let first = {
        let _ = run(&mut ws, &cases[1].0, cases[1].1);
        snapshot(&ws)
    };
    let _ = run(&mut ws, &cases[0].0, cases[0].1);
    let _ = run(&mut ws, &cases[1].0, cases[1].1);
    assert_eq!(snapshot(&ws), first);
    crate::allocation_test_support::start();
    for (case, points) in cases.iter().zip(&bytes) {
        let _ = ws.build(case.1, &case.0.verbs, points);
    }
    assert_eq!(crate::allocation_test_support::stop(), 0);
}

// ---- Seeded defects ST-D6 to ST-D8 (section 11.3) ----

fn with_defect(
    mut ws: StrokeWorkspace,
    set: impl FnOnce(&mut crate::stroke_outline::StrokeDefects),
) -> StrokeWorkspace {
    set(ws.defects_mut());
    ws
}

#[test]
fn seeded_cubic_defects_fail_their_named_checks() {
    // Controls: the clean workspaces meet each check.
    let f16 = cubic(F16);
    let f16_request = request(0.125, BUTT, MITER, 4.0, -8);
    let r3_request = request(2.0, BUTT, MITER, 4.0, -5);
    let arc_request = request(9.94, BUTT, MITER, 4.0, 0);
    let mut clean = wide();
    assert_eq!(run(&mut clean, &f16, f16_request), StrokeOutcome::Mesh);
    assert!(inside(&clean, point(0.5, 0.8)));
    assert_eq!(count(&clean, PieceKind::Bevel), 0);
    assert_eq!(run(&mut clean, &cubic(R3), r3_request), StrokeOutcome::Mesh);
    assert_eq!(count(&clean, PieceKind::CubicLeaf), 4);
    assert_eq!(count(&clean, PieceKind::Bevel), 0);
    assert_eq!(
        run(&mut clean, &cubic(FOLDED_ARC), arc_request),
        StrokeOutcome::Mesh
    );
    assert_eq!(count(&clean, PieceKind::CubicLeaf), 2);
    assert!(clean.pieces().iter().all(|piece| piece.meta.depth == 1));

    // ST-D6: a user join at generated knots (ST-O2 rejects it in the hand-off).
    let mut ws = with_defect(wide(), |defects| defects.knot_join = true);
    let _ = run(&mut ws, &f16, f16_request);
    assert!(count(&ws, PieceKind::Bevel) > 0);
    let _ = run(&mut ws, &cubic(R3), r3_request);
    assert_eq!(count(&ws, PieceKind::Bevel), 3);

    // ST-D7: the cusp disk omitted; ST-F16's (0.5, 0.8) falls outside.
    let mut ws = with_defect(wide(), |defects| defects.omit_cusp_disk = true);
    assert_eq!(run(&mut ws, &f16, f16_request), StrokeOutcome::Mesh);
    assert_eq!(count(&ws, PieceKind::CuspDisk), 0);
    assert!(!inside(&ws, point(0.5, 0.8)));

    // ST-D8: factor 2 accepts the folded arc as one leaf, which ST-O1 rejects in the hand-off.
    let mut ws = with_defect(workspace(), |defects| defects.leaf_factor_two = true);
    assert_eq!(
        run(&mut ws, &cubic(FOLDED_ARC), arc_request),
        StrokeOutcome::Mesh
    );
    assert_eq!(count(&ws, PieceKind::CubicLeaf), 1);
    assert_eq!(ws.pieces()[0].meta.depth, 0);
}
