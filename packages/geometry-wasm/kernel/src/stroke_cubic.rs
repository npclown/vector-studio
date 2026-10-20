//! P3 B2 stroke front end for cubic segments, unit ST-U4.
//!
//! The frozen contract is `docs/plans/p3-b2-stroke-contract.md`: the exact stationary
//! classification of section 4.6 and the cubic leaf test of section 4.5, with the guards ST-G4
//! and ST-G5 as ST-U4 proves and tightens them (plan entry "B2 ST-U4 cubic stroke"). The
//! emission itself lives in `stroke_outline.rs`.
//!
//! Arithmetic (section 4.2): binary64 `+ - * /` and `sqrt` only, plus exact `Signed`
//! integer arithmetic for every classification decision. No epsilon decides a class.

use core::cmp::Ordering;

use crate::fill_exact::{multiply, Signed, COORDINATE_LIMBS, LINE_LIMBS};
use crate::geometry::Point;
use crate::stroke_outline::FrontEndError;

/// `Signed` widths by polynomial degree in binary64 inputs (each `COORDINATE_LIMBS` limbs).
const DEGREE_1: usize = COORDINATE_LIMBS;
const DEGREE_2: usize = LINE_LIMBS;
const DEGREE_3: usize = 3 * COORDINATE_LIMBS;
const DEGREE_4: usize = 4 * COORDINATE_LIMBS;
const DEGREE_5: usize = 5 * COORDINATE_LIMBS;
const DEGREE_6: usize = 6 * COORDINATE_LIMBS + 2;
const _: () = assert!(DEGREE_2 >= 2 * COORDINATE_LIMBS);

const UNIT: f64 = 1.0 / 9_007_199_254_740_992.0; // 2^-53
const SLACK_UP: f64 = 1.0 + 1.0 / 1_099_511_627_776.0; // 1 + 2^-40
const SLACK_DOWN: f64 = 1.0 - 1.0 / 1_099_511_627_776.0; // 1 - 2^-40

/// Section 4.5: leaf subdivision depth limit per cubic range.
pub(crate) const MAX_LEAF_DEPTH: u32 = 20;
/// ST-U4 range condition for a non-collinear cubic: `2^-250 <= M <= 2^250`, so that the
/// leaf test's products neither overflow nor lose the absolute guard `768 u M^2` to underflow.
const MIN_CUBIC_MAGNITUDE: f64 = f64::from_bits((1023 - 250) << 52); // 2^-250
const MAX_CUBIC_MAGNITUDE: f64 = f64::from_bits((1023 + 250) << 52); // 2^250
/// `2^-500`, added to `|V|` so that its rounding (or underflow) never lowers a guard.
const LENGTH_FLOOR: f64 = f64::from_bits((1023 - 500) << 52);

/// Exact stationary classification of one remaining cubic (section 4.6).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) enum CubicClass {
    /// No stationary parameter in `[0, 1]`.
    #[default]
    Regular,
    /// The hodograph's common root is `t = 0` (`P1 = P0`): reduced cone on the first leaf.
    StationaryStart,
    /// The common root is `t = 1` (`P2 = P3`): reduced cone on the last leaf.
    StationaryEnd,
    /// An interior reversal at the rational `t*`; `split` is the largest binary64 `<= t*`.
    Cusp { split: f64 },
    /// Every control on one line: sweeps between the end points and the odd-order roots of the
    /// projected derivative (`turning[..count]`, the largest binary64 at or below each root).
    Collinear { turning: [f64; 2], count: usize },
}

impl CubicClass {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Regular => "regular",
            Self::StationaryStart | Self::StationaryEnd => "endpoint-stationary",
            Self::Cusp { .. } => "cusp",
            Self::Collinear { .. } => "collinear",
        }
    }
}

type Exact = (Signed<DEGREE_1>, Signed<DEGREE_1>);

fn difference(to: f64, from: f64) -> Signed<DEGREE_1> {
    Signed::<DEGREE_1>::from_finite(to).add(Signed::from_finite(from).negated())
}

fn vector(from: Point, to: Point) -> Exact {
    (difference(to.x, from.x), difference(to.y, from.y))
}

fn twice(value: Signed<DEGREE_1>) -> Signed<DEGREE_1> {
    value.add(value)
}

fn product(a: Signed<DEGREE_1>, b: Signed<DEGREE_1>) -> Signed<DEGREE_2> {
    multiply::<DEGREE_1, DEGREE_1, DEGREE_2>(a, b)
}

fn cross(u: Exact, v: Exact) -> Signed<DEGREE_2> {
    product(u.0, v.1).add(product(u.1, v.0).negated())
}

fn dot(u: Exact, v: Exact) -> Signed<DEGREE_2> {
    product(u.0, v.0).add(product(u.1, v.1))
}

fn reverse(order: Ordering, negative: bool) -> Ordering {
    if negative {
        order.reverse()
    } else {
        order
    }
}

/// An exact root of the hodograph or of the projected derivative.
/// A stack value only (no allocation in `process`), so the variants keep their sizes.
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Copy, Debug)]
enum Root {
    /// `t* = numerator / denominator`, both of degree 2.
    Ratio {
        numerator: Signed<DEGREE_2>,
        denominator: Signed<DEGREE_2>,
    },
    /// `t* = (-b + sigma sqrt(disc)) / (2a)`, `a`, `b` of degree 2 and `disc > 0` of degree 4.
    Quadratic {
        a: Signed<DEGREE_2>,
        b: Signed<DEGREE_2>,
        disc: Signed<DEGREE_4>,
        positive: bool,
    },
}

impl Root {
    /// `sign(t - t*)` for a binary64 `t`, decided exactly.
    fn compare(self, t: f64) -> Ordering {
        // A binary64 `t` is the integer `t 2^1074` of degree 1; `one` lifts degree-2 terms.
        let parameter = Signed::<DEGREE_1>::from_finite(t);
        let one = Signed::<DEGREE_1>::from_finite(1.0);
        match self {
            Self::Ratio {
                numerator,
                denominator,
            } => {
                let scaled = multiply::<DEGREE_1, DEGREE_2, DEGREE_3>(parameter, denominator);
                let lifted = multiply::<DEGREE_2, DEGREE_1, DEGREE_3>(numerator, one);
                reverse(
                    scaled.add(lifted.negated()).cmp_zero(),
                    denominator.is_negative(),
                )
            }
            Self::Quadratic {
                a,
                b,
                disc,
                positive,
            } => {
                // t - t* = (2a t + b - sigma sqrt(disc)) / (2a).
                let x = multiply::<DEGREE_2, DEGREE_1, DEGREE_3>(a.add(a), parameter)
                    .add(multiply::<DEGREE_2, DEGREE_1, DEGREE_3>(b, one));
                let y = multiply::<DEGREE_4, DEGREE_2, DEGREE_6>(
                    disc,
                    multiply::<DEGREE_1, DEGREE_1, DEGREE_2>(one, one),
                );
                let x_squared = multiply::<DEGREE_3, DEGREE_3, DEGREE_6>(x, x);
                let numerator = if positive {
                    // x - sqrt(y)
                    if x.cmp_zero() != Ordering::Greater {
                        if x.is_zero() && y.is_zero() {
                            Ordering::Equal
                        } else {
                            Ordering::Less
                        }
                    } else {
                        x_squared.add(y.negated()).cmp_zero()
                    }
                } else if x.cmp_zero() != Ordering::Less {
                    // x + sqrt(y)
                    if x.is_zero() && y.is_zero() {
                        Ordering::Equal
                    } else {
                        Ordering::Greater
                    }
                } else {
                    y.add(x_squared.negated()).cmp_zero()
                };
                reverse(numerator, a.is_negative())
            }
        }
    }

    /// Strictly inside `(0, 1)`.
    fn interior(self) -> bool {
        self.compare(0.0) == Ordering::Less && self.compare(1.0) == Ordering::Greater
    }

    /// The largest binary64 `t̃ <= t*`, for `t*` in `(0, 1)`, by bisection on the bit
    /// patterns of `[0, 1]` (monotone for nonnegative values). `|t̃ - t*| <= 2^-53`.
    fn below(self) -> f64 {
        let mut low = 0u64;
        let mut high = 1.0f64.to_bits();
        while high - low > 1 {
            let middle = low + (high - low) / 2;
            if self.compare(f64::from_bits(middle)) == Ordering::Greater {
                high = middle;
            } else {
                low = middle;
            }
        }
        f64::from_bits(low)
    }
}

/// Section 4.6 on the Float64 controls, every decision exact. `Err(NumericRange)` for the
/// ST-U4 range condition of a non-collinear cubic or a reversal below the smallest subnormal.
pub(crate) fn classify_cubic(p: [Point; 4]) -> Result<CubicClass, FrontEndError> {
    let d0 = vector(p[0], p[1]);
    let d1 = vector(p[1], p[2]);
    let d2 = vector(p[2], p[3]);
    // C'(t)/3 = A t^2 + B t + C per component: A = d0 - 2 d1 + d2, B = 2 (d1 - d0), C = d0.
    let coefficient = |k: usize| {
        let (a, b, c) = match k {
            0 => (d0.0, d1.0, d2.0),
            _ => (d0.1, d1.1, d2.1),
        };
        (
            a.add(twice(b).negated()).add(c),
            twice(b.add(a.negated())),
            a,
        )
    };
    let (ax, bx, cx) = coefficient(0);
    let (ay, by, cy) = coefficient(1);
    let e1 = vector(p[0], p[1]);
    let e2 = vector(p[0], p[2]);
    let e3 = vector(p[0], p[3]);
    let collinear = cross(e1, e2).is_zero() && cross(e1, e3).is_zero() && cross(e2, e3).is_zero();
    if collinear {
        let direction = [e1, e2, e3]
            .into_iter()
            .find(|d| !(d.0.is_zero() && d.1.is_zero()))
            .ok_or(FrontEndError::Invariant)?;
        // Projected derivative p(t)/3 = Ap t^2 + Bp t + Cp.
        let ap = dot((ax, ay), direction);
        let bp = dot((bx, by), direction);
        let cp = dot((cx, cy), direction);
        let mut turning = [0.0; 2];
        let mut count = 0usize;
        if !ap.is_zero() {
            let four_ac = multiply::<DEGREE_2, DEGREE_2, DEGREE_4>(ap, cp);
            let four_ac = four_ac.add(four_ac);
            let four_ac = four_ac.add(four_ac);
            let disc = multiply::<DEGREE_2, DEGREE_2, DEGREE_4>(bp, bp).add(four_ac.negated());
            // disc = 0 is a double root (an even-order continuation): nothing (ST-S8).
            if disc.cmp_zero() == Ordering::Greater {
                // Increasing order: with a > 0 the root with -sqrt comes first.
                let order = if ap.is_negative() {
                    [true, false]
                } else {
                    [false, true]
                };
                for positive in order {
                    let root = Root::Quadratic {
                        a: ap,
                        b: bp,
                        disc,
                        positive,
                    };
                    if root.interior() {
                        turning[count] = root.below();
                        count += 1;
                    }
                }
            }
        } else if !bp.is_zero() {
            let root = Root::Ratio {
                numerator: cp.negated(),
                denominator: bp,
            };
            if root.interior() {
                turning[0] = root.below();
                count = 1;
            }
        }
        if turning[..count].iter().any(|t| *t <= 0.0) {
            return Err(FrontEndError::NumericRange);
        }
        return Ok(CubicClass::Collinear { turning, count });
    }
    let magnitude = p
        .iter()
        .fold(0.0f64, |m, point| m.max(point.x.abs()).max(point.y.abs()));
    if !(MIN_CUBIC_MAGNITUDE..=MAX_CUBIC_MAGNITUDE).contains(&magnitude) {
        return Err(FrontEndError::NumericRange);
    }
    // Not collinear, so Dx and Dy are not proportional: a common root is t* = -v/u with
    // u = Ax By - Ay Bx and v = Ax Cy - Ay Cx, and u = 0 leaves none (section 4.6 case 3).
    let u = product(ax, by).add(product(ay, bx).negated());
    if u.is_zero() {
        return Ok(CubicClass::Regular);
    }
    let v = product(ax, cy).add(product(ay, cx).negated());
    // D(t*) u^2 = A v^2 - B v u + C u^2 for each component.
    let v_squared = multiply::<DEGREE_2, DEGREE_2, DEGREE_4>(v, v);
    let u_squared = multiply::<DEGREE_2, DEGREE_2, DEGREE_4>(u, u);
    let vanishes = |a: Signed<DEGREE_1>, b: Signed<DEGREE_1>, c: Signed<DEGREE_1>| {
        let first = multiply::<DEGREE_1, DEGREE_4, DEGREE_5>(a, v_squared);
        let middle = multiply::<DEGREE_3, DEGREE_2, DEGREE_5>(
            multiply::<DEGREE_1, DEGREE_2, DEGREE_3>(b, v),
            u,
        );
        let last = multiply::<DEGREE_1, DEGREE_4, DEGREE_5>(c, u_squared);
        first.add(middle.negated()).add(last).is_zero()
    };
    if !(vanishes(ax, bx, cx) && vanishes(ay, by, cy)) {
        return Ok(CubicClass::Regular);
    }
    let root = Root::Ratio {
        numerator: v.negated(),
        denominator: u,
    };
    let at_start = root.compare(0.0);
    let at_end = root.compare(1.0);
    if at_start == Ordering::Greater || at_end == Ordering::Less {
        return Ok(CubicClass::Regular);
    }
    if at_start == Ordering::Equal {
        return Ok(CubicClass::StationaryStart);
    }
    if at_end == Ordering::Equal {
        return Ok(CubicClass::StationaryEnd);
    }
    let split = root.below();
    if split <= 0.0 {
        return Err(FrontEndError::NumericRange);
    }
    Ok(CubicClass::Cusp { split })
}

/// ST-G5 (section 4.6): `eta = 64 u M` bounds `|C(t̃) - C(t*)|` for the de Casteljau
/// evaluation at the split `t̃` (proof in the plan entry); the requirement is
/// `2 eta <= 2^(e-4)`.
pub(crate) fn stationary_guard(magnitude: f64, sixteenth: f64) -> bool {
    2.0 * (64.0 * UNIT * magnitude) <= sixteenth
}

fn lerp(a: Point, b: Point, t: f64) -> Point {
    Point {
        x: a.x + t * (b.x - a.x),
        y: a.y + t * (b.y - a.y),
    }
}

fn middle(a: Point, b: Point) -> Point {
    Point {
        x: (a.x + b.x) * 0.5,
        y: (a.y + b.y) * 0.5,
    }
}

/// De Casteljau at a binary64 `t`: the left and right controls, sharing the split point.
pub(crate) fn split_at(q: [Point; 4], t: f64) -> ([Point; 4], [Point; 4]) {
    let a = lerp(q[0], q[1], t);
    let b = lerp(q[1], q[2], t);
    let c = lerp(q[2], q[3], t);
    let ab = lerp(a, b, t);
    let bc = lerp(b, c, t);
    let point = lerp(ab, bc, t);
    ([q[0], a, ab, point], [point, bc, c, q[3]])
}

/// Midpoint de Casteljau split (section 4.5).
pub(crate) fn split_half(q: [Point; 4]) -> ([Point; 4], [Point; 4]) {
    let a = middle(q[0], q[1]);
    let b = middle(q[1], q[2]);
    let c = middle(q[2], q[3]);
    let ab = middle(a, b);
    let bc = middle(b, c);
    let point = middle(ab, bc);
    ([q[0], a, ab, point], [point, bc, c, q[3]])
}

/// `C(t)` by de Casteljau at a binary64 `t`.
pub(crate) fn evaluate(q: [Point; 4], t: f64) -> Point {
    split_at(q, t).0[3]
}

fn sub(a: Point, b: Point) -> Point {
    Point {
        x: a.x - b.x,
        y: a.y - b.y,
    }
}

fn scale3(a: Point) -> Point {
    Point {
        x: 3.0 * a.x,
        y: 3.0 * a.y,
    }
}

fn norm(a: Point) -> f64 {
    (a.x * a.x + a.y * a.y).sqrt()
}

/// One leaf's context for the test of section 4.5.
#[derive(Clone, Copy, Debug)]
pub(crate) struct LeafContext {
    /// `M`: the largest coordinate magnitude among the segment's source controls.
    pub(crate) magnitude: f64,
    pub(crate) r: f64,
    /// `2^e`.
    pub(crate) full: f64,
    /// ST-G1 `g_off` of the path.
    pub(crate) g_off: f64,
    /// The range comes from the split at a reversal (its controls carry that split's error).
    pub(crate) split_range: bool,
    /// The leaf's start or end is a stationary parameter (reduced cone).
    pub(crate) stationary_start: bool,
    pub(crate) stationary_end: bool,
    /// The leaf's start triple is fixed before the test, with its normal error bound: a source
    /// end (0) or the previous leaf's end. `None`: this leaf computes it (after a reversal).
    pub(crate) start_error: Option<f64>,
    /// The leaf's end is a source end: its triple is the source triple (normal error 0).
    pub(crate) end_fixed: bool,
    /// The binary64 length of the leaf's parameter interval, for leaves next to a reversal
    /// split, else 0 (ST-U4's reparameterization term).
    pub(crate) split_length: f64,
    /// 4 in production; 2 under the ST-D8 seeded defect.
    pub(crate) factor: f64,
}

/// The test's outcome and the directions of an accepted leaf's computed end normals.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct LeafMeasure {
    pub(crate) accepted: bool,
    pub(crate) start_direction: Point,
    pub(crate) end_direction: Point,
    /// Normal error bounds of the leaf's start and end triples.
    pub(crate) start_error: f64,
    pub(crate) end_error: f64,
}

fn first_nonzero(candidates: [Point; 2]) -> Point {
    if candidates[0].x != 0.0 || candidates[0].y != 0.0 {
        candidates[0]
    } else {
        candidates[1]
    }
}

/// Section 4.5's leaf test with ST-U4's guards (all only larger than the frozen ones):
///
/// ```text
/// eps    = (4 l + 16 s) u M                       control error per coordinate
/// aLow   = a (1 - 2^-40) - 768 u M^2 - 20 eps |V|
/// bUp    = b (1 + 2^-40) + 768 u M^2 + 20 eps |V|
/// dN     = (18 eps |V| + [split end] 600 u M^2) / aLow + 8u      computed normal error
/// gCtrl  = 4 l u M (1 + 12 r |V| / aLow) + 5 eps + 3 r max(dN_start, dN_end)
/// accept iff deltaUp + 4 r sinUp + gCtrl + gOff + kappa (|V| + 2r) <= 2^e (1 - 2^-40)
/// ```
pub(crate) fn measure_leaf(q: [Point; 4], depth: u32, context: LeafContext) -> LeafMeasure {
    let rejected = LeafMeasure::default();
    let third = |a: Point, b: Point, c: Point| Point {
        // c - (2a + b)/3
        x: c.x - (2.0 * a.x + b.x) / 3.0,
        y: c.y - (2.0 * a.y + b.y) / 3.0,
    };
    let q1 = third(q[0], q[3], q[1]);
    let q2 = third(q[3], q[0], q[2]);
    let delta = norm(q1).max(norm(q2));
    let v = sub(q[3], q[0]);
    let d = [
        scale3(sub(q[1], q[0])),
        scale3(sub(q[2], q[1])),
        scale3(sub(q[3], q[2])),
    ];
    let cone: &[Point] = if context.stationary_start {
        &d[1..]
    } else if context.stationary_end {
        &d[..2]
    } else {
        &d
    };
    let mut a = f64::INFINITY;
    let mut b = 0.0f64;
    for direction in cone {
        a = a.min(v.x * direction.x + v.y * direction.y);
        b = b.max((v.x * direction.y - v.y * direction.x).abs());
    }
    let m = context.magnitude;
    let level = f64::from(depth);
    let split = if context.split_range { 1.0 } else { 0.0 };
    let eps = (4.0 * level + 16.0 * split) * UNIT * m;
    let length = norm(v) * SLACK_UP + LENGTH_FLOOR;
    let absolute = 768.0 * UNIT * m * m;
    let perturbation = 20.0 * eps * length;
    let a_low = a * SLACK_DOWN - absolute - perturbation;
    if a_low.partial_cmp(&0.0) != Some(Ordering::Greater) {
        return rejected;
    }
    let b_up = b * SLACK_UP + absolute + perturbation;
    let sin_up = (b_up / (a_low * a_low + b_up * b_up).sqrt() * SLACK_UP).min(1.0);
    let delta_up = delta * SLACK_UP + 32.0 * UNIT * m;
    let r = context.r;
    let computed_error = |split_end: bool| {
        let stationary = if split_end && context.split_range {
            600.0 * UNIT * m * m
        } else {
            0.0
        };
        (18.0 * eps * length + stationary) / a_low + 8.0 * UNIT
    };
    let start_error = context
        .start_error
        .unwrap_or_else(|| computed_error(context.stationary_start));
    let end_error = if context.end_fixed {
        0.0
    } else {
        computed_error(context.stationary_end)
    };
    let g_ctrl = 4.0 * level * UNIT * m * (1.0 + 12.0 * r * length / a_low)
        + 5.0 * eps
        + 3.0 * r * start_error.max(end_error);
    let kappa = if context.split_length > 0.0 {
        UNIT * 2.0 / (context.split_length * SLACK_DOWN)
    } else {
        0.0
    };
    let total = delta_up
        + context.factor * r * sin_up
        + g_ctrl
        + context.g_off
        + kappa * (length + 2.0 * r);
    if !matches!(
        total.partial_cmp(&(context.full * SLACK_DOWN)),
        Some(Ordering::Less | Ordering::Equal)
    ) {
        return rejected;
    }
    LeafMeasure {
        accepted: true,
        start_direction: if context.stationary_start {
            first_nonzero([d[1], d[2]])
        } else {
            d[0]
        },
        end_direction: if context.stationary_end {
            first_nonzero([d[1], d[0]])
        } else {
            d[2]
        },
        start_error,
        end_error,
    }
}
