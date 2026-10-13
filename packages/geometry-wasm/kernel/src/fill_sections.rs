use core::cmp::Ordering;

use crate::fill_event_order::{exact_event_position, x_enclosure, EventError, FillEvent};
use crate::fill_exact::{
    compare_ratios, line, multiply, Signed, COORDINATE_LIMBS, EVENT_COMPARISON_LIMBS,
    HOMOGENEOUS_LIMBS, LINE_LIMBS,
};
use crate::fill_filter::{self, compare_enclosures, enclose_ratio, FilterId, Interval};
use crate::geometry::Point;

pub(crate) const SECTION_NUMERATOR_LIMBS: usize = 132;
pub(crate) const SECTION_WEIGHT_LIMBS: usize = 99;
pub(crate) const SECTION_COMPARISON_LIMBS: usize = 231;

pub(crate) const MIN_FINITE_RANK: u64 = 0x0010_0000_0000_0000;
pub(crate) const ZERO_RANK: u64 = 0x7fff_ffff_ffff_ffff;
pub(crate) const MAX_FINITE_RANK: u64 = 0xffef_ffff_ffff_fffe;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ExactColumn {
    pub(crate) numerator: Signed<HOMOGENEOUS_LIMBS>,
    pub(crate) weight: Signed<LINE_LIMBS>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ExactSection {
    pub(crate) numerator: Signed<SECTION_NUMERATOR_LIMBS>,
    pub(crate) weight: Signed<SECTION_WEIGHT_LIMBS>,
}

pub(crate) fn event_column(event: FillEvent) -> Result<ExactColumn, EventError> {
    let position = exact_event_position(event)?;
    let (numerator, weight) = normalize(position.x, position.w);
    Ok(ExactColumn { numerator, weight })
}

pub(crate) fn endpoint_section(value: f64) -> ExactSection {
    ExactSection {
        numerator: Signed::<COORDINATE_LIMBS>::from_finite(value).widen(),
        weight: Signed::one(),
    }
}

pub(crate) fn column_as_section(column: ExactColumn) -> ExactSection {
    ExactSection {
        numerator: column.numerator.widen(),
        weight: column.weight.widen(),
    }
}

pub(crate) fn mediant(left: ExactColumn, right: ExactColumn) -> ExactColumn {
    let numerator = left.numerator.add(right.numerator);
    let weight = left.weight.add(right.weight);
    let (numerator, weight) = normalize(numerator, weight);
    ExactColumn { numerator, weight }
}

pub(crate) fn section_at_column(start: Point, end: Point, column: ExactColumn) -> ExactSection {
    let source = line(start, end);
    assert!(
        !source.y.is_zero(),
        "vertical edge has no nonvertical section"
    );
    let lx_x = multiply::<COORDINATE_LIMBS, HOMOGENEOUS_LIMBS, SECTION_NUMERATOR_LIMBS>(
        source.x,
        column.numerator,
    );
    let lz_w = multiply::<LINE_LIMBS, LINE_LIMBS, SECTION_NUMERATOR_LIMBS>(source.z, column.weight);
    let mut numerator = lx_x.add(lz_w).negated();
    let mut weight =
        multiply::<LINE_LIMBS, COORDINATE_LIMBS, SECTION_WEIGHT_LIMBS>(column.weight, source.y);
    assert!(!weight.is_zero(), "nonvertical section has nonzero weight");
    if weight.is_negative() {
        numerator = numerator.negated();
        weight = weight.negated();
    }
    let (numerator, weight) = normalize(numerator, weight);
    ExactSection { numerator, weight }
}

// B0R unit U4 (docs/plans/p3-b0r-kernel-performance-contract.md sections 3.4, 3.5, 3.7 and 5.2).
//
// Each crate comparison below first tries an exact identity (F0.6) or an interval filter on the
// ratio enclosures of section 3.4 (F2.6-F2.8), and otherwise runs its unchanged exact routine
// (`exact_*`) once. A filter decides only what R1-R3 prove, so every return value is unchanged.
// The source-level helpers after them (`SectionSource`, `SectionTarget`) are the lazy exact
// construction of T1 and the per-call enclosures of T2: they compare enclosures computed from
// the defining binary64 data and build an `ExactColumn` or `ExactSection` only on the exact
// fallback path, with the same pure function the eager code uses.

/// F0.6, then F2.6, then the unchanged exact comparison.
pub(crate) fn compare_columns(left: ExactColumn, right: ExactColumn) -> Ordering {
    let decision = if same_representation(&left.numerator, &right.numerator)
        && same_representation(&left.weight, &right.weight)
    {
        // F0.6: equal representations are equal values.
        fill_filter::record(FilterId::RepresentationIdentity, true);
        Some(Ordering::Equal)
    } else {
        let decision = compare_ratio_enclosures(
            &left.numerator,
            &left.weight,
            &right.numerator,
            &right.weight,
        );
        fill_filter::record(FilterId::ColumnRatio, decision.is_some());
        decision
    };
    let order = decision.unwrap_or_else(|| exact_compare_columns(left, right));
    #[cfg(test)]
    shadow(|| order == exact_compare_columns(left, right));
    order
}

/// F2.6, then the unchanged exact comparison.
pub(crate) fn compare_column_f64(column: ExactColumn, value: f64) -> Ordering {
    let decision = enclose_ratio(&column.numerator, &column.weight)
        .and_then(|enclosure| compare_enclosures(enclosure, Interval::point(value)));
    fill_filter::record(FilterId::ColumnRatio, decision.is_some());
    let order = decision.unwrap_or_else(|| exact_compare_column_f64(column, value));
    #[cfg(test)]
    shadow(|| order == exact_compare_column_f64(column, value));
    order
}

/// F0.6, then F2.7, then the unchanged exact comparison.
pub(crate) fn compare_sections(left: ExactSection, right: ExactSection) -> Ordering {
    let decision = if same_representation(&left.numerator, &right.numerator)
        && same_representation(&left.weight, &right.weight)
    {
        // F0.6: equal representations are equal values.
        fill_filter::record(FilterId::RepresentationIdentity, true);
        Some(Ordering::Equal)
    } else {
        let decision = compare_ratio_enclosures(
            &left.numerator,
            &left.weight,
            &right.numerator,
            &right.weight,
        );
        fill_filter::record(FilterId::SectionRatio, decision.is_some());
        decision
    };
    let order = decision.unwrap_or_else(|| exact_compare_sections(left, right));
    #[cfg(test)]
    shadow(|| order == exact_compare_sections(left, right));
    order
}

/// F2.7, then the unchanged exact comparison.
pub(crate) fn compare_section_f64(section: ExactSection, value: f64) -> Ordering {
    let decision = enclose_ratio(&section.numerator, &section.weight)
        .and_then(|enclosure| compare_enclosures(enclosure, Interval::point(value)));
    fill_filter::record(FilterId::SectionRatio, decision.is_some());
    let order = decision.unwrap_or_else(|| exact_compare_section_f64(section, value));
    #[cfg(test)]
    shadow(|| order == exact_compare_section_f64(section, value));
    order
}

/// F2.8, then the unchanged exact predicate |s - v| <= tau / 2.
pub(crate) fn within_half_budget(section: ExactSection, value: f64, tolerance: f64) -> bool {
    debug_assert!(tolerance.is_finite() && tolerance > 0.0);
    let decision = enclose_ratio(&section.numerator, &section.weight)
        .and_then(|enclosure| within_half_enclosed(enclosure, value, tolerance));
    fill_filter::record(FilterId::HalfBudget, decision.is_some());
    let result = decision.unwrap_or_else(|| exact_within_half_budget(section, value, tolerance));
    #[cfg(test)]
    shadow(|| result == exact_within_half_budget(section, value, tolerance));
    result
}

/// F2.8, then the unchanged exact predicate s - v <= tau / 2.
pub(crate) fn lower_half_predicate(section: ExactSection, value: f64, tolerance: f64) -> bool {
    filtered_half_predicate(section, value, tolerance, false)
}

/// F2.8, then the unchanged exact predicate v - s <= tau / 2.
pub(crate) fn upper_half_predicate(section: ExactSection, value: f64, tolerance: f64) -> bool {
    filtered_half_predicate(section, value, tolerance, true)
}

fn filtered_half_predicate(
    section: ExactSection,
    value: f64,
    tolerance: f64,
    reverse: bool,
) -> bool {
    debug_assert!(tolerance.is_finite() && tolerance > 0.0);
    let decision = enclose_ratio(&section.numerator, &section.weight)
        .and_then(|enclosure| half_enclosed(enclosure, value, tolerance, reverse));
    fill_filter::record(FilterId::HalfBudget, decision.is_some());
    let result = decision.unwrap_or_else(|| half_predicate(section, value, tolerance, reverse));
    #[cfg(test)]
    shadow(|| result == half_predicate(section, value, tolerance, reverse));
    result
}

// The unchanged exact routines: the fallback of every filter above and the O1/O10 reference.

pub(crate) fn exact_compare_columns(left: ExactColumn, right: ExactColumn) -> Ordering {
    compare_ratios::<
        HOMOGENEOUS_LIMBS,
        LINE_LIMBS,
        HOMOGENEOUS_LIMBS,
        LINE_LIMBS,
        EVENT_COMPARISON_LIMBS,
    >(left.numerator, left.weight, right.numerator, right.weight)
}

pub(crate) fn exact_compare_column_f64(column: ExactColumn, value: f64) -> Ordering {
    exact_compare_columns(
        column,
        ExactColumn {
            numerator: Signed::<COORDINATE_LIMBS>::from_finite(value).widen(),
            weight: Signed::one(),
        },
    )
}

pub(crate) fn exact_compare_sections(left: ExactSection, right: ExactSection) -> Ordering {
    compare_ratios::<
        SECTION_NUMERATOR_LIMBS,
        SECTION_WEIGHT_LIMBS,
        SECTION_NUMERATOR_LIMBS,
        SECTION_WEIGHT_LIMBS,
        SECTION_COMPARISON_LIMBS,
    >(left.numerator, left.weight, right.numerator, right.weight)
}

pub(crate) fn exact_compare_section_f64(section: ExactSection, value: f64) -> Ordering {
    let candidate = Signed::<COORDINATE_LIMBS>::from_finite(value);
    let product = multiply::<COORDINATE_LIMBS, SECTION_WEIGHT_LIMBS, SECTION_NUMERATOR_LIMBS>(
        candidate,
        section.weight,
    );
    section.numerator.add(product.negated()).cmp_zero()
}

pub(crate) fn exact_within_half_budget(section: ExactSection, value: f64, tolerance: f64) -> bool {
    debug_assert!(tolerance.is_finite() && tolerance > 0.0);
    let candidate = Signed::<COORDINATE_LIMBS>::from_finite(value);
    let product = multiply::<COORDINATE_LIMBS, SECTION_WEIGHT_LIMBS, SECTION_NUMERATOR_LIMBS>(
        candidate,
        section.weight,
    );
    let difference = section.numerator.add(product.negated()).absolute();
    let doubled = difference.add(difference);
    let tolerance = Signed::<COORDINATE_LIMBS>::from_finite(tolerance);
    let allowance = multiply::<COORDINATE_LIMBS, SECTION_WEIGHT_LIMBS, SECTION_NUMERATOR_LIMBS>(
        tolerance,
        section.weight,
    );
    doubled.compare_magnitude(allowance) != Ordering::Greater
}

pub(crate) fn exact_lower_half_predicate(
    section: ExactSection,
    value: f64,
    tolerance: f64,
) -> bool {
    half_predicate(section, value, tolerance, false)
}

pub(crate) fn exact_upper_half_predicate(
    section: ExactSection,
    value: f64,
    tolerance: f64,
) -> bool {
    half_predicate(section, value, tolerance, true)
}

fn half_predicate(section: ExactSection, value: f64, tolerance: f64, reverse: bool) -> bool {
    debug_assert!(tolerance.is_finite() && tolerance > 0.0);
    let candidate = Signed::<COORDINATE_LIMBS>::from_finite(value);
    let product = multiply::<COORDINATE_LIMBS, SECTION_WEIGHT_LIMBS, SECTION_NUMERATOR_LIMBS>(
        candidate,
        section.weight,
    );
    let difference = if reverse {
        product.add(section.numerator.negated())
    } else {
        section.numerator.add(product.negated())
    };
    if difference.cmp_zero() != Ordering::Greater {
        return true;
    }
    let doubled = difference.add(difference);
    let tolerance = Signed::<COORDINATE_LIMBS>::from_finite(tolerance);
    let allowance = multiply::<COORDINATE_LIMBS, SECTION_WEIGHT_LIMBS, SECTION_NUMERATOR_LIMBS>(
        tolerance,
        section.weight,
    );
    doubled.compare_magnitude(allowance) != Ordering::Greater
}

// Filter helpers.

/// F0.6: two representations with the same sign and the same used limbs denote the same
/// integer. Two zeros are equal whatever their sign flag. Unequal representations decide
/// nothing.
fn same_representation<const N: usize>(left: &Signed<N>, right: &Signed<N>) -> bool {
    if left.used == 0 || right.used == 0 {
        return left.used == right.used;
    }
    left.used == right.used
        && left.negative == right.negative
        && left.used <= N
        && left.limbs[..left.used] == right.limbs[..right.used]
}

/// F2.6 and F2.7: disjoint ratio enclosures (section 3.4) decide the order of two ratios.
///
/// Width, to first order: each enclosure of section 3.3 is within 2 ulps of its value on each
/// side, and the R2 quotient adds one rounding and one R1 ulp, so a ratio enclosure has a
/// relative half-width of about 8u. Two enclosures are disjoint, and the filter decides, when
/// the values' relative separation exceeds about 16u, inside the "above 32u" of section 3.7.
fn compare_ratio_enclosures<const LN: usize, const LW: usize, const RN: usize, const RW: usize>(
    left_numerator: &Signed<LN>,
    left_weight: &Signed<LW>,
    right_numerator: &Signed<RN>,
    right_weight: &Signed<RW>,
) -> Option<Ordering> {
    let left = enclose_ratio(left_numerator, left_weight)?;
    let right = enclose_ratio(right_numerator, right_weight)?;
    compare_enclosures(left, right)
}

/// The smallest tolerance whose half `tolerance * 0.5` is a normal number, so that halving
/// is exact (2^-1021).
const MIN_EXACT_HALVING: f64 = f64::from_bits(2u64 << 52);

/// F2.8 on an enclosure `section` of s: decides s - v <= tau / 2, or v - s <= tau / 2 when
/// `reverse`, or returns `None`.
///
/// For W > 0 and tau > 0 the exact routine's tests `N - vW <= 0` or `2(N - vW) <= TW` are
/// together equivalent to s - v <= tau / 2 (section 3.7), so the filter evaluates
/// d = (s - v) - tau / 2 in interval arithmetic (R1, R2) and decides on its sign (R3): d < 0
/// proves the predicate, d > 0 refutes it. `tau * 0.5` is used only when tau >= 2^-1021, where
/// it is exact; otherwise, and for every non-finite or non-positive tau, the filter is
/// undecided and the exact routine runs.
///
/// Width, to first order: the enclosure of s adds about 8u * |s| on each side, and the two
/// subtractions about 2u * (|s| + |v|) and 2u * (|s - v| + tau / 2), so the filter decides when
/// |(s - v) - tau / 2| > 32u * (|s| + |v|) + 4u * tau, the bound of section 3.7.
pub(crate) fn half_enclosed(
    section: Interval,
    value: f64,
    tolerance: f64,
    reverse: bool,
) -> Option<bool> {
    if !(MIN_EXACT_HALVING..=f64::MAX).contains(&tolerance) {
        return None;
    }
    let half = Interval::point(tolerance * 0.5);
    let candidate = Interval::point(value);
    let difference = if reverse {
        candidate.sub(section)
    } else {
        section.sub(candidate)
    };
    match difference.sub(half).sign()? {
        Ordering::Less => Some(true),
        Ordering::Greater => Some(false),
        Ordering::Equal => None,
    }
}

/// F2.8 for `within_half_budget`: |s - v| <= tau / 2 holds exactly when both s - v <= tau / 2
/// and v - s <= tau / 2 hold, so the two one-sided decisions combine without new rounding.
pub(crate) fn within_half_enclosed(section: Interval, value: f64, tolerance: f64) -> Option<bool> {
    match (
        half_enclosed(section, value, tolerance, false),
        half_enclosed(section, value, tolerance, true),
    ) {
        (Some(false), _) | (_, Some(false)) => Some(false),
        (Some(true), Some(true)) => Some(true),
        _ => None,
    }
}

/// F0.5: the exact order of two finite binary64 values, with signed zeros equal, which is the
/// order of their exact representations (`from_finite` maps both zeros to zero).
fn compare_finite(left: f64, right: f64) -> Ordering {
    if left < right {
        Ordering::Less
    } else if left > right {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

/// O10 shadow mode: records whether a decision equals the eager exact one (test builds only).
#[cfg(test)]
fn shadow(equal: impl FnOnce() -> bool) {
    if fill_filter::shadow_active() {
        fill_filter::shadow_check(equal());
    }
}

// T1, T2 and T4: lazy exact construction from the defining binary64 data.

/// T1 and T4: the order of the column of `event` and a binary64 value.
///
/// Precondition, met by every event in the rounded tessellation's column list: `event` passed
/// `compare_event_x`, so it is finite and, if a crossing, a proper crossing. For such events
/// the result equals `compare_column_f64(event_column(event)?, value)`; the column is built
/// only on the exact fallback path. An endpoint's column is (x, 1), which `normalize` leaves
/// unchanged, so F0.5 compares x itself; a crossing's x is enclosed from its four points as in
/// F2.5 (`x_enclosure`), and disjoint enclosures decide.
pub(crate) fn compare_column_source_f64(
    event: FillEvent,
    value: f64,
) -> Result<Ordering, EventError> {
    let decision = match event {
        FillEvent::Endpoint(point)
            if point.x.is_finite() && point.y.is_finite() && value.is_finite() =>
        {
            fill_filter::record(FilterId::EndpointValue, true);
            Some(compare_finite(point.x, value))
        }
        FillEvent::Endpoint(_) => None,
        FillEvent::Crossing { .. } => {
            let decision = compare_enclosures(x_enclosure(event), Interval::point(value));
            fill_filter::record(FilterId::LazyColumn, decision.is_some());
            decision
        }
    };
    let order = match decision {
        Some(order) => order,
        None => compare_column_f64(event_column(event)?, value),
    };
    #[cfg(test)]
    shadow(|| {
        event_column(event).map(|column| exact_compare_column_f64(column, value)) == Ok(order)
    });
    Ok(order)
}

/// The defining data of a section, from which T1 builds the `ExactSection` only on the exact
/// fallback path, with the same pure function as the eager code.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum SectionSource {
    /// `endpoint_section(value)`: a vertical edge's endpoint y.
    Endpoint(f64),
    /// `column_as_section(event_column(event))`: a column's x as a section.
    Column(FillEvent),
    /// `section_at_column(start, end, event_column(column))`: a nonvertical edge at a column.
    Edge {
        start: Point,
        end: Point,
        column: FillEvent,
    },
}

impl SectionSource {
    /// F0.5: the exact value when it is a binary64 endpoint coordinate. `endpoint_section(v)`
    /// is (v, 1), and an endpoint event's column is (x, 1), which `normalize` and
    /// `column_as_section` leave unchanged. Non-finite data gives `None`, so the eager
    /// construction runs and keeps its behaviour.
    pub(crate) fn exact_value(self) -> Option<f64> {
        match self {
            Self::Endpoint(value) if value.is_finite() => Some(value),
            Self::Column(FillEvent::Endpoint(point))
                if point.x.is_finite() && point.y.is_finite() =>
            {
                Some(point.x)
            }
            _ => None,
        }
    }

    /// An enclosure of the section's value (section 3.4's value(N, W)) from the defining
    /// binary64 data, by interval arithmetic (R1, R2); `UNDECIDED` when it cannot be formed.
    ///
    /// For an edge from a to b with b.x != a.x, `section_at_column` computes
    /// -(Lx * x + Lz) / Ly with the line coefficients Lx = a.y - b.y, Ly = b.x - a.x and
    /// Lz = a.x * b.y - a.y * b.x. Multiplying out shows that this is the same real number as
    /// a.y + (x - a.x) * (b.y - a.y) / (b.x - a.x), the line through a and b at x, which is
    /// evaluated here because it does not cancel the products of Lz. The column's x is the
    /// endpoint's exact coordinate or the F2.5 crossing enclosure. Soundness rests on R1-R3
    /// only; the run b.x - a.x must enclose a nonzero interval, or the result is undecided.
    ///
    /// Width, to first order: with the run, rise and x - a.x each within 2 ulps, the slope and
    /// product add 4 more and the final addition 2, so the enclosure's half-width is about
    /// 12u * (|a.y| + |x - a.x| * |slope|) plus |slope| times the half-width of x.
    pub(crate) fn enclosure(self) -> Interval {
        match self {
            Self::Endpoint(value) => Interval::point(value),
            Self::Column(event) => x_enclosure(event),
            Self::Edge { start, end, column } => {
                let x = x_enclosure(column);
                let ax = Interval::point(start.x);
                let ay = Interval::point(start.y);
                let rise = Interval::point(end.y).sub(ay);
                let run = Interval::point(end.x).sub(ax);
                x.sub(ax).mul(rise).div(run).add(ay)
            }
        }
    }

    /// The eager construction, unchanged: the value the pre-U4 code built before comparing.
    pub(crate) fn build(self) -> Result<ExactSection, EventError> {
        match self {
            Self::Endpoint(value) => Ok(endpoint_section(value)),
            Self::Column(event) => Ok(column_as_section(event_column(event)?)),
            Self::Edge { start, end, column } => {
                Ok(section_at_column(start, end, event_column(column)?))
            }
        }
    }
}

/// T1: the order of two sections given by their sources, with the precondition of
/// `compare_column_source_f64` on every column event. F0.5 compares two binary64 endpoint
/// values; otherwise disjoint source enclosures decide; otherwise both sections are built,
/// left first, and `compare_sections` (F0.6, F2.7, exact) decides.
pub(crate) fn compare_section_sources(
    left: SectionSource,
    right: SectionSource,
) -> Result<Ordering, EventError> {
    let decision = if let (Some(left), Some(right)) = (left.exact_value(), right.exact_value()) {
        fill_filter::record(FilterId::EndpointValue, true);
        Some(compare_finite(left, right))
    } else {
        let decision = compare_enclosures(left.enclosure(), right.enclosure());
        fill_filter::record(FilterId::LazySection, decision.is_some());
        decision
    };
    let order = match decision {
        Some(order) => order,
        None => compare_sections(left.build()?, right.build()?),
    };
    #[cfg(test)]
    shadow(|| {
        let eager = left.build().and_then(|left| {
            right
                .build()
                .map(|right| exact_compare_sections(left, right))
        });
        eager == Ok(order)
    });
    Ok(order)
}

/// T2: the target of one `embed_scalar` call. Its enclosure (F0.5 if exact, else from its
/// source, or section 3.4 for an already built section) is computed once, and each bisection or
/// window step compares the candidate against it. The exact section is built at most once per
/// target, and only when a step falls back. Nothing is cached across targets.
pub(crate) struct SectionTarget {
    /// `None` for a target made from an already built section.
    source: Option<SectionSource>,
    exact: Option<f64>,
    enclosure: Interval,
    built: Option<ExactSection>,
}

impl From<SectionSource> for SectionTarget {
    fn from(source: SectionSource) -> Self {
        let exact = source.exact_value();
        let enclosure = match exact {
            Some(value) => Interval::point(value),
            None => source.enclosure(),
        };
        Self {
            source: Some(source),
            exact,
            enclosure,
            built: None,
        }
    }
}

/// A target from an already built section; only the inline tests of `rounded_line_fill` call
/// `embed_scalar` with one, and they stay unchanged (O5).
#[cfg(test)]
impl From<ExactSection> for SectionTarget {
    fn from(section: ExactSection) -> Self {
        Self {
            source: None,
            exact: None,
            enclosure: enclose_ratio(&section.numerator, &section.weight)
                .unwrap_or(fill_filter::UNDECIDED),
            built: Some(section),
        }
    }
}

impl SectionTarget {
    fn section(&mut self) -> Result<ExactSection, EventError> {
        if let Some(section) = self.built {
            return Ok(section);
        }
        let section = match self.source {
            Some(source) => source.build()?,
            None => unreachable!("a target without a source is built"),
        };
        self.built = Some(section);
        Ok(section)
    }

    /// O10: the eager value, built afresh from the source.
    #[cfg(test)]
    fn eager(&self) -> Result<ExactSection, EventError> {
        match (self.source, self.built) {
            (Some(source), _) => source.build(),
            (None, Some(section)) => Ok(section),
            (None, None) => unreachable!("a target without a source is built"),
        }
    }

    /// `compare_section_f64(target, value)`.
    pub(crate) fn compare_f64(&mut self, value: f64) -> Result<Ordering, EventError> {
        let decision = match self.exact {
            Some(target) if value.is_finite() => {
                fill_filter::record(FilterId::EndpointValue, true);
                Some(compare_finite(target, value))
            }
            _ => {
                let decision = compare_enclosures(self.enclosure, Interval::point(value));
                fill_filter::record(FilterId::EmbedStep, decision.is_some());
                decision
            }
        };
        let order = match decision {
            Some(order) => order,
            None => compare_section_f64(self.section()?, value),
        };
        #[cfg(test)]
        shadow(|| {
            self.eager()
                .map(|section| exact_compare_section_f64(section, value))
                == Ok(order)
        });
        Ok(order)
    }

    /// `lower_half_predicate(target, value, tolerance)`.
    pub(crate) fn lower_half(&mut self, value: f64, tolerance: f64) -> Result<bool, EventError> {
        self.half(value, tolerance, false)
    }

    /// `upper_half_predicate(target, value, tolerance)`.
    pub(crate) fn upper_half(&mut self, value: f64, tolerance: f64) -> Result<bool, EventError> {
        self.half(value, tolerance, true)
    }

    fn half(&mut self, value: f64, tolerance: f64, reverse: bool) -> Result<bool, EventError> {
        let decision = half_enclosed(self.enclosure, value, tolerance, reverse);
        fill_filter::record(FilterId::EmbedHalfStep, decision.is_some());
        let result = match decision {
            Some(result) => result,
            None => filtered_half_predicate(self.section()?, value, tolerance, reverse),
        };
        #[cfg(test)]
        shadow(|| {
            self.eager()
                .map(|section| half_predicate(section, value, tolerance, reverse))
                == Ok(result)
        });
        Ok(result)
    }
}

pub(crate) fn finite_rank(value: f64) -> u64 {
    debug_assert!(value.is_finite());
    let bits = if value == 0.0 { 0 } else { value.to_bits() };
    if bits >> 63 != 0 {
        !bits
    } else {
        (bits ^ (1u64 << 63)) - 1
    }
}

pub(crate) fn rank_finite(rank: u64) -> f64 {
    debug_assert!((MIN_FINITE_RANK..=MAX_FINITE_RANK).contains(&rank));
    let bits = if rank < ZERO_RANK {
        !rank
    } else {
        rank.wrapping_add(1) ^ (1u64 << 63)
    };
    let value = f64::from_bits(bits);
    debug_assert!(value.is_finite());
    if value == 0.0 {
        0.0
    } else {
        value
    }
}

fn normalize<const N: usize, const D: usize>(
    numerator: Signed<N>,
    weight: Signed<D>,
) -> (Signed<N>, Signed<D>) {
    debug_assert!(!weight.is_negative() && !weight.is_zero());
    if numerator.is_zero() {
        return (Signed::zero(), Signed::one());
    }
    let shift = numerator.trailing_zeros().min(weight.trailing_zeros());
    (numerator.shift_right(shift), weight.shift_right(shift))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn positive<const N: usize>(words: &[(usize, u64)]) -> Signed<N> {
        let mut value = Signed::zero();
        for &(index, word) in words {
            value.limbs[index] = word;
            value.used = value.used.max(index + 1);
        }
        while value.used > 0 && value.limbs[value.used - 1] == 0 {
            value.used -= 1;
        }
        value
    }

    fn point(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    #[test]
    fn canonical_rank_has_one_zero_and_strict_finite_order() {
        let values = [
            -f64::MAX,
            -f64::MIN_POSITIVE,
            -f64::from_bits(1),
            -0.0,
            0.0,
            f64::from_bits(1),
            f64::MIN_POSITIVE,
            f64::MAX,
        ];
        assert_eq!(finite_rank(-0.0), ZERO_RANK);
        assert_eq!(finite_rank(0.0), ZERO_RANK);
        for pair in values.windows(2).filter(|pair| pair[0] != pair[1]) {
            assert!(finite_rank(pair[0]) < finite_rank(pair[1]));
        }
        for value in values {
            assert_eq!(
                rank_finite(finite_rank(value)),
                if value == 0.0 { 0.0 } else { value }
            );
        }
        assert_eq!(finite_rank(-f64::MAX), MIN_FINITE_RANK);
        assert_eq!(finite_rank(f64::MAX), MAX_FINITE_RANK);
    }

    #[test]
    fn mediant_is_strictly_between_adjacent_floats() {
        let left = event_column(FillEvent::Endpoint(point(1.0, 0.0))).unwrap();
        let right = event_column(FillEvent::Endpoint(point(1.0f64.next_up(), 0.0))).unwrap();
        let sample = mediant(left, right);
        assert_eq!(compare_columns(left, sample), Ordering::Less);
        assert_eq!(compare_columns(sample, right), Ordering::Less);
    }

    #[test]
    fn sections_use_exact_column_not_rounded_evaluation() {
        let one_third = section_at_column(
            point(0.0, 0.0),
            point(3.0, 1.0),
            event_column(FillEvent::Endpoint(point(1.0, 0.0))).unwrap(),
        );
        assert_eq!(compare_section_f64(one_third, 1.0 / 3.0), Ordering::Greater);
        assert!(within_half_budget(one_third, 1.0 / 3.0, f64::EPSILON));
        assert!(!within_half_budget(one_third, 0.0, f64::EPSILON));
    }

    #[test]
    fn endpoint_sections_pin_subnormal_and_signed_zero() {
        let minimum = f64::from_bits(1);
        assert_eq!(
            compare_section_f64(endpoint_section(minimum), minimum),
            Ordering::Equal
        );
        assert_eq!(
            compare_section_f64(endpoint_section(-0.0), 0.0),
            Ordering::Equal
        );
    }

    #[test]
    fn normalization_is_literal_across_zero_sign_and_word_boundaries() {
        let (zero, unit) = normalize(
            Signed::<SECTION_NUMERATOR_LIMBS>::zero(),
            positive::<SECTION_WEIGHT_LIMBS>(&[(2, 8)]),
        );
        assert_eq!(zero, Signed::zero());
        assert_eq!(unit, Signed::one());

        let numerator = positive::<SECTION_NUMERATOR_LIMBS>(&[(1, 8), (2, 16)]).negated();
        let denominator = positive::<SECTION_WEIGHT_LIMBS>(&[(1, 4), (2, 8)]);
        let (numerator, denominator) = normalize(numerator, denominator);
        assert_eq!(
            numerator,
            positive::<SECTION_NUMERATOR_LIMBS>(&[(0, 2), (1, 4)]).negated()
        );
        assert_eq!(
            denominator,
            positive::<SECTION_WEIGHT_LIMBS>(&[(0, 1), (1, 2)])
        );
        assert!(!denominator.is_negative());

        let odd_numerator = positive::<SECTION_NUMERATOR_LIMBS>(&[(0, 3)]);
        let odd_weight = positive::<SECTION_WEIGHT_LIMBS>(&[(0, 5)]);
        assert_eq!(
            normalize(odd_numerator, odd_weight),
            (odd_numerator, odd_weight)
        );
    }

    #[test]
    fn half_budget_accepts_the_inclusive_boundary_and_rejects_stricter_tolerance() {
        let half = ExactSection {
            numerator: Signed::<COORDINATE_LIMBS>::from_finite(1.0).widen(),
            weight: positive(&[(0, 2)]),
        };
        assert!(within_half_budget(half, 0.0, 1.0));
        assert!(lower_half_predicate(half, 0.0, 1.0));
        assert!(upper_half_predicate(half, 1.0, 1.0));
        assert!(!within_half_budget(half, 0.0, 1.0f64.next_down()));
        assert!(!lower_half_predicate(half, 0.0, 1.0f64.next_down()));
        assert!(!upper_half_predicate(half, 1.0, 1.0f64.next_down()));

        assert!(lower_half_predicate(half, f64::MAX, f64::from_bits(1)));
        assert!(upper_half_predicate(half, -f64::MAX, f64::from_bits(1)));
    }

    #[test]
    fn extreme_crossing_columns_and_sections_preserve_independent_identities() {
        let minimum = f64::from_bits(1);
        let crossing = event_column(FillEvent::Crossing {
            a: point(-f64::MAX, minimum),
            b: point(f64::MAX, minimum),
            c: point(minimum, -f64::MAX),
            d: point(minimum, f64::MAX),
        })
        .unwrap();
        assert_eq!(compare_column_f64(crossing, minimum), Ordering::Equal);

        let negative_endpoint = point(-f64::MAX, -f64::MAX);
        let positive_endpoint = point(f64::MAX, f64::MAX);
        let expected = column_as_section(crossing);
        assert_eq!(
            compare_sections(
                section_at_column(negative_endpoint, positive_endpoint, crossing),
                expected,
            ),
            Ordering::Equal
        );
        assert_eq!(
            compare_sections(
                section_at_column(positive_endpoint, negative_endpoint, crossing),
                expected,
            ),
            Ordering::Equal
        );

        let left = event_column(FillEvent::Endpoint(point(-f64::MAX, 0.0))).unwrap();
        let right = event_column(FillEvent::Endpoint(point(f64::MAX, 0.0))).unwrap();
        let center = mediant(left, right);
        assert_eq!(compare_column_f64(center, 0.0), Ordering::Equal);
        assert_eq!(
            compare_sections(
                section_at_column(negative_endpoint, positive_endpoint, center),
                endpoint_section(0.0),
            ),
            Ordering::Equal
        );

        let half_minimum = ExactSection {
            numerator: positive(&[(0, 1)]),
            weight: positive(&[(0, 2)]),
        };
        assert!(within_half_budget(half_minimum, 0.0, minimum));
        assert!(within_half_budget(half_minimum, minimum, minimum));
        assert!(lower_half_predicate(half_minimum, 0.0, minimum));
        assert!(upper_half_predicate(half_minimum, minimum, minimum));
    }
}
