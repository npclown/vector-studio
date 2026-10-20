//! P3 B2 stroke front end for line strokes, unit ST-U3.
//!
//! The frozen contract is `docs/plans/p3-b2-stroke-contract.md`. This module decodes a path
//! into subpaths and remaining drawing segments (ST-S1, ST-S2), emits the outline pieces of
//! section 4.2 as positively oriented convex polygons in the order of section 4.9, and resolves
//! their union with the unchanged `RoundedFillWorkspace` under nonzero at `tau = 2^(e-2)`,
//! followed by V2's unchanged refinement and boundary checks (`FillScratch`). It has no export
//! yet (ST-U5) and no cubic support yet (ST-U4): a cubic that is not zero-length is the
//! unit-local `UnsupportedCubic` until ST-U4 replaces it.
//!
//! Arithmetic (section 4.2): binary64 `+ - * /` and `sqrt` only, plus exact `Signed`
//! predicates and exact `orient2d`. No `sin`, `cos`, `atan2`, `hypot`, `mul_add` or `pow`.

use core::cmp::Ordering;
use core::mem::size_of;

use crate::codec::{PathInput, Request};
use crate::engine::{BATCH_ALLOCATION_FAILED, BATCH_INTERNAL_ERROR};
use crate::fill_exact::{multiply, Signed, COORDINATE_LIMBS, LINE_LIMBS};
use crate::fill_export::{FillScratch, Mapped, SelfCheckFailure};
use crate::fill_predicates::orient2d;
use crate::geometry::{validate_path, Point, VERB_CLOSE, VERB_CUBIC, VERB_LINE, VERB_MOVE};
use crate::line_fill::LineFillRule;
use crate::rounded_line_fill::{RoundedFillError, RoundedFillLimits, RoundedFillWorkspace};

/// Section 7.2 path statuses. ST-U5 publishes them through `stroke_v0_*`.
pub(crate) const STROKE_PATH_OK: u32 = 0;
pub(crate) const STROKE_PATH_EMPTY: u32 = 1;
pub(crate) const STROKE_PATH_INVALID_PATH: u32 = 2;
pub(crate) const STROKE_PATH_INVALID_TOLERANCE: u32 = 3;
pub(crate) const STROKE_PATH_NUMERIC_RANGE: u32 = 4;
pub(crate) const STROKE_PATH_WORK_LIMIT: u32 = 5;
pub(crate) const STROKE_PATH_UNSUPPORTED_GEOMETRY: u32 = 6;
pub(crate) const STROKE_PATH_INVALID_STROKE: u32 = 7;

/// Section 7.7 accepted tolerance exponents.
pub(crate) const STROKE_MIN_TOLERANCE_EXPONENT: i32 = -1020;
pub(crate) const STROKE_MAX_TOLERANCE_EXPONENT: i32 = 1023;

/// Section 7.6 front-end limits.
pub(crate) const MAX_SOURCE_VERBS: usize = 1_024;
pub(crate) const MAX_SOURCE_SCALARS: usize = 6_144;
pub(crate) const MAX_SEGMENTS: usize = 512;
pub(crate) const MAX_SUBPATHS: usize = 256;
pub(crate) const MAX_PIECES: usize = 512;
pub(crate) const MAX_DISK_VERTICES: usize = 256;
/// Largest bisection level `k` (`n = 2^(k+2)`, section 4.4).
pub(crate) const MAX_DISK_LEVEL: u32 = 6;
/// Piece records including dropped hulls: caps (2 per subpath), sweeps, joins, point caps.
const MAX_PIECE_RECORDS: usize = 2 * MAX_SUBPATHS + 2 * MAX_SEGMENTS + MAX_SUBPATHS;
/// Section 7.5 combined stroke heap cap.
pub(crate) const STROKE_V0_HEAP_CAP: usize = 48 * 1024 * 1024;

/// Section 7.6 `STROKE_V0_LIMITS`.
pub(crate) const STROKE_V0_LIMITS: RoundedFillLimits = RoundedFillLimits {
    max_contours: 512,
    max_input_vertices: 1_024,
    max_edges: 1_024,
    max_pairs: 523_776,
    max_events: 4_096,
    max_sections: 262_144,
    max_nodes: 8_192,
    max_cells: 8_192,
    max_boundaries: 16_384,
    max_contributors: 16_384,
    max_vertices: 8_192,
    max_triangles: 8_192,
    max_work: 64_000_000,
    max_bytes: 32 * 1024 * 1024,
};

/// Width of the exact miter predicate (section 4.3): every term has degree at most 8 in
/// binary64 inputs, each of which needs `COORDINATE_LIMBS` limbs.
pub(crate) const PREDICATE_LIMBS: usize = 266;
const _: () = assert!(PREDICATE_LIMBS >= 8 * COORDINATE_LIMBS + 2);
const PRODUCT_LIMBS: usize = 2 * LINE_LIMBS;
const _: () = assert!(PRODUCT_LIMBS >= 4 * COORDINATE_LIMBS);

const UNIT: f64 = 1.0 / 9_007_199_254_740_992.0; // 2^-53
/// `C_ARC > pi^2 / 2` (section 4.4).
const C_ARC: f64 = 4.934_802_3;
const SLACK_DOWN: f64 = 1.0 - 1.0 / 1_099_511_627_776.0; // 1 - 2^-40
/// ST-G3 tightening (ST-U3 proof, see the plan entry): a kept miter needs `L <= 2^24`.
const MAX_GUARDED_MITER_LIMIT: f64 = 16_777_216.0;
/// Quadrant-I directions at level 6: 65 entries from `(1, 0)` to `(0, 1)`.
const DIRECTION_COUNT: usize = (1 << MAX_DISK_LEVEL) + 1;
/// Candidate points of one piece: a 256-gon plus three extra points.
const MAX_CANDIDATES: usize = MAX_DISK_VERTICES + 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StrokeCap {
    Butt,
    Round,
    Square,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StrokeJoin {
    Miter,
    Round,
    Bevel,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct StrokeRequest {
    pub(crate) request_id: u32,
    pub(crate) width: f64,
    pub(crate) cap: StrokeCap,
    pub(crate) join: StrokeJoin,
    pub(crate) miter_limit: f64,
    pub(crate) exponent: i32,
}

/// Front-end failures (section 7.8 mapping table).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FrontEndError {
    SourceLimit,
    SegmentLimit,
    SubpathLimit,
    /// Leaf depth (ST-U4); unused by line strokes.
    DepthLimit,
    PieceLimit,
    DiskLimit,
    /// ST-G1 to ST-G6.
    NumericRange,
    /// ST-U3 only: a cubic that is not zero-length, until ST-U4 lands.
    UnsupportedCubic,
    /// A front-end invariant failure.
    Invariant,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StrokeError {
    Front(FrontEndError),
    Rounded(RoundedFillError),
}

/// Section 7.8 mapping of a front-end value. One exhaustive match, no wildcard.
pub(crate) fn map_front_end_error(error: FrontEndError) -> Mapped {
    match error {
        FrontEndError::SourceLimit
        | FrontEndError::SegmentLimit
        | FrontEndError::SubpathLimit
        | FrontEndError::DepthLimit
        | FrontEndError::PieceLimit
        | FrontEndError::DiskLimit => Mapped::Path(STROKE_PATH_WORK_LIMIT),
        FrontEndError::NumericRange => Mapped::Path(STROKE_PATH_NUMERIC_RANGE),
        FrontEndError::UnsupportedCubic => Mapped::Path(STROKE_PATH_UNSUPPORTED_GEOMETRY),
        FrontEndError::Invariant => Mapped::Internal,
    }
}

/// Section 7.8 mapping of an arrangement value during `process`. Exhaustive, no wildcard.
pub(crate) fn map_rounded_error(error: RoundedFillError) -> Mapped {
    match error {
        RoundedFillError::InputLimit
        | RoundedFillError::EdgeLimit
        | RoundedFillError::PairLimit
        | RoundedFillError::EventLimit
        | RoundedFillError::SectionLimit
        | RoundedFillError::NodeLimit
        | RoundedFillError::CellLimit
        | RoundedFillError::BoundaryLimit
        | RoundedFillError::ContributorLimit
        | RoundedFillError::WorkLimit
        | RoundedFillError::OutputLimit => Mapped::Path(STROKE_PATH_WORK_LIMIT),
        RoundedFillError::TopologyAmbiguous => Mapped::Path(STROKE_PATH_UNSUPPORTED_GEOMETRY),
        RoundedFillError::InvalidTolerance => Mapped::Path(STROKE_PATH_INVALID_TOLERANCE),
        RoundedFillError::InvalidInput
        | RoundedFillError::InternalInvariant
        | RoundedFillError::InvalidLimits
        | RoundedFillError::AllocationFailed
        | RoundedFillError::ByteLimit => Mapped::Internal,
    }
}

/// Section 7.5: workspace construction failure at reserve.
pub(crate) fn construction_status(error: RoundedFillError) -> u32 {
    match error {
        RoundedFillError::AllocationFailed => BATCH_ALLOCATION_FAILED,
        RoundedFillError::InvalidLimits
        | RoundedFillError::ByteLimit
        | RoundedFillError::InputLimit
        | RoundedFillError::InvalidInput
        | RoundedFillError::InvalidTolerance
        | RoundedFillError::EdgeLimit
        | RoundedFillError::PairLimit
        | RoundedFillError::EventLimit
        | RoundedFillError::SectionLimit
        | RoundedFillError::NodeLimit
        | RoundedFillError::CellLimit
        | RoundedFillError::BoundaryLimit
        | RoundedFillError::ContributorLimit
        | RoundedFillError::WorkLimit
        | RoundedFillError::OutputLimit
        | RoundedFillError::TopologyAmbiguous
        | RoundedFillError::InternalInvariant => BATCH_INTERNAL_ERROR,
    }
}

/// `2^k` for `-1074 <= k <= 1023`, built from the exponent bits.
pub(crate) fn power_of_two(k: i32) -> f64 {
    debug_assert!((-1074..=1023).contains(&k));
    if k >= -1022 {
        f64::from_bits(((k + 1023) as u64) << 52)
    } else {
        f64::from_bits(1u64 << (k + 1074))
    }
}

/// Published mesh: vertices, triangle indices and boundary pairs.
pub(crate) type MeshView<'a> = (&'a [Point], &'a [u32], &'a [[u32; 2]]);

/// One canonical sample triple `(E-, C, E+)` (section 4.2).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Triple {
    pub(crate) minus: Point,
    pub(crate) center: Point,
    pub(crate) plus: Point,
}

/// A remaining drawing segment. For a line both tangents are `b - a`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Segment {
    pub(crate) subpath: usize,
    /// Source verb ordinal: the LINE, or the CLOSE of a closing line.
    pub(crate) verb: usize,
    pub(crate) a: Point,
    pub(crate) b: Point,
    /// `n(d)`, the Float64 unit direction of the rounded tangent.
    pub(crate) unit: Point,
    pub(crate) start: Triple,
    pub(crate) end: Triple,
    /// The source join that follows this segment inside its subpath, if any.
    pub(crate) join_after: Option<JoinDecision>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Subpath {
    pub(crate) first_segment: usize,
    pub(crate) segment_count: usize,
    pub(crate) closed: bool,
    /// Whether the subpath had a drawing verb (for ST-S10).
    pub(crate) had_drawing: bool,
    pub(crate) start_point_index: usize,
}

/// Exact classification of a source join (sections 2.3 and 4.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum JoinClass {
    /// `cross > 0`: the outer side is the right side `E-`.
    TurnLeft,
    /// `cross < 0`: the outer side is the left side `E+`.
    TurnRight,
    Continuation,
    Reversal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct JoinDecision {
    pub(crate) class: JoinClass,
    /// The outgoing segment index.
    pub(crate) next: usize,
    /// Whether this is the seam of a closed subpath.
    pub(crate) seam: bool,
}

/// Piece kinds of section 4.2.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PieceKind {
    LineSweep,
    Bevel,
    Miter,
    RoundJoin,
    RoundCap,
    SquareCap,
    PointRound,
    PointSquare,
}

impl PieceKind {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::LineSweep => "line-sweep",
            Self::Bevel => "bevel",
            Self::Miter => "miter",
            Self::RoundJoin => "round-join",
            Self::RoundCap => "round-cap",
            Self::SquareCap => "square-cap",
            Self::PointRound => "point-round",
            Self::PointSquare => "point-square",
        }
    }
}

/// One emitted piece: a contour of the arrangement.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Piece {
    pub(crate) kind: PieceKind,
    /// The source segment (the incoming one for a join), or the subpath for ST-P7.
    pub(crate) segment: usize,
    /// Parameter interval of the segment (`[0, 1]` for lines; the end parameter for a cap).
    pub(crate) t0: f64,
    pub(crate) t1: f64,
    pub(crate) start: usize,
    pub(crate) count: usize,
    /// Disk polygon vertex count for round pieces, else 0.
    pub(crate) disk_vertices: usize,
    /// A zero-area hull, dropped from the arrangement and kept only in this record.
    pub(crate) dropped: bool,
    /// Joins: `[O_in, O_out, T]` (the tip only on a miter). Square caps: `[E- + r t, E+ + r t]`.
    pub(crate) extra: [Point; 3],
    pub(crate) extra_count: usize,
}

/// Per-path outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StrokeOutcome {
    /// A non-`OK` path status.
    Status(u32),
    /// `OK`: the arrangement holds the vertices, the scratch the refined mesh.
    Mesh,
}

/// Test-only seeded defects of section 11.3 assigned to ST-U3. Outside test builds the type is
/// empty and every switch is constant `false`.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct StrokeDefects {
    /// ST-D1: miter decided by a Float64 comparison with an epsilon.
    #[cfg(test)]
    pub(crate) float_miter: bool,
    /// ST-D2: equality treated as bevel.
    #[cfg(test)]
    pub(crate) equality_bevel: bool,
    /// ST-D3: forward-continuation triple not shared.
    #[cfg(test)]
    pub(crate) unshared_continuation: bool,
    /// ST-D4: implicit fill closing edge stroked.
    #[cfg(test)]
    pub(crate) stroke_implicit_close: bool,
    /// ST-D5: zero-length segments kept for tangents.
    #[cfg(test)]
    pub(crate) keep_zero_length: bool,
    /// ST-D9: disk count `n` halved.
    #[cfg(test)]
    pub(crate) halve_disk: bool,
    /// ST-D10: square cap along the normal instead of the tangent.
    #[cfg(test)]
    pub(crate) square_along_normal: bool,
    /// ST-D11: reversal treated as a miter turn.
    #[cfg(test)]
    pub(crate) reversal_as_turn: bool,
    /// ST-D12: arrangement tolerance `2^(e-1)`.
    #[cfg(test)]
    pub(crate) fill_tolerance: bool,
    /// ST-D13: a piece emitted clockwise (the sweep of every odd segment).
    #[cfg(test)]
    pub(crate) clockwise_piece: bool,
    /// ST-D14: tip guard ST-G3 skipped.
    #[cfg(test)]
    pub(crate) skip_tip_guard: bool,
}

#[cfg(test)]
macro_rules! defect {
    ($name:ident) => {
        #[cfg(test)]
        fn $name(self) -> bool {
            self.$name
        }
    };
}

#[cfg(test)]
impl StrokeDefects {
    defect!(float_miter);
    defect!(equality_bevel);
    defect!(unshared_continuation);
    defect!(stroke_implicit_close);
    defect!(keep_zero_length);
    defect!(halve_disk);
    defect!(square_along_normal);
    defect!(reversal_as_turn);
    defect!(fill_tolerance);
    defect!(clockwise_piece);
    defect!(skip_tip_guard);
}

#[cfg(not(test))]
impl StrokeDefects {
    #[inline(always)]
    fn float_miter(self) -> bool {
        false
    }
    #[inline(always)]
    fn equality_bevel(self) -> bool {
        false
    }
    #[inline(always)]
    fn unshared_continuation(self) -> bool {
        false
    }
    #[inline(always)]
    fn stroke_implicit_close(self) -> bool {
        false
    }
    #[inline(always)]
    fn keep_zero_length(self) -> bool {
        false
    }
    #[inline(always)]
    fn halve_disk(self) -> bool {
        false
    }
    #[inline(always)]
    fn square_along_normal(self) -> bool {
        false
    }
    #[inline(always)]
    fn reversal_as_turn(self) -> bool {
        false
    }
    #[inline(always)]
    fn fill_tolerance(self) -> bool {
        false
    }
    #[inline(always)]
    fn clockwise_piece(self) -> bool {
        false
    }
    #[inline(always)]
    fn skip_tip_guard(self) -> bool {
        false
    }
}

/// Tolerances of one request (section 3), built from exponent bits.
#[derive(Clone, Copy, Debug)]
struct Tolerances {
    /// `2^(e-1)`, the ST-G3 requirement.
    half: f64,
    /// `2^(e-2)`, the arc share and the arrangement tolerance.
    quarter: f64,
    /// `2^(e-4)`, the ST-G1 requirement.
    sixteenth: f64,
}

impl Tolerances {
    fn new(exponent: i32) -> Self {
        Self {
            half: power_of_two(exponent - 1),
            quarter: power_of_two(exponent - 2),
            sixteenth: power_of_two(exponent - 4),
        }
    }
}

/// The stroke front end plus the reused arrangement and refinement storage, all reserved once.
pub(crate) struct StrokeWorkspace {
    subpaths: Vec<Subpath>,
    segments: Vec<Segment>,
    source: Vec<Point>,
    pieces: Vec<Piece>,
    piece_points: Vec<Point>,
    candidates: Vec<Point>,
    hull: Vec<Point>,
    directions: [Point; DIRECTION_COUNT],
    /// Emitted vertices, counted also beyond the stored ones (arrangement preflight).
    vertex_total: usize,
    /// Emitted (not dropped) pieces.
    emitted: usize,
    extra: [Point; 3],
    extra_count: usize,
    rounded: RoundedFillWorkspace,
    scratch: FillScratch,
    front_bytes: usize,
    scratch_bytes: usize,
    defects: StrokeDefects,
    #[cfg(test)]
    last_tau: Option<f64>,
}

fn reserve<T>(capacity: usize) -> Result<Vec<T>, u32> {
    let mut buffer = Vec::new();
    buffer
        .try_reserve_exact(capacity)
        .map_err(|_| BATCH_ALLOCATION_FAILED)?;
    Ok(buffer)
}

impl StrokeWorkspace {
    /// Reserves every buffer from `STROKE_V0_LIMITS`; `Err(batch status)` on refusal.
    pub(crate) fn new() -> Result<Self, u32> {
        let rounded = RoundedFillWorkspace::new(STROKE_V0_LIMITS).map_err(construction_status)?;
        let (scratch, scratch_bytes) = FillScratch::reserve(STROKE_V0_LIMITS)?;
        let mut workspace = Self {
            subpaths: reserve(MAX_SUBPATHS)?,
            segments: reserve(MAX_SEGMENTS)?,
            source: reserve(MAX_SOURCE_SCALARS / 2)?,
            pieces: reserve(MAX_PIECE_RECORDS)?,
            piece_points: reserve(STROKE_V0_LIMITS.max_input_vertices)?,
            candidates: reserve(MAX_CANDIDATES)?,
            hull: reserve(2 * MAX_CANDIDATES + 1)?,
            directions: build_directions(),
            vertex_total: 0,
            emitted: 0,
            extra: [Point::default(); 3],
            extra_count: 0,
            rounded,
            scratch,
            front_bytes: 0,
            scratch_bytes,
            defects: StrokeDefects::default(),
            #[cfg(test)]
            last_tau: None,
        };
        workspace.front_bytes = [
            workspace.subpaths.capacity() * size_of::<Subpath>(),
            workspace.segments.capacity() * size_of::<Segment>(),
            workspace.source.capacity() * size_of::<Point>(),
            workspace.pieces.capacity() * size_of::<Piece>(),
            workspace.piece_points.capacity() * size_of::<Point>(),
            workspace.candidates.capacity() * size_of::<Point>(),
            workspace.hull.capacity() * size_of::<Point>(),
        ]
        .into_iter()
        .try_fold(0usize, usize::checked_add)
        .ok_or(BATCH_INTERNAL_ERROR)?;
        let total = workspace.allocated_bytes().ok_or(BATCH_INTERNAL_ERROR)?;
        if total > STROKE_V0_HEAP_CAP {
            return Err(BATCH_INTERNAL_ERROR);
        }
        Ok(workspace)
    }

    /// Bytes of the front end, the arrangement workspace and the scratch.
    pub(crate) fn allocated_bytes(&self) -> Option<usize> {
        self.front_bytes
            .checked_add(self.rounded.allocated_bytes())?
            .checked_add(self.scratch_bytes)
    }

    /// `(front end, RoundedFillWorkspace, FillScratch)` bytes.
    pub(crate) fn byte_parts(&self) -> (usize, usize, usize) {
        (
            self.front_bytes,
            self.rounded.allocated_bytes(),
            self.scratch_bytes,
        )
    }

    pub(crate) fn segments(&self) -> &[Segment] {
        &self.segments
    }

    pub(crate) fn subpaths(&self) -> &[Subpath] {
        &self.subpaths
    }

    pub(crate) fn pieces(&self) -> &[Piece] {
        &self.pieces
    }

    pub(crate) fn piece_points(&self, piece: &Piece) -> &[Point] {
        &self.piece_points[piece.start..piece.start + piece.count]
    }

    /// The published mesh vertices, triangles and boundary pairs after `Mesh`.
    pub(crate) fn mesh(&self) -> Option<MeshView<'_>> {
        let output = self.rounded.output()?;
        Some((
            output.vertices,
            self.scratch.triangles(),
            self.scratch.boundary(),
        ))
    }

    #[cfg(test)]
    pub(crate) fn defects_mut(&mut self) -> &mut StrokeDefects {
        &mut self.defects
    }

    #[cfg(test)]
    pub(crate) fn last_tau(&self) -> Option<f64> {
        self.last_tau
    }

    #[cfg(test)]
    pub(crate) fn rounded_stats(&self) -> crate::rounded_line_fill::RoundedFillStats {
        self.rounded.stats()
    }

    fn reset(&mut self) {
        self.subpaths.clear();
        self.segments.clear();
        self.source.clear();
        self.pieces.clear();
        self.piece_points.clear();
        self.candidates.clear();
        self.hull.clear();
        self.vertex_total = 0;
        self.emitted = 0;
        self.extra_count = 0;
        #[cfg(test)]
        {
            self.last_tau = None;
        }
    }

    /// Runs the per-path stage order of section 7.8 for one path. `Err` is a batch
    /// `internal-error`.
    pub(crate) fn build(
        &mut self,
        request: StrokeRequest,
        verbs: &[u8],
        point_bytes: &[u8],
    ) -> Result<StrokeOutcome, SelfCheckFailure> {
        self.reset();
        let input = PathInput::from_parts(
            Request {
                request_id: request.request_id,
                source_epoch: 0,
                source_revision: 0,
                tolerance: 0.0,
            },
            verbs,
            point_bytes,
        );
        // 1. Grammar and values.
        if validate_path(input).is_err() {
            return Ok(StrokeOutcome::Status(STROKE_PATH_INVALID_PATH));
        }
        // 2. Stroke values.
        let width_valid = request.width.is_finite() && request.width >= 0.0;
        let limit_valid = request.miter_limit.is_finite() && request.miter_limit >= 1.0;
        if !width_valid || !limit_valid {
            return Ok(StrokeOutcome::Status(STROKE_PATH_INVALID_STROKE));
        }
        // 3. Tolerance range.
        if !(STROKE_MIN_TOLERANCE_EXPONENT..=STROKE_MAX_TOLERANCE_EXPONENT)
            .contains(&request.exponent)
        {
            return Ok(StrokeOutcome::Status(STROKE_PATH_INVALID_TOLERANCE));
        }
        // 4. Empty.
        if verbs.is_empty() || request.width == 0.0 {
            return Ok(StrokeOutcome::Status(STROKE_PATH_EMPTY));
        }
        let tolerances = Tolerances::new(request.exponent);
        // 5. Front end.
        match self.front_end(request, input, tolerances) {
            Ok(()) => {}
            Err(error) => {
                let mapped = match error {
                    StrokeError::Front(error) => map_front_end_error(error),
                    StrokeError::Rounded(error) => map_rounded_error(error),
                };
                return match mapped {
                    Mapped::Path(status) => Ok(StrokeOutcome::Status(status)),
                    Mapped::Internal => Err(SelfCheckFailure),
                };
            }
        }
        if self.emitted == 0 {
            // Every piece dropped (ST-S9, butt ST-S10, collapse): no arrangement call.
            return Ok(StrokeOutcome::Status(STROKE_PATH_EMPTY));
        }
        // 6. Arrangement under nonzero at tau = 2^(e-2) (ST-D12 seeds 2^(e-1)).
        let tau = if self.defects.fill_tolerance() {
            tolerances.half
        } else {
            tolerances.quarter
        };
        #[cfg(test)]
        {
            self.last_tau = Some(tau);
        }
        let mut references: [&[Point]; MAX_PIECES] = [&[]; MAX_PIECES];
        let mut contours = 0usize;
        for piece in self.pieces.iter().filter(|piece| !piece.dropped) {
            references[contours] = &self.piece_points[piece.start..piece.start + piece.count];
            contours += 1;
        }
        if let Err(error) =
            self.rounded
                .tessellate(&references[..contours], LineFillRule::Nonzero, tau)
        {
            return match map_rounded_error(error) {
                Mapped::Path(status) => Ok(StrokeOutcome::Status(status)),
                Mapped::Internal => Err(SelfCheckFailure),
            };
        }
        // 7. Refinement and boundary (V2 section f), unchanged.
        let output = self.rounded.output().ok_or(SelfCheckFailure)?;
        self.scratch.refine(&output)?;
        // 8. Empty region.
        if self.scratch.triangles().is_empty() {
            return if output.vertices.is_empty() && self.scratch.boundary().is_empty() {
                Ok(StrokeOutcome::Status(STROKE_PATH_EMPTY))
            } else {
                Err(SelfCheckFailure)
            };
        }
        Ok(StrokeOutcome::Mesh)
    }

    fn front_end(
        &mut self,
        request: StrokeRequest,
        input: PathInput<'_>,
        tolerances: Tolerances,
    ) -> Result<(), StrokeError> {
        if input.verbs.len() > MAX_SOURCE_VERBS || input.point_count() > MAX_SOURCE_SCALARS {
            return Err(StrokeError::Front(FrontEndError::SourceLimit));
        }
        self.decode(input).map_err(StrokeError::Front)?;
        let r = request.width * 0.5;
        let emits_points = request.cap != StrokeCap::Butt
            && self.subpaths.iter().any(|subpath| {
                !subpath.closed && subpath.segment_count == 0 && subpath.had_drawing
            });
        if self.segments.is_empty() && !emits_points {
            return Ok(());
        }
        // ST-G1 on the path's largest source coordinate magnitude.
        let magnitude = self
            .source
            .iter()
            .fold(0.0f64, |m, point| m.max(point.x.abs()).max(point.y.abs()));
        let g_off = 16.0 * UNIT * (magnitude + r);
        // Every input is finite, so g_off is finite or +infinity, never NaN.
        if g_off > tolerances.sixteenth {
            return Err(StrokeError::Front(FrontEndError::NumericRange));
        }
        self.build_triples(r).map_err(StrokeError::Front)?;
        self.classify_joins().map_err(StrokeError::Front)?;
        self.emit(request, r, tolerances)
            .map_err(StrokeError::Front)?;
        if self.vertex_total > STROKE_V0_LIMITS.max_input_vertices {
            // The arrangement's own preflight result, after every front-end stage.
            return Err(StrokeError::Rounded(RoundedFillError::InputLimit));
        }
        Ok(())
    }

    /// ST-S1: subpaths and remaining drawing segments.
    fn decode(&mut self, input: PathInput<'_>) -> Result<(), FrontEndError> {
        let read = |index: usize| -> Result<Point, FrontEndError> {
            Ok(Point {
                x: input.point(index).ok_or(FrontEndError::Invariant)?,
                y: input.point(index + 1).ok_or(FrontEndError::Invariant)?,
            })
        };
        let mut scalar = 0usize;
        let mut current = Point::default();
        let mut start = Point::default();
        let mut open = false;
        let keep_zero = self.defects.keep_zero_length();
        for (ordinal, verb) in input.verbs.iter().copied().enumerate() {
            match verb {
                VERB_MOVE => {
                    if open {
                        self.finish_subpath(false, start, current, usize::MAX)?;
                    }
                    if self.subpaths.len() >= MAX_SUBPATHS {
                        return Err(FrontEndError::SubpathLimit);
                    }
                    current = read(scalar)?;
                    scalar += 2;
                    start = current;
                    self.push_source(current)?;
                    self.subpaths.push(Subpath {
                        first_segment: self.segments.len(),
                        segment_count: 0,
                        closed: false,
                        had_drawing: false,
                        start_point_index: self.source.len() - 1,
                    });
                    open = true;
                }
                VERB_LINE => {
                    let next = read(scalar)?;
                    scalar += 2;
                    self.push_source(next)?;
                    self.mark_drawing()?;
                    if keep_zero || !same(current, next) {
                        self.push_segment(current, next, ordinal)?;
                    }
                    current = next;
                }
                VERB_CUBIC => {
                    let p1 = read(scalar)?;
                    let p2 = read(scalar + 2)?;
                    let p3 = read(scalar + 4)?;
                    scalar += 6;
                    self.push_source(p1)?;
                    self.push_source(p2)?;
                    self.push_source(p3)?;
                    self.mark_drawing()?;
                    if !(same(current, p1) && same(current, p2) && same(current, p3)) {
                        return Err(FrontEndError::UnsupportedCubic);
                    }
                    current = p3;
                }
                VERB_CLOSE => {
                    self.finish_subpath(true, start, current, ordinal)?;
                    current = start;
                    open = false;
                }
                _ => return Err(FrontEndError::Invariant),
            }
        }
        if open {
            self.finish_subpath(false, start, current, usize::MAX)?;
        }
        Ok(())
    }

    fn push_source(&mut self, point: Point) -> Result<(), FrontEndError> {
        if self.source.len() >= self.source.capacity() {
            return Err(FrontEndError::SourceLimit);
        }
        self.source.push(point);
        Ok(())
    }

    fn mark_drawing(&mut self) -> Result<(), FrontEndError> {
        self.subpaths
            .last_mut()
            .ok_or(FrontEndError::Invariant)?
            .had_drawing = true;
        Ok(())
    }

    fn push_segment(&mut self, a: Point, b: Point, verb: usize) -> Result<(), FrontEndError> {
        if self.segments.len() >= MAX_SEGMENTS {
            return Err(FrontEndError::SegmentLimit);
        }
        let subpath = self
            .subpaths
            .len()
            .checked_sub(1)
            .ok_or(FrontEndError::Invariant)?;
        self.segments.push(Segment {
            subpath,
            verb,
            a,
            b,
            ..Segment::default()
        });
        self.subpaths[subpath].segment_count += 1;
        Ok(())
    }

    fn finish_subpath(
        &mut self,
        closed: bool,
        start: Point,
        current: Point,
        close_verb: usize,
    ) -> Result<(), FrontEndError> {
        let close_line = closed || self.defects.stroke_implicit_close();
        if close_line && !same(current, start) {
            self.mark_drawing()?;
            self.push_segment(current, start, close_verb)?;
        }
        self.subpaths
            .last_mut()
            .ok_or(FrontEndError::Invariant)?
            .closed = closed;
        Ok(())
    }

    /// ST-S2 and section 4.2: unit directions and canonical sample triples.
    fn build_triples(&mut self, r: f64) -> Result<(), FrontEndError> {
        for segment in &mut self.segments {
            let direction = Point {
                x: segment.b.x - segment.a.x,
                y: segment.b.y - segment.a.y,
            };
            let unit = unit_vector(direction)?;
            segment.unit = unit;
            let offset = Point {
                x: r * -unit.y,
                y: r * unit.x,
            };
            segment.start = triple(segment.a, offset);
            segment.end = triple(segment.b, offset);
        }
        Ok(())
    }

    /// Exact join classification, and the continuation triple sharing of section 4.2.
    fn classify_joins(&mut self) -> Result<(), FrontEndError> {
        let share = !self.defects.unshared_continuation();
        for subpath_index in 0..self.subpaths.len() {
            let subpath = self.subpaths[subpath_index];
            let count = subpath.segment_count;
            if count == 0 {
                continue;
            }
            let joins = if subpath.closed { count } else { count - 1 };
            for offset in 0..joins {
                let incoming = subpath.first_segment + offset;
                let outgoing = subpath.first_segment + (offset + 1) % count;
                let class = classify(self.segments[incoming], self.segments[outgoing]);
                if class == JoinClass::Continuation && share {
                    self.segments[outgoing].start = self.segments[incoming].end;
                }
                self.segments[incoming].join_after = Some(JoinDecision {
                    class,
                    next: outgoing,
                    seam: offset + 1 == count,
                });
            }
        }
        Ok(())
    }

    /// Section 4.9 emission order.
    fn emit(
        &mut self,
        request: StrokeRequest,
        r: f64,
        tolerances: Tolerances,
    ) -> Result<(), FrontEndError> {
        for subpath_index in 0..self.subpaths.len() {
            let subpath = self.subpaths[subpath_index];
            if subpath.segment_count == 0 {
                if !subpath.closed && subpath.had_drawing {
                    let point = self.source[subpath.start_point_index];
                    self.emit_point(request.cap, point, r, subpath_index, tolerances)?;
                }
                continue;
            }
            let first = subpath.first_segment;
            let last = first + subpath.segment_count - 1;
            if !subpath.closed {
                self.emit_cap(request.cap, first, false, r, tolerances)?;
            }
            for index in first..=last {
                self.emit_sweep(index)?;
                if let Some(join) = self.segments[index].join_after {
                    self.emit_join(request, index, join, r, tolerances)?;
                }
            }
            if !subpath.closed {
                self.emit_cap(request.cap, last, true, r, tolerances)?;
            }
        }
        Ok(())
    }

    fn emit_sweep(&mut self, index: usize) -> Result<(), FrontEndError> {
        let segment = self.segments[index];
        self.candidates.clear();
        for point in [
            segment.start.minus,
            segment.start.center,
            segment.start.plus,
            segment.end.minus,
            segment.end.center,
            segment.end.plus,
        ] {
            self.push_candidate(point)?;
        }
        let emitted = self.emit_hull(PieceKind::LineSweep, index, 0.0, 1.0, 0)?;
        if emitted && self.defects.clockwise_piece() && index % 2 == 1 {
            if let Some(piece) = self.pieces.last() {
                let (start, count) = (piece.start, piece.count);
                let stored = self.piece_points.len();
                if start + count <= stored {
                    self.piece_points[start..start + count].reverse();
                }
            }
        }
        Ok(())
    }

    fn emit_join(
        &mut self,
        request: StrokeRequest,
        index: usize,
        join: JoinDecision,
        r: f64,
        tolerances: Tolerances,
    ) -> Result<(), FrontEndError> {
        let incoming = self.segments[index];
        let outgoing = self.segments[join.next];
        let center = incoming.end.center;
        // ST-D11 seeds a reversal treated as a kept miter turn.
        let forced = join.class == JoinClass::Reversal
            && self.defects.reversal_as_turn()
            && request.join == StrokeJoin::Miter;
        let class = if forced {
            JoinClass::TurnLeft
        } else {
            join.class
        };
        match class {
            JoinClass::Continuation => Ok(()),
            JoinClass::Reversal => {
                if request.join != StrokeJoin::Round {
                    return Ok(());
                }
                self.candidates.clear();
                self.push_disk(center, r, tolerances)?;
                let disk = self.candidates.len();
                for point in [center, incoming.end.minus, incoming.end.plus] {
                    self.push_candidate(point)?;
                }
                self.set_extra(&[incoming.end.minus, incoming.end.plus]);
                self.emit_hull(PieceKind::RoundJoin, index, 1.0, 1.0, disk)
                    .map(|_| ())
            }
            JoinClass::TurnLeft | JoinClass::TurnRight => {
                let right = class == JoinClass::TurnLeft;
                let (o_in, o_out) = if right {
                    (incoming.end.minus, outgoing.start.minus)
                } else {
                    (incoming.end.plus, outgoing.start.plus)
                };
                match request.join {
                    StrokeJoin::Bevel => self.emit_bevel(index, center, o_in, o_out),
                    StrokeJoin::Round => {
                        self.candidates.clear();
                        self.push_disk(center, r, tolerances)?;
                        let disk = self.candidates.len();
                        for point in [center, o_in, o_out] {
                            self.push_candidate(point)?;
                        }
                        self.set_extra(&[o_in, o_out]);
                        self.emit_hull(PieceKind::RoundJoin, index, 1.0, 1.0, disk)
                            .map(|_| ())
                    }
                    StrokeJoin::Miter => {
                        let keep = if forced {
                            true
                        } else if self.defects.float_miter() {
                            float_miter(incoming.unit, outgoing.unit, request.miter_limit)
                        } else {
                            miter_kept(
                                (incoming.a, incoming.b),
                                (outgoing.a, outgoing.b),
                                request.miter_limit,
                                self.defects.equality_bevel(),
                            )
                        };
                        if !keep {
                            return self.emit_bevel(index, center, o_in, o_out);
                        }
                        let tip = miter_tip(center, incoming.unit, outgoing.unit, right, r);
                        if !self.defects.skip_tip_guard()
                            && !tip_guard(center, r, request.miter_limit, tolerances)
                        {
                            return Err(FrontEndError::NumericRange);
                        }
                        self.candidates.clear();
                        for point in [center, o_in, tip, o_out] {
                            self.push_candidate(point)?;
                        }
                        self.set_extra(&[o_in, o_out, tip]);
                        self.emit_hull(PieceKind::Miter, index, 1.0, 1.0, 0)
                            .map(|_| ())
                    }
                }
            }
        }
    }

    fn emit_bevel(
        &mut self,
        index: usize,
        center: Point,
        o_in: Point,
        o_out: Point,
    ) -> Result<(), FrontEndError> {
        self.candidates.clear();
        for point in [center, o_in, o_out] {
            self.push_candidate(point)?;
        }
        self.set_extra(&[o_in, o_out]);
        self.emit_hull(PieceKind::Bevel, index, 1.0, 1.0, 0)
            .map(|_| ())
    }

    fn emit_cap(
        &mut self,
        cap: StrokeCap,
        index: usize,
        end: bool,
        r: f64,
        tolerances: Tolerances,
    ) -> Result<(), FrontEndError> {
        let segment = self.segments[index];
        let (sample, parameter) = if end {
            (segment.end, 1.0)
        } else {
            (segment.start, 0.0)
        };
        match cap {
            StrokeCap::Butt => Ok(()),
            StrokeCap::Round => {
                self.candidates.clear();
                self.push_disk(sample.center, r, tolerances)?;
                let disk = self.candidates.len();
                for point in [sample.center, sample.minus, sample.plus] {
                    self.push_candidate(point)?;
                }
                self.emit_hull(PieceKind::RoundCap, index, parameter, parameter, disk)
                    .map(|_| ())
            }
            StrokeCap::Square => {
                let outward = if self.defects.square_along_normal() {
                    Point {
                        x: -segment.unit.y,
                        y: segment.unit.x,
                    }
                } else if end {
                    segment.unit
                } else {
                    Point {
                        x: -segment.unit.x,
                        y: -segment.unit.y,
                    }
                };
                let step = Point {
                    x: r * outward.x,
                    y: r * outward.y,
                };
                self.candidates.clear();
                for point in [
                    sample.minus,
                    sample.center,
                    sample.plus,
                    add(sample.minus, step),
                    add(sample.plus, step),
                ] {
                    self.push_candidate(point)?;
                }
                self.set_extra(&[add(sample.minus, step), add(sample.plus, step)]);
                self.emit_hull(PieceKind::SquareCap, index, parameter, parameter, 0)
                    .map(|_| ())
            }
        }
    }

    /// ST-P7 at the point of a zero-length open subpath.
    fn emit_point(
        &mut self,
        cap: StrokeCap,
        point: Point,
        r: f64,
        subpath: usize,
        tolerances: Tolerances,
    ) -> Result<(), FrontEndError> {
        match cap {
            StrokeCap::Butt => Ok(()),
            StrokeCap::Round => {
                self.candidates.clear();
                self.push_disk(point, r, tolerances)?;
                let disk = self.candidates.len();
                self.emit_hull(PieceKind::PointRound, subpath, 0.0, 0.0, disk)
                    .map(|_| ())
            }
            StrokeCap::Square => {
                self.candidates.clear();
                for (sx, sy) in [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)] {
                    let corner = Point {
                        x: if sx < 0.0 { point.x - r } else { point.x + r },
                        y: if sy < 0.0 { point.y - r } else { point.y + r },
                    };
                    self.push_candidate(corner)?;
                }
                self.emit_hull(PieceKind::PointSquare, subpath, 0.0, 0.0, 0)
                    .map(|_| ())
            }
        }
    }

    fn push_candidate(&mut self, point: Point) -> Result<(), FrontEndError> {
        // ST-G6: every emitted coordinate finite.
        if !(point.x.is_finite() && point.y.is_finite()) {
            return Err(FrontEndError::NumericRange);
        }
        if self.candidates.len() >= self.candidates.capacity() {
            return Err(FrontEndError::Invariant);
        }
        self.candidates.push(Point {
            x: point.x + 0.0,
            y: point.y + 0.0,
        });
        Ok(())
    }

    /// Section 4.4: the disk polygon, counter-clockwise from direction `(1, 0)`.
    fn push_disk(
        &mut self,
        center: Point,
        r: f64,
        tolerances: Tolerances,
    ) -> Result<(), FrontEndError> {
        let mut level = disk_level(center, r, tolerances.quarter)?;
        if self.defects.halve_disk() && level > 1 {
            level -= 1;
        }
        let count = 1usize << (level + 2);
        let quadrant = count / 4;
        let stride = (DIRECTION_COUNT - 1) / quadrant;
        for vertex in 0..count {
            let base = self.directions[(vertex % quadrant) * stride];
            let mut direction = base;
            for _ in 0..vertex / quadrant {
                direction = Point {
                    x: -direction.y,
                    y: direction.x,
                };
            }
            self.push_candidate(Point {
                x: center.x + r * direction.x,
                y: center.y + r * direction.y,
            })?;
        }
        Ok(())
    }

    /// Boundary-inclusive convex hull of the candidates (section 4.2), stored as one piece.
    /// Returns whether a piece was emitted (a zero-area hull is dropped).
    fn emit_hull(
        &mut self,
        kind: PieceKind,
        segment: usize,
        t0: f64,
        t1: f64,
        disk_vertices: usize,
    ) -> Result<bool, FrontEndError> {
        let points = &mut self.candidates;
        points.sort_unstable_by(|left, right| {
            left.x
                .partial_cmp(&right.x)
                .unwrap_or(Ordering::Equal)
                .then(left.y.partial_cmp(&right.y).unwrap_or(Ordering::Equal))
        });
        points.dedup_by(|a, b| a.x == b.x && a.y == b.y);
        if points.len() < 3 {
            return self.record_dropped(kind, segment, t0, t1, disk_vertices);
        }
        let first = points[0];
        let last = points[points.len() - 1];
        let mut has_area = false;
        for point in points.iter() {
            if orient(first, last, *point)? != Ordering::Equal {
                has_area = true;
                break;
            }
        }
        if !has_area {
            return self.record_dropped(kind, segment, t0, t1, disk_vertices);
        }
        let hull = &mut self.hull;
        hull.clear();
        for point in points.iter().copied() {
            while hull.len() >= 2
                && orient(hull[hull.len() - 2], hull[hull.len() - 1], point)? == Ordering::Less
            {
                hull.pop();
            }
            push_hull(hull, point)?;
        }
        let lower = hull.len();
        for point in points.iter().rev().skip(1).copied() {
            while hull.len() > lower
                && orient(hull[hull.len() - 2], hull[hull.len() - 1], point)? == Ordering::Less
            {
                hull.pop();
            }
            push_hull(hull, point)?;
        }
        // The last point is the first one again.
        hull.pop();
        if self.emitted >= MAX_PIECES {
            return Err(FrontEndError::PieceLimit);
        }
        if self.pieces.len() >= self.pieces.capacity() {
            return Err(FrontEndError::Invariant);
        }
        self.emitted += 1;
        let start = self.vertex_total;
        let count = hull.len();
        self.vertex_total = self
            .vertex_total
            .checked_add(count)
            .ok_or(FrontEndError::Invariant)?;
        if self.vertex_total <= self.piece_points.capacity() {
            self.piece_points.extend_from_slice(hull);
        }
        self.pieces.push(Piece {
            kind,
            segment,
            t0,
            t1,
            start,
            count,
            disk_vertices,
            dropped: false,
            extra: self.extra,
            extra_count: self.extra_count,
        });
        self.extra_count = 0;
        Ok(true)
    }

    /// A zero-area hull: dropped from the arrangement (section 4.2), kept in the record.
    fn record_dropped(
        &mut self,
        kind: PieceKind,
        segment: usize,
        t0: f64,
        t1: f64,
        disk_vertices: usize,
    ) -> Result<bool, FrontEndError> {
        if self.pieces.len() >= self.pieces.capacity() {
            return Err(FrontEndError::Invariant);
        }
        self.pieces.push(Piece {
            kind,
            segment,
            t0,
            t1,
            start: self.vertex_total,
            count: 0,
            disk_vertices,
            dropped: true,
            extra: self.extra,
            extra_count: self.extra_count,
        });
        self.extra_count = 0;
        Ok(false)
    }

    /// Records the join outer points and tip, or the square-cap extension, of the next piece.
    fn set_extra(&mut self, points: &[Point]) {
        self.extra = [Point::default(); 3];
        self.extra[..points.len()].copy_from_slice(points);
        self.extra_count = points.len();
    }
}

fn push_hull(hull: &mut Vec<Point>, point: Point) -> Result<(), FrontEndError> {
    if hull.len() >= hull.capacity() {
        return Err(FrontEndError::Invariant);
    }
    hull.push(point);
    Ok(())
}

fn orient(a: Point, b: Point, c: Point) -> Result<Ordering, FrontEndError> {
    orient2d(a, b, c).map_err(|_| FrontEndError::NumericRange)
}

fn same(a: Point, b: Point) -> bool {
    a.x == b.x && a.y == b.y
}

fn add(a: Point, b: Point) -> Point {
    Point {
        x: a.x + b.x,
        y: a.y + b.y,
    }
}

fn triple(center: Point, offset: Point) -> Triple {
    Triple {
        minus: Point {
            x: center.x - offset.x,
            y: center.y - offset.y,
        },
        center,
        plus: Point {
            x: center.x + offset.x,
            y: center.y + offset.y,
        },
    }
}

/// Section 4.2 `n(d) = d / sqrt(d.d)` on the rounded direction. ST-G1 range condition
/// (ST-U3 tightening): the squared length must be a finite normal number, else the relative
/// error argument of the offset bound fails (overflow, or underflow of the squares).
pub(crate) fn unit_vector(direction: Point) -> Result<Point, FrontEndError> {
    let length_squared = direction.x * direction.x + direction.y * direction.y;
    if !(length_squared.is_finite() && length_squared >= f64::MIN_POSITIVE) {
        return Err(FrontEndError::NumericRange);
    }
    let length = length_squared.sqrt();
    Ok(Point {
        x: direction.x / length,
        y: direction.y / length,
    })
}

/// Section 4.4 quadrant-I directions at level 6 by bisection, from `(1, 0)` to `(0, 1)`.
pub(crate) fn build_directions() -> [Point; DIRECTION_COUNT] {
    let mut directions = [Point::default(); DIRECTION_COUNT];
    directions[0] = Point { x: 1.0, y: 0.0 };
    directions[DIRECTION_COUNT - 1] = Point { x: 0.0, y: 1.0 };
    let mut step = DIRECTION_COUNT - 1;
    while step > 1 {
        let half = step / 2;
        let mut index = half;
        while index < DIRECTION_COUNT - 1 {
            let a = directions[index - half];
            let b = directions[index + half];
            let sum = Point {
                x: a.x + b.x,
                y: a.y + b.y,
            };
            let length = (sum.x * sum.x + sum.y * sum.y).sqrt();
            directions[index] = Point {
                x: sum.x / length,
                y: sum.y / length,
            };
            index += step;
        }
        step = half;
    }
    directions
}

/// Section 4.4 count rule: the smallest level `k` in `1..=6` with
/// `r * C_ARC <= (2^(e-2) - g_arc) * n^2 * (1 - 2^-40)`.
pub(crate) fn disk_level(center: Point, r: f64, quarter: f64) -> Result<u32, FrontEndError> {
    let reach = center.x.abs().max(center.y.abs()) + r;
    for level in 1..=MAX_DISK_LEVEL {
        let count = f64::from(1u32 << (level + 2));
        let g_arc = f64::from(8 * level + 16) * UNIT * reach;
        if r * C_ARC <= (quarter - g_arc) * (count * count) * SLACK_DOWN {
            return Ok(level);
        }
    }
    Err(FrontEndError::DiskLimit)
}

fn exact_difference(to: f64, from: f64) -> Signed<COORDINATE_LIMBS> {
    Signed::<COORDINATE_LIMBS>::from_finite(to).add(Signed::from_finite(from).negated())
}

type ExactVector = (Signed<COORDINATE_LIMBS>, Signed<COORDINATE_LIMBS>);

fn exact_vector(from: Point, to: Point) -> ExactVector {
    (
        exact_difference(to.x, from.x),
        exact_difference(to.y, from.y),
    )
}

fn exact_cross(u: ExactVector, v: ExactVector) -> Signed<LINE_LIMBS> {
    multiply::<COORDINATE_LIMBS, COORDINATE_LIMBS, LINE_LIMBS>(u.0, v.1)
        .add(multiply::<COORDINATE_LIMBS, COORDINATE_LIMBS, LINE_LIMBS>(u.1, v.0).negated())
}

fn exact_dot(u: ExactVector, v: ExactVector) -> Signed<LINE_LIMBS> {
    multiply::<COORDINATE_LIMBS, COORDINATE_LIMBS, LINE_LIMBS>(u.0, v.0).add(multiply::<
        COORDINATE_LIMBS,
        COORDINATE_LIMBS,
        LINE_LIMBS,
    >(u.1, v.1))
}

/// Exact turn, continuation or reversal of two line segments (section 4.3).
fn classify(incoming: Segment, outgoing: Segment) -> JoinClass {
    let u = exact_vector(incoming.a, incoming.b);
    let v = exact_vector(outgoing.a, outgoing.b);
    match exact_cross(u, v).cmp_zero() {
        Ordering::Greater => JoinClass::TurnLeft,
        Ordering::Less => JoinClass::TurnRight,
        Ordering::Equal => {
            if exact_dot(u, v).cmp_zero() == Ordering::Greater {
                JoinClass::Continuation
            } else {
                JoinClass::Reversal
            }
        }
    }
}

/// Section 4.3 exact miter test on the exact tangents `u = d_in`, `v = d_out`:
/// miter iff `L^2 (u.v) >= (2 - L^2) |u| |v|`. Called only at a turn. `equality_bevel` is the
/// ST-D2 seeded defect (test builds only; always false in production).
pub(crate) fn miter_kept(
    u: (Point, Point),
    v: (Point, Point),
    limit: f64,
    equality_bevel: bool,
) -> bool {
    let u = exact_vector(u.0, u.1);
    let v = exact_vector(v.0, v.1);
    let limit = Signed::<COORDINATE_LIMBS>::from_finite(limit);
    let limit_squared = multiply::<COORDINATE_LIMBS, COORDINATE_LIMBS, LINE_LIMBS>(limit, limit);
    let two = multiply::<COORDINATE_LIMBS, COORDINATE_LIMBS, LINE_LIMBS>(
        Signed::from_finite(2.0),
        Signed::from_finite(1.0),
    );
    // A = L^2 (u.v), K = 2 - L^2, U = |u|^2, V = |v|^2.
    let a = multiply::<LINE_LIMBS, LINE_LIMBS, PRODUCT_LIMBS>(limit_squared, exact_dot(u, v));
    let k = two.add(limit_squared.negated());
    let uu = exact_dot(u, u);
    let vv = exact_dot(v, v);
    let a_squared = multiply::<PRODUCT_LIMBS, PRODUCT_LIMBS, PREDICATE_LIMBS>(a, a);
    let k_squared = multiply::<LINE_LIMBS, LINE_LIMBS, PRODUCT_LIMBS>(k, k);
    let lengths = multiply::<LINE_LIMBS, LINE_LIMBS, PRODUCT_LIMBS>(uu, vv);
    let right = multiply::<PRODUCT_LIMBS, PRODUCT_LIMBS, PREDICATE_LIMBS>(k_squared, lengths);
    let order = a_squared.compare_magnitude(right);
    let k_positive = k.cmp_zero() == Ordering::Greater;
    let a_negative = a.cmp_zero() == Ordering::Less;
    match (k_positive, a_negative) {
        (false, false) => true,
        (false, true) => {
            if equality_bevel {
                order == Ordering::Less
            } else {
                order != Ordering::Greater
            }
        }
        (true, true) => false,
        (true, false) => {
            if equality_bevel {
                order == Ordering::Greater
            } else {
                order != Ordering::Less
            }
        }
    }
}

/// ST-D1 seeded defect: the miter ratio in Float64 with an epsilon.
fn float_miter(incoming: Point, outgoing: Point, limit: f64) -> bool {
    let cosine = incoming.x * outgoing.x + incoming.y * outgoing.y;
    let ratio = 1.0 / ((1.0 + cosine) * 0.5).sqrt();
    ratio <= limit * (1.0 + 1e-9)
}

/// Section 4.3 tip `T = B + r (n_in + n_out) / (1 + n_in.n_out)`, rounded per operation, with
/// `n_in`, `n_out` the Float64 outer unit normals.
pub(crate) fn miter_tip(
    center: Point,
    incoming: Point,
    outgoing: Point,
    right: bool,
    r: f64,
) -> Point {
    let outer = |unit: Point| {
        if right {
            Point {
                x: unit.y,
                y: -unit.x,
            }
        } else {
            Point {
                x: -unit.y,
                y: unit.x,
            }
        }
    };
    let n_in = outer(incoming);
    let n_out = outer(outgoing);
    let dot = n_in.x * n_out.x + n_in.y * n_out.y;
    let denominator = 1.0 + dot;
    let sum = Point {
        x: n_in.x + n_out.x,
        y: n_in.y + n_out.y,
    };
    let quotient = Point {
        x: sum.x / denominator,
        y: sum.y / denominator,
    };
    Point {
        x: center.x + r * quotient.x,
        y: center.y + r * quotient.y,
    }
}

/// ST-G3 as tightened in ST-U3: a kept miter needs `L <= 2^24` and
/// `g_tip = 64 * 2^-53 * (|B|inf + r * L^3) <= 2^(e-1)`.
fn tip_guard(center: Point, r: f64, limit: f64, tolerances: Tolerances) -> bool {
    // The limit is finite (stage 2).
    if limit > MAX_GUARDED_MITER_LIMIT {
        return false;
    }
    let reach = center.x.abs().max(center.y.abs());
    let g_tip = 64.0 * UNIT * (reach + r * (limit * limit * limit));
    g_tip <= tolerances.half
}

/// Test access to the private tolerance builder.
#[cfg(test)]
pub(crate) fn tip_guard_at(center: Point, r: f64, limit: f64, exponent: i32) -> bool {
    tip_guard(center, r, limit, Tolerances::new(exponent))
}
