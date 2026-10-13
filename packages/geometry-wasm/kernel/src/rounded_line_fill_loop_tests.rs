//! B0R unit U6 oracles for the loop restructurings L1 (`collect_events`) and L2
//! (`sort_events`) of the rounded tessellation (docs/plans/p3-b0r-kernel-performance-contract.md
//! sections 5.4 and 7: O8, O10 and O11).
//!
//! - O10: in shadow mode every L1 and L2 call also runs the `cfg(test)` copy of the pre-U6 loop
//!   on a clone of the workspace state and compares the result, every counter and the pushed
//!   events. With loop variants on, both loops also run from clones of that state under reduced
//!   budgets and event limits, so the comparison covers failures as well.
//! - O11: Lemma D (`stable_sort_charges` against a counting stable insertion sort on tie-heavy
//!   integer sequences), Lemma C (`bulk_charge` against consecutive `charge()` calls), and
//!   Corollary C1 and Lemma D through the real loops at every failing budget and event limit,
//!   including L2's comparator-error fallback with injected invalid events.
//!
//! The full-size runs are `#[ignore]` tests in the release profile, run by
//! `pnpm test:p3-fill-identity`; the ordinary tests are the smoke versions and the O8 checks.
use std::time::Instant;

use crate::fill_event_order::FillEvent;
use crate::fill_filter::{take_shadow_tally, with_fault, with_shadow, Fault};
use crate::fill_filter_tests::{parallel, pow2, share, Rng, ORACLE_SHARDS, THREAD_STACK_BYTES};
use crate::geometry::Point;
use crate::line_fill::LineFillRule;
use crate::p3_b0r_identity::{read_b0, read_file, read_random, run_chunk};
use crate::rounded_line_fill::{
    b0r_event_bits, stable_sort_charges, take_loop_counts, take_loop_tally, with_loop_variants,
    EventLoop, LoopCounts, LoopImpl, LoopShadowTally, RoundedFillError, RoundedFillLimits,
    RoundedFillWorkspace,
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

/// Seeded contours with many crossings, touching and collinear edges, vertical edges and
/// repeated points: lattice polygons, star polygons and random polygons at scales 2^-30 to
/// 2^30. `max_vertices` bounds each contour.
fn loop_contours(rng: &mut Rng, max_vertices: u64) -> Vec<Vec<Point>> {
    let unit = pow2(rng.range_i32(-30, 30));
    let contours = 1 + rng.below(3);
    (0..contours)
        .map(|_| {
            let vertices = 3 + rng.below(max_vertices - 2) as usize;
            match rng.below(3) {
                0 => (0..vertices)
                    .map(|_| point((rng.below(8) as f64) * unit, (rng.below(8) as f64) * unit))
                    .collect(),
                1 => {
                    let step = 1 + rng.below(vertices as u64 - 1) as usize;
                    let radius = (1 + rng.below(4)) as f64 * unit;
                    let center = (rng.below(4) as f64) * unit;
                    (0..vertices)
                        .map(|index| {
                            let angle = core::f64::consts::TAU * ((index * step) % vertices) as f64
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
        .collect()
}

fn random_scenes(seed: u64, count: usize, max_vertices: u64) -> Vec<Scene> {
    let mut rng = Rng::new(seed);
    (0..count)
        .map(|_| {
            let contours = loop_contours(&mut rng, max_vertices);
            let rule = if rng.chance(1, 2) {
                LineFillRule::Nonzero
            } else {
                LineFillRule::Evenodd
            };
            let tau = pow2(-rng.range_i32(2, 40));
            (contours, rule, tau)
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// O11, Lemma D on integer sequences.

/// The counting stable insertion sort of the pre-U6 `sort_events`, on integer keys: the
/// permutation and the number of comparisons.
fn insertion_reference(keys: &[u32]) -> (Vec<u16>, u64) {
    let mut order: Vec<u16> = (0..keys.len() as u16).collect();
    let mut comparisons = 0u64;
    for index in 1..order.len() {
        let value = order[index];
        let mut cursor = index;
        while cursor > 0 {
            comparisons += 1;
            if keys[usize::from(order[cursor - 1])] <= keys[usize::from(value)] {
                break;
            }
            order[cursor] = order[cursor - 1];
            cursor -= 1;
        }
        order[cursor] = value;
    }
    (order, comparisons)
}

/// A tie-heavy integer sequence: all equal, sorted, reversed, sawtooth, random over 1-8
/// distinct keys, or random over wide keys. Lengths 0-256, a third of them at most 8.
fn key_sequence(rng: &mut Rng) -> (usize, Vec<u32>) {
    let length = if rng.chance(1, 3) {
        rng.below(9) as usize
    } else {
        rng.below(257) as usize
    };
    let family = rng.below(6) as usize;
    let mut level = 0u32;
    let period = 1 + rng.below(16) as usize;
    let distinct = 1 + rng.below(8) as u32;
    let keys = (0..length)
        .map(|index| match family {
            0 => 7,
            1 => {
                level += rng.below(3) as u32;
                level
            }
            2 => {
                level += rng.below(3) as u32;
                10_000 - level
            }
            3 => (index % period) as u32,
            4 => rng.below(u64::from(distinct)) as u32,
            _ => rng.next_u64() as u32,
        })
        .collect();
    (family, keys)
}

#[derive(Clone, Copy, Debug, Default)]
struct LemmaDTally {
    sequences: u64,
    elements: u64,
    charges: u64,
    by_family: [u64; 6],
    permutation_mismatches: u64,
    charge_mismatches: u64,
    unstable: u64,
}

impl LemmaDTally {
    fn merge(&mut self, other: Self) {
        self.sequences += other.sequences;
        self.elements += other.elements;
        self.charges += other.charges;
        for (total, count) in self.by_family.iter_mut().zip(other.by_family) {
            *total += count;
        }
        self.permutation_mismatches += other.permutation_mismatches;
        self.charge_mismatches += other.charge_mismatches;
        self.unstable += other.unstable;
    }

    fn failures(&self) -> u64 {
        self.permutation_mismatches + self.charge_mismatches + self.unstable
    }
}

/// Lemma D: `stable_sort_charges` gives the counting insertion sort's permutation and count,
/// and the permutation is stable.
fn lemma_d_sequences(seed: u64, sequences: u64) -> LemmaDTally {
    let mut rng = Rng::new(seed);
    let mut tally = LemmaDTally::default();
    for _ in 0..sequences {
        let (family, keys) = key_sequence(&mut rng);
        let mut order = [0u16; 256];
        let charges = stable_sort_charges(keys.len(), &mut order, |left, right| {
            Ok::<_, ()>(keys[left].cmp(&keys[right]))
        })
        .unwrap();
        let (expected, comparisons) = insertion_reference(&keys);
        let order = &order[..keys.len()];
        tally.sequences += 1;
        tally.elements += keys.len() as u64;
        tally.charges += charges;
        tally.by_family[family] += 1;
        tally.permutation_mismatches += u64::from(order != expected.as_slice());
        tally.charge_mismatches += u64::from(charges != comparisons);
        tally.unstable += u64::from(order.windows(2).any(|pair| {
            let (left, right) = (usize::from(pair[0]), usize::from(pair[1]));
            keys[left] > keys[right] || (keys[left] == keys[right] && left > right)
        }));
    }
    tally
}

// ---------------------------------------------------------------------------------------------
// O11, Lemma C and the real loops at every failure point.

#[derive(Clone, Copy, Debug, Default)]
struct LoopDifferential {
    /// Lemma C cases (bulk against per-iteration charges).
    bulk_cases: u64,
    /// Compared L1 runs and their failures by kind.
    collect_runs: u64,
    collect_work_limit: u64,
    collect_event_limit: u64,
    /// Compared L2 runs, their `WorkLimit` failures and the runs with an injected invalid event.
    sort_runs: u64,
    sort_work_limit: u64,
    sort_injected: u64,
    /// Sweeps that sampled iteration boundaries instead of every failing budget (smoke only).
    sampled_sweeps: u64,
    /// Runs whose result, counters or compared events differed.
    mismatches: u64,
}

impl LoopDifferential {
    fn merge(&mut self, other: Self) {
        self.bulk_cases += other.bulk_cases;
        self.collect_runs += other.collect_runs;
        self.collect_work_limit += other.collect_work_limit;
        self.collect_event_limit += other.collect_event_limit;
        self.sort_runs += other.sort_runs;
        self.sort_work_limit += other.sort_work_limit;
        self.sort_injected += other.sort_injected;
        self.sampled_sweeps += other.sampled_sweeps;
        self.mismatches += other.mismatches;
    }
}

/// Lemma C: `bulk_charge(count)`, plain and counted into `pair_checks`, equals `count`
/// consecutive `charge()` calls, at random states and at every boundary of the remaining budget.
fn lemma_c_cases(rng: &mut Rng, cases: u64, tally: &mut LoopDifferential) {
    let mut workspace = RoundedFillWorkspace::new(LIMITS).unwrap();
    workspace.b0r_load_events(&[]);
    for _ in 0..cases {
        let start = rng.below(1_000);
        let count = match rng.below(4) {
            0 => 0,
            1 => 1 + rng.below(4),
            _ => rng.below(3_000),
        };
        let remaining = match rng.below(6) {
            0 => 0,
            1 => count.saturating_sub(1),
            2 => count,
            3 => count + 1,
            _ => rng.below(4_000),
        };
        let counted = rng.chance(1, 2);
        let mut bulk = workspace.clone();
        bulk.b0r_set_budget(start, start + remaining, LIMITS.max_events);
        let mut reference = bulk.clone();
        let result = bulk.b0r_bulk_charge(count, counted);
        let mut expected = Ok(());
        for _ in 0..count {
            expected = reference.b0r_charge(counted);
            if expected.is_err() {
                break;
            }
        }
        tally.bulk_cases += 1;
        tally.mismatches += u64::from(
            result != expected || bulk.b0r_loop_state().0 != reference.b0r_loop_state().0,
        );
    }
}

/// Runs one loop with both implementations from clones of `base` under the given limits and
/// compares results, counters and (unless an L2 `WorkLimit` left scratch) events.
fn compare_loop(
    base: &RoundedFillWorkspace,
    which: EventLoop,
    start: u64,
    max_work: u64,
    max_events: usize,
) -> (Result<(), RoundedFillError>, bool, RoundedFillWorkspace) {
    let mut reference = base.clone();
    reference.b0r_set_budget(start, max_work, max_events);
    let mut restructured = reference.clone();
    let expected = reference.b0r_run_loop(which, LoopImpl::Reference);
    let result = restructured.b0r_run_loop(which, LoopImpl::Restructured);
    let (reference_stats, reference_events) = reference.b0r_loop_state();
    let (stats, events) = restructured.b0r_loop_state();
    let compare_events =
        which == EventLoop::Collect || expected != Err(RoundedFillError::WorkLimit);
    let equal = expected == result
        && reference_stats == stats
        && (!compare_events || b0r_event_bits(reference_events) == b0r_event_bits(events));
    (expected, equal, reference)
}

/// The budgets of one sweep: every budget from `start` to `start + total + 1` when the loop's
/// charge total is at most `exhaustive`, otherwise both sides of `samples` random iteration
/// boundaries plus the ends.
fn budgets(rng: &mut Rng, start: u64, total: u64, exhaustive: u64, samples: u64) -> Vec<u64> {
    if total <= exhaustive {
        return (start..=start + total + 1).collect();
    }
    let mut budgets = vec![
        start,
        start + 1,
        start + total - 1,
        start + total,
        start + total + 1,
    ];
    for _ in 0..samples {
        let boundary = start + rng.below(total + 1);
        budgets.extend([boundary, boundary + 1]);
    }
    budgets
}

/// Corollary C1 through L1: one scene's `collect_events` at every failing budget (or sampled
/// iteration boundaries) and at every crossing push's `EventLimit`.
fn collect_sweep(
    rng: &mut Rng,
    contours: &[Vec<Point>],
    exhaustive: bool,
    tally: &mut LoopDifferential,
) {
    let references: Vec<&[Point]> = contours.iter().map(Vec::as_slice).collect();
    let mut base = RoundedFillWorkspace::new(LIMITS).unwrap();
    if base.b0r_load_contours(&references).is_err() {
        return;
    }
    let start = rng.below(50);
    let (expected, equal, reference) = compare_loop(
        &base,
        EventLoop::Collect,
        start,
        LIMITS.max_work,
        LIMITS.max_events,
    );
    record_collect(tally, expected, equal);
    let (stats, events) = reference.b0r_loop_state();
    let total = stats.work_units - start;
    let limit = if exhaustive { u64::MAX } else { 400 };
    tally.sampled_sweeps += u64::from(total > limit);
    for budget in budgets(rng, start, total, limit, 48) {
        let (expected, equal, _) =
            compare_loop(&base, EventLoop::Collect, start, budget, LIMITS.max_events);
        record_collect(tally, expected, equal);
    }
    let endpoints = 2 * stats.edges;
    for max_events in endpoints..events.len() {
        let (expected, equal, _) = compare_loop(
            &base,
            EventLoop::Collect,
            start,
            LIMITS.max_work,
            max_events,
        );
        record_collect(tally, expected, equal);
    }
}

fn record_collect(
    tally: &mut LoopDifferential,
    expected: Result<(), RoundedFillError>,
    equal: bool,
) {
    tally.collect_runs += 1;
    tally.collect_work_limit += u64::from(expected == Err(RoundedFillError::WorkLimit));
    tally.collect_event_limit += u64::from(expected == Err(RoundedFillError::EventLimit));
    tally.mismatches += u64::from(!equal);
}

/// An invalid event for L2's comparator-error fallback: a non-finite endpoint or a crossing of
/// two segments that do not cross properly.
fn invalid_event(rng: &mut Rng) -> FillEvent {
    if rng.chance(1, 2) {
        FillEvent::Endpoint(point(f64::NAN, 0.0))
    } else {
        FillEvent::Crossing {
            a: point(0.0, 0.0),
            b: point(1.0, 0.0),
            c: point(0.0, 1.0),
            d: point(1.0, 1.0),
        }
    }
}

/// Lemma D and Lemma C through L2: one event list (a scene's real events, reordered, with tied
/// copies, and sometimes an injected invalid event) sorted at every failing budget or sampled
/// boundaries.
fn sort_sweep(
    rng: &mut Rng,
    contours: &[Vec<Point>],
    exhaustive: bool,
    tally: &mut LoopDifferential,
) {
    let references: Vec<&[Point]> = contours.iter().map(Vec::as_slice).collect();
    let mut collected = RoundedFillWorkspace::new(LIMITS).unwrap();
    if collected.b0r_load_contours(&references).is_err()
        || collected
            .b0r_run_loop(EventLoop::Collect, LoopImpl::Reference)
            .is_err()
    {
        return;
    }
    let mut events = collected.b0r_loop_state().1.to_vec();
    if rng.chance(1, 3) {
        for index in (1..events.len()).rev() {
            events.swap(index, rng.below(index as u64 + 1) as usize);
        }
    }
    if rng.chance(1, 3) && !events.is_empty() {
        for _ in 0..rng.below(8) {
            let copy = events[rng.below(events.len() as u64) as usize];
            let at = rng.below(events.len() as u64 + 1) as usize;
            events.insert(at, copy);
        }
    }
    let injected = rng.chance(1, 4) && !events.is_empty();
    if injected {
        let at = rng.below(events.len() as u64) as usize;
        events[at] = invalid_event(rng);
    }
    events.truncate(300);
    let mut base = RoundedFillWorkspace::new(LIMITS).unwrap();
    base.b0r_load_events(&events);
    let start = rng.below(50);
    let (expected, equal, reference) = compare_loop(
        &base,
        EventLoop::Sort,
        start,
        LIMITS.max_work,
        LIMITS.max_events,
    );
    record_sort(tally, expected, equal, injected);
    let total = reference.b0r_loop_state().0.work_units - start;
    let limit = if exhaustive { u64::MAX } else { 600 };
    tally.sampled_sweeps += u64::from(total > limit);
    for budget in budgets(rng, start, total, limit, 48) {
        let (expected, equal, _) =
            compare_loop(&base, EventLoop::Sort, start, budget, LIMITS.max_events);
        record_sort(tally, expected, equal, injected);
    }
}

fn record_sort(
    tally: &mut LoopDifferential,
    expected: Result<(), RoundedFillError>,
    equal: bool,
    injected: bool,
) {
    tally.sort_runs += 1;
    tally.sort_work_limit += u64::from(expected == Err(RoundedFillError::WorkLimit));
    tally.sort_injected += u64::from(injected);
    tally.mismatches += u64::from(!equal);
}

/// O11 through the real loops: Lemma C cases, then `scenes` scenes, each through the L1 and the
/// L2 sweep.
fn loop_differential(
    seed: u64,
    bulk_cases: u64,
    scenes: u64,
    exhaustive: bool,
) -> LoopDifferential {
    let mut rng = Rng::new(seed);
    let mut tally = LoopDifferential::default();
    lemma_c_cases(&mut rng, bulk_cases, &mut tally);
    for _ in 0..scenes {
        let max_vertices = if rng.chance(1, 4) { 24 } else { 9 };
        let contours = loop_contours(&mut rng, max_vertices);
        collect_sweep(&mut rng, &contours, exhaustive, &mut tally);
        sort_sweep(&mut rng, &contours, exhaustive, &mut tally);
    }
    tally
}

// ---------------------------------------------------------------------------------------------
// O10 smoke: shadow mode with loop variants on tessellations.

/// Tessellates every scene with shadow mode and loop variants off, then on; the results and
/// counters must be equal, and the loop tally of the second run is returned.
fn shadow_loops(scenes: &[Scene]) -> (LoopShadowTally, usize) {
    let mut workspace = RoundedFillWorkspace::new(LIMITS).unwrap();
    let mut ok = 0;
    take_loop_tally();
    for (contours, rule, tau) in scenes {
        let references: Vec<&[Point]> = contours.iter().map(Vec::as_slice).collect();
        let plain = workspace.tessellate(&references, *rule, *tau);
        let plain_stats = workspace.stats();
        let shadowed =
            with_shadow(|| with_loop_variants(|| workspace.tessellate(&references, *rule, *tau)));
        assert_eq!(plain, shadowed);
        assert_eq!(plain_stats, workspace.stats());
        ok += usize::from(plain.is_ok());
    }
    (take_loop_tally(), ok)
}

#[test]
fn b0r_o10_smoke_event_loops_fixture_rows() {
    let scenes = fixture_scenes();
    assert_eq!(scenes.len(), 202);
    let (tally, ok) = shadow_loops(&scenes);
    println!("B0R O10 L1/L2 smoke fixture rows: {ok} ok, {tally:?}");
    assert!(
        tally.collect_runs > 1_000 && tally.sort_runs > 1_000,
        "{tally:?}"
    );
    assert!(
        tally.work_limit > 1_000 && tally.event_limit > 0,
        "{tally:?}"
    );
    assert_eq!(tally.mismatches, 0, "{tally:?}");
}

#[test]
fn b0r_o10_smoke_event_loops_random_scenes() {
    let scenes = random_scenes(0x4230_5236_0010, 12, 8);
    let (tally, ok) = shadow_loops(&scenes);
    println!("B0R O10 L1/L2 smoke random scenes: {ok} ok, {tally:?}");
    assert!(ok > 0, "{ok}");
    assert!(tally.event_limit > 0, "{tally:?}");
    assert_eq!(tally.mismatches, 0, "{tally:?}");
}

// ---------------------------------------------------------------------------------------------
// O11 smoke.

#[test]
fn b0r_o11_smoke_lemma_d_sequences() {
    let tally = lemma_d_sequences(0x4230_5236_0011, 10_000);
    println!("B0R O11 Lemma D smoke: {tally:?}");
    assert!(
        tally.by_family.iter().all(|&count| count > 1_000),
        "{tally:?}"
    );
    assert_eq!(tally.failures(), 0, "{tally:?}");
}

#[test]
fn b0r_o11_smoke_lemma_c_and_loop_failure_points() {
    let tally = loop_differential(0x4230_5236_0012, 10_000, 12, false);
    println!("B0R O11 loop smoke: {tally:?}");
    assert!(
        tally.collect_work_limit > 100 && tally.collect_event_limit > 10,
        "{tally:?}"
    );
    assert!(
        tally.sort_work_limit > 100 && tally.sort_injected > 0,
        "{tally:?}"
    );
    assert_eq!(tally.mismatches, 0, "{tally:?}");
}

/// The fallback argument of L2: with an erroring element anywhere, the merge sort with its
/// running-minimum pass reports the error for every n >= 2 (every element is compared).
#[test]
fn b0r_o11_merge_sort_compares_every_element() {
    for count in 0..=64usize {
        for bad in 0..count.max(1) {
            let mut order = [0u16; 256];
            let result = stable_sort_charges(count, &mut order, |left, right| {
                if left == bad || right == bad {
                    Err(())
                } else {
                    Ok(left.cmp(&right))
                }
            });
            assert_eq!(result.is_err(), count >= 2, "count {count}, bad {bad}");
        }
    }
}

/// L2's comparator-error fallback reproduces the insertion sort exactly, events included, and
/// the size guards route more than 64 edges and more than 256 events to the current loops.
#[test]
fn b0r_o11_fallback_and_size_guards() {
    let mut rng = Rng::new(0x4230_5236_0013);
    // Comparator-error fallback: an invalid event at every position of a small list.
    let base: Vec<FillEvent> = (0..12)
        .map(|index| FillEvent::Endpoint(point(f64::from(11 - index % 5), f64::from(index))))
        .collect();
    for at in 0..base.len() {
        let mut events = base.clone();
        events[at] = invalid_event(&mut rng);
        let mut workspace = RoundedFillWorkspace::new(LIMITS).unwrap();
        workspace.b0r_load_events(&events);
        take_loop_counts();
        for budget in 0..=80 {
            let (expected, equal, reference) =
                compare_loop(&workspace, EventLoop::Sort, 0, budget, LIMITS.max_events);
            assert!(equal, "at {at}, budget {budget}");
            assert!(expected.is_err());
            // The fallback ran the insertion sort, so the events are equal even on WorkLimit.
            let mut restructured = workspace.clone();
            restructured.b0r_set_budget(0, budget, LIMITS.max_events);
            let _ = restructured.b0r_run_loop(EventLoop::Sort, LoopImpl::Restructured);
            assert_eq!(
                b0r_event_bits(restructured.b0r_loop_state().1),
                b0r_event_bits(reference.b0r_loop_state().1)
            );
        }
        let counts = take_loop_counts();
        assert_eq!(counts.merge_sorts, 0, "{counts:?}");
        // Each budget runs the restructured sort twice (in compare_loop and above).
        assert_eq!(counts.insertion_fallbacks, 2 * 81, "{counts:?}");
    }

    // L2 size guard: 300 events run the insertion sort; 256 run the merge sort.
    for (count, merged) in [(256usize, 1u64), (300, 0)] {
        let events: Vec<FillEvent> = (0..count)
            .map(|_| FillEvent::Endpoint(point(rng.below(16) as f64, rng.below(16) as f64)))
            .collect();
        let mut workspace = RoundedFillWorkspace::new(LIMITS).unwrap();
        workspace.b0r_load_events(&events);
        take_loop_counts();
        let (expected, equal, _) = compare_loop(
            &workspace,
            EventLoop::Sort,
            0,
            LIMITS.max_work,
            LIMITS.max_events,
        );
        assert_eq!(expected, Ok(()));
        assert!(equal);
        let counts = take_loop_counts();
        assert_eq!(counts.merge_sorts, merged, "{counts:?}");
        assert_eq!(counts.insertion_fallbacks, 0, "{counts:?}");
    }

    // L1 size guard: 64 edges are swept, 65 run the current all-pairs loop.
    for (vertices, swept) in [(64usize, 1u64), (65, 0)] {
        let contour: Vec<Point> = (0..vertices)
            .map(|index| {
                let angle =
                    core::f64::consts::TAU * ((index * 7) % vertices) as f64 / vertices as f64;
                point(angle.cos(), angle.sin())
            })
            .collect();
        let mut workspace = RoundedFillWorkspace::new(LIMITS).unwrap();
        workspace.b0r_load_contours(&[&contour]).unwrap();
        take_loop_counts();
        let (expected, equal, _) = compare_loop(
            &workspace,
            EventLoop::Collect,
            0,
            LIMITS.max_work,
            LIMITS.max_events,
        );
        assert_eq!(expected, Ok(()));
        assert!(equal);
        let counts = take_loop_counts();
        assert_eq!(counts.swept_calls, swept, "{counts:?}");
    }
}

// ---------------------------------------------------------------------------------------------
// O8 defects (11)-(13).

/// O8 (11): Corollary C1 with one outer charge too few per active member is detected by the
/// O11 loop differential and by O10 shadow mode on the fixture rows.
#[test]
fn b0r_o8_c1_outer_charge_short_is_detected() {
    let (differential, shadow) = with_fault(Fault::C1OuterChargeShort, || {
        let differential = loop_differential(0x4230_5236_0811, 0, 10, false);
        let (shadow, _) = shadow_loops(&fixture_scenes()[..40]);
        (differential, shadow)
    });
    println!("B0R O8 (11): {differential:?}; {shadow:?}");
    assert!(differential.mismatches > 0, "{differential:?}");
    assert!(shadow.mismatches > 0, "{shadow:?}");
}

/// O8 (12): Lemma D without the prefix-minimum correction m is detected by the O11 sequence
/// differential and by O10 shadow mode on the fixture rows.
#[test]
fn b0r_o8_lemma_d_without_minimum_is_detected() {
    let (sequences, shadow) = with_fault(Fault::LemmaDWithoutMinimum, || {
        let sequences = lemma_d_sequences(0x4230_5236_0812, 1_000);
        let (shadow, _) = shadow_loops(&fixture_scenes()[..40]);
        (sequences, shadow)
    });
    println!("B0R O8 (12): {sequences:?}; {shadow:?}");
    assert!(sequences.charge_mismatches > 0, "{sequences:?}");
    assert!(shadow.mismatches > 0, "{shadow:?}");
}

/// O8 (13): L1 with its candidates in sorted-by-x order is detected by the O11 loop
/// differential and by O10 shadow mode on random scenes with crossings.
#[test]
fn b0r_o8_l1_sorted_by_x_is_detected() {
    let scenes = random_scenes(0x4230_5236_0813, 6, 8);
    let (differential, shadow) = with_fault(Fault::L1SortedByX, || {
        let differential = loop_differential(0x4230_5236_0813, 0, 4, false);
        let (shadow, _) = shadow_loops(&scenes);
        (differential, shadow)
    });
    println!("B0R O8 (13): {differential:?}; {shadow:?}");
    assert!(differential.mismatches > 0, "{differential:?}");
    assert!(shadow.mismatches > 0, "{shadow:?}");
}

// ---------------------------------------------------------------------------------------------
// Full-size oracles (release profile, `pnpm test:p3-fill-identity`).

/// Full O10 for L1 and L2 on the O4 corpora: every `CubicFillWorkspace` entry and the V2
/// cascade, by the identity harness's `run_chunk`, first with shadow mode off (loop counts),
/// then with shadow mode and loop variants on (every L1 and L2 call compared with the reference
/// at its real limits and at reduced budgets and event limits).
#[test]
#[ignore = "B0R O10 full size; release profile via pnpm test:p3-fill-identity"]
fn b0r_oracle_full_o10_event_loops() {
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
                        take_loop_counts();
                        for chunk in chunks.iter().skip(worker).step_by(threads) {
                            run_chunk(chunk);
                        }
                        let counts = take_loop_counts();
                        take_loop_tally();
                        take_shadow_tally();
                        with_shadow(|| {
                            with_loop_variants(|| {
                                for chunk in chunks.iter().skip(worker).step_by(threads) {
                                    run_chunk(chunk);
                                }
                            })
                        });
                        take_shadow_tally();
                        (counts, take_loop_tally())
                    })
                    .expect("spawn O10 loop worker")
            })
            .collect();
        let mut counts = LoopCounts::default();
        let mut tally = LoopShadowTally::default();
        for handle in handles {
            let (worker_counts, worker_tally) = handle.join().expect("O10 loop worker");
            counts.merge(worker_counts);
            tally.merge(worker_tally);
        }
        println!(
            "B0R O10 L1/L2 {label}: {chunk_count} chunks; shadow off: {counts:?}, candidate \
             fraction {:.4}; shadow with variants: {tally:?}; {threads} threads, {:.1} s",
            counts.candidate_pairs as f64 / counts.logical_pairs.max(1) as f64,
            start.elapsed().as_secs_f64()
        );
        assert!(
            counts.swept_calls > 0 && counts.merge_sorts > 0,
            "{counts:?}"
        );
        assert!(tally.collect_runs > 0 && tally.sort_runs > 0, "{tally:?}");
        assert!(tally.work_limit > 0, "{tally:?}");
        // EventLimit is asserted only for the randomized corpus, whose crossing paths drive the
        // event-limit variants. On B0 it is not guaranteed: the B0 rings have no crossings, and
        // its EventLimit comparisons come from paths that reach the 128-event cap.
        if label != "B0" {
            assert!(tally.event_limit > 0, "{tally:?}");
        }
        assert_eq!(tally.mismatches, 0, "{tally:?}");
    }
}

/// Full O11: 10^6 tie-heavy integer sequences for Lemma D, 10^6 Lemma C cases, and 640 scenes
/// through exhaustive L1 and L2 failure-point sweeps, in 16 fixed seeded shards.
#[test]
#[ignore = "B0R O11 full size; release profile via pnpm test:p3-fill-identity"]
fn b0r_oracle_full_o11_charge_lemmas() {
    const SEQUENCES: u64 = 1_000_000;
    const BULK_CASES: u64 = 1_000_000;
    // Every scene is swept exhaustively: every budget from the start to one past the charge
    // total of each loop, so the scan fails at each of its iterations. The cost per scene is
    // quadratic in the charge total, so the scene count is 640 (about 7.5 min in release).
    const SCENES: u64 = 640;
    let threads = ORACLE_SHARDS;
    let start = Instant::now();
    let mut sequences = LemmaDTally::default();
    let mut loops = LoopDifferential::default();
    for (shard_sequences, shard_loops) in parallel(threads, move |shard| {
        let seed = 0x4230_5236_1100 + shard as u64;
        (
            lemma_d_sequences(seed, share(SEQUENCES, threads, shard)),
            loop_differential(
                seed ^ 0x5a5a,
                share(BULK_CASES, threads, shard),
                share(SCENES, threads, shard),
                true,
            ),
        )
    }) {
        sequences.merge(shard_sequences);
        loops.merge(shard_loops);
    }
    println!(
        "B0R O11 full: Lemma D {sequences:?}; loops {loops:?}; {threads} threads, {:.1} s",
        start.elapsed().as_secs_f64()
    );
    assert_eq!(sequences.sequences, SEQUENCES);
    assert_eq!(sequences.failures(), 0, "{sequences:?}");
    assert_eq!(loops.bulk_cases, BULK_CASES);
    assert!(
        loops.collect_work_limit > 0 && loops.collect_event_limit > 0,
        "{loops:?}"
    );
    assert!(
        loops.sort_work_limit > 0 && loops.sort_injected > 0,
        "{loops:?}"
    );
    assert_eq!(loops.sampled_sweeps, 0, "{loops:?}");
    assert_eq!(loops.mismatches, 0, "{loops:?}");
}
