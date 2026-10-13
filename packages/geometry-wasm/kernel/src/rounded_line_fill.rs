use core::cmp::Ordering;
use core::mem::size_of;

use crate::fill_event_order::{compare_event_x, EventError, FillEvent};
use crate::fill_predicates::{orient2d, segment_relation, SegmentRelation};
use crate::fill_sections::{
    compare_column_source_f64, compare_section_sources, compare_slab_sections, rank_finite,
    ExactSection, SectionSource, SectionTarget, SlabSample, MAX_FINITE_RANK, MIN_FINITE_RANK,
};
#[cfg(test)]
use crate::fill_sections::{event_column, section_at_column, ExactColumn};
use crate::geometry::{Bounds, Point};
use crate::line_fill::LineFillRule;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RoundedFillError {
    InvalidLimits,
    AllocationFailed,
    ByteLimit,
    InputLimit,
    InvalidInput,
    InvalidTolerance,
    EdgeLimit,
    PairLimit,
    EventLimit,
    SectionLimit,
    NodeLimit,
    CellLimit,
    BoundaryLimit,
    ContributorLimit,
    WorkLimit,
    OutputLimit,
    TopologyAmbiguous,
    InternalInvariant,
}

fn validate_limits(limits: RoundedFillLimits) -> Result<usize, RoundedFillError> {
    if limits.max_vertices > u32::MAX as usize || limits.max_edges > i64::MAX as usize {
        return Err(RoundedFillError::InvalidLimits);
    }
    pair_count(limits.max_edges).ok_or(RoundedFillError::InvalidLimits)?;
    limits
        .max_edges
        .checked_mul(2)
        .and_then(|endpoints| endpoints.checked_add(limits.max_pairs))
        .ok_or(RoundedFillError::InvalidLimits)?;
    limits
        .max_events
        .checked_mul(limits.max_edges)
        .and_then(|sections| {
            limits
                .max_edges
                .checked_mul(2)
                .and_then(|vertical| sections.checked_add(vertical))
        })
        .ok_or(RoundedFillError::InvalidLimits)?;
    limits
        .max_cells
        .checked_mul(2)
        .and_then(|cell_boundaries| cell_boundaries.checked_add(limits.max_nodes))
        .ok_or(RoundedFillError::InvalidLimits)?;
    let index_capacity = limits
        .max_triangles
        .checked_mul(3)
        .ok_or(RoundedFillError::InvalidLimits)?;
    requested_bytes(limits, index_capacity)?;
    Ok(index_capacity)
}

fn requested_bytes(
    limits: RoundedFillLimits,
    index_capacity: usize,
) -> Result<usize, RoundedFillError> {
    allocation_bytes(&[
        (limits.max_edges, size_of::<EdgeState>()),
        (limits.max_events, size_of::<FillEvent>()),
        (limits.max_events, size_of::<FillEvent>()),
        (limits.max_events, size_of::<SourceRange>()),
        (limits.max_nodes, size_of::<NodeMeta>()),
        (limits.max_edges, size_of::<ActiveEdge>()),
        (limits.max_edges, size_of::<RoundedSourceEdge>()),
        (limits.max_events, size_of::<RoundedColumn>()),
        (limits.max_nodes, size_of::<RoundedNode>()),
        (limits.max_sections, size_of::<RoundedSection>()),
        (limits.max_cells, size_of::<RoundedCell>()),
        (limits.max_boundaries, size_of::<RoundedBoundary>()),
        (limits.max_nodes, size_of::<RoundedColumnSpan>()),
        (limits.max_contributors, size_of::<usize>()),
        (limits.max_vertices, size_of::<Point>()),
        (index_capacity, size_of::<u32>()),
    ])
}

fn allocation_bytes(parts: &[(usize, usize)]) -> Result<usize, RoundedFillError> {
    let mut total = 0usize;
    for &(capacity, item_size) in parts {
        let bytes = capacity
            .checked_mul(item_size)
            .ok_or(RoundedFillError::InvalidLimits)?;
        if bytes > isize::MAX as usize {
            return Err(RoundedFillError::InvalidLimits);
        }
        total = total
            .checked_add(bytes)
            .ok_or(RoundedFillError::InvalidLimits)?;
    }
    Ok(total)
}

fn reserve_vec<T>(capacity: usize) -> Result<Vec<T>, RoundedFillError> {
    let mut buffer = Vec::new();
    buffer
        .try_reserve_exact(capacity)
        .map_err(|_| RoundedFillError::AllocationFailed)?;
    Ok(buffer)
}

fn pair_count(edges: usize) -> Option<usize> {
    if edges < 2 {
        return Some(0);
    }
    if edges.is_multiple_of(2) {
        (edges / 2).checked_mul(edges - 1)
    } else {
        edges.checked_mul((edges - 1) / 2)
    }
}

fn validate_input(contours: &[&[Point]]) -> Result<(), RoundedFillError> {
    if contours
        .iter()
        .flat_map(|contour| contour.iter())
        .all(|point| point.x.is_finite() && point.y.is_finite())
    {
        Ok(())
    } else {
        Err(RoundedFillError::InvalidInput)
    }
}

fn normalize_point(point: Point) -> Point {
    Point {
        x: normalize_zero(point.x),
        y: normalize_zero(point.y),
    }
}

fn normalize_zero(value: f64) -> f64 {
    if value == 0.0 {
        0.0
    } else {
        value
    }
}

fn same_point(left: Point, right: Point) -> bool {
    left.x == right.x && left.y == right.y
}

fn edge_winding(edge: EdgeState) -> i64 {
    if edge.b.x > edge.a.x {
        1
    } else {
        -1
    }
}

fn vertical_winding(edge: EdgeState) -> i64 {
    if edge.b.y > edge.a.y {
        1
    } else {
        -1
    }
}

fn is_filled(winding: i64, rule: LineFillRule) -> bool {
    match rule {
        LineFillRule::Nonzero => winding != 0,
        LineFillRule::Evenodd => winding % 2 != 0,
    }
}

fn map_event_error(_error: EventError) -> RoundedFillError {
    RoundedFillError::InternalInvariant
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> RoundedFillLimits {
        RoundedFillLimits {
            max_contours: 4,
            max_input_vertices: 16,
            max_edges: 16,
            max_pairs: 120,
            max_events: 152,
            max_sections: 2_500,
            max_nodes: 512,
            max_cells: 512,
            max_boundaries: 1_536,
            max_contributors: 8_192,
            max_vertices: 512,
            max_triangles: 1_024,
            max_work: 1_000_000,
            max_bytes: 16 * 1024 * 1024,
        }
    }

    fn point(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    #[test]
    fn constructor_accounts_every_actual_capacity_and_zero_is_allocation_free() {
        let workspace = RoundedFillWorkspace::new(limits()).unwrap();
        assert!(workspace.allocated_bytes() > 0);
        assert_eq!(
            workspace.allocated_bytes(),
            workspace.actual_allocated_bytes().unwrap()
        );

        let zero = RoundedFillWorkspace::new(RoundedFillLimits {
            max_contours: 0,
            max_input_vertices: 0,
            max_edges: 0,
            max_pairs: 0,
            max_events: 0,
            max_sections: 0,
            max_nodes: 0,
            max_cells: 0,
            max_boundaries: 0,
            max_contributors: 0,
            max_vertices: 0,
            max_triangles: 0,
            max_work: 0,
            max_bytes: 0,
        })
        .unwrap();
        assert_eq!(zero.allocated_bytes(), 0);
    }

    #[test]
    fn exact_square_builds_shared_mesh_and_boundary_ledger() {
        let contour = [
            point(0.0, 0.0),
            point(1.0, 0.0),
            point(1.0, 1.0),
            point(0.0, 1.0),
        ];
        let mut workspace = RoundedFillWorkspace::new(limits()).unwrap();
        workspace
            .tessellate(&[&contour], LineFillRule::Nonzero, f64::from_bits(1))
            .unwrap();
        let output = workspace.output().unwrap();
        assert_eq!(output.vertices.len(), 4);
        assert_eq!(output.indices.len(), 6);
        assert_eq!(output.boundaries.len(), 4);
        assert_eq!(output.error_bound.to_bits(), f64::from_bits(1).to_bits());
        assert!(output.nodes.iter().all(|node| node.vertex.is_some()));
    }

    #[test]
    fn invalid_tolerance_precedes_no_topology_work_and_clears_prior_output() {
        let contour = [point(0.0, 0.0), point(1.0, 0.0), point(0.0, 1.0)];
        let mut workspace = RoundedFillWorkspace::new(limits()).unwrap();
        workspace
            .tessellate(&[&contour], LineFillRule::Evenodd, f64::EPSILON)
            .unwrap();
        assert_eq!(
            workspace.tessellate(&[&contour], LineFillRule::Evenodd, 0.0),
            Err(RoundedFillError::InvalidTolerance)
        );
        assert!(workspace.output().is_none());
        assert_eq!(workspace.stats().input_vertices, 3);
        assert_eq!(workspace.stats().edges, 0);
    }

    #[test]
    fn nonrepresentable_window_search_is_exact_bounded_and_canonical() {
        let mut workspace = RoundedFillWorkspace::new(limits()).unwrap();
        let third = section_at_column(
            point(0.0, 0.0),
            point(3.0, 1.0),
            event_column(FillEvent::Endpoint(point(1.0, 0.0))).unwrap(),
        );
        let before = workspace.stats.work_units;
        let (rounded, rank) = workspace.embed_scalar(third, None, f64::EPSILON).unwrap();
        let consumed = workspace.stats.work_units - before;
        assert!((1..=192).contains(&consumed));
        assert_eq!(crate::fill_sections::finite_rank(rounded), rank);
        assert!(crate::fill_sections::within_half_budget(
            third,
            rounded,
            f64::EPSILON
        ));

        let next = workspace
            .embed_scalar(third, Some(rank), f64::EPSILON)
            .unwrap();
        assert_eq!(next.1, rank + 1);
        assert!(crate::fill_sections::within_half_budget(
            third,
            next.0,
            f64::EPSILON
        ));
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RoundedFillLimits {
    pub(crate) max_contours: usize,
    pub(crate) max_input_vertices: usize,
    pub(crate) max_edges: usize,
    pub(crate) max_pairs: usize,
    pub(crate) max_events: usize,
    pub(crate) max_sections: usize,
    pub(crate) max_nodes: usize,
    pub(crate) max_cells: usize,
    pub(crate) max_boundaries: usize,
    pub(crate) max_contributors: usize,
    pub(crate) max_vertices: usize,
    pub(crate) max_triangles: usize,
    pub(crate) max_work: u64,
    pub(crate) max_bytes: usize,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct RoundedFillStats {
    pub(crate) input_vertices: usize,
    pub(crate) edges: usize,
    pub(crate) pair_checks: usize,
    pub(crate) events: usize,
    pub(crate) columns: usize,
    pub(crate) sections: usize,
    pub(crate) nodes: usize,
    pub(crate) cells: usize,
    pub(crate) boundaries: usize,
    pub(crate) contributors: usize,
    pub(crate) work_units: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct SourceRange {
    pub(crate) start: usize,
    pub(crate) count: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RoundedSourceEdge {
    pub(crate) contour: usize,
    pub(crate) start_vertex: usize,
    pub(crate) end_vertex: usize,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct RoundedColumn {
    pub(crate) x: f64,
    pub(crate) node_start: usize,
    pub(crate) node_count: usize,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct RoundedNode {
    pub(crate) point: Point,
    pub(crate) column: usize,
    pub(crate) vertex: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RoundedSection {
    pub(crate) column: usize,
    pub(crate) node: usize,
    pub(crate) edge: usize,
    pub(crate) endpoint: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RoundedCell {
    pub(crate) slab: usize,
    pub(crate) nodes: [usize; 4],
    pub(crate) lower_sources: SourceRange,
    pub(crate) upper_sources: SourceRange,
    pub(crate) lower_before: i64,
    pub(crate) lower_after: i64,
    pub(crate) upper_before: i64,
    pub(crate) upper_after: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BoundaryKind {
    Lower,
    Upper,
    Vertical,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RoundedBoundary {
    pub(crate) from: usize,
    pub(crate) to: usize,
    pub(crate) kind: BoundaryKind,
    pub(crate) sources: SourceRange,
    pub(crate) before_winding: i64,
    pub(crate) after_winding: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RoundedColumnSpan {
    pub(crate) column: usize,
    pub(crate) lower: usize,
    pub(crate) upper: usize,
    pub(crate) left_winding: i64,
    pub(crate) right_winding: i64,
    pub(crate) vertical_delta: i64,
    pub(crate) vertical_sources: SourceRange,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct RoundedFillOutput<'a> {
    pub(crate) vertices: &'a [Point],
    pub(crate) indices: &'a [u32],
    pub(crate) bounds: Bounds,
    pub(crate) source_edges: &'a [RoundedSourceEdge],
    pub(crate) columns: &'a [RoundedColumn],
    pub(crate) nodes: &'a [RoundedNode],
    pub(crate) sections: &'a [RoundedSection],
    pub(crate) cells: &'a [RoundedCell],
    pub(crate) boundaries: &'a [RoundedBoundary],
    pub(crate) spans: &'a [RoundedColumnSpan],
    pub(crate) contributors: &'a [usize],
    pub(crate) error_bound: f64,
}

#[derive(Clone, Copy)]
struct EdgeState {
    a: Point,
    b: Point,
    low_column: usize,
    high_column: usize,
}

#[derive(Clone, Copy)]
struct ActiveEdge {
    edge: usize,
    section: ExactSection,
}

#[derive(Clone, Copy)]
struct NodeMeta {
    section: usize,
    incoming: usize,
    outgoing: usize,
}

#[derive(Clone, Copy)]
struct PendingCell {
    lower_sources: SourceRange,
    left: usize,
    right: usize,
    before: i64,
    after: i64,
}

pub(crate) struct RoundedFillWorkspace {
    limits: RoundedFillLimits,
    edges: Vec<EdgeState>,
    events: Vec<FillEvent>,
    exact_columns: Vec<FillEvent>,
    column_sections: Vec<SourceRange>,
    node_meta: Vec<NodeMeta>,
    active: Vec<ActiveEdge>,
    source_edges: Vec<RoundedSourceEdge>,
    columns: Vec<RoundedColumn>,
    nodes: Vec<RoundedNode>,
    sections: Vec<RoundedSection>,
    cells: Vec<RoundedCell>,
    boundaries: Vec<RoundedBoundary>,
    spans: Vec<RoundedColumnSpan>,
    contributors: Vec<usize>,
    vertices: Vec<Point>,
    indices: Vec<u32>,
    stats: RoundedFillStats,
    bounds: Bounds,
    has_bounds: bool,
    tolerance: f64,
    published: bool,
    allocated_bytes: usize,
}

impl RoundedFillWorkspace {
    pub(crate) fn new(limits: RoundedFillLimits) -> Result<Self, RoundedFillError> {
        let index_capacity = validate_limits(limits)?;
        let requested = requested_bytes(limits, index_capacity)?;
        if requested > limits.max_bytes {
            return Err(RoundedFillError::ByteLimit);
        }

        let mut workspace = Self {
            limits,
            edges: reserve_vec(limits.max_edges)?,
            events: reserve_vec(limits.max_events)?,
            exact_columns: reserve_vec(limits.max_events)?,
            column_sections: reserve_vec(limits.max_events)?,
            node_meta: reserve_vec(limits.max_nodes)?,
            active: reserve_vec(limits.max_edges)?,
            source_edges: reserve_vec(limits.max_edges)?,
            columns: reserve_vec(limits.max_events)?,
            nodes: reserve_vec(limits.max_nodes)?,
            sections: reserve_vec(limits.max_sections)?,
            cells: reserve_vec(limits.max_cells)?,
            boundaries: reserve_vec(limits.max_boundaries)?,
            spans: reserve_vec(limits.max_nodes)?,
            contributors: reserve_vec(limits.max_contributors)?,
            vertices: reserve_vec(limits.max_vertices)?,
            indices: reserve_vec(index_capacity)?,
            stats: RoundedFillStats::default(),
            bounds: Bounds::default(),
            has_bounds: false,
            tolerance: 0.0,
            published: false,
            allocated_bytes: 0,
        };
        workspace.allocated_bytes = workspace.actual_allocated_bytes()?;
        if workspace.allocated_bytes > limits.max_bytes {
            return Err(RoundedFillError::ByteLimit);
        }
        Ok(workspace)
    }

    pub(crate) fn tessellate(
        &mut self,
        contours: &[&[Point]],
        rule: LineFillRule,
        tau: f64,
    ) -> Result<(), RoundedFillError> {
        self.begin_attempt();
        match self.tessellate_attempt(contours, rule, tau) {
            Ok(()) => {
                self.tolerance = tau;
                self.published = true;
                Ok(())
            }
            Err(error) => {
                self.clear_publication();
                Err(error)
            }
        }
    }

    pub(crate) fn output(&self) -> Option<RoundedFillOutput<'_>> {
        self.published.then_some(RoundedFillOutput {
            vertices: &self.vertices,
            indices: &self.indices,
            bounds: self.bounds,
            source_edges: &self.source_edges,
            columns: &self.columns,
            nodes: &self.nodes,
            sections: &self.sections,
            cells: &self.cells,
            boundaries: &self.boundaries,
            spans: &self.spans,
            contributors: &self.contributors,
            error_bound: if self.vertices.is_empty() {
                0.0
            } else {
                self.tolerance
            },
        })
    }

    pub(crate) fn stats(&self) -> RoundedFillStats {
        self.stats
    }

    pub(crate) fn allocated_bytes(&self) -> usize {
        self.allocated_bytes
    }

    fn tessellate_attempt(
        &mut self,
        contours: &[&[Point]],
        rule: LineFillRule,
        tau: f64,
    ) -> Result<(), RoundedFillError> {
        let input_vertices = self.preflight_input(contours)?;
        self.stats.input_vertices = input_vertices;
        validate_input(contours)?;
        if !tau.is_finite() || tau <= 0.0 {
            return Err(RoundedFillError::InvalidTolerance);
        }
        self.copy_edges(contours)?;
        let pairs = pair_count(self.edges.len()).ok_or(RoundedFillError::PairLimit)?;
        if pairs > self.limits.max_pairs {
            return Err(RoundedFillError::PairLimit);
        }
        self.collect_events()?;
        self.sort_events()?;
        self.build_exact_columns()?;
        self.assign_edge_columns()?;
        self.build_sections_and_nodes(tau)?;
        self.build_cells(rule)?;
        self.build_ledger(rule)?;
        self.build_mesh()?;
        if !self.has_bounds {
            self.bounds = Bounds::default();
        }
        Ok(())
    }

    fn begin_attempt(&mut self) {
        self.edges.clear();
        self.events.clear();
        self.exact_columns.clear();
        self.column_sections.clear();
        self.node_meta.clear();
        self.active.clear();
        self.source_edges.clear();
        self.columns.clear();
        self.nodes.clear();
        self.sections.clear();
        self.cells.clear();
        self.boundaries.clear();
        self.spans.clear();
        self.contributors.clear();
        self.vertices.clear();
        self.indices.clear();
        self.stats = RoundedFillStats::default();
        self.bounds = Bounds::default();
        self.has_bounds = false;
        self.tolerance = 0.0;
        self.published = false;
    }

    fn clear_publication(&mut self) {
        self.source_edges.clear();
        self.columns.clear();
        self.nodes.clear();
        self.sections.clear();
        self.cells.clear();
        self.boundaries.clear();
        self.spans.clear();
        self.contributors.clear();
        self.vertices.clear();
        self.indices.clear();
        self.bounds = Bounds::default();
        self.has_bounds = false;
        self.tolerance = 0.0;
        self.published = false;
    }

    fn preflight_input(&self, contours: &[&[Point]]) -> Result<usize, RoundedFillError> {
        if contours.len() > self.limits.max_contours {
            return Err(RoundedFillError::InputLimit);
        }
        let mut total = 0usize;
        for contour in contours {
            total = total
                .checked_add(contour.len())
                .ok_or(RoundedFillError::InputLimit)?;
            if total > self.limits.max_input_vertices {
                return Err(RoundedFillError::InputLimit);
            }
        }
        Ok(total)
    }

    fn copy_edges(&mut self, contours: &[&[Point]]) -> Result<(), RoundedFillError> {
        for (contour_index, contour) in contours.iter().enumerate() {
            if contour.is_empty() {
                continue;
            }
            for start_vertex in 0..contour.len() {
                let end_vertex = (start_vertex + 1) % contour.len();
                let a = normalize_point(contour[start_vertex]);
                let b = normalize_point(contour[end_vertex]);
                if same_point(a, b) {
                    continue;
                }
                if self.edges.len() >= self.limits.max_edges {
                    return Err(RoundedFillError::EdgeLimit);
                }
                self.edges.push(EdgeState {
                    a,
                    b,
                    low_column: usize::MAX,
                    high_column: usize::MAX,
                });
                self.source_edges.push(RoundedSourceEdge {
                    contour: contour_index,
                    start_vertex,
                    end_vertex,
                });
                self.stats.edges += 1;
            }
        }
        Ok(())
    }

    fn collect_events(&mut self) -> Result<(), RoundedFillError> {
        for edge_index in 0..self.edges.len() {
            let edge = self.edges[edge_index];
            self.push_event(FillEvent::Endpoint(edge.a))?;
            self.push_event(FillEvent::Endpoint(edge.b))?;
        }
        for left in 0..self.edges.len() {
            for right in (left + 1)..self.edges.len() {
                self.charge()?;
                self.stats.pair_checks += 1;
                let a = self.edges[left];
                let b = self.edges[right];
                let relation = segment_relation(a.a, a.b, b.a, b.b)
                    .map_err(|_| RoundedFillError::InternalInvariant)?;
                if relation == SegmentRelation::ProperCrossing {
                    self.push_event(FillEvent::Crossing {
                        a: a.a,
                        b: a.b,
                        c: b.a,
                        d: b.b,
                    })?;
                }
            }
        }
        Ok(())
    }

    fn push_event(&mut self, event: FillEvent) -> Result<(), RoundedFillError> {
        if self.events.len() >= self.limits.max_events {
            return Err(RoundedFillError::EventLimit);
        }
        self.events.push(event);
        self.stats.events += 1;
        Ok(())
    }

    fn sort_events(&mut self) -> Result<(), RoundedFillError> {
        for index in 1..self.events.len() {
            let value = self.events[index];
            let mut cursor = index;
            while cursor > 0 {
                let ordering = self.compare_events(self.events[cursor - 1], value)?;
                if ordering != Ordering::Greater {
                    break;
                }
                self.events[cursor] = self.events[cursor - 1];
                cursor -= 1;
            }
            self.events[cursor] = value;
        }
        Ok(())
    }

    fn build_exact_columns(&mut self) -> Result<(), RoundedFillError> {
        for index in 0..self.events.len() {
            let event = self.events[index];
            let distinct = if let Some(previous) = self.exact_columns.last().copied() {
                self.compare_event_x_charged(previous, event)? != Ordering::Equal
            } else {
                true
            };
            if distinct {
                debug_assert!(self.exact_columns.len() < self.limits.max_events);
                self.exact_columns.push(event);
            }
        }
        Ok(())
    }

    fn assign_edge_columns(&mut self) -> Result<(), RoundedFillError> {
        for edge_index in 0..self.edges.len() {
            let edge = self.edges[edge_index];
            let a_column = self.find_endpoint_column(edge.a.x)?;
            let b_column = self.find_endpoint_column(edge.b.x)?;
            self.edges[edge_index].low_column = a_column.min(b_column);
            self.edges[edge_index].high_column = a_column.max(b_column);
        }
        Ok(())
    }

    fn find_endpoint_column(&mut self, value: f64) -> Result<usize, RoundedFillError> {
        let mut low = 0usize;
        let mut high = self.exact_columns.len();
        while low < high {
            let middle = low + (high - low) / 2;
            self.charge()?;
            match self.compare_column_value(middle, value)? {
                Ordering::Less => low = middle + 1,
                Ordering::Greater => high = middle,
                Ordering::Equal => return Ok(middle),
            }
        }
        Err(RoundedFillError::InternalInvariant)
    }

    fn build_sections_and_nodes(&mut self, tau: f64) -> Result<(), RoundedFillError> {
        let mut previous_x = None;
        for column_index in 0..self.exact_columns.len() {
            // T1: the column's section is built only if an embedding step falls back.
            let x_source = SectionSource::Column(self.exact_columns[column_index]);
            #[cfg(test)]
            self.b0r_shadow_column_source(x_source, column_index);
            let (x, x_rank) = self.embed_scalar(x_source, previous_x, tau)?;
            previous_x = Some(x_rank);

            let section_start = self.sections.len();
            for edge_index in 0..self.edges.len() {
                self.charge()?;
                let edge = self.edges[edge_index];
                if edge.a.x != edge.b.x {
                    if edge.low_column <= column_index && column_index <= edge.high_column {
                        self.push_section(column_index, edge_index, 0)?;
                    }
                } else if edge.low_column == column_index {
                    self.push_section(column_index, edge_index, 1)?;
                    self.push_section(column_index, edge_index, 2)?;
                }
            }
            let section_end = self.sections.len();
            self.sort_section_range(section_start, section_end)?;

            let node_start = self.nodes.len();
            let mut previous_y = None;
            let mut cursor = section_start;
            while cursor < section_end {
                let mut group_end = cursor + 1;
                while group_end < section_end {
                    let left = self.sections[cursor];
                    let right = self.sections[group_end];
                    if self.compare_section_records(left, right)? != Ordering::Equal {
                        break;
                    }
                    group_end += 1;
                }
                if self.nodes.len() >= self.limits.max_nodes {
                    return Err(RoundedFillError::NodeLimit);
                }
                let source = self.section_source(self.sections[cursor])?;
                #[cfg(test)]
                self.b0r_shadow_section_source(source, self.sections[cursor]);
                let (y, y_rank) = self.embed_scalar(source, previous_y, tau)?;
                previous_y = Some(y_rank);
                let node = self.nodes.len();
                self.nodes.push(RoundedNode {
                    point: Point { x, y },
                    column: column_index,
                    vertex: None,
                });
                self.node_meta.push(NodeMeta {
                    section: cursor,
                    incoming: 0,
                    outgoing: 0,
                });
                self.stats.nodes += 1;
                for section in &mut self.sections[cursor..group_end] {
                    section.node = node;
                }
                cursor = group_end;
            }

            let section_range = SourceRange {
                start: section_start,
                count: section_end - section_start,
            };
            self.column_sections.push(section_range);
            self.columns.push(RoundedColumn {
                x,
                node_start,
                node_count: self.nodes.len() - node_start,
            });
            self.stats.columns += 1;
        }
        Ok(())
    }

    fn push_section(
        &mut self,
        column: usize,
        edge: usize,
        endpoint: u8,
    ) -> Result<(), RoundedFillError> {
        if self.sections.len() >= self.limits.max_sections {
            return Err(RoundedFillError::SectionLimit);
        }
        self.sections.push(RoundedSection {
            column,
            node: usize::MAX,
            edge,
            endpoint,
        });
        self.stats.sections += 1;
        Ok(())
    }

    fn sort_section_range(&mut self, start: usize, end: usize) -> Result<(), RoundedFillError> {
        for index in (start + 1)..end {
            let value = self.sections[index];
            let mut cursor = index;
            while cursor > start {
                let ordering = self.compare_section_records(self.sections[cursor - 1], value)?;
                if ordering != Ordering::Greater {
                    break;
                }
                self.sections[cursor] = self.sections[cursor - 1];
                cursor -= 1;
            }
            self.sections[cursor] = value;
        }
        Ok(())
    }

    /// The eager column, kept as the O10 shadow reference (T1 and T5 build columns lazily).
    #[cfg(test)]
    fn exact_column(&self, index: usize) -> Result<ExactColumn, RoundedFillError> {
        event_column(self.exact_columns[index]).map_err(map_event_error)
    }

    /// T1 and T4: the order of column `index` and `value`, building the exact column only on
    /// the exact fallback path. Every event in `exact_columns` was compared by
    /// `compare_event_x` in `sort_events` and `build_exact_columns` (each element at least
    /// once, because every edge contributes two endpoint events), so it is finite and, if a
    /// crossing, proper; for such events the eager `event_column` cannot fail, and the lazy
    /// result equals `compare_column_f64(self.exact_column(index)?, value)`.
    fn compare_column_value(&self, index: usize, value: f64) -> Result<Ordering, RoundedFillError> {
        let order =
            compare_column_source_f64(self.exact_columns[index], value).map_err(map_event_error);
        #[cfg(test)]
        if crate::fill_filter::shadow_active() {
            let eager = self
                .exact_column(index)
                .map(|column| crate::fill_sections::exact_compare_column_f64(column, value));
            crate::fill_filter::shadow_check(eager == order);
        }
        order
    }

    /// T1: the defining data of a section record, with the eager code's endpoint-code check.
    /// Its value is `exact_section(section)`'s, built by the same function when needed. A
    /// nonvertical edge's section at an endpoint column at one of its endpoint x coordinates
    /// carries that endpoint's y as its exact value (T3, `SectionSource::edge`).
    fn section_source(&self, section: RoundedSection) -> Result<SectionSource, RoundedFillError> {
        let edge = self.edges[section.edge];
        match section.endpoint {
            0 => Ok(SectionSource::edge(
                edge.a,
                edge.b,
                self.exact_columns[section.column],
            )),
            1 => Ok(SectionSource::Endpoint(edge.a.y)),
            2 => Ok(SectionSource::Endpoint(edge.b.y)),
            _ => Err(RoundedFillError::InternalInvariant),
        }
    }

    /// The pre-U4 eager construction, kept as the O10 shadow reference.
    #[cfg(test)]
    fn exact_section(&self, section: RoundedSection) -> Result<ExactSection, RoundedFillError> {
        let edge = self.edges[section.edge];
        match section.endpoint {
            0 => Ok(section_at_column(
                edge.a,
                edge.b,
                self.exact_column(section.column)?,
            )),
            1 => Ok(crate::fill_sections::endpoint_section(edge.a.y)),
            2 => Ok(crate::fill_sections::endpoint_section(edge.b.y)),
            _ => Err(RoundedFillError::InternalInvariant),
        }
    }

    /// O10: the lazily built column section equals the eager `column_as_section`.
    #[cfg(test)]
    fn b0r_shadow_column_source(&self, source: SectionSource, column: usize) {
        if crate::fill_filter::shadow_active() {
            let eager = self
                .exact_column(column)
                .map(crate::fill_sections::column_as_section);
            crate::fill_filter::shadow_check(source.build().map_err(map_event_error) == eager);
        }
    }

    /// O10: the lazily built section equals the eager `exact_section`.
    #[cfg(test)]
    fn b0r_shadow_section_source(&self, source: SectionSource, section: RoundedSection) {
        if crate::fill_filter::shadow_active() {
            let eager = self.exact_section(section);
            crate::fill_filter::shadow_check(source.build().map_err(map_event_error) == eager);
        }
    }

    fn compare_section_records(
        &mut self,
        left: RoundedSection,
        right: RoundedSection,
    ) -> Result<Ordering, RoundedFillError> {
        self.charge()?;
        // T1: F0.5 or the source enclosures decide; otherwise both sections are built.
        let left_source = self.section_source(left)?;
        let right_source = self.section_source(right)?;
        let order = compare_section_sources(left_source, right_source).map_err(map_event_error);
        #[cfg(test)]
        if crate::fill_filter::shadow_active() {
            let eager = self.exact_section(left).and_then(|left| {
                self.exact_section(right)
                    .map(|right| crate::fill_sections::exact_compare_sections(left, right))
            });
            crate::fill_filter::shadow_check(eager == order);
        }
        order
    }

    fn embed_scalar(
        &mut self,
        target: impl Into<SectionTarget>,
        previous: Option<u64>,
        tau: f64,
    ) -> Result<(f64, u64), RoundedFillError> {
        // T2: the target's enclosure is computed once for the three searches of this call.
        let mut target = target.into();
        let mut low = MIN_FINITE_RANK;
        let mut high = MAX_FINITE_RANK;
        while low <= high {
            let middle = low + (high - low) / 2;
            self.charge()?;
            match target
                .compare_f64(rank_finite(middle))
                .map_err(map_event_error)?
            {
                Ordering::Equal => {
                    if previous.is_some_and(|rank| middle <= rank) {
                        return Err(RoundedFillError::TopologyAmbiguous);
                    }
                    return Ok((rank_finite(middle), middle));
                }
                Ordering::Less => {
                    if middle == MIN_FINITE_RANK {
                        break;
                    }
                    high = middle - 1;
                }
                Ordering::Greater => {
                    if middle == MAX_FINITE_RANK {
                        break;
                    }
                    low = middle + 1;
                }
            }
        }

        let lower = self.search_lower_window(&mut target, tau)?;
        let upper = self.search_upper_window(&mut target, tau)?;
        if lower > upper {
            return Err(RoundedFillError::TopologyAmbiguous);
        }
        let selected = match previous {
            Some(rank) => lower.max(
                rank.checked_add(1)
                    .ok_or(RoundedFillError::TopologyAmbiguous)?,
            ),
            None => lower,
        };
        if selected > upper {
            return Err(RoundedFillError::TopologyAmbiguous);
        }
        Ok((rank_finite(selected), selected))
    }

    fn search_lower_window(
        &mut self,
        target: &mut SectionTarget,
        tau: f64,
    ) -> Result<u64, RoundedFillError> {
        let mut low = MIN_FINITE_RANK;
        let mut high = MAX_FINITE_RANK;
        let mut answer = None;
        while low <= high {
            let middle = low + (high - low) / 2;
            self.charge()?;
            if target
                .lower_half(rank_finite(middle), tau)
                .map_err(map_event_error)?
            {
                answer = Some(middle);
                if middle == MIN_FINITE_RANK {
                    break;
                }
                high = middle - 1;
            } else {
                if middle == MAX_FINITE_RANK {
                    break;
                }
                low = middle + 1;
            }
        }
        answer.ok_or(RoundedFillError::TopologyAmbiguous)
    }

    fn search_upper_window(
        &mut self,
        target: &mut SectionTarget,
        tau: f64,
    ) -> Result<u64, RoundedFillError> {
        let mut low = MIN_FINITE_RANK;
        let mut high = MAX_FINITE_RANK;
        let mut answer = None;
        while low <= high {
            let middle = low + (high - low) / 2;
            self.charge()?;
            if target
                .upper_half(rank_finite(middle), tau)
                .map_err(map_event_error)?
            {
                answer = Some(middle);
                if middle == MAX_FINITE_RANK {
                    break;
                }
                low = middle + 1;
            } else {
                if middle == MIN_FINITE_RANK {
                    break;
                }
                high = middle - 1;
            }
        }
        answer.ok_or(RoundedFillError::TopologyAmbiguous)
    }

    fn build_cells(&mut self, rule: LineFillRule) -> Result<(), RoundedFillError> {
        for slab in 0..self.exact_columns.len().saturating_sub(1) {
            // T5: the mediant sample and the active sections are built only when a comparison
            // falls back (`compare_slab_sections`). Both columns passed `compare_event_x`, so
            // the eager `exact_column` calls that preceded this slab's charges could not fail.
            let mut sample =
                SlabSample::new(self.exact_columns[slab], self.exact_columns[slab + 1]);
            self.active.clear();
            for edge_index in 0..self.edges.len() {
                self.charge()?;
                let edge = self.edges[edge_index];
                if edge.a.x != edge.b.x && edge.low_column <= slab && slab < edge.high_column {
                    self.active.push(ActiveEdge {
                        edge: edge_index,
                        section: ExactSection::unbuilt(),
                    });
                }
            }
            self.sort_active(&mut sample)?;
            self.build_slab_cells(slab, rule, &mut sample)?;
        }
        Ok(())
    }

    fn sort_active(&mut self, sample: &mut SlabSample) -> Result<(), RoundedFillError> {
        for index in 1..self.active.len() {
            // T5: a section built for the moving copy is stored in `value.section` and written
            // back below; shifts copy whatever an element holds, built or sentinel.
            let mut value = self.active[index];
            let mut cursor = index;
            while cursor > 0 {
                self.charge()?;
                if self.compare_active(sample, cursor - 1, &mut value)? != Ordering::Greater {
                    break;
                }
                self.active[cursor] = self.active[cursor - 1];
                cursor -= 1;
            }
            self.active[cursor] = value;
        }
        Ok(())
    }

    /// T5 consumer rule for `self.active[left]` and the moving copy `right` of `sort_active`;
    /// a section built for either is stored in it.
    fn compare_active(
        &mut self,
        sample: &mut SlabSample,
        left: usize,
        right: &mut ActiveEdge,
    ) -> Result<Ordering, RoundedFillError> {
        let left_edge = self.edges[self.active[left].edge];
        let right_edge = self.edges[right.edge];
        compare_slab_sections(
            sample,
            (left_edge.a, left_edge.b),
            &mut self.active[left].section,
            (right_edge.a, right_edge.b),
            &mut right.section,
        )
        .map_err(map_event_error)
    }

    /// T5 consumer rule for `self.active[left]` and `self.active[right]`, `left < right`; a
    /// section built for either is stored in its element.
    fn compare_active_elements(
        &mut self,
        sample: &mut SlabSample,
        left: usize,
        right: usize,
    ) -> Result<Ordering, RoundedFillError> {
        debug_assert!(left < right);
        let left_edge = self.edges[self.active[left].edge];
        let right_edge = self.edges[self.active[right].edge];
        let (head, tail) = self.active.split_at_mut(right);
        compare_slab_sections(
            sample,
            (left_edge.a, left_edge.b),
            &mut head[left].section,
            (right_edge.a, right_edge.b),
            &mut tail[0].section,
        )
        .map_err(map_event_error)
    }

    fn build_slab_cells(
        &mut self,
        slab: usize,
        rule: LineFillRule,
        sample: &mut SlabSample,
    ) -> Result<(), RoundedFillError> {
        let mut winding = 0i64;
        let mut pending = None;
        let mut cursor = 0usize;
        while cursor < self.active.len() {
            let mut group_end = cursor + 1;
            while group_end < self.active.len() {
                self.charge()?;
                if self.compare_active_elements(sample, cursor, group_end)? != Ordering::Equal {
                    break;
                }
                group_end += 1;
            }
            let before = winding;
            for active_index in cursor..group_end {
                self.charge()?;
                let edge = self.edges[self.active[active_index].edge];
                winding = winding
                    .checked_add(edge_winding(edge))
                    .ok_or(RoundedFillError::InternalInvariant)?;
            }
            let after = winding;
            let before_filled = is_filled(before, rule);
            let after_filled = is_filled(after, rule);
            if !before_filled && after_filled {
                if pending.is_some() {
                    return Err(RoundedFillError::InternalInvariant);
                }
                if self.cells.len() >= self.limits.max_cells {
                    return Err(RoundedFillError::CellLimit);
                }
                let (sources, left, right) = self.append_active_group(cursor, group_end, slab)?;
                pending = Some(PendingCell {
                    lower_sources: sources,
                    left,
                    right,
                    before,
                    after,
                });
            } else if before_filled && !after_filled {
                let lower = pending.take().ok_or(RoundedFillError::InternalInvariant)?;
                let (upper_sources, upper_left, upper_right) =
                    self.append_active_group(cursor, group_end, slab)?;
                self.cells.push(RoundedCell {
                    slab,
                    nodes: [lower.left, lower.right, upper_right, upper_left],
                    lower_sources: lower.lower_sources,
                    upper_sources,
                    lower_before: lower.before,
                    lower_after: lower.after,
                    upper_before: before,
                    upper_after: after,
                });
                self.stats.cells += 1;
            }
            cursor = group_end;
        }
        if winding != 0 || pending.is_some() {
            return Err(RoundedFillError::InternalInvariant);
        }
        Ok(())
    }

    fn append_active_group(
        &mut self,
        start: usize,
        end: usize,
        slab: usize,
    ) -> Result<(SourceRange, usize, usize), RoundedFillError> {
        if start == end {
            return Err(RoundedFillError::InternalInvariant);
        }
        let range_start = self.contributors.len();
        let mut left_node = None;
        let mut right_node = None;
        let mut previous_edge = None;
        for index in start..end {
            self.charge()?;
            let edge = self.active[index].edge;
            if previous_edge.is_some_and(|previous| edge <= previous) {
                return Err(RoundedFillError::InternalInvariant);
            }
            previous_edge = Some(edge);
            let left = self.lookup_section_node(slab, edge, 0)?;
            let right = self.lookup_section_node(slab + 1, edge, 0)?;
            if left_node.is_some_and(|node| node != left)
                || right_node.is_some_and(|node| node != right)
            {
                return Err(RoundedFillError::InternalInvariant);
            }
            left_node = Some(left);
            right_node = Some(right);
            self.push_contributor(edge)?;
        }
        Ok((
            SourceRange {
                start: range_start,
                count: self.contributors.len() - range_start,
            },
            left_node.ok_or(RoundedFillError::InternalInvariant)?,
            right_node.ok_or(RoundedFillError::InternalInvariant)?,
        ))
    }

    fn lookup_section_node(
        &mut self,
        column: usize,
        edge: usize,
        endpoint: u8,
    ) -> Result<usize, RoundedFillError> {
        let range = self.column_sections[column];
        let end = range
            .start
            .checked_add(range.count)
            .ok_or(RoundedFillError::InternalInvariant)?;
        for index in range.start..end {
            self.charge()?;
            let section = self.sections[index];
            if section.edge == edge && section.endpoint == endpoint {
                return Ok(section.node);
            }
        }
        Err(RoundedFillError::InternalInvariant)
    }

    fn push_contributor(&mut self, edge: usize) -> Result<(), RoundedFillError> {
        if self.contributors.len() >= self.limits.max_contributors {
            return Err(RoundedFillError::ContributorLimit);
        }
        self.contributors.push(edge);
        self.stats.contributors += 1;
        Ok(())
    }

    fn build_ledger(&mut self, rule: LineFillRule) -> Result<(), RoundedFillError> {
        for cell_index in 0..self.cells.len() {
            let cell = self.cells[cell_index];
            self.emit_boundary(RoundedBoundary {
                from: cell.nodes[0],
                to: cell.nodes[1],
                kind: BoundaryKind::Lower,
                sources: cell.lower_sources,
                before_winding: cell.lower_before,
                after_winding: cell.lower_after,
            })?;
            self.emit_boundary(RoundedBoundary {
                from: cell.nodes[2],
                to: cell.nodes[3],
                kind: BoundaryKind::Upper,
                sources: cell.upper_sources,
                before_winding: cell.upper_before,
                after_winding: cell.upper_after,
            })?;
        }

        for column_index in 0..self.columns.len() {
            let column = self.columns[column_index];
            for rank in 0..column.node_count.saturating_sub(1) {
                self.build_column_span(column_index, rank, rule)?;
            }
        }
        for meta in &self.node_meta {
            if meta.incoming != meta.outgoing {
                return Err(RoundedFillError::InternalInvariant);
            }
        }
        Ok(())
    }

    fn build_column_span(
        &mut self,
        column: usize,
        rank: usize,
        rule: LineFillRule,
    ) -> Result<(), RoundedFillError> {
        let mut left_winding = 0i64;
        let mut right_winding = 0i64;
        for edge_index in 0..self.edges.len() {
            self.charge()?;
            let edge = self.edges[edge_index];
            if edge.a.x == edge.b.x {
                continue;
            }
            let active_left = edge.low_column < column && column <= edge.high_column;
            let active_right = edge.low_column <= column && column < edge.high_column;
            if active_left || active_right {
                let node = self.lookup_section_node(column, edge_index, 0)?;
                let node_rank = self.node_rank(column, node)?;
                if node_rank <= rank {
                    let delta = edge_winding(edge);
                    if active_left {
                        left_winding = left_winding
                            .checked_add(delta)
                            .ok_or(RoundedFillError::InternalInvariant)?;
                    }
                    if active_right {
                        right_winding = right_winding
                            .checked_add(delta)
                            .ok_or(RoundedFillError::InternalInvariant)?;
                    }
                }
            }
        }

        let contributor_start = self.contributors.len();
        let mut vertical_delta = 0i64;
        for edge_index in 0..self.edges.len() {
            self.charge()?;
            let edge = self.edges[edge_index];
            if edge.a.x != edge.b.x || edge.low_column != column {
                continue;
            }
            let a_node = self.lookup_section_node(column, edge_index, 1)?;
            let b_node = self.lookup_section_node(column, edge_index, 2)?;
            let a_rank = self.node_rank(column, a_node)?;
            let b_rank = self.node_rank(column, b_node)?;
            if a_rank.min(b_rank) <= rank && a_rank.max(b_rank) > rank {
                vertical_delta = vertical_delta
                    .checked_add(vertical_winding(edge))
                    .ok_or(RoundedFillError::InternalInvariant)?;
                self.push_contributor(edge_index)?;
            }
        }
        let vertical_sources = if self.contributors.len() == contributor_start {
            SourceRange::default()
        } else {
            SourceRange {
                start: contributor_start,
                count: self.contributors.len() - contributor_start,
            }
        };

        if left_winding
            .checked_sub(vertical_delta)
            .ok_or(RoundedFillError::InternalInvariant)?
            != right_winding
        {
            return Err(RoundedFillError::InternalInvariant);
        }
        let column_record = self.columns[column];
        let lower = column_record.node_start + rank;
        let upper = lower + 1;
        if self.spans.len() >= self.limits.max_nodes {
            return Err(RoundedFillError::NodeLimit);
        }
        self.spans.push(RoundedColumnSpan {
            column,
            lower,
            upper,
            left_winding,
            right_winding,
            vertical_delta,
            vertical_sources,
        });

        let left_filled = is_filled(left_winding, rule);
        let right_filled = is_filled(right_winding, rule);
        if left_filled != right_filled {
            if vertical_sources.count == 0 {
                return Err(RoundedFillError::InternalInvariant);
            }
            let (from, to) = if left_filled {
                (lower, upper)
            } else {
                (upper, lower)
            };
            self.emit_boundary(RoundedBoundary {
                from,
                to,
                kind: BoundaryKind::Vertical,
                sources: vertical_sources,
                before_winding: left_winding,
                after_winding: right_winding,
            })?;
        }
        Ok(())
    }

    fn node_rank(&self, column: usize, node: usize) -> Result<usize, RoundedFillError> {
        let record = self.columns[column];
        let rank = node
            .checked_sub(record.node_start)
            .ok_or(RoundedFillError::InternalInvariant)?;
        if rank >= record.node_count {
            return Err(RoundedFillError::InternalInvariant);
        }
        Ok(rank)
    }

    fn emit_boundary(&mut self, boundary: RoundedBoundary) -> Result<(), RoundedFillError> {
        if self.boundaries.len() >= self.limits.max_boundaries {
            return Err(RoundedFillError::BoundaryLimit);
        }
        if boundary.from == boundary.to
            || boundary.from >= self.node_meta.len()
            || boundary.to >= self.node_meta.len()
        {
            return Err(RoundedFillError::InternalInvariant);
        }
        let outgoing = self.node_meta[boundary.from]
            .outgoing
            .checked_add(1)
            .ok_or(RoundedFillError::InternalInvariant)?;
        let incoming = self.node_meta[boundary.to]
            .incoming
            .checked_add(1)
            .ok_or(RoundedFillError::InternalInvariant)?;
        self.node_meta[boundary.from].outgoing = outgoing;
        self.node_meta[boundary.to].incoming = incoming;
        self.boundaries.push(boundary);
        self.stats.boundaries += 1;
        Ok(())
    }

    fn build_mesh(&mut self) -> Result<(), RoundedFillError> {
        const USED: u32 = u32::MAX;
        for cell in &self.cells {
            for &node in &cell.nodes {
                self.nodes[node].vertex = Some(USED);
            }
        }
        for node_index in 0..self.nodes.len() {
            if self.nodes[node_index].vertex != Some(USED) {
                continue;
            }
            if self.vertices.len() >= self.limits.max_vertices {
                return Err(RoundedFillError::OutputLimit);
            }
            let vertex =
                u32::try_from(self.vertices.len()).map_err(|_| RoundedFillError::OutputLimit)?;
            let point = self.nodes[node_index].point;
            self.nodes[node_index].vertex = Some(vertex);
            self.vertices.push(point);
            self.include_output(point);
        }

        for cell_index in 0..self.cells.len() {
            let cell = self.cells[cell_index];
            let mut emitted = 0usize;
            if self.emit_triangle(
                [cell.nodes[0], cell.nodes[1], cell.nodes[2]],
                cell.nodes[1] == cell.nodes[2],
            )? {
                emitted += 1;
            }
            if self.emit_triangle(
                [cell.nodes[0], cell.nodes[2], cell.nodes[3]],
                cell.nodes[0] == cell.nodes[3],
            )? {
                emitted += 1;
            }
            if emitted == 0 {
                return Err(RoundedFillError::InternalInvariant);
            }
        }
        Ok(())
    }

    fn emit_triangle(
        &mut self,
        nodes: [usize; 3],
        symbolic_degenerate: bool,
    ) -> Result<bool, RoundedFillError> {
        self.charge()?;
        if symbolic_degenerate {
            return Ok(false);
        }
        let points = [
            self.nodes[nodes[0]].point,
            self.nodes[nodes[1]].point,
            self.nodes[nodes[2]].point,
        ];
        if orient2d(points[0], points[1], points[2])
            .map_err(|_| RoundedFillError::InternalInvariant)?
            != Ordering::Greater
        {
            return Err(RoundedFillError::InternalInvariant);
        }
        if self.indices.len() / 3 >= self.limits.max_triangles {
            return Err(RoundedFillError::OutputLimit);
        }
        for node in nodes {
            let vertex = self.nodes[node]
                .vertex
                .filter(|index| *index != u32::MAX)
                .ok_or(RoundedFillError::InternalInvariant)?;
            self.indices.push(vertex);
        }
        Ok(true)
    }

    fn include_output(&mut self, point: Point) {
        if self.has_bounds {
            self.bounds.min_x = self.bounds.min_x.min(point.x);
            self.bounds.min_y = self.bounds.min_y.min(point.y);
            self.bounds.max_x = self.bounds.max_x.max(point.x);
            self.bounds.max_y = self.bounds.max_y.max(point.y);
        } else {
            self.bounds = Bounds {
                min_x: point.x,
                min_y: point.y,
                max_x: point.x,
                max_y: point.y,
            };
            self.has_bounds = true;
        }
    }

    fn compare_events(
        &mut self,
        left: FillEvent,
        right: FillEvent,
    ) -> Result<Ordering, RoundedFillError> {
        self.compare_event_x_charged(left, right)
    }

    fn compare_event_x_charged(
        &mut self,
        left: FillEvent,
        right: FillEvent,
    ) -> Result<Ordering, RoundedFillError> {
        self.charge()?;
        compare_event_x(left, right).map_err(map_event_error)
    }

    fn charge(&mut self) -> Result<(), RoundedFillError> {
        if self.stats.work_units >= self.limits.max_work {
            return Err(RoundedFillError::WorkLimit);
        }
        self.stats.work_units += 1;
        Ok(())
    }

    fn actual_allocated_bytes(&self) -> Result<usize, RoundedFillError> {
        allocation_bytes(&[
            (self.edges.capacity(), size_of::<EdgeState>()),
            (self.events.capacity(), size_of::<FillEvent>()),
            (self.exact_columns.capacity(), size_of::<FillEvent>()),
            (self.column_sections.capacity(), size_of::<SourceRange>()),
            (self.node_meta.capacity(), size_of::<NodeMeta>()),
            (self.active.capacity(), size_of::<ActiveEdge>()),
            (self.source_edges.capacity(), size_of::<RoundedSourceEdge>()),
            (self.columns.capacity(), size_of::<RoundedColumn>()),
            (self.nodes.capacity(), size_of::<RoundedNode>()),
            (self.sections.capacity(), size_of::<RoundedSection>()),
            (self.cells.capacity(), size_of::<RoundedCell>()),
            (self.boundaries.capacity(), size_of::<RoundedBoundary>()),
            (self.spans.capacity(), size_of::<RoundedColumnSpan>()),
            (self.contributors.capacity(), size_of::<usize>()),
            (self.vertices.capacity(), size_of::<Point>()),
            (self.indices.capacity(), size_of::<u32>()),
        ])
    }
}
