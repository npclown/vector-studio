//! B0R shared filter module (docs/plans/p3-b0r-kernel-performance-contract.md sections 3.2-3.4).
//!
//! A filter proves the sign of an exact quantity from binary64 interval arithmetic, or reports
//! that it cannot decide. Callers then run their unchanged exact routine once. Soundness rests
//! only on the arithmetic facts R1-R3 of section 3.2:
//!
//! - R1, outward rounding: for a finite round-to-nearest result r = fl(z) of one operation on
//!   finite operands, `next_down(r) <= z <= next_up(r)`, also in the subnormal range.
//! - R2, interval inclusion: closed-interval addition, subtraction, multiplication and division
//!   by an interval excluding zero, with each computed endpoint widened by R1, contain the exact
//!   result for all operands in the input intervals (Moore 1966; IEEE 1788-2015 containment).
//! - R3, decision: a strictly positive lower endpoint proves a positive value, a strictly
//!   negative upper endpoint a negative one. NaN or infinite endpoints, and intervals containing
//!   zero, leave the filter undecided, so a filter never returns `Equal`.
//!
//! Every operation here is an IEEE 754 binary64 round-to-nearest operation, `f64::next_up`,
//! `f64::next_down`, an integer-to-float conversion or bit manipulation, which wasm32 defines
//! identically to native targets. Rust never contracts `a * b + c` into a fused multiply-add.
//!
//! The `cfg(test)` decided/fallback counters and fault switches are thread-locals that exist
//! only in test builds; release, WASM and `p3_b0_diag` builds compile them to nothing.
use core::cmp::Ordering;

use crate::fill_exact::Signed;

/// A closed binary64 interval `[lo, hi]`. NaN endpoints mark an undecidable result.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Interval {
    pub(crate) lo: f64,
    pub(crate) hi: f64,
}

/// The undecidable interval: every R3 decision on it returns `None`.
pub(crate) const UNDECIDED: Interval = Interval {
    lo: f64::NAN,
    hi: f64::NAN,
};

impl Interval {
    /// The exact one-point interval of a finite binary64 value.
    pub(crate) fn point(value: f64) -> Self {
        if value.is_finite() {
            Self {
                lo: value,
                hi: value,
            }
        } else {
            UNDECIDED
        }
    }

    pub(crate) fn is_finite(self) -> bool {
        self.lo.is_finite() && self.hi.is_finite()
    }

    /// R1: widen computed endpoints outward by one ulp each. A non-finite endpoint makes the
    /// result undecidable, so no later operation can mix it with finite values.
    fn rounded(lo: f64, hi: f64) -> Self {
        if !lo.is_finite() || !hi.is_finite() {
            return UNDECIDED;
        }
        if fault_active(Fault::R1WideningRemoved) {
            return Self { lo, hi };
        }
        Self {
            lo: lo.next_down(),
            hi: hi.next_up(),
        }
    }

    pub(crate) fn add(self, other: Self) -> Self {
        if !self.is_finite() || !other.is_finite() {
            return UNDECIDED;
        }
        Self::rounded(self.lo + other.lo, self.hi + other.hi)
    }

    pub(crate) fn sub(self, other: Self) -> Self {
        if !self.is_finite() || !other.is_finite() {
            return UNDECIDED;
        }
        Self::rounded(self.lo - other.hi, self.hi - other.lo)
    }

    pub(crate) fn mul(self, other: Self) -> Self {
        if !self.is_finite() || !other.is_finite() {
            return UNDECIDED;
        }
        let products = [
            self.lo * other.lo,
            self.lo * other.hi,
            self.hi * other.lo,
            self.hi * other.hi,
        ];
        extreme_rounded(products)
    }

    /// R2 division; the divisor interval must exclude zero, otherwise undecidable.
    pub(crate) fn div(self, other: Self) -> Self {
        if !self.is_finite() || !other.is_finite() || !(other.lo > 0.0 || other.hi < 0.0) {
            return UNDECIDED;
        }
        let quotients = [
            self.lo / other.lo,
            self.lo / other.hi,
            self.hi / other.lo,
            self.hi / other.hi,
        ];
        extreme_rounded(quotients)
    }

    /// R3: the sign of every value in the interval, when it is the same nonzero sign.
    pub(crate) fn sign(self) -> Option<Ordering> {
        if !self.is_finite() {
            None
        } else if self.lo > 0.0 {
            Some(Ordering::Greater)
        } else if self.hi < 0.0 {
            Some(Ordering::Less)
        } else {
            None
        }
    }
}

fn extreme_rounded(values: [f64; 4]) -> Interval {
    if values.iter().any(|value| !value.is_finite()) {
        return UNDECIDED;
    }
    let mut lo = values[0];
    let mut hi = values[0];
    for value in &values[1..] {
        lo = lo.min(*value);
        hi = hi.max(*value);
    }
    Interval::rounded(lo, hi)
}

/// R3 for a comparison: disjoint enclosures decide the order of the enclosed values.
pub(crate) fn compare_enclosures(left: Interval, right: Interval) -> Option<Ordering> {
    if !left.is_finite() || !right.is_finite() {
        None
    } else if left.hi < right.lo {
        Some(Ordering::Less)
    } else if left.lo > right.hi {
        Some(Ordering::Greater)
    } else {
        None
    }
}

/// The trimmed invariant of `fill_exact`: `used == 0` exactly for zero, and otherwise the top
/// used limb is nonzero (`trim`, maintained by `from_finite`, `multiply`, `add`, `shift_right`).
pub(crate) fn is_trimmed<const N: usize>(value: &Signed<N>) -> bool {
    value.used <= N && (value.used == 0 || value.limbs[value.used - 1] != 0)
}

/// Section 3.3 step 2: the top two used limbs as `m` and the limb index of the lowest limb
/// read, or `None` if the trimmed invariant fails (it never reads past `used`).
pub(crate) fn top_limbs<const N: usize>(value: &Signed<N>) -> Option<(u128, usize)> {
    if !is_trimmed(value) || value.used == 0 {
        return None;
    }
    let used = value.used;
    if used == 1 {
        return Some((u128::from(value.limbs[0]), 0));
    }
    Some((
        (u128::from(value.limbs[used - 1]) << 64) | u128::from(value.limbs[used - 2]),
        used - 2,
    ))
}

fn power_of_two(exponent: i32) -> f64 {
    debug_assert!((-1022..=1023).contains(&exponent));
    f64::from_bits(((exponent + 1023) as u64) << 52)
}

/// Section 3.3: `lo <= value * 2^-unit_exponent <= hi`, or `None`.
///
/// 1. Zero gives (0, 0).
/// 2. Otherwise m is the top two used limbs (one if `used == 1`) and e the binary exponent of
///    the lowest limb read minus `unit_exponent`. Truncating lower limbs gives
///    `m * 2^e <= |value| * 2^-unit_exponent < (m + 1) * 2^e`; with two limbs read, m >= 2^64
///    by the trimmed invariant, so the truncation error is below 2^-64 relative.
/// 3. `m as f64` rounds to nearest; the power-of-two scaling is exact when the final result is
///    a normal finite number, because every intermediate lies between the start value (>= 1)
///    and the end value and is therefore normal too. Otherwise `None`.
/// 4. Two ulps on each side cover the truncation (below 2^-64 relative) plus the conversion
///    rounding (half an ulp), also when r is a power of two and the gap below it is half the
///    gap above. The sign is applied last.
pub(crate) fn enclose<const N: usize>(value: &Signed<N>, unit_exponent: i32) -> Option<Interval> {
    debug_assert!(is_trimmed(value), "enclose requires a trimmed Signed value");
    if value.used == 0 {
        return Some(Interval { lo: 0.0, hi: 0.0 });
    }
    let (m, low_limb) = top_limbs(value)?;
    let mut exponent = i32::try_from(low_limb).ok()?.checked_mul(64)? - unit_exponent;
    let mut r = m as f64;
    while exponent > 1023 {
        r *= power_of_two(1023);
        exponent -= 1023;
    }
    while exponent < -1022 {
        r *= power_of_two(-1022);
        exponent += 1022;
    }
    r *= power_of_two(exponent);
    if !r.is_normal() {
        return None;
    }
    let (lo, hi) = if fault_active(Fault::EnclosureWideningRemoved) {
        (r, r)
    } else {
        (r.next_down().next_down(), r.next_up().next_up())
    };
    Some(if value.negative {
        Interval { lo: -hi, hi: -lo }
    } else {
        Interval { lo, hi }
    })
}

fn bit_length<const N: usize>(value: &Signed<N>) -> Option<i32> {
    top_limbs(value)?;
    let used = i32::try_from(value.used).ok()?;
    Some(64 * (used - 1) + (64 - value.limbs[value.used - 1].leading_zeros() as i32))
}

/// Section 3.4: an enclosure of value(N, W) = (N / W) * 2^-1074 for W > 0, independent of any
/// common shift `normalize` applied to N and W.
///
/// With b the bit length of W, W is enclosed with unit exponent b (W' in [1/2, 1) up to the
/// widening) and N with unit exponent b + 1074. The quotient N'/W' equals value(N, W) and is not
/// rescaled, so no intermediate leaves the represented value's own magnitude: for example
/// N = 100 * 2^1074, W = 1 gives b = 1, N' = 50, W' = 1/2 and the quotient 100.
pub(crate) fn enclose_ratio<const NN: usize, const NW: usize>(
    numerator: &Signed<NN>,
    weight: &Signed<NW>,
) -> Option<Interval> {
    if weight.negative || weight.used == 0 {
        return None;
    }
    let bits = bit_length(weight)?;
    let numerator_unit = if fault_active(Fault::RatioFixedNumeratorUnit) {
        1074
    } else {
        bits.checked_add(1074)?
    };
    let weight_enclosure = enclose(weight, bits)?;
    let numerator_enclosure = enclose(numerator, numerator_unit)?;
    let quotient = numerator_enclosure.div(weight_enclosure);
    quotient.is_finite().then_some(quotient)
}

/// Filter identities for the `cfg(test)` decided/fallback counters (oracles O1 and O2). U1's
/// topology filters come first; later B0R units add their own identities after them.
#[allow(clippy::enum_variant_names)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FilterId {
    /// F0.1, topology `orient` with two equal points.
    TopologyOrientIdentity,
    /// F2.1, topology `orient`.
    TopologyOrient,
    /// F2.1 and F2.4, the cross sign of two exact vectors (`transverse_orientation`).
    TopologyCrossSign,
    /// F2.2, one dot sign of a point difference with a direction.
    TopologyDotSign,
    /// F2.2, the three-term `total` of `rounded_projected_monotone`.
    TopologyDotTotal,
    /// F2.3, `compare_coordinate` (and through it `compare_points`, `between_closed`).
    TopologyCompareCoordinate,
    /// F0.2, `fill_predicates` orientation with two equal points (`same_point`).
    PredicateOrientIdentity,
    /// F1, the static filter for the orientation of binary64 points.
    PredicateOrient,
    /// F0.3, `segment_relation` with disjoint closed segment boxes.
    SegmentBoxes,
    /// F0.4, an event comparison of two `Endpoint` events.
    EventEndpoints,
    /// F2.5, an event comparison involving a crossing, decided on enclosed x coordinates.
    EventCrossingX,
    /// F0.5, a column or section whose exact value is a binary64 endpoint coordinate, compared
    /// with a binary64 value or with another such coordinate.
    EndpointValue,
    /// F0.6, `compare_columns` or `compare_sections` with identical representations.
    RepresentationIdentity,
    /// F2.6, `compare_columns` and `compare_column_f64` on ratio enclosures (section 3.4).
    ColumnRatio,
    /// F2.7, `compare_sections` and `compare_section_f64` on ratio enclosures (section 3.4).
    SectionRatio,
    /// F2.8, the half-budget predicates on a ratio enclosure (section 3.4).
    HalfBudget,
    /// T1 and T4, a crossing column compared with a binary64 value, enclosed from its points.
    LazyColumn,
    /// T1, two sections compared on enclosures from their defining binary64 data.
    LazySection,
    /// T2, an `embed_scalar` bisection step decided by the target's per-call enclosure.
    EmbedStep,
    /// T2 with F2.8, a window-search step decided by the target's per-call enclosure.
    EmbedHalfStep,
}

/// The number of U1 topology filter identities, the first variants of `FilterId`. U1's test
/// files iterate over exactly these, so the count keeps its U1 value.
pub(crate) const FILTER_COUNT: usize = 6;

/// The number of U3 binary64-input filter identities, which follow the topology ones.
pub(crate) const BINARY64_FILTER_COUNT: usize = 5;

/// The number of U4 column and section filter identities, which follow the U3 ones.
pub(crate) const SECTION_FILTER_COUNT: usize = 9;

#[cfg(test)]
const COUNTER_SLOTS: usize = FILTER_COUNT + BINARY64_FILTER_COUNT + SECTION_FILTER_COUNT;

/// Fault switches of oracle O8 that act inside this module.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Fault {
    /// O8 (1): R1 widening removed from the interval operations.
    R1WideningRemoved,
    /// O8 (1), enclosure part: the two-ulp widening of section 3.3 step 4 removed.
    EnclosureWideningRemoved,
    /// O8 (7): ratio enclosure using a fixed numerator unit instead of section 3.4.
    RatioFixedNumeratorUnit,
    /// O8 (2): the F1 error bound multiplied by 0.5.
    F1BoundHalved,
}

#[cfg(test)]
thread_local! {
    static COUNTERS: core::cell::Cell<[[u64; 2]; COUNTER_SLOTS]> =
        const { core::cell::Cell::new([[0; 2]; COUNTER_SLOTS]) };
    static FAULT: core::cell::Cell<Option<Fault>> = const { core::cell::Cell::new(None) };
    static SHADOW: core::cell::Cell<bool> = const { core::cell::Cell::new(false) };
    static SHADOW_TALLY: core::cell::Cell<ShadowTally> =
        const { core::cell::Cell::new(ShadowTally { checks: 0, mismatches: 0 }) };
}

/// Oracle O10, tessellation shadow mode for U4 (T1, T2, T4 and F2.6-F2.8): every filtered or
/// lazy decision also computes the eager exact value and records whether the two are equal.
#[cfg(test)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ShadowTally {
    pub(crate) checks: u64,
    pub(crate) mismatches: u64,
}

#[cfg(test)]
impl ShadowTally {
    pub(crate) fn merge(&mut self, other: Self) {
        self.checks += other.checks;
        self.mismatches += other.mismatches;
    }
}

/// Whether shadow mode is on in this thread (test builds only).
#[cfg(test)]
pub(crate) fn shadow_active() -> bool {
    SHADOW.with(core::cell::Cell::get)
}

/// Records one shadow comparison of a filtered or lazy decision with the eager exact one.
#[cfg(test)]
pub(crate) fn shadow_check(equal: bool) {
    SHADOW_TALLY.with(|tally| {
        let mut value = tally.get();
        value.checks += 1;
        value.mismatches += u64::from(!equal);
        tally.set(value);
    });
}

/// Runs `action` with shadow mode on in this thread, then switches it off.
#[cfg(test)]
pub(crate) fn with_shadow<T>(action: impl FnOnce() -> T) -> T {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            SHADOW.with(|active| active.set(false));
        }
    }
    SHADOW.with(|active| active.set(true));
    let _reset = Reset;
    action()
}

/// Returns and resets this thread's shadow tally.
#[cfg(test)]
pub(crate) fn take_shadow_tally() -> ShadowTally {
    SHADOW_TALLY.with(|tally| tally.replace(ShadowTally::default()))
}

/// Counts one filter call as decided or as fallen back (this thread, test builds only).
#[cfg(test)]
pub(crate) fn record(id: FilterId, decided: bool) {
    COUNTERS.with(|counters| {
        let mut value = counters.get();
        value[id as usize][usize::from(!decided)] += 1;
        counters.set(value);
    });
}

#[cfg(not(test))]
#[inline(always)]
pub(crate) fn record(_id: FilterId, _decided: bool) {}

#[cfg(test)]
pub(crate) fn fault_active(fault: Fault) -> bool {
    FAULT.with(|active| active.get() == Some(fault))
}

#[cfg(not(test))]
#[inline(always)]
pub(crate) fn fault_active(_fault: Fault) -> bool {
    false
}

/// Resets this thread's counters.
#[cfg(test)]
pub(crate) fn reset_counters() {
    COUNTERS.with(|counters| counters.set([[0; 2]; COUNTER_SLOTS]));
}

/// This thread's (decided, fallback) counts for one filter.
#[cfg(test)]
pub(crate) fn counts(id: FilterId) -> (u64, u64) {
    COUNTERS.with(|counters| {
        let value = counters.get()[id as usize];
        (value[0], value[1])
    })
}

/// Runs `action` with one fault switched on in this thread, then switches it off.
#[cfg(test)]
pub(crate) fn with_fault<T>(fault: Fault, action: impl FnOnce() -> T) -> T {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            FAULT.with(|active| active.set(None));
        }
    }
    FAULT.with(|active| active.set(Some(fault)));
    let _reset = Reset;
    action()
}
