use core::mem::size_of;

use crate::codec::PathInput;
use crate::geometry::{
    run_path, Bounds, Pass, Plan, Point, Provenance, WorkStatistics, PATH_OK, VERB_CLOSE,
    VERB_CUBIC, VERB_LINE, VERB_MOVE,
};
use crate::line_fill::LineFillRule;
use crate::rounded_line_fill::{
    RoundedFillError, RoundedFillLimits, RoundedFillOutput, RoundedFillStats, RoundedFillWorkspace,
};
use crate::simple_cubic_topology::{
    RoundedKnotCubicTopologyWorkspace, SimpleCubicTopologyWorkspace, TopologyCubic, TopologyError,
    TopologyInput, TopologyLeaf, TopologyLimits, TopologyRange, TopologyStats,
    TransverseArrangementWorkspace,
};

// D8 B1 kernel caps (`docs/plans/p3-fill-stroke-meshes.md`, "B1 kernel caps"). A path holds at
// most MAX_CONTOURS contours, MAX_SOURCE_SEGMENTS source segments and MAX_EDGE_OWNERS flattened
// edges; the roadmap's 32 cubics at λ = 8 are 256 leaves. The other caps follow from those three
// as the pre-B1 caps (4, 16, 64 → 24, 104, 68, 72) did: one MOVE and one CLOSE per contour, six
// scalars per cubic and two per MOVE, and one repeated start point per contour before
// `finish_*_contour` drops it.
pub(crate) const MAX_CONTOURS: usize = 4;
pub(crate) const MAX_SOURCE_SEGMENTS: usize = 64;
pub(crate) const MAX_EDGE_OWNERS: usize = 256;
pub(crate) const MAX_FLAT_COMMANDS: usize = MAX_EDGE_OWNERS + 2 * MAX_CONTOURS;
const MAX_SOURCE_VERBS: usize = MAX_SOURCE_SEGMENTS + 2 * MAX_CONTOURS;
const MAX_SOURCE_SCALARS: usize = 6 * MAX_SOURCE_SEGMENTS + 2 * MAX_CONTOURS;
pub(crate) const MAX_CONTOUR_POINTS: usize = MAX_EDGE_OWNERS + MAX_CONTOURS;
// E14-K1 (`docs/plans/d9-e14-fill-rung0-edge-cap-contract.md` section 3): rung 0's own edge cap
// E0. Only the prefix run that feeds rung 0 enforces it; the exact rung keeps MAX_EDGE_OWNERS
// and `FILL_V0_LIMITS`. The command and point caps follow from E0 as the B1 ones do from E.
pub(crate) const MAX_FAST_EDGE_OWNERS: usize = 8_192;
// E16-K1 (`docs/plans/d9-e16-fill-rejection-remedy-contract.md` section 3): rung 0's own source
// caps, 512 contours (the stroke instance's `MAX_PIECES`) and E0 segments.
pub(crate) const MAX_FAST_CONTOURS: usize = 512;
pub(crate) const MAX_FAST_SOURCE_SEGMENTS: usize = MAX_FAST_EDGE_OWNERS;
pub(crate) const MAX_FAST_FLAT_COMMANDS: usize = MAX_FAST_EDGE_OWNERS + 2 * MAX_FAST_CONTOURS;
const MAX_FAST_SOURCE_VERBS: usize = MAX_FAST_SOURCE_SEGMENTS + 2 * MAX_FAST_CONTOURS;
const MAX_FAST_SOURCE_SCALARS: usize = 6 * MAX_FAST_SOURCE_SEGMENTS + 2 * MAX_FAST_CONTOURS;
pub(crate) const MAX_FAST_CONTOUR_POINTS: usize = MAX_FAST_EDGE_OWNERS + MAX_FAST_CONTOURS;
// E16-K1 item 2: the exact rung's caps on a line-only path, which builds no topology
// certificate: 64 contours and E segments. `MAX_EXACT_FLAT_COMMANDS` is the command capacity
// the exact callers pass; `emit` bounds it by the path kind's caps, so a cubic path keeps
// `MAX_FLAT_COMMANDS`.
pub(crate) const MAX_LINE_CONTOURS: usize = 64;
const MAX_LINE_SOURCE_SEGMENTS: usize = MAX_EDGE_OWNERS;
pub(crate) const MAX_EXACT_FLAT_COMMANDS: usize = MAX_EDGE_OWNERS + 2 * MAX_LINE_CONTOURS;
const MAX_COMBINED_HEAP_BYTES: usize = 16 * 1024 * 1024;

/// The prefix caps one prefix run enforces. The prefix buffers are always sized for the fast
/// caps (E14-K1). A workspace's exact rung enforces `B1_CAPS` and its rung-0 prefix
/// `FAST_CAPS`, unless a `cfg(test)` constructor selects `PRE_B1_CAPS` for both.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PrefixCaps {
    contours: usize,
    source_verbs: usize,
    source_scalars: usize,
    source_segments: usize,
    flat_commands: usize,
    contour_points: usize,
    edge_owners: usize,
}

const B1_CAPS: PrefixCaps = PrefixCaps {
    contours: MAX_CONTOURS,
    source_verbs: MAX_SOURCE_VERBS,
    source_scalars: MAX_SOURCE_SCALARS,
    source_segments: MAX_SOURCE_SEGMENTS,
    flat_commands: MAX_FLAT_COMMANDS,
    contour_points: MAX_CONTOUR_POINTS,
    edge_owners: MAX_EDGE_OWNERS,
};

/// E16-K1 item 2: the exact rung's caps on a line-only path. The rounded line fill takes at
/// most `limits.max_contours` contours and `limits.max_edges` edges, so the line-only contour
/// and segment caps are those limits clamped between B1's cubic caps and 64 contours and E
/// segments: `FILL_V0_LIMITS` gives 64 and E, and the frozen native test limits (4 contours,
/// 64 edges) give exactly `B1_CAPS`.
const fn line_caps(limits: RoundedFillLimits) -> PrefixCaps {
    let contours = clamp(limits.max_contours, MAX_CONTOURS, MAX_LINE_CONTOURS);
    let segments = clamp(
        limits.max_edges,
        MAX_SOURCE_SEGMENTS,
        MAX_LINE_SOURCE_SEGMENTS,
    );
    PrefixCaps {
        contours,
        source_verbs: segments + 2 * contours,
        source_scalars: 6 * segments + 2 * contours,
        source_segments: segments,
        flat_commands: MAX_EDGE_OWNERS + 2 * contours,
        contour_points: MAX_EDGE_OWNERS + contours,
        edge_owners: MAX_EDGE_OWNERS,
    }
}

const fn clamp(value: usize, low: usize, high: usize) -> usize {
    if value < low {
        low
    } else if value > high {
        high
    } else {
        value
    }
}

/// E14-K1 item 2 and E16-K1 item 1: the caps of the prefix run that feeds rung 0 in a
/// production workspace.
const FAST_CAPS: PrefixCaps = PrefixCaps {
    contours: MAX_FAST_CONTOURS,
    source_verbs: MAX_FAST_SOURCE_VERBS,
    source_scalars: MAX_FAST_SOURCE_SCALARS,
    source_segments: MAX_FAST_SOURCE_SEGMENTS,
    flat_commands: MAX_FAST_FLAT_COMMANDS,
    contour_points: MAX_FAST_CONTOUR_POINTS,
    edge_owners: MAX_FAST_EDGE_OWNERS,
};

/// B1's test-only pre-B1 cap mode (`docs/plans/p3-fill-stroke-meshes.md`, "B1 kernel caps"):
/// the caps before B1, so that the frozen oracles (SL-O4 against the 2026-10-17 record, AL-I3
/// against the frozen spike) compare like with like. Unreachable outside `cfg(test)`.
#[cfg(test)]
const PRE_B1_CAPS: PrefixCaps = PrefixCaps {
    contours: 4,
    source_verbs: 24,
    source_scalars: 104,
    source_segments: 16,
    flat_commands: 72,
    contour_points: 68,
    edge_owners: 64,
};

/// The topology limits before B1 (`TopologyLimits::default()` was these values).
#[cfg(test)]
const PRE_B1_TOPOLOGY_LIMITS: TopologyLimits = TopologyLimits {
    max_contours: 4,
    max_cubics: 16,
    max_leaves: 64,
    max_pairs: 2_016,
    max_bytes: 1024 * 1024,
};

/// E16-K1 item 5, for the allocation tests: the bytes of the four source buffers, sized for
/// the fast caps.
#[cfg(test)]
pub(crate) const fn source_buffer_bytes() -> usize {
    MAX_FAST_SOURCE_VERBS * size_of::<SourceVerb>()
        + MAX_FAST_SOURCE_SEGMENTS * size_of::<DecodedSource>()
        + MAX_FAST_CONTOURS * size_of::<TopologyRange>()
        + MAX_FAST_CONTOURS * size_of::<ContourRange>()
}

/// A heap buffer of `length` copies of `value`, reserved fallibly (E14-K1 item 4). A refusal
/// reuses the workspaces' allocation error, which `construction_status` maps to
/// `BATCH_ALLOCATION_FAILED`.
fn filled<T: Copy>(value: T, length: usize) -> Result<Vec<T>, CubicFillError> {
    let mut buffer = Vec::new();
    buffer
        .try_reserve_exact(length)
        .map_err(|_| CubicFillError::Rounded(RoundedFillError::AllocationFailed))?;
    buffer.resize(length, value);
    Ok(buffer)
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct FlatCommand {
    pub(crate) verb: u8,
    pub(crate) point: Option<Point>,
    pub(crate) provenance: Provenance,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ContourRange {
    pub(crate) start: usize,
    pub(crate) count: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EdgeOwner {
    Line {
        source_verb: u32,
    },
    CubicLeaf {
        source_verb: u32,
        end_numerator: u32,
        depth: u32,
    },
    ImplicitClosure {
        contour: usize,
    },
    ExplicitClose {
        source_verb: u32,
    },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum DecodedSource {
    Line {
        points: [Point; 2],
        source_verb: u32,
        contour: usize,
    },
    Cubic {
        points: [Point; 4],
        source_verb: u32,
        contour: usize,
    },
}

impl Default for DecodedSource {
    fn default() -> Self {
        Self::Line {
            points: [Point::default(); 2],
            source_verb: 0,
            contour: 0,
        }
    }
}

impl DecodedSource {
    pub(crate) fn source_verb(self) -> u32 {
        match self {
            Self::Line { source_verb, .. } | Self::Cubic { source_verb, .. } => source_verb,
        }
    }

    pub(crate) fn contour(self) -> usize {
        match self {
            Self::Line { contour, .. } | Self::Cubic { contour, .. } => contour,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CubicFillError {
    SourceLimit,
    UnsupportedSource,
    CommandLimit,
    EmissionStatus(u32),
    PlanMismatch,
    BoundsMismatch,
    InvalidCommand,
    InvalidProvenance,
    ContourLimit,
    PointLimit,
    OwnerLimit,
    ZeroLengthLeaf,
    Topology(TopologyError),
    TopologyOwnership,
    CombinedByteLimit,
    Rounded(RoundedFillError),
    RoundedOwnership,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct CubicFillDiagnostics {
    pub(crate) sizing_invoked: bool,
    pub(crate) emission_invoked: bool,
    pub(crate) topology_invoked: bool,
    pub(crate) rounded_topology_invoked: bool,
    pub(crate) rounded_topology_selected: bool,
    pub(crate) rounded_topology_error: Option<TopologyError>,
    pub(crate) transverse_topology_invoked: bool,
    pub(crate) transverse_topology_selected: bool,
    pub(crate) transverse_topology_error: Option<TopologyError>,
    pub(crate) rounded_invoked: bool,
    pub(crate) flat_status: u32,
    pub(crate) sizing_plan: Plan,
    pub(crate) emission_plan: Option<Plan>,
    pub(crate) flat_bounds: Option<Bounds>,
    pub(crate) statistics: WorkStatistics,
}

#[derive(Clone, Copy)]
pub(crate) struct CubicFillOutput<'a> {
    pub(crate) commands: &'a [FlatCommand],
    pub(crate) ranges: &'a [ContourRange],
    pub(crate) points: &'a [Point],
    pub(crate) owners: &'a [EdgeOwner],
    pub(crate) sources: &'a [DecodedSource],
    pub(crate) rounded: RoundedFillOutput<'a>,
    pub(crate) rounded_stats: RoundedFillStats,
}

/// Borrowed views of the S1 state after the prefix (Alt-A1 production contract
/// `docs/plans/p3-alt-a1-fill-ladder-contract.md` section 1.2; spike section 2.2).
#[derive(Clone, Copy, Debug)]
pub(crate) struct S1View<'a> {
    pub(crate) commands: &'a [FlatCommand],
    pub(crate) ranges: &'a [ContourRange],
    pub(crate) points: &'a [Point],
    pub(crate) owners: &'a [EdgeOwner],
    pub(crate) sources: &'a [DecodedSource],
}

/// A failed S1 prefix: a sizing status other than `PATH_OK`, or an error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PrefixFailure {
    Sizing(u32),
    Error(CubicFillError),
}

#[derive(Clone, Copy, Debug)]
enum SourceVerb {
    Unused,
    Move { contour: usize, point: Point },
    Line { contour: usize, end: Point },
    Cubic { contour: usize },
    Close { contour: usize },
}

#[derive(Clone, Copy)]
enum TopologyMode {
    Legacy,
    Arrangement(ArrangementMode),
}

#[derive(Clone, Copy)]
enum ArrangementMode {
    Cubic,
    Mixed,
    TriangleFree,
}

#[derive(Clone, Copy, Debug)]
struct ActiveSourceContour {
    contour: usize,
    segment_start: usize,
    current: Point,
}

#[derive(Clone, Copy)]
struct ActiveContour {
    source_contour: usize,
    point_start: usize,
    previous: Point,
}

pub(crate) struct CubicFillWorkspace {
    rounded: RoundedFillWorkspace,
    topology: SimpleCubicTopologyWorkspace,
    rounded_topology: RoundedKnotCubicTopologyWorkspace,
    transverse_topology: TransverseArrangementWorkspace,
    /// E16-K1 item 5: heap buffers sized for the fast source caps, reserved once at
    /// construction.
    source_verbs: Vec<SourceVerb>,
    source_verb_len: usize,
    sources: Vec<DecodedSource>,
    source_len: usize,
    source_ranges: Vec<TopologyRange>,
    source_range_len: usize,
    /// E14-K1 item 4: heap buffers of `MAX_FAST_*` elements, reserved once at construction.
    commands: Vec<FlatCommand>,
    command_len: usize,
    contour_points: Vec<Point>,
    point_len: usize,
    contour_ranges: Vec<ContourRange>,
    range_len: usize,
    edge_owners: Vec<EdgeOwner>,
    owner_len: usize,
    diagnostics: CubicFillDiagnostics,
    topology_stats: TopologyStats,
    published: bool,
    /// The exact rung's caps (`attempt*`, `certify_topology`).
    caps: PrefixCaps,
    /// The exact rung's caps on a line-only path (E16-K1 item 2).
    line_caps: PrefixCaps,
    /// E16-K2 item 8: refinement retries, off in the pre-B1 mode.
    refines: bool,
    /// The caps of the prefix run that feeds rung 0 (`prepare_prefix`, E14-K1 item 2).
    fast_caps: PrefixCaps,
    /// The caps of the current prefix run: `caps` or `fast_caps`.
    prefix_caps: PrefixCaps,
}

impl CubicFillWorkspace {
    pub(crate) fn new(limits: RoundedFillLimits) -> Result<Self, CubicFillError> {
        Self::with_caps(
            limits,
            B1_CAPS,
            line_caps(limits),
            FAST_CAPS,
            TopologyLimits::default(),
        )
    }

    /// B1's test-only pre-B1 cap mode: the prefix and topology caps before B1. The caller passes
    /// the matching rounded limits (`fill_export::PRE_B1_FILL_V0_LIMITS` or the native `LIMITS`).
    #[cfg(test)]
    pub(crate) fn new_pre_b1(limits: RoundedFillLimits) -> Result<Self, CubicFillError> {
        Self::with_caps(
            limits,
            PRE_B1_CAPS,
            PRE_B1_CAPS,
            PRE_B1_CAPS,
            PRE_B1_TOPOLOGY_LIMITS,
        )
    }

    fn with_caps(
        limits: RoundedFillLimits,
        caps: PrefixCaps,
        line_caps: PrefixCaps,
        fast_caps: PrefixCaps,
        topology_limits: TopologyLimits,
    ) -> Result<Self, CubicFillError> {
        let workspace = Self {
            rounded: RoundedFillWorkspace::new(limits).map_err(CubicFillError::Rounded)?,
            topology: SimpleCubicTopologyWorkspace::new(topology_limits)
                .map_err(CubicFillError::Topology)?,
            rounded_topology: RoundedKnotCubicTopologyWorkspace::new(topology_limits)
                .map_err(CubicFillError::Topology)?,
            transverse_topology: TransverseArrangementWorkspace::new(topology_limits)
                .map_err(CubicFillError::Topology)?,
            source_verbs: filled(SourceVerb::Unused, MAX_FAST_SOURCE_VERBS)?,
            source_verb_len: 0,
            sources: filled(DecodedSource::default(), MAX_FAST_SOURCE_SEGMENTS)?,
            source_len: 0,
            source_ranges: filled(TopologyRange::default(), MAX_FAST_CONTOURS)?,
            source_range_len: 0,
            commands: filled(FlatCommand::default(), MAX_FAST_FLAT_COMMANDS)?,
            command_len: 0,
            contour_points: filled(Point::default(), MAX_FAST_CONTOUR_POINTS)?,
            point_len: 0,
            contour_ranges: filled(ContourRange::default(), MAX_FAST_CONTOURS)?,
            range_len: 0,
            edge_owners: filled(
                EdgeOwner::ImplicitClosure { contour: 0 },
                MAX_FAST_EDGE_OWNERS,
            )?,
            owner_len: 0,
            diagnostics: CubicFillDiagnostics::default(),
            topology_stats: TopologyStats::default(),
            published: false,
            caps,
            line_caps,
            refines: caps == B1_CAPS,
            fast_caps,
            prefix_caps: caps,
        };
        if workspace
            .combined_bytes()
            .is_none_or(|bytes| bytes > MAX_COMBINED_HEAP_BYTES)
        {
            return Err(CubicFillError::CombinedByteLimit);
        }
        Ok(workspace)
    }

    /// The retained heap bytes: the four topology and rounded workspaces and, since E14-K1
    /// item 4 and E16-K1 item 5, the prefix and source buffers.
    fn combined_bytes(&self) -> Option<usize> {
        let prefix = self
            .commands
            .capacity()
            .checked_mul(size_of::<FlatCommand>())?
            .checked_add(
                self.contour_points
                    .capacity()
                    .checked_mul(size_of::<Point>())?,
            )?
            .checked_add(
                self.edge_owners
                    .capacity()
                    .checked_mul(size_of::<EdgeOwner>())?,
            )?
            .checked_add(
                self.source_verbs
                    .capacity()
                    .checked_mul(size_of::<SourceVerb>())?,
            )?
            .checked_add(
                self.sources
                    .capacity()
                    .checked_mul(size_of::<DecodedSource>())?,
            )?
            .checked_add(
                self.source_ranges
                    .capacity()
                    .checked_mul(size_of::<TopologyRange>())?,
            )?
            .checked_add(
                self.contour_ranges
                    .capacity()
                    .checked_mul(size_of::<ContourRange>())?,
            )?;
        self.rounded
            .allocated_bytes()
            .checked_add(self.topology.allocated_bytes())
            .and_then(|bytes| bytes.checked_add(self.rounded_topology.allocated_bytes()))
            .and_then(|bytes| bytes.checked_add(self.transverse_topology.allocated_bytes()))
            .and_then(|bytes| bytes.checked_add(prefix))
    }

    pub(crate) fn allocated_bytes(&self) -> usize {
        self.combined_bytes()
            .expect("constructor validated combined retained capacities")
    }

    /// E16-K2 item 8: whether the exact rung retries at finer tolerances after a topology
    /// failure; false in the test-only pre-B1 mode.
    pub(crate) fn refines(&self) -> bool {
        #[cfg(test)]
        if E16_NO_REFINEMENT.with(core::cell::Cell::get) {
            return false;
        }
        self.refines
    }

    /// The exact rung's caps for this path (E16-K1 item 2): the line-only caps when the path
    /// has no CUBIC verb, otherwise the cubic caps of B1.
    fn exact_caps(&self, input: PathInput<'_>) -> PrefixCaps {
        #[cfg(test)]
        if E16_CUBIC_LINE_CAPS.with(core::cell::Cell::get) {
            return self.line_caps;
        }
        if input.verbs.iter().all(|verb| *verb != VERB_CUBIC) {
            self.line_caps
        } else {
            self.caps
        }
    }

    /// The edge cap of the prefix run that feeds rung 0 (E14-K1 item 2): E0 in a production
    /// workspace, the pre-B1 cap in the test-only pre-B1 mode.
    pub(crate) fn fast_edge_owners(&self) -> usize {
        self.fast_caps.edge_owners
    }

    /// The flat command cap of the prefix run that feeds rung 0, the command capacity
    /// `FillLadder::fast_rung_until` passes to `prepare_prefix`.
    pub(crate) fn fast_flat_commands(&self) -> usize {
        self.fast_caps.flat_commands
    }

    /// The contour point cap of the prefix run that feeds rung 0, from which
    /// `FillLadder::reserve` derives AL-FR9's boundary record count (E14-K1 item 5).
    pub(crate) fn fast_contour_points(&self) -> usize {
        self.fast_caps.contour_points
    }

    /// The contour cap of the prefix run that feeds rung 0 (E16-K1 item 1), the h of AL-FR9's
    /// boundary record bound.
    pub(crate) fn fast_contours(&self) -> usize {
        self.fast_caps.contours
    }

    pub(crate) fn diagnostics(&self) -> CubicFillDiagnostics {
        self.diagnostics
    }

    pub(crate) fn topology_stats(&self) -> TopologyStats {
        self.topology_stats
    }

    pub(crate) fn rounded_stats(&self) -> RoundedFillStats {
        self.rounded.stats()
    }

    pub(crate) fn attempt(
        &mut self,
        input: PathInput<'_>,
        rule: LineFillRule,
        topology_tolerance: f64,
        command_capacity: usize,
    ) -> Result<CubicFillDiagnostics, CubicFillError> {
        self.attempt_body(
            input,
            rule,
            topology_tolerance,
            command_capacity,
            TopologyMode::Legacy,
        )
    }

    pub(crate) fn attempt_transverse(
        &mut self,
        input: PathInput<'_>,
        rule: LineFillRule,
        topology_tolerance: f64,
        command_capacity: usize,
    ) -> Result<CubicFillDiagnostics, CubicFillError> {
        self.attempt_body(
            input,
            rule,
            topology_tolerance,
            command_capacity,
            TopologyMode::Arrangement(ArrangementMode::Cubic),
        )
    }

    pub(crate) fn attempt_mixed_transverse(
        &mut self,
        input: PathInput<'_>,
        rule: LineFillRule,
        topology_tolerance: f64,
        command_capacity: usize,
    ) -> Result<CubicFillDiagnostics, CubicFillError> {
        self.attempt_body(
            input,
            rule,
            topology_tolerance,
            command_capacity,
            TopologyMode::Arrangement(ArrangementMode::Mixed),
        )
    }

    pub(crate) fn attempt_triangle_free(
        &mut self,
        input: PathInput<'_>,
        rule: LineFillRule,
        topology_tolerance: f64,
        command_capacity: usize,
    ) -> Result<CubicFillDiagnostics, CubicFillError> {
        self.attempt_body(
            input,
            rule,
            topology_tolerance,
            command_capacity,
            TopologyMode::Arrangement(ArrangementMode::TriangleFree),
        )
    }

    fn attempt_body(
        &mut self,
        input: PathInput<'_>,
        rule: LineFillRule,
        topology_tolerance: f64,
        command_capacity: usize,
        topology_mode: TopologyMode,
    ) -> Result<CubicFillDiagnostics, CubicFillError> {
        // E14-D1: the seeded defect runs the exact rung with the fast caps and command count.
        #[cfg(test)]
        let (caps, command_capacity) = if E14_EXACT_FAST_CAPS.with(core::cell::Cell::get) {
            (self.fast_caps, self.fast_caps.flat_commands)
        } else {
            (self.exact_caps(input), command_capacity)
        };
        #[cfg(not(test))]
        let caps = self.exact_caps(input);
        let all_line_eligible = match self.run_prefix(input, command_capacity, true, caps) {
            Ok(all_line_eligible) => all_line_eligible,
            Err(PrefixFailure::Sizing(_)) => return Ok(self.diagnostics),
            Err(PrefixFailure::Error(error)) => return Err(error),
        };
        #[cfg(p3_b0_diag)]
        if crate::p3_b0_diag::stop_stage() == crate::p3_b0_diag::STAGE_S1 {
            return Ok(self.diagnostics);
        }
        if !all_line_eligible {
            self.diagnostics.topology_invoked = true;
            self.certify_topology(topology_mode)?;
        }
        #[cfg(p3_b0_diag)]
        if crate::p3_b0_diag::stop_stage() == crate::p3_b0_diag::STAGE_S2 {
            return Ok(self.diagnostics);
        }

        // E16-K1 item 2, guard: the array holds the line-only contour cap.
        if self.range_len > MAX_LINE_CONTOURS {
            return Err(CubicFillError::SourceLimit);
        }
        let mut references: [&[Point]; MAX_LINE_CONTOURS] = [&[]; MAX_LINE_CONTOURS];
        for (index, range) in self.contour_ranges[..self.range_len]
            .iter()
            .copied()
            .enumerate()
        {
            references[index] = &self.contour_points[range.start..range.start + range.count];
        }
        self.diagnostics.rounded_invoked = true;
        self.rounded
            .tessellate(&references[..self.range_len], rule, topology_tolerance)
            .map_err(CubicFillError::Rounded)?;
        self.validate_rounded_ownership()?;
        self.published = true;
        Ok(self.diagnostics)
    }

    /// The Alt-A1 S1 prefix (production contract section 1.2), the production form of the
    /// spike's `cfg(test)` `prepare_for_spike`: the prefix statements of `attempt_body`, then
    /// borrowed views of the S1 state. It publishes nothing; a later `attempt*` call re-runs the
    /// same prefix on the same input. It enforces the workspace's fast caps (E14-K1 item 2) and
    /// at most `command_capacity` flat commands, so a caller that passes `MAX_FLAT_COMMANDS`
    /// still gets the exact rung's command cap.
    pub(crate) fn prepare_prefix(
        &mut self,
        input: PathInput<'_>,
        command_capacity: usize,
    ) -> Result<S1View<'_>, PrefixFailure> {
        self.run_prefix(input, command_capacity, false, self.fast_caps)?;
        Ok(S1View {
            commands: &self.commands[..self.command_len],
            ranges: &self.contour_ranges[..self.range_len],
            points: &self.contour_points[..self.point_len],
            owners: &self.edge_owners[..self.owner_len],
            sources: &self.sources[..self.source_len],
        })
    }

    /// The statements of `attempt_body` up to the B0 stop point S1, in their order. Returns
    /// `all_line_eligible`, a sizing status other than `PATH_OK`, or the first error.
    /// `canonical_final_knots` is set only by `attempt_body` (the exact rung): it runs the E8-U2
    /// snap between `emit` and `collect_contours` (E8 addendum section E8.4). `caps` are the
    /// caller's prefix caps (E14-K1 item 2).
    fn run_prefix(
        &mut self,
        input: PathInput<'_>,
        command_capacity: usize,
        canonical_final_knots: bool,
        caps: PrefixCaps,
    ) -> Result<bool, PrefixFailure> {
        self.begin_attempt();
        self.prefix_caps = caps;
        if input.verbs.len() > self.prefix_caps.source_verbs
            || input.point_count() > self.prefix_caps.source_scalars
        {
            return Err(PrefixFailure::Error(CubicFillError::SourceLimit));
        }

        self.diagnostics.sizing_invoked = true;
        let (sizing_plan, sizing_bounds) = run_path(
            input,
            Pass::Sizing,
            &mut self.diagnostics.statistics,
            |_, _, _| true,
        );
        self.diagnostics.flat_status = sizing_plan.status;
        self.diagnostics.sizing_plan = sizing_plan;
        if sizing_plan.status != PATH_OK {
            return Err(PrefixFailure::Sizing(sizing_plan.status));
        }

        let all_line_eligible = input.verbs.iter().all(|verb| *verb != VERB_CUBIC);
        self.decode_sources(input, all_line_eligible)
            .map_err(PrefixFailure::Error)?;
        self.emit(input, sizing_plan, sizing_bounds, command_capacity)
            .map_err(PrefixFailure::Error)?;
        #[cfg(test)]
        if E8_COLLAPSE_FINAL_LEAF.with(core::cell::Cell::get) {
            self.e8_test_collapse_final_leaf();
        }
        if canonical_final_knots {
            self.snap_final_knots();
        }
        self.collect_contours(all_line_eligible)
            .map_err(PrefixFailure::Error)?;
        self.validate_leaf_partitions()
            .map_err(PrefixFailure::Error)?;
        Ok(all_line_eligible)
    }

    pub(crate) fn output(&self) -> Option<CubicFillOutput<'_>> {
        if !self.published {
            return None;
        }
        Some(CubicFillOutput {
            commands: &self.commands[..self.command_len],
            ranges: &self.contour_ranges[..self.range_len],
            points: &self.contour_points[..self.point_len],
            owners: &self.edge_owners[..self.owner_len],
            sources: &self.sources[..self.source_len],
            rounded: self.rounded.output()?,
            rounded_stats: self.rounded.stats(),
        })
    }

    fn begin_attempt(&mut self) {
        self.source_verb_len = 0;
        self.source_len = 0;
        self.source_range_len = 0;
        self.command_len = 0;
        self.point_len = 0;
        self.range_len = 0;
        self.owner_len = 0;
        self.diagnostics = CubicFillDiagnostics::default();
        self.published = false;
        self.prefix_caps = self.caps;
    }

    fn decode_sources(
        &mut self,
        input: PathInput<'_>,
        allow_empty_ranges: bool,
    ) -> Result<(), CubicFillError> {
        let mut scalar = 0usize;
        let mut active = None;
        for (ordinal, verb) in input.verbs.iter().copied().enumerate() {
            let source_verb = u32::try_from(ordinal).map_err(|_| CubicFillError::SourceLimit)?;
            match verb {
                VERB_MOVE => {
                    if let Some(open) = active.take() {
                        self.finish_source(open, allow_empty_ranges)?;
                    }
                    if self.source_range_len >= self.prefix_caps.contours {
                        return Err(CubicFillError::SourceLimit);
                    }
                    let point = read_source_point(input, scalar)?;
                    scalar = scalar
                        .checked_add(2)
                        .ok_or(CubicFillError::UnsupportedSource)?;
                    let contour = self.source_range_len;
                    self.source_verbs[ordinal] = SourceVerb::Move { contour, point };
                    active = Some(ActiveSourceContour {
                        contour,
                        segment_start: self.source_len,
                        current: point,
                    });
                }
                VERB_LINE => {
                    let mut open = active.ok_or(CubicFillError::UnsupportedSource)?;
                    if self.source_len >= self.prefix_caps.source_segments {
                        return Err(CubicFillError::SourceLimit);
                    }
                    let end = read_source_point(input, scalar)?;
                    scalar = scalar
                        .checked_add(2)
                        .ok_or(CubicFillError::UnsupportedSource)?;
                    self.sources[self.source_len] = DecodedSource::Line {
                        points: [open.current, end],
                        source_verb,
                        contour: open.contour,
                    };
                    self.source_len += 1;
                    self.source_verbs[ordinal] = SourceVerb::Line {
                        contour: open.contour,
                        end,
                    };
                    open.current = end;
                    active = Some(open);
                }
                VERB_CUBIC => {
                    let mut open = active.ok_or(CubicFillError::UnsupportedSource)?;
                    if self.source_len >= self.prefix_caps.source_segments {
                        return Err(CubicFillError::SourceLimit);
                    }
                    let one = read_source_point(input, scalar)?;
                    let two = read_source_point(
                        input,
                        scalar
                            .checked_add(2)
                            .ok_or(CubicFillError::UnsupportedSource)?,
                    )?;
                    let end = read_source_point(
                        input,
                        scalar
                            .checked_add(4)
                            .ok_or(CubicFillError::UnsupportedSource)?,
                    )?;
                    scalar = scalar
                        .checked_add(6)
                        .ok_or(CubicFillError::UnsupportedSource)?;
                    self.sources[self.source_len] = DecodedSource::Cubic {
                        points: [open.current, one, two, end],
                        source_verb,
                        contour: open.contour,
                    };
                    self.source_len += 1;
                    self.source_verbs[ordinal] = SourceVerb::Cubic {
                        contour: open.contour,
                    };
                    open.current = end;
                    active = Some(open);
                }
                VERB_CLOSE => {
                    let open = active.take().ok_or(CubicFillError::UnsupportedSource)?;
                    self.source_verbs[ordinal] = SourceVerb::Close {
                        contour: open.contour,
                    };
                    self.finish_source(open, allow_empty_ranges)?;
                }
                _ => return Err(CubicFillError::UnsupportedSource),
            }
        }
        if let Some(open) = active {
            self.finish_source(open, allow_empty_ranges)?;
        }
        if scalar != input.point_count() || self.source_range_len == 0 {
            return Err(CubicFillError::UnsupportedSource);
        }
        self.source_verb_len = input.verbs.len();
        Ok(())
    }

    fn finish_source(
        &mut self,
        open: ActiveSourceContour,
        allow_empty_range: bool,
    ) -> Result<(), CubicFillError> {
        if self.source_len == open.segment_start && !allow_empty_range {
            return Err(CubicFillError::UnsupportedSource);
        }
        self.push_source_range(TopologyRange {
            start: open.segment_start,
            count: self.source_len - open.segment_start,
        })
    }

    fn push_source_range(&mut self, range: TopologyRange) -> Result<(), CubicFillError> {
        if self.source_range_len >= self.prefix_caps.contours {
            return Err(CubicFillError::SourceLimit);
        }
        self.source_ranges[self.source_range_len] = range;
        self.source_range_len += 1;
        Ok(())
    }

    fn emit(
        &mut self,
        input: PathInput<'_>,
        sizing_plan: Plan,
        sizing_bounds: Bounds,
        command_capacity: usize,
    ) -> Result<(), CubicFillError> {
        let bounded_capacity = command_capacity.min(self.prefix_caps.flat_commands);
        let mut exhausted = false;
        let commands = &mut self.commands;
        let command_len = &mut self.command_len;
        self.diagnostics.emission_invoked = true;
        let (emission_plan, emission_bounds) = run_path(
            input,
            Pass::Emission,
            &mut self.diagnostics.statistics,
            |verb, point, provenance| {
                if *command_len >= bounded_capacity {
                    exhausted = true;
                    return false;
                }
                commands[*command_len] = FlatCommand {
                    verb,
                    point,
                    provenance,
                };
                *command_len += 1;
                true
            },
        );
        self.diagnostics.emission_plan = Some(emission_plan);
        if exhausted {
            return Err(CubicFillError::CommandLimit);
        }
        if emission_plan.status != PATH_OK {
            return Err(CubicFillError::EmissionStatus(emission_plan.status));
        }
        if sizing_plan != emission_plan
            || usize::try_from(emission_plan.verb_count).ok() != Some(self.command_len)
            || usize::try_from(emission_plan.point_count).ok()
                != Some(
                    self.commands[..self.command_len]
                        .iter()
                        .map(|command| usize::from(command.point.is_some()) * 2)
                        .sum(),
                )
        {
            return Err(CubicFillError::PlanMismatch);
        }
        if !same_bounds_bits(sizing_bounds, emission_bounds) {
            return Err(CubicFillError::BoundsMismatch);
        }
        self.diagnostics.flat_bounds = Some(emission_bounds);
        Ok(())
    }

    /// E8-U2 (E8 addendum section E8.4): replaces the point of each cubic source's final
    /// flattened leaf (`end_numerator == 2^depth`) with the source's represented p3, before
    /// collection, so the closure rule, the zero-length rule and the source-final restriction all
    /// see the canonical knot. Counts, order and provenance are unchanged. A final leaf whose
    /// point already equals the previous emitted point is left as emitted, so collection rejects
    /// it with `ZeroLengthLeaf` as before (E8-C6). LINE sources, internal knots and CLOSE
    /// commands are not touched. A command whose provenance names no cubic source is left for
    /// collection to reject.
    fn snap_final_knots(&mut self) {
        let mut source = 0usize;
        // The previous command's point as emitted, before any snap (E8.4's zero-length rule).
        let mut emitted_previous = None;
        for index in 0..self.command_len {
            let command = self.commands[index];
            let previous = core::mem::replace(&mut emitted_previous, command.point);
            if command.verb != VERB_LINE {
                continue;
            }
            let Some(point) = command.point else {
                continue;
            };
            let provenance = command.provenance;
            if 1u32.checked_shl(provenance.depth) != Some(provenance.end_numerator) {
                continue;
            }
            // Commands and sources are both in source-verb order.
            while source < self.source_len
                && self.sources[source].source_verb() < provenance.source_verb
            {
                source += 1;
            }
            let Some(DecodedSource::Cubic {
                points,
                source_verb,
                ..
            }) = self.sources[..self.source_len].get(source).copied()
            else {
                continue;
            };
            // A point equal in value is kept with its emitted bits (for example +0 for a -0
            // endpoint), so an exact-rung output that succeeded before E8-U2 is unchanged bit
            // for bit.
            if source_verb != provenance.source_verb || same_point(point, points[3]) {
                continue;
            }
            if previous.is_some_and(|previous| same_point(previous, point)) {
                continue;
            }
            self.commands[index].point = Some(points[3]);
        }
    }

    fn certify_topology(&mut self, mode: TopologyMode) -> Result<(), CubicFillError> {
        // E16-K1 item 2, guard: the arrays below hold the cubic caps.
        if self.source_range_len > MAX_CONTOURS || self.source_len > MAX_SOURCE_SEGMENTS {
            return Err(CubicFillError::SourceLimit);
        }
        let mut contours = [TopologyRange::default(); MAX_CONTOURS];
        let mut cubics = [TopologyCubic::default(); MAX_SOURCE_SEGMENTS];
        let mut leaves = [TopologyLeaf::default(); MAX_EDGE_OWNERS];
        let mut source_kinds = [false; MAX_SOURCE_SEGMENTS];
        let mut cubic_len = 0usize;
        let mut leaf_len = 0usize;
        for (contour_index, source_range) in self.source_ranges[..self.source_range_len]
            .iter()
            .copied()
            .enumerate()
        {
            let cubic_start = cubic_len;
            for source in self.sources[source_range.start..source_range.start + source_range.count]
                .iter()
                .copied()
            {
                if matches!(source, DecodedSource::Line { points: [a, b], .. } if same_point(a, b))
                {
                    continue;
                }
                let source_verb = source.source_verb();
                let leaf_start = leaf_len;
                for command in &self.commands[..self.command_len] {
                    if command.verb != VERB_LINE || command.provenance.source_verb != source_verb {
                        continue;
                    }
                    if leaf_len >= self.caps.edge_owners {
                        return Err(CubicFillError::OwnerLimit);
                    }
                    leaves[leaf_len] = TopologyLeaf {
                        end: command.point.ok_or(CubicFillError::InvalidCommand)?,
                        provenance: command.provenance,
                    };
                    leaf_len += 1;
                }
                let (points, source_kind) = match source {
                    DecodedSource::Line { points: [a, b], .. } => ([a, a, b, b], true),
                    DecodedSource::Cubic { points, .. } => (points, false),
                };
                source_kinds[cubic_len] = source_kind;
                cubics[cubic_len] = TopologyCubic {
                    points,
                    source_verb,
                    leaves: TopologyRange {
                        start: leaf_start,
                        count: leaf_len - leaf_start,
                    },
                };
                cubic_len += 1;
            }
            contours[contour_index] = TopologyRange {
                start: cubic_start,
                count: cubic_len - cubic_start,
            };
        }
        let input = TopologyInput {
            contours: &contours[..self.source_range_len],
            cubics: &cubics[..cubic_len],
            leaves: &leaves[..leaf_len],
        };
        match mode {
            TopologyMode::Legacy => self.certify_legacy_topology(input),
            TopologyMode::Arrangement(mode) => {
                self.certify_arrangement_topology(input, mode, &source_kinds[..cubic_len])
            }
        }
    }

    fn certify_legacy_topology(&mut self, input: TopologyInput<'_>) -> Result<(), CubicFillError> {
        match self.topology.certify(input) {
            Ok(()) => {
                self.topology_stats = self.topology.stats();
                let certificate = self
                    .topology
                    .output()
                    .ok_or(CubicFillError::TopologyOwnership)?;
                self.validate_topology_ownership(certificate.points, certificate.contours)
            }
            Err(TopologyError::KnotMismatch) => {
                let exact_stats = self.topology.stats();
                self.diagnostics.rounded_topology_invoked = true;
                match self.rounded_topology.certify(input) {
                    Ok(()) => {
                        let rounded_stats = self.rounded_topology.stats();
                        self.topology_stats = add_topology_stats(exact_stats, rounded_stats);
                        self.diagnostics.rounded_topology_selected = true;
                        let certificate = self
                            .rounded_topology
                            .output()
                            .ok_or(CubicFillError::TopologyOwnership)?;
                        self.validate_topology_ownership(certificate.points, certificate.contours)
                    }
                    Err(error) => {
                        self.topology_stats =
                            add_topology_stats(exact_stats, self.rounded_topology.stats());
                        self.diagnostics.rounded_topology_error = Some(error);
                        Err(CubicFillError::Topology(TopologyError::KnotMismatch))
                    }
                }
            }
            Err(error) => {
                self.topology_stats = self.topology.stats();
                Err(CubicFillError::Topology(error))
            }
        }
    }

    fn certify_arrangement_topology(
        &mut self,
        input: TopologyInput<'_>,
        mode: ArrangementMode,
        source_kinds: &[bool],
    ) -> Result<(), CubicFillError> {
        self.diagnostics.transverse_topology_invoked = true;
        let result = match mode {
            ArrangementMode::Cubic => self.transverse_topology.certify(input),
            ArrangementMode::Mixed => self.transverse_topology.certify_mixed(input, source_kinds),
            ArrangementMode::TriangleFree => self
                .transverse_topology
                .certify_triangle_free(input, source_kinds),
        };
        match result {
            Ok(()) => {
                self.topology_stats = self.transverse_topology.stats();
                self.diagnostics.transverse_topology_selected = true;
                let certificate = self
                    .transverse_topology
                    .output()
                    .ok_or(CubicFillError::TopologyOwnership)?;
                self.validate_topology_ownership(certificate.points, certificate.contours)
            }
            Err(error) => {
                self.topology_stats = self.transverse_topology.stats();
                self.diagnostics.transverse_topology_error = Some(error);
                Err(CubicFillError::Topology(error))
            }
        }
    }

    fn validate_topology_ownership(
        &self,
        certificate_points: &[Point],
        certificate_contours: &[TopologyRange],
    ) -> Result<(), CubicFillError> {
        if certificate_contours.len() != self.range_len
            || certificate_points.len() != self.owner_len
        {
            return Err(CubicFillError::TopologyOwnership);
        }
        for (certified, collected) in certificate_contours
            .iter()
            .zip(&self.contour_ranges[..self.range_len])
        {
            if certified.count != collected.count {
                return Err(CubicFillError::TopologyOwnership);
            }
            for offset in 0..certified.count {
                if !same_point(
                    certificate_points[certified.start + offset],
                    self.contour_points[collected.start + offset],
                ) {
                    return Err(CubicFillError::TopologyOwnership);
                }
            }
        }
        Ok(())
    }

    fn collect_contours(&mut self, allow_singletons: bool) -> Result<(), CubicFillError> {
        let mut active = None;
        for command_index in 0..self.command_len {
            let command = self.commands[command_index];
            match command.verb {
                VERB_MOVE => {
                    if let Some(open) = active.take() {
                        self.finish_open_contour(open, allow_singletons)?;
                    }
                    if self.range_len >= self.prefix_caps.contours {
                        return Err(CubicFillError::ContourLimit);
                    }
                    let point = command.point.ok_or(CubicFillError::InvalidCommand)?;
                    if !finite_point(point)
                        || command.provenance.end_numerator != 1
                        || command.provenance.depth != 0
                    {
                        return Err(CubicFillError::InvalidCommand);
                    }
                    match self.source_verb(command.provenance.source_verb)? {
                        SourceVerb::Move {
                            contour,
                            point: expected,
                        } if contour == self.range_len && same_point_bits(point, expected) => {}
                        _ => return Err(CubicFillError::InvalidProvenance),
                    }
                    self.push_point(point)?;
                    active = Some(ActiveContour {
                        source_contour: self.range_len,
                        point_start: self.point_len - 1,
                        previous: point,
                    });
                }
                VERB_LINE => {
                    let mut open = active.ok_or(CubicFillError::InvalidCommand)?;
                    let point = command.point.ok_or(CubicFillError::InvalidCommand)?;
                    if !finite_point(point) {
                        return Err(CubicFillError::InvalidCommand);
                    }
                    let (owner, original_zero_line) = match self
                        .source_verb(command.provenance.source_verb)?
                    {
                        SourceVerb::Line {
                            contour,
                            end: expected,
                        } if contour == open.source_contour
                            && command.provenance.end_numerator == 1
                            && command.provenance.depth == 0
                            && same_point_bits(point, expected) =>
                        {
                            let original_zero_line =
                                match self.sources[..self.source_len].iter().copied().find(
                                    |source| source.source_verb() == command.provenance.source_verb,
                                ) {
                                    Some(DecodedSource::Line { points: [a, b], .. }) => {
                                        same_point(a, b)
                                    }
                                    _ => return Err(CubicFillError::InvalidProvenance),
                                };
                            (
                                EdgeOwner::Line {
                                    source_verb: command.provenance.source_verb,
                                },
                                original_zero_line,
                            )
                        }
                        SourceVerb::Cubic { contour } if contour == open.source_contour => (
                            EdgeOwner::CubicLeaf {
                                source_verb: command.provenance.source_verb,
                                end_numerator: command.provenance.end_numerator,
                                depth: command.provenance.depth,
                            },
                            false,
                        ),
                        _ => return Err(CubicFillError::InvalidProvenance),
                    };
                    if original_zero_line {
                        active = Some(open);
                        continue;
                    }
                    if same_point(open.previous, point) {
                        return Err(CubicFillError::ZeroLengthLeaf);
                    }
                    self.push_owner(owner)?;
                    self.push_point(point)?;
                    open.previous = point;
                    active = Some(open);
                }
                VERB_CLOSE => {
                    let open = active.take().ok_or(CubicFillError::InvalidCommand)?;
                    if command.point.is_some()
                        || command.provenance.end_numerator != 1
                        || command.provenance.depth != 0
                    {
                        return Err(CubicFillError::InvalidCommand);
                    }
                    match self.source_verb(command.provenance.source_verb)? {
                        SourceVerb::Close { contour } if contour == open.source_contour => {}
                        _ => return Err(CubicFillError::InvalidProvenance),
                    }
                    self.finish_closed_contour(
                        open,
                        command.provenance.source_verb,
                        allow_singletons,
                    )?;
                }
                _ => return Err(CubicFillError::InvalidCommand),
            }
        }
        if let Some(open) = active {
            self.finish_open_contour(open, allow_singletons)?;
        }
        if self.range_len != self.source_range_len
            || self.owner_len
                != self.contour_ranges[..self.range_len]
                    .iter()
                    .map(|range| if range.count >= 2 { range.count } else { 0 })
                    .sum()
        {
            return Err(CubicFillError::RoundedOwnership);
        }
        Ok(())
    }

    fn finish_closed_contour(
        &mut self,
        open: ActiveContour,
        close_source_verb: u32,
        allow_singleton: bool,
    ) -> Result<(), CubicFillError> {
        let first = self.contour_points[open.point_start];
        if open.source_contour != self.range_len {
            return Err(CubicFillError::InvalidCommand);
        }
        if self.point_len <= open.point_start + 1 && !allow_singleton {
            return Err(CubicFillError::ZeroLengthLeaf);
        }
        if self.point_len > open.point_start + 1 {
            if same_point(first, open.previous) {
                self.point_len -= 1;
            } else {
                self.push_owner(EdgeOwner::ExplicitClose {
                    source_verb: close_source_verb,
                })?;
            }
        }
        self.push_range(ContourRange {
            start: open.point_start,
            count: self.point_len - open.point_start,
        })
    }

    fn finish_open_contour(
        &mut self,
        open: ActiveContour,
        allow_singleton: bool,
    ) -> Result<(), CubicFillError> {
        let first = self.contour_points[open.point_start];
        if open.source_contour != self.range_len {
            return Err(CubicFillError::InvalidCommand);
        }
        if self.point_len <= open.point_start + 1 && !allow_singleton {
            return Err(CubicFillError::ZeroLengthLeaf);
        }
        if self.point_len > open.point_start + 1 {
            if same_point(first, open.previous) {
                self.point_len -= 1;
            } else {
                self.push_owner(EdgeOwner::ImplicitClosure {
                    contour: open.source_contour,
                })?;
            }
        }
        self.push_range(ContourRange {
            start: open.point_start,
            count: self.point_len - open.point_start,
        })
    }

    fn push_point(&mut self, point: Point) -> Result<(), CubicFillError> {
        if self.point_len >= self.prefix_caps.contour_points {
            return Err(CubicFillError::PointLimit);
        }
        self.contour_points[self.point_len] = point;
        self.point_len += 1;
        Ok(())
    }

    fn push_owner(&mut self, owner: EdgeOwner) -> Result<(), CubicFillError> {
        if self.owner_len >= self.prefix_caps.edge_owners {
            return Err(CubicFillError::OwnerLimit);
        }
        self.edge_owners[self.owner_len] = owner;
        self.owner_len += 1;
        Ok(())
    }

    fn push_range(&mut self, range: ContourRange) -> Result<(), CubicFillError> {
        if self.range_len >= self.prefix_caps.contours {
            return Err(CubicFillError::ContourLimit);
        }
        self.contour_ranges[self.range_len] = range;
        self.range_len += 1;
        Ok(())
    }

    fn validate_leaf_partitions(&self) -> Result<(), CubicFillError> {
        let mut previous_source = None;
        for command in &self.commands[..self.command_len] {
            if command.verb != VERB_LINE {
                continue;
            }
            if previous_source.is_some_and(|source| command.provenance.source_verb < source) {
                return Err(CubicFillError::InvalidProvenance);
            }
            previous_source = Some(command.provenance.source_verb);
        }
        for source in &self.sources[..self.source_len] {
            let source_verb = source.source_verb();
            let mut previous_numerator = 0u64;
            let mut previous_denominator = 1u64;
            let mut count = 0usize;
            for command in &self.commands[..self.command_len] {
                if command.verb != VERB_LINE || command.provenance.source_verb != source_verb {
                    continue;
                }
                if command.provenance.depth > 20 {
                    return Err(CubicFillError::InvalidProvenance);
                }
                let denominator = 1u64 << command.provenance.depth;
                let numerator = u64::from(command.provenance.end_numerator);
                if numerator == 0
                    || numerator > denominator
                    || previous_numerator * denominator != (numerator - 1) * previous_denominator
                {
                    return Err(CubicFillError::InvalidProvenance);
                }
                previous_numerator = numerator;
                previous_denominator = denominator;
                count += 1;
            }
            let valid = match source {
                DecodedSource::Line { .. } => {
                    count == 1 && previous_numerator == 1 && previous_denominator == 1
                }
                DecodedSource::Cubic { .. } => {
                    count != 0 && previous_numerator == previous_denominator
                }
            };
            if !valid {
                return Err(CubicFillError::InvalidProvenance);
            }
        }
        Ok(())
    }

    fn validate_rounded_ownership(&self) -> Result<(), CubicFillError> {
        let output = self
            .rounded
            .output()
            .ok_or(CubicFillError::RoundedOwnership)?;
        if output.source_edges.len() != self.owner_len {
            return Err(CubicFillError::RoundedOwnership);
        }
        let mut edge_index = 0usize;
        for (contour, range) in self.contour_ranges[..self.range_len]
            .iter()
            .copied()
            .enumerate()
        {
            let edge_count = if range.count >= 2 { range.count } else { 0 };
            for start_vertex in 0..edge_count {
                let source = output
                    .source_edges
                    .get(edge_index)
                    .ok_or(CubicFillError::RoundedOwnership)?;
                if source.contour != contour
                    || source.start_vertex != start_vertex
                    || source.end_vertex != (start_vertex + 1) % range.count
                {
                    return Err(CubicFillError::RoundedOwnership);
                }
                match self.edge_owners[edge_index] {
                    EdgeOwner::Line { source_verb } => {
                        let expected = match self.source_verb(source_verb)? {
                            SourceVerb::Line {
                                contour: owner,
                                end,
                            } if owner == contour => end,
                            _ => return Err(CubicFillError::RoundedOwnership),
                        };
                        if !self.commands[..self.command_len].iter().any(|command| {
                            command.verb == VERB_LINE
                                && command.provenance.source_verb == source_verb
                                && command.provenance.end_numerator == 1
                                && command.provenance.depth == 0
                                && command
                                    .point
                                    .is_some_and(|point| same_point_bits(point, expected))
                        }) {
                            return Err(CubicFillError::RoundedOwnership);
                        }
                    }
                    EdgeOwner::CubicLeaf { source_verb, .. } => {
                        if !self.commands[..self.command_len].iter().any(|command| {
                            command.verb == VERB_LINE
                                && command.provenance.source_verb == source_verb
                        }) {
                            return Err(CubicFillError::RoundedOwnership);
                        }
                    }
                    EdgeOwner::ImplicitClosure { contour: owner }
                        if owner == contour && start_vertex + 1 == range.count => {}
                    EdgeOwner::ImplicitClosure { .. } => {
                        return Err(CubicFillError::RoundedOwnership);
                    }
                    EdgeOwner::ExplicitClose { source_verb }
                        if start_vertex + 1 == range.count
                            && matches!(
                                self.source_verb(source_verb)?,
                                SourceVerb::Close { contour: owner } if owner == contour
                            )
                            && self.commands[..self.command_len].iter().any(|command| {
                                command.verb == VERB_CLOSE
                                    && command.provenance.source_verb == source_verb
                            }) => {}
                    EdgeOwner::ExplicitClose { .. } => {
                        return Err(CubicFillError::RoundedOwnership);
                    }
                }
                edge_index += 1;
            }
        }
        if edge_index != self.owner_len
            || output
                .contributors
                .iter()
                .any(|owner| *owner >= self.owner_len)
        {
            return Err(CubicFillError::RoundedOwnership);
        }
        Ok(())
    }

    fn source_verb(&self, ordinal: u32) -> Result<SourceVerb, CubicFillError> {
        self.source_verbs
            .get(usize::try_from(ordinal).map_err(|_| CubicFillError::InvalidProvenance)?)
            .copied()
            .filter(|_| usize::try_from(ordinal).is_ok_and(|index| index < self.source_verb_len))
            .ok_or(CubicFillError::InvalidProvenance)
    }
}

fn add_topology_stats(left: TopologyStats, right: TopologyStats) -> TopologyStats {
    TopologyStats {
        leaves: left.leaves + right.leaves,
        pairs: left.pairs + right.pairs,
    }
}

fn read_source_point(input: PathInput<'_>, scalar: usize) -> Result<Point, CubicFillError> {
    let y = scalar
        .checked_add(1)
        .ok_or(CubicFillError::UnsupportedSource)?;
    Ok(Point {
        x: input
            .point(scalar)
            .ok_or(CubicFillError::UnsupportedSource)?,
        y: input.point(y).ok_or(CubicFillError::UnsupportedSource)?,
    })
}

fn same_bounds_bits(left: Bounds, right: Bounds) -> bool {
    left.min_x.to_bits() == right.min_x.to_bits()
        && left.min_y.to_bits() == right.min_y.to_bits()
        && left.max_x.to_bits() == right.max_x.to_bits()
        && left.max_y.to_bits() == right.max_y.to_bits()
}

fn same_point(left: Point, right: Point) -> bool {
    left.x == right.x && left.y == right.y
}

fn same_point_bits(left: Point, right: Point) -> bool {
    left.x.to_bits() == right.x.to_bits() && left.y.to_bits() == right.y.to_bits()
}

fn finite_point(point: Point) -> bool {
    point.x.is_finite() && point.y.is_finite()
}

/// The P3 B0 spike S1 accessor, test-only, kept in its own impl block at the end of the file so
/// that no existing line moves (the release WASM embeds source locations).
#[cfg(test)]
impl CubicFillWorkspace {
    /// P3 B0 spike S1 accessor (`docs/plans/p3-b0-spike-ladder-contract.md` section 2.2): the
    /// statements of `attempt_body` up to the B0 stop point S1, in the same order and with the
    /// same `all_line_eligible` argument. It publishes nothing and returns borrowed views of
    /// the S1 state, or the prefix failure (a sizing status other than `PATH_OK`, or an error).
    pub(crate) fn prepare_for_spike(
        &mut self,
        input: PathInput<'_>,
        command_capacity: usize,
    ) -> Result<crate::p3_b0_spike::S1View<'_>, crate::p3_b0_spike::PrefixFailure> {
        use crate::p3_b0_spike::{PrefixFailure, S1View};
        self.begin_attempt();
        if input.verbs.len() > self.caps.source_verbs
            || input.point_count() > self.caps.source_scalars
        {
            return Err(PrefixFailure::Error(CubicFillError::SourceLimit));
        }

        self.diagnostics.sizing_invoked = true;
        let (sizing_plan, sizing_bounds) = run_path(
            input,
            Pass::Sizing,
            &mut self.diagnostics.statistics,
            |_, _, _| true,
        );
        self.diagnostics.flat_status = sizing_plan.status;
        self.diagnostics.sizing_plan = sizing_plan;
        if sizing_plan.status != PATH_OK {
            return Err(PrefixFailure::Sizing(sizing_plan.status));
        }

        let all_line_eligible = input.verbs.iter().all(|verb| *verb != VERB_CUBIC);
        self.decode_sources(input, all_line_eligible)
            .map_err(PrefixFailure::Error)?;
        self.emit(input, sizing_plan, sizing_bounds, command_capacity)
            .map_err(PrefixFailure::Error)?;
        self.collect_contours(all_line_eligible)
            .map_err(PrefixFailure::Error)?;
        self.validate_leaf_partitions()
            .map_err(PrefixFailure::Error)?;
        Ok(S1View {
            commands: &self.commands[..self.command_len],
            ranges: &self.contour_ranges[..self.range_len],
            points: &self.contour_points[..self.point_len],
            owners: &self.edge_owners[..self.owner_len],
            sources: &self.sources[..self.source_len],
        })
    }
}

#[cfg(test)]
thread_local! {
    static E8_COLLAPSE_FINAL_LEAF: core::cell::Cell<bool> = const { core::cell::Cell::new(false) };
    static E14_EXACT_FAST_CAPS: core::cell::Cell<bool> = const { core::cell::Cell::new(false) };
    static E16_NO_REFINEMENT: core::cell::Cell<bool> = const { core::cell::Cell::new(false) };
    static E16_CUBIC_LINE_CAPS: core::cell::Cell<bool> = const { core::cell::Cell::new(false) };
}

/// Runs `action` with E16-K2's refinement retries off, so a test can read the workspace state
/// the cascade at e leaves (`docs/plans/d9-e16-fill-rejection-remedy-contract.md` section 4).
#[cfg(test)]
pub(crate) fn without_refinement<T>(action: impl FnOnce() -> T) -> T {
    E16_NO_REFINEMENT.with(|switch| switch.set(true));
    let result = action();
    E16_NO_REFINEMENT.with(|switch| switch.set(false));
    result
}

/// E16-D1 (contract section 7): runs `action` with the exact rung's line-only caps applied to
/// every path, cubic paths included, then switches it off.
#[cfg(test)]
pub(crate) fn with_line_caps_on_cubic_paths<T>(action: impl FnOnce() -> T) -> T {
    E16_CUBIC_LINE_CAPS.with(|switch| switch.set(true));
    let result = action();
    E16_CUBIC_LINE_CAPS.with(|switch| switch.set(false));
    result
}

/// E14-D1 (`docs/plans/d9-e14-fill-rung0-edge-cap-contract.md` section 8): runs `action` with
/// the exact rung's prefix enforcing the fast caps instead of `caps`, then switches it off.
#[cfg(test)]
pub(crate) fn with_exact_rung_fast_caps<T>(action: impl FnOnce() -> T) -> T {
    E14_EXACT_FAST_CAPS.with(|switch| switch.set(true));
    let result = action();
    E14_EXACT_FAST_CAPS.with(|switch| switch.set(false));
    result
}

/// E8-C6's command-list injection (E8 addendum E8.6): runs `action` with the first cubic
/// source's final flattened leaf moved onto the previous emitted point, after `emit` and before
/// the E8-U2 snap, then switches it off.
#[cfg(test)]
pub(crate) fn with_e8_collapsed_final_leaf<T>(action: impl FnOnce() -> T) -> T {
    E8_COLLAPSE_FINAL_LEAF.with(|switch| switch.set(true));
    let result = action();
    E8_COLLAPSE_FINAL_LEAF.with(|switch| switch.set(false));
    result
}

#[cfg(test)]
impl CubicFillWorkspace {
    /// The exact rung's prefix (`attempt_body` up to S1, with the E8-U2 snap), for the E8-K10
    /// topology emitter: borrowed views of the state `certify_topology` reads.
    pub(crate) fn prepare_exact_prefix(
        &mut self,
        input: PathInput<'_>,
        command_capacity: usize,
    ) -> Result<S1View<'_>, PrefixFailure> {
        self.run_prefix(input, command_capacity, true, self.caps)?;
        Ok(S1View {
            commands: &self.commands[..self.command_len],
            ranges: &self.contour_ranges[..self.range_len],
            points: &self.contour_points[..self.point_len],
            owners: &self.edge_owners[..self.owner_len],
            sources: &self.sources[..self.source_len],
        })
    }

    /// The commands of the last prefix as emitted (and snapped in the exact rung), also after a
    /// failure in collection.
    pub(crate) fn emitted_commands(&self) -> &[FlatCommand] {
        &self.commands[..self.command_len]
    }

    fn e8_test_collapse_final_leaf(&mut self) {
        for index in 1..self.command_len {
            let command = self.commands[index];
            let cubic = self.sources[..self.source_len].iter().any(|source| {
                matches!(source, DecodedSource::Cubic { source_verb, .. }
                    if *source_verb == command.provenance.source_verb)
            });
            if command.verb == VERB_LINE
                && cubic
                && 1u32.checked_shl(command.provenance.depth)
                    == Some(command.provenance.end_numerator)
            {
                self.commands[index].point = self.commands[index - 1].point;
                return;
            }
        }
    }
}
