use core::cmp::Ordering;
use core::mem::size_of;

use crate::fill_event_order::{compare_event_positions, compare_event_x, EventError, FillEvent};
use crate::fill_predicates::{orient2d, point_on_segment, segment_relation, SegmentRelation};
use crate::geometry::{Bounds, Point};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LineFillRule {
    Nonzero,
    Evenodd,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LineFillError {
    InvalidLimits,
    AllocationFailed,
    InputLimit,
    InvalidInput,
    EdgeLimit,
    PairLimit,
    EventLimit,
    WorkLimit,
    OutputLimit,
    Unresolved,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct LineFillLimits {
    pub(crate) max_contours: usize,
    pub(crate) max_input_vertices: usize,
    pub(crate) max_edges: usize,
    pub(crate) max_pairs: usize,
    pub(crate) max_events: usize,
    pub(crate) max_work: u64,
    pub(crate) max_vertices: usize,
    pub(crate) max_triangles: usize,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct LineFillStats {
    pub(crate) input_vertices: usize,
    pub(crate) edges: usize,
    pub(crate) pair_checks: usize,
    pub(crate) events: usize,
    pub(crate) columns: usize,
    pub(crate) work_units: u64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct LineFillMesh<'a> {
    pub(crate) vertices: &'a [Point],
    pub(crate) indices: &'a [u32],
    pub(crate) bounds: Bounds,
}

#[derive(Clone, Copy)]
struct Edge {
    a: Point,
    b: Point,
}

#[derive(Clone, Copy)]
struct ActiveEdge {
    edge_index: usize,
    event: FillEvent,
}

pub(crate) struct LineFillWorkspace {
    limits: LineFillLimits,
    edges: Vec<Edge>,
    events: Vec<FillEvent>,
    columns: Vec<f64>,
    active: Vec<ActiveEdge>,
    vertices: Vec<Point>,
    indices: Vec<u32>,
    stats: LineFillStats,
    bounds: Bounds,
    has_bounds: bool,
    published: bool,
    allocated_bytes: usize,
}

impl LineFillWorkspace {
    pub(crate) fn new(limits: LineFillLimits) -> Result<Self, LineFillError> {
        validate_limits(limits)?;

        let index_capacity = limits
            .max_triangles
            .checked_mul(3)
            .ok_or(LineFillError::InvalidLimits)?;
        let mut edges = Vec::new();
        let mut events = Vec::new();
        let mut columns = Vec::new();
        let mut active = Vec::new();
        let mut vertices = Vec::new();
        let mut indices = Vec::new();
        reserve(&mut edges, limits.max_edges)?;
        reserve(&mut events, limits.max_events)?;
        reserve(&mut columns, limits.max_events)?;
        reserve(&mut active, limits.max_edges)?;
        reserve(&mut vertices, limits.max_vertices)?;
        reserve(&mut indices, index_capacity)?;

        let allocated_bytes = allocation_bytes(&[
            (edges.capacity(), size_of::<Edge>()),
            (events.capacity(), size_of::<FillEvent>()),
            (columns.capacity(), size_of::<f64>()),
            (active.capacity(), size_of::<ActiveEdge>()),
            (vertices.capacity(), size_of::<Point>()),
            (indices.capacity(), size_of::<u32>()),
        ])?;
        Ok(Self {
            limits,
            edges,
            events,
            columns,
            active,
            vertices,
            indices,
            stats: LineFillStats::default(),
            bounds: Bounds::default(),
            has_bounds: false,
            published: false,
            allocated_bytes,
        })
    }

    pub(crate) fn tessellate(
        &mut self,
        contours: &[&[Point]],
        rule: LineFillRule,
    ) -> Result<(), LineFillError> {
        self.begin_attempt();
        match self.tessellate_attempt(contours, rule) {
            Ok(()) => {
                self.published = true;
                Ok(())
            }
            Err(error) => {
                self.vertices.clear();
                self.indices.clear();
                self.bounds = Bounds::default();
                self.has_bounds = false;
                self.published = false;
                Err(error)
            }
        }
    }

    pub(crate) fn mesh(&self) -> Option<LineFillMesh<'_>> {
        self.published.then_some(LineFillMesh {
            vertices: &self.vertices,
            indices: &self.indices,
            bounds: self.bounds,
        })
    }

    pub(crate) fn stats(&self) -> LineFillStats {
        self.stats
    }

    pub(crate) fn allocated_bytes(&self) -> usize {
        self.allocated_bytes
    }

    fn begin_attempt(&mut self) {
        self.edges.clear();
        self.events.clear();
        self.columns.clear();
        self.active.clear();
        self.vertices.clear();
        self.indices.clear();
        self.stats = LineFillStats::default();
        self.bounds = Bounds::default();
        self.has_bounds = false;
        self.published = false;
    }

    fn tessellate_attempt(
        &mut self,
        contours: &[&[Point]],
        rule: LineFillRule,
    ) -> Result<(), LineFillError> {
        let input_vertices = self.preflight_input(contours)?;
        self.stats.input_vertices = input_vertices;
        validate_input(contours)?;
        self.copy_edges(contours)?;

        let pairs = pair_count(self.edges.len()).ok_or(LineFillError::PairLimit)?;
        if pairs > self.limits.max_pairs {
            return Err(LineFillError::PairLimit);
        }
        self.collect_events()?;
        self.sort_events()?;
        self.build_columns()?;
        self.emit_slabs(rule)?;
        if !self.has_bounds {
            self.bounds = Bounds::default();
        }
        Ok(())
    }

    fn preflight_input(&self, contours: &[&[Point]]) -> Result<usize, LineFillError> {
        if contours.len() > self.limits.max_contours {
            return Err(LineFillError::InputLimit);
        }
        let mut total = 0usize;
        for contour in contours {
            total = total
                .checked_add(contour.len())
                .ok_or(LineFillError::InputLimit)?;
            if total > self.limits.max_input_vertices {
                return Err(LineFillError::InputLimit);
            }
        }
        Ok(total)
    }

    fn copy_edges(&mut self, contours: &[&[Point]]) -> Result<(), LineFillError> {
        for contour in contours {
            if contour.len() < 2 {
                continue;
            }
            for index in 0..contour.len() {
                let a = normalize_point(contour[index]);
                let b = normalize_point(contour[(index + 1) % contour.len()]);
                if same_point(a, b) {
                    continue;
                }
                if self.edges.len() >= self.limits.max_edges {
                    return Err(LineFillError::EdgeLimit);
                }
                self.edges.push(Edge { a, b });
                self.stats.edges = self.edges.len();
            }
        }
        Ok(())
    }

    fn collect_events(&mut self) -> Result<(), LineFillError> {
        for edge_index in 0..self.edges.len() {
            let edge = self.edges[edge_index];
            self.push_event(FillEvent::Endpoint(edge.a))?;
            self.push_event(FillEvent::Endpoint(edge.b))?;
        }

        for left_index in 0..self.edges.len() {
            for right_index in (left_index + 1)..self.edges.len() {
                self.charge()?;
                self.stats.pair_checks += 1;
                let left = self.edges[left_index];
                let right = self.edges[right_index];
                let relation = segment_relation(left.a, left.b, right.a, right.b)
                    .map_err(|_| LineFillError::Unresolved)?;
                if relation == SegmentRelation::ProperCrossing {
                    self.push_event(FillEvent::Crossing {
                        a: left.a,
                        b: left.b,
                        c: right.a,
                        d: right.b,
                    })?;
                }
            }
        }
        Ok(())
    }

    fn push_event(&mut self, event: FillEvent) -> Result<(), LineFillError> {
        if self.events.len() >= self.limits.max_events {
            return Err(LineFillError::EventLimit);
        }
        self.events.push(event);
        self.stats.events = self.events.len();
        Ok(())
    }

    fn sort_events(&mut self) -> Result<(), LineFillError> {
        for index in 1..self.events.len() {
            let event = self.events[index];
            let mut position = index;
            while position > 0 {
                let previous = self.events[position - 1];
                let ordering = self.compare_x(previous, event)?;
                if ordering != Ordering::Greater {
                    break;
                }
                self.events[position] = previous;
                position -= 1;
            }
            self.events[position] = event;
        }
        Ok(())
    }

    fn build_columns(&mut self) -> Result<(), LineFillError> {
        let mut start = 0usize;
        while start < self.events.len() {
            let mut end = start + 1;
            while end < self.events.len() {
                let left = self.events[start];
                let right = self.events[end];
                if self.compare_x(left, right)? != Ordering::Equal {
                    break;
                }
                end += 1;
            }
            let x = self.column_x(start, end)?;
            if self.columns.last().is_some_and(|previous| *previous >= x) {
                return Err(LineFillError::Unresolved);
            }
            if self.columns.len() >= self.limits.max_events {
                return Err(LineFillError::EventLimit);
            }
            self.columns.push(x);
            self.stats.columns = self.columns.len();
            start = end;
        }
        Ok(())
    }

    fn column_x(&mut self, start: usize, end: usize) -> Result<f64, LineFillError> {
        let mut chosen = None;
        for index in start..end {
            let event = self.events[index];
            let x = self.event_x(event)?;
            if let Some(previous) = chosen {
                if previous != x {
                    return Err(LineFillError::Unresolved);
                }
            } else {
                chosen = Some(x);
            }
        }
        chosen.ok_or(LineFillError::Unresolved)
    }

    fn event_x(&mut self, event: FillEvent) -> Result<f64, LineFillError> {
        match event {
            FillEvent::Endpoint(point) => Ok(normalize_zero(point.x)),
            FillEvent::Crossing { a, b, c, d } => {
                let lower = a.x.min(b.x).max(c.x.min(d.x));
                let upper = a.x.max(b.x).min(c.x.max(d.x));
                self.search_event_x(event, lower, upper)
            }
        }
    }

    fn search_event_x(
        &mut self,
        event: FillEvent,
        lower: f64,
        upper: f64,
    ) -> Result<f64, LineFillError> {
        let mut lo = ordered_key(lower);
        let mut hi = ordered_key(upper);
        for _ in 0..64 {
            if lo > hi {
                break;
            }
            let middle = lo + (hi - lo) / 2;
            let candidate = key_value(middle);
            self.charge()?;
            let ordering = compare_event_x(
                event,
                FillEvent::Endpoint(Point {
                    x: candidate,
                    y: 0.0,
                }),
            )
            .map_err(map_event_error)?;
            match ordering {
                Ordering::Equal => return Ok(normalize_zero(candidate)),
                Ordering::Less => {
                    hi = middle.checked_sub(1).ok_or(LineFillError::Unresolved)?;
                }
                Ordering::Greater => {
                    lo = middle.checked_add(1).ok_or(LineFillError::Unresolved)?;
                }
            }
        }
        Err(LineFillError::Unresolved)
    }

    fn emit_slabs(&mut self, rule: LineFillRule) -> Result<(), LineFillError> {
        for column_index in 0..self.columns.len().saturating_sub(1) {
            let left = self.columns[column_index];
            let right = self.columns[column_index + 1];
            let sample = interior_sample(left, right)?;
            self.collect_active(sample)?;
            self.sort_active()?;
            self.emit_active_intervals(left, right, rule)?;
        }
        Ok(())
    }

    fn collect_active(&mut self, sample: f64) -> Result<(), LineFillError> {
        self.active.clear();
        for edge_index in 0..self.edges.len() {
            self.charge()?;
            let edge = self.edges[edge_index];
            if edge.a.x == edge.b.x
                || sample <= edge.a.x.min(edge.b.x)
                || sample >= edge.a.x.max(edge.b.x)
            {
                continue;
            }
            let event = if edge.a.y == edge.b.y {
                FillEvent::Endpoint(Point {
                    x: sample,
                    y: edge.a.y,
                })
            } else {
                FillEvent::Crossing {
                    a: edge.a,
                    b: edge.b,
                    c: Point {
                        x: sample,
                        y: edge.a.y.min(edge.b.y),
                    },
                    d: Point {
                        x: sample,
                        y: edge.a.y.max(edge.b.y),
                    },
                }
            };
            if self.active.len() >= self.limits.max_edges {
                return Err(LineFillError::EdgeLimit);
            }
            self.active.push(ActiveEdge { edge_index, event });
        }
        Ok(())
    }

    fn sort_active(&mut self) -> Result<(), LineFillError> {
        for index in 1..self.active.len() {
            let active = self.active[index];
            let mut position = index;
            while position > 0 {
                let previous = self.active[position - 1];
                let ordering = self.compare_active(previous.event, active.event)?;
                if ordering != Ordering::Greater {
                    break;
                }
                self.active[position] = previous;
                position -= 1;
            }
            self.active[position] = active;
        }
        Ok(())
    }

    fn emit_active_intervals(
        &mut self,
        left: f64,
        right: f64,
        rule: LineFillRule,
    ) -> Result<(), LineFillError> {
        let mut winding = 0i64;
        let mut lower_edge = None;
        let mut start = 0usize;
        while start < self.active.len() {
            let mut end = start + 1;
            while end < self.active.len() {
                let first = self.active[start].event;
                let candidate = self.active[end].event;
                if self.compare_active(first, candidate)? != Ordering::Equal {
                    break;
                }
                end += 1;
            }

            let representative_index = self.active[start].edge_index;
            let representative = self.edges[representative_index];
            let mut delta = 0i64;
            for index in start..end {
                let edge = self.edges[self.active[index].edge_index];
                if !same_supporting_line(representative, edge)? {
                    return Err(LineFillError::Unresolved);
                }
                let contribution = if edge.b.x > edge.a.x { 1 } else { -1 };
                delta = delta
                    .checked_add(contribution)
                    .ok_or(LineFillError::Unresolved)?;
            }

            let was_filled = is_filled(winding, rule);
            winding = winding
                .checked_add(delta)
                .ok_or(LineFillError::Unresolved)?;
            let now_filled = is_filled(winding, rule);
            if !was_filled && now_filled {
                lower_edge = Some(representative_index);
            } else if was_filled && !now_filled {
                let lower = lower_edge.take().ok_or(LineFillError::Unresolved)?;
                self.emit_interval(lower, representative_index, left, right)?;
            }
            start = end;
        }
        if winding != 0 || lower_edge.is_some() {
            return Err(LineFillError::Unresolved);
        }
        Ok(())
    }

    fn emit_interval(
        &mut self,
        lower_index: usize,
        upper_index: usize,
        left: f64,
        right: f64,
    ) -> Result<(), LineFillError> {
        let lower = self.edges[lower_index];
        let upper = self.edges[upper_index];
        let bottom_left = self.edge_cut(lower, left)?;
        let bottom_right = self.edge_cut(lower, right)?;
        let top_left = self.edge_cut(upper, left)?;
        let top_right = self.edge_cut(upper, right)?;
        self.emit_triangle([bottom_left, bottom_right, top_right])?;
        self.emit_triangle([bottom_left, top_right, top_left])
    }

    fn edge_cut(&mut self, edge: Edge, x: f64) -> Result<Point, LineFillError> {
        self.charge()?;
        let candidate = if x == edge.a.x {
            edge.a
        } else if x == edge.b.x {
            edge.b
        } else if edge.a.y == edge.b.y {
            Point { x, y: edge.a.y }
        } else {
            let y = self.search_cut_y(edge, x, edge.a.y.min(edge.b.y), edge.a.y.max(edge.b.y))?;
            Point { x, y }
        };
        let candidate = normalize_point(candidate);
        if !point_is_finite(candidate) || candidate.x != x {
            return Err(LineFillError::Unresolved);
        }
        if !point_on_segment(candidate, edge.a, edge.b).map_err(|_| LineFillError::Unresolved)? {
            return Err(LineFillError::Unresolved);
        }
        Ok(candidate)
    }

    fn search_cut_y(
        &mut self,
        edge: Edge,
        x: f64,
        lower: f64,
        upper: f64,
    ) -> Result<f64, LineFillError> {
        let mut lo = ordered_key(lower);
        let mut hi = ordered_key(upper);
        for _ in 0..64 {
            if lo > hi {
                break;
            }
            let middle = lo + (hi - lo) / 2;
            let candidate = key_value(middle);
            self.charge()?;
            let mut ordering = orient2d(edge.a, edge.b, Point { x, y: candidate })
                .map_err(|_| LineFillError::Unresolved)?;
            if edge.b.x < edge.a.x {
                ordering = ordering.reverse();
            }
            match ordering {
                Ordering::Equal => return Ok(normalize_zero(candidate)),
                Ordering::Greater => {
                    hi = middle.checked_sub(1).ok_or(LineFillError::Unresolved)?;
                }
                Ordering::Less => {
                    lo = middle.checked_add(1).ok_or(LineFillError::Unresolved)?;
                }
            }
        }
        Err(LineFillError::Unresolved)
    }

    fn emit_triangle(&mut self, triangle: [Point; 3]) -> Result<(), LineFillError> {
        self.charge()?;
        match orient2d(triangle[0], triangle[1], triangle[2])
            .map_err(|_| LineFillError::Unresolved)?
        {
            Ordering::Less => return Err(LineFillError::Unresolved),
            Ordering::Equal => return Ok(()),
            Ordering::Greater => {}
        }

        let triangle_count = self.indices.len() / 3;
        if triangle_count >= self.limits.max_triangles
            || self
                .vertices
                .len()
                .checked_add(3)
                .is_none_or(|length| length > self.limits.max_vertices)
            || self
                .indices
                .len()
                .checked_add(3)
                .is_none_or(|length| length > self.limits.max_triangles * 3)
        {
            return Err(LineFillError::OutputLimit);
        }
        for point in triangle {
            let index =
                u32::try_from(self.vertices.len()).map_err(|_| LineFillError::OutputLimit)?;
            self.vertices.push(point);
            self.indices.push(index);
            self.include_output(point);
        }
        Ok(())
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

    fn compare_x(&mut self, left: FillEvent, right: FillEvent) -> Result<Ordering, LineFillError> {
        self.charge()?;
        compare_event_x(left, right).map_err(map_event_error)
    }

    fn compare_active(
        &mut self,
        left: FillEvent,
        right: FillEvent,
    ) -> Result<Ordering, LineFillError> {
        self.charge()?;
        compare_event_positions(left, right).map_err(map_event_error)
    }

    fn charge(&mut self) -> Result<(), LineFillError> {
        if self.stats.work_units >= self.limits.max_work {
            return Err(LineFillError::WorkLimit);
        }
        self.stats.work_units += 1;
        Ok(())
    }
}

fn validate_limits(limits: LineFillLimits) -> Result<(), LineFillError> {
    if limits.max_vertices > u32::MAX as usize {
        return Err(LineFillError::InvalidLimits);
    }
    pair_count(limits.max_edges).ok_or(LineFillError::InvalidLimits)?;
    let endpoint_events = limits
        .max_edges
        .checked_mul(2)
        .ok_or(LineFillError::InvalidLimits)?;
    endpoint_events
        .checked_add(limits.max_pairs)
        .ok_or(LineFillError::InvalidLimits)?;
    let index_capacity = limits
        .max_triangles
        .checked_mul(3)
        .ok_or(LineFillError::InvalidLimits)?;
    allocation_bytes(&[
        (limits.max_edges, size_of::<Edge>()),
        (limits.max_events, size_of::<FillEvent>()),
        (limits.max_events, size_of::<f64>()),
        (limits.max_edges, size_of::<ActiveEdge>()),
        (limits.max_vertices, size_of::<Point>()),
        (index_capacity, size_of::<u32>()),
    ])?;
    Ok(())
}

fn allocation_bytes(parts: &[(usize, usize)]) -> Result<usize, LineFillError> {
    let mut total = 0usize;
    for &(capacity, item_size) in parts {
        let bytes = capacity
            .checked_mul(item_size)
            .ok_or(LineFillError::InvalidLimits)?;
        if bytes > isize::MAX as usize {
            return Err(LineFillError::InvalidLimits);
        }
        total = total
            .checked_add(bytes)
            .ok_or(LineFillError::InvalidLimits)?;
    }
    Ok(total)
}

fn reserve<T>(buffer: &mut Vec<T>, capacity: usize) -> Result<(), LineFillError> {
    buffer
        .try_reserve_exact(capacity)
        .map_err(|_| LineFillError::AllocationFailed)
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

fn validate_input(contours: &[&[Point]]) -> Result<(), LineFillError> {
    if contours
        .iter()
        .flat_map(|contour| contour.iter())
        .all(|point| point_is_finite(*point))
    {
        Ok(())
    } else {
        Err(LineFillError::InvalidInput)
    }
}

fn point_is_finite(point: Point) -> bool {
    point.x.is_finite() && point.y.is_finite()
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

fn map_event_error(_error: EventError) -> LineFillError {
    LineFillError::Unresolved
}

fn ordered_key(value: f64) -> u64 {
    let bits = value.to_bits();
    if bits >> 63 != 0 {
        !bits
    } else {
        bits ^ (1u64 << 63)
    }
}

fn key_value(key: u64) -> f64 {
    let bits = if key >> 63 != 0 {
        key ^ (1u64 << 63)
    } else {
        !key
    };
    normalize_zero(f64::from_bits(bits))
}

fn interior_sample(left: f64, right: f64) -> Result<f64, LineFillError> {
    let sample = if left <= 0.0 && right >= 0.0 {
        (left + right) * 0.5
    } else {
        left * 0.5 + right * 0.5
    };
    if sample.is_finite() && left < sample && sample < right {
        Ok(normalize_zero(sample))
    } else {
        Err(LineFillError::Unresolved)
    }
}

fn same_supporting_line(left: Edge, right: Edge) -> Result<bool, LineFillError> {
    Ok(
        orient2d(left.a, left.b, right.a).map_err(|_| LineFillError::Unresolved)?
            == Ordering::Equal
            && orient2d(left.a, left.b, right.b).map_err(|_| LineFillError::Unresolved)?
                == Ordering::Equal,
    )
}

fn is_filled(winding: i64, rule: LineFillRule) -> bool {
    match rule {
        LineFillRule::Nonzero => winding != 0,
        LineFillRule::Evenodd => winding % 2 != 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> LineFillLimits {
        LineFillLimits {
            max_contours: 4,
            max_input_vertices: 16,
            max_edges: 16,
            max_pairs: 120,
            max_events: 152,
            max_work: 10_000,
            max_vertices: 48,
            max_triangles: 16,
        }
    }

    fn point(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    fn crossing(a: Point, b: Point, c: Point, d: Point) -> FillEvent {
        FillEvent::Crossing { a, b, c, d }
    }

    fn assert_event_search(
        workspace: &mut LineFillWorkspace,
        event: FillEvent,
        lower: f64,
        upper: f64,
        expected: Result<f64, LineFillError>,
    ) {
        let before = workspace.stats.work_units;
        assert_eq!(workspace.search_event_x(event, lower, upper), expected);
        let consumed = workspace.stats.work_units - before;
        assert!((1..=64).contains(&consumed));
    }

    fn assert_cut_search(
        workspace: &mut LineFillWorkspace,
        edge: Edge,
        x: f64,
        expected: Result<f64, LineFillError>,
    ) {
        let before = workspace.stats.work_units;
        assert_eq!(
            workspace.search_cut_y(edge, x, edge.a.y.min(edge.b.y), edge.a.y.max(edge.b.y)),
            expected
        );
        let consumed = workspace.stats.work_units - before;
        assert!((1..=64).contains(&consumed));
    }

    #[test]
    fn ordered_keys_round_trip_finite_boundaries_and_canonicalize_zero() {
        let values = [
            -f64::MAX,
            -f64::MIN_POSITIVE,
            -f64::from_bits(1),
            -0.0,
            0.0,
            f64::from_bits(1),
            f64::MIN_POSITIVE,
            f64::MAX,
        ];
        for pair in values.windows(2) {
            assert!(ordered_key(pair[0]) < ordered_key(pair[1]));
        }
        for value in values {
            let round_trip = key_value(ordered_key(value));
            if value == 0.0 {
                assert_eq!(round_trip.to_bits(), 0);
            } else {
                assert_eq!(round_trip.to_bits(), value.to_bits());
            }
        }
    }

    #[test]
    fn strict_samples_cover_negative_and_zero_crossing_ranges() {
        assert_eq!(interior_sample(-4.0, -2.0), Ok(-3.0));
        assert_eq!(interior_sample(-2.0, 4.0), Ok(1.0));
        assert_eq!(
            interior_sample(1.0, 1.0f64.next_up()),
            Err(LineFillError::Unresolved)
        );
    }

    #[test]
    fn event_x_search_covers_exact_domains_and_rejects_a_third() {
        let mut workspace = LineFillWorkspace::new(limits()).unwrap();
        assert_event_search(
            &mut workspace,
            crossing(
                point(-1.0, -1.0),
                point(1.0, 1.0),
                point(-1.0, 1.0),
                point(1.0, -1.0),
            ),
            -1.0,
            1.0,
            Ok(0.0),
        );
        assert_event_search(
            &mut workspace,
            crossing(
                point(-3.0, -1.0),
                point(-1.0, 1.0),
                point(-3.0, 1.0),
                point(-1.0, -1.0),
            ),
            -3.0,
            -1.0,
            Ok(-2.0),
        );

        let minimum = f64::from_bits(1);
        let twice_minimum = f64::from_bits(2);
        assert_event_search(
            &mut workspace,
            crossing(
                point(0.0, -minimum),
                point(twice_minimum, minimum),
                point(0.0, minimum),
                point(twice_minimum, -minimum),
            ),
            0.0,
            twice_minimum,
            Ok(minimum),
        );

        let large = f64::from_bits(0x7e70_0000_0000_0000);
        let twice_large = f64::from_bits(0x7e80_0000_0000_0000);
        assert_event_search(
            &mut workspace,
            crossing(
                point(0.0, -1.0),
                point(twice_large, 1.0),
                point(0.0, 1.0),
                point(twice_large, -1.0),
            ),
            0.0,
            twice_large,
            Ok(large),
        );
        assert_event_search(
            &mut workspace,
            crossing(
                point(-f64::MAX, -1.0),
                point(f64::MAX, 1.0),
                point(-f64::MAX, 1.0),
                point(f64::MAX, -1.0),
            ),
            -f64::MAX,
            f64::MAX,
            Ok(0.0),
        );
        assert_event_search(
            &mut workspace,
            crossing(
                point(0.0, 0.0),
                point(1.0, 1.0),
                point(0.0, 1.0),
                point(1.0, -1.0),
            ),
            0.0,
            1.0,
            Err(LineFillError::Unresolved),
        );
    }

    #[test]
    fn cut_y_search_covers_direction_extremes_and_nonrepresentable_root() {
        let mut workspace = LineFillWorkspace::new(limits()).unwrap();
        let rising = Edge {
            a: point(0.0, 0.0),
            b: point(2.0, 2.0),
        };
        assert_cut_search(&mut workspace, rising, 1.0, Ok(1.0));
        assert_cut_search(
            &mut workspace,
            Edge {
                a: rising.b,
                b: rising.a,
            },
            1.0,
            Ok(1.0),
        );
        assert_cut_search(
            &mut workspace,
            Edge {
                a: point(0.0, -3.0),
                b: point(2.0, -1.0),
            },
            1.0,
            Ok(-2.0),
        );

        let minimum = f64::from_bits(1);
        assert_cut_search(
            &mut workspace,
            Edge {
                a: point(0.0, 0.0),
                b: point(2.0, f64::from_bits(2)),
            },
            1.0,
            Ok(minimum),
        );
        assert_cut_search(
            &mut workspace,
            Edge {
                a: point(0.0, -f64::MAX),
                b: point(2.0, f64::MAX),
            },
            1.0,
            Ok(0.0),
        );
        assert_cut_search(
            &mut workspace,
            Edge {
                a: point(0.0, 0.0),
                b: point(3.0, 1.0),
            },
            1.0,
            Err(LineFillError::Unresolved),
        );
    }

    #[test]
    fn allocated_bytes_uses_actual_capacities() {
        let workspace = LineFillWorkspace::new(limits()).unwrap();
        let expected = workspace.edges.capacity() * size_of::<Edge>()
            + workspace.events.capacity() * size_of::<FillEvent>()
            + workspace.columns.capacity() * size_of::<f64>()
            + workspace.active.capacity() * size_of::<ActiveEdge>()
            + workspace.vertices.capacity() * size_of::<Point>()
            + workspace.indices.capacity() * size_of::<u32>();
        assert!(expected > 0);
        assert_eq!(workspace.allocated_bytes(), expected);

        let zero = LineFillWorkspace::new(LineFillLimits {
            max_contours: 0,
            max_input_vertices: 0,
            max_edges: 0,
            max_pairs: 0,
            max_events: 0,
            max_work: 0,
            max_vertices: 0,
            max_triangles: 0,
        })
        .unwrap();
        assert_eq!(zero.allocated_bytes(), 0);
    }
}
