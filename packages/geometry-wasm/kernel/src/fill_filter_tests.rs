//! B0R unit U1 oracles for the shared filter module `fill_filter`
//! (docs/plans/p3-b0r-kernel-performance-contract.md sections 3.2-3.4 and 7: O1, O2, O8).
//!
//! Every check here is exact: interval endpoints are compared with the enclosed value by
//! arbitrary-width integer arithmetic (`Big`), and ratio comparisons with
//! `fill_exact::compare_ratios`.
//!
//! The full-size runs are `#[ignore]` tests in the release profile, run by
//! `pnpm test:p3-fill-identity`; the ordinary tests are the smoke versions.
use core::cmp::Ordering;
use std::thread;
use std::time::Instant;

use crate::fill_exact::{compare_ratios, multiply, Signed};
use crate::fill_filter::{
    compare_enclosures, enclose, enclose_ratio, top_limbs, with_fault, Fault, Interval, UNDECIDED,
};

pub(crate) const THREAD_STACK_BYTES: usize = 16 * 1024 * 1024;

/// xorshift64* (Vigna 2016); deterministic per seed.
pub(crate) struct Rng(u64);

impl Rng {
    pub(crate) fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }

    pub(crate) fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    /// Uniform in `0..bound` (bound > 0), with negligible modulo bias for test sampling.
    pub(crate) fn below(&mut self, bound: u64) -> u64 {
        self.next_u64() % bound
    }

    pub(crate) fn range_i32(&mut self, low: i32, high: i32) -> i32 {
        low + self.below((high - low + 1) as u64) as i32
    }

    pub(crate) fn chance(&mut self, numerator: u64, denominator: u64) -> bool {
        self.below(denominator) < numerator
    }

    /// A significand in [1, 2) times 2^exponent, with a random sign when `signed`.
    pub(crate) fn scaled(&mut self, exponent: i32, signed: bool) -> f64 {
        let fraction = self.next_u64() >> 12;
        let value = f64::from_bits((1023u64 << 52) | fraction) * pow2(exponent);
        if signed && self.chance(1, 2) {
            -value
        } else {
            value
        }
    }

    /// `scaled` with an exponent uniform in `low..=high`.
    pub(crate) fn scaled_in(&mut self, low: i32, high: i32, signed: bool) -> f64 {
        let exponent = self.range_i32(low, high);
        self.scaled(exponent, signed)
    }

    /// A finite binary64 value: mostly normal with exponent in `exponents`, plus zeros of both
    /// signs, subnormals and small integers.
    pub(crate) fn finite(&mut self, low: i32, high: i32) -> f64 {
        match self.below(100) {
            0..=2 => {
                if self.chance(1, 2) {
                    0.0
                } else {
                    -0.0
                }
            }
            3..=5 => {
                let bits = 1 + self.below((1u64 << 52) - 1);
                let value = f64::from_bits(bits);
                if self.chance(1, 2) {
                    -value
                } else {
                    value
                }
            }
            6..=12 => (self.below(64) as f64) - 32.0,
            _ => {
                let exponent = self.range_i32(low, high);
                self.scaled(exponent, true)
            }
        }
    }
}

/// 2^exponent for any exponent whose result is a finite nonzero binary64 value.
pub(crate) fn pow2(exponent: i32) -> f64 {
    if exponent >= -1022 {
        f64::from_bits(((exponent + 1023) as u64) << 52)
    } else {
        f64::from_bits(1u64 << (exponent + 1074))
    }
}

/// Arbitrary-width signed integer, test-only reference arithmetic.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Big {
    negative: bool,
    magnitude: Vec<u64>,
}

impl Big {
    fn trimmed(mut self) -> Self {
        while self.magnitude.last() == Some(&0) {
            self.magnitude.pop();
        }
        if self.magnitude.is_empty() {
            self.negative = false;
        }
        self
    }

    pub(crate) fn from_signed<const N: usize>(value: &Signed<N>) -> Self {
        Self {
            negative: value.negative,
            magnitude: value.limbs[..value.used].to_vec(),
        }
        .trimmed()
    }

    /// x * 2^1074 exactly (the `fill_exact` decoded unit).
    pub(crate) fn from_f64(value: f64) -> Self {
        Self::from_signed(&Signed::<33>::from_finite(value))
    }

    pub(crate) fn shl(&self, bits: usize) -> Self {
        let words = bits / 64;
        let offset = bits % 64;
        let mut magnitude = vec![0u64; words];
        let mut carry = 0u64;
        for &word in &self.magnitude {
            if offset == 0 {
                magnitude.push(word);
            } else {
                magnitude.push((word << offset) | carry);
                carry = word >> (64 - offset);
            }
        }
        magnitude.push(carry);
        Self {
            negative: self.negative,
            magnitude,
        }
        .trimmed()
    }

    pub(crate) fn mul(&self, other: &Self) -> Self {
        let mut magnitude = vec![0u64; self.magnitude.len() + other.magnitude.len() + 1];
        for (i, &left) in self.magnitude.iter().enumerate() {
            let mut carry = 0u128;
            for (j, &right) in other.magnitude.iter().enumerate() {
                let value =
                    u128::from(left) * u128::from(right) + u128::from(magnitude[i + j]) + carry;
                magnitude[i + j] = value as u64;
                carry = value >> 64;
            }
            let mut index = i + other.magnitude.len();
            while carry != 0 {
                let value = u128::from(magnitude[index]) + carry;
                magnitude[index] = value as u64;
                carry = value >> 64;
                index += 1;
            }
        }
        Self {
            negative: self.negative != other.negative,
            magnitude,
        }
        .trimmed()
    }

    fn compare_magnitude(&self, other: &Self) -> Ordering {
        self.magnitude
            .len()
            .cmp(&other.magnitude.len())
            .then_with(|| {
                for index in (0..self.magnitude.len()).rev() {
                    match self.magnitude[index].cmp(&other.magnitude[index]) {
                        Ordering::Equal => {}
                        value => return value,
                    }
                }
                Ordering::Equal
            })
    }

    pub(crate) fn compare(&self, other: &Self) -> Ordering {
        match (self.negative, other.negative) {
            (false, true) => Ordering::Greater,
            (true, false) => Ordering::Less,
            (false, false) => self.compare_magnitude(other),
            (true, true) => other.compare_magnitude(self),
        }
    }
}

/// Exact check of `lo <= value * 2^-unit <= hi` for an enclosure of a `Signed` value.
pub(crate) fn enclosure_contains<const N: usize>(
    enclosure: Interval,
    value: &Signed<N>,
    unit: usize,
) -> bool {
    let scaled = Big::from_signed(value).shl(1074);
    Big::from_f64(enclosure.lo).shl(unit).compare(&scaled) != Ordering::Greater
        && Big::from_f64(enclosure.hi).shl(unit).compare(&scaled) != Ordering::Less
}

fn wide(value: f64) -> Signed<34> {
    Signed::<33>::from_finite(value).widen()
}

/// Exact containment of one interval operation on point intervals, or `None` when the
/// operation is undecidable (non-finite) and therefore claims nothing.
fn operation_contains(kind: u64, a: f64, b: f64) -> Option<bool> {
    let (result, exact, unit) = match kind {
        0 => (
            Interval::point(a).add(Interval::point(b)),
            Big::from_signed(&wide(a).add(wide(b))),
            0,
        ),
        1 => (
            Interval::point(a).sub(Interval::point(b)),
            Big::from_signed(&wide(a).add(wide(b).negated())),
            0,
        ),
        2 => (
            Interval::point(a).mul(Interval::point(b)),
            Big::from_signed(&multiply::<33, 33, 66>(
                Signed::<33>::from_finite(a),
                Signed::<33>::from_finite(b),
            )),
            1074,
        ),
        _ => {
            // Division by a positive point: lo * b <= a <= hi * b, scaled by 2^2148.
            let b = b.abs();
            if b == 0.0 {
                return None;
            }
            let result = Interval::point(a).div(Interval::point(b));
            if !result.is_finite() {
                return None;
            }
            let numerator = Big::from_f64(a).shl(1074);
            let weight = Big::from_f64(b);
            let low = Big::from_f64(result.lo).mul(&weight);
            let high = Big::from_f64(result.hi).mul(&weight);
            return Some(
                low.compare(&numerator) != Ordering::Greater
                    && high.compare(&numerator) != Ordering::Less,
            );
        }
    };
    if !result.is_finite() {
        return None;
    }
    Some(
        Big::from_f64(result.lo).shl(unit).compare(&exact) != Ordering::Greater
            && Big::from_f64(result.hi).shl(unit).compare(&exact) != Ordering::Less,
    )
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Tally {
    pub(crate) cases: u64,
    pub(crate) violations: u64,
    pub(crate) decided: u64,
    pub(crate) undecided: u64,
}

impl Tally {
    pub(crate) fn merge(&mut self, other: Tally) {
        self.cases += other.cases;
        self.violations += other.violations;
        self.decided += other.decided;
        self.undecided += other.undecided;
    }
}

fn adversarial_pair(rng: &mut Rng) -> (f64, f64) {
    let a = rng.finite(-1074, 1023);
    let b = match rng.below(6) {
        // Cancellation: a neighbour of -a.
        0 => -a.next_up(),
        1 => -a.next_down(),
        // Binade boundaries.
        2 => pow2(rng.range_i32(-1074, 1023)).next_down(),
        3 => pow2(rng.range_i32(-1074, 1023)),
        // Near overflow and deep underflow.
        4 => rng.scaled_in(1000, 1023, true),
        _ => rng.scaled_in(-1022, -1000, true),
    };
    (a, b)
}

/// R1/R2 containment of add, sub, mul and div on point intervals (O1 for the primitives).
pub(crate) fn interval_operations(seed: u64, random: u64, adversarial: u64) -> Tally {
    let mut rng = Rng::new(seed);
    let mut tally = Tally::default();
    for index in 0..random + adversarial {
        let (a, b) = if index < random {
            (rng.finite(-1074, 1023), rng.finite(-1074, 1023))
        } else {
            adversarial_pair(&mut rng)
        };
        for kind in 0..4 {
            tally.cases += 1;
            match operation_contains(kind, a, b) {
                Some(true) => tally.decided += 1,
                Some(false) => tally.violations += 1,
                None => tally.undecided += 1,
            }
        }
    }
    tally
}

fn random_signed<const N: usize>(rng: &mut Rng, max_used: usize) -> Signed<N> {
    let mut value = Signed::<N>::zero();
    let used = 1 + rng.below(max_used.min(N) as u64) as usize;
    for limb in &mut value.limbs[..used] {
        *limb = match rng.below(4) {
            0 => 0,
            1 => u64::MAX,
            _ => rng.next_u64(),
        };
    }
    if value.limbs[used - 1] == 0 {
        value.limbs[used - 1] = 1 + rng.below(u64::MAX - 1);
    }
    // Sparse top limbs exercise the single-bit and power-of-two cases.
    if rng.chance(1, 4) {
        value.limbs[used - 1] = 1u64 << rng.below(64);
    }
    value.used = used;
    value.negative = rng.chance(1, 2);
    value
}

/// Section 3.3 containment, exact, for random and adversarial `Signed<34>` values at the
/// topology unit 2^-1134 and `Signed<33>` values at 2^-1074.
pub(crate) fn enclosure_containment(seed: u64, random: u64, adversarial: u64) -> Tally {
    let mut rng = Rng::new(seed);
    let mut tally = Tally::default();
    for index in 0..random + adversarial {
        let (value, unit): (Signed<34>, usize) = if index < random {
            (random_signed::<34>(&mut rng, 34), 1134)
        } else {
            match rng.below(3) {
                // Exact binary64 values at binade boundaries and their neighbours.
                0 => {
                    let base = pow2(rng.range_i32(-1074, 1023));
                    let value = match rng.below(3) {
                        0 => base,
                        1 => base.next_down(),
                        _ => base.next_up(),
                    };
                    (wide(if rng.chance(1, 2) { -value } else { value }), 1074)
                }
                // Values whose truncated tail is all ones (largest truncation error).
                1 => {
                    let mut value = Signed::<34>::zero();
                    let used = 2 + rng.below(32) as usize;
                    value.limbs[..used].fill(u64::MAX);
                    value.used = used;
                    (value, 1134)
                }
                // Top limb a power of two with a tiny tail (r a power of two).
                _ => {
                    let mut value = Signed::<34>::zero();
                    let used = 3 + rng.below(31) as usize;
                    value.limbs[used - 1] = 1u64 << rng.below(64);
                    value.limbs[used - 3] = rng.next_u64() | 1;
                    value.used = used;
                    value.negative = rng.chance(1, 2);
                    (value, 1134)
                }
            }
        };
        tally.cases += 1;
        match enclose(&value, unit as i32) {
            Some(enclosure) if enclosure_contains(enclosure, &value, unit) => tally.decided += 1,
            Some(_) => tally.violations += 1,
            None => tally.undecided += 1,
        }
    }
    tally
}

fn bits_signed<const N: usize>(rng: &mut Rng, bits: usize) -> Signed<N> {
    let mut value = Signed::<N>::zero();
    let used = bits.div_ceil(64);
    for limb in &mut value.limbs[..used] {
        *limb = rng.next_u64();
    }
    let top = bits - 64 * (used - 1);
    value.limbs[used - 1] &= if top == 64 {
        u64::MAX
    } else {
        (1u64 << top) - 1
    };
    value.limbs[used - 1] |= 1u64 << (top - 1);
    value.used = used;
    value
}

fn shifted<const N: usize>(value: &Signed<N>, bits: usize) -> Signed<N> {
    let big = Big::from_signed(value).shl(bits);
    let mut result = Signed::<N>::zero();
    result.negative = big.negative;
    result.limbs[..big.magnitude.len()].copy_from_slice(&big.magnitude);
    result.used = big.magnitude.len();
    result
}

fn bit_length<const N: usize>(value: &Signed<N>) -> usize {
    64 * (value.used - 1) + 64 - value.limbs[value.used - 1].leading_zeros() as usize
}

/// A random ratio N/W with W > 0 whose value (N / W) * 2^-1074 has binary exponent near
/// `exponent`, for a column (`Signed<99>` / `Signed<66>`) or section shape.
fn random_ratio<const NN: usize, const NW: usize>(
    rng: &mut Rng,
    exponent: i32,
    max_weight_bits: usize,
) -> (Signed<NN>, Signed<NW>) {
    let weight_bits = 1 + rng.below(max_weight_bits as u64) as usize;
    let weight = bits_signed::<NW>(rng, weight_bits);
    let numerator_bits = (weight_bits as i32 + 1074 + exponent).max(1) as usize;
    let mut numerator = bits_signed::<NN>(rng, numerator_bits);
    numerator.negative = rng.chance(1, 2);
    (numerator, weight)
}

/// Exact check of the ratio enclosure: lo * 2^1074 * W <= N <= hi * 2^1074 * W.
fn ratio_contains<const NN: usize, const NW: usize>(
    enclosure: Interval,
    numerator: &Signed<NN>,
    weight: &Signed<NW>,
) -> bool {
    let n = Big::from_signed(numerator);
    let w = Big::from_signed(weight);
    Big::from_f64(enclosure.lo).mul(&w).compare(&n) != Ordering::Greater
        && Big::from_f64(enclosure.hi).mul(&w).compare(&n) != Ordering::Less
}

/// Section 3.4 differential for one ratio shape: containment of each enclosure, and every
/// decided comparison of two enclosures equal to `compare_ratios`. The second operand is an
/// independent ratio, the same ratio in another (unnormalized) representation, a neighbour
/// (N + 1), or an exact binary64 point.
fn ratio_differential<const NN: usize, const NW: usize, const OUT: usize>(
    rng: &mut Rng,
    cases: u64,
    adversarial: bool,
    max_weight_bits: usize,
) -> Tally {
    let mut tally = Tally::default();
    for _ in 0..cases {
        let exponent = if adversarial {
            match rng.below(3) {
                0 => rng.range_i32(-1022, -1000),
                1 => rng.range_i32(1000, 1022),
                _ => rng.range_i32(-60, 60),
            }
        } else {
            rng.range_i32(-1000, 1000)
        };
        let (left_n, left_w) = random_ratio::<NN, NW>(rng, exponent, max_weight_bits);
        let mode = if adversarial {
            1 + rng.below(3)
        } else {
            rng.below(4)
        };
        let (right_n, right_w): (Signed<NN>, Signed<NW>) = match mode {
            0 => {
                let offset = rng.range_i32(-2, 2);
                random_ratio::<NN, NW>(rng, exponent + offset, max_weight_bits)
            }
            1 => {
                // Same ratio, different representation: a common left shift within capacity.
                let room = (64 * NW)
                    .saturating_sub(bit_length(&left_w))
                    .min(64 * NN - bit_length(&left_n));
                let shift = 1 + rng.below(room.clamp(1, 300) as u64) as usize;
                if shift >= room {
                    (left_n, left_w)
                } else {
                    (shifted(&left_n, shift), shifted(&left_w, shift))
                }
            }
            2 => {
                let one = Signed::<NN>::one();
                (
                    left_n.add(if rng.chance(1, 2) { one } else { one.negated() }),
                    left_w,
                )
            }
            _ => {
                // An exact binary64 point: N = from_finite(v), W = 1.
                let value = rng.scaled(exponent.clamp(-1022, 1022), true);
                (
                    Signed::<33>::from_finite(value).widen(),
                    Signed::<NW>::one(),
                )
            }
        };
        let left = enclose_ratio(&left_n, &left_w);
        let right = enclose_ratio(&right_n, &right_w);
        for (enclosure, n, w) in [(left, &left_n, &left_w), (right, &right_n, &right_w)] {
            if let Some(enclosure) = enclosure {
                if !ratio_contains(enclosure, n, w) {
                    tally.violations += 1;
                }
            }
        }
        tally.cases += 1;
        let decision = match (left, right) {
            (Some(left), Some(right)) => compare_enclosures(left, right),
            _ => None,
        };
        match decision {
            Some(value) => {
                tally.decided += 1;
                if value != compare_ratios::<NN, NW, NN, NW, OUT>(left_n, left_w, right_n, right_w)
                {
                    tally.violations += 1;
                }
            }
            None => tally.undecided += 1,
        }
    }
    tally
}

/// O1 for section 3.4 on both shapes: columns (`Signed<99>` / `Signed<66>`) and sections
/// (`Signed<132>` / `Signed<99>`).
pub(crate) fn ratio_enclosures(seed: u64, random: u64, adversarial: u64) -> [Tally; 2] {
    let mut rng = Rng::new(seed);
    let mut column = ratio_differential::<99, 66, 165>(&mut rng, random, false, 3000);
    column.merge(ratio_differential::<99, 66, 165>(
        &mut rng,
        adversarial,
        true,
        3000,
    ));
    let mut section = ratio_differential::<132, 99, 231>(&mut rng, random, false, 4500);
    section.merge(ratio_differential::<132, 99, 231>(
        &mut rng,
        adversarial,
        true,
        4500,
    ));
    [column, section]
}

#[test]
fn b0r_o1_smoke_interval_operations() {
    let tally = interval_operations(0x4230_5231_0001, 10_000, 1_000);
    assert_eq!(tally.violations, 0, "{tally:?}");
    assert!(tally.decided > 30_000, "{tally:?}");
}

#[test]
fn b0r_o1_smoke_enclosure_containment() {
    let tally = enclosure_containment(0x4230_5231_0002, 10_000, 1_000);
    assert_eq!(tally.violations, 0, "{tally:?}");
    assert!(tally.decided > 5_000, "{tally:?}");
}

#[test]
fn b0r_o1_smoke_ratio_enclosures() {
    for tally in ratio_enclosures(0x4230_5231_0003, 2_000, 500) {
        assert_eq!(tally.violations, 0, "{tally:?}");
        assert!(tally.decided > 500, "{tally:?}");
        assert!(tally.undecided > 100, "{tally:?}");
    }
}

#[test]
fn b0r_o2_trimmed_invariant_violation_is_not_enclosed() {
    let mut value = Signed::<34>::zero();
    value.limbs[0] = 7;
    value.used = 2; // top used limb is zero: not trimmed
    assert_eq!(top_limbs(&value), None);
    let result = std::panic::catch_unwind(|| enclose(&value, 1134));
    if cfg!(debug_assertions) {
        assert!(
            result.is_err(),
            "the helper debug_asserts the trimmed invariant"
        );
    } else {
        assert_eq!(result.ok(), Some(None));
    }
    let mut overlong = Signed::<2>::zero();
    overlong.used = 3;
    assert_eq!(top_limbs(&overlong), None);
}

#[test]
fn b0r_o2_nan_producing_operations_are_undecided() {
    let huge = Interval::point(f64::MAX);
    let tiny = Interval::point(f64::MIN_POSITIVE);
    assert_eq!(Interval::point(f64::INFINITY).sign(), None);
    assert_eq!(Interval::point(f64::NAN).sign(), None);
    assert!(!huge.add(huge).is_finite(), "overflowing sum");
    assert!(!huge.mul(huge).is_finite(), "overflowing product");
    assert!(!huge.sub(huge.mul(Interval::point(-1.0))).is_finite());
    assert!(
        !UNDECIDED.mul(Interval::point(0.0)).is_finite(),
        "NaN times zero"
    );
    let straddle = Interval { lo: -1.0, hi: 1.0 };
    assert!(!tiny.div(straddle).is_finite(), "divisor containing zero");
    assert!(!tiny.div(Interval::point(0.0)).is_finite());
    assert_eq!(compare_enclosures(UNDECIDED, Interval::point(1.0)), None);
    // A true zero always yields an interval containing zero: never a decision.
    let third = Interval::point(1.0).div(Interval::point(3.0));
    assert_eq!(
        third
            .mul(Interval::point(3.0))
            .sub(Interval::point(1.0))
            .sign(),
        None
    );
}

#[test]
fn b0r_o2_enclosure_limits_at_binade_boundaries() {
    for exponent in [-1022, -1000, -1, 0, 1, 52, 53, 64, 1000, 1023] {
        for value in [
            pow2(exponent),
            pow2(exponent).next_down(),
            pow2(exponent).next_up(),
        ] {
            if !value.is_normal() {
                continue;
            }
            let exact = wide(value);
            let enclosure = enclose(&exact, 1074).expect("normal value enclosed");
            assert!(enclosure_contains(enclosure, &exact, 1074), "{value:e}");
            assert!(enclosure.lo < value && value < enclosure.hi);
            // Two ulps on each side, no more.
            assert_eq!(enclosure.hi, value.next_up().next_up());
            assert_eq!(enclosure.lo, value.next_down().next_down());
        }
    }
    // Subnormal results and the smallest normal neighbourhood are not enclosed.
    assert_eq!(enclose(&wide(f64::from_bits(1)), 1074), None);
    assert_eq!(enclose(&wide(f64::MIN_POSITIVE.next_down()), 1074), None);
    assert!(enclose(&wide(f64::MIN_POSITIVE), 1074).is_some());
    // Results beyond the finite range are not enclosed.
    assert_eq!(enclose(&wide(f64::MAX), 1073), None);
    assert_eq!(
        enclose(&Signed::<34>::zero(), 1134),
        Some(Interval { lo: 0.0, hi: 0.0 })
    );
}

#[test]
fn b0r_o2_endpoint_sections_through_ratio_enclosure() {
    // endpoint_section(v): N = v * 2^1074 in Signed<132>, W = 1 (b = 1).
    for value in [100.0, pow2(1000), pow2(-1000), -pow2(1000) * 1.5, -100.0] {
        let numerator: Signed<132> = Signed::<33>::from_finite(value).widen();
        let weight = Signed::<99>::one();
        let enclosure = enclose_ratio(&numerator, &weight).expect("no overflow");
        assert!(ratio_contains(enclosure, &numerator, &weight), "{value:e}");
        // Decided against well-separated binary64 candidates.
        let above = Interval::point(value + value.abs() * pow2(-30));
        let below = Interval::point(value - value.abs() * pow2(-30));
        assert_eq!(compare_enclosures(enclosure, above), Some(Ordering::Less));
        assert_eq!(
            compare_enclosures(enclosure, below),
            Some(Ordering::Greater)
        );
        // A section exactly equal to an f64 candidate is never decided.
        assert_eq!(compare_enclosures(enclosure, Interval::point(value)), None);
    }
    // The unnormalized representation (N * 2^k, W * 2^k) gives an enclosure of the same value.
    let numerator: Signed<132> = Signed::<33>::from_finite(100.0).widen();
    let weight = Signed::<99>::one();
    let enclosure = enclose_ratio(&shifted(&numerator, 700), &shifted(&weight, 700)).unwrap();
    assert!(enclosure.lo < 100.0 && 100.0 < enclosure.hi);
    assert!(enclosure.hi - enclosure.lo < 1e-12);
}

/// O8 (1): with R1 widening removed, the primitive containment oracle fails.
#[test]
fn b0r_o8_r1_widening_removed_is_detected() {
    let tally = with_fault(Fault::R1WideningRemoved, || {
        interval_operations(0x4230_5231_0001, 10_000, 1_000)
    });
    assert!(tally.violations > 0, "{tally:?}");
}

/// O8 (1), enclosure part: with the two-ulp widening removed, the containment oracle fails.
#[test]
fn b0r_o8_enclosure_widening_removed_is_detected() {
    let tally = with_fault(Fault::EnclosureWideningRemoved, || {
        enclosure_containment(0x4230_5231_0002, 10_000, 1_000)
    });
    assert!(tally.violations > 0, "{tally:?}");
}

/// O8 (7): a fixed numerator unit instead of section 3.4 is detected by the ratio differential.
#[test]
fn b0r_o8_ratio_fixed_numerator_unit_is_detected() {
    let [column, section] = with_fault(Fault::RatioFixedNumeratorUnit, || {
        ratio_enclosures(0x4230_5231_0003, 2_000, 500)
    });
    assert!(column.violations > 0, "{column:?}");
    assert!(section.violations > 0, "{section:?}");
}

/// Runs `work(thread_index)` on every available core with a large stack and merges results.
pub(crate) fn parallel<T: Send + 'static>(
    threads: usize,
    work: impl Fn(usize) -> T + Send + Sync + Copy + 'static,
) -> Vec<T> {
    let handles: Vec<_> = (0..threads)
        .map(|index| {
            thread::Builder::new()
                .stack_size(THREAD_STACK_BYTES)
                .spawn(move || work(index))
                .expect("spawn oracle thread")
        })
        .collect();
    handles
        .into_iter()
        .map(|handle| handle.join().expect("oracle thread"))
        .collect()
}

pub(crate) fn thread_count() -> usize {
    thread::available_parallelism().map_or(4, usize::from)
}

/// Splits `total` cases over `threads` workers.
pub(crate) fn share(total: u64, threads: usize, index: usize) -> u64 {
    let threads = threads as u64;
    total / threads + u64::from((index as u64) < total % threads)
}

/// Full O1 for the shared module: 10^7 random and 10^6 adversarial tuples per primitive.
#[test]
#[ignore = "B0R O1 full size; release profile via pnpm test:p3-fill-identity"]
fn b0r_oracle_full_o1_filter_module() {
    const RANDOM: u64 = 10_000_000;
    const ADVERSARIAL: u64 = 1_000_000;
    let threads = thread_count();
    let start = Instant::now();
    let mut operations = Tally::default();
    for tally in parallel(threads, move |index| {
        interval_operations(
            0x4230_5231_1000 + index as u64,
            share(RANDOM, threads, index),
            share(ADVERSARIAL, threads, index),
        )
    }) {
        operations.merge(tally);
    }
    let mut containment = Tally::default();
    for tally in parallel(threads, move |index| {
        enclosure_containment(
            0x4230_5231_2000 + index as u64,
            share(RANDOM, threads, index),
            share(ADVERSARIAL, threads, index),
        )
    }) {
        containment.merge(tally);
    }
    let mut column = Tally::default();
    let mut section = Tally::default();
    for [c, s] in parallel(threads, move |index| {
        ratio_enclosures(
            0x4230_5231_3000 + index as u64,
            share(RANDOM, threads, index),
            share(ADVERSARIAL, threads, index),
        )
    }) {
        column.merge(c);
        section.merge(s);
    }
    println!(
        "B0R O1 filter module ({threads} threads, {:.1} s): interval operations {operations:?}; enclosure containment {containment:?}; column ratios {column:?}; section ratios {section:?}",
        start.elapsed().as_secs_f64()
    );
    for tally in [operations, containment, column, section] {
        assert_eq!(tally.violations, 0, "{tally:?}");
    }
}
