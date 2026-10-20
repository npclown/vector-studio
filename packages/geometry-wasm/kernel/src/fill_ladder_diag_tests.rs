//! P3 Alt-A1 unit AL-U4a (`docs/plans/p3-alt-a1-fill-ladder-contract.md` sections 5.1 and
//! 6.1): the sub-stage diagnostic split of the certificate FR1-FR5. Test-only and functional.
//! Its timings locate cost for the AL-U4b optimizations; they are diagnostics, not performance
//! evidence, and no claim rests on them.
//!
//! Two measurements, both on the B0 framed corpus at e = −3 under the nonzero rule:
//!
//! - **Production stops.** `FillLadder::fast_rung_until` with the stops S1 (AL-FR0, the S1
//!   prefix and the copy into the rung), FR1 to FR5, FR8 and AL-FR9, each timed on its own
//!   (warm-up, then timed batches of the cell's ten paths); a stage's cost is the difference of
//!   adjacent medians, as in the spike's SL-D1 to SL-D4. One untimed run per stop records the
//!   `fill_filter` decided/fallback counts of F0.2, F1 and F0.3, whose stop-to-stop difference
//!   is the stage's share.
//! - **The mirror.** `fill_ladder.rs` keeps its stage internals private, and this unit's file
//!   scope (contract section 6.1: `fill_ladder_tests.rs` or a `cfg(test)` diagnostic module)
//!   excludes it, so nested stops inside FR1 to FR5 cannot be placed there. (`cfg(test)` stops
//!   would not change the release WASM; the scope is the constraint.) This module therefore
//!   holds a statement-for-
//!   statement copy of FR1 to FR5 on the same S1 view, with the same `Interval`, `orient2d` and
//!   `segment_relation` calls in the same order, but without the `cfg(test)` `fault()` reads
//!   (which outside test builds are constant `false`). Its fidelity is checked on every B0
//!   path before any timing: the mirror's FR1-FR5 result equals the production rung's
//!   `fast_rung_until(.., Stage::Fr5)` result, and its observations (the bits of the largest
//!   |d_m|² bound, the sweep candidates and the clearance step 2 and step 3 counts) equal the
//!   production `FastStats`. The sub-stages are then timed as isolated kernels over state
//!   prepared once per path (untimed), on the paths whose FR1-FR5 pass.
//!
//! **AL-U4b1.** The mirror follows the first optimization: FR2's `restrict` is the shared
//! `Subdivision` (AL-C2 with AL-C1), `midpoint` takes the hoisted one-point interval of 0.5,
//! and the |d_m|² terms reuse the previous leaf's 2 p_end when p_start has the same bits
//! (AL-C1). The fidelity check is unchanged. The AL-U4a per-leaf `restrict` stays as the extra
//! kernel `FR2.restrict.AL-U4a`, checked against the stored controls, for a same-run
//! comparison, and the counts report both split totals.
//!
//! **AL-U4b2.** The mirror follows the second optimization: FR4 computes each edge's chord and
//! control steps once per edge (`MonotoneEdge`, AL-C1), as `fill_ladder.rs`'s
//! `monotone_contour` does; its sub-stage kernels compute only their own per-edge operands. The
//! fidelity check is unchanged. The AL-U4b1 FR4 stays as the extra kernel `FR4.AL-U4b1`,
//! checked to pass on every timed path, for a same-run comparison. The dot counts are unchanged.
//!
//! The ignored test runs only by hand (release profile, `--nocapture`, one test thread) and
//! prints its tables; it changes no output and writes no file.
use core::cmp::Ordering;
use core::hint::black_box;
use std::env;
use std::time::Instant;

use crate::codec::{PathInput, Request};
use crate::cubic_fill::{
    ContourRange, CubicFillWorkspace, DecodedSource, EdgeOwner, S1View, MAX_FLAT_COMMANDS,
};
use crate::fill_export::{tolerances, FillRequest, FILL_V0_LIMITS};
use crate::fill_filter::{self, compare_enclosures, FilterId, Interval, UNDECIDED};
use crate::fill_ladder::{
    BoundaryScan, FillLadder, Reason, Stage, MAX_BOUNDARY_RECORDS, MAX_CONTOURS, MAX_EDGES,
    MAX_POINTS, MAX_SOURCES,
};
use crate::fill_predicates::{orient2d, segment_relation, SegmentRelation};
use crate::geometry::Point;
use crate::line_fill::LineFillRule;
use crate::p3_b0_bench::{clock_quantum, read_corpus, Cell};

/// The spike's diagnostic exponent and rule (spike section 5.8; B0 corpus at e = −3).
const EXPONENT: i32 = -3;
const RULE: LineFillRule = LineFillRule::Nonzero;
/// Paths per decision cell, as in the spike's diagnostic run.
const CELL_PATHS: usize = 10;
/// The deepest leaf FR1 accepts (`fill_ladder.rs` `MAX_LEAF_DEPTH`, from P2's `MAX_DEPTH`).
const MAX_LEAF_DEPTH: u32 = 20;

fn env_or(name: &str, default: usize) -> usize {
    env::var(name)
        .ok()
        .map(|value| value.parse().expect("a non-negative integer"))
        .unwrap_or(default)
}

// ------------------------------------------------------------------------------------------
// AL-FR9 item 2 for the production stops: a copy of V2's once-only scan on reserved buffers
// (the `TestScan` of `fill_ladder_tests.rs`, which is private to that file).

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct DirectedEdge {
    low: u32,
    high: u32,
    position: u32,
    forward: bool,
}

const UNUSED_PAIR: [u32; 2] = [u32::MAX, u32::MAX];

struct DiagScan {
    edges: Vec<DirectedEdge>,
    boundary: Vec<[u32; 2]>,
}

impl DiagScan {
    fn new() -> Self {
        Self {
            edges: Vec::with_capacity(MAX_BOUNDARY_RECORDS),
            boundary: Vec::with_capacity(MAX_BOUNDARY_RECORDS),
        }
    }
}

impl BoundaryScan for DiagScan {
    fn scan(&mut self, triangles: &[u32]) -> Option<&[[u32; 2]]> {
        self.edges.clear();
        self.boundary.clear();
        let slots = triangles.len();
        if slots > self.edges.capacity() || slots > self.boundary.capacity() {
            return None;
        }
        for position in 0..slots {
            let triangle = position - position % 3;
            let a = triangles[position];
            let b = triangles[triangle + (position % 3 + 1) % 3];
            if a == b {
                return None;
            }
            self.edges.push(DirectedEdge {
                low: a.min(b),
                high: a.max(b),
                position: u32::try_from(position).ok()?,
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
                        triangles[position],
                        triangles[triangle + (position % 3 + 1) % 3],
                    ];
                }
                2 if self.edges[cursor + 1].forward != first.forward => {}
                _ => return None,
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
        Some(&self.boundary)
    }
}

// ------------------------------------------------------------------------------------------
// The mirror's interval helpers: copies of `fill_ladder.rs`'s, same operations, same order.

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

fn proved_positive(value: Interval) -> bool {
    value.sign() == Some(Ordering::Greater)
}

fn proved_negative(value: Interval) -> bool {
    value.sign() == Some(Ordering::Less)
}

fn proved_below(value: Interval, bound: Interval) -> bool {
    compare_enclosures(value, bound) == Some(Ordering::Less)
}

/// `fill_ladder.rs`'s `proved_exceeds` without the seeded-defect branch.
fn proved_exceeds(value: Interval, bound: Interval) -> bool {
    compare_enclosures(value, bound) == Some(Ordering::Greater)
}

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

/// AL-U4b1: the bits [x.lo, x.hi, y.lo, y.hi] of an interval point.
fn ipoint_bits(point: IPoint) -> [u64; 4] {
    [
        point.x.lo.to_bits(),
        point.x.hi.to_bits(),
        point.y.lo.to_bits(),
        point.y.hi.to_bits(),
    ]
}

/// AL-U4b1: `fill_ladder.rs`'s `same_bits`.
fn same_bits(left: Point, right: Point) -> bool {
    left.x.to_bits() == right.x.to_bits() && left.y.to_bits() == right.y.to_bits()
}

fn orient(a: Point, b: Point, c: Point, reason: Reason) -> Result<Ordering, Reason> {
    orient2d(a, b, c).map_err(|_| reason)
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
enum Piece {
    #[default]
    Unset,
    Leaf {
        source: usize,
        controls: [Point; 4],
        numerator: u32,
        depth: u32,
    },
    Segment {
        a: Point,
        b: Point,
    },
}

impl Piece {
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

#[derive(Clone, Copy, Debug, Default)]
struct CertEdge {
    start: Point,
    end: Point,
    piece: Piece,
    controls: [IPoint; 4],
    deviation_squared: f64,
    contour: usize,
    local: usize,
}

#[derive(Clone, Copy, Debug, Default)]
struct ContourInfo {
    point_start: usize,
    edges: usize,
    cert_start: usize,
    cert_count: usize,
    contracted: bool,
}

const LEVELS: usize = MAX_LEAF_DEPTH as usize;

/// AL-U4b1: `fill_ladder.rs`'s `Subdivision`, the prefix-shared interval de Casteljau of FR2,
/// statement for statement; `splits` counts its `split_both` calls in every build.
struct Subdivision {
    source: Option<[Point; 4]>,
    root: [IPoint; 4],
    levels: usize,
    keys: [u32; LEVELS],
    children: [[[IPoint; 4]; 2]; LEVELS],
    split: [bool; LEVELS + 1],
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
        self.splits += 1;
        split_both(self.node(level))
    }

    fn restrict(&mut self, controls: [Point; 4], numerator: u32, depth: u32) -> [IPoint; 4] {
        let cell = numerator - 1;
        let depth = depth as usize;
        if depth > LEVELS {
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
        let mut level = 0;
        while level < depth
            && level < self.levels
            && self.keys[level] == cell >> (depth - level - 1)
        {
            level += 1;
        }
        if level < depth {
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

fn split_both(points: [IPoint; 4]) -> [[IPoint; 4]; 2] {
    let half = Interval::point(0.5);
    let p01 = midpoint_half(points[0], points[1], half);
    let p12 = midpoint_half(points[1], points[2], half);
    let p23 = midpoint_half(points[2], points[3], half);
    let p012 = midpoint_half(p01, p12, half);
    let p123 = midpoint_half(p12, p23, half);
    let middle = midpoint_half(p012, p123, half);
    [
        [points[0], p01, p012, middle],
        [middle, p123, p23, points[3]],
    ]
}

/// AL-U4b1: `fill_ladder.rs`'s `midpoint`, with the hoisted one-point interval of 0.5.
fn midpoint_half(left: IPoint, right: IPoint, half: Interval) -> IPoint {
    left.add(right).mul(half)
}

/// The AL-U4a mirror's per-leaf `restrict` (the spike's, before AL-U4b1), kept for the
/// same-run comparison kernel `FR2.restrict.AL-U4a`.
fn restrict_unshared(controls: [Point; 4], numerator: u32, depth: u32) -> [IPoint; 4] {
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

/// AL-U4b2: `fill_ladder.rs`'s `MonotoneEdge`, one edge's FR4 operands computed once. The
/// mirror's sub-stage kernels compute only the chord (`CHORDS`) or only the steps (`STEPS`).
#[derive(Clone, Copy)]
struct MonotoneEdge {
    chord: IPoint,
    steps: [IPoint; 3],
    terms: Option<usize>,
}

impl MonotoneEdge {
    fn new<const CHORDS: bool, const STEPS: bool>(edge: &CertEdge) -> Self {
        let terms = match edge.piece {
            Piece::Leaf { .. } => Some(3),
            Piece::Segment { .. } => Some(1),
            Piece::Unset => None,
        };
        let mut steps = [IPoint::default(); 3];
        if STEPS {
            for (term, step) in steps.iter_mut().enumerate().take(terms.unwrap_or(0)) {
                *step = edge.controls[term + 1].sub(edge.controls[term]);
            }
        }
        Self {
            chord: if CHORDS {
                exact_difference(edge.end, edge.start)
            } else {
                IPoint::default()
            },
            steps,
            terms,
        }
    }
}

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

/// Which of the point tests (i)-(iii) decided a `point_clear` call (0 when none did).
fn point_clear<const COUNT: bool>(
    point: Point,
    start: Point,
    end: Point,
    r_squared: Interval,
    decided: &mut [u64; 4],
) -> bool {
    let v = exact_difference(end, start);
    let w = exact_difference(point, start);
    let across = cross(v, w);
    if proved_exceeds(across.mul(across), r_squared.mul(norm_squared(v))) {
        if COUNT {
            decided[1] += 1;
        }
        return true;
    }
    if proved_negative(dot(w, v)) && proved_exceeds(norm_squared(w), r_squared) {
        if COUNT {
            decided[2] += 1;
        }
        return true;
    }
    let beyond = exact_difference(point, end);
    let clear = proved_positive(dot(beyond, v)) && proved_exceeds(norm_squared(beyond), r_squared);
    if COUNT {
        decided[if clear { 3 } else { 0 }] += 1;
    }
    clear
}

// ------------------------------------------------------------------------------------------
// The mirror of FR1-FR5 on one path.

/// Logical counts of one mirror pass (diagnostics; no decision reads them).
#[derive(Clone, Copy, Debug, Default)]
struct Counts {
    edges: u64,
    leaves: u64,
    segments: u64,
    /// FR1: source lookups (`resolve` and `source_end`) and the sources each one scanned.
    lookups: u64,
    lookup_steps: u64,
    /// FR2: `split_both` calls of the shared interval de Casteljau (AL-U4b1), the `split_half`
    /// calls the per-leaf `restrict` of AL-U4a made (the sum of the leaf depths), and the
    /// |d_m|² terms checked.
    splits: u64,
    unshared_splits: u64,
    fr2_terms: u64,
    /// FR3: contracted contours (the only ones FR3 examines).
    contracted: u64,
    /// FR4: consecutive pairs and interval dot-sign tests.
    fr4_pairs: u64,
    fr4_dots: u64,
    /// FR5: scan visits (inner-loop iterations), consecutive skips, candidates, box-gap
    /// decisions, step 2 and step 3 pairs, and the point tests (none, (i), (ii), (iii)).
    visits: u64,
    consecutive: u64,
    candidates: u64,
    box_decided: u64,
    step2: u64,
    step3: u64,
    point_tests: [u64; 4],
}

impl Counts {
    fn add(&mut self, other: &Self) {
        self.edges += other.edges;
        self.leaves += other.leaves;
        self.segments += other.segments;
        self.lookups += other.lookups;
        self.lookup_steps += other.lookup_steps;
        self.splits += other.splits;
        self.unshared_splits += other.unshared_splits;
        self.fr2_terms += other.fr2_terms;
        self.contracted += other.contracted;
        self.fr4_pairs += other.fr4_pairs;
        self.fr4_dots += other.fr4_dots;
        self.visits += other.visits;
        self.consecutive += other.consecutive;
        self.candidates += other.candidates;
        self.box_decided += other.box_decided;
        self.step2 += other.step2;
        self.step3 += other.step3;
        for (total, value) in self.point_tests.iter_mut().zip(other.point_tests) {
            *total += value;
        }
    }
}

struct Mirror {
    delta: f64,
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
    max_deviation_squared: f64,
    counts: Counts,
    /// FR5 state prepared once (untimed) for the isolated sweep, box-gap, relation and point
    /// kernels: the sort keys and order, and the pairs reaching each step.
    xlo: [f64; MAX_EDGES],
    xhi: [f64; MAX_EDGES],
    order: [usize; MAX_EDGES],
    candidates: Vec<(usize, usize)>,
    step2: Vec<(usize, usize)>,
    step3: Vec<(usize, usize)>,
}

impl Mirror {
    fn new() -> Self {
        Self {
            delta: 0.0,
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
            max_deviation_squared: 0.0,
            counts: Counts::default(),
            xlo: [0.0; MAX_EDGES],
            xhi: [0.0; MAX_EDGES],
            order: [0; MAX_EDGES],
            candidates: Vec::new(),
            step2: Vec::new(),
            step3: Vec::new(),
        }
    }

    /// `FastRung::load`.
    fn load(&mut self, view: S1View<'_>, delta: f64) -> Result<(), Reason> {
        self.cert_len = 0;
        self.max_deviation_squared = 0.0;
        self.counts = Counts::default();
        if view.points.is_empty()
            || view.ranges.is_empty()
            || view.points.len() > MAX_POINTS
            || view.ranges.len() > MAX_CONTOURS
            || view.owners.len() > MAX_EDGES
            || view.sources.len() > MAX_SOURCES
        {
            return Err(Reason::Prefix);
        }
        self.delta = delta;
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

    // FR1 -----------------------------------------------------------------------------------

    fn source_end<const COUNT: bool>(&mut self, contour: usize) -> Option<Point> {
        let mut steps = 0u64;
        let found = self.sources[..self.source_len]
            .iter()
            .rev()
            .find(|source| {
                if COUNT {
                    steps += 1;
                }
                source.contour() == contour
            })
            .map(|source| match *source {
                DecodedSource::Line { points, .. } => points[1],
                DecodedSource::Cubic { points, .. } => points[3],
            });
        if COUNT {
            self.counts.lookups += 1;
            self.counts.lookup_steps += steps;
        }
        found
    }

    fn resolve<const COUNT: bool>(
        &mut self,
        owner: EdgeOwner,
        contour: usize,
        is_last: bool,
        z: Point,
        m: Point,
    ) -> Result<Piece, Reason> {
        let mut steps = 0u64;
        let result = match owner {
            EdgeOwner::Line { source_verb } => self.sources[..self.source_len]
                .iter()
                .find_map(|source| {
                    if COUNT {
                        steps += 1;
                    }
                    match *source {
                        DecodedSource::Line {
                            points,
                            source_verb: verb,
                            contour: owner_contour,
                        } if verb == source_verb && owner_contour == contour => {
                            Some(Piece::Segment {
                                a: points[0],
                                b: points[1],
                            })
                        }
                        _ => None,
                    }
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
                    .find_map(|(index, source)| {
                        if COUNT {
                            steps += 1;
                        }
                        match *source {
                            DecodedSource::Cubic {
                                points,
                                source_verb: verb,
                                contour: owner_contour,
                            } if verb == source_verb && owner_contour == contour => {
                                Some(Piece::Leaf {
                                    source: index,
                                    controls: points,
                                    numerator: end_numerator,
                                    depth,
                                })
                            }
                            _ => None,
                        }
                    })
                    .ok_or(Reason::Structure)
            }
            EdgeOwner::ImplicitClosure {
                contour: owner_contour,
            } if owner_contour == contour && is_last => Ok(Piece::Segment { a: z, b: m }),
            EdgeOwner::ExplicitClose { .. } if is_last => Ok(Piece::Segment { a: z, b: m }),
            EdgeOwner::ImplicitClosure { .. } | EdgeOwner::ExplicitClose { .. } => {
                Err(Reason::Structure)
            }
        };
        if COUNT {
            self.counts.lookups += 1;
            self.counts.lookup_steps += steps;
        }
        result
    }

    /// FR1 sub-stage: the source lookups alone (`source_end` and `resolve` per edge), on a path
    /// whose FR1 passes.
    fn fr1_resolve(&mut self) -> Result<(), Reason> {
        let mut owner_start = 0usize;
        for contour in 0..self.range_len {
            let range = self.ranges[contour];
            let edges = if range.count >= 2 { range.count } else { 0 };
            let m = self.points[range.start];
            let z = self.source_end::<false>(contour).ok_or(Reason::Structure)?;
            for index in 0..edges {
                self.pieces[owner_start + index] = self.resolve::<false>(
                    self.owners[owner_start + index],
                    contour,
                    index + 1 == edges,
                    z,
                    m,
                )?;
            }
            owner_start += edges;
        }
        Ok(())
    }

    /// `FastRung::structure`.
    fn structure<const COUNT: bool>(&mut self) -> Result<(), Reason> {
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
            let z = self.source_end::<COUNT>(contour).ok_or(Reason::Structure)?;
            for index in 0..edges {
                self.pieces[owner_start + index] = self.resolve::<COUNT>(
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
            if edges > 0 && !closes && !same_point(z, m) {
                return Err(Reason::Structure);
            }
            let contracted = closes && same_point(z, m);
            for index in 0..edges {
                let following = (index + 1) % edges;
                if !consistent(
                    self.pieces[owner_start + index],
                    self.pieces[owner_start + following],
                ) {
                    return Err(Reason::Structure);
                }
            }
            let cert_count = if contracted { edges - 1 } else { edges };
            if cert_count < 3 {
                return Err(Reason::Structure);
            }
            let cert_start = self.cert_len;
            for index in 0..cert_count {
                let (start, end, piece) = if contracted && index + 1 == cert_count {
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
        if COUNT {
            self.counts.edges += self.cert_len as u64;
            for edge in &self.cert[..self.cert_len] {
                match edge.piece {
                    Piece::Leaf { .. } => self.counts.leaves += 1,
                    Piece::Segment { .. } => self.counts.segments += 1,
                    Piece::Unset => {}
                }
            }
        }
        Ok(())
    }

    // FR2 -----------------------------------------------------------------------------------

    /// `FastRung::deviation`, with the knot errors always on.
    fn deviation<const COUNT: bool>(&mut self) -> Result<(), Reason> {
        let delta = Interval::point(self.delta);
        let delta_squared = delta.mul(delta);
        let two = Interval::point(2.0);
        let three = Interval::point(3.0);
        let mut subdivision = Subdivision::new();
        let mut doubled_end: Option<(Point, IPoint)> = None;
        let mut unshared_splits = 0u64;
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
                    controls = subdivision.restrict(source, numerator, depth);
                    if COUNT {
                        unshared_splits += u64::from(depth);
                    }
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
                    &[0, 1, 2, 3]
                }
                Piece::Segment { a, b } => {
                    controls[0] = IPoint::exact(a);
                    controls[1] = IPoint::exact(b);
                    deviations[0] = controls[0].sub(start);
                    deviations[1] = controls[1].sub(end);
                    &[0, 1]
                }
                Piece::Unset => return Err(Reason::Structure),
            };
            self.cert[index].controls = controls;
            for &term in checked {
                let squared = norm_squared(deviations[term]);
                if COUNT {
                    self.counts.fr2_terms += 1;
                }
                if !proved_below(squared, delta_squared) {
                    return Err(Reason::Deviation);
                }
                self.max_deviation_squared = self.max_deviation_squared.max(squared.hi);
                self.cert[index].deviation_squared =
                    self.cert[index].deviation_squared.max(squared.hi);
            }
        }
        if COUNT {
            self.counts.splits += subdivision.splits;
            self.counts.unshared_splits += unshared_splits;
        }
        Ok(())
    }

    /// FR2 sub-stage: the interval de Casteljau restriction of every leaf alone (the shared
    /// `Subdivision` from AL-U4b1), with the per-edge copy that `deviation` makes. Returns the
    /// split count.
    fn fr2_restrict(&mut self) -> u64 {
        let mut subdivision = Subdivision::new();
        for index in 0..self.cert_len {
            let edge = self.cert[index];
            if let Piece::Leaf {
                controls,
                numerator,
                depth,
                ..
            } = edge.piece
            {
                // Every leaf's result is kept observable, as `deviation` stores it.
                black_box(subdivision.restrict(controls, numerator, depth));
            }
        }
        subdivision.splits
    }

    /// The AL-U4a `FR2.restrict` kernel, the per-leaf `restrict` before AL-U4b1, for a
    /// same-run comparison; it checks that its result equals the stored controls.
    fn fr2_restrict_unshared(&mut self) -> bool {
        let mut same = true;
        for index in 0..self.cert_len {
            let edge = self.cert[index];
            if let Piece::Leaf {
                controls,
                numerator,
                depth,
                ..
            } = edge.piece
            {
                let restricted = black_box(restrict_unshared(controls, numerator, depth));
                // Bit comparison, so that a ±0 or NaN-payload difference is caught.
                same &= restricted
                    .iter()
                    .zip(edge.controls.iter())
                    .all(|(left, right)| ipoint_bits(*left) == ipoint_bits(*right));
            }
        }
        same
    }

    /// FR2 sub-stage: the |d_m|² terms and their comparisons with δ² alone, on the restricted
    /// controls that the prepared pass stored.
    fn fr2_terms(&mut self) -> Result<f64, Reason> {
        let delta = Interval::point(self.delta);
        let delta_squared = delta.mul(delta);
        let two = Interval::point(2.0);
        let three = Interval::point(3.0);
        let mut largest = 0.0f64;
        let mut doubled_end: Option<(Point, IPoint)> = None;
        for index in 0..self.cert_len {
            let edge = self.cert[index];
            let start = IPoint::exact(edge.start);
            let end = IPoint::exact(edge.end);
            let controls = edge.controls;
            let mut deviations = [IPoint::default(); 4];
            let checked: &[usize] = match edge.piece {
                Piece::Leaf { .. } => {
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
                    &[0, 1, 2, 3]
                }
                Piece::Segment { .. } => {
                    deviations[0] = controls[0].sub(start);
                    deviations[1] = controls[1].sub(end);
                    &[0, 1]
                }
                Piece::Unset => return Err(Reason::Structure),
            };
            for &term in checked {
                let squared = norm_squared(deviations[term]);
                if !proved_below(squared, delta_squared) {
                    return Err(Reason::Deviation);
                }
                largest = largest.max(squared.hi);
            }
        }
        Ok(largest)
    }

    // FR3 -----------------------------------------------------------------------------------

    /// `FastRung::closure`, AL-M5 on.
    fn closure<const COUNT: bool>(&mut self) -> Result<(), Reason> {
        let delta = Interval::point(self.delta);
        let delta_squared = delta.mul(delta);
        for info in self.contours[..self.range_len].iter().copied() {
            if !info.contracted {
                continue;
            }
            if COUNT {
                self.counts.contracted += 1;
            }
            let base = info.point_start;
            let edges = info.edges;
            let m = self.points[base];
            let q = self.points[base + 1];
            let r = self.points[base + edges - 3];
            let p = self.points[base + edges - 2];
            let k = self.points[base + edges - 1];
            if info.cert_count < 3 {
                return Err(Reason::Closure);
            }
            let closing_squared = norm_squared(exact_difference(k, m));
            if !proved_below(closing_squared, delta_squared) {
                return Err(Reason::Closure);
            }
            let sigma = orient(p, k, m, Reason::Closure)?;
            if sigma == Ordering::Equal
                && !proved_positive(dot(exact_difference(k, p), exact_difference(m, k)))
            {
                return Err(Reason::Closure);
            }
            if sigma == Ordering::Equal {
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
                let inside = |value: Ordering| value == sigma || value == Ordering::Equal;
                let q_in_cone = inside(orient(k, m, q, Reason::Closure)?)
                    && inside(orient(m, p, q, Reason::Closure)?);
                let r_in_cone = inside(orient(m, p, r, Reason::Closure)?)
                    && inside(orient(p, k, r, Reason::Closure)?);
                let (m_side, p_side) = (!q_in_cone, !r_in_cone);
                if !(m_side && p_side) {
                    return Err(Reason::Closure);
                }
            }
            let merged = self.cert[info.cert_start + info.cert_count - 1];
            let sum = norm_from_squared_bound(merged.deviation_squared)
                .add(norm_from_squared_bound(closing_squared.hi));
            if !proved_below(sum, delta) {
                return Err(Reason::Closure);
            }
        }
        Ok(())
    }

    // FR4 -----------------------------------------------------------------------------------

    /// `FastRung::monotone` with `monotone_contour` (AL-U4b2): each edge's chord and control
    /// steps are computed once per edge (`MonotoneEdge`), edge 0's kept for the cyclic pair.
    /// `CHORDS` and `STEPS` select the sub-stages (both for the stage); each sub-stage computes
    /// only its own per-edge operands.
    fn monotone<const COUNT: bool, const CHORDS: bool, const STEPS: bool>(
        &mut self,
    ) -> Result<(), Reason> {
        for info in self.contours[..self.range_len].iter().copied() {
            let edges = &self.cert[info.cert_start..info.cert_start + info.cert_count];
            let count = edges.len();
            if count == 0 {
                continue;
            }
            let first = MonotoneEdge::new::<CHORDS, STEPS>(&edges[0]);
            let mut e = first;
            for index in 0..count {
                let next = index + 1;
                let (f_edge, f) = if next < count {
                    (
                        &edges[next],
                        MonotoneEdge::new::<CHORDS, STEPS>(&edges[next]),
                    )
                } else {
                    (&edges[0], first)
                };
                let w = exact_difference(f_edge.end, edges[index].start);
                if COUNT {
                    self.counts.fr4_pairs += 1;
                    self.counts.fr4_dots += 2;
                }
                if CHORDS
                    && (!proved_positive(dot(e.chord, w)) || !proved_positive(dot(f.chord, w)))
                {
                    return Err(Reason::Monotone);
                }
                if STEPS {
                    for edge in [&e, &f] {
                        let Some(terms) = edge.terms else {
                            return Err(Reason::Structure);
                        };
                        for step in &edge.steps[..terms] {
                            if COUNT {
                                self.counts.fr4_dots += 1;
                            }
                            if !proved_positive(dot(*step, w)) {
                                return Err(Reason::Monotone);
                            }
                        }
                    }
                }
                e = f;
            }
        }
        Ok(())
    }

    /// The AL-U4b1 `FastRung::monotone` (each edge's chord and steps computed in both of its
    /// pairs), kept as the extra kernel `FR4.AL-U4b1` for a same-run comparison (AL-U4b2).
    fn monotone_unshared(&self) -> Result<(), Reason> {
        for info in self.contours[..self.range_len].iter().copied() {
            let count = info.cert_count;
            for index in 0..count {
                let e = self.cert[info.cert_start + index];
                let f = self.cert[info.cert_start + (index + 1) % count];
                let w = exact_difference(f.end, e.start);
                if !proved_positive(dot(exact_difference(e.end, e.start), w))
                    || !proved_positive(dot(exact_difference(f.end, f.start), w))
                {
                    return Err(Reason::Monotone);
                }
                for edge in [e, f] {
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

    // FR5 -----------------------------------------------------------------------------------

    fn consecutive(&self, left: usize, right: usize) -> bool {
        let (a, b) = (self.cert[left], self.cert[right]);
        if a.contour != b.contour {
            return false;
        }
        let count = self.contours[a.contour].cert_count;
        let offset = (a.local + count - b.local) % count;
        offset == 1 || offset == count - 1
    }

    /// `FastRung::clearance`; with `COUNT` it also stores the sort state and the pairs that
    /// reach each step, for the isolated kernels.
    fn clearance<const COUNT: bool>(&mut self) -> Result<(), Reason> {
        let count = self.cert_len;
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
        let mut order = [0usize; MAX_EDGES];
        let mut scratch = [0usize; MAX_EDGES];
        for (index, slot) in order[..count].iter_mut().enumerate() {
            *slot = index;
        }
        merge_sort(&mut order[..count], &mut scratch[..count], |a, b| {
            xlo[a].total_cmp(&xlo[b]).then(a.cmp(&b))
        });
        if COUNT {
            self.xlo = xlo;
            self.xhi = xhi;
            self.order = order;
            self.candidates.clear();
            self.step2.clear();
            self.step3.clear();
        }
        let mut marks = [0u64; MAX_EDGES];
        let mut candidates = 0u32;
        for position in 0..count {
            let a = order[position];
            let bound = (xhi[a] + radius).next_up();
            let bound = if bound.is_finite() {
                bound
            } else {
                f64::INFINITY
            };
            for &b in &order[position + 1..count] {
                if xlo[b] > bound {
                    break;
                }
                if COUNT {
                    self.counts.visits += 1;
                }
                if self.consecutive(a, b) {
                    if COUNT {
                        self.counts.consecutive += 1;
                    }
                    continue;
                }
                let (low, high) = (a.min(b), a.max(b));
                marks[low] |= 1u64 << high;
                candidates += 1;
                if COUNT {
                    self.candidates.push((a, b));
                }
                self.clear_pair::<COUNT>(a, b, r, r_squared)?;
            }
        }
        debug_assert!(marks.iter().map(|row| row.count_ones()).sum::<u32>() == candidates);
        if COUNT {
            self.counts.candidates += u64::from(candidates);
        }
        Ok(())
    }

    fn clear_pair<const COUNT: bool>(
        &mut self,
        left: usize,
        right: usize,
        r: Interval,
        r_squared: Interval,
    ) -> Result<(), Reason> {
        let (e, f) = (self.cert[left], self.cert[right]);
        let gap = |high: f64, low: f64| Interval::point(low).sub(Interval::point(high));
        let gaps = [
            gap(e.start.x.max(e.end.x), f.start.x.min(f.end.x)),
            gap(f.start.x.max(f.end.x), e.start.x.min(e.end.x)),
            gap(e.start.y.max(e.end.y), f.start.y.min(f.end.y)),
            gap(f.start.y.max(f.end.y), e.start.y.min(e.end.y)),
        ];
        if gaps.iter().any(|value| proved_exceeds(*value, r)) {
            if COUNT {
                self.counts.box_decided += 1;
            }
            return Ok(());
        }
        if COUNT {
            self.counts.step2 += 1;
            self.step2.push((left, right));
        }
        match segment_relation(e.start, e.end, f.start, f.end) {
            Ok(SegmentRelation::Disjoint) => {}
            _ => return Err(Reason::Crossing),
        }
        if COUNT {
            self.counts.step3 += 1;
            self.step3.push((left, right));
        }
        let mut decided = [0u64; 4];
        for (point, segment) in [(e.start, f), (e.end, f), (f.start, e), (f.end, e)] {
            if !point_clear::<COUNT>(point, segment.start, segment.end, r_squared, &mut decided) {
                if COUNT {
                    self.add_point_tests(decided);
                }
                return Err(Reason::Clearance);
            }
        }
        if COUNT {
            self.add_point_tests(decided);
        }
        Ok(())
    }

    fn add_point_tests(&mut self, decided: [u64; 4]) {
        for (total, value) in self.counts.point_tests.iter_mut().zip(decided) {
            *total += value;
        }
    }

    /// FR5 sub-stage: the sort keys and the merge sort.
    fn fr5_sort(&self) -> usize {
        let count = self.cert_len;
        let mut xlo = [0.0f64; MAX_EDGES];
        let mut xhi = [0.0f64; MAX_EDGES];
        for index in 0..count {
            let edge = self.cert[index];
            xlo[index] = edge.start.x.min(edge.end.x);
            xhi[index] = edge.start.x.max(edge.end.x);
        }
        let mut order = [0usize; MAX_EDGES];
        let mut scratch = [0usize; MAX_EDGES];
        for (index, slot) in order[..count].iter_mut().enumerate() {
            *slot = index;
        }
        merge_sort(&mut order[..count], &mut scratch[..count], |a, b| {
            xlo[a].total_cmp(&xlo[b]).then(a.cmp(&b))
        });
        black_box(xhi);
        order[0]
    }

    /// FR5 sub-stage: the sweep scan with its consecutive-pair skip and marks, on the stored
    /// order, without the pair tests.
    fn fr5_scan(&self) -> u32 {
        let count = self.cert_len;
        let radius = 2.0 * self.delta;
        let mut marks = [0u64; MAX_EDGES];
        let mut candidates = 0u32;
        for position in 0..count {
            let a = self.order[position];
            let bound = (self.xhi[a] + radius).next_up();
            let bound = if bound.is_finite() {
                bound
            } else {
                f64::INFINITY
            };
            for &b in &self.order[position + 1..count] {
                if self.xlo[b] > bound {
                    break;
                }
                if self.consecutive(a, b) {
                    continue;
                }
                let (low, high) = (a.min(b), a.max(b));
                marks[low] |= 1u64 << high;
                candidates += 1;
            }
        }
        debug_assert!(marks.iter().map(|row| row.count_ones()).sum::<u32>() == candidates);
        candidates
    }

    /// FR5 sub-stage: step 1, the box-gap test, on every stored candidate.
    fn fr5_box_gap(&self) -> u32 {
        let r = Interval::point(2.0 * self.delta);
        let mut decided = 0u32;
        for &(left, right) in &self.candidates {
            let (e, f) = (self.cert[left], self.cert[right]);
            let gap = |high: f64, low: f64| Interval::point(low).sub(Interval::point(high));
            let gaps = [
                gap(e.start.x.max(e.end.x), f.start.x.min(f.end.x)),
                gap(f.start.x.max(f.end.x), e.start.x.min(e.end.x)),
                gap(e.start.y.max(e.end.y), f.start.y.min(f.end.y)),
                gap(f.start.y.max(f.end.y), e.start.y.min(e.end.y)),
            ];
            if gaps.iter().any(|value| proved_exceeds(*value, r)) {
                decided += 1;
            }
        }
        decided
    }

    /// FR5 sub-stage: step 2, `segment_relation`, on the stored step-2 pairs.
    fn fr5_relation(&self) -> u32 {
        let mut disjoint = 0u32;
        for &(left, right) in &self.step2 {
            let (e, f) = (self.cert[left], self.cert[right]);
            if segment_relation(e.start, e.end, f.start, f.end) == Ok(SegmentRelation::Disjoint) {
                disjoint += 1;
            }
        }
        disjoint
    }

    /// FR5 sub-stage: step 3, the four point tests, on the stored step-3 pairs.
    fn fr5_points(&self) -> u32 {
        let r = Interval::point(2.0 * self.delta);
        let r_squared = r.mul(r);
        let mut decided = [0u64; 4];
        let mut clear = 0u32;
        for &(left, right) in &self.step3 {
            let (e, f) = (self.cert[left], self.cert[right]);
            for (point, segment) in [(e.start, f), (e.end, f), (f.start, e), (f.end, e)] {
                if point_clear::<false>(point, segment.start, segment.end, r_squared, &mut decided)
                {
                    clear += 1;
                }
            }
        }
        clear
    }

    /// FR1-FR5 in order, counted; the first unproved check returns its reason.
    fn certificate_counted(&mut self) -> Result<(), Reason> {
        self.structure::<true>()?;
        self.deviation::<true>()?;
        self.closure::<true>()?;
        self.monotone::<true, true, true>()?;
        self.clearance::<true>()
    }
}

// ------------------------------------------------------------------------------------------
// The run.

fn request() -> FillRequest {
    FillRequest {
        request_id: 0,
        rule: RULE,
        exponent: EXPONENT,
    }
}

/// The path input of `fill_ladder::path_input` (flattening tolerance 2^e).
fn path_input<'a>(verbs: &'a [u8], point_bytes: &'a [u8]) -> PathInput<'a> {
    PathInput::from_parts(
        Request {
            request_id: 0,
            source_epoch: 0,
            source_revision: 0,
            tolerance: tolerances(EXPONENT).0,
        },
        verbs,
        point_bytes,
    )
}

/// Loads the mirror from the S1 prefix exactly as `fast_rung_until` does (after AL-FR0, which
/// e = −3 passes).
fn load_mirror(
    workspace: &mut CubicFillWorkspace,
    mirror: &mut Mirror,
    verbs: &[u8],
    point_bytes: &[u8],
) -> Result<(), Reason> {
    let input = path_input(verbs, point_bytes);
    match workspace.prepare_prefix(input, MAX_FLAT_COMMANDS) {
        Ok(view) => mirror.load(view, input.request.tolerance),
        Err(_) => Err(Reason::Prefix),
    }
}

/// Median of a batch-time sample, in ns per pass over the cell's paths.
fn median(mut samples: Vec<f64>) -> f64 {
    samples.sort_by(f64::total_cmp);
    let middle = samples.len() / 2;
    if !samples.len().is_multiple_of(2) {
        samples[middle]
    } else {
        (samples[middle - 1] + samples[middle]) / 2.0
    }
}

struct Timing {
    warmup: usize,
    timed: usize,
    inner: usize,
}

impl Timing {
    /// Median over `timed` rounds (after `warmup`) of one pass of `pass`, each round running
    /// it `inner` times; ns per pass.
    fn measure(&self, mut pass: impl FnMut()) -> f64 {
        let mut samples = Vec::with_capacity(self.timed);
        for round in 0..self.warmup + self.timed {
            let start = Instant::now();
            for _ in 0..self.inner {
                pass();
            }
            let ns = start.elapsed().as_nanos() as f64 / self.inner as f64;
            if round >= self.warmup {
                samples.push(ns);
            }
        }
        median(samples)
    }
}

const PRODUCTION_STOPS: [(&str, Stage); 8] = [
    ("S1", Stage::S1),
    ("FR1", Stage::Fr1),
    ("FR2", Stage::Fr2),
    ("FR3", Stage::Fr3),
    ("FR4", Stage::Fr4),
    ("FR5", Stage::Fr5),
    ("FR8", Stage::Fr8),
    ("FR9", Stage::Fr9),
];

const FILTERS: [(&str, FilterId); 3] = [
    ("F0.2", FilterId::PredicateOrientIdentity),
    ("F1", FilterId::PredicateOrient),
    ("F0.3", FilterId::SegmentBoxes),
];

/// The mirror's sub-stage kernels, in stage order.
const KERNELS: [&str; 17] = [
    "FR1",
    "FR1.resolve",
    "FR2",
    "FR2.restrict",
    "FR2.terms",
    "FR3",
    "FR4",
    "FR4.chords",
    "FR4.steps",
    "FR5",
    "FR5.sort",
    "FR5.scan",
    "FR5.boxgap",
    "FR5.relation",
    "FR5.points",
    "FR2.restrict.AL-U4a",
    "FR4.AL-U4b1",
];

fn time_kernel(timing: &Timing, mirrors: &mut [Box<Mirror>], kernel: impl Fn(&mut Mirror)) -> f64 {
    timing.measure(|| {
        for state in mirrors.iter_mut() {
            kernel(state);
        }
    })
}

/// Times kernel `slot` of `KERNELS`; each closure is its own monomorphized pass.
///
/// The slots run in order on shared prepared state: slot 0 (FR1) rebuilds the certified edges,
/// which zeroes their `controls` and `deviation_squared`, and slot 2 (FR2) restores both before
/// slot 4 (FR2 terms), slot 5 (FR3, AL-M5) and slots 6-8 and 16 (FR4) read them. The order of
/// `KERNELS` must keep that dependency.
fn measure_kernel(slot: usize, timing: &Timing, mirrors: &mut [Box<Mirror>]) -> f64 {
    match slot {
        0 => time_kernel(timing, mirrors, |m| {
            black_box(m.structure::<false>()).expect("FR1 passes");
        }),
        1 => time_kernel(timing, mirrors, |m| {
            black_box(m.fr1_resolve()).expect("FR1 lookups pass");
        }),
        2 => time_kernel(timing, mirrors, |m| {
            black_box(m.deviation::<false>()).expect("FR2 passes");
        }),
        3 => time_kernel(timing, mirrors, |m| {
            black_box(m.fr2_restrict());
        }),
        4 => time_kernel(timing, mirrors, |m| {
            black_box(m.fr2_terms()).expect("FR2 terms pass");
        }),
        5 => time_kernel(timing, mirrors, |m| {
            black_box(m.closure::<false>()).expect("FR3 passes");
        }),
        6 => time_kernel(timing, mirrors, |m| {
            black_box(m.monotone::<false, true, true>()).expect("FR4 passes");
        }),
        7 => time_kernel(timing, mirrors, |m| {
            black_box(m.monotone::<false, true, false>()).expect("FR4 chords pass");
        }),
        8 => time_kernel(timing, mirrors, |m| {
            black_box(m.monotone::<false, false, true>()).expect("FR4 steps pass");
        }),
        9 => time_kernel(timing, mirrors, |m| {
            black_box(m.clearance::<false>()).expect("FR5 passes");
        }),
        10 => time_kernel(timing, mirrors, |m| {
            black_box(m.fr5_sort());
        }),
        11 => time_kernel(timing, mirrors, |m| {
            black_box(m.fr5_scan());
        }),
        12 => time_kernel(timing, mirrors, |m| {
            black_box(m.fr5_box_gap());
        }),
        13 => time_kernel(timing, mirrors, |m| {
            black_box(m.fr5_relation());
        }),
        14 => time_kernel(timing, mirrors, |m| {
            black_box(m.fr5_points());
        }),
        15 => time_kernel(timing, mirrors, |m| {
            black_box(m.fr2_restrict_unshared());
        }),
        16 => time_kernel(timing, mirrors, |m| {
            black_box(m.monotone_unshared()).expect("AL-U4b1 FR4 passes");
        }),
        _ => unreachable!("unknown kernel {slot}"),
    }
}

/// One cell's results.
struct CellResult {
    id: String,
    timed_paths: usize,
    /// Production stop medians, ns per pass over the cell's paths.
    stops: [f64; PRODUCTION_STOPS.len()],
    /// F0.2, F1, F0.3 (decided, fallback) totals of one untimed pass, per production stop.
    filters: [[(u64, u64); FILTERS.len()]; PRODUCTION_STOPS.len()],
    kernels: [f64; KERNELS.len()],
    counts: Counts,
}

fn micros(ns: f64) -> String {
    format!("{:.2}", ns / 1000.0)
}

fn print_tables(results: &[CellResult], timing: &Timing, quantum: u64) {
    println!(
        "AL-U4a diagnostic split (functional; NOT performance evidence). Clock quantum {quantum} ns; \
         warm-up {}, timed {}, inner repetitions {}. Times are medians in microseconds per pass \
         over the cell's {CELL_PATHS} paths.",
        timing.warmup, timing.timed, timing.inner
    );
    println!();
    println!("Production stops (stage cost = difference of adjacent medians):");
    println!(
        "| Cell | S1 | FR1 | FR2 | FR3 | FR4 | FR5 | FR6-FR8 | AL-FR9 | Fast rung | FR1-FR5 | FR1-FR5 share |"
    );
    println!(
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
    );
    let mut stage_totals = [0.0f64; PRODUCTION_STOPS.len()];
    for result in results {
        let s = &result.stops;
        let mut row = format!("| {} | {}", result.id, micros(s[0]));
        let mut costs = [0.0f64; PRODUCTION_STOPS.len()];
        costs[0] = s[0];
        for index in 1..s.len() {
            costs[index] = s[index] - s[index - 1];
        }
        for (total, cost) in stage_totals.iter_mut().zip(costs) {
            *total += cost;
        }
        for cost in &costs[1..] {
            row.push_str(&format!(" | {}", micros(*cost)));
        }
        let certificate = s[5] - s[0];
        row.push_str(&format!(
            " | {} | {} | {:.0}% |",
            micros(s[7]),
            micros(certificate),
            100.0 * certificate / s[7]
        ));
        println!("{row}");
    }
    let fast: f64 = stage_totals.iter().sum();
    let certificate: f64 = stage_totals[1..6].iter().sum();
    let mut row = "| Sum".to_owned();
    for total in &stage_totals {
        row.push_str(&format!(" | {}", micros(*total)));
    }
    row.push_str(&format!(
        " | {} | {} | {:.0}% |",
        micros(fast),
        micros(certificate),
        100.0 * certificate / fast
    ));
    println!("{row}");
    println!();
    println!("Mirror sub-stage kernels (isolated, on the paths whose FR1-FR5 pass):");
    let mut header = "| Cell | Paths".to_owned();
    for name in KERNELS {
        header.push_str(&format!(" | {name}"));
    }
    println!("{header} |");
    println!("|{}", " --- |".repeat(KERNELS.len() + 2));
    let mut kernel_totals = [0.0f64; KERNELS.len()];
    for result in results {
        let mut row = format!("| {} | {}", result.id, result.timed_paths);
        for (index, value) in result.kernels.iter().enumerate() {
            kernel_totals[index] += value;
            row.push_str(&format!(" | {}", micros(*value)));
        }
        println!("{row} |");
    }
    let mut row = "| Sum | ".to_owned();
    for value in kernel_totals {
        row.push_str(&format!(" | {}", micros(value)));
    }
    println!("{row} |");
    let mirror_certificate = kernel_totals[0]
        + kernel_totals[2]
        + kernel_totals[5]
        + kernel_totals[6]
        + kernel_totals[9];
    println!();
    println!(
        "Mirror shares of its own FR1-FR5 sum ({} us):",
        micros(mirror_certificate)
    );
    for (index, name) in KERNELS.iter().enumerate() {
        println!(
            "  {name:<13} {:>10} us  {:>5.1}%",
            micros(kernel_totals[index]),
            100.0 * kernel_totals[index] / mirror_certificate
        );
    }
    println!();
    println!("Logical counts (sums over each cell's paths):");
    println!(
        "| Cell | Edges | Leaves | Segments | Lookups | Lookup steps | Splits | Splits (AL-U4a) | \
         FR2 terms | \
         Contracted | FR4 pairs | FR4 dots | Scan visits | Consecutive | Candidates | Box decided | \
         Step 2 | Step 3 | Point tests none/(i)/(ii)/(iii) |"
    );
    println!("|{}", " --- |".repeat(19));
    let mut total = Counts::default();
    for result in results {
        total.add(&result.counts);
        print_counts(&result.id, &result.counts);
    }
    print_counts("Sum", &total);
    println!();
    println!(
        "fill_filter counts per production stage (decided/fallback; stop-to-stop differences):"
    );
    let mut header = "| Cell".to_owned();
    for (stop, _) in PRODUCTION_STOPS {
        for (filter, _) in FILTERS {
            header.push_str(&format!(" | {stop} {filter}"));
        }
    }
    println!("{header} |");
    let mut sums = [[(0u64, 0u64); FILTERS.len()]; PRODUCTION_STOPS.len()];
    for result in results {
        let mut row = format!("| {}", result.id);
        let mut before = [(0u64, 0u64); FILTERS.len()];
        for (stop_sums, stop_counts) in sums.iter_mut().zip(result.filters) {
            for ((sum, previous), (decided, fallback)) in
                stop_sums.iter_mut().zip(before.iter_mut()).zip(stop_counts)
            {
                let stage = (decided - previous.0, fallback - previous.1);
                *previous = (decided, fallback);
                sum.0 += stage.0;
                sum.1 += stage.1;
                row.push_str(&format!(" | {}/{}", stage.0, stage.1));
            }
        }
        println!("{row} |");
    }
    let mut row = "| Sum".to_owned();
    for stage in sums {
        for (decided, fallback) in stage {
            row.push_str(&format!(" | {decided}/{fallback}"));
        }
    }
    println!("{row} |");
}

/// The test-build hook cost: `fill_filter::Interval`'s R1 widening reads the thread-local
/// fault switch on every operation in test builds (constant `false` outside them). This times
/// one `add` and one `mul` of `fill_filter::Interval` against a copy of the same operations
/// without that read, in a dependent chain; ns per add+mul pair.
fn interval_hook_cost(timing: &Timing) -> (f64, f64) {
    #[derive(Clone, Copy)]
    struct Plain {
        lo: f64,
        hi: f64,
    }
    fn plain_rounded(lo: f64, hi: f64) -> Plain {
        if !lo.is_finite() || !hi.is_finite() {
            return Plain {
                lo: f64::NAN,
                hi: f64::NAN,
            };
        }
        Plain {
            lo: lo.next_down(),
            hi: hi.next_up(),
        }
    }
    fn plain_finite(value: Plain) -> bool {
        value.lo.is_finite() && value.hi.is_finite()
    }
    fn plain_add(left: Plain, right: Plain) -> Plain {
        if !plain_finite(left) || !plain_finite(right) {
            return Plain {
                lo: f64::NAN,
                hi: f64::NAN,
            };
        }
        plain_rounded(left.lo + right.lo, left.hi + right.hi)
    }
    fn plain_mul(left: Plain, right: Plain) -> Plain {
        if !plain_finite(left) || !plain_finite(right) {
            return Plain {
                lo: f64::NAN,
                hi: f64::NAN,
            };
        }
        let values = [
            left.lo * right.lo,
            left.lo * right.hi,
            left.hi * right.lo,
            left.hi * right.hi,
        ];
        if values.iter().any(|value| !value.is_finite()) {
            return Plain {
                lo: f64::NAN,
                hi: f64::NAN,
            };
        }
        let mut lo = values[0];
        let mut hi = values[0];
        for value in &values[1..] {
            lo = lo.min(*value);
            hi = hi.max(*value);
        }
        plain_rounded(lo, hi)
    }
    const CHAIN: usize = 10_000;
    let hooked = timing.measure(|| {
        let step = black_box(Interval::point(0.25));
        let half = black_box(Interval::point(0.5));
        let mut value = black_box(Interval::point(1.0));
        for _ in 0..CHAIN {
            value = value.add(step).mul(half);
        }
        black_box(value);
    }) / CHAIN as f64;
    let plain = timing.measure(|| {
        let step = black_box(Plain { lo: 0.25, hi: 0.25 });
        let half = black_box(Plain { lo: 0.5, hi: 0.5 });
        let mut value = black_box(Plain { lo: 1.0, hi: 1.0 });
        for _ in 0..CHAIN {
            value = plain_mul(plain_add(value, step), half);
        }
        black_box((value.lo, value.hi));
    }) / CHAIN as f64;
    (hooked, plain)
}

fn print_counts(id: &str, c: &Counts) {
    println!(
        "| {id} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {}/{}/{}/{} |",
        c.edges,
        c.leaves,
        c.segments,
        c.lookups,
        c.lookup_steps,
        c.splits,
        c.unshared_splits,
        c.fr2_terms,
        c.contracted,
        c.fr4_pairs,
        c.fr4_dots,
        c.visits,
        c.consecutive,
        c.candidates,
        c.box_decided,
        c.step2,
        c.step3,
        c.point_tests[0],
        c.point_tests[1],
        c.point_tests[2],
        c.point_tests[3]
    );
}

/// AL-U4a: the fidelity check of the mirror on every B0 path, then the production stops and the
/// mirror's sub-stage kernels on the spike's diagnostic cells (P2, P4 and P8, ten paths each).
/// Reads `P3_B0R_B0_CORPUS`; optional `P3_AL_DIAG_WARMUP` (3), `P3_AL_DIAG_TIMED` (21) and
/// `P3_AL_DIAG_INNER` (50). Release profile, one test thread, `--nocapture`.
#[test]
#[ignore = "AL-U4a diagnostic split; needs P3_B0R_B0_CORPUS; release profile; not evidence"]
fn al_u4a_certificate_sub_stage_split() {
    let cells = read_corpus(&env::var("P3_B0R_B0_CORPUS").expect("P3_B0R_B0_CORPUS is required"));
    let timing = Timing {
        warmup: env_or("P3_AL_DIAG_WARMUP", 3),
        timed: env_or("P3_AL_DIAG_TIMED", 21),
        inner: env_or("P3_AL_DIAG_INNER", 50).max(1),
    };
    let quantum = clock_quantum();
    let mut ladder = FillLadder::reserve(FILL_V0_LIMITS).expect("ladder");
    let mut workspace = CubicFillWorkspace::new(FILL_V0_LIMITS).expect("workspace");
    let mut prefix = CubicFillWorkspace::new(FILL_V0_LIMITS).expect("prefix workspace");
    let mut scan = DiagScan::new();

    // Fidelity: the mirror equals the production rung through FR5 on every B0 path.
    let mut mirror = Box::new(Mirror::new());
    let mut checked = 0usize;
    let mut passed = 0usize;
    let mut failures = Vec::new();
    for cell in &cells {
        for (index, path) in cell.paths.iter().enumerate() {
            let production = ladder.fast_rung_until(
                &mut workspace,
                request(),
                &path.verbs,
                &path.point_bytes,
                &mut scan,
                Stage::Fr5,
            );
            let stats = ladder.fast().stats();
            let mirrored = load_mirror(&mut prefix, &mut mirror, &path.verbs, &path.point_bytes)
                .and_then(|()| mirror.certificate_counted());
            checked += 1;
            let same_stats = production.is_err()
                || (stats.max_deviation_squared.to_bits()
                    == mirror.max_deviation_squared.to_bits()
                    && u64::from(stats.sweep_candidates) == mirror.counts.candidates
                    && u64::from(stats.clearance_step2) == mirror.counts.step2
                    && u64::from(stats.clearance_step3) == mirror.counts.step3);
            if production != mirrored || !same_stats {
                failures.push(format!(
                    "{}#{index}: production {production:?} {stats:?}, mirror {mirrored:?} {:?}",
                    cell.id, mirror.counts
                ));
            }
            if production.is_ok() {
                passed += 1;
            }
        }
    }
    println!(
        "Mirror fidelity: {checked} B0 paths, {passed} pass FR1-FR5 in production, {} differ",
        failures.len()
    );
    assert!(failures.is_empty(), "mirror differs: {failures:#?}");

    let diagnostic: Vec<&Cell> = cells.iter().filter(|cell| cell.is_primary()).collect();
    let mut results = Vec::with_capacity(diagnostic.len());
    for cell in diagnostic {
        let paths = &cell.paths[..CELL_PATHS];
        let mut stops = [0.0f64; PRODUCTION_STOPS.len()];
        let mut filters = [[(0u64, 0u64); FILTERS.len()]; PRODUCTION_STOPS.len()];
        for (slot, (_, stop)) in PRODUCTION_STOPS.iter().enumerate() {
            fill_filter::reset_counters();
            for path in paths {
                let _ = ladder.fast_rung_until(
                    &mut workspace,
                    request(),
                    &path.verbs,
                    &path.point_bytes,
                    &mut scan,
                    *stop,
                );
            }
            for (index, (_, id)) in FILTERS.iter().enumerate() {
                filters[slot][index] = fill_filter::counts(*id);
            }
            stops[slot] = timing.measure(|| {
                for path in paths {
                    let _ = black_box(ladder.fast_rung_until(
                        &mut workspace,
                        request(),
                        &path.verbs,
                        &path.point_bytes,
                        &mut scan,
                        *stop,
                    ));
                }
            });
        }
        // The mirror state of every path whose FR1-FR5 pass, prepared once (untimed).
        let mut mirrors = Vec::new();
        let mut counts = Counts::default();
        for path in paths {
            let mut state = Box::new(Mirror::new());
            let outcome = load_mirror(&mut prefix, &mut state, &path.verbs, &path.point_bytes)
                .and_then(|()| state.certificate_counted());
            if outcome.is_ok() {
                // Untimed cross-checks: each isolated kernel reproduces, on the prepared state,
                // what the counted stage pass observed.
                assert_eq!(
                    state.fr2_terms().map(f64::to_bits),
                    Ok(state.max_deviation_squared.to_bits()),
                    "FR2 terms kernel, {}",
                    cell.id
                );
                assert_eq!(
                    state.fr2_restrict(),
                    state.counts.splits,
                    "FR2 restrict kernel, {}",
                    cell.id
                );
                assert!(
                    state.fr2_restrict_unshared(),
                    "AL-U4a restrict kernel, {}",
                    cell.id
                );
                assert_eq!(
                    state.monotone_unshared(),
                    Ok(()),
                    "AL-U4b1 FR4 kernel, {}",
                    cell.id
                );
                assert_eq!(
                    u64::from(state.fr5_scan()),
                    state.counts.candidates,
                    "FR5 scan kernel, {}",
                    cell.id
                );
                assert_eq!(
                    u64::from(state.fr5_box_gap()),
                    state.counts.box_decided,
                    "FR5 box-gap kernel, {}",
                    cell.id
                );
                assert_eq!(
                    state.fr5_relation() as usize,
                    state.step3.len(),
                    "FR5 relation kernel, {}",
                    cell.id
                );
                counts.add(&state.counts);
                mirrors.push(state);
            }
        }
        let mut kernels = [0.0f64; KERNELS.len()];
        for (slot, value) in kernels.iter_mut().enumerate() {
            *value = measure_kernel(slot, &timing, &mut mirrors);
        }
        results.push(CellResult {
            id: cell.id.clone(),
            timed_paths: mirrors.len(),
            stops,
            filters,
            kernels,
            counts,
        });
    }
    print_tables(&results, &timing, quantum);
    let (hooked, plain) = interval_hook_cost(&timing);
    println!();
    println!(
        "Interval add+mul pair: {hooked:.2} ns with the test-build fault read (fill_filter), \
         {plain:.2} ns for the same operations without it (ratio {:.2})",
        hooked / plain
    );
}
