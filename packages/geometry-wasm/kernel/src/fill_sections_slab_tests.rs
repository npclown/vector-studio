//! B0R unit U5 oracles for the tessellation changes T3 (endpoint-section identity) and T5 (lazy
//! slab samples and the zero-weight `ActiveEdge.section` sentinel under the T5 consumer rule)
//! (docs/plans/p3-b0r-kernel-performance-contract.md sections 5.2 and 7: O1, O2, O8, O10).
//!
//! - O1, T3: every section source made by `SectionSource::edge` is checked against the eager
//!   `section_at_column`: an identity value must equal the exact section, the identity must
//!   apply exactly when the column x equals an endpoint x, and every comparison through it
//!   (`compare_section_sources`, `SectionTarget` steps) must equal the exact routine.
//! - O1, T5: `compare_slab_sections` on sentinel and built operands is checked against the
//!   exact comparison of the eagerly built sections at the eager mediant sample; every section
//!   it stores must equal the eager one, and every finite sample and section enclosure must
//!   contain the exact value.
//! - O10: the tessellation shadow mode (U4's switch) also covers T5: every slab comparison
//!   and every operand that reaches `compare_sections` is checked against the eager value.
//!
//! The full-size runs are `#[ignore]` tests in the release profile, run by
//! `pnpm test:p3-fill-identity`; the ordinary tests are the smoke versions and the fixtures.
use core::cmp::Ordering;
use std::time::Instant;

use crate::fill_event_order::{exact_event_position, FillEvent};
use crate::fill_filter::{
    counts, reset_counters, take_shadow_tally, with_fault, with_shadow, Fault, FilterId, Interval,
};
use crate::fill_filter_tests::{parallel, pow2, share, Rng, ORACLE_SHARDS, THREAD_STACK_BYTES};
use crate::fill_sections::{
    compare_section_sources, compare_slab_sections, endpoint_section, event_column,
    exact_compare_column_f64, exact_compare_section_f64, exact_compare_sections,
    exact_lower_half_predicate, exact_upper_half_predicate, section_at_column, ExactSection,
    SectionSource, SectionTarget, SlabSample,
};
use crate::geometry::Point;
use crate::line_fill::LineFillRule;
use crate::p3_b0r_identity::{read_b0, read_file, read_random, run_chunk};
use crate::rounded_line_fill::{RoundedFillLimits, RoundedFillWorkspace};

/// The filter identities reported by these oracles, in tally order.
const IDS: [FilterId; 7] = [
    FilterId::EndpointSection,
    FilterId::SlabSection,
    FilterId::EndpointValue,
    FilterId::LazySection,
    FilterId::EmbedStep,
    FilterId::EmbedHalfStep,
    FilterId::RepresentationIdentity,
];

const ID_NAMES: [&str; 7] = [
    "T3 endpoint section (applications)",
    "T5 slab section",
    "F0.5 (calls)",
    "T1 section sources",
    "T2 bisection step",
    "T2 window step",
    "F0.6 (calls)",
];

/// The checked comparisons, in tally order.
const CHECK_NAMES: [&str; 6] = [
    "T3 identity value",
    "compare_section_sources",
    "SectionTarget steps",
    "compare_slab_sections",
    "stored section",
    "enclosure containment",
];

fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct SlabTally {
    pub(crate) cases: u64,
    /// Failures per check of `CHECK_NAMES`.
    pub(crate) failures: [u64; 6],
    /// T3 cases whose column x equals an endpoint x, and the T3 sources made for them.
    pub(crate) t3_matches: u64,
    pub(crate) t3_sources: u64,
    /// Finite enclosures checked, and unbounded ones.
    pub(crate) enclosures: u64,
    pub(crate) unbounded: u64,
    /// Slab comparisons that built at least one section, and the sections they built.
    pub(crate) built_comparisons: u64,
    pub(crate) built_sections: u64,
    /// (decided, fallback) per filter of `IDS`.
    pub(crate) filters: [(u64, u64); 7],
}

impl SlabTally {
    pub(crate) fn merge(&mut self, other: Self) {
        self.cases += other.cases;
        for (slot, value) in self.failures.iter_mut().zip(other.failures) {
            *slot += value;
        }
        self.t3_matches += other.t3_matches;
        self.t3_sources += other.t3_sources;
        self.enclosures += other.enclosures;
        self.unbounded += other.unbounded;
        self.built_comparisons += other.built_comparisons;
        self.built_sections += other.built_sections;
        for (slot, value) in self.filters.iter_mut().zip(other.filters) {
            slot.0 += value.0;
            slot.1 += value.1;
        }
    }

    fn total_failures(&self) -> u64 {
        self.failures.iter().sum()
    }

    fn collect_counters(&mut self) {
        for (slot, id) in self.filters.iter_mut().zip(IDS) {
            let (decided, fallback) = counts(id);
            slot.0 += decided;
            slot.1 += fallback;
        }
        reset_counters();
    }

    fn fail(&mut self, index: usize, context: &dyn Fn() -> String) {
        self.failures[index] += 1;
        if self.failures[index] <= 3 {
            eprintln!("B0R U5 O1 failure {}: {}", CHECK_NAMES[index], context());
        }
    }

    fn rates(&self) -> String {
        IDS.iter()
            .zip(ID_NAMES)
            .zip(self.filters)
            .filter(|(_, (decided, fallback))| decided + fallback > 0)
            .map(|((_, name), (decided, fallback))| {
                format!(
                    "{name}: decided {decided}, fallback {fallback}, decided fraction {:.4}",
                    decided as f64 / (decided + fallback) as f64
                )
            })
            .collect::<Vec<_>>()
            .join("; ")
    }
}

fn report(label: &str, tally: &SlabTally) -> String {
    let failures = CHECK_NAMES
        .iter()
        .zip(tally.failures)
        .map(|(name, count)| format!("{name} {count}"))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "{label}: {} cases; failures: {failures}; T3 matches {}, T3 sources {}; enclosures \
         {} checked, {} unbounded; slab comparisons that built {}, sections built {}; {}",
        tally.cases,
        tally.t3_matches,
        tally.t3_sources,
        tally.enclosures,
        tally.unbounded,
        tally.built_comparisons,
        tally.built_sections,
        tally.rates()
    )
}

// ---------------------------------------------------------------------------------------------
// Generators.

/// `value` moved by `steps` ulps up (positive) or down (negative).
fn ulps(value: f64, steps: i32) -> f64 {
    let mut value = value;
    for _ in 0..steps.unsigned_abs() {
        value = if steps > 0 {
            value.next_up()
        } else {
            value.next_down()
        };
    }
    value
}

/// A coordinate at the scene scale: sometimes a small integer, a zero of either sign or a
/// subnormal.
fn coordinate(rng: &mut Rng, exponent: i32, adversarial: bool) -> f64 {
    match rng.below(if adversarial { 10 } else { 8 }) {
        0 => rng.below(17) as f64 - 8.0,
        1 => 0.0,
        8 => -0.0,
        9 => f64::from_bits(1 + rng.below(1 << 20)) * if rng.chance(1, 2) { 1.0 } else { -1.0 },
        _ => rng.scaled_in(exponent - 12, exponent, true),
    }
}

fn scene_point(rng: &mut Rng, exponent: i32, adversarial: bool) -> Point {
    point(
        coordinate(rng, exponent, adversarial),
        coordinate(rng, exponent, adversarial),
    )
}

fn scene_exponent(rng: &mut Rng, adversarial: bool) -> i32 {
    if adversarial {
        match rng.below(4) {
            0 => rng.range_i32(-1000, -900),
            1 => rng.range_i32(900, 1000),
            _ => rng.range_i32(-40, 40),
        }
    } else {
        rng.range_i32(-30, 30)
    }
}

/// A nonvertical edge, sometimes through `through` (a shared vertex), in either direction.
fn edge_through(
    rng: &mut Rng,
    exponent: i32,
    through: Option<Point>,
    adversarial: bool,
) -> (Point, Point) {
    loop {
        let start = through.unwrap_or_else(|| scene_point(rng, exponent, adversarial));
        let end = scene_point(rng, exponent, adversarial);
        if start.x != end.x {
            return if rng.chance(1, 2) {
                (start, end)
            } else {
                (end, start)
            };
        }
    }
}

/// A proper crossing near `center`, or an endpoint if rounding made it improper.
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

/// A finite proper column event: an endpoint or a crossing at the scene scale.
fn column_event(rng: &mut Rng, exponent: i32, adversarial: bool) -> FillEvent {
    let center = scene_point(rng, exponent, adversarial);
    if rng.chance(1, 2) {
        FillEvent::Endpoint(center)
    } else {
        let size = exponent + rng.range_i32(-20, 0);
        crossing_near(rng, center, size)
    }
}

/// A nonvertical segment of a crossing, if it has one.
fn crossing_segment(rng: &mut Rng, event: FillEvent) -> Option<(Point, Point)> {
    match event {
        FillEvent::Crossing { a, b, c, d } => {
            let (start, end) = if rng.chance(1, 2) { (a, b) } else { (c, d) };
            (start.x != end.x).then_some((start, end))
        }
        FillEvent::Endpoint(_) => None,
    }
}

// ---------------------------------------------------------------------------------------------
// O1, T3.

/// A T3 case: a nonvertical edge and an endpoint column at, near or away from one of its
/// endpoint x coordinates.
fn t3_case(rng: &mut Rng, exponent: i32, adversarial: bool) -> (Point, Point, FillEvent) {
    let (mut start, end) = edge_through(rng, exponent, None, adversarial);
    if adversarial && rng.chance(1, 4) {
        // Signed zeros: a.y = -0.0 at a.x = +-0.0, with the column x at either zero.
        start = point(if rng.chance(1, 2) { 0.0 } else { -0.0 }, -0.0);
        if start.x == end.x {
            return t3_case(rng, exponent, adversarial);
        }
    }
    let base = if rng.chance(1, 2) { start.x } else { end.x };
    let x = match rng.below(8) {
        0..=3 => {
            if base == 0.0 && rng.chance(1, 2) {
                -base
            } else {
                base
            }
        }
        4 | 5 => ulps(
            base,
            if rng.chance(1, 2) { 1 } else { -1 } * rng.range_i32(1, 3),
        ),
        _ => coordinate(rng, exponent, adversarial),
    };
    let y = coordinate(rng, exponent, adversarial);
    (start, end, FillEvent::Endpoint(point(x, y)))
}

/// A second source for a T3 comparison: an endpoint at the vertex's y, an edge through the same
/// vertex at the same column, the column itself, or an unrelated value.
fn t3_partner(
    rng: &mut Rng,
    exponent: i32,
    start: Point,
    end: Point,
    column: FillEvent,
    adversarial: bool,
) -> SectionSource {
    let at = match column {
        FillEvent::Endpoint(at) => at,
        FillEvent::Crossing { .. } => unreachable!("T3 columns are endpoints"),
    };
    let vertex = if at.x == end.x { end } else { start };
    match rng.below(5) {
        0 => SectionSource::Endpoint(vertex.y),
        1 | 2 => {
            let (other_start, other_end) = edge_through(rng, exponent, Some(vertex), adversarial);
            SectionSource::edge(other_start, other_end, column)
        }
        3 => SectionSource::Column(column),
        _ => SectionSource::Endpoint(coordinate(rng, exponent, adversarial)),
    }
}

/// A positive finite tolerance.
fn tolerance(rng: &mut Rng) -> f64 {
    match rng.below(6) {
        0 => f64::from_bits(1),
        1 => pow2(-1021),
        _ => rng.scaled_in(-80, 20, false),
    }
}

/// O1 differential for T3.
pub(crate) fn t3_differential(seed: u64, random: u64, adversarial: u64) -> SlabTally {
    let mut rng = Rng::new(seed);
    let mut tally = SlabTally::default();
    reset_counters();
    for index in 0..random + adversarial {
        let adversarial = index >= random;
        let exponent = scene_exponent(&mut rng, adversarial);
        let (start, end, column) = t3_case(&mut rng, exponent, adversarial);
        let at = match column {
            FillEvent::Endpoint(at) => at,
            FillEvent::Crossing { .. } => unreachable!(),
        };
        tally.cases += 1;
        let source = SectionSource::edge(start, end, column);
        let eager = section_at_column(start, end, event_column(column).expect("finite endpoint"));
        let matches = at.x == start.x || at.x == end.x;
        tally.t3_matches += u64::from(matches);
        let context = || format!("edge {start:?} -> {end:?} at {column:?}: {source:?}");
        match source {
            SectionSource::EdgeEndpoint { value, .. } => {
                tally.t3_sources += 1;
                if !matches || exact_compare_section_f64(eager, value) != Ordering::Equal {
                    tally.fail(0, &context);
                }
            }
            _ => {
                if matches {
                    tally.fail(0, &context);
                }
            }
        }
        if source.build() != Ok(eager) {
            tally.fail(0, &context);
        }

        let partner = t3_partner(&mut rng, exponent, start, end, column, adversarial);
        let partner_section = partner.build().expect("finite partner");
        for (left, right, expected) in [
            (
                source,
                partner,
                exact_compare_sections(eager, partner_section),
            ),
            (
                partner,
                source,
                exact_compare_sections(partner_section, eager),
            ),
        ] {
            if compare_section_sources(left, right) != Ok(expected) {
                tally.fail(1, &|| format!("{left:?} vs {right:?}, exact {expected:?}"));
            }
        }

        let candidate = match (source.exact_value(), rng.below(3)) {
            (Some(value), 0) => value,
            (Some(value), 1) => ulps(value, rng.range_i32(-2, 2)),
            _ => rng.finite(exponent - 20, exponent + 4),
        };
        let tau = tolerance(&mut rng);
        let mut target = SectionTarget::from(source);
        let steps = (
            target.compare_f64(candidate),
            target.lower_half(candidate, tau),
            target.upper_half(candidate, tau),
        );
        let exact = (
            Ok(exact_compare_section_f64(eager, candidate)),
            Ok(exact_lower_half_predicate(eager, candidate, tau)),
            Ok(exact_upper_half_predicate(eager, candidate, tau)),
        );
        if steps != exact {
            tally.fail(2, &|| {
                format!("{source:?} at {candidate:?}, tau {tau:?}: {steps:?} vs {exact:?}")
            });
        }
    }
    tally.collect_counters();
    tally
}

// ---------------------------------------------------------------------------------------------
// O1, T5.

/// The two columns of a slab: independent events, adjacent binary64 columns, or a crossing
/// with an endpoint near it.
fn slab_columns(rng: &mut Rng, exponent: i32, adversarial: bool) -> (FillEvent, FillEvent) {
    let (left, right) = match rng.below(if adversarial { 4 } else { 3 }) {
        0 => (
            column_event(rng, exponent, adversarial),
            column_event(rng, exponent, adversarial),
        ),
        1 => {
            let center = scene_point(rng, exponent, adversarial);
            let next = point(center.x.next_up(), center.y);
            (FillEvent::Endpoint(center), FillEvent::Endpoint(next))
        }
        2 => (
            FillEvent::Endpoint(scene_point(rng, exponent, adversarial)),
            FillEvent::Endpoint(scene_point(rng, exponent, adversarial)),
        ),
        _ => {
            let center = scene_point(rng, exponent, adversarial);
            let size = exponent + rng.range_i32(-30, 0);
            let crossing = crossing_near(rng, center, size);
            let near = point(ulps(center.x, rng.range_i32(-3, 3)), center.y);
            (crossing, FillEvent::Endpoint(near))
        }
    };
    if rng.chance(1, 2) {
        (left, right)
    } else {
        (right, left)
    }
}

/// An active edge of a slab: random, through a vertex at the left column, a segment of a
/// crossing column, a copy of `other`, or `other` with one endpoint moved by an ulp.
fn slab_edge(
    rng: &mut Rng,
    exponent: i32,
    columns: (FillEvent, FillEvent),
    other: Option<(Point, Point)>,
    adversarial: bool,
) -> (Point, Point) {
    if !adversarial {
        return edge_through(rng, exponent, None, false);
    }
    let column = if rng.chance(1, 2) {
        columns.0
    } else {
        columns.1
    };
    match (rng.below(6), other) {
        (0, Some(edge)) => edge,
        (1, Some((start, end))) => {
            let moved = point(end.x, ulps(end.y, if rng.chance(1, 2) { 1 } else { -1 }));
            (start, moved)
        }
        (2 | 3, _) => match column {
            FillEvent::Endpoint(vertex) => edge_through(rng, exponent, Some(vertex), true),
            crossing => crossing_segment(rng, crossing)
                .unwrap_or_else(|| edge_through(rng, exponent, None, true)),
        },
        _ => edge_through(rng, exponent, None, true),
    }
}

/// Checks that a finite sample or section enclosure contains the exact value.
fn check_containment(
    tally: &mut SlabTally,
    enclosure: Interval,
    below_lo: bool,
    above_hi: bool,
    context: &dyn Fn() -> String,
) {
    if !enclosure.is_finite() {
        tally.unbounded += 1;
        return;
    }
    tally.enclosures += 1;
    if below_lo || above_hi {
        tally.fail(5, context);
    }
}

/// O1 differential for T5: two comparisons per slab sample, each operand a sentinel or (when
/// `prebuilt`) sometimes already built.
pub(crate) fn t5_differential(
    seed: u64,
    random: u64,
    adversarial: u64,
    prebuilt: bool,
) -> SlabTally {
    let mut rng = Rng::new(seed);
    let mut tally = SlabTally::default();
    reset_counters();
    for index in 0..random + adversarial {
        let adversarial = index >= random;
        let exponent = scene_exponent(&mut rng, adversarial);
        let columns = slab_columns(&mut rng, exponent, adversarial);
        let mut sample = SlabSample::new(columns.0, columns.1);
        let eager_column = sample.eager().expect("proper columns");

        let enclosure = sample.enclosure();
        check_containment(
            &mut tally,
            enclosure,
            enclosure.is_finite()
                && exact_compare_column_f64(eager_column, enclosure.lo) == Ordering::Less,
            enclosure.is_finite()
                && exact_compare_column_f64(eager_column, enclosure.hi) == Ordering::Greater,
            &|| format!("sample of {columns:?}: {enclosure:?}"),
        );

        for _ in 0..2 {
            tally.cases += 1;
            let left_edge = slab_edge(&mut rng, exponent, columns, None, adversarial);
            let right_edge = slab_edge(&mut rng, exponent, columns, Some(left_edge), adversarial);
            let eager_left = section_at_column(left_edge.0, left_edge.1, eager_column);
            let eager_right = section_at_column(right_edge.0, right_edge.1, eager_column);
            let expected = exact_compare_sections(eager_left, eager_right);
            for (edge, eager) in [(left_edge, eager_left), (right_edge, eager_right)] {
                let enclosure = sample.section_enclosure(edge.0, edge.1);
                check_containment(
                    &mut tally,
                    enclosure,
                    enclosure.is_finite()
                        && exact_compare_section_f64(eager, enclosure.lo) == Ordering::Less,
                    enclosure.is_finite()
                        && exact_compare_section_f64(eager, enclosure.hi) == Ordering::Greater,
                    &|| format!("section of {edge:?} at {columns:?}: {enclosure:?}"),
                );
            }
            let mut initial = |eager: ExactSection| {
                if prebuilt && rng.chance(1, 3) {
                    eager
                } else {
                    ExactSection::unbuilt()
                }
            };
            let mut left = initial(eager_left);
            let mut right = initial(eager_right);
            let unbuilt_before = u64::from(left.is_unbuilt()) + u64::from(right.is_unbuilt());
            let order =
                compare_slab_sections(&mut sample, left_edge, &mut left, right_edge, &mut right);
            if order != Ok(expected) {
                tally.fail(3, &|| {
                    format!(
                        "{left_edge:?} vs {right_edge:?} at {columns:?}: {order:?}, exact \
                         {expected:?}"
                    )
                });
            }
            for (section, eager) in [(left, eager_left), (right, eager_right)] {
                if !section.is_unbuilt() && section != eager {
                    tally.fail(4, &|| format!("stored section differs at {columns:?}"));
                }
            }
            let unbuilt_after = u64::from(left.is_unbuilt()) + u64::from(right.is_unbuilt());
            let built = unbuilt_before.saturating_sub(unbuilt_after);
            tally.built_comparisons += u64::from(built > 0);
            tally.built_sections += built;
        }
    }
    tally.collect_counters();
    tally
}

#[test]
fn b0r_o1_smoke_t3_endpoint_sections() {
    let tally = t3_differential(0x4230_5235_0001, 10_000, 2_000);
    println!("{}", report("B0R U5 O1 smoke T3", &tally));
    assert_eq!(tally.total_failures(), 0, "{tally:?}");
    assert_eq!(tally.t3_matches, tally.t3_sources, "{tally:?}");
    assert!(tally.t3_sources > 3_000, "{tally:?}");
}

#[test]
fn b0r_o1_smoke_t5_slab_sections() {
    let tally = t5_differential(0x4230_5235_0002, 10_000, 2_000, true);
    println!("{}", report("B0R U5 O1 smoke T5", &tally));
    assert_eq!(tally.total_failures(), 0, "{tally:?}");
    assert!(tally.enclosures > 10_000, "{tally:?}");
    let (decided, fallback) = tally.filters[1];
    assert!(decided > 5_000 && fallback > 500, "{tally:?}");
    assert!(tally.built_sections > 500, "{tally:?}");
}

// ---------------------------------------------------------------------------------------------
// O2 fixtures.

/// Runs `action` and returns its value with this thread's counts for `ids`.
fn counted<T, const K: usize>(
    ids: [FilterId; K],
    action: impl FnOnce() -> T,
) -> (T, [(u64, u64); K]) {
    reset_counters();
    let value = action();
    let result = ids.map(counts);
    reset_counters();
    (value, result)
}

/// O2: T3 with a.y = -0.0 and the column x at +0.0 and at -0.0. The identity applies (binary64
/// `==` treats the zeros as equal), its value -0.0 equals the exact section, comparisons and
/// embedding steps are decided without building, and an embedded coordinate is
/// `rank_finite(rank)`, so it is +0.0 in both versions.
#[test]
fn b0r_o2_t3_signed_zero_endpoint() {
    for (start_x, column_x) in [(0.0, 0.0), (0.0, -0.0), (-0.0, 0.0), (-0.0, -0.0)] {
        let start = point(start_x, -0.0);
        let end = point(2.0, 1.0);
        let column = FillEvent::Endpoint(point(column_x, 5.0));
        let (source, [(t3, _)]) = counted([FilterId::EndpointSection], || {
            SectionSource::edge(start, end, column)
        });
        assert_eq!(t3, 1);
        assert_eq!(
            source.exact_value().map(f64::to_bits),
            Some((-0.0f64).to_bits())
        );
        let eager = section_at_column(start, end, event_column(column).unwrap());
        assert_eq!(exact_compare_section_f64(eager, 0.0), Ordering::Equal);
        let (order, [(value, _), (_, fallback)]) =
            counted([FilterId::EndpointValue, FilterId::LazySection], || {
                compare_section_sources(source, SectionSource::Endpoint(0.0))
            });
        assert_eq!((order, value, fallback), (Ok(Ordering::Equal), 1, 0));
        let mut target = SectionTarget::from(source);
        assert_eq!(target.compare_f64(0.0), Ok(Ordering::Equal));
        assert_eq!(target.compare_f64(-0.0), Ok(Ordering::Equal));
        assert_eq!(target.compare_f64(f64::from_bits(1)), Ok(Ordering::Less));
    }

    // The tessellation keeps +0.0 output coordinates at such a vertex.
    let contour = [point(0.0, -0.0), point(2.0, 1.0), point(2.0, -1.0)];
    let mut workspace = RoundedFillWorkspace::new(LIMITS).unwrap();
    reset_counters();
    workspace
        .tessellate(&[&contour], LineFillRule::Nonzero, pow2(-20))
        .unwrap();
    assert!(counts(FilterId::EndpointSection).0 > 0);
    reset_counters();
    let output = workspace.output().unwrap();
    assert!(output
        .vertices
        .iter()
        .any(|vertex| vertex.x.to_bits() == 0 && vertex.y.to_bits() == 0));
}

/// O2: T3 is not applied when the column x differs from the endpoint x by one ulp, nor to a
/// vertical edge, a crossing column or non-finite data; the exact construction then decides.
#[test]
fn b0r_o2_t3_applies_only_at_equal_x() {
    let start = point(1.0, 0.25);
    let end = point(3.0, 1.0);
    for x in [1.0f64.next_up(), 1.0f64.next_down(), 3.0f64.next_up(), 2.0] {
        let source = SectionSource::edge(start, end, FillEvent::Endpoint(point(x, 0.0)));
        assert!(matches!(source, SectionSource::Edge { .. }), "{x}");
        assert_eq!(source.exact_value(), None);
    }
    let vertical = SectionSource::edge(start, point(1.0, 2.0), FillEvent::Endpoint(start));
    assert!(matches!(vertical, SectionSource::Edge { .. }));
    let crossing = FillEvent::Crossing {
        a: point(0.0, 0.0),
        b: point(2.0, 2.0),
        c: point(0.0, 2.0),
        d: point(2.0, 0.0),
    };
    let at_crossing = SectionSource::edge(point(0.0, 0.0), point(2.0, 2.0), crossing);
    assert!(matches!(at_crossing, SectionSource::Edge { .. }));
    let nonfinite = SectionSource::edge(start, end, FillEvent::Endpoint(point(1.0, f64::NAN)));
    assert!(matches!(nonfinite, SectionSource::Edge { .. }));
    for (column, value) in [(start, 0.25), (end, 1.0)] {
        let source = SectionSource::edge(start, end, FillEvent::Endpoint(column));
        assert_eq!(source.exact_value(), Some(value));
        assert_eq!(
            source.build(),
            Ok(section_at_column(
                start,
                end,
                event_column(FillEvent::Endpoint(column)).unwrap()
            ))
        );
    }
}

/// O2 decided controls for T3: the endpoint sections of two edges through a shared vertex at
/// that vertex's column, and an endpoint section against a value, decide by F0.5 without
/// building; embedding steps decide without the exact fallback.
#[test]
fn b0r_o2_t3_decided_controls() {
    let vertex = point(0.1, 0.7);
    let column = FillEvent::Endpoint(vertex);
    let first = SectionSource::edge(vertex, point(0.9, 0.3), column);
    let second = SectionSource::edge(point(-0.4, 0.2), vertex, column);
    let (order, [(value, value_fallback), (_, lazy_fallback)]) =
        counted([FilterId::EndpointValue, FilterId::LazySection], || {
            compare_section_sources(first, second)
        });
    assert_eq!(
        (order, value, value_fallback, lazy_fallback),
        (Ok(Ordering::Equal), 1, 0, 0)
    );
    let (order, [(value, _), (_, lazy_fallback)]) =
        counted([FilterId::EndpointValue, FilterId::LazySection], || {
            compare_section_sources(first, SectionSource::Endpoint(0.8))
        });
    assert_eq!((order, value, lazy_fallback), (Ok(Ordering::Less), 1, 0));
    let mut target = SectionTarget::from(first);
    let (steps, [(_, step_fallback), (_, half_fallback)]) =
        counted([FilterId::EmbedStep, FilterId::EmbedHalfStep], || {
            (
                target.compare_f64(0.7),
                target.lower_half(0.6, 0.5),
                target.lower_half(0.6, 0.1),
            )
        });
    assert_eq!(steps, (Ok(Ordering::Equal), Ok(true), Ok(false)));
    assert_eq!((step_fallback, half_fallback), (0, 0));
}

fn endpoint_slab(left: f64, right: f64) -> SlabSample {
    SlabSample::new(
        FillEvent::Endpoint(point(left, 0.0)),
        FillEvent::Endpoint(point(right, 0.0)),
    )
}

/// O2 decided controls for T5: well-separated active edges of an endpoint slab and of a slab
/// bounded by a crossing column are ordered by step 1; nothing is built, neither sample nor
/// section.
#[test]
fn b0r_o2_t5_decided_controls() {
    let crossing = FillEvent::Crossing {
        a: point(0.0, 0.0),
        b: point(3.0, 3.0),
        c: point(0.0, 3.0),
        d: point(3.0, 0.0),
    };
    for mut sample in [
        endpoint_slab(1.0, 2.0),
        SlabSample::new(crossing, FillEvent::Endpoint(point(2.0, 0.0))),
    ] {
        let low = (point(0.0, 0.0), point(4.0, 1.0));
        let high = (point(0.0, 5.0), point(4.0, 7.0));
        let mut left = ExactSection::unbuilt();
        let mut right = ExactSection::unbuilt();
        let (order, [(decided, fallback)]) = counted([FilterId::SlabSection], || {
            compare_slab_sections(&mut sample, high, &mut left, low, &mut right)
        });
        assert_eq!((order, decided, fallback), (Ok(Ordering::Greater), 1, 0));
        assert!(left.is_unbuilt() && right.is_unbuilt());
        assert!(!sample.is_built());
    }
}

/// O2: two edges through a shared vertex at the slab's left column with nearly equal slopes,
/// and two identical edges: step 1 cannot decide, both sentinels are resolved to the eager
/// sections, the sample is built once, and only then F0.6 or the exact routine decides. Two
/// sentinels of different edges never compare `Equal`.
#[test]
fn b0r_o2_t5_fallback_resolves_sentinels_first() {
    let vertex = point(1.0, 1.0);
    let steep = (vertex, point(3.0, 2.0));
    let slight = (vertex, point(3.0, 2.0f64.next_down()));
    let mut sample = endpoint_slab(1.0, 1.0f64.next_up());
    let eager_column = sample.eager().unwrap();
    let mut left = ExactSection::unbuilt();
    let mut right = ExactSection::unbuilt();
    let (order, [(decided, fallback)]) = counted([FilterId::SlabSection], || {
        compare_slab_sections(&mut sample, steep, &mut left, slight, &mut right)
    });
    assert_eq!((order, decided, fallback), (Ok(Ordering::Greater), 0, 1));
    assert!(sample.is_built());
    assert_eq!(left, section_at_column(steep.0, steep.1, eager_column));
    assert_eq!(right, section_at_column(slight.0, slight.1, eager_column));

    // Identical edges: both resolved, then F0.6 on the built representations.
    let mut left = ExactSection::unbuilt();
    let mut right = ExactSection::unbuilt();
    let (order, [(decided, fallback), (identity, _)]) = counted(
        [FilterId::SlabSection, FilterId::RepresentationIdentity],
        || compare_slab_sections(&mut sample, steep, &mut left, steep, &mut right),
    );
    assert_eq!(order, Ok(Ordering::Equal));
    assert_eq!((decided, fallback, identity), (0, 1, 1));
    assert!(!left.is_unbuilt() && left == right);

    // An already built operand is kept, and a sentinel beside it is resolved.
    let built = section_at_column(slight.0, slight.1, eager_column);
    let mut left = built;
    let mut right = ExactSection::unbuilt();
    let order = compare_slab_sections(&mut sample, slight, &mut left, steep, &mut right);
    assert_eq!(order, Ok(Ordering::Less));
    assert_eq!(left, built);
    assert_eq!(right, section_at_column(steep.0, steep.1, eager_column));
}

/// O2: the sentinel has zero weight, which no valid section has.
#[test]
fn b0r_o2_t5_sentinel_is_not_a_value() {
    let sentinel = ExactSection::unbuilt();
    assert!(sentinel.is_unbuilt());
    assert!(!endpoint_section(0.0).is_unbuilt());
    let column = event_column(FillEvent::Endpoint(point(0.5, 0.0))).unwrap();
    assert!(!section_at_column(point(0.0, 0.0), point(1.0, 0.0), column).is_unbuilt());
}

// ---------------------------------------------------------------------------------------------
// O8 seeded defects (8), (9) and (10).

/// O8 (8): T3 applied when the column x is one ulp from the endpoint x is detected by the T3
/// differential (identity values and comparisons disagree with the exact routine).
#[test]
fn b0r_o8_t3_one_ulp_is_detected() {
    let tally = with_fault(Fault::T3OneUlp, || {
        t3_differential(0x4230_5235_0008, 2_000, 500)
    });
    assert!(tally.failures[0] > 0, "{tally:?}");
    assert!(tally.failures[1] + tally.failures[2] > 0, "{tally:?}");
}

/// O8 (9): the sentinel read as a value (step 2 skipped) is detected by the T5 differential.
/// Every operand starts as a sentinel, so the defect compares two sentinels and never reaches
/// the exact routine with a zero weight.
#[test]
fn b0r_o8_t5_sentinel_read_as_value_is_detected() {
    let tally = with_fault(Fault::T5SentinelAsValue, || {
        t5_differential(0x4230_5235_0009, 2_000, 500, false)
    });
    assert!(tally.failures[3] > 0, "{tally:?}");
}

/// O8 (10): F0.6 applied to two sentinels is detected by the T5 differential and by the O10
/// shadow mode on the frozen fixture rows.
#[test]
fn b0r_o8_t5_sentinel_identity_is_detected() {
    let tally = with_fault(Fault::T5SentinelIdentity, || {
        t5_differential(0x4230_5235_000a, 2_000, 500, true)
    });
    assert!(tally.failures[3] > 0, "{tally:?}");

    let scenes = fixture_scenes();
    let shadow = with_fault(Fault::T5SentinelIdentity, || {
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
    assert!(shadow.mismatches > 0, "{shadow:?}");
}

// ---------------------------------------------------------------------------------------------
// O10 smoke for T3 and T5.

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

/// O10 smoke: the 202 frozen rows with shadow mode off and on give equal results, stats and
/// vertex bits, with zero shadow mismatches; T3 and both T5 outcomes occur.
#[test]
fn b0r_o10_smoke_slab_shadow() {
    let scenes = fixture_scenes();
    assert_eq!(scenes.len(), 202);
    let mut workspace = RoundedFillWorkspace::new(LIMITS).unwrap();
    take_shadow_tally();
    reset_counters();
    for (contours, rule, tau) in &scenes {
        let references: Vec<&[Point]> = contours.iter().map(Vec::as_slice).collect();
        let plain = workspace.tessellate(&references, *rule, *tau);
        let plain_stats = workspace.stats();
        let bits = |workspace: &RoundedFillWorkspace| -> Vec<u64> {
            workspace
                .output()
                .map(|output| {
                    output
                        .vertices
                        .iter()
                        .flat_map(|vertex| [vertex.x.to_bits(), vertex.y.to_bits()])
                        .collect()
                })
                .unwrap_or_default()
        };
        let plain_bits = bits(&workspace);
        let shadowed = with_shadow(|| workspace.tessellate(&references, *rule, *tau));
        assert_eq!(plain, shadowed);
        assert_eq!(plain_stats, workspace.stats());
        assert_eq!(plain_bits, bits(&workspace));
    }
    let tally = take_shadow_tally();
    let mut filters = SlabTally::default();
    filters.collect_counters();
    println!(
        "B0R U5 O10 smoke fixture rows: {tally:?}; {}",
        filters.rates()
    );
    assert_eq!(tally.mismatches, 0, "{tally:?}");
    assert!(tally.checks > 10_000, "{tally:?}");
    assert!(filters.filters[0].0 > 0, "{filters:?}");
    let (decided, fallback) = filters.filters[1];
    assert!(decided > 0 && fallback > 0, "{filters:?}");
}

// ---------------------------------------------------------------------------------------------
// Full-size oracles (release profile, `pnpm test:p3-fill-identity`).

/// Full O1 for T3 and T5: 10^7 random and 10^6 adversarial tuples each.
#[test]
#[ignore = "B0R O1 full size; release profile via pnpm test:p3-fill-identity"]
fn b0r_oracle_full_o1_slab_sections() {
    const RANDOM: u64 = 10_000_000;
    const ADVERSARIAL: u64 = 1_000_000;
    let threads = ORACLE_SHARDS;
    let start = Instant::now();
    let mut failures = 0;
    for (label, random, adversarial) in [("random", RANDOM, 0), ("adversarial", 0, ADVERSARIAL)] {
        let offset = if random == 0 { 0x80 } else { 0 };
        let mut t3 = SlabTally::default();
        for shard in parallel(threads, move |index| {
            t3_differential(
                0x4230_5235_1000 + index as u64 + offset,
                share(random, threads, index),
                share(adversarial, threads, index),
            )
        }) {
            t3.merge(shard);
        }
        println!("{}", report(&format!("B0R U5 O1 T3 {label}"), &t3));
        let mut t5 = SlabTally::default();
        for shard in parallel(threads, move |index| {
            t5_differential(
                0x4230_5235_2000 + index as u64 + offset,
                share(random, threads, index),
                share(adversarial, threads, index),
                true,
            )
        }) {
            t5.merge(shard);
        }
        println!("{}", report(&format!("B0R U5 O1 T5 {label}"), &t5));
        failures += t3.total_failures() + t5.total_failures();
        assert_eq!(t3.t3_matches, t3.t3_sources, "{t3:?}");
    }
    println!(
        "B0R U5 O1 slab sections ({threads} shards, {:.1} s)",
        start.elapsed().as_secs_f64()
    );
    assert_eq!(failures, 0);
}

/// T3 and T5 decided and fallback fractions on the O4 native corpora (B0 and
/// `p3-b0r-random/v1`) through every `CubicFillWorkspace` entry and the V2 cascade. Shadow
/// mode stays off here: `b0r_oracle_full_o10_tessellation_shadow` runs the same corpora with
/// it on, which now includes the T5 checks.
#[test]
#[ignore = "B0R T3/T5 corpus rates; release profile via pnpm test:p3-fill-identity"]
fn b0r_oracle_full_slab_corpus_rates() {
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
                        reset_counters();
                        for chunk in chunks.iter().skip(worker).step_by(threads) {
                            run_chunk(chunk);
                        }
                        let mut filters = SlabTally::default();
                        filters.collect_counters();
                        filters
                    })
                    .expect("spawn corpus worker")
            })
            .collect();
        let mut filters = SlabTally::default();
        for handle in handles {
            filters.merge(handle.join().expect("corpus worker"));
        }
        println!(
            "B0R U5 {label} corpus rates: {chunk_count} chunks; {}; {threads} threads, {:.1} s",
            filters.rates(),
            start.elapsed().as_secs_f64()
        );
        let (decided, fallback) = filters.filters[1];
        assert!(decided + fallback > 0, "{filters:?}");
    }
}
