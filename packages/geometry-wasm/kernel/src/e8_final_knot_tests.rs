//! E8-U2 tests (E8 addendum `docs/plans/p3-rounded-knot-topology-contract.md` section E8.4):
//! the canonical source-final knot of the exact rung.
//!
//! - The snap runs only in the exact rung and only at source-final knots: the fast rung's S1
//!   prefix keeps the emitted point, and every other command is unchanged (E8-D6, E8-D8).
//! - E8-C6: a zero-length final leaf is left as emitted and fails with `ZeroLengthLeaf`
//!   (E8-D10), through a `cfg(test)` command-list injection.
//! - E8-K11 (open obligation E8-P1): at the largest admitted magnitudes, the emitted final knot
//!   q' = fl(o + fl(p3 - o)) differs from p3 by at most u(A + R)/(1 - u)^2 per coordinate, which
//!   is below 1/128 of the flattener's guard at the leaf's depth. The written proof is in
//!   `docs/evidence/e8-u2-2026-10-24.md`.
use crate::codec::{PathInput, Request};
use crate::cubic_fill::{
    with_e8_collapsed_final_leaf, CubicFillError, CubicFillWorkspace, DecodedSource,
    MAX_FLAT_COMMANDS,
};
use crate::fill_export::{tolerances, FILL_V0_LIMITS};
use crate::geometry::{
    run_path, Pass, Point, Provenance, WorkStatistics, PATH_OK, VERB_CLOSE, VERB_CUBIC, VERB_LINE,
    VERB_MOVE,
};
use crate::line_fill::LineFillRule;

/// E8-F5, `M -2.9 33.4 C -2.9 31.4 17.1 23.6 17.1 33.4 C 17.1 47.7 -2.9 37.7 -2.9 33.4 Z`.
const E8_F5_VERBS: [u8; 4] = [VERB_MOVE, VERB_CUBIC, VERB_CUBIC, VERB_CLOSE];
const E8_F5_POINTS: [f64; 14] = [
    -2.9, 33.4, -2.9, 31.4, 17.1, 23.6, 17.1, 33.4, 17.1, 47.7, -2.9, 37.7, -2.9, 33.4,
];

fn bytes(points: &[f64]) -> Vec<u8> {
    points
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

fn input<'a>(verbs: &'a [u8], point_bytes: &'a [u8], tolerance: f64) -> PathInput<'a> {
    PathInput::from_parts(
        Request {
            request_id: 0,
            source_epoch: 0,
            source_revision: 0,
            tolerance,
        },
        verbs,
        point_bytes,
    )
}

fn is_final(provenance: Provenance) -> bool {
    1u32.checked_shl(provenance.depth) == Some(provenance.end_numerator)
}

fn cubic_end(sources: &[DecodedSource], source_verb: u32) -> Option<Point> {
    sources.iter().find_map(|source| match *source {
        DecodedSource::Cubic {
            points,
            source_verb: verb,
            ..
        } if verb == source_verb => Some(points[3]),
        _ => None,
    })
}

fn same_bits(left: Point, right: Point) -> bool {
    left.x.to_bits() == right.x.to_bits() && left.y.to_bits() == right.y.to_bits()
}

#[test]
fn e8_f5_snaps_only_source_final_knots_in_the_exact_rung() {
    let point_bytes = bytes(&E8_F5_POINTS);
    let (flatten, topology) = tolerances(0);
    let mut workspace = CubicFillWorkspace::new(FILL_V0_LIMITS).unwrap();
    let (prefix, sources) = {
        let view = workspace
            .prepare_prefix(
                input(&E8_F5_VERBS, &point_bytes, flatten),
                MAX_FLAT_COMMANDS,
            )
            .expect("E8-F5 prefix");
        (view.commands.to_vec(), view.sources.to_vec())
    };
    workspace
        .attempt(
            input(&E8_F5_VERBS, &point_bytes, flatten),
            LineFillRule::Nonzero,
            topology,
            MAX_FLAT_COMMANDS,
        )
        .expect("E8-F5 certifies in the first cascade step");
    let output = workspace.output().expect("published E8-F5");
    assert_eq!(output.commands.len(), prefix.len());
    let mut moved = 0usize;
    for (exact, fast) in output.commands.iter().zip(&prefix) {
        assert_eq!(exact.verb, fast.verb);
        assert_eq!(exact.provenance, fast.provenance);
        let end = cubic_end(&sources, fast.provenance.source_verb);
        match (exact.point, fast.point, end) {
            (Some(snapped), Some(emitted), Some(end))
                if fast.verb == VERB_LINE && is_final(fast.provenance) =>
            {
                assert!(same_bits(snapped, end), "the exact rung writes p3");
                moved += usize::from(!same_bits(snapped, emitted));
            }
            (Some(left), Some(right), _) => {
                assert!(same_bits(left, right), "a non-final command moved")
            }
            (left, right, _) => assert_eq!(left, right),
        }
    }
    // M2: at least one of the two final knots is emitted inexactly; the fast rung keeps it.
    assert!(moved >= 1, "E8-F5 has no inexact final knot");
}

#[test]
fn e8_c6_zero_length_final_leaf_is_left_as_emitted() {
    let point_bytes = bytes(&E8_F5_POINTS);
    let (flatten, topology) = tolerances(0);
    let mut workspace = CubicFillWorkspace::new(FILL_V0_LIMITS).unwrap();
    let result = with_e8_collapsed_final_leaf(|| {
        workspace.attempt(
            input(&E8_F5_VERBS, &point_bytes, flatten),
            LineFillRule::Nonzero,
            topology,
            MAX_FLAT_COMMANDS,
        )
    });
    assert_eq!(result, Err(CubicFillError::ZeroLengthLeaf));
    assert!(workspace.output().is_none());
    // The switch is off again: the same workspace certifies E8-F5.
    workspace
        .attempt(
            input(&E8_F5_VERBS, &point_bytes, flatten),
            LineFillRule::Nonzero,
            topology,
            MAX_FLAT_COMMANDS,
        )
        .expect("E8-F5 after the injection");
}

/// A seeded 64-bit LCG (Knuth MMIX constants).
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0
    }

    /// A value in [-1, 1) with a full 53-bit significand (non-dyadic after scaling by 0.9).
    fn unit(&mut self) -> f64 {
        let bits = self.next() >> 11;
        (bits as f64 / (1u64 << 52) as f64 - 1.0) * 0.9
    }
}

#[derive(Default)]
struct BoundTally {
    final_leaves: usize,
    inexact: usize,
    largest_inexact: usize,
    worst_ratio: f64,
    max_depth: u32,
}

/// Checks every final leaf of one single-cubic path; returns false when flattening fails.
fn check_final_knot(controls: [Point; 4], exponent: i32, tally: &mut BoundTally) -> bool {
    const U: f64 = f64::EPSILON / 2.0;
    let mut points = Vec::with_capacity(8);
    for point in controls {
        points.extend([point.x, point.y]);
    }
    let point_bytes = bytes(&points);
    let verbs = [VERB_MOVE, VERB_CUBIC];
    let (flatten, _) = tolerances(exponent);
    let mut last = None;
    let (plan, _) = run_path(
        input(&verbs, &point_bytes, flatten),
        Pass::Emission,
        &mut WorkStatistics::default(),
        |verb, point, provenance| {
            if verb == VERB_LINE {
                last = point.map(|point| (point, provenance));
            }
            true
        },
    );
    if plan.status != PATH_OK {
        return false;
    }
    let (emitted, provenance) = last.expect("a cubic emits at least one leaf");
    assert!(is_final(provenance));
    let origin = controls[0];
    let end = controls[3];
    // A and R as `Cubic::relative` computes them (P2 private contract, flattening guard).
    let a = controls.iter().fold(1.0f64, |value, point| {
        value.max(point.x.abs()).max(point.y.abs())
    });
    let r = controls[1..].iter().fold(0.0f64, |value, point| {
        value
            .max((point.x - origin.x).abs())
            .max((point.y - origin.y).abs())
    });
    let guard = 128.0 * f64::EPSILON * (a + (f64::from(provenance.depth) + 1.0) * r);
    // u(A + R)/(1 - u)^2, with (1 - u)^-2 < 1 + 4u, rounded up by one more relative 2u.
    let coordinate_bound = U * (a + r) * (1.0 + 8.0 * U);
    let mut deltas = [0.0f64; 2];
    for (index, (q, p)) in [(emitted.x, end.x), (emitted.y, end.y)]
        .into_iter()
        .enumerate()
    {
        // Sterbenz: q and p agree in sign and lie within a factor of two, so q - p is exact.
        if q != p {
            assert!(
                q.signum() == p.signum() && q.abs() <= 2.0 * p.abs() && p.abs() <= 2.0 * q.abs()
            );
        }
        let delta = (q - p).abs();
        assert!(
            delta <= coordinate_bound,
            "|q' - p3| = {delta:e} exceeds u(A + R) bound {coordinate_bound:e}"
        );
        deltas[index] = delta;
    }
    let distance = deltas[0].hypot(deltas[1]);
    assert!(
        distance <= guard / 128.0,
        "|q' - p3| = {distance:e} is not below guard / 128 = {:e}",
        guard / 128.0
    );
    tally.final_leaves += 1;
    tally.max_depth = tally.max_depth.max(provenance.depth);
    if distance > 0.0 {
        tally.inexact += 1;
        tally.worst_ratio = tally.worst_ratio.max(distance / guard);
        if a >= 2f64.powi(1020) {
            tally.largest_inexact += 1;
        }
    }
    true
}

#[test]
fn e8_k11_snapped_final_knot_moves_less_than_the_guard_at_the_largest_admitted_magnitudes() {
    // Magnitudes from 1 to 2^1023 (A up to about 0.9 * 2^1023; the relative span stays finite).
    // Tolerance exponents from the scale down, so final leaves reach depth > 0. Exponents above
    // 1023 are not admitted (V2 section d).
    let mut generator = Lcg(0xe802_2026_1024);
    let mut tally = BoundTally::default();
    let mut attempted = 0usize;
    for scale_exponent in [0, 30, 100, 500, 1000, 1020, 1022, 1023] {
        let scale = 2f64.powi(scale_exponent);
        for _ in 0..64 {
            let controls = [(); 4].map(|_| Point {
                x: generator.unit() * scale,
                y: generator.unit() * scale,
            });
            for drop in [0, 2, 4, 6, 8] {
                let exponent = (scale_exponent - drop).min(1023);
                attempted += 1;
                check_final_knot(controls, exponent, &mut tally);
            }
        }
    }
    // Near the top of the admitted range: A = 0.2 f64::MAX and |p3 - o| = 0.4 f64::MAX on one
    // axis (with A + R near 0.6 f64::MAX the bounds pass and the guard stay finite), interior
    // controls near the chord thirds, so that the single depth-0 leaf is accepted at the largest
    // tolerance 2^1023.
    let edge = 0.2 * f64::MAX;
    for (sign, lift) in [(1.0, 0.1), (-1.0, 0.3), (1.0, -0.7), (-1.0, 0.9)] {
        let start = Point {
            x: -edge * sign,
            y: edge * lift / 3.0,
        };
        let end = Point {
            x: edge * sign,
            y: -edge * lift / 7.0,
        };
        let third = |weight: f64, bend: f64| Point {
            x: start.x + (end.x - start.x) * weight,
            y: start.y + (end.y - start.y) * weight + bend * 1.1e300,
        };
        let controls = [start, third(1.0 / 3.0, 1.0), third(2.0 / 3.0, -1.0), end];
        attempted += 1;
        assert!(
            check_final_knot(controls, 1023, &mut tally),
            "edge path did not flatten"
        );
    }
    assert!(
        tally.final_leaves * 2 >= attempted,
        "too few paths flattened: {}",
        tally.final_leaves
    );
    assert!(
        tally.inexact >= 100,
        "too few inexact final knots: {}",
        tally.inexact
    );
    assert!(
        tally.largest_inexact >= 10,
        "too few inexact knots at 2^1020 and above"
    );
    assert!(
        tally.max_depth >= 3,
        "final leaves stay shallow: {}",
        tally.max_depth
    );
    assert!(tally.worst_ratio <= 1.0 / 128.0);
    println!(
        "E8-K11: {} final leaves, {} inexact ({} at A >= 2^1020), max depth {}, worst |q' - p3| / guard {:e}",
        tally.final_leaves, tally.inexact, tally.largest_inexact, tally.max_depth, tally.worst_ratio
    );
}
