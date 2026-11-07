//! P3 D8 V2 fill-mesh transport v0.
//!
//! The frozen contract is `docs/plans/p3-v2-fill-mesh-transport-contract.md`.
//! This engine is independent of the P2 `Engine`: it owns its own arenas,
//! epoch, workspace and scratch, and P2 code never calls into it.
//!
//! Revision 2 (`docs/plans/p3-alt-a1-fill-ladder-contract.md`, unit AL-U3): stage 4 of every
//! path runs the two-rung ladder, rung 0 (`fill_ladder`'s fast rung) first, and on a fallback
//! V2's two-step exact cascade unchanged.

use core::cmp::Ordering;
use core::mem::size_of;

use crate::codec::{align_up, read_u32, write_f64, write_u32, PathInput, Request};
use crate::cubic_fill::{
    CubicFillDiagnostics, CubicFillError, CubicFillWorkspace, FillTier, LargeTierLimits,
    MAX_EDGE_OWNERS, MAX_EXACT_FLAT_COMMANDS, MAX_LARGE_EDGE_OWNERS, MAX_LINE_CONTOURS,
};
use crate::engine::{
    BATCH_ALLOCATION_FAILED, BATCH_DISPOSED, BATCH_INTERNAL_ERROR, BATCH_INVALID_BATCH, BATCH_OK,
    BATCH_OUTPUT_CAPACITY, BATCH_RESOURCE_LIMIT,
};
use crate::fill_ladder::{
    boundary_records, BoundaryScan, ExactOutcome, ExactStep, FillLadder, Reason, Rung,
};
use crate::fill_predicates::orient2d;
use crate::geometry::{
    validate_path, Point, PATH_EMPTY, PATH_INVALID, PATH_INVALID_TOLERANCE, PATH_NUMERIC_RANGE,
    PATH_OK, PATH_WORK_LIMIT,
};
use crate::line_fill::LineFillRule;
use crate::robust_mesh::{RobustMesh, WindingFill};
use crate::rounded_line_fill::{RoundedFillError, RoundedFillLimits, RoundedFillOutput};
use crate::simple_cubic_topology::{
    TopologyError, TopologyLimits, MAX_CROSSINGS, MAX_CROSSING_SCAN,
};

pub const FILL_V0_VERSION: u32 = 0;
pub const FILL_V0_REVISION: u32 = 7;
pub const FILL_INPUT_MAGIC: u32 = 0x3046_4756;
pub const FILL_OUTPUT_MAGIC: u32 = 0x304D_4756;

pub const FILL_PATH_OK: u32 = 0;
pub const FILL_PATH_EMPTY: u32 = 1;
pub const FILL_PATH_INVALID_PATH: u32 = 2;
pub const FILL_PATH_INVALID_TOLERANCE: u32 = 3;
pub const FILL_PATH_NUMERIC_RANGE: u32 = 4;
pub const FILL_PATH_WORK_LIMIT: u32 = 5;
pub const FILL_PATH_UNSUPPORTED_GEOMETRY: u32 = 6;

pub(crate) const INPUT_HEADER_BYTES: usize = 48;
pub(crate) const REQUEST_BYTES: usize = 16;
pub(crate) const OUTPUT_HEADER_BYTES: usize = 64;
pub(crate) const RESULT_BYTES: usize = 80;
pub(crate) const INPUT_CAP_BYTES: u32 = 64 * 1024 * 1024;
pub(crate) const OUTPUT_CAP_BYTES: u32 = 256 * 1024 * 1024;
pub(crate) const MIN_TOLERANCE_EXPONENT: i32 = -1021;
pub(crate) const MAX_TOLERANCE_EXPONENT: i32 = 1023;

/// Runtime workspace limits of fill transport v0. Equal before B1 to the native
/// test constant `LIMITS`; B1 changes these values without a port change.
///
/// D8 B1 (`docs/plans/p3-fill-stroke-meshes.md`, "B1 kernel caps"): every field
/// is the pre-B1 value scaled by the same rule from E = `MAX_EDGE_OWNERS` (64
/// before B1, 256 since): input vertices and edges E, pairs
/// E(E − 1)/2, events 2E, sections the full bound events · E + 2E, nodes,
/// cells, vertices and triangles 4E, boundaries and contributors 8E. The work
/// budget scales with the pair count (×16), and 16 MiB still holds the
/// workspace's reservation.
pub(crate) const FILL_V0_LIMITS: RoundedFillLimits = RoundedFillLimits {
    max_contours: MAX_LINE_CONTOURS,
    max_input_vertices: MAX_EDGE_OWNERS,
    max_edges: MAX_EDGE_OWNERS,
    max_pairs: MAX_EDGE_OWNERS * (MAX_EDGE_OWNERS - 1) / 2,
    max_events: 2 * MAX_EDGE_OWNERS,
    max_sections: 2 * MAX_EDGE_OWNERS * MAX_EDGE_OWNERS + 2 * MAX_EDGE_OWNERS,
    max_nodes: 4 * MAX_EDGE_OWNERS,
    max_cells: 4 * MAX_EDGE_OWNERS,
    max_boundaries: 8 * MAX_EDGE_OWNERS,
    max_contributors: 8 * MAX_EDGE_OWNERS,
    max_vertices: 4 * MAX_EDGE_OWNERS,
    max_triangles: 4 * MAX_EDGE_OWNERS,
    max_work: 32_000_000,
    max_bytes: 16 * 1024 * 1024,
};

/// E14-U2 X-K1 item 4 (`docs/plans/d9-e14-u2-fill-exact-edge-cap-contract.md` section 4): the
/// exact rung's large tier, every field derived from EX = `MAX_LARGE_EDGE_OWNERS` as
/// `FILL_V0_LIMITS` derives it from E, except `max_sections`, fixed at the small tier's value
/// (X-K2, X-Q2 (a)), and `max_work`, measured (X-K3). The rounded workspace is reserved for
/// these limits and runs the small tier's unless an attempt enters the large tier.
pub(crate) const FILL_V0_LARGE_LIMITS: RoundedFillLimits = RoundedFillLimits {
    max_contours: MAX_LINE_CONTOURS,
    max_input_vertices: MAX_LARGE_EDGE_OWNERS,
    max_edges: MAX_LARGE_EDGE_OWNERS,
    max_pairs: MAX_LARGE_EDGE_OWNERS * (MAX_LARGE_EDGE_OWNERS - 1) / 2,
    max_events: 2 * MAX_LARGE_EDGE_OWNERS,
    max_sections: FILL_V0_LIMITS.max_sections,
    max_nodes: 4 * MAX_LARGE_EDGE_OWNERS,
    max_cells: 4 * MAX_LARGE_EDGE_OWNERS,
    max_boundaries: 8 * MAX_LARGE_EDGE_OWNERS,
    max_contributors: 8 * MAX_LARGE_EDGE_OWNERS,
    max_vertices: 4 * MAX_LARGE_EDGE_OWNERS,
    max_triangles: 4 * MAX_LARGE_EDGE_OWNERS,
    max_work: LARGE_TIER_MAX_WORK,
    max_bytes: 32 * 1024 * 1024,
};

/// E14-U2 X-K3: the large tier's work cap. The largest charged work measured at X-U1 was
/// 9,796,597 units (`a04-corpus/v1` C3 g0099, the A01 sweep rows that reach the large tier,
/// `pnpm e16:fill-diag`); × 4 rounded up to a power of two is 2^26.
pub(crate) const LARGE_TIER_MAX_WORK: u64 = 1 << 26;

/// E14-U2 X-K1: the large tier of the production fill workspace.
pub(crate) const FILL_V0_LARGE_TIER: LargeTierLimits = LargeTierLimits {
    rounded: FILL_V0_LARGE_LIMITS,
    topology: TopologyLimits::LARGE,
    crossings: MAX_CROSSINGS,
    crossing_scan: MAX_CROSSING_SCAN,
};

/// B1's test-only pre-B1 cap mode: `FILL_V0_LIMITS` before B1 (E = 64), equal to the native
/// test constant `LIMITS`. With `CubicFillWorkspace::new_pre_b1` it reproduces the pre-B1
/// kernel for the frozen oracles (`docs/plans/p3-fill-stroke-meshes.md`, "B1 kernel caps").
#[cfg(test)]
pub(crate) const PRE_B1_FILL_V0_LIMITS: RoundedFillLimits = RoundedFillLimits {
    max_contours: 4,
    max_input_vertices: 64,
    max_edges: 64,
    max_pairs: 2_016,
    max_events: 128,
    max_sections: 8_320,
    max_nodes: 256,
    max_cells: 256,
    max_boundaries: 512,
    max_contributors: 512,
    max_vertices: 256,
    max_triangles: 256,
    max_work: 2_000_000,
    max_bytes: 16 * 1024 * 1024,
};

/// Flattening tolerance `2^e` and topology tolerance `2^(e-1)`, built from
/// the exponent bits. `e` must be inside the accepted range.
pub(crate) fn tolerances(exponent: i32) -> (f64, f64) {
    debug_assert!((MIN_TOLERANCE_EXPONENT..=MAX_TOLERANCE_EXPONENT).contains(&exponent));
    let biased = (exponent + 1023) as u64;
    (
        f64::from_bits(biased << 52),
        f64::from_bits((biased - 1) << 52),
    )
}

/// Outcome of mapping one kernel value to the port.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Mapped {
    Path(u32),
    Internal,
}

/// Section e mapping of an attempt error. One exhaustive match, no wildcard:
/// a new kernel variant fails to compile until it is mapped.
pub(crate) fn map_attempt_error(error: CubicFillError) -> Mapped {
    match error {
        CubicFillError::SourceLimit
        | CubicFillError::CommandLimit
        | CubicFillError::ContourLimit
        | CubicFillError::PointLimit
        | CubicFillError::OwnerLimit => Mapped::Path(FILL_PATH_WORK_LIMIT),
        CubicFillError::UnsupportedSource | CubicFillError::ZeroLengthLeaf => {
            Mapped::Path(FILL_PATH_UNSUPPORTED_GEOMETRY)
        }
        CubicFillError::EmissionStatus(_)
        | CubicFillError::PlanMismatch
        | CubicFillError::BoundsMismatch
        | CubicFillError::InvalidCommand
        | CubicFillError::InvalidProvenance
        | CubicFillError::TopologyOwnership
        | CubicFillError::RoundedOwnership
        | CubicFillError::CombinedByteLimit => Mapped::Internal,
        CubicFillError::Topology(error) => match error {
            TopologyError::KnotMismatch | TopologyError::Unresolved => {
                Mapped::Path(FILL_PATH_UNSUPPORTED_GEOMETRY)
            }
            // E14-U2 X-K3: the crossing scan's cap is a cap stop like `WorkLimit`.
            TopologyError::WorkLimit | TopologyError::ByteLimit | TopologyError::ScanLimit => {
                Mapped::Path(FILL_PATH_WORK_LIMIT)
            }
            TopologyError::InvalidInput
            | TopologyError::InvalidProvenance
            | TopologyError::InvalidLimits
            | TopologyError::AllocationFailed => Mapped::Internal,
        },
        CubicFillError::Rounded(error) => match error {
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
            | RoundedFillError::OutputLimit => Mapped::Path(FILL_PATH_WORK_LIMIT),
            RoundedFillError::TopologyAmbiguous => Mapped::Path(FILL_PATH_UNSUPPORTED_GEOMETRY),
            RoundedFillError::InvalidTolerance => Mapped::Path(FILL_PATH_INVALID_TOLERANCE),
            RoundedFillError::InvalidInput
            | RoundedFillError::InternalInvariant
            | RoundedFillError::InvalidLimits
            | RoundedFillError::AllocationFailed
            | RoundedFillError::ByteLimit => Mapped::Internal,
        },
    }
}

/// Section a: workspace construction failure at `fill_v0_reserve`.
pub(crate) fn construction_status(error: CubicFillError) -> u32 {
    match error {
        CubicFillError::Topology(TopologyError::AllocationFailed)
        | CubicFillError::Rounded(RoundedFillError::AllocationFailed) => BATCH_ALLOCATION_FAILED,
        CubicFillError::SourceLimit
        | CubicFillError::UnsupportedSource
        | CubicFillError::CommandLimit
        | CubicFillError::EmissionStatus(_)
        | CubicFillError::PlanMismatch
        | CubicFillError::BoundsMismatch
        | CubicFillError::InvalidCommand
        | CubicFillError::InvalidProvenance
        | CubicFillError::ContourLimit
        | CubicFillError::PointLimit
        | CubicFillError::OwnerLimit
        | CubicFillError::ZeroLengthLeaf
        | CubicFillError::Topology(_)
        | CubicFillError::TopologyOwnership
        | CubicFillError::CombinedByteLimit
        | CubicFillError::Rounded(_)
        | CubicFillError::RoundedOwnership => BATCH_INTERNAL_ERROR,
    }
}

/// Sizing statuses of the shared P2 flattening (section e mapping table).
pub(crate) fn map_flat_status(status: u32) -> Mapped {
    match status {
        PATH_OK => Mapped::Path(FILL_PATH_OK),
        PATH_EMPTY => Mapped::Path(FILL_PATH_EMPTY),
        PATH_INVALID => Mapped::Path(FILL_PATH_INVALID_PATH),
        PATH_INVALID_TOLERANCE => Mapped::Path(FILL_PATH_INVALID_TOLERANCE),
        PATH_NUMERIC_RANGE => Mapped::Path(FILL_PATH_NUMERIC_RANGE),
        PATH_WORK_LIMIT => Mapped::Path(FILL_PATH_WORK_LIMIT),
        _ => Mapped::Internal,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FillRequest {
    pub(crate) request_id: u32,
    pub(crate) rule: LineFillRule,
    pub(crate) exponent: i32,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct FillInput<'a> {
    bytes: &'a [u8],
    path_count: usize,
    path_offsets_offset: usize,
    point_offsets_offset: usize,
    verbs_offset: usize,
    points_offset: usize,
}

fn section(start: usize, count: usize, width: usize, total: usize) -> Option<(usize, usize)> {
    let end = start.checked_add(count.checked_mul(width)?)?;
    (end <= total).then_some((start, end))
}

fn all_zero(bytes: &[u8], start: usize, end: usize) -> bool {
    bytes
        .get(start..end)
        .is_some_and(|padding| padding.iter().all(|byte| *byte == 0))
}

fn read_usize(bytes: &[u8], offset: usize) -> Option<usize> {
    usize::try_from(read_u32(bytes, offset)?).ok()
}

impl<'a> FillInput<'a> {
    pub(crate) fn parse(bytes: &'a [u8]) -> Option<Self> {
        if bytes.len() < INPUT_HEADER_BYTES
            || read_u32(bytes, 0)? != FILL_INPUT_MAGIC
            || read_u32(bytes, 4)? != FILL_V0_VERSION
            || read_usize(bytes, 8)? != bytes.len()
            || read_u32(bytes, 44)? != 0
        {
            return None;
        }
        let path_count = read_usize(bytes, 12)?;
        let verb_count = read_usize(bytes, 16)?;
        let point_count = read_usize(bytes, 20)?;
        let total = bytes.len();

        let requests = section(
            align_up(INPUT_HEADER_BYTES, 8)?,
            path_count,
            REQUEST_BYTES,
            total,
        )?;
        let table_entries = path_count.checked_add(1)?;
        let path_offsets = section(align_up(requests.1, 4)?, table_entries, 4, total)?;
        let point_offsets = section(align_up(path_offsets.1, 4)?, table_entries, 4, total)?;
        let verbs = section(point_offsets.1, verb_count, 1, total)?;
        let points = section(align_up(verbs.1, 8)?, point_count, 8, total)?;

        if read_usize(bytes, 24)? != requests.0
            || read_usize(bytes, 28)? != path_offsets.0
            || read_usize(bytes, 32)? != point_offsets.0
            || read_usize(bytes, 36)? != verbs.0
            || read_usize(bytes, 40)? != points.0
            || points.1 != total
            || !all_zero(bytes, INPUT_HEADER_BYTES, requests.0)
            || !all_zero(bytes, requests.1, path_offsets.0)
            || !all_zero(bytes, path_offsets.1, point_offsets.0)
            || !all_zero(bytes, verbs.1, points.0)
        {
            return None;
        }

        for index in 0..path_count {
            let request = requests.0.checked_add(index.checked_mul(REQUEST_BYTES)?)?;
            let rule = read_u32(bytes, request.checked_add(4)?)?;
            if rule > 1 || read_u32(bytes, request.checked_add(12)?)? != 0 {
                return None;
            }
        }

        for (table, count) in [(path_offsets.0, verb_count), (point_offsets.0, point_count)] {
            if read_u32(bytes, table)? != 0 {
                return None;
            }
            let mut previous = 0usize;
            for index in 1..=path_count {
                let value = read_usize(bytes, table.checked_add(index.checked_mul(4)?)?)?;
                if value < previous {
                    return None;
                }
                previous = value;
            }
            if previous != count {
                return None;
            }
        }

        Some(Self {
            bytes,
            path_count,
            path_offsets_offset: path_offsets.0,
            point_offsets_offset: point_offsets.0,
            verbs_offset: verbs.0,
            points_offset: points.0,
        })
    }

    pub(crate) fn path_count(self) -> usize {
        self.path_count
    }

    pub(crate) fn request(self, index: usize) -> Option<FillRequest> {
        if index >= self.path_count {
            return None;
        }
        let offset = INPUT_HEADER_BYTES.checked_add(index.checked_mul(REQUEST_BYTES)?)?;
        let rule = match read_u32(self.bytes, offset.checked_add(4)?)? {
            0 => LineFillRule::Nonzero,
            1 => LineFillRule::Evenodd,
            _ => return None,
        };
        Some(FillRequest {
            request_id: read_u32(self.bytes, offset)?,
            rule,
            exponent: read_u32(self.bytes, offset.checked_add(8)?)? as i32,
        })
    }

    /// Verb bytes and point bytes of one path.
    pub(crate) fn path(self, index: usize) -> Option<(&'a [u8], &'a [u8])> {
        if index >= self.path_count {
            return None;
        }
        let entry = index.checked_mul(4)?;
        let next = entry.checked_add(4)?;
        let verb_start = read_usize(self.bytes, self.path_offsets_offset.checked_add(entry)?)?;
        let verb_end = read_usize(self.bytes, self.path_offsets_offset.checked_add(next)?)?;
        let point_start = read_usize(self.bytes, self.point_offsets_offset.checked_add(entry)?)?;
        let point_end = read_usize(self.bytes, self.point_offsets_offset.checked_add(next)?)?;
        let verbs = self.bytes.get(
            self.verbs_offset.checked_add(verb_start)?..self.verbs_offset.checked_add(verb_end)?,
        )?;
        let points = self.bytes.get(
            self.points_offset
                .checked_add(point_start.checked_mul(8)?)?
                ..self.points_offset.checked_add(point_end.checked_mul(8)?)?,
        )?;
        Some((verbs, points))
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct DirectedEdge {
    low: u32,
    high: u32,
    position: u32,
    forward: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct SplitEdge {
    from: usize,
    to: usize,
    matched: bool,
}

const UNUSED_PAIR: [u32; 2] = [u32::MAX, u32::MAX];

/// Section a fill scratch, reserved once from `FILL_V0_LIMITS`. Since E14-K1 item 5 its index,
/// edge and boundary buffers hold the larger of the exact rung's slots and rung 0's AL-FR9
/// records; the exact rung's own checks stay bounded by `exact_slots`.
pub(crate) struct FillScratch {
    triangles: Vec<u32>,
    edges: Vec<DirectedEdge>,
    boundary: Vec<[u32; 2]>,
    split: Vec<SplitEdge>,
    /// The index slots of `FillScratch::sizes` for the active tier's limits.
    exact_slots: usize,
    /// The split pairs of the active tier's limits (E14-U2 X-K1 item 3).
    split_limit: usize,
    /// `(index slots, split pairs)` of the small and large tiers.
    small_limits: (usize, usize),
    large_limits: (usize, usize),
    /// E38: the robust last rung's storage and mesh (`fill-v0+r6`, `stroke-v0+r9`).
    pub(crate) robust: RobustMesh,
}

/// Marker for a refinement or boundary self-check failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SelfCheckFailure;

impl FillScratch {
    const fn empty() -> Self {
        Self {
            triangles: Vec::new(),
            edges: Vec::new(),
            boundary: Vec::new(),
            split: Vec::new(),
            exact_slots: 0,
            split_limit: 0,
            small_limits: (0, 0),
            large_limits: (0, 0),
            robust: RobustMesh::new(),
        }
    }

    /// The split pairs `max_boundaries + max_nodes` (V2 section a).
    fn split_pairs(limits: RoundedFillLimits) -> Option<usize> {
        limits.max_boundaries.checked_add(limits.max_nodes)
    }

    /// E14-U2 X-K1 item 3: the exact rung's self-checks (`exact_slots`, the `collect_boundary`
    /// limit and `push_split`'s capacity) take the tier of the mesh being refined.
    pub(crate) fn set_exact_tier(&mut self, tier: FillTier) {
        (self.exact_slots, self.split_limit) = match tier {
            FillTier::Small => self.small_limits,
            FillTier::Large => self.large_limits,
        };
    }

    /// The exact rung's index slots `3 · (max_triangles + 2 · max_vertices)` (V2 section a).
    pub(crate) fn exact_slots(limits: RoundedFillLimits) -> Option<usize> {
        limits
            .max_triangles
            .checked_add(limits.max_vertices.checked_mul(2)?)?
            .checked_mul(3)
    }

    /// Capacities `(index slots, split pairs)` and the total byte size, for at least
    /// `records` index slots (E14-K1 item 5: rung 0's AL-FR9 records).
    fn sizes_for(limits: RoundedFillLimits, records: usize) -> Option<(usize, usize, usize)> {
        let slots = Self::exact_slots(limits)?.max(records);
        let split = Self::split_pairs(limits)?;
        let bytes = [
            slots.checked_mul(size_of::<u32>())?,
            slots.checked_mul(size_of::<DirectedEdge>())?,
            slots.checked_mul(size_of::<[u32; 2]>())?,
            split.checked_mul(size_of::<SplitEdge>())?,
            // E38: the robust rung's buffers.
            RobustMesh::reserved_bytes(),
        ]
        .into_iter()
        .try_fold(0usize, usize::checked_add)?;
        Some((slots, split, bytes))
    }

    /// Capacities and bytes of the exact rung's scratch alone (before E14-K1).
    #[cfg(test)]
    fn sizes(limits: RoundedFillLimits) -> Option<(usize, usize, usize)> {
        Self::sizes_for(limits, 0)
    }

    /// Reserves every scratch buffer for at least `records` index slots; `Err(status)` on
    /// refusal.
    pub(crate) fn reserve(limits: RoundedFillLimits, records: usize) -> Result<(Self, usize), u32> {
        Self::reserve_tiers(limits, limits, records)
    }

    /// E14-U2 X-K1: reserves the scratch for the larger of two tiers' limits (and at least
    /// `records` index slots) and activates the small tier's checks.
    pub(crate) fn reserve_tiers(
        small: RoundedFillLimits,
        large: RoundedFillLimits,
        records: usize,
    ) -> Result<(Self, usize), u32> {
        let (slots, split, bytes) = Self::sizes_for(large, records).ok_or(BATCH_INTERNAL_ERROR)?;
        let mut scratch = Self::empty();
        scratch.small_limits = (
            Self::exact_slots(small).ok_or(BATCH_INTERNAL_ERROR)?,
            Self::split_pairs(small).ok_or(BATCH_INTERNAL_ERROR)?,
        );
        scratch.large_limits = (
            Self::exact_slots(large).ok_or(BATCH_INTERNAL_ERROR)?,
            Self::split_pairs(large).ok_or(BATCH_INTERNAL_ERROR)?,
        );
        if scratch.small_limits.0 > scratch.large_limits.0
            || scratch.small_limits.1 > scratch.large_limits.1
        {
            return Err(BATCH_INTERNAL_ERROR);
        }
        scratch.set_exact_tier(FillTier::Small);
        if scratch.triangles.try_reserve_exact(slots).is_err()
            || scratch.edges.try_reserve_exact(slots).is_err()
            || scratch.boundary.try_reserve_exact(slots).is_err()
            || scratch.split.try_reserve_exact(split).is_err()
            || scratch.robust.reserve().is_err()
        {
            return Err(BATCH_ALLOCATION_FAILED);
        }
        if scratch.robust.allocated_bytes() != RobustMesh::reserved_bytes() {
            return Err(BATCH_INTERNAL_ERROR);
        }
        Ok((scratch, bytes))
    }

    /// The reserved index slots, which `FillLadder::reserve` checks against AL-FR9's records.
    pub(crate) fn records(&self) -> usize {
        self.triangles
            .capacity()
            .min(self.edges.capacity())
            .min(self.boundary.capacity())
    }

    pub(crate) fn triangles(&self) -> &[u32] {
        &self.triangles
    }

    pub(crate) fn boundary(&self) -> &[[u32; 2]] {
        &self.boundary
    }

    /// Section f: conforming ladder refinement, boundary edges used once,
    /// and the cross-check against the kernel ledger.
    pub(crate) fn refine(&mut self, mesh: &RoundedFillOutput<'_>) -> Result<(), SelfCheckFailure> {
        self.triangles.clear();
        self.edges.clear();
        self.boundary.clear();
        self.split.clear();
        self.build_ladders(mesh)?;
        self.collect_boundary(self.exact_slots)?;
        self.cross_check_ledger(mesh)
    }

    fn build_ladders(&mut self, mesh: &RoundedFillOutput<'_>) -> Result<(), SelfCheckFailure> {
        for cell in mesh.cells {
            let left = *mesh.columns.get(cell.slab).ok_or(SelfCheckFailure)?;
            let right = *mesh
                .columns
                .get(cell.slab.checked_add(1).ok_or(SelfCheckFailure)?)
                .ok_or(SelfCheckFailure)?;
            let [n0, n1, n2, n3] = cell.nodes;
            let left_end = left.node_start + left.node_count;
            let right_end = right.node_start + right.node_count;
            if n0 > n3
                || n1 > n2
                || n0 < left.node_start
                || n3 >= left_end
                || n1 < right.node_start
                || n2 >= right_end
            {
                return Err(SelfCheckFailure);
            }
            let start = self.triangles.len();
            let mut l = n0;
            let mut r = n1;
            while l != n3 || r != n2 {
                let next_l = if l == n3 {
                    None
                } else {
                    Some(next_vertex_node(mesh, l, n3)?)
                };
                let next_r = if r == n2 {
                    None
                } else {
                    Some(next_vertex_node(mesh, r, n2)?)
                };
                let advance_right = match (next_l, next_r) {
                    (_, None) => false,
                    (None, Some(_)) => true,
                    (Some(lower), Some(upper)) => {
                        mesh.nodes[upper].point.y < mesh.nodes[lower].point.y
                    }
                };
                let triangle = if advance_right {
                    let upper = next_r.ok_or(SelfCheckFailure)?;
                    let triangle = [l, r, upper];
                    r = upper;
                    triangle
                } else {
                    let upper = next_l.ok_or(SelfCheckFailure)?;
                    let triangle = [l, r, upper];
                    l = upper;
                    triangle
                };
                self.push_triangle(mesh, triangle)?;
            }
            if self.triangles.len() == start {
                return Err(SelfCheckFailure);
            }
        }
        Ok(())
    }

    fn push_triangle(
        &mut self,
        mesh: &RoundedFillOutput<'_>,
        nodes: [usize; 3],
    ) -> Result<(), SelfCheckFailure> {
        let points = [
            mesh.nodes[nodes[0]].point,
            mesh.nodes[nodes[1]].point,
            mesh.nodes[nodes[2]].point,
        ];
        if orient2d(points[0], points[1], points[2]) != Ok(Ordering::Greater) {
            return Err(SelfCheckFailure);
        }
        if self.triangles.len() + 3 > self.exact_slots.min(self.triangles.capacity()) {
            return Err(SelfCheckFailure);
        }
        for node in nodes {
            let vertex = node_vertex(mesh, node)?;
            self.triangles.push(vertex);
        }
        Ok(())
    }

    /// V2 section f's once-only scan over at most `limit` index slots: the exact rung passes
    /// its own slot count (E14-K1 item 5), rung 0's AL-FR9 the reserved capacity.
    fn collect_boundary(&mut self, limit: usize) -> Result<(), SelfCheckFailure> {
        let slots = self.triangles.len();
        if slots > limit || slots > self.edges.capacity() || slots > self.boundary.capacity() {
            return Err(SelfCheckFailure);
        }
        for position in 0..slots {
            let triangle = position - position % 3;
            let a = self.triangles[position];
            let b = self.triangles[triangle + (position % 3 + 1) % 3];
            if a == b {
                return Err(SelfCheckFailure);
            }
            self.edges.push(DirectedEdge {
                low: a.min(b),
                high: a.max(b),
                position: u32::try_from(position).map_err(|_| SelfCheckFailure)?,
                forward: a < b,
            });
            self.boundary.push(UNUSED_PAIR);
        }
        self.edges
            .sort_unstable_by_key(|edge| (edge.low, edge.high, edge.position));
        let mut cursor = 0usize;
        while cursor < self.edges.len() {
            let first = self.edges[cursor];
            let mut end = cursor + 1;
            while end < self.edges.len()
                && self.edges[end].low == first.low
                && self.edges[end].high == first.high
            {
                end += 1;
            }
            match end - cursor {
                1 => {
                    let position = first.position as usize;
                    let triangle = position - position % 3;
                    self.boundary[position] = [
                        self.triangles[position],
                        self.triangles[triangle + (position % 3 + 1) % 3],
                    ];
                }
                2 if self.edges[cursor + 1].forward != first.forward => {}
                _ => return Err(SelfCheckFailure),
            }
            cursor = end;
        }
        let mut written = 0usize;
        for position in 0..self.boundary.len() {
            let pair = self.boundary[position];
            if pair != UNUSED_PAIR {
                self.boundary[written] = pair;
                written += 1;
            }
        }
        self.boundary.truncate(written);
        Ok(())
    }

    fn cross_check_ledger(&mut self, mesh: &RoundedFillOutput<'_>) -> Result<(), SelfCheckFailure> {
        for index in 0..self.boundary.len() {
            let [a, b] = self.boundary[index];
            let from = vertex_node(mesh, a)?;
            let to = vertex_node(mesh, b)?;
            if mesh.nodes[from].column == mesh.nodes[to].column {
                let mut node = from;
                while node != to {
                    let next = if from < to { node + 1 } else { node - 1 };
                    self.push_split(node, next)?;
                    node = next;
                }
            } else {
                self.push_split(from, to)?;
            }
        }
        self.split.sort_unstable_by_key(|edge| (edge.from, edge.to));
        if self
            .split
            .windows(2)
            .any(|pair| pair[0].from == pair[1].from && pair[0].to == pair[1].to)
            || self.split.len() != mesh.boundaries.len()
        {
            return Err(SelfCheckFailure);
        }
        for boundary in mesh.boundaries {
            let found = self
                .split
                .binary_search_by(|edge| (edge.from, edge.to).cmp(&(boundary.from, boundary.to)))
                .map_err(|_| SelfCheckFailure)?;
            if self.split[found].matched {
                return Err(SelfCheckFailure);
            }
            self.split[found].matched = true;
        }
        Ok(())
    }

    fn push_split(&mut self, from: usize, to: usize) -> Result<(), SelfCheckFailure> {
        if self.split.len() >= self.split_limit.min(self.split.capacity()) {
            return Err(SelfCheckFailure);
        }
        self.split.push(SplitEdge {
            from,
            to,
            matched: false,
        });
        Ok(())
    }
}

/// AL-FR9 item 2 on a fast mesh (Alt-A1 contract section 3.5). The fast triangles are copied
/// into the reserved index scratch, and V2's unchanged `collect_boundary` runs on them, so the
/// edges used once of a fast mesh come from the same code, in the same slot order, as an exact
/// mesh's. A duplicated directed edge or another self-check failure is `None` (`MESH_CHECK`).
/// The copy never allocates: rung 0 emits at most `fill_ladder::MAX_BOUNDARY_RECORDS` index
/// slots, which `FillLadder::reserve` checks against this scratch's reserved capacity. After a
/// published fast mesh the scratch holds its triangles and boundary pairs, in output order.
impl BoundaryScan for FillScratch {
    fn scan(&mut self, triangles: &[u32]) -> Option<&[[u32; 2]]> {
        self.triangles.clear();
        self.edges.clear();
        self.boundary.clear();
        self.split.clear();
        if triangles.len() > self.triangles.capacity() {
            return None;
        }
        self.triangles.extend_from_slice(triangles);
        self.collect_boundary(self.triangles.capacity()).ok()?;
        Some(&self.boundary)
    }
}

/// The next node after `node`, up to and including `last`, that has a mesh
/// vertex. Node indices are contiguous by rank within a column.
fn next_vertex_node(
    mesh: &RoundedFillOutput<'_>,
    node: usize,
    last: usize,
) -> Result<usize, SelfCheckFailure> {
    let mut candidate = node + 1;
    while candidate < last {
        if mesh.nodes[candidate].vertex.is_some() {
            return Ok(candidate);
        }
        candidate += 1;
    }
    if candidate == last {
        Ok(last)
    } else {
        Err(SelfCheckFailure)
    }
}

fn node_vertex(mesh: &RoundedFillOutput<'_>, node: usize) -> Result<u32, SelfCheckFailure> {
    let vertex = mesh
        .nodes
        .get(node)
        .and_then(|node| node.vertex)
        .ok_or(SelfCheckFailure)?;
    if (vertex as usize) < mesh.vertices.len() {
        Ok(vertex)
    } else {
        Err(SelfCheckFailure)
    }
}

/// Reverse of `RoundedNode.vertex`: a binary search over the columns by x and
/// then over that column's nodes by y.
fn vertex_node(mesh: &RoundedFillOutput<'_>, vertex: u32) -> Result<usize, SelfCheckFailure> {
    let point: Point = *mesh.vertices.get(vertex as usize).ok_or(SelfCheckFailure)?;
    let column = mesh
        .columns
        .binary_search_by(|column| column.x.partial_cmp(&point.x).unwrap_or(Ordering::Less))
        .map_err(|_| SelfCheckFailure)?;
    let record = mesh.columns[column];
    let nodes = mesh
        .nodes
        .get(record.node_start..record.node_start + record.node_count)
        .ok_or(SelfCheckFailure)?;
    let rank = nodes
        .binary_search_by(|node| node.point.y.partial_cmp(&point.y).unwrap_or(Ordering::Less))
        .map_err(|_| SelfCheckFailure)?;
    let node = record.node_start + rank;
    if mesh.nodes[node].vertex == Some(vertex) {
        Ok(node)
    } else {
        Err(SelfCheckFailure)
    }
}

/// Per-path outcome of one computation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PathOutcome {
    /// A non-`OK` path status.
    Status(u32),
    /// `OK`: on the exact rung the workspace holds the vertices and the scratch the refined
    /// mesh; on the fast rung the ladder holds the vertices and the scratch the fast triangles
    /// and their edges used once (Alt-A1 contract section 3.5).
    Mesh,
}

/// One path's result with its ladder record (Alt-A1 contract section 3.6): the rung that
/// produced it, and on a fallback the reason and the exact rung's topology step. All three are
/// `None` for a status decided before stage 4; under `exact_only` the reason is `None`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct BuiltPath {
    pub(crate) outcome: PathOutcome,
    pub(crate) rung: Option<Rung>,
    pub(crate) reason: Option<Reason>,
    pub(crate) step: Option<ExactStep>,
    /// E16-K2 item 4: the refinement depth k of the exact mesh, 0 without a successful retry.
    pub(crate) depth: u32,
    /// The exact rung's unmapped error, when it ended in one (E16-A2).
    pub(crate) error: Option<CubicFillError>,
    /// E14-U2 X-K1 item 5: the exact rung's tier, `None` when the exact rung did not run.
    pub(crate) tier: Option<FillTier>,
    /// E38: the mesh is the robust rung's (`FillScratch::robust`), after the exact rung's
    /// `work-limit` or `unsupported-geometry`; the other fields keep the exact rung's record.
    pub(crate) robust: bool,
    /// E39-K6: the mesh's coverage (`COVERAGE_PARTITION` or `COVERAGE_WINDING`).
    pub(crate) coverage: u32,
}

/// E39-K6: the record's coverage word (offset 36): a partition mesh (today's), a winding mesh
/// (a fill fan), or a union mesh (stroke pieces).
pub(crate) const COVERAGE_PARTITION: u32 = 0;
pub(crate) const COVERAGE_WINDING: u32 = 1;
pub(crate) const COVERAGE_UNION: u32 = 2;

impl BuiltPath {
    const fn decided(status: u32) -> Self {
        Self {
            outcome: PathOutcome::Status(status),
            rung: None,
            reason: None,
            step: None,
            depth: 0,
            error: None,
            tier: None,
            robust: false,
            coverage: COVERAGE_PARTITION,
        }
    }
}

/// The test-only ladder switches (Alt-A1 contract section 3.6): `exact_only` skips rung 0, and
/// the production seeded defects (14) and (15) of section 4.3. Outside test builds the type is
/// empty and every switch is constant `false`.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct PathSwitches {
    #[cfg(test)]
    pub(crate) exact_only: bool,
    /// Defect (14): the exact cascade's step order inverted (triangle-free first).
    #[cfg(test)]
    pub(crate) cascade_inverted: bool,
    /// Defect (15): a fallback path served from rung 0's partial state (the scratch that
    /// rung 0 left), because the exact mesh's refinement is skipped.
    #[cfg(test)]
    pub(crate) fallback_partial: bool,
    /// E38: the robust last rung runs. Production always runs it; in tests it is opt-in, so
    /// that the exact-rung fixtures keep observing `fill-v0+r5`'s statuses.
    #[cfg(test)]
    pub(crate) robust: bool,
    /// E39: winding meshes instead of the ladder. Production always builds them; in tests it
    /// is opt-in, so that the ladder fixtures keep observing `fill-v0+r6`'s results.
    #[cfg(test)]
    pub(crate) winding: bool,
}

impl PathSwitches {
    #[cfg(test)]
    fn winding(self) -> bool {
        self.winding
    }

    #[cfg(not(test))]
    #[inline(always)]
    fn winding(self) -> bool {
        true
    }

    #[cfg(test)]
    fn no_robust(self) -> bool {
        !self.robust
    }

    #[cfg(not(test))]
    #[inline(always)]
    fn no_robust(self) -> bool {
        false
    }

    #[cfg(test)]
    fn exact_only(self) -> bool {
        self.exact_only
    }

    #[cfg(not(test))]
    #[inline(always)]
    fn exact_only(self) -> bool {
        false
    }

    #[cfg(test)]
    fn cascade_inverted(self) -> bool {
        self.cascade_inverted
    }

    #[cfg(not(test))]
    #[inline(always)]
    fn cascade_inverted(self) -> bool {
        false
    }

    #[cfg(test)]
    fn fallback_partial(self) -> bool {
        self.fallback_partial
    }

    #[cfg(not(test))]
    #[inline(always)]
    fn fallback_partial(self) -> bool {
        false
    }
}

/// E16-K2 (`docs/plans/d9-e16-fill-rejection-remedy-contract.md` section 4): the most
/// tolerance halvings the exact rung retries after a topology failure.
pub(crate) const MAX_REFINEMENT_DEPTH: i32 = 16;

/// E16-K2 item 2: the exponents of the refinement retries after a topology failure at
/// `exponent`, finest last, none below `MIN_TOLERANCE_EXPONENT`.
pub(crate) fn refinement_exponents(exponent: i32) -> impl Iterator<Item = i32> {
    #[cfg(test)]
    let floor = if e16_defect(E16Defect::NoExponentBound) {
        i32::MIN
    } else {
        MIN_TOLERANCE_EXPONENT
    };
    #[cfg(not(test))]
    let floor = MIN_TOLERANCE_EXPONENT;
    (1..=MAX_REFINEMENT_DEPTH)
        .map(move |k| exponent - k)
        .take_while(move |value| *value >= floor)
}

/// E16-D2 to E16-D4 (contract section 7), test-only seeded defects of `exact_rung`.
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum E16Defect {
    /// D2: a stopped retry returns its own result instead of the cascade at e's.
    RetryOwnResult,
    /// D3: the retries also run after the cascade at e succeeds.
    RetryAfterSuccess,
    /// D4: the retry schedule ignores `MIN_TOLERANCE_EXPONENT`.
    NoExponentBound,
}

#[cfg(test)]
thread_local! {
    static E16_DEFECT: core::cell::Cell<Option<E16Defect>> = const { core::cell::Cell::new(None) };
}

#[cfg(test)]
fn e16_defect(defect: E16Defect) -> bool {
    E16_DEFECT.with(core::cell::Cell::get) == Some(defect)
}

/// Runs `action` with the seeded defect `defect` on, then switches it off.
#[cfg(test)]
pub(crate) fn with_e16_defect<T>(defect: E16Defect, action: impl FnOnce() -> T) -> T {
    E16_DEFECT.with(|switch| switch.set(Some(defect)));
    let result = action();
    E16_DEFECT.with(|switch| switch.set(None));
    result
}

fn topology_failure(result: &Result<CubicFillDiagnostics, CubicFillError>) -> bool {
    matches!(
        result,
        Err(CubicFillError::Topology(
            TopologyError::KnotMismatch | TopologyError::Unresolved
        ))
    )
}

/// V2's two-step cascade (section c) at tolerance exponent `exponent`: `attempt`, then
/// `attempt_triangle_free` after `KnotMismatch` or `Unresolved`, or the reverse order under
/// the seeded defect (14).
fn cascade_at(
    workspace: &mut CubicFillWorkspace,
    request: FillRequest,
    exponent: i32,
    verbs: &[u8],
    point_bytes: &[u8],
    inverted: bool,
) -> (ExactStep, Result<CubicFillDiagnostics, CubicFillError>) {
    let (flatten, topology) = tolerances(exponent);
    let input = PathInput::from_parts(
        Request {
            request_id: request.request_id,
            source_epoch: 0,
            source_revision: 0,
            tolerance: flatten,
        },
        verbs,
        point_bytes,
    );
    let run = |workspace: &mut CubicFillWorkspace, triangle_free: bool| {
        if triangle_free {
            workspace.attempt_triangle_free(input, request.rule, topology, MAX_EXACT_FLAT_COMMANDS)
        } else {
            workspace.attempt(input, request.rule, topology, MAX_EXACT_FLAT_COMMANDS)
        }
    };
    let result = run(workspace, inverted);
    if topology_failure(&result) {
        return (ExactStep::TriangleFree, run(workspace, !inverted));
    }
    (ExactStep::Legacy, result)
}

/// The exact rung (rung 1): the cascade at the request's exponent e and, when it ends in a
/// topology failure, E16-K2's retries at e − 1 to e − 16. The first retry that succeeds with
/// flat status `PATH_OK` is the result, with its depth. A retry that ends in another path
/// failure stops the retries, and the result is the cascade at e's; an internal error is
/// returned as it is, so the batch self-check fails. A pre-B1 workspace runs no retries.
pub(crate) fn exact_rung(
    workspace: &mut CubicFillWorkspace,
    request: FillRequest,
    verbs: &[u8],
    point_bytes: &[u8],
    inverted: bool,
) -> ExactOutcome {
    // E14-U2 X-K1 items 3 and 6: only the cascade at the request exponent may enter the large
    // tier, and its tier is the request's.
    workspace.set_large_tier_allowed(true);
    let (step, result) = cascade_at(
        workspace,
        request,
        request.exponent,
        verbs,
        point_bytes,
        inverted,
    );
    workspace.set_large_tier_allowed(false);
    let tier = workspace.tier();
    let mut first = ExactOutcome {
        step,
        result,
        depth: 0,
        stop: None,
        tier,
    };
    #[cfg(test)]
    let retry_after_success = e16_defect(E16Defect::RetryAfterSuccess);
    #[cfg(not(test))]
    let retry_after_success = false;
    // E14-U2 X-K1 item 6: a large request gets no E16-K2 retry.
    if !(topology_failure(&first.result) || retry_after_success)
        || !workspace.refines()
        || tier == FillTier::Large
    {
        return first;
    }
    for (depth, exponent) in (1..).zip(refinement_exponents(request.exponent)) {
        let (step, result) = cascade_at(workspace, request, exponent, verbs, point_bytes, inverted);
        let retry = ExactOutcome {
            step,
            result,
            depth,
            stop: None,
            tier,
        };
        match result {
            Ok(diagnostics) if diagnostics.flat_status == PATH_OK => return retry,
            // A flat status other than `PATH_OK` stops the retries with no error to record.
            Ok(_) => first.stop = None,
            Err(error) => {
                first.stop = Some((depth, error));
                if topology_failure(&result) {
                    continue;
                }
                // An internal error fails the batch self-check; depth stays 0, since no
                // retry succeeded (contract section 4 item 4).
                if map_attempt_error(error) == Mapped::Internal {
                    return ExactOutcome {
                        depth: 0,
                        stop: first.stop,
                        ..retry
                    };
                }
            }
        }
        // A stop: the outcome is the cascade at e's.
        #[cfg(test)]
        if e16_defect(E16Defect::RetryOwnResult) {
            return retry;
        }
        break;
    }
    first
}

/// Runs the per-path stage order of section e for one path. Stage 4 is the ladder of the
/// Alt-A1 contract (section 3.1): rung 0, and on a fallback the exact rung (`exact_rung`).
pub(crate) fn build_path(
    workspace: &mut CubicFillWorkspace,
    scratch: &mut FillScratch,
    ladder: &mut FillLadder,
    request: FillRequest,
    verbs: &[u8],
    point_bytes: &[u8],
    switches: PathSwitches,
) -> Result<BuiltPath, SelfCheckFailure> {
    let unchecked = PathInput::from_parts(
        Request {
            request_id: request.request_id,
            source_epoch: 0,
            source_revision: 0,
            tolerance: 0.0,
        },
        verbs,
        point_bytes,
    );
    if validate_path(unchecked).is_err() {
        return Ok(BuiltPath::decided(FILL_PATH_INVALID_PATH));
    }
    if !(MIN_TOLERANCE_EXPONENT..=MAX_TOLERANCE_EXPONENT).contains(&request.exponent) {
        return Ok(BuiltPath::decided(FILL_PATH_INVALID_TOLERANCE));
    }
    if verbs.is_empty() {
        return Ok(BuiltPath::decided(FILL_PATH_EMPTY));
    }
    // E39-K1, K3 and K5: production builds a winding mesh, with no rung of the ladder; a path
    // past the winding bound takes E38's slab sweep (a partition mesh).
    if switches.winding() {
        let tol = tolerances(request.exponent).1;
        let robust = |outcome| BuiltPath {
            robust: true,
            ..BuiltPath::decided(outcome)
        };
        return Ok(match scratch.robust.build_fill_winding(verbs, point_bytes, tol) {
            WindingFill::Mesh => BuiltPath {
                outcome: PathOutcome::Mesh,
                coverage: COVERAGE_WINDING,
                ..robust(FILL_PATH_OK)
            },
            WindingFill::Empty => BuiltPath::decided(FILL_PATH_EMPTY),
            WindingFill::Refused => BuiltPath::decided(FILL_PATH_WORK_LIMIT),
            WindingFill::TooWound => {
                match scratch.robust.build_fill(verbs, point_bytes, request.rule, tol) {
                    Some(true) => BuiltPath {
                        outcome: PathOutcome::Mesh,
                        ..robust(FILL_PATH_OK)
                    },
                    Some(false) => BuiltPath::decided(FILL_PATH_EMPTY),
                    None => BuiltPath::decided(FILL_PATH_WORK_LIMIT),
                }
            }
        });
    }
    // Step 0, rung 0 (Alt-A1 contract sections 1.2 and 3.1): AL-FR0, the S1 prefix, FR1-FR8
    // and AL-FR9 on the request's tolerance. A published fast mesh is the path's result: no
    // exact attempt, no cell-ladder refinement and no ledger cross-check run (section 3.8).
    let reason = if switches.exact_only() {
        None
    } else {
        match ladder.fast_rung(workspace, request, verbs, point_bytes, scratch) {
            Ok(()) => {
                return Ok(BuiltPath {
                    outcome: PathOutcome::Mesh,
                    rung: Some(Rung::Fast),
                    reason: None,
                    step: None,
                    depth: 0,
                    error: None,
                    tier: None,
                    robust: false,
                    coverage: COVERAGE_PARTITION,
                })
            }
            Err(reason) => Some(reason),
        }
    };

    // Rung 1, the exact rung, on the same input: V2's two-step cascade, then E16-K2's
    // refinement retries after a topology failure. Only the seeded defect (14), a test-only
    // switch, inverts its step order.
    let ExactOutcome {
        step,
        result,
        depth,
        tier,
        ..
    } = exact_rung(
        workspace,
        request,
        verbs,
        point_bytes,
        switches.cascade_inverted(),
    );
    let error = result.err();
    let exact = |outcome| BuiltPath {
        outcome,
        rung: Some(Rung::Exact),
        reason,
        step: Some(step),
        depth,
        error,
        tier: Some(tier),
        robust: false,
        coverage: COVERAGE_PARTITION,
    };
    // E38: an exact `work-limit` or `unsupported-geometry` goes to the robust last rung, which
    // never refuses a valid path (an empty region is `empty`).
    let robust = |scratch: &mut FillScratch, status: u32| -> BuiltPath {
        let refused = status == FILL_PATH_WORK_LIMIT || status == FILL_PATH_UNSUPPORTED_GEOMETRY;
        if !refused || switches.no_robust() {
            return exact(PathOutcome::Status(status));
        }
        let tol = tolerances(request.exponent).1;
        let outcome = match scratch
            .robust
            .build_fill(verbs, point_bytes, request.rule, tol)
        {
            Some(true) => PathOutcome::Mesh,
            Some(false) => PathOutcome::Status(FILL_PATH_EMPTY),
            // Beyond the rung's reserved buffers at any tolerance: the exact rung's status.
            None => return exact(PathOutcome::Status(status)),
        };
        BuiltPath {
            robust: true,
            ..exact(outcome)
        }
    };
    let diagnostics = match result {
        Ok(diagnostics) => diagnostics,
        Err(error) => {
            return match map_attempt_error(error) {
                Mapped::Path(status) => Ok(robust(scratch, status)),
                Mapped::Internal => Err(SelfCheckFailure),
            }
        }
    };
    match map_flat_status(diagnostics.flat_status) {
        Mapped::Path(FILL_PATH_OK) => {}
        Mapped::Path(status) => return Ok(robust(scratch, status)),
        Mapped::Internal => return Err(SelfCheckFailure),
    }
    let output = workspace.output().ok_or(SelfCheckFailure)?;
    // The seeded defect (15), a test-only switch, skips the refinement on a fallback path.
    if !(switches.fallback_partial() && reason.is_some()) {
        scratch.set_exact_tier(tier);
        let refined = scratch.refine(&output.rounded);
        scratch.set_exact_tier(FillTier::Small);
        refined?;
    }
    if scratch.triangles.is_empty() {
        return if output.rounded.vertices.is_empty() && scratch.boundary.is_empty() {
            Ok(exact(PathOutcome::Status(FILL_PATH_EMPTY)))
        } else {
            Err(SelfCheckFailure)
        };
    }
    Ok(exact(PathOutcome::Mesh))
}

/// Exact vertex bounds `[minX, minY, maxX, maxY]`.
fn vertex_bounds(vertices: &[Point]) -> [f64; 4] {
    let mut bounds = [vertices[0].x, vertices[0].y, vertices[0].x, vertices[0].y];
    for point in &vertices[1..] {
        bounds[0] = bounds[0].min(point.x);
        bounds[1] = bounds[1].min(point.y);
        bounds[2] = bounds[2].max(point.x);
        bounds[3] = bounds[3].max(point.y);
    }
    bounds
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BatchOutcome {
    Published(u32),
    Capacity(u32),
    ResourceLimit,
    Internal,
}

#[derive(Clone, Copy, Debug, Default)]
struct BlockRecord {
    offset: u32,
    vertices: u32,
    indices: u32,
    boundary: u32,
    bytes: u32,
    bounds: [f64; 4],
    /// E39-K6: the coverage word and the tolerance doublings of the published build.
    coverage: u32,
    coarsenings: u32,
}

fn write_record(
    output: &mut [u8],
    offset: usize,
    request: FillRequest,
    status: u32,
    block: BlockRecord,
) -> Option<()> {
    output
        .get_mut(offset..offset.checked_add(RESULT_BYTES)?)?
        .fill(0);
    write_u32(output, offset, request.request_id)?;
    write_u32(output, offset + 4, status)?;
    write_u32(output, offset + 8, request.exponent as u32)?;
    write_u32(output, offset + 16, block.offset)?;
    write_u32(output, offset + 20, block.vertices)?;
    write_u32(output, offset + 24, block.indices)?;
    write_u32(output, offset + 28, block.boundary)?;
    write_u32(output, offset + 32, block.bytes)?;
    write_u32(output, offset + 36, block.coverage)?;
    write_u32(output, offset + 40, block.coarsenings)?;
    for (index, value) in block.bounds.into_iter().enumerate() {
        write_f64(output, offset + 48 + index * 8, value)?;
    }
    Some(())
}

fn write_block(
    output: &mut [u8],
    offset: usize,
    bytes: usize,
    vertices: &[Point],
    triangles: &[u32],
    boundary: &[[u32; 2]],
) -> Option<()> {
    output.get_mut(offset..offset.checked_add(bytes)?)?.fill(0);
    let mut cursor = offset;
    for point in vertices {
        write_f64(output, cursor, point.x)?;
        write_f64(output, cursor + 8, point.y)?;
        cursor += 16;
    }
    for index in triangles {
        write_u32(output, cursor, *index)?;
        cursor += 4;
    }
    for pair in boundary {
        write_u32(output, cursor, pair[0])?;
        write_u32(output, cursor + 4, pair[1])?;
        cursor += 8;
    }
    Some(())
}

#[allow(clippy::too_many_arguments)]
fn run_batch(
    input: FillInput<'_>,
    workspace: &mut CubicFillWorkspace,
    scratch: &mut FillScratch,
    ladder: &mut FillLadder,
    output: &mut [u8],
    output_cap: u32,
    fault_path: Option<usize>,
    switches: PathSwitches,
) -> BatchOutcome {
    let capacity = output.len() as u64;
    let path_count = input.path_count();
    let Some(data_offset) = (path_count as u64)
        .checked_mul(RESULT_BYTES as u64)
        .and_then(|bytes| bytes.checked_add(OUTPUT_HEADER_BYTES as u64))
    else {
        return BatchOutcome::ResourceLimit;
    };
    let mut cursor = data_offset;
    let mut overflow = false;
    for index in 0..path_count {
        let (Some(request), Some((verbs, points))) = (input.request(index), input.path(index))
        else {
            return BatchOutcome::Internal;
        };
        if fault_path == Some(index) {
            return BatchOutcome::Internal;
        }
        let built = match build_path(workspace, scratch, ladder, request, verbs, points, switches) {
            Ok(built) => built,
            Err(SelfCheckFailure) => return BatchOutcome::Internal,
        };
        let record_offset = OUTPUT_HEADER_BYTES as u64 + (index as u64) * RESULT_BYTES as u64;
        let record_fits = record_offset + RESULT_BYTES as u64 <= capacity;
        let (status, block) = match built.outcome {
            PathOutcome::Status(status) => (status, BlockRecord::default()),
            PathOutcome::Mesh => {
                let (vertices, triangles, boundary) = if built.robust {
                    scratch.robust.mesh()
                } else if built.rung == Some(Rung::Fast) {
                    let Some((vertices, _)) = ladder.mesh() else {
                        return BatchOutcome::Internal;
                    };
                    (vertices, scratch.triangles(), scratch.boundary())
                } else {
                    let Some(mesh) = workspace.output() else {
                        return BatchOutcome::Internal;
                    };
                    (
                        mesh.rounded.vertices,
                        scratch.triangles(),
                        scratch.boundary(),
                    )
                };
                let payload = 16 * vertices.len() as u64
                    + 4 * (triangles.len() as u64 + 2 * boundary.len() as u64);
                let block_bytes = payload.div_ceil(8) * 8;
                let block_offset = cursor;
                match cursor.checked_add(block_bytes) {
                    Some(next) => cursor = next,
                    None => overflow = true,
                }
                let fits = !overflow && cursor <= capacity;
                if fits
                    && write_block(
                        output,
                        block_offset as usize,
                        block_bytes as usize,
                        vertices,
                        triangles,
                        boundary,
                    )
                    .is_none()
                {
                    return BatchOutcome::Internal;
                }
                let record = if record_fits && fits {
                    let (
                        Ok(offset),
                        Ok(vertex_count),
                        Ok(index_count),
                        Ok(boundary_count),
                        Ok(bytes),
                    ) = (
                        u32::try_from(block_offset),
                        u32::try_from(vertices.len()),
                        u32::try_from(triangles.len()),
                        u32::try_from(boundary.len() * 2),
                        u32::try_from(block_bytes),
                    )
                    else {
                        return BatchOutcome::Internal;
                    };
                    BlockRecord {
                        offset,
                        vertices: vertex_count,
                        indices: index_count,
                        boundary: boundary_count,
                        bytes,
                        bounds: vertex_bounds(vertices),
                        coverage: built.coverage,
                        coarsenings: if built.robust {
                            scratch.robust.stats.coarsenings
                        } else {
                            0
                        },
                    }
                } else {
                    BlockRecord::default()
                };
                (FILL_PATH_OK, record)
            }
        };
        if record_fits
            && write_record(output, record_offset as usize, request, status, block).is_none()
        {
            return BatchOutcome::Internal;
        }
    }
    if overflow || cursor > u64::from(output_cap) || cursor > u64::from(u32::MAX) {
        return BatchOutcome::ResourceLimit;
    }
    let total = cursor as u32;
    if cursor > capacity {
        return BatchOutcome::Capacity(total);
    }
    let (Ok(count), Ok(data)) = (u32::try_from(path_count), u32::try_from(data_offset)) else {
        return BatchOutcome::Internal;
    };
    let header = [
        FILL_OUTPUT_MAGIC,
        FILL_V0_VERSION,
        total,
        count,
        OUTPUT_HEADER_BYTES as u32,
        data,
    ];
    let Some(header_bytes) = output.get_mut(..OUTPUT_HEADER_BYTES) else {
        return BatchOutcome::Internal;
    };
    header_bytes.fill(0);
    for (index, value) in header.into_iter().enumerate() {
        if write_u32(output, index * 4, value).is_none() {
            return BatchOutcome::Internal;
        }
    }
    BatchOutcome::Published(total)
}

/// The fill-v0 engine: a second, independent module-level engine.
pub struct FillEngine {
    input: Vec<u64>,
    output: Vec<u64>,
    input_capacity: u32,
    output_capacity: u32,
    epoch: u32,
    result_len: u32,
    required_output_bytes: u32,
    disposed: bool,
    workspace: Option<CubicFillWorkspace>,
    scratch: FillScratch,
    ladder: Option<FillLadder>,
    heap_bytes: usize,
    #[cfg(test)]
    test_hooks: TestHooks,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct TestHooks {
    pub(crate) fail_workspace: Option<u32>,
    pub(crate) fault_path: Option<usize>,
    pub(crate) output_cap: Option<u32>,
    /// Skips rung 0, so every path takes V2's exact cascade (Alt-A1 contract section 3.6).
    pub(crate) exact_only: bool,
    /// Seeded defect (14), section 4.3: the cascade's step order inverted.
    pub(crate) defect_cascade_inverted: bool,
    /// Seeded defect (15), section 4.3: a fallback path served from rung 0's partial state.
    pub(crate) defect_fallback_partial: bool,
    /// B1's pre-B1 cap mode for the frozen oracles: the next reserve builds the workspace,
    /// scratch and ladder from `PRE_B1_FILL_V0_LIMITS` and `CubicFillWorkspace::new_pre_b1`.
    pub(crate) pre_b1_caps: bool,
    /// E14-U2: the next reserve builds the `fill-v0+r4` workspace and scratch, without the
    /// exact rung's large tier, as the identity reference.
    pub(crate) small_tier_only: bool,
    /// E38: the robust last rung runs (opt-in in tests; always on in production).
    pub(crate) robust: bool,
    /// E39: winding meshes instead of the ladder (opt-in in tests; always on in production).
    pub(crate) winding: bool,
}

impl Default for FillEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl FillEngine {
    pub const fn new() -> Self {
        Self {
            input: Vec::new(),
            output: Vec::new(),
            input_capacity: 0,
            output_capacity: 0,
            epoch: 0,
            result_len: 0,
            required_output_bytes: 0,
            disposed: false,
            workspace: None,
            scratch: FillScratch::empty(),
            ladder: None,
            heap_bytes: 0,
            #[cfg(test)]
            test_hooks: TestHooks {
                fail_workspace: None,
                fault_path: None,
                output_cap: None,
                exact_only: false,
                defect_cascade_inverted: false,
                defect_fallback_partial: false,
                pre_b1_caps: false,
                robust: false,
                winding: false,
                small_tier_only: false,
            },
        }
    }

    pub fn reserve(&mut self, input_bytes: u32, output_bytes: u32) -> u32 {
        if !self.begin_mutation() || self.disposed {
            return BATCH_DISPOSED;
        }
        self.invalidate_result();
        if input_bytes > INPUT_CAP_BYTES || output_bytes > OUTPUT_CAP_BYTES {
            return BATCH_RESOURCE_LIMIT;
        }
        let new_input = self.input_capacity.max(input_bytes);
        let new_output = self.output_capacity.max(output_bytes);
        if !grow_zeroed(&mut self.input, words_for(new_input))
            || !grow_zeroed(&mut self.output, words_for(new_output))
        {
            return BATCH_ALLOCATION_FAILED;
        }
        self.input_capacity = new_input;
        self.output_capacity = new_output;
        if self.workspace.is_none() {
            return match self.build_workspace() {
                Ok(()) => BATCH_OK,
                Err(status) => {
                    self.workspace = None;
                    self.scratch = FillScratch::empty();
                    self.ladder = None;
                    self.heap_bytes = 0;
                    status
                }
            };
        }
        BATCH_OK
    }

    fn build_workspace(&mut self) -> Result<(), u32> {
        #[cfg(test)]
        if let Some(status) = self.test_hooks.fail_workspace.take() {
            return Err(status);
        }
        let limits = FILL_V0_LIMITS;
        #[cfg(test)]
        let limits = if self.test_hooks.pre_b1_caps {
            PRE_B1_FILL_V0_LIMITS
        } else {
            limits
        };
        #[cfg(test)]
        let workspace = match (self.test_hooks.pre_b1_caps, self.test_hooks.small_tier_only) {
            (true, _) => CubicFillWorkspace::new_pre_b1(limits),
            (false, true) => CubicFillWorkspace::new(limits),
            (false, false) => CubicFillWorkspace::new_two_tier(limits, FILL_V0_LARGE_TIER),
        };
        #[cfg(not(test))]
        let workspace = CubicFillWorkspace::new_two_tier(limits, FILL_V0_LARGE_TIER);
        let workspace = workspace.map_err(construction_status)?;
        // E14-K1 item 5: the scratch also holds the AL-FR9 records of the workspace's fast caps.
        let fast_points = workspace.fast_contour_points();
        let fast_contours = workspace.fast_contours();
        // E14-U2 X-K1: the scratch is reserved for the large tier unless the workspace has none
        // (the test-only pre-B1 mode).
        #[cfg(test)]
        let large = if self.test_hooks.pre_b1_caps || self.test_hooks.small_tier_only {
            limits
        } else {
            FILL_V0_LARGE_LIMITS
        };
        #[cfg(not(test))]
        let large = FILL_V0_LARGE_LIMITS;
        let (scratch, scratch_bytes) = FillScratch::reserve_tiers(
            limits,
            large,
            boundary_records(fast_points, fast_contours),
        )?;
        // Alt-A1 contract section 3.4: rung 0's storage, reserved once and fallibly beside the
        // workspace and the scratch, after the check that the scratch holds AL-FR9's records.
        let ladder = FillLadder::reserve(scratch.records(), fast_points, fast_contours)?;
        let total = workspace
            .allocated_bytes()
            .checked_add(scratch_bytes)
            .and_then(|bytes| bytes.checked_add(ladder.allocated_bytes()))
            .ok_or(BATCH_INTERNAL_ERROR)?;
        self.scratch = scratch;
        self.workspace = Some(workspace);
        self.ladder = Some(ladder);
        self.heap_bytes = total;
        Ok(())
    }

    pub fn process(&mut self, input_length: u32) -> u32 {
        if !self.begin_mutation() || self.disposed {
            return BATCH_DISPOSED;
        }
        self.invalidate_result();
        let capacity = self.output_capacity as usize;
        let output_storage = words_as_bytes_mut(&mut self.output);
        if capacity >= OUTPUT_HEADER_BYTES {
            output_storage[..OUTPUT_HEADER_BYTES].fill(0);
        }
        if input_length > self.input_capacity {
            return BATCH_INVALID_BATCH;
        }
        let Some(input_bytes) = words_as_bytes(&self.input).get(..input_length as usize) else {
            return BATCH_INVALID_BATCH;
        };
        let Some(input) = FillInput::parse(input_bytes) else {
            return BATCH_INVALID_BATCH;
        };
        let (Some(workspace), Some(ladder)) = (self.workspace.as_mut(), self.ladder.as_mut())
        else {
            return BATCH_ALLOCATION_FAILED;
        };
        #[cfg(test)]
        let (fault_path, output_cap, switches) = (
            self.test_hooks.fault_path,
            self.test_hooks.output_cap.unwrap_or(OUTPUT_CAP_BYTES),
            self.test_hooks.switches(),
        );
        #[cfg(not(test))]
        let (fault_path, output_cap, switches) = (None, OUTPUT_CAP_BYTES, PathSwitches::default());
        let output = &mut words_as_bytes_mut(&mut self.output)[..capacity];
        match run_batch(
            input,
            workspace,
            &mut self.scratch,
            ladder,
            output,
            output_cap,
            fault_path,
            switches,
        ) {
            BatchOutcome::Published(total) => {
                self.result_len = total;
                BATCH_OK
            }
            BatchOutcome::Capacity(total) => {
                self.required_output_bytes = total;
                BATCH_OUTPUT_CAPACITY
            }
            BatchOutcome::ResourceLimit => BATCH_RESOURCE_LIMIT,
            BatchOutcome::Internal => {
                if capacity >= OUTPUT_HEADER_BYTES {
                    words_as_bytes_mut(&mut self.output)[..OUTPUT_HEADER_BYTES].fill(0);
                }
                BATCH_INTERNAL_ERROR
            }
        }
    }

    pub fn dispose(&mut self) -> u32 {
        self.epoch = self.epoch.saturating_add(1);
        self.disposed = true;
        self.invalidate_result();
        self.input = Vec::new();
        self.output = Vec::new();
        self.input_capacity = 0;
        self.output_capacity = 0;
        self.workspace = None;
        self.scratch = FillScratch::empty();
        self.ladder = None;
        self.heap_bytes = 0;
        BATCH_OK
    }

    fn begin_mutation(&mut self) -> bool {
        if self.epoch == u32::MAX {
            self.disposed = true;
            self.invalidate_result();
            return false;
        }
        self.epoch += 1;
        true
    }

    fn invalidate_result(&mut self) {
        self.result_len = 0;
        self.required_output_bytes = 0;
    }

    pub fn input_ptr(&mut self) -> u32 {
        self.input.as_mut_ptr() as usize as u32
    }

    pub fn input_capacity(&mut self) -> u32 {
        self.input_capacity
    }

    pub fn output_ptr(&mut self) -> u32 {
        self.output.as_mut_ptr() as usize as u32
    }

    pub fn output_capacity(&mut self) -> u32 {
        self.output_capacity
    }

    pub fn memory_epoch(&mut self) -> u32 {
        self.epoch
    }

    pub fn result_len(&mut self) -> u32 {
        self.result_len
    }

    pub fn required_output_bytes(&mut self) -> u32 {
        self.required_output_bytes
    }
}

#[cfg(test)]
impl TestHooks {
    fn switches(&self) -> PathSwitches {
        PathSwitches {
            exact_only: self.exact_only,
            cascade_inverted: self.defect_cascade_inverted,
            fallback_partial: self.defect_fallback_partial,
            // The older references (`r4`, pre-B1) predate the robust rung.
            robust: self.robust && !self.small_tier_only && !self.pre_b1_caps,
            winding: self.winding && !self.small_tier_only && !self.pre_b1_caps,
        }
    }
}

#[cfg(test)]
impl FillEngine {
    pub(crate) fn hooks(&mut self) -> &mut TestHooks {
        &mut self.test_hooks
    }

    /// One path through `build_path` on this engine's reserved state and hooks, for the
    /// native ladder record (Alt-A1 contract section 3.6); `None` before a reservation.
    pub(crate) fn build_one(
        &mut self,
        request: FillRequest,
        verbs: &[u8],
        point_bytes: &[u8],
    ) -> Option<Result<BuiltPath, SelfCheckFailure>> {
        let switches = self.test_hooks.switches();
        let (Some(workspace), Some(ladder)) = (self.workspace.as_mut(), self.ladder.as_mut())
        else {
            return None;
        };
        Some(build_path(
            workspace,
            &mut self.scratch,
            ladder,
            request,
            verbs,
            point_bytes,
            switches,
        ))
    }

    /// The robust rung's mesh of the last path (E38), meaningful when it was `robust`.
    pub(crate) fn scratch_robust_mesh(&self) -> (&[Point], &[u32], &[[u32; 2]]) {
        self.scratch.robust.mesh()
    }

    /// Rung 0's work charges in the last path (E14-K3).
    #[cfg(test)]
    pub(crate) fn fast_work(&self) -> u32 {
        self.ladder
            .as_ref()
            .map_or(0, |ladder| ladder.fast().stats().work)
    }

    /// Rung 0's published fast mesh after the last path, if that path was fast.
    pub(crate) fn fast_mesh(&self) -> Option<(&[Point], &[[u32; 3]])> {
        self.ladder.as_ref().and_then(FillLadder::mesh)
    }

    pub(crate) fn input_bytes_mut(&mut self) -> &mut [u8] {
        words_as_bytes_mut(&mut self.input)
    }

    pub(crate) fn output_bytes(&self) -> &[u8] {
        &words_as_bytes(&self.output)[..self.result_len as usize]
    }

    pub(crate) fn raw_output(&self) -> &[u8] {
        words_as_bytes(&self.output)
    }

    pub(crate) fn workspace(&self) -> Option<&CubicFillWorkspace> {
        self.workspace.as_ref()
    }

    /// E14-U2 X-A5: the workspace, for the `cfg(test)` limits override.
    #[cfg(test)]
    pub(crate) fn workspace_mut(&mut self) -> Option<&mut CubicFillWorkspace> {
        self.workspace.as_mut()
    }

    pub(crate) fn heap_bytes(&self) -> usize {
        self.heap_bytes
    }

    pub(crate) fn set_epoch(&mut self, epoch: u32) {
        self.epoch = epoch;
    }

    pub(crate) fn is_disposed(&self) -> bool {
        self.disposed
    }

    pub(crate) fn storage(&self) -> [(usize, usize); 7] {
        [
            (self.input.as_ptr() as usize, self.input.capacity()),
            (self.output.as_ptr() as usize, self.output.capacity()),
            (
                self.scratch.triangles.as_ptr() as usize,
                self.scratch.triangles.capacity(),
            ),
            (
                self.scratch.edges.as_ptr() as usize,
                self.scratch.edges.capacity(),
            ),
            (
                self.scratch.boundary.as_ptr() as usize,
                self.scratch.boundary.capacity(),
            ),
            (
                self.scratch.split.as_ptr() as usize,
                self.scratch.split.capacity(),
            ),
            self.ladder.as_ref().map_or((0, 0), |ladder| {
                (
                    core::ptr::from_ref(ladder.fast()) as usize,
                    ladder.allocated_bytes(),
                )
            }),
        ]
    }

    #[cfg(test)]
    pub(crate) fn scratch_sizes() -> Option<(usize, usize, usize)> {
        FillScratch::sizes(FILL_V0_LIMITS)
    }

    /// The bytes of the production fill scratch, which since E14-K1 item 5 also holds rung 0's
    /// AL-FR9 records at E0, and since E14-U2 is sized for the exact rung's large tier.
    #[cfg(test)]
    pub(crate) fn scratch_bytes() -> usize {
        FillScratch::sizes_for(
            FILL_V0_LARGE_LIMITS,
            crate::fill_ladder::MAX_BOUNDARY_RECORDS,
        )
        .expect("scratch sizes")
        .2
    }
}

fn words_for(bytes: u32) -> usize {
    (bytes as usize).div_ceil(8)
}

fn grow_zeroed(storage: &mut Vec<u64>, length: usize) -> bool {
    if length <= storage.len() {
        return true;
    }
    if storage.try_reserve_exact(length - storage.len()).is_err() {
        return false;
    }
    storage.resize(length, 0);
    true
}

fn words_as_bytes(words: &[u64]) -> &[u8] {
    // SAFETY: u8 has alignment one, every u64 bit pattern is valid, and the
    // byte length is exactly eight times the source length.
    unsafe { core::slice::from_raw_parts(words.as_ptr().cast(), words.len() * 8) }
}

fn words_as_bytes_mut(words: &mut [u64]) -> &mut [u8] {
    // SAFETY: same representation argument as words_as_bytes; the mutable
    // borrow guarantees exclusive access for the returned byte slice.
    unsafe { core::slice::from_raw_parts_mut(words.as_mut_ptr().cast(), words.len() * 8) }
}
