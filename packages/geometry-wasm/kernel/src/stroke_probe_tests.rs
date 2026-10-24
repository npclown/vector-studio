//! P3 B2 unit ST-U3b (`docs/plans/p3-b2-stroke-contract.md` section 12.1, decision B2-Q8): the
//! native scaling probe of line strokes after ST-U3. Test-only. It times
//! `StrokeWorkspace::build` on families of line strokes that scale in segment count, join, cap,
//! width and tolerance exponent, and prints the per-stroke median time with the arrangement
//! counts (pieces, vertices, edges, pair checks, events, sections, nodes, work units,
//! triangles) and fitted log-log growth slopes.
//!
//! **Diagnostic, not evidence.** B2-Q8 fixes no threshold and no performance claim; the output
//! is an observation reported to the user with a recommendation on ST-U9. The test changes no
//! output, writes no file and commits no result record.
//!
//! The ignored test runs only by hand, in the release profile, with one test thread:
//!
//! ```text
//! cargo test --manifest-path packages/geometry-wasm/kernel/Cargo.toml --release --lib \
//!     --locked --offline stroke_probe_tests -- --ignored --nocapture --test-threads 1
//! ```
//!
//! Optional environment: `P3_STROKE_PROBE_BUDGET_MS` (default 200), the timed budget per case.
//! Each case runs one untimed build on a fresh workspace, whose `RoundedFillStats` start at
//! zero, so a zero edge count means the arrangement never ran (a front-end failure). The timed
//! builds then reuse one workspace, as production does, until the budget is spent (at least one,
//! at most 101 builds), and the median is reported. Every timed build must give the counting
//! build's outcome.
//!
//! A `work-limit` is labelled by where it arose: `front:pieces` (the 512-piece cap),
//! `front:vertices` (more than 1,024 emitted vertices, the arrangement's `InputLimit` preflight),
//! `front:other` (another front-end limit, such as `DiskLimit`), or `arr:<counter>` for the first
//! arrangement counter found at its `STROKE_V0_LIMITS` cap (`arr` alone when none is). The
//! `emitted` column is the vertex total of the emitted pieces, which counts beyond the stored
//! ones.
use core::hint::black_box;
use std::env;
use std::time::Instant;

use crate::geometry::{VERB_LINE, VERB_MOVE};
use crate::rounded_line_fill::RoundedFillStats;
use crate::stroke_outline::{
    StrokeCap, StrokeJoin, StrokeOutcome, StrokeRequest, StrokeWorkspace, MAX_PIECES,
    STROKE_PATH_EMPTY, STROKE_PATH_INVALID_PATH, STROKE_PATH_INVALID_STROKE,
    STROKE_PATH_INVALID_TOLERANCE, STROKE_PATH_NUMERIC_RANGE, STROKE_PATH_UNSUPPORTED_GEOMETRY,
    STROKE_PATH_WORK_LIMIT, STROKE_V0_LIMITS,
};

const CAPS: [StrokeCap; 3] = [StrokeCap::Butt, StrokeCap::Round, StrokeCap::Square];
const JOINS: [StrokeJoin; 3] = [StrokeJoin::Miter, StrokeJoin::Round, StrokeJoin::Bevel];
pub(crate) const SEGMENTS: [usize; 10] = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];
const MITER_LIMIT: f64 = 4.0;
/// Zoom 1, DPR 1 in the s2 mapping `e = floor(log2(0.125 / (zoom * DPR)))`.
const BASE_EXPONENT: i32 = -3;
const BASE_WIDTH: f64 = 2.0;
/// Zigzag step: each segment is `(16, ±16)`, a 90° turn at every interior vertex.
const ZIGZAG_STEP: f64 = 16.0;
/// Chord family: points on a circle of this radius at multiples of the golden angle, so most
/// segments cross many others (crossings grow quadratically in the segment count).
const CHORD_RADIUS: f64 = 100.0;
const GOLDEN_ANGLE: f64 = 2.399_963_229_728_653;
const MAX_TIMED_BUILDS: usize = 101;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Family {
    Zigzag,
    Chords,
}

impl Family {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Family::Zigzag => "zigzag",
            Family::Chords => "chords",
        }
    }
}

fn cap_name(cap: StrokeCap) -> &'static str {
    match cap {
        StrokeCap::Butt => "butt",
        StrokeCap::Round => "round",
        StrokeCap::Square => "square",
    }
}

fn join_name(join: StrokeJoin) -> &'static str {
    match join {
        StrokeJoin::Miter => "miter",
        StrokeJoin::Round => "round",
        StrokeJoin::Bevel => "bevel",
    }
}

/// An open polyline of `segments` LINE verbs, as verbs and little-endian point bytes.
pub(crate) fn polyline(family: Family, segments: usize) -> (Vec<u8>, Vec<u8>) {
    let mut verbs = Vec::with_capacity(segments + 1);
    let mut bytes = Vec::with_capacity((segments + 1) * 16);
    for index in 0..=segments {
        let (x, y) = match family {
            Family::Zigzag => (ZIGZAG_STEP * index as f64, ZIGZAG_STEP * (index % 2) as f64),
            Family::Chords => {
                let angle = GOLDEN_ANGLE * index as f64;
                (CHORD_RADIUS * angle.cos(), CHORD_RADIUS * angle.sin())
            }
        };
        verbs.push(if index == 0 { VERB_MOVE } else { VERB_LINE });
        bytes.extend(x.to_le_bytes());
        bytes.extend(y.to_le_bytes());
    }
    (verbs, bytes)
}

#[derive(Clone, Copy, Debug)]
struct Case {
    family: Family,
    segments: usize,
    join: StrokeJoin,
    cap: StrokeCap,
    width: f64,
    exponent: i32,
}

impl Case {
    fn request(self) -> StrokeRequest {
        StrokeRequest {
            request_id: 1,
            width: self.width,
            cap: self.cap,
            join: self.join,
            miter_limit: MITER_LIMIT,
            exponent: self.exponent,
        }
    }
}

struct Observation {
    case: Case,
    outcome: StrokeOutcome,
    status: String,
    pieces: usize,
    emitted_vertices: usize,
    triangles: usize,
    stats: RoundedFillStats,
    median_ns: u64,
    builds: usize,
}

fn status_name(
    outcome: StrokeOutcome,
    stats: &RoundedFillStats,
    pieces: usize,
    emitted_vertices: usize,
) -> String {
    let status = match outcome {
        StrokeOutcome::Mesh => return "ok".to_string(),
        StrokeOutcome::Status(status) => status,
    };
    let name = match status {
        STROKE_PATH_EMPTY => "empty",
        STROKE_PATH_INVALID_PATH => "invalid-path",
        STROKE_PATH_INVALID_TOLERANCE => "invalid-tolerance",
        STROKE_PATH_NUMERIC_RANGE => "numeric-range",
        STROKE_PATH_WORK_LIMIT => "work-limit",
        STROKE_PATH_UNSUPPORTED_GEOMETRY => "unsupported-geometry",
        STROKE_PATH_INVALID_STROKE => "invalid-stroke",
        _ => "unknown",
    };
    if status != STROKE_PATH_WORK_LIMIT {
        return name.to_string();
    }
    // The counting build ran on a fresh workspace, so zero edges means no arrangement call.
    // Otherwise the first counter found at its cap names the likely arrangement limit.
    let limits = STROKE_V0_LIMITS;
    let stage = if stats.edges == 0 && stats.input_vertices == 0 {
        if pieces >= MAX_PIECES {
            "front:pieces"
        } else if emitted_vertices > limits.max_input_vertices {
            "front:vertices"
        } else {
            "front:other"
        }
    } else if stats.work_units >= limits.max_work {
        "arr:work"
    } else if stats.events >= limits.max_events {
        "arr:events"
    } else if stats.sections >= limits.max_sections {
        "arr:sections"
    } else if stats.nodes >= limits.max_nodes {
        "arr:nodes"
    } else if stats.cells >= limits.max_cells {
        "arr:cells"
    } else if stats.boundaries >= limits.max_boundaries {
        "arr:boundaries"
    } else if stats.contributors >= limits.max_contributors {
        "arr:contributors"
    } else {
        "arr"
    };
    format!("{name}({stage})")
}

fn budget_ns() -> u64 {
    let ms = env::var("P3_STROKE_PROBE_BUDGET_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(200);
    ms * 1_000_000
}

fn observe(timed: &mut StrokeWorkspace, case: Case, budget: u64) -> Observation {
    let (verbs, bytes) = polyline(case.family, case.segments);
    let request = case.request();
    // Untimed counting build on a fresh workspace (zeroed stats).
    let mut counting = StrokeWorkspace::new().expect("stroke workspace");
    let outcome = counting
        .build(request, &verbs, &bytes)
        .expect("no self-check failure");
    let stats = counting.rounded_stats();
    let emitted = || counting.pieces().iter().filter(|piece| !piece.dropped);
    let pieces = emitted().count();
    let emitted_vertices = emitted().map(|piece| piece.count).sum::<usize>();
    let triangles = match outcome {
        StrokeOutcome::Mesh => counting.mesh().map_or(0, |(_, t, _)| t.len() / 3),
        StrokeOutcome::Status(_) => 0,
    };
    drop(counting);
    let status = status_name(outcome, &stats, pieces, emitted_vertices);
    // Warm-up on the reused workspace, then timed builds.
    let warm = timed
        .build(request, &verbs, &bytes)
        .expect("no self-check failure");
    assert_eq!(warm, outcome, "nondeterministic outcome");
    let mut samples = Vec::with_capacity(MAX_TIMED_BUILDS);
    let mut spent = 0u64;
    while samples.len() < MAX_TIMED_BUILDS && (samples.is_empty() || spent < budget) {
        let start = Instant::now();
        let result = timed.build(black_box(request), black_box(&verbs), black_box(&bytes));
        let elapsed = u64::try_from(start.elapsed().as_nanos()).unwrap_or(u64::MAX);
        assert_eq!(
            black_box(result).expect("no self-check failure"),
            outcome,
            "nondeterministic outcome"
        );
        samples.push(elapsed);
        spent = spent.saturating_add(elapsed);
    }
    samples.sort_unstable();
    Observation {
        case,
        outcome,
        status,
        pieces,
        emitted_vertices,
        triangles,
        stats,
        median_ns: samples[samples.len() / 2],
        builds: samples.len(),
    }
}

fn print_header() {
    println!(
        "| family | n | join | cap | w | e | status | pieces | emitted | vertices | edges | pairs \
         | events | sections | nodes | work | tris | median µs | builds |"
    );
    println!(
        "|---|---:|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"
    );
}

fn print_row(observation: &Observation) {
    let case = observation.case;
    let stats = &observation.stats;
    println!(
        "| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} \
         | {:.1} | {} |",
        case.family.name(),
        case.segments,
        join_name(case.join),
        cap_name(case.cap),
        case.width,
        case.exponent,
        observation.status,
        observation.pieces,
        observation.emitted_vertices,
        stats.input_vertices,
        stats.edges,
        stats.pair_checks,
        stats.events,
        stats.sections,
        stats.nodes,
        stats.work_units,
        observation.triangles,
        observation.median_ns as f64 / 1_000.0,
        observation.builds,
    );
}

/// Least-squares slope of `ln y` against `ln x`; `None` below three points.
fn slope(points: &[(f64, f64)]) -> Option<f64> {
    if points.len() < 3 {
        return None;
    }
    let count = points.len() as f64;
    let (sx, sy) = points
        .iter()
        .fold((0.0, 0.0), |(sx, sy), (x, y)| (sx + x.ln(), sy + y.ln()));
    let (mx, my) = (sx / count, sy / count);
    let (mut sxy, mut sxx) = (0.0, 0.0);
    for (x, y) in points {
        sxy += (x.ln() - mx) * (y.ln() - my);
        sxx += (x.ln() - mx) * (x.ln() - mx);
    }
    (sxx > 0.0).then(|| sxy / sxx)
}

fn format_slope(value: Option<f64>) -> String {
    value.map_or_else(|| "—".to_string(), |slope| format!("{slope:.2}"))
}

/// Slopes over the `ok` cases with `n ≥ 8` of one (family, join, cap) series, or with `n ≥ 2`
/// when fewer than three such cases exist.
fn print_slopes(observations: &[Observation]) {
    println!();
    println!(
        "Slopes (ln-ln least squares over `ok` cases with n >= 8, or n >= 2 when fewer than \
         three):"
    );
    println!();
    println!(
        "| family | join | cap | ok n range | time/n | time/edges | edges/n | sections/n | \
         pairs/n | work/n | time/work |"
    );
    println!("|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|");
    for family in [Family::Zigzag, Family::Chords] {
        for join in JOINS {
            for cap in CAPS {
                let ok_from = |least: usize| -> Vec<&Observation> {
                    observations
                        .iter()
                        .filter(|o| {
                            o.case.family == family
                                && o.case.join == join
                                && o.case.cap == cap
                                && o.case.segments >= least
                                && o.outcome == StrokeOutcome::Mesh
                        })
                        .collect()
                };
                let mut series = ok_from(8);
                if series.len() < 3 {
                    series = ok_from(2);
                }
                let pick = |f: &dyn Fn(&Observation) -> (f64, f64)| -> Option<f64> {
                    slope(&series.iter().map(|o| f(o)).collect::<Vec<_>>())
                };
                let n = |o: &Observation| o.case.segments as f64;
                let time = |o: &Observation| o.median_ns as f64;
                let range = match (series.first(), series.last()) {
                    (Some(first), Some(last)) => {
                        format!("{}-{}", first.case.segments, last.case.segments)
                    }
                    _ => "none".to_string(),
                };
                println!(
                    "| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |",
                    family.name(),
                    join_name(join),
                    cap_name(cap),
                    range,
                    format_slope(pick(&|o| (n(o), time(o)))),
                    format_slope(pick(&|o| (o.stats.edges as f64, time(o)))),
                    format_slope(pick(&|o| (n(o), o.stats.edges as f64))),
                    format_slope(pick(&|o| (n(o), o.stats.sections as f64))),
                    format_slope(pick(&|o| (n(o), o.stats.pair_checks as f64))),
                    format_slope(pick(&|o| (n(o), o.stats.work_units as f64))),
                    format_slope(pick(&|o| (o.stats.work_units as f64, time(o)))),
                );
            }
        }
    }
}

#[test]
fn polylines_have_the_requested_segment_count() {
    for family in [Family::Zigzag, Family::Chords] {
        for segments in SEGMENTS {
            let (verbs, bytes) = polyline(family, segments);
            assert_eq!(verbs.len(), segments + 1);
            assert_eq!(bytes.len(), 16 * (segments + 1));
            assert_eq!(verbs[0], VERB_MOVE);
            assert!(verbs[1..].iter().all(|&verb| verb == VERB_LINE));
        }
    }
    assert_eq!(slope(&[(1.0, 3.0), (2.0, 12.0), (4.0, 48.0)]), Some(2.0));
}

#[test]
#[ignore = "B2-Q8 ST-U3b scaling probe; release profile, --nocapture; diagnostic, not evidence"]
fn stroke_scaling_probe() {
    let budget = budget_ns();
    let mut timed = StrokeWorkspace::new().expect("stroke workspace");
    println!("ST-U3b stroke scaling probe: diagnostic, not evidence; no threshold.");
    println!(
        "miter limit {MITER_LIMIT}; zigzag step {ZIGZAG_STEP}; chord radius {CHORD_RADIUS}; \
         budget {} ms per case",
        budget / 1_000_000
    );

    println!();
    println!("Table 1: segments x join x cap (w = {BASE_WIDTH}, e = {BASE_EXPONENT}).");
    println!();
    print_header();
    let mut grid = Vec::new();
    for family in [Family::Zigzag, Family::Chords] {
        for join in JOINS {
            for cap in CAPS {
                for segments in SEGMENTS {
                    let case = Case {
                        family,
                        segments,
                        join,
                        cap,
                        width: BASE_WIDTH,
                        exponent: BASE_EXPONENT,
                    };
                    let observation = observe(&mut timed, case, budget);
                    print_row(&observation);
                    grid.push(observation);
                }
            }
        }
    }
    print_slopes(&grid);

    let pairs = [
        (StrokeJoin::Miter, StrokeCap::Butt),
        (StrokeJoin::Round, StrokeCap::Round),
    ];
    println!();
    println!("Table 2: width (zigzag, n = 32, e = {BASE_EXPONENT}).");
    println!();
    print_header();
    for (join, cap) in pairs {
        for width in [0.0625, 0.25, 1.0, 2.0, 4.0, 16.0, 64.0] {
            let case = Case {
                family: Family::Zigzag,
                segments: 32,
                join,
                cap,
                width,
                exponent: BASE_EXPONENT,
            };
            print_row(&observe(&mut timed, case, budget));
        }
    }

    println!();
    println!("Table 3: tolerance exponent (zigzag, n = 32, w = {BASE_WIDTH}).");
    println!();
    print_header();
    for (join, cap) in pairs {
        for exponent in [3, 0, -3, -6, -9, -11, -14] {
            let case = Case {
                family: Family::Zigzag,
                segments: 32,
                join,
                cap,
                width: BASE_WIDTH,
                exponent,
            };
            print_row(&observe(&mut timed, case, budget));
        }
    }
}
