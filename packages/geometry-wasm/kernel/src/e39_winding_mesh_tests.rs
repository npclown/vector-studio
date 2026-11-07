//! D9 rendering-track item E39 (`docs/plans/d9-e39-gpu-stencil-path-contract.md`): winding
//! meshes for fills (a fan per subpath, K1), union meshes for strokes (the E38 pieces fanned,
//! K2), the size bound (K4), the winding bound and its fallback (K5) and the export record
//! (K6). A child module of the E38 tests, whose corpus, fuzz paths and oracles it reuses.

use super::*;
use crate::fill_export::{COVERAGE_PARTITION, COVERAGE_WINDING};
use crate::robust_mesh::{WindingFill, MAX_WINDING_VERTICES, WINDING_FALLBACK};

/// The fill engine and stroke workspace as in production: winding and union meshes (opt-in in
/// tests).
fn winding_production() -> (FillEngine, StrokeWorkspace) {
    let (mut fill, mut stroke) = production();
    fill.hooks().winding = true;
    stroke.defects_mut().winding = true;
    (fill, stroke)
}

fn orientation(vertices: &[Point], t: &[u32]) -> f64 {
    let (a, b, c) = (
        vertices[t[0] as usize],
        vertices[t[1] as usize],
        vertices[t[2] as usize],
    );
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

/// The signed count of the mesh's triangles at `q` (the stencil pass's winding count).
fn count_at(vertices: &[Point], triangles: &[u32], q: Point) -> i32 {
    triangles
        .chunks_exact(3)
        .filter(|t| inside_triangle(vertices, t, q))
        .map(|t| {
            if orientation(vertices, t) > 0.0 {
                1
            } else {
                -1
            }
        })
        .sum()
}

/// E39-A2: `samples` seeded points; a winding mesh passes `rule` on its signed count, a union
/// mesh covers the point, exactly when the oracle says inside. Returns the points checked,
/// the mismatches and the largest absolute count seen.
#[allow(clippy::too_many_arguments)]
fn compare_counts(
    rng: &mut Rng,
    path: &PathSpec,
    grow: f64,
    samples: usize,
    vertices: &[Point],
    triangles: &[u32],
    rule: Option<LineFillRule>,
    oracle: &Oracle<'_>,
) -> (usize, Vec<Point>, i32) {
    let (x0, y0, x1, y1) = bounds(path);
    let mut checked = 0;
    let mut wrong = Vec::new();
    let mut deepest = 0;
    for _ in 0..samples {
        let q = Point {
            x: rng.range(x0 - grow, x1 + grow),
            y: rng.range(y0 - grow, y1 + grow),
        };
        let count = count_at(vertices, triangles, q);
        deepest = deepest.max(count.abs());
        let Some(expected) = oracle(q) else { continue };
        checked += 1;
        let painted = match rule {
            Some(LineFillRule::Nonzero) => count != 0,
            Some(LineFillRule::Evenodd) => count & 1 != 0,
            None => covered(vertices, triangles, q),
        };
        if painted != expected {
            wrong.push(q);
        }
    }
    (checked, wrong, deepest)
}

/// E39-A1 on `paths` at `exponents`: fill (nonzero) and stroke (width 1, butt, miter 4)
/// through the production entry points; every build is a mesh, a winding fill or a union
/// stroke, matching the reference at `samples` seeded points. Returns the fills that fell back
/// to a partition mesh (K5).
fn check_winding_paths(paths: &[(String, PathSpec)], exponents: &[i32], samples: usize) -> usize {
    let (mut fill, mut stroke) = winding_production();
    let mut rng = Rng(0x0E39_0001);
    let mut fallbacks = 0;
    for (name, path) in paths {
        let (lines, reference_error) = reference_with_error(path);
        for &e in exponents {
            let tol = 2f64.powi(e - 1);
            let margin = 4.0 * tol + 2.0 * reference_error + 1e-9;
            let record = built(&mut fill, path, LineFillRule::Nonzero, e);
            assert_eq!(record.outcome, PathOutcome::Mesh, "{name} e={e} fill");
            assert!(record.robust, "{name} e={e} fill: no ladder in production");
            let (vertices, triangles, boundary) = fill.scratch_robust_mesh();
            assert!(boundary.is_empty());
            let rule = if record.coverage == COVERAGE_WINDING {
                Some(LineFillRule::Nonzero)
            } else {
                assert_eq!(record.coverage, COVERAGE_PARTITION);
                fallbacks += 1;
                None
            };
            let oracle = fill_oracle(&lines, LineFillRule::Nonzero, margin);
            let (checked, wrong, _) = compare_counts(
                &mut rng, path, 4.0, samples, vertices, triangles, rule, &oracle,
            );
            assert!(checked > samples / 2, "{name} e={e} fill checked {checked}");
            assert!(
                wrong.is_empty(),
                "{name} e={e} fill wrong at {:?}",
                &wrong[..wrong.len().min(4)]
            );
            let outcome = stroke
                .build(
                    request(1.0, StrokeCap::Butt, StrokeJoin::Miter, 4.0, e),
                    &path.verbs,
                    &path.bytes(),
                )
                .expect("no internal error");
            assert_eq!(outcome, StrokeOutcome::Mesh, "{name} e={e} stroke");
            assert!(stroke.union_published(), "{name} e={e} stroke union");
            assert_eq!(stroke.coarsenings(), 0, "{name} e={e} stroke coarsened");
            let (vertices, triangles, boundary) = stroke.mesh().expect("mesh");
            assert!(boundary.is_empty());
            let oracle = stroke_oracle(
                &lines,
                0.5,
                StrokeCap::Butt,
                StrokeJoin::Miter,
                4.0,
                margin.max(0.05),
            );
            let (checked, wrong, _) = compare_counts(
                &mut rng, path, 4.0, samples, vertices, triangles, None, &oracle,
            );
            assert!(checked > 0, "{name} e={e} stroke checked {checked}");
            assert!(
                wrong.is_empty(),
                "{name} e={e} stroke wrong at {:?}",
                &wrong[..wrong.len().min(4)]
            );
        }
    }
    fallbacks
}

/// E39-A1 (CI part): node-5 and node-7 at the editor's exponents.
#[test]
fn e39_user_node5_node7_draw_as_winding_meshes() {
    let paths: Vec<(String, PathSpec)> = corpus()
        .into_iter()
        .filter(|(name, _)| name == "node-5b" || name == "node-7b")
        .collect();
    assert_eq!(check_winding_paths(&paths, &[-3, -4], 150), 0);
}

/// E39-A1 (evidence): every corpus path at `e = 0` to `-8`.
#[test]
#[ignore = "E39 evidence, run by hand in release"]
fn e39_user_paths_always_draw() {
    let fallbacks = check_winding_paths(&corpus(), &[0, -1, -2, -3, -4, -5, -6, -7, -8], 600);
    println!("fills on the partition fallback: {fallbacks}");
}

/// E39-A2 and K5: a seeded fuzz of pen-like paths straight through the builds, every rule,
/// cap and join; the winding bound covers every count seen.
fn fuzz_winding(seed: u64, cases: usize, max_size: f64, samples: usize) {
    let mut rng = Rng(seed);
    let mut mesh = RobustMesh::new();
    mesh.reserve().expect("reserve");
    let caps = [StrokeCap::Butt, StrokeCap::Round, StrokeCap::Square];
    let joins = [StrokeJoin::Miter, StrokeJoin::Round, StrokeJoin::Bevel];
    for case in 0..cases {
        let size = rng.range(20.0, max_size);
        let closed = rng.next().is_multiple_of(2);
        let path = pen_path(&mut rng, size, closed);
        let (lines, reference_error) = reference_with_error(&path);
        let e = -((rng.next() % 9) as i32);
        let tol = 2f64.powi(e - 1);
        let margin = 4.0 * tol + 2.0 * reference_error + 1e-9 * size;
        let bytes = path.bytes();
        let rule = if rng.next().is_multiple_of(2) {
            LineFillRule::Nonzero
        } else {
            LineFillRule::Evenodd
        };
        let outcome = mesh.build_fill_winding(&path.verbs, &bytes, tol);
        assert!(
            outcome == WindingFill::Mesh || outcome == WindingFill::Empty,
            "case {case} fill {outcome:?} stats {:?}",
            mesh.stats
        );
        assert_eq!(mesh.stats.coarsenings, 0, "case {case} fill coarsened");
        let bound = mesh.stats.winding_bound;
        let (vertices, triangles, boundary) = mesh.mesh();
        assert!(boundary.is_empty());
        let oracle = fill_oracle(&lines, rule, margin);
        let (_, wrong, deepest) = compare_counts(
            &mut rng,
            &path,
            2.0,
            samples,
            vertices,
            triangles,
            Some(rule),
            &oracle,
        );
        assert!(
            wrong.is_empty(),
            "case {case} fill {rule:?} e={e}: wrong at {:?}",
            &wrong[..wrong.len().min(4)]
        );
        assert!(
            deepest as u32 <= bound,
            "case {case}: count {deepest} over the bound {bound}"
        );
        let r = rng.range(0.5, 8.0);
        let (cap, join) = (
            caps[(rng.next() % 3) as usize],
            joins[(rng.next() % 3) as usize],
        );
        let limit = rng.range(1.0, 10.0);
        let style = RobustStroke {
            width: 2.0 * r,
            cap,
            join,
            miter_limit: limit,
        };
        let drawn = mesh
            .build_stroke_union(&path.verbs, &bytes, style, tol)
            .expect("fits");
        assert!(drawn, "case {case} stroke empty");
        assert_eq!(mesh.stats.coarsenings, 0, "case {case} stroke coarsened");
        let (vertices, triangles, _) = mesh.mesh();
        let oracle = stroke_oracle(&lines, r, cap, join, limit, margin.max(0.02 * r));
        let (checked, wrong, _) = compare_counts(
            &mut rng,
            &path,
            2.0 * r * limit,
            samples,
            vertices,
            triangles,
            None,
            &oracle,
        );
        assert!(
            wrong.is_empty(),
            "case {case} stroke r {r} {cap:?} {join:?} e={e} checked {checked}: wrong at {:?}",
            &wrong[..wrong.len().min(4)]
        );
    }
}

#[test]
fn e39_fuzz_winding_meshes_match_the_reference() {
    fuzz_winding(0x0E39_00F2, 12, 600.0, 120);
}

/// E39-A2 (evidence): 96 cases up to 2,500 px.
#[test]
#[ignore = "E39 evidence, run by hand in release"]
fn e39_fuzz_winding_meshes_match_the_reference_full() {
    fuzz_winding(0x0E39_00F3, 96, 2500.0, 300);
}

/// E39-A3: the production entry points never refuse a fuzzed pen path.
#[test]
fn e39_fuzz_never_refuses() {
    let mut rng = Rng(0x0E39_00A4);
    let (mut fill, mut stroke) = winding_production();
    for case in 0..40 {
        let size = rng.range(200.0, 2000.0);
        let closed = rng.next().is_multiple_of(2);
        let path = pen_path(&mut rng, size, closed);
        let e = -((rng.next() % 9) as i32);
        let record = built(&mut fill, &path, LineFillRule::Nonzero, e);
        assert!(
            record.outcome == PathOutcome::Mesh
                || record.outcome == PathOutcome::Status(FILL_PATH_EMPTY),
            "case {case} e={e} fill {record:?}"
        );
        let outcome = stroke
            .build(
                request(1.0, StrokeCap::Butt, StrokeJoin::Miter, 4.0, e),
                &path.verbs,
                &path.bytes(),
            )
            .expect("no internal error");
        assert_eq!(outcome, StrokeOutcome::Mesh, "case {case} e={e} stroke");
    }
}

/// A star polygon `{n/k}` of radius `r` (all its edges cross); winding numbers up to `k`.
fn star(n: usize, k: usize, r: f64) -> PathSpec {
    let at = |i: usize| {
        let angle = std::f64::consts::TAU * ((i * k) % n) as f64 / n as f64;
        (r * angle.cos(), r * angle.sin())
    };
    let mut path = PathSpec::new().m(at(0).0, at(0).1);
    for i in 1..n {
        path = path.l(at(i).0, at(i).1);
    }
    path.z()
}

/// A spiral of `turns` closed by a straight chord: its centre has winding `turns`.
fn spiral(turns: usize) -> PathSpec {
    let steps = 64 * turns;
    let mut path = PathSpec::new().m(10.0, 0.0);
    for i in 1..=steps {
        let angle = std::f64::consts::TAU * i as f64 / 64.0;
        let r = 10.0 + i as f64 * 0.05;
        path = path.l(r * angle.cos(), r * angle.sin());
    }
    path.z()
}

/// An outlined text row: `glyphs` rings ("o"), each an outer and an inner contour, side by
/// side; true winding at most 1, disjoint boxes.
fn text_row(glyphs: usize) -> PathSpec {
    let ring = |path: PathSpec, cx: f64, r: f64, reverse: bool| {
        let n = 24;
        let at = |i: usize| {
            let t = std::f64::consts::TAU * i as f64 / n as f64;
            let t = if reverse { -t } else { t };
            (cx + r * t.cos(), r * t.sin())
        };
        let mut path = path.m(at(0).0, at(0).1);
        for i in 1..n {
            path = path.l(at(i).0, at(i).1);
        }
        path.z()
    };
    let mut path = PathSpec::new();
    for g in 0..glyphs {
        let cx = 12.0 * g as f64;
        path = ring(path, cx, 5.0, false);
        path = ring(path, cx, 3.0, true);
    }
    path
}

/// E39-K5 and A3: the bound falls back for the E36 star fill and a 130-turn spiral, and not
/// for a 64-glyph text row; the star's stroke is a union mesh, unbounded.
#[test]
fn e39_winding_bound_falls_back_only_when_needed() {
    let mut mesh = RobustMesh::new();
    mesh.reserve().expect("reserve");
    let tol = 2f64.powi(-4);
    let star = star(1001, 500, 300.0);
    let bytes = star.bytes();
    assert_eq!(
        mesh.build_fill_winding(&star.verbs, &bytes, tol),
        WindingFill::TooWound
    );
    assert!(mesh.stats.winding_bound >= WINDING_FALLBACK);
    let spiral = spiral(130);
    assert_eq!(
        mesh.build_fill_winding(&spiral.verbs, &spiral.bytes(), tol),
        WindingFill::TooWound
    );
    let row = text_row(64);
    assert_eq!(
        mesh.build_fill_winding(&row.verbs, &row.bytes(), tol),
        WindingFill::Mesh
    );
    // Two contours per glyph, each bounded by 2 (closed spans count both edges at a vertex's
    // y): far below the fallback, whatever the number of glyphs.
    assert!(mesh.stats.winding_bound <= 4, "{:?}", mesh.stats);
    let small = spiral_bound(&mut mesh, 20, tol);
    assert!(
        (20..WINDING_FALLBACK).contains(&small),
        "spiral 20: {small}"
    );
    let style = RobustStroke {
        width: 1.0,
        cap: StrokeCap::Butt,
        join: StrokeJoin::Miter,
        miter_limit: 4.0,
    };
    assert_eq!(
        mesh.build_stroke_union(&star.verbs, &bytes, style, tol),
        Some(true)
    );
    assert_eq!(mesh.stats.coarsenings, 0);
    // Through the production entry point the star's fill takes the partition fallback.
    let (mut fill, _) = winding_production();
    let record = built(&mut fill, &star, LineFillRule::Nonzero, -3);
    assert_eq!(
        (record.outcome, record.coverage),
        (PathOutcome::Mesh, COVERAGE_PARTITION)
    );
}

fn spiral_bound(mesh: &mut RobustMesh, turns: usize, tol: f64) -> u32 {
    let path = spiral(turns);
    assert_eq!(
        mesh.build_fill_winding(&path.verbs, &path.bytes(), tol),
        WindingFill::Mesh
    );
    mesh.stats.winding_bound
}

/// E39-A3: wide strokes at high zoom and the 1,001-point star stroke build at the requested
/// tolerance; in release each takes under 16 ms (printed for the record).
#[test]
fn e39_wide_strokes_keep_their_tolerance() {
    let mut mesh = RobustMesh::new();
    mesh.reserve().expect("reserve");
    let node5 = user_node5();
    let star = star(1001, 500, 300.0);
    for (name, path, width, e) in [
        ("node-5 w100", &node5, 100.0, -6),
        ("star w1", &star, 1.0, -3),
        ("star w20", &star, 20.0, -3),
    ] {
        let style = RobustStroke {
            width,
            cap: StrokeCap::Round,
            join: StrokeJoin::Round,
            miter_limit: 4.0,
        };
        let start = std::time::Instant::now();
        let drawn = mesh.build_stroke_union(&path.verbs, &path.bytes(), style, 2f64.powi(e - 1));
        let elapsed = start.elapsed();
        println!(
            "{name} e={e}: {:?} vertices {} triangles {} {elapsed:.1?}",
            drawn,
            mesh.mesh().0.len(),
            mesh.mesh().1.len() / 3
        );
        assert_eq!(drawn, Some(true), "{name}");
        assert_eq!(mesh.stats.coarsenings, 0, "{name}");
        assert!(mesh.mesh().0.len() <= MAX_WINDING_VERTICES);
        #[cfg(not(debug_assertions))]
        assert!(elapsed.as_millis() < 16, "{name} took {elapsed:?}");
    }
}

/// E39-A4: a winding or union build allocates nothing.
#[test]
fn e39_build_allocates_nothing() {
    let mut mesh = RobustMesh::new();
    mesh.reserve().expect("reserve");
    let path = user_node7();
    let bytes = path.bytes();
    let star = star(1001, 500, 300.0);
    let star_bytes = star.bytes();
    let row = text_row(64);
    let row_bytes = row.bytes();
    let style = RobustStroke {
        width: 1.0,
        cap: StrokeCap::Round,
        join: StrokeJoin::Round,
        miter_limit: 4.0,
    };
    crate::allocation_test_support::start();
    let fill = mesh.build_fill_winding(&path.verbs, &bytes, 2f64.powi(-9));
    let stroke = mesh.build_stroke_union(&path.verbs, &bytes, style, 2f64.powi(-9));
    let wound = mesh.build_fill_winding(&star.verbs, &star_bytes, 2f64.powi(-4));
    let text = mesh.build_fill_winding(&row.verbs, &row_bytes, 2f64.powi(-4));
    let allocations = crate::allocation_test_support::stop();
    assert_eq!(
        (fill, stroke, wound, text, allocations),
        (
            WindingFill::Mesh,
            Some(true),
            WindingFill::TooWound,
            WindingFill::Mesh,
            0
        )
    );
}

/// E39-K1: the fan of a simple counterclockwise square has two positive triangles from its
/// first point, and its vertices are the flattened points.
#[test]
fn e39_fan_of_a_square() {
    let mut mesh = RobustMesh::new();
    mesh.reserve().expect("reserve");
    let square = PathSpec::new()
        .m(0.0, 0.0)
        .l(10.0, 0.0)
        .l(10.0, 10.0)
        .l(0.0, 10.0)
        .z();
    assert_eq!(
        mesh.build_fill_winding(&square.verbs, &square.bytes(), 0.5),
        WindingFill::Mesh
    );
    let (vertices, triangles, boundary) = mesh.mesh();
    assert_eq!(vertices.len(), 4);
    assert_eq!(triangles, &[0, 1, 2, 0, 2, 3]);
    assert!(boundary.is_empty());
    assert!(triangles
        .chunks_exact(3)
        .all(|t| orientation(vertices, t) > 0.0));
    assert_eq!(mesh.stats.winding_bound, 1);
}
