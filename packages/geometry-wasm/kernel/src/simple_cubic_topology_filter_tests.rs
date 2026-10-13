//! B0R unit U1 oracles for the topology filters F0.1 and F2.1-F2.4
//! (docs/plans/p3-b0r-kernel-performance-contract.md sections 3.5, 3.7 and 7: O1, O2).
//!
//! Each filtered predicate is compared with its unchanged exact routine on seeded random tuples
//! (exact dyadic restrictions to depth 20 of cubics with magnitudes 2^-60 to 2^60, signs, signed
//! zeros and subnormals) and on seeded adversarial tuples (exact collinearity, one-ulp and
//! one-grid-unit perturbations, equal points, parallel and perpendicular vectors, magnitudes at
//! 2^+-500 and beyond, subnormals and the binary64 limits). The `cfg(test)` counters of
//! `fill_filter` report the decided and fallback fractions and prove that named fixtures fall back.
use std::time::Instant;

use crate::fill_exact::Signed;
use crate::fill_filter::{counts, reset_counters, FilterId, FILTER_COUNT};
use crate::fill_filter_tests::{enclosure_contains, parallel, pow2, share, thread_count, Rng};
use crate::geometry::Point;
use crate::simple_cubic_topology::{
    b0r_test_enclose_coordinate, b0r_test_evaluate, b0r_test_point, b0r_test_restrict,
    B0rTestPoint, B0rTopologyPredicate,
};

type Coordinate = Signed<34>;

const FILTER_IDS: [FilterId; FILTER_COUNT] = [
    FilterId::TopologyOrientIdentity,
    FilterId::TopologyOrient,
    FilterId::TopologyCrossSign,
    FilterId::TopologyDotSign,
    FilterId::TopologyDotTotal,
    FilterId::TopologyCompareCoordinate,
];

const PREDICATES: [B0rTopologyPredicate; 13] = [
    B0rTopologyPredicate::Orient,
    B0rTopologyPredicate::CrossSign,
    B0rTopologyPredicate::DotSign,
    B0rTopologyPredicate::ProjectedMonotone,
    B0rTopologyPredicate::RoundedProjectedMonotone { closure: false },
    B0rTopologyPredicate::RoundedProjectedMonotone { closure: true },
    B0rTopologyPredicate::TransverseOrientation {
        left_closure: false,
        right_closure: false,
    },
    B0rTopologyPredicate::TransverseOrientation {
        left_closure: true,
        right_closure: false,
    },
    B0rTopologyPredicate::TransverseOrientation {
        left_closure: false,
        right_closure: true,
    },
    B0rTopologyPredicate::CompareCoordinate,
    B0rTopologyPredicate::ComparePoints,
    B0rTopologyPredicate::BetweenClosed,
    B0rTopologyPredicate::TransverseOrientation {
        left_closure: true,
        right_closure: true,
    },
];

fn point(x: f64, y: f64) -> B0rTestPoint {
    b0r_test_point(Point { x, y })
}

fn sub(left: &Coordinate, right: &Coordinate) -> Coordinate {
    left.add(right.negated())
}

fn grid_unit() -> Coordinate {
    let mut unit = Coordinate::zero();
    unit.limbs[0] = 1;
    unit.used = 1;
    unit
}

/// One grid unit (2^-1134) up or down: an exact neighbour no binary64 enclosure separates.
fn nudge(value: &Coordinate, rng: &mut Rng) -> Coordinate {
    let unit = grid_unit();
    value.add(if rng.chance(1, 2) {
        unit
    } else {
        unit.negated()
    })
}

fn vector(end: &B0rTestPoint, start: &B0rTestPoint) -> B0rTestPoint {
    [sub(&end[0], &start[0]), sub(&end[1], &start[1])]
}

/// A source cubic around one magnitude, with occasional zeros, subnormals and small integers.
fn random_cubic(rng: &mut Rng) -> [Point; 4] {
    let exponent = rng.range_i32(-60, 60);
    let center = [
        rng.scaled(exponent + 2, true),
        rng.scaled(exponent + 2, true),
    ];
    core::array::from_fn(|_| {
        let mut coordinate = |axis: usize| match rng.below(40) {
            0 => {
                if rng.chance(1, 2) {
                    0.0
                } else {
                    -0.0
                }
            }
            1 => f64::from_bits(1 + rng.below(1 << 40)),
            2 => rng.finite(-60, 60),
            _ => {
                let offset = rng.range_i32(0, 8);
                center[axis] + rng.scaled(exponent - offset, true)
            }
        };
        Point {
            x: coordinate(0),
            y: coordinate(1),
        }
    })
}

/// An exact random restriction to a dyadic cell of depth 0-20.
fn random_leaf(rng: &mut Rng) -> [B0rTestPoint; 4] {
    let depth = rng.below(21) as u32;
    let end = 1 + rng.below(1u64 << depth) as u32;
    b0r_test_restrict(random_cubic(rng), end, depth)
}

/// A line cubic (collinear controls) restricted deep: exactly collinear points with long
/// significands.
fn collinear_leaf(rng: &mut Rng) -> [B0rTestPoint; 4] {
    // Integer multiples (below 2^23) of one power of two, so every control is exact.
    let unit = pow2(rng.range_i32(-60, 40));
    let a = Point {
        x: rng.range_i32(-(1 << 20), 1 << 20) as f64 * unit,
        y: rng.range_i32(-(1 << 20), 1 << 20) as f64 * unit,
    };
    let step = rng.range_i32(1, 4096) as f64 * unit;
    let (dx, dy) = (step * 3.0, step * if rng.chance(1, 2) { 1.0 } else { -1.0 });
    let controls = [0.0, 1.0, 2.0, 3.0].map(|t| Point {
        x: a.x + dx * t,
        y: a.y + dy * t,
    });
    let depth = rng.below(21) as u32;
    let end = 1 + rng.below(1u64 << depth) as u32;
    b0r_test_restrict(controls, end, depth)
}

struct Pool {
    leaves: Vec<[B0rTestPoint; 4]>,
}

impl Pool {
    fn new(rng: &mut Rng, size: usize) -> Self {
        Self {
            leaves: (0..size).map(|_| random_leaf(rng)).collect(),
        }
    }

    fn refresh(&mut self, rng: &mut Rng) {
        let index = rng.below(self.leaves.len() as u64) as usize;
        self.leaves[index] = random_leaf(rng);
    }

    fn leaf(&self, rng: &mut Rng) -> [B0rTestPoint; 4] {
        self.leaves[rng.below(self.leaves.len() as u64) as usize]
    }

    fn point(&self, rng: &mut Rng) -> B0rTestPoint {
        self.leaf(rng)[rng.below(4) as usize]
    }

    /// A six-point rounded leaf: restricted controls plus actual endpoints, which are either
    /// the exact restricted endpoints or exact points of nearby binary64 values.
    fn rounded_leaf(&self, rng: &mut Rng, closure: bool) -> [B0rTestPoint; 6] {
        let controls = self.leaf(rng);
        if closure {
            // Closure leaves are stored as [a, a, b, b, a, b].
            let a = controls[0];
            let b = controls[3];
            return [a, a, b, b, a, b];
        }
        let actual = |rng: &mut Rng, exact: B0rTestPoint| {
            if rng.chance(1, 2) {
                exact
            } else {
                let enclosure = b0r_test_enclose_coordinate(&exact[0]);
                let nearby = enclosure.map_or(0.0, |value| value.lo);
                let y = b0r_test_enclose_coordinate(&exact[1]).map_or(0.0, |value| value.hi);
                point(nearby, y)
            }
        };
        let start = actual(rng, controls[0]);
        let end = actual(rng, controls[3]);
        [
            controls[0],
            controls[1],
            controls[2],
            controls[3],
            start,
            end,
        ]
    }
}

fn random_tuple(predicate: B0rTopologyPredicate, rng: &mut Rng, pool: &Pool) -> Vec<B0rTestPoint> {
    match predicate {
        B0rTopologyPredicate::Orient => {
            if rng.chance(1, 2) {
                // Three controls of one restriction: nearly collinear at depth.
                let leaf = pool.leaf(rng);
                let first = rng.below(2) as usize;
                vec![
                    leaf[first],
                    leaf[first + 1],
                    leaf[(first + 2 + rng.below(2) as usize) % 4],
                ]
            } else {
                vec![pool.point(rng), pool.point(rng), pool.point(rng)]
            }
        }
        B0rTopologyPredicate::CrossSign => {
            let leaf = pool.leaf(rng);
            let other = if rng.chance(1, 2) {
                leaf
            } else {
                pool.leaf(rng)
            };
            let i = rng.below(3) as usize;
            let j = rng.below(3) as usize;
            vec![
                vector(&leaf[i + 1], &leaf[i]),
                vector(&other[j + 1], &other[j]),
            ]
        }
        B0rTopologyPredicate::DotSign => {
            let leaf = pool.leaf(rng);
            let i = rng.below(3) as usize;
            let chord = vector(&leaf[3], &leaf[0]);
            let direction = if rng.chance(1, 2) {
                chord
            } else {
                vector(&pool.point(rng), &pool.point(rng))
            };
            vec![leaf[i + 1], leaf[i], direction]
        }
        B0rTopologyPredicate::ProjectedMonotone => {
            if rng.chance(3, 4) {
                pool.leaf(rng).to_vec()
            } else {
                (0..4).map(|_| pool.point(rng)).collect()
            }
        }
        B0rTopologyPredicate::RoundedProjectedMonotone { closure } => {
            let mut points = pool.rounded_leaf(rng, closure).to_vec();
            let next = pool.leaf(rng);
            let direction = if rng.chance(1, 2) {
                vector(&next[3], &points[0])
            } else {
                vector(&points[3], &points[0])
            };
            points.push(direction);
            points
        }
        B0rTopologyPredicate::TransverseOrientation {
            left_closure,
            right_closure,
        } => {
            let mut points = pool.rounded_leaf(rng, left_closure).to_vec();
            points.extend(pool.rounded_leaf(rng, right_closure));
            points
        }
        B0rTopologyPredicate::CompareCoordinate | B0rTopologyPredicate::ComparePoints => {
            let left = pool.point(rng);
            let right = if rng.chance(1, 4) {
                [left[0], pool.point(rng)[1]]
            } else {
                pool.point(rng)
            };
            vec![left, right]
        }
        B0rTopologyPredicate::BetweenClosed => {
            vec![pool.point(rng), pool.point(rng), pool.point(rng)]
        }
    }
}

/// Exactly collinear points on a slope +-1/3 line, scaled by a power of two.
fn slope_third(rng: &mut Rng, exponent: i32) -> [B0rTestPoint; 3] {
    let scale = pow2(exponent);
    let sign = if rng.chance(1, 2) { 1.0 } else { -1.0 };
    let base = rng.range_i32(-1000, 1000) as f64;
    core::array::from_fn(|_| {
        let k = base + rng.range_i32(-1000, 1000) as f64;
        point(3.0 * k * scale, sign * k * scale)
    })
}

/// Binary64 points near an exactly collinear triple, perturbed by one ulp up or down.
fn ulp_perturbed(rng: &mut Rng) -> [B0rTestPoint; 3] {
    let exponent = rng.range_i32(-50, 50);
    let scale = pow2(exponent);
    let k = [
        1.0,
        2.0 + rng.below(100) as f64,
        200.0 + rng.below(1000) as f64,
    ];
    let mut points = k.map(|k| (3.0 * k * scale, k * scale));
    let index = rng.below(3) as usize;
    points[index].1 = if rng.chance(1, 2) {
        points[index].1.next_up()
    } else {
        points[index].1.next_down()
    };
    points.map(|(x, y)| point(x, y))
}

/// Points at extreme magnitudes: 2^+-500, beyond the product range, subnormal, binary64 limits.
fn extreme_point(rng: &mut Rng) -> B0rTestPoint {
    let coordinate = |rng: &mut Rng| match rng.below(7) {
        0 => rng.scaled_in(495, 505, true),
        1 => rng.scaled_in(-505, -495, true),
        2 => rng.scaled_in(560, 1023, true),
        3 => f64::from_bits(1 + rng.below(1 << 52)),
        4 => {
            if rng.chance(1, 2) {
                f64::MAX
            } else {
                -f64::MAX
            }
        }
        5 => pow2(rng.range_i32(-1074, 1023)),
        _ => rng.scaled_in(-1022, -1000, true),
    };
    let x = coordinate(rng);
    let y = coordinate(rng);
    point(x, y)
}

fn adversarial_triple(rng: &mut Rng, pool: &Pool) -> [B0rTestPoint; 3] {
    match rng.below(7) {
        0 => {
            let exponent = rng.range_i32(-60, 60);
            slope_third(rng, exponent)
        }
        1 => ulp_perturbed(rng),
        2 => {
            let leaf = collinear_leaf(rng);
            [leaf[0], leaf[rng.range_i32(1, 2) as usize], leaf[3]]
        }
        3 => {
            // Collinear restriction with one coordinate moved by one grid unit.
            let leaf = collinear_leaf(rng);
            let mut moved = leaf[2];
            let axis = rng.below(2) as usize;
            moved[axis] = nudge(&moved[axis], rng);
            [leaf[0], leaf[1], moved]
        }
        4 => {
            // F0.1: two equal points.
            let a = pool.point(rng);
            let b = pool.point(rng);
            match rng.below(3) {
                0 => [a, a, b],
                1 => [a, b, a],
                _ => [b, a, a],
            }
        }
        5 => [extreme_point(rng), extreme_point(rng), extreme_point(rng)],
        _ => {
            // Shared endpoints of adjacent leaves.
            let leaf = pool.leaf(rng);
            [leaf[0], leaf[3], leaf[rng.below(4) as usize]]
        }
    }
}

fn adversarial_vectors(rng: &mut Rng, pool: &Pool) -> [B0rTestPoint; 2] {
    let leaf = if rng.chance(1, 2) {
        collinear_leaf(rng)
    } else {
        pool.leaf(rng)
    };
    let v = vector(&leaf[rng.range_i32(1, 3) as usize], &leaf[0]);
    match rng.below(6) {
        0 => [v, [v[0].add(v[0]), v[1].add(v[1])]],
        1 => [v, v],
        2 => [v, [v[0].negated(), v[1].negated()]],
        3 => [v, [nudge(&v[0], rng), v[1]]],
        4 => [v, [Coordinate::zero(), Coordinate::zero()]],
        _ => {
            let triple = adversarial_triple(rng, pool);
            [
                vector(&triple[1], &triple[0]),
                vector(&triple[2], &triple[0]),
            ]
        }
    }
}

fn perpendicular(v: &B0rTestPoint) -> B0rTestPoint {
    [v[1].negated(), v[0]]
}

fn adversarial_tuple(
    predicate: B0rTopologyPredicate,
    rng: &mut Rng,
    pool: &Pool,
) -> Vec<B0rTestPoint> {
    match predicate {
        B0rTopologyPredicate::Orient => adversarial_triple(rng, pool).to_vec(),
        B0rTopologyPredicate::CrossSign => adversarial_vectors(rng, pool).to_vec(),
        B0rTopologyPredicate::DotSign => {
            let triple = adversarial_triple(rng, pool);
            let difference = vector(&triple[1], &triple[0]);
            let direction = match rng.below(4) {
                0 => perpendicular(&difference),
                1 => {
                    let p = perpendicular(&difference);
                    [nudge(&p[0], rng), p[1]]
                }
                2 => [Coordinate::zero(), Coordinate::zero()],
                _ => vector(&triple[2], &triple[0]),
            };
            vec![triple[1], triple[0], direction]
        }
        B0rTopologyPredicate::ProjectedMonotone => match rng.below(4) {
            0 => collinear_leaf(rng).to_vec(),
            1 => {
                let leaf = pool.leaf(rng);
                vec![leaf[0], leaf[0], leaf[3], leaf[3]]
            }
            2 => {
                // A middle control on the perpendicular through an endpoint: zero projection.
                let leaf = pool.leaf(rng);
                let chord = vector(&leaf[3], &leaf[0]);
                let p = perpendicular(&chord);
                let second = [leaf[0][0].add(p[0]), leaf[0][1].add(p[1])];
                vec![leaf[0], second, leaf[2], leaf[3]]
            }
            _ => {
                let triple = adversarial_triple(rng, pool);
                vec![triple[0], triple[1], triple[2], extreme_point(rng)]
            }
        },
        B0rTopologyPredicate::RoundedProjectedMonotone { closure } => {
            let mut points = if rng.chance(1, 2) {
                pool.rounded_leaf(rng, closure).to_vec()
            } else {
                let leaf = collinear_leaf(rng);
                if closure {
                    vec![leaf[0], leaf[0], leaf[3], leaf[3], leaf[0], leaf[3]]
                } else {
                    vec![leaf[0], leaf[1], leaf[2], leaf[3], leaf[0], leaf[3]]
                }
            };
            let step = rng.below(3) as usize;
            let difference = vector(&points[step + 1], &points[step]);
            let direction = match rng.below(4) {
                0 => perpendicular(&difference),
                1 => [Coordinate::zero(), Coordinate::zero()],
                2 => {
                    let p = perpendicular(&vector(&points[5], &points[4]));
                    [nudge(&p[0], rng), p[1]]
                }
                _ => vector(&points[3], &points[0]),
            };
            points.push(direction);
            points
        }
        B0rTopologyPredicate::TransverseOrientation {
            left_closure,
            right_closure,
        } => {
            let line = collinear_leaf(rng);
            let mut left = pool.rounded_leaf(rng, left_closure).to_vec();
            let mut right = pool.rounded_leaf(rng, right_closure).to_vec();
            match rng.below(3) {
                // Parallel generators on a common line.
                0 => {
                    left = vec![line[0], line[1], line[2], line[3], line[0], line[3]];
                    let other = collinear_leaf(rng);
                    right = vec![line[0], line[2], line[3], other[0], line[1], line[3]];
                }
                // A zero generator.
                1 => {
                    left[1] = left[0];
                }
                _ => {
                    right[5] = nudge_point(&right[4], rng);
                }
            }
            left.extend(right);
            left
        }
        B0rTopologyPredicate::CompareCoordinate | B0rTopologyPredicate::ComparePoints => {
            let left = if rng.chance(1, 3) {
                extreme_point(rng)
            } else {
                pool.point(rng)
            };
            let right = match rng.below(4) {
                0 => left,
                1 => [nudge(&left[0], rng), left[1]],
                2 => [left[0], nudge(&left[1], rng)],
                _ => [left[0].negated(), left[1]],
            };
            vec![left, right]
        }
        B0rTopologyPredicate::BetweenClosed => {
            let a = pool.point(rng);
            let b = pool.point(rng);
            match rng.below(5) {
                0 => vec![a, a, b],
                1 => vec![b, a, b],
                2 => vec![a, b, b],
                3 => vec![nudge_point(&a, rng), a, b],
                _ => vec![nudge_point(&b, rng), a, b],
            }
        }
    }
}

fn nudge_point(point: &B0rTestPoint, rng: &mut Rng) -> B0rTestPoint {
    [nudge(&point[0], rng), nudge(&point[1], rng)]
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct PredicateTally {
    cases: u64,
    disagreements: u64,
    /// (decided, fallback) per `FilterId`, in `FILTER_IDS` order.
    filters: [(u64, u64); FILTER_COUNT],
}

impl PredicateTally {
    fn merge(&mut self, other: Self) {
        self.cases += other.cases;
        self.disagreements += other.disagreements;
        for (mine, theirs) in self.filters.iter_mut().zip(other.filters) {
            mine.0 += theirs.0;
            mine.1 += theirs.1;
        }
    }

    fn decided(&self) -> u64 {
        self.filters.iter().map(|value| value.0).sum()
    }

    fn fallback(&self) -> u64 {
        self.filters.iter().map(|value| value.1).sum()
    }
}

/// Differential of one predicate: filtered against exact on `count` tuples of one corpus.
fn differential(
    predicate: B0rTopologyPredicate,
    seed: u64,
    count: u64,
    adversarial: bool,
) -> PredicateTally {
    let mut rng = Rng::new(seed);
    let mut pool = Pool::new(&mut rng, 32);
    let mut tally = PredicateTally::default();
    let mut filtered_counts = [(0u64, 0u64); FILTER_COUNT];
    for index in 0..count {
        if index % 16 == 15 {
            pool.refresh(&mut rng);
        }
        let tuple = if adversarial {
            adversarial_tuple(predicate, &mut rng, &pool)
        } else {
            random_tuple(predicate, &mut rng, &pool)
        };
        reset_counters();
        let filtered = b0r_test_evaluate(predicate, &tuple, false);
        for (slot, id) in filtered_counts.iter_mut().zip(FILTER_IDS) {
            let (decided, fallback) = counts(id);
            slot.0 += decided;
            slot.1 += fallback;
        }
        let exact = b0r_test_evaluate(predicate, &tuple, true);
        tally.cases += 1;
        if filtered != exact {
            tally.disagreements += 1;
            if tally.disagreements <= 3 {
                eprintln!("B0R O1 disagreement {predicate:?}: filtered {filtered}, exact {exact}");
            }
        }
    }
    reset_counters();
    tally.filters = filtered_counts;
    tally
}

fn fraction(part: u64, whole: u64) -> f64 {
    if whole == 0 {
        0.0
    } else {
        part as f64 / whole as f64
    }
}

fn report(label: &str, predicate: B0rTopologyPredicate, tally: &PredicateTally) {
    let decided = tally.decided();
    let fallback = tally.fallback();
    let per_filter: Vec<String> = FILTER_IDS
        .iter()
        .zip(tally.filters)
        .filter(|(_, value)| value.0 + value.1 > 0)
        .map(|(id, value)| format!("{id:?} {}/{}", value.0, value.1))
        .collect();
    println!(
        "B0R O1 {label} {predicate:?}: cases {}, disagreements {}, filter calls decided {decided} / fallback {fallback} (decided fraction {:.6}); per filter decided/fallback: {}",
        tally.cases,
        tally.disagreements,
        fraction(decided, decided + fallback),
        per_filter.join(", ")
    );
}

#[test]
fn b0r_o1_smoke_topology_predicates() {
    for (index, predicate) in PREDICATES.into_iter().enumerate() {
        let seed = 0x4230_5231_5000 + index as u64;
        let random = differential(predicate, seed, 10_000, false);
        let adversarial = differential(predicate, seed ^ 0xadad, 1_000, true);
        assert_eq!(random.disagreements, 0, "{predicate:?} random {random:?}");
        assert_eq!(
            adversarial.disagreements, 0,
            "{predicate:?} adversarial {adversarial:?}"
        );
        // A filter that always falls back fails here.
        assert!(
            random.decided() > random.fallback(),
            "{predicate:?} random {random:?}"
        );
        assert!(
            adversarial.fallback() > 0,
            "{predicate:?} adversarial {adversarial:?}"
        );
    }
}

/// Full O1 for the topology filters: 10^7 random and 10^6 adversarial tuples per predicate.
#[test]
#[ignore = "B0R O1 full size; release profile via pnpm test:p3-fill-identity"]
fn b0r_oracle_full_o1_topology() {
    const RANDOM: u64 = 10_000_000;
    const ADVERSARIAL: u64 = 1_000_000;
    let threads = thread_count();
    let start = Instant::now();
    let mut failures = Vec::new();
    for (index, predicate) in PREDICATES.into_iter().enumerate() {
        let predicate_start = Instant::now();
        let mut corpora = [PredicateTally::default(); 2];
        for (corpus, (total, adversarial)) in [(RANDOM, false), (ADVERSARIAL, true)]
            .into_iter()
            .enumerate()
        {
            for tally in parallel(threads, move |thread| {
                differential(
                    predicate,
                    0x4230_5231_6000
                        + ((index as u64) << 16)
                        + ((corpus as u64) << 8)
                        + thread as u64,
                    share(total, threads, thread),
                    adversarial,
                )
            }) {
                corpora[corpus].merge(tally);
            }
        }
        report("random", predicate, &corpora[0]);
        report("adversarial", predicate, &corpora[1]);
        println!(
            "B0R O1 {predicate:?}: {:.1} s",
            predicate_start.elapsed().as_secs_f64()
        );
        for tally in corpora {
            if tally.disagreements != 0 {
                failures.push(format!("{predicate:?}: {tally:?}"));
            }
        }
    }
    println!(
        "B0R O1 topology: {} predicates, {threads} threads, {:.1} s",
        PREDICATES.len(),
        start.elapsed().as_secs_f64()
    );
    assert!(failures.is_empty(), "{failures:?}");
}

// ---------------------------------------------------------------------------------------------
// O2 named fixtures. Each asserts equality with the exact routine and, through the counters,
// whether the fallback ran.

fn evaluate_counted(
    predicate: B0rTopologyPredicate,
    points: &[B0rTestPoint],
    id: FilterId,
) -> (i32, u64, u64) {
    reset_counters();
    let filtered = b0r_test_evaluate(predicate, points, false);
    let (decided, fallback) = counts(id);
    reset_counters();
    let exact = b0r_test_evaluate(predicate, points, true);
    assert_eq!(
        filtered, exact,
        "{predicate:?} differs from the exact routine"
    );
    (filtered, decided, fallback)
}

#[test]
fn b0r_o2_exactly_collinear_slope_third_falls_back() {
    for exponent in [-60, -3, 0, 7, 60] {
        let points = [
            point(3.0 * pow2(exponent), pow2(exponent)),
            point(-6.0 * pow2(exponent), -2.0 * pow2(exponent)),
            point(300.0 * pow2(exponent), 100.0 * pow2(exponent)),
        ];
        let (value, decided, fallback) = evaluate_counted(
            B0rTopologyPredicate::Orient,
            &points,
            FilterId::TopologyOrient,
        );
        assert_eq!((value, decided, fallback), (0, 0, 1));
    }
    // Restricted collinear controls: long significands, still an exact zero.
    let mut rng = Rng::new(0x4230_5231_7001);
    for _ in 0..50 {
        let leaf = collinear_leaf(&mut rng);
        if leaf[0] == leaf[1] || leaf[1] == leaf[3] || leaf[0] == leaf[3] {
            continue;
        }
        let (value, _, fallback) = evaluate_counted(
            B0rTopologyPredicate::Orient,
            &[leaf[0], leaf[1], leaf[3]],
            FilterId::TopologyOrient,
        );
        assert_eq!((value, fallback), (0, 1));
    }
}

#[test]
fn b0r_o2_one_ulp_perturbations_fall_back() {
    let scale = pow2(-4);
    for (offset, expected) in [(1, -1), (-1, 1)] {
        let y = 100.0 * scale;
        let moved = if offset > 0 {
            y.next_up()
        } else {
            y.next_down()
        };
        let points = [
            point(0.0, 0.0),
            point(3.0 * scale, scale),
            point(300.0 * scale, moved),
        ];
        // Orientation of (a, b, c) with c above the line is positive.
        let (value, decided, fallback) = evaluate_counted(
            B0rTopologyPredicate::Orient,
            &points,
            FilterId::TopologyOrient,
        );
        assert_eq!(value, -expected);
        assert_eq!((decided, fallback), (0, 1));
    }
}

#[test]
fn b0r_o2_equal_points_use_identity() {
    let a = point(1.25, -3.5);
    let b = point(7.0, 2.0);
    for points in [[a, a, b], [a, b, a], [b, a, a]] {
        let (value, decided, fallback) = evaluate_counted(
            B0rTopologyPredicate::Orient,
            &points,
            FilterId::TopologyOrientIdentity,
        );
        assert_eq!((value, decided, fallback), (0, 1, 0));
    }
}

#[test]
fn b0r_o2_extreme_magnitudes() {
    // At 2^500 products stay finite: decided.
    let big = pow2(500);
    let points = [point(0.0, 0.0), point(big, 0.0), point(0.0, big)];
    let (value, decided, fallback) = evaluate_counted(
        B0rTopologyPredicate::Orient,
        &points,
        FilterId::TopologyOrient,
    );
    assert_eq!((value, decided, fallback), (1, 1, 0));
    // Beyond the product range (2^600 squared overflows): fallback.
    let huge = pow2(600);
    let points = [point(0.0, 0.0), point(huge, 0.0), point(0.0, huge)];
    let (value, decided, fallback) = evaluate_counted(
        B0rTopologyPredicate::Orient,
        &points,
        FilterId::TopologyOrient,
    );
    assert_eq!((value, decided, fallback), (1, 0, 1));
    // The binary64 limits: differences overflow, NaN-free undecided interval, fallback.
    let points = [
        point(f64::MAX, 0.0),
        point(-f64::MAX, 0.0),
        point(0.0, f64::MAX),
    ];
    let (value, decided, fallback) = evaluate_counted(
        B0rTopologyPredicate::Orient,
        &points,
        FilterId::TopologyOrient,
    );
    assert_eq!((value, decided, fallback), (-1, 0, 1));
    // At 2^-500 products are 2^-1000, normal: decided.
    let small = pow2(-500);
    let points = [point(0.0, 0.0), point(small, 0.0), point(0.0, small)];
    let (value, decided, _) = evaluate_counted(
        B0rTopologyPredicate::Orient,
        &points,
        FilterId::TopologyOrient,
    );
    assert_eq!((value, decided), (1, 1));
}

#[test]
fn b0r_o2_subnormal_coordinates_fall_back() {
    let tiny = f64::from_bits(3);
    let points = [point(0.0, 0.0), point(tiny, 0.0), point(0.0, tiny)];
    let (value, decided, fallback) = evaluate_counted(
        B0rTopologyPredicate::Orient,
        &points,
        FilterId::TopologyOrient,
    );
    assert_eq!((value, decided, fallback), (1, 0, 1));
    let left = point(tiny, 1.0);
    let right = point(f64::from_bits(4), 1.0);
    let (value, decided, fallback) = evaluate_counted(
        B0rTopologyPredicate::CompareCoordinate,
        &[left, right],
        FilterId::TopologyCompareCoordinate,
    );
    assert_eq!((value, decided, fallback), (-1, 0, 1));
}

#[test]
fn b0r_o2_grid_unit_neighbours_fall_back() {
    let mut rng = Rng::new(0x4230_5231_7002);
    let a = b0r_test_restrict(
        [
            Point { x: 0.1, y: 0.3 },
            Point { x: 1.7, y: 2.9 },
            Point { x: 3.3, y: -0.4 },
            Point { x: 5.1, y: 1.2 },
        ],
        777,
        20,
    )[1];
    let b = [nudge(&a[0], &mut rng), a[1]];
    let (value, decided, fallback) = evaluate_counted(
        B0rTopologyPredicate::CompareCoordinate,
        &[a, b],
        FilterId::TopologyCompareCoordinate,
    );
    assert_ne!(value, 0);
    assert_eq!((decided, fallback), (0, 1));
    let (value, _, fallback) = evaluate_counted(
        B0rTopologyPredicate::CompareCoordinate,
        &[a, a],
        FilterId::TopologyCompareCoordinate,
    );
    assert_eq!((value, fallback), (0, 1));
    // The enclosure of the restricted coordinate contains it exactly.
    let enclosure = b0r_test_enclose_coordinate(&a[0]).unwrap();
    assert!(enclosure_contains(enclosure, &a[0], 1134));
}

#[test]
fn b0r_o2_parallel_and_perpendicular_vectors_fall_back() {
    let mut rng = Rng::new(0x4230_5231_7003);
    let leaf = random_leaf(&mut rng);
    let v = vector(&leaf[3], &leaf[0]);
    let doubled = [v[0].add(v[0]), v[1].add(v[1])];
    let (value, decided, fallback) = evaluate_counted(
        B0rTopologyPredicate::CrossSign,
        &[v, doubled],
        FilterId::TopologyCrossSign,
    );
    assert_eq!((value, decided, fallback), (0, 0, 1));
    let (value, decided, fallback) = evaluate_counted(
        B0rTopologyPredicate::DotSign,
        &[leaf[3], leaf[0], perpendicular(&v)],
        FilterId::TopologyDotSign,
    );
    assert_eq!((value, decided, fallback), (0, 0, 1));
}

#[test]
fn b0r_o2_closure_leaf_and_transverse_zero_generators_fall_back() {
    let a = point(1.0, 2.0);
    let b = point(4.0, 3.0);
    let closure = [a, a, b, b, a, b];
    // Closure records [a, a, b, b, a, b] take the endpoint-direction branch.
    let direction = vector(&b, &a);
    let mut points = closure.to_vec();
    points.push(direction);
    let (value, decided, fallback) = evaluate_counted(
        B0rTopologyPredicate::RoundedProjectedMonotone { closure: true },
        &points,
        FilterId::TopologyDotSign,
    );
    assert_eq!((value, decided, fallback), (1, 2, 0));
    // As a non-closure record its zero steps make exact zero projections: fallback.
    let (value, _, fallback) = evaluate_counted(
        B0rTopologyPredicate::RoundedProjectedMonotone { closure: false },
        &points,
        FilterId::TopologyDotSign,
    );
    assert_eq!(value, 1);
    assert_eq!(fallback, 2);
    // A transverse leaf with a zero generator: cross sign zero, fallback, None.
    let c = point(2.0, -1.0);
    let d = point(3.0, 5.0);
    let mut leaves = vec![a, a, b, b, a, b];
    leaves.extend([c, c, d, d, c, d]);
    let (value, _, fallback) = evaluate_counted(
        B0rTopologyPredicate::TransverseOrientation {
            left_closure: false,
            right_closure: false,
        },
        &leaves,
        FilterId::TopologyCrossSign,
    );
    assert_eq!((value, fallback), (2, 1));
}

/// Decided controls: well-separated inputs never fall back, so a filter that always falls back
/// fails these.
#[test]
fn b0r_o2_decided_controls() {
    let a = point(0.0, 0.0);
    let b = point(10.0, 1.0);
    let c = point(3.0, 7.0);
    let cases: [(B0rTopologyPredicate, Vec<B0rTestPoint>, FilterId, i32); 6] = [
        (
            B0rTopologyPredicate::Orient,
            vec![a, b, c],
            FilterId::TopologyOrient,
            1,
        ),
        (
            B0rTopologyPredicate::CrossSign,
            vec![vector(&b, &a), vector(&c, &a)],
            FilterId::TopologyCrossSign,
            1,
        ),
        (
            B0rTopologyPredicate::DotSign,
            vec![b, a, vector(&c, &a)],
            FilterId::TopologyDotSign,
            1,
        ),
        (
            B0rTopologyPredicate::CompareCoordinate,
            vec![a, b],
            FilterId::TopologyCompareCoordinate,
            -1,
        ),
        (
            B0rTopologyPredicate::ComparePoints,
            vec![c, b],
            FilterId::TopologyCompareCoordinate,
            -1,
        ),
        (
            B0rTopologyPredicate::BetweenClosed,
            vec![c, a, b],
            FilterId::TopologyCompareCoordinate,
            1,
        ),
    ];
    for (predicate, points, id, expected) in cases {
        let (value, decided, fallback) = evaluate_counted(predicate, &points, id);
        assert_eq!(value, expected, "{predicate:?}");
        assert!(decided > 0, "{predicate:?}");
        assert_eq!(fallback, 0, "{predicate:?}");
    }
    // A deep restriction of a well-curved cubic: projected monotonicity decided without fallback.
    let leaf = b0r_test_restrict(
        [
            Point { x: 0.0, y: 0.0 },
            Point { x: 1.0, y: 2.0 },
            Point { x: 3.0, y: 2.0 },
            Point { x: 4.0, y: 0.0 },
        ],
        3,
        3,
    );
    let (value, decided, fallback) = evaluate_counted(
        B0rTopologyPredicate::ProjectedMonotone,
        &leaf,
        FilterId::TopologyDotSign,
    );
    assert_eq!((value, decided, fallback), (1, 3, 0));
    let mut points = vec![leaf[0], leaf[1], leaf[2], leaf[3], leaf[0], leaf[3]];
    points.push(vector(&leaf[3], &leaf[0]));
    let (value, _, fallback) = evaluate_counted(
        B0rTopologyPredicate::RoundedProjectedMonotone { closure: false },
        &points,
        FilterId::TopologyDotTotal,
    );
    assert_eq!((value, fallback), (1, 0));
}
