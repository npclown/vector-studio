use core::cmp::Ordering;

use crate::fill_event_order::{exact_event_position, EventError, FillEvent};
use crate::fill_exact::{
    compare_ratios, line, multiply, Signed, COORDINATE_LIMBS, EVENT_COMPARISON_LIMBS,
    HOMOGENEOUS_LIMBS, LINE_LIMBS,
};
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

pub(crate) fn compare_columns(left: ExactColumn, right: ExactColumn) -> Ordering {
    compare_ratios::<
        HOMOGENEOUS_LIMBS,
        LINE_LIMBS,
        HOMOGENEOUS_LIMBS,
        LINE_LIMBS,
        EVENT_COMPARISON_LIMBS,
    >(left.numerator, left.weight, right.numerator, right.weight)
}

pub(crate) fn compare_column_f64(column: ExactColumn, value: f64) -> Ordering {
    compare_columns(
        column,
        ExactColumn {
            numerator: Signed::<COORDINATE_LIMBS>::from_finite(value).widen(),
            weight: Signed::one(),
        },
    )
}

pub(crate) fn compare_sections(left: ExactSection, right: ExactSection) -> Ordering {
    compare_ratios::<
        SECTION_NUMERATOR_LIMBS,
        SECTION_WEIGHT_LIMBS,
        SECTION_NUMERATOR_LIMBS,
        SECTION_WEIGHT_LIMBS,
        SECTION_COMPARISON_LIMBS,
    >(left.numerator, left.weight, right.numerator, right.weight)
}

pub(crate) fn compare_section_f64(section: ExactSection, value: f64) -> Ordering {
    let candidate = Signed::<COORDINATE_LIMBS>::from_finite(value);
    let product = multiply::<COORDINATE_LIMBS, SECTION_WEIGHT_LIMBS, SECTION_NUMERATOR_LIMBS>(
        candidate,
        section.weight,
    );
    section.numerator.add(product.negated()).cmp_zero()
}

pub(crate) fn within_half_budget(section: ExactSection, value: f64, tolerance: f64) -> bool {
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

pub(crate) fn lower_half_predicate(section: ExactSection, value: f64, tolerance: f64) -> bool {
    half_predicate(section, value, tolerance, false)
}

pub(crate) fn upper_half_predicate(section: ExactSection, value: f64, tolerance: f64) -> bool {
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
