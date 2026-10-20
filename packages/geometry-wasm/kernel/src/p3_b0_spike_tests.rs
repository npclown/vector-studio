//! P3 B0 spike, unit SL-U1 tests (`docs/plans/p3-b0-spike-ladder-contract.md` sections 2.2,
//! 4.8 and 7.2): the named fixtures SL-F1 to SL-F21 with their literal expectations, the ten
//! seeded defects of section 4.8, the S1 accessor equality test, the allocation-free ladder
//! test over the B0 corpus (SL-A7) and the `emit_spike_fixtures` hand-off to the TypeScript
//! oracles of unit SL-U2.
//!
//! The fixtures feed the fast rung synthetic S1 views (polygon, owners, sources), so knot errors
//! and closures can be chosen; SL-F13 runs two B0 corpus paths through the whole ladder. For
//! every fast outcome the Rust side checks that every triangle's exact `orient2d` is positive,
//! that the vertex set is the boundary contours' vertex set, and that the signed sum of the
//! triangle areas equals the literal expected area (the coordinates are dyadic with few
//! significant bits, so these Float64 sums are exact). It also checks, as a debugging aid only,
//! that the triangles' directed edges cancel to the boundary contours' edges; the exact region
//! oracle is SL-O2 in TypeScript.
use core::cmp::Ordering;
use std::env;
use std::fmt::Write as _;
use std::fs;

use crate::codec::{PathInput, Request};
use crate::cubic_fill::{
    ContourRange, CubicFillError, CubicFillWorkspace, DecodedSource, EdgeOwner, MAX_FLAT_COMMANDS,
};
use crate::fill_filter::{with_fault, Fault};
use crate::fill_predicates::orient2d;
use crate::geometry::{Point, PATH_OK};
use crate::line_fill::LineFillRule;
use crate::native_cubic_fill_tests::{FLATTEN_TOLERANCE, LIMITS, TOPOLOGY_TOLERANCE};
use crate::p3_b0_spike::{
    with_spike_fault, ExactEntry, FastRung, PrefixFailure, Reason, Rung, S1View, SpikeFault,
    SpikeLadder, Stage,
};

/// δ = `FLATTEN_TOLERANCE` = 2^-3 for every fixture, as in every B0 cell (section 1).
const DELTA: f64 = FLATTEN_TOLERANCE;

fn p(x: f64, y: f64) -> Point {
    Point { x, y }
}

fn pow2(exponent: i32) -> f64 {
    2.0f64.powi(exponent)
}

// ------------------------------------------------------------------------------------------
// Synthetic S1 views.

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
}

/// Builds the S1 view that `collect_contours` would produce for these sources and emitted knots:
/// the last knot is dropped when it equals the MOVE point, otherwise a close edge is pushed
/// (`ExplicitClose` with a CLOSE verb, `ImplicitClosure` without).
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
// Fixtures SL-F1 to SL-F21 (section 4.8), expectations written before the first execution.

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

/// Section 3.7's first example: contour 1 starts with the cubic e, contour 2 with f.
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

    // SL-F1: disjoint chords y = 0 and y = 1/8, crossing curves; dist(e, f) = 1/8 ≤ 2δ.
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
    // SL-F2: disjoint curves, crossing chords; the pair (e, f) is the first FR5 failure.
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
    // SL-F3: facing edges exactly 2δ = 1/4 apart (strictness).
    add(
        "SL-F3",
        vec![
            line_contour(&square(0.0, 0.0, 1.0, 1.0)),
            line_contour(&square(1.25, 0.0, 2.25, 1.0)),
        ],
        nonzero,
        Expected::Fallback(Reason::Clearance),
    );
    // SL-F4: the second square moved right by 2^-20.
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
    // SL-F5: private contract F01, area 100 under both rules.
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
    // SL-F6: F02, both contours counterclockwise.
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
    // SL-F7: F03, the inner contour reversed, area 84 under both rules.
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
    // SL-F8: F05 (F01 and its reversed copy) and F07 (squares sharing the edge x = 2).
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
    // SL-F9: F06, the bowtie; ⟨u_f, w⟩ = 0 at (4, 4) fails FR4 at the first pair.
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
    // SL-F10: a backward-starting leaf, ⟨R1 − R0, w⟩ < 0 for w = (1/4, −1).
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
    // SL-F10b, supplementary (beyond section 4.8, review item S1): a backward-starting leaf in
    // a 3-edge contour, with a far unit square so that cross-contour pairs exist and all are
    // more than 2δ apart. Hand derivation: e is the depth-0 cubic (0, 0), (1/16, 1/16),
    // (5/16, 1/32), (1/2, 0), then `Line` sources to (1/4, 1/2) and back. d_1 = (−5/48, 1/16)
    // with |d_1|² = 34/2304 < 36/2304 = δ², d_2 = (−1/48, 1/32), d_0 = d_3 = 0. For the cyclic
    // pair (h, e), h = [(1/4, 1/2), (0, 0)]: w = (1/2, 0) − (1/4, 1/2) = (1/4, −1/2), the chord
    // dots are ⟨u_h, w⟩ = 3/16 and ⟨u_e, w⟩ = 1/8, but ⟨R1 − R0, w⟩ = 1/64 − 1/32 < 0. Every
    // other dot of the three pairs is positive (pair (e, f): w = (1/4, 1/2), control dots 3/64,
    // 3/64, 1/32; pair (f, h): w = (−1/2, 0), chord dots 1/8 and 1/8). So `MONOTONE` at the
    // last pair; with chords only (defect (3)) FR5 finds no failing pair (the triangle has no
    // non-consecutive pair, the square's opposite sides are 1 apart and the contours are about
    // 10 apart), and the path is fast with area 1/8 + 1 = 9/8 in 1 + 2 triangles.
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
    // SL-F11: F01 with the polygon vertex (10, 0) at (163/16, 0), sources the exact square.
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
    // SL-F12: micro-closure. (a) k inside the square: fast through SL-L5. Its region is the
    // unit square minus the sliver conv((0, 1), k, (0, 0)) of area 2^-31.
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
    // (b) k = (2^-30, −2^-30): f enters T at m.
    add(
        "SL-F12b",
        vec![micro_closure_square(p(tiny, -tiny))],
        nonzero,
        Expected::Fallback(Reason::Closure),
    );
    // SL-F14: closed polygon over an open source.
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
    // SL-F15: a second contour with two edges.
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
    // SL-F16 and SL-F17: non-degenerate `ImplicitClosure` and `ExplicitClose`.
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
    // SL-F18: same-contour clearance, the finger's edges two apart and 1/8 apart at the tip.
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
    // SL-F19: cubic-leaf knot error, the bottom interior knot (6, 0) emitted as (6, 5/32).
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
    // SL-F20: SL-M4 on the p/h side; r = (1/64, 1/2) lies inside T.
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
    // SL-F21: σ = 0. (a) k strictly between p and m: FR3 passes. (b) k beyond m.
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
    list
}

fn fixture(id: &str) -> Fixture {
    fixtures()
        .into_iter()
        .find(|fixture| fixture.id == id)
        .unwrap_or_else(|| panic!("unknown fixture {id}"))
}

fn rule_name(rule: LineFillRule) -> &'static str {
    match rule {
        LineFillRule::Nonzero => "nonzero",
        LineFillRule::Evenodd => "evenodd",
    }
}

// ------------------------------------------------------------------------------------------
// Rust-side mesh checks (section 4.8).

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

/// The three Rust-side checks (orientation, signed area, vertex set, in that order, with the
/// optional triangle count) plus the directed-edge debugging aid. `area` is compared exactly
/// when `exact_area` is set, otherwise to a relative 1e-12.
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
    // Debugging aid: directed edges cancel to the boundary contours' edges, each contour in one
    // consistent direction, with no directed edge twice.
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

/// Runs one fixture through the fast rung and compares the outcome with its expectation.
fn check_fixture(fixture: &Fixture) -> Result<(), String> {
    let mut fast = FastRung::new();
    fast.load(fixture.view.view(), DELTA, fixture.rule)
        .map_err(|reason| format!("{}: load failed with {reason:?}", fixture.id))?;
    match fixture.expected {
        Expected::Fallback(expected) => match fast.run(Stage::Fr8) {
            Err(reason) if reason == expected => Ok(()),
            other => Err(format!(
                "{}: expected {expected:?}, got {other:?}",
                fixture.id
            )),
        },
        Expected::Passes(stage) => fast
            .run(stage)
            .map_err(|reason| format!("{}: stage {stage:?} failed with {reason:?}", fixture.id)),
        Expected::Fast {
            area,
            boundary,
            triangles,
        } => {
            fast.run(Stage::Fr8)
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
fn spike_fixtures_match_their_literal_expectations() {
    let mut failures = Vec::new();
    let all = fixtures();
    assert_eq!(
        all.len(),
        27,
        "fixture entries (26 of section 4.8 and SL-F10b)"
    );
    for fixture in &all {
        if let Err(message) = check_fixture(fixture) {
            failures.push(message);
        }
    }
    assert!(failures.is_empty(), "fixture failures: {failures:#?}");
}

#[test]
fn sl_f21a_full_run_is_recorded() {
    // SL-F21 (a) asserts FR3 only; the later stages may take `TRIANGLE` on the collinear
    // vertex k. Whatever they return must be a published mesh or `TRIANGLE`.
    let fixture = fixture("SL-F21a");
    let mut fast = FastRung::new();
    fast.load(fixture.view.view(), DELTA, fixture.rule).unwrap();
    let result = fast.run(Stage::Fr8);
    println!("SL-F21a full run: {result:?}");
    match result {
        Ok(()) => {
            let mesh = fast.mesh().expect("published mesh");
            check_mesh(
                &fixture.view.ranges,
                &fixture.view.points,
                mesh,
                &[0],
                1.0,
                true,
                None,
            )
            .unwrap();
        }
        Err(reason) => assert_eq!(reason, Reason::Triangle),
    }
}

#[test]
fn stage_stops_return_after_their_stage() {
    // The nested stops of section 5.8 on SL-F11, which fails at FR2: S1 and FR1 pass.
    let fixture = fixture("SL-F11");
    let mut fast = FastRung::new();
    fast.load(fixture.view.view(), DELTA, fixture.rule).unwrap();
    assert_eq!(fast.run(Stage::S1), Ok(()));
    assert_eq!(fast.run(Stage::Fr1), Ok(()));
    assert_eq!(fast.run(Stage::Fr2), Err(Reason::Deviation));
    assert!(fast.mesh().is_none());
    // SL-F5 passes every stop and publishes only at FR8.
    let fixture = self::fixture("SL-F5/nonzero");
    fast.load(fixture.view.view(), DELTA, fixture.rule).unwrap();
    for stage in [Stage::Fr3, Stage::Fr4, Stage::Fr5, Stage::Fr6, Stage::Fr7] {
        assert_eq!(fast.run(stage), Ok(()), "{stage:?}");
        assert!(fast.mesh().is_none());
    }
    assert_eq!(fast.run(Stage::Fr8), Ok(()));
    assert!(fast.mesh().is_some());
    assert_eq!(fast.boundary_contours(), &[true]);
    assert_eq!(fast.stats().diagonals, 0);
}

// ------------------------------------------------------------------------------------------
// Seeded defects (section 4.8): the named fixture must fail for each.

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

fn under(which: SpikeFault) -> impl Fn(&Fixture) -> Result<(), String> {
    move |fixture| with_spike_fault(which, || check_fixture(fixture))
}

#[test]
fn sl_defect_01_clearance_ge_without_r1_widening_is_detected() {
    assert_detected("(1)", &["SL-F3"], |fixture| {
        with_fault(Fault::R1WideningRemoved, || {
            with_spike_fault(SpikeFault::ClearanceGreaterEqual, || check_fixture(fixture))
        })
    });
}

#[test]
fn sl_defect_02_knot_errors_omitted_is_detected() {
    assert_detected(
        "(2)",
        &["SL-F11", "SL-F19"],
        under(SpikeFault::KnotErrorsOmitted),
    );
}

#[test]
fn sl_defect_03_monotone_chords_only_is_detected() {
    assert_detected(
        "(3)",
        &["SL-F10", "SL-F10b"],
        under(SpikeFault::MonotoneChordsOnly),
    );
    // SL-F10b (supplementary, beyond section 4.8): under chords only it becomes fast, with its
    // hand-derived area 9/8 in three triangles.
    let mut supplementary = fixture("SL-F10b");
    supplementary.expected = Expected::Fast {
        area: 9.0 / 8.0,
        boundary: &[0, 1],
        triangles: Some(3),
    };
    with_spike_fault(SpikeFault::MonotoneChordsOnly, || {
        check_fixture(&supplementary)
    })
    .expect("SL-F10b is fast under defect (3)");
}

#[test]
fn sl_defect_04_simplicity_only_is_detected() {
    assert_detected(
        "(4)",
        &["SL-F1", "SL-F3", "SL-F18"],
        under(SpikeFault::SimplicityOnly),
    );
}

#[test]
fn sl_defect_05_cone_inverted_is_detected() {
    assert_detected("(5)", &["SL-F12a"], under(SpikeFault::ConeInverted));
}

#[test]
fn sl_defect_06_nesting_from_orientation_is_detected() {
    assert_detected(
        "(6)",
        &["SL-F6/nonzero"],
        under(SpikeFault::NestingFromOrientation),
    );
}

#[test]
fn sl_defect_07_flipped_triangle_is_detected() {
    assert_detected(
        "(7)",
        &["SL-F5/nonzero"],
        under(SpikeFault::TriangleFlipped),
    );
}

#[test]
fn sl_defect_08_non_boundary_triangulated_is_detected() {
    assert_detected(
        "(8)",
        &["SL-F6/nonzero"],
        under(SpikeFault::NonBoundaryTriangulated),
    );
}

#[test]
fn sl_defect_09_scan_bound_without_radius_is_detected() {
    assert_detected("(9)", &["SL-F3"], under(SpikeFault::ScanBoundWithoutRadius));
}

#[test]
fn sl_defect_10_skip_two_apart_is_detected() {
    assert_detected("(10)", &["SL-F18"], under(SpikeFault::SkipTwoApart));
}

// ------------------------------------------------------------------------------------------
// Real paths: SL-F13 and the S1 accessor equality test (section 2.2).

struct RealPath {
    name: String,
    entry: ExactEntry,
    verbs: Vec<u8>,
    point_bytes: Vec<u8>,
}

impl RealPath {
    fn input(&self) -> PathInput<'_> {
        PathInput::from_test_parts(
            Request {
                request_id: 0,
                source_epoch: 0,
                source_revision: 0,
                tolerance: FLATTEN_TOLERANCE,
            },
            &self.verbs,
            &self.point_bytes,
        )
    }
}

fn real_path(name: &str, verbs: Vec<u8>, scalars: &[f64]) -> RealPath {
    RealPath {
        name: name.to_owned(),
        entry: ExactEntry::Attempt,
        verbs,
        point_bytes: scalars
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect(),
    }
}

/// The two B0 fixture paths of `tests/geometry/p3-b0/fixtures.json` (SL-F13).
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

/// A few line-source and cubic-source paths for the debug-profile accessor test.
fn small_real_paths() -> Vec<RealPath> {
    let mut paths = b0_fixture_paths();
    paths.push(real_path(
        "F01",
        vec![0, 1, 1, 1, 3],
        &[0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 10.0],
    ));
    paths.push(real_path(
        "F02",
        vec![0, 1, 1, 1, 3, 0, 1, 1, 1, 3],
        &[
            0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 10.0, 3.0, 3.0, 7.0, 3.0, 7.0, 7.0, 3.0, 7.0,
        ],
    ));
    paths.push(real_path(
        "open-square",
        vec![0, 1, 1, 1],
        &[0.0, 0.0, 4.0, 0.0, 4.0, 4.0, 0.0, 4.0],
    ));
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

fn entry_attempt(
    workspace: &mut CubicFillWorkspace,
    entry: ExactEntry,
    input: PathInput<'_>,
) -> Result<crate::cubic_fill::CubicFillDiagnostics, CubicFillError> {
    match entry {
        ExactEntry::Attempt => workspace.attempt(
            input,
            LineFillRule::Nonzero,
            TOPOLOGY_TOLERANCE,
            MAX_FLAT_COMMANDS,
        ),
        ExactEntry::Transverse => workspace.attempt_transverse(
            input,
            LineFillRule::Nonzero,
            TOPOLOGY_TOLERANCE,
            MAX_FLAT_COMMANDS,
        ),
    }
}

/// Section 2.2: on a path whose exact attempt publishes, the accessor's points, ranges and
/// owners equal the published output's bit for bit. Otherwise the accessor either succeeds (a
/// failure after S1) or fails exactly as the exact attempt did inside the prefix. Returns
/// whether the exact attempt published.
fn check_accessor(workspace: &mut CubicFillWorkspace, path: &RealPath) -> Result<bool, String> {
    let result = entry_attempt(workspace, path.entry, path.input());
    let published = workspace.output().map(|output| {
        (
            output.ranges.to_vec(),
            output.points.iter().copied().map(bits).collect::<Vec<_>>(),
            output.owners.to_vec(),
        )
    });
    let accessor = workspace.prepare_for_spike(path.input(), MAX_FLAT_COMMANDS);
    match (published, accessor) {
        (Some((ranges, points, owners)), Ok(view)) => {
            let view_points: Vec<_> = view.points.iter().copied().map(bits).collect();
            if view.ranges != ranges.as_slice() || view_points != points || view.owners != owners {
                return Err(format!("{}: S1 view differs from the output", path.name));
            }
            Ok(true)
        }
        (Some(_), Err(failure)) => Err(format!(
            "{}: published, but the accessor failed with {failure:?}",
            path.name
        )),
        (None, Ok(_)) => Ok(false),
        (None, Err(PrefixFailure::Error(error))) if result == Err(error) => Ok(false),
        (None, Err(PrefixFailure::Sizing(status)))
            if status != PATH_OK
                && result.is_ok_and(|diagnostics| diagnostics.flat_status == status) =>
        {
            Ok(false)
        }
        (None, Err(failure)) => Err(format!(
            "{}: accessor failure {failure:?} differs from the attempt's {result:?}",
            path.name
        )),
    }
}

#[test]
fn s1_accessor_matches_published_output_on_small_paths() {
    let mut workspace = CubicFillWorkspace::new_pre_b1(LIMITS).expect("workspace");
    let mut published = 0usize;
    for path in small_real_paths() {
        if check_accessor(&mut workspace, &path).unwrap() {
            published += 1;
        }
    }
    assert_eq!(
        published, 6,
        "every small path publishes under the exact rung"
    );
}

#[test]
fn sl_f13_b0_fixture_paths_take_the_fast_rung() {
    let mut ladder = Box::new(SpikeLadder::new(LIMITS).expect("ladder"));
    for path in b0_fixture_paths() {
        let outcome = ladder.run(
            path.input(),
            path.entry,
            LineFillRule::Nonzero,
            TOPOLOGY_TOLERANCE,
            MAX_FLAT_COMMANDS,
        );
        assert_eq!(outcome.rung, Rung::Fast, "{}: {outcome:?}", path.name);
        // The S1 polygon, from a separate prefix run.
        let mut workspace = CubicFillWorkspace::new_pre_b1(LIMITS).expect("workspace");
        assert!(check_accessor(&mut workspace, &path).unwrap());
        check_ring_mesh(&mut workspace, &path, ladder.fast())
            .unwrap_or_else(|message| panic!("{}: {message}", path.name));
        assert!(ladder.fast().stats().max_deviation_squared < DELTA * DELTA);
    }
}

/// The mesh checks for a fast mesh of a B0 ring path, whose contours are disjoint and not
/// nested, so every contour is a boundary contour (an expectation for this family only). The
/// S1 polygon comes from a separate prefix run in `workspace`; the expected area is its
/// shoelace area, compared to a relative 1e-12. An early warning, not SL-O2.
fn check_ring_mesh(
    workspace: &mut CubicFillWorkspace,
    path: &RealPath,
    fast: &FastRung,
) -> Result<(), String> {
    let view = workspace
        .prepare_for_spike(path.input(), MAX_FLAT_COMMANDS)
        .map_err(|failure| format!("prefix {failure:?}"))?;
    let boundary: Vec<usize> = (0..view.ranges.len()).collect();
    let area: f64 = boundary
        .iter()
        .map(|contour| {
            let ring = contour_points(view.ranges, view.points, *contour);
            let mut twice = 0.0;
            for index in 0..ring.len() {
                let (a, b) = (ring[index], ring[(index + 1) % ring.len()]);
                twice += a.x * b.y - a.y * b.x;
            }
            (twice / 2.0).abs()
        })
        .sum();
    let mesh = fast.mesh().ok_or("no fast mesh")?;
    check_mesh(view.ranges, view.points, mesh, &boundary, area, false, None)
}

#[test]
fn ladder_falls_back_to_the_exact_rung_with_its_reason() {
    // F02 under nonzero through the whole ladder takes the fast rung; a path with a crossing
    // (F05, two coincident squares) falls back as `CROSSING` and the exact rung decides.
    let mut ladder = Box::new(SpikeLadder::new(LIMITS).expect("ladder"));
    let paths = small_real_paths();
    let f02 = &paths[3];
    let outcome = ladder.run(
        f02.input(),
        f02.entry,
        LineFillRule::Nonzero,
        TOPOLOGY_TOLERANCE,
        MAX_FLAT_COMMANDS,
    );
    assert_eq!(outcome.rung, Rung::Fast);
    let f05 = real_path(
        "F05",
        vec![0, 1, 1, 1, 3, 0, 1, 1, 1, 3],
        &[
            0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 10.0, 0.0, 0.0, 0.0, 10.0, 10.0, 10.0, 10.0, 0.0,
        ],
    );
    let outcome = ladder.run(
        f05.input(),
        f05.entry,
        LineFillRule::Nonzero,
        TOPOLOGY_TOLERANCE,
        MAX_FLAT_COMMANDS,
    );
    assert_eq!(outcome.rung, Rung::Exact);
    assert_eq!(outcome.reason, Some(Reason::Crossing));
    let mut reference = CubicFillWorkspace::new_pre_b1(LIMITS).expect("workspace");
    assert_eq!(
        outcome.exact,
        Some(entry_attempt(&mut reference, f05.entry, f05.input()))
    );
    // A prefix failure (an unsupported verb) is `PREFIX`, reproduced by the exact rung.
    let broken = real_path("bad-verb", vec![0, 7], &[0.0, 0.0]);
    let outcome = ladder.run(
        broken.input(),
        broken.entry,
        LineFillRule::Nonzero,
        TOPOLOGY_TOLERANCE,
        MAX_FLAT_COMMANDS,
    );
    assert_eq!(outcome.reason, Some(Reason::Prefix));
    match outcome.exact {
        Some(Err(_)) => {}
        Some(Ok(diagnostics)) => assert_ne!(diagnostics.flat_status, PATH_OK),
        None => panic!("no exact result on fallback"),
    }
    assert!(ladder.fast().mesh().is_none());
    assert!(ladder.exact().output().is_none());
}

// ------------------------------------------------------------------------------------------
// B0 corpus tests (ignored; release profile). The framed corpus of `p3-b0-ring/v1` is read
// from `P3_B0R_B0_CORPUS`, the variable the identity tool already uses for it.

fn read_b0_corpus() -> Vec<(String, Vec<RealPath>)> {
    let path = env::var("P3_B0R_B0_CORPUS").expect("P3_B0R_B0_CORPUS is required");
    let bytes = fs::read(path).expect("read the B0 corpus");
    let mut offset = 0usize;
    let mut take = |count: usize| -> &[u8] {
        let slice = &bytes[offset..offset + count];
        offset += count;
        slice
    };
    assert_eq!(take(8), b"P3B0COR1", "corpus magic");
    let read_u32 = |slice: &[u8]| u32::from_le_bytes(slice.try_into().expect("u32")) as usize;
    let cells = read_u32(take(4));
    let mut corpus = Vec::with_capacity(cells);
    for _ in 0..cells {
        let id_len = read_u32(take(4));
        let id = String::from_utf8(take(id_len).to_vec()).expect("cell id");
        let entry = match take(1)[0] {
            0 => ExactEntry::Attempt,
            1 => ExactEntry::Transverse,
            other => panic!("unknown entry {other}"),
        };
        for _ in 0..3 {
            take(4);
        }
        let count = read_u32(take(4));
        let mut paths = Vec::with_capacity(count);
        for index in 0..count {
            let verb_count = read_u32(take(4));
            let verbs = take(verb_count).to_vec();
            let scalar_count = read_u32(take(4));
            let point_bytes = take(scalar_count * 8).to_vec();
            paths.push(RealPath {
                name: format!("{id}#{index}"),
                entry,
                verbs,
                point_bytes,
            });
        }
        corpus.push((id, paths));
    }
    assert_eq!(offset, bytes.len(), "trailing corpus bytes");
    corpus
}

#[test]
#[ignore = "B0 corpus; needs P3_B0R_B0_CORPUS; run in the release profile"]
fn spike_corpus_s1_accessor_matches_published_output() {
    let corpus = read_b0_corpus();
    let mut workspace = CubicFillWorkspace::new_pre_b1(LIMITS).expect("workspace");
    let (mut published, mut other) = (0usize, 0usize);
    for (_, paths) in &corpus {
        for path in paths {
            if check_accessor(&mut workspace, path).unwrap() {
                published += 1;
            } else {
                other += 1;
            }
        }
    }
    println!("P3 B0 spike S1 accessor: {published} published paths equal, {other} other paths");
    assert!(published > 0);
}

/// SL-A7: the tracking allocator counts only inside each ladder call, over every B0 corpus
/// path. Also prints the fast-rung admission per cell, an observation with no expected value.
#[test]
#[ignore = "B0 corpus; needs P3_B0R_B0_CORPUS; run in the release profile"]
fn spike_corpus_ladder_is_allocation_free() {
    let corpus = read_b0_corpus();
    let mut ladder = Box::new(SpikeLadder::new(LIMITS).expect("ladder"));
    let mut paths_total = 0usize;
    let mut allocating = 0usize;
    let mut totals = [0usize; Reason::ALL.len() + 1];
    let mut prefix_workspace = CubicFillWorkspace::new_pre_b1(LIMITS).expect("workspace");
    let mut meshes_checked = 0usize;
    let mut mesh_failures = Vec::new();
    for (id, paths) in &corpus {
        let mut counts = [0usize; Reason::ALL.len() + 1];
        let mut exact_ok = 0usize;
        for path in paths {
            crate::allocation_test_support::start();
            let outcome = ladder.run(
                path.input(),
                path.entry,
                LineFillRule::Nonzero,
                TOPOLOGY_TOLERANCE,
                MAX_FLAT_COMMANDS,
            );
            let allocations = crate::allocation_test_support::stop();
            if allocations != 0 {
                allocating += 1;
            }
            paths_total += 1;
            let slot = match outcome.reason {
                None => 0,
                Some(reason) => 1 + Reason::ALL.iter().position(|r| *r == reason).unwrap(),
            };
            counts[slot] += 1;
            totals[slot] += 1;
            if outcome.rung == Rung::Exact && matches!(outcome.exact, Some(Ok(_))) {
                exact_ok += usize::from(ladder.exact().output().is_some());
            }
            // Outside the allocation window: the mesh checks on every fast mesh (orientation,
            // area, vertex set and directed-edge cancellation), an early warning, not SL-O2.
            if outcome.rung == Rung::Fast {
                meshes_checked += 1;
                if let Err(message) = check_ring_mesh(&mut prefix_workspace, path, ladder.fast()) {
                    mesh_failures.push(format!("{}: {message}", path.name));
                }
            }
        }
        let mut line = format!("{id}: paths {} fast {}", paths.len(), counts[0]);
        for (index, reason) in Reason::ALL.iter().enumerate() {
            if counts[index + 1] > 0 {
                let _ = write!(line, " {} {}", reason.code(), counts[index + 1]);
            }
        }
        let _ = write!(line, " exact-published-on-fallback {exact_ok}");
        println!("{line}");
    }
    let mut line = format!(
        "P3 B0 spike corpus: {paths_total} paths, fast {}",
        totals[0]
    );
    for (index, reason) in Reason::ALL.iter().enumerate() {
        if totals[index + 1] > 0 {
            let _ = write!(line, " {} {}", reason.code(), totals[index + 1]);
        }
    }
    println!("{line}; allocating ladder calls {allocating}");
    println!(
        "P3 B0 spike corpus: fast meshes checked {meshes_checked}, failures {}",
        mesh_failures.len()
    );
    assert_eq!(allocating, 0, "ladder calls allocated");
    assert!(
        mesh_failures.is_empty(),
        "fast mesh failures: {mesh_failures:#?}"
    );
}

// ------------------------------------------------------------------------------------------
// The `emit_spike_fixtures` hand-off (section 4.8): one framed JSON block for the TypeScript
// oracles of unit SL-U2.

fn hex(value: f64) -> String {
    format!("\"{:016x}\"", value.to_bits())
}

fn json_points(points: &[Point]) -> String {
    let items: Vec<String> = points
        .iter()
        .map(|point| format!("[{},{}]", hex(point.x), hex(point.y)))
        .collect();
    format!("[{}]", items.join(","))
}

fn json_ranges(ranges: &[ContourRange]) -> String {
    let items: Vec<String> = ranges
        .iter()
        .map(|range| format!("[{},{}]", range.start, range.count))
        .collect();
    format!("[{}]", items.join(","))
}

fn json_owners(owners: &[EdgeOwner]) -> String {
    let items: Vec<String> = owners
        .iter()
        .map(|owner| match *owner {
            EdgeOwner::Line { source_verb } => {
                format!("{{\"kind\":\"line\",\"sourceVerb\":{source_verb}}}")
            }
            EdgeOwner::CubicLeaf {
                source_verb,
                end_numerator,
                depth,
            } => format!(
                "{{\"kind\":\"cubicLeaf\",\"sourceVerb\":{source_verb},\"endNumerator\":{end_numerator},\"depth\":{depth}}}"
            ),
            EdgeOwner::ImplicitClosure { contour } => {
                format!("{{\"kind\":\"implicitClosure\",\"contour\":{contour}}}")
            }
            EdgeOwner::ExplicitClose { source_verb } => {
                format!("{{\"kind\":\"explicitClose\",\"sourceVerb\":{source_verb}}}")
            }
        })
        .collect();
    format!("[{}]", items.join(","))
}

fn json_sources(sources: &[DecodedSource]) -> String {
    let items: Vec<String> = sources
        .iter()
        .map(|source| match *source {
            DecodedSource::Line {
                points,
                source_verb,
                contour,
            } => format!(
                "{{\"kind\":\"line\",\"sourceVerb\":{source_verb},\"contour\":{contour},\"points\":{}}}",
                json_points(&points)
            ),
            DecodedSource::Cubic {
                points,
                source_verb,
                contour,
            } => format!(
                "{{\"kind\":\"cubic\",\"sourceVerb\":{source_verb},\"contour\":{contour},\"points\":{}}}",
                json_points(&points)
            ),
        })
        .collect();
    format!("[{}]", items.join(","))
}

fn json_mesh(vertices: &[Point], triangles: &[[u32; 3]]) -> String {
    let items: Vec<String> = triangles
        .iter()
        .map(|[a, b, c]| format!("[{a},{b},{c}]"))
        .collect();
    format!(
        "{{\"vertices\":{},\"triangles\":[{}]}}",
        json_points(vertices),
        items.join(",")
    )
}

fn json_view(
    ranges: &[ContourRange],
    points: &[Point],
    owners: &[EdgeOwner],
    sources: &[DecodedSource],
) -> String {
    format!(
        "\"ranges\":{},\"points\":{},\"owners\":{},\"sources\":{}",
        json_ranges(ranges),
        json_points(points),
        json_owners(owners),
        json_sources(sources)
    )
}

fn json_outcome(result: Result<(), Reason>, stage: Stage, fast: &FastRung) -> String {
    let mesh = fast
        .mesh()
        .map_or_else(|| "null".to_owned(), |(v, t)| json_mesh(v, t));
    match result {
        Ok(()) => format!(
            "\"stop\":\"{stage:?}\",\"rung\":\"{}\",\"reason\":null,\"maxDeviationSquared\":{},\"mesh\":{mesh}",
            if fast.mesh().is_some() { "fast" } else { "none" },
            hex(fast.stats().max_deviation_squared)
        ),
        Err(reason) => format!(
            "\"stop\":\"{stage:?}\",\"rung\":\"fallback\",\"reason\":\"{}\",\"maxDeviationSquared\":null,\"mesh\":null",
            reason.code()
        ),
    }
}

/// One fixture entry of the hand-off: its view, expectation, stop and fast-rung outcome. The
/// seeded-defect entries run it inside `with_spike_fault`.
fn json_fixture(fixture: &Fixture) -> String {
    let expected = match fixture.expected {
        Expected::Fast {
            area,
            boundary,
            triangles,
        } => format!(
            "{{\"kind\":\"fast\",\"area\":{},\"boundary\":{boundary:?},\"triangles\":{}}}",
            hex(area),
            triangles.map_or_else(|| "null".to_owned(), |count| count.to_string())
        ),
        Expected::Fallback(reason) => {
            format!("{{\"kind\":\"fallback\",\"reason\":\"{}\"}}", reason.code())
        }
        Expected::Passes(stage) => format!("{{\"kind\":\"passes\",\"stage\":\"{stage:?}\"}}"),
    };
    let stop = match fixture.expected {
        Expected::Passes(stage) => stage,
        _ => Stage::Fr8,
    };
    let mut fast = FastRung::new();
    fast.load(fixture.view.view(), DELTA, fixture.rule).unwrap();
    let result = fast.run(stop);
    let view = &fixture.view;
    format!(
        "{{\"id\":\"{}\",\"kind\":\"view\",\"rule\":\"{}\",\"expected\":{expected},{},{}}}",
        fixture.id,
        rule_name(fixture.rule),
        json_view(&view.ranges, &view.points, &view.owners, &view.sources),
        json_outcome(result, stop, &fast)
    )
}

#[test]
#[ignore = "SL-U2 hand-off; run with --ignored --exact --nocapture"]
fn emit_spike_fixtures() {
    let mut out = String::new();
    let _ = write!(
        out,
        "{{\"schema\":\"p3-b0-spike-fixtures/1\",\"delta\":{},\"fixtures\":[",
        hex(DELTA)
    );
    for (index, fixture) in fixtures().iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&json_fixture(fixture));
    }
    // SL-F13: the two B0 fixture paths through the ladder, with the exact rung's output for
    // the SL-O3 comparison (the oracle run executes the exact rung on every path).
    let mut ladder = Box::new(SpikeLadder::new(LIMITS).expect("ladder"));
    let mut exact = CubicFillWorkspace::new_pre_b1(LIMITS).expect("workspace");
    for path in b0_fixture_paths() {
        let outcome = ladder.run(
            path.input(),
            path.entry,
            LineFillRule::Nonzero,
            TOPOLOGY_TOLERANCE,
            MAX_FLAT_COMMANDS,
        );
        let view = exact
            .prepare_for_spike(path.input(), MAX_FLAT_COMMANDS)
            .expect("prefix");
        let view_json = json_view(view.ranges, view.points, view.owners, view.sources);
        entry_attempt(&mut exact, path.entry, path.input()).expect("exact rung admits");
        let output = exact.output().expect("exact output");
        let exact_json = format!(
            "{{{},\"mesh\":{}}}",
            json_view(output.ranges, output.points, output.owners, output.sources),
            json_mesh(
                output.rounded.vertices,
                &output
                    .rounded
                    .indices
                    .chunks(3)
                    .map(|chunk| [chunk[0], chunk[1], chunk[2]])
                    .collect::<Vec<_>>()
            )
        );
        let result = match outcome.reason {
            None => Ok(()),
            Some(reason) => Err(reason),
        };
        let _ = write!(
            out,
            ",{{\"id\":\"SL-F13/{}\",\"kind\":\"ladder\",\"rule\":\"nonzero\",\"expected\":{{\"kind\":\"fast\",\"area\":null,\"boundary\":null,\"triangles\":null}},{view_json},{},\"exact\":{exact_json}}}",
            path.name,
            json_outcome(result, Stage::Fr8, ladder.fast())
        );
    }
    // The seeded defects of section 4.8 (SL-A5, the SL-U2 part): each defect's named fixtures
    // run under its fault switch, for the TypeScript oracles to reject. Added by SL-U2.
    out.push_str("],\"defects\":[");
    let defects: [(&str, &[&str], SpikeFault); 10] = [
        ("(1)", &["SL-F3"], SpikeFault::ClearanceGreaterEqual),
        ("(2)", &["SL-F11", "SL-F19"], SpikeFault::KnotErrorsOmitted),
        (
            "(3)",
            &["SL-F10", "SL-F10b"],
            SpikeFault::MonotoneChordsOnly,
        ),
        (
            "(4)",
            &["SL-F1", "SL-F3", "SL-F18"],
            SpikeFault::SimplicityOnly,
        ),
        ("(5)", &["SL-F12a"], SpikeFault::ConeInverted),
        (
            "(6)",
            &["SL-F6/nonzero"],
            SpikeFault::NestingFromOrientation,
        ),
        ("(7)", &["SL-F5/nonzero"], SpikeFault::TriangleFlipped),
        (
            "(8)",
            &["SL-F6/nonzero"],
            SpikeFault::NonBoundaryTriangulated,
        ),
        ("(9)", &["SL-F3"], SpikeFault::ScanBoundWithoutRadius),
        ("(10)", &["SL-F18"], SpikeFault::SkipTwoApart),
    ];
    let mut first = true;
    for (defect, ids, which) in defects {
        for id in ids {
            let fixture = fixture(id);
            // Defect (1) is ≥ together with `Fault::R1WideningRemoved` (section 4.8).
            let entry = if defect == "(1)" {
                with_fault(Fault::R1WideningRemoved, || {
                    with_spike_fault(which, || json_fixture(&fixture))
                })
            } else {
                with_spike_fault(which, || json_fixture(&fixture))
            };
            if !first {
                out.push(',');
            }
            first = false;
            let _ = write!(out, "{{\"defect\":\"{defect}\",\"entry\":{entry}}}");
        }
    }
    out.push_str("]}");
    println!("P3_B0_SPIKE_FIXTURES_BEGIN");
    println!("{out}");
    println!("P3_B0_SPIKE_FIXTURES_END");
}
