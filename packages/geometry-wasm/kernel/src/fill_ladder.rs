//! P3 Alt-A1 production fast rung and two-rung fallback ladder, unit AL-U1 of the frozen
//! contract `docs/plans/p3-alt-a1-fill-ladder-contract.md` (sections 3 and 4).
//!
//! This is the production port of the frozen spike module `p3_b0_spike.rs` (contract
//! `docs/plans/p3-b0-spike-ladder-contract.md`, stages FR1-FR8 of its section 2.3 and the
//! proof of its section 3). The stage order, the check order inside each stage, the thresholds
//! and every proved/not-proved decision are the spike's, with the three production additions of
//! section 3.1: AL-FR0 (a conservative tolerance range), AL-M5 (a strengthened closure bound)
//! and AL-FR9 (an always-on output check). From AL-U3 (revision 2) `fill_export::build_path`
//! runs rung 0 as step 0 of stage 4, and V2's exact cascade on a fallback.
//!
//! Nothing in a call allocates: the fast rung's storage is reserved once by
//! `FillLadder::reserve` (section 3.4), the rest is bounded stack scratch, and the exact rung
//! allocates nothing inside its `attempt*` entries (B0R O7).
//!
//! Correspondence of checks to the proof, in stage order:
//!
//! | Stage  | Check (function)                                                | Condition, lemma         | Reason                  |
//! | ------ | --------------------------------------------------------------- | ------------------------ | ----------------------- |
//! | AL-FR0 | `FillLadder::fast_rung`: −511 ≤ e ≤ 510                          | contract 3.2 (no proof)  | `RANGE`                 |
//! | S1     | `CubicFillWorkspace::prepare_prefix`, `FastRung::load`          | spike 2.2                | `PREFIX`                |
//! | FR1    | `structure`: source pieces, closure classes, contraction, n ≥ 3 | SL-C0, spike 3.3, 3.6    | `STRUCTURE`             |
//! | FR2    | `deviation`: max over m of \|d_m\|² < δ² on P′                   | SL-C1, SL-L1             | `DEVIATION`             |
//! | FR3    | `closure`: SL-M1-M4, then AL-M5                                 | SL-L5; contract 3.3      | `CLOSURE`               |
//! | FR4    | `monotone`: consecutive pairs of P′                             | SL-C2, SL-L2             | `MONOTONE`              |
//! | FR5    | `clearance`: sweep, box gap, `segment_relation`, SL-L4 tests    | SL-C3, SL-L3/L4, spike 3.9 | `CROSSING`, `CLEARANCE` |
//! | FR6    | `classify`: orientation, nesting, winding, boundary contours    | SL-T1, SL-T2             | `STRUCTURE`             |
//! | FR7    | `triangulate`: monotone decomposition, stack triangulation      | positive triangles       | `TRIANGLE`              |
//! | FR8    | `assemble`                                                      | none                     | `TRIANGLE` (empty)      |
//! | AL-FR9 | `check_output`: items 1-3 of contract 3.5                       | SL-O2's argument; SL-OB4 | `MESH_CHECK`            |
//!
//! "Proved" means decided by an exact predicate (`orient2d`, `segment_relation`) or by
//! `fill_filter::Interval` arithmetic with `compare_enclosures` or `Interval::sign` under
//! B0R's facts R1-R3. An interval never decides a true zero or an exact tie with a threshold, so
//! every strict inequality below falls back at equality. "Not proved" covers both false and
//! undecided; either returns the stage's fallback reason, and the ladder then runs the exact
//! rung on the same input (contract section 3.1).
use core::cmp::Ordering;
use core::mem::size_of;

use crate::codec::{PathInput, Request};
use crate::cubic_fill::{
    ContourRange, CubicFillDiagnostics, CubicFillError, CubicFillWorkspace, DecodedSource,
    EdgeOwner, S1View, MAX_CONTOURS as PREFIX_MAX_CONTOURS,
    MAX_CONTOUR_POINTS as PREFIX_MAX_POINTS, MAX_EDGE_OWNERS as PREFIX_MAX_EDGES,
    MAX_FLAT_COMMANDS, MAX_SOURCE_SEGMENTS as PREFIX_MAX_SOURCES,
};
use crate::engine::{BATCH_ALLOCATION_FAILED, BATCH_INTERNAL_ERROR};
use crate::fill_export::{tolerances, FillRequest};
use crate::fill_filter::{compare_enclosures, Interval, UNDECIDED};
use crate::fill_predicates::{orient2d, segment_relation, SegmentRelation};
use crate::geometry::Point;
use crate::line_fill::LineFillRule;
use crate::rounded_line_fill::RoundedFillLimits;
use crate::simple_cubic_topology::TopologyError;

/// Contract section 3.2, AL-FR0: the smallest tolerance exponent rung 0 accepts.
pub(crate) const MIN_FAST_EXPONENT: i32 = -511;
/// Contract section 3.2, AL-FR0: the largest tolerance exponent rung 0 accepts.
pub(crate) const MAX_FAST_EXPONENT: i32 = 510;

/// Section 3.4: the caps the S1 prefix enforces (`cubic_fill.rs`). The fast rung's arrays are
/// derived from them, so a B1 cap raise resizes them with the prefix.
pub(crate) const MAX_POINTS: usize = PREFIX_MAX_POINTS;
pub(crate) const MAX_EDGES: usize = PREFIX_MAX_EDGES;
pub(crate) const MAX_CONTOURS: usize = PREFIX_MAX_CONTOURS;
pub(crate) const MAX_SOURCES: usize = PREFIX_MAX_SOURCES;
/// Section 3.4: a polygonal region with n vertices, k ≥ 1 outer components and h holes has
/// n + 2h − 2k triangles (spike section 2.5); this bounds it with h ≤ MAX_CONTOURS, k ≥ 1.
/// Overflow is `TRIANGLE`.
pub(crate) const MAX_TRIANGLES: usize = MAX_POINTS + 2 * MAX_CONTOURS - 2;
/// Section 3.4, "the diagonal array is sized likewise": a full triangulation has
/// n + 3h − 3k diagonals and the monotone decomposition adds a subset of them. Overflow is
/// `TRIANGLE`.
pub(crate) const MAX_DIAGONALS: usize = MAX_POINTS + 3 * MAX_CONTOURS - 3;
/// Section 3.4, boundary scratch: AL-FR9 scans at most this many directed-edge records.
pub(crate) const MAX_BOUNDARY_RECORDS: usize = 3 * MAX_TRIANGLES;
/// Boundary half-edges plus both directions of every diagonal (FR7 face tracing).
const MAX_HALF_EDGES: usize = MAX_POINTS + 2 * MAX_DIAGONALS;
/// P2's deepest leaf (`geometry.rs` `MAX_DEPTH`, enforced by `validate_leaf_partitions`).
const MAX_LEAF_DEPTH: u32 = 20;

// The FR5 candidate bitset holds one u64 row per certified edge (spike section 2.5).
const _: () = assert!(MAX_EDGES <= 64);
// FR7 and AL-FR9 store vertex indices as u32.
const _: () = assert!(MAX_POINTS <= u32::MAX as usize);

/// Section 3.1: the fallback reasons, in stage order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Reason {
    Range,
    Prefix,
    Structure,
    Deviation,
    Closure,
    Monotone,
    Crossing,
    Clearance,
    Triangle,
    MeshCheck,
}

impl Reason {
    pub(crate) const ALL: [Self; 10] = [
        Self::Range,
        Self::Prefix,
        Self::Structure,
        Self::Deviation,
        Self::Closure,
        Self::Monotone,
        Self::Crossing,
        Self::Clearance,
        Self::Triangle,
        Self::MeshCheck,
    ];

    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::Range => "RANGE",
            Self::Prefix => "PREFIX",
            Self::Structure => "STRUCTURE",
            Self::Deviation => "DEVIATION",
            Self::Closure => "CLOSURE",
            Self::Monotone => "MONOTONE",
            Self::Crossing => "CROSSING",
            Self::Clearance => "CLEARANCE",
            Self::Triangle => "TRIANGLE",
            Self::MeshCheck => "MESH_CHECK",
        }
    }
}

/// The fast rung's stages after S1; `FastRung::run` stops after the given one (the diagnostic
/// stops of spike section 5.8 and of AL-U4a).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Stage {
    S1,
    Fr1,
    Fr2,
    Fr3,
    Fr4,
    Fr5,
    Fr6,
    Fr7,
    Fr8,
    Fr9,
}

/// The rung that produced a path's output (section 3.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Rung {
    Fast,
    Exact,
}

/// The exact rung's topology selection: V2's two-step cascade (V2 section c).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ExactStep {
    /// `attempt` only.
    Legacy,
    /// `attempt`, then `attempt_triangle_free` after `KnotMismatch` or `Unresolved`.
    TriangleFree,
}

/// Seeded defects: the spike's (1)-(10) (spike section 4.8), the production defects (11)-(13)
/// (contract section 4.3), and the fault variants of fixtures AL-F8, AL-F8b and AL-F10. The
/// enum and the `fault` call sites compile into every build; only the switch state and
/// `with_ladder_faults` are test-only, and outside test builds `fault` is constant `false`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LadderFault {
    /// (1) Clearance comparisons with >= instead of > (with `Fault::R1WideningRemoved`).
    ClearanceGreaterEqual,
    /// (2) d_0 and d_3 (the knot errors) omitted from δ(e).
    KnotErrorsOmitted,
    /// (3) SL-C2 checks only the chords.
    MonotoneChordsOnly,
    /// (4) SL-C3 replaced by `segment_relation` alone (simplicity only).
    SimplicityOnly,
    /// (5) SL-M4's cone test inverted.
    ConeInverted,
    /// (6) Nesting taken from orientation alone.
    NestingFromOrientation,
    /// (7) and AL-F8: one assembled triangle flipped after FR8.
    TriangleFlipped,
    /// (8) A non-boundary contour triangulated as a boundary.
    NonBoundaryTriangulated,
    /// (9) The sweep's scan bound xhi(a) instead of xhi(a) + r.
    ScanBoundWithoutRadius,
    /// (10) The consecutive-pair skip also skips edges two apart in one contour.
    SkipTwoApart,
    /// (11) AL-M5 omitted.
    AlM5Omitted,
    /// (12) AL-FR0 omitted.
    RangeOmitted,
    /// (13) AL-FR9 item 3 disabled.
    MeshCheckItem3Disabled,
    /// AL-F8b (a): one assembled triangle dropped after FR8.
    TriangleDropped,
    /// AL-F8b (c): one assembled triangle with a vertex replaced by another polygon vertex,
    /// still positive, with no directed edge repeated.
    VertexSubstituted,
    /// AL-F10: the FR7 orientation check fails at the first emitted triangle.
    Fr7OrientationRejected,
}

#[cfg(test)]
thread_local! {
    static LADDER_FAULTS: core::cell::Cell<u32> = const { core::cell::Cell::new(0) };
}

#[cfg(test)]
fn fault(which: LadderFault) -> bool {
    LADDER_FAULTS.with(|active| active.get() & (1u32 << which as u32) != 0)
}

#[cfg(not(test))]
#[inline(always)]
fn fault(_which: LadderFault) -> bool {
    false
}

/// Runs `action` with the given faults switched on in this thread, then switches them off
/// (the `fill_filter::with_fault` pattern, for several faults at once).
#[cfg(test)]
pub(crate) fn with_ladder_faults<T>(faults: &[LadderFault], action: impl FnOnce() -> T) -> T {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            LADDER_FAULTS.with(|active| active.set(0));
        }
    }
    let mask = faults
        .iter()
        .fold(0u32, |mask, which| mask | (1u32 << *which as u32));
    LADDER_FAULTS.with(|active| active.set(mask));
    let _reset = Reset;
    action()
}

/// AL-FR9 item 2 and the boundary derivation (contract section 3.5): V2 section f's once-only
/// scan, the existing `collect_boundary` of `fill_export.rs`, run on the fast triangles. The
/// export implements it on its reserved fill scratch (`FillScratch`, from AL-U3).
pub(crate) trait BoundaryScan {
    /// Scans `triangles` (counterclockwise index triples, flattened, in output order). Returns
    /// the edges used exactly once as directed pairs in triangle order, or `None` when a
    /// directed edge occurs twice or the scan's own self-check fails (`MESH_CHECK`).
    fn scan(&mut self, triangles: &[u32]) -> Option<&[[u32; 2]]>;
}

/// An interval point: a closed box enclosing one real point.
#[derive(Clone, Copy, Debug, PartialEq)]
struct IPoint {
    x: Interval,
    y: Interval,
}

impl Default for IPoint {
    fn default() -> Self {
        Self::exact(Point::default())
    }
}

impl IPoint {
    fn exact(point: Point) -> Self {
        Self {
            x: Interval::point(point.x),
            y: Interval::point(point.y),
        }
    }

    fn add(self, other: Self) -> Self {
        Self {
            x: self.x.add(other.x),
            y: self.y.add(other.y),
        }
    }

    fn sub(self, other: Self) -> Self {
        Self {
            x: self.x.sub(other.x),
            y: self.y.sub(other.y),
        }
    }

    fn mul(self, scale: Interval) -> Self {
        Self {
            x: self.x.mul(scale),
            y: self.y.mul(scale),
        }
    }

    fn div(self, scale: Interval) -> Self {
        Self {
            x: self.x.div(scale),
            y: self.y.div(scale),
        }
    }
}

fn exact_difference(left: Point, right: Point) -> IPoint {
    IPoint::exact(left).sub(IPoint::exact(right))
}

fn dot(left: IPoint, right: IPoint) -> Interval {
    left.x.mul(right.x).add(left.y.mul(right.y))
}

fn cross(left: IPoint, right: IPoint) -> Interval {
    left.x.mul(right.y).sub(left.y.mul(right.x))
}

fn norm_squared(value: IPoint) -> Interval {
    dot(value, value)
}

/// R3: the enclosed value is proved strictly positive.
fn proved_positive(value: Interval) -> bool {
    value.sign() == Some(Ordering::Greater)
}

/// R3: the enclosed value is proved strictly negative.
fn proved_negative(value: Interval) -> bool {
    value.sign() == Some(Ordering::Less)
}

/// R3 on enclosures: `value < bound` is proved.
fn proved_below(value: Interval, bound: Interval) -> bool {
    compare_enclosures(value, bound) == Some(Ordering::Less)
}

/// Spike section 3.9: `value > bound` is proved strictly (R1 widening, then R3). A value
/// exactly at the bound is never proved greater, which is what makes SL-C3 strict (SL-L3).
/// Seeded defect (1) relaxes the comparison to `>=`; together with `Fault::R1WideningRemoved`
/// an exact value at r then counts as proved.
fn proved_exceeds(value: Interval, bound: Interval) -> bool {
    if fault(LadderFault::ClearanceGreaterEqual) {
        value.is_finite() && bound.is_finite() && value.lo >= bound.hi
    } else {
        compare_enclosures(value, bound) == Some(Ordering::Greater)
    }
}

/// AL-M5 (contract section 3.3): an enclosure of a norm from an upper bound of its square. IEEE
/// 754 square root is correctly rounded, so R1 widens its result outward by one ulp; the norm
/// lies in [0, next_up(fl(√bound))]. A non-finite or negative bound is undecidable.
fn norm_from_squared_bound(squared_upper: f64) -> Interval {
    if !(squared_upper.is_finite() && squared_upper >= 0.0) {
        return UNDECIDED;
    }
    let root = squared_upper.sqrt().next_up();
    if root.is_finite() {
        Interval { lo: 0.0, hi: root }
    } else {
        UNDECIDED
    }
}

fn same_point(left: Point, right: Point) -> bool {
    left.x == right.x && left.y == right.y
}

fn orient(a: Point, b: Point, c: Point, reason: Reason) -> Result<Ordering, Reason> {
    orient2d(a, b, c).map_err(|_| reason)
}

/// The source piece γ_e of a polygon edge (spike section 3.3).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
enum Piece {
    #[default]
    Unset,
    /// A `CubicLeaf`: the source cubic `controls` restricted to [(n − 1)/2^d, n/2^d].
    Leaf {
        source: usize,
        controls: [Point; 4],
        numerator: u32,
        depth: u32,
    },
    /// A `Line` source segment, or a closing segment z → m (a degenerate one has a = b = m).
    Segment { a: Point, b: Point },
}

impl Piece {
    /// γ_e(1) as an exact source point, when it is one (spike section 3.3, consistency).
    fn end_point(self) -> Option<Point> {
        match self {
            Self::Leaf {
                controls,
                numerator,
                depth,
                ..
            } if u64::from(numerator) == 1u64 << depth => Some(controls[3]),
            Self::Segment { b, .. } => Some(b),
            _ => None,
        }
    }

    /// γ_e(0) as an exact source point, when it is one.
    fn start_point(self) -> Option<Point> {
        match self {
            Self::Leaf {
                controls,
                numerator: 1,
                ..
            } => Some(controls[0]),
            Self::Segment { a, .. } => Some(a),
            _ => None,
        }
    }
}

/// Spike section 3.3, consistency at vertices: γ_e(1) = γ_f(0) for f following e. Within one
/// source cubic the leaves' dyadic intervals must abut; across sources both ends must be the
/// same exact source point. S1 guarantees this; FR1 checks the premise rather than assuming it.
fn consistent(previous: Piece, following: Piece) -> bool {
    if let (
        Piece::Leaf {
            source: left_source,
            numerator: left_numerator,
            depth: left_depth,
            ..
        },
        Piece::Leaf {
            source: right_source,
            numerator: right_numerator,
            depth: right_depth,
            ..
        },
    ) = (previous, following)
    {
        // n_e / 2^d_e == (n_f − 1) / 2^d_f, cross-multiplied in u64 (depths at most 20).
        if left_source == right_source
            && u64::from(left_numerator) << right_depth
                == u64::from(right_numerator - 1) << left_depth
        {
            return true;
        }
    }
    match (previous.end_point(), following.start_point()) {
        (Some(end), Some(start)) => same_point(end, start),
        _ => false,
    }
}

/// One edge of the certified polygon P′ (P with every micro-closure contracted, SL-L5).
#[derive(Clone, Copy, Debug, Default)]
struct CertEdge {
    start: Point,
    end: Point,
    piece: Piece,
    /// FR2: enclosures of R0-R3 for a leaf, or the exact segment ends in [0] and [1].
    controls: [IPoint; 4],
    /// FR2: the largest certified upper bound of |d_m|² over this edge's checked terms, the
    /// square of δ̄(e)'s upper bound as AL-M5 reads it (contract section 3.3).
    deviation_squared: f64,
    contour: usize,
    local: usize,
}

#[derive(Clone, Copy, Debug, Default)]
struct ContourInfo {
    point_start: usize,
    /// Edges of P in this contour (its point count when at least two, otherwise zero).
    edges: usize,
    cert_start: usize,
    cert_count: usize,
    /// A degenerate-source close edge was contracted (spike section 3.6, SL-L5).
    contracted: bool,
}

/// Per-call observations; not used by any decision.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct FastStats {
    /// The largest certified upper bound of |d_m|² over the certified edges (SL-O6).
    pub(crate) max_deviation_squared: f64,
    /// Non-consecutive pairs reached by the FR5 sweep.
    pub(crate) sweep_candidates: u32,
    /// Sweep candidates that reached step 2 (`segment_relation`) and step 3 (point tests).
    pub(crate) clearance_step2: u32,
    pub(crate) clearance_step3: u32,
    /// Diagonals added by the FR7 monotone decomposition.
    pub(crate) diagonals: u32,
    /// The AL-FR9 item (1, 2 or 3) that returned `MESH_CHECK`, otherwise 0.
    pub(crate) mesh_check_item: u8,
}

/// Kinds of polygon vertices in the FR7 monotone decomposition (de Berg et al., chapter 3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum VertexKind {
    Start,
    Split,
    End,
    Merge,
    /// The boundary descends through the vertex: the interior lies to its east.
    RegularRight,
    /// The boundary ascends through the vertex: the interior lies to its west.
    RegularLeft,
}

/// One fast-rung stage body.
type StageBody = fn(&mut FastRung) -> Result<(), Reason>;

/// The fast rung (contract section 3.1). Its storage is inline and fixed (section 3.4) and is
/// reserved once, inside `FillLadder`.
pub(crate) struct FastRung {
    delta: f64,
    rule: LineFillRule,
    points: [Point; MAX_POINTS],
    point_len: usize,
    ranges: [ContourRange; MAX_CONTOURS],
    range_len: usize,
    owners: [EdgeOwner; MAX_EDGES],
    owner_len: usize,
    sources: [DecodedSource; MAX_SOURCES],
    source_len: usize,
    contours: [ContourInfo; MAX_CONTOURS],
    pieces: [Piece; MAX_EDGES],
    cert: [CertEdge; MAX_EDGES],
    cert_len: usize,
    orientation: [i32; MAX_CONTOURS],
    boundary: [bool; MAX_CONTOURS],
    reversed: [bool; MAX_CONTOURS],
    vertices: [Point; MAX_POINTS],
    vertex_len: usize,
    triangles: [[u32; 3]; MAX_TRIANGLES],
    triangle_len: usize,
    published: bool,
    stats: FastStats,
}

impl Default for FastRung {
    fn default() -> Self {
        Self::new()
    }
}

impl FastRung {
    pub(crate) fn new() -> Self {
        Self {
            delta: 0.0,
            rule: LineFillRule::Nonzero,
            points: [Point::default(); MAX_POINTS],
            point_len: 0,
            ranges: [ContourRange::default(); MAX_CONTOURS],
            range_len: 0,
            owners: [EdgeOwner::ImplicitClosure { contour: 0 }; MAX_EDGES],
            owner_len: 0,
            sources: [DecodedSource::default(); MAX_SOURCES],
            source_len: 0,
            contours: [ContourInfo::default(); MAX_CONTOURS],
            pieces: [Piece::Unset; MAX_EDGES],
            cert: [CertEdge::default(); MAX_EDGES],
            cert_len: 0,
            orientation: [0; MAX_CONTOURS],
            boundary: [false; MAX_CONTOURS],
            reversed: [false; MAX_CONTOURS],
            vertices: [Point::default(); MAX_POINTS],
            vertex_len: 0,
            triangles: [[0; 3]; MAX_TRIANGLES],
            triangle_len: 0,
            published: false,
            stats: FastStats::default(),
        }
    }

    /// Clears the outputs of an earlier call, so that no fallback path can read rung 0's
    /// partial state (contract section 3.6, defect (15)).
    fn reset(&mut self) {
        self.published = false;
        self.stats = FastStats::default();
        self.cert_len = 0;
        self.vertex_len = 0;
        self.triangle_len = 0;
    }

    /// Spike section 2.3: copies the S1 view into the fixed inline arrays. A view that produced
    /// no polygon, or one larger than the S1 caps (unreachable from S1), is `PREFIX`.
    pub(crate) fn load(
        &mut self,
        view: S1View<'_>,
        delta: f64,
        rule: LineFillRule,
    ) -> Result<(), Reason> {
        self.reset();
        if view.points.is_empty()
            || view.ranges.is_empty()
            || view.points.len() > MAX_POINTS
            || view.ranges.len() > MAX_CONTOURS
            || view.owners.len() > MAX_EDGES
            || view.sources.len() > MAX_SOURCES
        {
            self.point_len = 0;
            self.range_len = 0;
            self.owner_len = 0;
            self.source_len = 0;
            return Err(Reason::Prefix);
        }
        self.delta = delta;
        self.rule = rule;
        self.point_len = view.points.len();
        self.points[..self.point_len].copy_from_slice(view.points);
        self.range_len = view.ranges.len();
        self.ranges[..self.range_len].copy_from_slice(view.ranges);
        self.owner_len = view.owners.len();
        self.owners[..self.owner_len].copy_from_slice(view.owners);
        self.source_len = view.sources.len();
        self.sources[..self.source_len].copy_from_slice(view.sources);
        Ok(())
    }

    /// Runs FR1 to `stop` in order, then AL-FR9 when `stop` is `Fr9`; the first unproved check
    /// returns its reason (spike section 2.6). Only a run through AL-FR9 publishes.
    pub(crate) fn run<S: BoundaryScan + ?Sized>(
        &mut self,
        stop: Stage,
        scan: &mut S,
    ) -> Result<(), Reason> {
        self.published = false;
        let stages: [(Stage, StageBody); 8] = [
            (Stage::Fr1, Self::structure),
            (Stage::Fr2, Self::deviation),
            (Stage::Fr3, Self::closure),
            (Stage::Fr4, Self::monotone),
            (Stage::Fr5, Self::clearance),
            (Stage::Fr6, Self::classify),
            (Stage::Fr7, Self::triangulate),
            (Stage::Fr8, Self::assemble),
        ];
        for (stage, body) in stages {
            if stage > stop {
                return Ok(());
            }
            body(self)?;
        }
        if stop >= Stage::Fr9 {
            self.check_output(scan)?;
            self.published = true;
        }
        Ok(())
    }

    /// The published fast mesh: vertices and counterclockwise triangles (contract 3.5).
    pub(crate) fn mesh(&self) -> Option<(&[Point], &[[u32; 3]])> {
        self.published.then(|| {
            (
                &self.vertices[..self.vertex_len],
                &self.triangles[..self.triangle_len],
            )
        })
    }

    pub(crate) fn stats(&self) -> FastStats {
        self.stats
    }

    /// FR6's boundary classification of the loaded contours (observational).
    pub(crate) fn boundary_contours(&self) -> &[bool] {
        &self.boundary[..self.range_len]
    }

    // ------------------------------------------------------------------------------------
    // FR1: structure (SL-C0; spike sections 3.3 and 3.6).

    fn source_end(&self, contour: usize) -> Option<Point> {
        self.sources[..self.source_len]
            .iter()
            .rev()
            .find(|source| source.contour() == contour)
            .map(|source| match *source {
                DecodedSource::Line { points, .. } => points[1],
                DecodedSource::Cubic { points, .. } => points[3],
            })
    }

    /// Spike section 3.3: the source piece of one edge from its owner and the decoded sources.
    fn resolve(
        &self,
        owner: EdgeOwner,
        contour: usize,
        is_last: bool,
        z: Point,
        m: Point,
    ) -> Result<Piece, Reason> {
        match owner {
            EdgeOwner::Line { source_verb } => self.sources[..self.source_len]
                .iter()
                .find_map(|source| match *source {
                    DecodedSource::Line {
                        points,
                        source_verb: verb,
                        contour: owner_contour,
                    } if verb == source_verb && owner_contour == contour => Some(Piece::Segment {
                        a: points[0],
                        b: points[1],
                    }),
                    _ => None,
                })
                .ok_or(Reason::Structure),
            EdgeOwner::CubicLeaf {
                source_verb,
                end_numerator,
                depth,
            } => {
                if depth > MAX_LEAF_DEPTH
                    || end_numerator == 0
                    || u64::from(end_numerator) > 1u64 << depth
                {
                    return Err(Reason::Structure);
                }
                self.sources[..self.source_len]
                    .iter()
                    .enumerate()
                    .find_map(|(index, source)| match *source {
                        DecodedSource::Cubic {
                            points,
                            source_verb: verb,
                            contour: owner_contour,
                        } if verb == source_verb && owner_contour == contour => Some(Piece::Leaf {
                            source: index,
                            controls: points,
                            numerator: end_numerator,
                            depth,
                        }),
                        _ => None,
                    })
                    .ok_or(Reason::Structure)
            }
            // Spike section 3.3: the closing segment from the last source endpoint z to the
            // MOVE point m. Only the contour's last edge may carry it.
            EdgeOwner::ImplicitClosure {
                contour: owner_contour,
            } if owner_contour == contour && is_last => Ok(Piece::Segment { a: z, b: m }),
            EdgeOwner::ExplicitClose { .. } if is_last => Ok(Piece::Segment { a: z, b: m }),
            EdgeOwner::ImplicitClosure { .. } | EdgeOwner::ExplicitClose { .. } => {
                Err(Reason::Structure)
            }
        }
    }

    fn structure(&mut self) -> Result<(), Reason> {
        if self.points[..self.point_len]
            .iter()
            .any(|point| !(point.x.is_finite() && point.y.is_finite()))
        {
            return Err(Reason::Structure);
        }
        let mut owner_start = 0usize;
        self.cert_len = 0;
        for contour in 0..self.range_len {
            let range = self.ranges[contour];
            if range.count == 0
                || range
                    .start
                    .checked_add(range.count)
                    .is_none_or(|end| end > self.point_len)
            {
                return Err(Reason::Structure);
            }
            let edges = if range.count >= 2 { range.count } else { 0 };
            if owner_start + edges > self.owner_len {
                return Err(Reason::Structure);
            }
            let m = self.points[range.start];
            let z = self.source_end(contour).ok_or(Reason::Structure)?;
            for index in 0..edges {
                self.pieces[owner_start + index] = self.resolve(
                    self.owners[owner_start + index],
                    contour,
                    index + 1 == edges,
                    z,
                    m,
                )?;
            }
            let closes = edges > 0
                && matches!(
                    self.owners[owner_start + edges - 1],
                    EdgeOwner::ImplicitClosure { .. } | EdgeOwner::ExplicitClose { .. }
                );
            // Spike section 3.6, closed polygon over an open source: z ≠ m but no close edge
            // carries the source segment [z, m], so the consistency of section 3.3 fails at m.
            if edges > 0 && !closes && !same_point(z, m) {
                return Err(Reason::Structure);
            }
            // Spike section 3.6, degenerate-source close: z = m, so the close edge g = [k, m]
            // has the single point m as its source piece; SL-L5 contracts it.
            let contracted = closes && same_point(z, m);
            // Spike section 3.3, consistency premise of the straight-line family H.
            for index in 0..edges {
                let following = (index + 1) % edges;
                if !consistent(
                    self.pieces[owner_start + index],
                    self.pieces[owner_start + following],
                ) {
                    return Err(Reason::Structure);
                }
            }
            // SL-C0 after the contractions of SL-C4 (which is also SL-M1 on P′).
            let cert_count = if contracted { edges - 1 } else { edges };
            if cert_count < 3 {
                return Err(Reason::Structure);
            }
            let cert_start = self.cert_len;
            for index in 0..cert_count {
                let (start, end, piece) = if contracted && index + 1 == cert_count {
                    // SL-L5: e′ = [p, m] replaces e = [p, k] and g = [k, m]; γ_e′ = γ_e.
                    (
                        self.points[range.start + edges - 2],
                        m,
                        self.pieces[owner_start + edges - 2],
                    )
                } else {
                    (
                        self.points[range.start + index],
                        self.points[range.start + (index + 1) % edges],
                        self.pieces[owner_start + index],
                    )
                };
                self.cert[self.cert_len] = CertEdge {
                    start,
                    end,
                    piece,
                    controls: [IPoint::default(); 4],
                    deviation_squared: 0.0,
                    contour,
                    local: index,
                };
                self.cert_len += 1;
            }
            self.contours[contour] = ContourInfo {
                point_start: range.start,
                edges,
                cert_start,
                cert_count,
                contracted,
            };
            owner_start += edges;
        }
        if owner_start != self.owner_len {
            return Err(Reason::Structure);
        }
        Ok(())
    }

    // ------------------------------------------------------------------------------------
    // FR2: deviation (SL-C1; spike section 3.3, SL-L1).

    fn deviation(&mut self) -> Result<(), Reason> {
        // Contract section 3.2: the threshold enclosure exactly as the spike builds it.
        let delta = Interval::point(self.delta);
        let delta_squared = delta.mul(delta);
        let two = Interval::point(2.0);
        let three = Interval::point(3.0);
        let knot_errors = !fault(LadderFault::KnotErrorsOmitted);
        for index in 0..self.cert_len {
            let edge = self.cert[index];
            let start = IPoint::exact(edge.start);
            let end = IPoint::exact(edge.end);
            let mut controls = [IPoint::default(); 4];
            let mut deviations = [IPoint::default(); 4];
            let checked: &[usize] = match edge.piece {
                Piece::Leaf {
                    controls: source,
                    numerator,
                    depth,
                    ..
                } => {
                    // Spike section 2.3 FR2: exact restricted controls R0-R3 enclosed by
                    // interval de Casteljau on [(n − 1)/2^d, n/2^d], following the high-to-low
                    // bits of n − 1 as P3.2g's `restrict_cell` does exactly.
                    controls = restrict(source, numerator, depth);
                    // Spike section 3.3: d_0 = R0 − p_start, d_1 = R1 − (2 p_start + p_end)/3,
                    // d_2 = R2 − (p_start + 2 p_end)/3, d_3 = R3 − p_end.
                    let third = start.mul(two).add(end).div(three);
                    let two_thirds = start.add(end.mul(two)).div(three);
                    deviations = [
                        controls[0].sub(start),
                        controls[1].sub(third),
                        controls[2].sub(two_thirds),
                        controls[3].sub(end),
                    ];
                    if knot_errors {
                        &[0, 1, 2, 3]
                    } else {
                        &[1, 2]
                    }
                }
                Piece::Segment { a, b } => {
                    // Spike section 3.3: d_0 = γ_e(0) − p_start, d_1 = γ_e(1) − p_end.
                    controls[0] = IPoint::exact(a);
                    controls[1] = IPoint::exact(b);
                    deviations[0] = controls[0].sub(start);
                    deviations[1] = controls[1].sub(end);
                    if knot_errors {
                        &[0, 1]
                    } else {
                        &[]
                    }
                }
                Piece::Unset => return Err(Reason::Structure),
            };
            self.cert[index].controls = controls;
            for &term in checked {
                // SL-C1: the upper bound of |d_m|² = d_m,x² + d_m,y² proved below δ². Overflow
                // or NaN leaves the interval undecided, which is `DEVIATION`.
                let squared = norm_squared(deviations[term]);
                if !proved_below(squared, delta_squared) {
                    return Err(Reason::Deviation);
                }
                self.stats.max_deviation_squared = self.stats.max_deviation_squared.max(squared.hi);
                // AL-M5 input: no decision here (contract section 3.3).
                self.cert[index].deviation_squared =
                    self.cert[index].deviation_squared.max(squared.hi);
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------------------------------
    // FR3: micro-closure contraction (SL-C4 = SL-M1 to SL-M4; SL-L5), then AL-M5.

    fn closure(&mut self) -> Result<(), Reason> {
        let delta = Interval::point(self.delta);
        let delta_squared = delta.mul(delta);
        for info in self.contours[..self.range_len].iter().copied() {
            if !info.contracted {
                continue;
            }
            let base = info.point_start;
            let edges = info.edges;
            // P has the cyclic vertices m, q, ..., r, p, k: f = [m, q] follows g = [k, m],
            // e = [p, k] precedes g, and h = [r, p] precedes e.
            let m = self.points[base];
            let q = self.points[base + 1];
            let r = self.points[base + edges - 3];
            let p = self.points[base + edges - 2];
            let k = self.points[base + edges - 1];
            // SL-M1: P′ still has at least three edges (also FR1's SL-C0, so unreachable here).
            if info.cert_count < 3 {
                return Err(Reason::Closure);
            }
            // SL-M2: |k − m| < δ proved.
            let closing_squared = norm_squared(exact_difference(k, m));
            if !proved_below(closing_squared, delta_squared) {
                return Err(Reason::Closure);
            }
            // SL-M3: σ = sign orient2d(p, k, m) ≠ 0, or σ = 0 and ⟨k − p, m − k⟩ > 0.
            let sigma = orient(p, k, m, Reason::Closure)?;
            if sigma == Ordering::Equal
                && !proved_positive(dot(exact_difference(k, p), exact_difference(m, k)))
            {
                return Err(Reason::Closure);
            }
            // SL-M4: f ∩ T = {m} and h ∩ T = {p} for T = conv(p, k, m), decided exactly.
            if sigma == Ordering::Equal {
                // T is the segment [p, m]. f enters it beyond m exactly when q is on the line
                // with ⟨q − m, p − m⟩ > 0; h beyond p when r is with ⟨r − p, m − p⟩ > 0. The
                // dot sign must be proved negative; positive or undecided falls back.
                if orient(p, m, q, Reason::Closure)? == Ordering::Equal
                    && !proved_negative(dot(exact_difference(q, m), exact_difference(p, m)))
                {
                    return Err(Reason::Closure);
                }
                if orient(p, m, r, Reason::Closure)? == Ordering::Equal
                    && !proved_negative(dot(exact_difference(r, p), exact_difference(m, p)))
                {
                    return Err(Reason::Closure);
                }
            } else {
                // The closed cone of T at m is bounded by k → m and m → p: q lies in it exactly
                // when σ·orient2d(k, m, q) ≥ 0 and σ·orient2d(m, p, q) ≥ 0. At p the cone is
                // bounded by m → p and p → k. The condition is that both memberships fail.
                let inside = |value: Ordering| value == sigma || value == Ordering::Equal;
                let q_in_cone = inside(orient(k, m, q, Reason::Closure)?)
                    && inside(orient(m, p, q, Reason::Closure)?);
                let r_in_cone = inside(orient(m, p, r, Reason::Closure)?)
                    && inside(orient(p, k, r, Reason::Closure)?);
                let (m_side, p_side) = if fault(LadderFault::ConeInverted) {
                    (q_in_cone, r_in_cone)
                } else {
                    (!q_in_cone, !r_in_cone)
                };
                if !(m_side && p_side) {
                    return Err(Reason::Closure);
                }
            }
            // AL-M5 (contract section 3.3): δ̄(e′) + |k − m| < δ proved. δ̄(e′)'s upper bound is
            // the root of FR2's largest |d_m|² upper bound on e′ = [p, m] (the contour's last
            // certified edge); |k − m|'s is the root of SL-M2's enclosure's upper bound. Both
            // roots are widened outward by R1, added as intervals (R2), and the strict
            // comparison with δ's enclosure is decided by R3; equality or undecided fails.
            if !fault(LadderFault::AlM5Omitted) {
                let merged = self.cert[info.cert_start + info.cert_count - 1];
                let sum = norm_from_squared_bound(merged.deviation_squared)
                    .add(norm_from_squared_bound(closing_squared.hi));
                if !proved_below(sum, delta) {
                    return Err(Reason::Closure);
                }
            }
            // SL-C1 to SL-C3 on P′ are FR2, FR4 and FR5, which run on the certified edges.
        }
        Ok(())
    }

    // ------------------------------------------------------------------------------------
    // FR4: consecutive pairs (SL-C2; SL-L2).

    fn monotone(&mut self) -> Result<(), Reason> {
        let chords_only = fault(LadderFault::MonotoneChordsOnly);
        for info in self.contours[..self.range_len].iter().copied() {
            let count = info.cert_count;
            // Contour order, then the cyclic pair (last, first).
            for index in 0..count {
                let e = self.cert[info.cert_start + index];
                let f = self.cert[info.cert_start + (index + 1) % count];
                // w = p_end(f) − p_start(e); u_e, u_f the chords.
                let w = exact_difference(f.end, e.start);
                if !proved_positive(dot(exact_difference(e.end, e.start), w))
                    || !proved_positive(dot(exact_difference(f.end, f.start), w))
                {
                    return Err(Reason::Monotone);
                }
                if chords_only {
                    continue;
                }
                for edge in [e, f] {
                    // ⟨R_{m+1} − R_m, w⟩ > 0 for m = 0, 1, 2 (leaf), or ⟨γ(1) − γ(0), w⟩ > 0.
                    let terms = match edge.piece {
                        Piece::Leaf { .. } => 3,
                        Piece::Segment { .. } => 1,
                        Piece::Unset => return Err(Reason::Structure),
                    };
                    for term in 0..terms {
                        let step = edge.controls[term + 1].sub(edge.controls[term]);
                        if !proved_positive(dot(step, w)) {
                            return Err(Reason::Monotone);
                        }
                    }
                }
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------------------------------
    // FR5: non-consecutive pairs (SL-C3; SL-L3, SL-L4; spike section 3.9).

    /// SL-C2 handles consecutive pairs; every other pair, in one contour or two, is SL-C3's.
    fn consecutive(&self, left: usize, right: usize) -> bool {
        let (a, b) = (self.cert[left], self.cert[right]);
        if a.contour != b.contour {
            return false;
        }
        let count = self.contours[a.contour].cert_count;
        let offset = (a.local + count - b.local) % count;
        offset == 1
            || offset == count - 1
            || (fault(LadderFault::SkipTwoApart) && (offset == 2 || offset + 2 == count))
    }

    fn clearance(&mut self) -> Result<(), Reason> {
        let count = self.cert_len;
        // Contract section 3.2: r = 2δ and r² enclosed exactly as the spike does.
        let radius = 2.0 * self.delta;
        let r = Interval::point(radius);
        let r_squared = r.mul(r);
        let mut xlo = [0.0f64; MAX_EDGES];
        let mut xhi = [0.0f64; MAX_EDGES];
        for index in 0..count {
            let edge = self.cert[index];
            xlo[index] = edge.start.x.min(edge.end.x);
            xhi[index] = edge.start.x.max(edge.end.x);
        }
        // Sort by xlo, ties by index (allocation-free bottom-up merge sort).
        let mut order = [0usize; MAX_EDGES];
        let mut scratch = [0usize; MAX_EDGES];
        for (index, slot) in order[..count].iter_mut().enumerate() {
            *slot = index;
        }
        merge_sort(&mut order[..count], &mut scratch[..count], |a, b| {
            xlo[a].total_cmp(&xlo[b]).then(a.cmp(&b))
        });
        let mut marks = [0u64; MAX_EDGES];
        self.stats.sweep_candidates = 0;
        self.stats.clearance_step2 = 0;
        self.stats.clearance_step3 = 0;
        for position in 0..count {
            let a = order[position];
            // Spike section 3.9: scan while xlo(b) ≤ next_up(fl(xhi(a) + r)). An unscanned pair
            // has xlo(b) above an upper bound of xhi(a) + r (R1), so a proved x gap above r.
            let bound = if fault(LadderFault::ScanBoundWithoutRadius) {
                xhi[a]
            } else {
                (xhi[a] + radius).next_up()
            };
            let bound = if bound.is_finite() {
                bound
            } else {
                f64::INFINITY
            };
            for &b in &order[position + 1..count] {
                if xlo[b] > bound {
                    break;
                }
                if self.consecutive(a, b) {
                    continue;
                }
                let (low, high) = (a.min(b), a.max(b));
                marks[low] |= 1u64 << high;
                self.stats.sweep_candidates += 1;
                self.clear_pair(a, b, r, r_squared)?;
            }
        }
        debug_assert!(
            marks.iter().map(|row| row.count_ones()).sum::<u32>() == self.stats.sweep_candidates
        );
        Ok(())
    }

    /// Spike section 3.9 steps 1-3 for one non-consecutive pair e = [a, b], f = [c, d].
    fn clear_pair(
        &mut self,
        left: usize,
        right: usize,
        r: Interval,
        r_squared: Interval,
    ) -> Result<(), Reason> {
        let (e, f) = (self.cert[left], self.cert[right]);
        let simplicity_only = fault(LadderFault::SimplicityOnly);
        if !simplicity_only {
            // Step 1, box gap: Euclidean distance is at least each axis gap.
            let gap = |high: f64, low: f64| Interval::point(low).sub(Interval::point(high));
            let gaps = [
                gap(e.start.x.max(e.end.x), f.start.x.min(f.end.x)),
                gap(f.start.x.max(f.end.x), e.start.x.min(e.end.x)),
                gap(e.start.y.max(e.end.y), f.start.y.min(f.end.y)),
                gap(f.start.y.max(f.end.y), e.start.y.min(e.end.y)),
            ];
            if gaps.iter().any(|value| proved_exceeds(*value, r)) {
                return Ok(());
            }
        }
        // Step 2: the closed segments must be disjoint (B0D-Q6 (a)); any other relation, a
        // crossing, touch, collinear point or overlap, is `CROSSING`.
        self.stats.clearance_step2 += 1;
        match segment_relation(e.start, e.end, f.start, f.end) {
            Ok(SegmentRelation::Disjoint) => {}
            _ => return Err(Reason::Crossing),
        }
        if simplicity_only {
            return Ok(());
        }
        // Step 3 (SL-L4): for disjoint segments the distance is the minimum of the four
        // point-segment distances, each of which must be proved farther than r.
        self.stats.clearance_step3 += 1;
        for (point, segment) in [(e.start, f), (e.end, f), (f.start, e), (f.end, e)] {
            if !point_clear(point, segment.start, segment.end, r_squared) {
                return Err(Reason::Clearance);
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------------------------------
    // FR6: orientation, nesting, winding and boundary contours (consequence of SL-T1, SL-T2).

    fn contour_point(&self, contour: usize, index: usize) -> Point {
        let info = self.contours[contour];
        self.points[info.point_start + index % info.edges]
    }

    /// Exact half-open horizontal ray crossing of `point` against contour `contour` of P,
    /// with coordinate comparisons and `orient2d` only. A point on the contour cannot occur
    /// under SL-T1 (contours pairwise disjoint), so it is an internal invariant (`STRUCTURE`).
    fn inside(&self, point: Point, contour: usize) -> Result<bool, Reason> {
        let edges = self.contours[contour].edges;
        let mut crossings = 0u32;
        for index in 0..edges {
            let s = self.contour_point(contour, index);
            let t = self.contour_point(contour, index + 1);
            if (s.y > point.y) == (t.y > point.y) {
                continue;
            }
            let side = orient(s, t, point, Reason::Structure)?;
            if side == Ordering::Equal {
                return Err(Reason::Structure);
            }
            // An upward edge crosses the ray to +x when the point is on its left, a downward
            // edge when the point is on its right.
            if (t.y > s.y) == (side == Ordering::Greater) {
                crossings += 1;
            }
        }
        Ok(crossings % 2 == 1)
    }

    fn filled(&self, winding: i32) -> bool {
        match self.rule {
            LineFillRule::Nonzero => winding != 0,
            LineFillRule::Evenodd => winding.rem_euclid(2) == 1,
        }
    }

    fn classify(&mut self) -> Result<(), Reason> {
        // Orientation: exact orient2d at the lexicographically smallest vertex (x, then y),
        // which is a convex hull vertex of a simple polygon, so the sign is nonzero.
        for contour in 0..self.range_len {
            let edges = self.contours[contour].edges;
            let mut lowest = 0usize;
            for index in 1..edges {
                let (candidate, best) = (
                    self.contour_point(contour, index),
                    self.contour_point(contour, lowest),
                );
                if candidate.x < best.x || (candidate.x == best.x && candidate.y < best.y) {
                    lowest = index;
                }
            }
            let turn = orient(
                self.contour_point(contour, lowest + edges - 1),
                self.contour_point(contour, lowest),
                self.contour_point(contour, lowest + 1),
                Reason::Structure,
            )?;
            self.orientation[contour] = match turn {
                Ordering::Greater => 1,
                Ordering::Less => -1,
                Ordering::Equal => return Err(Reason::Structure),
            };
        }
        // Nesting (SL-T2 item 2), then w_out(a) = Σ o_b over the contours b containing a and
        // w_in(a) = w_out(a) + o_a; a is a boundary contour when its sides differ in fill.
        let from_orientation = fault(LadderFault::NestingFromOrientation);
        let every_contour = fault(LadderFault::NonBoundaryTriangulated);
        for contour in 0..self.range_len {
            let probe = self.contour_point(contour, 0);
            let mut outside = 0i32;
            for other in 0..self.range_len {
                if other == contour {
                    continue;
                }
                let contains = if from_orientation {
                    self.orientation[contour] < 0 && self.orientation[other] > 0
                } else {
                    self.inside(probe, other)?
                };
                if contains {
                    outside += self.orientation[other];
                }
            }
            let inner = outside + self.orientation[contour];
            self.boundary[contour] = every_contour || self.filled(outside) != self.filled(inner);
            // FR7 traverses a boundary contour counterclockwise when its inside is filled.
            self.reversed[contour] = (self.orientation[contour] > 0) != self.filled(inner);
        }
        Ok(())
    }

    // ------------------------------------------------------------------------------------
    // FR7: triangulation of the region bounded by all boundary contours together, without
    // Steiner points (de Berg, Cheong, van Kreveld and Overmars, Computational Geometry, 3rd
    // ed., 2008, chapter 3). "Above" is y descending, then x ascending. Correctness is the
    // textbook algorithm's; AL-FR9 checks its output on every path (SL-OB4). Every emitted
    // triangle's exact orient2d must be positive, and every internal invariant failure or
    // capacity overflow is `TRIANGLE`.

    fn triangulate(&mut self) -> Result<(), Reason> {
        let mut next = [0usize; MAX_POINTS];
        let mut previous = [0usize; MAX_POINTS];
        self.vertex_len = 0;
        self.triangle_len = 0;
        for contour in 0..self.range_len {
            if !self.boundary[contour] {
                continue;
            }
            let info = self.contours[contour];
            let first = self.vertex_len;
            for index in 0..info.edges {
                let source = if self.reversed[contour] {
                    info.edges - 1 - index
                } else {
                    index
                };
                self.vertices[self.vertex_len] = self.points[info.point_start + source];
                self.vertex_len += 1;
            }
            for index in 0..info.edges {
                let vertex = first + index;
                let following = first + (index + 1) % info.edges;
                next[vertex] = following;
                previous[following] = vertex;
            }
        }
        let count = self.vertex_len;
        if count < 3 {
            return Err(Reason::Triangle);
        }
        let vertices = self.vertices;

        // Event order, ties by vertex index; equal points cannot occur under SL-T1.
        let mut order = [0usize; MAX_POINTS];
        let mut scratch = [0usize; MAX_POINTS];
        for (index, slot) in order[..count].iter_mut().enumerate() {
            *slot = index;
        }
        merge_sort(&mut order[..count], &mut scratch[..count], |a, b| {
            above(vertices[a], vertices[b]).then(a.cmp(&b))
        });
        let mut rank = [0usize; MAX_POINTS];
        for (position, vertex) in order[..count].iter().copied().enumerate() {
            if position > 0
                && above(vertices[order[position - 1]], vertices[vertex]) != Ordering::Less
            {
                return Err(Reason::Triangle);
            }
            rank[vertex] = position;
        }

        // Vertex classification from the neighbours' order and the orient2d sign at the vertex.
        let mut kind = [VertexKind::RegularLeft; MAX_POINTS];
        for vertex in 0..count {
            let (before, after) = (previous[vertex], next[vertex]);
            let before_below = rank[before] > rank[vertex];
            let after_below = rank[after] > rank[vertex];
            let turn = orient(
                vertices[before],
                vertices[vertex],
                vertices[after],
                Reason::Triangle,
            )?;
            kind[vertex] = match (before_below, after_below, turn) {
                (true, true, Ordering::Greater) => VertexKind::Start,
                (true, true, Ordering::Less) => VertexKind::Split,
                (false, false, Ordering::Greater) => VertexKind::End,
                (false, false, Ordering::Less) => VertexKind::Merge,
                (true, true, Ordering::Equal) | (false, false, Ordering::Equal) => {
                    return Err(Reason::Triangle);
                }
                (false, true, _) => VertexKind::RegularRight,
                (true, false, _) => VertexKind::RegularLeft,
            };
        }

        // MakeMonotone. The status holds edges e_v = (v, next(v)) that have the interior to
        // their east, each with its helper; a small array searched linearly (AL-OB8).
        let mut active = [0usize; MAX_POINTS];
        let mut active_len = 0usize;
        let mut helper = [0usize; MAX_POINTS];
        let mut diagonals = [(0usize, 0usize); MAX_DIAGONALS];
        let mut diagonal_len = 0usize;
        let mut add_diagonal = |a: usize, b: usize| -> Result<(), Reason> {
            if diagonal_len >= MAX_DIAGONALS {
                return Err(Reason::Triangle);
            }
            diagonals[diagonal_len] = (a, b);
            diagonal_len += 1;
            Ok(())
        };
        let sweep = Sweep {
            vertices: &vertices,
            next: &next,
            rank: &rank,
        };
        for vertex in order[..count].iter().copied() {
            let incoming = previous[vertex];
            match kind[vertex] {
                VertexKind::Start => {
                    insert_edge(&mut active, &mut active_len, vertex)?;
                    helper[vertex] = vertex;
                }
                VertexKind::End => {
                    if kind[helper[incoming]] == VertexKind::Merge {
                        add_diagonal(vertex, helper[incoming])?;
                    }
                    remove_edge(&mut active, &mut active_len, incoming)?;
                }
                VertexKind::Split => {
                    let left = sweep.left_edge(vertex, &active[..active_len])?;
                    add_diagonal(vertex, helper[left])?;
                    helper[left] = vertex;
                    insert_edge(&mut active, &mut active_len, vertex)?;
                    helper[vertex] = vertex;
                }
                VertexKind::Merge => {
                    if kind[helper[incoming]] == VertexKind::Merge {
                        add_diagonal(vertex, helper[incoming])?;
                    }
                    remove_edge(&mut active, &mut active_len, incoming)?;
                    let left = sweep.left_edge(vertex, &active[..active_len])?;
                    if kind[helper[left]] == VertexKind::Merge {
                        add_diagonal(vertex, helper[left])?;
                    }
                    helper[left] = vertex;
                }
                VertexKind::RegularRight => {
                    if kind[helper[incoming]] == VertexKind::Merge {
                        add_diagonal(vertex, helper[incoming])?;
                    }
                    remove_edge(&mut active, &mut active_len, incoming)?;
                    insert_edge(&mut active, &mut active_len, vertex)?;
                    helper[vertex] = vertex;
                }
                VertexKind::RegularLeft => {
                    let left = sweep.left_edge(vertex, &active[..active_len])?;
                    if kind[helper[left]] == VertexKind::Merge {
                        add_diagonal(vertex, helper[left])?;
                    }
                    helper[left] = vertex;
                }
            }
        }
        self.stats.diagonals = u32::try_from(diagonal_len).unwrap_or(u32::MAX);

        // Monotone pieces: trace the faces left of every boundary half-edge (v → next(v)) and of
        // both directions of every diagonal. At w, arriving from u, the next half-edge is the
        // first outgoing one clockwise from the direction w → u.
        let graph = Graph {
            vertices: &vertices,
            next: &next,
            diagonals: &diagonals[..diagonal_len],
            count,
        };
        let half_count = count + 2 * diagonal_len;
        let mut visited = [false; MAX_HALF_EDGES];
        let mut face = [0usize; MAX_HALF_EDGES];
        for first in 0..half_count {
            if visited[first] {
                continue;
            }
            let mut length = 0usize;
            let mut half = first;
            loop {
                if visited[half] {
                    if half == first {
                        break;
                    }
                    return Err(Reason::Triangle);
                }
                visited[half] = true;
                if length >= MAX_HALF_EDGES {
                    return Err(Reason::Triangle);
                }
                face[length] = graph.origin(half);
                length += 1;
                half = graph.next_half(half)?;
            }
            self.triangulate_monotone(&face[..length], &vertices, &rank)?;
        }
        Ok(())
    }

    fn emit(&mut self, vertices: &[Point; MAX_POINTS], triangle: [usize; 3]) -> Result<(), Reason> {
        // Every triangle positive: a non-positive one (collinear chains can produce it) is
        // `TRIANGLE`, never emitted or skipped. AL-F10's fault variant fails this check.
        if orient(
            vertices[triangle[0]],
            vertices[triangle[1]],
            vertices[triangle[2]],
            Reason::Triangle,
        )? != Ordering::Greater
            || fault(LadderFault::Fr7OrientationRejected)
            || self.triangle_len >= MAX_TRIANGLES
        {
            return Err(Reason::Triangle);
        }
        let mut indices = [0u32; 3];
        for (slot, vertex) in indices.iter_mut().zip(triangle) {
            *slot = u32::try_from(vertex).map_err(|_| Reason::Triangle)?;
        }
        self.triangles[self.triangle_len] = indices;
        self.triangle_len += 1;
        Ok(())
    }

    /// TriangulateMonotonePolygon (de Berg et al., section 3.3) on one face, given in
    /// counterclockwise order. A face that is not monotone in the "above" order is an internal
    /// invariant failure (`TRIANGLE`).
    fn triangulate_monotone(
        &mut self,
        face: &[usize],
        vertices: &[Point; MAX_POINTS],
        rank: &[usize; MAX_POINTS],
    ) -> Result<(), Reason> {
        let length = face.len();
        if length < 3 {
            return Err(Reason::Triangle);
        }
        let mut top = 0usize;
        let mut bottom = 0usize;
        for (position, vertex) in face.iter().copied().enumerate() {
            if rank[vertex] < rank[face[top]] {
                top = position;
            }
            if rank[vertex] > rank[face[bottom]] {
                bottom = position;
            }
        }
        // Forward from the top the boundary descends to the bottom (the left chain of a
        // counterclockwise face), then ascends back (the right chain).
        let mut is_left = [false; MAX_HALF_EDGES];
        let mut position = top;
        while position != bottom {
            let following = (position + 1) % length;
            if rank[face[following]] <= rank[face[position]] {
                return Err(Reason::Triangle);
            }
            is_left[following] = following != bottom;
            position = following;
        }
        while position != top {
            let following = (position + 1) % length;
            if rank[face[following]] >= rank[face[position]] {
                return Err(Reason::Triangle);
            }
            position = following;
        }
        let mut sorted = [0usize; MAX_HALF_EDGES];
        let mut scratch = [0usize; MAX_HALF_EDGES];
        for (index, slot) in sorted[..length].iter_mut().enumerate() {
            *slot = index;
        }
        merge_sort(&mut sorted[..length], &mut scratch[..length], |a, b| {
            rank[face[a]].cmp(&rank[face[b]])
        });
        let vertex = |slot: usize| face[slot];
        let mut stack = [0usize; MAX_HALF_EDGES];
        stack[0] = sorted[0];
        stack[1] = sorted[1];
        let mut depth = 2usize;
        for current in sorted[2..length - 1].iter().copied() {
            if is_left[current] != is_left[stack[depth - 1]] {
                // Different chains: fan from the current vertex to every stack vertex.
                for index in 0..depth - 1 {
                    self.emit_fan(
                        vertices,
                        vertex(current),
                        vertex(stack[index]),
                        vertex(stack[index + 1]),
                        is_left[current],
                    )?;
                }
                stack[0] = stack[depth - 1];
                stack[1] = current;
                depth = 2;
            } else {
                // Same chain: pop while the diagonal to the next stack vertex is inside.
                depth -= 1;
                let mut last = stack[depth];
                while depth > 0 {
                    let candidate = stack[depth - 1];
                    let triangle = if is_left[current] {
                        [vertex(candidate), vertex(last), vertex(current)]
                    } else {
                        [vertex(current), vertex(last), vertex(candidate)]
                    };
                    if orient(
                        vertices[triangle[0]],
                        vertices[triangle[1]],
                        vertices[triangle[2]],
                        Reason::Triangle,
                    )? != Ordering::Greater
                    {
                        break;
                    }
                    self.emit(vertices, triangle)?;
                    last = candidate;
                    depth -= 1;
                }
                stack[depth] = last;
                stack[depth + 1] = current;
                depth += 2;
            }
        }
        // The bottom vertex closes the fan to every stack vertex; it lies on the chain opposite
        // to the stack's top.
        let bottom_slot = sorted[length - 1];
        let bottom_is_left = !is_left[stack[depth - 1]];
        for index in 0..depth - 1 {
            self.emit_fan(
                vertices,
                vertex(bottom_slot),
                vertex(stack[index]),
                vertex(stack[index + 1]),
                bottom_is_left,
            )?;
        }
        Ok(())
    }

    /// A triangle from `apex` to the stack vertices `upper` above `lower` on the other chain,
    /// in counterclockwise order.
    fn emit_fan(
        &mut self,
        vertices: &[Point; MAX_POINTS],
        apex: usize,
        upper: usize,
        lower: usize,
        apex_is_left: bool,
    ) -> Result<(), Reason> {
        if apex_is_left {
            self.emit(vertices, [apex, lower, upper])
        } else {
            self.emit(vertices, [apex, upper, lower])
        }
    }

    // ------------------------------------------------------------------------------------
    // FR8: assembly (contract section 3.5). The vertices are the boundary contours' polygon
    // vertices in contour order (reversed where FR6 reversed a contour); the indices are the
    // counterclockwise triangles in emission order. Publication waits for AL-FR9.

    fn assemble(&mut self) -> Result<(), Reason> {
        if self.triangle_len == 0 {
            return Err(Reason::Triangle);
        }
        #[cfg(test)]
        self.apply_output_faults();
        Ok(())
    }

    /// The seeded output faults after FR8: defect (7) and AL-F8 (one triangle flipped), AL-F8b
    /// (a) (one triangle dropped) and AL-F8b (c) (one vertex substituted).
    #[cfg(test)]
    fn apply_output_faults(&mut self) {
        if fault(LadderFault::TriangleFlipped) {
            self.triangles[0].swap(1, 2);
        }
        if fault(LadderFault::TriangleDropped) && self.triangle_len > 1 {
            self.triangle_len -= 1;
        }
        if fault(LadderFault::VertexSubstituted) {
            self.substitute_vertex();
        }
    }

    /// AL-F8b (c): the first (triangle, corner, vertex) in index order whose substitution
    /// keeps the triangle's exact orientation positive and repeats no directed edge.
    #[cfg(test)]
    fn substitute_vertex(&mut self) {
        let count = self.triangle_len;
        let point = |vertex: u32| self.vertices[vertex as usize];
        for triangle in 0..count {
            for corner in 0..3 {
                for replacement in 0..self.vertex_len as u32 {
                    let mut candidate = self.triangles[triangle];
                    if candidate.contains(&replacement) {
                        continue;
                    }
                    candidate[corner] = replacement;
                    if orient2d(
                        point(candidate[0]),
                        point(candidate[1]),
                        point(candidate[2]),
                    ) != Ok(Ordering::Greater)
                    {
                        continue;
                    }
                    let mut edges = Vec::new();
                    for (index, corners) in self.triangles[..count].iter().enumerate() {
                        let corners = if index == triangle {
                            candidate
                        } else {
                            *corners
                        };
                        for side in 0..3 {
                            edges.push((corners[side], corners[(side + 1) % 3]));
                        }
                    }
                    let total = edges.len();
                    edges.sort_unstable();
                    edges.dedup();
                    if edges.len() == total {
                        self.triangles[triangle] = candidate;
                        return;
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------------------------------
    // AL-FR9: the always-on output check (contract section 3.5), discharging SL-OB4. Items 1
    // and 3 imply, by SL-O2's argument, that the triangles have disjoint interiors, form a
    // conforming mesh and tile exactly the region of FR6's boundary contours as FR6 oriented
    // them. Item 2 is V2's own once-only scan. Any failure is `MESH_CHECK`.

    fn check_output<S: BoundaryScan + ?Sized>(&mut self, scan: &mut S) -> Result<(), Reason> {
        let count = self.vertex_len;
        let triangles = &self.triangles[..self.triangle_len];
        // Item 1: every triangle's exact orient2d is strictly positive.
        for triangle in triangles {
            if triangle.iter().any(|vertex| *vertex as usize >= count)
                || orient2d(
                    self.vertices[triangle[0] as usize],
                    self.vertices[triangle[1] as usize],
                    self.vertices[triangle[2] as usize],
                ) != Ok(Ordering::Greater)
            {
                self.stats.mesh_check_item = 1;
                return Err(Reason::MeshCheck);
            }
        }
        // Item 2: no directed edge occurs twice (`collect_boundary`), which also derives the
        // edges used once.
        let Some(once) = scan.scan(triangles.as_flattened()) else {
            self.stats.mesh_check_item = 2;
            return Err(Reason::MeshCheck);
        };
        // Item 3: the edges used once, as directed pairs, are exactly the directed edges of
        // FR6's boundary contours in the FR7/FR8 vertex order (filled side on the left): each
        // vertex v has the one boundary successor next(v), and every pair must be (v, next(v))
        // for a distinct v, with as many pairs as vertices. The vertex layout is not trusted:
        // each vertex must equal, bit for bit, the S1 polygon point that FR6's boundary contour
        // and orientation put there (reversed contours in reverse order), an O(n) check.
        if !fault(LadderFault::MeshCheckItem3Disabled) {
            let mut next = [0usize; MAX_POINTS];
            let mut assigned = 0usize;
            let mut layout = true;
            for contour in 0..self.range_len {
                if !self.boundary[contour] {
                    continue;
                }
                let info = self.contours[contour];
                let edges = info.edges;
                if assigned + edges > count {
                    layout = false;
                    break;
                }
                for index in 0..edges {
                    next[assigned + index] = assigned + (index + 1) % edges;
                    let source = if self.reversed[contour] {
                        edges - 1 - index
                    } else {
                        index
                    };
                    let expected = self.points[info.point_start + source];
                    let actual = self.vertices[assigned + index];
                    layout &= actual.x.to_bits() == expected.x.to_bits()
                        && actual.y.to_bits() == expected.y.to_bits();
                }
                assigned += edges;
            }
            let mut seen = [false; MAX_POINTS];
            let exact = layout
                && assigned == count
                && once.len() == count
                && once.iter().all(|&[from, to]| {
                    let (from, to) = (from as usize, to as usize);
                    let fresh = from < count && !seen[from] && next[from] == to;
                    if fresh {
                        seen[from] = true;
                    }
                    fresh
                });
            if !exact {
                self.stats.mesh_check_item = 3;
                return Err(Reason::MeshCheck);
            }
        }
        Ok(())
    }
}

/// Spike section 3.9 step 3: p is proved farther than r from the segment [s, t], with
/// v = t − s and w = p − s, when any one of (i)-(iii) is proved.
fn point_clear(point: Point, start: Point, end: Point, r_squared: Interval) -> bool {
    let v = exact_difference(end, start);
    let w = exact_difference(point, start);
    // (i) cross(v, w)² > r² |v|²: the distance to the line exceeds r.
    let across = cross(v, w);
    if proved_exceeds(across.mul(across), r_squared.mul(norm_squared(v))) {
        return true;
    }
    // (ii) ⟨w, v⟩ < 0 and |w|² > r²: the nearest segment point is s.
    if proved_negative(dot(w, v)) && proved_exceeds(norm_squared(w), r_squared) {
        return true;
    }
    // (iii) ⟨p − t, v⟩ > 0 and |p − t|² > r²: the nearest segment point is t.
    let beyond = exact_difference(point, end);
    proved_positive(dot(beyond, v)) && proved_exceeds(norm_squared(beyond), r_squared)
}

/// Interval de Casteljau restriction of a source cubic to the dyadic cell
/// [(n − 1)/2^d, n/2^d], with the cell bits read from high to low (P3.2g `restrict_cell`).
fn restrict(controls: [Point; 4], numerator: u32, depth: u32) -> [IPoint; 4] {
    let mut points = controls.map(IPoint::exact);
    let cell = numerator - 1;
    for bit in (0..depth).rev() {
        points = split_half(points, cell & (1u32 << bit) != 0);
    }
    points
}

fn split_half(points: [IPoint; 4], right: bool) -> [IPoint; 4] {
    let p01 = midpoint(points[0], points[1]);
    let p12 = midpoint(points[1], points[2]);
    let p23 = midpoint(points[2], points[3]);
    let p012 = midpoint(p01, p12);
    let p123 = midpoint(p12, p23);
    let middle = midpoint(p012, p123);
    if right {
        [middle, p123, p23, points[3]]
    } else {
        [points[0], p01, p012, middle]
    }
}

fn midpoint(left: IPoint, right: IPoint) -> IPoint {
    left.add(right).mul(Interval::point(0.5))
}

/// The FR7 event order: `Less` when `left` is above `right` (y descending, then x ascending).
/// It compares represented values (signed zeros equal), as `orient2d` does; FR1 has checked
/// that every coordinate is finite.
fn above(left: Point, right: Point) -> Ordering {
    right
        .y
        .partial_cmp(&left.y)
        .unwrap_or(Ordering::Equal)
        .then_with(|| left.x.partial_cmp(&right.x).unwrap_or(Ordering::Equal))
}

/// A deterministic, allocation-free bottom-up merge sort of index values (spike section 2.3);
/// the comparator breaks ties itself, so the order is total.
fn merge_sort(
    items: &mut [usize],
    scratch: &mut [usize],
    mut compare: impl FnMut(usize, usize) -> Ordering,
) {
    let length = items.len();
    let mut width = 1usize;
    while width < length {
        let mut start = 0usize;
        while start < length {
            let middle = (start + width).min(length);
            let end = (start + 2 * width).min(length);
            let (mut left, mut right, mut out) = (start, middle, start);
            while left < middle && right < end {
                if compare(items[right], items[left]) == Ordering::Less {
                    scratch[out] = items[right];
                    right += 1;
                } else {
                    scratch[out] = items[left];
                    left += 1;
                }
                out += 1;
            }
            scratch[out..out + (middle - left)].copy_from_slice(&items[left..middle]);
            out += middle - left;
            scratch[out..out + (end - right)].copy_from_slice(&items[right..end]);
            start = end;
        }
        items.copy_from_slice(&scratch[..length]);
        width *= 2;
    }
}

fn insert_edge(
    active: &mut [usize; MAX_POINTS],
    length: &mut usize,
    edge: usize,
) -> Result<(), Reason> {
    if *length >= MAX_POINTS {
        return Err(Reason::Triangle);
    }
    active[*length] = edge;
    *length += 1;
    Ok(())
}

fn remove_edge(
    active: &mut [usize; MAX_POINTS],
    length: &mut usize,
    edge: usize,
) -> Result<(), Reason> {
    let position = active[..*length]
        .iter()
        .position(|candidate| *candidate == edge)
        .ok_or(Reason::Triangle)?;
    active.copy_within(position + 1..*length, position);
    *length -= 1;
    Ok(())
}

/// Read-only sweep state for the status searches of FR7.
struct Sweep<'a> {
    vertices: &'a [Point; MAX_POINTS],
    next: &'a [usize; MAX_POINTS],
    rank: &'a [usize; MAX_POINTS],
}

impl Sweep<'_> {
    /// The status edge directly left of `vertex`. Active edges are directed downward, so the
    /// vertex is east of edge (a, b) exactly when orient2d(a, b, vertex) > 0; the left-right
    /// order of two active edges is decided by orient2d of endpoints, valid because SL-T1
    /// makes all edges pairwise disjoint except at shared vertices.
    fn left_edge(&self, vertex: usize, active: &[usize]) -> Result<usize, Reason> {
        let point = self.vertices[vertex];
        let mut best: Option<usize> = None;
        for edge in active.iter().copied() {
            let (start, end) = (edge, self.next[edge]);
            if start == vertex || end == vertex {
                continue;
            }
            match orient(
                self.vertices[start],
                self.vertices[end],
                point,
                Reason::Triangle,
            )? {
                Ordering::Greater => {}
                Ordering::Less => continue,
                Ordering::Equal => return Err(Reason::Triangle),
            }
            best = Some(match best {
                Some(current) if !self.east_of(edge, current)? => current,
                _ => edge,
            });
        }
        best.ok_or(Reason::Triangle)
    }

    /// Whether active edge `candidate` lies east of active edge `current` on the sweep line.
    /// The lower of the two upper endpoints lies inside the other edge's y-range, so its side
    /// of that edge decides; a zero there would be a touching point (`TRIANGLE`).
    fn east_of(&self, candidate: usize, current: usize) -> Result<bool, Reason> {
        let (a1, b1) = (current, self.next[current]);
        let (a2, b2) = (candidate, self.next[candidate]);
        if self.rank[a2] > self.rank[a1] {
            match orient(
                self.vertices[a1],
                self.vertices[b1],
                self.vertices[a2],
                Reason::Triangle,
            )? {
                Ordering::Greater => Ok(true),
                Ordering::Less => Ok(false),
                Ordering::Equal => Err(Reason::Triangle),
            }
        } else {
            match orient(
                self.vertices[a2],
                self.vertices[b2],
                self.vertices[a1],
                Reason::Triangle,
            )? {
                Ordering::Less => Ok(true),
                Ordering::Greater => Ok(false),
                Ordering::Equal => Err(Reason::Triangle),
            }
        }
    }
}

/// The planar graph of boundary edges and diagonals for the FR7 face tracing. Half-edge h < n
/// is the boundary edge h → next(h); n + 2k and n + 2k + 1 are diagonal k in both directions.
struct Graph<'a> {
    vertices: &'a [Point; MAX_POINTS],
    next: &'a [usize; MAX_POINTS],
    diagonals: &'a [(usize, usize)],
    count: usize,
}

impl Graph<'_> {
    fn origin(&self, half: usize) -> usize {
        if half < self.count {
            half
        } else {
            let (a, b) = self.diagonals[(half - self.count) / 2];
            if (half - self.count).is_multiple_of(2) {
                a
            } else {
                b
            }
        }
    }

    fn destination(&self, half: usize) -> usize {
        if half < self.count {
            self.next[half]
        } else {
            let (a, b) = self.diagonals[(half - self.count) / 2];
            if (half - self.count).is_multiple_of(2) {
                b
            } else {
                a
            }
        }
    }

    /// The clockwise class of the direction w → x relative to w → u: 0 for (0, π), 1 for π,
    /// 2 for (π, 2π), 3 for x = u (angle 2π, last). Equal directions are an invariant failure.
    fn class(&self, w: usize, u: usize, x: usize) -> Result<u8, Reason> {
        if x == u {
            return Ok(3);
        }
        let (pw, pu, px) = (self.vertices[w], self.vertices[u], self.vertices[x]);
        match orient(pw, pu, px, Reason::Triangle)? {
            Ordering::Less => Ok(0),
            Ordering::Greater => Ok(2),
            Ordering::Equal => {
                // Collinear: opposite directions when w lies strictly between u and x.
                let opposite = if pu.x != pw.x {
                    (pu.x < pw.x) == (pw.x < px.x) && px.x != pw.x
                } else {
                    (pu.y < pw.y) == (pw.y < px.y) && px.y != pw.y
                };
                if opposite {
                    Ok(1)
                } else {
                    Err(Reason::Triangle)
                }
            }
        }
    }

    fn next_half(&self, half: usize) -> Result<usize, Reason> {
        let u = self.origin(half);
        let w = self.destination(half);
        let mut best: Option<(usize, u8)> = None;
        let mut consider = |candidate: usize| -> Result<(), Reason> {
            let x = self.destination(candidate);
            let class = self.class(w, u, x)?;
            let better = match best {
                None => true,
                Some((current, current_class)) => {
                    if class != current_class {
                        class < current_class
                    } else if class == 1 || class == 3 {
                        return Err(Reason::Triangle);
                    } else {
                        // Same half-turn: the candidate is first when the current one is
                        // clockwise from it.
                        match orient(
                            self.vertices[w],
                            self.vertices[x],
                            self.vertices[self.destination(current)],
                            Reason::Triangle,
                        )? {
                            Ordering::Less => true,
                            Ordering::Greater => false,
                            Ordering::Equal => return Err(Reason::Triangle),
                        }
                    }
                }
            };
            if better {
                best = Some((candidate, class));
            }
            Ok(())
        };
        consider(w)?;
        for (index, (a, b)) in self.diagonals.iter().copied().enumerate() {
            if a == w {
                consider(self.count + 2 * index)?;
            }
            if b == w {
                consider(self.count + 2 * index + 1)?;
            }
        }
        best.map(|(candidate, _)| candidate).ok_or(Reason::Triangle)
    }
}

/// The exact rung's result on a fallback path: its topology selection and its result.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ExactOutcome {
    pub(crate) step: ExactStep,
    pub(crate) result: Result<CubicFillDiagnostics, CubicFillError>,
}

/// One ladder outcome: the rung taken, the fallback reason, and on fallback the exact rung's
/// result (contract sections 3.1 and 3.6).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct LadderOutcome {
    pub(crate) rung: Rung,
    pub(crate) reason: Option<Reason>,
    pub(crate) exact: Option<ExactOutcome>,
}

/// The two-rung ladder (contract section 3.1). It owns rung 0's storage, reserved once
/// (section 3.4); rung 1 runs on the caller's `CubicFillWorkspace`.
pub(crate) struct FillLadder {
    fast: Box<[FastRung; 1]>,
}

impl FillLadder {
    /// Reserves rung 0's storage once, with fallible reservation (contract section 3.4): a
    /// refused reservation is `BATCH_ALLOCATION_FAILED`. It also checks that the fill scratch
    /// reserved from `limits` holds AL-FR9's boundary records (`BATCH_INTERNAL_ERROR`
    /// otherwise), with V2 section a's record count 3 · (max_triangles + 2 · max_vertices).
    pub(crate) fn reserve(limits: RoundedFillLimits) -> Result<Self, u32> {
        let scratch_records = limits
            .max_vertices
            .checked_mul(2)
            .and_then(|vertices| vertices.checked_add(limits.max_triangles))
            .and_then(|triangles| triangles.checked_mul(3))
            .ok_or(BATCH_INTERNAL_ERROR)?;
        if MAX_BOUNDARY_RECORDS > scratch_records {
            return Err(BATCH_INTERNAL_ERROR);
        }
        let mut storage: Vec<FastRung> = Vec::new();
        if storage.try_reserve_exact(1).is_err() {
            return Err(BATCH_ALLOCATION_FAILED);
        }
        storage.push(FastRung::new());
        let fast: Box<[FastRung; 1]> = storage
            .into_boxed_slice()
            .try_into()
            .map_err(|_| BATCH_INTERNAL_ERROR)?;
        Ok(Self { fast })
    }

    /// Bytes reserved by the ladder, for the reserve-time totals and `linearMemoryBytes()`.
    pub(crate) fn allocated_bytes(&self) -> usize {
        size_of::<FastRung>()
    }

    pub(crate) fn fast(&self) -> &FastRung {
        &self.fast[0]
    }

    /// The published fast mesh of the last rung-0 call, if it published.
    pub(crate) fn mesh(&self) -> Option<(&[Point], &[[u32; 3]])> {
        self.fast[0].mesh()
    }

    /// Rung 0 on one path that has passed V2's stages 1-3 (its exponent is inside V2's
    /// −1021..=1023): AL-FR0, the S1 prefix with δ = 2^e, FR1-FR8 and AL-FR9.
    pub(crate) fn fast_rung<S: BoundaryScan + ?Sized>(
        &mut self,
        workspace: &mut CubicFillWorkspace,
        request: FillRequest,
        verbs: &[u8],
        point_bytes: &[u8],
        scan: &mut S,
    ) -> Result<(), Reason> {
        self.fast_rung_until(workspace, request, verbs, point_bytes, scan, Stage::Fr9)
    }

    /// As `fast_rung`, stopped after `stop`; a stop before AL-FR9 publishes nothing.
    pub(crate) fn fast_rung_until<S: BoundaryScan + ?Sized>(
        &mut self,
        workspace: &mut CubicFillWorkspace,
        request: FillRequest,
        verbs: &[u8],
        point_bytes: &[u8],
        scan: &mut S,
        stop: Stage,
    ) -> Result<(), Reason> {
        let fast = &mut self.fast[0];
        fast.reset();
        // AL-FR0 (contract section 3.2): a conservative restriction to exponents whose δ, 2δ,
        // δ² and (2δ)² are normal binary64 values. Outside it, rung 0 does no work.
        if !fault(LadderFault::RangeOmitted)
            && !(MIN_FAST_EXPONENT..=MAX_FAST_EXPONENT).contains(&request.exponent)
        {
            return Err(Reason::Range);
        }
        let input = path_input(request, verbs, point_bytes).0;
        match workspace.prepare_prefix(input, MAX_FLAT_COMMANDS) {
            Ok(view) => {
                fast.load(view, input.request.tolerance, request.rule)?;
                fast.run(stop, scan)
            }
            Err(_) => Err(Reason::Prefix),
        }
    }

    /// The ladder on one path: rung 0, then on a fallback rung 1, V2's unchanged two-step
    /// cascade (`attempt`, then `attempt_triangle_free` after `KnotMismatch` or `Unresolved`),
    /// on the same input. The caller has applied V2's stages 1-3.
    pub(crate) fn run<S: BoundaryScan + ?Sized>(
        &mut self,
        workspace: &mut CubicFillWorkspace,
        request: FillRequest,
        verbs: &[u8],
        point_bytes: &[u8],
        scan: &mut S,
    ) -> LadderOutcome {
        match self.fast_rung(workspace, request, verbs, point_bytes, scan) {
            Ok(()) => LadderOutcome {
                rung: Rung::Fast,
                reason: None,
                exact: None,
            },
            Err(reason) => LadderOutcome {
                rung: Rung::Exact,
                reason: Some(reason),
                exact: Some(exact_cascade(workspace, request, verbs, point_bytes)),
            },
        }
    }
}

/// The path input of `fill_export::build_path` with flattening tolerance 2^e, and the
/// topology tolerance 2^(e−1), both built from the exponent bits.
fn path_input<'a>(
    request: FillRequest,
    verbs: &'a [u8],
    point_bytes: &'a [u8],
) -> (PathInput<'a>, f64) {
    let (flatten, topology) = tolerances(request.exponent);
    (
        PathInput::from_parts(
            Request {
                request_id: request.request_id,
                source_epoch: 0,
                source_revision: 0,
                tolerance: flatten,
            },
            verbs,
            point_bytes,
        ),
        topology,
    )
}

/// Rung 1: V2's two-step cascade, unchanged (V2 section c).
pub(crate) fn exact_cascade(
    workspace: &mut CubicFillWorkspace,
    request: FillRequest,
    verbs: &[u8],
    point_bytes: &[u8],
) -> ExactOutcome {
    let (input, topology) = path_input(request, verbs, point_bytes);
    let result = workspace.attempt(input, request.rule, topology, MAX_FLAT_COMMANDS);
    if matches!(
        result,
        Err(CubicFillError::Topology(
            TopologyError::KnotMismatch | TopologyError::Unresolved
        ))
    ) {
        return ExactOutcome {
            step: ExactStep::TriangleFree,
            result: workspace.attempt_triangle_free(
                input,
                request.rule,
                topology,
                MAX_FLAT_COMMANDS,
            ),
        };
    }
    ExactOutcome {
        step: ExactStep::Legacy,
        result,
    }
}
