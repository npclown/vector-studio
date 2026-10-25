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
//! Nothing in a call allocates: the fast rung's storage and its stage scratch are reserved once
//! by `FillLadder::reserve` (section 3.4; E14-K1 item 4 moves both to the heap), and the exact
//! rung allocates nothing inside its `attempt*` entries (B0R O7).
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
//! | E14-K3 | `Work::charge` in FR5, FR7's status scans and face tracing      | none (cost bound)        | `WORK`                  |
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
    MAX_FAST_CONTOUR_POINTS as PREFIX_MAX_POINTS, MAX_FAST_EDGE_OWNERS as PREFIX_MAX_EDGES,
    MAX_FLAT_COMMANDS, MAX_SOURCE_SEGMENTS as PREFIX_MAX_SOURCES,
};
use crate::engine::{BATCH_ALLOCATION_FAILED, BATCH_INTERNAL_ERROR};
use crate::fill_export::{tolerances, FillRequest};
use crate::fill_filter::{compare_enclosures, Interval, UNDECIDED};
use crate::fill_predicates::{orient2d, segment_relation, SegmentRelation};
use crate::geometry::Point;
use crate::line_fill::LineFillRule;
use crate::simple_cubic_topology::TopologyError;

/// Contract section 3.2, AL-FR0: the smallest tolerance exponent rung 0 accepts.
pub(crate) const MIN_FAST_EXPONENT: i32 = -511;
/// Contract section 3.2, AL-FR0: the largest tolerance exponent rung 0 accepts.
pub(crate) const MAX_FAST_EXPONENT: i32 = 510;

/// Section 3.4: the caps the S1 prefix enforces for rung 0 (`cubic_fill.rs`). Since E14-K1 they
/// are the fast caps (E0 = `MAX_FAST_EDGE_OWNERS`), not the exact rung's B1 caps.
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
pub(crate) const MAX_BOUNDARY_RECORDS: usize = boundary_records(MAX_POINTS);
/// AL-FR9's boundary records for a prefix of at most `points` contour points: three per
/// triangle of the bound n + 2h − 2k (E14-K1 item 5).
pub(crate) const fn boundary_records(points: usize) -> usize {
    3 * (points + 2 * MAX_CONTOURS - 2)
}
/// Boundary half-edges plus both directions of every diagonal (FR7 face tracing).
const MAX_HALF_EDGES: usize = MAX_POINTS + 2 * MAX_DIAGONALS;
/// P2's deepest leaf (`geometry.rs` `MAX_DEPTH`, enforced by `validate_leaf_partitions`).
const MAX_LEAF_DEPTH: u32 = 20;

/// The FR5 candidate bitset holds one row per certified edge (spike section 2.5). Before B1 a
/// row was one u64 (`MAX_EDGES <= 64`); B1 widens it to EDGE_WORDS words, bit j in word j / 64,
/// which for at most 64 edges is the pre-B1 word. Since E14-K1 it is heap scratch reserved only
/// with debug assertions.
#[cfg(debug_assertions)]
const EDGE_WORDS: usize = MAX_EDGES.div_ceil(64);
/// E14-K3: rung 0's work cap W0, inclusive. With at most E = 256 flat edges a call charges
/// fewer than 400,000 times (contract section 5), so `WORK` cannot occur there.
pub(crate) const MAX_FAST_WORK: u32 = 1 << 22;
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
    /// E14-K3: rung 0's work cap W0 was reached. Appended last, after the stage reasons.
    Work,
}

impl Reason {
    pub(crate) const ALL: [Self; 11] = [
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
        Self::Work,
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
            Self::Work => "WORK",
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
    /// E14-D4: the FR7 per-vertex diagonal index lists each vertex's half-edges in reverse
    /// order.
    DiagonalIndexReversed,
}

#[cfg(test)]
thread_local! {
    static LADDER_FAULTS: core::cell::Cell<u32> = const { core::cell::Cell::new(0) };
    /// E14-D2 and E14-F8: a lowered work cap for this thread; `None` is W0.
    static WORK_CAP: core::cell::Cell<Option<u32>> = const { core::cell::Cell::new(None) };
    /// E14-D2: W0 not enforced in this thread.
    static WORK_CAP_DISABLED: core::cell::Cell<bool> = const { core::cell::Cell::new(false) };
    /// E14-D4: every indexed `next_half` call is compared with today's linear scan.
    static NEXT_HALF_DIFFERENTIAL: core::cell::Cell<u64> = const { core::cell::Cell::new(0) };
}

/// The work cap of a call: W0, or a test override.
#[cfg(not(test))]
#[inline(always)]
fn work_cap() -> Option<u32> {
    Some(MAX_FAST_WORK)
}

#[cfg(test)]
fn work_cap() -> Option<u32> {
    if WORK_CAP_DISABLED.with(core::cell::Cell::get) {
        return None;
    }
    Some(
        WORK_CAP
            .with(core::cell::Cell::get)
            .unwrap_or(MAX_FAST_WORK),
    )
}

/// Runs `action` with rung 0's work cap set to `cap` in this thread (`None`: not enforced, the
/// seeded defect E14-D2), then restores W0.
#[cfg(test)]
pub(crate) fn with_work_cap<T>(cap: Option<u32>, action: impl FnOnce() -> T) -> T {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            WORK_CAP.with(|value| value.set(None));
            WORK_CAP_DISABLED.with(|value| value.set(false));
        }
    }
    match cap {
        Some(cap) => WORK_CAP.with(|value| value.set(Some(cap))),
        None => WORK_CAP_DISABLED.with(|value| value.set(true)),
    }
    let _reset = Reset;
    action()
}

/// Runs `action` with the E14-D4 differential on: every indexed `next_half` call in this thread
/// is compared with today's linear scan, and a difference panics. Returns the action's result
/// and the number of calls compared.
#[cfg(test)]
pub(crate) fn with_next_half_differential<T>(action: impl FnOnce() -> T) -> (T, u64) {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            NEXT_HALF_DIFFERENTIAL.with(|value| value.set(0));
        }
    }
    NEXT_HALF_DIFFERENTIAL.with(|value| value.set(1));
    let _reset = Reset;
    let result = action();
    let compared = NEXT_HALF_DIFFERENTIAL.with(core::cell::Cell::get) - 1;
    (result, compared)
}

/// E14-K3: rung 0's per-call work counter. Each charge comes before the visit it pays for; at
/// the cap the next charge is `WORK`.
#[derive(Clone, Copy, Debug)]
struct Work {
    used: u32,
    cap: Option<u32>,
}

impl Work {
    fn new() -> Self {
        Self {
            used: 0,
            cap: work_cap(),
        }
    }

    fn charge(&mut self) -> Result<(), Reason> {
        if self.cap.is_some_and(|cap| self.used >= cap) {
            return Err(Reason::Work);
        }
        self.used = self.used.saturating_add(1);
        Ok(())
    }
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

/// Bit equality of two points (AL-U4b1): the same binary64 operands, signed zeros distinct.
fn same_bits(left: Point, right: Point) -> bool {
    left.x.to_bits() == right.x.to_bits() && left.y.to_bits() == right.y.to_bits()
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
    /// E14-K3: the work charges of the call (at most W0).
    pub(crate) work: u32,
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

/// A heap buffer of `length` copies of `value`, reserved fallibly (E14-K1 item 4): a refusal is
/// `BATCH_ALLOCATION_FAILED`.
fn reserved<T: Clone>(value: T, length: usize) -> Result<Vec<T>, u32> {
    let mut buffer = Vec::new();
    buffer
        .try_reserve_exact(length)
        .map_err(|_| BATCH_ALLOCATION_FAILED)?;
    buffer.resize(length, value);
    Ok(buffer)
}

fn heap_bytes<T>(buffer: &Vec<T>) -> usize {
    buffer.capacity() * size_of::<T>()
}

/// E14-K1 item 4: the stage-local arrays of FR5, FR7 and AL-FR9, reserved once with the fast
/// rung. A stage reads and writes only the prefix `[..n]` of each and first sets that prefix to
/// the value the stage's former local declaration gave it, so nothing from an earlier path is
/// read and no call touches a full-capacity array.
#[derive(Default)]
struct RungScratch {
    /// FR5: the edge boxes and the sort's (key, index) items and merge scratch.
    boxes: Vec<EdgeBox>,
    edge_order: Vec<(i64, usize)>,
    edge_scratch: Vec<(i64, usize)>,
    /// FR5's candidate bitset, `MAX_EDGES` rows of `EDGE_WORDS` words; it only feeds a
    /// `debug_assert!`.
    #[cfg(debug_assertions)]
    marks: Vec<u64>,
    /// FR7, sized `MAX_POINTS`.
    next: Vec<usize>,
    previous: Vec<usize>,
    order: Vec<usize>,
    order_scratch: Vec<usize>,
    rank: Vec<usize>,
    kind: Vec<VertexKind>,
    active: Vec<usize>,
    helper: Vec<usize>,
    /// FR7, sized `MAX_DIAGONALS`.
    diagonals: Vec<(usize, usize)>,
    /// E14-K3: the per-vertex diagonal index, `MAX_POINTS + 1` offsets into `2 · MAX_DIAGONALS`
    /// half-edges.
    diagonal_start: Vec<usize>,
    diagonal_halves: Vec<usize>,
    /// FR7 face tracing and monotone triangulation, sized `MAX_HALF_EDGES`.
    visited: Vec<bool>,
    face: Vec<usize>,
    is_left: Vec<bool>,
    face_scratch: Vec<usize>,
    sorted: Vec<usize>,
    stack: Vec<usize>,
    /// AL-FR9 item 3, sized `MAX_POINTS`.
    check_next: Vec<usize>,
    seen: Vec<bool>,
}

impl RungScratch {
    fn reserve() -> Result<Self, u32> {
        Ok(Self {
            boxes: reserved(EdgeBox::default(), MAX_EDGES)?,
            edge_order: reserved((0, 0), MAX_EDGES)?,
            edge_scratch: reserved((0, 0), MAX_EDGES)?,
            #[cfg(debug_assertions)]
            marks: reserved(0, MAX_EDGES * EDGE_WORDS)?,
            next: reserved(0, MAX_POINTS)?,
            previous: reserved(0, MAX_POINTS)?,
            order: reserved(0, MAX_POINTS)?,
            order_scratch: reserved(0, MAX_POINTS)?,
            rank: reserved(0, MAX_POINTS)?,
            kind: reserved(VertexKind::RegularLeft, MAX_POINTS)?,
            active: reserved(0, MAX_POINTS)?,
            helper: reserved(0, MAX_POINTS)?,
            diagonals: reserved((0, 0), MAX_DIAGONALS)?,
            diagonal_start: reserved(0, MAX_POINTS + 1)?,
            diagonal_halves: reserved(0, 2 * MAX_DIAGONALS)?,
            visited: reserved(false, MAX_HALF_EDGES)?,
            face: reserved(0, MAX_HALF_EDGES)?,
            is_left: reserved(false, MAX_HALF_EDGES)?,
            face_scratch: reserved(0, MAX_HALF_EDGES)?,
            sorted: reserved(0, MAX_HALF_EDGES)?,
            stack: reserved(0, MAX_HALF_EDGES)?,
            check_next: reserved(0, MAX_POINTS)?,
            seen: reserved(false, MAX_POINTS)?,
        })
    }

    fn allocated_bytes(&self) -> usize {
        let fr5 =
            heap_bytes(&self.boxes) + heap_bytes(&self.edge_order) + heap_bytes(&self.edge_scratch);
        #[cfg(debug_assertions)]
        let fr5 = fr5 + heap_bytes(&self.marks);
        let fr7 = heap_bytes(&self.next)
            + heap_bytes(&self.previous)
            + heap_bytes(&self.order)
            + heap_bytes(&self.order_scratch)
            + heap_bytes(&self.rank)
            + heap_bytes(&self.kind)
            + heap_bytes(&self.active)
            + heap_bytes(&self.helper)
            + heap_bytes(&self.diagonals)
            + heap_bytes(&self.diagonal_start)
            + heap_bytes(&self.diagonal_halves)
            + heap_bytes(&self.visited)
            + heap_bytes(&self.face)
            + heap_bytes(&self.is_left)
            + heap_bytes(&self.face_scratch)
            + heap_bytes(&self.sorted)
            + heap_bytes(&self.stack);
        fr5 + fr7 + heap_bytes(&self.check_next) + heap_bytes(&self.seen)
    }
}

/// The fast rung (contract section 3.1). Its arrays are fixed in size (section 3.4) and, since
/// E14-K1 item 4, heap buffers reserved once by `FastRung::reserve`, inside `FillLadder`: at E0
/// they no longer fit a WebAssembly stack frame.
pub(crate) struct FastRung {
    delta: f64,
    rule: LineFillRule,
    points: Vec<Point>,
    point_len: usize,
    ranges: [ContourRange; MAX_CONTOURS],
    range_len: usize,
    owners: Vec<EdgeOwner>,
    owner_len: usize,
    sources: [DecodedSource; MAX_SOURCES],
    source_len: usize,
    contours: [ContourInfo; MAX_CONTOURS],
    pieces: Vec<Piece>,
    cert: Vec<CertEdge>,
    cert_len: usize,
    orientation: [i32; MAX_CONTOURS],
    boundary: [bool; MAX_CONTOURS],
    reversed: [bool; MAX_CONTOURS],
    vertices: Vec<Point>,
    vertex_len: usize,
    triangles: Vec<[u32; 3]>,
    triangle_len: usize,
    published: bool,
    stats: FastStats,
    work: Work,
    scratch: RungScratch,
}

impl FastRung {
    /// Reserves the fast rung's storage and stage scratch on the heap, fallibly (E14-K1 item 4):
    /// the one constructor of production and tests. A refusal is `BATCH_ALLOCATION_FAILED`.
    pub(crate) fn reserve() -> Result<Self, u32> {
        Ok(Self {
            delta: 0.0,
            rule: LineFillRule::Nonzero,
            points: reserved(Point::default(), MAX_POINTS)?,
            point_len: 0,
            ranges: [ContourRange::default(); MAX_CONTOURS],
            range_len: 0,
            owners: reserved(EdgeOwner::ImplicitClosure { contour: 0 }, MAX_EDGES)?,
            owner_len: 0,
            sources: [DecodedSource::default(); MAX_SOURCES],
            source_len: 0,
            contours: [ContourInfo::default(); MAX_CONTOURS],
            pieces: reserved(Piece::Unset, MAX_EDGES)?,
            cert: reserved(CertEdge::default(), MAX_EDGES)?,
            cert_len: 0,
            orientation: [0; MAX_CONTOURS],
            boundary: [false; MAX_CONTOURS],
            reversed: [false; MAX_CONTOURS],
            vertices: reserved(Point::default(), MAX_POINTS)?,
            vertex_len: 0,
            triangles: reserved([0; 3], MAX_TRIANGLES)?,
            triangle_len: 0,
            published: false,
            stats: FastStats::default(),
            work: Work::new(),
            scratch: RungScratch::reserve()?,
        })
    }

    /// The fast rung's bytes: the struct and every heap buffer (E14-G3).
    pub(crate) fn allocated_bytes(&self) -> usize {
        size_of::<Self>()
            + heap_bytes(&self.points)
            + heap_bytes(&self.owners)
            + heap_bytes(&self.pieces)
            + heap_bytes(&self.cert)
            + heap_bytes(&self.vertices)
            + heap_bytes(&self.triangles)
            + self.scratch.allocated_bytes()
    }

    /// Clears the outputs of an earlier call, so that no fallback path can read rung 0's
    /// partial state (contract section 3.6, defect (15)), and starts the call's work count.
    fn reset(&mut self) {
        self.published = false;
        self.stats = FastStats::default();
        self.work = Work::new();
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
        // AL-U4b1 (contract section 5.1, AL-C2 with AL-C1): the prefix-shared subdivision of
        // the leaves, bounded stack scratch; see `Subdivision`.
        let mut subdivision = Subdivision::new();
        // AL-U4b1 (AL-C1): the previous leaf's p_end and its 2 p_end. The next leaf's 2 p_start
        // is that value when p_start has the same bits, since both are `IPoint::exact(p).mul(two)`
        // on bit-identical p; otherwise it is computed as before.
        let mut doubled_end: Option<(Point, IPoint)> = None;
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
                    controls = subdivision.restrict(source, numerator, depth);
                    // Spike section 3.3: d_0 = R0 − p_start, d_1 = R1 − (2 p_start + p_end)/3,
                    // d_2 = R2 − (p_start + 2 p_end)/3, d_3 = R3 − p_end.
                    let start_doubled = match doubled_end {
                        Some((point, doubled)) if same_bits(point, edge.start) => doubled,
                        _ => start.mul(two),
                    };
                    let end_doubled = end.mul(two);
                    doubled_end = Some((edge.end, end_doubled));
                    let third = start_doubled.add(end).div(three);
                    let two_thirds = start.add(end_doubled).div(three);
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
            let edges = &self.cert[info.cert_start..info.cert_start + info.cert_count];
            monotone_contour(edges, chords_only, &mut |_| {})?;
        }
        Ok(())
    }

    // ------------------------------------------------------------------------------------
    // FR5: non-consecutive pairs (SL-C3; SL-L3, SL-L4; spike section 3.9).

    /// FR5 (SL-C3): `clearance_edges` on the certified edges of P′.
    fn clearance(&mut self) -> Result<(), Reason> {
        let result = clearance_edges(
            &self.cert[..self.cert_len],
            &self.contours,
            self.delta,
            ClearanceScratch {
                boxes: &mut self.scratch.boxes,
                order: &mut self.scratch.edge_order,
                scratch: &mut self.scratch.edge_scratch,
                #[cfg(debug_assertions)]
                marks: &mut self.scratch.marks,
            },
            &mut self.work,
            &mut self.stats,
            &mut |_, _, _| {},
        );
        self.stats.work = self.work.used;
        result
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
        // E14-K1 item 4: the stage scratch and the vertex buffer leave `self` for the stage, so
        // that FR7 borrows them instead of copying the vertex array (both moves are pointer
        // swaps), and come back on every return.
        let mut scratch = core::mem::take(&mut self.scratch);
        let mut vertices = core::mem::take(&mut self.vertices);
        let result = self.triangulate_with(&mut scratch, &mut vertices);
        self.vertices = vertices;
        self.scratch = scratch;
        self.stats.work = self.work.used;
        result
    }

    fn triangulate_with(
        &mut self,
        scratch: &mut RungScratch,
        vertex_buffer: &mut [Point],
    ) -> Result<(), Reason> {
        let RungScratch {
            next,
            previous,
            order,
            order_scratch,
            rank,
            kind,
            active,
            helper,
            diagonals,
            diagonal_start,
            diagonal_halves,
            visited,
            face,
            is_left,
            face_scratch,
            sorted,
            stack,
            ..
        } = scratch;
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
                vertex_buffer[self.vertex_len] = self.points[info.point_start + source];
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
        let vertices: &[Point] = vertex_buffer;

        // Event order, ties by vertex index; equal points cannot occur under SL-T1.
        order_scratch[..count].fill(0);
        for (index, slot) in order[..count].iter_mut().enumerate() {
            *slot = index;
        }
        merge_sort(&mut order[..count], &mut order_scratch[..count], |a, b| {
            above(vertices[a], vertices[b]).then(a.cmp(&b))
        });
        rank[..count].fill(0);
        for (position, vertex) in order[..count].iter().copied().enumerate() {
            if position > 0
                && above(vertices[order[position - 1]], vertices[vertex]) != Ordering::Less
            {
                return Err(Reason::Triangle);
            }
            rank[vertex] = position;
        }

        // Vertex classification from the neighbours' order and the orient2d sign at the vertex.
        kind[..count].fill(VertexKind::RegularLeft);
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
        // their east, each with its helper; a small array searched linearly (AL-OB8). Each
        // vertex inserts at most one edge, so the status stays inside `active[..count]`.
        active[..count].fill(0);
        let mut active_len = 0usize;
        helper[..count].fill(0);
        // At most n + 3h − 3k diagonals (section 3.4); a longer list overflows `MAX_DIAGONALS`.
        diagonals[..(count + 3 * MAX_CONTOURS - 3).min(MAX_DIAGONALS)].fill((0, 0));
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
            vertices,
            next,
            rank,
        };
        let work = &mut self.work;
        for vertex in order[..count].iter().copied() {
            let incoming = previous[vertex];
            match kind[vertex] {
                VertexKind::Start => {
                    insert_edge(active, &mut active_len, vertex)?;
                    helper[vertex] = vertex;
                }
                VertexKind::End => {
                    if kind[helper[incoming]] == VertexKind::Merge {
                        add_diagonal(vertex, helper[incoming])?;
                    }
                    remove_edge(active, &mut active_len, incoming, work)?;
                }
                VertexKind::Split => {
                    let left = sweep.left_edge(vertex, &active[..active_len], work)?;
                    add_diagonal(vertex, helper[left])?;
                    helper[left] = vertex;
                    insert_edge(active, &mut active_len, vertex)?;
                    helper[vertex] = vertex;
                }
                VertexKind::Merge => {
                    if kind[helper[incoming]] == VertexKind::Merge {
                        add_diagonal(vertex, helper[incoming])?;
                    }
                    remove_edge(active, &mut active_len, incoming, work)?;
                    let left = sweep.left_edge(vertex, &active[..active_len], work)?;
                    if kind[helper[left]] == VertexKind::Merge {
                        add_diagonal(vertex, helper[left])?;
                    }
                    helper[left] = vertex;
                }
                VertexKind::RegularRight => {
                    if kind[helper[incoming]] == VertexKind::Merge {
                        add_diagonal(vertex, helper[incoming])?;
                    }
                    remove_edge(active, &mut active_len, incoming, work)?;
                    insert_edge(active, &mut active_len, vertex)?;
                    helper[vertex] = vertex;
                }
                VertexKind::RegularLeft => {
                    let left = sweep.left_edge(vertex, &active[..active_len], work)?;
                    if kind[helper[left]] == VertexKind::Merge {
                        add_diagonal(vertex, helper[left])?;
                    }
                    helper[left] = vertex;
                }
            }
        }
        self.stats.diagonals = u32::try_from(diagonal_len).unwrap_or(u32::MAX);
        let diagonals = &diagonals[..diagonal_len];

        // E14-K3: the per-vertex diagonal index, a counting sort of the diagonal half-edges by
        // origin that keeps half-edge order, so `next_half` considers the half-edges at a
        // vertex in today's order (diagonal index, then direction). `helper` is free after the
        // sweep and serves as the write cursor.
        let half_count = count + 2 * diagonal_len;
        diagonal_start[..=count].fill(0);
        for &(a, b) in diagonals {
            diagonal_start[a + 1] += 1;
            diagonal_start[b + 1] += 1;
        }
        for vertex in 0..count {
            diagonal_start[vertex + 1] += diagonal_start[vertex];
        }
        diagonal_halves[..2 * diagonal_len].fill(0);
        helper[..count].copy_from_slice(&diagonal_start[..count]);
        let reversed_index = fault(LadderFault::DiagonalIndexReversed);
        for half in count..half_count {
            let (a, b) = diagonals[(half - count) / 2];
            let origin = if (half - count).is_multiple_of(2) {
                a
            } else {
                b
            };
            diagonal_halves[helper[origin]] = half;
            helper[origin] += 1;
        }
        if reversed_index {
            for vertex in 0..count {
                diagonal_halves[diagonal_start[vertex]..diagonal_start[vertex + 1]].reverse();
            }
        }

        // Monotone pieces: trace the faces left of every boundary half-edge (v → next(v)) and of
        // both directions of every diagonal. At w, arriving from u, the next half-edge is the
        // first outgoing one clockwise from the direction w → u.
        let graph = Graph {
            vertices,
            next,
            diagonals,
            count,
            diagonal_start,
            diagonal_halves,
        };
        visited[..half_count].fill(false);
        face[..half_count].fill(0);
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
                half = graph.next_half(half, &mut self.work)?;
            }
            self.triangulate_monotone(
                &face[..length],
                vertices,
                rank,
                FaceScratch {
                    is_left,
                    sorted,
                    scratch: face_scratch,
                    stack,
                },
            )?;
        }
        Ok(())
    }

    fn emit(&mut self, vertices: &[Point], triangle: [usize; 3]) -> Result<(), Reason> {
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
        vertices: &[Point],
        rank: &[usize],
        FaceScratch {
            is_left,
            sorted,
            scratch,
            stack,
        }: FaceScratch<'_>,
    ) -> Result<(), Reason> {
        let length = face.len();
        if length < 3 {
            return Err(Reason::Triangle);
        }
        is_left[..length].fill(false);
        sorted[..length].fill(0);
        scratch[..length].fill(0);
        stack[..length].fill(0);
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
        for (index, slot) in sorted[..length].iter_mut().enumerate() {
            *slot = index;
        }
        merge_sort(&mut sorted[..length], &mut scratch[..length], |a, b| {
            rank[face[a]].cmp(&rank[face[b]])
        });
        let vertex = |slot: usize| face[slot];
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
        vertices: &[Point],
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
            let next = &mut self.scratch.check_next[..count];
            next.fill(0);
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
            let seen = &mut self.scratch.seen[..count];
            seen.fill(false);
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

/// One certified edge's FR4 operands, computed once per edge (AL-U4b2; contract section 5.1,
/// AL-C1). The spike computed them in each of the edge's two consecutive pairs, (previous, e)
/// and (e, next), by the same operations on the same operands: the chord
/// `exact_difference(end, start)` and the control steps `controls[m + 1].sub(controls[m])`.
/// They depend only on the edge, not on the pair's w, so the value computed once has the bits
/// of each of the two values computed before. `fill_filter::Interval` reads only the test-build
/// fault switch, which nothing changes during FR4, so computing a step that the spike would not
/// have reached (its pair failed earlier) has no effect.
#[derive(Clone, Copy)]
struct MonotoneEdge {
    /// u = p_end − p_start.
    chord: IPoint,
    /// R_{m+1} − R_m for m < `terms` (leaf: m = 0, 1, 2), or γ(1) − γ(0) (segment).
    steps: [IPoint; 3],
    /// 3 for a leaf, 1 for a segment, `None` for an unset piece. FR2 has already returned
    /// `STRUCTURE` on an unset piece; FR4 keeps the spike's check at the spike's position.
    terms: Option<usize>,
}

impl MonotoneEdge {
    fn new(edge: &CertEdge) -> Self {
        let terms = match edge.piece {
            Piece::Leaf { .. } => Some(3),
            Piece::Segment { .. } => Some(1),
            Piece::Unset => None,
        };
        let mut steps = [IPoint::default(); 3];
        for (term, step) in steps.iter_mut().enumerate().take(terms.unwrap_or(0)) {
            *step = edge.controls[term + 1].sub(edge.controls[term]);
        }
        Self {
            chord: exact_difference(edge.end, edge.start),
            steps,
            terms,
        }
    }
}

/// FR4 on one contour's certified edges (SL-C2; SL-L2): every consecutive pair (e, f), in
/// contour order and then the cyclic pair (last, first), with w = p_end(f) − p_start(e):
/// ⟨u_e, w⟩ > 0 and ⟨u_f, w⟩ > 0 proved, then for e and then f each ⟨R_{m+1} − R_m, w⟩ > 0
/// (m = 0, 1, 2 for a leaf) or ⟨γ(1) − γ(0), w⟩ > 0 (a segment) proved, in that order. The
/// first unproved dot returns `MONOTONE`.
///
/// AL-U4b2 (contract section 5.1, AL-C1): each edge's `MonotoneEdge` is computed once, when it
/// first enters a pair as f (edge 0 as the first pair's e, kept for the cyclic pair). Every dot
/// is `dot(operand, w)` on operands with the spike's bits, in the spike's order, and every
/// decision is the same `proved_positive`; the checks, their order and the reasons are the
/// spike's. `observe` sees each decided dot interval in order; production passes a no-op, and
/// only the AL-U4b2 equivalence test (`monotone_trace`) records them.
fn monotone_contour(
    edges: &[CertEdge],
    chords_only: bool,
    observe: &mut impl FnMut(Interval),
) -> Result<(), Reason> {
    let count = edges.len();
    if count == 0 {
        return Ok(());
    }
    let first = MonotoneEdge::new(&edges[0]);
    let mut e = first;
    for index in 0..count {
        let next = index + 1;
        let (f_edge, f) = if next < count {
            (&edges[next], MonotoneEdge::new(&edges[next]))
        } else {
            (&edges[0], first)
        };
        // w = p_end(f) − p_start(e); u_e, u_f the chords.
        let w = exact_difference(f_edge.end, edges[index].start);
        let chord_e = dot(e.chord, w);
        observe(chord_e);
        if !proved_positive(chord_e) {
            return Err(Reason::Monotone);
        }
        let chord_f = dot(f.chord, w);
        observe(chord_f);
        if !proved_positive(chord_f) {
            return Err(Reason::Monotone);
        }
        if !chords_only {
            for edge in [&e, &f] {
                let Some(terms) = edge.terms else {
                    return Err(Reason::Structure);
                };
                for step in &edge.steps[..terms] {
                    let value = dot(*step, w);
                    observe(value);
                    if !proved_positive(value) {
                        return Err(Reason::Monotone);
                    }
                }
            }
        }
        e = f;
    }
    Ok(())
}

/// AL-U4b2 equivalence test input: one certified edge as FR4 reads it, (p_start, p_end, the
/// step count (3 leaf, 1 segment, `None` unset), the controls' [x, y] intervals).
#[cfg(test)]
pub(crate) type MonotoneTestEdge = (Point, Point, Option<usize>, [[Interval; 2]; 4]);

#[cfg(test)]
impl FastRung {
    /// AL-U4b2 equivalence hook: the certified edges of each loaded contour, as FR4 reads them
    /// after a run through FR3.
    pub(crate) fn monotone_inputs(&self) -> Vec<Vec<MonotoneTestEdge>> {
        self.contours[..self.range_len]
            .iter()
            .map(|info| {
                self.cert[info.cert_start..info.cert_start + info.cert_count]
                    .iter()
                    .map(|edge| {
                        let terms = match edge.piece {
                            Piece::Leaf { .. } => Some(3),
                            Piece::Segment { .. } => Some(1),
                            Piece::Unset => None,
                        };
                        (
                            edge.start,
                            edge.end,
                            terms,
                            edge.controls.map(|point| [point.x, point.y]),
                        )
                    })
                    .collect()
            })
            .collect()
    }
}

/// AL-U4b2 equivalence hook: production FR4 (`monotone_contour`, as `FastRung::monotone` runs
/// it over the contours) on the given edges, with the result and the bits [lo, hi] of every
/// decided dot interval in order.
#[cfg(test)]
pub(crate) fn monotone_trace(
    contours: &[Vec<MonotoneTestEdge>],
    chords_only: bool,
) -> (Result<(), Reason>, Vec<[u64; 2]>) {
    let mut trace = Vec::new();
    let mut observe = |value: Interval| trace.push([value.lo.to_bits(), value.hi.to_bits()]);
    let mut result = Ok(());
    for contour in contours {
        let edges: Vec<CertEdge> = contour
            .iter()
            .map(|&(start, end, terms, controls)| CertEdge {
                start,
                end,
                piece: match terms {
                    Some(3) => Piece::Leaf {
                        source: 0,
                        controls: [start, start, end, end],
                        numerator: 1,
                        depth: 0,
                    },
                    Some(1) => Piece::Segment { a: start, b: end },
                    None => Piece::Unset,
                    Some(other) => panic!("no piece has {other} control steps"),
                },
                controls: controls.map(|[x, y]| IPoint { x, y }),
                ..CertEdge::default()
            })
            .collect();
        result = monotone_contour(&edges, chords_only, &mut observe);
        if result.is_err() {
            break;
        }
    }
    (result, trace)
}

/// FR5 visit outcomes, as `clearance_edges` passes them to its `observe` callback with the
/// pair (a, b) in scan order. Only the AL-U4b3 equivalence test (`clearance_trace`) records
/// them; production passes a no-op.
///
/// A consecutive pair, skipped (SL-C2 handles it).
pub(crate) const VISIT_CONSECUTIVE: u8 = 0;
/// Step 1 proved an axis gap above r.
pub(crate) const VISIT_BOX_GAP: u8 = 1;
/// Step 2 found a relation other than `Disjoint`: `CROSSING`.
pub(crate) const VISIT_CROSSING: u8 = 2;
/// Defect (4), simplicity only: step 2 passed and step 3 is skipped.
pub(crate) const VISIT_DISJOINT: u8 = 3;
/// Step 3 proved all four point-segment distances above r.
pub(crate) const VISIT_CLEAR: u8 = 4;
/// Step 3 failed at point test k (0-3): `CLEARANCE`. The code is `VISIT_CLEARANCE + k`.
pub(crate) const VISIT_CLEARANCE: u8 = 5;

/// One certified edge's axis-aligned box, for the FR5 sort key, the scan bound and step 1.
///
/// AL-U4b3 (contract section 5.1, AL-C1): before AL-U4b3, FR5 computed xlo and xhi once per
/// edge for the sort and the scan, and step 1 recomputed all four extremes of both edges for
/// every candidate pair, as `e.start.x.max(e.end.x)`, `f.start.x.min(f.end.x)` and likewise in
/// y. Each field here is the same `f64::min` or `f64::max` call on the same two operands in the
/// same order (start, then end), computed once per edge, so it has the bits of every per-pair
/// computation. No rounding is involved; FR1 has checked that every coordinate is finite.
#[derive(Clone, Copy, Default)]
struct EdgeBox {
    xlo: f64,
    xhi: f64,
    ylo: f64,
    yhi: f64,
}

impl EdgeBox {
    fn new(edge: &CertEdge) -> Self {
        Self {
            xlo: edge.start.x.min(edge.end.x),
            xhi: edge.start.x.max(edge.end.x),
            ylo: edge.start.y.min(edge.end.y),
            yhi: edge.start.y.max(edge.end.y),
        }
    }
}

/// AL-U4b3 (AL-C4): the integer key of `f64::total_cmp`, computed as the standard library's
/// implementation computes it (the sign-magnitude bits mapped to two's complement order), so
/// `total_order_key(a).cmp(&total_order_key(b)) == a.total_cmp(&b)` for all a and b. It is
/// integer bit manipulation, with no floating-point arithmetic.
fn total_order_key(value: f64) -> i64 {
    let mut bits = value.to_bits() as i64;
    bits ^= (((bits >> 63) as u64) >> 1) as i64;
    bits
}

/// SL-C2 handles consecutive pairs; every other pair, in one contour or two, is SL-C3's.
///
/// AL-U4b3 (AL-C4): the edges are read by reference instead of being copied for each scan
/// visit; the integer test is unchanged.
fn consecutive(a: &CertEdge, b: &CertEdge, contours: &[ContourInfo], skip_two_apart: bool) -> bool {
    if a.contour != b.contour {
        return false;
    }
    let count = contours[a.contour].cert_count;
    let offset = (a.local + count - b.local) % count;
    offset == 1 || offset == count - 1 || (skip_two_apart && (offset == 2 || offset + 2 == count))
}

/// FR5 (SL-C3; SL-L3, SL-L4; spike section 3.9): the x sweep over the certified edges of P′ and
/// steps 1-3 for every non-consecutive pair it reaches, in the spike's order. The first
/// unproved pair returns `CROSSING` or `CLEARANCE`. It sets the sweep and clearance counters of
/// `stats`.
///
/// AL-U4b3 (contract section 5.1, AL-C1 and AL-C4), against AL-U4b2's `FastRung::clearance`:
///
/// - The boxes are computed once per edge (`EdgeBox`, AL-C1). The sort key, the scan bound and
///   step 1 read the same values as before: xlo and xhi were already computed once per edge, and
///   step 1's extremes have the bits of its per-pair computations.
/// - Step 1 tests the four gaps in the same order, gap(xhi(e), xlo(f)), gap(xhi(f), xlo(e)),
///   gap(yhi(e), ylo(f)), gap(yhi(f), ylo(e)), each by the same `Interval::point(low)` minus
///   `Interval::point(high)` and `proved_exceeds(gap, r)`. It now computes a gap only when the
///   earlier ones did not decide (AL-C4, control flow): the interval operations are pure and
///   `.any` already stopped at the first decided gap, so the decision is the same.
/// - The sort orders (key, index) pairs by integer comparison (`total_order_key`, AL-C4),
///   which decides every comparison as before.
/// - Edges are read by reference, not copied per scan visit and per candidate (AL-C4).
/// - The fault switches are read once per call instead of once per position, visit or pair
///   (AL-C4). They are test-build constants that no stage changes, and constant `false` outside
///   test builds.
/// - The candidate bitset, which only feeds a `debug_assert!`, exists only with debug
///   assertions (AL-C4: no zeroing of `MAX_EDGES × EDGE_WORDS` words per call in release).
///
/// The sort, the scan order and bound, the consecutive skip, the step order and every decided
/// quantity are unchanged, so the result and the counters are the same for every input.
/// `observe` sees each visit's outcome (`VISIT_*`) in order.
///
/// E14-K1 item 4: the boxes, the sort arrays and the debug bitset are the caller's reserved
/// scratch; only their prefixes for `edges.len()` are set and read, and the bitset clears only
/// the rows and words it can set. E14-K3: every sweep candidate is charged to `work` before its
/// visit; at the cap the call returns `WORK`.
fn clearance_edges(
    edges: &[CertEdge],
    contours: &[ContourInfo],
    delta: f64,
    scratch: ClearanceScratch<'_>,
    work: &mut Work,
    stats: &mut FastStats,
    observe: &mut impl FnMut(usize, usize, u8),
) -> Result<(), Reason> {
    let ClearanceScratch {
        boxes,
        order,
        scratch,
        #[cfg(debug_assertions)]
        marks,
    } = scratch;
    let count = edges.len();
    // Contract section 3.2: r = 2δ and r² enclosed exactly as the spike does.
    let radius = 2.0 * delta;
    let r = Interval::point(radius);
    let r_squared = r.mul(r);
    let scan_without_radius = fault(LadderFault::ScanBoundWithoutRadius);
    let skip_two_apart = fault(LadderFault::SkipTwoApart);
    let simplicity_only = fault(LadderFault::SimplicityOnly);
    let boxes = &mut boxes[..count];
    for (slot, edge) in boxes.iter_mut().zip(edges) {
        *slot = EdgeBox::new(edge);
    }
    // Sort by xlo, ties by index (allocation-free bottom-up merge sort). AL-U4b3 (AL-C4): the
    // items are (total_order_key(xlo), index) pairs compared as integer pairs. For every two
    // items this gives the result of AL-U4b2's comparator
    // `xlo[a].total_cmp(&xlo[b]).then(a.cmp(&b))` (see `total_order_key`), so the same merge
    // sort makes the same moves and yields the same order.
    let order = &mut order[..count];
    let scratch = &mut scratch[..count];
    scratch.fill((0, 0));
    for (index, slot) in order.iter_mut().enumerate() {
        *slot = (total_order_key(boxes[index].xlo), index);
    }
    merge_sort(order, scratch, |a, b| a.cmp(&b));
    // Row `low` holds bit `high` in word `high / 64`; only rows below `count` and words below
    // `count.div_ceil(64)` can be set.
    #[cfg(debug_assertions)]
    let words = count.div_ceil(64);
    #[cfg(debug_assertions)]
    for row in 0..count {
        marks[row * EDGE_WORDS..row * EDGE_WORDS + words].fill(0);
    }
    stats.sweep_candidates = 0;
    stats.clearance_step2 = 0;
    stats.clearance_step3 = 0;
    for position in 0..count {
        let a = order[position].1;
        // Spike section 3.9: scan while xlo(b) ≤ next_up(fl(xhi(a) + r)). An unscanned pair
        // has xlo(b) above an upper bound of xhi(a) + r (R1), so a proved x gap above r.
        let bound = if scan_without_radius {
            boxes[a].xhi
        } else {
            (boxes[a].xhi + radius).next_up()
        };
        let bound = if bound.is_finite() {
            bound
        } else {
            f64::INFINITY
        };
        for &(_, b) in &order[position + 1..count] {
            if boxes[b].xlo > bound {
                break;
            }
            if consecutive(&edges[a], &edges[b], contours, skip_two_apart) {
                observe(a, b, VISIT_CONSECUTIVE);
                continue;
            }
            work.charge()?;
            #[cfg(debug_assertions)]
            {
                let (low, high) = (a.min(b), a.max(b));
                marks[low * EDGE_WORDS + high / 64] |= 1u64 << (high % 64);
            }
            stats.sweep_candidates += 1;
            let outcome = clear_pair(
                (&edges[a], &boxes[a]),
                (&edges[b], &boxes[b]),
                r,
                r_squared,
                simplicity_only,
                stats,
            );
            observe(a, b, outcome);
            match outcome {
                VISIT_CROSSING => return Err(Reason::Crossing),
                VISIT_BOX_GAP | VISIT_DISJOINT | VISIT_CLEAR => {}
                _ => return Err(Reason::Clearance),
            }
        }
    }
    #[cfg(debug_assertions)]
    debug_assert!(
        (0..count)
            .flat_map(|row| &marks[row * EDGE_WORDS..row * EDGE_WORDS + words])
            .map(|word| word.count_ones())
            .sum::<u32>()
            == stats.sweep_candidates
    );
    Ok(())
}

/// FR5's reserved scratch (E14-K1 item 4), borrowed from `RungScratch` or from a test.
struct ClearanceScratch<'a> {
    boxes: &'a mut [EdgeBox],
    order: &'a mut [(i64, usize)],
    scratch: &'a mut [(i64, usize)],
    #[cfg(debug_assertions)]
    marks: &'a mut [u64],
}

/// FR7's per-face scratch for `triangulate_monotone` (E14-K1 item 4).
struct FaceScratch<'a> {
    is_left: &'a mut [bool],
    sorted: &'a mut [usize],
    scratch: &'a mut [usize],
    stack: &'a mut [usize],
}

/// Spike section 3.9 steps 1-3 for one non-consecutive pair e = [a, b], f = [c, d], with each
/// edge's box; the visit outcome (`VISIT_*`). See `clearance_edges` for the AL-U4b3 argument.
fn clear_pair(
    (e, e_box): (&CertEdge, &EdgeBox),
    (f, f_box): (&CertEdge, &EdgeBox),
    r: Interval,
    r_squared: Interval,
    simplicity_only: bool,
    stats: &mut FastStats,
) -> u8 {
    if !simplicity_only {
        // Step 1, box gap: Euclidean distance is at least each axis gap.
        let gap = |high: f64, low: f64| Interval::point(low).sub(Interval::point(high));
        if proved_exceeds(gap(e_box.xhi, f_box.xlo), r)
            || proved_exceeds(gap(f_box.xhi, e_box.xlo), r)
            || proved_exceeds(gap(e_box.yhi, f_box.ylo), r)
            || proved_exceeds(gap(f_box.yhi, e_box.ylo), r)
        {
            return VISIT_BOX_GAP;
        }
    }
    // Step 2: the closed segments must be disjoint (B0D-Q6 (a)); any other relation, a
    // crossing, touch, collinear point or overlap, is `CROSSING`.
    stats.clearance_step2 += 1;
    match segment_relation(e.start, e.end, f.start, f.end) {
        Ok(SegmentRelation::Disjoint) => {}
        _ => return VISIT_CROSSING,
    }
    if simplicity_only {
        return VISIT_DISJOINT;
    }
    // Step 3 (SL-L4): for disjoint segments the distance is the minimum of the four
    // point-segment distances, each of which must be proved farther than r.
    stats.clearance_step3 += 1;
    for (test, (point, segment)) in [(e.start, f), (e.end, f), (f.start, e), (f.end, e)]
        .into_iter()
        .enumerate()
    {
        if !point_clear(point, segment.start, segment.end, r_squared) {
            return VISIT_CLEARANCE + test as u8;
        }
    }
    VISIT_CLEAR
}

/// AL-U4b3 equivalence test input: one certified edge as FR5 reads it, (p_start, p_end, its
/// contour, its index in the contour).
#[cfg(test)]
pub(crate) type ClearanceTestEdge = (Point, Point, usize, usize);

/// AL-U4b3 equivalence trace: the FR5 result, the counters (sweep candidates, step 2, step 3)
/// and every visit (a, b, `VISIT_*`) in order.
#[cfg(test)]
pub(crate) type ClearanceTrace = (Result<(), Reason>, [u32; 3], Vec<(usize, usize, u8)>);

#[cfg(test)]
impl FastRung {
    /// AL-U4b3 equivalence hook: the certified edges, each contour's certified edge count and
    /// δ, as FR5 reads them after a run through FR4.
    pub(crate) fn clearance_inputs(&self) -> (Vec<ClearanceTestEdge>, Vec<usize>, f64) {
        (
            self.cert[..self.cert_len]
                .iter()
                .map(|edge| (edge.start, edge.end, edge.contour, edge.local))
                .collect(),
            self.contours[..self.range_len]
                .iter()
                .map(|info| info.cert_count)
                .collect(),
            self.delta,
        )
    }
}

/// AL-U4b3 equivalence hook: production FR5 (`clearance_edges`) on the given edges, with the
/// result, the counters (sweep candidates, step 2, step 3) and every visit (a, b, `VISIT_*`) in
/// order. It reads the ladder fault switches as production does.
#[cfg(test)]
pub(crate) fn clearance_trace(
    edges: &[ClearanceTestEdge],
    counts: &[usize],
    delta: f64,
) -> ClearanceTrace {
    assert!(
        edges.len() <= MAX_EDGES,
        "at most MAX_EDGES certified edges"
    );
    let cert: Vec<CertEdge> = edges
        .iter()
        .map(|&(start, end, contour, local)| CertEdge {
            start,
            end,
            piece: Piece::Segment { a: start, b: end },
            contour,
            local,
            ..CertEdge::default()
        })
        .collect();
    let contours: Vec<ContourInfo> = counts
        .iter()
        .map(|&cert_count| ContourInfo {
            cert_count,
            ..ContourInfo::default()
        })
        .collect();
    let mut stats = FastStats::default();
    let mut trace = Vec::new();
    let count = cert.len();
    let (mut boxes, mut order, mut scratch) = (
        vec![EdgeBox::default(); count],
        vec![(0, 0); count],
        vec![(0, 0); count],
    );
    #[cfg(debug_assertions)]
    let mut marks = vec![0; count * EDGE_WORDS];
    let result = clearance_edges(
        &cert,
        &contours,
        delta,
        ClearanceScratch {
            boxes: &mut boxes,
            order: &mut order,
            scratch: &mut scratch,
            #[cfg(debug_assertions)]
            marks: &mut marks,
        },
        &mut Work::new(),
        &mut stats,
        &mut |a, b, outcome| {
            trace.push((a, b, outcome));
        },
    );
    (
        result,
        [
            stats.sweep_candidates,
            stats.clearance_step2,
            stats.clearance_step3,
        ],
        trace,
    )
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

const LEVELS: usize = MAX_LEAF_DEPTH as usize;

/// Interval de Casteljau restriction of source cubics to dyadic cells [(n − 1)/2^d, n/2^d],
/// with the cell bits read from high to low (P3.2g `restrict_cell`), shared across the leaves
/// of FR2 (AL-U4b1; contract section 5.1, AL-C2 with AL-C1).
///
/// The spike's `restrict` started each leaf at `IPoint::exact` of the source controls and
/// applied `split_half(points, bit)` once per bit of n − 1, high to low. Its level-j interval
/// controls therefore depend only on the source's bits and on the first j bits of the cell,
/// that is on the prefix index (n − 1) >> (d − j). This cache keeps, for the last source seen,
/// the node of every level along the last leaf's path, keyed by that prefix index, and both
/// halves of each node it has split:
///
/// - AL-C1: `split_half` computed all six midpoints whatever `right` was, then returned one
///   half. `split_both` makes the same six `midpoint` calls on the same operands, in the same
///   order, and returns both halves, so each half has the bits `split_half` gave it.
/// - AL-C2: a cached node at level j is the result of the same j `split_half` steps on the same
///   inputs as the uncached path: the source is compared by bits (so `IPoint::exact` gives the
///   same root), and the level-j key equals the leaf's prefix index only when the first j bits
///   agree. The leaf's result is therefore bit-identical to the spike's `restrict`.
///
/// Every operation is a pure function of its operands (`fill_filter::Interval` reads only the
/// test-build fault switch, which no call changes), so neither caching nor the call order can
/// change a bit. When a cubic's leaves are consecutive and cover it, every internal node is
/// split once: 2^d − 1 calls instead of d·2^d. It decides nothing.
struct Subdivision {
    /// The source controls of the cached root, compared by bits; `None` before the first leaf.
    source: Option<[Point; 4]>,
    root: [IPoint; 4],
    /// The cached path length: nodes at levels 1..=`levels` are valid.
    levels: usize,
    /// `keys[j]`: the prefix index of the cached node at level j + 1; its last bit chooses the
    /// half of the level-j node.
    keys: [u32; LEVELS],
    /// `children[j]`: both halves [left, right] of the cached level-j node, valid when
    /// `split[j]`.
    children: [[[IPoint; 4]; 2]; LEVELS],
    split: [bool; LEVELS + 1],
    /// `split_both` calls (a logical counter for the AL-U4b1 tests; decides nothing).
    #[cfg(test)]
    splits: u64,
}

impl Subdivision {
    fn new() -> Self {
        Self {
            source: None,
            root: [IPoint::default(); 4],
            levels: 0,
            keys: [0; LEVELS],
            children: [[[IPoint::default(); 4]; 2]; LEVELS],
            split: [false; LEVELS + 1],
            #[cfg(test)]
            splits: 0,
        }
    }

    fn node(&self, level: usize) -> [IPoint; 4] {
        if level == 0 {
            self.root
        } else {
            self.children[level - 1][(self.keys[level - 1] & 1) as usize]
        }
    }

    fn split_node(&mut self, level: usize) -> [[IPoint; 4]; 2] {
        #[cfg(test)]
        {
            self.splits += 1;
        }
        split_both(self.node(level))
    }

    /// The restricted controls of leaf n of depth d of `controls`: bit-identical to the
    /// spike's `restrict(controls, numerator, depth)` (see the type's comment).
    fn restrict(&mut self, controls: [Point; 4], numerator: u32, depth: u32) -> [IPoint; 4] {
        let cell = numerator - 1;
        let depth = depth as usize;
        if depth > LEVELS {
            // Unreachable: FR1 rejects a leaf deeper than `MAX_LEAF_DEPTH`. The uncached path,
            // the spike's loop, keeps the result defined without indexing past the cache.
            let mut points = controls.map(IPoint::exact);
            for bit in (0..depth).rev() {
                points = split_both(points)[((cell >> bit) & 1) as usize];
            }
            return points;
        }
        let same_source = self.source.is_some_and(|cached| {
            cached
                .iter()
                .zip(controls.iter())
                .all(|(left, right)| same_bits(*left, *right))
        });
        if !same_source {
            self.source = Some(controls);
            self.root = controls.map(IPoint::exact);
            self.levels = 0;
            self.split[0] = false;
        }
        // The longest cached prefix of this leaf's path. `keys[level]` is the cached node at
        // level + 1; this leaf's node there has prefix index cell >> (depth − level − 1).
        let mut level = 0;
        while level < depth
            && level < self.levels
            && self.keys[level] == cell >> (depth - level - 1)
        {
            level += 1;
        }
        if level < depth {
            // Nodes below `level` belong to another path; `split[level]` still describes the
            // kept node at `level`.
            self.levels = level;
            while level < depth {
                if !self.split[level] {
                    self.children[level] = self.split_node(level);
                    self.split[level] = true;
                }
                self.keys[level] = cell >> (depth - level - 1);
                level += 1;
                self.split[level] = false;
                self.levels = level;
            }
        }
        self.node(depth)
    }
}

/// Both halves of the interval de Casteljau split at 1/2: the six `midpoint` calls of the
/// spike's `split_half`, unchanged, returning [left, right] instead of the half `right` chose
/// (AL-U4b1, AL-C1).
fn split_both(points: [IPoint; 4]) -> [[IPoint; 4]; 2] {
    // AL-U4b1 (AL-C1): the one-point interval of 0.5, built once per split instead of once per
    // midpoint; `Interval::point` is a construction with no arithmetic.
    let half = Interval::point(0.5);
    let p01 = midpoint(points[0], points[1], half);
    let p12 = midpoint(points[1], points[2], half);
    let p23 = midpoint(points[2], points[3], half);
    let p012 = midpoint(p01, p12, half);
    let p123 = midpoint(p12, p23, half);
    let middle = midpoint(p012, p123, half);
    [
        [points[0], p01, p012, middle],
        [middle, p123, p23, points[3]],
    ]
}

fn midpoint(left: IPoint, right: IPoint, half: Interval) -> IPoint {
    left.add(right).mul(half)
}

/// AL-U4b1 equivalence hook: the restricted controls of each leaf `(controls, numerator,
/// depth)` in order, through one shared `Subdivision` as FR2 runs them, as the bits of
/// [x.lo, x.hi, y.lo, y.hi] per control, with the number of splits made.
#[cfg(test)]
pub(crate) fn shared_restrict_bits(leaves: &[([Point; 4], u32, u32)]) -> (Vec<[[u64; 4]; 4]>, u64) {
    let mut subdivision = Subdivision::new();
    let results = leaves
        .iter()
        .map(|&(controls, numerator, depth)| {
            subdivision
                .restrict(controls, numerator, depth)
                .map(|point| {
                    [
                        point.x.lo.to_bits(),
                        point.x.hi.to_bits(),
                        point.y.lo.to_bits(),
                        point.y.hi.to_bits(),
                    ]
                })
        })
        .collect();
    (results, subdivision.splits)
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
/// the comparator breaks ties itself, so the order is total. AL-U4b3 (AL-C4) makes it generic
/// over the item type, so that FR5 sorts keyed indices; the algorithm is unchanged.
fn merge_sort<T: Copy>(
    items: &mut [T],
    scratch: &mut [T],
    mut compare: impl FnMut(T, T) -> Ordering,
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

fn insert_edge(active: &mut [usize], length: &mut usize, edge: usize) -> Result<(), Reason> {
    if *length >= active.len() {
        return Err(Reason::Triangle);
    }
    active[*length] = edge;
    *length += 1;
    Ok(())
}

/// Removes `edge` from the status. E14-K3: each status entry shifted down is charged to `work`
/// first.
fn remove_edge(
    active: &mut [usize],
    length: &mut usize,
    edge: usize,
    work: &mut Work,
) -> Result<(), Reason> {
    let position = active[..*length]
        .iter()
        .position(|candidate| *candidate == edge)
        .ok_or(Reason::Triangle)?;
    for _ in position + 1..*length {
        work.charge()?;
    }
    active.copy_within(position + 1..*length, position);
    *length -= 1;
    Ok(())
}

/// Read-only sweep state for the status searches of FR7.
struct Sweep<'a> {
    vertices: &'a [Point],
    next: &'a [usize],
    rank: &'a [usize],
}

impl Sweep<'_> {
    /// The status edge directly left of `vertex`. Active edges are directed downward, so the
    /// vertex is east of edge (a, b) exactly when orient2d(a, b, vertex) > 0; the left-right
    /// order of two active edges is decided by orient2d of endpoints, valid because SL-T1
    /// makes all edges pairwise disjoint except at shared vertices. E14-K3: each status entry
    /// is charged to `work` before it is visited.
    fn left_edge(&self, vertex: usize, active: &[usize], work: &mut Work) -> Result<usize, Reason> {
        let point = self.vertices[vertex];
        let mut best: Option<usize> = None;
        for edge in active.iter().copied() {
            work.charge()?;
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
/// E14-K3: `diagonal_halves[diagonal_start[v]..diagonal_start[v + 1]]` are the diagonal
/// half-edges with origin v, in increasing half-edge order.
struct Graph<'a> {
    vertices: &'a [Point],
    next: &'a [usize],
    diagonals: &'a [(usize, usize)],
    count: usize,
    diagonal_start: &'a [usize],
    diagonal_halves: &'a [usize],
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

    /// The half-edge after `half` in its face. It considers w → next(w) and then the diagonal
    /// half-edges at w from the index, in the order today's scan over every diagonal met them
    /// (E14-K3), so the choice and every `TRIANGLE` error are today's. Each `consider` call is
    /// charged to `work` first.
    fn next_half(&self, half: usize, work: &mut Work) -> Result<usize, Reason> {
        let w = self.destination(half);
        let indexed = &self.diagonal_halves[self.diagonal_start[w]..self.diagonal_start[w + 1]];
        let result = self.select(half, indexed.iter().copied(), Some(work));
        #[cfg(test)]
        if NEXT_HALF_DIFFERENTIAL.with(core::cell::Cell::get) > 0 {
            assert_eq!(
                result,
                self.next_half_linear(half),
                "E14-D4: indexed and linear next_half differ at half-edge {half}"
            );
            NEXT_HALF_DIFFERENTIAL.with(|value| value.set(value.get() + 1));
        }
        result
    }

    /// Today's `next_half` before E14-K3: the scan over every diagonal (E14-D4 differential).
    #[cfg(test)]
    fn next_half_linear(&self, half: usize) -> Result<usize, Reason> {
        let w = self.destination(half);
        let candidates = self
            .diagonals
            .iter()
            .copied()
            .enumerate()
            .flat_map(|(index, (a, b))| {
                [
                    (a == w).then_some(self.count + 2 * index),
                    (b == w).then_some(self.count + 2 * index + 1),
                ]
            })
            .flatten();
        self.select(half, candidates, None)
    }

    /// The selection of `next_half`: `consider` on w → next(w), then on `candidates` in order.
    fn select(
        &self,
        half: usize,
        candidates: impl Iterator<Item = usize>,
        mut work: Option<&mut Work>,
    ) -> Result<usize, Reason> {
        let u = self.origin(half);
        let w = self.destination(half);
        let mut best: Option<(usize, u8)> = None;
        let mut consider = |candidate: usize| -> Result<(), Reason> {
            if let Some(work) = work.as_deref_mut() {
                work.charge()?;
            }
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
        for candidate in candidates {
            consider(candidate)?;
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
    /// holds AL-FR9's boundary records (`BATCH_INTERNAL_ERROR` otherwise): `scratch_records` is
    /// the scratch's reserved record count, and E14-K1 item 5 derives the records rung 0 needs
    /// from the workspace's fast contour point cap (`boundary_records`), so a pre-B1 ladder
    /// checks the pre-B1 count.
    pub(crate) fn reserve(scratch_records: usize, fast_contour_points: usize) -> Result<Self, u32> {
        if fast_contour_points > MAX_POINTS
            || boundary_records(fast_contour_points) > scratch_records
        {
            return Err(BATCH_INTERNAL_ERROR);
        }
        let mut storage: Vec<FastRung> = Vec::new();
        if storage.try_reserve_exact(1).is_err() {
            return Err(BATCH_ALLOCATION_FAILED);
        }
        storage.push(FastRung::reserve()?);
        let fast: Box<[FastRung; 1]> = storage
            .into_boxed_slice()
            .try_into()
            .map_err(|_| BATCH_INTERNAL_ERROR)?;
        Ok(Self { fast })
    }

    /// A ladder for tests that bring their own boundary scan: the check against the fill
    /// scratch passes by construction.
    #[cfg(test)]
    pub(crate) fn for_tests() -> Self {
        Self::reserve(MAX_BOUNDARY_RECORDS, MAX_POINTS).expect("ladder")
    }

    /// Bytes reserved by the ladder, for the reserve-time totals and `linearMemoryBytes()`.
    pub(crate) fn allocated_bytes(&self) -> usize {
        self.fast[0].allocated_bytes()
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
        // E14-K1 item 2: the prefix run over the workspace's fast caps.
        let command_capacity = workspace.fast_flat_commands();
        match workspace.prepare_prefix(input, command_capacity) {
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
