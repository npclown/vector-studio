//! B0R unit U4 oracles for the column and section filters F0.5, F0.6 and F2.6-F2.8 and the
//! tessellation changes T1, T2 and T4 (docs/plans/p3-b0r-kernel-performance-contract.md
//! sections 3.4-3.7, 5.2 and 7: O1, O2, O8 and O10).
//!
//! - O1: every filtered crate comparison of `fill_sections` is compared with its unchanged
//!   exact routine (`exact_*`), and every source-level comparison (T1, T2, T4) with the exact
//!   routine on the eagerly built value. Every finite source enclosure is also checked to
//!   contain the exact value.
//! - O10: shadow mode makes every filtered or lazy decision inside the rounded tessellation
//!   compute the eager exact value and record whether the two agree.
//!
//! The full-size runs are `#[ignore]` tests in the release profile, run by
//! `pnpm test:p3-fill-identity`; the ordinary tests are the smoke versions and the fixtures.
use core::cmp::Ordering;
use std::time::Instant;

use crate::fill_event_order::{exact_event_position, x_enclosure, FillEvent};
use crate::fill_exact::Signed;
use crate::fill_filter::{
    counts, enclose_ratio, reset_counters, take_shadow_tally, with_fault, with_shadow, Fault,
    FilterId, Interval, ShadowTally,
};
use crate::fill_filter_tests::{parallel, pow2, share, Rng, ORACLE_SHARDS, THREAD_STACK_BYTES};
use crate::fill_sections::{
    column_as_section, compare_column_f64, compare_column_source_f64, compare_columns,
    compare_section_f64, compare_section_sources, compare_sections, endpoint_section, event_column,
    exact_compare_column_f64, exact_compare_columns, exact_compare_section_f64,
    exact_compare_sections, exact_lower_half_predicate, exact_upper_half_predicate,
    exact_within_half_budget, lower_half_predicate, mediant, section_at_column,
    upper_half_predicate, within_half_budget, ExactColumn, ExactSection, SectionSource,
    SectionTarget,
};
use crate::geometry::Point;
use crate::line_fill::LineFillRule;
use crate::p3_b0r_identity::{read_b0, read_file, read_random, run_chunk};
use crate::rounded_line_fill::{RoundedFillLimits, RoundedFillWorkspace};

/// Every U4 filter identity, in `FilterId` order.
const IDS: [FilterId; 9] = [
    FilterId::EndpointValue,
    FilterId::RepresentationIdentity,
    FilterId::ColumnRatio,
    FilterId::SectionRatio,
    FilterId::HalfBudget,
    FilterId::LazyColumn,
    FilterId::LazySection,
    FilterId::EmbedStep,
    FilterId::EmbedHalfStep,
];

/// The filtered comparisons checked by the crate differential, in tally order.
const CRATE_NAMES: [&str; 7] = [
    "compare_columns",
    "compare_column_f64",
    "compare_sections",
    "compare_section_f64",
    "within_half_budget",
    "lower_half_predicate",
    "upper_half_predicate",
];

/// The source-level comparisons checked by the source differential, in tally order.
const SOURCE_NAMES: [&str; 5] = [
    "compare_column_source_f64",
    "compare_section_sources",
    "SectionTarget::compare_f64",
    "SectionTarget::lower_half",
    "SectionTarget::upper_half",
];

fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct SectionTally {
    pub(crate) cases: u64,
    /// Disagreements with the exact routine, per checked comparison.
    pub(crate) disagreements: [u64; 7],
    /// Finite source enclosures checked against the exact value, and the misses.
    pub(crate) enclosures: u64,
    pub(crate) containment_violations: u64,
    pub(crate) unbounded: u64,
    /// (decided, fallback) per filter of `IDS`.
    pub(crate) filters: [(u64, u64); 9],
}

impl SectionTally {
    pub(crate) fn merge(&mut self, other: Self) {
        self.cases += other.cases;
        for (slot, value) in self.disagreements.iter_mut().zip(other.disagreements) {
            *slot += value;
        }
        self.enclosures += other.enclosures;
        self.containment_violations += other.containment_violations;
        self.unbounded += other.unbounded;
        for (slot, value) in self.filters.iter_mut().zip(other.filters) {
            slot.0 += value.0;
            slot.1 += value.1;
        }
    }

    fn failures(&self) -> u64 {
        self.disagreements.iter().sum::<u64>() + self.containment_violations
    }

    fn collect_counters(&mut self) {
        for (slot, id) in self.filters.iter_mut().zip(IDS) {
            let (decided, fallback) = counts(id);
            slot.0 += decided;
            slot.1 += fallback;
        }
        reset_counters();
    }

    fn check<T: PartialEq + core::fmt::Debug>(
        &mut self,
        index: usize,
        name: &str,
        filtered: T,
        exact: T,
        context: &dyn Fn() -> String,
    ) {
        if filtered != exact {
            self.disagreements[index] += 1;
            if self.disagreements[index] <= 3 {
                eprintln!(
                    "B0R O1 disagreement {name}: filtered {filtered:?}, exact {exact:?}; {}",
                    context()
                );
            }
        }
    }

    fn rates(&self) -> String {
        IDS.iter()
            .zip(self.filters)
            .filter(|(_, (decided, fallback))| decided + fallback > 0)
            .map(|(id, (decided, fallback))| {
                format!(
                    "{id:?} {decided}/{} ({:.4})",
                    decided + fallback,
                    fraction(decided, decided + fallback)
                )
            })
            .collect::<Vec<_>>()
            .join(", ")
    }
}

fn fraction(part: u64, whole: u64) -> f64 {
    if whole == 0 {
        0.0
    } else {
        part as f64 / whole as f64
    }
}

// ---------------------------------------------------------------------------------------------
// Generators.

fn nudge(value: f64, rng: &mut Rng) -> f64 {
    let mut value = value;
    for _ in 0..rng.below(4) {
        value = if rng.chance(1, 2) {
            value.next_up()
        } else {
            value.next_down()
        };
    }
    value
}

/// `value * 2^bits` with the same sign, or `None` beyond the capacity: the same ratio in an
/// unnormalized representation when applied to numerator and weight together.
fn shifted<const N: usize>(value: &Signed<N>, bits: usize) -> Option<Signed<N>> {
    if value.used == 0 {
        return Some(*value);
    }
    let words = bits / 64;
    let offset = bits % 64;
    let mut result = Signed::<N>::zero();
    let mut carry = 0u64;
    for index in 0..value.used {
        let limb = value.limbs[index];
        let target = index + words;
        if target >= N {
            return None;
        }
        result.limbs[target] = if offset == 0 {
            limb
        } else {
            (limb << offset) | carry
        };
        carry = if offset == 0 {
            0
        } else {
            limb >> (64 - offset)
        };
    }
    let mut used = value.used + words;
    if carry != 0 {
        if used >= N {
            return None;
        }
        result.limbs[used] = carry;
        used += 1;
    }
    result.used = used;
    result.negative = value.negative;
    Some(result)
}

fn shifted_column(column: ExactColumn, bits: usize) -> Option<ExactColumn> {
    Some(ExactColumn {
        numerator: shifted(&column.numerator, bits)?,
        weight: shifted(&column.weight, bits)?,
    })
}

fn shifted_section(section: ExactSection, bits: usize) -> Option<ExactSection> {
    Some(ExactSection {
        numerator: shifted(&section.numerator, bits)?,
        weight: shifted(&section.weight, bits)?,
    })
}

/// A scene scale exponent and a coordinate at that scale (sometimes a small integer).
fn coordinate(rng: &mut Rng, exponent: i32) -> f64 {
    match rng.below(8) {
        0 => rng.below(17) as f64 - 8.0,
        1 => 0.0,
        _ => rng.scaled_in(exponent - 12, exponent, true),
    }
}

fn scene_point(rng: &mut Rng, exponent: i32) -> Point {
    point(coordinate(rng, exponent), coordinate(rng, exponent))
}

/// A proper crossing near `center`: two segments through it in random directions. Rounding
/// may move the endpoints off the exact lines; non-proper results are replaced by an endpoint.
fn crossing_near(rng: &mut Rng, center: Point, exponent: i32) -> FillEvent {
    let mut direction = || {
        point(
            rng.scaled_in(exponent - 6, exponent, true),
            rng.scaled_in(exponent - 6, exponent, true),
        )
    };
    let first = direction();
    let second = direction();
    let mut length = || 0.25 + (rng.next_u64() >> 11) as f64 * pow2(-53) * 2.0;
    let (s0, s1, r0, r1) = (length(), length(), length(), length());
    let event = FillEvent::Crossing {
        a: point(center.x - s0 * first.x, center.y - s0 * first.y),
        b: point(center.x + s1 * first.x, center.y + s1 * first.y),
        c: point(center.x - r0 * second.x, center.y - r0 * second.y),
        d: point(center.x + r1 * second.x, center.y + r1 * second.y),
    };
    if exact_event_position(event).is_ok() {
        event
    } else {
        FillEvent::Endpoint(center)
    }
}

/// A proper crossing exactly at a lattice point, from two lattice lines through it.
fn lattice_crossing(rng: &mut Rng, center: Point, unit: f64) -> FillEvent {
    // Integer directions, compared before scaling (a product of scaled values may underflow).
    let mut direction = || loop {
        let p = rng.below(9) as i64 - 4;
        let q = rng.below(9) as i64 - 4;
        if p != 0 || q != 0 {
            return (p, q);
        }
    };
    let (p0, q0) = direction();
    let (mut p1, mut q1) = direction();
    while p0 * q1 == p1 * q0 {
        (p1, q1) = direction();
    }
    let (p0, q0, p1, q1) = (
        p0 as f64 * unit,
        q0 as f64 * unit,
        p1 as f64 * unit,
        q1 as f64 * unit,
    );
    let event = FillEvent::Crossing {
        a: point(center.x - p0, center.y - q0),
        b: point(center.x + p0, center.y + q0),
        c: point(center.x - p1, center.y - q1),
        d: point(center.x + 2.0 * p1, center.y + 2.0 * q1),
    };
    if exact_event_position(event).is_ok() {
        event
    } else {
        FillEvent::Endpoint(center)
    }
}

/// A finite, proper column event: an endpoint or a crossing at the scene scale.
fn column_event(rng: &mut Rng, exponent: i32, adversarial: bool) -> FillEvent {
    let center = scene_point(rng, exponent);
    match rng.below(if adversarial { 4 } else { 3 }) {
        0 => FillEvent::Endpoint(center),
        1 | 2 => {
            let size = exponent + rng.range_i32(-20, 0);
            crossing_near(rng, center, size)
        }
        _ => {
            let unit = pow2(exponent - rng.range_i32(0, 8));
            let center = point(
                (rng.below(64) as f64 - 32.0) * unit,
                (rng.below(64) as f64 - 32.0) * unit,
            );
            lattice_crossing(rng, center, unit)
        }
    }
}

/// A binary64 estimate of a ratio value (only to place candidates near it).
fn estimate(enclosure: Option<Interval>) -> Option<f64> {
    let enclosure = enclosure?;
    let middle = enclosure.lo * 0.5 + enclosure.hi * 0.5;
    middle.is_finite().then_some(middle)
}

fn column_estimate(column: &ExactColumn) -> Option<f64> {
    estimate(enclose_ratio(&column.numerator, &column.weight))
}

fn section_estimate(section: &ExactSection) -> Option<f64> {
    estimate(enclose_ratio(&section.numerator, &section.weight))
}

/// A column: an event column, a mediant of two (snapped mediant samples included), or another
/// representation of the same ratio.
fn random_column(rng: &mut Rng, exponent: i32, adversarial: bool) -> ExactColumn {
    let base = event_column(column_event(rng, exponent, adversarial)).expect("proper event");
    match rng.below(5) {
        0 | 1 => base,
        2 => {
            let other = if adversarial && rng.chance(1, 2) {
                // Adjacent binary64 columns: the snapped mediant sample of a narrow slab.
                let x = column_estimate(&base).unwrap_or(1.0);
                event_column(FillEvent::Endpoint(point(x.next_up(), 0.0))).expect("endpoint")
            } else {
                event_column(column_event(rng, exponent, adversarial)).expect("proper event")
            };
            mediant(base, other)
        }
        _ => {
            let bits = 1 + rng.below(400) as usize;
            shifted_column(base, bits).unwrap_or(base)
        }
    }
}

/// A nonvertical edge at the scene scale, sometimes through `through` (a shared vertex).
fn random_edge(rng: &mut Rng, exponent: i32, through: Option<Point>) -> (Point, Point) {
    loop {
        let start = through.unwrap_or_else(|| scene_point(rng, exponent));
        let end = scene_point(rng, exponent);
        if start.x != end.x {
            return if rng.chance(1, 2) {
                (start, end)
            } else {
                (end, start)
            };
        }
    }
}

/// A section: an endpoint section, a column as a section, a nonvertical edge at a column, or
/// another representation of the same ratio.
fn random_section(rng: &mut Rng, exponent: i32, adversarial: bool) -> ExactSection {
    let base = match rng.below(4) {
        0 => endpoint_section(coordinate(rng, exponent)),
        1 => column_as_section(random_column(rng, exponent, adversarial)),
        _ => {
            let (start, end) = random_edge(rng, exponent, None);
            section_at_column(start, end, random_column(rng, exponent, adversarial))
        }
    };
    if rng.chance(1, 5) {
        let bits = 1 + rng.below(400) as usize;
        shifted_section(base, bits).unwrap_or(base)
    } else {
        base
    }
}

/// A binary64 candidate: random, or within a few ulps of `near`, or `near` itself.
fn candidate(rng: &mut Rng, near: Option<f64>, exponent: i32) -> f64 {
    match (near, rng.below(4)) {
        (Some(value), 0) => value,
        (Some(value), 1 | 2) => nudge(value, rng),
        _ => rng.finite(exponent - 20, exponent + 4),
    }
}

/// A tolerance: random, at the edges of the exact-halving range, or twice a distance.
fn tolerance(rng: &mut Rng, distance: Option<f64>) -> f64 {
    match rng.below(10) {
        0 => f64::from_bits(1),
        1 => pow2(-1021),
        2 => pow2(-1021).next_down(),
        3 | 4 => match distance {
            Some(value) if value.is_finite() && value != 0.0 => {
                let doubled = (2.0 * value).abs();
                if doubled.is_finite() && doubled > 0.0 {
                    nudge(doubled, rng)
                } else {
                    1.0
                }
            }
            _ => rng.scaled_in(-60, 10, false),
        },
        _ => rng.scaled_in(-80, 20, false),
    }
}

// ---------------------------------------------------------------------------------------------
// O1, crate comparisons (F0.6, F2.6-F2.8).

/// A half-budget tie 2(N - vW) = TW: a section exactly v + h, as an endpoint section or as an
/// edge through (0, v) and (2, v + 2h) at x = 1, with tau = 2h (adjusted by a few ulps).
fn half_tie(rng: &mut Rng) -> (ExactSection, f64, f64) {
    let v = (rng.below(64) as f64 - 32.0) * pow2(rng.range_i32(-8, 8));
    let h = pow2(rng.range_i32(-40, 0));
    let s = v + h;
    let section = if rng.chance(1, 2) || (v + 2.0 * h) - v != 2.0 * h {
        endpoint_section(s)
    } else {
        section_at_column(
            point(0.0, v),
            point(2.0, v + 2.0 * h),
            event_column(FillEvent::Endpoint(point(1.0, 0.0))).expect("endpoint"),
        )
    };
    let tau = match rng.below(3) {
        0 => 2.0 * h,
        1 => (2.0 * h).next_down(),
        _ => (2.0 * h).next_up(),
    };
    // v is the lower predicate's tie and v + 2h the upper one's.
    let value = if rng.chance(1, 2) { v } else { v + 2.0 * h };
    (section, value, tau)
}

/// O1 differential of the seven crate comparisons: `random` random and `adversarial`
/// adversarial tuples, each evaluated by every comparison.
pub(crate) fn crate_differential(seed: u64, random: u64, adversarial: u64) -> SectionTally {
    let mut rng = Rng::new(seed);
    let mut tally = SectionTally::default();
    reset_counters();
    for index in 0..random + adversarial {
        let adversarial = index >= random;
        let exponent = if adversarial {
            match rng.below(4) {
                0 => rng.range_i32(-1000, -960),
                1 => rng.range_i32(960, 1000),
                _ => rng.range_i32(-40, 40),
            }
        } else {
            rng.range_i32(-60, 60)
        };
        let left_column = random_column(&mut rng, exponent, adversarial);
        let right_column = match rng.below(if adversarial { 4 } else { 6 }) {
            0 => left_column,
            1 => shifted_column(left_column, 1 + rng.below(300) as usize).unwrap_or(left_column),
            _ => random_column(&mut rng, exponent, adversarial),
        };
        let (left_section, value, tau) = if adversarial && rng.chance(1, 4) {
            half_tie(&mut rng)
        } else {
            let section = random_section(&mut rng, exponent, adversarial);
            let near = section_estimate(&section);
            let value = candidate(&mut rng, near, exponent);
            let tau = tolerance(&mut rng, near.map(|near| near - value));
            (section, value, tau)
        };
        let right_section = match rng.below(if adversarial { 4 } else { 6 }) {
            0 => left_section,
            1 => shifted_section(left_section, 1 + rng.below(300) as usize).unwrap_or(left_section),
            _ => random_section(&mut rng, exponent, adversarial),
        };
        let column_value = candidate(&mut rng, column_estimate(&left_column), exponent);
        let context = || {
            format!(
                "columns {left_column:?} {right_column:?} value {column_value:e}; sections \
                 {left_section:?} {right_section:?} value {value:e} tau {tau:e}"
            )
        };
        tally.cases += 1;
        tally.check(
            0,
            CRATE_NAMES[0],
            compare_columns(left_column, right_column),
            exact_compare_columns(left_column, right_column),
            &context,
        );
        tally.check(
            1,
            CRATE_NAMES[1],
            compare_column_f64(left_column, column_value),
            exact_compare_column_f64(left_column, column_value),
            &context,
        );
        tally.check(
            2,
            CRATE_NAMES[2],
            compare_sections(left_section, right_section),
            exact_compare_sections(left_section, right_section),
            &context,
        );
        tally.check(
            3,
            CRATE_NAMES[3],
            compare_section_f64(left_section, value),
            exact_compare_section_f64(left_section, value),
            &context,
        );
        if tau.is_finite() && tau > 0.0 {
            tally.check(
                4,
                CRATE_NAMES[4],
                within_half_budget(left_section, value, tau),
                exact_within_half_budget(left_section, value, tau),
                &context,
            );
            tally.check(
                5,
                CRATE_NAMES[5],
                lower_half_predicate(left_section, value, tau),
                exact_lower_half_predicate(left_section, value, tau),
                &context,
            );
            tally.check(
                6,
                CRATE_NAMES[6],
                upper_half_predicate(left_section, value, tau),
                exact_upper_half_predicate(left_section, value, tau),
                &context,
            );
        }
        tally.collect_counters();
    }
    tally
}

// ---------------------------------------------------------------------------------------------
// O1, source-level comparisons (F0.5, T1, T2, T4).

/// A section source at the scene scale. Adversarial sources include edges through a shared
/// vertex at that vertex's column, and the two edges of a crossing at the crossing's column.
fn random_source(rng: &mut Rng, exponent: i32, adversarial: bool) -> SectionSource {
    match rng.below(if adversarial { 5 } else { 4 }) {
        0 => SectionSource::Endpoint(coordinate(rng, exponent)),
        1 => SectionSource::Column(column_event(rng, exponent, adversarial)),
        2 | 3 => {
            let (start, end) = random_edge(rng, exponent, None);
            SectionSource::Edge {
                start,
                end,
                column: column_event(rng, exponent, adversarial),
            }
        }
        _ => {
            let vertex = scene_point(rng, exponent);
            let (start, end) = random_edge(rng, exponent, Some(vertex));
            SectionSource::Edge {
                start,
                end,
                column: FillEvent::Endpoint(point(vertex.x, coordinate(rng, exponent))),
            }
        }
    }
}

/// A second source tied to `first` in the adversarial families: an edge through the same
/// vertex, or the other edge of the crossing that defines the column.
fn related_source(rng: &mut Rng, first: SectionSource, exponent: i32) -> SectionSource {
    match first {
        SectionSource::Edge {
            start,
            end,
            column: FillEvent::Endpoint(at),
        } if at.x == start.x || at.x == end.x => {
            let vertex = if at.x == start.x { start } else { end };
            if rng.chance(1, 3) {
                SectionSource::Endpoint(vertex.y)
            } else {
                let (start, end) = random_edge(rng, exponent, Some(vertex));
                SectionSource::Edge {
                    start,
                    end,
                    column: FillEvent::Endpoint(at),
                }
            }
        }
        SectionSource::Edge {
            column: column @ FillEvent::Crossing { a, b, c, d },
            ..
        } => {
            let (start, end) = if rng.chance(1, 2) { (a, b) } else { (c, d) };
            if start.x == end.x {
                SectionSource::Column(column)
            } else {
                SectionSource::Edge { start, end, column }
            }
        }
        SectionSource::Column(column @ FillEvent::Crossing { a, b, .. }) if a.x != b.x => {
            SectionSource::Edge {
                start: a,
                end: b,
                column,
            }
        }
        _ => random_source(rng, exponent, true),
    }
}

/// Checks that a finite source enclosure contains the exact value.
fn check_enclosure(source: SectionSource, tally: &mut SectionTally) {
    let enclosure = source.enclosure();
    if !enclosure.is_finite() {
        tally.unbounded += 1;
        return;
    }
    let section = source.build().expect("proper sources");
    tally.enclosures += 1;
    if exact_compare_section_f64(section, enclosure.lo) == Ordering::Less
        || exact_compare_section_f64(section, enclosure.hi) == Ordering::Greater
    {
        tally.containment_violations += 1;
        if tally.containment_violations <= 3 {
            eprintln!("B0R O1 source enclosure miss {source:?}: {enclosure:?}");
        }
    }
}

/// O1 differential of the source-level comparisons against the eager exact construction.
pub(crate) fn source_differential(seed: u64, random: u64, adversarial: u64) -> SectionTally {
    let mut rng = Rng::new(seed);
    let mut tally = SectionTally::default();
    reset_counters();
    for index in 0..random + adversarial {
        let adversarial = index >= random;
        let exponent = if adversarial {
            match rng.below(4) {
                0 => rng.range_i32(-1000, -960),
                1 => rng.range_i32(900, 940),
                _ => rng.range_i32(-30, 30),
            }
        } else {
            rng.range_i32(-40, 40)
        };
        let left = random_source(&mut rng, exponent, adversarial);
        let right = if adversarial && rng.chance(2, 3) {
            related_source(&mut rng, left, exponent)
        } else {
            random_source(&mut rng, exponent, adversarial)
        };
        let left_section = left.build().expect("proper sources");
        let right_section = right.build().expect("proper sources");
        let near = section_estimate(&left_section);
        let column = column_event(&mut rng, exponent, adversarial);
        let column_value = candidate(
            &mut rng,
            column_estimate(&event_column(column).expect("proper event")),
            exponent,
        );
        let context = || format!("sources {left:?} {right:?}");
        tally.cases += 1;
        tally.check(
            0,
            SOURCE_NAMES[0],
            compare_column_source_f64(column, column_value),
            Ok(exact_compare_column_f64(
                event_column(column).expect("proper event"),
                column_value,
            )),
            &|| format!("column {column:?} value {column_value:e}"),
        );
        tally.check(
            1,
            SOURCE_NAMES[1],
            compare_section_sources(left, right),
            Ok(exact_compare_sections(left_section, right_section)),
            &context,
        );
        // T2: one target, several steps, so the built section is reused after a fallback.
        let mut target = SectionTarget::from(left);
        for _ in 0..3 {
            let value = candidate(&mut rng, near, exponent);
            let tau = tolerance(&mut rng, near.map(|near| near - value));
            let step_context = || format!("target {left:?} value {value:e} tau {tau:e}");
            tally.check(
                2,
                SOURCE_NAMES[2],
                target.compare_f64(value),
                Ok(exact_compare_section_f64(left_section, value)),
                &step_context,
            );
            if tau.is_finite() && tau > 0.0 {
                tally.check(
                    3,
                    SOURCE_NAMES[3],
                    target.lower_half(value, tau),
                    Ok(exact_lower_half_predicate(left_section, value, tau)),
                    &step_context,
                );
                tally.check(
                    4,
                    SOURCE_NAMES[4],
                    target.upper_half(value, tau),
                    Ok(exact_upper_half_predicate(left_section, value, tau)),
                    &step_context,
                );
            }
        }
        check_enclosure(left, &mut tally);
        check_enclosure(right, &mut tally);
        if let FillEvent::Crossing { .. } = column {
            // The crossing column's own x enclosure (T4's input) must contain its x.
            let enclosure = x_enclosure(column);
            if enclosure.is_finite() {
                let exact = event_column(column).expect("proper event");
                tally.enclosures += 1;
                if exact_compare_column_f64(exact, enclosure.lo) == Ordering::Less
                    || exact_compare_column_f64(exact, enclosure.hi) == Ordering::Greater
                {
                    tally.containment_violations += 1;
                }
            } else {
                tally.unbounded += 1;
            }
        }
        tally.collect_counters();
    }
    tally
}

fn report(label: &str, names: &[&str], tally: &SectionTally) -> String {
    let disagreements: Vec<String> = names
        .iter()
        .zip(tally.disagreements)
        .map(|(name, count)| format!("{name} {count}"))
        .collect();
    format!(
        "{label}: {} cases; disagreements [{}]; {} enclosures checked, {} containment violations, \
         {} unbounded; {}",
        tally.cases,
        disagreements.join(", "),
        tally.enclosures,
        tally.containment_violations,
        tally.unbounded,
        tally.rates()
    )
}

#[test]
fn b0r_o1_smoke_section_crate_filters() {
    let tally = crate_differential(0x4230_5234_0001, 10_000, 1_000);
    println!("{}", report("B0R O1 smoke crate", &CRATE_NAMES, &tally));
    assert_eq!(tally.failures(), 0, "{tally:?}");
    // Each ratio filter decides a share of the tuples; most candidates are placed within a few
    // ulps of the value by design, and the O2 decided controls check separated cases.
    for id in [
        FilterId::ColumnRatio,
        FilterId::SectionRatio,
        FilterId::HalfBudget,
    ] {
        let (decided, fallback) = tally.filters[id as usize - FilterId::EndpointValue as usize];
        assert!(
            fraction(decided, decided + fallback) > 0.15,
            "{id:?} {decided}/{fallback}"
        );
    }
    let (identity, _) = tally.filters[1];
    assert!(identity > 100, "F0.6 hits {identity}");
}

#[test]
fn b0r_o1_smoke_section_sources() {
    let tally = source_differential(0x4230_5234_0002, 10_000, 1_000);
    println!("{}", report("B0R O1 smoke sources", &SOURCE_NAMES, &tally));
    assert_eq!(tally.failures(), 0, "{tally:?}");
    assert!(tally.enclosures > 10_000, "{tally:?}");
    for id in [
        FilterId::LazyColumn,
        FilterId::LazySection,
        FilterId::EmbedStep,
        FilterId::EmbedHalfStep,
    ] {
        let (decided, fallback) = tally.filters[id as usize - FilterId::EndpointValue as usize];
        assert!(
            fraction(decided, decided + fallback) > 0.15,
            "{id:?} {decided}/{fallback}"
        );
    }
}

// ---------------------------------------------------------------------------------------------
// O2 fixtures.

const DECIDED: (u64, u64) = (1, 0);
const FALLBACK: (u64, u64) = (0, 1);

/// Runs `action` and returns its value with the (decided, fallback) counts of one filter.
fn counted<T>(id: FilterId, action: impl FnOnce() -> T) -> (T, (u64, u64)) {
    reset_counters();
    let value = action();
    let result = counts(id);
    reset_counters();
    (value, result)
}

fn endpoint_column(x: f64) -> ExactColumn {
    event_column(FillEvent::Endpoint(point(x, 0.0))).expect("finite endpoint")
}

/// O2: a section exactly equal to a binary64 candidate is never decided by F2.7, at the
/// crate level or from its source; the exact routine returns `Equal`.
#[test]
fn b0r_o2_section_equal_to_candidate_falls_back() {
    let (start, end) = (point(0.0, 0.0), point(2.0, 2.0));
    let section = section_at_column(start, end, endpoint_column(1.0));
    let (order, counts) = counted(FilterId::SectionRatio, || compare_section_f64(section, 1.0));
    assert_eq!((order, counts), (Ordering::Equal, FALLBACK));
    let source = SectionSource::Edge {
        start,
        end,
        column: FillEvent::Endpoint(point(1.0, 7.0)),
    };
    let mut target = SectionTarget::from(source);
    let (order, counts) = counted(FilterId::EmbedStep, || target.compare_f64(1.0));
    assert_eq!((order, counts), (Ok(Ordering::Equal), FALLBACK));
    // One ulp away on either side is decided from the source enclosure.
    let (order, counts) = counted(FilterId::EmbedStep, || {
        target.compare_f64(1.0f64.next_up().next_up().next_up().next_up())
    });
    assert_eq!(order, Ok(Ordering::Less));
    assert!(counts == DECIDED || counts == FALLBACK);
    assert_eq!(
        target.compare_f64(1.0 + pow2(-30)),
        Ok(Ordering::Less),
        "decided control"
    );
}

/// O2: half-budget ties 2(N - vW) = TW fall back and keep the inclusive boundary.
#[test]
fn b0r_o2_half_budget_ties_fall_back() {
    let h = pow2(-11);
    let tied = section_at_column(
        point(0.0, 1.0),
        point(2.0, 1.0 + 2.0 * h),
        endpoint_column(1.0),
    );
    assert_eq!(exact_compare_section_f64(tied, 1.0 + h), Ordering::Equal);
    for section in [tied, endpoint_section(1.0 + h)] {
        let (value, counts) = counted(FilterId::HalfBudget, || {
            lower_half_predicate(section, 1.0, 2.0 * h)
        });
        assert_eq!((value, counts), (true, FALLBACK));
        let (value, counts) = counted(FilterId::HalfBudget, || {
            upper_half_predicate(section, 1.0 + 2.0 * h, 2.0 * h)
        });
        assert_eq!((value, counts), (true, FALLBACK));
        let (value, counts) = counted(FilterId::HalfBudget, || {
            within_half_budget(section, 1.0, 2.0 * h)
        });
        assert_eq!((value, counts), (true, FALLBACK));
        let (value, _) = counted(FilterId::HalfBudget, || {
            lower_half_predicate(section, 1.0, (2.0 * h).next_down())
        });
        assert!(!value);
    }
    // The same tie from the source inside a window search step.
    let mut target = SectionTarget::from(SectionSource::Edge {
        start: point(0.0, 1.0),
        end: point(2.0, 1.0 + 2.0 * h),
        column: FillEvent::Endpoint(point(1.0, 0.0)),
    });
    let (value, counts) = counted(FilterId::EmbedHalfStep, || target.lower_half(1.0, 2.0 * h));
    assert_eq!((value, counts), (Ok(true), FALLBACK));
    let (value, counts) = counted(FilterId::EmbedHalfStep, || {
        target.lower_half(1.0 - pow2(-20), 2.0 * h)
    });
    assert_eq!((value, counts), (Ok(false), DECIDED), "decided control");
}

/// O2: tau at the minimum subnormal and just below 2^-1021 is not halved, so F2.8 falls
/// back; at 2^-1021 the halving is exact and well-separated cases are decided.
#[test]
fn b0r_o2_half_budget_tolerance_limits() {
    let section = endpoint_section(3.0);
    for tau in [f64::from_bits(1), pow2(-1021).next_down(), pow2(-1022)] {
        let (value, counts) = counted(FilterId::HalfBudget, || {
            lower_half_predicate(section, 1.0, tau)
        });
        assert_eq!(value, exact_lower_half_predicate(section, 1.0, tau));
        assert_eq!(counts, FALLBACK, "tau {tau:e}");
    }
    for (value, expected) in [(1.0, false), (5.0, true)] {
        let (result, counts) = counted(FilterId::HalfBudget, || {
            lower_half_predicate(section, value, pow2(-1021))
        });
        assert_eq!((result, counts), (expected, DECIDED));
        assert_eq!(
            result,
            exact_lower_half_predicate(section, value, pow2(-1021))
        );
    }
    // A subnormal section with a subnormal tolerance: the exact routine decides.
    let tiny = endpoint_section(f64::from_bits(3));
    let (value, counts) = counted(FilterId::HalfBudget, || {
        within_half_budget(tiny, f64::from_bits(2), f64::from_bits(2))
    });
    assert_eq!((value, counts), (true, FALLBACK));
}

/// O2: endpoint sections at 100 and near 2^+-1000 are enclosed by section 3.4 without
/// overflow, and decided against separated candidates.
#[test]
fn b0r_o2_endpoint_sections_through_ratio_enclosures() {
    for value in [100.0, pow2(1000), pow2(-1000), -1.5 * pow2(1000), -100.0] {
        let section = endpoint_section(value);
        let above = value + value.abs() * pow2(-30);
        let (order, counts) = counted(FilterId::SectionRatio, || {
            compare_section_f64(section, above)
        });
        assert_eq!((order, counts), (Ordering::Less, DECIDED), "{value:e}");
        let (order, counts) = counted(FilterId::SectionRatio, || {
            compare_section_f64(section, value)
        });
        assert_eq!((order, counts), (Ordering::Equal, FALLBACK), "{value:e}");
        // F0.5 decides the same comparisons from the source without enclosing.
        let mut target = SectionTarget::from(SectionSource::Endpoint(value));
        let (order, counts) = counted(FilterId::EndpointValue, || target.compare_f64(value));
        assert_eq!((order, counts), (Ok(Ordering::Equal), DECIDED));
    }
    // Signed zeros compare equal under F0.5, as `from_finite` maps both to zero.
    let (order, counts) = counted(FilterId::EndpointValue, || {
        compare_section_sources(SectionSource::Endpoint(-0.0), SectionSource::Endpoint(0.0))
    });
    assert_eq!((order, counts), (Ok(Ordering::Equal), DECIDED));
    let (order, counts) = counted(FilterId::EndpointValue, || {
        compare_column_source_f64(FillEvent::Endpoint(point(-0.0, 1.0)), 0.0)
    });
    assert_eq!((order, counts), (Ok(Ordering::Equal), DECIDED));
}

/// O2: F0.6 decides identical representations; the same ratio in another representation is
/// not an identity and goes on to F2 and the exact routine.
#[test]
fn b0r_o2_representation_identity() {
    let section = section_at_column(point(0.0, 0.0), point(3.0, 1.0), endpoint_column(1.0));
    let (order, counts) = counted(FilterId::RepresentationIdentity, || {
        compare_sections(section, section)
    });
    assert_eq!((order, counts), (Ordering::Equal, DECIDED));
    let other = shifted_section(section, 77).unwrap();
    let (order, counts) = counted(FilterId::RepresentationIdentity, || {
        compare_sections(section, other)
    });
    assert_eq!((order, counts), (Ordering::Equal, (0, 0)));
    let (_, counts) = counted(FilterId::SectionRatio, || compare_sections(section, other));
    assert_eq!(counts, FALLBACK);
    let column = mediant(endpoint_column(1.0), endpoint_column(2.0));
    let (order, counts) = counted(FilterId::RepresentationIdentity, || {
        compare_columns(column, column)
    });
    assert_eq!((order, counts), (Ordering::Equal, DECIDED));
    // Zeros with either sign flag are one identity.
    let zero = endpoint_section(0.0);
    let mut negative_zero = zero;
    negative_zero.numerator.negative = true;
    assert_eq!(compare_sections(zero, negative_zero), Ordering::Equal);
}

/// O2 decided controls: snapped mediant columns, sections at mediant samples and at crossing
/// columns, and crossing columns from their points are decided on separated candidates, so a
/// filter that always falls back fails here.
#[test]
fn b0r_o2_decided_controls() {
    let snapped = mediant(endpoint_column(1.0), endpoint_column(1.0f64.next_up()));
    let (order, counts) = counted(FilterId::ColumnRatio, || {
        compare_column_f64(snapped, 1.0 + pow2(-40))
    });
    assert_eq!((order, counts), (Ordering::Less, DECIDED));
    let wide = mediant(endpoint_column(0.1), endpoint_column(0.7));
    let (order, counts) = counted(FilterId::ColumnRatio, || {
        compare_columns(wide, endpoint_column(0.3))
    });
    assert_eq!((order, counts), (Ordering::Greater, DECIDED));

    let at_mediant = section_at_column(point(0.1, 0.3), point(0.9, 0.7), wide);
    let (order, counts) = counted(FilterId::SectionRatio, || {
        compare_section_f64(at_mediant, 0.6)
    });
    assert_eq!((order, counts), (Ordering::Less, DECIDED));

    let crossing = FillEvent::Crossing {
        a: point(0.1, 0.2),
        b: point(2.3, 1.7),
        c: point(0.3, 1.9),
        d: point(1.9, 0.1),
    };
    let at_crossing = section_at_column(
        point(0.0, 0.0),
        point(2.0, 0.5),
        event_column(crossing).unwrap(),
    );
    let (order, counts) = counted(FilterId::SectionRatio, || {
        compare_section_f64(at_crossing, 1.0)
    });
    assert_eq!((order, counts), (Ordering::Less, DECIDED));
    let (order, counts) = counted(FilterId::LazyColumn, || {
        compare_column_source_f64(crossing, 0.5)
    });
    assert_eq!((order, counts), (Ok(Ordering::Greater), DECIDED));
    let (order, counts) = counted(FilterId::LazySection, || {
        compare_section_sources(
            SectionSource::Edge {
                start: point(0.0, 0.0),
                end: point(2.0, 0.5),
                column: crossing,
            },
            SectionSource::Edge {
                start: point(0.0, 1.0),
                end: point(2.0, 1.5),
                column: crossing,
            },
        )
    });
    assert_eq!((order, counts), (Ok(Ordering::Less), DECIDED));
    let mut target = SectionTarget::from(SectionSource::Column(crossing));
    let (order, counts) = counted(FilterId::EmbedStep, || target.compare_f64(2.0));
    assert_eq!((order, counts), (Ok(Ordering::Less), DECIDED));
}

/// O2: the two edges of a crossing, at the crossing's column, have equal sections; neither
/// F0.5 nor the source enclosures decide, and the exact routine returns `Equal`.
#[test]
fn b0r_o2_equal_sections_at_crossing_and_shared_vertex_fall_back() {
    let (a, b, c, d) = (
        point(0.0, 0.0),
        point(3.0, 3.0),
        point(0.0, 3.0),
        point(3.0, 0.0),
    );
    let crossing = FillEvent::Crossing { a, b, c, d };
    let (order, counts) = counted(FilterId::LazySection, || {
        compare_section_sources(
            SectionSource::Edge {
                start: a,
                end: b,
                column: crossing,
            },
            SectionSource::Edge {
                start: c,
                end: d,
                column: crossing,
            },
        )
    });
    assert_eq!((order, counts), (Ok(Ordering::Equal), FALLBACK));
    let vertex = point(0.1, 0.7);
    let (order, counts) = counted(FilterId::LazySection, || {
        compare_section_sources(
            SectionSource::Edge {
                start: vertex,
                end: point(0.9, 0.3),
                column: FillEvent::Endpoint(vertex),
            },
            SectionSource::Endpoint(vertex.y),
        )
    });
    assert_eq!((order, counts), (Ok(Ordering::Equal), FALLBACK));
}

/// O2: a non-finite endpoint column or section is not filtered, so the eager construction
/// keeps its error.
#[test]
fn b0r_o2_nonfinite_sources_keep_their_errors() {
    let nonfinite = FillEvent::Endpoint(point(f64::NAN, 0.0));
    assert_eq!(
        compare_column_source_f64(nonfinite, 0.0),
        event_column(nonfinite).map(|column| exact_compare_column_f64(column, 0.0))
    );
    assert!(compare_column_source_f64(nonfinite, 0.0).is_err());
    let source = SectionSource::Column(nonfinite);
    assert_eq!(source.exact_value(), None);
    assert!(compare_section_sources(source, SectionSource::Endpoint(1.0)).is_err());
}

// ---------------------------------------------------------------------------------------------
// O8 seeded defects (1) and (7) against the U4 oracles.

/// O8 (1): with R1 widening removed, source enclosures miss exact values.
#[test]
fn b0r_o8_r1_widening_removed_is_detected_by_section_sources() {
    let tally = with_fault(Fault::R1WideningRemoved, || {
        source_differential(0x4230_5234_0002, 2_000, 500)
    });
    assert!(tally.containment_violations > 0, "{tally:?}");
}

/// O8 (7): a fixed numerator unit in the ratio enclosure makes the crate filters disagree
/// with the exact routines.
#[test]
fn b0r_o8_ratio_fixed_numerator_unit_is_detected_by_section_filters() {
    let tally = with_fault(Fault::RatioFixedNumeratorUnit, || {
        crate_differential(0x4230_5234_0001, 2_000, 500)
    });
    assert!(tally.failures() > 0, "{tally:?}");
}

// ---------------------------------------------------------------------------------------------
// O10 tessellation shadow mode.

const LIMITS: RoundedFillLimits = RoundedFillLimits {
    max_contours: 16,
    max_input_vertices: 64,
    max_edges: 64,
    max_pairs: 2016,
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

/// Seeded random polygons and stars with crossings, shared vertices and vertical edges.
fn random_scenes(seed: u64, count: usize) -> Vec<Scene> {
    let mut rng = Rng::new(seed);
    (0..count)
        .map(|_| {
            let unit = pow2(rng.range_i32(-20, 10));
            let contours = (0..1 + rng.below(2))
                .map(|_| {
                    let vertices = 3 + rng.below(8) as usize;
                    (0..vertices)
                        .map(|_| {
                            let lattice = rng.chance(1, 2);
                            let mut value = || {
                                if lattice {
                                    (rng.below(16) as f64) * unit
                                } else {
                                    rng.scaled_in(-4, 3, false) * unit
                                }
                            };
                            point(value(), value())
                        })
                        .collect()
                })
                .collect();
            let rule = if rng.chance(1, 2) {
                LineFillRule::Nonzero
            } else {
                LineFillRule::Evenodd
            };
            let tau = unit * pow2(-rng.range_i32(2, 40));
            (contours, rule, tau)
        })
        .collect()
}

/// Tessellates every scene with shadow mode off and on; the results must be equal (shadow
/// only observes), and the shadow tally of the second run is returned.
fn shadow_scenes(scenes: &[Scene]) -> (ShadowTally, usize) {
    let mut workspace = RoundedFillWorkspace::new(LIMITS).unwrap();
    let mut ok = 0;
    take_shadow_tally();
    for (contours, rule, tau) in scenes {
        let references: Vec<&[Point]> = contours.iter().map(Vec::as_slice).collect();
        let plain = workspace.tessellate(&references, *rule, *tau);
        let plain_stats = workspace.stats();
        let plain_vertices: Vec<u64> = workspace
            .output()
            .map(|output| {
                output
                    .vertices
                    .iter()
                    .flat_map(|vertex| [vertex.x.to_bits(), vertex.y.to_bits()])
                    .collect()
            })
            .unwrap_or_default();
        let shadowed = with_shadow(|| workspace.tessellate(&references, *rule, *tau));
        assert_eq!(plain, shadowed);
        assert_eq!(plain_stats, workspace.stats());
        let vertices: Vec<u64> = workspace
            .output()
            .map(|output| {
                output
                    .vertices
                    .iter()
                    .flat_map(|vertex| [vertex.x.to_bits(), vertex.y.to_bits()])
                    .collect()
            })
            .unwrap_or_default();
        assert_eq!(plain_vertices, vertices);
        ok += usize::from(plain.is_ok());
    }
    (take_shadow_tally(), ok)
}

#[test]
fn b0r_o10_smoke_rounded_fixture_shadow() {
    let scenes = fixture_scenes();
    assert_eq!(scenes.len(), 202);
    let (tally, ok) = shadow_scenes(&scenes);
    println!("B0R O10 smoke fixture rows: {ok} ok, {tally:?}");
    assert!(tally.checks > 10_000, "{tally:?}");
    assert_eq!(tally.mismatches, 0, "{tally:?}");
}

#[test]
fn b0r_o10_smoke_random_scene_shadow() {
    let scenes = random_scenes(0x4230_5234_0010, 15);
    let (tally, ok) = shadow_scenes(&scenes);
    println!("B0R O10 smoke random scenes: {ok} ok, {tally:?}");
    assert!(ok > 10, "{ok}");
    assert!(tally.checks > 10_000, "{tally:?}");
    assert_eq!(tally.mismatches, 0, "{tally:?}");
}

/// O8 (7) against O10: with the fixed numerator unit, shadow mode sees wrong decisions on the
/// fixture rows.
#[test]
fn b0r_o8_ratio_fixed_numerator_unit_is_detected_by_shadow_mode() {
    let scenes = fixture_scenes();
    let tally = with_fault(Fault::RatioFixedNumeratorUnit, || {
        let mut workspace = RoundedFillWorkspace::new(LIMITS).unwrap();
        take_shadow_tally();
        with_shadow(|| {
            for (contours, rule, tau) in scenes.iter().take(60) {
                let references: Vec<&[Point]> = contours.iter().map(Vec::as_slice).collect();
                let _ = workspace.tessellate(&references, *rule, *tau);
            }
        });
        take_shadow_tally()
    });
    assert!(tally.mismatches > 0, "{tally:?}");
}

// ---------------------------------------------------------------------------------------------
// Full-size oracles (release profile, `pnpm test:p3-fill-identity`).

/// Full O1 for F0.5, F0.6, F2.6-F2.8, T1, T2 and T4: 10^7 random and 10^6 adversarial tuples
/// for each comparison.
#[test]
#[ignore = "B0R O1 full size; release profile via pnpm test:p3-fill-identity"]
fn b0r_oracle_full_o1_sections() {
    const RANDOM: u64 = 10_000_000;
    const ADVERSARIAL: u64 = 1_000_000;
    let threads = ORACLE_SHARDS;
    let start = Instant::now();
    let mut failures = 0;
    for (label, random, adversarial) in [("random", RANDOM, 0), ("adversarial", 0, ADVERSARIAL)] {
        let mut crate_tally = SectionTally::default();
        for shard in parallel(threads, move |index| {
            crate_differential(
                0x4230_5234_1000 + index as u64 + if random == 0 { 0x80 } else { 0 },
                share(random, threads, index),
                share(adversarial, threads, index),
            )
        }) {
            crate_tally.merge(shard);
        }
        println!(
            "{}",
            report(&format!("B0R O1 crate {label}"), &CRATE_NAMES, &crate_tally)
        );
        let mut source_tally = SectionTally::default();
        for shard in parallel(threads, move |index| {
            source_differential(
                0x4230_5234_2000 + index as u64 + if random == 0 { 0x80 } else { 0 },
                share(random, threads, index),
                share(adversarial, threads, index),
            )
        }) {
            source_tally.merge(shard);
        }
        println!(
            "{}",
            report(
                &format!("B0R O1 sources {label}"),
                &SOURCE_NAMES,
                &source_tally
            )
        );
        failures += crate_tally.failures() + source_tally.failures();
    }
    println!(
        "B0R O1 sections ({threads} shards, {:.1} s)",
        start.elapsed().as_secs_f64()
    );
    assert_eq!(failures, 0);
}

/// Full O10: the O4 native corpora (B0 and `p3-b0r-random/v1`) through every
/// `CubicFillWorkspace` entry and the V2 cascade (the identity harness's `run_chunk`), with
/// tessellation shadow mode on. Digests are discarded here; O4 compares them with the merge
/// base separately. The filter counts give the decided and fallback fractions per corpus.
#[test]
#[ignore = "B0R O10 full size; release profile via pnpm test:p3-fill-identity"]
fn b0r_oracle_full_o10_tessellation_shadow() {
    let start = Instant::now();
    for (label, chunks) in [
        ("B0", read_b0(&read_file("P3_B0R_B0_CORPUS"))),
        (
            "p3-b0r-random/v1",
            read_random(&read_file("P3_B0R_RANDOM_CORPUS")),
        ),
    ] {
        let chunk_count = chunks.len();
        let threads = ORACLE_SHARDS;
        let chunks = std::sync::Arc::new(chunks);
        let handles: Vec<_> = (0..threads)
            .map(|worker| {
                let chunks = std::sync::Arc::clone(&chunks);
                std::thread::Builder::new()
                    .stack_size(THREAD_STACK_BYTES)
                    .spawn(move || {
                        take_shadow_tally();
                        reset_counters();
                        with_shadow(|| {
                            for chunk in chunks.iter().skip(worker).step_by(threads) {
                                run_chunk(chunk);
                            }
                        });
                        let mut filters = SectionTally::default();
                        filters.collect_counters();
                        (take_shadow_tally(), filters)
                    })
                    .expect("spawn O10 corpus worker")
            })
            .collect();
        let mut tally = ShadowTally::default();
        let mut filters = SectionTally::default();
        for handle in handles {
            let (shadow, counts) = handle.join().expect("O10 corpus worker");
            tally.merge(shadow);
            filters.merge(counts);
        }
        println!(
            "B0R O10 {label} shadow: {chunk_count} chunks, {tally:?}; {}; {threads} threads, \
             {:.1} s",
            filters.rates(),
            start.elapsed().as_secs_f64()
        );
        assert!(tally.checks > 0, "{tally:?}");
        assert_eq!(tally.mismatches, 0, "{tally:?}");
    }
}
