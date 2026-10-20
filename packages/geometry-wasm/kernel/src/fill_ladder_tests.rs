//! P3 Alt-A1 unit AL-U1 tests (`docs/plans/p3-alt-a1-fill-ladder-contract.md` sections 3.4,
//! 4.3 and 4.4): the spike fixtures SL-F1 to SL-F21 re-run against the production module with
//! their literal expectations, the AL-F fixtures at module level (AL-F1 to AL-F10 with AL-F8b
//! (a) and (c); the export parts of AL-F1, AL-F5, AL-F6, AL-F7 and AL-F9 wait for AL-U3), the
//! seeded defects (1)-(13), the S1 prefix identity, the reserve-time storage and the
//! allocation-free rung 0 (AL-A6), and AL-I3, the differential against the frozen spike module
//! `p3_b0_spike.rs`.
//!
//! The debug tests run the fixtures, a few real paths and a small generated sample. The B0
//! framed corpus and `p3-b0r-random/v1` runs are ignored release tests reading
//! `P3_B0R_B0_CORPUS` and `P3_B0R_RANDOM_CORPUS`, the variables the identity tool uses.
//!
//! AL-FR9 item 2 is V2's `collect_boundary`, which the export runs on its fill scratch from
//! AL-U3. These tests use `TestScan`, a statement-for-statement copy of that scan on its own
//! reserved buffers, because `FillScratch` is private to `fill_export.rs`.
use core::cmp::Ordering;
use std::env;
use std::fmt::Write as _;

use crate::codec::{PathInput, Request};
use crate::cubic_fill::{
    ContourRange, CubicFillWorkspace, DecodedSource, EdgeOwner, PrefixFailure, S1View,
    MAX_FLAT_COMMANDS,
};
use crate::engine::BATCH_INTERNAL_ERROR;
use crate::fill_export::{tolerances, FillRequest, FILL_V0_LIMITS};
use crate::fill_filter::{with_fault, Fault};
use crate::fill_ladder::{
    exact_cascade, with_ladder_faults, BoundaryScan, ExactOutcome, ExactStep, FastRung, FillLadder,
    LadderFault, Reason, Rung, Stage, MAX_BOUNDARY_RECORDS, MAX_FAST_EXPONENT, MIN_FAST_EXPONENT,
};
use crate::fill_predicates::orient2d;
use crate::geometry::Point;
use crate::line_fill::LineFillRule;
use crate::native_cubic_fill_tests::LIMITS;
use crate::p3_b0_spike;

/// δ = 2^-3 for every synthetic fixture, as in the spike (spike section 4.8).
const DELTA: f64 = 0.125;
const B0_EXPONENT: i32 = -3;

fn p(x: f64, y: f64) -> Point {
    Point { x, y }
}

fn pow2(exponent: i32) -> f64 {
    2.0f64.powi(exponent)
}

// ------------------------------------------------------------------------------------------
// AL-FR9 item 2 for the tests: a copy of V2's `FillScratch::collect_boundary`.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct DirectedEdge {
    low: u32,
    high: u32,
    position: u32,
    forward: bool,
}

const UNUSED_PAIR: [u32; 2] = [u32::MAX, u32::MAX];

/// The once-only scan of V2 section f on reserved buffers: same records, same sort key, same
/// group rule (one record: boundary; two of opposite direction: interior; otherwise failure).
struct TestScan {
    edges: Vec<DirectedEdge>,
    boundary: Vec<[u32; 2]>,
}

impl TestScan {
    fn new() -> Self {
        Self {
            edges: Vec::with_capacity(MAX_BOUNDARY_RECORDS),
            boundary: Vec::with_capacity(MAX_BOUNDARY_RECORDS),
        }
    }
}

impl BoundaryScan for TestScan {
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
// Synthetic S1 views (the spike tests' builder, spike section 4.8).

#[derive(Clone)]
enum Segment {
    Line {
        to: Point,
        emitted: Point,
    },
    /// A cubic source with its leaves (end numerator, depth, emitted end knot).
    Cubic {
        one: Point,
        two: Point,
        to: Point,
        leaves: Vec<(u32, u32, Point)>,
    },
}

#[derive(Clone)]
struct ContourSpec {
    start: Point,
    segments: Vec<Segment>,
    close: bool,
}

fn line(to: Point) -> Segment {
    Segment::Line { to, emitted: to }
}

/// A cubic source from `from` to `to` with its controls at the thirds (binary64-rounded).
fn straight_cubic(from: Point, to: Point, leaves: Vec<(u32, u32, Point)>) -> Segment {
    Segment::Cubic {
        one: p(
            from.x + (to.x - from.x) / 3.0,
            from.y + (to.y - from.y) / 3.0,
        ),
        two: p(
            from.x + 2.0 * (to.x - from.x) / 3.0,
            from.y + 2.0 * (to.y - from.y) / 3.0,
        ),
        to,
        leaves,
    }
}

/// A closed contour of `Line` sources through `vertices`, with exact knots and a CLOSE verb.
fn line_contour(vertices: &[Point]) -> ContourSpec {
    let mut segments: Vec<Segment> = vertices[1..].iter().copied().map(line).collect();
    segments.push(line(vertices[0]));
    ContourSpec {
        start: vertices[0],
        segments,
        close: true,
    }
}

#[derive(Clone, Debug)]
struct OwnedView {
    ranges: Vec<ContourRange>,
    points: Vec<Point>,
    owners: Vec<EdgeOwner>,
    sources: Vec<DecodedSource>,
}

impl OwnedView {
    fn view(&self) -> S1View<'_> {
        S1View {
            commands: &[],
            ranges: &self.ranges,
            points: &self.points,
            owners: &self.owners,
            sources: &self.sources,
        }
    }

    fn spike_view(&self) -> p3_b0_spike::S1View<'_> {
        p3_b0_spike::S1View {
            commands: &[],
            ranges: &self.ranges,
            points: &self.points,
            owners: &self.owners,
            sources: &self.sources,
        }
    }
}

/// Builds the S1 view that `collect_contours` would produce for these sources and emitted
/// knots: the last knot is dropped when it equals the MOVE point, otherwise a close edge is
/// pushed (`ExplicitClose` with a CLOSE verb, `ImplicitClosure` without).
fn build(contours: &[ContourSpec]) -> OwnedView {
    let mut view = OwnedView {
        ranges: Vec::new(),
        points: Vec::new(),
        owners: Vec::new(),
        sources: Vec::new(),
    };
    let mut verb = 0u32;
    for (index, contour) in contours.iter().enumerate() {
        let start = view.points.len();
        view.points.push(contour.start);
        verb += 1;
        let mut current = contour.start;
        for segment in &contour.segments {
            let source_verb = verb;
            verb += 1;
            match segment {
                Segment::Line { to, emitted } => {
                    view.sources.push(DecodedSource::Line {
                        points: [current, *to],
                        source_verb,
                        contour: index,
                    });
                    view.owners.push(EdgeOwner::Line { source_verb });
                    view.points.push(*emitted);
                    current = *to;
                }
                Segment::Cubic {
                    one,
                    two,
                    to,
                    leaves,
                } => {
                    view.sources.push(DecodedSource::Cubic {
                        points: [current, *one, *two, *to],
                        source_verb,
                        contour: index,
                    });
                    for (end_numerator, depth, emitted) in leaves {
                        view.owners.push(EdgeOwner::CubicLeaf {
                            source_verb,
                            end_numerator: *end_numerator,
                            depth: *depth,
                        });
                        view.points.push(*emitted);
                    }
                    current = *to;
                }
            }
        }
        let close_verb = verb;
        if contour.close {
            verb += 1;
        }
        if view.points.len() > start + 1 {
            let first = view.points[start];
            let last = view.points[view.points.len() - 1];
            if first == last {
                view.points.pop();
            } else if contour.close {
                view.owners.push(EdgeOwner::ExplicitClose {
                    source_verb: close_verb,
                });
            } else {
                view.owners
                    .push(EdgeOwner::ImplicitClosure { contour: index });
            }
        }
        view.ranges.push(ContourRange {
            start,
            count: view.points.len() - start,
        });
    }
    view
}

// ------------------------------------------------------------------------------------------
// Fixtures: SL-F1 to SL-F21 (spike section 4.8) with their literal expectations, unchanged,
// and the synthetic views AL-F3 and AL-F4 (contract section 4.3), whose expectations were
// written before the first execution.

#[derive(Clone, Copy, Debug)]
enum Expected {
    /// Fast, with the literal signed area, the boundary contours and optionally the triangles.
    Fast {
        area: f64,
        boundary: &'static [usize],
        triangles: Option<usize>,
    },
    Fallback(Reason),
    /// The stages up to and including this one pass (SL-F21 (a)).
    Passes(Stage),
}

struct Fixture {
    id: &'static str,
    view: OwnedView,
    rule: LineFillRule,
    expected: Expected,
}

fn square(x0: f64, y0: f64, x1: f64, y1: f64) -> [Point; 4] {
    [p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1)]
}

/// Spike section 3.7's first example: contour 1 starts with the cubic e, contour 2 with f.
fn first_example_contour_one() -> ContourSpec {
    ContourSpec {
        start: p(0.0, 0.0),
        segments: vec![
            Segment::Cubic {
                one: p(1.0, 3.0 / 32.0),
                two: p(2.0, 3.0 / 32.0),
                to: p(3.0, 0.0),
                leaves: vec![(1, 0, p(3.0, 0.0))],
            },
            line(p(3.0, -1.0)),
            line(p(0.0, -1.0)),
            line(p(0.0, 0.0)),
        ],
        close: true,
    }
}

/// SL-F12 and SL-F21: the unit square with a closing cubic (0, 1) → (0, 0) whose single leaf
/// ends at k, then the degenerate `ExplicitClose` [k, (0, 0)].
fn micro_closure_square(k: Point) -> ContourSpec {
    ContourSpec {
        start: p(0.0, 0.0),
        segments: vec![
            line(p(1.0, 0.0)),
            line(p(1.0, 1.0)),
            line(p(0.0, 1.0)),
            straight_cubic(p(0.0, 1.0), p(0.0, 0.0), vec![(1, 0, k)]),
        ],
        close: true,
    }
}

/// AL-F3 and AL-F4: the rectangle m = (0, 0), (4, 0), (4, 3), p = (0, 3) closed by the cubic
/// p, (3/32, 2), (0, 1), m, whose single leaf ends at k = (0, κ), then the degenerate
/// `ExplicitClose` [k, m]. Hand derivation (δ = 1/8): on e′ = [p, m], (2p + m)/3 = (0, 2) and
/// (p + 2m)/3 = (0, 1), so d_1 = (3/32, 0), d_0 = d_2 = d_3 = 0 and δ̄(e′) = 3/32 < δ. k lies on
/// [p, m] strictly between them (σ = 0, ⟨k − p, m − k⟩ = κ(3 − κ) > 0, q = (4, 0) and
/// r = (4, 3) off the line), so SL-M2 to SL-M4 hold, and |k − m| = κ < δ. FR4: every chord
/// and control dot of the four pairs of P′ is positive (pair (h, e′), w = (−4, −3): 16, 9,
/// 2.625, 3.375, 3; pair (e′, f), w = (4, −3): 9, 16, 3.375, 2.625, 3). FR5: the opposite
/// sides of P′ are 3 and 4 apart. P is the rectangle with k on its left side: area 12, five
/// vertices, three triangles.
fn al_closure_rectangle(kappa: f64) -> ContourSpec {
    ContourSpec {
        start: p(0.0, 0.0),
        segments: vec![
            line(p(4.0, 0.0)),
            line(p(4.0, 3.0)),
            line(p(0.0, 3.0)),
            Segment::Cubic {
                one: p(3.0 / 32.0, 2.0),
                two: p(0.0, 1.0),
                to: p(0.0, 0.0),
                leaves: vec![(1, 0, p(0.0, kappa))],
            },
        ],
        close: true,
    }
}

fn fixtures() -> Vec<Fixture> {
    let nonzero = LineFillRule::Nonzero;
    let evenodd = LineFillRule::Evenodd;
    let f01 = square(0.0, 0.0, 10.0, 10.0);
    let inner = square(3.0, 3.0, 7.0, 7.0);
    let inner_reversed = [inner[0], inner[3], inner[2], inner[1]];
    let f01_reversed = [f01[0], f01[3], f01[2], f01[1]];
    let tiny = pow2(-30);
    let shift = pow2(-20);
    let mut list = Vec::new();
    let mut add = |id, contours: Vec<ContourSpec>, rule, expected| {
        list.push(Fixture {
            id,
            view: build(&contours),
            rule,
            expected,
        });
    };

    add(
        "SL-F1",
        vec![
            first_example_contour_one(),
            ContourSpec {
                start: p(3.0, 1.0 / 8.0),
                segments: vec![
                    Segment::Cubic {
                        one: p(2.0, 1.0 / 32.0),
                        two: p(1.0, 1.0 / 32.0),
                        to: p(0.0, 1.0 / 8.0),
                        leaves: vec![(1, 0, p(0.0, 1.0 / 8.0))],
                    },
                    line(p(0.0, 9.0 / 8.0)),
                    line(p(3.0, 9.0 / 8.0)),
                    line(p(3.0, 1.0 / 8.0)),
                ],
                close: true,
            },
        ],
        nonzero,
        Expected::Fallback(Reason::Clearance),
    );
    add(
        "SL-F2",
        vec![
            first_example_contour_one(),
            line_contour(&[
                p(1.0, 1.0 / 32.0),
                p(1.5, -1.0 / 32.0),
                p(1.5, 1.0),
                p(1.0, 1.0),
            ]),
        ],
        nonzero,
        Expected::Fallback(Reason::Crossing),
    );
    add(
        "SL-F3",
        vec![
            line_contour(&square(0.0, 0.0, 1.0, 1.0)),
            line_contour(&square(1.25, 0.0, 2.25, 1.0)),
        ],
        nonzero,
        Expected::Fallback(Reason::Clearance),
    );
    add(
        "SL-F4",
        vec![
            line_contour(&square(0.0, 0.0, 1.0, 1.0)),
            line_contour(&square(1.25 + shift, 0.0, 2.25 + shift, 1.0)),
        ],
        nonzero,
        Expected::Fast {
            area: 2.0,
            boundary: &[0, 1],
            triangles: Some(4),
        },
    );
    for (id, rule) in [("SL-F5/nonzero", nonzero), ("SL-F5/evenodd", evenodd)] {
        add(
            id,
            vec![line_contour(&f01)],
            rule,
            Expected::Fast {
                area: 100.0,
                boundary: &[0],
                triangles: Some(2),
            },
        );
    }
    add(
        "SL-F6/nonzero",
        vec![line_contour(&f01), line_contour(&inner)],
        nonzero,
        Expected::Fast {
            area: 100.0,
            boundary: &[0],
            triangles: Some(2),
        },
    );
    add(
        "SL-F6/evenodd",
        vec![line_contour(&f01), line_contour(&inner)],
        evenodd,
        Expected::Fast {
            area: 84.0,
            boundary: &[0, 1],
            triangles: Some(8),
        },
    );
    for (id, rule) in [("SL-F7/nonzero", nonzero), ("SL-F7/evenodd", evenodd)] {
        add(
            id,
            vec![line_contour(&f01), line_contour(&inner_reversed)],
            rule,
            Expected::Fast {
                area: 84.0,
                boundary: &[0, 1],
                triangles: Some(8),
            },
        );
    }
    add(
        "SL-F8/F05",
        vec![line_contour(&f01), line_contour(&f01_reversed)],
        nonzero,
        Expected::Fallback(Reason::Crossing),
    );
    add(
        "SL-F8/F07",
        vec![
            line_contour(&square(0.0, 0.0, 2.0, 2.0)),
            line_contour(&square(2.0, 0.0, 4.0, 2.0)),
        ],
        nonzero,
        Expected::Fallback(Reason::Crossing),
    );
    add(
        "SL-F9",
        vec![line_contour(&[
            p(0.0, 0.0),
            p(4.0, 4.0),
            p(0.0, 4.0),
            p(4.0, 0.0),
        ])],
        nonzero,
        Expected::Fallback(Reason::Monotone),
    );
    add(
        "SL-F10",
        vec![ContourSpec {
            start: p(0.0, 0.0),
            segments: vec![
                Segment::Cubic {
                    one: p(-1.0 / 32.0, 1.0 / 32.0),
                    two: p(3.0 / 16.0, 0.0),
                    to: p(0.25, 0.0),
                    leaves: vec![(1, 0, p(0.25, 0.0))],
                },
                line(p(0.25, 1.0)),
                line(p(0.0, 1.0)),
                line(p(0.0, 0.0)),
            ],
            close: true,
        }],
        nonzero,
        Expected::Fallback(Reason::Monotone),
    );
    // SL-F10b, the spike's supplementary fixture (its review item S1).
    add(
        "SL-F10b",
        vec![
            ContourSpec {
                start: p(0.0, 0.0),
                segments: vec![
                    Segment::Cubic {
                        one: p(1.0 / 16.0, 1.0 / 16.0),
                        two: p(5.0 / 16.0, 1.0 / 32.0),
                        to: p(0.5, 0.0),
                        leaves: vec![(1, 0, p(0.5, 0.0))],
                    },
                    line(p(0.25, 0.5)),
                    line(p(0.0, 0.0)),
                ],
                close: true,
            },
            line_contour(&square(10.0, 10.0, 11.0, 11.0)),
        ],
        nonzero,
        Expected::Fallback(Reason::Monotone),
    );
    add(
        "SL-F11",
        vec![ContourSpec {
            start: p(0.0, 0.0),
            segments: vec![
                Segment::Line {
                    to: p(10.0, 0.0),
                    emitted: p(163.0 / 16.0, 0.0),
                },
                line(p(10.0, 10.0)),
                line(p(0.0, 10.0)),
                line(p(0.0, 0.0)),
            ],
            close: true,
        }],
        nonzero,
        Expected::Fallback(Reason::Deviation),
    );
    add(
        "SL-F12a",
        vec![micro_closure_square(p(tiny, tiny))],
        nonzero,
        Expected::Fast {
            area: 1.0 - pow2(-31),
            boundary: &[0],
            triangles: Some(3),
        },
    );
    add(
        "SL-F12b",
        vec![micro_closure_square(p(tiny, -tiny))],
        nonzero,
        Expected::Fallback(Reason::Closure),
    );
    add(
        "SL-F14",
        vec![ContourSpec {
            start: p(0.0, 0.0),
            segments: vec![
                line(p(1.0, 0.0)),
                line(p(1.0, 1.0)),
                straight_cubic(p(1.0, 1.0), p(tiny, 0.0), vec![(1, 0, p(0.0, 0.0))]),
            ],
            close: false,
        }],
        nonzero,
        Expected::Fallback(Reason::Structure),
    );
    add(
        "SL-F15",
        vec![
            line_contour(&f01),
            ContourSpec {
                start: p(20.0, 0.0),
                segments: vec![line(p(21.0, 0.0))],
                close: false,
            },
        ],
        nonzero,
        Expected::Fallback(Reason::Structure),
    );
    for (id, close) in [("SL-F16", false), ("SL-F17", true)] {
        add(
            id,
            vec![ContourSpec {
                start: p(0.0, 0.0),
                segments: vec![line(p(4.0, 0.0)), line(p(4.0, 4.0)), line(p(0.0, 4.0))],
                close,
            }],
            nonzero,
            Expected::Fast {
                area: 16.0,
                boundary: &[0],
                triangles: Some(2),
            },
        );
    }
    add(
        "SL-F18",
        vec![line_contour(&[
            p(0.0, 0.0),
            p(4.0, 0.0),
            p(4.0, 0.5),
            p(8.0, 15.0 / 16.0),
            p(8.0, 17.0 / 16.0),
            p(4.0, 1.5),
            p(4.0, 2.0),
            p(0.0, 2.0),
        ])],
        nonzero,
        Expected::Fallback(Reason::Clearance),
    );
    let corners = square(0.0, 0.0, 12.0, 12.0);
    let mids = [p(6.0, 5.0 / 32.0), p(12.0, 6.0), p(6.0, 12.0), p(0.0, 6.0)];
    add(
        "SL-F19",
        vec![ContourSpec {
            start: corners[0],
            segments: (0..4)
                .map(|side| {
                    let to = corners[(side + 1) % 4];
                    straight_cubic(corners[side], to, vec![(1, 1, mids[side]), (2, 1, to)])
                })
                .collect(),
            close: true,
        }],
        nonzero,
        Expected::Fallback(Reason::Deviation),
    );
    add(
        "SL-F20",
        vec![ContourSpec {
            start: p(0.0, 0.0),
            segments: vec![
                line(p(1.0, 0.0)),
                line(p(1.0, 1.0)),
                line(p(1.0 / 64.0, 0.5)),
                line(p(0.0, 1.0)),
                straight_cubic(
                    p(0.0, 1.0),
                    p(0.0, 0.0),
                    vec![(1, 0, p(1.0 / 16.0, 1.0 / 64.0))],
                ),
            ],
            close: true,
        }],
        nonzero,
        Expected::Fallback(Reason::Closure),
    );
    add(
        "SL-F21a",
        vec![micro_closure_square(p(0.0, tiny))],
        nonzero,
        Expected::Passes(Stage::Fr3),
    );
    add(
        "SL-F21b",
        vec![micro_closure_square(p(0.0, -tiny))],
        nonzero,
        Expected::Fallback(Reason::Closure),
    );
    // AL-F3: |k − m| = 1/16, so δ̄(e′) + |k − m| = 5/32 > δ (AL-M5).
    add(
        "AL-F3",
        vec![al_closure_rectangle(1.0 / 16.0)],
        nonzero,
        Expected::Fallback(Reason::Closure),
    );
    // AL-F4: |k − m| = 1/64, so the sum is 7/64 < δ.
    add(
        "AL-F4",
        vec![al_closure_rectangle(1.0 / 64.0)],
        nonzero,
        Expected::Fast {
            area: 12.0,
            boundary: &[0],
            triangles: Some(3),
        },
    );
    list
}

fn fixture(id: &str) -> Fixture {
    fixtures()
        .into_iter()
        .find(|fixture| fixture.id == id)
        .unwrap_or_else(|| panic!("unknown fixture {id}"))
}

// ------------------------------------------------------------------------------------------
// Rust-side mesh checks (spike section 4.8).

fn signed_area(vertices: &[Point], triangles: &[[u32; 3]]) -> f64 {
    let mut twice = 0.0;
    for triangle in triangles {
        let [a, b, c] = triangle.map(|index| vertices[index as usize]);
        twice += (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    }
    twice / 2.0
}

fn bits(point: Point) -> (u64, u64) {
    (point.x.to_bits(), point.y.to_bits())
}

fn contour_points<'a>(ranges: &[ContourRange], points: &'a [Point], contour: usize) -> &'a [Point] {
    let range = ranges[contour];
    &points[range.start..range.start + range.count]
}

/// Orientation, signed area (exact when `exact_area`, otherwise to a relative 1e-12), the
/// vertex set, the optional triangle count, and the directed-edge cancellation aid.
fn check_mesh(
    ranges: &[ContourRange],
    points: &[Point],
    mesh: (&[Point], &[[u32; 3]]),
    boundary: &[usize],
    area: f64,
    exact_area: bool,
    triangle_count: Option<usize>,
) -> Result<(), String> {
    let (vertices, triangles) = mesh;
    for (index, triangle) in triangles.iter().enumerate() {
        let [a, b, c] = triangle.map(|vertex| vertices[vertex as usize]);
        if orient2d(a, b, c) != Ok(Ordering::Greater) {
            return Err(format!("triangle {index} {triangle:?} is not positive"));
        }
    }
    let measured = signed_area(vertices, triangles);
    let area_ok = if exact_area {
        measured == area
    } else {
        (measured - area).abs() <= 1e-12 * area.abs()
    };
    if !area_ok {
        return Err(format!("signed area {measured:?}, expected {area:?}"));
    }
    let mut expected: Vec<(u64, u64)> = boundary
        .iter()
        .flat_map(|contour| contour_points(ranges, points, *contour).iter().copied())
        .map(bits)
        .collect();
    let mut actual: Vec<(u64, u64)> = vertices.iter().copied().map(bits).collect();
    expected.sort_unstable();
    actual.sort_unstable();
    if expected != actual {
        return Err("the vertex set differs from the boundary contours' vertex set".to_owned());
    }
    if let Some(count) = triangle_count {
        if triangles.len() != count {
            return Err(format!("{} triangles, expected {count}", triangles.len()));
        }
    }
    let mut directed: Vec<((u64, u64), (u64, u64))> = Vec::new();
    for triangle in triangles {
        for side in 0..3 {
            let from = bits(vertices[triangle[side] as usize]);
            let to = bits(vertices[triangle[(side + 1) % 3] as usize]);
            if directed.contains(&(from, to)) {
                return Err("a directed edge occurs twice".to_owned());
            }
            directed.push((from, to));
        }
    }
    let remaining: Vec<_> = directed
        .iter()
        .copied()
        .filter(|(from, to)| !directed.contains(&(*to, *from)))
        .collect();
    let mut boundary_edges = 0usize;
    for contour in boundary {
        let ring = contour_points(ranges, points, *contour);
        let edge = |index: usize| (bits(ring[index]), bits(ring[(index + 1) % ring.len()]));
        let forward = (0..ring.len()).all(|index| remaining.contains(&edge(index)));
        let backward = (0..ring.len()).all(|index| {
            let (from, to) = edge(index);
            remaining.contains(&(to, from))
        });
        if !(forward || backward) {
            return Err(format!("contour {contour} is not the cancelled boundary"));
        }
        boundary_edges += ring.len();
    }
    if remaining.len() != boundary_edges {
        return Err("the cancelled edges are not exactly the boundary".to_owned());
    }
    Ok(())
}

/// Runs one fixture through the production fast rung (FR1 to AL-FR9) and compares the outcome
/// with its literal expectation.
fn check_fixture(fixture: &Fixture) -> Result<(), String> {
    let mut fast = Box::new(FastRung::new());
    let mut scan = TestScan::new();
    fast.load(fixture.view.view(), DELTA, fixture.rule)
        .map_err(|reason| format!("{}: load failed with {reason:?}", fixture.id))?;
    match fixture.expected {
        Expected::Fallback(expected) => match fast.run(Stage::Fr9, &mut scan) {
            Err(reason) if reason == expected => Ok(()),
            other => Err(format!(
                "{}: expected {expected:?}, got {other:?}",
                fixture.id
            )),
        },
        Expected::Passes(stage) => fast
            .run(stage, &mut scan)
            .map_err(|reason| format!("{}: stage {stage:?} failed with {reason:?}", fixture.id)),
        Expected::Fast {
            area,
            boundary,
            triangles,
        } => {
            fast.run(Stage::Fr9, &mut scan)
                .map_err(|reason| format!("{}: expected fast, got {reason:?}", fixture.id))?;
            let mesh = fast
                .mesh()
                .ok_or_else(|| format!("{}: no mesh", fixture.id))?;
            check_mesh(
                &fixture.view.ranges,
                &fixture.view.points,
                mesh,
                boundary,
                area,
                true,
                triangles,
            )
            .map_err(|message| format!("{}: {message}", fixture.id))
        }
    }
}

#[test]
fn production_fixtures_match_their_literal_expectations() {
    let all = fixtures();
    assert_eq!(all.len(), 29, "27 spike entries plus AL-F3 and AL-F4");
    let failures: Vec<String> = all
        .iter()
        .filter_map(|fixture| check_fixture(fixture).err())
        .collect();
    assert!(failures.is_empty(), "fixture failures: {failures:#?}");
}

#[test]
fn sl_f21a_full_run_is_recorded() {
    // SL-F21 (a) asserts FR3 only. The full production run must publish or be `TRIANGLE`.
    let fixture = fixture("SL-F21a");
    let mut fast = Box::new(FastRung::new());
    let mut scan = TestScan::new();
    fast.load(fixture.view.view(), DELTA, fixture.rule).unwrap();
    let result = fast.run(Stage::Fr9, &mut scan);
    println!("SL-F21a full run: {result:?}");
    match result {
        Ok(()) => check_mesh(
            &fixture.view.ranges,
            &fixture.view.points,
            fast.mesh().expect("published mesh"),
            &[0],
            1.0,
            true,
            None,
        )
        .unwrap(),
        Err(reason) => assert_eq!(reason, Reason::Triangle),
    }
}

#[test]
fn stage_stops_return_after_their_stage_and_publish_only_after_al_fr9() {
    let mut fast = Box::new(FastRung::new());
    let mut scan = TestScan::new();
    let fixture = fixture("SL-F11");
    fast.load(fixture.view.view(), DELTA, fixture.rule).unwrap();
    assert_eq!(fast.run(Stage::S1, &mut scan), Ok(()));
    assert_eq!(fast.run(Stage::Fr1, &mut scan), Ok(()));
    assert_eq!(fast.run(Stage::Fr2, &mut scan), Err(Reason::Deviation));
    assert!(fast.mesh().is_none());
    let fixture = self::fixture("SL-F5/nonzero");
    fast.load(fixture.view.view(), DELTA, fixture.rule).unwrap();
    for stage in [
        Stage::Fr3,
        Stage::Fr4,
        Stage::Fr5,
        Stage::Fr6,
        Stage::Fr7,
        Stage::Fr8,
    ] {
        assert_eq!(fast.run(stage, &mut scan), Ok(()), "{stage:?}");
        assert!(fast.mesh().is_none(), "{stage:?} published");
    }
    assert_eq!(fast.run(Stage::Fr9, &mut scan), Ok(()));
    assert!(fast.mesh().is_some());
    assert_eq!(fast.boundary_contours(), &[true]);
    assert_eq!(fast.stats().diagonals, 0);
    assert_eq!(fast.stats().mesh_check_item, 0);
}

// ------------------------------------------------------------------------------------------
// Seeded defects (contract section 4.3): (1)-(10) as the spike, (11)-(13) for production.

fn assert_detected(defect: &str, ids: &[&str], run: impl Fn(&Fixture) -> Result<(), String>) {
    for id in ids {
        let fixture = fixture(id);
        check_fixture(&fixture)
            .unwrap_or_else(|message| panic!("{id} without {defect}: {message}"));
        let result = run(&fixture);
        assert!(result.is_err(), "defect {defect} not detected by {id}");
        println!("defect {defect}: {id} fails: {}", result.unwrap_err());
    }
}

fn under(which: LadderFault) -> impl Fn(&Fixture) -> Result<(), String> {
    move |fixture| with_ladder_faults(&[which], || check_fixture(fixture))
}

#[test]
fn al_defect_01_clearance_ge_without_r1_widening_is_detected() {
    assert_detected("(1)", &["SL-F3"], |fixture| {
        with_fault(Fault::R1WideningRemoved, || {
            with_ladder_faults(&[LadderFault::ClearanceGreaterEqual], || {
                check_fixture(fixture)
            })
        })
    });
}

#[test]
fn al_defect_02_knot_errors_omitted_is_detected() {
    assert_detected(
        "(2)",
        &["SL-F11", "SL-F19"],
        under(LadderFault::KnotErrorsOmitted),
    );
}

#[test]
fn al_defect_03_monotone_chords_only_is_detected() {
    assert_detected(
        "(3)",
        &["SL-F10", "SL-F10b"],
        under(LadderFault::MonotoneChordsOnly),
    );
    let mut supplementary = fixture("SL-F10b");
    supplementary.expected = Expected::Fast {
        area: 9.0 / 8.0,
        boundary: &[0, 1],
        triangles: Some(3),
    };
    with_ladder_faults(&[LadderFault::MonotoneChordsOnly], || {
        check_fixture(&supplementary)
    })
    .expect("SL-F10b is fast under defect (3)");
}

#[test]
fn al_defect_04_simplicity_only_is_detected() {
    assert_detected(
        "(4)",
        &["SL-F1", "SL-F3", "SL-F18"],
        under(LadderFault::SimplicityOnly),
    );
}

#[test]
fn al_defect_05_cone_inverted_is_detected() {
    assert_detected("(5)", &["SL-F12a"], under(LadderFault::ConeInverted));
}

#[test]
fn al_defect_06_nesting_from_orientation_is_detected() {
    assert_detected(
        "(6)",
        &["SL-F6/nonzero"],
        under(LadderFault::NestingFromOrientation),
    );
}

#[test]
fn al_defect_07_flipped_triangle_is_detected() {
    assert_detected(
        "(7)",
        &["SL-F5/nonzero"],
        under(LadderFault::TriangleFlipped),
    );
}

#[test]
fn al_defect_08_non_boundary_triangulated_is_detected() {
    assert_detected(
        "(8)",
        &["SL-F6/nonzero"],
        under(LadderFault::NonBoundaryTriangulated),
    );
}

#[test]
fn al_defect_09_scan_bound_without_radius_is_detected() {
    assert_detected(
        "(9)",
        &["SL-F3"],
        under(LadderFault::ScanBoundWithoutRadius),
    );
}

#[test]
fn al_defect_10_skip_two_apart_is_detected() {
    assert_detected("(10)", &["SL-F18"], under(LadderFault::SkipTwoApart));
}

#[test]
fn al_defect_11_al_m5_omitted_is_detected() {
    // AL-F3 is admitted past FR3 when AL-M5 is omitted.
    assert_detected("(11)", &["AL-F3"], under(LadderFault::AlM5Omitted));
    let fixture = fixture("AL-F3");
    let mut fast = Box::new(FastRung::new());
    let mut scan = TestScan::new();
    fast.load(fixture.view.view(), DELTA, fixture.rule).unwrap();
    with_ladder_faults(&[LadderFault::AlM5Omitted], || {
        assert_eq!(fast.run(Stage::Fr3, &mut scan), Ok(()));
        // The full run through AL-FR9 publishes AL-F3's mesh.
        assert_eq!(fast.run(Stage::Fr9, &mut scan), Ok(()));
    });
    assert!(fast.mesh().is_some(), "defect (11): AL-F3 published");
}

// ------------------------------------------------------------------------------------------
// Real paths.

#[derive(Clone)]
struct RealPath {
    name: String,
    verbs: Vec<u8>,
    point_bytes: Vec<u8>,
}

fn real_path(name: &str, verbs: Vec<u8>, scalars: &[f64]) -> RealPath {
    RealPath {
        name: name.to_owned(),
        verbs,
        point_bytes: scalars
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect(),
    }
}

fn request(rule: LineFillRule, exponent: i32) -> FillRequest {
    FillRequest {
        request_id: 0,
        rule,
        exponent,
    }
}

const SQUARE_10: [f64; 8] = [0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 10.0];

fn f01() -> RealPath {
    real_path("F01", vec![0, 1, 1, 1, 3], &SQUARE_10)
}

fn two_squares(name: &str, first: [f64; 8], second: [f64; 8]) -> RealPath {
    let scalars: Vec<f64> = first.iter().chain(second.iter()).copied().collect();
    real_path(name, vec![0, 1, 1, 1, 3, 0, 1, 1, 1, 3], &scalars)
}

fn rectangle(x0: f64, y0: f64, x1: f64, y1: f64) -> [f64; 8] {
    [x0, y0, x1, y0, x1, y1, x0, y1]
}

/// AL-F6: V2's simple curved path, the cubic (0, 0), (1, 2), (3, 2), (4, 0), closed.
fn al_f6() -> RealPath {
    real_path(
        "AL-F6",
        vec![0, 2, 3],
        &[0.0, 0.0, 1.0, 2.0, 3.0, 2.0, 4.0, 0.0],
    )
}

/// A one-contour circle of four cubics, radius 1024 at δ = 1/8: more than 64 leaves, so the
/// S1 prefix fails (`PREFIX`).
fn big_circle() -> RealPath {
    let (r, k) = (1024.0, 0.552_284_749_830_793_4 * 1024.0);
    real_path(
        "big-circle",
        vec![0, 2, 2, 2, 2, 3],
        &[
            r, 0.0, r, k, k, r, 0.0, r, -k, r, -r, k, -r, 0.0, -r, -k, -k, -r, 0.0, -r, k, -r, r,
            -k, r, 0.0,
        ],
    )
}

/// The two B0 fixture paths of `tests/geometry/p3-b0/fixtures.json` (SL-F13, AL-F9).
fn b0_fixture_paths() -> Vec<RealPath> {
    let source = include_str!("../../../../tests/geometry/p3-b0/fixtures.json");
    ["P4/s=4#0", "K2/s=3#0"]
        .iter()
        .map(|name| {
            let start = source.find(&format!("\"{name}\"")).expect("fixture entry");
            let entry = &source[start..];
            let entry = &entry[..entry.find('}').expect("fixture entry end")];
            let list = |key: &str| -> &str {
                let at = entry.find(&format!("\"{key}\"")).expect("fixture key");
                let open = at + entry[at..].find('[').expect("list start");
                let close = open + entry[open..].find(']').expect("list end");
                &entry[open + 1..close]
            };
            let verbs = list("verbs")
                .split(',')
                .map(|value| value.trim().parse().expect("verb byte"))
                .collect();
            let scalars: Vec<f64> = list("bits")
                .split(',')
                .map(|value| {
                    f64::from_bits(
                        u64::from_str_radix(value.trim().trim_matches('"'), 16).expect("hex"),
                    )
                })
                .collect();
            real_path(name, verbs, &scalars)
        })
        .collect()
}

/// The real paths of AL-F7 (one per reachable reason) and a few others.
fn small_real_paths() -> Vec<RealPath> {
    let mut paths = b0_fixture_paths();
    paths.push(f01());
    paths.push(two_squares("F02", SQUARE_10, rectangle(3.0, 3.0, 7.0, 7.0)));
    paths.push(two_squares("F04", SQUARE_10, SQUARE_10));
    paths.push(real_path(
        "F06",
        vec![0, 1, 1, 1, 3],
        &[0.0, 0.0, 4.0, 4.0, 0.0, 4.0, 4.0, 0.0],
    ));
    paths.push(two_squares(
        "F07",
        rectangle(0.0, 0.0, 2.0, 2.0),
        rectangle(2.0, 0.0, 4.0, 2.0),
    ));
    paths.push(two_squares(
        "SL-F3",
        rectangle(0.0, 0.0, 1.0, 1.0),
        rectangle(1.25, 0.0, 2.25, 1.0),
    ));
    paths.push(two_squares(
        "SL-F4",
        rectangle(0.0, 0.0, 1.0, 1.0),
        rectangle(1.25 + pow2(-20), 0.0, 2.25 + pow2(-20), 1.0),
    ));
    paths.push(real_path(
        "SL-F15",
        vec![0, 1, 1, 1, 3, 0, 1],
        &[
            0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 10.0, 20.0, 0.0, 21.0, 0.0,
        ],
    ));
    paths.push(al_f6());
    paths.push(big_circle());
    paths.push(real_path(
        "cubic-square",
        vec![0, 2, 2, 2, 2, 3],
        &[
            0.0, 0.0, 4.0, -1.0, 8.0, -1.0, 12.0, 0.0, 13.0, 4.0, 13.0, 8.0, 12.0, 12.0, 8.0, 13.0,
            4.0, 13.0, 0.0, 12.0, -1.0, 8.0, -1.0, 4.0, 0.0, 0.0,
        ],
    ));
    paths
}

fn find_path(name: &str) -> RealPath {
    small_real_paths()
        .into_iter()
        .find(|path| path.name == name)
        .unwrap_or_else(|| panic!("unknown path {name}"))
}

/// A path input exactly as `fill_export::build_path` builds it.
fn input<'a>(request: FillRequest, path: &'a RealPath) -> PathInput<'a> {
    PathInput::from_parts(
        Request {
            request_id: request.request_id,
            source_epoch: 0,
            source_revision: 0,
            tolerance: tolerances(request.exponent).0,
        },
        &path.verbs,
        &path.point_bytes,
    )
}

struct Harness {
    ladder: FillLadder,
    workspace: CubicFillWorkspace,
    scan: TestScan,
}

impl Harness {
    fn new() -> Self {
        Self {
            ladder: FillLadder::reserve(FILL_V0_LIMITS).expect("ladder"),
            workspace: CubicFillWorkspace::new(FILL_V0_LIMITS).expect("workspace"),
            scan: TestScan::new(),
        }
    }

    fn fast(
        &mut self,
        request: FillRequest,
        verbs: &[u8],
        point_bytes: &[u8],
    ) -> Result<(), Reason> {
        self.ladder.fast_rung(
            &mut self.workspace,
            request,
            verbs,
            point_bytes,
            &mut self.scan,
        )
    }

    fn run(&mut self, request: FillRequest, path: &RealPath) -> crate::fill_ladder::LadderOutcome {
        self.ladder.run(
            &mut self.workspace,
            request,
            &path.verbs,
            &path.point_bytes,
            &mut self.scan,
        )
    }

    /// The edges used once of the last fast mesh, as the scan derived them.
    fn boundary(&self) -> Vec<[u32; 2]> {
        self.scan.boundary.clone()
    }
}

/// Every observable part of an exact-rung workspace after a call: diagnostics, and when it
/// published, the polygon, owners and the mesh with its ledger counts, as bits.
fn exact_digest(workspace: &CubicFillWorkspace) -> String {
    let mut out = format!("{:?}", workspace.diagnostics());
    if let Some(output) = workspace.output() {
        let _ = write!(
            out,
            "|{:?}|{:?}|{:?}|{:?}",
            output.ranges,
            output.points.iter().copied().map(bits).collect::<Vec<_>>(),
            output.owners,
            output.sources
        );
        let _ = write!(
            out,
            "|{:?}|{:?}|{}|{}|{}",
            output
                .rounded
                .vertices
                .iter()
                .copied()
                .map(bits)
                .collect::<Vec<_>>(),
            output.rounded.indices,
            output.rounded.cells.len(),
            output.rounded.nodes.len(),
            output.rounded.boundaries.len()
        );
    }
    out
}

/// Module-level AL-I2 check (AL-F7): on a fallback, the ladder's exact result and the
/// workspace's published state equal the unchanged cascade on a fresh workspace, and no fast
/// mesh is left published.
fn assert_fallback_equals_exact_cascade(
    harness: &mut Harness,
    request: FillRequest,
    path: &RealPath,
    expected: Reason,
) -> ExactOutcome {
    let outcome = harness.run(request, path);
    assert_eq!(outcome.rung, Rung::Exact, "{}", path.name);
    assert_eq!(outcome.reason, Some(expected), "{}", path.name);
    assert!(harness.ladder.mesh().is_none(), "{}", path.name);
    let exact = outcome.exact.expect("exact result on fallback");
    let ladder_digest = exact_digest(&harness.workspace);
    let mut reference = CubicFillWorkspace::new(FILL_V0_LIMITS).expect("workspace");
    let direct = exact_cascade(&mut reference, request, &path.verbs, &path.point_bytes);
    assert_eq!(exact, direct, "{}", path.name);
    assert_eq!(ladder_digest, exact_digest(&reference), "{}", path.name);
    exact
}

#[test]
fn defect_12_and_al_f1_range_outside_the_fast_exponents() {
    let mut harness = Harness::new();
    let path = f01();
    for exponent in [MAX_FAST_EXPONENT + 1, MIN_FAST_EXPONENT - 1] {
        assert_eq!(exponent.abs(), if exponent > 0 { 511 } else { 512 });
        assert_fallback_equals_exact_cascade(
            &mut harness,
            request(LineFillRule::Nonzero, exponent),
            &path,
            Reason::Range,
        );
    }
    // Defect (12): without AL-FR0, e = 511 returns another reason.
    let request = request(LineFillRule::Nonzero, 511);
    let omitted = with_ladder_faults(&[LadderFault::RangeOmitted], || {
        harness.fast(request, &path.verbs, &path.point_bytes)
    });
    println!("defect (12): AL-F1 at e = 511 returns {omitted:?}");
    assert!(omitted.is_err() && omitted != Err(Reason::Range));
}

#[test]
fn al_f2_range_ends_are_admitted() {
    let mut harness = Harness::new();
    let path = f01();
    // e = 510: the range admits it, and opposite edges 10 apart are not more than 2δ apart.
    assert_fallback_equals_exact_cascade(
        &mut harness,
        request(LineFillRule::Nonzero, 510),
        &path,
        Reason::Clearance,
    );
    // e = −511: fast, area 100.
    assert_eq!(
        harness.fast(
            request(LineFillRule::Nonzero, -511),
            &path.verbs,
            &path.point_bytes
        ),
        Ok(())
    );
    let (vertices, triangles) = harness.ladder.mesh().expect("fast mesh");
    assert_eq!(signed_area(vertices, triangles), 100.0);
}

#[test]
fn al_f5_line_only_square_is_fast_with_the_four_directed_edges() {
    let mut harness = Harness::new();
    let path = f01();
    for rule in [LineFillRule::Nonzero, LineFillRule::Evenodd] {
        let outcome = harness.run(request(rule, B0_EXPONENT), &path);
        assert_eq!(outcome.rung, Rung::Fast);
        assert_eq!(outcome.exact, None);
        let (vertices, triangles) = harness.ladder.mesh().expect("fast mesh");
        assert_eq!(signed_area(vertices, triangles), 100.0);
        let expected: Vec<(u64, u64)> = SQUARE_10
            .chunks_exact(2)
            .map(|pair| bits(p(pair[0], pair[1])))
            .collect();
        assert_eq!(
            vertices.iter().copied().map(bits).collect::<Vec<_>>(),
            expected,
            "positions are the S1 polygon in contour order"
        );
        let mut boundary = harness.boundary();
        boundary.sort_unstable();
        assert_eq!(boundary, vec![[0, 1], [1, 2], [2, 3], [3, 0]]);
    }
}

#[test]
fn al_f6_simple_curve_is_monotone_and_legacy_admits_it() {
    let mut harness = Harness::new();
    let path = al_f6();
    let exact = assert_fallback_equals_exact_cascade(
        &mut harness,
        request(LineFillRule::Nonzero, B0_EXPONENT),
        &path,
        Reason::Monotone,
    );
    assert_eq!(exact.step, ExactStep::Legacy);
    let diagnostics = exact.result.expect("Legacy admits AL-F6");
    assert!(diagnostics.topology_invoked);
    assert!(!diagnostics.transverse_topology_invoked);
    assert!(harness.workspace.output().is_some());
}

#[test]
fn al_f7_real_inputs_reach_their_reasons_and_fall_back_to_the_exact_cascade() {
    let mut harness = Harness::new();
    let nonzero = LineFillRule::Nonzero;
    // RANGE (AL-F1) has its own test; CLOSURE is a B0 corpus path (ignored corpus test);
    // DEVIATION and TRIANGLE are module-level only (SL-F11, SL-F19; AL-F10).
    for (name, expected) in [
        ("big-circle", Reason::Prefix),
        ("SL-F15", Reason::Structure),
        ("AL-F6", Reason::Monotone),
        ("F06", Reason::Monotone),
        ("F04", Reason::Crossing),
        ("F07", Reason::Crossing),
        ("SL-F3", Reason::Clearance),
    ] {
        let path = find_path(name);
        let exact = assert_fallback_equals_exact_cascade(
            &mut harness,
            request(nonzero, B0_EXPONENT),
            &path,
            expected,
        );
        println!(
            "AL-F7 {name}: {expected:?}, exact {:?}",
            exact.result.map(|_| ())
        );
    }
}

#[test]
fn al_f8_flipped_triangle_is_mesh_check_item_1_then_exact() {
    let mut harness = Harness::new();
    let path = f01();
    let request = request(LineFillRule::Nonzero, B0_EXPONENT);
    with_ladder_faults(&[LadderFault::TriangleFlipped], || {
        assert_fallback_equals_exact_cascade(&mut harness, request, &path, Reason::MeshCheck);
    });
    assert_eq!(harness.ladder.fast().stats().mesh_check_item, 1);
}

#[test]
fn al_f8b_and_defect_13_mesh_check_item_3_then_exact() {
    let mut harness = Harness::new();
    let request = request(LineFillRule::Nonzero, B0_EXPONENT);
    for (variant, path) in [
        (LadderFault::TriangleDropped, f01()),
        (LadderFault::VertexSubstituted, find_path("SL-F4")),
    ] {
        // Without the fault the path is fast.
        assert_eq!(
            harness.fast(request, &path.verbs, &path.point_bytes),
            Ok(()),
            "{variant:?}"
        );
        let clean = harness.ladder.mesh().map(|(_, t)| t.to_vec()).unwrap();
        // AL-F8b: items 1 and 2 pass, item 3 rejects, the exact rung's result follows.
        with_ladder_faults(&[variant], || {
            assert_fallback_equals_exact_cascade(&mut harness, request, &path, Reason::MeshCheck);
        });
        assert_eq!(
            harness.ladder.fast().stats().mesh_check_item,
            3,
            "{variant:?}"
        );
        // Defect (13): with item 3 disabled the faulty mesh is published.
        let published = with_ladder_faults(&[variant, LadderFault::MeshCheckItem3Disabled], || {
            harness.fast(request, &path.verbs, &path.point_bytes)
        });
        assert_eq!(published, Ok(()), "defect (13) not shown by {variant:?}");
        let faulty = harness.ladder.mesh().map(|(_, t)| t.to_vec()).unwrap();
        assert_ne!(faulty, clean, "{variant:?} changed nothing");
        println!(
            "defect (13): {variant:?} on {} is published: {} triangles, {} once-used edges",
            path.name,
            faulty.len(),
            harness.boundary().len()
        );
    }
}

#[test]
fn al_f9_b0_fixture_paths_are_fast_and_the_exact_rung_admits_them() {
    let mut harness = Harness::new();
    for path in b0_fixture_paths() {
        let request = request(LineFillRule::Nonzero, B0_EXPONENT);
        assert_eq!(
            harness.fast(request, &path.verbs, &path.point_bytes),
            Ok(()),
            "{}",
            path.name
        );
        let view = {
            let mut workspace = CubicFillWorkspace::new(FILL_V0_LIMITS).expect("workspace");
            let view = workspace
                .prepare_prefix(input(request, &path), MAX_FLAT_COMMANDS)
                .expect("prefix");
            (view.ranges.to_vec(), view.points.to_vec())
        };
        let boundary: Vec<usize> = (0..view.0.len()).collect();
        let area: f64 = boundary
            .iter()
            .map(|contour| {
                let ring = contour_points(&view.0, &view.1, *contour);
                let mut twice = 0.0;
                for index in 0..ring.len() {
                    let (a, b) = (ring[index], ring[(index + 1) % ring.len()]);
                    twice += a.x * b.y - a.y * b.x;
                }
                (twice / 2.0).abs()
            })
            .sum();
        check_mesh(
            &view.0,
            &view.1,
            harness.ladder.mesh().expect("fast mesh"),
            &boundary,
            area,
            false,
            None,
        )
        .unwrap_or_else(|message| panic!("{}: {message}", path.name));
        let mut exact = CubicFillWorkspace::new(FILL_V0_LIMITS).expect("workspace");
        let outcome = exact_cascade(&mut exact, request, &path.verbs, &path.point_bytes);
        assert!(outcome.result.is_ok(), "{}: {outcome:?}", path.name);
        assert!(exact.output().is_some(), "{}", path.name);
    }
}

#[test]
fn al_f10_triangle_is_covered_by_its_fault_variant() {
    // No real or synthetic input that passes FR1-FR6 was found to reach `TRIANGLE` (see the
    // plan's AL-U1 entry), so AL-F10 is the contract's `cfg(test)` fault variant.
    let fixture = fixture("SL-F5/nonzero");
    check_fixture(&fixture).unwrap();
    let mut fast = Box::new(FastRung::new());
    let mut scan = TestScan::new();
    fast.load(fixture.view.view(), DELTA, fixture.rule).unwrap();
    let result = with_ladder_faults(&[LadderFault::Fr7OrientationRejected], || {
        fast.run(Stage::Fr9, &mut scan)
    });
    assert_eq!(result, Err(Reason::Triangle));
    assert!(fast.mesh().is_none());
}

// ------------------------------------------------------------------------------------------
// S1 prefix identity, reserve-time storage and allocation.

#[test]
fn production_prefix_equals_the_spike_accessor() {
    // The non-test prefix method runs the statements of `attempt_body` up to S1; its view and
    // its failures equal the spike's `cfg(test)` accessor bit for bit.
    let mut production = CubicFillWorkspace::new(LIMITS).expect("workspace");
    let mut spike = CubicFillWorkspace::new(LIMITS).expect("workspace");
    let mut checked = 0usize;
    for path in small_real_paths() {
        for exponent in [B0_EXPONENT, -36, 34] {
            let input = input(request(LineFillRule::Nonzero, exponent), &path);
            let left = production.prepare_prefix(input, MAX_FLAT_COMMANDS);
            let right = spike.prepare_for_spike(input, MAX_FLAT_COMMANDS);
            match (left, right) {
                (Ok(a), Ok(b)) => {
                    assert_eq!(a.commands, b.commands, "{}", path.name);
                    assert_eq!(a.ranges, b.ranges, "{}", path.name);
                    assert_eq!(
                        a.points.iter().copied().map(bits).collect::<Vec<_>>(),
                        b.points.iter().copied().map(bits).collect::<Vec<_>>(),
                        "{}",
                        path.name
                    );
                    assert_eq!(a.owners, b.owners, "{}", path.name);
                    assert_eq!(a.sources, b.sources, "{}", path.name);
                }
                (Err(PrefixFailure::Sizing(a)), Err(p3_b0_spike::PrefixFailure::Sizing(b))) => {
                    assert_eq!(a, b, "{}", path.name);
                }
                (Err(PrefixFailure::Error(a)), Err(p3_b0_spike::PrefixFailure::Error(b))) => {
                    assert_eq!(a, b, "{}", path.name);
                }
                (left, right) => panic!("{}: {left:?} against {right:?}", path.name),
            }
            assert_eq!(
                production.diagnostics(),
                spike.diagnostics(),
                "{}",
                path.name
            );
            checked += 1;
        }
    }
    assert_eq!(checked, 3 * small_real_paths().len());
}

#[test]
fn ladder_storage_is_reserved_once_and_checked_against_the_fill_scratch() {
    let ladder = FillLadder::reserve(FILL_V0_LIMITS).expect("ladder");
    assert_eq!(ladder.allocated_bytes(), core::mem::size_of::<FastRung>());
    println!(
        "FastRung {} bytes; MAX_TRIANGLES boundary records {MAX_BOUNDARY_RECORDS}",
        ladder.allocated_bytes()
    );
    // V2 section a: 3 · (256 + 2 · 256) records, far above the fast mesh's.
    const { assert!(MAX_BOUNDARY_RECORDS <= 3 * (256 + 2 * 256)) };
    let tiny = crate::rounded_line_fill::RoundedFillLimits {
        max_triangles: 1,
        max_vertices: 1,
        ..FILL_V0_LIMITS
    };
    assert_eq!(FillLadder::reserve(tiny).err(), Some(BATCH_INTERNAL_ERROR));
}

/// The debug sample of AL-I3 and AL-A6: the real paths at e = −3, plus generated generic-
/// coordinate rings at three exponents (e = −3, and −36 and 34 as in `p3-b0r-random/v1`),
/// one or two contours, both rules.
fn sample_cases() -> Vec<(String, FillRequest, RealPath)> {
    let mut cases: Vec<(String, FillRequest, RealPath)> = small_real_paths()
        .into_iter()
        .map(|path| {
            (
                path.name.clone(),
                request(LineFillRule::Nonzero, B0_EXPONENT),
                path,
            )
        })
        .collect();
    let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut uniform = move || {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (state >> 11) as f64 / pow2(53)
    };
    let kappa = 0.552_284_749_830_793_4;
    for exponent in [B0_EXPONENT, -36, 34] {
        let scale = pow2(exponent + 3);
        for index in 0..10 {
            let rule = if index % 2 == 0 {
                LineFillRule::Nonzero
            } else {
                LineFillRule::Evenodd
            };
            let mut verbs = Vec::new();
            let mut scalars = Vec::new();
            for contour in 0..1 + index % 2 {
                let cx = (20.0 * contour as f64 + 5.0 + uniform()) * scale;
                let cy = (5.0 + uniform()) * scale;
                let r = (2.0 + uniform()) * scale;
                let k = kappa * r;
                verbs.extend([0, 2, 2, 2, 2, 3]);
                scalars.extend([
                    cx + r,
                    cy,
                    cx + r,
                    cy + k,
                    cx + k,
                    cy + r,
                    cx,
                    cy + r,
                    cx - k,
                    cy + r,
                    cx - r,
                    cy + k,
                    cx - r,
                    cy,
                    cx - r,
                    cy - k,
                    cx - k,
                    cy - r,
                    cx,
                    cy - r,
                    cx + k,
                    cy - r,
                    cx + r,
                    cy - k,
                    cx + r,
                    cy,
                ]);
            }
            let name = format!("ring/e={exponent}/{index}");
            cases.push((
                name.clone(),
                request(rule, exponent),
                real_path(&name, verbs, &scalars),
            ));
        }
    }
    cases
}

#[test]
fn rung_zero_allocates_nothing_on_the_debug_sample() {
    let mut harness = Harness::new();
    let mut allocating = Vec::new();
    for (name, request, path) in sample_cases() {
        crate::allocation_test_support::start();
        let _ = harness.fast(request, &path.verbs, &path.point_bytes);
        if crate::allocation_test_support::stop() != 0 {
            allocating.push(name);
        }
    }
    assert!(
        allocating.is_empty(),
        "allocating rung-0 calls: {allocating:?}"
    );
}

// ------------------------------------------------------------------------------------------
// AL-I3: the production rung 0 against the frozen spike module (contract section 4.4).

#[derive(Default)]
struct Differential {
    paths: usize,
    identical_fast: usize,
    identical_fallback: usize,
    range: Vec<String>,
    closure: Vec<String>,
    failures: Vec<String>,
    reasons: [usize; Reason::ALL.len() + 1],
    allocating: usize,
    first_closure: Vec<String>,
    prefix: Vec<String>,
}

impl Differential {
    fn summary(&self, label: &str) -> String {
        let mut line = format!(
            "AL-I3 {label}: {} paths; identical {} (fast {}, fallback {}); allowed RANGE {}, allowed AL-M5 CLOSURE {}; failures {}; allocating rung-0 calls {}; rung 0 fast {}",
            self.paths,
            self.identical_fast + self.identical_fallback,
            self.identical_fast,
            self.identical_fallback,
            self.range.len(),
            self.closure.len(),
            self.failures.len(),
            self.allocating,
            self.reasons[0]
        );
        for (index, reason) in Reason::ALL.iter().enumerate() {
            if self.reasons[index + 1] > 0 {
                let _ = write!(line, " {} {}", reason.code(), self.reasons[index + 1]);
            }
        }
        line
    }
}

type OwnedMesh = (Vec<(u64, u64)>, Vec<[u32; 3]>);

fn owned_mesh(mesh: Option<(&[Point], &[[u32; 3]])>) -> Option<OwnedMesh> {
    mesh.map(|(vertices, triangles)| {
        (
            vertices.iter().copied().map(bits).collect(),
            triangles.to_vec(),
        )
    })
}

/// The spike's rung 0 on one path at the path's own δ, stopped after `stop`.
fn spike_rung(
    spike: &mut p3_b0_spike::FastRung,
    workspace: &mut CubicFillWorkspace,
    request: FillRequest,
    path: &RealPath,
    stop: p3_b0_spike::Stage,
) -> Result<(), &'static str> {
    let input = input(request, path);
    match workspace.prepare_for_spike(input, MAX_FLAT_COMMANDS) {
        Ok(view) => spike
            .load(view, input.request.tolerance, request.rule)
            .and_then(|()| spike.run(stop))
            .map_err(p3_b0_spike::Reason::code),
        Err(_) => Err("PREFIX"),
    }
}

struct DifferentialRunner {
    harness: Harness,
    spike: Box<p3_b0_spike::FastRung>,
    spike_workspace: CubicFillWorkspace,
    result: Differential,
}

impl DifferentialRunner {
    fn new() -> Self {
        Self {
            harness: Harness::new(),
            spike: Box::new(p3_b0_spike::FastRung::new()),
            spike_workspace: CubicFillWorkspace::new(FILL_V0_LIMITS).expect("workspace"),
            result: Differential::default(),
        }
    }

    fn case(&mut self, name: &str, request: FillRequest, path: &RealPath) {
        self.result.paths += 1;
        crate::allocation_test_support::start();
        let production = self.harness.fast(request, &path.verbs, &path.point_bytes);
        if crate::allocation_test_support::stop() != 0 {
            self.result.allocating += 1;
        }
        let production_mesh = owned_mesh(self.harness.ladder.mesh());
        let slot = match production {
            Ok(()) => 0,
            Err(reason) => 1 + Reason::ALL.iter().position(|r| *r == reason).unwrap(),
        };
        self.result.reasons[slot] += 1;
        let spike = spike_rung(
            &mut self.spike,
            &mut self.spike_workspace,
            request,
            path,
            p3_b0_spike::Stage::Fr8,
        );
        let spike_mesh = owned_mesh(self.spike.mesh());
        if spike == Err("CLOSURE")
            && name.starts_with("b0/O1/")
            && self.result.first_closure.len() < 3
        {
            self.result.first_closure.push(name.to_owned());
        }
        if spike == Err("PREFIX")
            && name.starts_with("b0/O1/P4/s=16")
            && self.result.prefix.len() < 3
        {
            self.result.prefix.push(name.to_owned());
        }
        let in_range = (MIN_FAST_EXPONENT..=MAX_FAST_EXPONENT).contains(&request.exponent);
        match (production, spike) {
            (Ok(()), Ok(())) if production_mesh == spike_mesh && production_mesh.is_some() => {
                self.result.identical_fast += 1;
            }
            (Err(left), Err(right)) if left.code() == right => {
                self.result.identical_fallback += 1;
            }
            (Err(Reason::Range), _) if !in_range => self.result.range.push(name.to_owned()),
            (Err(Reason::Closure), spike) => {
                let passes_fr3 = spike_rung(
                    &mut self.spike,
                    &mut self.spike_workspace,
                    request,
                    path,
                    p3_b0_spike::Stage::Fr3,
                )
                .is_ok();
                if passes_fr3 {
                    self.result
                        .closure
                        .push(format!("{name} (spike {spike:?})"));
                } else {
                    self.result
                        .failures
                        .push(format!("{name}: CLOSURE against spike {spike:?}"));
                }
            }
            (left, right) => self.result.failures.push(format!(
                "{name}: production {left:?} against spike {right:?}"
            )),
        }
    }
}

#[test]
fn al_i3_fixtures_and_debug_sample_equal_the_spike() {
    // Fixtures: both modules' rung 0 on the same synthetic view at δ = 1/8.
    let mut scan = TestScan::new();
    let mut production = Box::new(FastRung::new());
    let mut spike = Box::new(p3_b0_spike::FastRung::new());
    let mut closure = Vec::new();
    for fixture in fixtures() {
        let left = production
            .load(fixture.view.view(), DELTA, fixture.rule)
            .and_then(|()| production.run(Stage::Fr9, &mut scan))
            .map_err(Reason::code);
        let right = spike
            .load(fixture.view.spike_view(), DELTA, fixture.rule)
            .and_then(|()| spike.run(p3_b0_spike::Stage::Fr8))
            .map_err(p3_b0_spike::Reason::code);
        if left == right {
            assert_eq!(
                owned_mesh(production.mesh()),
                owned_mesh(spike.mesh()),
                "{}",
                fixture.id
            );
            continue;
        }
        // The only allowed fixture difference: an AL-M5 CLOSURE where the spike passes FR3.
        assert_eq!(
            left,
            Err("CLOSURE"),
            "{}: {left:?} against {right:?}",
            fixture.id
        );
        spike
            .load(fixture.view.spike_view(), DELTA, fixture.rule)
            .unwrap();
        assert_eq!(spike.run(p3_b0_spike::Stage::Fr3), Ok(()), "{}", fixture.id);
        closure.push(fixture.id);
    }
    assert_eq!(closure, vec!["AL-F3"], "AL-M5 differences on the fixtures");
    // Real paths and the generated sample.
    let mut runner = DifferentialRunner::new();
    for (name, request, path) in sample_cases() {
        runner.case(&name, request, &path);
    }
    println!("{}", runner.result.summary("debug sample"));
    assert!(
        runner.result.failures.is_empty(),
        "{:#?}",
        runner.result.failures
    );
    assert_eq!(runner.result.allocating, 0);
    assert!(runner.result.identical_fast > 0);
    assert_eq!(runner.result.reasons[Reason::ALL.len()], 0, "MESH_CHECK");
}

// ------------------------------------------------------------------------------------------
// Ignored release tests over the B0 framed corpus and `p3-b0r-random/v1`.

fn random_corpus(bytes: &[u8]) -> Vec<(String, FillRequest, RealPath)> {
    let mut reader = crate::p3_b0_bench::Reader { bytes, offset: 0 };
    assert_eq!(reader.take(8), b"P3BRRND1", "randomized corpus magic");
    let families = reader.u32();
    let mut cases = Vec::new();
    for _ in 0..families {
        let length = reader.u32();
        let id = String::from_utf8(reader.take(length).to_vec()).expect("family id");
        let _entry = reader.u8();
        let count = reader.u32();
        for index in 0..count {
            let rule = match reader.u8() {
                0 => LineFillRule::Nonzero,
                1 => LineFillRule::Evenodd,
                other => panic!("unknown fill rule {other}"),
            };
            let exponent = i32::from_le_bytes(reader.take(4).try_into().expect("exponent width"));
            let verb_count = reader.u32();
            let verbs = reader.take(verb_count).to_vec();
            let scalar_count = reader.u32();
            let point_bytes = reader.take(scalar_count * 8).to_vec();
            let name = format!("rnd/{id}/{index}");
            cases.push((
                name.clone(),
                request(rule, exponent),
                RealPath {
                    name,
                    verbs,
                    point_bytes,
                },
            ));
        }
    }
    assert_eq!(reader.offset, bytes.len(), "trailing corpus bytes");
    cases
}

fn b0_corpus() -> Vec<(String, FillRequest, RealPath)> {
    let path = env::var("P3_B0R_B0_CORPUS").expect("P3_B0R_B0_CORPUS is required");
    let mut cases = Vec::new();
    for cell in crate::p3_b0_bench::read_corpus(&path) {
        for (index, corpus_path) in cell.paths.iter().enumerate() {
            let name = format!("b0/{}#{index}", cell.id);
            cases.push((
                name.clone(),
                request(LineFillRule::Nonzero, B0_EXPONENT),
                RealPath {
                    name,
                    verbs: corpus_path.verbs.clone(),
                    point_bytes: corpus_path.point_bytes.clone(),
                },
            ));
        }
    }
    cases
}

/// AL-A5 and AL-A6 on the full corpora, and the AL-F7 `TRIANGLE` count: AL-I3 over every B0
/// path (decision, O1 and X, at e = −3) and the randomized corpus `p3-b0r-random/v1`; zero
/// allocations inside every rung-0 call; and the count of `TRIANGLE` outcomes. The fixtures
/// run only in the debug test `al_i3_fixtures_and_debug_sample_equal_the_spike`.
#[test]
#[ignore = "AL-I3 full corpus; needs P3_B0R_B0_CORPUS and P3_B0R_RANDOM_CORPUS; release profile"]
fn al_i3_full_corpus_equals_the_spike_and_allocates_nothing() {
    let mut b0 = DifferentialRunner::new();
    for (name, request, path) in b0_corpus() {
        b0.case(&name, request, &path);
    }
    println!("{}", b0.result.summary("B0 framed corpus"));
    println!("AL-M5 differences (B0): {:#?}", b0.result.closure);
    println!(
        "first O1 CLOSURE paths (spike): {:?}",
        b0.result.first_closure
    );
    println!(
        "first O1/P4/s=16 PREFIX paths (spike): {:?}",
        b0.result.prefix
    );
    let random_bytes = {
        let path = env::var("P3_B0R_RANDOM_CORPUS").expect("P3_B0R_RANDOM_CORPUS is required");
        std::fs::read(path).expect("read the randomized corpus")
    };
    let mut random = DifferentialRunner::new();
    for (name, request, path) in random_corpus(&random_bytes) {
        random.case(&name, request, &path);
    }
    println!("{}", random.result.summary("p3-b0r-random/v1"));
    println!("AL-M5 differences (random): {:#?}", random.result.closure);
    for runner in [&b0, &random] {
        assert!(
            runner.result.failures.is_empty(),
            "{:#?}",
            runner.result.failures
        );
        assert!(
            runner.result.range.is_empty(),
            "every corpus exponent is in range"
        );
        assert_eq!(runner.result.allocating, 0, "allocating rung-0 calls");
        assert_eq!(runner.result.reasons[Reason::ALL.len()], 0, "MESH_CHECK");
    }
    println!(
        "AL-F7 TRIANGLE search: B0 {} and randomized {} rung-0 TRIANGLE outcomes",
        b0.result.reasons[1 + Reason::ALL
            .iter()
            .position(|r| *r == Reason::Triangle)
            .unwrap()],
        random.result.reasons[1 + Reason::ALL
            .iter()
            .position(|r| *r == Reason::Triangle)
            .unwrap()]
    );
}

/// AL-F7's corpus inputs, named by cell and index: `CLOSURE`, an O1 path of the spike record's
/// 73 (the first in corpus order, `O1/P2/s=3#0`), and `PREFIX`, an O1/P4/s=16 path of more than
/// 64 leaves (the first, `O1/P4/s=16#0`), whose exact rung fails with `OwnerLimit`. Each falls
/// back to the unchanged cascade (module-level AL-I2).
#[test]
#[ignore = "AL-F7 corpus inputs; needs P3_B0R_B0_CORPUS; release profile"]
fn al_f7_b0_corpus_closure_and_prefix_inputs() {
    let cases = b0_corpus();
    let mut harness = Harness::new();
    for (name, expected) in [
        ("b0/O1/P2/s=3#0", Reason::Closure),
        ("b0/O1/P4/s=16#0", Reason::Prefix),
    ] {
        let (_, request, path) = cases
            .iter()
            .find(|(case, _, _)| case == name)
            .unwrap_or_else(|| panic!("no corpus path {name}"));
        let exact = assert_fallback_equals_exact_cascade(&mut harness, *request, path, expected);
        println!(
            "AL-F7 {name}: {expected:?}, exact {:?}",
            exact.result.map(|_| ())
        );
        if expected == Reason::Prefix {
            assert_eq!(
                exact.result.map(|_| ()),
                Err(crate::cubic_fill::CubicFillError::OwnerLimit)
            );
        }
    }
}

// ------------------------------------------------------------------------------------------
// The AL-F7 `TRIANGLE` search on synthetic real line paths (contract section 4.3).

/// A star-shaped ring of `count` distinct integer points in the square of half-width `radius`
/// around `centre`, sorted by angle; exactly collinear triples are frequent on so small a grid.
fn search_star(
    next: &mut dyn FnMut(u64) -> u64,
    centre: (i64, i64),
    radius: i64,
    count: usize,
) -> Vec<(i64, i64)> {
    let mut points: Vec<(i64, i64)> = Vec::new();
    while points.len() < count {
        let x = centre.0 - radius + next((2 * radius + 1) as u64) as i64;
        let y = centre.1 - radius + next((2 * radius + 1) as u64) as i64;
        if (x, y) != centre && !points.contains(&(x, y)) {
            points.push((x, y));
        }
    }
    let angle =
        |point: &(i64, i64)| ((point.1 - centre.1) as f64).atan2((point.0 - centre.0) as f64);
    points.sort_by(|a, b| angle(a).total_cmp(&angle(b)));
    points
}

/// One search input of family `trial % 4`: (0) a star ring; (1) a star ring with a hole or a
/// disjoint second ring; (2) an orthogonal histogram with collinear points inserted on its
/// edges, optionally transposed, optionally with a disjoint rectangle carrying a collinear
/// point; (3) a jittered integer circle ring with collinear midpoints, optionally with a hole.
fn search_contours(next: &mut dyn FnMut(u64) -> u64, trial: u64) -> Vec<Vec<(i64, i64)>> {
    match trial % 4 {
        0 => {
            let count = 4 + next(7) as usize;
            vec![search_star(next, (8, 8), 8, count)]
        }
        1 => {
            let count = 4 + next(7) as usize;
            let outer = search_star(next, (8, 8), 8, count);
            let second = if next(2) == 0 {
                let count = 3 + next(3) as usize;
                search_star(next, (8, 8), 2, count)
            } else {
                let count = 3 + next(4) as usize;
                search_star(next, (30, 8), 8, count)
            };
            vec![outer, second]
        }
        2 => {
            let columns = 2 + next(6) as i64;
            let mut top = Vec::new();
            let mut x = 0i64;
            for _ in 0..columns {
                let height = 2 + next(6) as i64;
                let width = 1 + next(3) as i64;
                top.push((x, height));
                if next(2) == 0 && width > 1 {
                    top.push((x + 1, height));
                }
                top.push((x + width, height));
                x += width;
            }
            let mut ring = vec![(0i64, 0i64)];
            if next(2) == 0 && x > 1 {
                ring.push((1, 0));
            }
            ring.push((x, 0));
            ring.extend(top.iter().rev());
            ring.dedup();
            if ring.last() == ring.first() {
                ring.pop();
            }
            if next(2) == 0 {
                ring.iter_mut()
                    .for_each(|point| *point = (point.1, point.0));
                ring.reverse();
            }
            let mut contours = vec![ring];
            if next(3) == 0 {
                contours.push(vec![(30, 1), (33, 1), (33, 4), (32, 4), (30, 4)]);
            }
            contours
        }
        _ => {
            let count = 8 + next(12) as usize;
            let mut ring: Vec<(i64, i64)> = Vec::new();
            for index in 0..count {
                let turn = (index as f64 + 0.3 * (next(100) as f64 / 100.0)) / count as f64;
                let angle = core::f64::consts::TAU * turn;
                let radius = 20.0 + next(6) as f64;
                let point = (
                    (radius * angle.cos()).round() as i64,
                    (radius * angle.sin()).round() as i64,
                );
                if ring.last() != Some(&point) && ring.first() != Some(&point) {
                    ring.push(point);
                }
            }
            let mut with_midpoints = Vec::new();
            for index in 0..ring.len() {
                let (a, b) = (ring[index], ring[(index + 1) % ring.len()]);
                with_midpoints.push(a);
                if (a.0 + b.0) % 2 == 0 && (a.1 + b.1) % 2 == 0 && next(2) == 0 {
                    with_midpoints.push(((a.0 + b.0) / 2, (a.1 + b.1) / 2));
                }
            }
            let mut contours = vec![with_midpoints];
            if next(2) == 0 {
                let count = 3 + next(4) as usize;
                contours.push(search_star(next, (0, 0), 5, count));
            }
            contours
        }
    }
}

/// AL-F7's search for a real export input that reaches `TRIANGLE`: 400,000 seeded synthetic
/// line paths (integer coordinates scaled by 4, e = −3, both rules) whose exactly collinear
/// vertex chains and merge/split vertices exercise FR7's degenerate branches. It reports the
/// reason counts per family and the first `TRIANGLE` inputs, and asserts only that AL-FR9
/// never fires (`MESH_CHECK` 0). The finding is recorded in the plan's AL-U1 entry.
#[test]
#[ignore = "AL-F7 TRIANGLE search; release profile"]
fn al_f7_triangle_search_on_synthetic_line_paths() {
    let mut harness = Harness::new();
    let mut state: u64 = 0x2545_f491_4f6c_dd1d;
    let mut next = move |bound: u64| {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state % bound
    };
    let mut counts = [[0usize; Reason::ALL.len() + 1]; 4];
    let mut found = Vec::new();
    for trial in 0..400_000u64 {
        let contours = search_contours(&mut next, trial);
        let mut verbs = Vec::new();
        let mut scalars = Vec::new();
        for contour in &contours {
            for (index, (x, y)) in contour.iter().enumerate() {
                verbs.push(if index == 0 { 0 } else { 1 });
                scalars.extend([*x as f64 * 4.0, *y as f64 * 4.0]);
            }
            verbs.push(3);
        }
        let path = real_path("search", verbs, &scalars);
        for rule in [LineFillRule::Nonzero, LineFillRule::Evenodd] {
            let result = harness.fast(request(rule, B0_EXPONENT), &path.verbs, &path.point_bytes);
            let slot = match result {
                Ok(()) => 0,
                Err(reason) => 1 + Reason::ALL.iter().position(|r| *r == reason).unwrap(),
            };
            counts[(trial % 4) as usize][slot] += 1;
            if result == Err(Reason::Triangle) && found.len() < 5 {
                found.push(format!("{rule:?} {contours:?}"));
            }
        }
    }
    for (family, family_counts) in counts.iter().enumerate() {
        let reasons: Vec<(&str, usize)> = Reason::ALL
            .iter()
            .map(|reason| reason.code())
            .zip(family_counts[1..].iter().copied())
            .filter(|(_, count)| *count > 0)
            .collect();
        println!(
            "AL-F7 TRIANGLE search family {family}: fast {} {reasons:?}",
            family_counts[0]
        );
    }
    println!("AL-F7 TRIANGLE search: first TRIANGLE inputs {found:#?}");
    assert!(
        counts.iter().all(|family| family[Reason::ALL.len()] == 0),
        "MESH_CHECK"
    );
}

// ------------------------------------------------------------------------------------------
// AL-U4b1 (contract section 5.1, AL-C2 with AL-C1): the prefix-shared subdivision of FR2 is
// bit-identical to the spike's per-leaf `restrict`, kept here as a statement-for-statement
// copy of the AL-U3 code (`fill_ladder.rs` at 4f48284), on many cubics, depths and leaf orders.

/// The AL-U3 `IPoint`, restricted to the operations of `restrict`.
#[derive(Clone, Copy)]
struct OldIPoint {
    x: crate::fill_filter::Interval,
    y: crate::fill_filter::Interval,
}

impl OldIPoint {
    fn exact(point: Point) -> Self {
        Self {
            x: crate::fill_filter::Interval::point(point.x),
            y: crate::fill_filter::Interval::point(point.y),
        }
    }

    fn add(self, other: Self) -> Self {
        Self {
            x: self.x.add(other.x),
            y: self.y.add(other.y),
        }
    }

    fn mul(self, scale: crate::fill_filter::Interval) -> Self {
        Self {
            x: self.x.mul(scale),
            y: self.y.mul(scale),
        }
    }
}

/// The AL-U3 `restrict`, unchanged.
fn old_restrict(controls: [Point; 4], numerator: u32, depth: u32) -> [OldIPoint; 4] {
    let mut points = controls.map(OldIPoint::exact);
    let cell = numerator - 1;
    for bit in (0..depth).rev() {
        points = old_split_half(points, cell & (1u32 << bit) != 0);
    }
    points
}

/// The AL-U3 `split_half`, unchanged.
fn old_split_half(points: [OldIPoint; 4], right: bool) -> [OldIPoint; 4] {
    let p01 = old_midpoint(points[0], points[1]);
    let p12 = old_midpoint(points[1], points[2]);
    let p23 = old_midpoint(points[2], points[3]);
    let p012 = old_midpoint(p01, p12);
    let p123 = old_midpoint(p12, p23);
    let middle = old_midpoint(p012, p123);
    if right {
        [middle, p123, p23, points[3]]
    } else {
        [points[0], p01, p012, middle]
    }
}

/// The AL-U3 `midpoint`, unchanged.
fn old_midpoint(left: OldIPoint, right: OldIPoint) -> OldIPoint {
    left.add(right)
        .mul(crate::fill_filter::Interval::point(0.5))
}

fn old_restrict_bits(controls: [Point; 4], numerator: u32, depth: u32) -> [[u64; 4]; 4] {
    old_restrict(controls, numerator, depth).map(|point| {
        [
            point.x.lo.to_bits(),
            point.x.hi.to_bits(),
            point.y.lo.to_bits(),
            point.y.hi.to_bits(),
        ]
    })
}

/// A deterministic xorshift64* stream for the AL-U4b1 equivalence test.
struct EquivalenceStream(u64);

impl EquivalenceStream {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound
    }

    /// A coordinate from several families: small integers, dyadic fractions, wide exponents,
    /// subnormals, signed zeros and values near the overflow of the midpoint sums.
    fn coordinate(&mut self) -> f64 {
        let sign = if self.next() & 1 == 0 { 1.0 } else { -1.0 };
        match self.below(8) {
            0 => sign * self.below(64) as f64,
            1 => sign * self.below(1 << 20) as f64 / 1024.0,
            2 => sign * f64::from_bits(0x3ff0_0000_0000_0000 | (self.next() >> 12)),
            3 => {
                let exponent = self.below(200) as i32 - 100;
                sign * pow2(exponent) * (1.0 + self.below(1 << 30) as f64 / (1u64 << 30) as f64)
            }
            4 => sign * f64::from_bits(self.next() >> 13 & 0x000f_ffff_ffff_ffff),
            5 => sign * 0.0,
            6 => sign * f64::MAX / (1.0 + self.below(4) as f64),
            _ => sign * (self.next() >> 11) as f64 * pow2(-53) * 1.0e6,
        }
    }

    fn cubic(&mut self) -> [Point; 4] {
        [(); 4].map(|()| p(self.coordinate(), self.coordinate()))
    }
}

#[test]
fn al_u4b1_shared_subdivision_is_bit_identical_to_the_per_leaf_restrict() {
    let mut stream = EquivalenceStream(0x9e37_79b9_7f4a_7c15);
    let mut leaves: Vec<([Point; 4], u32, u32)> = Vec::new();
    let mut covered = Vec::new();
    // (1) Covering leaf sequences in order, one depth per cubic, depths 0 to 8, as FR2 meets the
    // leaves of one cubic; the shared path must make 2^d − 1 splits for each.
    for depth in 0..=8u32 {
        for _ in 0..4 {
            let cubic = stream.cubic();
            let start = leaves.len();
            for numerator in 1..=(1u32 << depth) {
                leaves.push((cubic, numerator, depth));
            }
            covered.push((start, leaves.len(), depth));
        }
    }
    // (2) Mixed depths and orders on shared sources: random walks over a few cubics, with the
    // source repeated, revisited after others, and copied with one signed zero flipped.
    let mut pool: Vec<[Point; 4]> = (0..24).map(|_| stream.cubic()).collect();
    let mut flipped = pool[0];
    flipped[2] = p(-0.0, flipped[2].y);
    pool[0][2] = p(0.0, pool[0][2].y);
    pool.push(flipped);
    for _ in 0..20_000 {
        let cubic = pool[stream.below(pool.len() as u64) as usize];
        let depth = match stream.below(4) {
            0 => stream.below(4) as u32,
            1 => stream.below(9) as u32,
            2 => 20,
            _ => stream.below(21) as u32,
        };
        let numerator = 1 + stream.below(1u64 << depth) as u32;
        let run = 1 + stream.below(6) as u32;
        for offset in 0..run {
            // Consecutive leaves, and siblings at other depths, as a cubic's leaves would be.
            if numerator + offset <= 1u32 << depth {
                leaves.push((cubic, numerator + offset, depth));
            }
        }
        if depth > 0 && stream.below(3) == 0 {
            let coarser = depth - 1 - stream.below(u64::from(depth)) as u32;
            let parent = ((numerator - 1) >> (depth - coarser)) + 1;
            leaves.push((cubic, parent, coarser));
            leaves.push((cubic, numerator, depth));
        }
    }
    // (3) Every leaf of a depth-20 path along both extremes and a random interior run.
    let deep = stream.cubic();
    for numerator in [1, 2, 3, (1 << 19), (1 << 19) + 1, (1 << 20) - 1, 1 << 20] {
        leaves.push((deep, numerator, 20));
    }
    for _ in 0..256 {
        let start = 1 + stream.below((1 << 20) - 64) as u32;
        for offset in 0..64 {
            leaves.push((deep, start + offset, 20));
        }
    }

    let (shared, _) = crate::fill_ladder::shared_restrict_bits(&leaves);
    let mut differences = Vec::new();
    for (index, (&(controls, numerator, depth), bits)) in leaves.iter().zip(&shared).enumerate() {
        if old_restrict_bits(controls, numerator, depth) != *bits {
            differences.push(format!("leaf {index}: n = {numerator}, d = {depth}"));
        }
    }
    let non_finite = shared
        .iter()
        .filter(|bits| {
            bits.iter()
                .flatten()
                .any(|bit| !f64::from_bits(*bit).is_finite())
        })
        .count();
    println!(
        "AL-U4b1 equivalence: {} leaves compared, {} differ, {non_finite} with undecided controls",
        leaves.len(),
        differences.len()
    );
    assert!(
        differences.is_empty(),
        "shared subdivision differs: {differences:#?}"
    );
    // The sample must exercise the undecided (overflow) path as well as the finite one.
    assert!(non_finite > 0 && non_finite < leaves.len());

    // A covering sequence costs one split per internal node.
    for (start, end, depth) in covered {
        let (bits, splits) = crate::fill_ladder::shared_restrict_bits(&leaves[start..end]);
        assert_eq!(bits.len(), end - start);
        assert_eq!(splits, (1u64 << depth) - 1, "depth {depth}");
    }
}

// ------------------------------------------------------------------------------------------
// AL-U4b1 review item S1: on every path where both production and the spike are fast, the
// production `FastStats::max_deviation_squared` (FR2's largest certified |d_m|² bound, read by
// SL-O1 and AL-M5's operand) has the spike's bits. The spike exposes no per-edge
// `deviation_squared`, so the bound is compared through this maximum only. These are additions
// beside the AL-I3 differential, which they repeat on the same cases.

#[derive(Default)]
struct DeviationBits {
    compared: usize,
    differences: Vec<String>,
}

impl DeviationBits {
    fn case(
        &mut self,
        runner: &mut DifferentialRunner,
        name: &str,
        request: FillRequest,
        path: &RealPath,
    ) {
        let production = runner.harness.fast(request, &path.verbs, &path.point_bytes);
        let production_bits = runner
            .harness
            .ladder
            .fast()
            .stats()
            .max_deviation_squared
            .to_bits();
        let spike = spike_rung(
            &mut runner.spike,
            &mut runner.spike_workspace,
            request,
            path,
            p3_b0_spike::Stage::Fr8,
        );
        if production.is_ok() && spike.is_ok() {
            self.compare(
                name,
                production_bits,
                runner.spike.stats().max_deviation_squared,
            );
        }
    }

    fn compare(&mut self, name: &str, production_bits: u64, spike: f64) {
        self.compared += 1;
        if production_bits != spike.to_bits() {
            self.differences.push(format!(
                "{name}: production {:e} ({production_bits:#018x}), spike {spike:e} ({:#018x})",
                f64::from_bits(production_bits),
                spike.to_bits()
            ));
        }
    }

    fn report(&self, label: &str) {
        println!(
            "AL-U4b1 max |d_m|² bits {label}: {} fast paths compared, {} differ",
            self.compared,
            self.differences.len()
        );
        assert!(
            self.differences.is_empty(),
            "max_deviation_squared differs: {:#?}",
            self.differences
        );
    }
}

#[test]
fn al_u4b1_fixtures_and_debug_sample_keep_the_spike_max_deviation_bits() {
    let mut fixtures_bits = DeviationBits::default();
    let mut scan = TestScan::new();
    let mut production = Box::new(FastRung::new());
    let mut spike = Box::new(p3_b0_spike::FastRung::new());
    for fixture in fixtures() {
        let left = production
            .load(fixture.view.view(), DELTA, fixture.rule)
            .and_then(|()| production.run(Stage::Fr9, &mut scan));
        let right = spike
            .load(fixture.view.spike_view(), DELTA, fixture.rule)
            .and_then(|()| spike.run(p3_b0_spike::Stage::Fr8));
        if left.is_ok() && right.is_ok() {
            fixtures_bits.compare(
                fixture.id,
                production.stats().max_deviation_squared.to_bits(),
                spike.stats().max_deviation_squared,
            );
        }
    }
    fixtures_bits.report("fixtures");
    assert!(fixtures_bits.compared > 0);
    let mut runner = DifferentialRunner::new();
    let mut sample_bits = DeviationBits::default();
    for (name, request, path) in sample_cases() {
        sample_bits.case(&mut runner, &name, request, &path);
    }
    sample_bits.report("debug sample");
    assert!(sample_bits.compared > 0);
}

#[test]
#[ignore = "AL-U4b1 S1 full corpus; needs P3_B0R_B0_CORPUS and P3_B0R_RANDOM_CORPUS; release profile"]
fn al_u4b1_full_corpus_keeps_the_spike_max_deviation_bits() {
    let mut runner = DifferentialRunner::new();
    let mut b0 = DeviationBits::default();
    for (name, request, path) in b0_corpus() {
        b0.case(&mut runner, &name, request, &path);
    }
    let random_bytes = {
        let path = env::var("P3_B0R_RANDOM_CORPUS").expect("P3_B0R_RANDOM_CORPUS is required");
        std::fs::read(path).expect("read the randomized corpus")
    };
    let mut random = DeviationBits::default();
    for (name, request, path) in random_corpus(&random_bytes) {
        random.case(&mut runner, &name, request, &path);
    }
    b0.report("B0 framed corpus");
    random.report("p3-b0r-random/v1");
    assert!(b0.compared > 0 && random.compared > 0);
}

// ------------------------------------------------------------------------------------------
// AL-U4b2 (contract section 5.1, AL-C1): FR4 with each edge's chord and control steps computed
// once per edge decides exactly as the AL-U4b1 FR4 (`fill_ladder.rs` at 85f7ef9), kept here as
// a statement-for-statement copy. Both record the bits [lo, hi] of every decided dot interval in
// order, so equal traces mean the same operands, the same dots, the same decisions in the same
// order, and the same first failing reason.

impl OldIPoint {
    fn sub(self, other: Self) -> Self {
        Self {
            x: self.x.sub(other.x),
            y: self.y.sub(other.y),
        }
    }
}

fn old_exact_difference(left: Point, right: Point) -> OldIPoint {
    OldIPoint::exact(left).sub(OldIPoint::exact(right))
}

fn old_dot(left: OldIPoint, right: OldIPoint) -> crate::fill_filter::Interval {
    left.x.mul(right.x).add(left.y.mul(right.y))
}

/// The AL-U4b1 `FastRung::monotone`, unchanged except that it reads `MonotoneTestEdge`s and
/// records each decided dot interval.
fn old_monotone_trace(
    contours: &[Vec<crate::fill_ladder::MonotoneTestEdge>],
    chords_only: bool,
) -> (Result<(), Reason>, Vec<[u64; 2]>) {
    let mut trace = Vec::new();
    let mut decided = |value: crate::fill_filter::Interval| {
        trace.push([value.lo.to_bits(), value.hi.to_bits()]);
        value.sign() == Some(Ordering::Greater)
    };
    let mut run = || {
        for contour in contours {
            let count = contour.len();
            for index in 0..count {
                let e = contour[index];
                let f = contour[(index + 1) % count];
                let w = old_exact_difference(f.1, e.0);
                if !decided(old_dot(old_exact_difference(e.1, e.0), w))
                    || !decided(old_dot(old_exact_difference(f.1, f.0), w))
                {
                    return Err(Reason::Monotone);
                }
                if chords_only {
                    continue;
                }
                for edge in [e, f] {
                    let terms = match edge.2 {
                        Some(terms) => terms,
                        None => return Err(Reason::Structure),
                    };
                    let controls = edge.3.map(|[x, y]| OldIPoint { x, y });
                    for term in 0..terms {
                        let step = controls[term + 1].sub(controls[term]);
                        if !decided(old_dot(step, w)) {
                            return Err(Reason::Monotone);
                        }
                    }
                }
            }
        }
        Ok(())
    };
    let result = run();
    (result, trace)
}

#[derive(Default)]
struct MonotoneEquivalence {
    cases: usize,
    dots: usize,
    undecided_dots: usize,
    passed: usize,
    monotone: usize,
    structure: usize,
    differences: Vec<String>,
}

impl MonotoneEquivalence {
    /// Compares both FR4 versions on `contours`, with and without defect (3)'s chords-only
    /// switch, and returns the new version's full result.
    fn compare(
        &mut self,
        name: &str,
        contours: &[Vec<crate::fill_ladder::MonotoneTestEdge>],
    ) -> Result<(), Reason> {
        let mut full = Ok(());
        for chords_only in [false, true] {
            let new = crate::fill_ladder::monotone_trace(contours, chords_only);
            let old = old_monotone_trace(contours, chords_only);
            self.cases += 1;
            self.dots += new.1.len();
            self.undecided_dots += new
                .1
                .iter()
                .filter(|[lo, hi]| {
                    !(f64::from_bits(*lo).is_finite() && f64::from_bits(*hi).is_finite())
                })
                .count();
            match new.0 {
                Ok(()) => self.passed += 1,
                Err(Reason::Monotone) => self.monotone += 1,
                Err(Reason::Structure) => self.structure += 1,
                Err(_) => {}
            }
            if new != old {
                self.differences.push(format!(
                    "{name} (chords only {chords_only}): new {:?} after {} dots, old {:?} after \
                     {} dots",
                    new.0,
                    new.1.len(),
                    old.0,
                    old.1.len()
                ));
            }
            if !chords_only {
                full = new.0;
            }
        }
        full
    }

    fn report(&self, label: &str) {
        println!(
            "AL-U4b2 FR4 equivalence {label}: {} cases, {} dots ({} undecided), {} pass, {} \
             MONOTONE, {} STRUCTURE, {} differ",
            self.cases,
            self.dots,
            self.undecided_dots,
            self.passed,
            self.monotone,
            self.structure,
            self.differences.len()
        );
        assert!(
            self.differences.is_empty(),
            "FR4 differs: {:#?}",
            self.differences
        );
    }
}

/// FR4 on a real path: the certified edges after FR3, compared, and the new version's result
/// against the production stop after FR4. Returns false when FR1-FR3 do not pass.
fn monotone_real_case(
    harness: &mut Harness,
    equivalence: &mut MonotoneEquivalence,
    name: &str,
    request: FillRequest,
    path: &RealPath,
) -> bool {
    let through_fr3 = harness.ladder.fast_rung_until(
        &mut harness.workspace,
        request,
        &path.verbs,
        &path.point_bytes,
        &mut harness.scan,
        Stage::Fr3,
    );
    if through_fr3.is_err() {
        return false;
    }
    let inputs = harness.ladder.fast().monotone_inputs();
    let result = equivalence.compare(name, &inputs);
    let production = harness.ladder.fast_rung_until(
        &mut harness.workspace,
        request,
        &path.verbs,
        &path.point_bytes,
        &mut harness.scan,
        Stage::Fr4,
    );
    if production != result {
        equivalence.differences.push(format!(
            "{name}: production FR4 stop {production:?}, hook {result:?}"
        ));
    }
    true
}

/// A random interval around `center`: exact, widened by a random relative width, or undecided.
fn random_interval(stream: &mut EquivalenceStream, center: f64) -> crate::fill_filter::Interval {
    match stream.below(16) {
        0 => crate::fill_filter::UNDECIDED,
        1..=7 => crate::fill_filter::Interval::point(center),
        _ => {
            let width = center.abs() * pow2(-(stream.below(60) as i32)) + pow2(-1074);
            crate::fill_filter::Interval {
                lo: center - width,
                hi: center + width,
            }
        }
    }
}

/// A random contour of 1 to 10 edges: a convex polygon (scaled by a random power of two, so
/// that most pairs pass) with leaf or segment pieces whose controls lie on the chords, perturbed
/// by random enclosure widths, reversed steps and unset pieces; or entirely random points.
fn random_monotone_contour(
    stream: &mut EquivalenceStream,
) -> Vec<crate::fill_ladder::MonotoneTestEdge> {
    let count = 1 + stream.below(10) as usize;
    let convex = stream.below(4) != 0;
    let scale = pow2(stream.below(160) as i32 - 80);
    let phase = stream.below(1000) as f64 / 1000.0;
    let points: Vec<Point> = (0..count)
        .map(|index| {
            if convex {
                let angle = core::f64::consts::TAU * (index as f64 + phase) / count.max(3) as f64;
                p(scale * angle.cos(), scale * angle.sin())
            } else {
                p(stream.coordinate(), stream.coordinate())
            }
        })
        .collect();
    (0..count)
        .map(|index| {
            let start = points[index];
            let end = points[(index + 1) % count];
            let terms = match stream.below(16) {
                0 => None,
                1..=10 => Some(3),
                _ => Some(1),
            };
            let along = |t: f64| {
                p(
                    start.x + (end.x - start.x) * t,
                    start.y + (end.y - start.y) * t,
                )
            };
            let mut targets = match terms {
                Some(1) => [start, end, end, end],
                _ => [start, along(1.0 / 3.0), along(2.0 / 3.0), end],
            };
            if stream.below(8) == 0 {
                // A reversed control step.
                targets.swap(1, 2);
            }
            let controls = targets.map(|point| {
                [
                    random_interval(stream, point.x),
                    random_interval(stream, point.y),
                ]
            });
            (start, end, terms, controls)
        })
        .collect()
}

#[test]
fn al_u4b2_fr4_shared_operands_decide_as_before() {
    // Fixtures: the synthetic views through FR3, then FR4 by both versions, and the hook's
    // result against the production stops after FR4 (with and without defect (3)).
    let mut scan = TestScan::new();
    let mut production = Box::new(FastRung::new());
    let mut fixtures_equivalence = MonotoneEquivalence::default();
    let mut reached = 0usize;
    for fixture in fixtures() {
        let through_fr3 = production
            .load(fixture.view.view(), DELTA, fixture.rule)
            .and_then(|()| production.run(Stage::Fr3, &mut scan));
        if through_fr3.is_err() {
            continue;
        }
        reached += 1;
        let inputs = production.monotone_inputs();
        let result = fixtures_equivalence.compare(fixture.id, &inputs);
        let stop = production
            .load(fixture.view.view(), DELTA, fixture.rule)
            .and_then(|()| production.run(Stage::Fr4, &mut scan));
        let chords = crate::fill_ladder::monotone_trace(&inputs, true).0;
        let chords_stop = with_ladder_faults(&[LadderFault::MonotoneChordsOnly], || {
            production
                .load(fixture.view.view(), DELTA, fixture.rule)
                .and_then(|()| production.run(Stage::Fr4, &mut scan))
        });
        if stop != result || chords_stop != chords {
            fixtures_equivalence.differences.push(format!(
                "{}: stop {stop:?} / {chords_stop:?}, hook {result:?} / {chords:?}",
                fixture.id
            ));
        }
    }
    fixtures_equivalence.report("fixtures");
    assert!(reached > 0 && fixtures_equivalence.monotone > 0 && fixtures_equivalence.passed > 0);

    // The debug sample of real paths.
    let mut harness = Harness::new();
    let mut sample = MonotoneEquivalence::default();
    let mut sample_reached = 0usize;
    for (name, request, path) in sample_cases() {
        if monotone_real_case(&mut harness, &mut sample, &name, request, &path) {
            sample_reached += 1;
        }
    }
    sample.report("debug sample");
    assert!(sample_reached > 0 && sample.passed > 0);

    // Random edges, contours of 1 to 10 edges (FR1 admits only 3 or more; FR4 handles any),
    // one to three contours per case.
    let mut stream = EquivalenceStream(0xd1b5_4a32_d192_ed03);
    let mut random = MonotoneEquivalence::default();
    for case in 0..20_000 {
        let contours: Vec<_> = (0..1 + stream.below(3))
            .map(|_| random_monotone_contour(&mut stream))
            .collect();
        let _ = random.compare(&format!("random {case}"), &contours);
    }
    random.report("random edges");
    assert!(random.passed > 0 && random.monotone > 0 && random.structure > 0);
    assert!(random.undecided_dots > 0 && random.undecided_dots < random.dots);
}

#[test]
#[ignore = "AL-U4b2 FR4 full corpus; needs P3_B0R_B0_CORPUS and P3_B0R_RANDOM_CORPUS; release profile"]
fn al_u4b2_full_corpus_fr4_shared_operands_decide_as_before() {
    let mut harness = Harness::new();
    let mut b0 = MonotoneEquivalence::default();
    for (name, request, path) in b0_corpus() {
        monotone_real_case(&mut harness, &mut b0, &name, request, &path);
    }
    let random_bytes = {
        let path = env::var("P3_B0R_RANDOM_CORPUS").expect("P3_B0R_RANDOM_CORPUS is required");
        std::fs::read(path).expect("read the randomized corpus")
    };
    let mut random = MonotoneEquivalence::default();
    for (name, request, path) in random_corpus(&random_bytes) {
        monotone_real_case(&mut harness, &mut random, &name, request, &path);
    }
    b0.report("B0 framed corpus");
    random.report("p3-b0r-random/v1");
    assert!(b0.passed > 0 && random.passed > 0);
}
