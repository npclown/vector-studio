use core::cmp::Ordering;
use core::mem::size_of;

use crate::fill_exact::{multiply, Signed};
use crate::geometry::{Point, Provenance};

const ABSOLUTE_MAX_CONTOURS: usize = 4;
const ABSOLUTE_MAX_CUBICS: usize = 16;
const ABSOLUTE_MAX_LEAVES: usize = 64;
const ABSOLUTE_MAX_PAIRS: usize = 2_016;
const ABSOLUTE_MAX_BYTES: usize = 1024 * 1024;
const MAX_DEPTH: u32 = 20;
const COORDINATE_LIMBS: usize = 34;
const PRODUCT_LIMBS: usize = 68;
const GRID_SHIFT: usize = 60;

type ExactCoordinate = Signed<COORDINATE_LIMBS>;
type ExactProduct = Signed<PRODUCT_LIMBS>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct TopologyRange {
    pub(crate) start: usize,
    pub(crate) count: usize,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct TopologyCubic {
    pub(crate) points: [Point; 4],
    pub(crate) source_verb: u32,
    pub(crate) leaves: TopologyRange,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct TopologyLeaf {
    pub(crate) end: Point,
    pub(crate) provenance: Provenance,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct TransverseLeafInput {
    pub(crate) source: [Point; 4],
    pub(crate) provenance: Provenance,
    pub(crate) actual: [Point; 2],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct TransversePairCertificate {
    pub(crate) leaves: [Provenance; 2],
    pub(crate) orientation: i8,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct TopologyInput<'a> {
    pub(crate) contours: &'a [TopologyRange],
    pub(crate) cubics: &'a [TopologyCubic],
    pub(crate) leaves: &'a [TopologyLeaf],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct TopologyLimits {
    pub(crate) max_contours: usize,
    pub(crate) max_cubics: usize,
    pub(crate) max_leaves: usize,
    pub(crate) max_pairs: usize,
    pub(crate) max_bytes: usize,
}

impl Default for TopologyLimits {
    fn default() -> Self {
        Self {
            max_contours: ABSOLUTE_MAX_CONTOURS,
            max_cubics: ABSOLUTE_MAX_CUBICS,
            max_leaves: ABSOLUTE_MAX_LEAVES,
            max_pairs: ABSOLUTE_MAX_PAIRS,
            max_bytes: ABSOLUTE_MAX_BYTES,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TopologyError {
    InvalidLimits,
    AllocationFailed,
    ByteLimit,
    InvalidInput,
    InvalidProvenance,
    KnotMismatch,
    Unresolved,
    WorkLimit,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct TopologyStats {
    pub(crate) leaves: usize,
    pub(crate) pairs: usize,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct TopologyOutput<'a> {
    pub(crate) points: &'a [Point],
    pub(crate) contours: &'a [TopologyRange],
    pub(crate) orientations: &'a [i8],
    pub(crate) winding: &'a [[i8; ABSOLUTE_MAX_CONTOURS]],
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ArrangementCrossing {
    pub(crate) left_leaf: usize,
    pub(crate) right_leaf: usize,
    pub(crate) orientation: i8,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ArrangementOutput<'a> {
    pub(crate) points: &'a [Point],
    pub(crate) contours: &'a [TopologyRange],
    pub(crate) crossings: &'a [ArrangementCrossing],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ExactPoint {
    x: ExactCoordinate,
    y: ExactCoordinate,
}

type ExactCubic = [ExactPoint; 4];

#[derive(Clone, Copy)]
struct ExactLeaf {
    controls: ExactCubic,
    hull: [u8; 4],
    hull_len: usize,
    contour: usize,
    contour_leaf: usize,
    ordinary_start: Point,
}

struct RoundedExactLeaf {
    points: [ExactPoint; 6],
    hull: [u8; 6],
    hull_len: usize,
    contour: usize,
    contour_leaf: usize,
    ordinary_start: Point,
    closure: bool,
}

#[derive(Clone, Copy)]
struct ExactHull<'a> {
    points: &'a [ExactPoint],
    indices: &'a [u8],
}

pub(crate) fn certify_transverse_pair(
    leaves: &[TransverseLeafInput; 2],
) -> Result<TransversePairCertificate, TopologyError> {
    for leaf in leaves {
        if leaf.source.iter().copied().any(|point| !finite(point))
            || leaf.actual.iter().copied().any(|point| !finite(point))
        {
            return Err(TopologyError::InvalidInput);
        }
    }
    for leaf in leaves {
        if !valid_transverse_provenance(leaf.provenance) {
            return Err(TopologyError::InvalidProvenance);
        }
    }
    if leaves[0].provenance.source_verb == leaves[1].provenance.source_verb {
        if !same_cubic_bits(leaves[0].source, leaves[1].source) {
            return Err(TopologyError::InvalidInput);
        }
        if !dyadic_interiors_disjoint(leaves[0].provenance, leaves[1].provenance) {
            return Err(TopologyError::InvalidProvenance);
        }
    }

    // Source-level fixed scratch is bounded per nonrecursive helper. This function's conservative
    // envelope is 32 ExactPoints (18,432 bytes): eight restricted and twelve expanded points,
    // eight aggregate-construction/result copies, and four proper-chord argument copies. Add two
    // six-byte hull-index results and under 512 bytes of certificates/provenance/length metadata.
    // restrict_cell needs twelve ExactPoints across its cubic and split argument/result;
    // split_half needs fourteen across its input, six midpoint locals, and returned cubic.
    // transverse_generators needs at most twelve ExactPoints (6,912 bytes) across its actual
    // local, fixed array, point-subtraction arguments/results, and returned tuple copy.
    // transverse_orientation conservatively allows twenty ExactPoints (eight generator locals,
    // eight returned tuple/array copies, two loop values, and two cross arguments) plus four
    // ExactProducts (2,240 bytes) for
    // multiply/negate/add results. cross_vectors itself needs two ExactPoints, two
    // ExactCoordinates, and four ExactProducts (3,968 bytes). Proper/closed-hull helpers need at
    // most eight ExactPoints plus four ExactProducts (6,848 bytes). An endpoint sweep needs four
    // ExactPoints including construction copies and twelve hull-index bytes; convex_hull needs at
    // most 36 index bytes and three point arguments. Every envelope is below 32 KiB. These are
    // conservative source-level counts including by-value arguments/returns, not compiler
    // stack-frame or whole-call-chain claims.
    let expanded = {
        let restricted = [
            restrict_cell(
                exact_cubic(leaves[0].source),
                leaves[0].provenance.end_numerator,
                leaves[0].provenance.depth,
            ),
            restrict_cell(
                exact_cubic(leaves[1].source),
                leaves[1].provenance.end_numerator,
                leaves[1].provenance.depth,
            ),
        ];
        [
            [
                restricted[0][0],
                restricted[0][1],
                restricted[0][2],
                restricted[0][3],
                exact_point(leaves[0].actual[0]),
                exact_point(leaves[0].actual[1]),
            ],
            [
                restricted[1][0],
                restricted[1][1],
                restricted[1][2],
                restricted[1][3],
                exact_point(leaves[1].actual[0]),
                exact_point(leaves[1].actual[1]),
            ],
        ]
    };

    if !segments_properly_intersect(
        expanded[0][4],
        expanded[0][5],
        expanded[1][4],
        expanded[1][5],
    ) {
        return Err(TopologyError::Unresolved);
    }
    let orientation = transverse_orientation(&expanded[0], false, &expanded[1], false)
        .ok_or(TopologyError::Unresolved)?;

    let (left_indices, left_len) = convex_hull(&expanded[0]);
    let (right_indices, right_len) = convex_hull(&expanded[1]);
    let left_hull = ExactHull {
        points: &expanded[0],
        indices: &left_indices[..left_len],
    };
    let right_hull = ExactHull {
        points: &expanded[1],
        indices: &right_indices[..right_len],
    };
    if !endpoint_sweeps_disjoint(&expanded[0], right_hull)
        || !endpoint_sweeps_disjoint(&expanded[1], left_hull)
    {
        return Err(TopologyError::Unresolved);
    }

    Ok(TransversePairCertificate {
        leaves: [leaves[0].provenance, leaves[1].provenance],
        orientation,
    })
}

pub(crate) struct SimpleCubicTopologyWorkspace {
    limits: TopologyLimits,
    exact_leaves: Vec<ExactLeaf>,
    points: [Point; ABSOLUTE_MAX_LEAVES],
    point_len: usize,
    contours: [TopologyRange; ABSOLUTE_MAX_CONTOURS],
    contour_len: usize,
    orientations: [i8; ABSOLUTE_MAX_CONTOURS],
    winding: [[i8; ABSOLUTE_MAX_CONTOURS]; ABSOLUTE_MAX_CONTOURS],
    stats: TopologyStats,
    allocated_bytes: usize,
    published: bool,
}

pub(crate) struct RoundedKnotCubicTopologyWorkspace {
    limits: TopologyLimits,
    exact_leaves: Vec<RoundedExactLeaf>,
    points: [Point; ABSOLUTE_MAX_LEAVES],
    point_len: usize,
    contours: [TopologyRange; ABSOLUTE_MAX_CONTOURS],
    contour_len: usize,
    orientations: [i8; ABSOLUTE_MAX_CONTOURS],
    winding: [[i8; ABSOLUTE_MAX_CONTOURS]; ABSOLUTE_MAX_CONTOURS],
    stats: TopologyStats,
    allocated_bytes: usize,
    published: bool,
}

pub(crate) struct TransverseArrangementWorkspace {
    // The sole heap owner is rounded. The additional inline matching storage is 64 usize partner
    // slots, 32 bounded crossing records, one length, and one publication flag; the native unit
    // freezes the complete wrapper at no more than 4 KiB.
    rounded: RoundedKnotCubicTopologyWorkspace,
    partners: [usize; ABSOLUTE_MAX_LEAVES],
    crossings: [ArrangementCrossing; ABSOLUTE_MAX_LEAVES / 2],
    crossing_len: usize,
    published: bool,
}

impl SimpleCubicTopologyWorkspace {
    pub(crate) fn new(limits: TopologyLimits) -> Result<Self, TopologyError> {
        validate_limits(limits)?;
        let requested = limits
            .max_leaves
            .checked_mul(size_of::<ExactLeaf>())
            .ok_or(TopologyError::InvalidLimits)?;
        if requested > limits.max_bytes {
            return Err(TopologyError::ByteLimit);
        }
        let mut exact_leaves = Vec::new();
        exact_leaves
            .try_reserve_exact(limits.max_leaves)
            .map_err(|_| TopologyError::AllocationFailed)?;
        let allocated_bytes = exact_leaves
            .capacity()
            .checked_mul(size_of::<ExactLeaf>())
            .ok_or(TopologyError::InvalidLimits)?;
        if allocated_bytes > limits.max_bytes {
            return Err(TopologyError::ByteLimit);
        }
        Ok(Self {
            limits,
            exact_leaves,
            points: [Point::default(); ABSOLUTE_MAX_LEAVES],
            point_len: 0,
            contours: [TopologyRange::default(); ABSOLUTE_MAX_CONTOURS],
            contour_len: 0,
            orientations: [0; ABSOLUTE_MAX_CONTOURS],
            winding: [[0; ABSOLUTE_MAX_CONTOURS]; ABSOLUTE_MAX_CONTOURS],
            stats: TopologyStats::default(),
            allocated_bytes,
            published: false,
        })
    }

    pub(crate) fn certify(&mut self, input: TopologyInput<'_>) -> Result<(), TopologyError> {
        self.begin_attempt();
        validate_counts(self.limits, input)?;
        validate_structure(input)?;
        validate_provenance(input)?;
        preflight_knots(input)?;
        self.build_leaves(input)?;
        self.validate_pairs()?;
        self.derive_output()?;
        self.published = true;
        Ok(())
    }

    pub(crate) fn stats(&self) -> TopologyStats {
        self.stats
    }

    pub(crate) fn output(&self) -> Option<TopologyOutput<'_>> {
        self.published.then_some(TopologyOutput {
            points: &self.points[..self.point_len],
            contours: &self.contours[..self.contour_len],
            orientations: &self.orientations[..self.contour_len],
            winding: &self.winding[..self.contour_len],
        })
    }

    pub(crate) fn allocated_bytes(&self) -> usize {
        self.allocated_bytes
    }

    fn begin_attempt(&mut self) {
        self.exact_leaves.clear();
        self.point_len = 0;
        self.contour_len = 0;
        self.orientations.fill(0);
        self.winding.fill([0; ABSOLUTE_MAX_CONTOURS]);
        self.stats = TopologyStats::default();
        self.published = false;
    }

    fn build_leaves(&mut self, input: TopologyInput<'_>) -> Result<(), TopologyError> {
        for (contour_index, contour_range) in input.contours.iter().copied().enumerate() {
            let output_start = self.exact_leaves.len();
            let first = input.cubics[contour_range.start].points[0];
            let first_exact = exact_point(first);
            let mut last_exact = first_exact;
            let mut last_ordinary = first;
            let mut contour_leaf = 0usize;

            for cubic in &input.cubics[range(contour_range)] {
                let exact_source = exact_cubic(cubic.points);
                let mut ordinary_start = cubic.points[0];
                for leaf in &input.leaves[range(cubic.leaves)] {
                    if self.exact_leaves.len() >= self.limits.max_leaves {
                        return Err(TopologyError::WorkLimit);
                    }
                    let controls = restrict_cell(
                        exact_source,
                        leaf.provenance.end_numerator,
                        leaf.provenance.depth,
                    );
                    if !projected_monotone(controls) {
                        return Err(TopologyError::Unresolved);
                    }
                    let (hull, hull_len) = convex_hull(&controls);
                    self.exact_leaves.push(ExactLeaf {
                        controls,
                        hull,
                        hull_len,
                        contour: contour_index,
                        contour_leaf,
                        ordinary_start,
                    });
                    self.stats.leaves += 1;
                    contour_leaf += 1;
                    ordinary_start = leaf.end;
                    last_ordinary = leaf.end;
                    last_exact = exact_point(leaf.end);
                }
            }

            if last_exact != first_exact {
                if self.exact_leaves.len() >= self.limits.max_leaves {
                    return Err(TopologyError::WorkLimit);
                }
                let controls = [last_exact, last_exact, first_exact, first_exact];
                let (hull, hull_len) = convex_hull(&controls);
                self.exact_leaves.push(ExactLeaf {
                    controls,
                    hull,
                    hull_len,
                    contour: contour_index,
                    contour_leaf,
                    ordinary_start: last_ordinary,
                });
                self.stats.leaves += 1;
                contour_leaf += 1;
            }
            if contour_leaf < 3 {
                return Err(TopologyError::Unresolved);
            }
            self.contours[contour_index] = TopologyRange {
                start: output_start,
                count: contour_leaf,
            };
            self.contour_len += 1;
        }
        Ok(())
    }

    fn validate_pairs(&mut self) -> Result<(), TopologyError> {
        for left_index in 0..self.exact_leaves.len() {
            for right_index in (left_index + 1)..self.exact_leaves.len() {
                if self.stats.pairs == self.limits.max_pairs {
                    return Err(TopologyError::WorkLimit);
                }
                self.stats.pairs += 1;
                let left = &self.exact_leaves[left_index];
                let right = &self.exact_leaves[right_index];
                if let Some(shared) = adjacent_shared_point(*left, *right, &self.contours) {
                    if !hull_intersection_is_only(
                        exact_leaf_hull(left),
                        exact_leaf_hull(right),
                        shared,
                    ) {
                        return Err(TopologyError::Unresolved);
                    }
                } else if closed_hulls_intersect(exact_leaf_hull(left), exact_leaf_hull(right)) {
                    return Err(TopologyError::Unresolved);
                }
            }
        }
        Ok(())
    }

    fn derive_output(&mut self) -> Result<(), TopologyError> {
        self.point_len = self.exact_leaves.len();
        for (index, leaf) in self.exact_leaves.iter().copied().enumerate() {
            self.points[index] = leaf.ordinary_start;
        }
        for contour_index in 0..self.contour_len {
            let contour = self.contours[contour_index];
            let mut area = ExactProduct::zero();
            for offset in 0..contour.count {
                let current = self.exact_leaves[contour.start + offset].controls[0];
                let next =
                    self.exact_leaves[contour.start + (offset + 1) % contour.count].controls[0];
                area = area.add(cross_points(current, next));
            }
            self.orientations[contour_index] = match area.cmp_zero() {
                Ordering::Less => -1,
                Ordering::Greater => 1,
                Ordering::Equal => return Err(TopologyError::Unresolved),
            };
        }

        for query_index in 0..self.contour_len {
            let query_range = self.contours[query_index];
            let query = self.exact_leaves[query_range.start].controls[0];
            for container_index in 0..self.contour_len {
                if query_index == container_index {
                    continue;
                }
                let container = self.contours[container_index];
                match classify_polygon(&self.exact_leaves, container, query) {
                    PolygonLocation::Boundary => return Err(TopologyError::Unresolved),
                    PolygonLocation::Inside => {
                        self.winding[query_index][container_index] =
                            self.orientations[container_index];
                    }
                    PolygonLocation::Outside => {}
                }
            }
        }
        Ok(())
    }
}

impl RoundedKnotCubicTopologyWorkspace {
    pub(crate) fn new(limits: TopologyLimits) -> Result<Self, TopologyError> {
        validate_limits(limits)?;
        let requested = limits
            .max_leaves
            .checked_mul(size_of::<RoundedExactLeaf>())
            .ok_or(TopologyError::InvalidLimits)?;
        if requested > limits.max_bytes {
            return Err(TopologyError::ByteLimit);
        }
        let mut exact_leaves = Vec::new();
        exact_leaves
            .try_reserve_exact(limits.max_leaves)
            .map_err(|_| TopologyError::AllocationFailed)?;
        let allocated_bytes = exact_leaves
            .capacity()
            .checked_mul(size_of::<RoundedExactLeaf>())
            .ok_or(TopologyError::InvalidLimits)?;
        if allocated_bytes > limits.max_bytes {
            return Err(TopologyError::ByteLimit);
        }
        Ok(Self {
            limits,
            exact_leaves,
            points: [Point::default(); ABSOLUTE_MAX_LEAVES],
            point_len: 0,
            contours: [TopologyRange::default(); ABSOLUTE_MAX_CONTOURS],
            contour_len: 0,
            orientations: [0; ABSOLUTE_MAX_CONTOURS],
            winding: [[0; ABSOLUTE_MAX_CONTOURS]; ABSOLUTE_MAX_CONTOURS],
            stats: TopologyStats::default(),
            allocated_bytes,
            published: false,
        })
    }

    pub(crate) fn certify(&mut self, input: TopologyInput<'_>) -> Result<(), TopologyError> {
        self.prepare(input)?;
        self.validate_pairs()?;
        self.derive_output()?;
        self.published = true;
        Ok(())
    }

    fn prepare(&mut self, input: TopologyInput<'_>) -> Result<(), TopologyError> {
        self.begin_attempt();
        validate_counts(self.limits, input)?;
        validate_structure(input)?;
        validate_provenance(input)?;
        preflight_source_final(input)?;
        self.build_leaves(input)?;
        self.validate_minimum_leaves()?;
        Ok(())
    }

    pub(crate) fn stats(&self) -> TopologyStats {
        self.stats
    }

    pub(crate) fn output(&self) -> Option<TopologyOutput<'_>> {
        self.published.then_some(TopologyOutput {
            points: &self.points[..self.point_len],
            contours: &self.contours[..self.contour_len],
            orientations: &self.orientations[..self.contour_len],
            winding: &self.winding[..self.contour_len],
        })
    }

    pub(crate) fn allocated_bytes(&self) -> usize {
        self.allocated_bytes
    }

    fn begin_attempt(&mut self) {
        self.exact_leaves.clear();
        self.point_len = 0;
        self.contour_len = 0;
        self.contours.fill(TopologyRange::default());
        self.orientations.fill(0);
        self.winding.fill([0; ABSOLUTE_MAX_CONTOURS]);
        self.stats = TopologyStats::default();
        self.published = false;
    }

    fn build_leaves(&mut self, input: TopologyInput<'_>) -> Result<(), TopologyError> {
        // A conservative source-level inventory stays below 32 KiB: at most 32 ExactPoints cover
        // the source, restricted controls, first/carried/actual endpoints, six hull candidates,
        // and a transient record copy; eight ExactProducts cover the largest predicate; five
        // six-byte index arrays and 512 bytes cover hull/scalar metadata. split_half has fourteen
        // ExactPoints across its argument, midpoint locals, and result. This is not a claim about
        // compiler-generated stack frames. Pair helpers borrow retained records.
        for (contour_index, contour_range) in input.contours.iter().copied().enumerate() {
            let output_start = self.exact_leaves.len();
            let first = input.cubics[contour_range.start].points[0];
            let first_exact = exact_point(first);
            let mut actual_start = first_exact;
            let mut ordinary_start = first;
            let mut contour_leaf = 0usize;

            for cubic in &input.cubics[range(contour_range)] {
                let exact_source = exact_cubic(cubic.points);
                for leaf in &input.leaves[range(cubic.leaves)] {
                    if self.exact_leaves.len() >= self.limits.max_leaves {
                        return Err(TopologyError::WorkLimit);
                    }
                    let controls = restrict_cell(
                        exact_source,
                        leaf.provenance.end_numerator,
                        leaf.provenance.depth,
                    );
                    let actual_end = exact_point(leaf.end);
                    let points = [
                        controls[0],
                        controls[1],
                        controls[2],
                        controls[3],
                        actual_start,
                        actual_end,
                    ];
                    let (hull, hull_len) = convex_hull(&points);
                    self.exact_leaves.push(RoundedExactLeaf {
                        points,
                        hull,
                        hull_len,
                        contour: contour_index,
                        contour_leaf,
                        ordinary_start,
                        closure: false,
                    });
                    self.stats.leaves += 1;
                    contour_leaf += 1;
                    actual_start = actual_end;
                    ordinary_start = leaf.end;
                }
            }

            if actual_start != first_exact {
                if self.exact_leaves.len() >= self.limits.max_leaves {
                    return Err(TopologyError::WorkLimit);
                }
                let points = [
                    actual_start,
                    actual_start,
                    first_exact,
                    first_exact,
                    actual_start,
                    first_exact,
                ];
                let (hull, hull_len) = convex_hull(&points);
                self.exact_leaves.push(RoundedExactLeaf {
                    points,
                    hull,
                    hull_len,
                    contour: contour_index,
                    contour_leaf,
                    ordinary_start,
                    closure: true,
                });
                self.stats.leaves += 1;
                contour_leaf += 1;
            }
            self.contours[contour_index] = TopologyRange {
                start: output_start,
                count: contour_leaf,
            };
            self.contour_len += 1;
        }
        Ok(())
    }

    fn validate_minimum_leaves(&self) -> Result<(), TopologyError> {
        if self.contours[..self.contour_len]
            .iter()
            .any(|contour| contour.count < 3)
        {
            return Err(TopologyError::Unresolved);
        }
        Ok(())
    }

    fn validate_pairs(&mut self) -> Result<(), TopologyError> {
        for left_index in 0..self.exact_leaves.len() {
            for right_index in (left_index + 1)..self.exact_leaves.len() {
                if self.stats.pairs == self.limits.max_pairs {
                    return Err(TopologyError::WorkLimit);
                }
                self.stats.pairs += 1;
                let left = &self.exact_leaves[left_index];
                let right = &self.exact_leaves[right_index];
                if let Some((previous, next)) =
                    directed_rounded_adjacent(left, right, &self.contours)
                {
                    let direction = point_sub(next.points[3], previous.points[0]);
                    if !rounded_projected_monotone(previous, direction)
                        || !rounded_projected_monotone(next, direction)
                    {
                        return Err(TopologyError::Unresolved);
                    }
                } else if closed_hulls_intersect(rounded_leaf_hull(left), rounded_leaf_hull(right))
                {
                    return Err(TopologyError::Unresolved);
                }
            }
        }
        Ok(())
    }

    fn derive_output(&mut self) -> Result<(), TopologyError> {
        self.copy_actual_starts();
        for contour_index in 0..self.contour_len {
            let contour = self.contours[contour_index];
            let mut area = ExactProduct::zero();
            for offset in 0..contour.count {
                let current = self.exact_leaves[contour.start + offset].points[4];
                let next =
                    self.exact_leaves[contour.start + (offset + 1) % contour.count].points[4];
                area = area.add(cross_points(current, next));
            }
            self.orientations[contour_index] = match area.cmp_zero() {
                Ordering::Less => -1,
                Ordering::Greater => 1,
                Ordering::Equal => return Err(TopologyError::Unresolved),
            };
        }

        for query_index in 0..self.contour_len {
            let query_range = self.contours[query_index];
            let query = self.exact_leaves[query_range.start].points[4];
            for container_index in 0..self.contour_len {
                if query_index == container_index {
                    continue;
                }
                let container = self.contours[container_index];
                match classify_rounded_polygon(&self.exact_leaves, container, query) {
                    PolygonLocation::Boundary => return Err(TopologyError::Unresolved),
                    PolygonLocation::Inside => {
                        self.winding[query_index][container_index] =
                            self.orientations[container_index];
                    }
                    PolygonLocation::Outside => {}
                }
            }
        }
        Ok(())
    }

    fn copy_actual_starts(&mut self) {
        self.point_len = self.exact_leaves.len();
        for (index, leaf) in self.exact_leaves.iter().enumerate() {
            self.points[index] = leaf.ordinary_start;
        }
    }
}

impl TransverseArrangementWorkspace {
    pub(crate) fn new(limits: TopologyLimits) -> Result<Self, TopologyError> {
        Ok(Self {
            rounded: RoundedKnotCubicTopologyWorkspace::new(limits)?,
            partners: [usize::MAX; ABSOLUTE_MAX_LEAVES],
            crossings: [ArrangementCrossing::default(); ABSOLUTE_MAX_LEAVES / 2],
            crossing_len: 0,
            published: false,
        })
    }

    pub(crate) fn certify(&mut self, input: TopologyInput<'_>) -> Result<(), TopologyError> {
        self.begin_attempt();
        self.rounded.prepare(input)?;
        self.validate_pairs()?;
        self.rounded.copy_actual_starts();
        self.published = true;
        Ok(())
    }

    pub(crate) fn stats(&self) -> TopologyStats {
        self.rounded.stats
    }

    pub(crate) fn output(&self) -> Option<ArrangementOutput<'_>> {
        self.published.then_some(ArrangementOutput {
            points: &self.rounded.points[..self.rounded.point_len],
            contours: &self.rounded.contours[..self.rounded.contour_len],
            crossings: &self.crossings[..self.crossing_len],
        })
    }

    pub(crate) fn allocated_bytes(&self) -> usize {
        self.rounded.allocated_bytes
    }

    fn begin_attempt(&mut self) {
        self.partners.fill(usize::MAX);
        self.crossing_len = 0;
        self.published = false;
    }

    fn validate_pairs(&mut self) -> Result<(), TopologyError> {
        // Pair inspection borrows both retained records. Its largest exact scratch is the shared
        // transverse-orientation envelope above; no RoundedExactLeaf or six-point array is copied.
        for left_index in 0..self.rounded.exact_leaves.len() {
            for right_index in (left_index + 1)..self.rounded.exact_leaves.len() {
                if self.rounded.stats.pairs == self.rounded.limits.max_pairs {
                    return Err(TopologyError::WorkLimit);
                }
                self.rounded.stats.pairs += 1;
                let orientation = {
                    let left = &self.rounded.exact_leaves[left_index];
                    let right = &self.rounded.exact_leaves[right_index];
                    if let Some((previous, next)) =
                        directed_rounded_adjacent(left, right, &self.rounded.contours)
                    {
                        let direction = point_sub(next.points[3], previous.points[0]);
                        if !rounded_projected_monotone(previous, direction)
                            || !rounded_projected_monotone(next, direction)
                        {
                            return Err(TopologyError::Unresolved);
                        }
                        None
                    } else if !closed_hulls_intersect(
                        rounded_leaf_hull(left),
                        rounded_leaf_hull(right),
                    ) {
                        None
                    } else {
                        Some(
                            certify_transverse_rounded_pair(left, right)
                                .ok_or(TopologyError::Unresolved)?,
                        )
                    }
                };

                let Some(orientation) = orientation else {
                    continue;
                };
                if self.partners[left_index] != usize::MAX {
                    return Err(TopologyError::Unresolved);
                }
                if self.partners[right_index] != usize::MAX {
                    return Err(TopologyError::Unresolved);
                }
                if self.crossing_len == self.crossings.len() {
                    return Err(TopologyError::WorkLimit);
                }
                self.partners[left_index] = right_index;
                self.partners[right_index] = left_index;
                self.crossings[self.crossing_len] = ArrangementCrossing {
                    left_leaf: left_index,
                    right_leaf: right_index,
                    orientation,
                };
                self.crossing_len += 1;
            }
        }
        Ok(())
    }
}

fn validate_limits(limits: TopologyLimits) -> Result<(), TopologyError> {
    if !(1..=ABSOLUTE_MAX_CONTOURS).contains(&limits.max_contours)
        || !(1..=ABSOLUTE_MAX_CUBICS).contains(&limits.max_cubics)
        || !(1..=ABSOLUTE_MAX_LEAVES).contains(&limits.max_leaves)
        || limits.max_pairs > ABSOLUTE_MAX_PAIRS
        || limits.max_bytes > ABSOLUTE_MAX_BYTES
    {
        return Err(TopologyError::InvalidLimits);
    }
    Ok(())
}

fn validate_counts(limits: TopologyLimits, input: TopologyInput<'_>) -> Result<(), TopologyError> {
    if input.contours.is_empty() || input.cubics.is_empty() || input.leaves.is_empty() {
        return Err(TopologyError::InvalidInput);
    }
    if input.contours.len() > limits.max_contours
        || input.cubics.len() > limits.max_cubics
        || input.leaves.len() > limits.max_leaves
    {
        return Err(TopologyError::WorkLimit);
    }
    Ok(())
}

fn validate_structure(input: TopologyInput<'_>) -> Result<(), TopologyError> {
    validate_partition(input.contours, input.cubics.len())?;
    let leaf_ranges = input.cubics.iter().map(|cubic| cubic.leaves);
    validate_partition_iter(leaf_ranges, input.leaves.len())?;

    for cubic in input.cubics {
        if cubic.points.iter().copied().any(|point| !finite(point)) {
            return Err(TopologyError::InvalidInput);
        }
    }
    if input.leaves.iter().any(|leaf| !finite(leaf.end)) {
        return Err(TopologyError::InvalidInput);
    }
    for left in 0..input.cubics.len() {
        for right in (left + 1)..input.cubics.len() {
            if input.cubics[left].source_verb == input.cubics[right].source_verb {
                return Err(TopologyError::InvalidInput);
            }
        }
    }
    for contour in input.contours.iter().copied() {
        let cubics = &input.cubics[range(contour)];
        for pair in cubics.windows(2) {
            if !same_point(pair[0].points[3], pair[1].points[0]) {
                return Err(TopologyError::InvalidInput);
            }
        }
    }
    Ok(())
}

fn validate_partition(ranges: &[TopologyRange], total: usize) -> Result<(), TopologyError> {
    validate_partition_iter(ranges.iter().copied(), total)
}

fn validate_partition_iter(
    ranges: impl IntoIterator<Item = TopologyRange>,
    total: usize,
) -> Result<(), TopologyError> {
    let mut expected_start = 0usize;
    for value in ranges {
        if value.count == 0 || value.start != expected_start {
            return Err(TopologyError::InvalidInput);
        }
        expected_start = value
            .start
            .checked_add(value.count)
            .ok_or(TopologyError::InvalidInput)?;
        if expected_start > total {
            return Err(TopologyError::InvalidInput);
        }
    }
    if expected_start != total {
        return Err(TopologyError::InvalidInput);
    }
    Ok(())
}

fn validate_provenance(input: TopologyInput<'_>) -> Result<(), TopologyError> {
    for cubic in input.cubics {
        let mut previous_numerator = 0u64;
        let mut previous_denominator = 1u64;
        for leaf in &input.leaves[range(cubic.leaves)] {
            let provenance = leaf.provenance;
            if provenance.source_verb != cubic.source_verb || provenance.depth > MAX_DEPTH {
                return Err(TopologyError::InvalidProvenance);
            }
            let denominator = 1u64 << provenance.depth;
            let numerator = u64::from(provenance.end_numerator);
            if numerator == 0
                || numerator > denominator
                || previous_numerator * denominator != (numerator - 1) * previous_denominator
            {
                return Err(TopologyError::InvalidProvenance);
            }
            previous_numerator = numerator;
            previous_denominator = denominator;
        }
        if previous_numerator != previous_denominator {
            return Err(TopologyError::InvalidProvenance);
        }
    }
    Ok(())
}

fn preflight_source_final(input: TopologyInput<'_>) -> Result<(), TopologyError> {
    for cubic in input.cubics {
        let final_actual = input.leaves[range(cubic.leaves)]
            .last()
            .expect("validated nonempty leaf range")
            .end;
        if !same_point(final_actual, cubic.points[3]) {
            return Err(TopologyError::KnotMismatch);
        }
    }
    Ok(())
}

fn preflight_knots(input: TopologyInput<'_>) -> Result<(), TopologyError> {
    for cubic in input.cubics {
        let exact_source = exact_cubic(cubic.points);
        let mut actual_start = exact_source[0];
        for leaf in &input.leaves[range(cubic.leaves)] {
            let controls = restrict_cell(
                exact_source,
                leaf.provenance.end_numerator,
                leaf.provenance.depth,
            );
            let actual_end = exact_point(leaf.end);
            if controls[0] != actual_start || controls[3] != actual_end {
                return Err(TopologyError::KnotMismatch);
            }
            actual_start = actual_end;
        }
    }
    Ok(())
}

fn range(value: TopologyRange) -> core::ops::Range<usize> {
    value.start..value.start + value.count
}

fn finite(point: Point) -> bool {
    point.x.is_finite() && point.y.is_finite()
}

fn valid_transverse_provenance(provenance: Provenance) -> bool {
    if provenance.depth > MAX_DEPTH {
        return false;
    }
    let denominator = 1u64 << provenance.depth;
    let numerator = u64::from(provenance.end_numerator);
    (1..=denominator).contains(&numerator)
}

fn same_point(left: Point, right: Point) -> bool {
    left.x == right.x && left.y == right.y
}

fn same_cubic_bits(left: [Point; 4], right: [Point; 4]) -> bool {
    left.iter().zip(right.iter()).all(|(left, right)| {
        left.x.to_bits() == right.x.to_bits() && left.y.to_bits() == right.y.to_bits()
    })
}

fn dyadic_interiors_disjoint(left: Provenance, right: Provenance) -> bool {
    let left_denominator = 1u64 << left.depth;
    let right_denominator = 1u64 << right.depth;
    let left_end = u64::from(left.end_numerator);
    let right_end = u64::from(right.end_numerator);
    let left_start = left_end - 1;
    let right_start = right_end - 1;

    left_end * right_denominator <= right_start * left_denominator
        || right_end * left_denominator <= left_start * right_denominator
}

fn exact_cubic(points: [Point; 4]) -> ExactCubic {
    points.map(exact_point)
}

fn exact_point(point: Point) -> ExactPoint {
    ExactPoint {
        x: scale_coordinate(ExactCoordinate::from_finite(point.x)),
        y: scale_coordinate(ExactCoordinate::from_finite(point.y)),
    }
}

fn scale_coordinate(value: ExactCoordinate) -> ExactCoordinate {
    if value.is_zero() {
        return value;
    }
    let mut result = ExactCoordinate::zero();
    result.negative = value.negative;
    for index in 0..value.used {
        let word = value.limbs[index];
        let target = index;
        result.limbs[target] |= word << GRID_SHIFT;
        if word >> (64 - GRID_SHIFT) != 0 {
            assert!(
                target + 1 < COORDINATE_LIMBS,
                "scaled coordinate capacity overflow"
            );
            result.limbs[target + 1] |= word >> (64 - GRID_SHIFT);
        }
    }
    result.used = value.used + usize::from(value.limbs[value.used - 1] >> (64 - GRID_SHIFT) != 0);
    result
}

fn restrict_cell(mut cubic: ExactCubic, end_numerator: u32, depth: u32) -> ExactCubic {
    let cell = end_numerator - 1;
    for bit in (0..depth).rev() {
        cubic = split_half(cubic, (cell & (1u32 << bit)) != 0);
    }
    cubic
}

fn split_half(points: ExactCubic, right: bool) -> ExactCubic {
    let p01 = midpoint(points[0], points[1]);
    let p12 = midpoint(points[1], points[2]);
    let p23 = midpoint(points[2], points[3]);
    let p012 = midpoint(p01, p12);
    let p123 = midpoint(p12, p23);
    let middle = midpoint(p012, p123);
    if right {
        [middle, p123, p23, points[3]]
    } else {
        [points[0], p01, p012, middle]
    }
}

fn midpoint(left: ExactPoint, right: ExactPoint) -> ExactPoint {
    ExactPoint {
        x: left.x.add(right.x).shift_right(1),
        y: left.y.add(right.y).shift_right(1),
    }
}

fn point_sub(left: ExactPoint, right: ExactPoint) -> ExactPoint {
    ExactPoint {
        x: left.x.add(right.x.negated()),
        y: left.y.add(right.y.negated()),
    }
}

fn dot(left: ExactPoint, right: ExactPoint) -> ExactProduct {
    multiply::<COORDINATE_LIMBS, COORDINATE_LIMBS, PRODUCT_LIMBS>(left.x, right.x).add(multiply::<
        COORDINATE_LIMBS,
        COORDINATE_LIMBS,
        PRODUCT_LIMBS,
    >(
        left.y, right.y,
    ))
}

fn cross_vectors(left: ExactPoint, right: ExactPoint) -> ExactProduct {
    multiply::<COORDINATE_LIMBS, COORDINATE_LIMBS, PRODUCT_LIMBS>(left.x, right.y).add(
        multiply::<COORDINATE_LIMBS, COORDINATE_LIMBS, PRODUCT_LIMBS>(left.y, right.x).negated(),
    )
}

fn cross_points(left: ExactPoint, right: ExactPoint) -> ExactProduct {
    cross_vectors(left, right)
}

fn orient(start: ExactPoint, end: ExactPoint, query: ExactPoint) -> Ordering {
    cross_vectors(point_sub(end, start), point_sub(query, start)).cmp_zero()
}

fn projected_monotone(controls: ExactCubic) -> bool {
    let chord = point_sub(controls[3], controls[0]);
    if chord.x.is_zero() && chord.y.is_zero() {
        return false;
    }
    let projections = [
        dot(point_sub(controls[1], controls[0]), chord).cmp_zero(),
        dot(point_sub(controls[2], controls[1]), chord).cmp_zero(),
        dot(point_sub(controls[3], controls[2]), chord).cmp_zero(),
    ];
    projections.iter().all(|value| *value != Ordering::Less)
        && projections.contains(&Ordering::Greater)
}

fn rounded_projected_monotone(leaf: &RoundedExactLeaf, direction: ExactPoint) -> bool {
    let source_progresses = if leaf.closure {
        dot(point_sub(leaf.points[3], leaf.points[0]), direction).cmp_zero() == Ordering::Greater
    } else {
        let mut total = ExactProduct::zero();
        let mut nonnegative = true;
        for index in 0..3 {
            let projection = dot(
                point_sub(leaf.points[index + 1], leaf.points[index]),
                direction,
            );
            if projection.cmp_zero() == Ordering::Less {
                nonnegative = false;
            }
            total = total.add(projection);
        }
        nonnegative && total.cmp_zero() == Ordering::Greater
    };
    source_progresses
        && dot(point_sub(leaf.points[5], leaf.points[4]), direction).cmp_zero() == Ordering::Greater
}

fn compare_coordinate(left: ExactCoordinate, right: ExactCoordinate) -> Ordering {
    if left.negative != right.negative {
        return if left.negative {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    let magnitude = left.compare_magnitude(right);
    if left.negative {
        magnitude.reverse()
    } else {
        magnitude
    }
}

fn compare_points(left: ExactPoint, right: ExactPoint) -> Ordering {
    match compare_coordinate(left.x, right.x) {
        Ordering::Equal => compare_coordinate(left.y, right.y),
        value => value,
    }
}

fn convex_hull<const N: usize>(points: &[ExactPoint; N]) -> ([u8; N], usize) {
    assert!(N <= usize::from(u8::MAX), "hull index capacity");
    let mut sorted: [u8; N] = core::array::from_fn(|index| index as u8);
    for index in 1..sorted.len() {
        let value = sorted[index];
        let mut cursor = index;
        while cursor > 0
            && compare_points(points[value as usize], points[sorted[cursor - 1] as usize])
                == Ordering::Less
        {
            sorted[cursor] = sorted[cursor - 1];
            cursor -= 1;
        }
        sorted[cursor] = value;
    }
    let mut unique = [0u8; N];
    let mut unique_len = 0usize;
    for value in sorted {
        if unique_len == 0 || points[value as usize] != points[unique[unique_len - 1] as usize] {
            unique[unique_len] = value;
            unique_len += 1;
        }
    }
    if unique_len <= 2 {
        return (unique, unique_len);
    }

    let mut lower = [0u8; N];
    let mut lower_len = 0usize;
    for value in unique[..unique_len].iter().copied() {
        while lower_len >= 2
            && orient(
                points[lower[lower_len - 2] as usize],
                points[lower[lower_len - 1] as usize],
                points[value as usize],
            ) != Ordering::Greater
        {
            lower_len -= 1;
        }
        lower[lower_len] = value;
        lower_len += 1;
    }
    let mut upper = [0u8; N];
    let mut upper_len = 0usize;
    for value in unique[..unique_len].iter().rev().copied() {
        while upper_len >= 2
            && orient(
                points[upper[upper_len - 2] as usize],
                points[upper[upper_len - 1] as usize],
                points[value as usize],
            ) != Ordering::Greater
        {
            upper_len -= 1;
        }
        upper[upper_len] = value;
        upper_len += 1;
    }
    let mut hull = [0u8; N];
    let mut hull_len = 0usize;
    for value in lower[..lower_len - 1]
        .iter()
        .chain(&upper[..upper_len - 1])
        .copied()
    {
        hull[hull_len] = value;
        hull_len += 1;
    }
    (hull, hull_len)
}

fn exact_leaf_hull(leaf: &ExactLeaf) -> ExactHull<'_> {
    ExactHull {
        points: &leaf.controls,
        indices: &leaf.hull[..leaf.hull_len],
    }
}

fn rounded_leaf_hull(leaf: &RoundedExactLeaf) -> ExactHull<'_> {
    ExactHull {
        points: &leaf.points,
        indices: &leaf.hull[..leaf.hull_len],
    }
}

fn hull_point(hull: ExactHull<'_>, index: usize) -> ExactPoint {
    hull.points[hull.indices[index] as usize]
}

fn edge_count(hull: ExactHull<'_>) -> usize {
    match hull.indices.len() {
        0 | 1 => 0,
        2 => 1,
        value => value,
    }
}

fn hull_edge(hull: ExactHull<'_>, index: usize) -> (ExactPoint, ExactPoint) {
    if hull.indices.len() == 2 {
        return (hull_point(hull, 0), hull_point(hull, 1));
    }
    (
        hull_point(hull, index),
        hull_point(hull, (index + 1) % hull.indices.len()),
    )
}

fn between_closed(value: ExactCoordinate, left: ExactCoordinate, right: ExactCoordinate) -> bool {
    let (minimum, maximum) = if compare_coordinate(left, right) == Ordering::Greater {
        (right, left)
    } else {
        (left, right)
    };
    compare_coordinate(value, minimum) != Ordering::Less
        && compare_coordinate(value, maximum) != Ordering::Greater
}

fn within_bounds(point: ExactPoint, start: ExactPoint, end: ExactPoint) -> bool {
    between_closed(point.x, start.x, end.x) && between_closed(point.y, start.y, end.y)
}

fn on_segment(point: ExactPoint, start: ExactPoint, end: ExactPoint) -> bool {
    orient(start, end, point) == Ordering::Equal && within_bounds(point, start, end)
}

fn opposite(left: Ordering, right: Ordering) -> bool {
    matches!(
        (left, right),
        (Ordering::Less, Ordering::Greater) | (Ordering::Greater, Ordering::Less)
    )
}

fn segments_properly_intersect(a: ExactPoint, b: ExactPoint, c: ExactPoint, d: ExactPoint) -> bool {
    opposite(orient(a, b, c), orient(a, b, d)) && opposite(orient(c, d, a), orient(c, d, b))
}

fn segments_intersect(a: ExactPoint, b: ExactPoint, c: ExactPoint, d: ExactPoint) -> bool {
    let abc = orient(a, b, c);
    let abd = orient(a, b, d);
    let cda = orient(c, d, a);
    let cdb = orient(c, d, b);
    (abc == Ordering::Equal && within_bounds(c, a, b))
        || (abd == Ordering::Equal && within_bounds(d, a, b))
        || (cda == Ordering::Equal && within_bounds(a, c, d))
        || (cdb == Ordering::Equal && within_bounds(b, c, d))
        || (opposite(abc, abd) && opposite(cda, cdb))
}

fn point_in_closed_hull(point: ExactPoint, hull: ExactHull<'_>) -> bool {
    match hull.indices.len() {
        0 => false,
        1 => point == hull_point(hull, 0),
        2 => on_segment(point, hull_point(hull, 0), hull_point(hull, 1)),
        count => (0..count).all(|index| {
            orient(
                hull_point(hull, index),
                hull_point(hull, (index + 1) % count),
                point,
            ) != Ordering::Less
        }),
    }
}

fn closed_hulls_intersect(left: ExactHull<'_>, right: ExactHull<'_>) -> bool {
    for left_edge in 0..edge_count(left) {
        let (a, b) = hull_edge(left, left_edge);
        for right_edge in 0..edge_count(right) {
            let (c, d) = hull_edge(right, right_edge);
            if segments_intersect(a, b, c, d) {
                return true;
            }
        }
    }
    point_in_closed_hull(hull_point(left, 0), right)
        || point_in_closed_hull(hull_point(right, 0), left)
}

fn transverse_generators(points: &[ExactPoint; 6], closure: bool) -> ([ExactPoint; 4], usize) {
    let actual = point_sub(points[5], points[4]);
    let mut generators = [actual; 4];
    if closure {
        generators[0] = point_sub(points[3], points[0]);
        return (generators, 2);
    }
    generators[0] = point_sub(points[1], points[0]);
    generators[1] = point_sub(points[2], points[1]);
    generators[2] = point_sub(points[3], points[2]);
    (generators, 4)
}

fn transverse_orientation(
    left: &[ExactPoint; 6],
    left_closure: bool,
    right: &[ExactPoint; 6],
    right_closure: bool,
) -> Option<i8> {
    // The true cubic derivative generators have a positive factor of three. Omitting that
    // factor preserves every cross-product sign used here; these unscaled differences are not
    // used as a convex-hull representation of the derivatives.
    // Genuine closure records use their endpoint direction plus the equal actual chord, retaining
    // both generators. They must not be treated as duplicated cubic controls with zero edges.
    let (left_generators, left_len) = transverse_generators(left, left_closure);
    let (right_generators, right_len) = transverse_generators(right, right_closure);
    let mut orientation = 0i8;
    for &left_generator in &left_generators[..left_len] {
        for &right_generator in &right_generators[..right_len] {
            let sign = match cross_vectors(left_generator, right_generator).cmp_zero() {
                Ordering::Less => -1,
                Ordering::Equal => return None,
                Ordering::Greater => 1,
            };
            if orientation == 0 {
                orientation = sign;
            } else if orientation != sign {
                return None;
            }
        }
    }
    Some(orientation)
}

fn certify_transverse_rounded_pair(
    left: &RoundedExactLeaf,
    right: &RoundedExactLeaf,
) -> Option<i8> {
    if !segments_properly_intersect(
        left.points[4],
        left.points[5],
        right.points[4],
        right.points[5],
    ) {
        return None;
    }
    let orientation =
        transverse_orientation(&left.points, left.closure, &right.points, right.closure)?;
    if !endpoint_sweeps_disjoint(&left.points, rounded_leaf_hull(right))
        || !endpoint_sweeps_disjoint(&right.points, rounded_leaf_hull(left))
    {
        return None;
    }
    Some(orientation)
}

#[cfg(test)]
pub(crate) fn certify_transverse_test_pair(
    left: [Point; 6],
    left_closure: bool,
    right: [Point; 6],
    right_closure: bool,
) -> Option<i8> {
    // Test-only construction retains two six-point leaf records. Conservatively including one
    // in-progress map/result copy gives 18 ExactPoints (10,368 bytes), two six-byte hull arrays,
    // and under 512 bytes of ordinary inputs/metadata before the borrowed pair proof.
    fn test_leaf(points: [Point; 6], closure: bool) -> RoundedExactLeaf {
        let points = points.map(exact_point);
        let (hull, hull_len) = convex_hull(&points);
        RoundedExactLeaf {
            points,
            hull,
            hull_len,
            contour: 0,
            contour_leaf: 0,
            ordinary_start: Point::default(),
            closure,
        }
    }

    certify_transverse_rounded_pair(
        &test_leaf(left, left_closure),
        &test_leaf(right, right_closure),
    )
}

fn endpoint_sweeps_disjoint(leaf: &[ExactPoint; 6], other: ExactHull<'_>) -> bool {
    for (source, actual_point) in [(0, 4), (3, 5)] {
        let sweep = [leaf[source], leaf[actual_point]];
        let (indices, len) = convex_hull(&sweep);
        if closed_hulls_intersect(
            ExactHull {
                points: &sweep,
                indices: &indices[..len],
            },
            other,
        ) {
            return false;
        }
    }
    true
}

fn segment_intersection_has_point_other_than(
    a: ExactPoint,
    b: ExactPoint,
    c: ExactPoint,
    d: ExactPoint,
    allowed: ExactPoint,
) -> bool {
    if !segments_intersect(a, b, c, d) {
        return false;
    }
    let collinear = orient(a, b, c) == Ordering::Equal && orient(a, b, d) == Ordering::Equal;
    if !collinear {
        return !(on_segment(allowed, a, b) && on_segment(allowed, c, d));
    }
    [a, b, c, d]
        .iter()
        .copied()
        .any(|point| point != allowed && on_segment(point, a, b) && on_segment(point, c, d))
}

fn hull_intersection_is_only(
    left: ExactHull<'_>,
    right: ExactHull<'_>,
    allowed: ExactPoint,
) -> bool {
    if !point_in_closed_hull(allowed, left) || !point_in_closed_hull(allowed, right) {
        return false;
    }
    for index in 0..left.indices.len() {
        let point = hull_point(left, index);
        if point != allowed && point_in_closed_hull(point, right) {
            return false;
        }
    }
    for index in 0..right.indices.len() {
        let point = hull_point(right, index);
        if point != allowed && point_in_closed_hull(point, left) {
            return false;
        }
    }
    for left_edge in 0..edge_count(left) {
        let (a, b) = hull_edge(left, left_edge);
        for right_edge in 0..edge_count(right) {
            let (c, d) = hull_edge(right, right_edge);
            if segment_intersection_has_point_other_than(a, b, c, d, allowed) {
                return false;
            }
        }
    }
    true
}

fn adjacent_shared_point(
    left: ExactLeaf,
    right: ExactLeaf,
    contours: &[TopologyRange; ABSOLUTE_MAX_CONTOURS],
) -> Option<ExactPoint> {
    if left.contour != right.contour {
        return None;
    }
    let count = contours[left.contour].count;
    if right.contour_leaf == left.contour_leaf + 1 {
        Some(left.controls[3])
    } else if left.contour_leaf == 0 && right.contour_leaf == count - 1 {
        Some(left.controls[0])
    } else {
        None
    }
}

fn directed_rounded_adjacent<'a>(
    left: &'a RoundedExactLeaf,
    right: &'a RoundedExactLeaf,
    contours: &[TopologyRange; ABSOLUTE_MAX_CONTOURS],
) -> Option<(&'a RoundedExactLeaf, &'a RoundedExactLeaf)> {
    if left.contour != right.contour {
        return None;
    }
    let count = contours[left.contour].count;
    if right.contour_leaf == left.contour_leaf + 1 {
        Some((left, right))
    } else if left.contour_leaf == 0 && right.contour_leaf == count - 1 {
        Some((right, left))
    } else {
        None
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PolygonLocation {
    Inside,
    Outside,
    Boundary,
}

fn classify_polygon(
    leaves: &[ExactLeaf],
    contour: TopologyRange,
    query: ExactPoint,
) -> PolygonLocation {
    let mut winding = 0i32;
    for offset in 0..contour.count {
        let start = leaves[contour.start + offset].controls[0];
        let end = leaves[contour.start + (offset + 1) % contour.count].controls[0];
        let side = orient(start, end, query);
        if side == Ordering::Equal && within_bounds(query, start, end) {
            return PolygonLocation::Boundary;
        }
        let upward = compare_coordinate(start.y, query.y) != Ordering::Greater
            && compare_coordinate(end.y, query.y) == Ordering::Greater;
        let downward = compare_coordinate(start.y, query.y) == Ordering::Greater
            && compare_coordinate(end.y, query.y) != Ordering::Greater;
        if upward && side == Ordering::Greater {
            winding += 1;
        } else if downward && side == Ordering::Less {
            winding -= 1;
        }
    }
    if winding == 0 {
        PolygonLocation::Outside
    } else {
        PolygonLocation::Inside
    }
}

fn classify_rounded_polygon(
    leaves: &[RoundedExactLeaf],
    contour: TopologyRange,
    query: ExactPoint,
) -> PolygonLocation {
    let mut winding = 0i32;
    for offset in 0..contour.count {
        let start = leaves[contour.start + offset].points[4];
        let end = leaves[contour.start + (offset + 1) % contour.count].points[4];
        let side = orient(start, end, query);
        if side == Ordering::Equal && within_bounds(query, start, end) {
            return PolygonLocation::Boundary;
        }
        let upward = compare_coordinate(start.y, query.y) != Ordering::Greater
            && compare_coordinate(end.y, query.y) == Ordering::Greater;
        let downward = compare_coordinate(start.y, query.y) == Ordering::Greater
            && compare_coordinate(end.y, query.y) != Ordering::Greater;
        if upward && side == Ordering::Greater {
            winding += 1;
        } else if downward && side == Ordering::Less {
            winding -= 1;
        }
    }
    if winding == 0 {
        PolygonLocation::Outside
    } else {
        PolygonLocation::Inside
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    #[test]
    fn rounded_six_point_hull_uses_every_vertex_in_lexicographic_cycle() {
        let points = [
            exact_point(point(0.0, 0.0)),
            exact_point(point(2.0, 0.0)),
            exact_point(point(3.0, 1.0)),
            exact_point(point(2.0, 2.0)),
            exact_point(point(0.0, 2.0)),
            exact_point(point(-1.0, 1.0)),
        ];
        let (indices, len) = convex_hull(&points);
        assert_eq!(len, 6);
        assert_eq!(&indices[..len], &[5, 0, 1, 2, 3, 4]);
        for index in 0..len {
            assert_eq!(
                orient(
                    points[indices[index] as usize],
                    points[indices[(index + 1) % len] as usize],
                    points[indices[(index + 2) % len] as usize],
                ),
                Ordering::Greater
            );
        }
    }

    #[test]
    fn rounded_exact_storage_and_source_scratch_fit_frozen_byte_bounds() {
        let retained = ABSOLUTE_MAX_LEAVES * size_of::<RoundedExactLeaf>();
        let source_scratch = 32 * size_of::<ExactPoint>()
            + 8 * size_of::<ExactProduct>()
            + 5 * 6 * size_of::<u8>()
            + 512;
        let split_scratch = 14 * size_of::<ExactPoint>();
        assert!(retained < ABSOLUTE_MAX_BYTES);
        assert!(source_scratch < 32 * 1024);
        assert!(split_scratch < 32 * 1024);
        let old_bytes = SimpleCubicTopologyWorkspace::new(TopologyLimits::default())
            .unwrap()
            .allocated_bytes();
        let rounded_bytes = RoundedKnotCubicTopologyWorkspace::new(TopologyLimits::default())
            .unwrap()
            .allocated_bytes();
        assert!(old_bytes >= ABSOLUTE_MAX_LEAVES * size_of::<ExactLeaf>());
        assert!(old_bytes <= ABSOLUTE_MAX_BYTES);
        assert!(rounded_bytes >= retained);
        assert!(rounded_bytes <= ABSOLUTE_MAX_BYTES);
    }

    #[test]
    fn rounded_extreme_grid_decode_and_dot_stay_within_fixed_width() {
        let maximum = exact_point(point(f64::MAX, -f64::MAX));
        let minimum = exact_point(point(f64::from_bits(1), -f64::from_bits(1)));
        let difference = point_sub(maximum, minimum);
        let squared = dot(difference, difference);
        assert!(!maximum.x.is_zero());
        assert!(!minimum.x.is_zero());
        assert!(maximum.x.used <= COORDINATE_LIMBS);
        assert!(minimum.x.used <= COORDINATE_LIMBS);
        assert!(squared.used <= PRODUCT_LIMBS);
        assert_eq!(squared.cmp_zero(), Ordering::Greater);
    }

    fn linear(start: Point, end: Point) -> [Point; 4] {
        [
            start,
            point((2.0 * start.x + end.x) / 3.0, (2.0 * start.y + end.y) / 3.0),
            point((start.x + 2.0 * end.x) / 3.0, (start.y + 2.0 * end.y) / 3.0),
            end,
        ]
    }

    fn square() -> ([TopologyRange; 1], [TopologyCubic; 4], [TopologyLeaf; 4]) {
        let points = [
            point(0.0, 0.0),
            point(3.0, 0.0),
            point(3.0, 3.0),
            point(0.0, 3.0),
        ];
        let cubics = core::array::from_fn(|index| TopologyCubic {
            points: linear(points[index], points[(index + 1) % points.len()]),
            source_verb: (index + 1) as u32,
            leaves: TopologyRange {
                start: index,
                count: 1,
            },
        });
        let leaves = core::array::from_fn(|index| TopologyLeaf {
            end: points[(index + 1) % points.len()],
            provenance: Provenance {
                source_verb: (index + 1) as u32,
                end_numerator: 1,
                depth: 0,
            },
        });
        ([TopologyRange { start: 0, count: 4 }], cubics, leaves)
    }

    fn input<'a>(
        contours: &'a [TopologyRange],
        cubics: &'a [TopologyCubic],
        leaves: &'a [TopologyLeaf],
    ) -> TopologyInput<'a> {
        TopologyInput {
            contours,
            cubics,
            leaves,
        }
    }

    fn measured_certify(
        workspace: &mut SimpleCubicTopologyWorkspace,
        input: TopologyInput<'_>,
    ) -> Result<(), TopologyError> {
        let bytes = workspace.allocated_bytes();
        crate::allocation_test_support::start();
        let result = workspace.certify(input);
        let allocations = crate::allocation_test_support::stop();
        assert_eq!(allocations, 0, "topology certification allocated");
        assert_eq!(workspace.allocated_bytes(), bytes);
        result
    }

    fn triangle(offset: f64, ordinal: u32) -> ([TopologyCubic; 3], [TopologyLeaf; 3]) {
        let corners = [
            point(offset, 0.0),
            point(offset + 3.0, 0.0),
            point(offset, 3.0),
        ];
        let cubics = core::array::from_fn(|index| TopologyCubic {
            points: linear(corners[index], corners[(index + 1) % corners.len()]),
            source_verb: ordinal + index as u32,
            leaves: TopologyRange {
                start: index,
                count: 1,
            },
        });
        let leaves = core::array::from_fn(|index| TopologyLeaf {
            end: corners[(index + 1) % corners.len()],
            provenance: Provenance {
                source_verb: ordinal + index as u32,
                end_numerator: 1,
                depth: 0,
            },
        });
        (cubics, leaves)
    }

    #[test]
    fn exact_square_certifies_owned_orientation_and_winding() {
        let (contours, cubics, leaves) = square();
        let mut workspace = SimpleCubicTopologyWorkspace::new(TopologyLimits::default()).unwrap();
        workspace
            .certify(input(&contours, &cubics, &leaves))
            .unwrap();
        assert_eq!(
            workspace.stats(),
            TopologyStats {
                leaves: 4,
                pairs: 6
            }
        );
        let output = workspace.output().unwrap();
        assert_eq!(
            output.points,
            &[
                point(0.0, 0.0),
                point(3.0, 0.0),
                point(3.0, 3.0),
                point(0.0, 3.0)
            ]
        );
        assert_eq!(output.contours, &[TopologyRange { start: 0, count: 4 }]);
        assert_eq!(output.orientations, &[1]);
        assert_eq!(output.winding, &[[0, 0, 0, 0]]);
    }

    #[test]
    fn validation_precedence_and_atomic_publication_are_stable() {
        let (contours, cubics, leaves) = square();
        let mut workspace = SimpleCubicTopologyWorkspace::new(TopologyLimits::default()).unwrap();
        measured_certify(&mut workspace, input(&contours, &cubics, &leaves)).unwrap();
        assert!(workspace.output().is_some());

        let mut invalid_cubics = cubics;
        invalid_cubics[1].source_verb = invalid_cubics[0].source_verb;
        let mut bad_leaves = leaves;
        bad_leaves[0].provenance.depth = MAX_DEPTH + 1;
        assert_eq!(
            measured_certify(
                &mut workspace,
                input(&contours, &invalid_cubics, &bad_leaves),
            ),
            Err(TopologyError::InvalidInput)
        );
        assert_eq!(workspace.stats(), TopologyStats::default());
        assert!(workspace.output().is_none());
        measured_certify(&mut workspace, input(&contours, &cubics, &leaves)).unwrap();
        assert!(workspace.output().is_some());

        assert_eq!(
            measured_certify(&mut workspace, input(&contours, &cubics, &bad_leaves)),
            Err(TopologyError::InvalidProvenance)
        );
        assert!(workspace.output().is_none());
        measured_certify(&mut workspace, input(&contours, &cubics, &leaves)).unwrap();
        assert!(workspace.output().is_some());

        bad_leaves = leaves;
        bad_leaves[0].end.x = 3.0f64.next_up();
        assert_eq!(
            measured_certify(&mut workspace, input(&contours, &cubics, &bad_leaves)),
            Err(TopologyError::KnotMismatch)
        );
        assert!(workspace.output().is_none());
        measured_certify(&mut workspace, input(&contours, &cubics, &leaves)).unwrap();
        assert!(workspace.output().is_some());

        let loop_contours = [TopologyRange { start: 0, count: 1 }];
        let loop_cubics = [TopologyCubic {
            points: [
                point(0.0, 0.0),
                point(1.0 / 16.0, 1.0 / 16.0),
                point(-1.0 / 16.0, 1.0 / 16.0),
                point(0.0, 0.0),
            ],
            source_verb: 7,
            leaves: TopologyRange { start: 0, count: 1 },
        }];
        let loop_leaves = [TopologyLeaf {
            end: point(0.0, 0.0),
            provenance: Provenance {
                source_verb: 7,
                end_numerator: 1,
                depth: 0,
            },
        }];
        assert_eq!(
            measured_certify(
                &mut workspace,
                input(&loop_contours, &loop_cubics, &loop_leaves),
            ),
            Err(TopologyError::Unresolved)
        );
        assert!(workspace.output().is_none());
        measured_certify(&mut workspace, input(&contours, &cubics, &leaves)).unwrap();
        assert!(workspace.output().is_some());
    }

    #[test]
    fn exact_depth_twenty_and_extreme_grid_widths_are_literal() {
        let minimum = f64::from_bits(1);
        let maximum = f64::MAX;
        let low = exact_point(point(minimum, -0.0));
        let high = exact_point(point(maximum, -maximum));
        assert_eq!(low.x.trailing_zeros(), GRID_SHIFT);
        assert_eq!(low.x.limbs[0], 1u64 << GRID_SHIFT);
        assert_eq!(high.x.used, COORDINATE_LIMBS);
        assert_eq!(high.x.limbs[32], 0xfe00_0000_0000_0000);
        assert_eq!(high.x.limbs[33], 0x0000_3fff_ffff_ffff);
        let opposite = exact_point(point(-maximum, maximum));
        assert_eq!(
            midpoint(high, opposite),
            ExactPoint {
                x: ExactCoordinate::zero(),
                y: ExactCoordinate::zero(),
            }
        );
        let mixed_x = ExactPoint {
            x: high.x,
            y: low.x,
        };
        let mixed_y = ExactPoint {
            x: low.x,
            y: high.x,
        };
        assert_eq!(dot(mixed_x, mixed_x).cmp_zero(), Ordering::Greater);
        assert_eq!(
            cross_vectors(mixed_x, mixed_y).cmp_zero(),
            Ordering::Greater
        );

        let extreme_source = exact_cubic([
            point(maximum, maximum),
            point(minimum, -minimum),
            point(-maximum, -maximum),
            point(-minimum, minimum),
        ]);
        let first_half = restrict_cell(extreme_source, 1, 1);
        let x = high.x;
        let m = low.x;
        let q1 = ExactPoint {
            x: x.add(m).shift_right(1),
            y: x.add(m.negated()).shift_right(1),
        };
        let q2 = ExactPoint {
            x: m.shift_right(1),
            y: m.negated().shift_right(1),
        };
        let q3 = ExactPoint {
            x: x.negated().add(m).shift_right(2),
            y: x.negated().add(m.negated()).shift_right(2),
        };
        assert_eq!(first_half, [extreme_source[0], q1, q2, q3]);
        assert_eq!(q2.x.used, 1);
        assert_eq!(q2.x.limbs[0], 1u64 << 59);
        assert!(!q2.x.negative);
        assert_eq!(q2.y.used, 1);
        assert_eq!(q2.y.limbs[0], 1u64 << 59);
        assert!(q2.y.negative);

        let extreme_square = [
            exact_point(point(-maximum, -maximum)),
            exact_point(point(maximum, -maximum)),
            exact_point(point(maximum, maximum)),
            exact_point(point(-maximum, maximum)),
        ];
        let mut exact_area = ExactProduct::zero();
        for index in 0..extreme_square.len() {
            exact_area = exact_area.add(cross_points(
                extreme_square[index],
                extreme_square[(index + 1) % extreme_square.len()],
            ));
        }
        assert_eq!(exact_area.cmp_zero(), Ordering::Greater);
        assert_eq!(exact_area.used, PRODUCT_LIMBS);
        assert_eq!(exact_area.trailing_zeros(), 4_213);

        let source = exact_cubic([
            point(0.0, 0.0),
            point(1.0, 0.0),
            point(2.0, 0.0),
            point(3.0, 0.0),
        ]);
        let leaf = restrict_cell(source, 1, MAX_DEPTH);
        assert_eq!(leaf[0], source[0]);
        assert_eq!(
            leaf[3].x.trailing_zeros(),
            1_074 + GRID_SHIFT - MAX_DEPTH as usize
        );
        assert!(projected_monotone(leaf));
    }

    #[test]
    fn limits_are_inclusive_and_byte_accounting_uses_actual_capacity() {
        let workspace = SimpleCubicTopologyWorkspace::new(TopologyLimits::default()).unwrap();
        assert_eq!(
            workspace.allocated_bytes(),
            workspace.exact_leaves.capacity() * size_of::<ExactLeaf>()
        );
        assert!(size_of::<SimpleCubicTopologyWorkspace>() < 64 * 1024);
        let exact_bytes = workspace.allocated_bytes();
        assert_eq!(
            SimpleCubicTopologyWorkspace::new(TopologyLimits {
                max_bytes: exact_bytes,
                ..TopologyLimits::default()
            })
            .unwrap()
            .allocated_bytes(),
            exact_bytes
        );
        assert!(matches!(
            SimpleCubicTopologyWorkspace::new(TopologyLimits {
                max_bytes: exact_bytes - 1,
                ..TopologyLimits::default()
            }),
            Err(TopologyError::ByteLimit)
        ));
        assert!(matches!(
            SimpleCubicTopologyWorkspace::new(TopologyLimits {
                max_bytes: 0,
                ..TopologyLimits::default()
            }),
            Err(TopologyError::ByteLimit)
        ));
        assert!(matches!(
            SimpleCubicTopologyWorkspace::new(TopologyLimits {
                max_bytes: ABSOLUTE_MAX_BYTES + 1,
                ..TopologyLimits::default()
            }),
            Err(TopologyError::InvalidLimits)
        ));
    }

    #[test]
    fn pair_and_leaf_caps_fail_before_excess_work() {
        let (contours, cubics, leaves) = square();
        let (triangle_cubics, triangle_leaves) = triangle(0.0, 1);
        let triangle_contours = [TopologyRange { start: 0, count: 3 }];
        let mut pair_workspace = SimpleCubicTopologyWorkspace::new(TopologyLimits {
            max_pairs: 5,
            ..TopologyLimits::default()
        })
        .unwrap();
        measured_certify(
            &mut pair_workspace,
            input(&triangle_contours, &triangle_cubics, &triangle_leaves),
        )
        .unwrap();
        assert_eq!(
            measured_certify(&mut pair_workspace, input(&contours, &cubics, &leaves)),
            Err(TopologyError::WorkLimit)
        );
        assert!(pair_workspace.output().is_none());
        assert_eq!(
            pair_workspace.stats(),
            TopologyStats {
                leaves: 4,
                pairs: 5
            }
        );
        measured_certify(
            &mut pair_workspace,
            input(&triangle_contours, &triangle_cubics, &triangle_leaves),
        )
        .unwrap();

        let mut leaf_workspace = SimpleCubicTopologyWorkspace::new(TopologyLimits {
            max_leaves: 3,
            ..TopologyLimits::default()
        })
        .unwrap();
        measured_certify(
            &mut leaf_workspace,
            input(&triangle_contours, &triangle_cubics, &triangle_leaves),
        )
        .unwrap();
        assert_eq!(
            measured_certify(&mut leaf_workspace, input(&contours, &cubics, &leaves)),
            Err(TopologyError::WorkLimit)
        );
        assert_eq!(leaf_workspace.stats(), TopologyStats::default());
        assert!(leaf_workspace.output().is_none());
        measured_certify(
            &mut leaf_workspace,
            input(&triangle_contours, &triangle_cubics, &triangle_leaves),
        )
        .unwrap();
    }

    #[test]
    fn malformed_ranges_nonfinite_values_and_provenance_are_distinct() {
        let (contours, cubics, leaves) = square();
        let mut workspace = SimpleCubicTopologyWorkspace::new(TopologyLimits::default()).unwrap();

        let bad_contours = [TopologyRange { start: 1, count: 4 }];
        assert_eq!(
            measured_certify(&mut workspace, input(&bad_contours, &cubics, &leaves)),
            Err(TopologyError::InvalidInput)
        );
        let mut bad_cubics = cubics;
        bad_cubics[1].leaves.start = 2;
        assert_eq!(
            measured_certify(&mut workspace, input(&contours, &bad_cubics, &leaves)),
            Err(TopologyError::InvalidInput)
        );
        bad_cubics = cubics;
        bad_cubics[2].points[1].x = f64::INFINITY;
        assert_eq!(
            measured_certify(&mut workspace, input(&contours, &bad_cubics, &leaves)),
            Err(TopologyError::InvalidInput)
        );
        let mut bad_leaves = leaves;
        bad_leaves[2].end.y = f64::NAN;
        assert_eq!(
            measured_certify(&mut workspace, input(&contours, &cubics, &bad_leaves)),
            Err(TopologyError::InvalidInput)
        );

        bad_leaves = leaves;
        bad_leaves[1].provenance.source_verb = 99;
        assert_eq!(
            measured_certify(&mut workspace, input(&contours, &cubics, &bad_leaves)),
            Err(TopologyError::InvalidProvenance)
        );
        bad_leaves = leaves;
        bad_leaves[0].provenance = Provenance {
            source_verb: 1,
            end_numerator: 1,
            depth: 1,
        };
        assert_eq!(
            measured_certify(&mut workspace, input(&contours, &cubics, &bad_leaves)),
            Err(TopologyError::InvalidProvenance)
        );

        assert_eq!(
            validate_partition_iter(
                [
                    TopologyRange {
                        start: 0,
                        count: usize::MAX,
                    },
                    TopologyRange {
                        start: usize::MAX,
                        count: 1,
                    },
                ],
                usize::MAX,
            ),
            Err(TopologyError::InvalidInput)
        );

        let mut disconnected = cubics;
        disconnected[1].points[0].x = disconnected[1].points[0].x.next_up();
        assert_eq!(
            measured_certify(&mut workspace, input(&contours, &disconnected, &leaves)),
            Err(TopologyError::InvalidInput)
        );
        measured_certify(&mut workspace, input(&contours, &cubics, &leaves)).unwrap();

        let provenance_cubic = [TopologyCubic {
            points: linear(point(0.0, 0.0), point(3.0, 0.0)),
            source_verb: 17,
            leaves: TopologyRange { start: 0, count: 2 },
        }];
        let reordered = [
            TopologyLeaf {
                end: point(3.0, 0.0),
                provenance: Provenance {
                    source_verb: 17,
                    end_numerator: 2,
                    depth: 1,
                },
            },
            TopologyLeaf {
                end: point(1.5, 0.0),
                provenance: Provenance {
                    source_verb: 17,
                    end_numerator: 1,
                    depth: 1,
                },
            },
        ];
        assert_eq!(
            validate_provenance(input(
                &[TopologyRange { start: 0, count: 1 }],
                &provenance_cubic,
                &reordered,
            )),
            Err(TopologyError::InvalidProvenance)
        );
        let gapped = [
            TopologyLeaf {
                end: point(0.75, 0.0),
                provenance: Provenance {
                    source_verb: 17,
                    end_numerator: 1,
                    depth: 2,
                },
            },
            TopologyLeaf {
                end: point(3.0, 0.0),
                provenance: Provenance {
                    source_verb: 17,
                    end_numerator: 2,
                    depth: 1,
                },
            },
        ];
        assert_eq!(
            validate_provenance(input(
                &[TopologyRange { start: 0, count: 1 }],
                &provenance_cubic,
                &gapped,
            )),
            Err(TopologyError::InvalidProvenance)
        );
    }

    #[test]
    fn all_knots_precede_every_projection_failure() {
        let contours = [TopologyRange { start: 0, count: 2 }];
        let cubics = [
            TopologyCubic {
                points: [
                    point(0.0, 0.0),
                    point(2.0, 0.0),
                    point(-1.0, 0.0),
                    point(1.0, 0.0),
                ],
                source_verb: 1,
                leaves: TopologyRange { start: 0, count: 1 },
            },
            TopologyCubic {
                points: linear(point(1.0, 0.0), point(2.0, 0.0)),
                source_verb: 2,
                leaves: TopologyRange { start: 1, count: 1 },
            },
        ];
        let leaves = [
            TopologyLeaf {
                end: point(1.0, 0.0),
                provenance: Provenance {
                    source_verb: 1,
                    end_numerator: 1,
                    depth: 0,
                },
            },
            TopologyLeaf {
                end: point(2.0f64.next_up(), 0.0),
                provenance: Provenance {
                    source_verb: 2,
                    end_numerator: 1,
                    depth: 0,
                },
            },
        ];
        let mut workspace = SimpleCubicTopologyWorkspace::new(TopologyLimits::default()).unwrap();
        assert_eq!(
            measured_certify(&mut workspace, input(&contours, &cubics, &leaves)),
            Err(TopologyError::KnotMismatch)
        );
        assert_eq!(workspace.stats(), TopologyStats::default());
    }

    #[test]
    fn contour_and_cubic_count_limits_are_exact() {
        let (left_cubics, left_leaves) = triangle(0.0, 1);
        let (mut right_cubics, right_leaves) = triangle(16.0, 4);
        for cubic in &mut right_cubics {
            cubic.leaves.start += 3;
        }
        let mut cubics = [TopologyCubic::default(); 6];
        cubics[..3].copy_from_slice(&left_cubics);
        cubics[3..].copy_from_slice(&right_cubics);
        let mut leaves = [TopologyLeaf::default(); 6];
        leaves[..3].copy_from_slice(&left_leaves);
        leaves[3..].copy_from_slice(&right_leaves);
        let contours = [
            TopologyRange { start: 0, count: 3 },
            TopologyRange { start: 3, count: 3 },
        ];

        let mut exact = SimpleCubicTopologyWorkspace::new(TopologyLimits {
            max_contours: 2,
            max_cubics: 6,
            max_leaves: 6,
            max_pairs: 15,
            max_bytes: ABSOLUTE_MAX_BYTES,
        })
        .unwrap();
        measured_certify(&mut exact, input(&contours, &cubics, &leaves)).unwrap();
        assert_eq!(
            exact.stats(),
            TopologyStats {
                leaves: 6,
                pairs: 15
            }
        );

        let mut contour_short = SimpleCubicTopologyWorkspace::new(TopologyLimits {
            max_contours: 1,
            max_cubics: 6,
            max_leaves: 6,
            max_pairs: 15,
            max_bytes: ABSOLUTE_MAX_BYTES,
        })
        .unwrap();
        assert_eq!(
            measured_certify(&mut contour_short, input(&contours, &cubics, &leaves)),
            Err(TopologyError::WorkLimit)
        );
        assert_eq!(contour_short.stats(), TopologyStats::default());
        measured_certify(
            &mut contour_short,
            input(
                &[TopologyRange { start: 0, count: 3 }],
                &left_cubics,
                &left_leaves,
            ),
        )
        .unwrap();

        let (square_contours, square_cubics, square_leaves) = square();
        let mut cubic_exact = SimpleCubicTopologyWorkspace::new(TopologyLimits {
            max_cubics: 4,
            max_leaves: 4,
            max_pairs: 6,
            ..TopologyLimits::default()
        })
        .unwrap();
        measured_certify(
            &mut cubic_exact,
            input(&square_contours, &square_cubics, &square_leaves),
        )
        .unwrap();
        let mut cubic_short = SimpleCubicTopologyWorkspace::new(TopologyLimits {
            max_cubics: 3,
            ..TopologyLimits::default()
        })
        .unwrap();
        measured_certify(
            &mut cubic_short,
            input(
                &[TopologyRange { start: 0, count: 3 }],
                &left_cubics,
                &left_leaves,
            ),
        )
        .unwrap();
        assert_eq!(
            measured_certify(
                &mut cubic_short,
                input(&square_contours, &square_cubics, &square_leaves),
            ),
            Err(TopologyError::WorkLimit)
        );
        assert!(cubic_short.output().is_none());
        measured_certify(
            &mut cubic_short,
            input(
                &[TopologyRange { start: 0, count: 3 }],
                &left_cubics,
                &left_leaves,
            ),
        )
        .unwrap();
    }

    #[test]
    fn earlier_implicit_closure_consumes_capacity_before_later_projection() {
        let contours = [
            TopologyRange { start: 0, count: 2 },
            TopologyRange { start: 2, count: 1 },
        ];
        let cubics = [
            TopologyCubic {
                points: linear(point(0.0, 0.0), point(2.0, 0.0)),
                source_verb: 1,
                leaves: TopologyRange { start: 0, count: 1 },
            },
            TopologyCubic {
                points: linear(point(2.0, 0.0), point(1.0, 1.0)),
                source_verb: 2,
                leaves: TopologyRange { start: 1, count: 1 },
            },
            TopologyCubic {
                points: [
                    point(10.0, 0.0),
                    point(12.0, 0.0),
                    point(9.0, 0.0),
                    point(11.0, 0.0),
                ],
                source_verb: 4,
                leaves: TopologyRange { start: 2, count: 1 },
            },
        ];
        let leaves = [
            TopologyLeaf {
                end: point(2.0, 0.0),
                provenance: Provenance {
                    source_verb: 1,
                    end_numerator: 1,
                    depth: 0,
                },
            },
            TopologyLeaf {
                end: point(1.0, 1.0),
                provenance: Provenance {
                    source_verb: 2,
                    end_numerator: 1,
                    depth: 0,
                },
            },
            TopologyLeaf {
                end: point(11.0, 0.0),
                provenance: Provenance {
                    source_verb: 4,
                    end_numerator: 1,
                    depth: 0,
                },
            },
        ];
        let mut capped = SimpleCubicTopologyWorkspace::new(TopologyLimits {
            max_contours: 2,
            max_cubics: 3,
            max_leaves: 3,
            max_pairs: 3,
            max_bytes: ABSOLUTE_MAX_BYTES,
        })
        .unwrap();
        assert_eq!(
            capped.certify(input(&contours, &cubics, &leaves)),
            Err(TopologyError::WorkLimit)
        );
        assert_eq!(
            capped.stats(),
            TopologyStats {
                leaves: 3,
                pairs: 0
            }
        );

        let mut uncapped = SimpleCubicTopologyWorkspace::new(TopologyLimits {
            max_contours: 2,
            max_cubics: 3,
            max_leaves: 4,
            max_pairs: 6,
            max_bytes: ABSOLUTE_MAX_BYTES,
        })
        .unwrap();
        assert_eq!(
            uncapped.certify(input(&contours, &cubics, &leaves)),
            Err(TopologyError::Unresolved)
        );
        assert_eq!(
            uncapped.stats(),
            TopologyStats {
                leaves: 3,
                pairs: 0
            }
        );
    }

    #[test]
    fn stationary_endpoint_tangents_and_signed_zero_preserve_owned_points() {
        let corners = [point(-0.0, 0.0), point(3.0, 0.0), point(0.0, 3.0)];
        let mut cubics: [TopologyCubic; 3] = core::array::from_fn(|index| {
            let start = corners[index];
            let end = corners[(index + 1) % corners.len()];
            TopologyCubic {
                points: [start, start, end, end],
                source_verb: (index + 1) as u32,
                leaves: TopologyRange {
                    start: index,
                    count: 1,
                },
            }
        });
        let leaves: [TopologyLeaf; 3] = core::array::from_fn(|index| TopologyLeaf {
            end: corners[(index + 1) % corners.len()],
            provenance: Provenance {
                source_verb: (index + 1) as u32,
                end_numerator: 1,
                depth: 0,
            },
        });
        let contours = [TopologyRange { start: 0, count: 3 }];
        let mut workspace = SimpleCubicTopologyWorkspace::new(TopologyLimits::default()).unwrap();
        measured_certify(&mut workspace, input(&contours, &cubics, &leaves)).unwrap();
        assert_eq!(
            workspace.output().unwrap().points[0].x.to_bits(),
            1u64 << 63
        );
        cubics[0].points[0].x = 99.0;
        assert_eq!(cubics[0].points[0].x, 99.0);
        assert_eq!(
            workspace.output().unwrap().points[0].x.to_bits(),
            1u64 << 63
        );
    }

    #[test]
    fn depth_twenty_partition_certifies_with_bounded_leaf_and_pair_counts() {
        let scale = 2.0f64.powi(20);
        let corners = [
            point(0.0, 0.0),
            point(3.0 * scale, 0.0),
            point(3.0 * scale, 3.0 * scale),
            point(0.0, 3.0 * scale),
        ];
        let mut leaves = Vec::new();
        leaves.push(TopologyLeaf {
            end: point(3.0, 0.0),
            provenance: Provenance {
                source_verb: 1,
                end_numerator: 1,
                depth: 20,
            },
        });
        leaves.push(TopologyLeaf {
            end: point(6.0, 0.0),
            provenance: Provenance {
                source_verb: 1,
                end_numerator: 2,
                depth: 20,
            },
        });
        for depth in (1..20).rev() {
            leaves.push(TopologyLeaf {
                end: point(3.0 * 2.0f64.powi(20 - depth as i32 + 1), 0.0),
                provenance: Provenance {
                    source_verb: 1,
                    end_numerator: 2,
                    depth,
                },
            });
        }
        for index in 1..4 {
            leaves.push(TopologyLeaf {
                end: corners[(index + 1) % corners.len()],
                provenance: Provenance {
                    source_verb: (index + 1) as u32,
                    end_numerator: 1,
                    depth: 0,
                },
            });
        }
        let cubics = [
            TopologyCubic {
                points: [
                    corners[0],
                    point(scale, 0.0),
                    point(2.0 * scale, 0.0),
                    corners[1],
                ],
                source_verb: 1,
                leaves: TopologyRange {
                    start: 0,
                    count: 21,
                },
            },
            TopologyCubic {
                points: linear(corners[1], corners[2]),
                source_verb: 2,
                leaves: TopologyRange {
                    start: 21,
                    count: 1,
                },
            },
            TopologyCubic {
                points: linear(corners[2], corners[3]),
                source_verb: 3,
                leaves: TopologyRange {
                    start: 22,
                    count: 1,
                },
            },
            TopologyCubic {
                points: linear(corners[3], corners[0]),
                source_verb: 4,
                leaves: TopologyRange {
                    start: 23,
                    count: 1,
                },
            },
        ];
        let contours = [TopologyRange { start: 0, count: 4 }];
        let mut workspace = SimpleCubicTopologyWorkspace::new(TopologyLimits::default()).unwrap();
        workspace
            .certify(input(&contours, &cubics, &leaves))
            .unwrap();
        assert_eq!(
            workspace.stats(),
            TopologyStats {
                leaves: 24,
                pairs: 276
            }
        );
        assert_eq!(workspace.output().unwrap().orientations, &[1]);
    }

    #[test]
    fn certify_is_allocation_free_and_workspaces_are_isolated() {
        let (contours, cubics, leaves) = square();
        let mut first = SimpleCubicTopologyWorkspace::new(TopologyLimits::default()).unwrap();
        let mut second = SimpleCubicTopologyWorkspace::new(TopologyLimits::default()).unwrap();
        measured_certify(&mut first, input(&contours, &cubics, &leaves)).unwrap();
        measured_certify(&mut second, input(&contours, &cubics, &leaves)).unwrap();
        assert!(first.output().is_some());
        assert!(second.output().is_some());

        let mut bad = leaves;
        bad[0].end.x = 3.0f64.next_up();
        assert_eq!(
            measured_certify(&mut first, input(&contours, &cubics, &bad)),
            Err(TopologyError::KnotMismatch)
        );
        assert!(first.output().is_none());
        assert!(second.output().is_some());
        measured_certify(&mut first, input(&contours, &cubics, &leaves)).unwrap();
        assert!(first.output().is_some());
        assert!(second.output().is_some());
    }

    #[test]
    fn knot_mismatch_precedes_projection_and_copies_signed_zero_on_success() {
        let contours = [TopologyRange { start: 0, count: 1 }];
        let cubic = TopologyCubic {
            points: [
                point(-0.0, 0.0),
                point(1.0, 0.0),
                point(-1.0, 0.0),
                point(0.0, 0.0),
            ],
            source_verb: 7,
            leaves: TopologyRange { start: 0, count: 1 },
        };
        let mut leaf = TopologyLeaf {
            end: point(f64::from_bits(1), 0.0),
            provenance: Provenance {
                source_verb: 7,
                end_numerator: 1,
                depth: 0,
            },
        };
        let mut workspace = SimpleCubicTopologyWorkspace::new(TopologyLimits::default()).unwrap();
        assert_eq!(
            workspace.certify(input(&contours, &[cubic], &[leaf])),
            Err(TopologyError::KnotMismatch)
        );
        assert_eq!(workspace.stats(), TopologyStats::default());

        leaf.end = point(0.0, 0.0);
        assert_eq!(
            workspace.certify(input(&contours, &[cubic], &[leaf])),
            Err(TopologyError::Unresolved)
        );
        assert_eq!(workspace.stats(), TopologyStats::default());
    }
}
