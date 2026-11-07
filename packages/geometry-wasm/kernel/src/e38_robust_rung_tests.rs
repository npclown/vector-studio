//! D9 rendering-track item E38 (`docs/plans/d9-e38-robust-path-rung-contract.md`): the robust
//! last rung of the fill and stroke exports. The fixtures are the user's pen paths that drew
//! nothing (node-3, node-5, node-6, node-7, node-8, the E35 hairpins); E38-A1 builds each at
//! `e = 0` to `-8` through the production entry points, E38-A2 compares every mesh with a
//! reference raster at seeded sample points, and E38-A3 is a seeded fuzz of pen-like paths
//! (large frames, short and hairpin handles, self-crossings, open and closed).

use crate::e14u2_fill_large_tier_tests::{built, engine, node3, node8};
use crate::e35_hairpin_retry_tests::{case, CASES};
use crate::fill_export::FillEngine;
use crate::fill_export::{PathOutcome, FILL_PATH_EMPTY};
use crate::geometry::{Point, VERB_CLOSE, VERB_CUBIC, VERB_LINE, VERB_MOVE};
use crate::line_fill::LineFillRule;
use crate::robust_mesh::{RobustMesh, RobustStroke, MAX_CHORDS};
use crate::stroke_outline::{StrokeCap, StrokeJoin, StrokeOutcome, StrokeWorkspace};
use crate::stroke_outline_tests::{request, PathSpec};

/// The user's node-5 (2026-11-07), 739 x 609 px, frame 24.79998779296875, 18.399993896484375.
pub(crate) fn user_node5() -> PathSpec {
    PathSpec::new()
        .m(209.60000610351562, 230.39999389648438)
        .c([
            210.39999389648435,
            279.20001220703125,
            176.79998779296875,
            275.1999816894531,
            240.00000000000003,
            340.0,
        ])
        .c([
            303.20001220703125,
            404.8000183105469,
            362.39996337890625,
            416.0,
            392.0,
            416.0,
        ])
        .c([
            421.6000366210938,
            416.0,
            480.00003051757807,
            432.8000183105469,
            299.20001220703125,
            363.20001220703125,
        ])
        .c([
            118.39999389648436,
            293.6000061035156,
            24.79998779296875,
            257.6000061035156,
            272.0,
            213.60000610351562,
        ])
        .c([
            519.2000122070312,
            169.60000610351562,
            764.0,
            18.399993896484375,
            547.2000122070312,
            199.1999969482422,
        ])
        .c([
            330.4000244140625,
            380.0,
            215.20001220703125,
            400.79998779296875,
            189.60000610351562,
            402.3999938964844,
        ])
        .c([
            164.0,
            404.0,
            36.79998779296875,
            347.20001220703125,
            164.0,
            419.20001220703125,
        ])
        .c([
            291.20001220703125,
            491.20001220703125,
            377.60003662109375,
            532.7999877929688,
            457.6000366210937,
            539.2000122070312,
        ])
        .c([
            537.6000366210938,
            545.6000366210938,
            534.4000854492188,
            554.4000244140625,
            605.6000366210938,
            542.4000244140625,
        ])
        .c([
            676.7999877929688,
            530.4000244140625,
            695.2000122070312,
            627.2000732421875,
            683.2000122070312,
            493.60003662109375,
        ])
        .c([
            671.2000122070312,
            360.0,
            755.2000122070312,
            236.79998779296875,
            526.4000244140625,
            214.39999389648435,
        ])
        .c([
            297.60003662109375,
            192.0,
            275.2000427246094,
            188.8000030517578,
            260.8000183105469,
            196.8000030517578,
        ])
        .c([
            246.39999389648438,
            204.8000030517578,
            254.39999389648438,
            204.80001831054688,
            241.60000610351565,
            212.80001831054688,
        ])
        .c([
            228.80001831054688,
            220.80001831054688,
            223.19998168945312,
            228.8000030517578,
            216.00000000000003,
            204.8000030517578,
        ])
        .c([
            208.80001831054688,
            180.8000030517578,
            209.60003662109378,
            167.1999969482422,
            208.80001831054688,
            179.1999969482422,
        ])
        .c([
            208.0,
            191.19999694824216,
            214.4000244140625,
            193.60000610351562,
            207.20001220703125,
            206.40000915527347,
        ])
        .c([
            200.0,
            219.20001220703125,
            190.4000244140625,
            223.20001220703128,
            199.20001220703125,
            229.60000610351565,
        ])
        .c([
            208.0,
            236.00000000000003,
            208.80001831054688,
            181.5999755859375,
            209.60000610351562,
            230.39999389648438,
        ])
        .z()
}

/// The user's node-7 (2026-11-07), 1240 x 733 px, frame -246.39996337890625, -51.20001220703125.
pub(crate) fn user_node7() -> PathSpec {
    PathSpec::new()
        .m(478.4000244140625, 143.19999694824216)
        .c([
            135.99999999999994,
            236.0,
            33.5999755859375,
            135.19998168945312,
            142.39999389648443,
            252.0,
        ])
        .c([
            251.20001220703125,
            368.8000183105469,
            112.0,
            323.2000122070312,
            246.39999389648438,
            387.2000122070313,
        ])
        .c([
            380.79998779296875,
            451.2000122070313,
            755.1999664306641,
            466.4000244140625,
            372.79998779296875,
            460.8000183105469,
        ])
        .c([
            -9.599990844726562,
            455.20001220703125,
            -72.0,
            396.79998779296875,
            193.60000610351568,
            384.0,
        ])
        .c([
            459.20001220703125,
            371.20001220703125,
            456.79998779296875,
            445.59997558593744,
            404.79998779296875,
            410.3999938964844,
        ])
        .c([
            352.79998779296875,
            375.20001220703125,
            661.6000366210938,
            -8.0,
            418.4000244140624,
            312.0,
        ])
        .c([
            175.20001220703125,
            632.0,
            -246.39996337890625,
            681.5999755859375,
            160.80001831054688,
            616.7999877929688,
        ])
        .c([
            568.0,
            552.0,
            622.4000244140625,
            583.2000122070312,
            642.4000244140625,
            559.2000122070312,
        ])
        .c([
            662.4000244140625,
            535.2000122070312,
            584.0000610351562,
            555.9999694824219,
            661.6000366210938,
            466.3999938964844,
        ])
        .c([
            739.2000122070311,
            376.8000183105469,
            991.2000122070312,
            412.79998779296875,
            798.4000244140625,
            322.3999938964844,
        ])
        .c([
            605.6000366210938,
            232.0,
            655.2000122070312,
            -51.20001220703125,
            571.2000122070312,
            227.20001220703125,
        ])
        .c([
            487.20001220703125,
            505.60003662109375,
            639.9999389648438,
            501.60003662109375,
            704.7999877929688,
            550.4000244140625,
        ])
        .c([
            769.6000366210938,
            599.2000122070312,
            804.0,
            624.0000610351562,
            814.4000244140625,
            597.6000366210938,
        ])
        .c([
            824.800048828125,
            571.2000122070312,
            884.0001220703125,
            559.1999816894531,
            859.2000732421875,
            480.79998779296875,
        ])
        .c([
            834.4000244140625,
            402.39999389648443,
            993.5999755859375,
            286.3999938964844,
            824.0,
            207.1999969482422,
        ])
        .c([
            654.4000244140625,
            128.0,
            594.4000244140625,
            116.00001525878906,
            546.4000244140625,
            98.40000915527344,
        ])
        .c([
            498.4000244140626,
            80.80000305175781,
            495.199951171875,
            70.40000915527344,
            496.79998779296875,
            79.20000457763672,
        ])
        .c([
            498.4000244140626,
            88.0,
            475.20001220703125,
            145.60000610351562,
            475.20001220703125,
            145.60000610351562,
        ])
        .c([
            475.20001220703125,
            145.60000610351562,
            820.800048828125,
            50.399993896484375,
            478.4000244140625,
            143.19999694824216,
        ])
        .z()
}

/// The fill engine and stroke workspace with the robust rung on, as in production (it is
/// opt-in in tests).
fn production() -> (FillEngine, StrokeWorkspace) {
    let mut fill = engine();
    fill.hooks().robust = true;
    let mut stroke = StrokeWorkspace::new().expect("workspace");
    stroke.defects_mut().robust = true;
    (fill, stroke)
}

/// Every fixture of the corpus: the user's paths in document coordinates.
fn corpus() -> Vec<(String, PathSpec)> {
    let mut paths = vec![
        ("node-3".to_string(), node3()),
        ("node-5b".to_string(), user_node5()),
        ("node-7b".to_string(), user_node7()),
        ("node-8".to_string(), node8()),
    ];
    for name in CASES {
        paths.push((format!("e35-{name}"), case(name)));
    }
    paths
}

/// xorshift64*, seeded; the fuzz is the same on every platform.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }

    fn range(&mut self, low: f64, high: f64) -> f64 {
        low + (high - low) * self.unit()
    }
}

/// A pen-like path: `n` cubics through random anchors in a `size` frame, each handle random,
/// short (within 1 px) or a hairpin (the first control on the start, the second past the end).
fn pen_path(rng: &mut Rng, size: f64, closed: bool) -> PathSpec {
    let n = 2 + (rng.next() % 24) as usize;
    let origin = (rng.range(-500.0, 500.0), rng.range(-500.0, 500.0));
    let anchor = |rng: &mut Rng| {
        (
            origin.0 + rng.range(0.0, size),
            origin.1 + {
                let height = size * rng.range(0.3, 1.0);
                rng.range(0.0, height)
            },
        )
    };
    let start = anchor(rng);
    let mut path = PathSpec::new().m(start.0, start.1);
    let mut current = start;
    for k in 0..n {
        let end = if closed && k == n - 1 {
            start
        } else {
            anchor(rng)
        };
        let kind = rng.next() % 4;
        let (c1, c2) = match kind {
            0 => (anchor(rng), anchor(rng)),
            1 => (
                (
                    current.0 + rng.range(-1.0, 1.0),
                    current.1 + rng.range(-1.0, 1.0),
                ),
                (end.0 + rng.range(-1.0, 1.0), end.1 + rng.range(-1.0, 1.0)),
            ),
            2 => (
                current,
                (
                    end.0 + (end.0 - current.0) * rng.range(0.0, 0.3),
                    end.1 + (end.1 - current.1) * rng.range(0.0, 0.3),
                ),
            ),
            _ => (
                (
                    current.0 + rng.range(-size, size) * 0.2,
                    current.1 + rng.range(-size, size) * 0.2,
                ),
                (
                    end.0 + rng.range(-size, size) * 0.2,
                    end.1 + rng.range(-size, size) * 0.2,
                ),
            ),
        };
        path = if rng.next().is_multiple_of(8) {
            path.l(end.0, end.1)
        } else {
            path.c([c1.0, c1.1, c2.0, c2.1, end.0, end.1])
        };
        current = end;
    }
    if closed {
        path = path.z();
    }
    path
}

/// The reference polylines: each subpath, uniformly subdivided (`REFERENCE_CHORDS` per cubic),
/// with its closed flag and its verb-boundary corners.
fn reference(path: &PathSpec) -> Lines {
    reference_with_error(path).0
}

const REFERENCE_CHORDS: usize = 256;

/// The reference and its chord error bound, `0.75 M / n^2` (Wang) over its cubics.
fn reference_with_error(path: &PathSpec) -> (Lines, f64) {
    let mut error = 0.0f64;
    let mut lines = Vec::new();
    let mut points: Vec<Point> = Vec::new();
    let mut corners: Vec<Point> = Vec::new();
    let mut index = 0usize;
    let p = |i: usize| Point {
        x: path.points[2 * i],
        y: path.points[2 * i + 1],
    };
    for &verb in &path.verbs {
        match verb {
            VERB_MOVE => {
                if !points.is_empty() {
                    lines.push((
                        std::mem::take(&mut points),
                        false,
                        std::mem::take(&mut corners),
                    ));
                }
                points.push(p(index));
                corners.push(p(index));
                index += 1;
            }
            VERB_LINE => {
                points.push(p(index));
                corners.push(p(index));
                index += 1;
            }
            VERB_CUBIC => {
                let c = [
                    *points.last().unwrap(),
                    p(index),
                    p(index + 1),
                    p(index + 2),
                ];
                index += 3;
                let second = |a: Point, b: Point, c: Point| {
                    (a.x - 2.0 * b.x + c.x).hypot(a.y - 2.0 * b.y + c.y)
                };
                let m = second(c[0], c[1], c[2]).max(second(c[1], c[2], c[3]));
                error = error.max(0.75 * m / (REFERENCE_CHORDS * REFERENCE_CHORDS) as f64);
                for k in 1..=REFERENCE_CHORDS {
                    let t = k as f64 / REFERENCE_CHORDS as f64;
                    let u = 1.0 - t;
                    points.push(Point {
                        x: u * u * u * c[0].x
                            + 3.0 * u * u * t * c[1].x
                            + 3.0 * u * t * t * c[2].x
                            + t * t * t * c[3].x,
                        y: u * u * u * c[0].y
                            + 3.0 * u * u * t * c[1].y
                            + 3.0 * u * t * t * c[2].y
                            + t * t * t * c[3].y,
                    });
                }
                corners.push(c[3]);
            }
            VERB_CLOSE => {
                lines.push((
                    std::mem::take(&mut points),
                    true,
                    std::mem::take(&mut corners),
                ));
            }
            _ => unreachable!(),
        }
    }
    if !points.is_empty() {
        lines.push((points, false, corners));
    }
    (lines, error)
}

fn winding(lines: &[(Vec<Point>, bool, Vec<Point>)], q: Point) -> i32 {
    let mut w = 0;
    for (points, _, _) in lines {
        for i in 0..points.len() {
            let (a, b) = (points[i], points[(i + 1) % points.len()]);
            if (a.y <= q.y) != (b.y <= q.y) {
                let x = a.x + (q.y - a.y) / (b.y - a.y) * (b.x - a.x);
                if x > q.x {
                    w += if b.y > a.y { 1 } else { -1 };
                }
            }
        }
    }
    w
}

fn segment_distance(q: Point, a: Point, b: Point) -> f64 {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let length = dx * dx + dy * dy;
    let t = if length > 0.0 {
        (((q.x - a.x) * dx + (q.y - a.y) * dy) / length).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (q.x - a.x - t * dx).hypot(q.y - a.y - t * dy)
}

/// Distance to the curve (`closed` subpaths include their closing chord).
fn curve_distance(lines: &[(Vec<Point>, bool, Vec<Point>)], q: Point, closing: bool) -> f64 {
    let mut best = f64::INFINITY;
    for (points, closed, _) in lines {
        let n = points.len();
        if n == 1 {
            best = best.min((q.x - points[0].x).hypot(q.y - points[0].y));
        }
        let segments = if *closed || closing { n } else { n - 1 };
        for i in 0..segments {
            best = best.min(segment_distance(q, points[i], points[(i + 1) % n]));
        }
    }
    best
}

fn inside_triangle(vertices: &[Point], t: &[u32], q: Point) -> bool {
    let (a, b, c) = (
        vertices[t[0] as usize],
        vertices[t[1] as usize],
        vertices[t[2] as usize],
    );
    let d1 = (b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x);
    let d2 = (c.x - b.x) * (q.y - b.y) - (c.y - b.y) * (q.x - b.x);
    let d3 = (a.x - c.x) * (q.y - c.y) - (a.y - c.y) * (q.x - c.x);
    (d1 >= 0.0 && d2 >= 0.0 && d3 >= 0.0) || (d1 <= 0.0 && d2 <= 0.0 && d3 <= 0.0)
}

fn covered(vertices: &[Point], triangles: &[u32], q: Point) -> bool {
    triangles
        .chunks_exact(3)
        .any(|t| inside_triangle(vertices, t, q))
}

/// A uniform grid over a mesh's triangles, for the sample loops.
struct Grid<'a> {
    vertices: &'a [Point],
    triangles: &'a [u32],
    origin: Point,
    cell: f64,
    size: usize,
    cells: Vec<Vec<u32>>,
}

impl<'a> Grid<'a> {
    fn new(vertices: &'a [Point], triangles: &'a [u32]) -> Self {
        let size = 128usize;
        let (mut x0, mut y0, mut x1, mut y1) = (
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        );
        for p in vertices {
            x0 = x0.min(p.x);
            y0 = y0.min(p.y);
            x1 = x1.max(p.x);
            y1 = y1.max(p.y);
        }
        let cell = ((x1 - x0).max(y1 - y0) / size as f64).max(1e-9);
        let mut grid = Self {
            vertices,
            triangles,
            origin: Point { x: x0, y: y0 },
            cell,
            size,
            cells: vec![Vec::new(); size * size],
        };
        for (index, t) in triangles.chunks_exact(3).enumerate() {
            let ps = t.iter().map(|&i| vertices[i as usize]);
            let (mut a, mut b, mut c, mut d) = (usize::MAX, 0usize, usize::MAX, 0usize);
            for p in ps {
                let (i, j) = grid.index(p);
                a = a.min(i);
                b = b.max(i);
                c = c.min(j);
                d = d.max(j);
            }
            for i in a..=b {
                for j in c..=d {
                    grid.cells[j * size + i].push(index as u32);
                }
            }
        }
        grid
    }

    fn index(&self, p: Point) -> (usize, usize) {
        let i = ((p.x - self.origin.x) / self.cell)
            .floor()
            .clamp(0.0, (self.size - 1) as f64);
        let j = ((p.y - self.origin.y) / self.cell)
            .floor()
            .clamp(0.0, (self.size - 1) as f64);
        (i as usize, j as usize)
    }

    fn covered(&self, q: Point) -> bool {
        if self.triangles.is_empty() {
            return false;
        }
        let (i, j) = self.index(q);
        self.cells[j * self.size + i].iter().any(|&t| {
            let t = t as usize * 3;
            inside_triangle(self.vertices, &self.triangles[t..t + 3], q)
        })
    }
}

fn bounds(path: &PathSpec) -> (f64, f64, f64, f64) {
    let xs = path.points.iter().step_by(2);
    let ys = path.points.iter().skip(1).step_by(2);
    (
        xs.clone().copied().fold(f64::INFINITY, f64::min),
        ys.clone().copied().fold(f64::INFINITY, f64::min),
        xs.copied().fold(f64::NEG_INFINITY, f64::max),
        ys.copied().fold(f64::NEG_INFINITY, f64::max),
    )
}

/// What a sample point should be, or `None` when it is within `margin` of an edge of the
/// region (where the tolerance lets either answer stand).
/// The reference polylines (points, closed, verb-boundary corners).
type Lines = Vec<(Vec<Point>, bool, Vec<Point>)>;

type Oracle<'a> = dyn Fn(Point) -> Option<bool> + 'a;

/// E38-A2: `samples` seeded points over the path's bounds grown by `grow`; returns the number
/// of points checked and the mismatches.
fn compare(
    rng: &mut Rng,
    path: &PathSpec,
    grow: f64,
    samples: usize,
    vertices: &[Point],
    triangles: &[u32],
    oracle: &Oracle<'_>,
) -> (usize, Vec<Point>) {
    let (x0, y0, x1, y1) = bounds(path);
    let mut checked = 0;
    let mut wrong = Vec::new();
    let grid = Grid::new(vertices, triangles);
    for _ in 0..samples {
        let q = Point {
            x: rng.range(x0 - grow, x1 + grow),
            y: rng.range(y0 - grow, y1 + grow),
        };
        let Some(expected) = oracle(q) else { continue };
        checked += 1;
        if grid.covered(q) != expected {
            wrong.push(q);
        }
    }
    (checked, wrong)
}

fn fill_oracle<'a>(
    lines: &'a [(Vec<Point>, bool, Vec<Point>)],
    rule: LineFillRule,
    margin: f64,
) -> impl Fn(Point) -> Option<bool> + 'a {
    move |q| {
        if curve_distance(lines, q, true) < margin {
            return None;
        }
        let w = winding(lines, q);
        Some(match rule {
            LineFillRule::Nonzero => w != 0,
            LineFillRule::Evenodd => w & 1 != 0,
        })
    }
}

/// The stroke region of width `2 r`: inside within `r - margin` of the curve, outside beyond
/// `r + margin`, except near a corner (a miter tip reaches `limit * r`) or an open end (caps).
fn stroke_oracle<'a>(
    lines: &'a [(Vec<Point>, bool, Vec<Point>)],
    r: f64,
    cap: StrokeCap,
    join: StrokeJoin,
    limit: f64,
    margin: f64,
) -> impl Fn(Point) -> Option<bool> + 'a {
    move |q| {
        let d = curve_distance(lines, q, false);
        let reach = match join {
            StrokeJoin::Miter => limit * r,
            _ => r,
        } + margin;
        let near_corner = lines.iter().any(|(points, closed, corners)| {
            let ends = if *closed {
                &[][..]
            } else {
                &[points[0], points[points.len() - 1]][..]
            };
            corners.iter().chain(ends).any(|c| {
                (q.x - c.x).hypot(q.y - c.y) < reach.max(r * std::f64::consts::SQRT_2 + margin)
            })
        });
        if d <= r - margin {
            // Inside the sweep, unless the point is past a butt end or behind a miter or bevel
            // corner (a bevel, or a miter past its limit, cuts the disk at the corner).
            if near_corner && (cap == StrokeCap::Butt || join != StrokeJoin::Round) {
                return None;
            }
            return Some(true);
        }
        if d >= r + margin {
            if near_corner {
                return None;
            }
            return Some(false);
        }
        None
    }
}

/// E38-A1 and E38-A2 on `paths` at `exponents`: fill (nonzero) and stroke (width 1, butt,
/// miter 4, the editor's default) through the production entry points; every build is a mesh,
/// and every robust mesh matches the reference raster at `samples` seeded points.
fn check_user_paths(
    paths: &[(String, PathSpec)],
    exponents: &[i32],
    samples: usize,
) -> (usize, usize) {
    let (mut fill, mut stroke) = production();
    let mut rng = Rng(0x0E38_0001);
    let mut robust = (0, 0);
    for (name, path) in paths {
        let (lines, reference_error) = reference_with_error(path);
        for &e in exponents {
            let tol = 2f64.powi(e - 1);
            let margin = 4.0 * tol + 2.0 * reference_error + 1e-9;
            let record = built(&mut fill, path, LineFillRule::Nonzero, e);
            assert_eq!(record.outcome, PathOutcome::Mesh, "{name} e={e} fill");
            if record.robust {
                robust.0 += 1;
                let (vertices, triangles, boundary) = fill.scratch_robust_mesh();
                assert!(boundary.is_empty());
                let oracle = fill_oracle(&lines, LineFillRule::Nonzero, margin);
                let (checked, wrong) =
                    compare(&mut rng, path, 4.0, samples, vertices, triangles, &oracle);
                assert!(checked > samples / 2, "{name} e={e} fill checked {checked}");
                assert!(
                    wrong.is_empty(),
                    "{name} e={e} fill wrong at {:?}",
                    &wrong[..wrong.len().min(4)]
                );
            }
            let outcome = stroke
                .build(
                    request(1.0, StrokeCap::Butt, StrokeJoin::Miter, 4.0, e),
                    &path.verbs,
                    &path.bytes(),
                )
                .expect("no internal error");
            assert_eq!(outcome, StrokeOutcome::Mesh, "{name} e={e} stroke");
            if stroke.robust_published() {
                robust.1 += 1;
                let (vertices, triangles, _) = stroke.mesh().expect("mesh");
                let oracle = stroke_oracle(
                    &lines,
                    0.5,
                    StrokeCap::Butt,
                    StrokeJoin::Miter,
                    4.0,
                    margin.max(0.05),
                );
                let (checked, wrong) =
                    compare(&mut rng, path, 4.0, samples, vertices, triangles, &oracle);
                assert!(checked > 0, "{name} e={e} stroke checked {checked}");
                assert!(
                    wrong.is_empty(),
                    "{name} e={e} stroke wrong at {:?}",
                    &wrong[..wrong.len().min(4)]
                );
            }
        }
    }
    robust
}

/// E38-A1 (CI part): the user's node-5 and node-7 (2026-11-07) at zoom 1 and DPR 1 or 1.25
/// to 2 (`e = -3`, `-4`) draw both paints, each through the robust rung.
#[test]
fn e38_user_node5_node7_draw_at_editor_exponents() {
    let paths: Vec<(String, PathSpec)> = corpus()
        .into_iter()
        .filter(|(name, _)| name == "node-5b" || name == "node-7b")
        .collect();
    let robust = check_user_paths(&paths, &[-3, -4], 150);
    // node-5's fill at -3 is exact; everything else here needs the rung.
    assert_eq!(robust, (3, 4));
}

/// E38-A1 (evidence): every corpus path at `e = 0` to `-8`, 600 samples per robust mesh.
#[test]
#[ignore = "E38 evidence, run by hand in release"]
fn e38_user_paths_always_draw() {
    let robust = check_user_paths(&corpus(), &[0, -1, -2, -3, -4, -5, -6, -7, -8], 600);
    println!("robust builds (fill, stroke): {robust:?}");
    assert!(robust.0 > 10 && robust.1 > 10, "robust builds {robust:?}");
}

/// E38-A3: a seeded fuzz of pen-like paths straight through the rung, every rule, cap and
/// join, compared with the reference raster near the stroke (`r` 0.5 to 8) and in the fill.
fn fuzz_rung(seed: u64, cases: usize, max_size: f64, samples: usize) {
    let mut rng = Rng(seed);
    let mut mesh = RobustMesh::new();
    mesh.reserve().expect("reserve");
    let caps = [StrokeCap::Butt, StrokeCap::Round, StrokeCap::Square];
    let joins = [StrokeJoin::Miter, StrokeJoin::Round, StrokeJoin::Bevel];
    for case in 0..cases {
        let size = rng.range(20.0, max_size);
        let closed = rng.next().is_multiple_of(2);
        let path = pen_path(&mut rng, size, closed);
        let (lines, reference_error) = reference_with_error(&path);
        let e = -((rng.next() % 9) as i32);
        let tol = 2f64.powi(e - 1);
        let margin = 4.0 * tol + 2.0 * reference_error + 1e-9 * size;
        let bytes = path.bytes();
        let rule = if rng.next().is_multiple_of(2) {
            LineFillRule::Nonzero
        } else {
            LineFillRule::Evenodd
        };
        let drawn = mesh
            .build_fill(&path.verbs, &bytes, rule, tol)
            .expect("fits");
        let (vertices, triangles, boundary) = mesh.mesh();
        assert!(boundary.is_empty());
        assert!(mesh.stats.chords <= MAX_CHORDS);
        let oracle = fill_oracle(&lines, rule, margin.max(mesh.stats.tolerance * 4.0));
        let (_, wrong) = compare(&mut rng, &path, 2.0, samples, vertices, triangles, &oracle);
        assert!(
            wrong.is_empty(),
            "case {case} fill {rule:?} e={e} drawn {drawn}: wrong at {:?}",
            &wrong[..wrong.len().min(4)]
        );
        let r = rng.range(0.5, 8.0);
        let (cap, join) = (
            caps[(rng.next() % 3) as usize],
            joins[(rng.next() % 3) as usize],
        );
        let limit = rng.range(1.0, 10.0);
        let style = RobustStroke {
            width: 2.0 * r,
            cap,
            join,
            miter_limit: limit,
        };
        let drawn = mesh
            .build_stroke(&path.verbs, &bytes, style, tol)
            .expect("fits");
        assert!(drawn, "case {case} stroke empty");
        let (vertices, triangles, _) = mesh.mesh();
        let used = 4.0 * mesh.stats.tolerance + 2.0 * reference_error + 1e-9 * size;
        let oracle = stroke_oracle(&lines, r, cap, join, limit, margin.max(used).max(0.02 * r));
        let (checked, wrong) = compare(
            &mut rng,
            &path,
            2.0 * r * limit,
            samples,
            vertices,
            triangles,
            &oracle,
        );
        assert!(
            wrong.is_empty(),
            "case {case} stroke r {r} {cap:?} {join:?} e={e} checked {checked}: wrong at {:?}",
            &wrong[..wrong.len().min(4)]
        );
        // Sample along the curve itself, where a thin stroke lives.
        let mut misses = Vec::new();
        let grid = Grid::new(vertices, triangles);
        for (points, _, _) in &lines {
            for _ in 0..40 {
                // A point inside a reference chord (not on a vertex, where adjacent trapezoids
                // meet on a shared edge and a point test can fall either way by one ulp).
                let i = (rng.next() % points.len() as u64) as usize;
                let (a, b) = (points[i], points[(i + 1) % points.len()]);
                let t = rng.range(0.1, 0.9);
                let p = Point {
                    x: a.x + (b.x - a.x) * t,
                    y: a.y + (b.y - a.y) * t,
                };
                if let Some(true) = oracle(p) {
                    if !grid.covered(p) {
                        misses.push(p);
                    }
                }
            }
        }
        assert!(
            misses.is_empty(),
            "case {case} stroke misses on the curve {:?} stats {:?} r {r} e {e} size {size}",
            &misses[..misses.len().min(4)],
            mesh.stats
        );
    }
}

#[test]
fn e38_fuzz_pen_paths_match_the_reference() {
    fuzz_rung(0x0E38_00F2, 12, 600.0, 120);
}

/// E38-A3 (evidence): 96 cases up to 2,500 px.
#[test]
#[ignore = "E38 evidence, run by hand in release"]
fn e38_fuzz_pen_paths_match_the_reference_full() {
    fuzz_rung(0x0E38_00F3, 96, 2500.0, 300);
}

/// E38-A4: the production entry points never refuse a fuzzed pen path (`work-limit` and
/// `unsupported-geometry` go to the rung), at the editor's exponents.
fn never_refuses(cases: usize) {
    let mut rng = Rng(0x0E38_00A4);
    let (mut fill, mut stroke) = production();
    for case in 0..cases {
        let size = rng.range(200.0, 2000.0);
        let closed = rng.next().is_multiple_of(2);
        let path = pen_path(&mut rng, size, closed);
        let e = -((rng.next() % 7) as i32);
        let record = built(&mut fill, &path, LineFillRule::Nonzero, e);
        assert!(
            record.outcome == PathOutcome::Mesh
                || record.outcome == PathOutcome::Status(FILL_PATH_EMPTY),
            "case {case} e={e} fill {record:?}"
        );
        let outcome = stroke
            .build(
                request(1.0, StrokeCap::Butt, StrokeJoin::Miter, 4.0, e),
                &path.verbs,
                &path.bytes(),
            )
            .expect("no internal error");
        assert_eq!(outcome, StrokeOutcome::Mesh, "case {case} e={e} stroke");
    }
}

#[test]
fn e38_fuzz_never_refuses() {
    never_refuses(3);
}

/// E38-A4 (evidence): 40 cases.
#[test]
#[ignore = "E38 evidence, run by hand in release"]
fn e38_fuzz_never_refuses_full() {
    never_refuses(40);
}

/// E38-R1: the rung's statistics on the corpus (chords, edges, trapezoids, coarsenings), for
/// the evidence record.
#[test]
#[ignore = "E38 evidence, run by hand in release"]
fn e38_measure_corpus() {
    let mut mesh = RobustMesh::new();
    mesh.reserve().expect("reserve");
    println!("engine bytes {}", mesh.allocated_bytes());
    for (name, path) in corpus() {
        let bytes = path.bytes();
        for e in [0, -2, -3, -4, -6, -8] {
            let tol = 2f64.powi(e - 1);
            let start = std::time::Instant::now();
            mesh.build_fill(&path.verbs, &bytes, LineFillRule::Nonzero, tol)
                .expect("fits");
            let fill = (mesh.stats, start.elapsed());
            let style = RobustStroke {
                width: 1.0,
                cap: StrokeCap::Butt,
                join: StrokeJoin::Miter,
                miter_limit: 4.0,
            };
            let start = std::time::Instant::now();
            mesh.build_stroke(&path.verbs, &bytes, style, tol)
                .expect("fits");
            let stroke = (mesh.stats, start.elapsed());
            println!(
                "{name}\te{e}\tfill chords {} trapezoids {} coarsen {} {:.1?}\tstroke chords {} edges {} trapezoids {} coarsen {} {:.1?}",
                fill.0.chords, fill.0.trapezoids, fill.0.coarsenings, fill.1,
                stroke.0.chords, stroke.0.edges, stroke.0.trapezoids, stroke.0.coarsenings, stroke.1
            );
        }
    }
}

/// E38-R4: a build allocates nothing (the reserved buffers only).
#[test]
fn e38_build_allocates_nothing() {
    let mut mesh = RobustMesh::new();
    mesh.reserve().expect("reserve");
    let path = user_node7();
    let bytes = path.bytes();
    let style = RobustStroke {
        width: 1.0,
        cap: StrokeCap::Round,
        join: StrokeJoin::Round,
        miter_limit: 4.0,
    };
    crate::allocation_test_support::start();
    let fill = mesh.build_fill(&path.verbs, &bytes, LineFillRule::Evenodd, 2f64.powi(-9));
    let stroke = mesh.build_stroke(&path.verbs, &bytes, style, 2f64.powi(-9));
    let allocations = crate::allocation_test_support::stop();
    assert_eq!((fill, stroke, allocations), (Some(true), Some(true), 0));
}
