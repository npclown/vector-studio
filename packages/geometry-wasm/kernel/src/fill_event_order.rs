use core::cmp::Ordering;

use crate::fill_predicates::{segment_relation, SegmentRelation};
use crate::geometry::Point;

// Magnitudes are respectively below 2^2099, 2^4199, 2^6297 and
// 2^10497. The final 10560-bit width retains 63 spare high bits.
const COORDINATE_LIMBS: usize = 33;
const LINE_LIMBS: usize = 66;
const HOMOGENEOUS_LIMBS: usize = 99;
const COMPARISON_LIMBS: usize = 165;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum FillEvent {
    Endpoint(Point),
    Crossing {
        a: Point,
        b: Point,
        c: Point,
        d: Point,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EventError {
    NonFinite,
    NotProperCrossing,
}

pub(crate) fn compare_event_positions(
    left: FillEvent,
    right: FillEvent,
) -> Result<Ordering, EventError> {
    validate_event(left)?;
    validate_event(right)?;

    let left = event_position(left)?;
    let right = event_position(right)?;
    let x_order = compare_ratios(left.x, left.w, right.x, right.w);
    if x_order != Ordering::Equal {
        return Ok(x_order);
    }
    Ok(compare_ratios(left.y, left.w, right.y, right.w))
}

pub(crate) fn compare_event_x(left: FillEvent, right: FillEvent) -> Result<Ordering, EventError> {
    validate_event(left)?;
    validate_event(right)?;
    let left = event_position(left)?;
    let right = event_position(right)?;
    Ok(compare_ratios(left.x, left.w, right.x, right.w))
}

fn validate_event(event: FillEvent) -> Result<(), EventError> {
    let finite = match event {
        FillEvent::Endpoint(point) => point_is_finite(point),
        FillEvent::Crossing { a, b, c, d } => {
            point_is_finite(a) && point_is_finite(b) && point_is_finite(c) && point_is_finite(d)
        }
    };
    finite.then_some(()).ok_or(EventError::NonFinite)
}

fn point_is_finite(point: Point) -> bool {
    point.x.is_finite() && point.y.is_finite()
}

#[derive(Clone, Copy)]
struct EventPosition {
    x: Signed<HOMOGENEOUS_LIMBS>,
    y: Signed<HOMOGENEOUS_LIMBS>,
    w: Signed<LINE_LIMBS>,
}

fn event_position(event: FillEvent) -> Result<EventPosition, EventError> {
    match event {
        FillEvent::Endpoint(point) => Ok(EventPosition {
            x: Signed::<COORDINATE_LIMBS>::from_finite(point.x).widen(),
            y: Signed::<COORDINATE_LIMBS>::from_finite(point.y).widen(),
            w: Signed::one(),
        }),
        FillEvent::Crossing { a, b, c, d } => {
            if segment_relation(a, b, c, d).map_err(|_| EventError::NonFinite)?
                != SegmentRelation::ProperCrossing
            {
                return Err(EventError::NotProperCrossing);
            }
            Ok(crossing_position(a, b, c, d))
        }
    }
}

#[derive(Clone, Copy)]
struct Line {
    x: Signed<COORDINATE_LIMBS>,
    y: Signed<COORDINATE_LIMBS>,
    z: Signed<LINE_LIMBS>,
}

fn line(start: Point, end: Point) -> Line {
    let ax = Signed::<COORDINATE_LIMBS>::from_finite(start.x);
    let ay = Signed::<COORDINATE_LIMBS>::from_finite(start.y);
    let bx = Signed::<COORDINATE_LIMBS>::from_finite(end.x);
    let by = Signed::<COORDINATE_LIMBS>::from_finite(end.y);
    Line {
        x: ay.add(by.negated()),
        y: bx.add(ax.negated()),
        z: multiply::<COORDINATE_LIMBS, COORDINATE_LIMBS, LINE_LIMBS>(ax, by)
            .add(multiply::<COORDINATE_LIMBS, COORDINATE_LIMBS, LINE_LIMBS>(ay, bx).negated()),
    }
}

fn crossing_position(a: Point, b: Point, c: Point, d: Point) -> EventPosition {
    let left = line(a, b);
    let right = line(c, d);
    let mut x = multiply::<COORDINATE_LIMBS, LINE_LIMBS, HOMOGENEOUS_LIMBS>(left.y, right.z).add(
        multiply::<LINE_LIMBS, COORDINATE_LIMBS, HOMOGENEOUS_LIMBS>(left.z, right.y).negated(),
    );
    let mut y = multiply::<LINE_LIMBS, COORDINATE_LIMBS, HOMOGENEOUS_LIMBS>(left.z, right.x).add(
        multiply::<COORDINATE_LIMBS, LINE_LIMBS, HOMOGENEOUS_LIMBS>(left.x, right.z).negated(),
    );
    let mut w = multiply::<COORDINATE_LIMBS, COORDINATE_LIMBS, LINE_LIMBS>(left.x, right.y)
        .add(multiply::<COORDINATE_LIMBS, COORDINATE_LIMBS, LINE_LIMBS>(left.y, right.x).negated());
    assert!(
        !w.is_zero(),
        "proper crossing has nonzero homogeneous weight"
    );
    if w.negative {
        x = x.negated();
        y = y.negated();
        w = w.negated();
    }
    EventPosition { x, y, w }
}

fn compare_ratios(
    left_numerator: Signed<HOMOGENEOUS_LIMBS>,
    left_weight: Signed<LINE_LIMBS>,
    right_numerator: Signed<HOMOGENEOUS_LIMBS>,
    right_weight: Signed<LINE_LIMBS>,
) -> Ordering {
    debug_assert!(!left_weight.negative && !left_weight.is_zero());
    debug_assert!(!right_weight.negative && !right_weight.is_zero());
    let left =
        multiply::<HOMOGENEOUS_LIMBS, LINE_LIMBS, COMPARISON_LIMBS>(left_numerator, right_weight);
    let right =
        multiply::<HOMOGENEOUS_LIMBS, LINE_LIMBS, COMPARISON_LIMBS>(right_numerator, left_weight);
    left.add(right.negated()).cmp_zero()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Signed<const N: usize> {
    negative: bool,
    limbs: [u64; N],
    used: usize,
}

impl<const N: usize> Signed<N> {
    fn zero() -> Self {
        Self {
            negative: false,
            limbs: [0; N],
            used: 0,
        }
    }

    fn one() -> Self {
        let mut value = Self::zero();
        assert!(N > 0, "integer capacity overflow");
        value.limbs[0] = 1;
        value.used = 1;
        value
    }

    fn from_finite(value: f64) -> Self {
        let bits = value.to_bits();
        let raw_exponent = ((bits >> 52) & 0x7ff) as usize;
        debug_assert!(raw_exponent != 0x7ff);
        let fraction = bits & ((1u64 << 52) - 1);
        let (significand, shift) = if raw_exponent == 0 {
            (fraction, 0)
        } else {
            ((1u64 << 52) | fraction, raw_exponent - 1)
        };
        if significand == 0 {
            return Self::zero();
        }

        let mut result = Self::zero();
        result.negative = bits >> 63 != 0;
        let limb = shift / 64;
        let offset = shift % 64;
        assert!(limb < N, "decoded coordinate capacity overflow");
        result.limbs[limb] = significand << offset;
        result.used = limb + 1;
        if offset != 0 {
            let high = significand >> (64 - offset);
            if high != 0 {
                assert!(limb + 1 < N, "decoded coordinate capacity overflow");
                result.limbs[limb + 1] = high;
                result.used = limb + 2;
            }
        }
        result
    }

    fn is_zero(self) -> bool {
        self.used == 0
    }

    fn negated(mut self) -> Self {
        if !self.is_zero() {
            self.negative = !self.negative;
        }
        self
    }

    fn widen<const M: usize>(self) -> Signed<M> {
        assert!(self.used <= M, "integer widening capacity overflow");
        let mut result = Signed::<M>::zero();
        result.negative = self.negative;
        result.used = self.used;
        result.limbs[..self.used].copy_from_slice(&self.limbs[..self.used]);
        result
    }

    fn add(self, other: Self) -> Self {
        if self.is_zero() {
            return other;
        }
        if other.is_zero() {
            return self;
        }
        if self.negative == other.negative {
            return add_magnitudes(self, other, self.negative);
        }
        match self.compare_magnitude(other) {
            Ordering::Greater => subtract_magnitudes(self, other, self.negative),
            Ordering::Less => subtract_magnitudes(other, self, other.negative),
            Ordering::Equal => Self::zero(),
        }
    }

    fn compare_magnitude(self, other: Self) -> Ordering {
        match self.used.cmp(&other.used) {
            Ordering::Equal => {
                for index in (0..self.used).rev() {
                    match self.limbs[index].cmp(&other.limbs[index]) {
                        Ordering::Equal => {}
                        ordering => return ordering,
                    }
                }
                Ordering::Equal
            }
            ordering => ordering,
        }
    }

    fn cmp_zero(self) -> Ordering {
        if self.is_zero() {
            Ordering::Equal
        } else if self.negative {
            Ordering::Less
        } else {
            Ordering::Greater
        }
    }

    fn trim(&mut self) {
        while self.used > 0 && self.limbs[self.used - 1] == 0 {
            self.used -= 1;
        }
        if self.used == 0 {
            self.negative = false;
        }
    }
}

fn add_magnitudes<const N: usize>(left: Signed<N>, right: Signed<N>, negative: bool) -> Signed<N> {
    let mut result = Signed::<N>::zero();
    result.negative = negative;
    let length = left.used.max(right.used);
    let mut carry = false;
    for index in 0..length {
        let (partial, first_carry) = left.limbs[index].overflowing_add(right.limbs[index]);
        let (sum, second_carry) = partial.overflowing_add(u64::from(carry));
        result.limbs[index] = sum;
        carry = first_carry || second_carry;
    }
    result.used = length;
    if carry {
        assert!(result.used < N, "integer addition capacity overflow");
        result.limbs[result.used] = 1;
        result.used += 1;
    }
    result
}

fn subtract_magnitudes<const N: usize>(
    larger: Signed<N>,
    smaller: Signed<N>,
    negative: bool,
) -> Signed<N> {
    debug_assert!(larger.compare_magnitude(smaller) != Ordering::Less);
    let mut result = Signed::<N>::zero();
    result.negative = negative;
    result.used = larger.used;
    let mut borrow = false;
    for index in 0..larger.used {
        let (partial, first_borrow) = larger.limbs[index].overflowing_sub(smaller.limbs[index]);
        let (difference, second_borrow) = partial.overflowing_sub(u64::from(borrow));
        result.limbs[index] = difference;
        borrow = first_borrow || second_borrow;
    }
    assert!(!borrow, "integer subtraction borrow escaped");
    result.trim();
    result
}

fn multiply<const A: usize, const B: usize, const OUT: usize>(
    left: Signed<A>,
    right: Signed<B>,
) -> Signed<OUT> {
    if left.is_zero() || right.is_zero() {
        return Signed::zero();
    }
    assert!(
        left.used + right.used <= OUT + 1,
        "integer product capacity overflow"
    );
    let mut result = Signed::<OUT>::zero();
    result.negative = left.negative ^ right.negative;
    for left_index in 0..left.used {
        let mut carry = 0u128;
        for right_index in 0..right.used {
            let output_index = left_index + right_index;
            assert!(output_index < OUT, "integer product capacity overflow");
            let value = u128::from(left.limbs[left_index]) * u128::from(right.limbs[right_index])
                + u128::from(result.limbs[output_index])
                + carry;
            result.limbs[output_index] = value as u64;
            carry = value >> 64;
        }
        let mut output_index = left_index + right.used;
        while carry != 0 {
            assert!(output_index < OUT, "integer product capacity overflow");
            let value = u128::from(result.limbs[output_index]) + carry;
            result.limbs[output_index] = value as u64;
            carry = value >> 64;
            output_index += 1;
        }
    }
    result.used = OUT;
    result.trim();
    result
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
        value.trim();
        value
    }

    #[test]
    fn decode_canonicalizes_zero_and_covers_boundary_shifts() {
        assert_eq!(
            Signed::<COORDINATE_LIMBS>::from_finite(-0.0),
            Signed::zero()
        );
        assert_eq!(
            Signed::<COORDINATE_LIMBS>::from_finite(f64::from_bits(1)),
            positive(&[(0, 1)])
        );
        assert_eq!(
            Signed::<COORDINATE_LIMBS>::from_finite(f64::from_bits(64u64 << 52)),
            positive(&[(1, 1u64 << 51)])
        );
        assert_eq!(
            Signed::<COORDINATE_LIMBS>::from_finite(f64::from_bits(65u64 << 52)),
            positive(&[(1, 1u64 << 52)])
        );
        let one = Signed::<COORDINATE_LIMBS>::from_finite(1.0);
        assert_eq!(one.used, 17);
        assert_eq!(one.limbs[16], 1u64 << 50);
        let maximum = Signed::<COORDINATE_LIMBS>::from_finite(f64::MAX);
        assert_eq!(maximum.used, COORDINATE_LIMBS);
        assert!(maximum.limbs[..31].iter().all(|word| *word == 0));
        assert_eq!(maximum.limbs[31], 0xe000_0000_0000_0000);
        assert_eq!(maximum.limbs[32], 0x0003_ffff_ffff_ffff);
    }

    #[test]
    fn signed_addition_propagates_carry_borrow_and_canonicalizes_zero() {
        let maximum_word = positive::<COORDINATE_LIMBS>(&[(0, u64::MAX), (1, u64::MAX)]);
        let one = positive::<COORDINATE_LIMBS>(&[(0, 1)]);
        assert_eq!(maximum_word.add(one), positive(&[(2, 1)]));
        assert_eq!(
            positive::<COORDINATE_LIMBS>(&[(2, 1)]).add(one.negated()),
            maximum_word
        );
        assert_eq!(one.add(one.negated()), Signed::zero());
        assert_eq!(one.negated().add(one.negated()).cmp_zero(), Ordering::Less);
    }

    #[test]
    fn widening_zero_fills_and_high_products_reach_expected_limbs() {
        let coordinate = positive::<COORDINATE_LIMBS>(&[(COORDINATE_LIMBS - 1, 1)]);
        let widened = coordinate.widen::<LINE_LIMBS>();
        assert_eq!(widened.used, COORDINATE_LIMBS);
        assert_eq!(widened.limbs[COORDINATE_LIMBS - 1], 1);
        assert!(widened.limbs[COORDINATE_LIMBS..]
            .iter()
            .all(|word| *word == 0));

        let line = positive::<LINE_LIMBS>(&[(LINE_LIMBS - 1, 1)]);
        let homogeneous =
            multiply::<COORDINATE_LIMBS, LINE_LIMBS, HOMOGENEOUS_LIMBS>(coordinate, line);
        assert_eq!(homogeneous, positive(&[(97, 1)]));
        let weight = positive::<LINE_LIMBS>(&[(LINE_LIMBS - 1, 1)]);
        let comparison = multiply::<HOMOGENEOUS_LIMBS, LINE_LIMBS, COMPARISON_LIMBS>(
            positive::<HOMOGENEOUS_LIMBS>(&[(HOMOGENEOUS_LIMBS - 1, 1)]),
            weight,
        );
        assert_eq!(comparison, positive(&[(163, 1)]));

        let top_comparison = multiply::<HOMOGENEOUS_LIMBS, LINE_LIMBS, COMPARISON_LIMBS>(
            positive::<HOMOGENEOUS_LIMBS>(&[(HOMOGENEOUS_LIMBS - 1, 1u64 << 63)]),
            positive::<LINE_LIMBS>(&[(LINE_LIMBS - 1, 1u64 << 63)]),
        );
        assert_eq!(
            top_comparison,
            positive(&[(COMPARISON_LIMBS - 1, 1u64 << 62)])
        );
    }

    #[test]
    fn dense_products_preserve_words_sign_and_canonical_zero() {
        let dense = positive::<COORDINATE_LIMBS>(&[(0, u64::MAX), (1, u64::MAX)]);
        let square = multiply::<COORDINATE_LIMBS, COORDINATE_LIMBS, LINE_LIMBS>(dense, dense);
        assert_eq!(
            square,
            positive(&[(0, 1), (2, u64::MAX - 1), (3, u64::MAX)])
        );
        let negative =
            multiply::<COORDINATE_LIMBS, COORDINATE_LIMBS, LINE_LIMBS>(dense.negated(), dense);
        assert!(negative.negative);
        assert_eq!(negative.negated(), square);
        assert_eq!(
            multiply::<COORDINATE_LIMBS, COORDINATE_LIMBS, LINE_LIMBS>(Signed::zero(), dense,),
            Signed::zero()
        );
    }

    #[test]
    #[should_panic(expected = "integer addition capacity overflow")]
    fn bounded_addition_overflow_asserts() {
        let maximum = Signed::<COORDINATE_LIMBS> {
            negative: false,
            limbs: [u64::MAX; COORDINATE_LIMBS],
            used: COORDINATE_LIMBS,
        };
        maximum.add(positive(&[(0, 1)]));
    }

    #[test]
    #[should_panic(expected = "integer product capacity overflow")]
    fn bounded_product_overflow_asserts() {
        multiply::<COORDINATE_LIMBS, COORDINATE_LIMBS, COORDINATE_LIMBS>(
            positive(&[(16, u64::MAX)]),
            positive(&[(16, u64::MAX)]),
        );
    }
}
