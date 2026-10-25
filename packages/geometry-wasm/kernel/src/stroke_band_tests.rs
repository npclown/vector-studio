//! D9 rendering-track item E2, unit E2-U2 (`docs/plans/d9-e2-stroke-fast-rung-contract.md`,
//! sections 5 and 8): the band leaf rule E2-K2 on its own (the full-cone restriction, the fold
//! and chord predicates behind the seeded defects E2-D2 and E2-D3), the fold control E2-F4f,
//! and the two hand-built seam-merge cases E2-U1 left open (a `C` outside its seam and a side
//! edge; a `-0.0` band corner next to a hull neighbour). ST-O1 on the dumps of these cases runs
//! in `tests/geometry/stroke-oracle.test.ts`.

use core::cmp::Ordering;

use crate::fill_predicates::orient2d;
use crate::geometry::Point;
use crate::stroke_cubic::{measure_band, BandRule, LeafContext};
use crate::stroke_merge::SeamMerge;
use crate::stroke_merge_tests::{workspace, Rev};
use crate::stroke_outline::{
    Piece, PieceKind, PieceMeta, StrokeCap, StrokeDefects, StrokeJoin, StrokeOutcome,
    StrokeWorkspace, Triple,
};
use crate::stroke_outline_tests::{request, PathSpec};

fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}

// ---- The predicate ----

/// A full-cone interior leaf at depth 0 of a source segment (`magnitude` is its largest
/// control coordinate), tolerance `2^-3`, no `g_off`.
fn context(magnitude: f64, r: f64) -> LeafContext {
    LeafContext {
        magnitude,
        r,
        full: 0.125,
        g_off: 0.0,
        split_range: false,
        stationary_start: false,
        stationary_end: false,
        start_error: 0.0,
        end_fixed: false,
        split_length: 0.0,
        factor: 4.0,
    }
}

/// A gentle arc of turning about 2.3 degrees, scaled by `scale`: `|C''| / |C'|^2` is about
/// `0.0133 / scale`, the control-polygon length about `3 scale`.
fn arc(scale: f64) -> [Point; 4] {
    [(0.0, 0.0), (1.0, 0.0), (2.0, 0.02), (3.0, 0.06)].map(|(x, y)| point(x * scale, y * scale))
}

fn band(q: [Point; 4], context: LeafContext, rule: BandRule) -> bool {
    measure_band(q, 0, context, rule).accepted
}

/// E2-K2 is defined only on a leaf with the full cone set: a stationary end or a split range
/// is left to section 4.5, whatever the bound.
#[test]
fn e2_k2_needs_the_full_cone_set() {
    let q = arc(1.0);
    let clean = context(3.0, 1.0);
    assert!(band(q, clean, BandRule::PRODUCTION));
    for reduced in [
        LeafContext {
            stationary_start: true,
            ..clean
        },
        LeafContext {
            stationary_end: true,
            ..clean
        },
        LeafContext {
            split_range: true,
            ..clean
        },
    ] {
        assert!(!band(q, reduced, BandRule::PRODUCTION), "{reduced:?}");
    }
}

/// E2-D2 as a predicate: `r Kup` above 1/2 is refused in production. Without the fold test the
/// same leaf is accepted, both with `1/2 < r Kup < 1` (where `KO` and `lO` still bound) and with
/// `r Kup > 1`, where `1 - r Kup < 0` makes the chord bound negative.
#[test]
fn e2_d2_fold_predicate() {
    let q = arc(1.0);
    let no_fold = BandRule {
        fold_check: false,
        ..BandRule::PRODUCTION
    };
    assert!(
        band(q, context(3.0, 30.0), BandRule::PRODUCTION),
        "r Kup about 0.40"
    );
    for r in [40.0, 100.0] {
        assert!(!band(q, context(3.0, r), BandRule::PRODUCTION), "r = {r}");
        assert!(band(q, context(3.0, r), no_fold), "E2-D2 at r = {r}");
    }
}

/// E2-D3 as a predicate: the arc at scale 12 has a chord bound of about 0.18 against a
/// tolerance of 0.125; halving the bound accepts it.
#[test]
fn e2_d3_halved_chord_predicate() {
    let q = arc(12.0);
    let half = BandRule {
        bound_scale: 0.5,
        ..BandRule::PRODUCTION
    };
    assert!(!band(q, context(36.0, 1.0), BandRule::PRODUCTION));
    assert!(band(q, context(36.0, 1.0), half));
    assert!(band(arc(6.0), context(18.0, 1.0), BandRule::PRODUCTION));
}

// ---- E2-F4f and E2-F3 through the front end ----

/// E2-F4f (contract section 8): `M 0 0 C 6 4 34 4 40 0`, width 12, butt, `e = -3`. The
/// depth-0 leaf's band quad is strictly convex (its end normal segments do not cross), while
/// the sampled maximum of `r kappa` is about 1.195 (`docs/evidence/e2-u2-2026-10-25.md`).
pub(crate) fn f4f() -> PathSpec {
    PathSpec::new()
        .m(0.0, 0.0)
        .c([6.0, 4.0, 34.0, 4.0, 40.0, 0.0])
}

fn leaf_depths(ws: &StrokeWorkspace) -> Vec<u32> {
    ws.pieces()
        .iter()
        .filter(|piece| piece.kind == PieceKind::CubicLeaf)
        .map(|piece| piece.meta.depth)
        .collect()
}

fn build(ws: &mut StrokeWorkspace, path: &PathSpec, width: f64) -> StrokeOutcome {
    ws.build(
        request(width, StrokeCap::Butt, StrokeJoin::Miter, 4.0, -3),
        &path.verbs,
        &path.bytes(),
    )
    .expect("no self-check failure")
}

/// E2-F4f: production refuses the folded depth-0 leaf and meshes from deeper leaves; E2-D2
/// accepts it as one leaf (which ST-O1 rejects in the hand-off).
#[test]
fn e2_f4f_fold_control() {
    let path = f4f();
    let mut ws = workspace(Rev::R6);
    assert_eq!(build(&mut ws, &path, 12.0), StrokeOutcome::Mesh);
    let depths = leaf_depths(&ws);
    assert_eq!(depths.len(), 112);
    assert!(depths.iter().all(|&depth| depth >= 3), "{depths:?}");
    let mut defective = workspace(Rev::R6);
    defective.defects_mut().band_no_fold = true;
    assert_eq!(build(&mut defective, &path, 12.0), StrokeOutcome::Mesh);
    assert_eq!(leaf_depths(&defective), [0]);
}

/// E2-D3 (the chord bound halved) leaves E2-F3's leaf set unchanged: its depth-5 leaves have a
/// bound margin below 2, so the halved bound accepts no depth-4 leaf (recorded, like ST-D8's
/// named case). On E2-F8 it accepts fewer, larger leaves, which ST-O1 rejects in the hand-off.
#[test]
fn e2_d3_leaf_sets() {
    let (r, k) = (256.0, 256.0 * 0.552_284_749_8);
    let circle = PathSpec::new()
        .m(r, 0.0)
        .c([r, k, k, r, 0.0, r])
        .c([-k, r, -r, k, -r, 0.0])
        .c([-r, -k, -k, -r, 0.0, -r])
        .c([k, -r, r, -k, r, 0.0])
        .z();
    let eight = PathSpec::new()
        .m(0.0, 0.0)
        .c([60.0, 60.0, 60.0, -60.0, 0.0, 0.0])
        .c([-60.0, 60.0, -60.0, -60.0, 0.0, 0.0])
        .z();
    let mut counts = Vec::new();
    for (path, width) in [(&circle, 16.0), (&eight, 1.0)] {
        let mut ws = workspace(Rev::R6);
        assert_eq!(build(&mut ws, path, width), StrokeOutcome::Mesh);
        let mut defective = workspace(Rev::R6);
        defective.defects_mut().band_half_bound = true;
        assert_eq!(build(&mut defective, path, width), StrokeOutcome::Mesh);
        counts.push((leaf_depths(&ws), leaf_depths(&defective)));
    }
    assert_eq!(counts[0].0.len(), 128);
    assert_eq!(counts[0].0, counts[0].1, "E2-F3 unchanged under E2-D3");
    assert_eq!((counts[1].0.len(), counts[1].1.len()), (88, 60), "E2-F8");
}

// ---- Hand-built seam-merge cases left open by E2-U1 ----

fn triple(minus: Point, center: Point, plus: Point) -> Triple {
    Triple {
        minus,
        center,
        plus,
    }
}

fn piece(kind: PieceKind, samples: [Triple; 2], start: usize, count: usize) -> Piece {
    Piece {
        kind,
        segment: 0,
        t0: 0.0,
        t1: 1.0,
        start,
        count,
        disk_vertices: 0,
        dropped: false,
        extra: [Point::default(); 3],
        extra_count: 0,
        meta: PieceMeta {
            samples,
            ..PieceMeta::default()
        },
    }
}

fn merged(pieces: &[Piece], hulls: &[Point]) -> SeamMerge {
    let mut merge = SeamMerge::reserve().expect("the seam merge reserves");
    merge
        .merge(pieces, hulls, StrokeDefects::default())
        .expect("the merge runs");
    merge
}

fn twice_area(merge: &SeamMerge) -> f64 {
    merge
        .contours()
        .map(|contour| {
            (0..contour.len())
                .map(|i| {
                    let (a, b) = (contour[i], contour[(i + 1) % contour.len()]);
                    a.x * b.y - a.y * b.x
                })
                .sum::<f64>()
        })
        .sum()
}

/// The S1 case: the end sample `C = (11, -2)` of a band piece is strictly outside its seam and
/// strictly outside the side edge `E-(a) -> E-(b)`. Its band neighbour shares the seam triple
/// and its quad holds `C`, yet `C` stays a vertex: dropping it would lose the part of the
/// triangle `E-, C, E+` outside the side edge, which no neighbour covers.
#[test]
fn e2_s1_sample_outside_seam_and_side_edge_is_kept() {
    let c = point(11.0, -2.0);
    let a = triple(point(0.0, -1.0), point(0.0, 0.0), point(0.0, 1.0));
    let b = triple(point(10.0, -1.0), c, point(10.0, 1.0));
    let end = triple(point(14.0, -9.0), point(17.0, -4.0), point(20.0, 1.0));
    let pieces = [
        piece(PieceKind::CubicLeaf, [a, b], 0, 0),
        piece(PieceKind::CubicLeaf, [b, end], 0, 0),
    ];
    let neighbour = [b.minus, end.minus, end.plus, b.plus];
    for index in 0..4 {
        let next = (index + 1) % 4;
        assert_eq!(
            orient2d(neighbour[index], neighbour[next], c).ok(),
            Some(Ordering::Greater),
            "C strictly inside the neighbour's quad"
        );
    }
    let merge = merged(&pieces, &[]);
    let polygons: Vec<Vec<Point>> = merge.polygons().map(|(_, p)| p.to_vec()).collect();
    assert!(polygons[0].contains(&c), "{:?}", polygons[0]);
    // The first polygon is the hull of its quad and C: (10, -1) is interior to it.
    assert!(!polygons[0].contains(&point(10.0, -1.0)));
    assert!(
        !polygons[1].contains(&c),
        "C strictly inside the neighbour is no vertex"
    );
}

/// A band piece whose start triple carries `-0.0` next to a square-cap hull stored with
/// `+0.0`: the two shared edges (through the sample `C`, which lies on the seam and so stays a
/// vertex of both) cancel bit for bit, leaving one contour of the union's area.
#[test]
fn e2_negative_zero_band_corner_cancels_against_a_hull_neighbour() {
    let a = triple(point(-0.0, -1.0), point(-0.0, 0.0), point(-0.0, 1.0));
    let b = triple(point(10.0, -1.0), point(10.0, 0.0), point(10.0, 1.0));
    let cap = [
        point(-1.0, -1.0),
        point(0.0, -1.0),
        point(0.0, 0.0),
        point(0.0, 1.0),
        point(-1.0, 1.0),
    ];
    let pieces = [
        piece(PieceKind::SquareCap, [Triple::default(); 2], 0, 5),
        piece(PieceKind::LineSweep, [a, b], 0, 0),
    ];
    let merge = merged(&pieces, &cap);
    assert_eq!(merge.cancelled_pairs(), 2);
    assert_eq!(merge.contour_total(), 1);
    assert_eq!(twice_area(&merge), 44.0);
    for contour in merge.contours() {
        assert!(contour
            .iter()
            .all(|p| p.x.to_bits() != (-0.0f64).to_bits() && p.y.to_bits() != (-0.0f64).to_bits()));
    }
}
