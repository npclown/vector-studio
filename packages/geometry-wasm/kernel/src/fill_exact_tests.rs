//! B0R unit U1b oracles for low-limb skipping in `fill_exact`
//! (docs/plans/p3-b0r-kernel-performance-contract.md sections 5.5 and 7, O1).
//!
//! Each changed routine (`multiply`, `add_magnitudes`, `subtract_magnitudes`) and the composites
//! that reach it (`Signed::add`, `compare_ratios`) are compared with `cfg(test)` copies of the
//! routines as they were before U1b, on random and adversarial limb patterns: sparse limbs,
//! all-zero low limbs, shared and disjoint zero prefixes, carries and borrows across the skipped
//! boundary and across runs of zero limbs, and maximum widths. Every comparison is of the whole
//! `Signed` value: sign, `used` and every limb of the fixed array, so a result that differs only
//! above `used` also fails.
//!
//! The full-size run is an `#[ignore]` test in the release profile, run by
//! `pnpm test:p3-fill-identity`; the ordinary tests are the smoke versions.
use core::cmp::Ordering;
use std::time::Instant;

use crate::fill_exact::{add_magnitudes, compare_ratios, multiply, subtract_magnitudes, Signed};
use crate::fill_filter_tests::{parallel, share, Rng, ORACLE_SHARDS};

// ---------------------------------------------------------------------------------------------
// Reference copies of the routines before U1b (main 2d4d245), without the diagnostic hooks.
// ---------------------------------------------------------------------------------------------

fn reference_trim<const N: usize>(value: &mut Signed<N>) {
    while value.used > 0 && value.limbs[value.used - 1] == 0 {
        value.used -= 1;
    }
    if value.used == 0 {
        value.negative = false;
    }
}

fn reference_add_magnitudes<const N: usize>(
    left: Signed<N>,
    right: Signed<N>,
    negative: bool,
) -> Signed<N> {
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

fn reference_subtract_magnitudes<const N: usize>(
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
    reference_trim(&mut result);
    result
}

fn reference_add<const N: usize>(left: Signed<N>, right: Signed<N>) -> Signed<N> {
    if left.is_zero() {
        return right;
    }
    if right.is_zero() {
        return left;
    }
    if left.negative == right.negative {
        return reference_add_magnitudes(left, right, left.negative);
    }
    match left.compare_magnitude(right) {
        Ordering::Greater => reference_subtract_magnitudes(left, right, left.negative),
        Ordering::Less => reference_subtract_magnitudes(right, left, right.negative),
        Ordering::Equal => Signed::zero(),
    }
}

fn reference_multiply<const A: usize, const B: usize, const OUT: usize>(
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
    reference_trim(&mut result);
    result
}

fn reference_compare_ratios<
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
    let left = reference_multiply::<LN, RD, OUT>(left_numerator, right_weight);
    let right = reference_multiply::<RN, LD, OUT>(right_numerator, left_weight);
    reference_add(left, right.negated()).cmp_zero()
}

// ---------------------------------------------------------------------------------------------
// Limb-pattern generators.
// ---------------------------------------------------------------------------------------------

/// The trimmed invariant plus zero limbs above `used`, which every kernel value satisfies.
fn canonical<const N: usize>(value: &Signed<N>) -> bool {
    value.used <= N
        && (value.used == 0 || value.limbs[value.used - 1] != 0)
        && value.limbs[value.used..].iter().all(|word| *word == 0)
        && !(value.used == 0 && value.negative)
}

fn lowest_nonzero<const N: usize>(value: &Signed<N>) -> usize {
    value.limbs[..value.used]
        .iter()
        .position(|word| *word != 0)
        .unwrap_or(0)
}

fn finish<const N: usize>(mut value: Signed<N>, negative: bool) -> Signed<N> {
    value.used = N;
    reference_trim(&mut value);
    value.negative = negative && value.used != 0;
    value
}

fn word(rng: &mut Rng, kind: u64) -> u64 {
    match kind {
        0 => rng.next_u64(),
        1 => u64::MAX,
        2 => 1u64 << rng.below(64),
        3 => {
            if rng.chance(1, 6) {
                rng.next_u64() | 1
            } else {
                0
            }
        }
        4 => rng.next_u64() >> rng.below(64),
        _ => {
            if rng.chance(1, 2) {
                u64::MAX
            } else {
                0
            }
        }
    }
}

/// A canonical value with `used` limbs at most `max_used`, a zero low prefix of random length
/// (often none, often all but the top limb) and one limb style for the rest: dense, all ones,
/// single bits, sparse, short words or a mix of zeros and all-ones limbs.
fn pattern<const N: usize>(rng: &mut Rng, max_used: usize) -> Signed<N> {
    let max_used = max_used.min(N);
    if rng.chance(1, 64) {
        return Signed::zero();
    }
    let used = match rng.below(4) {
        0 => max_used,
        1 => 1 + rng.below(3.min(max_used as u64)) as usize,
        _ => 1 + rng.below(max_used as u64) as usize,
    };
    let low = match rng.below(4) {
        0 => 0,
        1 => used - 1,
        _ => rng.below(used as u64) as usize,
    };
    let kind = rng.below(6);
    let mut value = Signed::<N>::zero();
    for limb in &mut value.limbs[low..used] {
        *limb = word(rng, kind);
    }
    if value.limbs[used - 1] == 0 {
        value.limbs[used - 1] = 1 + rng.below(u64::MAX - 1);
    }
    if rng.chance(3, 4) && value.limbs[low] == 0 {
        value.limbs[low] = word(rng, 2);
    }
    finish(value, rng.chance(1, 2))
}

/// Adversarial pairs for addition and subtraction of one width.
fn adversarial_pair<const N: usize>(rng: &mut Rng, max_used: usize) -> (Signed<N>, Signed<N>) {
    let max_used = max_used.min(N);
    let mut left = pattern::<N>(rng, max_used);
    let mut right = pattern::<N>(rng, max_used);
    match rng.below(8) {
        // Shared zero prefix: both operands skip the same low limbs.
        0 => {
            let low = rng.below(max_used as u64) as usize;
            left.limbs[..low.min(N)].fill(0);
            right.limbs[..low.min(N)].fill(0);
        }
        // Borrow across a run of zero limbs: larger = 2^(64k), smaller nonzero below limb k.
        1 => {
            let top = 1 + rng.below(max_used as u64 - 1) as usize;
            left = Signed::zero();
            left.limbs[top] = if rng.chance(1, 2) { 1 } else { word(rng, 2) };
            right = Signed::zero();
            let low = rng.below(top as u64 + 1) as usize;
            for limb in &mut right.limbs[low..top] {
                let kind = rng.below(6);
                *limb = word(rng, kind);
            }
            right.limbs[low] = word(rng, 2);
        }
        // Subtrahend zero below the minuend's lowest nonzero limb and the reverse.
        2 => {
            let split = rng.below(max_used as u64) as usize;
            right.limbs[..split].fill(0);
        }
        3 => {
            let split = rng.below(max_used as u64) as usize;
            left.limbs[..split].fill(0);
        }
        // Carry across the skipped boundary: all-ones limbs on both sides of it.
        4 => {
            let boundary = rng.below(max_used as u64) as usize;
            left.limbs[..boundary].fill(u64::MAX);
            left.limbs[boundary..max_used].fill(0);
            right.limbs[..boundary].fill(0);
            right.limbs[boundary..max_used].fill(u64::MAX);
            if boundary < max_used {
                left.limbs[boundary] = u64::MAX;
            }
        }
        // Equal or near-equal magnitudes: one limb perturbed, possibly in the low prefix.
        5 => {
            right = left;
            right.negative = rng.chance(1, 2);
            if rng.chance(2, 3) && left.used > 0 {
                let index = rng.below(left.used as u64) as usize;
                right.limbs[index] = right.limbs[index].wrapping_add(1 + rng.below(3));
            }
        }
        // Maximum width with full limbs, one operand sparse.
        6 => {
            left.limbs[..max_used].fill(u64::MAX);
            right.limbs[..max_used].fill(0);
            right.limbs[rng.below(max_used as u64) as usize] = word(rng, 0) | 1;
        }
        _ => {}
    }
    (
        finish(left, rng.chance(1, 2)),
        finish(right, rng.chance(1, 2)),
    )
}

/// Adversarial product operands: wide zero prefixes in one or both, single nonzero limbs at
/// the top of the declared width, and all-ones runs that drive long carries.
fn adversarial_factor<const N: usize>(rng: &mut Rng, max_used: usize) -> Signed<N> {
    let max_used = max_used.min(N);
    let mut value = Signed::<N>::zero();
    match rng.below(5) {
        0 => {
            let kind = rng.below(3);
            value.limbs[max_used - 1] = word(rng, kind) | 1;
        }
        1 => {
            let low = rng.below(max_used as u64) as usize;
            value.limbs[low..max_used].fill(u64::MAX);
        }
        2 => {
            let low = max_used.saturating_sub(1 + rng.below(3) as usize);
            for limb in &mut value.limbs[low..max_used] {
                *limb = rng.next_u64();
            }
        }
        3 => {
            let low = rng.below(max_used as u64) as usize;
            value.limbs[low] = word(rng, 2);
            let high = low + rng.below((max_used - low) as u64) as usize;
            value.limbs[high] |= u64::MAX;
        }
        _ => return pattern(rng, max_used),
    }
    finish(value, rng.chance(1, 2))
}

// ---------------------------------------------------------------------------------------------
// Differential runners.
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default)]
struct Tally {
    cases: u64,
    skipped_low: u64,
    disagreements: u64,
}

impl Tally {
    fn merge(&mut self, other: Self) {
        self.cases += other.cases;
        self.skipped_low += other.skipped_low;
        self.disagreements += other.disagreements;
    }
}

fn check_add<const N: usize>(tally: &mut Tally, left: Signed<N>, right: Signed<N>) {
    assert!(canonical(&left) && canonical(&right));
    tally.cases += 1;
    if lowest_nonzero(&left) > 0 || lowest_nonzero(&right) > 0 {
        tally.skipped_low += 1;
    }
    let mut agree = true;
    if !left.is_zero() && !right.is_zero() {
        // Direct magnitude routines, including the equal-magnitude subtraction.
        let negative = left.negative;
        if !would_overflow_add(&left, &right) {
            agree &= add_magnitudes(left, right, negative)
                == reference_add_magnitudes(left, right, negative);
        }
        let (larger, smaller) = match left.compare_magnitude(right) {
            Ordering::Less => (right, left),
            _ => (left, right),
        };
        let expected = reference_subtract_magnitudes(larger, smaller, negative);
        let actual = subtract_magnitudes(larger, smaller, negative);
        agree &= actual == expected && canonical(&actual);
    }
    if !would_overflow_add(&left, &right) {
        let expected = reference_add(left, right);
        let actual = left.add(right);
        agree &= actual == expected && canonical(&actual);
        let expected = reference_add(left, right.negated());
        let actual = left.add(right.negated());
        agree &= actual == expected && canonical(&actual);
    }
    if !agree {
        tally.disagreements += 1;
        if tally.disagreements <= 3 {
            eprintln!("U1b add/sub disagreement: left {left:?} right {right:?}");
        }
    }
}

/// True when a same-sign magnitude sum would exceed the width (the capacity assertion).
fn would_overflow_add<const N: usize>(left: &Signed<N>, right: &Signed<N>) -> bool {
    if left.used.max(right.used) < N {
        return false;
    }
    let mut carry = false;
    for index in 0..N {
        let (partial, first) = left.limbs[index].overflowing_add(right.limbs[index]);
        let (_, second) = partial.overflowing_add(u64::from(carry));
        carry = first || second;
    }
    carry
}

fn check_multiply<const A: usize, const B: usize, const OUT: usize>(
    tally: &mut Tally,
    left: Signed<A>,
    right: Signed<B>,
) {
    assert!(canonical(&left) && canonical(&right));
    tally.cases += 1;
    if lowest_nonzero(&left) > 0 || lowest_nonzero(&right) > 0 {
        tally.skipped_low += 1;
    }
    let expected = reference_multiply::<A, B, OUT>(left, right);
    let actual = multiply::<A, B, OUT>(left, right);
    if actual != expected || !canonical(&actual) {
        tally.disagreements += 1;
        if tally.disagreements <= 3 {
            eprintln!("U1b multiply disagreement: left {left:?} right {right:?}");
        }
    }
}

fn check_ratios<
    const LN: usize,
    const LD: usize,
    const RN: usize,
    const RD: usize,
    const OUT: usize,
>(
    tally: &mut Tally,
    rng: &mut Rng,
    adversarial: bool,
) {
    // Numerators one limb short of their width keep both products and their difference inside
    // the comparison width, as the kernel's width proofs guarantee for real operands.
    let numerator_left = factor::<LN>(rng, adversarial, LN - 1);
    let numerator_right = if rng.chance(1, 4) {
        numerator_left.widen::<RN>()
    } else {
        factor::<RN>(rng, adversarial, RN - 1)
    };
    let weight_left = factor::<LD>(rng, adversarial, LD).absolute();
    let weight_right = if rng.chance(1, 4) {
        weight_left.widen::<RD>()
    } else {
        factor::<RD>(rng, adversarial, RD).absolute()
    };
    if weight_left.is_zero() || weight_right.is_zero() {
        return;
    }
    tally.cases += 1;
    if lowest_nonzero(&numerator_left) > 0 || lowest_nonzero(&weight_right) > 0 {
        tally.skipped_low += 1;
    }
    let expected = reference_compare_ratios::<LN, LD, RN, RD, OUT>(
        numerator_left,
        weight_left,
        numerator_right,
        weight_right,
    );
    let actual = compare_ratios::<LN, LD, RN, RD, OUT>(
        numerator_left,
        weight_left,
        numerator_right,
        weight_right,
    );
    if actual != expected {
        tally.disagreements += 1;
    }
}

fn factor<const N: usize>(rng: &mut Rng, adversarial: bool, max_used: usize) -> Signed<N> {
    if adversarial {
        adversarial_factor(rng, max_used)
    } else {
        pattern(rng, max_used)
    }
}

fn add_shape<const N: usize>(tally: &mut Tally, rng: &mut Rng, adversarial: bool) {
    let (left, right) = if adversarial {
        adversarial_pair::<N>(rng, N)
    } else {
        (pattern::<N>(rng, N), pattern::<N>(rng, N))
    };
    check_add(tally, left, right);
}

/// One product shape: operand widths up to the declared widths, with `used` sums that fit the
/// output (the capacity assertion is exercised separately).
fn multiply_shape<const A: usize, const B: usize, const OUT: usize>(
    tally: &mut Tally,
    rng: &mut Rng,
    adversarial: bool,
) {
    let left = factor::<A>(rng, adversarial, A.min(OUT - 1));
    let right = factor::<B>(rng, adversarial, (OUT - left.used).min(B));
    check_multiply::<A, B, OUT>(tally, left, right);
}

/// Every width the kernel instantiates (`fill_exact`, `fill_sections`, `simple_cubic_topology`).
fn add_cases(seed: u64, count: u64, adversarial: bool) -> Tally {
    let mut rng = Rng::new(seed);
    let mut tally = Tally::default();
    for index in 0..count {
        match index % 8 {
            0 => add_shape::<33>(&mut tally, &mut rng, adversarial),
            1 => add_shape::<34>(&mut tally, &mut rng, adversarial),
            2 => add_shape::<66>(&mut tally, &mut rng, adversarial),
            3 => add_shape::<68>(&mut tally, &mut rng, adversarial),
            4 => add_shape::<99>(&mut tally, &mut rng, adversarial),
            5 => add_shape::<132>(&mut tally, &mut rng, adversarial),
            6 => add_shape::<165>(&mut tally, &mut rng, adversarial),
            _ => add_shape::<231>(&mut tally, &mut rng, adversarial),
        }
    }
    tally
}

/// Every `multiply` instantiation in the kernel, including those reached by `compare_ratios`.
fn multiply_cases(seed: u64, count: u64, adversarial: bool) -> Tally {
    let mut rng = Rng::new(seed);
    let mut tally = Tally::default();
    for index in 0..count {
        let (r, t, a) = (&mut rng, &mut tally, adversarial);
        match index % 12 {
            0 => multiply_shape::<33, 33, 66>(t, r, a),
            1 => multiply_shape::<34, 34, 68>(t, r, a),
            2 => multiply_shape::<33, 66, 99>(t, r, a),
            3 => multiply_shape::<66, 33, 99>(t, r, a),
            4 => multiply_shape::<33, 99, 132>(t, r, a),
            5 => multiply_shape::<66, 99, 165>(t, r, a),
            6 => multiply_shape::<66, 66, 132>(t, r, a),
            7 => multiply_shape::<99, 66, 165>(t, r, a),
            8 => multiply_shape::<132, 99, 231>(t, r, a),
            9 => multiply_shape::<33, 33, 33>(t, r, a),
            10 => multiply_shape::<34, 34, 34>(t, r, a),
            _ => multiply_shape::<99, 99, 231>(t, r, a),
        }
    }
    tally
}

/// The `compare_ratios` instantiations of `fill_event_order` and `fill_sections`.
fn ratio_cases(seed: u64, count: u64, adversarial: bool) -> Tally {
    let mut rng = Rng::new(seed);
    let mut tally = Tally::default();
    for index in 0..count {
        if index % 2 == 0 {
            check_ratios::<99, 66, 99, 66, 165>(&mut tally, &mut rng, adversarial);
        } else {
            check_ratios::<132, 99, 132, 99, 231>(&mut tally, &mut rng, adversarial);
        }
    }
    tally
}

fn run_all(random: u64, adversarial: u64, shards: usize) -> [Tally; 6] {
    let mut totals = [Tally::default(); 6];
    let runners: [(u64, fn(u64, u64, bool) -> Tally); 3] = [
        (0x4230_5231_b100, add_cases),
        (0x4230_5231_b200, multiply_cases),
        (0x4230_5231_b300, ratio_cases),
    ];
    for (slot, (seed, runner)) in runners.into_iter().enumerate() {
        for [r, a] in parallel(shards, move |index| {
            [
                runner(seed + index as u64, share(random, shards, index), false),
                runner(
                    seed + 0x80 + index as u64,
                    share(adversarial, shards, index),
                    true,
                ),
            ]
        }) {
            totals[2 * slot].merge(r);
            totals[2 * slot + 1].merge(a);
        }
    }
    totals
}

fn assert_clean(totals: &[Tally; 6]) {
    for tally in totals {
        assert_eq!(tally.disagreements, 0, "{tally:?}");
        assert!(tally.cases > 0, "{tally:?}");
        assert!(tally.skipped_low > 0, "{tally:?}");
    }
}

// ---------------------------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------------------------

/// Smoke O1 for U1b: 10^4 random and 10^4 adversarial tuples per routine family.
#[test]
fn b0r_u1b_smoke_low_limb_skipping_matches_reference() {
    let totals = run_all(10_000, 10_000, 4);
    assert_clean(&totals);
}

/// Exhaustive small patterns: every 4-limb value with limbs drawn from {0, 1, 2^63, MAX}, both
/// signs, against every other, through `add`, both magnitude routines and `multiply`.
#[test]
fn b0r_u1b_exhaustive_small_limb_patterns() {
    const WORDS: [u64; 4] = [0, 1, 1u64 << 63, u64::MAX];
    let mut values: Vec<Signed<8>> = Vec::new();
    for code in 0..WORDS.len().pow(4) {
        let mut value = Signed::<8>::zero();
        let mut rest = code;
        for limb in &mut value.limbs[..4] {
            *limb = WORDS[rest % 4];
            rest /= 4;
        }
        for negative in [false, true] {
            values.push(finish(value, negative));
        }
    }
    let mut tally = Tally::default();
    for &left in &values {
        for &right in &values {
            check_add(&mut tally, left, right);
            check_multiply::<8, 8, 8>(&mut tally, left, right);
            check_multiply::<8, 8, 16>(&mut tally, left, right);
        }
    }
    assert_eq!(tally.disagreements, 0, "{tally:?}");
    assert!(tally.skipped_low > 0);
}

/// Named boundary fixtures: borrows through zero limbs, the subtrahend-zero copy case, carries
/// out of a copied prefix, products placed at the top of the declared width.
#[test]
fn b0r_u1b_boundary_fixtures() {
    let at = |entries: &[(usize, u64)]| {
        let mut value = Signed::<33>::zero();
        for &(index, word) in entries {
            value.limbs[index] = word;
        }
        finish(value, false)
    };
    let mut tally = Tally::default();
    // 2^(64*32) - 1: a borrow from the top limb through 31 zero limbs.
    let top = at(&[(32, 1)]);
    let one = at(&[(0, 1)]);
    check_add(&mut tally, top, one.negated());
    let all_ones = top.add(one.negated());
    assert_eq!(all_ones.used, 32);
    assert!(all_ones.limbs[..32].iter().all(|word| *word == u64::MAX));
    // Minuend nonzero below a zero-prefixed subtrahend: limbs 0..5 are copied.
    check_add(&mut tally, at(&[(0, 7), (9, 3)]), at(&[(5, 1)]).negated());
    // Subtrahend nonzero below a zero-prefixed minuend: the borrow loop starts at limb 0.
    check_add(&mut tally, at(&[(5, 1), (9, 3)]), at(&[(0, 7)]).negated());
    // Carry out of the copied prefix's top into the summed region.
    check_add(
        &mut tally,
        at(&[(0, u64::MAX), (1, u64::MAX), (2, u64::MAX)]),
        at(&[(2, 1)]),
    );
    // Equal magnitudes with a shared zero prefix cancel to canonical zero.
    let shared = at(&[(4, 9), (20, 1)]);
    assert_eq!(shared.add(shared.negated()), Signed::zero());
    check_add(&mut tally, shared, shared.negated());
    // Products with operands placed high: 33 x 33 -> 66 with both tops at limb 32.
    check_multiply::<33, 33, 66>(&mut tally, at(&[(32, u64::MAX)]), at(&[(32, u64::MAX)]));
    check_multiply::<33, 33, 66>(&mut tally, top, at(&[(31, 1u64 << 63), (32, 3)]));
    // The used sum OUT + 1 with a product that fits: the trim bound is OUT.
    check_multiply::<33, 33, 33>(&mut tally, at(&[(16, 1)]), at(&[(16, u64::MAX)]));
    assert_eq!(tally.disagreements, 0, "{tally:?}");
}

/// The capacity assertions fire for the same inputs as before, with the same message.
#[test]
fn b0r_u1b_capacity_assertions_unchanged() {
    let panics = |action: &(dyn Fn() + std::panic::RefUnwindSafe)| {
        std::panic::catch_unwind(action).err().map(|payload| {
            payload
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_default()
        })
    };
    let high = |index: usize, word: u64| {
        let mut value = Signed::<33>::zero();
        value.limbs[index] = word;
        finish(value, false)
    };
    let cases = [
        (high(16, u64::MAX), high(16, u64::MAX)),
        (high(16, 1u64 << 63), high(16, 2)),
        (high(16, 1u64 << 63), high(16, 1)),
        (high(17, 1), high(16, 1)),
    ];
    for (left, right) in cases {
        let actual = panics(&move || {
            multiply::<33, 33, 33>(left, right);
        });
        let expected = panics(&move || {
            reference_multiply::<33, 33, 33>(left, right);
        });
        assert_eq!(actual, expected, "{left:?} x {right:?}");
    }
    let mut full = Signed::<33>::zero();
    full.limbs.fill(u64::MAX);
    let full = finish(full, false);
    for addend in [high(0, 1), high(32, 1), high(20, 1)] {
        let actual = panics(&move || {
            full.add(addend);
        });
        let expected = panics(&move || {
            reference_add(full, addend);
        });
        assert_eq!(actual, expected);
        assert_eq!(
            actual.as_deref(),
            Some("integer addition capacity overflow")
        );
    }
}

/// The differential detects a skipping defect: a subtraction that also skips the subtrahend's
/// low limbs below the minuend's lowest nonzero limb (the borrow the contract forbids skipping).
#[test]
fn b0r_u1b_differential_detects_forbidden_borrow_skip() {
    fn defective<const N: usize>(larger: Signed<N>, smaller: Signed<N>) -> Signed<N> {
        let mut result = Signed::<N>::zero();
        result.used = larger.used;
        let start = lowest_nonzero(&larger).max(lowest_nonzero(&smaller));
        result.limbs[..start].copy_from_slice(&larger.limbs[..start]);
        let mut borrow = false;
        for index in start..larger.used {
            let (partial, first) = larger.limbs[index].overflowing_sub(smaller.limbs[index]);
            let (difference, second) = partial.overflowing_sub(u64::from(borrow));
            result.limbs[index] = difference;
            borrow = first || second;
        }
        if borrow {
            return Signed::zero();
        }
        reference_trim(&mut result);
        result
    }
    let mut rng = Rng::new(0x4230_5231_b400);
    let mut detected = 0u64;
    for _ in 0..10_000 {
        let (left, right) = adversarial_pair::<33>(&mut rng, 33);
        if left.is_zero() || right.is_zero() {
            continue;
        }
        let (larger, smaller) = match left.compare_magnitude(right) {
            Ordering::Less => (right.absolute(), left.absolute()),
            _ => (left.absolute(), right.absolute()),
        };
        if defective(larger, smaller) != reference_subtract_magnitudes(larger, smaller, false) {
            detected += 1;
        }
    }
    assert!(detected > 100, "{detected}");
}

/// Full O1 for U1b: 10^7 random and 10^6 adversarial tuples for each of `add`/`subtract`,
/// `multiply` and `compare_ratios`, in 16 fixed seeded shards.
#[test]
#[ignore = "B0R O1 full size; release profile via pnpm test:p3-fill-identity"]
fn b0r_oracle_full_u1b_fill_exact() {
    let start = Instant::now();
    let totals = run_all(10_000_000, 1_000_000, ORACLE_SHARDS);
    println!(
        "B0R O1 U1b fill_exact ({ORACLE_SHARDS} shards, {:.1} s): add/sub random {:?} adversarial {:?}; multiply random {:?} adversarial {:?}; compare_ratios random {:?} adversarial {:?}",
        start.elapsed().as_secs_f64(),
        totals[0],
        totals[1],
        totals[2],
        totals[3],
        totals[4],
        totals[5]
    );
    assert_clean(&totals);
}
