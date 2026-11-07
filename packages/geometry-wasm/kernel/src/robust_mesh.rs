//! D9 rendering-track item E38 (`docs/plans/d9-e38-robust-path-rung-contract.md`): the robust
//! last rung of the fill and stroke exports (`fill-v0+r6`, `stroke-v0+r9`).
//!
//! The exact rungs resolve a path's planar arrangement with exact predicates under fixed caps
//! (input vertices, nodes, commands, work). Their cost grows with the path's length over the
//! tolerance and with its crossings, so a large pen path, or any path at a high enough zoom,
//! meets a cap and the path drew nothing. This rung runs only after an exact rung refused a path
//! with `work-limit` or `unsupported-geometry`:
//!
//! - R1, flattening: every cubic becomes `n` chords by Wang's bound at `tol = 2^(e-1)`.
//! - R2, stroke pieces: per chord a quad of half width `r`, a join per chord corner (the
//!   request's join at a verb boundary, round inside a cubic) and the caps of open subpaths.
//!   Each piece is a convex polygon, oriented counterclockwise, so nonzero is their union.
//! - R3, slab sweep: the directed edges are cut at every endpoint `y` and at every crossing of
//!   two neighbouring edges, and each slab's spans whose winding passes the rule become
//!   trapezoids; a span bounded by the same two edges in the next slab extends its trapezoid.
//! - R4, budget: every buffer is reserved once (`RobustMesh::reserve`), so a build never
//!   allocates (the process calls must not move linear memory). A build that would overflow a
//!   buffer starts again at twice the tolerance. It refuses (`None`) only when the path does
//!   not fit even at one chord per verb, which takes more than `MAX_CHORDS` source points.
//!
//! Plain binary64 arithmetic, no exact predicate: the mesh has no boundary edges, so the
//! renderer draws it without the coverage fringe (4x MSAA edges), and a rounding slip moves a
//! trapezoid corner by about one ulp of the coordinates.

use crate::geometry::{Point, VERB_CLOSE, VERB_CUBIC, VERB_LINE, VERB_MOVE};
use crate::line_fill::LineFillRule;
use crate::stroke_outline::{StrokeCap, StrokeJoin};

/// The most chords (flattened points) one path keeps.
pub(crate) const MAX_CHORDS: usize = 8_192;
/// The most sweep edges (a stroke has about seven per chord).
pub(crate) const MAX_EDGES: usize = 8 * MAX_CHORDS;
/// The most edges crossing one slab (and spans open at once).
pub(crate) const MAX_ACTIVE: usize = 16_384;
/// The most trapezoids, each up to four vertices and two triangles.
pub(crate) const MAX_TRAPEZOIDS: usize = 32_768;
/// The most chords of one cubic at any tolerance.
const MAX_CHORDS_PER_CUBIC: usize = 4_096;
/// The most crossing splits of one slab before it is emitted in its sorted order.
const MAX_SPLITS_PER_SLAB: usize = 4_096;
/// The most segments of one round join or cap arc.
const MAX_ARC_STEPS: usize = 128;
/// The most tolerance doublings (R4) before a refusal.
const MAX_COARSENINGS: u32 = 64;

/// One directed edge of the sweep, stored top to bottom with its winding sign.
#[derive(Clone, Copy, Debug, Default)]
struct Edge {
    top: Point,
    bottom: Point,
    winding: i32,
}

impl Edge {
    fn x_at(&self, y: f64) -> f64 {
        if y <= self.top.y {
            return self.top.x;
        }
        if y >= self.bottom.y {
            return self.bottom.x;
        }
        let t = (y - self.top.y) / (self.bottom.y - self.top.y);
        self.top.x + (self.bottom.x - self.top.x) * t
    }
}

/// One flattened subpath: `points[start..start + count]`.
#[derive(Clone, Copy, Debug, Default)]
struct Subpath {
    start: usize,
    count: usize,
    closed: bool,
    /// The subpath had a drawing verb (a zero-length one draws a dot under round or square caps).
    drawing: bool,
}

/// An open trapezoid chain of the sweep: the span between `left` and `right` from `y`.
#[derive(Clone, Copy, Debug, Default)]
struct OpenSpan {
    left: u32,
    right: u32,
    y: f64,
    seen: u32,
}

/// A build stopped at a full buffer (R4 retries coarser).
#[derive(Clone, Copy, Debug)]
struct Full;

/// Statistics of the last build.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct RobustStats {
    pub(crate) chords: usize,
    pub(crate) edges: usize,
    pub(crate) slabs: usize,
    pub(crate) splits: usize,
    pub(crate) capped_slabs: usize,
    pub(crate) trapezoids: usize,
    /// The tolerance used, `2^(e-1)` times `2^coarsenings`.
    pub(crate) tolerance: f64,
    pub(crate) coarsenings: u32,
}

/// The stroke style of a build.
#[derive(Clone, Copy, Debug)]
pub(crate) struct RobustStroke {
    pub(crate) width: f64,
    pub(crate) cap: StrokeCap,
    pub(crate) join: StrokeJoin,
    pub(crate) miter_limit: f64,
}

/// The robust rung's storage, reserved once, and its published mesh.
#[derive(Debug, Default)]
pub(crate) struct RobustMesh {
    subpaths: Vec<Subpath>,
    points: Vec<Point>,
    corners: Vec<bool>,
    piece: Vec<Point>,
    edges: Vec<Edge>,
    active: Vec<u32>,
    keys: Vec<(f64, f64, u32)>,
    spans: Vec<(u32, u32)>,
    open: Vec<OpenSpan>,
    vertices: Vec<Point>,
    triangles: Vec<u32>,
    boundary: Vec<[u32; 2]>,
    reserved: bool,
    pub(crate) stats: RobustStats,
}

fn sub(a: Point, b: Point) -> Point {
    Point {
        x: a.x - b.x,
        y: a.y - b.y,
    }
}

fn add(a: Point, b: Point) -> Point {
    Point {
        x: a.x + b.x,
        y: a.y + b.y,
    }
}

fn scale(a: Point, s: f64) -> Point {
    Point {
        x: a.x * s,
        y: a.y * s,
    }
}

fn length(a: Point) -> f64 {
    a.x.hypot(a.y)
}

fn cross(a: Point, b: Point) -> f64 {
    a.x * b.y - a.y * b.x
}

fn dot(a: Point, b: Point) -> f64 {
    a.x * b.x + a.y * b.y
}

/// Reads point `index` of a validated path's little-endian binary64 scalars.
fn point(points: &[u8], index: usize) -> Point {
    let read = |scalar: usize| {
        let start = scalar * 8;
        let mut bytes = [0u8; 8];
        bytes.copy_from_slice(&points[start..start + 8]);
        f64::from_le_bytes(bytes)
    };
    Point {
        x: read(2 * index),
        y: read(2 * index + 1),
    }
}

/// Wang's chord count for a cubic at tolerance `tol` (chord error at most `tol`).
fn cubic_chords(p: [Point; 4], tol: f64) -> usize {
    let d1 = length(add(sub(p[0], scale(p[1], 2.0)), p[2]));
    let d2 = length(add(sub(p[1], scale(p[2], 2.0)), p[3]));
    let n = (0.75 * d1.max(d2) / tol).sqrt().ceil();
    if n.is_nan() || n < 1.0 {
        1
    } else if n >= MAX_CHORDS_PER_CUBIC as f64 {
        MAX_CHORDS_PER_CUBIC
    } else {
        n as usize
    }
}

fn cubic_at(p: [Point; 4], t: f64) -> Point {
    let u = 1.0 - t;
    let (a, b, c, d) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
    Point {
        x: a * p[0].x + b * p[1].x + c * p[2].x + d * p[3].x,
        y: a * p[0].y + b * p[1].y + c * p[2].y + d * p[3].y,
    }
}

/// cos(phi / 2) from cos(phi).
fn half_cos(cosine: f64) -> f64 {
    ((1.0 + cosine) * 0.5).max(0.0).sqrt()
}

fn reserve<T>(buffer: &mut Vec<T>, capacity: usize) -> Result<(), ()> {
    buffer.try_reserve_exact(capacity).map_err(|_| ())
}

/// Pushes into a reserved buffer, never past its capacity (no allocation).
fn push<T>(buffer: &mut Vec<T>, value: T) -> Result<(), Full> {
    if buffer.len() == buffer.capacity() {
        return Err(Full);
    }
    buffer.push(value);
    Ok(())
}

impl RobustMesh {
    pub(crate) const fn new() -> Self {
        Self {
            subpaths: Vec::new(),
            points: Vec::new(),
            corners: Vec::new(),
            piece: Vec::new(),
            edges: Vec::new(),
            active: Vec::new(),
            keys: Vec::new(),
            spans: Vec::new(),
            open: Vec::new(),
            vertices: Vec::new(),
            triangles: Vec::new(),
            boundary: Vec::new(),
            reserved: false,
            stats: RobustStats {
                chords: 0,
                edges: 0,
                slabs: 0,
                splits: 0,
                capped_slabs: 0,
                trapezoids: 0,
                tolerance: 0.0,
                coarsenings: 0,
            },
        }
    }

    /// Reserves every buffer once; `Err` when an allocation is refused.
    pub(crate) fn reserve(&mut self) -> Result<(), ()> {
        if self.reserved {
            return Ok(());
        }
        reserve(&mut self.subpaths, MAX_CHORDS)?;
        reserve(&mut self.points, MAX_CHORDS)?;
        reserve(&mut self.corners, MAX_CHORDS)?;
        reserve(&mut self.piece, MAX_ARC_STEPS + 8)?;
        reserve(&mut self.edges, MAX_EDGES)?;
        reserve(&mut self.active, MAX_ACTIVE)?;
        reserve(&mut self.keys, MAX_ACTIVE)?;
        reserve(&mut self.spans, MAX_ACTIVE)?;
        reserve(&mut self.open, MAX_ACTIVE)?;
        reserve(&mut self.vertices, 4 * MAX_TRAPEZOIDS)?;
        reserve(&mut self.triangles, 6 * MAX_TRAPEZOIDS)?;
        self.reserved = true;
        Ok(())
    }

    /// Bytes `reserve` requests, from the capacities alone.
    pub(crate) const fn reserved_bytes() -> usize {
        use std::mem::size_of;
        MAX_CHORDS * (size_of::<Subpath>() + size_of::<Point>() + size_of::<bool>())
            + (MAX_ARC_STEPS + 8) * size_of::<Point>()
            + MAX_EDGES * size_of::<Edge>()
            + MAX_ACTIVE
                * (size_of::<u32>()
                    + size_of::<(f64, f64, u32)>()
                    + size_of::<(u32, u32)>()
                    + size_of::<OpenSpan>())
            + 4 * MAX_TRAPEZOIDS * size_of::<Point>()
            + 6 * MAX_TRAPEZOIDS * size_of::<u32>()
    }

    /// Bytes reserved by `reserve`.
    pub(crate) fn allocated_bytes(&self) -> usize {
        use std::mem::size_of;
        self.subpaths.capacity() * size_of::<Subpath>()
            + self.points.capacity() * size_of::<Point>()
            + self.corners.capacity()
            + self.piece.capacity() * size_of::<Point>()
            + self.edges.capacity() * size_of::<Edge>()
            + self.active.capacity() * size_of::<u32>()
            + self.keys.capacity() * size_of::<(f64, f64, u32)>()
            + self.spans.capacity() * size_of::<(u32, u32)>()
            + self.open.capacity() * size_of::<OpenSpan>()
            + self.vertices.capacity() * size_of::<Point>()
            + self.triangles.capacity() * size_of::<u32>()
    }

    /// The published vertices, triangles (three indices each) and boundary pairs (none).
    pub(crate) fn mesh(&self) -> (&[Point], &[u32], &[[u32; 2]]) {
        (&self.vertices, &self.triangles, &self.boundary)
    }

    /// The fill of a validated path under `rule`: `Some(true)` for a mesh, `Some(false)` for an
    /// empty region, `None` when the path does not fit the reserved buffers at any tolerance.
    pub(crate) fn build_fill(
        &mut self,
        verbs: &[u8],
        points: &[u8],
        rule: LineFillRule,
        tol: f64,
    ) -> Option<bool> {
        self.build(verbs, points, tol, |mesh, _| {
            for index in 0..mesh.subpaths.len() {
                let subpath = mesh.subpaths[index];
                let end = subpath.start + subpath.count;
                for i in subpath.start..end {
                    let next = if i + 1 == end { subpath.start } else { i + 1 };
                    mesh.push_edge(mesh.points[i], mesh.points[next])?;
                }
            }
            mesh.sweep(rule)
        })
    }

    /// The stroke of a validated path (nonzero union of its pieces), as `build_fill`.
    pub(crate) fn build_stroke(
        &mut self,
        verbs: &[u8],
        points: &[u8],
        style: RobustStroke,
        tol: f64,
    ) -> Option<bool> {
        if style.width.is_nan() || style.width <= 0.0 {
            self.clear();
            return Some(false);
        }
        self.build(verbs, points, tol, |mesh, tol| {
            mesh.stroke_pieces(style, tol)?;
            mesh.sweep(LineFillRule::Nonzero)
        })
    }

    fn clear(&mut self) {
        self.subpaths.clear();
        self.points.clear();
        self.corners.clear();
        self.edges.clear();
        self.vertices.clear();
        self.triangles.clear();
        self.stats = RobustStats::default();
    }

    /// R1 and R4 around one build body.
    fn build(
        &mut self,
        verbs: &[u8],
        points: &[u8],
        tol: f64,
        body: impl Fn(&mut Self, f64) -> Result<bool, Full>,
    ) -> Option<bool> {
        if !self.reserved {
            return None;
        }
        let mut tol = tol;
        for coarsenings in 0..=MAX_COARSENINGS {
            self.clear();
            self.stats.coarsenings = coarsenings;
            self.stats.tolerance = tol;
            let result = self
                .flatten(verbs, points, tol)
                .and_then(|()| body(self, tol));
            match result {
                Ok(drawn) => return Some(drawn),
                Err(Full) => tol *= 2.0,
            }
            if !tol.is_finite() {
                break;
            }
        }
        self.clear();
        None
    }

    fn push_point(&mut self, p: Point, corner: bool) -> Result<(), Full> {
        let start = self.subpaths.last().map_or(0, |subpath| subpath.start);
        if self.points.len() > start && self.points.last() == Some(&p) {
            if corner {
                if let Some(last) = self.corners.last_mut() {
                    *last = true;
                }
            }
            return Ok(());
        }
        push(&mut self.points, p)?;
        push(&mut self.corners, corner)?;
        if let Some(subpath) = self.subpaths.last_mut() {
            subpath.count += 1;
        }
        Ok(())
    }

    fn mark_drawing(&mut self) {
        if let Some(subpath) = self.subpaths.last_mut() {
            subpath.drawing = true;
        }
    }

    /// R1: the path's subpaths as chords at `tol` (consecutive equal points merged).
    fn flatten(&mut self, verbs: &[u8], points: &[u8], tol: f64) -> Result<(), Full> {
        let mut index = 0usize;
        for &verb in verbs {
            match verb {
                VERB_MOVE => {
                    push(
                        &mut self.subpaths,
                        Subpath {
                            start: self.points.len(),
                            ..Subpath::default()
                        },
                    )?;
                    self.push_point(point(points, index), true)?;
                    index += 1;
                }
                VERB_LINE => {
                    self.mark_drawing();
                    self.push_point(point(points, index), true)?;
                    index += 1;
                }
                VERB_CUBIC => {
                    self.mark_drawing();
                    let start = self.points.last().copied().unwrap_or_default();
                    let p = [
                        start,
                        point(points, index),
                        point(points, index + 1),
                        point(points, index + 2),
                    ];
                    index += 3;
                    let n = cubic_chords(p, tol);
                    for k in 1..n {
                        self.push_point(cubic_at(p, k as f64 / n as f64), false)?;
                    }
                    self.push_point(p[3], true)?;
                }
                VERB_CLOSE => {
                    if let Some(subpath) = self.subpaths.last_mut() {
                        subpath.closed = true;
                        let first = self.points[subpath.start];
                        if subpath.count > 1 && self.points.last() == Some(&first) {
                            self.points.pop();
                            self.corners.pop();
                            subpath.count -= 1;
                        }
                    }
                }
                _ => {}
            }
        }
        self.stats.chords = self.points.len();
        Ok(())
    }

    fn push_edge(&mut self, a: Point, b: Point) -> Result<(), Full> {
        if a.y == b.y {
            return Ok(());
        }
        let (top, bottom, winding) = if a.y < b.y { (a, b, 1) } else { (b, a, -1) };
        push(
            &mut self.edges,
            Edge {
                top,
                bottom,
                winding,
            },
        )
    }

    /// Adds the closed polygon in `self.piece`, counterclockwise (a stroke piece).
    fn push_piece(&mut self) -> Result<(), Full> {
        let n = self.piece.len();
        if n < 3 {
            return Ok(());
        }
        let mut area = 0.0;
        for i in 0..n {
            area += cross(self.piece[i], self.piece[(i + 1) % n]);
        }
        if area == 0.0 || area.is_nan() {
            return Ok(());
        }
        for i in 0..n {
            let (a, b) = (self.piece[i], self.piece[(i + 1) % n]);
            if area < 0.0 {
                self.push_edge(b, a)?;
            } else {
                self.push_edge(a, b)?;
            }
        }
        Ok(())
    }

    fn set_piece(&mut self, points: &[Point]) {
        self.piece.clear();
        self.piece.extend_from_slice(points);
    }

    /// R2: every stroke piece of the flattened path.
    fn stroke_pieces(&mut self, style: RobustStroke, tol: f64) -> Result<(), Full> {
        let r = style.width * 0.5;
        for index in 0..self.subpaths.len() {
            let subpath = self.subpaths[index];
            let (start, n) = (subpath.start, subpath.count);
            if n == 0 {
                continue;
            }
            if n == 1 {
                if subpath.drawing {
                    self.dot(self.points[start], r, style.cap, tol)?;
                }
                continue;
            }
            let segments = if subpath.closed { n } else { n - 1 };
            let at = |mesh: &Self, i: usize| mesh.points[start + i % n];
            let direction = |mesh: &Self, i: usize| {
                let d = sub(at(mesh, i + 1), at(mesh, i));
                scale(d, 1.0 / length(d))
            };
            for i in 0..segments {
                let (a, b) = (at(self, i), at(self, i + 1));
                let d = direction(self, i);
                let normal = Point {
                    x: -d.y * r,
                    y: d.x * r,
                };
                self.set_piece(&[
                    add(a, normal),
                    add(b, normal),
                    sub(b, normal),
                    sub(a, normal),
                ]);
                self.push_piece()?;
            }
            let joins = if subpath.closed { 0..n } else { 1..n - 1 };
            for i in joins {
                let d0 = direction(self, i + n - 1);
                let d1 = direction(self, i);
                let kind = if self.corners[start + i] {
                    style.join
                } else {
                    StrokeJoin::Round
                };
                self.join(at(self, i), d0, d1, r, kind, style.miter_limit, tol)?;
            }
            if !subpath.closed {
                let first = direction(self, 0);
                let last = direction(self, segments - 1);
                self.cap(at(self, 0), scale(first, -1.0), r, style.cap, tol)?;
                self.cap(at(self, n - 1), last, r, style.cap, tol)?;
            }
        }
        Ok(())
    }

    /// A zero-length subpath's dot.
    fn dot(&mut self, c: Point, r: f64, cap: StrokeCap, tol: f64) -> Result<(), Full> {
        match cap {
            StrokeCap::Butt => return Ok(()),
            StrokeCap::Square => self.set_piece(&[
                Point {
                    x: c.x - r,
                    y: c.y - r,
                },
                Point {
                    x: c.x + r,
                    y: c.y - r,
                },
                Point {
                    x: c.x + r,
                    y: c.y + r,
                },
                Point {
                    x: c.x - r,
                    y: c.y + r,
                },
            ]),
            StrokeCap::Round => {
                self.piece.clear();
                arc(
                    &mut self.piece,
                    c,
                    Point { x: 1.0, y: 0.0 },
                    std::f64::consts::TAU,
                    r,
                    tol,
                );
            }
        }
        self.push_piece()
    }

    /// One join at `p` from direction `d0` into `d1`.
    #[allow(clippy::too_many_arguments)]
    fn join(
        &mut self,
        p: Point,
        d0: Point,
        d1: Point,
        r: f64,
        kind: StrokeJoin,
        miter_limit: f64,
        tol: f64,
    ) -> Result<(), Full> {
        let turn = cross(d0, d1);
        let cosine = dot(d0, d1).clamp(-1.0, 1.0);
        if turn == 0.0 && cosine > 0.0 {
            return Ok(());
        }
        // The outer side: right of travel for a positive turn, left otherwise.
        let side = if turn > 0.0 { -1.0 } else { 1.0 };
        let n0 = Point {
            x: -d0.y * side,
            y: d0.x * side,
        };
        let n1 = Point {
            x: -d1.y * side,
            y: d1.x * side,
        };
        let (a, b) = (add(p, scale(n0, r)), add(p, scale(n1, r)));
        match kind {
            StrokeJoin::Bevel => self.set_piece(&[p, a, b]),
            StrokeJoin::Miter => {
                // The miter ratio 1 / cos(phi / 2) against the limit, phi the turn angle.
                let half = half_cos(cosine);
                if half > 0.0 && 1.0 <= miter_limit * half {
                    let tip = add(p, scale(add(n0, n1), r / (1.0 + cosine)));
                    self.set_piece(&[p, a, tip, b]);
                } else {
                    self.set_piece(&[p, a, b]);
                }
            }
            StrokeJoin::Round => {
                if r * (1.0 - half_cos(cosine)) <= tol {
                    self.set_piece(&[p, a, b]);
                } else {
                    self.piece.clear();
                    self.piece.push(p);
                    arc(&mut self.piece, p, n0, turn.atan2(cosine), r, tol);
                }
            }
        }
        self.push_piece()
    }

    /// One cap at the end `p` of an open subpath, `d` pointing out of the stroke.
    fn cap(&mut self, p: Point, d: Point, r: f64, cap: StrokeCap, tol: f64) -> Result<(), Full> {
        let normal = Point {
            x: -d.y * r,
            y: d.x * r,
        };
        match cap {
            StrokeCap::Butt => return Ok(()),
            StrokeCap::Square => {
                let out = scale(d, r);
                self.set_piece(&[
                    add(p, normal),
                    add(add(p, normal), out),
                    add(sub(p, normal), out),
                    sub(p, normal),
                ]);
            }
            StrokeCap::Round => {
                // A half disk from +normal through d to -normal.
                self.piece.clear();
                arc(
                    &mut self.piece,
                    p,
                    Point { x: -d.y, y: d.x },
                    -std::f64::consts::PI,
                    r,
                    tol,
                );
            }
        }
        self.push_piece()
    }

    fn trapezoid(&mut self, left: Edge, right: Edge, top: f64, bottom: f64) -> Result<(), Full> {
        if bottom.is_nan() || top.is_nan() || bottom <= top {
            return Ok(());
        }
        let tl = Point {
            x: left.x_at(top),
            y: top,
        };
        let tr = Point {
            x: right.x_at(top),
            y: top,
        };
        let br = Point {
            x: right.x_at(bottom),
            y: bottom,
        };
        let bl = Point {
            x: left.x_at(bottom),
            y: bottom,
        };
        let wide_top = tr.x > tl.x;
        let wide_bottom = br.x > bl.x;
        if !wide_top && !wide_bottom {
            return Ok(());
        }
        if self.vertices.len() + 4 > self.vertices.capacity()
            || self.triangles.len() + 6 > self.triangles.capacity()
        {
            return Err(Full);
        }
        let base = self.vertices.len() as u32;
        self.vertices.extend_from_slice(&[tl, tr, br, bl]);
        if wide_top {
            self.triangles
                .extend_from_slice(&[base, base + 2, base + 1]);
        }
        if wide_bottom {
            self.triangles
                .extend_from_slice(&[base, base + 3, base + 2]);
        }
        self.stats.trapezoids += 1;
        Ok(())
    }

    /// Closes every open span not seen in generation `generation` at `y`.
    fn close_unseen(&mut self, generation: u32, y: f64) -> Result<(), Full> {
        let mut kept = 0usize;
        for i in 0..self.open.len() {
            let span = self.open[i];
            if span.seen == generation {
                self.open[kept] = span;
                kept += 1;
            } else {
                let (left, right) = (
                    self.edges[span.left as usize],
                    self.edges[span.right as usize],
                );
                self.trapezoid(left, right, span.y, y)?;
            }
        }
        self.open.truncate(kept);
        Ok(())
    }

    /// R3: the slab sweep under `rule`. Returns whether a trapezoid has area.
    fn sweep(&mut self, rule: LineFillRule) -> Result<bool, Full> {
        let inside = |w: i32| match rule {
            LineFillRule::Nonzero => w != 0,
            LineFillRule::Evenodd => w & 1 != 0,
        };
        let finite = |p: Point| p.x.is_finite() && p.y.is_finite();
        self.edges
            .retain(|edge| finite(edge.top) && finite(edge.bottom));
        self.stats.edges = self.edges.len();
        self.edges
            .sort_unstable_by(|a, b| a.top.y.total_cmp(&b.top.y));
        self.active.clear();
        self.open.clear();
        let mut next = 0usize;
        let mut generation = 0u32;
        // The sweep's next event: the next edge top or the nearest active bottom.
        let mut y0 = match self.edges.first() {
            Some(edge) => edge.top.y,
            None => return Ok(false),
        };
        loop {
            while next < self.edges.len() && self.edges[next].top.y <= y0 {
                push(&mut self.active, next as u32)?;
                next += 1;
            }
            let edges = &self.edges;
            self.active
                .retain(|&index| edges[index as usize].bottom.y > y0);
            let mut y1 = f64::INFINITY;
            if next < self.edges.len() {
                y1 = self.edges[next].top.y;
            }
            for &index in &self.active {
                y1 = y1.min(self.edges[index as usize].bottom.y);
            }
            if y1 == f64::INFINITY {
                break;
            }
            let mut top = y0;
            let mut splits = 0usize;
            loop {
                self.stats.slabs += 1;
                self.keys.clear();
                for &index in &self.active {
                    let edge = &self.edges[index as usize];
                    self.keys.push((edge.x_at(top), edge.x_at(y1), index));
                }
                self.keys.sort_unstable_by(|a, b| {
                    a.0.total_cmp(&b.0)
                        .then(a.1.total_cmp(&b.1))
                        .then(a.2.cmp(&b.2))
                });
                // The earliest crossing below `top` of two neighbours in the top order.
                let mut split = y1;
                if splits < MAX_SPLITS_PER_SLAB {
                    for pair in self.keys.windows(2) {
                        let (a, b) = (pair[0], pair[1]);
                        if a.1 > b.1 {
                            let (dt, db) = (a.0 - b.0, a.1 - b.1);
                            let y = top + (y1 - top) * (dt / (dt - db));
                            if y > top && y < split {
                                split = y;
                            }
                        }
                    }
                } else if splits == MAX_SPLITS_PER_SLAB {
                    self.stats.capped_slabs += 1;
                }
                // The spans of this sub-slab.
                self.spans.clear();
                let mut winding = 0i32;
                let mut left = None;
                for &(_, _, index) in &self.keys {
                    let before = inside(winding);
                    winding += self.edges[index as usize].winding;
                    let after = inside(winding);
                    if !before && after {
                        left = Some(index);
                    } else if before && !after {
                        if let Some(l) = left.take() {
                            self.spans.push((l, index));
                        }
                    }
                }
                generation = generation.wrapping_add(1);
                for s in 0..self.spans.len() {
                    let (l, r) = self.spans[s];
                    match self
                        .open
                        .iter_mut()
                        .find(|span| span.left == l && span.right == r)
                    {
                        Some(span) => span.seen = generation,
                        None => push(
                            &mut self.open,
                            OpenSpan {
                                left: l,
                                right: r,
                                y: top,
                                seen: generation,
                            },
                        )?,
                    }
                }
                self.close_unseen(generation, top)?;
                if split < y1 {
                    top = split;
                    splits += 1;
                    self.stats.splits += 1;
                    continue;
                }
                break;
            }
            // Spans bounded by an edge that ends at y1 close there.
            generation = generation.wrapping_add(1);
            for span in self.open.iter_mut() {
                let ends = self.edges[span.left as usize].bottom.y <= y1
                    || self.edges[span.right as usize].bottom.y <= y1;
                if !ends {
                    span.seen = generation;
                }
            }
            self.close_unseen(generation, y1)?;
            y0 = y1;
        }
        self.close_unseen(generation.wrapping_add(1), y0)?;
        Ok(!self.triangles.is_empty())
    }
}

/// Appends the arc points from `p + r * from` sweeping `sweep` radians (sign = direction),
/// both ends included (a full turn drops its repeated end), with steps whose sagitta is at most
/// `tol`, at most `MAX_ARC_STEPS`.
fn arc(piece: &mut Vec<Point>, p: Point, from: Point, sweep: f64, r: f64, tol: f64) {
    let step = if tol >= r {
        std::f64::consts::FRAC_PI_2
    } else {
        2.0 * (1.0 - tol / r).acos()
    };
    let wanted = (sweep.abs() / step).ceil();
    let steps = if wanted.is_nan() || wanted < 2.0 {
        2
    } else if wanted > MAX_ARC_STEPS as f64 {
        MAX_ARC_STEPS
    } else {
        wanted as usize
    };
    let base = from.y.atan2(from.x);
    let full = sweep.abs() >= std::f64::consts::TAU;
    let last = if full { steps - 1 } else { steps };
    for k in 0..=last {
        let angle = base + sweep * (k as f64 / steps as f64);
        piece.push(add(
            p,
            Point {
                x: r * angle.cos(),
                y: r * angle.sin(),
            },
        ));
    }
}
