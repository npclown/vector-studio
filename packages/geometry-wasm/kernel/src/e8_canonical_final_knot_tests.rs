//! E8-U2, the canonical source-final knot in the exact rung
//! (docs/plans/p3-rounded-knot-topology-contract.md, E8 addendum E8.4, E8.6-E8.8).
//!
//! - `snap_final_knots` on literal command lists: the final leaf of every cubic source becomes
//!   its canonical p3; internal knots (E8-D8), LINE sources and CLOSE commands are untouched; a
//!   final leaf that is already zero-length is skipped (E8-C6 by injection, E8-D10).
//! - E8-C6 through the exact rung: a zero-length final leaf stays `ZeroLengthLeaf`.
//! - The flag: `prepare_prefix` (the fast rung's S1 view) keeps the emitted final knot (E8-D6).
//! - E8-P1 (E8-K11): the emitted final knot differs from p3 by at most
//!   eps * max_abs_original + (eps / 2) * max_abs_relative per coordinate, at least 128 times
//!   inside the guard, up to the largest admitted magnitudes.
use crate::codec::{PathInput, Request};
use crate::cubic_fill::{
    snap_final_knots, CubicFillError, CubicFillWorkspace, DecodedSource, FlatCommand,
    MAX_FLAT_COMMANDS,
};
use crate::fill_export::{tolerances, FILL_V0_LIMITS};
use crate::geometry::{e8_test_final_knot, Point, Provenance, VERB_CLOSE, VERB_LINE, VERB_MOVE};
use crate::line_fill::LineFillRule;

fn p(x: f64, y: f64) -> Point {
    Point { x, y }
}

fn bytes(values: &[f64]) -> Vec<u8> {
    values
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

fn input<'a>(verbs: &'a [u8], point_bytes: &'a [u8], exponent: i32) -> PathInput<'a> {
    PathInput::from_test_parts(
        Request {
            request_id: 0,
            source_epoch: 0,
            source_revision: 0,
            tolerance: tolerances(exponent).0,
        },
        verbs,
        point_bytes,
    )
}

fn command(verb: u8, point: Option<Point>, source_verb: u32, end: u32, depth: u32) -> FlatCommand {
    FlatCommand {
        verb,
        point,
        provenance: Provenance {
            source_verb,
            end_numerator: end,
            depth,
        },
    }
}

fn cubic(points: [Point; 4], source_verb: u32) -> DecodedSource {
    DecodedSource::Cubic {
        points,
        source_verb,
        contour: 0,
    }
}

#[test]
fn final_leaves_of_cubic_sources_take_their_canonical_p3() {
    // MOVE, a cubic (verb 1) in two leaves whose final knot is emitted off p3, a LINE (verb 2),
    // a single-leaf cubic (verb 3) whose final knot is also off p3, then CLOSE.
    let p3 = p(0.3, 0.7);
    let q3 = p(0.1, 1.0);
    let sources = [
        cubic([p(0.0, 0.0), p(0.1, 0.2), p(0.2, 0.5), p3], 1),
        DecodedSource::Line {
            points: [p3, p(1.0, 1.0)],
            source_verb: 2,
            contour: 0,
        },
        cubic([p(1.0, 1.0), p(0.8, 1.0), p(0.4, 1.0), q3], 3),
    ];
    let internal = p(0.15, 0.4);
    let mut commands = [
        command(VERB_MOVE, Some(p(0.0, 0.0)), 0, 0, 0),
        command(VERB_LINE, Some(internal), 1, 1, 1),
        command(VERB_LINE, Some(p(0.3 + 1e-16, 0.7)), 1, 2, 1),
        command(VERB_LINE, Some(p(1.0, 1.0)), 2, 1, 0),
        command(VERB_LINE, Some(p(0.1 + 1e-16, 1.0)), 3, 1, 0),
        command(VERB_CLOSE, None, 4, 0, 0),
    ];
    let before = commands;
    assert_ne!(before[2].point, Some(p3));
    assert_ne!(before[4].point, Some(q3));
    snap_final_knots(&mut commands, &sources);
    // E8-D8 detector: the internal knot keeps its emitted value.
    assert_eq!(commands[1], before[1]);
    assert_eq!(commands[2].point, Some(p3));
    // The LINE source and the CLOSE command are untouched.
    assert_eq!(commands[3], before[3]);
    assert_eq!(commands[4].point, Some(q3));
    assert_eq!(commands[5], before[5]);
    // Counts, order and provenance are unchanged.
    for (after, before) in commands.iter().zip(before.iter()) {
        assert_eq!(
            (after.verb, after.provenance),
            (before.verb, before.provenance)
        );
    }
}

#[test]
fn an_already_zero_length_final_leaf_is_not_snapped() {
    // E8-C6 by command-list injection and the E8-D10 detector: the final leaf's emitted point
    // equals the previous emitted point, while its canonical p3 differs. The snap must leave it,
    // so collection rejects it as `ZeroLengthLeaf` as before.
    let start = p(1.0, 0.0);
    let sources = [cubic(
        [start, p(0.75, 0.0), p(0.25, 0.0), p(1e-300, 0.0)],
        1,
    )];
    let mut commands = [
        command(VERB_MOVE, Some(start), 0, 0, 0),
        command(VERB_LINE, Some(start), 1, 1, 0),
    ];
    let before = commands;
    snap_final_knots(&mut commands, &sources);
    assert_eq!(commands, before);
}

#[test]
fn a_zero_length_final_leaf_stays_zero_length_leaf_in_the_exact_rung() {
    // E8-C6 through the exact rung (the V2 mapping-row input): a constant cubic whose single leaf
    // has the MOVE point. The snap is skipped and every exact entry reports `ZeroLengthLeaf`,
    // never an internal error.
    let verbs = [0u8, 2, 2, 2, 2, 3];
    let points = bytes(&[
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 2.0, 0.0, 3.0, 0.0, 2.0, 1.0, 1.0, 2.0,
        0.0, 3.0, 0.0, 2.0, 0.0, 1.0, 0.0, 0.0,
    ]);
    let mut workspace = CubicFillWorkspace::new(FILL_V0_LIMITS).unwrap();
    let (_, topology) = tolerances(-3);
    let path = input(&verbs, &points, -3);
    let results = [
        workspace.attempt(path, LineFillRule::Nonzero, topology, MAX_FLAT_COMMANDS),
        workspace.attempt_transverse(path, LineFillRule::Nonzero, topology, MAX_FLAT_COMMANDS),
        workspace.attempt_triangle_free(path, LineFillRule::Nonzero, topology, MAX_FLAT_COMMANDS),
    ];
    for result in results {
        assert_eq!(result.err(), Some(CubicFillError::ZeroLengthLeaf));
    }
}

/// E8-F5 (E8 addendum E8.6) as fill-v0 scalars.
const E8_F5_POINTS: [f64; 14] = [
    -2.9, 33.4, -2.9, 31.4, 17.1, 23.6, 17.1, 33.4, 17.1, 47.7, -2.9, 37.7, -2.9, 33.4,
];

#[test]
fn only_the_exact_rung_snaps() {
    // E8-D6 detector: the fast rung's S1 view (`prepare_prefix`, flag off) keeps the emitted
    // final knots of E8-F5, which differ from p3; the exact rung (`attempt`, flag on) admits it.
    let verbs = [0u8, 2, 2, 3];
    let points = bytes(&E8_F5_POINTS);
    let mut workspace = CubicFillWorkspace::new(FILL_V0_LIMITS).unwrap();
    let canonical = [p(17.1, 33.4), p(-2.9, 33.4)];
    let view = workspace
        .prepare_prefix(input(&verbs, &points, 0), MAX_FLAT_COMMANDS)
        .unwrap();
    let finals: Vec<Point> = view
        .commands
        .iter()
        .filter(|command| {
            command.verb == VERB_LINE
                && command.provenance.end_numerator == 1u32 << command.provenance.depth
        })
        .filter_map(|command| command.point)
        .collect();
    assert_eq!(finals.len(), 2);
    assert!(
        finals
            .iter()
            .zip(canonical)
            .any(|(emitted, p3)| *emitted != p3),
        "E8-F5 has an inexact emitted source-final knot"
    );
    let (_, topology) = tolerances(0);
    let result = workspace.attempt(
        input(&verbs, &points, 0),
        LineFillRule::Nonzero,
        topology,
        MAX_FLAT_COMMANDS,
    );
    assert!(result.is_ok());
    assert!(workspace.output().is_some());
}

/// A 64-bit LCG (Knuth's MMIX constants) for the E8-P1 sample.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0
    }

    /// A finite value with a random sign, a random 32-bit mantissa and a binary exponent in
    /// [lo, hi].
    fn value(&mut self, lo: i32, hi: i32) -> f64 {
        let bits = self.next();
        let span = u64::try_from(hi - lo + 1).unwrap();
        let exponent = lo + i32::try_from((bits >> 32) % span).unwrap();
        let mantissa = 1.0 + (bits & 0xffff_ffff) as f64 / 4_294_967_296.0;
        let value = mantissa * 2f64.powi(exponent);
        if bits & (1 << 63) == 0 {
            value
        } else {
            -value
        }
    }
}

#[test]
fn emitted_final_knot_error_is_far_inside_the_guard() {
    // E8-P1 (E8-K11). With r = fl(p3 - o) and q' = fl(o + r) per coordinate (u = eps / 2),
    // |q' - p3| <= |fl(o + r) - (o + r)| + |r - (p3 - o)| <= u |o + r| + u |p3 - o|
    //            <= eps * max_abs_original + (eps / 2) * max_abs_relative,
    // while the guard of every leaf is 128 eps (max_abs_original + (depth + 1) max_abs_relative),
    // at least 128 times that bound. The sample covers ordinary magnitudes, the largest admitted
    // binary exponents (up to 1021, so that p3 - o stays finite) and two extreme cubics.
    const EPS: f64 = f64::EPSILON;
    let mut random = Lcg(0xe8c0_0004_0000_0001);
    let mut cases: Vec<[Point; 4]> = Vec::new();
    for index in 0..20_000 {
        let (lo, hi) = if index % 2 == 0 {
            (-60, 60)
        } else {
            (900, 1021)
        };
        cases.push(core::array::from_fn(|_| {
            p(random.value(lo, hi), random.value(lo, hi))
        }));
    }
    let big = f64::MAX / 4.0;
    cases.push([p(big, -big), p(-big, big), p(big, big), p(-big, -big)]);
    cases.push([p(-big, 0.1), p(big, 0.3), p(0.0, -big), p(big, 1.0 / 3.0)]);
    let mut checked = 0usize;
    let mut largest = 0.0f64;
    for points in cases {
        let Ok((emitted, guard)) = e8_test_final_knot(points, 0) else {
            continue;
        };
        let max_abs_original = points.iter().fold(1.0f64, |value, point| {
            value.max(point.x.abs()).max(point.y.abs())
        });
        let max_abs_relative = points.iter().fold(0.0f64, |value, point| {
            value
                .max((point.x - points[0].x).abs())
                .max((point.y - points[0].y).abs())
        });
        let bound = EPS * max_abs_original + 0.5 * EPS * max_abs_relative;
        for (q, p3) in [(emitted.x, points[3].x), (emitted.y, points[3].y)] {
            let difference = (q - p3).abs();
            assert!(
                difference <= bound,
                "final knot error {difference:e} exceeds {bound:e} at {points:?}"
            );
            largest = largest.max(max_abs_original);
        }
        assert!(bound * 128.0 <= guard * (1.0 + 4.0 * EPS));
        checked += 1;
    }
    assert!(checked > 10_000, "only {checked} cubics in range");
    assert!(largest > 1e300, "the sample reaches the largest magnitudes");
}
