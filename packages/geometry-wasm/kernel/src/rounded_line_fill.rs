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

/// `Clone` exists only in test builds: oracle O10 runs the `cfg(test)` reference loops on a clone
/// of the workspace state (B0R contract section 10, unit U6).
#[cfg_attr(test, derive(Clone))]
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
        #[cfg(test)]
        if crate::fill_filter::shadow_active() {
            return self.b0r_shadow_event_loop(EventLoop::Collect);
        }
        self.collect_events_restructured()
    }

    /// B0R L1 (contract section 5.4): the endpoint events as before, then the crossing pairs.
    /// With at most `SWEEP_EDGES` edges only the box-overlapping pairs run their body
    /// (`collect_crossings_swept`); otherwise the current all-pairs loop below runs (size guard).
    fn collect_events_restructured(&mut self) -> Result<(), RoundedFillError> {
        for edge_index in 0..self.edges.len() {
            let edge = self.edges[edge_index];
            self.push_event(FillEvent::Endpoint(edge.a))?;
            self.push_event(FillEvent::Endpoint(edge.b))?;
        }
        if self.edges.len() <= SWEEP_EDGES {
            return self.collect_crossings_swept();
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
        #[cfg(test)]
        if crate::fill_filter::shadow_active() {
            return self.b0r_shadow_event_loop(EventLoop::Sort);
        }
        self.sort_events_restructured()
    }

    /// B0R L2 (contract section 5.4): with at most `MERGE_SORT_EVENTS` events, the stable merge
    /// sort with the Lemma D charge count (`sort_events_merged`). If the size guard fails, or a
    /// comparator call returned an error, the current insertion sort below runs on the untouched
    /// `events` from the start.
    fn sort_events_restructured(&mut self) -> Result<(), RoundedFillError> {
        if self.events.len() <= MERGE_SORT_EVENTS {
            if let Some(result) = self.sort_events_merged() {
                return result;
            }
        }
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

    /// B0R L1, the crossing pairs of at most `SWEEP_EDGES` edges (contract sections 4.3 and 5.4).
    ///
    /// The current loop visits every pair `left < right` in lexicographic order and, per pair,
    /// charges one unit, counts one `pair_checks`, then runs `segment_relation` and pushes a
    /// `ProperCrossing`. Edge boxes are exact (binary64 endpoints), and a pair whose closed
    /// boxes are disjoint is `Disjoint` by F0.3, while `segment_relation` cannot fail on the
    /// validated finite edges; so outside the box-overlapping pairs the body has no effect.
    ///
    /// Corollary C1 with the pair rank as the iteration index: before the body of the candidate
    /// at rank k, the outer charges of iterations `consumed..=k` are applied by one Lemma C bulk
    /// charge, whose counted variant adds the successful charges to `pair_checks`; after the
    /// last candidate, the remaining `total - consumed` iterations. Each body therefore runs at
    /// the same `work_units` and `pair_checks`, in the same order, as in the current loop, and a
    /// `WorkLimit` or `EventLimit` failure leaves the same counters and pushed events.
    fn collect_crossings_swept(&mut self) -> Result<(), RoundedFillError> {
        let count = self.edges.len();
        debug_assert!(count <= SWEEP_EDGES);
        let mut rows = [0u64; SWEEP_EDGES];
        sweep_box_overlaps(&self.edges, |left, right| rows[left] |= 1u64 << right);
        let total = pair_count(count).ok_or(RoundedFillError::InternalInvariant)?;
        #[cfg(test)]
        {
            let candidates: u64 = rows.iter().map(|row| u64::from(row.count_ones())).sum();
            b0r_count_loops(|counts| {
                counts.swept_calls += 1;
                counts.logical_pairs += total as u64;
                counts.candidate_pairs += candidates;
            });
            if crate::fill_filter::fault_active(crate::fill_filter::Fault::L1SortedByX) {
                return self.b0r_collect_crossings_sorted_by_x(total);
            }
        }
        let mut consumed = 0usize;
        for (left, &marks) in rows.iter().enumerate().take(count) {
            let mut row = marks;
            while row != 0 {
                let right = row.trailing_zeros() as usize;
                row &= row - 1;
                let rank = pair_rank(count, left, right);
                let mut outer = rank - consumed + 1;
                if crate::fill_filter::fault_active(crate::fill_filter::Fault::C1OuterChargeShort) {
                    outer -= 1;
                }
                self.bulk_charge_pairs(outer)?;
                self.crossing_pair(left, right)?;
                consumed = rank + 1;
            }
        }
        self.bulk_charge_pairs(total - consumed)
    }

    /// The body of one `collect_events` pair iteration after its charge, unchanged.
    fn crossing_pair(&mut self, left: usize, right: usize) -> Result<(), RoundedFillError> {
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
        Ok(())
    }

    /// B0R L2 (contract section 5.4): returns `None` if a comparator call returned an error, with
    /// `events` and every counter untouched, so the caller runs the current insertion sort.
    ///
    /// Otherwise the stable merge sort gives the same permutation as the stable insertion sort
    /// (the exact x comparison is a total preorder, so the stable order is unique), and Lemma D
    /// gives the insertion sort's comparison count C, which Lemma C charges in bulk: on success
    /// `work_units` grows by C and the permutation is applied; on failure `work_units` becomes
    /// `max_work` and `WorkLimit` returns with `events` unsorted. That content is scratch that no
    /// output or counter reads after a failure (P3.2e:140). The current sort performs nothing but
    /// charges and comparisons until its first comparator error, and comparator errors depend on
    /// one operand at a time; `stable_sort_charges` compares every element at least once, so
    /// both agree on whether an error exists, and the fallback starts at the same `work_units`.
    fn sort_events_merged(&mut self) -> Option<Result<(), RoundedFillError>> {
        let count = self.events.len();
        let mut order = [0u16; MERGE_SORT_EVENTS];
        let events = &self.events;
        let Ok(charges) = stable_sort_charges(count, &mut order, |left, right| {
            compare_event_x(events[left], events[right])
        }) else {
            #[cfg(test)]
            b0r_count_loops(|counts| counts.insertion_fallbacks += 1);
            return None;
        };
        #[cfg(test)]
        b0r_count_loops(|counts| {
            counts.merge_sorts += 1;
            counts.merge_sorted_events += count as u64;
            counts.emulated_charges += charges;
        });
        if let Err(error) = self.bulk_charge(charges).1 {
            return Some(Err(error));
        }
        // `exact_columns` is empty until `build_exact_columns` and has capacity `max_events`, so
        // it holds the permuted copy without allocating; it is cleared again afterwards.
        debug_assert!(self.exact_columns.is_empty());
        for &index in &order[..count] {
            self.exact_columns.push(self.events[usize::from(index)]);
        }
        self.events.copy_from_slice(&self.exact_columns);
        self.exact_columns.clear();
        Some(Ok(()))
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
        let mut sweep = EdgeColumnSweep::guarded(&self.edges);
        for column_index in 0..self.exact_columns.len() {
            // T1: the column's section is built only if an embedding step falls back.
            let x_source = SectionSource::Column(self.exact_columns[column_index]);
            #[cfg(test)]
            self.b0r_shadow_column_source(x_source, column_index);
            let (x, x_rank) = self.embed_scalar(x_source, previous_x, tau)?;
            previous_x = Some(x_rank);

            let section_start = self.sections.len();
            // B0R L3 (contract section 5.4): with at most `SWEEP_EDGES` edges the swept scan runs
            // and the current loop below has no iteration; otherwise the current loop runs.
            let fallback_edges = self.scan_column_sections(column_index, &mut sweep)?;
            for edge_index in 0..fallback_edges {
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
        let mut sweep = EdgeColumnSweep::guarded(&self.edges);
        for slab in 0..self.exact_columns.len().saturating_sub(1) {
            // T5: the mediant sample and the active sections are built only when a comparison
            // falls back (`compare_slab_sections`). Both columns passed `compare_event_x`, so
            // the eager `exact_column` calls that preceded this slab's charges could not fail.
            let mut sample =
                SlabSample::new(self.exact_columns[slab], self.exact_columns[slab + 1]);
            self.active.clear();
            // B0R L3: the swept scan, or the current loop below (size guard).
            let fallback_edges = self.scan_slab_active(slab, &mut sweep)?;
            for edge_index in 0..fallback_edges {
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
        #[cfg(test)]
        if let Some(result) = self.b0r_shadow_scan(ScanLoop::Lookup {
            column,
            edge,
            endpoint,
        }) {
            return result.map(|(node, _)| node as usize);
        }
        let range = self.column_sections[column];
        let end = range
            .start
            .checked_add(range.count)
            .ok_or(RoundedFillError::InternalInvariant)?;
        // B0R L4 (contract section 5.4): the current loop charges one unit per candidate up to
        // and including the match and reads nothing observable otherwise. So an uncharged scan
        // followed by one Lemma C bulk charge of q + 1 units for a match at offset q, or of
        // `range.count` units followed by `InternalInvariant` without a match, gives the same
        // result, `work_units` and `WorkLimit` point. The range was recorded from the pushes
        // into `sections`, so the uncharged scan reads only elements the current loop may read.
        for index in range.start..end {
            let section = self.sections[index];
            if section.edge == edge && section.endpoint == endpoint {
                let mut charges = index - range.start + 1;
                if crate::fill_filter::fault_active(crate::fill_filter::Fault::L4ChargeShort) {
                    charges -= 1;
                }
                #[cfg(test)]
                b0r_count_scans(|counts| {
                    counts.lookups += 1;
                    counts.lookup_charges += charges as u64;
                });
                self.bulk_charge(charges as u64).1?;
                return Ok(section.node);
            }
        }
        #[cfg(test)]
        b0r_count_scans(|counts| {
            counts.lookups += 1;
            counts.lookup_charges += range.count as u64;
        });
        self.bulk_charge(range.count as u64).1?;
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

        let mut sweep = EdgeColumnSweep::guarded(&self.edges);
        for column_index in 0..self.columns.len() {
            let column = self.columns[column_index];
            let swept = sweep
                .as_mut()
                .map(|sweep| sweep.column_sets(&self.edges, column_index));
            for rank in 0..column.node_count.saturating_sub(1) {
                self.build_column_span(column_index, rank, rule, swept)?;
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
        swept: Option<ColumnEdgeSets>,
    ) -> Result<(), RoundedFillError> {
        let mut left_winding = 0i64;
        let mut right_winding = 0i64;
        // B0R L3: the swept scans, or the current loops below (size guard).
        let fallback_edges =
            self.scan_span_windings(column, rank, swept, &mut left_winding, &mut right_winding)?;
        for edge_index in 0..fallback_edges {
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
        let fallback_edges = self.scan_span_verticals(column, rank, swept, &mut vertical_delta)?;
        for edge_index in 0..fallback_edges {
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

    /// Lemma C (contract section 5.4): equivalent to `count` consecutive `charge()` calls with
    /// nothing in between. Each call fails exactly when `work_units >= max_work`, so the sequence
    /// fails if and only if `work_units + count > max_work`, and a failing sequence leaves
    /// `work_units = max_work`. Returns the number of calls that would have succeeded,
    /// min(count, max_work - work_units), with the result of the sequence.
    fn bulk_charge(&mut self, count: u64) -> (u64, Result<(), RoundedFillError>) {
        if count == 0 {
            return (0, Ok(()));
        }
        // As in `charge()`: the first call fails without changing `work_units`.
        if self.stats.work_units >= self.limits.max_work {
            return (0, Err(RoundedFillError::WorkLimit));
        }
        let remaining = self.limits.max_work - self.stats.work_units;
        if count > remaining {
            self.stats.work_units = self.limits.max_work;
            return (remaining, Err(RoundedFillError::WorkLimit));
        }
        self.stats.work_units += count;
        (count, Ok(()))
    }

    /// Lemma C's counted variant for `collect_events`: each successful outer charge of the
    /// current pair loop is followed by `pair_checks += 1`.
    fn bulk_charge_pairs(&mut self, count: usize) -> Result<(), RoundedFillError> {
        let (charged, result) = self.bulk_charge(count as u64);
        self.stats.pair_checks += charged as usize;
        result
    }

    /// Corollary C1 (contract section 5.4), a sparse charged scan: equivalent to the current
    /// `for edge in 0..n { charge()?; body(edge)? }` when `body` has no effect (no state change,
    /// no error, no charge) for every edge outside `active`. Before the body of the active edge
    /// k, one Lemma C bulk charge applies the outer charges of the iterations `consumed..=k`;
    /// after the last active edge, the remaining `n - consumed`. Each body, including its own
    /// charges (the `lookup_section_node` calls of `build_column_span`) and its failures, runs
    /// at the same `work_units`, in the same ascending edge order and with the same state.
    fn sparse_charged_scan(
        &mut self,
        active: u64,
        mut body: impl FnMut(&mut Self, usize) -> Result<(), RoundedFillError>,
    ) -> Result<(), RoundedFillError> {
        let count = self.edges.len();
        debug_assert!(count <= SWEEP_EDGES);
        debug_assert!(count == SWEEP_EDGES || active >> count == 0);
        #[cfg(test)]
        b0r_count_scans(|counts| {
            counts.scans += 1;
            counts.iterations += count as u64;
            counts.members += u64::from(active.count_ones());
        });
        let mut consumed = 0usize;
        let mut rest = active;
        while rest != 0 {
            let edge = rest.trailing_zeros() as usize;
            rest &= rest - 1;
            let mut outer = edge - consumed + 1;
            if crate::fill_filter::fault_active(crate::fill_filter::Fault::L3OuterChargeShort) {
                outer -= 1;
            }
            self.bulk_charge(outer as u64).1?;
            body(self, edge)?;
            consumed = edge + 1;
        }
        self.bulk_charge((count - consumed) as u64).1
    }

    /// B0R L3 for the section scan of `build_sections_and_nodes`: returns the number of
    /// iterations left for the current loop, zero once the swept scan ran, or every edge when
    /// the size guard fails.
    fn scan_column_sections(
        &mut self,
        column: usize,
        sweep: &mut Option<EdgeColumnSweep>,
    ) -> Result<usize, RoundedFillError> {
        let Some(sweep) = sweep.as_mut() else {
            return Ok(self.edges.len());
        };
        let active = sweep.column_sets(&self.edges, column).all;
        #[cfg(test)]
        if let Some(result) = self.b0r_shadow_scan(ScanLoop::Sections { column, active }) {
            return result.map(|_| 0);
        }
        self.swept_column_sections(column, active)?;
        Ok(0)
    }

    /// The swept section scan. `active` holds the nonvertical edges with
    /// `low <= column <= high` and the vertical edges with `low == column` (a vertical edge has
    /// `low == high`); every other edge only tests and continues in the current loop.
    fn swept_column_sections(
        &mut self,
        column: usize,
        active: u64,
    ) -> Result<(), RoundedFillError> {
        self.sparse_charged_scan(active, |workspace, edge_index| {
            workspace.column_section_body(column, edge_index)
        })
    }

    /// The body of one section-scan iteration after its charge, unchanged.
    fn column_section_body(
        &mut self,
        column_index: usize,
        edge_index: usize,
    ) -> Result<(), RoundedFillError> {
        let edge = self.edges[edge_index];
        if edge.a.x != edge.b.x {
            if edge.low_column <= column_index && column_index <= edge.high_column {
                self.push_section(column_index, edge_index, 0)?;
            }
        } else if edge.low_column == column_index {
            self.push_section(column_index, edge_index, 1)?;
            self.push_section(column_index, edge_index, 2)?;
        }
        Ok(())
    }

    /// B0R L3 for the active-edge scan of `build_cells`, as `scan_column_sections`.
    fn scan_slab_active(
        &mut self,
        slab: usize,
        sweep: &mut Option<EdgeColumnSweep>,
    ) -> Result<usize, RoundedFillError> {
        let Some(sweep) = sweep.as_mut() else {
            return Ok(self.edges.len());
        };
        let active = sweep.slab_set(&self.edges, slab);
        #[cfg(test)]
        if let Some(result) = self.b0r_shadow_scan(ScanLoop::Slab { slab, active }) {
            return result.map(|_| 0);
        }
        self.swept_slab_active(slab, active)?;
        Ok(0)
    }

    /// The swept active-edge scan. `active` holds the edges with `low <= slab < high`, which
    /// are nonvertical; every other edge only tests in the current loop.
    fn swept_slab_active(&mut self, slab: usize, active: u64) -> Result<(), RoundedFillError> {
        self.sparse_charged_scan(active, |workspace, edge_index| {
            workspace.slab_active_body(slab, edge_index);
            Ok(())
        })
    }

    /// The body of one active-edge-scan iteration after its charge, unchanged.
    fn slab_active_body(&mut self, slab: usize, edge_index: usize) {
        let edge = self.edges[edge_index];
        if edge.a.x != edge.b.x && edge.low_column <= slab && slab < edge.high_column {
            self.active.push(ActiveEdge {
                edge: edge_index,
                section: ExactSection::unbuilt(),
            });
        }
    }

    /// B0R L3 for the first scan of `build_column_span`, as `scan_column_sections`; the
    /// windings are added to `left_winding` and `right_winding`.
    fn scan_span_windings(
        &mut self,
        column: usize,
        rank: usize,
        swept: Option<ColumnEdgeSets>,
        left_winding: &mut i64,
        right_winding: &mut i64,
    ) -> Result<usize, RoundedFillError> {
        let Some(sets) = swept else {
            return Ok(self.edges.len());
        };
        #[cfg(test)]
        if let Some(result) = self.b0r_shadow_scan(ScanLoop::Windings {
            column,
            rank,
            active: sets.nonvertical,
        }) {
            let (left, right) = result?;
            *left_winding += left;
            *right_winding += right;
            return Ok(0);
        }
        self.swept_span_windings(column, rank, sets.nonvertical, left_winding, right_winding)?;
        Ok(0)
    }

    /// The swept winding scan. `active` holds the nonvertical edges with
    /// `low <= column <= high`, which for a nonvertical edge (`low < high`) are exactly those
    /// active on the left or the right; every other edge only tests and continues.
    fn swept_span_windings(
        &mut self,
        column: usize,
        rank: usize,
        active: u64,
        left_winding: &mut i64,
        right_winding: &mut i64,
    ) -> Result<(), RoundedFillError> {
        self.sparse_charged_scan(active, |workspace, edge_index| {
            workspace.span_winding_body(column, rank, edge_index, left_winding, right_winding)
        })
    }

    /// The body of one winding-scan iteration after its charge, unchanged (its
    /// `lookup_section_node` call charges).
    fn span_winding_body(
        &mut self,
        column: usize,
        rank: usize,
        edge_index: usize,
        left_winding: &mut i64,
        right_winding: &mut i64,
    ) -> Result<(), RoundedFillError> {
        let edge = self.edges[edge_index];
        if edge.a.x == edge.b.x {
            return Ok(());
        }
        let active_left = edge.low_column < column && column <= edge.high_column;
        let active_right = edge.low_column <= column && column < edge.high_column;
        if active_left || active_right {
            let node = self.lookup_section_node(column, edge_index, 0)?;
            let node_rank = self.node_rank(column, node)?;
            if node_rank <= rank {
                let delta = edge_winding(edge);
                if active_left {
                    *left_winding = left_winding
                        .checked_add(delta)
                        .ok_or(RoundedFillError::InternalInvariant)?;
                }
                if active_right {
                    *right_winding = right_winding
                        .checked_add(delta)
                        .ok_or(RoundedFillError::InternalInvariant)?;
                }
            }
        }
        Ok(())
    }

    /// B0R L3 for the second scan of `build_column_span`, as `scan_column_sections`; the
    /// vertical windings are added to `vertical_delta`.
    fn scan_span_verticals(
        &mut self,
        column: usize,
        rank: usize,
        swept: Option<ColumnEdgeSets>,
        vertical_delta: &mut i64,
    ) -> Result<usize, RoundedFillError> {
        let Some(sets) = swept else {
            return Ok(self.edges.len());
        };
        #[cfg(test)]
        if let Some(result) = self.b0r_shadow_scan(ScanLoop::Verticals {
            column,
            rank,
            active: sets.vertical,
        }) {
            *vertical_delta += result?.0;
            return Ok(0);
        }
        self.swept_span_verticals(column, rank, sets.vertical, vertical_delta)?;
        Ok(0)
    }

    /// The swept vertical scan. `active` holds the vertical edges with `low == column`; every
    /// other edge only tests and continues.
    fn swept_span_verticals(
        &mut self,
        column: usize,
        rank: usize,
        active: u64,
        vertical_delta: &mut i64,
    ) -> Result<(), RoundedFillError> {
        self.sparse_charged_scan(active, |workspace, edge_index| {
            workspace.span_vertical_body(column, rank, edge_index, vertical_delta)
        })
    }

    /// The body of one vertical-scan iteration after its charge, unchanged (its two
    /// `lookup_section_node` calls charge, and `push_contributor` may fail).
    fn span_vertical_body(
        &mut self,
        column: usize,
        rank: usize,
        edge_index: usize,
        vertical_delta: &mut i64,
    ) -> Result<(), RoundedFillError> {
        let edge = self.edges[edge_index];
        if edge.a.x != edge.b.x || edge.low_column != column {
            return Ok(());
        }
        let a_node = self.lookup_section_node(column, edge_index, 1)?;
        let b_node = self.lookup_section_node(column, edge_index, 2)?;
        let a_rank = self.node_rank(column, a_node)?;
        let b_rank = self.node_rank(column, b_node)?;
        if a_rank.min(b_rank) <= rank && a_rank.max(b_rank) > rank {
            *vertical_delta = vertical_delta
                .checked_add(vertical_winding(edge))
                .ok_or(RoundedFillError::InternalInvariant)?;
            self.push_contributor(edge_index)?;
        }
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

/// L1 size guard (contract section 5.4): the sweep's `[u64; 64]` bitset and `[u8; 64]` order
/// hold at most 64 edges. Today's `LIMITS` and `FILL_V0_LIMITS` allow 64 edges; a workspace
/// with more edges runs the current all-pairs loop.
const SWEEP_EDGES: usize = 64;

/// L2 size guard (contract section 5.4): the merge sort's two `[u16; 256]` index arrays hold at
/// most 256 events. Today's caps allow 128 events; more events run the current insertion sort.
const MERGE_SORT_EVENTS: usize = 256;

/// The closed coordinate box of one edge. Edge endpoints are finite binary64 values, so the box
/// is exact.
#[derive(Clone, Copy, Default)]
struct EdgeBox {
    x_lo: f64,
    x_hi: f64,
    y_lo: f64,
    y_hi: f64,
}

impl EdgeBox {
    fn of(edge: EdgeState) -> Self {
        Self {
            x_lo: edge.a.x.min(edge.b.x),
            x_hi: edge.a.x.max(edge.b.x),
            y_lo: edge.a.y.min(edge.b.y),
            y_hi: edge.a.y.max(edge.b.y),
        }
    }
}

/// Section 4.3's sweep over edge boxes: calls `mark(min, max)` once for every pair of edges
/// whose closed boxes overlap, which is every pair that F0.3 does not decide `Disjoint`.
///
/// The edge indices are insertion-sorted by `x_lo` into a `[u8; 64]` stack array (tie order does
/// not matter, because the marks are a set). For each edge a in that order, the following edges
/// b are scanned while `x_lo_b <= x_hi_a`; since `x_lo_a <= x_lo_b <= x_hi_b`, these are exactly
/// the later edges whose x ranges overlap a's, and every edge after the first failing one has an
/// even larger `x_lo`. A pair is marked when the y ranges also overlap. With finite coordinates
/// the overlap tests are the negations of F0.3's strict separation tests. Scratch: 2 KiB of
/// boxes and the 64-byte order, on the stack.
fn sweep_box_overlaps(edges: &[EdgeState], mut mark: impl FnMut(usize, usize)) {
    let count = edges.len();
    debug_assert!(count <= SWEEP_EDGES);
    let mut boxes = [EdgeBox::default(); SWEEP_EDGES];
    let mut order = [0u8; SWEEP_EDGES];
    for (index, edge) in edges.iter().enumerate() {
        boxes[index] = EdgeBox::of(*edge);
        let mut cursor = index;
        while cursor > 0 && boxes[usize::from(order[cursor - 1])].x_lo > boxes[index].x_lo {
            order[cursor] = order[cursor - 1];
            cursor -= 1;
        }
        order[cursor] = index as u8;
    }
    for (position, &first) in order[..count].iter().enumerate() {
        let a = boxes[usize::from(first)];
        for &second in &order[position + 1..count] {
            let b = boxes[usize::from(second)];
            if b.x_lo > a.x_hi {
                break;
            }
            if b.y_lo <= a.y_hi && a.y_lo <= b.y_hi {
                let (first, second) = (usize::from(first), usize::from(second));
                mark(first.min(second), first.max(second));
            }
        }
    }
}

/// The zero-based iteration index of the pair `left < right` in the current lexicographic pair
/// loop over `count` edges (Lemma B's rank): i(2n - i - 1)/2 + (j - i - 1). The product
/// i(2n - i - 1) is even, because i and 2n - i - 1 have opposite parities.
fn pair_rank(count: usize, left: usize, right: usize) -> usize {
    left * (2 * count - left - 1) / 2 + (right - left - 1)
}

/// The active edge sets of one column for B0R L3 (contract section 5.4), as `u64` bitsets over
/// edge indices.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ColumnEdgeSets {
    /// Edges with `low_column <= column <= high_column`: the nonvertical edges spanning the
    /// column and the vertical edges on it (a vertical edge has `low_column == high_column`).
    all: u64,
    /// The nonvertical edges of `all`.
    nonvertical: u64,
    /// The vertical edges of `all`, that is, the vertical edges with `low_column == column`.
    vertical: u64,
}

/// B0R L3's incremental active sets over the columns or slabs of one phase, for at most
/// `SWEEP_EDGES` edges with assigned columns.
///
/// The edge indices are insertion-sorted by `low_column` and by `high_column` into two
/// `[u8; 64]` stack arrays. `advance(upto, from)` adds every edge with `low_column <= upto` and
/// then removes every edge with `high_column < from`; with `upto` and `from` non-decreasing
/// across the calls of a phase and `from <= upto + 1`, the set is then exactly
/// {e : low <= upto and high >= from}. An edge leaves only after it entered: `high < from`
/// implies `low <= high <= upto`, so it was added in the same call or earlier. Each edge enters
/// and leaves at most once, so a phase costs O(columns + edges) after the two sorts of at most
/// 64 entries. Scratch: under 200 bytes on the stack.
struct EdgeColumnSweep {
    by_low: [u8; SWEEP_EDGES],
    by_high: [u8; SWEEP_EDGES],
    count: usize,
    added: usize,
    removed: usize,
    set: u64,
    vertical: u64,
}

impl EdgeColumnSweep {
    /// The sweep, or `None` when the size guard fails (more than `SWEEP_EDGES` edges), in which
    /// case the current loops run.
    fn guarded(edges: &[EdgeState]) -> Option<Self> {
        if edges.len() > SWEEP_EDGES {
            return None;
        }
        let mut sweep = Self {
            by_low: [0; SWEEP_EDGES],
            by_high: [0; SWEEP_EDGES],
            count: edges.len(),
            added: 0,
            removed: 0,
            set: 0,
            vertical: 0,
        };
        for (index, edge) in edges.iter().enumerate() {
            sweep.vertical |= u64::from(edge.a.x == edge.b.x) << index;
            insert_by_key(&mut sweep.by_low, index, |at| {
                edges[usize::from(at)].low_column > edge.low_column
            });
            insert_by_key(&mut sweep.by_high, index, |at| {
                edges[usize::from(at)].high_column > edge.high_column
            });
        }
        #[cfg(test)]
        b0r_count_scans(|counts| counts.sweeps += 1);
        Some(sweep)
    }

    fn advance(&mut self, edges: &[EdgeState], upto: usize, from: usize) -> u64 {
        while self.added < self.count {
            let edge = usize::from(self.by_low[self.added]);
            if edges[edge].low_column > upto {
                break;
            }
            self.set |= 1u64 << edge;
            self.added += 1;
        }
        while self.removed < self.count {
            let edge = usize::from(self.by_high[self.removed]);
            if edges[edge].high_column >= from {
                break;
            }
            self.set &= !(1u64 << edge);
            self.removed += 1;
        }
        self.set
    }

    /// The sets of `column`; columns must be visited in non-decreasing order.
    fn column_sets(&mut self, edges: &[EdgeState], column: usize) -> ColumnEdgeSets {
        let all = self.advance(edges, column, column);
        ColumnEdgeSets {
            all,
            nonvertical: all & !self.vertical,
            vertical: all & self.vertical,
        }
    }

    /// The edges with `low_column <= slab < high_column`, all nonvertical; slabs must be
    /// visited in non-decreasing order.
    fn slab_set(&mut self, edges: &[EdgeState], slab: usize) -> u64 {
        self.advance(edges, slab, slab + 1)
    }
}

/// Inserts `index` into the sorted prefix `order[..index]`, after every entry for which
/// `greater` is false (a stable insertion step).
fn insert_by_key(order: &mut [u8; SWEEP_EDGES], index: usize, greater: impl Fn(u8) -> bool) {
    let mut cursor = index;
    while cursor > 0 && greater(order[cursor - 1]) {
        order[cursor] = order[cursor - 1];
        cursor -= 1;
    }
    order[cursor] = index as u8;
}

/// B0R L2's stable bottom-up merge sort of the indices `0..count` with Lemma D's charge count
/// (contract section 5.4). Writes the stable sorted permutation into `order[..count]` and
/// returns C, the number of comparisons the current stable insertion sort makes, or the first
/// comparator error. Nothing is charged here.
///
/// Lemma D: inserting the element at index i >= 1 makes g_i shifting comparisons (g_i earlier
/// elements are strictly greater) plus one stopping comparison unless all i earlier elements are
/// greater, so C = sum g_i + (n - 1) - m, with m the number of indices i >= 1 whose element is
/// strictly less than every earlier element. The merge counts sum g_i: a run holds a contiguous
/// range of input positions, and when the right run's head is taken because the left head is
/// strictly greater, every remaining left-run element (at least the left head) is strictly
/// greater too, while every left-run element already taken is at most it. The extra pass keeps
/// the running minimum: an element is strictly less than every earlier one exactly when it is
/// strictly less than their minimum. That pass alone compares every element at least once for
/// n >= 2, which the comparator-error fallback relies on.
pub(crate) fn stable_sort_charges<E>(
    count: usize,
    order: &mut [u16; MERGE_SORT_EVENTS],
    mut compare: impl FnMut(usize, usize) -> Result<Ordering, E>,
) -> Result<u64, E> {
    assert!(count <= MERGE_SORT_EVENTS);
    for (slot, index) in order.iter_mut().zip(0u16..).take(count) {
        *slot = index;
    }
    let mut scratch = [0u16; MERGE_SORT_EVENTS];
    let mut inversions = 0u64;
    let mut sorted_in_order = true;
    let mut width = 1usize;
    while width < count {
        if sorted_in_order {
            merge_runs(
                &order[..count],
                &mut scratch[..count],
                width,
                &mut compare,
                &mut inversions,
            )?;
        } else {
            merge_runs(
                &scratch[..count],
                &mut order[..count],
                width,
                &mut compare,
                &mut inversions,
            )?;
        }
        sorted_in_order = !sorted_in_order;
        width *= 2;
    }
    if !sorted_in_order {
        order[..count].copy_from_slice(&scratch[..count]);
    }
    if count == 0 {
        return Ok(0);
    }
    let mut minima = 0u64;
    let mut minimum = 0usize;
    for index in 1..count {
        if compare(minimum, index)? == Ordering::Greater {
            minima += 1;
            minimum = index;
        }
    }
    if crate::fill_filter::fault_active(crate::fill_filter::Fault::LemmaDWithoutMinimum) {
        minima = 0;
    }
    Ok(inversions + (count as u64 - 1) - minima)
}

/// One bottom-up merge pass of runs of `width` from `source` into `target`, stable (the left
/// element is taken unless it is strictly greater), adding the strict inversions it resolves.
fn merge_runs<E>(
    source: &[u16],
    target: &mut [u16],
    width: usize,
    compare: &mut impl FnMut(usize, usize) -> Result<Ordering, E>,
    inversions: &mut u64,
) -> Result<(), E> {
    let count = source.len();
    let mut start = 0usize;
    while start < count {
        let middle = (start + width).min(count);
        let end = (start + 2 * width).min(count);
        let (mut left, mut right, mut out) = (start, middle, start);
        while left < middle && right < end {
            if compare(usize::from(source[left]), usize::from(source[right]))? == Ordering::Greater
            {
                target[out] = source[right];
                right += 1;
                *inversions += (middle - left) as u64;
            } else {
                target[out] = source[left];
                left += 1;
            }
            out += 1;
        }
        let rest = middle - left;
        target[out..out + rest].copy_from_slice(&source[left..middle]);
        out += rest;
        target[out..out + (end - right)].copy_from_slice(&source[right..end]);
        start = end;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// B0R U6 test machinery (`cfg(test)` only): the reference loops, oracle O10's shadow comparison
// of L1 and L2, the O8 fault path of defect (13) and test access for O11.

/// The two loops restructured by unit U6.
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EventLoop {
    /// `collect_events` (L1).
    Collect,
    /// `sort_events` (L2).
    Sort,
}

/// Which implementation of an `EventLoop` runs.
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LoopImpl {
    /// The production code: L1 or L2 behind its size guard.
    Restructured,
    /// The pre-U6 loop, kept verbatim as the O10 reference.
    Reference,
}

/// Per-thread counts of the restructured loops' work (test builds only).
#[cfg(test)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct LoopCounts {
    /// `collect_crossings_swept` calls.
    pub(crate) swept_calls: u64,
    /// Logical pairs n(n - 1)/2 of those calls.
    pub(crate) logical_pairs: u64,
    /// Candidate pairs (overlapping boxes) of those calls.
    pub(crate) candidate_pairs: u64,
    /// Merge sorts without a comparator error.
    pub(crate) merge_sorts: u64,
    /// Events sorted by them.
    pub(crate) merge_sorted_events: u64,
    /// Lemma D charge totals C of them.
    pub(crate) emulated_charges: u64,
    /// Merge sorts abandoned for the insertion sort after a comparator error.
    pub(crate) insertion_fallbacks: u64,
}

#[cfg(test)]
impl LoopCounts {
    pub(crate) fn merge(&mut self, other: Self) {
        self.swept_calls += other.swept_calls;
        self.logical_pairs += other.logical_pairs;
        self.candidate_pairs += other.candidate_pairs;
        self.merge_sorts += other.merge_sorts;
        self.merge_sorted_events += other.merge_sorted_events;
        self.emulated_charges += other.emulated_charges;
        self.insertion_fallbacks += other.insertion_fallbacks;
    }
}

/// Per-thread tally of O10's L1/L2 comparisons with the reference loops (test builds only).
#[cfg(test)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct LoopShadowTally {
    /// Compared `collect_events` runs.
    pub(crate) collect_runs: u64,
    /// Compared `sort_events` runs.
    pub(crate) sort_runs: u64,
    /// Runs whose result, counters or pushed records differed.
    pub(crate) mismatches: u64,
    /// Compared runs whose reference returned `WorkLimit`.
    pub(crate) work_limit: u64,
    /// Compared runs whose reference returned `EventLimit`.
    pub(crate) event_limit: u64,
    /// Compared runs whose reference returned another error.
    pub(crate) other_errors: u64,
}

#[cfg(test)]
impl LoopShadowTally {
    pub(crate) fn merge(&mut self, other: Self) {
        self.collect_runs += other.collect_runs;
        self.sort_runs += other.sort_runs;
        self.mismatches += other.mismatches;
        self.work_limit += other.work_limit;
        self.event_limit += other.event_limit;
        self.other_errors += other.other_errors;
    }
}

#[cfg(test)]
const NO_LOOP_COUNTS: LoopCounts = LoopCounts {
    swept_calls: 0,
    logical_pairs: 0,
    candidate_pairs: 0,
    merge_sorts: 0,
    merge_sorted_events: 0,
    emulated_charges: 0,
    insertion_fallbacks: 0,
};

#[cfg(test)]
const NO_LOOP_TALLY: LoopShadowTally = LoopShadowTally {
    collect_runs: 0,
    sort_runs: 0,
    mismatches: 0,
    work_limit: 0,
    event_limit: 0,
    other_errors: 0,
};

#[cfg(test)]
thread_local! {
    static LOOP_COUNTS: core::cell::Cell<LoopCounts> = const { core::cell::Cell::new(NO_LOOP_COUNTS) };
    static LOOP_TALLY: core::cell::Cell<LoopShadowTally> =
        const { core::cell::Cell::new(NO_LOOP_TALLY) };
    static LOOP_VARIANTS: core::cell::Cell<bool> = const { core::cell::Cell::new(false) };
}

#[cfg(test)]
fn b0r_count_loops(update: impl FnOnce(&mut LoopCounts)) {
    LOOP_COUNTS.with(|counts| {
        let mut value = counts.get();
        update(&mut value);
        counts.set(value);
    });
}

/// Returns and resets this thread's loop counts.
#[cfg(test)]
pub(crate) fn take_loop_counts() -> LoopCounts {
    LOOP_COUNTS.with(|counts| counts.replace(NO_LOOP_COUNTS))
}

/// Returns and resets this thread's O10 loop tally.
#[cfg(test)]
pub(crate) fn take_loop_tally() -> LoopShadowTally {
    LOOP_TALLY.with(|tally| tally.replace(NO_LOOP_TALLY))
}

/// Runs `action` with O10's loop variants on in this thread: in shadow mode each L1 and L2 call
/// is then also compared with the reference under reduced budgets and event limits.
#[cfg(test)]
pub(crate) fn with_loop_variants<T>(action: impl FnOnce() -> T) -> T {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            LOOP_VARIANTS.with(|active| active.set(false));
        }
    }
    LOOP_VARIANTS.with(|active| active.set(true));
    let _reset = Reset;
    action()
}

#[cfg(test)]
fn b0r_record_loop_run(which: EventLoop, expected: Result<(), RoundedFillError>, equal: bool) {
    crate::fill_filter::shadow_check(equal);
    LOOP_TALLY.with(|tally| {
        let mut value = tally.get();
        match which {
            EventLoop::Collect => value.collect_runs += 1,
            EventLoop::Sort => value.sort_runs += 1,
        }
        value.mismatches += u64::from(!equal);
        match expected {
            Ok(()) => {}
            Err(RoundedFillError::WorkLimit) => value.work_limit += 1,
            Err(RoundedFillError::EventLimit) => value.event_limit += 1,
            Err(_) => value.other_errors += 1,
        }
        tally.set(value);
    });
}

/// The bits of every event, for a bit-exact comparison of pushed records.
#[cfg(test)]
pub(crate) fn b0r_event_bits(events: &[FillEvent]) -> Vec<u64> {
    let mut bits = Vec::with_capacity(events.len() * 9);
    for event in events {
        match *event {
            FillEvent::Endpoint(point) => {
                bits.extend([0, point.x.to_bits(), point.y.to_bits()]);
            }
            FillEvent::Crossing { a, b, c, d } => {
                bits.push(1);
                for point in [a, b, c, d] {
                    bits.extend([point.x.to_bits(), point.y.to_bits()]);
                }
            }
        }
    }
    bits
}

#[cfg(test)]
impl RoundedFillWorkspace {
    /// O10 for L1 and L2: runs the restructured loop on this workspace and the reference loop
    /// on a clone of the state before it, and records whether the results, every counter and
    /// the pushed records are equal. After an L2 `WorkLimit` the events are scratch that no
    /// output reads (P3.2e:140) and are not compared. With loop variants on, both loops also
    /// run from clones of the same state under reduced budgets and event limits.
    fn b0r_shadow_event_loop(&mut self, which: EventLoop) -> Result<(), RoundedFillError> {
        let before = self.clone();
        let result = self.b0r_run_loop(which, LoopImpl::Restructured);
        let mut reference = before.clone();
        let expected = reference.b0r_run_loop(which, LoopImpl::Reference);
        let equal = b0r_loop_states_equal(which, &reference, expected, self, result);
        b0r_record_loop_run(which, expected, equal);
        if LOOP_VARIANTS.with(core::cell::Cell::get) {
            for limits in b0r_loop_variants(which, &before, &reference, expected) {
                let mut variant_reference = before.clone();
                variant_reference.limits = limits;
                let mut variant = variant_reference.clone();
                let expected = variant_reference.b0r_run_loop(which, LoopImpl::Reference);
                let result = variant.b0r_run_loop(which, LoopImpl::Restructured);
                let equal =
                    b0r_loop_states_equal(which, &variant_reference, expected, &variant, result);
                b0r_record_loop_run(which, expected, equal);
            }
        }
        result
    }

    /// Runs one event loop without the shadow dispatch.
    pub(crate) fn b0r_run_loop(
        &mut self,
        which: EventLoop,
        implementation: LoopImpl,
    ) -> Result<(), RoundedFillError> {
        match (which, implementation) {
            (EventLoop::Collect, LoopImpl::Restructured) => self.collect_events_restructured(),
            (EventLoop::Collect, LoopImpl::Reference) => self.b0r_reference_collect_events(),
            (EventLoop::Sort, LoopImpl::Restructured) => self.sort_events_restructured(),
            (EventLoop::Sort, LoopImpl::Reference) => self.b0r_reference_sort_events(),
        }
    }

    /// The pre-U6 `collect_events`, verbatim (O10 reference).
    fn b0r_reference_collect_events(&mut self) -> Result<(), RoundedFillError> {
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

    /// The pre-U6 `sort_events`, verbatim (O10 reference).
    fn b0r_reference_sort_events(&mut self) -> Result<(), RoundedFillError> {
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

    /// O8 defect (13): L1 with the candidates processed in the sweep's sorted-by-x discovery
    /// order instead of lexicographic order (the charge emulation saturates where ranks go
    /// back).
    fn b0r_collect_crossings_sorted_by_x(&mut self, total: usize) -> Result<(), RoundedFillError> {
        let count = self.edges.len();
        let mut pairs = Vec::new();
        sweep_box_overlaps(&self.edges, |left, right| pairs.push((left, right)));
        let mut consumed = 0usize;
        for (left, right) in pairs {
            let rank = pair_rank(count, left, right);
            self.bulk_charge_pairs((rank + 1).saturating_sub(consumed))?;
            self.crossing_pair(left, right)?;
            consumed = consumed.max(rank + 1);
        }
        self.bulk_charge_pairs(total - consumed)
    }

    /// Test access: the state before `collect_events`, through the real `copy_edges`.
    pub(crate) fn b0r_load_contours(
        &mut self,
        contours: &[&[Point]],
    ) -> Result<(), RoundedFillError> {
        self.begin_attempt();
        self.copy_edges(contours)
    }

    /// Test access: the state before `sort_events` with the given raw events.
    pub(crate) fn b0r_load_events(&mut self, events: &[FillEvent]) {
        self.begin_attempt();
        self.events.extend_from_slice(events);
        self.stats.events = events.len();
    }

    /// Test access: the starting work counter and the two limits the event loops read.
    pub(crate) fn b0r_set_budget(&mut self, work_units: u64, max_work: u64, max_events: usize) {
        self.stats.work_units = work_units;
        self.limits.max_work = max_work;
        self.limits.max_events = max_events;
    }

    /// Test access: the counters and the events.
    pub(crate) fn b0r_loop_state(&self) -> (RoundedFillStats, &[FillEvent]) {
        (self.stats, &self.events)
    }

    /// Test access: one per-iteration `charge()`, the Lemma C reference, counted into
    /// `pair_checks` like the current pair loop when `counted`.
    pub(crate) fn b0r_charge(&mut self, counted: bool) -> Result<(), RoundedFillError> {
        self.charge()?;
        if counted {
            self.stats.pair_checks += 1;
        }
        Ok(())
    }

    /// Test access: Lemma C's bulk charge, plain or counted into `pair_checks`.
    pub(crate) fn b0r_bulk_charge(
        &mut self,
        count: u64,
        counted: bool,
    ) -> Result<(), RoundedFillError> {
        if counted {
            self.bulk_charge_pairs(count as usize)
        } else {
            self.bulk_charge(count).1
        }
    }
}

/// Equal results, counters and pushed records of a reference and a restructured run. The
/// `exact_columns` scratch is compared as well (L2 leaves it empty, as the reference does).
#[cfg(test)]
fn b0r_loop_states_equal(
    which: EventLoop,
    reference: &RoundedFillWorkspace,
    expected: Result<(), RoundedFillError>,
    candidate: &RoundedFillWorkspace,
    result: Result<(), RoundedFillError>,
) -> bool {
    let compare_events =
        which == EventLoop::Collect || expected != Err(RoundedFillError::WorkLimit);
    expected == result
        && reference.stats == candidate.stats
        && b0r_event_bits(&reference.exact_columns) == b0r_event_bits(&candidate.exact_columns)
        && (!compare_events
            || b0r_event_bits(&reference.events) == b0r_event_bits(&candidate.events))
}

/// O10's reduced limits for one loop call: budgets at the start, one unit later, the middle,
/// around the reference's final `work_units` and three pseudo-random points in between; for a
/// successful `collect_events` with crossings, event limits failing at the first, a middle and
/// the last crossing push.
#[cfg(test)]
fn b0r_loop_variants(
    which: EventLoop,
    before: &RoundedFillWorkspace,
    reference: &RoundedFillWorkspace,
    expected: Result<(), RoundedFillError>,
) -> Vec<RoundedFillLimits> {
    let start = before.stats.work_units;
    let end = reference.stats.work_units.max(start);
    let span = end - start;
    let mut budgets = vec![
        start,
        start + 1,
        start + span / 2,
        end.saturating_sub(1).max(start),
        end,
        end + 1,
    ];
    let mut seed = span
        ^ ((before.edges.len() as u64) << 32)
        ^ ((before.events.len() as u64) << 16)
        ^ 0x9e37_79b9_7f4a_7c15;
    for _ in 0..3 {
        seed = seed
            .wrapping_mul(0x5851_f42d_4c95_7f2d)
            .wrapping_add(0x1405_7b7e_f767_814f);
        budgets.push(start + (seed >> 11) % (span + 2));
    }
    budgets.sort_unstable();
    budgets.dedup();
    let mut variants: Vec<RoundedFillLimits> = budgets
        .into_iter()
        .map(|max_work| RoundedFillLimits {
            max_work,
            ..before.limits
        })
        .collect();
    if which == EventLoop::Collect && expected.is_ok() {
        let endpoints = before.events.len() + 2 * before.edges.len();
        let crossings = reference.events.len().saturating_sub(endpoints);
        if crossings > 0 {
            let mut limits = vec![
                endpoints,
                endpoints + crossings / 2,
                endpoints + crossings - 1,
            ];
            limits.dedup();
            variants.extend(limits.into_iter().map(|max_events| RoundedFillLimits {
                max_events,
                ..before.limits
            }));
        }
    }
    variants
}

// ---------------------------------------------------------------------------------------------
// B0R U7 test machinery (`cfg(test)` only): the reference copies of the pre-U7 scans and of
// `lookup_section_node`, oracle O10's shadow comparison of L3 and L4 with sampled or exhaustive
// variants (O11), per-thread counts and test access.

/// One call of a scan restructured by unit U7, with the active set the sweep computed.
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ScanLoop {
    /// The section scan of `build_sections_and_nodes` (L3).
    Sections { column: usize, active: u64 },
    /// The active-edge scan of `build_cells` (L3).
    Slab { slab: usize, active: u64 },
    /// The winding scan of `build_column_span` (L3).
    Windings {
        column: usize,
        rank: usize,
        active: u64,
    },
    /// The vertical scan of `build_column_span` (L3).
    Verticals {
        column: usize,
        rank: usize,
        active: u64,
    },
    /// `lookup_section_node` (L4).
    Lookup {
        column: usize,
        edge: usize,
        endpoint: u8,
    },
}

#[cfg(test)]
impl ScanLoop {
    /// The index of this scan's kind in the order of the enum.
    pub(crate) fn kind(self) -> usize {
        match self {
            Self::Sections { .. } => 0,
            Self::Slab { .. } => 1,
            Self::Windings { .. } => 2,
            Self::Verticals { .. } => 3,
            Self::Lookup { .. } => 4,
        }
    }
}

/// Per-thread counts of the restructured scans' work (test builds only).
#[cfg(test)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ScanCounts {
    /// `EdgeColumnSweep`s built (phases that passed the size guard).
    pub(crate) sweeps: u64,
    /// Sparse charged scans (L3 calls).
    pub(crate) scans: u64,
    /// Logical iterations n of those scans.
    pub(crate) iterations: u64,
    /// Active members of those scans (bodies run).
    pub(crate) members: u64,
    /// `lookup_section_node` calls (L4).
    pub(crate) lookups: u64,
    /// Units charged by those calls.
    pub(crate) lookup_charges: u64,
}

#[cfg(test)]
impl ScanCounts {
    pub(crate) fn merge(&mut self, other: Self) {
        self.sweeps += other.sweeps;
        self.scans += other.scans;
        self.iterations += other.iterations;
        self.members += other.members;
        self.lookups += other.lookups;
        self.lookup_charges += other.lookup_charges;
    }
}

/// Per-thread tally of O10's L3/L4 comparisons with the reference copies (test builds only).
#[cfg(test)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ScanShadowTally {
    /// Shadowed calls by `ScanLoop::kind`.
    pub(crate) calls: [u64; 5],
    /// Compared runs, at the real limits and in the variants.
    pub(crate) runs: u64,
    /// Runs whose result, counters, buffer lengths or pushed records differed.
    pub(crate) mismatches: u64,
    /// Compared runs whose reference returned `WorkLimit`.
    pub(crate) work_limit: u64,
    /// Compared runs whose reference returned `SectionLimit` or `ContributorLimit`.
    pub(crate) push_limit: u64,
    /// Compared runs whose reference returned another error.
    pub(crate) other_errors: u64,
    /// Shadowed calls whose variants were sampled.
    pub(crate) sampled_calls: u64,
    /// Shadowed calls whose variants covered every failing budget and push limit.
    pub(crate) exhaustive_calls: u64,
}

#[cfg(test)]
impl ScanShadowTally {
    pub(crate) fn merge(&mut self, other: Self) {
        for (total, count) in self.calls.iter_mut().zip(other.calls) {
            *total += count;
        }
        self.runs += other.runs;
        self.mismatches += other.mismatches;
        self.work_limit += other.work_limit;
        self.push_limit += other.push_limit;
        self.other_errors += other.other_errors;
        self.sampled_calls += other.sampled_calls;
        self.exhaustive_calls += other.exhaustive_calls;
    }
}

#[cfg(test)]
const NO_SCAN_COUNTS: ScanCounts = ScanCounts {
    sweeps: 0,
    scans: 0,
    iterations: 0,
    members: 0,
    lookups: 0,
    lookup_charges: 0,
};

#[cfg(test)]
const NO_SCAN_TALLY: ScanShadowTally = ScanShadowTally {
    calls: [0; 5],
    runs: 0,
    mismatches: 0,
    work_limit: 0,
    push_limit: 0,
    other_errors: 0,
    sampled_calls: 0,
    exhaustive_calls: 0,
};

/// O10 scan variants: none, sampled, or every failing budget and push limit (O11).
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ScanVariants {
    Off,
    Sampled,
    Exhaustive,
}

#[cfg(test)]
thread_local! {
    static SCAN_COUNTS: core::cell::Cell<ScanCounts> = const { core::cell::Cell::new(NO_SCAN_COUNTS) };
    static SCAN_TALLY: core::cell::Cell<ScanShadowTally> =
        const { core::cell::Cell::new(NO_SCAN_TALLY) };
    static SCAN_VARIANTS: core::cell::Cell<ScanVariants> =
        const { core::cell::Cell::new(ScanVariants::Off) };
    static SCAN_SHADOW_BUSY: core::cell::Cell<bool> = const { core::cell::Cell::new(false) };
}

#[cfg(test)]
fn b0r_count_scans(update: impl FnOnce(&mut ScanCounts)) {
    SCAN_COUNTS.with(|counts| {
        let mut value = counts.get();
        update(&mut value);
        counts.set(value);
    });
}

/// Returns and resets this thread's scan counts.
#[cfg(test)]
pub(crate) fn take_scan_counts() -> ScanCounts {
    SCAN_COUNTS.with(|counts| counts.replace(NO_SCAN_COUNTS))
}

/// Returns and resets this thread's O10 scan tally.
#[cfg(test)]
pub(crate) fn take_scan_tally() -> ScanShadowTally {
    SCAN_TALLY.with(|tally| tally.replace(NO_SCAN_TALLY))
}

/// Runs `action` with O10's scan variants on in this thread: in shadow mode each L3 and L4 call
/// is then also compared with the reference under reduced budgets and push limits, sampled or,
/// when `exhaustive`, at every budget from the call's start to one past its charge total and at
/// every push limit (O11).
#[cfg(test)]
pub(crate) fn with_scan_variants<T>(exhaustive: bool, action: impl FnOnce() -> T) -> T {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            SCAN_VARIANTS.with(|mode| mode.set(ScanVariants::Off));
        }
    }
    let mode = if exhaustive {
        ScanVariants::Exhaustive
    } else {
        ScanVariants::Sampled
    };
    SCAN_VARIANTS.with(|active| active.set(mode));
    let _reset = Reset;
    action()
}

#[cfg(test)]
fn b0r_record_scan(expected: Result<(i64, i64), RoundedFillError>, equal: bool) {
    crate::fill_filter::shadow_check(equal);
    SCAN_TALLY.with(|tally| {
        let mut value = tally.get();
        value.runs += 1;
        value.mismatches += u64::from(!equal);
        match expected {
            Ok(_) => {}
            Err(RoundedFillError::WorkLimit) => value.work_limit += 1,
            Err(RoundedFillError::SectionLimit | RoundedFillError::ContributorLimit) => {
                value.push_limit += 1;
            }
            Err(_) => value.other_errors += 1,
        }
        tally.set(value);
    });
}

/// The state a scan may change: the counters, the limits the variants lower, and the lengths of
/// the three buffers the scans push into.
#[cfg(test)]
struct ScanSnapshot {
    stats: RoundedFillStats,
    limits: RoundedFillLimits,
    sections: usize,
    active: usize,
    contributors: usize,
}

#[cfg(test)]
impl ScanSnapshot {
    fn take(workspace: &RoundedFillWorkspace) -> Self {
        Self {
            stats: workspace.stats,
            limits: workspace.limits,
            sections: workspace.sections.len(),
            active: workspace.active.len(),
            contributors: workspace.contributors.len(),
        }
    }

    /// Restores the state before the scan: the scans only push into `sections`, `active` and
    /// `contributors` and change counters, and the captures check that no other buffer changed
    /// length.
    fn restore(&self, workspace: &mut RoundedFillWorkspace) {
        workspace.sections.truncate(self.sections);
        workspace.active.truncate(self.active);
        workspace.contributors.truncate(self.contributors);
        workspace.stats = self.stats;
        workspace.limits = self.limits;
    }
}

/// What one scan run observably did: its result (with the windings or node it returns), every
/// counter, the length of every buffer and the records it pushed.
#[cfg(test)]
#[derive(Debug, PartialEq)]
struct ScanCapture {
    result: Result<(i64, i64), RoundedFillError>,
    stats: RoundedFillStats,
    lengths: [usize; 16],
    sections: Vec<RoundedSection>,
    active: Vec<(usize, ExactSection)>,
    contributors: Vec<usize>,
}

#[cfg(test)]
impl ScanCapture {
    fn take(
        workspace: &RoundedFillWorkspace,
        snapshot: &ScanSnapshot,
        result: Result<(i64, i64), RoundedFillError>,
    ) -> Self {
        Self {
            result,
            stats: workspace.stats,
            lengths: [
                workspace.edges.len(),
                workspace.events.len(),
                workspace.exact_columns.len(),
                workspace.column_sections.len(),
                workspace.node_meta.len(),
                workspace.active.len(),
                workspace.source_edges.len(),
                workspace.columns.len(),
                workspace.nodes.len(),
                workspace.sections.len(),
                workspace.cells.len(),
                workspace.boundaries.len(),
                workspace.spans.len(),
                workspace.contributors.len(),
                workspace.vertices.len(),
                workspace.indices.len(),
            ],
            sections: workspace.sections[snapshot.sections.min(workspace.sections.len())..]
                .to_vec(),
            active: workspace.active[snapshot.active.min(workspace.active.len())..]
                .iter()
                .map(|active| (active.edge, active.section))
                .collect(),
            contributors: workspace.contributors
                [snapshot.contributors.min(workspace.contributors.len())..]
                .to_vec(),
        }
    }
}

/// O10's reduced limits for one scan call. Budgets: sampled as for L1 and L2 (the start, one
/// unit later, the middle, around the reference's final `work_units` and three pseudo-random
/// points), or every budget from the start to one past the charge total, so that the scan fails
/// at each of its iterations and at each charge inside an active body. Push limits for the
/// scans that push into a capped buffer (`sections`, `contributors`): failing at the first, a
/// middle and the last push, or at every push.
#[cfg(test)]
fn b0r_scan_variants(
    scan: ScanLoop,
    snapshot: &ScanSnapshot,
    reference: &ScanCapture,
    exhaustive: bool,
) -> Vec<RoundedFillLimits> {
    let start = snapshot.stats.work_units;
    let end = reference.stats.work_units.max(start);
    let span = end - start;
    let mut budgets: Vec<u64> = if exhaustive {
        (start..=end + 1).collect()
    } else {
        let mut budgets = vec![
            start,
            start + 1,
            start + span / 2,
            end.saturating_sub(1).max(start),
            end,
            end + 1,
        ];
        let mut seed = span ^ ((scan.kind() as u64) << 40) ^ 0x9e37_79b9_7f4a_7c15;
        for _ in 0..3 {
            seed = seed
                .wrapping_mul(0x5851_f42d_4c95_7f2d)
                .wrapping_add(0x1405_7b7e_f767_814f);
            budgets.push(start + (seed >> 11) % (span + 2));
        }
        budgets
    };
    budgets.sort_unstable();
    budgets.dedup();
    let mut variants: Vec<RoundedFillLimits> = budgets
        .into_iter()
        .map(|max_work| RoundedFillLimits {
            max_work,
            ..snapshot.limits
        })
        .collect();
    let (pushed, base) = match scan {
        ScanLoop::Sections { .. } => (reference.sections.len(), snapshot.sections),
        ScanLoop::Verticals { .. } => (reference.contributors.len(), snapshot.contributors),
        _ => (0, 0),
    };
    if pushed > 0 {
        let mut counts: Vec<usize> = if exhaustive {
            (0..pushed).collect()
        } else {
            vec![0, pushed / 2, pushed - 1]
        };
        counts.dedup();
        variants.extend(counts.into_iter().map(|count| match scan {
            ScanLoop::Sections { .. } => RoundedFillLimits {
                max_sections: base + count,
                ..snapshot.limits
            },
            _ => RoundedFillLimits {
                max_contributors: base + count,
                ..snapshot.limits
            },
        }));
    }
    variants
}

#[cfg(test)]
impl RoundedFillWorkspace {
    /// O10 for L3 and L4: unless shadow mode is off or a shadowed scan is already running on
    /// this thread, runs the reference copy and then the restructured scan from the same state
    /// and records whether the results, every counter, every buffer length and the pushed
    /// records are equal. With scan variants on, both also run from that state under reduced
    /// budgets and push limits. The restructured run at the real limits runs last, so its state
    /// continues the tessellation. Scans nested in a shadowed scan (the lookups of
    /// `build_column_span`) run unshadowed; the enclosing comparison covers them.
    fn b0r_shadow_scan(&mut self, scan: ScanLoop) -> Option<Result<(i64, i64), RoundedFillError>> {
        if !crate::fill_filter::shadow_active() || SCAN_SHADOW_BUSY.with(core::cell::Cell::get) {
            return None;
        }
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                SCAN_SHADOW_BUSY.with(|busy| busy.set(false));
            }
        }
        SCAN_SHADOW_BUSY.with(|busy| busy.set(true));
        let _reset = Reset;
        SCAN_TALLY.with(|tally| {
            let mut value = tally.get();
            value.calls[scan.kind()] += 1;
            tally.set(value);
        });

        let snapshot = ScanSnapshot::take(self);
        let expected = self.b0r_run_scan(scan, LoopImpl::Reference);
        let reference = ScanCapture::take(self, &snapshot, expected);
        snapshot.restore(self);
        let mode = SCAN_VARIANTS.with(core::cell::Cell::get);
        if mode != ScanVariants::Off {
            let exhaustive = mode == ScanVariants::Exhaustive;
            for limits in b0r_scan_variants(scan, &snapshot, &reference, exhaustive) {
                self.limits = limits;
                let expected = self.b0r_run_scan(scan, LoopImpl::Reference);
                let variant_reference = ScanCapture::take(self, &snapshot, expected);
                snapshot.restore(self);
                self.limits = limits;
                let result = self.b0r_run_scan(scan, LoopImpl::Restructured);
                let variant = ScanCapture::take(self, &snapshot, result);
                snapshot.restore(self);
                b0r_record_scan(expected, variant_reference == variant);
            }
            SCAN_TALLY.with(|tally| {
                let mut value = tally.get();
                if exhaustive {
                    value.exhaustive_calls += 1;
                } else {
                    value.sampled_calls += 1;
                }
                tally.set(value);
            });
        }
        let result = self.b0r_run_scan(scan, LoopImpl::Restructured);
        let actual = ScanCapture::take(self, &snapshot, result);
        b0r_record_scan(expected, reference == actual);
        Some(result)
    }

    /// Runs one scan without the shadow dispatch: the restructured scan (L3's sparse charged
    /// scan over `active`, or L4) or its pre-U7 reference copy. Returns the windings of
    /// `Windings`, the vertical delta of `Verticals` and the node of `Lookup`.
    pub(crate) fn b0r_run_scan(
        &mut self,
        scan: ScanLoop,
        implementation: LoopImpl,
    ) -> Result<(i64, i64), RoundedFillError> {
        let reference = implementation == LoopImpl::Reference;
        match scan {
            ScanLoop::Sections { column, active } => {
                if reference {
                    self.b0r_reference_column_sections(column)?;
                } else {
                    self.swept_column_sections(column, active)?;
                }
                Ok((0, 0))
            }
            ScanLoop::Slab { slab, active } => {
                if reference {
                    self.b0r_reference_slab_active(slab)?;
                } else {
                    self.swept_slab_active(slab, active)?;
                }
                Ok((0, 0))
            }
            ScanLoop::Windings {
                column,
                rank,
                active,
            } => {
                if reference {
                    return self.b0r_reference_span_windings(column, rank);
                }
                let (mut left, mut right) = (0i64, 0i64);
                self.swept_span_windings(column, rank, active, &mut left, &mut right)?;
                Ok((left, right))
            }
            ScanLoop::Verticals {
                column,
                rank,
                active,
            } => {
                if reference {
                    return Ok((self.b0r_reference_span_verticals(column, rank)?, 0));
                }
                let mut delta = 0i64;
                self.swept_span_verticals(column, rank, active, &mut delta)?;
                Ok((delta, 0))
            }
            ScanLoop::Lookup {
                column,
                edge,
                endpoint,
            } => {
                let node = if reference {
                    self.b0r_reference_lookup_section_node(column, edge, endpoint)?
                } else {
                    self.lookup_section_node(column, edge, endpoint)?
                };
                Ok((node as i64, 0))
            }
        }
    }

    /// The pre-U7 section scan of `build_sections_and_nodes`, verbatim (O10 reference).
    fn b0r_reference_column_sections(
        &mut self,
        column_index: usize,
    ) -> Result<(), RoundedFillError> {
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
        Ok(())
    }

    /// The pre-U7 active-edge scan of `build_cells`, verbatim (O10 reference).
    fn b0r_reference_slab_active(&mut self, slab: usize) -> Result<(), RoundedFillError> {
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
        Ok(())
    }

    /// The pre-U7 winding scan of `build_column_span`, verbatim except that it calls the
    /// reference `lookup_section_node` (O10 reference).
    fn b0r_reference_span_windings(
        &mut self,
        column: usize,
        rank: usize,
    ) -> Result<(i64, i64), RoundedFillError> {
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
                let node = self.b0r_reference_lookup_section_node(column, edge_index, 0)?;
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
        Ok((left_winding, right_winding))
    }

    /// The pre-U7 vertical scan of `build_column_span`, verbatim except that it calls the
    /// reference `lookup_section_node` (O10 reference).
    fn b0r_reference_span_verticals(
        &mut self,
        column: usize,
        rank: usize,
    ) -> Result<i64, RoundedFillError> {
        let mut vertical_delta = 0i64;
        for edge_index in 0..self.edges.len() {
            self.charge()?;
            let edge = self.edges[edge_index];
            if edge.a.x != edge.b.x || edge.low_column != column {
                continue;
            }
            let a_node = self.b0r_reference_lookup_section_node(column, edge_index, 1)?;
            let b_node = self.b0r_reference_lookup_section_node(column, edge_index, 2)?;
            let a_rank = self.node_rank(column, a_node)?;
            let b_rank = self.node_rank(column, b_node)?;
            if a_rank.min(b_rank) <= rank && a_rank.max(b_rank) > rank {
                vertical_delta = vertical_delta
                    .checked_add(vertical_winding(edge))
                    .ok_or(RoundedFillError::InternalInvariant)?;
                self.push_contributor(edge_index)?;
            }
        }
        Ok(vertical_delta)
    }

    /// The pre-U7 `lookup_section_node`, verbatim (O10 reference).
    fn b0r_reference_lookup_section_node(
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

    /// Test access: a state for `lookup_section_node` with the given section records and
    /// column ranges.
    pub(crate) fn b0r_load_lookup(&mut self, sections: &[RoundedSection], ranges: &[SourceRange]) {
        self.begin_attempt();
        self.sections.extend_from_slice(sections);
        self.column_sections.extend_from_slice(ranges);
    }
}
