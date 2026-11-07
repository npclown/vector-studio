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
/// E39-K4: the most vertices of a winding (fill) or union (stroke) mesh, and the most flattened
/// points of their builds.
pub(crate) const MAX_WINDING_VERTICES: usize = 1 << 17;
/// E39-K4: the most triangle indices of a winding or union mesh (a fan of `k` points has `k - 2`
/// triangles, so three per vertex is enough).
const MAX_WINDING_INDICES: usize = 3 * MAX_WINDING_VERTICES;
/// E39-K4: every subpath holds a point, so a build within the vertex bound has at most this
/// many subpaths (the E38 sweep's `MAX_CHORDS` would refuse a compound path of more contours).
const MAX_SUBPATHS: usize = MAX_WINDING_VERTICES;
/// E39-K5: the winding boxes held at once. A path with more boxing subpaths (an outlined text
/// block) merges neighbouring boxes in pairs, which only loosens the bound.
const MAX_BOXES: usize = MAX_CHORDS;
/// E39-K5: a fill whose winding bound reaches this falls back to the slab sweep (the stencil
/// counts modulo 128 in a joint draw; 8 is the margin for the f32 rounding of transformed
/// vertices).
pub(crate) const WINDING_FALLBACK: u32 = 120;
/// The sweep's vertex and index limits (E38), kept apart from the larger winding buffers.
const SWEEP_VERTICES: usize = 4 * MAX_TRAPEZOIDS;
const SWEEP_INDICES: usize = 6 * MAX_TRAPEZOIDS;
/// The sweep's work budget per build: edge visits over all sub-slabs (sorting, crossing search,
/// span matching). A build over it starts again at twice the tolerance (R4), which bounds the
/// time of one robust build however much the stroke pieces overlap.
pub(crate) const MAX_SWEEP_WORK: u64 = 1 << 24;

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

/// E39: the outcome of a winding fill build.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WindingFill {
    /// A winding mesh (fan triangles over the flattened points).
    Mesh,
    /// No triangle covers a sample.
    Empty,
    /// E39-K5: the winding bound reached `WINDING_FALLBACK`; build the slab sweep instead.
    TooWound,
    /// The path does not fit the reserved buffers at any tolerance.
    Refused,
}

/// One subpath's box and winding bound for the E39-K5 sweep.
#[derive(Clone, Copy, Debug, Default)]
struct WindingBox {
    min: Point,
    max: Point,
    bound: u32,
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
    /// The sweep work of the published build (against `MAX_SWEEP_WORK`).
    pub(crate) work: u64,
    /// E39-K5: the winding bound of the last winding fill build.
    pub(crate) winding_bound: u32,
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
    /// Per edge, the `open` slot of the span it may bound on the left (checked on use, so a
    /// stale entry is harmless).
    open_by_left: Vec<u32>,
    /// The factor of the next coarsening (R4): 2 after a full buffer, more after a sweep far
    /// over its work budget.
    coarsening: f64,
    /// The last `Full` came from the work budget, not a buffer.
    over_work: bool,
    /// The sweep's work budget of this attempt (`MAX_SWEEP_WORK`, or none, see `build`).
    work_budget: u64,
    vertices: Vec<Point>,
    triangles: Vec<u32>,
    boundary: Vec<[u32; 2]>,
    /// The most flattened points of this build: `MAX_CHORDS` for the sweep (E38), and
    /// `MAX_WINDING_VERTICES` for a winding or union build (E39-K4).
    point_limit: usize,
    /// E39-K2: stroke pieces are written as fan triangles (a union mesh), not sweep edges.
    union_output: bool,
    /// E39-K1: the published vertices are the flattened points (a fill fan).
    publish_points: bool,
    /// E39-K5: edge span ends, and the subpath boxes with their y and x events.
    tops: Vec<f64>,
    bottoms: Vec<f64>,
    boxes: Vec<WindingBox>,
    box_ys: Vec<f64>,
    box_events: Vec<(f64, u32, bool)>,
    tree_max: Vec<i64>,
    tree_add: Vec<i64>,
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

const fn const_max(a: usize, b: usize) -> usize {
    if a > b {
        a
    } else {
        b
    }
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
            open_by_left: Vec::new(),
            coarsening: 2.0,
            over_work: false,
            work_budget: MAX_SWEEP_WORK,
            vertices: Vec::new(),
            triangles: Vec::new(),
            boundary: Vec::new(),
            point_limit: MAX_CHORDS,
            union_output: false,
            publish_points: false,
            tops: Vec::new(),
            bottoms: Vec::new(),
            boxes: Vec::new(),
            box_ys: Vec::new(),
            box_events: Vec::new(),
            tree_max: Vec::new(),
            tree_add: Vec::new(),
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
                work: 0,
                winding_bound: 0,
            },
        }
    }

    /// Reserves every buffer once; `Err` when an allocation is refused.
    pub(crate) fn reserve(&mut self) -> Result<(), ()> {
        if self.reserved {
            return Ok(());
        }
        reserve(&mut self.subpaths, MAX_SUBPATHS)?;
        reserve(&mut self.points, MAX_WINDING_VERTICES)?;
        reserve(&mut self.corners, MAX_WINDING_VERTICES)?;
        reserve(&mut self.piece, MAX_ARC_STEPS + 8)?;
        reserve(&mut self.edges, MAX_EDGES)?;
        reserve(&mut self.active, MAX_ACTIVE)?;
        reserve(&mut self.keys, MAX_ACTIVE)?;
        reserve(&mut self.spans, MAX_ACTIVE)?;
        reserve(&mut self.open, MAX_ACTIVE)?;
        reserve(&mut self.open_by_left, MAX_EDGES)?;
        self.open_by_left.resize(MAX_EDGES, 0);
        reserve(&mut self.vertices, MAX_WINDING_VERTICES.max(SWEEP_VERTICES))?;
        reserve(&mut self.triangles, MAX_WINDING_INDICES.max(SWEEP_INDICES))?;
        reserve(&mut self.tops, MAX_WINDING_VERTICES)?;
        reserve(&mut self.bottoms, MAX_WINDING_VERTICES)?;
        reserve(&mut self.boxes, MAX_BOXES)?;
        reserve(&mut self.box_ys, 2 * MAX_BOXES)?;
        reserve(&mut self.box_events, 2 * MAX_BOXES)?;
        reserve(&mut self.tree_max, 8 * MAX_BOXES)?;
        reserve(&mut self.tree_add, 8 * MAX_BOXES)?;
        self.tree_max.resize(8 * MAX_BOXES, 0);
        self.tree_add.resize(8 * MAX_BOXES, 0);
        self.reserved = true;
        Ok(())
    }

    /// Bytes `reserve` requests, from the capacities alone.
    pub(crate) const fn reserved_bytes() -> usize {
        use std::mem::size_of;
        MAX_SUBPATHS * size_of::<Subpath>()
            + MAX_WINDING_VERTICES * (size_of::<Point>() + size_of::<bool>())
            + (MAX_ARC_STEPS + 8) * size_of::<Point>()
            + MAX_EDGES * size_of::<Edge>()
            + MAX_ACTIVE
                * (size_of::<u32>()
                    + size_of::<(f64, f64, u32)>()
                    + size_of::<(u32, u32)>()
                    + size_of::<OpenSpan>())
            + MAX_EDGES * size_of::<u32>()
            + const_max(MAX_WINDING_VERTICES, SWEEP_VERTICES) * size_of::<Point>()
            + const_max(MAX_WINDING_INDICES, SWEEP_INDICES) * size_of::<u32>()
            + 2 * MAX_WINDING_VERTICES * size_of::<f64>()
            + MAX_BOXES * size_of::<WindingBox>()
            + 2 * MAX_BOXES * (size_of::<f64>() + size_of::<(f64, u32, bool)>())
            + 16 * MAX_BOXES * size_of::<i64>()
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
            + self.open_by_left.capacity() * size_of::<u32>()
            + self.vertices.capacity() * size_of::<Point>()
            + self.triangles.capacity() * size_of::<u32>()
            + (self.tops.capacity() + self.bottoms.capacity()) * size_of::<f64>()
            + self.boxes.capacity() * size_of::<WindingBox>()
            + self.box_ys.capacity() * size_of::<f64>()
            + self.box_events.capacity() * size_of::<(f64, u32, bool)>()
            + (self.tree_max.capacity() + self.tree_add.capacity()) * size_of::<i64>()
    }

    /// The published vertices, triangles (three indices each) and boundary pairs (none).
    pub(crate) fn mesh(&self) -> (&[Point], &[u32], &[[u32; 2]]) {
        if self.publish_points {
            return (&self.points, &self.triangles, &self.boundary);
        }
        (&self.vertices, &self.triangles, &self.boundary)
    }

    /// E39-K1 and K5: the fill of a validated path as a winding mesh, a fan from each
    /// subpath's first flattened point, at `tol` or coarser (K4).
    pub(crate) fn build_fill_winding(
        &mut self,
        verbs: &[u8],
        points: &[u8],
        tol: f64,
    ) -> WindingFill {
        self.point_limit = MAX_WINDING_VERTICES;
        let built = self.build(verbs, points, tol, |mesh, _| mesh.fans());
        self.point_limit = MAX_CHORDS;
        match built {
            None => WindingFill::Refused,
            Some(false) => WindingFill::Empty,
            Some(true) => {
                let bound = self.winding_bound();
                self.stats.winding_bound = bound;
                if bound >= WINDING_FALLBACK {
                    WindingFill::TooWound
                } else {
                    self.publish_points = true;
                    WindingFill::Mesh
                }
            }
        }
    }

    /// E39-K2: the stroke of a validated path as a union mesh (every piece fanned), as
    /// `build_stroke` answers.
    pub(crate) fn build_stroke_union(
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
        self.point_limit = MAX_WINDING_VERTICES;
        self.union_output = true;
        let built = self.build(verbs, points, tol, |mesh, tol| {
            mesh.stroke_pieces(style, tol)?;
            Ok(!mesh.triangles.is_empty())
        });
        self.union_output = false;
        self.point_limit = MAX_CHORDS;
        built
    }

    /// E39-K1: the fan triangles `(p_0, p_i, p_{i+1})` of every subpath, collinear ones left
    /// out.
    fn fans(&mut self) -> Result<bool, Full> {
        for index in 0..self.subpaths.len() {
            let subpath = self.subpaths[index];
            if subpath.count < 3 {
                continue;
            }
            let first = subpath.start;
            let origin = self.points[first];
            for i in first + 1..first + subpath.count - 1 {
                let a = sub(self.points[i], origin);
                let b = sub(self.points[i + 1], origin);
                let area = cross(a, b);
                if area == 0.0 || area.is_nan() {
                    continue;
                }
                if self.triangles.len() + 3 > MAX_WINDING_INDICES {
                    return Err(Full);
                }
                self.triangles
                    .extend_from_slice(&[first as u32, i as u32, i as u32 + 1]);
            }
        }
        Ok(!self.triangles.is_empty())
    }

    /// E39-K5: a bound on the absolute winding number of the flattened fill. Per subpath, half
    /// the largest number of its edges whose closed `y`-span contains one `y` (a horizontal
    /// line through any point meets each such edge once, left or right of the point, and the
    /// winding number is the same either way); over the path, the largest sum of these over
    /// subpath boxes that contain one point.
    fn winding_bound(&mut self) -> u32 {
        self.boxes.clear();
        let mut total = 0u64;
        for index in 0..self.subpaths.len() {
            let subpath = self.subpaths[index];
            if subpath.count < 3 {
                continue;
            }
            let bound = self.subpath_bound(subpath);
            if bound == 0 {
                continue;
            }
            let mut min = self.points[subpath.start];
            let mut max = min;
            for p in &self.points[subpath.start..subpath.start + subpath.count] {
                min = Point {
                    x: min.x.min(p.x),
                    y: min.y.min(p.y),
                };
                max = Point {
                    x: max.x.max(p.x),
                    y: max.y.max(p.y),
                };
            }
            total += u64::from(bound);
            if self.boxes.len() == MAX_BOXES {
                self.merge_box_pairs();
            }
            self.boxes.push(WindingBox { min, max, bound });
        }
        if total < u64::from(WINDING_FALLBACK) {
            return total as u32;
        }
        self.box_depth()
    }

    /// Replaces boxes `2i` and `2i + 1` by the box around both with the sum of their bounds: a
    /// point in either is in the merged box, and its sum over the boxes containing it can only
    /// grow, so the bound stays conservative. Subpaths come in path order, so pairs are mostly
    /// near each other (the contours of one glyph, neighbouring glyphs).
    fn merge_box_pairs(&mut self) {
        let pairs = self.boxes.len() / 2;
        for i in 0..pairs {
            let (a, b) = (self.boxes[2 * i], self.boxes[2 * i + 1]);
            self.boxes[i] = WindingBox {
                min: Point {
                    x: a.min.x.min(b.min.x),
                    y: a.min.y.min(b.min.y),
                },
                max: Point {
                    x: a.max.x.max(b.max.x),
                    y: a.max.y.max(b.max.y),
                },
                bound: a.bound.saturating_add(b.bound),
            };
        }
        if self.boxes.len() % 2 == 1 {
            self.boxes[pairs] = self.boxes[2 * pairs];
            self.boxes.truncate(pairs + 1);
        } else {
            self.boxes.truncate(pairs);
        }
    }

    fn subpath_bound(&mut self, subpath: Subpath) -> u32 {
        self.tops.clear();
        self.bottoms.clear();
        let (start, n) = (subpath.start, subpath.count);
        for i in 0..n {
            let a = self.points[start + i];
            let b = self.points[start + (i + 1) % n];
            // `tops` and `bottoms` hold `MAX_WINDING_VERTICES`, as many as there are points.
            self.tops.push(a.y.min(b.y));
            self.bottoms.push(a.y.max(b.y));
        }
        self.tops.sort_unstable_by(f64::total_cmp);
        self.bottoms.sort_unstable_by(f64::total_cmp);
        let mut ended = 0usize;
        let mut deepest = 0usize;
        for (started, &y) in self.tops.iter().enumerate() {
            while ended < n && self.bottoms[ended] < y {
                ended += 1;
            }
            deepest = deepest.max(started + 1 - ended);
        }
        (deepest / 2) as u32
    }

    /// The largest sum of box bounds over the boxes containing one point (closed boxes): a
    /// sweep in `x` with a max segment tree over the boxes' `y` ends.
    fn box_depth(&mut self) -> u32 {
        self.box_ys.clear();
        self.box_events.clear();
        for (index, b) in self.boxes.iter().enumerate() {
            self.box_ys.push(b.min.y);
            self.box_ys.push(b.max.y);
            self.box_events.push((b.min.x, index as u32, true));
            self.box_events.push((b.max.x, index as u32, false));
        }
        self.box_ys.sort_unstable_by(f64::total_cmp);
        self.box_ys.dedup();
        // At one x, every box that starts there counts before any box that ends there.
        self.box_events
            .sort_unstable_by(|a, b| a.0.total_cmp(&b.0).then(b.2.cmp(&a.2)));
        let leaves = self.box_ys.len();
        let nodes = (4 * leaves).min(self.tree_max.len());
        self.tree_max[..nodes].fill(0);
        self.tree_add[..nodes].fill(0);
        let mut deepest = 0i64;
        for k in 0..self.box_events.len() {
            let (_, index, opens) = self.box_events[k];
            let b = self.boxes[index as usize];
            let lo = self.box_ys.partition_point(|&y| y < b.min.y);
            let hi = self.box_ys.partition_point(|&y| y <= b.max.y) - 1;
            let value = if opens {
                i64::from(b.bound)
            } else {
                -i64::from(b.bound)
            };
            self.tree_update(1, 0, leaves - 1, lo, hi, value);
            if opens {
                deepest = deepest.max(self.tree_max[1]);
            }
        }
        deepest.clamp(0, i64::from(u32::MAX)) as u32
    }

    fn tree_update(
        &mut self,
        node: usize,
        left: usize,
        right: usize,
        lo: usize,
        hi: usize,
        value: i64,
    ) {
        if hi < left || right < lo {
            return;
        }
        if lo <= left && right <= hi {
            self.tree_max[node] += value;
            self.tree_add[node] += value;
            return;
        }
        let middle = (left + right) / 2;
        self.tree_update(2 * node, left, middle, lo, hi, value);
        self.tree_update(2 * node + 1, middle + 1, right, lo, hi, value);
        self.tree_max[node] =
            self.tree_add[node] + self.tree_max[2 * node].max(self.tree_max[2 * node + 1]);
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
        self.publish_points = false;
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
        self.work_budget = MAX_SWEEP_WORK;
        let mut over_work_at = None;
        // E39-K4: the served tolerance as doublings of the requested one (an over-budget sweep
        // multiplies by up to 2^16 in one retry), and the requested flattening's chord count.
        let mut doublings = 0u32;
        let mut requested_chords = None;
        for attempt in 0..=MAX_COARSENINGS {
            self.clear();
            self.stats.coarsenings = doublings;
            self.stats.tolerance = tol;
            let result = self.flatten(verbs, points, tol).and_then(|()| {
                if attempt == 0 {
                    requested_chords = Some(self.stats.chords);
                }
                // A sweep over its budget whose coarsening left the chords as they were (a
                // path of lines) would only fail again: this attempt runs unbudgeted, since
                // its work is then the path's own crossings.
                if over_work_at == Some(self.stats.chords) {
                    self.work_budget = u64::MAX;
                }
                body(self, tol)
            });
            match result {
                Ok(drawn) => {
                    // Wang's chord count per cubic never grows with the tolerance, so an equal
                    // total is the requested flattening itself (a path of lines): not coarser.
                    if requested_chords == Some(self.stats.chords) {
                        self.stats.coarsenings = 0;
                    }
                    return Some(drawn);
                }
                Err(Full) => {
                    over_work_at = self.over_work.then_some(self.stats.chords);
                    self.over_work = false;
                    tol *= self.coarsening;
                    doublings += self.coarsening.log2() as u32;
                    self.coarsening = 2.0;
                }
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
        if self.points.len() >= self.point_limit {
            return Err(Full);
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
        // Relative to the first point, so huge or far-off coordinates neither overflow nor
        // cancel.
        let origin = self.piece[0];
        let mut area = 0.0;
        for i in 1..n - 1 {
            area += cross(sub(self.piece[i], origin), sub(self.piece[i + 1], origin));
        }
        if area == 0.0 || area.is_nan() {
            return Ok(());
        }
        if self.union_output {
            // E39-K2: the piece as a fan from its first point (orientation does not matter:
            // the renderer marks the union).
            if self.vertices.len() + n > MAX_WINDING_VERTICES
                || self.triangles.len() + 3 * (n - 2) > MAX_WINDING_INDICES
            {
                return Err(Full);
            }
            let base = self.vertices.len() as u32;
            self.vertices.extend_from_slice(&self.piece);
            for i in 1..n as u32 - 1 {
                self.triangles
                    .extend_from_slice(&[base, base + i, base + i + 1]);
            }
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
                // E39-K2: in a union mesh, an end with a join also takes its centre point as a
                // vertex, fanned from the start's centre, so the join's edges from the centre
                // meet the chord at shared vertices. Without it the centre is a T-junction on
                // the chord's end edge, and the f32 transform can open a crack between them
                // that a sample falls through.
                let joined_start = self.union_output && (subpath.closed || i > 0);
                let joined_end = self.union_output && (subpath.closed || i + 2 < n);
                self.piece.clear();
                if joined_start {
                    self.piece.push(a);
                }
                self.piece.push(add(a, normal));
                self.piece.push(add(b, normal));
                if joined_end {
                    self.piece.push(b);
                }
                self.piece.push(sub(b, normal));
                self.piece.push(sub(a, normal));
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
                    // From n0 around the outer side: counterclockwise when the outer side is
                    // the right (`side` = -1). Signed from `side`, not from `turn`, so an exact
                    // reversal (`turn` = ±0) sweeps through d0 whatever the zero's sign.
                    let sweep = -side * turn.atan2(cosine).abs();
                    self.piece.clear();
                    self.piece.push(p);
                    arc(&mut self.piece, p, n0, sweep, r, tol);
                    if self.union_output {
                        // E39-K2: the arc's ends are the chords' corners bit for bit, so the
                        // pieces share those vertices (no crack in a union mesh).
                        let last = self.piece.len() - 1;
                        self.piece[1] = a;
                        self.piece[last] = b;
                    }
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
                if self.union_output {
                    // E39-K2: the half disk's ends are the end chord's corners bit for bit.
                    let last = self.piece.len() - 1;
                    self.piece[0] = add(p, normal);
                    self.piece[last] = sub(p, normal);
                }
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
        if self.vertices.len() + 4 > SWEEP_VERTICES || self.triangles.len() + 6 > SWEEP_INDICES {
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
                self.open_by_left[span.left as usize] = kept as u32;
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

    /// The sweep ran over `MAX_SWEEP_WORK` with `next` edges started: projects its whole work
    /// from that share and records the coarsening that should bring it under the budget. The
    /// work grows about as `tol^-1.5` (chords as `tol^-0.5`, and the overlap depth and active
    /// edges with them), so the factor is the overrun to the power 2/3, as a power of two.
    fn over_budget(&mut self, next: usize) -> Full {
        let share = (next as f64 / self.edges.len().max(1) as f64).max(1.0 / 1024.0);
        let overrun = 1.0 / share;
        let factor = (overrun.powf(2.0 / 3.0) * 1.25)
            .log2()
            .ceil()
            .clamp(1.0, 16.0);
        self.coarsening = 2f64.powf(factor);
        self.over_work = true;
        Full
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
            let order = |a: &(f64, f64, u32), b: &(f64, f64, u32)| {
                a.0.total_cmp(&b.0)
                    .then(a.1.total_cmp(&b.1))
                    .then(a.2.cmp(&b.2))
            };
            loop {
                self.stats.slabs += 1;
                self.stats.work += 4 * self.active.len() as u64 + self.open.len() as u64;
                if self.stats.work > self.work_budget {
                    return Err(self.over_budget(next));
                }
                if splits == 0 {
                    self.keys.clear();
                    for &index in &self.active {
                        let edge = &self.edges[index as usize];
                        self.keys.push((edge.x_at(top), edge.x_at(y1), index));
                    }
                    self.keys.sort_unstable_by(order);
                } else {
                    // Below a crossing the previous order is almost right: refresh the keys
                    // and insertion-sort them (linear when few neighbours swapped).
                    for key in self.keys.iter_mut() {
                        let edge = &self.edges[key.2 as usize];
                        *key = (edge.x_at(top), edge.x_at(y1), key.2);
                    }
                    for i in 1..self.keys.len() {
                        let mut j = i;
                        while j > 0 && order(&self.keys[j - 1], &self.keys[j]).is_gt() {
                            self.keys.swap(j - 1, j);
                            j -= 1;
                            self.stats.work += 1;
                        }
                        if self.stats.work > self.work_budget {
                            return Err(self.over_budget(next));
                        }
                    }
                }
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
                    let slot = self.open_by_left[l as usize] as usize;
                    match self.open.get_mut(slot) {
                        Some(span) if span.left == l && span.right == r => {
                            span.seen = generation;
                        }
                        _ => {
                            self.open_by_left[l as usize] = self.open.len() as u32;
                            push(
                                &mut self.open,
                                OpenSpan {
                                    left: l,
                                    right: r,
                                    y: top,
                                    seen: generation,
                                },
                            )?;
                        }
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
