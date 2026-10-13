//! B0R unit U2 oracles for the sweep-based pair candidates of the three topology pair loops
//! (docs/plans/p3-b0r-kernel-performance-contract.md sections 4 and 7: O3, O8 (3)-(6)).
//!
//! - O3(a), Lemma A: for random hull pairs whose section 4.2 boxes are separated,
//!   `closed_hulls_intersect` is false.
//! - O3(b): the pre-B0R all-pairs loops are kept as `cfg(test)` references inside
//!   `simple_cubic_topology.rs`. Whole workspaces run once with the reference loops and once
//!   with the sweep and must agree on the result, `stats()`, partners, crossings and the
//!   published output. The shadow mode additionally runs both loops from the same state for the
//!   real budget and for budgets around every reachable stopping point, so WorkLimit is
//!   compared at small `max_pairs` on every input. The full-size version runs the shadow mode
//!   over every O4 input (both corpora, every `CubicFillWorkspace` entry and the V2 cascade).
//! - O3(c): every pair whose reference body returned an error or changed state is in C.
//! - The candidate set and the Lemma B counter are also checked directly against their section
//!   4.2 and 4.4 definitions on synthetic boxes and candidate sets.
//!
//! The full-size runs are `#[ignore]` tests in the release profile, run by
//! `pnpm test:p3-fill-identity`; the ordinary tests are the smoke versions.
use std::thread;
use std::time::Instant;

use crate::fill_filter_tests::{parallel, pow2, share, Rng, ORACLE_SHARDS, THREAD_STACK_BYTES};
use crate::geometry::{Point, Provenance};
use crate::p3_b0r_identity::{read_b0, read_file, read_random, run_chunk};
use crate::simple_cubic_topology::{
    b0r_take_shadow_tally, b0r_test_candidate_pairs, b0r_test_emulated_counter, b0r_test_lemma_a,
    b0r_test_point, b0r_test_restrict, b0r_with_pair_loop_mode, b0r_with_sweep_fault,
    B0rPairLoopMode, B0rShadowTally, B0rTestPoint, RoundedKnotCubicTopologyWorkspace,
    SimpleCubicTopologyWorkspace, SweepFault, TopologyCubic, TopologyError, TopologyInput,
    TopologyLeaf, TopologyLimits, TopologyRange, TransverseArrangementWorkspace,
};

const MAX_LEAVES: usize = 64;
const MAX_CUBICS: usize = 16;
const MAX_CONTOURS: usize = 4;

// ---------------------------------------------------------------------------------------------
// O3(a): Lemma A on random hull pairs.

#[derive(Clone, Copy, Debug, Default)]
struct LemmaTally {
    cases: u64,
    separated: u64,
    overlapping: u64,
    overlapping_disjoint: u64,
    unboxed: u64,
    zero_touch: u64,
    violations: u64,
}

impl LemmaTally {
    fn merge(&mut self, other: Self) {
        self.cases += other.cases;
        self.separated += other.separated;
        self.overlapping += other.overlapping;
        self.overlapping_disjoint += other.overlapping_disjoint;
        self.unboxed += other.unboxed;
        self.zero_touch += other.zero_touch;
        self.violations += other.violations;
    }
}

fn source_cubic(rng: &mut Rng) -> [Point; 4] {
    let exponent = rng.range_i32(-60, 60);
    let center = [
        rng.scaled(exponent + 3, true),
        rng.scaled(exponent + 3, true),
    ];
    core::array::from_fn(|_| Point {
        x: center[0] + rng.scaled_in(exponent - 6, exponent, true),
        y: center[1] + rng.scaled_in(exponent - 6, exponent, true),
    })
}

fn restricted(rng: &mut Rng, source: [Point; 4]) -> Vec<B0rTestPoint> {
    let depth = rng.below(21) as u32;
    let end = 1 + rng.below(1u64 << depth) as u32;
    b0r_test_restrict(source, end, depth).to_vec()
}

fn bounds(points: &[Point]) -> (f64, f64, f64, f64) {
    points.iter().fold(
        (
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
        ),
        |(x_lo, x_hi, y_lo, y_hi), point| {
            (
                x_lo.min(point.x),
                x_hi.max(point.x),
                y_lo.min(point.y),
                y_hi.max(point.y),
            )
        },
    )
}

/// Two random points inside the source's coordinate box, as the actual chord of a rounded leaf.
fn with_actual(
    rng: &mut Rng,
    mut points: Vec<B0rTestPoint>,
    source: &[Point; 4],
) -> Vec<B0rTestPoint> {
    let (x_lo, x_hi, y_lo, y_hi) = bounds(source);
    for _ in 0..2 {
        let s = rng.below(1025) as f64 / 1024.0;
        let t = rng.below(1025) as f64 / 1024.0;
        points.push(b0r_test_point(Point {
            x: x_lo + (x_hi - x_lo) * s,
            y: y_lo + (y_hi - y_lo) * t,
        }));
    }
    points
}

fn shifted(source: [Point; 4], dx: f64, dy: f64) -> [Point; 4] {
    source.map(|point| Point {
        x: point.x + dx,
        y: point.y + dy,
    })
}

/// A leaf touching the axis x = 0 (or y = 0) at `(0, y0)` from one side: the enclosure of an
/// exact zero is the point interval 0, so two such leaves have boxes that touch exactly there.
fn zero_touch_leaf(
    rng: &mut Rng,
    sign: f64,
    y0: f64,
    count: usize,
    swap: bool,
) -> Vec<B0rTestPoint> {
    let exponent = rng.range_i32(-20, 20);
    let mut points = vec![Point { x: 0.0, y: y0 }];
    while points.len() < count {
        points.push(Point {
            x: sign * rng.scaled(exponent, false),
            y: y0 + rng.scaled(exponent, true),
        });
    }
    points
        .into_iter()
        .map(|point| {
            b0r_test_point(if swap {
                Point {
                    x: point.y,
                    y: point.x,
                }
            } else {
                point
            })
        })
        .collect()
}

/// One random hull pair; `true` when it is a zero-touch pair.
fn lemma_pair(rng: &mut Rng) -> (Vec<B0rTestPoint>, Vec<B0rTestPoint>, bool) {
    match rng.below(10) {
        0..=5 => {
            // Shifted copies of one source cubic, separated by a gap that is zero, tiny, small
            // or negative (overlapping), along x or y, in either direction.
            let source = source_cubic(rng);
            let (x_lo, x_hi, y_lo, y_hi) = bounds(&source);
            let along_x = rng.chance(1, 2);
            let span = if along_x { x_hi - x_lo } else { y_hi - y_lo };
            let gap = match rng.below(8) {
                0 => 0.0,
                1 => span * pow2(-40),
                2 => span * pow2(-rng.range_i32(1, 20)),
                3 => -span * pow2(-rng.range_i32(1, 20)),
                _ => span * rng.below(4) as f64 / 4.0,
            };
            let direction = if rng.chance(1, 2) { 1.0 } else { -1.0 };
            let offset = direction * (span + gap);
            let across = if rng.chance(1, 2) {
                0.0
            } else {
                span * (rng.below(9) as f64 - 4.0) / 4.0
            };
            let other = if along_x {
                shifted(source, offset, across)
            } else {
                shifted(source, across, offset)
            };
            let mut left = restricted(rng, source);
            let mut right = restricted(rng, other);
            if rng.chance(1, 2) {
                left = with_actual(rng, left, &source);
            }
            if rng.chance(1, 2) {
                right = with_actual(rng, right, &other);
            }
            (left, right, false)
        }
        6 => {
            let y0 = if rng.chance(1, 4) {
                0.0
            } else {
                rng.scaled_in(-10, 10, true)
            };
            let swap = rng.chance(1, 2);
            let left_count = if rng.chance(1, 2) { 4 } else { 6 };
            let right_count = if rng.chance(1, 2) { 4 } else { 6 };
            let left = zero_touch_leaf(rng, -1.0, y0, left_count, swap);
            let right = zero_touch_leaf(rng, 1.0, y0, right_count, swap);
            (left, right, true)
        }
        7 => {
            // Collinear and coincident controls: degenerate hulls of one or two points.
            let base = Point {
                x: rng.finite(-30, 30),
                y: rng.finite(-30, 30),
            };
            let step = Point {
                x: rng.scaled_in(-30, 10, true),
                y: rng.scaled_in(-30, 10, true),
            };
            let line = |start: f64| {
                [0.0, 1.0, 2.0, 3.0].map(|t: f64| Point {
                    x: base.x + step.x * (start + t),
                    y: base.y + step.y * (start + t),
                })
            };
            let coincident = rng.chance(1, 3);
            let left = if coincident { [base; 4] } else { line(0.0) };
            let right = line(3.0 + rng.below(3) as f64);
            (
                left.map(b0r_test_point).to_vec(),
                right.map(b0r_test_point).to_vec(),
                false,
            )
        }
        8 => {
            // Subnormal and extreme coordinates: some enclosures are unavailable.
            let mut point = || {
                b0r_test_point(Point {
                    x: rng.finite(-1074, 1000),
                    y: rng.finite(-1074, 1000),
                })
            };
            let left = (0..4).map(|_| point()).collect();
            let right = (0..4).map(|_| point()).collect();
            (left, right, false)
        }
        _ => {
            let left_source = source_cubic(rng);
            let right_source = source_cubic(rng);
            (
                restricted(rng, left_source),
                restricted(rng, right_source),
                false,
            )
        }
    }
}

fn lemma_cases(seed: u64, count: u64) -> LemmaTally {
    let mut rng = Rng::new(seed);
    let mut tally = LemmaTally::default();
    for _ in 0..count {
        let (left, right, zero_touch) = lemma_pair(&mut rng);
        let (overlap, intersect) = b0r_test_lemma_a(&left, &right);
        tally.cases += 1;
        tally.zero_touch += u64::from(zero_touch);
        match overlap {
            None => tally.unboxed += 1,
            Some(true) => {
                tally.overlapping += 1;
                tally.overlapping_disjoint += u64::from(!intersect);
            }
            Some(false) => {
                tally.separated += 1;
                if intersect {
                    tally.violations += 1;
                }
            }
        }
    }
    tally
}

fn lemma_run(seed: u64, count: u64, shards: usize) -> LemmaTally {
    let mut total = LemmaTally::default();
    for tally in parallel(shards, move |shard| {
        lemma_cases(
            seed ^ ((shard as u64 + 1) << 32),
            share(count, shards, shard),
        )
    }) {
        total.merge(tally);
    }
    total
}

#[test]
fn b0r_o3a_smoke_lemma_a() {
    let tally = lemma_run(0x4230_5232_0001, 20_000, 4);
    println!("B0R O3(a) smoke: {tally:?}");
    assert_eq!(tally.violations, 0, "{tally:?}");
    assert!(tally.separated >= 10_000, "{tally:?}");
    assert!(
        tally.overlapping_disjoint > 0 && tally.unboxed > 0,
        "{tally:?}"
    );
}

/// O3(a) at full size: at least 10^6 separated hull pairs, zero violations.
#[test]
#[ignore = "B0R O3 full size; release profile via pnpm test:p3-fill-identity"]
fn b0r_oracle_full_o3a_lemma_a() {
    let start = Instant::now();
    let tally = lemma_run(0x4230_5232_0002, 2_000_000, ORACLE_SHARDS);
    println!(
        "B0R O3(a) full: {tally:?}, {} shards, {:.1} s",
        ORACLE_SHARDS,
        start.elapsed().as_secs_f64()
    );
    assert_eq!(tally.violations, 0, "{tally:?}");
    assert!(tally.separated >= 1_000_000, "{tally:?}");
}

// ---------------------------------------------------------------------------------------------
// Section 4.2-4.4 definitions on synthetic data.

type SyntheticBox = Option<[f64; 4]>;

fn synthetic_case(rng: &mut Rng) -> (Vec<SyntheticBox>, Vec<TopologyRange>) {
    let leaf_count = 1 + rng.below(MAX_LEAVES as u64) as usize;
    let mut contours = Vec::new();
    let mut start = 0usize;
    while start < leaf_count {
        let remaining = leaf_count - start;
        let count = if contours.len() == MAX_CONTOURS - 1 {
            remaining
        } else {
            1 + rng.below(remaining as u64) as usize
        };
        contours.push(TopologyRange { start, count });
        start += count;
    }
    // Small integer and signed-zero endpoints, so equal (touching) endpoints are frequent.
    let endpoint = |rng: &mut Rng| match rng.below(6) {
        0 => 0.0,
        1 => -0.0,
        _ => rng.range_i32(-4, 4) as f64,
    };
    let boxes = (0..leaf_count)
        .map(|_| {
            if rng.chance(1, 20) {
                return None;
            }
            let x = endpoint(rng);
            let y = endpoint(rng);
            let width = rng.below(3) as f64;
            let height = rng.below(3) as f64;
            Some([x, x + width, y, y + height])
        })
        .collect();
    (boxes, contours)
}

/// C by section 4.2, brute force: forced pairs, closed box overlap, and unboxed leaves.
fn reference_candidates(boxes: &[SyntheticBox], contours: &[TopologyRange]) -> Vec<(usize, usize)> {
    let contour_of = |leaf: usize| {
        contours
            .iter()
            .position(|range| (range.start..range.start + range.count).contains(&leaf))
            .unwrap()
    };
    let mut pairs = Vec::new();
    for left in 0..boxes.len() {
        for right in left + 1..boxes.len() {
            let contour = contour_of(left);
            let range = contours[contour];
            let forced = contour == contour_of(right) && {
                let (a, b) = (left - range.start, right - range.start);
                b == a + 1 || (a == 0 && b == range.count - 1)
            };
            let overlap = match (boxes[left], boxes[right]) {
                (Some(p), Some(q)) => p[0] <= q[1] && q[0] <= p[1] && p[2] <= q[3] && q[2] <= p[3],
                _ => true,
            };
            if forced || overlap {
                pairs.push((left, right));
            }
        }
    }
    pairs
}

fn candidate_mismatches(seed: u64, count: u64) -> (u64, u64) {
    let mut rng = Rng::new(seed);
    let mut mismatches = 0;
    let mut pairs = 0;
    for _ in 0..count {
        let (boxes, contours) = synthetic_case(&mut rng);
        let expected = reference_candidates(&boxes, &contours);
        pairs += expected.len() as u64;
        if b0r_test_candidate_pairs(&boxes, &contours) != expected {
            mismatches += 1;
        }
    }
    (mismatches, pairs)
}

/// Section 4.2-4.4: the sweep's candidates, in processing order, equal C in lexicographic order.
#[test]
fn b0r_o3_candidate_set_matches_definition() {
    let (mismatches, pairs) = candidate_mismatches(0x4230_5232_0003, 20_000);
    println!("B0R candidate set: 20000 cases, {pairs} candidate pairs, {mismatches} mismatches");
    assert_eq!(mismatches, 0);
    assert!(pairs > 0);
}

fn reference_counter(
    leaf_count: usize,
    failing: Option<(usize, usize)>,
    max_pairs: usize,
) -> (Result<(), TopologyError>, usize) {
    let mut pairs = 0usize;
    for left in 0..leaf_count {
        for right in left + 1..leaf_count {
            if pairs == max_pairs {
                return (Err(TopologyError::WorkLimit), pairs);
            }
            pairs += 1;
            if failing == Some((left, right)) {
                return (Err(TopologyError::Unresolved), pairs);
            }
        }
    }
    (Ok(()), pairs)
}

fn counter_mismatches(seed: u64, count: u64) -> (u64, u64, u64) {
    let mut rng = Rng::new(seed);
    let mut mismatches = 0;
    let mut work_limits = 0;
    let mut failures = 0;
    for _ in 0..count {
        let leaf_count = rng.below(MAX_LEAVES as u64 + 1) as usize;
        let total = leaf_count * leaf_count.saturating_sub(1) / 2;
        let density = 1 + rng.below(8);
        let mut candidates = Vec::new();
        for left in 0..leaf_count {
            for right in left + 1..leaf_count {
                if rng.chance(density, 8) {
                    candidates.push((left, right));
                }
            }
        }
        let failing = if !candidates.is_empty() && rng.chance(1, 2) {
            Some(candidates[rng.below(candidates.len() as u64) as usize])
        } else {
            None
        };
        let max_pairs = rng.below(total as u64 + 3) as usize;
        let expected = reference_counter(leaf_count, failing, max_pairs);
        match expected.0 {
            Err(TopologyError::WorkLimit) => work_limits += 1,
            Err(_) => failures += 1,
            Ok(()) => {}
        }
        if b0r_test_emulated_counter(leaf_count, &candidates, failing, max_pairs) != expected {
            mismatches += 1;
        }
    }
    (mismatches, work_limits, failures)
}

/// Lemma B: the emulated counter gives the pre-B0R loop's result and `pairs`.
#[test]
fn b0r_o3_lemma_b_counter_matches_reference_loop() {
    let (mismatches, work_limits, failures) = counter_mismatches(0x4230_5232_0004, 50_000);
    println!(
        "B0R Lemma B: 50000 cases, {work_limits} WorkLimit, {failures} body failures, \
         {mismatches} mismatches"
    );
    assert_eq!(mismatches, 0);
    assert!(work_limits > 1_000 && failures > 1_000);
}

// ---------------------------------------------------------------------------------------------
// O3(b) and O3(c) on whole workspaces: seeded random topology inputs.

struct Scene {
    family: u64,
    contours: Vec<TopologyRange>,
    cubics: Vec<TopologyCubic>,
    leaves: Vec<TopologyLeaf>,
    kinds: Vec<bool>,
}

impl Scene {
    fn input(&self) -> TopologyInput<'_> {
        TopologyInput {
            contours: &self.contours,
            cubics: &self.cubics,
            leaves: &self.leaves,
        }
    }
}

type Grid = [i64; 2];

/// Exact Bernstein evaluation at k / 2^depth of integer controls, times a power of two.
fn evaluate(controls: [Grid; 4], k: i64, depth: u32, scale: f64) -> Point {
    let s = 1i64 << depth;
    let weights = [
        (s - k).pow(3),
        3 * (s - k).pow(2) * k,
        3 * (s - k) * k * k,
        k.pow(3),
    ];
    let axis = |index: usize| {
        let numerator: i64 = (0..4).map(|i| weights[i] * controls[i][index]).sum();
        numerator as f64 / (s * s * s) as f64 * scale
    };
    Point {
        x: axis(0),
        y: axis(1),
    }
}

fn scaled_point(point: Grid, scale: f64) -> Point {
    Point {
        x: point[0] as f64 * scale,
        y: point[1] as f64 * scale,
    }
}

/// Seeded families: separated rings, nested rings, overlapping and star polygons with
/// crossings, contours touching at the origin, thin slivers, tiny (subnormal) and random
/// magnitudes. Leaves are exact dyadic restrictions, sometimes with perturbed actual ends.
fn scene(rng: &mut Rng) -> Scene {
    let family = rng.below(8);
    // Clean families draw near-regular polygons of at least five vertices, whose turns stay
    // below 90 degrees, so the rounded and arrangement certificates also succeed.
    let clean = matches!(family, 0 | 1 | 5 | 6);
    let contour_count = match family {
        7 => 1,
        0 | 1 | 5 | 6 => 1 + rng.below(3) as usize,
        _ => 1 + rng.below(MAX_CONTOURS as u64) as usize,
    };
    let reserve = if clean { 5 } else { 3 };
    let scale = match family {
        5 => pow2(-1070 + rng.range_i32(0, 6)),
        6 => pow2(rng.range_i32(-60, 60)),
        _ => pow2(rng.range_i32(-8, 4)),
    };
    let mut scene = Scene {
        family,
        contours: Vec::new(),
        cubics: Vec::new(),
        leaves: Vec::new(),
        kinds: Vec::new(),
    };
    for contour in 0..contour_count {
        let remaining_contours = contour_count - contour - 1;
        let cubic_room = MAX_CUBICS - scene.cubics.len() - reserve * remaining_contours;
        // Family 7: the first contour is a star polygon {5/2}, {9/2} or {11/2} of line cubics,
        // whose nonadjacent edges cross transversally; {5/2} turns too sharply for the rounded
        // certificate.
        let star = (family == 7 && contour == 0).then(|| match rng.below(3) {
            0 => (5usize, 2usize),
            1 => (9, 2),
            _ => (11, 2),
        });
        // Other contours have at least three distinct vertices (five when clean), except in
        // family 2, which also draws degenerate two-vertex contours.
        let explicit_close = star.is_some() || rng.chance(1, 2);
        let minimum = match (family, clean, explicit_close) {
            (2, _, _) => 1,
            (_, true, true) => 5,
            (_, true, false) => 4,
            (_, false, true) => 3,
            (_, false, false) => 2,
        };
        let cubic_count = match star {
            Some((points, _)) => points,
            None => minimum + rng.below((cubic_room.min(6) + 1 - minimum) as u64) as usize,
        };
        let explicit_close = explicit_close && cubic_count >= 2;
        let vertex_count = if explicit_close {
            cubic_count
        } else {
            cubic_count + 1
        };
        let radius = 20 + rng.below(100) as i64;
        let center: Grid = match family {
            0 => [contour as i64 * 300, rng.range_i32(-20, 20) as i64],
            1 => [0, 0],
            _ => [
                rng.range_i32(-100, 100) as i64,
                rng.range_i32(-100, 100) as i64,
            ],
        };
        let radius = if family == 1 {
            30 * (contour as i64 + 1) + rng.below(10) as i64
        } else {
            radius
        };
        let mut angles: Vec<f64> = (0..vertex_count)
            .map(|index| {
                let turn = if clean {
                    (index as f64 + rng.below(300) as f64 / 1000.0) / vertex_count as f64
                } else {
                    rng.below(3600) as f64 / 3600.0
                };
                turn * core::f64::consts::TAU
            })
            .collect();
        if family != 2 {
            angles.sort_by(f64::total_cmp);
        }
        let mut vertices: Vec<Grid> = angles
            .iter()
            .map(|angle| {
                let (sin, cos) = angle.sin_cos();
                let squash = if family == 4 { 8 } else { 1 };
                [
                    center[0] + (radius as f64 * cos).round() as i64,
                    center[1] + (radius as f64 * sin / squash as f64).round() as i64,
                ]
            })
            .collect();
        if let Some((points, step)) = star {
            for (index, vertex) in vertices.iter_mut().enumerate() {
                let angle = (index * step % points) as f64 / points as f64 * core::f64::consts::TAU;
                let (sin, cos) = angle.sin_cos();
                *vertex = [
                    center[0] + (100.0 * cos).round() as i64,
                    center[1] + (100.0 * sin).round() as i64,
                ];
            }
        }
        if family == 3 {
            // Every contour is a convex fan with its first vertex at the origin and the others on an
            // arc inside its own quadrant, so contours touch exactly at the origin.
            let base = contour as f64 * core::f64::consts::FRAC_PI_2;
            let count = vertices.len() - 1;
            vertices[0] = [0, 0];
            for (index, vertex) in vertices[1..].iter_mut().enumerate() {
                let angle = base
                    + (0.1 + 0.8 * (index as f64 + 0.5) / count as f64)
                        * core::f64::consts::FRAC_PI_2;
                let (sin, cos) = angle.sin_cos();
                *vertex = [
                    (radius as f64 * cos).round() as i64,
                    (radius as f64 * sin).round() as i64,
                ];
            }
        }
        if explicit_close {
            let first = vertices[0];
            vertices.push(first);
        }

        let first_cubic = scene.cubics.len();
        for index in 0..cubic_count {
            let a = vertices[index];
            let b = vertices[index + 1];
            let d = [b[0] - a[0], b[1] - a[1]];
            let shape = match family {
                2 => rng.below(5),
                7 => 1,
                _ => rng.below(4),
            };
            let (p1, p2, adapter) = match shape {
                0 => (a, b, true),
                1 | 2 => (
                    [a[0] + d[0] / 3, a[1] + d[1] / 3],
                    [a[0] + 2 * d[0] / 3, a[1] + 2 * d[1] / 3],
                    false,
                ),
                3 => {
                    let bulge = rng.range_i32(-8, 8) as i64;
                    (
                        [
                            a[0] + d[0] / 3 - d[1] * bulge / 32,
                            a[1] + d[1] / 3 + d[0] * bulge / 32,
                        ],
                        [
                            a[0] + 2 * d[0] / 3 - d[1] * bulge / 32,
                            a[1] + 2 * d[1] / 3 + d[0] * bulge / 32,
                        ],
                        false,
                    )
                }
                _ => (
                    [
                        center[0] + rng.range_i32(-120, 120) as i64,
                        center[1] + rng.range_i32(-120, 120) as i64,
                    ],
                    [
                        center[0] + rng.range_i32(-120, 120) as i64,
                        center[1] + rng.range_i32(-120, 120) as i64,
                    ],
                    false,
                ),
            };
            let controls = [a, p1, p2, b];
            let leaf_room = MAX_LEAVES.saturating_sub(
                scene.leaves.len() + remaining_contours * 3 + 1 + (cubic_count - index - 1),
            );
            let mut depth = rng.below(4) as u32;
            while depth > 0 && (1usize << depth) > leaf_room {
                depth -= 1;
            }
            let source_verb = scene.cubics.len() as u32 + 1;
            let leaf_start = scene.leaves.len();
            let count = 1u32 << depth;
            for k in 1..=count {
                let mut end = evaluate(controls, i64::from(k), depth, scale);
                if k < count && !matches!(family, 0 | 3) && rng.chance(1, 6) {
                    end.x += (rng.range_i32(-2, 2) as f64) * scale / 4.0;
                    end.y += (rng.range_i32(-2, 2) as f64) * scale / 4.0;
                }
                scene.leaves.push(TopologyLeaf {
                    end,
                    provenance: Provenance {
                        source_verb,
                        end_numerator: k,
                        depth,
                    },
                });
            }
            scene.cubics.push(TopologyCubic {
                points: controls.map(|point| scaled_point(point, scale)),
                source_verb,
                leaves: TopologyRange {
                    start: leaf_start,
                    count: count as usize,
                },
            });
            scene
                .kinds
                .push(adapter && depth == 0 && a != b && rng.chance(1, 2));
        }
        scene.contours.push(TopologyRange {
            start: first_cubic,
            count: cubic_count,
        });
    }
    scene
}

#[derive(Clone, Copy, Debug, Default)]
struct DiffTally {
    scenes: u64,
    calls: u64,
    mismatches: u64,
    allocating_calls: u64,
    ok: u64,
    unresolved: u64,
    work_limit: u64,
    knot_mismatch: u64,
    other_error: u64,
    crossing_records: u64,
    shadow: B0rShadowTally,
}

impl DiffTally {
    fn merge(&mut self, other: Self) {
        self.scenes += other.scenes;
        self.calls += other.calls;
        self.mismatches += other.mismatches;
        self.allocating_calls += other.allocating_calls;
        self.ok += other.ok;
        self.unresolved += other.unresolved;
        self.work_limit += other.work_limit;
        self.knot_mismatch += other.knot_mismatch;
        self.other_error += other.other_error;
        self.crossing_records += other.crossing_records;
        self.shadow.merge(other.shadow);
    }
}

struct Workspaces {
    simple: SimpleCubicTopologyWorkspace,
    rounded: RoundedKnotCubicTopologyWorkspace,
    transverse: TransverseArrangementWorkspace,
}

impl Workspaces {
    fn new(limits: TopologyLimits) -> Self {
        Self {
            simple: SimpleCubicTopologyWorkspace::new(limits).unwrap(),
            rounded: RoundedKnotCubicTopologyWorkspace::new(limits).unwrap(),
            transverse: TransverseArrangementWorkspace::new(limits).unwrap(),
        }
    }
}

/// One observation per certify call: result, stats, published output and partners, rendered
/// with `Debug` (f64 values in shortest round-trip form, signed zeros included).
struct Observation {
    text: String,
    result: Result<(), TopologyError>,
    crossings: usize,
    allocations: usize,
}

fn measured<T>(action: impl FnOnce() -> T) -> (T, usize) {
    crate::allocation_test_support::start();
    let value = action();
    (value, crate::allocation_test_support::stop())
}

fn observe(workspaces: &mut Workspaces, scene: &Scene) -> [Observation; 5] {
    let input = scene.input();
    let (simple, simple_allocations) = measured(|| workspaces.simple.certify(input));
    let simple = Observation {
        text: format!(
            "{simple:?} {:?} {:?}",
            workspaces.simple.stats(),
            workspaces.simple.output()
        ),
        result: simple,
        crossings: 0,
        allocations: simple_allocations,
    };
    let (rounded, rounded_allocations) = measured(|| workspaces.rounded.certify(input));
    let rounded = Observation {
        text: format!(
            "{rounded:?} {:?} {:?}",
            workspaces.rounded.stats(),
            workspaces.rounded.output()
        ),
        result: rounded,
        crossings: 0,
        allocations: rounded_allocations,
    };
    let mut arrangement = |index: usize| {
        let transverse = &mut workspaces.transverse;
        let (result, allocations) = measured(|| match index {
            0 => transverse.certify(input),
            1 => transverse.certify_mixed(input, &scene.kinds),
            _ => transverse.certify_triangle_free(input, &scene.kinds),
        });
        let crossings = transverse
            .output()
            .map_or(0, |output| output.crossings.len());
        Observation {
            text: format!(
                "{result:?} {:?} {:?} {:?}",
                transverse.stats(),
                transverse.output(),
                transverse.b0r_partners()
            ),
            result,
            crossings,
            allocations,
        }
    };
    let transverse = arrangement(0);
    let mixed = arrangement(1);
    let triangle_free = arrangement(2);
    [simple, rounded, transverse, mixed, triangle_free]
}

/// Runs `count` seeded scenes; each scene runs the five certify calls with the reference loops,
/// with the sweep and in shadow mode, on fresh workspaces with one budget (the default 2,016
/// or a small random `max_pairs`), and compares the three.
fn scene_differential(seed: u64, count: u64) -> DiffTally {
    let mut rng = Rng::new(seed);
    let mut tally = DiffTally::default();
    b0r_take_shadow_tally();
    for _ in 0..count {
        let scene = scene(&mut rng);
        let leaves = scene.leaves.len() + scene.contours.len();
        let total = leaves * leaves.saturating_sub(1) / 2;
        let max_pairs = if rng.chance(1, 2) {
            TopologyLimits::default().max_pairs
        } else {
            rng.below(total as u64 + 2).min(2_016) as usize
        };
        let limits = TopologyLimits {
            max_pairs,
            ..TopologyLimits::default()
        };
        let reference = b0r_with_pair_loop_mode(B0rPairLoopMode::Reference, || {
            observe(&mut Workspaces::new(limits), &scene)
        });
        let sweep = observe(&mut Workspaces::new(limits), &scene);
        let shadow = b0r_with_pair_loop_mode(B0rPairLoopMode::Shadow, || {
            observe(&mut Workspaces::new(limits), &scene)
        });
        tally.scenes += 1;
        for ((reference, sweep), shadow) in reference.iter().zip(&sweep).zip(&shadow) {
            tally.calls += 1;
            if reference.text != sweep.text || sweep.text != shadow.text {
                tally.mismatches += 1;
                if tally.mismatches <= 3 {
                    eprintln!(
                        "B0R O3(b) workspace mismatch:\n reference {}\n sweep     {}\n shadow    {}",
                        reference.text, sweep.text, shadow.text
                    );
                }
            }
            if reference.allocations + sweep.allocations + shadow.allocations != 0 {
                tally.allocating_calls += 1;
            }
            match sweep.result {
                Ok(()) => tally.ok += 1,
                Err(TopologyError::Unresolved) => tally.unresolved += 1,
                Err(TopologyError::WorkLimit) => tally.work_limit += 1,
                Err(TopologyError::KnotMismatch) => tally.knot_mismatch += 1,
                Err(_) => tally.other_error += 1,
            }
            tally.crossing_records += sweep.crossings as u64;
        }
    }
    tally.shadow = b0r_take_shadow_tally();
    tally
}

fn scene_run(seed: u64, count: u64, shards: usize) -> DiffTally {
    let mut total = DiffTally::default();
    for tally in parallel(shards, move |shard| {
        scene_differential(
            seed ^ ((shard as u64 + 1) << 32),
            share(count, shards, shard),
        )
    }) {
        total.merge(tally);
    }
    total
}

fn assert_clean(tally: &DiffTally) {
    assert_eq!(tally.mismatches, 0, "{tally:?}");
    assert_eq!(tally.allocating_calls, 0, "{tally:?}");
    assert_eq!(tally.shadow.mismatches, 0, "{tally:?}");
    assert_eq!(tally.shadow.uncovered, 0, "{tally:?}");
}

fn assert_coverage(tally: &DiffTally) {
    assert!(tally.ok > 0, "no certified call: {tally:?}");
    assert!(tally.unresolved > 0, "no Unresolved call: {tally:?}");
    assert!(tally.work_limit > 0, "no WorkLimit call: {tally:?}");
    assert!(tally.knot_mismatch > 0, "no KnotMismatch call: {tally:?}");
    assert!(tally.crossing_records > 0, "no crossing record: {tally:?}");
    assert!(
        tally.shadow.work_limit_runs > 0 && tally.shadow.failure_runs > 0,
        "{tally:?}"
    );
    assert!(tally.shadow.touched > 0, "{tally:?}");
    assert!(tally.shadow.unboxed_calls > 0, "no unboxed leaf: {tally:?}");
}

#[test]
fn b0r_o3b_smoke_workspace_differential() {
    let start = Instant::now();
    let tally = scene_run(0x4230_5232_0005, 96, 4);
    println!(
        "B0R O3(b) smoke: {tally:?}, {:.1} s",
        start.elapsed().as_secs_f64()
    );
    assert_clean(&tally);
    assert_coverage(&tally);
}

/// O3(b) and O3(c) at a larger size on the seeded scene families.
#[test]
#[ignore = "B0R O3 full size; release profile via pnpm test:p3-fill-identity"]
fn b0r_oracle_full_o3b_random_scenes() {
    let start = Instant::now();
    let tally = scene_run(0x4230_5232_0006, 64_000, ORACLE_SHARDS);
    println!(
        "B0R O3(b) random scenes: {tally:?}, {} shards, {:.1} s",
        ORACLE_SHARDS,
        start.elapsed().as_secs_f64()
    );
    assert_clean(&tally);
    assert_coverage(&tally);
}

/// O3(b) and O3(c) on every O4 input reaching topology: both corpora through the four
/// `CubicFillWorkspace` entries and the V2 cascade (the identity harness's `run_chunk`), with
/// every pair-loop call in shadow mode. The digests the harness computes are discarded here;
/// the identity tool compares the sweep's digests with the merge base separately (O4).
#[test]
#[ignore = "B0R O3 full size; release profile via pnpm test:p3-fill-identity"]
fn b0r_oracle_full_o3b_corpus_shadow() {
    let start = Instant::now();
    let mut chunks = read_b0(&read_file("P3_B0R_B0_CORPUS"));
    chunks.extend(read_random(&read_file("P3_B0R_RANDOM_CORPUS")));
    let chunk_count = chunks.len();
    let threads = ORACLE_SHARDS;
    let chunks = std::sync::Arc::new(chunks);
    let handles: Vec<_> = (0..threads)
        .map(|worker| {
            let chunks = std::sync::Arc::clone(&chunks);
            thread::Builder::new()
                .stack_size(THREAD_STACK_BYTES)
                .spawn(move || {
                    b0r_take_shadow_tally();
                    b0r_with_pair_loop_mode(B0rPairLoopMode::Shadow, || {
                        for chunk in chunks.iter().skip(worker).step_by(threads) {
                            run_chunk(chunk);
                        }
                    });
                    b0r_take_shadow_tally()
                })
                .expect("spawn O3 corpus worker")
        })
        .collect();
    let mut tally = B0rShadowTally::default();
    for handle in handles {
        tally.merge(handle.join().expect("O3 corpus worker"));
    }
    println!(
        "B0R O3(b) corpus shadow: {chunk_count} chunks, {tally:?}, {threads} threads, {:.1} s",
        start.elapsed().as_secs_f64()
    );
    assert!(tally.calls > 0, "{tally:?}");
    assert_eq!(tally.mismatches, 0, "{tally:?}");
    assert_eq!(tally.uncovered, 0, "{tally:?}");
}

// ---------------------------------------------------------------------------------------------
// O8 seeded defects (3)-(6): each is detected by at least one oracle above.

/// O8 (3): strict box overlap drops pairs whose boxes touch exactly (at an exact zero
/// coordinate, whose enclosure is the point 0); Lemma A and the candidate-set check fail, and
/// the workspace differential sees the dropped touching contours.
#[test]
fn b0r_o8_strict_box_overlap_is_detected() {
    let lemma = b0r_with_sweep_fault(SweepFault::StrictBoxOverlap, || {
        lemma_cases(0x4230_5232_0013, 5_000)
    });
    let (candidates, _) = b0r_with_sweep_fault(SweepFault::StrictBoxOverlap, || {
        candidate_mismatches(0x4230_5232_0023, 2_000)
    });
    let scenes = b0r_with_sweep_fault(SweepFault::StrictBoxOverlap, || {
        scene_differential(0x4230_5232_0033, 40)
    });
    println!(
        "B0R O8 (3): Lemma A violations {}, candidate-set mismatches {candidates}, workspace \
         mismatches {}, shadow mismatches {}, uncovered {}",
        lemma.violations, scenes.mismatches, scenes.shadow.mismatches, scenes.shadow.uncovered
    );
    assert!(lemma.violations > 0, "{lemma:?}");
    assert!(candidates > 0);
    assert!(
        scenes.mismatches > 0 && scenes.shadow.uncovered > 0,
        "{scenes:?}"
    );
}

/// O8 (4): with forced pairs unmarked, the candidate-set check fails. On real leaves the
/// defect is masked: adjacent leaves share an exact point, so their boxes always overlap.
#[test]
fn b0r_o8_forced_pairs_not_marked_is_detected() {
    let (candidates, _) = b0r_with_sweep_fault(SweepFault::ForcedPairsNotMarked, || {
        candidate_mismatches(0x4230_5232_0014, 2_000)
    });
    let scenes = b0r_with_sweep_fault(SweepFault::ForcedPairsNotMarked, || {
        scene_differential(0x4230_5232_0034, 10)
    });
    println!(
        "B0R O8 (4): candidate-set mismatches {candidates}, workspace mismatches {}, shadow \
         mismatches {}, uncovered {}",
        scenes.mismatches, scenes.shadow.mismatches, scenes.shadow.uncovered
    );
    assert!(candidates > 0);
}

/// O8 (5): sorted-by-x processing changes the first failing pair, the counter and the crossing
/// order; the workspace differential and the candidate-order check fail.
#[test]
fn b0r_o8_sorted_by_x_order_is_detected() {
    let (candidates, _) = b0r_with_sweep_fault(SweepFault::SortedByXOrder, || {
        candidate_mismatches(0x4230_5232_0015, 2_000)
    });
    let scenes = b0r_with_sweep_fault(SweepFault::SortedByXOrder, || {
        scene_differential(0x4230_5232_0035, 30)
    });
    println!(
        "B0R O8 (5): candidate-order mismatches {candidates}, workspace mismatches {}, shadow \
         mismatches {}",
        scenes.mismatches, scenes.shadow.mismatches
    );
    assert!(candidates > 0);
    assert!(
        scenes.mismatches > 0 && scenes.shadow.mismatches > 0,
        "{scenes:?}"
    );
}

/// O8 (6): a counter one too low is detected by the Lemma B check and by the workspace
/// differential on every body failure.
#[test]
fn b0r_o8_counter_off_by_one_is_detected() {
    let (counter, _, _) = b0r_with_sweep_fault(SweepFault::CounterOffByOne, || {
        counter_mismatches(0x4230_5232_0016, 5_000)
    });
    let scenes = b0r_with_sweep_fault(SweepFault::CounterOffByOne, || {
        scene_differential(0x4230_5232_0036, 30)
    });
    println!(
        "B0R O8 (6): Lemma B mismatches {counter}, workspace mismatches {}, shadow mismatches {}",
        scenes.mismatches, scenes.shadow.mismatches
    );
    assert!(counter > 0);
    assert!(
        scenes.mismatches > 0 && scenes.shadow.mismatches > 0,
        "{scenes:?}"
    );
}
