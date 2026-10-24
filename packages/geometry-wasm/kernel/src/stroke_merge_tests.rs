//! D9 rendering-track item E2, unit E2-U1 (`docs/plans/d9-e2-stroke-fast-rung-contract.md`,
//! sections 4, 7 and 8): the fixture table E2-F1 to E2-F8 at `stroke-v0+r5` beside the `r4`
//! input (the A/B switch `unmerged`), the lossless-merge check E2-A4 on every fixture, the
//! seeded defect E2-D1, storage, determinism and allocation, and the ignored differential that
//! runs E2-G1, E2-G2 and E2-A4 over the E11-U2 scene, the corpus E1-C1 and the ST-U3b families.
//!
//! The ignored differential runs by hand, in the release profile, with one test thread:
//!
//! ```text
//! node tooling/p3-stroke-e1-corpus.mjs c1 <e1-c1.txt>
//! E2_SCENE=<scene.txt> P3_E1_CORPUS=<e1-c1.txt> cargo test --release --lib \
//!     stroke_merge_tests::e2_differential -- --ignored --nocapture --test-threads 1
//! ```
//!
//! `scene.txt` is the E11-U2 scene `p3-exit-stress/v1` written by the dump in
//! `docs/evidence/e2-u1-2026-10-24/dump_scene_lines.test.ts.txt`. Either variable may be left
//! out; its part is then skipped and the run says so.

use core::cmp::Ordering;
use std::collections::HashMap;
use std::env;
use std::time::Instant;

use crate::fill_predicates::orient2d;
use crate::geometry::Point;
use crate::rounded_line_fill::RoundedFillError;
use crate::stroke_early_abort_tests::read_corpus;
use crate::stroke_merge::MAX_POLYGON_POINTS;
use crate::stroke_outline::{
    FrontEndError, Piece, PieceKind, StrokeCap, StrokeError, StrokeJoin, StrokeOutcome,
    StrokeRequest, StrokeWorkspace, MAX_PIECES, MAX_PIECE_POINTS, STROKE_PATH_NUMERIC_RANGE,
    STROKE_PATH_UNSUPPORTED_GEOMETRY, STROKE_PATH_WORK_LIMIT, STROKE_V0_HEAP_CAP, STROKE_V0_LIMITS,
};
use crate::stroke_outline_tests::{request, PathSpec};
use crate::stroke_probe_tests::{polyline, Family, SEGMENTS};

/// The four-cubic circle constant of the cause record's `circles.py`.
const CIRCLE_K: f64 = 0.552_284_749_8;
const BUTT: StrokeCap = StrokeCap::Butt;
const MITER: StrokeJoin = StrokeJoin::Miter;

/// `M R 0`, four quarter cubics, `Z`; every knot and the closing seam are exact continuations.
fn circle(radius: f64) -> PathSpec {
    let (r, k) = (radius, radius * CIRCLE_K);
    PathSpec::new()
        .m(r, 0.0)
        .c([r, k, k, r, 0.0, r])
        .c([-k, r, -r, k, -r, 0.0])
        .c([-r, -k, -k, -r, 0.0, -r])
        .c([k, -r, r, -k, r, 0.0])
        .z()
}

fn square(side: f64) -> PathSpec {
    PathSpec::new()
        .m(0.0, 0.0)
        .l(side, 0.0)
        .l(side, side)
        .l(0.0, side)
        .z()
}

/// Open two-cubic S curve; the knot `(50, 50)` is an exact continuation along `(0, 30)`.
fn s_curve() -> PathSpec {
    PathSpec::new()
        .m(0.0, 0.0)
        .c([30.0, 0.0, 50.0, 20.0, 50.0, 50.0])
        .c([50.0, 80.0, 70.0, 100.0, 100.0, 100.0])
}

fn figure_eight() -> PathSpec {
    PathSpec::new()
        .m(0.0, 0.0)
        .c([60.0, 60.0, 60.0, -60.0, 0.0, 0.0])
        .c([-60.0, 60.0, -60.0, -60.0, 0.0, 0.0])
        .z()
}

/// A single butt-capped line whose end sample `C` lies strictly outside its band quad, across
/// the end seam, with no neighbour: the E2-D1 fixture (the first hit of a scratch search over
/// short lines with decimal coordinates; `e2_d1_dropped_outside_sample_is_caught` asserts it).
fn outside_end() -> PathSpec {
    PathSpec::new().m(0.1, 0.3).l(10.7, 3.3)
}

fn status_of(outcome: StrokeOutcome) -> u32 {
    match outcome {
        StrokeOutcome::Mesh => 0,
        StrokeOutcome::Status(status) => status,
    }
}

fn workspace(unmerged: bool) -> StrokeWorkspace {
    let mut workspace = StrokeWorkspace::new().expect("the stroke workspace reserves");
    workspace.defects_mut().unmerged = unmerged;
    workspace
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Observation {
    status: u32,
    error: Option<StrokeError>,
    pieces: usize,
    contours: usize,
    vertices: usize,
}

fn observe(
    ws: &mut StrokeWorkspace,
    verbs: &[u8],
    bytes: &[u8],
    request: StrokeRequest,
) -> Observation {
    let outcome = ws
        .build(request, verbs, bytes)
        .expect("no self-check failure");
    Observation {
        status: status_of(outcome),
        error: ws.last_error(),
        pieces: ws.pieces().iter().filter(|piece| !piece.dropped).count(),
        contours: ws.merge().contour_total(),
        vertices: ws.merge().vertex_total(),
    }
}

// ---- E2-A4: the lossless-merge check ----

type Key = (u64, u64);

fn key(point: Point) -> Key {
    (point.x.to_bits(), point.y.to_bits())
}

fn sign(a: Point, b: Point, c: Point) -> Ordering {
    orient2d(a, b, c).expect("finite")
}

fn plus_zero(point: Point) -> Point {
    Point {
        x: point.x + 0.0,
        y: point.y + 0.0,
    }
}

/// An independent band test (contract section 3): a sweep piece whose band quad is strictly
/// convex and positive.
fn band_of(piece: &Piece) -> Option<[Point; 4]> {
    if piece.dropped || !matches!(piece.kind, PieceKind::LineSweep | PieceKind::CubicLeaf) {
        return None;
    }
    let [a, b] = piece.meta.samples;
    let quad = [a.minus, b.minus, b.plus, a.plus].map(plus_zero);
    (0..4)
        .all(|i| sign(quad[i], quad[(i + 1) % 4], quad[(i + 2) % 4]) == Ordering::Greater)
        .then_some(quad)
}

fn strictly_inside(quad: &[Point; 4], point: Point) -> bool {
    (0..4).all(|i| sign(quad[i], quad[(i + 1) % 4], point) == Ordering::Greater)
}

fn in_closed(polygon: &[Point], point: Point) -> bool {
    (0..polygon.len())
        .all(|i| sign(polygon[i], polygon[(i + 1) % polygon.len()], point) != Ordering::Less)
}

fn same_triple(a: &crate::stroke_outline::Triple, b: &crate::stroke_outline::Triple) -> bool {
    [a.minus, a.center, a.plus]
        .iter()
        .zip([b.minus, b.center, b.plus].iter())
        .all(|(x, y)| key(*x) == key(*y))
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct A4Counts {
    band: usize,
    inside: usize,
    kept: usize,
    dropped: usize,
    cancelled: usize,
    points: usize,
}

impl A4Counts {
    fn add(&mut self, other: Self) {
        self.band += other.band;
        self.inside += other.inside;
        self.kept += other.kept;
        self.dropped += other.dropped;
        self.cancelled += other.cancelled;
        self.points += other.points;
    }
}

/// Exact winding number of closed polygons at `point`, or `None` when `point` is on an edge.
fn winding<'a>(polygons: impl Iterator<Item = &'a [Point]>, point: Point) -> Option<i64> {
    let mut total = 0i64;
    for polygon in polygons {
        for i in 0..polygon.len() {
            let (a, b) = (polygon[i], polygon[(i + 1) % polygon.len()]);
            let side = sign(a, b, point);
            if side == Ordering::Equal
                && point.x >= a.x.min(b.x)
                && point.x <= a.x.max(b.x)
                && point.y >= a.y.min(b.y)
                && point.y <= a.y.max(b.y)
            {
                return None;
            }
            if a.y <= point.y {
                if b.y > point.y && side == Ordering::Greater {
                    total += 1;
                }
            } else if b.y <= point.y && side == Ordering::Less {
                total -= 1;
            }
        }
    }
    Some(total)
}

/// Deterministic sample points in the pieces' bounding box (a 64-bit LCG).
fn seeded_points(ws: &StrokeWorkspace, count: usize) -> Vec<Point> {
    let mut bounds = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    for piece in ws.pieces().iter().filter(|piece| !piece.dropped) {
        for point in ws.piece_points(piece).expect("stored") {
            bounds = [
                bounds[0].min(point.x),
                bounds[1].min(point.y),
                bounds[2].max(point.x),
                bounds[3].max(point.y),
            ];
        }
    }
    let mut state = 0x9e37_79b9_7f4a_7c15u64;
    let mut unit = || {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (state >> 11) as f64 / (1u64 << 53) as f64
    };
    (0..count)
        .map(|_| Point {
            x: bounds[0] + (bounds[2] - bounds[0]) * unit(),
            y: bounds[1] + (bounds[3] - bounds[1]) * unit(),
        })
        .collect()
}

/// E2-A4 on the last build of `ws` (which must have reached the merge): (i) the exact
/// structural check, (ii) equal winding numbers of the contours and of the hull pieces at the
/// seeded points and at `extra` (the centroids of the `r4` mesh's triangles).
fn lossless(ws: &StrokeWorkspace, seeded: usize, extra: &[Point]) -> Result<A4Counts, String> {
    let merge = ws.merge();
    let pieces = ws.pieces();
    let mut counts = A4Counts::default();
    let emitted: Vec<usize> = (0..pieces.len()).filter(|&i| !pieces[i].dropped).collect();
    let polygons: Vec<(usize, &[Point])> = merge.polygons().collect();
    if polygons.iter().map(|polygon| polygon.0).collect::<Vec<_>>() != emitted {
        return Err("step-1 polygons are not the emitted pieces in order".into());
    }
    let mut step1: HashMap<(Key, Key), i64> = HashMap::new();
    for &(record, polygon) in &polygons {
        let piece = &pieces[record];
        for i in 0..polygon.len() {
            *step1
                .entry((key(polygon[i]), key(polygon[(i + 1) % polygon.len()])))
                .or_default() += 1;
        }
        let Some(quad) = band_of(piece) else {
            if Some(polygon) != ws.piece_points(piece) {
                return Err(format!(
                    "piece {record}: a non-band polygon differs from its hull"
                ));
            }
            continue;
        };
        counts.band += 1;
        // Convex, positive, distinct vertices, all from the quad and the two samples C.
        let n = polygon.len();
        let convex = n >= 3
            && (0..n).all(|i| {
                sign(polygon[i], polygon[(i + 1) % n], polygon[(i + 2) % n]) != Ordering::Less
            })
            && (0..n).any(|i| {
                sign(polygon[i], polygon[(i + 1) % n], polygon[(i + 2) % n]) == Ordering::Greater
            });
        let mut keys: Vec<Key> = polygon.iter().map(|point| key(*point)).collect();
        keys.sort_unstable();
        keys.dedup();
        if !convex || keys.len() != n {
            return Err(format!(
                "piece {record}: step-1 polygon not convex and positive"
            ));
        }
        let [a, b] = piece.meta.samples;
        let allowed: Vec<Key> = quad
            .iter()
            .chain([a.center, b.center].iter())
            .map(|p| key(plus_zero(*p)))
            .collect();
        if polygon.iter().any(|point| !allowed.contains(&key(*point))) {
            return Err(format!(
                "piece {record}: a vertex is not a quad vertex or a sample C"
            ));
        }
        if quad.iter().any(|corner| !in_closed(polygon, *corner)) {
            return Err(format!(
                "piece {record}: the polygon does not hold its quad"
            ));
        }
        let seams = [(a, 3usize, 1usize), (b, 1usize, 0usize)];
        for (sample, seam, side) in seams {
            let c = plus_zero(sample.center);
            let vertex = polygon.iter().any(|point| key(*point) == key(c));
            if strictly_inside(&quad, c) {
                if vertex {
                    return Err(format!("piece {record}: a C strictly inside is a vertex"));
                }
                counts.inside += 1;
            } else if vertex {
                counts.kept += 1;
            } else {
                // Dropped: strictly outside its seam, outside no other edge (so the dropped part
                // is the triangle E-, C, E+), and inside a band neighbour's quad that shares the
                // whole seam triple from the other side.
                let outside =
                    |index: usize| sign(quad[index], quad[(index + 1) % 4], c) == Ordering::Less;
                if !outside(seam) || (0..4).any(|index| index != seam && outside(index)) {
                    return Err(format!(
                        "piece {record}: a dropped C is not strictly outside its seam alone"
                    ));
                }
                let covered = pieces.iter().enumerate().any(|(other, neighbour)| {
                    other != record
                        && same_triple(&neighbour.meta.samples[side], &sample)
                        && band_of(neighbour).is_some_and(|q| in_closed(&q, c))
                });
                if !covered {
                    return Err(format!("piece {record}: a dropped C has no covering quad"));
                }
                counts.dropped += 1;
            }
        }
    }
    // The merged edge multiset is the step-1 multiset minus the opposite pairs.
    let mut expected = step1.clone();
    for (&(from, to), &count) in &step1 {
        if from < to {
            let back = step1.get(&(to, from)).copied().unwrap_or(0);
            let pairs = count.min(back);
            counts.cancelled += pairs as usize;
            *expected.get_mut(&(from, to)).expect("present") -= pairs;
            if let Some(entry) = expected.get_mut(&(to, from)) {
                *entry -= pairs;
            }
        }
    }
    expected.retain(|_, count| *count != 0);
    let mut merged: HashMap<(Key, Key), i64> = HashMap::new();
    for contour in merge.contours() {
        for i in 0..contour.len() {
            *merged
                .entry((key(contour[i]), key(contour[(i + 1) % contour.len()])))
                .or_default() += 1;
        }
    }
    if merged != expected {
        return Err("the merged edges are not the step-1 edges minus the cancelled pairs".into());
    }
    if counts.cancelled != merge.cancelled_pairs() {
        return Err("cancelled pair count differs".into());
    }
    // (ii) Winding numbers, exactly.
    let hulls = || {
        pieces
            .iter()
            .filter(|piece| !piece.dropped)
            .map(|piece| ws.piece_points(piece).expect("stored"))
    };
    for point in seeded_points(ws, seeded).iter().chain(extra) {
        let (Some(left), Some(right)) =
            (winding(merge.contours(), *point), winding(hulls(), *point))
        else {
            continue;
        };
        if left != right {
            return Err(format!("winding {left} != {right} at {point:?}"));
        }
        counts.points += 1;
    }
    Ok(counts)
}

/// The centroids of the triangles of the last mesh of `ws`, if it published one.
fn centroids(ws: &StrokeWorkspace) -> Vec<Point> {
    let Some((vertices, triangles, _)) = ws.mesh() else {
        return Vec::new();
    };
    triangles
        .chunks_exact(3)
        .map(|t| {
            let [a, b, c] = [
                vertices[t[0] as usize],
                vertices[t[1] as usize],
                vertices[t[2] as usize],
            ];
            Point {
                x: (a.x + b.x + c.x) / 3.0,
                y: (a.y + b.y + c.y) / 3.0,
            }
        })
        .collect()
}

// ---- E2-F1 to E2-F8 ----

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Expected {
    Ok,
    WorkLimit,
    /// Recorded by E2-U1; a later unit fixes the expectation.
    Recorded,
}

struct Fixture {
    name: &'static str,
    path: PathSpec,
    request: StrokeRequest,
    r4: (u32, Option<StrokeError>),
    r5: Expected,
}

fn fixtures() -> Vec<Fixture> {
    let at = |width: f64, cap: StrokeCap| request(width, cap, MITER, 4.0, -3);
    let input = Some(StrokeError::Rounded(RoundedFillError::InputLimit));
    let pieces = Some(StrokeError::Front(FrontEndError::PieceLimit));
    let work = STROKE_PATH_WORK_LIMIT;
    vec![
        Fixture {
            name: "E2-F1",
            path: circle(64.0),
            request: at(1.0, BUTT),
            r4: (0, None),
            r5: Expected::Ok,
        },
        Fixture {
            name: "E2-F2",
            path: circle(64.0),
            request: at(4.0, BUTT),
            r4: (work, input),
            r5: Expected::Ok,
        },
        Fixture {
            name: "E2-F3",
            path: circle(256.0),
            request: at(16.0, BUTT),
            r4: (work, pieces),
            r5: Expected::WorkLimit,
        },
        Fixture {
            name: "E2-F4",
            path: circle(16.0),
            request: at(16.0, BUTT),
            r4: (work, pieces),
            r5: Expected::WorkLimit,
        },
        Fixture {
            name: "E2-F5",
            path: circle(1024.0),
            request: at(1.0, BUTT),
            r4: (work, input),
            r5: Expected::Ok,
        },
        Fixture {
            name: "E2-F6",
            path: square(100.0),
            request: at(4.0, BUTT),
            r4: (0, None),
            r5: Expected::Ok,
        },
        Fixture {
            name: "E2-F7",
            path: s_curve(),
            request: at(4.0, BUTT),
            r4: (0, None),
            r5: Expected::Recorded,
        },
        Fixture {
            name: "E2-F7r",
            path: s_curve(),
            request: at(4.0, StrokeCap::Round),
            r4: (0, None),
            r5: Expected::Recorded,
        },
        Fixture {
            name: "E2-F8",
            path: figure_eight(),
            request: at(1.0, BUTT),
            r4: (0, None),
            r5: Expected::Recorded,
        },
    ]
}

#[test]
fn e2_fixture_table_and_lossless_merge() {
    let mut r4 = workspace(true);
    let mut r5 = workspace(false);
    for fixture in fixtures() {
        let bytes = fixture.path.bytes();
        let old = observe(&mut r4, &fixture.path.verbs, &bytes, fixture.request);
        let extra = centroids(&r4);
        let new = observe(&mut r5, &fixture.path.verbs, &bytes, fixture.request);
        let a4 = lossless(&r5, 4_096, &extra);
        println!(
            "{}: r4 {} {:?} ({} pieces) | r5 {} {:?}, {} pieces -> {} contours, {} vertices | A4 {a4:?}",
            fixture.name, old.status, old.error, old.pieces, new.status, new.error, new.pieces,
            new.contours, new.vertices
        );
        assert_eq!((old.status, old.error), fixture.r4, "{}: r4", fixture.name);
        match fixture.r5 {
            Expected::Ok => assert_eq!(new.status, 0, "{}", fixture.name),
            Expected::WorkLimit => {
                assert_eq!(new.status, STROKE_PATH_WORK_LIMIT, "{}", fixture.name)
            }
            Expected::Recorded => {}
        }
        // E2-G1 on the fixtures.
        if old.status == 0 {
            assert_eq!(new.status, 0, "{}: an r4 ok stays ok", fixture.name);
        }
        assert_ne!(
            new.status, STROKE_PATH_UNSUPPORTED_GEOMETRY,
            "{}",
            fixture.name
        );
        assert_ne!(new.status, STROKE_PATH_NUMERIC_RANGE, "{}", fixture.name);
        // E2-A4 wherever the merge ran.
        if new.contours > 0 {
            let counts = a4.unwrap_or_else(|error| panic!("{}: E2-A4: {error}", fixture.name));
            assert!(counts.points > 0, "{}", fixture.name);
        }
    }
}

/// The recorded literals of the table (contract section 8): contour and vertex counts and the
/// cause of each `work-limit`, so a later unit sees every change.
#[test]
fn e2_fixture_literals() {
    let mut ws = workspace(false);
    let input = Some(StrokeError::Rounded(RoundedFillError::InputLimit));
    let expected: [(&str, u32, Option<StrokeError>, usize, usize); 9] = [
        ("E2-F1", 0, None, 2, 256),
        ("E2-F2", 0, None, 2, 512),
        ("E2-F3", STROKE_PATH_WORK_LIMIT, input, 2, 2_048),
        ("E2-F4", STROKE_PATH_WORK_LIMIT, input, 2, 2_048),
        ("E2-F5", 0, None, 2, 816),
        ("E2-F6", 0, None, 2, 24),
        ("E2-F7", 0, None, 1, 260),
        ("E2-F7r", 0, None, 3, 324),
        ("E2-F8", 0, None, 2, 304),
    ];
    for (fixture, (name, status, error, contours, vertices)) in fixtures().into_iter().zip(expected)
    {
        assert_eq!(fixture.name, name);
        let found = observe(
            &mut ws,
            &fixture.path.verbs,
            &fixture.path.bytes(),
            fixture.request,
        );
        assert_eq!(
            (found.status, found.error, found.contours, found.vertices),
            (status, error, contours, vertices),
            "{name}"
        );
    }
}

// ---- E2-D1 ----

/// E2-A6 / E2-D1: dropping every strictly-outside `C` as covered is caught by E2-A4 (i) on a
/// fixture that holds a strictly-outside, uncovered `C`.
#[test]
fn e2_d1_dropped_outside_sample_is_caught() {
    let path = outside_end();
    let request = request(2.0, BUTT, MITER, 4.0, -3);
    let mut ws = workspace(false);
    assert_eq!(
        observe(&mut ws, &path.verbs, &path.bytes(), request).status,
        0
    );
    // The fixture holds a band piece with a strictly-outside, uncovered sample C.
    let piece = ws.pieces()[0];
    let quad = band_of(&piece).expect("a band piece");
    let end = piece.meta.samples[1].center;
    assert_eq!(
        sign(quad[1], quad[2], end),
        Ordering::Less,
        "C strictly outside its end seam"
    );
    let counts = lossless(&ws, 256, &[]).expect("E2-A4 passes");
    assert!(counts.kept >= 1);
    let mut defective = workspace(false);
    defective.defects_mut().drop_outside = true;
    let _ = observe(&mut defective, &path.verbs, &path.bytes(), request);
    let error = lossless(&defective, 256, &[]).expect_err("E2-D1 is caught");
    assert!(error.contains("no covering quad"), "{error}");
}

// ---- Storage, determinism, allocation ----

#[test]
fn e2_storage_fits_the_heap_cap() {
    let ws = workspace(false);
    let (front, rounded, scratch) = ws.byte_parts();
    let total = ws.allocated_bytes().expect("bytes");
    println!(
        "E2-U1 stroke workspace ({}): front end {front} B (seam merge {} B), RoundedFillWorkspace {rounded} B, FillScratch {scratch} B, total {total} B of {STROKE_V0_HEAP_CAP}",
        std::env::consts::ARCH,
        ws.merge().allocated_bytes()
    );
    assert!(total <= STROKE_V0_HEAP_CAP);
    const { assert!(MAX_POLYGON_POINTS >= MAX_PIECE_POINTS) };
    assert_eq!(MAX_PIECES, STROKE_V0_LIMITS.max_contours);
}

#[test]
fn e2_merge_is_deterministic_and_allocates_nothing() {
    let cases: Vec<(PathSpec, StrokeRequest)> = fixtures()
        .into_iter()
        .map(|fixture| (fixture.path, fixture.request))
        .collect();
    let bytes: Vec<Vec<u8>> = cases.iter().map(|case| case.0.bytes()).collect();
    let mut ws = workspace(false);
    let snapshot = |ws: &StrokeWorkspace| -> Vec<u64> {
        ws.merge()
            .contours()
            .flat_map(|contour| contour.iter().flat_map(|p| [p.x.to_bits(), p.y.to_bits()]))
            .collect()
    };
    let mut first = Vec::new();
    for ((path, request), points) in cases.iter().zip(&bytes) {
        let _ = ws.build(*request, &path.verbs, points);
        first.push(snapshot(&ws));
    }
    let mut fresh = workspace(false);
    crate::allocation_test_support::start();
    for ((path, request), points) in cases.iter().zip(&bytes).rev() {
        let _ = fresh.build(*request, &path.verbs, points);
    }
    assert_eq!(crate::allocation_test_support::stop(), 0);
    for (((path, request), points), expected) in cases.iter().zip(&bytes).zip(&first) {
        let _ = fresh.build(*request, &path.verbs, points);
        assert_eq!(&snapshot(&fresh), expected);
    }
}

// ---- The ignored differential: E2-G1, E2-G2 and E2-A4 ----

/// Per family: cases, `ok` on each side, gained and lost `ok`s, E2-A4 checks and totals, and
/// the per-stroke median times of the `r4`-`ok` strokes on each side.
#[derive(Default)]
struct Tally {
    cases: usize,
    r4_ok: usize,
    r5_ok: usize,
    gained: usize,
    lost: usize,
    checked: usize,
    a4: A4Counts,
    r4_times: Vec<u64>,
    r5_times: Vec<u64>,
}

struct Case {
    family: &'static str,
    name: String,
    request: StrokeRequest,
    verbs: Vec<u8>,
    bytes: Vec<u8>,
}

fn scene_cases(text: &str) -> Vec<Case> {
    let caps = [StrokeCap::Butt, StrokeCap::Round, StrokeCap::Square];
    let joins = [StrokeJoin::Miter, StrokeJoin::Round, StrokeJoin::Bevel];
    text.lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let f: Vec<f64> = line
                .split(' ')
                .map(|v| v.parse().expect("number"))
                .collect();
            let verb_count = f[8] as usize;
            let verbs = f[9..9 + verb_count].iter().map(|v| *v as u8).collect();
            let scalar_count = f[9 + verb_count] as usize;
            let bytes = f[10 + verb_count..10 + verb_count + scalar_count]
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect();
            Case {
                family: "scene",
                name: format!("scene/{}", f[0]),
                request: StrokeRequest {
                    request_id: 1,
                    width: f[4],
                    cap: caps[f[5] as usize],
                    join: joins[f[6] as usize],
                    miter_limit: f[7],
                    exponent: f[3] as i32,
                },
                verbs,
                bytes,
            }
        })
        .collect()
}

fn probe_cases() -> Vec<Case> {
    let mut cases = Vec::new();
    for (family, label) in [
        (Family::Zigzag, "st-u3b/zigzag"),
        (Family::Chords, "st-u3b/chords"),
    ] {
        for join in [StrokeJoin::Miter, StrokeJoin::Round, StrokeJoin::Bevel] {
            for cap in [StrokeCap::Butt, StrokeCap::Round, StrokeCap::Square] {
                for segments in SEGMENTS {
                    let (verbs, bytes) = polyline(family, segments);
                    cases.push(Case {
                        family: label,
                        name: format!("{}/{segments}/{join:?}/{cap:?}", family.name()),
                        request: request(2.0, cap, join, 4.0, -3),
                        verbs,
                        bytes,
                    });
                }
            }
        }
    }
    cases
}

fn median(values: &mut [u64]) -> u64 {
    values.sort_unstable();
    values[values.len() / 2]
}

/// Interleaved timed builds of one case on both sides, reusing the two workspaces.
fn time_pair(r4: &mut StrokeWorkspace, r5: &mut StrokeWorkspace, case: &Case) -> (u64, u64) {
    let (mut left, mut right) = (Vec::new(), Vec::new());
    let started = Instant::now();
    while left.len() < 31 && (left.len() < 3 || started.elapsed().as_millis() < 300) {
        for (ws, times) in [(&mut *r4, &mut left), (&mut *r5, &mut right)] {
            let start = Instant::now();
            let _ = core::hint::black_box(ws.build(case.request, &case.verbs, &case.bytes));
            times.push(start.elapsed().as_nanos() as u64);
        }
    }
    (median(&mut left), median(&mut right))
}

#[test]
#[ignore = "E2-U1 differential (E2-G1, E2-G2, E2-A4); release profile, --nocapture, one thread"]
fn e2_differential() {
    let mut cases = probe_cases();
    match env::var("E2_SCENE") {
        Ok(path) => cases.extend(scene_cases(&std::fs::read_to_string(path).expect("scene"))),
        Err(_) => println!("E2_SCENE not set: scene skipped"),
    }
    match env::var("P3_E1_CORPUS") {
        Ok(path) => cases.extend(
            read_corpus(&std::fs::read_to_string(path).expect("corpus"))
                .into_iter()
                .map(|case| Case {
                    family: "e1-c1",
                    name: case.name,
                    request: case.request,
                    verbs: case.verbs,
                    bytes: case.bytes,
                }),
        ),
        Err(_) => println!("P3_E1_CORPUS not set: E1-C1 skipped"),
    }
    let mut r4 = workspace(true);
    let mut r5 = workspace(false);
    let mut families: Vec<&'static str> = Vec::new();
    let mut tallies: HashMap<&'static str, Tally> = HashMap::new();
    let mut causes: HashMap<(&'static str, String), usize> = HashMap::new();
    let mut failures = Vec::new();
    for case in &cases {
        if !families.contains(&case.family) {
            families.push(case.family);
        }
        let old = observe(&mut r4, &case.verbs, &case.bytes, case.request);
        let extra = centroids(&r4);
        let new = observe(&mut r5, &case.verbs, &case.bytes, case.request);
        let tally = tallies.entry(case.family).or_default();
        tally.cases += 1;
        tally.r4_ok += usize::from(old.status == 0);
        tally.r5_ok += usize::from(new.status == 0);
        tally.gained += usize::from(old.status != 0 && new.status == 0);
        tally.lost += usize::from(old.status == 0 && new.status != 0);
        *causes
            .entry((
                case.family,
                if new.status == 0 {
                    "ok".into()
                } else {
                    format!("{:?}", new.error)
                },
            ))
            .or_default() += 1;
        if old.status == 0 && new.status != 0 {
            failures.push(format!(
                "E2-G1 {}: r4 ok, r5 {} {:?}",
                case.name, new.status, new.error
            ));
        }
        if new.status == STROKE_PATH_UNSUPPORTED_GEOMETRY
            && old.status != STROKE_PATH_UNSUPPORTED_GEOMETRY
            || new.status == STROKE_PATH_NUMERIC_RANGE && old.status != STROKE_PATH_NUMERIC_RANGE
        {
            failures.push(format!(
                "E2-G1 {}: moved to {} from {}",
                case.name, new.status, old.status
            ));
        }
        // The merge ran wherever it produced contours.
        if new.contours > 0 {
            match lossless(&r5, 256, &extra) {
                Ok(counts) => {
                    tally.checked += 1;
                    tally.a4.add(counts);
                }
                Err(error) => failures.push(format!("E2-A4 {}: {error}", case.name)),
            }
        }
        if old.status == 0 {
            let (left, right) = time_pair(&mut r4, &mut r5, case);
            tally.r4_times.push(left);
            tally.r5_times.push(right);
        }
    }
    println!("E2-U1 differential: diagnostic A/B, not a performance claim (E2-G3).");
    println!("family | cases | r4 ok | r5 ok | gained | lost | A4 checked | A4 points | r4 median us | r5 median us | ratio");
    for family in &families {
        let t = tallies.get_mut(family).expect("family");
        let (left, right) = if t.r4_times.is_empty() {
            (0, 0)
        } else {
            (median(&mut t.r4_times), median(&mut t.r5_times))
        };
        let ratio = if left == 0 {
            0.0
        } else {
            right as f64 / left as f64
        };
        println!(
            "{family} | {} | {} | {} | {} | {} | {} | {} | {:.1} | {:.1} | {ratio:.3}",
            t.cases,
            t.r4_ok,
            t.r5_ok,
            t.gained,
            t.lost,
            t.checked,
            t.a4.points,
            left as f64 / 1e3,
            right as f64 / 1e3
        );
        println!("  A4 totals: {:?}", t.a4);
        if ratio > 1.10 {
            failures.push(format!("E2-G2 {family}: r5/r4 median {ratio:.3} > 1.10"));
        }
    }
    let mut rows: Vec<_> = causes.into_iter().collect();
    rows.sort();
    for ((family, cause), count) in rows {
        println!("  r5 {family}: {cause} {count}");
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

// ---- E2 section 7 caps at r5 (review S2) ----

/// Over 512 merged contours the path is `PieceLimit`, checked before `InputLimit`; over
/// `MAX_PIECE_POINTS` stored points it is `PieceLimit` at emission.
#[test]
fn e2_section_7_caps() {
    let mut ws = workspace(false);
    // 256 separate round-capped dashes: a sweep and two cap disks each, no cancellation between
    // dashes.
    let mut dashes = PathSpec::new();
    for index in 0..256u32 {
        let x = f64::from(index) * 8.0;
        dashes = dashes.m(x, 0.0).l(x + 2.0, 0.0);
    }
    let found = observe(
        &mut ws,
        &dashes.verbs,
        &dashes.bytes(),
        request(1.0, StrokeCap::Round, MITER, 4.0, -3),
    );
    println!("dashes: {found:?}");
    assert_eq!(found.status, STROKE_PATH_WORK_LIMIT);
    assert_eq!(
        found.error,
        Some(StrokeError::Front(FrontEndError::PieceLimit))
    );
    assert!(found.contours > MAX_PIECES);
    assert!(found.vertices > STROKE_V0_LIMITS.max_input_vertices);
    // 200 zigzag segments with round joins at r = 200: about 199 disks of 256 vertices.
    let mut zigzag = PathSpec::new().m(0.0, 0.0);
    for index in 1..=200u32 {
        zigzag = zigzag.l(16.0 * f64::from(index), 16.0 * f64::from(index % 2));
    }
    let found = observe(
        &mut ws,
        &zigzag.verbs,
        &zigzag.bytes(),
        request(400.0, BUTT, StrokeJoin::Round, 4.0, -3),
    );
    println!("zigzag: {found:?}");
    assert_eq!(
        found.error,
        Some(StrokeError::Front(FrontEndError::PieceLimit))
    );
    assert_eq!(found.contours, 0, "stopped at emission, before the merge");
    let stored: usize = ws.pieces().iter().map(|piece| piece.count).sum();
    assert!(stored <= MAX_PIECE_POINTS);
    assert!(ws.pieces().len() < 4_096);
}
