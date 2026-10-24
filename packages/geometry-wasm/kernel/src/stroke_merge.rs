//! D9 rendering-track item E2, unit E2-U1: the lossless seam merge E2-K1
//! (`docs/plans/d9-e2-stroke-fast-rung-contract.md`, section 4).
//!
//! It runs per path after the stroke front end has emitted its pieces (B2 section 4.1 step 4)
//! and before the arrangement. Step 1: every band piece (a sweep piece whose band quad
//! `E-(a), E-(b), E+(b), E+(a)` is strictly convex and positive) contributes the boundary-
//! inclusive hull of its quad and of the samples `C` the contract keeps; every other piece
//! contributes its hull unchanged. Step 2: a `C` strictly outside its quad across a seam, and
//! outside no other edge of it, is covered when a band piece that shares the whole seam triple
//! from the other side holds it in its quad. Step 3: opposite directed edges with bit-identical end points cancel in pairs.
//! Step 4: the remaining edges are traced into closed contours, taking the outgoing edges of a
//! vertex in emission order. The winding sum of the edges, and so the nonzero region, is the
//! union of the pieces as before; only the arrangement input changes.
//!
//! Every decision is an exact `orient2d` sign or a bit comparison. Storage is reserved once.

use core::cmp::Ordering;
use core::mem::size_of;

use crate::geometry::Point;
use crate::stroke_outline::{
    boundary_hull, orient, reserve, FrontEndError, Piece, PieceKind, StrokeDefects, Triple,
    MAX_PIECE_POINTS, MAX_PIECE_RECORDS,
};

/// Step-1 polygon points. A band polygon has at most six vertices and its piece's stored hull
/// at least three, so this bound is never reached by a path within `MAX_PIECE_POINTS`.
pub(crate) const MAX_POLYGON_POINTS: usize = MAX_PIECE_POINTS + 3 * MAX_PIECE_RECORDS;

const LIVE: u8 = 0;
const CANCELLED: u8 = 1;
const TRACED: u8 = 2;

/// The bit pattern of a point; equal keys are bit-identical points (hull points and band
/// polygon points are normalized with `+ 0.0`, so no `-0`).
type PointKey = (u64, u64);
type TripleKey = [u64; 6];

fn point_key(point: Point) -> PointKey {
    (point.x.to_bits(), point.y.to_bits())
}

fn triple_key(triple: &Triple) -> TripleKey {
    [
        triple.minus.x.to_bits(),
        triple.minus.y.to_bits(),
        triple.center.x.to_bits(),
        triple.center.y.to_bits(),
        triple.plus.x.to_bits(),
        triple.plus.y.to_bits(),
    ]
}

/// `point` with `-0` replaced by `+0`, as `push_candidate` stores every hull point, so that a
/// band polygon's edges cancel against a hull neighbour's bit for bit.
fn normalized(point: Point) -> Point {
    Point {
        x: point.x + 0.0,
        y: point.y + 0.0,
    }
}

/// The band quad of a sweep piece (section 3), or `None` when the piece is not a band piece.
pub(crate) fn band_quad(piece: &Piece) -> Result<Option<[Point; 4]>, FrontEndError> {
    if piece.dropped || !matches!(piece.kind, PieceKind::LineSweep | PieceKind::CubicLeaf) {
        return Ok(None);
    }
    let [a, b] = piece.meta.samples;
    let quad = [a.minus, b.minus, b.plus, a.plus].map(normalized);
    for index in 0..4 {
        if orient(quad[index], quad[(index + 1) % 4], quad[(index + 2) % 4])? != Ordering::Greater {
            return Ok(None);
        }
    }
    Ok(Some(quad))
}

/// Exact position of `point` against a strictly convex positive quad: `Greater` strictly
/// inside, `Less` strictly outside some edge, else `Equal` (on the boundary).
pub(crate) fn quad_position(quad: &[Point; 4], point: Point) -> Result<Ordering, FrontEndError> {
    let mut position = Ordering::Greater;
    for index in 0..4 {
        match orient(quad[index], quad[(index + 1) % 4], point)? {
            Ordering::Less => return Ok(Ordering::Less),
            Ordering::Equal => position = Ordering::Equal,
            Ordering::Greater => {}
        }
    }
    Ok(position)
}

/// E2-K1 storage and its result for the last path.
pub(crate) struct SeamMerge {
    /// Step-1 polygons, concatenated in emission order.
    polygon_points: Vec<Point>,
    /// `(piece record, start, count)` of each step-1 polygon.
    polygons: Vec<(u32, u32, u32)>,
    /// The end point index of the edge that starts at each polygon point.
    edge_end: Vec<u32>,
    /// `LIVE`, `CANCELLED` or `TRACED`, per edge.
    state: Vec<u8>,
    /// Edge permutation for the cancellation and tracing sorts.
    order: Vec<u32>,
    /// Per sorted position: the next outgoing edge to try in the group starting there.
    cursor: Vec<u32>,
    /// Band piece records sorted by `(start triple, record)` and by `(end triple, record)`.
    by_start: Vec<u32>,
    by_end: Vec<u32>,
    candidates: Vec<Point>,
    hull: Vec<Point>,
    /// Merged contours, all of them (a contour has at least three edges); `front_end` checks
    /// the caps of E2 section 7 on their totals.
    contour_points: Vec<Point>,
    contours: Vec<(u32, u32)>,
    cancelled_pairs: usize,
    bytes: usize,
}

impl SeamMerge {
    pub(crate) fn reserve() -> Result<Self, u32> {
        let mut merge = Self {
            polygon_points: reserve(MAX_POLYGON_POINTS)?,
            polygons: reserve(MAX_PIECE_RECORDS)?,
            edge_end: reserve(MAX_POLYGON_POINTS)?,
            state: reserve(MAX_POLYGON_POINTS)?,
            order: reserve(MAX_POLYGON_POINTS)?,
            cursor: reserve(MAX_POLYGON_POINTS)?,
            by_start: reserve(MAX_PIECE_RECORDS)?,
            by_end: reserve(MAX_PIECE_RECORDS)?,
            candidates: reserve(6)?,
            hull: reserve(2 * 6 + 1)?,
            contour_points: reserve(MAX_POLYGON_POINTS)?,
            contours: reserve(MAX_POLYGON_POINTS / 3 + 1)?,
            cancelled_pairs: 0,
            bytes: 0,
        };
        merge.bytes = merge.polygon_points.capacity() * size_of::<Point>()
            + merge.polygons.capacity() * size_of::<(u32, u32, u32)>()
            + merge.edge_end.capacity() * size_of::<u32>()
            + merge.state.capacity()
            + merge.order.capacity() * size_of::<u32>()
            + merge.cursor.capacity() * size_of::<u32>()
            + (merge.by_start.capacity() + merge.by_end.capacity()) * size_of::<u32>()
            + (merge.candidates.capacity() + merge.hull.capacity()) * size_of::<Point>()
            + merge.contour_points.capacity() * size_of::<Point>()
            + merge.contours.capacity() * size_of::<(u32, u32)>();
        Ok(merge)
    }

    pub(crate) fn allocated_bytes(&self) -> usize {
        self.bytes
    }

    pub(crate) fn clear(&mut self) {
        self.polygon_points.clear();
        self.polygons.clear();
        self.edge_end.clear();
        self.state.clear();
        self.order.clear();
        self.cursor.clear();
        self.by_start.clear();
        self.by_end.clear();
        self.contour_points.clear();
        self.contours.clear();
        self.cancelled_pairs = 0;
    }

    /// Merged contours.
    pub(crate) fn contour_total(&self) -> usize {
        self.contours.len()
    }

    /// Merged contour vertices.
    pub(crate) fn vertex_total(&self) -> usize {
        self.contour_points.len()
    }

    /// Opposite edge pairs removed by step 3.
    pub(crate) fn cancelled_pairs(&self) -> usize {
        self.cancelled_pairs
    }

    /// The merged contours, in tracing order.
    pub(crate) fn contours(&self) -> impl Iterator<Item = &[Point]> + '_ {
        self.contours
            .iter()
            .map(|&(start, count)| &self.contour_points[start as usize..(start + count) as usize])
    }

    /// The step-1 polygons as `(piece record, polygon)`, in emission order.
    pub(crate) fn polygons(&self) -> impl Iterator<Item = (usize, &[Point])> + '_ {
        self.polygons.iter().map(|&(piece, start, count)| {
            (
                piece as usize,
                &self.polygon_points[start as usize..(start + count) as usize],
            )
        })
    }

    /// Runs E2-K1 on the emitted pieces of one path. `piece_points` holds every emitted
    /// piece's hull (the stored-point cap was checked at emission).
    pub(crate) fn merge(
        &mut self,
        pieces: &[Piece],
        piece_points: &[Point],
        defects: StrokeDefects,
    ) -> Result<(), FrontEndError> {
        self.clear();
        self.index_bands(pieces)?;
        for (record, piece) in pieces.iter().enumerate() {
            if piece.dropped {
                continue;
            }
            let start = self.polygon_points.len();
            match band_quad(piece)? {
                Some(quad) => self.push_band(pieces, piece, quad, defects)?,
                None => {
                    let hull = piece_points
                        .get(piece.start..piece.start + piece.count)
                        .ok_or(FrontEndError::Invariant)?;
                    self.push_polygon(hull)?;
                }
            }
            let count = self.polygon_points.len() - start;
            // ST-D13 (B2 section 11.3): the step-1 polygon of an odd line sweep clockwise.
            // A non-band polygon is the stored hull, which `emit_line_part` already reversed.
            if defects.clockwise_piece()
                && piece.kind == PieceKind::LineSweep
                && piece.segment % 2 == 1
                && band_quad(piece)?.is_some()
            {
                self.polygon_points[start..].reverse();
            }
            for offset in 0..count {
                self.edge_end.push((start + (offset + 1) % count) as u32);
                self.state.push(LIVE);
            }
            self.polygons
                .push((record as u32, start as u32, count as u32));
        }
        self.cancel();
        self.trace()
    }

    /// Band piece records sorted by their start triple and by their end triple, each tie in
    /// record order, for the covered test of step 2.
    fn index_bands(&mut self, pieces: &[Piece]) -> Result<(), FrontEndError> {
        for (record, piece) in pieces.iter().enumerate() {
            if band_quad(piece)?.is_some() {
                self.by_start.push(record as u32);
                self.by_end.push(record as u32);
            }
        }
        let key =
            |record: u32, side: usize| triple_key(&pieces[record as usize].meta.samples[side]);
        self.by_start
            .sort_unstable_by(|&a, &b| key(a, 0).cmp(&key(b, 0)).then(a.cmp(&b)));
        self.by_end
            .sort_unstable_by(|&a, &b| key(a, 1).cmp(&key(b, 1)).then(a.cmp(&b)));
        Ok(())
    }

    /// The first band piece in record order whose `side` triple is `triple`, bit for bit.
    fn band_with(&self, pieces: &[Piece], side: usize, triple: &Triple) -> Option<usize> {
        let index = if side == 0 {
            &self.by_start
        } else {
            &self.by_end
        };
        let target = triple_key(triple);
        let position = index.partition_point(|&record| {
            triple_key(&pieces[record as usize].meta.samples[side]) < target
        });
        index
            .get(position)
            .map(|&record| record as usize)
            .filter(|&record| triple_key(&pieces[record].meta.samples[side]) == target)
    }

    /// Steps 1 and 2 for one band piece: its quad plus each `C` that is not strictly inside
    /// it, unless that `C` is strictly outside across its seam and covered.
    fn push_band(
        &mut self,
        pieces: &[Piece],
        piece: &Piece,
        quad: [Point; 4],
        defects: StrokeDefects,
    ) -> Result<(), FrontEndError> {
        self.candidates.clear();
        self.candidates.extend_from_slice(&quad);
        let [a, b] = piece.meta.samples;
        // (sample, its seam edge `quad[seam] -> quad[seam + 1]`, the neighbour's matching side).
        let seams = [(a, 3usize, 1usize), (b, 1usize, 0usize)];
        for (sample, seam, side) in seams {
            let c = normalized(sample.center);
            let mut sides = [Ordering::Equal; 4];
            for (index, value) in sides.iter_mut().enumerate() {
                *value = orient(quad[index], quad[(index + 1) % 4], c)?;
            }
            if sides.iter().all(|&value| value == Ordering::Greater) {
                continue;
            }
            // Only a `C` strictly outside its seam and on no other edge's outer side adds
            // exactly the triangle `E-, C, E+`, which a covering quad then holds.
            let across = sides[seam] == Ordering::Less
                && (0..4).all(|index| index == seam || sides[index] != Ordering::Less);
            if across {
                let covered = if defects.drop_outside() {
                    true
                } else {
                    match self.band_with(pieces, side, &sample) {
                        Some(record) => {
                            let neighbour =
                                band_quad(&pieces[record])?.ok_or(FrontEndError::Invariant)?;
                            quad_position(&neighbour, c)? != Ordering::Less
                        }
                        None => false,
                    }
                };
                if covered {
                    continue;
                }
            }
            if self.candidates.len() >= self.candidates.capacity() {
                return Err(FrontEndError::Invariant);
            }
            self.candidates.push(c);
        }
        if !boundary_hull(&mut self.candidates, &mut self.hull)? {
            return Err(FrontEndError::Invariant);
        }
        let start = self.polygon_points.len();
        if start + self.hull.len() > self.polygon_points.capacity() {
            return Err(FrontEndError::Invariant);
        }
        self.polygon_points.extend_from_slice(&self.hull);
        Ok(())
    }

    fn push_polygon(&mut self, points: &[Point]) -> Result<(), FrontEndError> {
        if self.polygon_points.len() + points.len() > self.polygon_points.capacity() {
            return Err(FrontEndError::Invariant);
        }
        self.polygon_points.extend_from_slice(points);
        Ok(())
    }

    fn from(&self, edge: u32) -> Point {
        self.polygon_points[edge as usize]
    }

    fn to(&self, edge: u32) -> Point {
        self.polygon_points[self.edge_end[edge as usize] as usize]
    }

    /// Step 3: within each group of edges on the same two end points, the k-th edge of one
    /// direction cancels the k-th edge of the other, both in emission order.
    fn cancel(&mut self) {
        let edges = self.polygon_points.len() as u32;
        self.order.extend(0..edges);
        let undirected = |merge: &Self, edge: u32| {
            let (a, b) = (point_key(merge.from(edge)), point_key(merge.to(edge)));
            if a <= b {
                (a, b)
            } else {
                (b, a)
            }
        };
        let mut order = core::mem::take(&mut self.order);
        order.sort_unstable_by(|&x, &y| {
            undirected(self, x)
                .cmp(&undirected(self, y))
                .then(x.cmp(&y))
        });
        let forward =
            |merge: &Self, edge: u32| point_key(merge.from(edge)) < point_key(merge.to(edge));
        let mut group = 0usize;
        while group < order.len() {
            let key = undirected(self, order[group]);
            let mut end = group + 1;
            while end < order.len() && undirected(self, order[end]) == key {
                end += 1;
            }
            let (mut f, mut b) = (group, group);
            loop {
                while f < end && !forward(self, order[f]) {
                    f += 1;
                }
                while b < end && forward(self, order[b]) {
                    b += 1;
                }
                if f >= end || b >= end {
                    break;
                }
                self.state[order[f] as usize] = CANCELLED;
                self.state[order[b] as usize] = CANCELLED;
                self.cancelled_pairs += 1;
                f += 1;
                b += 1;
            }
            group = end;
        }
        order.clear();
        self.order = order;
    }

    /// Step 4: each contour starts at the first untraced edge in emission order and, at every
    /// vertex, leaves by the first untraced outgoing edge in emission order; it closes at its
    /// first return to its start vertex. Every vertex has as many live edges in as out, so the
    /// walk always continues until it closes.
    fn trace(&mut self) -> Result<(), FrontEndError> {
        let edges = self.polygon_points.len() as u32;
        let mut order = core::mem::take(&mut self.order);
        order.extend((0..edges).filter(|&edge| self.state[edge as usize] == LIVE));
        order.sort_unstable_by(|&x, &y| {
            point_key(self.from(x))
                .cmp(&point_key(self.from(y)))
                .then(x.cmp(&y))
        });
        self.cursor.clear();
        self.cursor.extend(0..order.len() as u32);
        let result = self.trace_sorted(&order, edges);
        self.order = order;
        result
    }

    fn trace_sorted(&mut self, order: &[u32], edges: u32) -> Result<(), FrontEndError> {
        for first in 0..edges {
            if self.state[first as usize] != LIVE {
                continue;
            }
            self.state[first as usize] = TRACED;
            let origin = self.from(first);
            let start = self.contour_points.len();
            self.push_vertex(origin)?;
            let mut current = self.to(first);
            while point_key(current) != point_key(origin) {
                self.push_vertex(current)?;
                let key = point_key(current);
                let group = order.partition_point(|&edge| point_key(self.from(edge)) < key);
                let mut position = self.cursor[group] as usize;
                while position < order.len()
                    && point_key(self.from(order[position])) == key
                    && self.state[order[position] as usize] != LIVE
                {
                    position += 1;
                }
                self.cursor[group] = position as u32;
                let next = *order
                    .get(position)
                    .filter(|&&edge| point_key(self.from(edge)) == key)
                    .ok_or(FrontEndError::Invariant)?;
                self.state[next as usize] = TRACED;
                current = self.to(next);
            }
            let count = self.contour_points.len() - start;
            if self.contours.len() >= self.contours.capacity() {
                return Err(FrontEndError::Invariant);
            }
            self.contours.push((start as u32, count as u32));
        }
        Ok(())
    }

    fn push_vertex(&mut self, point: Point) -> Result<(), FrontEndError> {
        if self.contour_points.len() >= self.contour_points.capacity() {
            return Err(FrontEndError::Invariant);
        }
        self.contour_points.push(point);
        Ok(())
    }
}
