//! B0R unit U7 oracles for the loop restructurings L3 (the four column-by-edge scans) and L4
//! (`lookup_section_node`) of the rounded tessellation
//! (docs/plans/p3-b0r-kernel-performance-contract.md sections 5.4 and 7: O8, O10 and O11).
//!
//! - O10: in shadow mode every L3 scan and every L4 call also runs the `cfg(test)` copy of the
//!   pre-U7 loop from the same state and compares the result (with the windings or node it
//!   returns), every counter, every buffer length and the pushed records. With scan variants
//!   on, both also run under reduced budgets and push limits, so the comparison covers failures.
//! - O11: Corollary C1 with charging bodies and Lemma C through L3 and L4, with exhaustive
//!   variants: every budget from a call's start to one past its charge total, so that each scan
//!   fails at each of its iterations and at each charge inside an active body (the lookups of
//!   `build_column_span`), and every push limit (`SectionLimit`, `ContributorLimit`); and L4 on
//!   synthetic section ranges at every match offset, without a match, and at every budget.
//!
//! The full-size runs are `#[ignore]` tests in the release profile, run by
//! `pnpm test:p3-fill-identity`; the ordinary tests are the smoke versions and the O8 checks.
use std::time::Instant;

use crate::fill_filter::{take_shadow_tally, with_fault, with_shadow, Fault};
use crate::fill_filter_tests::{parallel, pow2, share, Rng, ORACLE_SHARDS, THREAD_STACK_BYTES};
use crate::geometry::Point;
use crate::line_fill::LineFillRule;
use crate::p3_b0r_identity::{read_b0, read_file, read_random, run_chunk};
use crate::rounded_line_fill::{
    take_scan_counts, take_scan_tally, with_scan_variants, LoopImpl, RoundedFillError,
    RoundedFillLimits, RoundedFillWorkspace, RoundedSection, ScanCounts, ScanLoop, ScanShadowTally,
    SourceRange,
};

const LIMITS: RoundedFillLimits = RoundedFillLimits {
    max_contours: 16,
    max_input_vertices: 96,
    max_edges: 96,
    max_pairs: 4560,
    max_events: 2200,
    max_sections: 16384,
    max_nodes: 2048,
    max_cells: 2048,
    max_boundaries: 4096,
    max_contributors: 65536,
    max_vertices: 2048,
    max_triangles: 4096,
    max_work: 4_000_000,
    max_bytes: 64 * 1024 * 1024,
};

type Scene = (Vec<Vec<Point>>, LineFillRule, f64);

fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}

/// The frozen `p3-rounded-fill-v1` rows: contours, rule and tau.
fn fixture_scenes() -> Vec<Scene> {
    let source = include_str!("../../../../tests/fixtures/p3-rounded-fill-v1.txt");
    let parse = |text: &str| f64::from_bits(u64::from_str_radix(text, 16).unwrap());
    source
        .lines()
        .filter(|line| !line.starts_with('#'))
        .map(|line| {
            let mut pieces = line.split(" | ");
            let fields: Vec<_> = pieces.next().unwrap().split(' ').collect();
            let rule = if fields[1] == "nonzero" {
                LineFillRule::Nonzero
            } else {
                LineFillRule::Evenodd
            };
            let contours = pieces
                .map(|contour| {
                    contour
                        .split(' ')
                        .map(|entry| {
                            let (x, y) = entry.split_once(',').unwrap();
                            point(parse(x), parse(y))
                        })
                        .collect()
                })
                .collect();
            (contours, rule, parse(fields[2]))
        })
        .collect()
}

/// Seeded scenes of at most 3 contours with at most `max_vertices` vertices each (at most 63
/// edges for `max_vertices` 21, inside L3's size guard): lattice polygons, whose vertical,
/// collinear and touching edges share columns and give vertical spans; star polygons with many
/// crossings; and random polygons, at scales 2^-30 to 2^30.
fn scan_scenes(seed: u64, count: usize, max_vertices: u64) -> Vec<Scene> {
    let mut rng = Rng::new(seed);
    (0..count)
        .map(|_| {
            let unit = pow2(rng.range_i32(-30, 30));
            let contours = (0..1 + rng.below(3))
                .map(|_| {
                    let vertices = 3 + rng.below(max_vertices - 2) as usize;
                    match rng.below(3) {
                        0 => (0..vertices)
                            .map(|_| {
                                point((rng.below(6) as f64) * unit, (rng.below(6) as f64) * unit)
                            })
                            .collect(),
                        1 => {
                            let step = 1 + rng.below(vertices as u64 - 1) as usize;
                            let radius = (1 + rng.below(4)) as f64 * unit;
                            let center = (rng.below(4) as f64) * unit;
                            (0..vertices)
                                .map(|index| {
                                    let angle = core::f64::consts::TAU
                                        * ((index * step) % vertices) as f64
                                        / vertices as f64;
                                    point(center + radius * angle.cos(), radius * angle.sin())
                                })
                                .collect()
                        }
                        _ => (0..vertices)
                            .map(|_| {
                                point(
                                    rng.scaled_in(-4, 3, true) * unit,
                                    rng.scaled_in(-4, 3, true) * unit,
                                )
                            })
                            .collect(),
                    }
                })
                .collect();
            let rule = if rng.chance(1, 2) {
                LineFillRule::Nonzero
            } else {
                LineFillRule::Evenodd
            };
            (contours, rule, pow2(-rng.range_i32(2, 40)))
        })
        .collect()
}

/// The observable outcome of one tessellation: result, counters and the published output.
fn outcome(
    workspace: &RoundedFillWorkspace,
    result: Result<(), RoundedFillError>,
) -> (Result<(), RoundedFillError>, String) {
    let output = workspace.output().map(|output| {
        let vertices: Vec<(u64, u64)> = output
            .vertices
            .iter()
            .map(|vertex| (vertex.x.to_bits(), vertex.y.to_bits()))
            .collect();
        format!(
            "{vertices:?} {:?} {:?} {:?} {:?} {:?} {:?} {:?}",
            output.indices,
            output.sections,
            output.cells,
            output.boundaries,
            output.spans,
            output.contributors,
            output.columns.len()
        )
    });
    (result, format!("{:?} {output:?}", workspace.stats()))
}

/// Tessellates every scene with shadow mode off, then on with scan variants (sampled, or
/// exhaustive); the outcomes must be equal, and the scan tally of the second runs is returned
/// with the number of `ok` scenes.
fn shadow_scans(scenes: &[Scene], exhaustive: bool) -> (ScanShadowTally, usize) {
    let mut workspace = RoundedFillWorkspace::new(LIMITS).unwrap();
    let mut ok = 0;
    take_scan_tally();
    for (contours, rule, tau) in scenes {
        let references: Vec<&[Point]> = contours.iter().map(Vec::as_slice).collect();
        let result = workspace.tessellate(&references, *rule, *tau);
        let plain = outcome(&workspace, result);
        let result = with_shadow(|| {
            with_scan_variants(exhaustive, || {
                workspace.tessellate(&references, *rule, *tau)
            })
        });
        assert_eq!(plain, outcome(&workspace, result));
        ok += usize::from(result.is_ok());
    }
    take_shadow_tally();
    (take_scan_tally(), ok)
}

fn assert_every_kind(tally: &ScanShadowTally) {
    assert!(tally.calls.iter().all(|&calls| calls > 0), "{tally:?}");
}

// ---------------------------------------------------------------------------------------------
// O11, L4 on synthetic section ranges.

#[derive(Clone, Copy, Debug, Default)]
struct LookupTally {
    runs: u64,
    matches: u64,
    no_match: u64,
    work_limit: u64,
    mismatches: u64,
}

impl LookupTally {
    fn merge(&mut self, other: Self) {
        self.runs += other.runs;
        self.matches += other.matches;
        self.no_match += other.no_match;
        self.work_limit += other.work_limit;
        self.mismatches += other.mismatches;
    }
}

/// L4 against the reference copy of the current loop: for `cases` random column ranges of
/// length 0-`max_range` (with repeated edges and endpoints, so earlier near-matches exist), a
/// lookup of each record and of absent keys, at random starting `work_units` and at every
/// budget from the start to one past the charge total (Lemma C).
fn lookup_differential(seed: u64, cases: u64, max_range: u64) -> LookupTally {
    let mut rng = Rng::new(seed);
    let mut tally = LookupTally::default();
    let mut workspace = RoundedFillWorkspace::new(LIMITS).unwrap();
    for _ in 0..cases {
        let before = rng.below(4) as usize;
        let length = rng.below(max_range + 1) as usize;
        let sections: Vec<RoundedSection> = (0..before + length + rng.below(4) as usize)
            .map(|index| RoundedSection {
                column: 0,
                node: 1000 + index,
                edge: rng.below(5) as usize,
                endpoint: rng.below(3) as u8,
            })
            .collect();
        let ranges = [
            SourceRange {
                start: 0,
                count: before,
            },
            SourceRange {
                start: before,
                count: length,
            },
        ];
        workspace.b0r_load_lookup(&sections, &ranges);
        let mut keys: Vec<(usize, u8)> = sections[before..before + length]
            .iter()
            .map(|section| (section.edge, section.endpoint))
            .collect();
        keys.extend([(rng.below(7) as usize, rng.below(3) as u8), (9, 0)]);
        for (edge, endpoint) in keys {
            let scan = ScanLoop::Lookup {
                column: 1,
                edge,
                endpoint,
            };
            let start = rng.below(100);
            let total = length as u64 + 1;
            for budget in start..=start + total + 1 {
                let mut reference = workspace.clone();
                reference.b0r_set_budget(start, budget, LIMITS.max_events);
                let mut restructured = reference.clone();
                let expected = reference.b0r_run_scan(scan, LoopImpl::Reference);
                let result = restructured.b0r_run_scan(scan, LoopImpl::Restructured);
                tally.runs += 1;
                tally.matches += u64::from(expected.is_ok());
                tally.no_match += u64::from(expected == Err(RoundedFillError::InternalInvariant));
                tally.work_limit += u64::from(expected == Err(RoundedFillError::WorkLimit));
                tally.mismatches += u64::from(
                    expected != result
                        || reference.b0r_loop_state().0 != restructured.b0r_loop_state().0,
                );
            }
        }
    }
    tally
}

// ---------------------------------------------------------------------------------------------
// O10 smoke: shadow mode with sampled scan variants.

#[test]
fn b0r_o10_smoke_scan_loops_fixture_rows() {
    let scenes = fixture_scenes();
    assert_eq!(scenes.len(), 202);
    let (tally, ok) = shadow_scans(&scenes, false);
    println!("B0R O10 L3/L4 smoke fixture rows: {ok} ok, {tally:?}");
    assert_every_kind(&tally);
    assert!(
        tally.work_limit > 1_000 && tally.push_limit > 100,
        "{tally:?}"
    );
    assert!(tally.sampled_calls > 0 && tally.exhaustive_calls == 0);
    assert_eq!(tally.mismatches, 0, "{tally:?}");
}

#[test]
fn b0r_o10_smoke_scan_loops_random_scenes() {
    let scenes = scan_scenes(0x4230_5237_0010, 12, 9);
    let (tally, ok) = shadow_scans(&scenes, false);
    println!("B0R O10 L3/L4 smoke random scenes: {ok} ok, {tally:?}");
    assert!(ok > 0, "{ok}");
    assert!(tally.work_limit > 0, "{tally:?}");
    assert_eq!(tally.mismatches, 0, "{tally:?}");
}

// ---------------------------------------------------------------------------------------------
// O11 smoke.

/// Corollary C1 with charging bodies: every failing budget and push limit of every L3 and L4
/// call of a few small scenes.
#[test]
fn b0r_o11_smoke_scan_failure_points() {
    let scenes = scan_scenes(0x4230_5237_0011, 4, 7);
    let (tally, ok) = shadow_scans(&scenes, true);
    println!("B0R O11 L3/L4 smoke: {ok} ok, {tally:?}");
    assert!(ok > 0, "{ok}");
    assert!(tally.exhaustive_calls > 0 && tally.sampled_calls == 0);
    assert!(
        tally.work_limit > 1_000 && tally.push_limit > 0,
        "{tally:?}"
    );
    assert_eq!(tally.mismatches, 0, "{tally:?}");
}

/// L4 at every match offset, without a match and at every budget (Lemma C).
#[test]
fn b0r_o11_smoke_lookup_every_budget() {
    let tally = lookup_differential(0x4230_5237_0012, 2_000, 12);
    println!("B0R O11 L4 smoke: {tally:?}");
    assert!(
        tally.matches > 1_000 && tally.no_match > 100 && tally.work_limit > 1_000,
        "{tally:?}"
    );
    assert_eq!(tally.mismatches, 0, "{tally:?}");
}

/// L3's size guard: 64 edges build the three phase sweeps and run sparse scans; 65 edges run
/// the current loops. The outcome is the same either way as the reference (O4 and the shadow
/// smoke tests); here the routing is checked.
#[test]
fn b0r_o11_scan_size_guard() {
    for (vertices, swept) in [(64usize, true), (65, false)] {
        let contour: Vec<Point> = (0..vertices)
            .map(|index| {
                let angle = core::f64::consts::TAU * index as f64 / vertices as f64;
                point(angle.cos(), angle.sin())
            })
            .collect();
        let mut workspace = RoundedFillWorkspace::new(LIMITS).unwrap();
        take_scan_counts();
        let result = workspace.tessellate(&[&contour], LineFillRule::Nonzero, pow2(-20));
        let counts = take_scan_counts();
        println!("B0R L3 size guard, {vertices} edges: {result:?}, {counts:?}");
        assert_eq!(result, Ok(()));
        if swept {
            assert_eq!(counts.sweeps, 3, "{counts:?}");
            assert!(counts.scans > 0 && counts.members < counts.iterations);
        } else {
            assert_eq!(counts.sweeps, 0, "{counts:?}");
            assert_eq!(counts.scans, 0, "{counts:?}");
        }
        // L4 has no size guard.
        assert!(counts.lookups > 0, "{counts:?}");
    }
}

// ---------------------------------------------------------------------------------------------
// O8 defects (11) for L3 and (14).

/// O8 (11) applied to L3, where Corollary C1 has charging bodies: one outer charge too few per
/// active member is detected by O10 shadow mode on the fixture rows and by the exhaustive O11
/// differential.
#[test]
fn b0r_o8_l3_outer_charge_short_is_detected() {
    let scenes = scan_scenes(0x4230_5237_0811, 2, 6);
    let (shadow, exhaustive) = with_fault(Fault::L3OuterChargeShort, || {
        let (shadow, _) = shadow_scans(&fixture_scenes()[..40], false);
        let (exhaustive, _) = shadow_scans(&scenes, true);
        (shadow, exhaustive)
    });
    println!("B0R O8 (11) for L3: {shadow:?}; {exhaustive:?}");
    assert!(shadow.mismatches > 0, "{shadow:?}");
    assert!(exhaustive.mismatches > 0, "{exhaustive:?}");
}

/// O8 (14): L4 charging q instead of q + 1 is detected by the O11 lookup differential and by
/// O10 shadow mode on the fixture rows.
#[test]
fn b0r_o8_l4_charge_short_is_detected() {
    let (lookups, shadow) = with_fault(Fault::L4ChargeShort, || {
        let lookups = lookup_differential(0x4230_5237_0814, 200, 12);
        let (shadow, _) = shadow_scans(&fixture_scenes()[..40], false);
        (lookups, shadow)
    });
    println!("B0R O8 (14): {lookups:?}; {shadow:?}");
    assert!(lookups.mismatches > 0, "{lookups:?}");
    assert!(shadow.mismatches > 0, "{shadow:?}");
}

// ---------------------------------------------------------------------------------------------
// Full-size oracles (release profile, `pnpm test:p3-fill-identity`).

/// Full O10 for L3 and L4 on the O4 corpora: every `CubicFillWorkspace` entry and the V2
/// cascade, by the identity harness's `run_chunk`, first with shadow mode off (scan counts),
/// then with shadow mode and sampled scan variants on (every L3 scan and L4 call compared with
/// the reference at its real limits and at reduced budgets and push limits).
#[test]
#[ignore = "B0R O10 full size; release profile via pnpm test:p3-fill-identity"]
fn b0r_oracle_full_o10_scan_loops() {
    for (label, chunks) in [
        ("B0", read_b0(&read_file("P3_B0R_B0_CORPUS"))),
        (
            "p3-b0r-random/v1",
            read_random(&read_file("P3_B0R_RANDOM_CORPUS")),
        ),
    ] {
        let start = Instant::now();
        let chunk_count = chunks.len();
        let threads = ORACLE_SHARDS;
        let chunks = std::sync::Arc::new(chunks);
        let handles: Vec<_> = (0..threads)
            .map(|worker| {
                let chunks = std::sync::Arc::clone(&chunks);
                std::thread::Builder::new()
                    .stack_size(THREAD_STACK_BYTES)
                    .spawn(move || {
                        take_scan_counts();
                        for chunk in chunks.iter().skip(worker).step_by(threads) {
                            run_chunk(chunk);
                        }
                        let counts = take_scan_counts();
                        take_scan_tally();
                        take_shadow_tally();
                        with_shadow(|| {
                            with_scan_variants(false, || {
                                for chunk in chunks.iter().skip(worker).step_by(threads) {
                                    run_chunk(chunk);
                                }
                            })
                        });
                        take_shadow_tally();
                        (counts, take_scan_tally())
                    })
                    .expect("spawn O10 scan worker")
            })
            .collect();
        let mut counts = ScanCounts::default();
        let mut tally = ScanShadowTally::default();
        for handle in handles {
            let (worker_counts, worker_tally) = handle.join().expect("O10 scan worker");
            counts.merge(worker_counts);
            tally.merge(worker_tally);
        }
        println!(
            "B0R O10 L3/L4 {label}: {chunk_count} chunks; shadow off: {counts:?}, active \
             fraction {:.4}; shadow with variants: {tally:?}; {threads} threads, {:.1} s",
            counts.members as f64 / counts.iterations.max(1) as f64,
            start.elapsed().as_secs_f64()
        );
        assert!(
            counts.sweeps > 0 && counts.scans > 0 && counts.lookups > 0,
            "{counts:?}"
        );
        assert!(tally.calls[0] > 0 && tally.calls[1] > 0, "{tally:?}");
        assert!(tally.calls[2] > 0 && tally.calls[4] > 0, "{tally:?}");
        assert!(tally.work_limit > 0 && tally.push_limit > 0, "{tally:?}");
        // Vertical spans need vertical edges, which the randomized corpus's near-degenerate
        // family has; the B0 rings are not guaranteed to have them.
        if label != "B0" {
            assert_every_kind(&tally);
        }
        assert_eq!(tally.mismatches, 0, "{tally:?}");
    }
}

/// Full O11 for L3 and L4: seeded scenes of at most 63 edges, each tessellated with exhaustive
/// scan variants (every failing budget of every L3 scan and L4 call, including every charge
/// inside an active body, and every push limit; no sampled call), and 10^6 synthetic L4
/// ranges at every budget, in 16 fixed seeded shards.
#[test]
#[ignore = "B0R O11 full size; release profile via pnpm test:p3-fill-identity"]
fn b0r_oracle_full_o11_scan_loops() {
    // Each scene is swept exhaustively per call. The cost per call is quadratic in its charge
    // total, but L3 and L4 calls are short (at most 63 iterations plus their lookups), so the
    // scene count need not be reduced.
    const SCENES: u64 = 8_000;
    const LOOKUP_CASES: u64 = 1_000_000;
    let threads = ORACLE_SHARDS;
    let start = Instant::now();
    let mut tally = ScanShadowTally::default();
    let mut lookups = LookupTally::default();
    let mut scenes_ok = 0usize;
    for (shard_tally, shard_ok, shard_lookups) in parallel(threads, move |shard| {
        let seed = 0x4230_5237_1100 + shard as u64;
        let count = share(SCENES, threads, shard) as usize;
        // A quarter of the scenes reach up to 63 edges, the rest up to 27.
        let mut scenes = scan_scenes(seed, count - count / 4, 9);
        scenes.extend(scan_scenes(seed ^ 0x5a5a, count / 4, 21));
        let (tally, ok) = shadow_scans(&scenes, true);
        let lookups = lookup_differential(seed ^ 0xa5a5, share(LOOKUP_CASES, threads, shard), 24);
        (tally, ok, lookups)
    }) {
        tally.merge(shard_tally);
        scenes_ok += shard_ok;
        lookups.merge(shard_lookups);
    }
    println!(
        "B0R O11 L3/L4 full: {SCENES} scenes ({scenes_ok} ok), {tally:?}; L4 {lookups:?}; \
         {threads} threads, {:.1} s",
        start.elapsed().as_secs_f64()
    );
    assert_every_kind(&tally);
    assert!(tally.work_limit > 0 && tally.push_limit > 0, "{tally:?}");
    assert_eq!(tally.sampled_calls, 0, "{tally:?}");
    assert!(tally.exhaustive_calls > 0, "{tally:?}");
    assert_eq!(tally.mismatches, 0, "{tally:?}");
    assert!(
        lookups.matches > 0 && lookups.no_match > 0 && lookups.work_limit > 0,
        "{lookups:?}"
    );
    assert_eq!(lookups.mismatches, 0, "{lookups:?}");
}
