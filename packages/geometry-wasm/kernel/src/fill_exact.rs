use core::cmp::Ordering;

use crate::geometry::Point;

pub(crate) const COORDINATE_LIMBS: usize = 33;
pub(crate) const LINE_LIMBS: usize = 66;
pub(crate) const HOMOGENEOUS_LIMBS: usize = 99;
pub(crate) const EVENT_COMPARISON_LIMBS: usize = 165;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Signed<const N: usize> {
    pub(crate) negative: bool,
    pub(crate) limbs: [u64; N],
    pub(crate) used: usize,
}

impl<const N: usize> Signed<N> {
    pub(crate) fn zero() -> Self {
        Self {
            negative: false,
            limbs: [0; N],
            used: 0,
        }
    }

    pub(crate) fn one() -> Self {
        let mut value = Self::zero();
        assert!(N > 0, "integer capacity overflow");
        value.limbs[0] = 1;
        value.used = 1;
        value
    }

    pub(crate) fn from_finite(value: f64) -> Self {
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

    pub(crate) fn is_zero(self) -> bool {
        self.used == 0
    }

    pub(crate) fn is_negative(self) -> bool {
        self.negative
    }

    pub(crate) fn negated(mut self) -> Self {
        if !self.is_zero() {
            self.negative = !self.negative;
        }
        self
    }

    pub(crate) fn absolute(mut self) -> Self {
        self.negative = false;
        self
    }

    pub(crate) fn widen<const M: usize>(self) -> Signed<M> {
        assert!(self.used <= M, "integer widening capacity overflow");
        let mut result = Signed::<M>::zero();
        result.negative = self.negative;
        result.used = self.used;
        result.limbs[..self.used].copy_from_slice(&self.limbs[..self.used]);
        result
    }

    pub(crate) fn narrow<const M: usize>(self) -> Signed<M> {
        assert!(self.used <= M, "integer narrowing capacity overflow");
        let mut result = Signed::<M>::zero();
        result.negative = self.negative;
        result.used = self.used;
        result.limbs[..self.used].copy_from_slice(&self.limbs[..self.used]);
        result
    }

    pub(crate) fn add(self, other: Self) -> Self {
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

    pub(crate) fn compare_magnitude(self, other: Self) -> Ordering {
        #[cfg(p3_b0_diag)]
        let _diag = crate::p3_b0_diag::enter(
            "fill_exact::compare_magnitude",
            core::any::type_name::<Self>(),
            move || {
                core::hint::black_box(
                    core::hint::black_box(self).compare_magnitude(core::hint::black_box(other)),
                );
            },
        );
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

    pub(crate) fn cmp_zero(self) -> Ordering {
        if self.is_zero() {
            Ordering::Equal
        } else if self.negative {
            Ordering::Less
        } else {
            Ordering::Greater
        }
    }

    pub(crate) fn trailing_zeros(self) -> usize {
        if self.is_zero() {
            return usize::MAX;
        }
        let mut bits = 0usize;
        for word in &self.limbs[..self.used] {
            if *word == 0 {
                bits += 64;
            } else {
                bits += word.trailing_zeros() as usize;
                break;
            }
        }
        bits
    }

    pub(crate) fn shift_right(mut self, shift: usize) -> Self {
        if shift == 0 || self.is_zero() {
            return self;
        }
        let words = shift / 64;
        let bits = shift % 64;
        assert!(
            words < self.used,
            "integer right shift removed nonzero value"
        );
        assert!(
            self.limbs[..words].iter().all(|word| *word == 0),
            "integer right shift discarded nonzero bits"
        );
        if bits != 0 {
            assert_eq!(
                self.limbs[words] & ((1u64 << bits) - 1),
                0,
                "integer right shift discarded nonzero bits"
            );
        }
        let remaining = self.used - words;
        for index in 0..remaining {
            let source = index + words;
            let low = self.limbs[source] >> bits;
            let high = if bits != 0 && source + 1 < self.used {
                self.limbs[source + 1] << (64 - bits)
            } else {
                0
            };
            self.limbs[index] = low | high;
        }
        self.limbs[remaining..self.used].fill(0);
        self.used = remaining;
        self.trim();
        self
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

pub(crate) fn multiply<const A: usize, const B: usize, const OUT: usize>(
    left: Signed<A>,
    right: Signed<B>,
) -> Signed<OUT> {
    #[cfg(p3_b0_diag)]
    let _diag = crate::p3_b0_diag::enter(
        "fill_exact::multiply",
        core::any::type_name::<(Signed<A>, Signed<B>, Signed<OUT>)>(),
        move || {
            core::hint::black_box(multiply::<A, B, OUT>(
                core::hint::black_box(left),
                core::hint::black_box(right),
            ));
        },
    );
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

pub(crate) fn compare_ratios<
    const LN: usize,
    const LD: usize,
    const RN: usize,
    const RD: usize,
    const OUT: usize,
>(
    left_numerator: Signed<LN>,
    left_weight: Signed<LD>,
    right_numerator: Signed<RN>,
    right_weight: Signed<RD>,
) -> Ordering {
    #[cfg(p3_b0_diag)]
    let _diag = crate::p3_b0_diag::enter(
        "fill_exact::compare_ratios",
        core::any::type_name::<(Signed<LN>, Signed<LD>, Signed<RN>, Signed<RD>, Signed<OUT>)>(),
        move || {
            core::hint::black_box(compare_ratios::<LN, LD, RN, RD, OUT>(
                core::hint::black_box(left_numerator),
                core::hint::black_box(left_weight),
                core::hint::black_box(right_numerator),
                core::hint::black_box(right_weight),
            ));
        },
    );
    debug_assert!(!left_weight.negative && !left_weight.is_zero());
    debug_assert!(!right_weight.negative && !right_weight.is_zero());
    let left = multiply::<LN, RD, OUT>(left_numerator, right_weight);
    let right = multiply::<RN, LD, OUT>(right_numerator, left_weight);
    left.add(right.negated()).cmp_zero()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ExactLine {
    pub(crate) x: Signed<COORDINATE_LIMBS>,
    pub(crate) y: Signed<COORDINATE_LIMBS>,
    pub(crate) z: Signed<LINE_LIMBS>,
}

pub(crate) fn line(start: Point, end: Point) -> ExactLine {
    let ax = Signed::<COORDINATE_LIMBS>::from_finite(start.x);
    let ay = Signed::<COORDINATE_LIMBS>::from_finite(start.y);
    let bx = Signed::<COORDINATE_LIMBS>::from_finite(end.x);
    let by = Signed::<COORDINATE_LIMBS>::from_finite(end.y);
    ExactLine {
        x: ay.add(by.negated()),
        y: bx.add(ax.negated()),
        z: multiply::<COORDINATE_LIMBS, COORDINATE_LIMBS, LINE_LIMBS>(ax, by)
            .add(multiply::<COORDINATE_LIMBS, COORDINATE_LIMBS, LINE_LIMBS>(ay, bx).negated()),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ExactEventPosition {
    pub(crate) x: Signed<HOMOGENEOUS_LIMBS>,
    pub(crate) y: Signed<HOMOGENEOUS_LIMBS>,
    pub(crate) w: Signed<LINE_LIMBS>,
}

pub(crate) fn endpoint_position(point: Point) -> ExactEventPosition {
    ExactEventPosition {
        x: Signed::<COORDINATE_LIMBS>::from_finite(point.x).widen(),
        y: Signed::<COORDINATE_LIMBS>::from_finite(point.y).widen(),
        w: Signed::one(),
    }
}

pub(crate) fn crossing_position(a: Point, b: Point, c: Point, d: Point) -> ExactEventPosition {
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
    ExactEventPosition { x, y, w }
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
    fn decode_canonicalizes_zero_and_covers_literal_boundaries() {
        assert_eq!(
            Signed::<COORDINATE_LIMBS>::from_finite(-0.0),
            Signed::zero()
        );
        assert_eq!(
            Signed::<COORDINATE_LIMBS>::from_finite(f64::from_bits(1)),
            positive(&[(0, 1)])
        );
        let maximum = Signed::<COORDINATE_LIMBS>::from_finite(f64::MAX);
        assert_eq!(maximum.used, COORDINATE_LIMBS);
        assert!(maximum.limbs[..31].iter().all(|word| *word == 0));
        assert_eq!(maximum.limbs[31], 0xe000_0000_0000_0000);
        assert_eq!(maximum.limbs[32], 0x0003_ffff_ffff_ffff);
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
    }

    #[test]
    fn carry_borrow_multiply_and_narrow_are_exact() {
        let dense = positive::<COORDINATE_LIMBS>(&[(0, u64::MAX), (1, u64::MAX)]);
        let one = positive::<COORDINATE_LIMBS>(&[(0, 1)]);
        assert_eq!(dense.add(one), positive(&[(0, 0), (1, 0), (2, 1)]));
        assert_eq!(
            positive::<COORDINATE_LIMBS>(&[(2, 1)]).add(one.negated()),
            dense
        );
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
        assert_eq!(one.widen::<LINE_LIMBS>().narrow::<COORDINATE_LIMBS>(), one);
    }

    #[test]
    fn widening_zero_fills_and_intermediate_products_keep_high_words() {
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
    }

    #[test]
    fn power_of_two_shift_is_literal_and_canonical() {
        let value = positive::<COORDINATE_LIMBS>(&[(0, 0), (1, 4), (2, 8)]);
        assert_eq!(value.trailing_zeros(), 66);
        assert_eq!(value.shift_right(66), positive(&[(0, 1), (1, 2)]));
        assert_eq!(
            Signed::<COORDINATE_LIMBS>::zero().trailing_zeros(),
            usize::MAX
        );
    }

    #[test]
    fn top_event_product_uses_final_limb() {
        let top = multiply::<HOMOGENEOUS_LIMBS, LINE_LIMBS, EVENT_COMPARISON_LIMBS>(
            positive::<HOMOGENEOUS_LIMBS>(&[(HOMOGENEOUS_LIMBS - 1, 1u64 << 63)]),
            positive::<LINE_LIMBS>(&[(LINE_LIMBS - 1, 1u64 << 63)]),
        );
        assert_eq!(top, positive(&[(EVENT_COMPARISON_LIMBS - 1, 1u64 << 62)]));
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
