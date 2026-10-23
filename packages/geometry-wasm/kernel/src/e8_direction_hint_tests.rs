//! E8-U1, the exact-rung direction hint (docs/plans/p3-rounded-knot-topology-contract.md, E8
//! addendum E8.3 and E8.6-E8.8).
//!
//! - Literal tests of the amended adjacent-pair test of P3.2n and P3.2s: the d2 candidate, the
//!   own-progress guard (E8-D1), the angular extremes (E8-D3), the sign of d2 (E8-D2), an
//!   implicit closure, and the widths at the largest admitted magnitudes (E8.3 "Work and
//!   width").
//! - Two ignored emitters for the TypeScript tests under `tests/geometry/`: the `e8-corner/v1`
//!   corpus digests (E8-K6, E8-K8), and the topology input and native certificate results of
//!   the E8 fixtures for the native-versus-oracle differential (E8-K10).
use std::env;
use std::fmt::Write as _;
use std::fs::OpenOptions;
use std::io::Write as _;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::thread;

use crate::codec::{PathInput, Request};
use crate::cubic_fill::{CubicFillWorkspace, DecodedSource, MAX_FLAT_COMMANDS};
use crate::fill_export::{tolerances, FILL_V0_LIMITS};
use crate::fill_filter_tests::THREAD_STACK_BYTES;
use crate::geometry::{Point, Provenance, VERB_CUBIC, VERB_LINE};
use crate::p3_b0r_identity::{read_file, read_random, run_chunk};
use crate::simple_cubic_topology::{
    b0r_test_point, e8_test_adjacent_pair, e8_test_second_direction, E8TestLeaf,
    RoundedKnotCubicTopologyWorkspace, SimpleCubicTopologyWorkspace, TopologyCubic, TopologyError,
    TopologyInput, TopologyLeaf, TopologyLimits, TopologyRange, TransverseArrangementWorkspace,
};

fn p(x: f64, y: f64) -> Point {
    Point { x, y }
}

/// A straight source piece from `start` to `end` with the controls on its endpoints, whose
/// actual chord is the source chord.
fn line(start: Point, end: Point) -> E8TestLeaf {
    ([start, start, end, end, start, end], false)
}

/// A source piece with its own controls and actual endpoints.
fn piece(controls: [Point; 4], actual_start: Point, actual_end: Point) -> E8TestLeaf {
    (
        [
            controls[0],
            controls[1],
            controls[2],
            controls[3],
            actual_start,
            actual_end,
        ],
        false,
    )
}

/// The implicit closure from `start` to the contour's first point `first`.
fn closure(start: Point, first: Point) -> E8TestLeaf {
    ([start, start, first, first, start, first], true)
}

fn reflect(leaf: E8TestLeaf, map: impl Fn(Point) -> Point) -> E8TestLeaf {
    (leaf.0.map(map), leaf.1)
}

#[test]
fn d2_admits_a_corner_that_d1_rejects() {
    // A long piece then a short piece that turns by 135 degrees: d1 = (3, 1) has a negative dot
    // with the short piece's difference (-1, 1). V = {(4, 0), (-1, 1)} lies in an open half
    // plane: a = (4, 0), b = (-1, 1), d2 = J(a - b) = J(5, -1) = (1, 5).
    let previous = line(p(0.0, 0.0), p(4.0, 0.0));
    let next = line(p(4.0, 0.0), p(3.0, 1.0));
    assert_eq!(e8_test_adjacent_pair(previous, next), (false, true));
    assert_eq!(
        e8_test_second_direction(previous, next),
        Some(b0r_test_point(p(1.0, 5.0)))
    );
    // Every image under the eight symmetries of the square behaves the same.
    let maps: [fn(Point) -> Point; 8] = [
        |q| p(q.x, q.y),
        |q| p(-q.x, q.y),
        |q| p(q.x, -q.y),
        |q| p(-q.x, -q.y),
        |q| p(q.y, q.x),
        |q| p(-q.y, q.x),
        |q| p(q.y, -q.x),
        |q| p(-q.y, -q.x),
    ];
    for map in maps {
        let (previous, next) = (reflect(previous, map), reflect(next, map));
        assert_eq!(e8_test_adjacent_pair(previous, next), (false, true));
    }
}

#[test]
fn d1_success_computes_nothing_else() {
    // A pair that passes with d1 passes whatever d2 would be.
    let previous = line(p(0.0, 0.0), p(4.0, 0.0));
    let next = line(p(4.0, 0.0), p(4.0, 1.0));
    assert_eq!(e8_test_adjacent_pair(previous, next), (true, true));
}

#[test]
fn collinear_same_direction_takes_d2_equal_to_a() {
    // Step 5, cross(a, b) = 0: every vector points the same way and d2 = a, the first vector.
    let previous = line(p(0.0, 0.0), p(4.0, 0.0));
    let next = line(p(4.0, 0.0), p(6.0, 0.0));
    assert_eq!(
        e8_test_second_direction(previous, next),
        Some(b0r_test_point(p(4.0, 0.0)))
    );
    assert_eq!(e8_test_adjacent_pair(previous, next), (true, true));
}

#[test]
fn antiparallel_vectors_have_no_extreme() {
    // E8-D3 detector: a literal antiparallel pair, the M1' turn. With the equal-direction rule
    // of step 4 weakened to accept opposite vectors, a and b exist (both (4, 0)) and d2 is
    // returned; the rule requires that neither exists.
    let previous = line(p(0.0, 0.0), p(4.0, 0.0));
    let next = line(p(4.0, 0.0), p(2.0, 0.0));
    assert_eq!(e8_test_second_direction(previous, next), None);
    assert_eq!(e8_test_adjacent_pair(previous, next), (false, false));
    // A set that spans a half-plane only together with an opposite pair: no extreme either.
    let next = piece(
        [p(4.0, 0.0), p(4.0, 0.0), p(4.0, 1.0), p(2.0, 1.0)],
        p(4.0, 0.0),
        p(2.0, 1.0),
    );
    assert_eq!(e8_test_second_direction(previous, next), None);
    assert_eq!(e8_test_adjacent_pair(previous, next), (false, false));
}

#[test]
fn own_progress_guard_keeps_a_reversed_actual_chord_unresolved() {
    // E8-D1 detector. The previous actual chord (-1, 1) runs against its source chord (4, 0)
    // (dot -4), while V = {(4, 0), (-1, 1), (0, 4), (5, 3)} lies in an open half plane, so
    // without the guard d2 = (1, 5) would certify the pair. d1 = (4, 4) fails on the chord.
    let previous = piece(
        [p(0.0, 0.0), p(0.0, 0.0), p(4.0, 0.0), p(4.0, 0.0)],
        p(0.0, 0.0),
        p(-1.0, 1.0),
    );
    let next = piece(
        [p(4.0, 0.0), p(4.0, 0.0), p(4.0, 4.0), p(4.0, 4.0)],
        p(-1.0, 1.0),
        p(4.0, 4.0),
    );
    assert_eq!(
        e8_test_second_direction(previous, next),
        Some(b0r_test_point(p(1.0, 5.0)))
    );
    assert_eq!(e8_test_adjacent_pair(previous, next), (false, false));
}

#[test]
fn d2_sign_is_j_of_a_minus_b() {
    // E8-D2 detector: J(b - a) = (-1, -5) has a negative dot with every vector of V.
    let previous = line(p(0.0, 0.0), p(4.0, 0.0));
    let next = line(p(4.0, 0.0), p(3.0, 1.0));
    let d2 = e8_test_second_direction(previous, next).unwrap();
    assert!(!d2[0].is_negative() && !d2[1].is_negative());
    assert_eq!(e8_test_adjacent_pair(previous, next), (false, true));
}

#[test]
fn an_implicit_closure_contributes_its_endpoint_derivative() {
    // The closure has no own-progress guard and contributes F - A and its actual chord.
    let previous = line(p(0.0, 0.0), p(4.0, 0.0));
    let next = closure(p(4.0, 0.0), p(3.0, 1.0));
    assert_eq!(e8_test_adjacent_pair(previous, next), (false, true));
    let previous = closure(p(3.0, 1.0), p(0.0, 0.0));
    let next = line(p(0.0, 0.0), p(4.0, 0.0));
    // d1 = (4, 0) - (3, 1) = (1, -1): the closure's (-3, -1) has dot -2. V = {(-3, -1), (4, 0)}.
    assert_eq!(e8_test_adjacent_pair(previous, next), (false, true));
}

#[test]
fn widths_hold_at_the_largest_admitted_magnitudes() {
    // E8.3 "Work and width": coordinates up to 1.5 * 2^1023, grid integers below 2^2158.
    // Differences reach 3 * 2^1023 (below 2^2159 on the grid), a - b reaches 6 * 2^1023 (below
    // 2^2160), and every product stays below 2^4321. d1 = (0, 1.5X) is orthogonal to the
    // previous piece, so only d2 can admit the pair.
    let x = 2f64.powi(1023);
    let h = 1.5 * x;
    let previous = line(p(-h, 0.0), p(h, 0.0));
    let next = line(p(h, 0.0), p(-h, h));
    assert_eq!(e8_test_adjacent_pair(previous, next), (false, true));
    // a = (3X, 0), b = (-3X, 1.5X), a - b = (6X, -1.5X), d2 = (1.5X, 6X).
    let half = b0r_test_point(p(h, h));
    let six = half[1].add(half[1]).add(half[1].add(half[1]));
    assert_eq!(
        e8_test_second_direction(previous, next),
        Some([half[0], six])
    );
    let maps: [fn(Point) -> Point; 4] = [
        |q| p(-q.x, q.y),
        |q| p(q.x, -q.y),
        |q| p(q.y, q.x),
        |q| p(-q.y, -q.x),
    ];
    for map in maps {
        let (previous, next) = (reflect(previous, map), reflect(next, map));
        assert_eq!(e8_test_adjacent_pair(previous, next), (false, true));
    }
    // The largest finite magnitude on both axes.
    let m = f64::MAX;
    let previous = line(p(-m, -m), p(m, -m));
    let next = line(p(m, -m), p(-m, m));
    assert_eq!(e8_test_adjacent_pair(previous, next), (false, true));
}

#[test]
fn cyclic_only_replacement_is_unresolved_natively() {
    // E8-Q3 extension of 2026-10-23: the literal input of
    // `tests/geometry/rounded-knot-topology/fixtures.ts::e8CyclicOnlyReplacement`. Exact linear
    // A-to-B and B-to-C (one leaf each), then the cubic C, (3, -3), (3, 0), A in four depth-2
    // leaves, which arrives at A antiparallel to A-to-B. Every native certificate fails at the
    // last-to-first pair, the fifth inspected pair, like the TypeScript oracles
    // (`tests/unit/geometry-e8-cyclic-only.test.ts`).
    let provenance = |source_verb, end_numerator, depth| Provenance {
        source_verb,
        end_numerator,
        depth,
    };
    let linear = |start: Point, end: Point| {
        [
            start,
            p((2.0 * start.x + end.x) / 3.0, (2.0 * start.y + end.y) / 3.0),
            p((start.x + 2.0 * end.x) / 3.0, (start.y + 2.0 * end.y) / 3.0),
            end,
        ]
    };
    let (a, b, c) = (p(0.0, 0.0), p(9.0, 0.0), p(3.0, -9.0));
    let cubics = [
        TopologyCubic {
            points: linear(a, b),
            source_verb: 7,
            leaves: TopologyRange { start: 0, count: 1 },
        },
        TopologyCubic {
            points: linear(b, c),
            source_verb: 8,
            leaves: TopologyRange { start: 1, count: 1 },
        },
        TopologyCubic {
            points: [c, p(3.0, -3.0), p(3.0, 0.0), a],
            source_verb: 9,
            leaves: TopologyRange { start: 2, count: 4 },
        },
    ];
    let leaves = [
        TopologyLeaf {
            end: b,
            provenance: provenance(7, 1, 0),
        },
        TopologyLeaf {
            end: c,
            provenance: provenance(8, 1, 0),
        },
        TopologyLeaf {
            end: p(189.0 / 64.0, -81.0 / 16.0),
            provenance: provenance(9, 1, 2),
        },
        TopologyLeaf {
            end: p(21.0 / 8.0, -9.0 / 4.0),
            provenance: provenance(9, 2, 2),
        },
        TopologyLeaf {
            end: p(111.0 / 64.0, -9.0 / 16.0),
            provenance: provenance(9, 3, 2),
        },
        TopologyLeaf {
            end: a,
            provenance: provenance(9, 4, 2),
        },
    ];
    let contours = [TopologyRange { start: 0, count: 3 }];
    let input = TopologyInput {
        contours: &contours,
        cubics: &cubics,
        leaves: &leaves,
    };
    let expected = (Err(TopologyError::Unresolved), 6, 5);
    let mut rounded = RoundedKnotCubicTopologyWorkspace::new(TopologyLimits::default()).unwrap();
    let result = rounded.certify(input);
    assert_eq!(
        (result, rounded.stats().leaves, rounded.stats().pairs),
        expected
    );
    let mut arrangement = TransverseArrangementWorkspace::new(TopologyLimits::default()).unwrap();
    let result = arrangement.certify(input);
    assert_eq!(
        (
            result,
            arrangement.stats().leaves,
            arrangement.stats().pairs
        ),
        expected
    );
    let result = arrangement.certify_triangle_free(input, &[false; 3]);
    assert_eq!(
        (
            result,
            arrangement.stats().leaves,
            arrangement.stats().pairs
        ),
        expected
    );
    let mut exact = SimpleCubicTopologyWorkspace::new(TopologyLimits::default()).unwrap();
    let result = exact.certify(input);
    assert_eq!(
        (result, exact.stats().leaves, exact.stats().pairs),
        expected
    );
}

// ------------------------------------------------------------------------------------------
// Emitters for the TypeScript tests.

/// `e8-corner/v1` (frame `P3BRRND1`, written by `tests/geometry/e8-corner/corpus.ts`): every
/// path through the four `CubicFillWorkspace` entries and the fill-v0 cascade, in the digest
/// format of `p3_b0r_identity` (case, digest, allocations, code, crossings per line).
#[test]
#[ignore = "E8-U1 corpus digests; run by tests/geometry/e8-corner-corpus.test.ts"]
fn emit_e8_corner_digests() {
    let chunks = read_random(&read_file("P3_E8_CORNER_CORPUS"));
    let threads = thread::available_parallelism()
        .map_or(1, usize::from)
        .clamp(1, 8);
    let next = AtomicUsize::new(0);
    let results: Vec<Mutex<Option<String>>> = chunks.iter().map(|_| Mutex::new(None)).collect();
    thread::scope(|scope| {
        let workers: Vec<_> = (0..threads)
            .map(|_| {
                thread::Builder::new()
                    .stack_size(THREAD_STACK_BYTES)
                    .spawn_scoped(scope, || loop {
                        let index = next.fetch_add(1, Ordering::Relaxed);
                        let Some(chunk) = chunks.get(index) else {
                            break;
                        };
                        let text = run_chunk(chunk);
                        *results[index].lock().expect("result slot") = Some(text);
                    })
                    .expect("spawn E8 worker")
            })
            .collect();
        for worker in workers {
            worker.join().expect("E8 worker panicked");
        }
    });
    let mut output = String::new();
    for slot in results {
        output.push_str(&slot.into_inner().expect("result slot").expect("chunk ran"));
    }
    let path = env::var("P3_E8_CORNER_OUTPUT").expect("P3_E8_CORNER_OUTPUT is required");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .expect("create exclusive E8 output");
    file.write_all(output.as_bytes()).expect("write E8 output");
}

fn status_name(result: Result<(), TopologyError>) -> &'static str {
    match result {
        Ok(()) => "CERTIFIED",
        Err(TopologyError::InvalidLimits) => "INVALID_LIMITS",
        Err(TopologyError::AllocationFailed) => "ALLOCATION_FAILED",
        Err(TopologyError::ByteLimit) => "BYTE_LIMIT",
        Err(TopologyError::InvalidInput) => "INVALID_INPUT",
        Err(TopologyError::InvalidProvenance) => "INVALID_PROVENANCE",
        Err(TopologyError::KnotMismatch) => "KNOT_MISMATCH",
        Err(TopologyError::Unresolved) => "UNRESOLVED",
        Err(TopologyError::WorkLimit) => "WORK_LIMIT",
    }
}

fn hex_point(output: &mut String, point: Point) {
    let _ = write!(
        output,
        "[\"{:016x}\",\"{:016x}\"]",
        point.x.to_bits(),
        point.y.to_bits()
    );
}

/// One input line per path: `id`, tolerance exponent, comma-separated verbs and comma-separated
/// hexadecimal binary64 scalars, tab-separated. Each path runs the S1 prefix with the fill-v0
/// caps; its topology input is built exactly as `CubicFillWorkspace::certify_topology` builds
/// it, and certified by P3.2n, P3.2s and P3.2x at the TypeScript oracles' default ceilings
/// (4 contours, 16 cubics, 64 leaves, 2,016 pairs). One JSON object per path is printed.
#[test]
#[ignore = "E8-U1 topology inputs; run by tests/geometry/native-e8-corner.test.ts"]
fn emit_e8_corner_topology() {
    let text = String::from_utf8(read_file("P3_E8_TOPOLOGY_INPUT")).expect("UTF-8 input");
    let limits = TopologyLimits {
        max_contours: 4,
        max_cubics: 16,
        max_leaves: 64,
        max_pairs: 2_016,
        ..TopologyLimits::default()
    };
    let mut rounded = RoundedKnotCubicTopologyWorkspace::new(limits).unwrap();
    let mut arrangement = TransverseArrangementWorkspace::new(limits).unwrap();
    let mut workspace = CubicFillWorkspace::new(FILL_V0_LIMITS).unwrap();
    println!("P3_E8_CORNER_TOPOLOGY_BEGIN");
    for row in text.lines().filter(|row| !row.is_empty()) {
        let fields: Vec<&str> = row.split('\t').collect();
        assert_eq!(fields.len(), 4, "E8 topology input row");
        let exponent: i32 = fields[1].parse().expect("exponent");
        let verbs: Vec<u8> = fields[2]
            .split(',')
            .map(|value| value.parse().expect("verb"))
            .collect();
        let point_bytes: Vec<u8> = fields[3]
            .split(',')
            .flat_map(|value| {
                f64::from_bits(u64::from_str_radix(value, 16).expect("scalar bits")).to_le_bytes()
            })
            .collect();
        let (flatten, _) = tolerances(exponent);
        let input = PathInput::from_test_parts(
            Request {
                request_id: 0,
                source_epoch: 0,
                source_revision: 0,
                tolerance: flatten,
            },
            &verbs,
            &point_bytes,
        );
        let mut output = String::new();
        let _ = write!(output, "{{\"id\":\"{}\",\"exponent\":{exponent}", fields[0]);
        let Ok(view) = workspace.prepare_prefix(input, MAX_FLAT_COMMANDS) else {
            println!("{output},\"prefix\":\"FAILED\"}}");
            continue;
        };
        // `certify_topology`: one topology cubic per non-degenerate source, its LINE commands
        // as leaves, contours in source-range order.
        let mut contours: Vec<TopologyRange> = Vec::new();
        let mut cubics: Vec<TopologyCubic> = Vec::new();
        let mut leaves: Vec<TopologyLeaf> = Vec::new();
        let mut kinds: Vec<bool> = Vec::new();
        let mut contour_index = usize::MAX;
        for source in view.sources.iter().copied() {
            if source.contour() != contour_index {
                contour_index = source.contour();
                contours.push(TopologyRange {
                    start: cubics.len(),
                    count: 0,
                });
            }
            if matches!(source, DecodedSource::Line { points: [a, b], .. } if a == b) {
                continue;
            }
            let leaf_start = leaves.len();
            for command in view.commands {
                if command.verb == VERB_LINE
                    && command.provenance.source_verb == source.source_verb()
                {
                    leaves.push(TopologyLeaf {
                        end: command.point.expect("LINE point"),
                        provenance: command.provenance,
                    });
                }
            }
            let (points, kind) = match source {
                DecodedSource::Line { points: [a, b], .. } => ([a, a, b, b], true),
                DecodedSource::Cubic { points, .. } => (points, false),
            };
            kinds.push(kind);
            cubics.push(TopologyCubic {
                points,
                source_verb: source.source_verb(),
                leaves: TopologyRange {
                    start: leaf_start,
                    count: leaves.len() - leaf_start,
                },
            });
            contours.last_mut().expect("open contour").count += 1;
        }
        assert!(view
            .commands
            .iter()
            .any(|command| command.verb == VERB_LINE));
        assert!(verbs.contains(&VERB_CUBIC));
        let topology = TopologyInput {
            contours: &contours,
            cubics: &cubics,
            leaves: &leaves,
        };
        output.push_str(",\"contours\":[");
        for (contour_number, contour) in contours.iter().enumerate() {
            if contour_number > 0 {
                output.push(',');
            }
            output.push('[');
            for (offset, cubic) in cubics[contour.start..contour.start + contour.count]
                .iter()
                .enumerate()
            {
                if offset > 0 {
                    output.push(',');
                }
                output.push_str("{\"cubic\":[");
                for (index, point) in cubic.points.iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    hex_point(&mut output, *point);
                }
                let _ = write!(
                    output,
                    "],\"sourceVerbOrdinal\":{},\"line\":{},\"lines\":[",
                    cubic.source_verb,
                    kinds[contour.start + offset]
                );
                for (index, leaf) in leaves
                    [cubic.leaves.start..cubic.leaves.start + cubic.leaves.count]
                    .iter()
                    .enumerate()
                {
                    if index > 0 {
                        output.push(',');
                    }
                    output.push_str("{\"end\":");
                    hex_point(&mut output, leaf.end);
                    let _ = write!(
                        output,
                        ",\"provenance\":{{\"sourceVerbOrdinal\":{},\"endNumerator\":{},\"depth\":{}}}}}",
                        leaf.provenance.source_verb,
                        leaf.provenance.end_numerator,
                        leaf.provenance.depth
                    );
                }
                output.push_str("]}");
            }
            output.push(']');
        }
        output.push(']');
        let results = [
            ("rounded", rounded.certify(topology), rounded.stats()),
            (
                "transverse",
                arrangement.certify(topology),
                arrangement.stats(),
            ),
            (
                "triangleFree",
                arrangement.certify_triangle_free(topology, &kinds),
                arrangement.stats(),
            ),
        ];
        for (name, result, stats) in results {
            let _ = write!(
                output,
                ",\"{name}\":{{\"status\":\"{}\",\"leaves\":{},\"pairs\":{}}}",
                status_name(result),
                stats.leaves,
                stats.pairs
            );
        }
        println!("{output}}}");
    }
    println!("P3_E8_CORNER_TOPOLOGY_END");
}
