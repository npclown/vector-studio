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
    SimpleCubicTopologyWorkspace, TopologyCubic, TopologyError, TopologyInput, TopologyLeaf,
    TopologyLimits, TopologyOutput, TopologyRange, TopologyStats,
};

pub(crate) const MAX_FLAT_COMMANDS: usize = 72;
const MAX_SOURCE_VERBS: usize = 24;
const MAX_SOURCE_SCALARS: usize = 104;
const MAX_CONTOUR_POINTS: usize = 68;
const MAX_CONTOURS: usize = 4;
const MAX_EDGE_OWNERS: usize = 64;
const MAX_SOURCE_CUBICS: usize = 16;
const MAX_COMBINED_HEAP_BYTES: usize = 16 * 1024 * 1024;

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
    CubicLeaf {
        source_verb: u32,
        end_numerator: u32,
        depth: u32,
    },
    ImplicitClosure {
        contour: usize,
    },
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct DecodedCubic {
    pub(crate) points: [Point; 4],
    pub(crate) source_verb: u32,
    pub(crate) contour: usize,
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
    pub(crate) sources: &'a [DecodedCubic],
    pub(crate) rounded: RoundedFillOutput<'a>,
    pub(crate) rounded_stats: RoundedFillStats,
}

#[derive(Clone, Copy, Debug)]
enum SourceVerb {
    Unused,
    Move { contour: usize, point: Point },
    Cubic { contour: usize },
    Close { contour: usize },
}

#[derive(Clone, Copy, Debug)]
struct ActiveSourceContour {
    contour: usize,
    cubic_start: usize,
    first: Point,
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
    source_verbs: [SourceVerb; MAX_SOURCE_VERBS],
    source_verb_len: usize,
    sources: [DecodedCubic; MAX_SOURCE_CUBICS],
    source_len: usize,
    source_ranges: [TopologyRange; MAX_CONTOURS],
    source_range_len: usize,
    commands: [FlatCommand; MAX_FLAT_COMMANDS],
    command_len: usize,
    contour_points: [Point; MAX_CONTOUR_POINTS],
    point_len: usize,
    contour_ranges: [ContourRange; MAX_CONTOURS],
    range_len: usize,
    edge_owners: [EdgeOwner; MAX_EDGE_OWNERS],
    owner_len: usize,
    diagnostics: CubicFillDiagnostics,
    published: bool,
}

impl CubicFillWorkspace {
    pub(crate) fn new(limits: RoundedFillLimits) -> Result<Self, CubicFillError> {
        let workspace = Self {
            rounded: RoundedFillWorkspace::new(limits).map_err(CubicFillError::Rounded)?,
            topology: SimpleCubicTopologyWorkspace::new(TopologyLimits::default())
                .map_err(CubicFillError::Topology)?,
            source_verbs: [SourceVerb::Unused; MAX_SOURCE_VERBS],
            source_verb_len: 0,
            sources: [DecodedCubic::default(); MAX_SOURCE_CUBICS],
            source_len: 0,
            source_ranges: [TopologyRange::default(); MAX_CONTOURS],
            source_range_len: 0,
            commands: [FlatCommand::default(); MAX_FLAT_COMMANDS],
            command_len: 0,
            contour_points: [Point::default(); MAX_CONTOUR_POINTS],
            point_len: 0,
            contour_ranges: [ContourRange::default(); MAX_CONTOURS],
            range_len: 0,
            edge_owners: [EdgeOwner::ImplicitClosure { contour: 0 }; MAX_EDGE_OWNERS],
            owner_len: 0,
            diagnostics: CubicFillDiagnostics::default(),
            published: false,
        };
        if workspace
            .rounded
            .allocated_bytes()
            .checked_add(workspace.topology.allocated_bytes())
            .is_none_or(|bytes| bytes > MAX_COMBINED_HEAP_BYTES)
        {
            return Err(CubicFillError::CombinedByteLimit);
        }
        Ok(workspace)
    }

    pub(crate) fn allocated_bytes(&self) -> usize {
        self.rounded.allocated_bytes() + self.topology.allocated_bytes()
    }

    pub(crate) fn diagnostics(&self) -> CubicFillDiagnostics {
        self.diagnostics
    }

    pub(crate) fn topology_stats(&self) -> TopologyStats {
        self.topology.stats()
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
        self.begin_attempt();
        if input.verbs.len() > MAX_SOURCE_VERBS || input.point_count() > MAX_SOURCE_SCALARS {
            return Err(CubicFillError::SourceLimit);
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
            return Ok(self.diagnostics);
        }

        self.decode_sources(input)?;
        self.emit(input, sizing_plan, sizing_bounds, command_capacity)?;
        self.collect_contours()?;
        self.validate_leaf_partitions()?;
        self.diagnostics.topology_invoked = true;
        self.certify_topology()?;

        let mut references: [&[Point]; MAX_CONTOURS] = [&[]; MAX_CONTOURS];
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
    }

    fn decode_sources(&mut self, input: PathInput<'_>) -> Result<(), CubicFillError> {
        let mut scalar = 0usize;
        let mut active = None;
        for (ordinal, verb) in input.verbs.iter().copied().enumerate() {
            let source_verb = u32::try_from(ordinal).map_err(|_| CubicFillError::SourceLimit)?;
            match verb {
                VERB_MOVE => {
                    if let Some(open) = active.take() {
                        self.finish_open_source(open)?;
                    }
                    if self.source_range_len >= MAX_CONTOURS {
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
                        cubic_start: self.source_len,
                        first: point,
                        current: point,
                    });
                }
                VERB_CUBIC => {
                    let mut open = active.ok_or(CubicFillError::UnsupportedSource)?;
                    if self.source_len >= MAX_SOURCE_CUBICS {
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
                    self.sources[self.source_len] = DecodedCubic {
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
                    self.finish_closed_source(open)?;
                }
                VERB_LINE => return Err(CubicFillError::UnsupportedSource),
                _ => return Err(CubicFillError::UnsupportedSource),
            }
        }
        if let Some(open) = active {
            self.finish_open_source(open)?;
        }
        if scalar != input.point_count() || self.source_range_len == 0 {
            return Err(CubicFillError::UnsupportedSource);
        }
        self.source_verb_len = input.verbs.len();
        Ok(())
    }

    fn finish_closed_source(&mut self, open: ActiveSourceContour) -> Result<(), CubicFillError> {
        if self.source_len == open.cubic_start || !same_point(open.current, open.first) {
            return Err(CubicFillError::UnsupportedSource);
        }
        self.push_source_range(TopologyRange {
            start: open.cubic_start,
            count: self.source_len - open.cubic_start,
        })
    }

    fn finish_open_source(&mut self, open: ActiveSourceContour) -> Result<(), CubicFillError> {
        if self.source_len == open.cubic_start || same_point(open.current, open.first) {
            return Err(CubicFillError::UnsupportedSource);
        }
        self.push_source_range(TopologyRange {
            start: open.cubic_start,
            count: self.source_len - open.cubic_start,
        })
    }

    fn push_source_range(&mut self, range: TopologyRange) -> Result<(), CubicFillError> {
        if self.source_range_len >= MAX_CONTOURS {
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
        let bounded_capacity = command_capacity.min(MAX_FLAT_COMMANDS);
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

    fn certify_topology(&mut self) -> Result<(), CubicFillError> {
        let mut cubics = [TopologyCubic::default(); MAX_SOURCE_CUBICS];
        let mut leaves = [TopologyLeaf::default(); MAX_EDGE_OWNERS];
        let mut leaf_len = 0usize;
        for (index, source) in self.sources[..self.source_len].iter().copied().enumerate() {
            let leaf_start = leaf_len;
            for command in &self.commands[..self.command_len] {
                if command.verb != VERB_LINE || command.provenance.source_verb != source.source_verb
                {
                    continue;
                }
                if leaf_len >= MAX_EDGE_OWNERS {
                    return Err(CubicFillError::OwnerLimit);
                }
                leaves[leaf_len] = TopologyLeaf {
                    end: command.point.ok_or(CubicFillError::InvalidCommand)?,
                    provenance: command.provenance,
                };
                leaf_len += 1;
            }
            cubics[index] = TopologyCubic {
                points: source.points,
                source_verb: source.source_verb,
                leaves: TopologyRange {
                    start: leaf_start,
                    count: leaf_len - leaf_start,
                },
            };
        }
        self.topology
            .certify(TopologyInput {
                contours: &self.source_ranges[..self.source_range_len],
                cubics: &cubics[..self.source_len],
                leaves: &leaves[..leaf_len],
            })
            .map_err(CubicFillError::Topology)?;
        let certificate = self
            .topology
            .output()
            .ok_or(CubicFillError::TopologyOwnership)?;
        self.validate_topology_ownership(certificate)
    }

    fn validate_topology_ownership(
        &self,
        certificate: TopologyOutput<'_>,
    ) -> Result<(), CubicFillError> {
        if certificate.contours.len() != self.range_len
            || certificate.points.len() != self.owner_len
        {
            return Err(CubicFillError::TopologyOwnership);
        }
        for (certified, collected) in certificate
            .contours
            .iter()
            .zip(&self.contour_ranges[..self.range_len])
        {
            if certified.count != collected.count {
                return Err(CubicFillError::TopologyOwnership);
            }
            for offset in 0..certified.count {
                if !same_point(
                    certificate.points[certified.start + offset],
                    self.contour_points[collected.start + offset],
                ) {
                    return Err(CubicFillError::TopologyOwnership);
                }
            }
        }
        Ok(())
    }

    fn collect_contours(&mut self) -> Result<(), CubicFillError> {
        let mut active = None;
        for command_index in 0..self.command_len {
            let command = self.commands[command_index];
            match command.verb {
                VERB_MOVE => {
                    if let Some(open) = active.take() {
                        self.finish_open_contour(open)?;
                    }
                    if self.range_len >= MAX_CONTOURS {
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
                    match self.source_verb(command.provenance.source_verb)? {
                        SourceVerb::Cubic { contour } if contour == open.source_contour => {}
                        _ => return Err(CubicFillError::InvalidProvenance),
                    }
                    if same_point(open.previous, point) {
                        return Err(CubicFillError::ZeroLengthLeaf);
                    }
                    self.push_owner(EdgeOwner::CubicLeaf {
                        source_verb: command.provenance.source_verb,
                        end_numerator: command.provenance.end_numerator,
                        depth: command.provenance.depth,
                    })?;
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
                    self.finish_closed_contour(open)?;
                }
                _ => return Err(CubicFillError::InvalidCommand),
            }
        }
        if let Some(open) = active {
            self.finish_open_contour(open)?;
        }
        if self.range_len != self.source_range_len
            || self.owner_len
                != self.contour_ranges[..self.range_len]
                    .iter()
                    .map(|range| range.count)
                    .sum()
        {
            return Err(CubicFillError::RoundedOwnership);
        }
        Ok(())
    }

    fn finish_closed_contour(&mut self, open: ActiveContour) -> Result<(), CubicFillError> {
        let first = self.contour_points[open.point_start];
        if !same_point(first, open.previous)
            || self.point_len <= open.point_start + 1
            || open.source_contour != self.range_len
        {
            return Err(CubicFillError::InvalidCommand);
        }
        self.point_len -= 1;
        self.push_range(ContourRange {
            start: open.point_start,
            count: self.point_len - open.point_start,
        })
    }

    fn finish_open_contour(&mut self, open: ActiveContour) -> Result<(), CubicFillError> {
        let first = self.contour_points[open.point_start];
        if same_point(first, open.previous)
            || self.point_len <= open.point_start + 1
            || open.source_contour != self.range_len
        {
            return Err(CubicFillError::InvalidCommand);
        }
        self.push_owner(EdgeOwner::ImplicitClosure {
            contour: open.source_contour,
        })?;
        self.push_range(ContourRange {
            start: open.point_start,
            count: self.point_len - open.point_start,
        })
    }

    fn push_point(&mut self, point: Point) -> Result<(), CubicFillError> {
        if self.point_len >= MAX_CONTOUR_POINTS {
            return Err(CubicFillError::PointLimit);
        }
        self.contour_points[self.point_len] = point;
        self.point_len += 1;
        Ok(())
    }

    fn push_owner(&mut self, owner: EdgeOwner) -> Result<(), CubicFillError> {
        if self.owner_len >= MAX_EDGE_OWNERS {
            return Err(CubicFillError::OwnerLimit);
        }
        self.edge_owners[self.owner_len] = owner;
        self.owner_len += 1;
        Ok(())
    }

    fn push_range(&mut self, range: ContourRange) -> Result<(), CubicFillError> {
        if self.range_len >= MAX_CONTOURS {
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
            let mut previous_numerator = 0u64;
            let mut previous_denominator = 1u64;
            let mut count = 0usize;
            for command in &self.commands[..self.command_len] {
                if command.verb != VERB_LINE || command.provenance.source_verb != source.source_verb
                {
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
            if count == 0 || previous_numerator != previous_denominator {
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
            for start_vertex in 0..range.count {
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
                    EdgeOwner::CubicLeaf { source_verb, .. } => {
                        if !self.commands[..self.command_len].iter().any(|command| {
                            command.verb == VERB_LINE
                                && command.provenance.source_verb == source_verb
                        }) {
                            return Err(CubicFillError::RoundedOwnership);
                        }
                    }
                    EdgeOwner::ImplicitClosure { contour: owner } if owner == contour => {}
                    EdgeOwner::ImplicitClosure { .. } => {
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
