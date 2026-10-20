use core::cmp::Ordering;
use core::mem::size_of;

use crate::fill_exact::{multiply, Signed};
use crate::fill_filter::{self, compare_enclosures, enclose, FilterId, Interval, UNDECIDED};
use crate::geometry::{Point, Provenance};

// D8 B1 kernel caps (`docs/plans/p3-fill-stroke-meshes.md`, "B1 kernel caps"): the leaf and
// cubic caps equal `cubic_fill.rs`'s `MAX_EDGE_OWNERS` and `MAX_SOURCE_SEGMENTS` (pre-B1: 64 and
// 16), the pair budget is every pair of that many leaves, as before, and the byte cap fits
// ABSOLUTE_MAX_LEAVES retained `RoundedExactLeaf` records.
const ABSOLUTE_MAX_CONTOURS: usize = 4;
const ABSOLUTE_MAX_CUBICS: usize = 64;
const ABSOLUTE_MAX_LEAVES: usize = 256;
const ABSOLUTE_MAX_PAIRS: usize = ABSOLUTE_MAX_LEAVES * (ABSOLUTE_MAX_LEAVES - 1) / 2;
const ABSOLUTE_MAX_BYTES: usize = 1024 * 1024;
/// The arrangement crossing ceiling, `ABSOLUTE_MAX_LEAVES / 2` before B1. B1 keeps it at 32: it
/// bounds the triangle-free scan's quadratic prefix search, and a larger ceiling would only
/// admit more crossings, which no B1 workload needs.
const MAX_CROSSINGS: usize = 32;
/// Words of one leaf bitset row (B0R section 4.3's candidate rows and the unboxed-leaf mask).
const LEAF_WORDS: usize = ABSOLUTE_MAX_LEAVES.div_ceil(64);
// The sweep order stores leaf indices as u16.
const _: () = assert!(ABSOLUTE_MAX_LEAVES <= u16::MAX as usize + 1);
const _: () = assert!(MAX_CROSSINGS <= ABSOLUTE_MAX_LEAVES / 2);
const MAX_DEPTH: u32 = 20;
const COORDINATE_LIMBS: usize = 34;
const PRODUCT_LIMBS: usize = 68;
const GRID_SHIFT: usize = 60;
/// B0R section 3.3: topology coordinates are integers on the grid 2^-(1074 + GRID_SHIFT).
const GRID_UNIT_EXPONENT: i32 = 1074 + GRID_SHIFT as i32;

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
    // The sole heap owner is rounded. The additional inline arrangement storage is
    // ABSOLUTE_MAX_LEAVES (64 before B1, 256 since) usize matching-partner slots, 32 bounded
    // crossing records, one length, and one publication flag; the native unit freezes the
    // complete wrapper at 2,512 bytes before B1 and 7,120 since (at most 16 KiB).
    rounded: RoundedKnotCubicTopologyWorkspace,
    partners: [usize; ABSOLUTE_MAX_LEAVES],
    crossings: [ArrangementCrossing; MAX_CROSSINGS],
    crossing_len: usize,
    published: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ArrangementPolicy {
    Matching,
    TriangleFree,
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
        let max_pairs = self.limits.max_pairs;
        #[cfg(test)]
        if let Some(result) = b0r_pair_loop_override(&mut SimplePairLoops(self), max_pairs) {
            return result;
        }
        self.sweep_pairs(max_pairs)
    }

    /// B0R section 4: the candidate pairs C in lexicographic order with the Lemma B counter.
    fn sweep_pairs(&mut self, max_pairs: usize) -> Result<(), TopologyError> {
        let leaf_count = self.exact_leaves.len();
        let candidates = self.pair_candidates();
        for (left_index, right_index) in candidates.pairs() {
            enter_pair(
                &mut self.stats.pairs,
                leaf_count,
                left_index,
                right_index,
                max_pairs,
            )?;
            self.check_pair(left_index, right_index)?;
        }
        finish_pairs(&mut self.stats.pairs, leaf_count, max_pairs)
    }

    fn pair_candidates(&self) -> PairCandidates {
        let (boxes, wild) = leaf_boxes(self.exact_leaves.iter().map(|leaf| &leaf.controls[..]));
        PairCandidates::new(
            self.exact_leaves.len(),
            &boxes,
            wild,
            &self.contours[..self.contour_len],
        )
    }

    /// The unchanged per-pair body of the pre-B0R loop.
    fn check_pair(&self, left_index: usize, right_index: usize) -> Result<(), TopologyError> {
        let left = &self.exact_leaves[left_index];
        let right = &self.exact_leaves[right_index];
        if let Some(shared) = adjacent_shared_point(*left, *right, &self.contours) {
            if !hull_intersection_is_only(exact_leaf_hull(left), exact_leaf_hull(right), shared) {
                return Err(TopologyError::Unresolved);
            }
        } else if closed_hulls_intersect(exact_leaf_hull(left), exact_leaf_hull(right)) {
            return Err(TopologyError::Unresolved);
        }
        Ok(())
    }

    /// The pre-B0R all-pairs loop, kept as the O3 reference. Only the budget is a parameter;
    /// `touched` receives every pair whose body returned an error.
    #[cfg(test)]
    #[allow(clippy::needless_range_loop)]
    fn reference_pairs(
        &mut self,
        max_pairs: usize,
        touched: &mut [LeafRow; ABSOLUTE_MAX_LEAVES],
    ) -> Result<(), TopologyError> {
        for left_index in 0..self.exact_leaves.len() {
            for right_index in (left_index + 1)..self.exact_leaves.len() {
                if self.stats.pairs == max_pairs {
                    return Err(TopologyError::WorkLimit);
                }
                self.stats.pairs += 1;
                if let Err(error) = self.reference_pair_body(left_index, right_index) {
                    set_bit(&mut touched[left_index], right_index);
                    return Err(error);
                }
            }
        }
        Ok(())
    }

    /// The pre-B0R pair body, copied verbatim for the reference loop.
    #[cfg(test)]
    fn reference_pair_body(
        &self,
        left_index: usize,
        right_index: usize,
    ) -> Result<(), TopologyError> {
        let left = &self.exact_leaves[left_index];
        let right = &self.exact_leaves[right_index];
        if let Some(shared) = adjacent_shared_point(*left, *right, &self.contours) {
            if !hull_intersection_is_only(exact_leaf_hull(left), exact_leaf_hull(right), shared) {
                return Err(TopologyError::Unresolved);
            }
        } else if closed_hulls_intersect(exact_leaf_hull(left), exact_leaf_hull(right)) {
            return Err(TopologyError::Unresolved);
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
        self.prepare_preflight(input)?;
        self.prepare_suffix(input)
    }

    fn prepare_preflight(&mut self, input: TopologyInput<'_>) -> Result<(), TopologyError> {
        self.begin_attempt();
        validate_counts(self.limits, input)?;
        validate_structure(input)?;
        validate_provenance(input)?;
        Ok(())
    }

    fn prepare_suffix(&mut self, input: TopologyInput<'_>) -> Result<(), TopologyError> {
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
        let max_pairs = self.limits.max_pairs;
        #[cfg(test)]
        if let Some(result) = b0r_pair_loop_override(&mut RoundedPairLoops(self), max_pairs) {
            return result;
        }
        self.sweep_pairs(max_pairs)
    }

    /// B0R section 4: the candidate pairs C in lexicographic order with the Lemma B counter.
    fn sweep_pairs(&mut self, max_pairs: usize) -> Result<(), TopologyError> {
        let leaf_count = self.exact_leaves.len();
        let candidates = self.pair_candidates();
        for (left_index, right_index) in candidates.pairs() {
            enter_pair(
                &mut self.stats.pairs,
                leaf_count,
                left_index,
                right_index,
                max_pairs,
            )?;
            self.check_pair(left_index, right_index)?;
        }
        finish_pairs(&mut self.stats.pairs, leaf_count, max_pairs)
    }

    fn pair_candidates(&self) -> PairCandidates {
        let (boxes, wild) = leaf_boxes(self.exact_leaves.iter().map(|leaf| &leaf.points[..]));
        PairCandidates::new(
            self.exact_leaves.len(),
            &boxes,
            wild,
            &self.contours[..self.contour_len],
        )
    }

    /// The unchanged per-pair body of the pre-B0R loop.
    fn check_pair(&self, left_index: usize, right_index: usize) -> Result<(), TopologyError> {
        let left = &self.exact_leaves[left_index];
        let right = &self.exact_leaves[right_index];
        if let Some((previous, next)) = directed_rounded_adjacent(left, right, &self.contours) {
            let direction = point_sub(next.points[3], previous.points[0]);
            if !rounded_projected_monotone(previous, direction)
                || !rounded_projected_monotone(next, direction)
            {
                return Err(TopologyError::Unresolved);
            }
        } else if closed_hulls_intersect(rounded_leaf_hull(left), rounded_leaf_hull(right)) {
            return Err(TopologyError::Unresolved);
        }
        Ok(())
    }

    /// The pre-B0R all-pairs loop, kept as the O3 reference. Only the budget is a parameter;
    /// `touched` receives every pair whose body returned an error.
    #[cfg(test)]
    #[allow(clippy::needless_range_loop)]
    fn reference_pairs(
        &mut self,
        max_pairs: usize,
        touched: &mut [LeafRow; ABSOLUTE_MAX_LEAVES],
    ) -> Result<(), TopologyError> {
        for left_index in 0..self.exact_leaves.len() {
            for right_index in (left_index + 1)..self.exact_leaves.len() {
                if self.stats.pairs == max_pairs {
                    return Err(TopologyError::WorkLimit);
                }
                self.stats.pairs += 1;
                if let Err(error) = self.reference_pair_body(left_index, right_index) {
                    set_bit(&mut touched[left_index], right_index);
                    return Err(error);
                }
            }
        }
        Ok(())
    }

    /// The pre-B0R pair body, copied verbatim for the reference loop.
    #[cfg(test)]
    fn reference_pair_body(
        &self,
        left_index: usize,
        right_index: usize,
    ) -> Result<(), TopologyError> {
        let left = &self.exact_leaves[left_index];
        let right = &self.exact_leaves[right_index];
        if let Some((previous, next)) = directed_rounded_adjacent(left, right, &self.contours) {
            let direction = point_sub(next.points[3], previous.points[0]);
            if !rounded_projected_monotone(previous, direction)
                || !rounded_projected_monotone(next, direction)
            {
                return Err(TopologyError::Unresolved);
            }
        } else if closed_hulls_intersect(rounded_leaf_hull(left), rounded_leaf_hull(right)) {
            return Err(TopologyError::Unresolved);
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
            crossings: [ArrangementCrossing::default(); MAX_CROSSINGS],
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

    pub(crate) fn certify_mixed(
        &mut self,
        input: TopologyInput<'_>,
        source_kinds: &[bool],
    ) -> Result<(), TopologyError> {
        self.certify_mixed_with_policy(input, source_kinds, ArrangementPolicy::Matching)
    }

    pub(crate) fn certify_triangle_free(
        &mut self,
        input: TopologyInput<'_>,
        source_kinds: &[bool],
    ) -> Result<(), TopologyError> {
        self.certify_mixed_with_policy(input, source_kinds, ArrangementPolicy::TriangleFree)
    }

    fn certify_mixed_with_policy(
        &mut self,
        input: TopologyInput<'_>,
        source_kinds: &[bool],
        policy: ArrangementPolicy,
    ) -> Result<(), TopologyError> {
        self.begin_attempt();
        self.rounded.prepare_preflight(input)?;
        validate_mixed_source_kinds(input, source_kinds)?;
        self.rounded.prepare_suffix(input)?;

        // This attempt-local map retains no source sidecar or leaf record. Source leaves occupy
        // the prefix of each prepared contour in packed source order; any following closure slot
        // remains false. A conservative 1 KiB covers the 256 booleans (64 before B1), input slices,
        // policy/result values, range iterators, and scalar indices in this nonrecursive helper.
        let mut marked_lines = [false; ABSOLUTE_MAX_LEAVES];
        for (contour_index, source_range) in input.contours.iter().copied().enumerate() {
            let mut retained_index = self.rounded.contours[contour_index].start;
            for source_index in range(source_range) {
                let cubic = &input.cubics[source_index];
                for _ in 0..cubic.leaves.count {
                    marked_lines[retained_index] = source_kinds[source_index];
                    retained_index += 1;
                }
            }
        }

        self.validate_pairs_with_kinds(Some(&marked_lines), policy)?;
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
        self.validate_pairs_with_kinds(None, ArrangementPolicy::Matching)
    }

    fn validate_pairs_with_kinds(
        &mut self,
        marked_lines: Option<&[bool; ABSOLUTE_MAX_LEAVES]>,
        policy: ArrangementPolicy,
    ) -> Result<(), TopologyError> {
        // Pair inspection borrows both retained records. Its largest exact scratch is the shared
        // transverse-orientation envelope above; no RoundedExactLeaf or six-point array is copied.
        // Optional marked-LINE state adds one borrowed 256-boolean array and scalar flags. The
        // triangle-free scan borrows the at-most-32-record prefix and uses two record references,
        // one witness index, and booleans; it neither copies the array nor allocates graph storage.
        let max_pairs = self.rounded.limits.max_pairs;
        #[cfg(test)]
        if let Some(result) = b0r_pair_loop_override(
            &mut TransversePairLoops {
                workspace: self,
                marked_lines,
                policy,
            },
            max_pairs,
        ) {
            return result;
        }
        self.sweep_pairs(marked_lines, policy, max_pairs)
    }

    /// B0R section 4: the candidate pairs C in lexicographic order with the Lemma B counter,
    /// so partners, the triangle-free crossing prefix and the crossing records are built in the
    /// order of the pre-B0R loop.
    fn sweep_pairs(
        &mut self,
        marked_lines: Option<&[bool; ABSOLUTE_MAX_LEAVES]>,
        policy: ArrangementPolicy,
        max_pairs: usize,
    ) -> Result<(), TopologyError> {
        let leaf_count = self.rounded.exact_leaves.len();
        let candidates = self.rounded.pair_candidates();
        for (left_index, right_index) in candidates.pairs() {
            enter_pair(
                &mut self.rounded.stats.pairs,
                leaf_count,
                left_index,
                right_index,
                max_pairs,
            )?;
            self.check_pair(left_index, right_index, marked_lines, policy)?;
        }
        finish_pairs(&mut self.rounded.stats.pairs, leaf_count, max_pairs)
    }

    /// The unchanged per-pair body of the pre-B0R loop; its `continue` is the early `Ok`.
    fn check_pair(
        &mut self,
        left_index: usize,
        right_index: usize,
        marked_lines: Option<&[bool; ABSOLUTE_MAX_LEAVES]>,
        policy: ArrangementPolicy,
    ) -> Result<(), TopologyError> {
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
            } else if !closed_hulls_intersect(rounded_leaf_hull(left), rounded_leaf_hull(right)) {
                None
            } else {
                Some(
                    certify_transverse_rounded_pair_with_kinds(
                        left,
                        left.closure || marked_lines.is_some_and(|kinds| kinds[left_index]),
                        right,
                        right.closure || marked_lines.is_some_and(|kinds| kinds[right_index]),
                    )
                    .ok_or(TopologyError::Unresolved)?,
                )
            }
        };

        let Some(orientation) = orientation else {
            return Ok(());
        };
        match policy {
            ArrangementPolicy::Matching => {
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
            }
            ArrangementPolicy::TriangleFree => {
                if closes_crossing_triangle(
                    &self.crossings[..self.crossing_len],
                    left_index,
                    right_index,
                ) {
                    return Err(TopologyError::Unresolved);
                }
                if self.crossing_len == self.crossings.len() {
                    return Err(TopologyError::WorkLimit);
                }
            }
        }
        self.crossings[self.crossing_len] = ArrangementCrossing {
            left_leaf: left_index,
            right_leaf: right_index,
            orientation,
        };
        self.crossing_len += 1;
        Ok(())
    }

    /// The pre-B0R all-pairs loop, kept as the O3 reference. Only the budget is a parameter;
    /// `touched` receives every pair whose body returned an error or appended a crossing.
    #[cfg(test)]
    #[allow(clippy::needless_range_loop)]
    fn reference_pairs(
        &mut self,
        marked_lines: Option<&[bool; ABSOLUTE_MAX_LEAVES]>,
        policy: ArrangementPolicy,
        max_pairs: usize,
        touched: &mut [LeafRow; ABSOLUTE_MAX_LEAVES],
    ) -> Result<(), TopologyError> {
        for left_index in 0..self.rounded.exact_leaves.len() {
            for right_index in (left_index + 1)..self.rounded.exact_leaves.len() {
                if self.rounded.stats.pairs == max_pairs {
                    return Err(TopologyError::WorkLimit);
                }
                self.rounded.stats.pairs += 1;
                let before = self.crossing_len;
                let outcome =
                    self.reference_pair_body(left_index, right_index, marked_lines, policy);
                if outcome.is_err() || self.crossing_len != before {
                    set_bit(&mut touched[left_index], right_index);
                }
                outcome?;
            }
        }
        Ok(())
    }

    /// The pre-B0R pair body, copied verbatim for the reference loop; `continue` is `Ok(())`.
    #[cfg(test)]
    fn reference_pair_body(
        &mut self,
        left_index: usize,
        right_index: usize,
        marked_lines: Option<&[bool; ABSOLUTE_MAX_LEAVES]>,
        policy: ArrangementPolicy,
    ) -> Result<(), TopologyError> {
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
            } else if !closed_hulls_intersect(rounded_leaf_hull(left), rounded_leaf_hull(right)) {
                None
            } else {
                Some(
                    certify_transverse_rounded_pair_with_kinds(
                        left,
                        left.closure || marked_lines.is_some_and(|kinds| kinds[left_index]),
                        right,
                        right.closure || marked_lines.is_some_and(|kinds| kinds[right_index]),
                    )
                    .ok_or(TopologyError::Unresolved)?,
                )
            }
        };

        let Some(orientation) = orientation else {
            return Ok(());
        };
        match policy {
            ArrangementPolicy::Matching => {
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
            }
            ArrangementPolicy::TriangleFree => {
                if closes_crossing_triangle(
                    &self.crossings[..self.crossing_len],
                    left_index,
                    right_index,
                ) {
                    return Err(TopologyError::Unresolved);
                }
                if self.crossing_len == self.crossings.len() {
                    return Err(TopologyError::WorkLimit);
                }
            }
        }
        self.crossings[self.crossing_len] = ArrangementCrossing {
            left_leaf: left_index,
            right_leaf: right_index,
            orientation,
        };
        self.crossing_len += 1;
        Ok(())
    }

    /// B0R O3(b) test access: the matching partner slots.
    #[cfg(test)]
    pub(crate) fn b0r_partners(&self) -> [usize; ABSOLUTE_MAX_LEAVES] {
        self.partners
    }
}

fn closes_crossing_triangle(
    crossings: &[ArrangementCrossing],
    left_leaf: usize,
    right_leaf: usize,
) -> bool {
    // This nonrecursive graph scan borrows the at-most-32-record prefix. Two iterator states,
    // crossing references, one optional witness index, arguments, and booleans stay below 1 KiB;
    // no crossing array or retained record is copied.
    for left_crossing in crossings {
        let witness = if left_crossing.left_leaf == left_leaf {
            Some(left_crossing.right_leaf)
        } else if left_crossing.right_leaf == left_leaf {
            Some(left_crossing.left_leaf)
        } else {
            None
        };
        let Some(witness) = witness else {
            continue;
        };
        if crossings.iter().any(|right_crossing| {
            (right_crossing.left_leaf == right_leaf && right_crossing.right_leaf == witness)
                || (right_crossing.right_leaf == right_leaf && right_crossing.left_leaf == witness)
        }) {
            return true;
        }
    }
    false
}

// B0R technique 2 (docs/plans/p3-b0r-kernel-performance-contract.md section 4): sweep-based pair
// candidates for the three pair loops above.
//
// - Section 4.2. B_i is the closed box spanned by the section 3.3 enclosures of every coordinate
//   of the leaf's point set (the four restricted controls, or the six rounded points). It contains
//   the leaf's hull. F holds every pair of one contour whose contour_leaf values differ by one or
//   are 0 and count - 1, a superset of the pairs on which `adjacent_shared_point` or
//   `directed_rounded_adjacent` returns Some. C = F, plus every pair of closed-overlapping boxes,
//   plus every pair with a leaf whose box cannot be formed (an enclosure is None).
// - Lemma A. A pair outside C is not adjacent, so its body evaluates `closed_hulls_intersect`;
//   separated boxes give disjoint hulls, so that returns false and the body returns Ok without
//   changing any state. Skipping it changes nothing but the pair counter.
// - Section 4.3. The boxed leaves are insertion-sorted by x_lo into a [u8; 64]; each leaf scans
//   the following ones while their x_lo <= its x_hi and marks those whose y ranges also overlap.
//   Marks go to a [u64; 64] bitset, row i holding bit j for j > i.
// - Section 4.4. Candidates are read in lexicographic (i, j) order, the order of the pre-B0R
//   loops restricted to C. The counter emulates the pre-B0R loop exactly (Lemma B): with
//   rank(i, j) = i(2n - i - 1)/2 + (j - i - 1) and T = n(n - 1)/2, a candidate at rank p >=
//   max_pairs sets pairs = max_pairs and returns WorkLimit; otherwise pairs = p + 1 and the
//   unchanged body runs. After the last candidate, T > max_pairs gives pairs = max_pairs and
//   WorkLimit, else pairs = T. Every pair loop starts with pairs == 0 (begin_attempt), which the
//   pre-B0R loop's `pairs == max_pairs` test also assumed.
//
// Scratch: 64 boxes (2 KiB), one wild mask, the 512-byte bitset and the 64-byte order, all on
// the stack of the nonrecursive sweep helpers, well inside the source-level envelopes above.
// Nothing is allocated or retained; no workspace field changes.
//
// B1 widening (`docs/plans/p3-fill-stroke-meshes.md`, "B1 kernel caps"): with
// ABSOLUTE_MAX_LEAVES = 256 a bitset row is LEAF_WORDS = 4 u64 words, bit j of row i in word
// j / 64 at position j % 64, and the order holds u16 indices. For at most 64 leaves only word 0
// is ever set, so every mark, read and iteration order is the pre-B1 one. Scratch at 256 leaves:
// 256 boxes (8 KiB), a 32-byte wild mask, the 8 KiB bitset and the 512-byte order, still on the
// stack of the same nonrecursive helpers.

/// One leaf bitset row (B1): bit j in word j / 64.
type LeafRow = [u64; LEAF_WORDS];

const EMPTY_ROW: LeafRow = [0; LEAF_WORDS];

fn set_bit(row: &mut LeafRow, bit: usize) {
    row[bit / 64] |= 1u64 << (bit % 64);
}

fn has_bit(row: &LeafRow, bit: usize) -> bool {
    row[bit / 64] & (1u64 << (bit % 64)) != 0
}

/// Section 4.2: the closed box spanned by the enclosures of one leaf's points.
#[derive(Clone, Copy, Debug, PartialEq)]
struct LeafBox {
    x_lo: f64,
    x_hi: f64,
    y_lo: f64,
    y_hi: f64,
}

const EMPTY_BOX: LeafBox = LeafBox {
    x_lo: 0.0,
    x_hi: 0.0,
    y_lo: 0.0,
    y_hi: 0.0,
};

fn leaf_box(points: &[ExactPoint]) -> Option<LeafBox> {
    let mut result: Option<LeafBox> = None;
    for point in points {
        let x = enclose_coordinate(&point.x)?;
        let y = enclose_coordinate(&point.y)?;
        result = Some(match result {
            None => LeafBox {
                x_lo: x.lo,
                x_hi: x.hi,
                y_lo: y.lo,
                y_hi: y.hi,
            },
            Some(current) => LeafBox {
                x_lo: current.x_lo.min(x.lo),
                x_hi: current.x_hi.max(x.hi),
                y_lo: current.y_lo.min(y.lo),
                y_hi: current.y_hi.max(y.hi),
            },
        });
    }
    result
}

/// Boxes of every leaf, and the mask of leaves without a box (every pair with one is a
/// candidate).
fn leaf_boxes<'a>(
    leaves: impl Iterator<Item = &'a [ExactPoint]>,
) -> ([LeafBox; ABSOLUTE_MAX_LEAVES], LeafRow) {
    let mut boxes = [EMPTY_BOX; ABSOLUTE_MAX_LEAVES];
    let mut wild = EMPTY_ROW;
    for (index, points) in leaves.enumerate() {
        match leaf_box(points) {
            Some(value) => boxes[index] = value,
            None => set_bit(&mut wild, index),
        }
    }
    (boxes, wild)
}

/// The closed comparison `left <= right` of two box endpoints.
fn closed_le(left: f64, right: f64) -> bool {
    if sweep_fault(SweepFault::StrictBoxOverlap) {
        left < right
    } else {
        left <= right
    }
}

/// Section 4.3: the candidate bitset C, row i holding bit j for j > i, and the x_lo order of
/// the boxed leaves followed by the unboxed ones.
struct PairCandidates {
    rows: [LeafRow; ABSOLUTE_MAX_LEAVES],
    order: [u16; ABSOLUTE_MAX_LEAVES],
    leaf_count: usize,
}

impl PairCandidates {
    fn new(
        leaf_count: usize,
        boxes: &[LeafBox; ABSOLUTE_MAX_LEAVES],
        wild: LeafRow,
        contours: &[TopologyRange],
    ) -> Self {
        debug_assert!(leaf_count <= ABSOLUTE_MAX_LEAVES);
        let mut candidates = Self {
            rows: [EMPTY_ROW; ABSOLUTE_MAX_LEAVES],
            order: [0; ABSOLUTE_MAX_LEAVES],
            leaf_count,
        };

        // Deterministic, allocation-free insertion sort of the boxed leaves by x_lo. Ties may
        // stay in any order: the marks form a set.
        let mut boxed = 0usize;
        for index in 0..leaf_count {
            if has_bit(&wild, index) {
                continue;
            }
            let mut position = boxed;
            while position > 0
                && boxes[candidates.order[position - 1] as usize].x_lo > boxes[index].x_lo
            {
                candidates.order[position] = candidates.order[position - 1];
                position -= 1;
            }
            candidates.order[position] = index as u16;
            boxed += 1;
        }
        let mut position = boxed;
        for index in 0..leaf_count {
            if has_bit(&wild, index) {
                candidates.order[position] = index as u16;
                position += 1;
            }
        }

        let order = candidates.order;
        for first in 0..boxed {
            let left = order[first] as usize;
            for &right in &order[first + 1..boxed] {
                let right = right as usize;
                if !closed_le(boxes[right].x_lo, boxes[left].x_hi) {
                    break;
                }
                if closed_le(boxes[left].y_lo, boxes[right].y_hi)
                    && closed_le(boxes[right].y_lo, boxes[left].y_hi)
                {
                    candidates.mark(left, right);
                }
            }
        }
        for index in 0..leaf_count {
            if has_bit(&wild, index) {
                for other in 0..leaf_count {
                    if other != index {
                        candidates.mark(index, other);
                    }
                }
            }
        }
        if !sweep_fault(SweepFault::ForcedPairsNotMarked) {
            for contour in contours {
                for offset in 1..contour.count {
                    candidates.mark(contour.start + offset - 1, contour.start + offset);
                }
                if contour.count >= 2 {
                    candidates.mark(contour.start, contour.start + contour.count - 1);
                }
            }
        }
        candidates
    }

    fn mark(&mut self, left: usize, right: usize) {
        let (low, high) = if left < right {
            (left, right)
        } else {
            (right, left)
        };
        set_bit(&mut self.rows[low], high);
    }

    #[cfg(test)]
    fn contains(&self, left: usize, right: usize) -> bool {
        has_bit(&self.rows[left], right)
    }

    #[cfg(test)]
    fn len(&self) -> u64 {
        self.rows
            .iter()
            .flatten()
            .map(|word| u64::from(word.count_ones()))
            .sum()
    }

    /// Candidates in lexicographic (i, j) order, read from the bitset rows in order.
    fn pairs(&self) -> impl Iterator<Item = (usize, usize)> + '_ {
        (0..self.leaf_count).flat_map(move |position| {
            let left = if sweep_fault(SweepFault::SortedByXOrder) {
                self.order[position] as usize
            } else {
                position
            };
            RowBits(self.rows[left]).map(move |right| (left, right))
        })
    }
}

/// The set bits of one bitset row, lowest first (word 0 first, so for at most 64 leaves the
/// pre-B1 single-word order).
struct RowBits(LeafRow);

impl Iterator for RowBits {
    type Item = usize;

    fn next(&mut self) -> Option<usize> {
        let word = self.0.iter().position(|word| *word != 0)?;
        let bit = self.0[word].trailing_zeros() as usize;
        self.0[word] &= self.0[word] - 1;
        Some(word * 64 + bit)
    }
}

/// Section 4.4: the rank of (left, right), left < right, in the pre-B0R loop's order.
fn pair_rank(leaf_count: usize, left: usize, right: usize) -> usize {
    left * (2 * leaf_count - left - 1) / 2 + (right - left - 1)
}

/// Lemma B, before a candidate's body: the pre-B0R loop's counter at that pair.
fn enter_pair(
    pairs: &mut usize,
    leaf_count: usize,
    left: usize,
    right: usize,
    max_pairs: usize,
) -> Result<(), TopologyError> {
    let rank = pair_rank(leaf_count, left, right);
    if rank >= max_pairs {
        *pairs = max_pairs;
        return Err(TopologyError::WorkLimit);
    }
    *pairs = if sweep_fault(SweepFault::CounterOffByOne) {
        rank
    } else {
        rank + 1
    };
    Ok(())
}

/// Lemma B, after the last candidate: the pre-B0R loop's counter at its end.
fn finish_pairs(
    pairs: &mut usize,
    leaf_count: usize,
    max_pairs: usize,
) -> Result<(), TopologyError> {
    let total = leaf_count * leaf_count.saturating_sub(1) / 2;
    if total > max_pairs {
        *pairs = max_pairs;
        return Err(TopologyError::WorkLimit);
    }
    *pairs = total;
    Ok(())
}

/// Seeded sweep defects of oracle O8 (3)-(6). The switch is a `cfg(test)` thread-local; every
/// other build compiles `sweep_fault` to a constant `false`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SweepFault {
    /// O8 (3): box overlap tested with strict inequalities.
    StrictBoxOverlap,
    /// O8 (4): forced pairs not marked.
    ForcedPairsNotMarked,
    /// O8 (5): candidates processed in sorted-by-x order.
    SortedByXOrder,
    /// O8 (6): the Lemma B counter one too low on entering a candidate.
    CounterOffByOne,
}

#[cfg(test)]
fn sweep_fault(fault: SweepFault) -> bool {
    B0R_SWEEP_FAULT.with(|active| active.get() == Some(fault))
}

#[cfg(not(test))]
#[inline(always)]
fn sweep_fault(_fault: SweepFault) -> bool {
    false
}

/// Which pair loop the topology workspaces run in this test thread.
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum B0rPairLoopMode {
    /// The production sweep (the default).
    Sweep,
    /// The pre-B0R all-pairs reference loop only.
    Reference,
    /// O3(b) and O3(c): both loops from the same state, compared for the real budget and a set
    /// of smaller budgets; the sweep's result and state are kept.
    Shadow,
}

/// Shadow-mode observations of this test thread.
#[cfg(test)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct B0rShadowTally {
    /// Pair-loop calls compared.
    pub(crate) calls: u64,
    /// Reference/sweep runs compared, over every budget.
    pub(crate) runs: u64,
    /// Compared runs whose reference result was WorkLimit.
    pub(crate) work_limit_runs: u64,
    /// Compared runs whose reference result was another error.
    pub(crate) failure_runs: u64,
    /// Compared runs with a different result or state.
    pub(crate) mismatches: u64,
    /// Pairs whose reference body (real budget) returned an error or changed state.
    pub(crate) touched: u64,
    /// Touched pairs outside C (O3(c)); must be zero.
    pub(crate) uncovered: u64,
    /// |C| and T = n(n - 1)/2 summed over the calls.
    pub(crate) candidates: u64,
    pub(crate) total_pairs: u64,
    /// Calls with at least one leaf without a box.
    pub(crate) unboxed_calls: u64,
}

#[cfg(test)]
impl B0rShadowTally {
    pub(crate) fn merge(&mut self, other: Self) {
        self.calls += other.calls;
        self.runs += other.runs;
        self.work_limit_runs += other.work_limit_runs;
        self.failure_runs += other.failure_runs;
        self.mismatches += other.mismatches;
        self.touched += other.touched;
        self.uncovered += other.uncovered;
        self.candidates += other.candidates;
        self.total_pairs += other.total_pairs;
        self.unboxed_calls += other.unboxed_calls;
    }
}

#[cfg(test)]
thread_local! {
    static B0R_SWEEP_FAULT: core::cell::Cell<Option<SweepFault>> =
        const { core::cell::Cell::new(None) };
    static B0R_PAIR_LOOP_MODE: core::cell::Cell<B0rPairLoopMode> =
        const { core::cell::Cell::new(B0rPairLoopMode::Sweep) };
    static B0R_SHADOW_TALLY: core::cell::Cell<B0rShadowTally> =
        const { core::cell::Cell::new(B0rShadowTally {
            calls: 0,
            runs: 0,
            work_limit_runs: 0,
            failure_runs: 0,
            mismatches: 0,
            touched: 0,
            uncovered: 0,
            candidates: 0,
            total_pairs: 0,
            unboxed_calls: 0,
        }) };
}

/// Runs `action` with one sweep defect switched on in this thread, then switches it off.
#[cfg(test)]
pub(crate) fn b0r_with_sweep_fault<T>(fault: SweepFault, action: impl FnOnce() -> T) -> T {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            B0R_SWEEP_FAULT.with(|active| active.set(None));
        }
    }
    B0R_SWEEP_FAULT.with(|active| active.set(Some(fault)));
    let _reset = Reset;
    action()
}

/// Runs `action` with the pair loops in `mode` in this thread, then restores the sweep.
#[cfg(test)]
pub(crate) fn b0r_with_pair_loop_mode<T>(mode: B0rPairLoopMode, action: impl FnOnce() -> T) -> T {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            B0R_PAIR_LOOP_MODE.with(|active| active.set(B0rPairLoopMode::Sweep));
        }
    }
    B0R_PAIR_LOOP_MODE.with(|active| active.set(mode));
    let _reset = Reset;
    action()
}

/// Returns and resets this thread's shadow tally.
#[cfg(test)]
pub(crate) fn b0r_take_shadow_tally() -> B0rShadowTally {
    B0R_SHADOW_TALLY.with(|tally| tally.replace(B0rShadowTally::default()))
}

#[cfg(test)]
fn update_shadow_tally(update: impl FnOnce(&mut B0rShadowTally)) {
    B0R_SHADOW_TALLY.with(|tally| {
        let mut value = tally.get();
        update(&mut value);
        tally.set(value);
    });
}

/// One workspace's pair loops, for the reference and shadow modes.
#[cfg(test)]
trait B0rPairLoops {
    type State: Copy + PartialEq + core::fmt::Debug;
    fn leaf_count(&self) -> usize;
    fn state(&self) -> Self::State;
    fn restore(&mut self, state: Self::State);
    fn pairs(&self) -> usize;
    fn candidates(&self) -> PairCandidates;
    fn unboxed(&self) -> bool;
    fn reference(
        &mut self,
        max_pairs: usize,
        touched: &mut [LeafRow; ABSOLUTE_MAX_LEAVES],
    ) -> Result<(), TopologyError>;
    fn sweep(&mut self, max_pairs: usize) -> Result<(), TopologyError>;
}

#[cfg(test)]
struct SimplePairLoops<'a>(&'a mut SimpleCubicTopologyWorkspace);

#[cfg(test)]
impl B0rPairLoops for SimplePairLoops<'_> {
    type State = TopologyStats;

    fn leaf_count(&self) -> usize {
        self.0.exact_leaves.len()
    }

    fn state(&self) -> TopologyStats {
        self.0.stats
    }

    fn restore(&mut self, state: TopologyStats) {
        self.0.stats = state;
    }

    fn pairs(&self) -> usize {
        self.0.stats.pairs
    }

    fn candidates(&self) -> PairCandidates {
        self.0.pair_candidates()
    }

    fn unboxed(&self) -> bool {
        leaf_boxes(self.0.exact_leaves.iter().map(|leaf| &leaf.controls[..])).1 != EMPTY_ROW
    }

    fn reference(
        &mut self,
        max_pairs: usize,
        touched: &mut [LeafRow; ABSOLUTE_MAX_LEAVES],
    ) -> Result<(), TopologyError> {
        self.0.reference_pairs(max_pairs, touched)
    }

    fn sweep(&mut self, max_pairs: usize) -> Result<(), TopologyError> {
        self.0.sweep_pairs(max_pairs)
    }
}

#[cfg(test)]
struct RoundedPairLoops<'a>(&'a mut RoundedKnotCubicTopologyWorkspace);

#[cfg(test)]
impl B0rPairLoops for RoundedPairLoops<'_> {
    type State = TopologyStats;

    fn leaf_count(&self) -> usize {
        self.0.exact_leaves.len()
    }

    fn state(&self) -> TopologyStats {
        self.0.stats
    }

    fn restore(&mut self, state: TopologyStats) {
        self.0.stats = state;
    }

    fn pairs(&self) -> usize {
        self.0.stats.pairs
    }

    fn candidates(&self) -> PairCandidates {
        self.0.pair_candidates()
    }

    fn unboxed(&self) -> bool {
        self.0.b0r_unboxed()
    }

    fn reference(
        &mut self,
        max_pairs: usize,
        touched: &mut [LeafRow; ABSOLUTE_MAX_LEAVES],
    ) -> Result<(), TopologyError> {
        self.0.reference_pairs(max_pairs, touched)
    }

    fn sweep(&mut self, max_pairs: usize) -> Result<(), TopologyError> {
        self.0.sweep_pairs(max_pairs)
    }
}

#[cfg(test)]
struct TransversePairLoops<'a> {
    workspace: &'a mut TransverseArrangementWorkspace,
    marked_lines: Option<&'a [bool; ABSOLUTE_MAX_LEAVES]>,
    policy: ArrangementPolicy,
}

#[cfg(test)]
type TransverseLoopState = (
    TopologyStats,
    [usize; ABSOLUTE_MAX_LEAVES],
    [ArrangementCrossing; MAX_CROSSINGS],
    usize,
);

#[cfg(test)]
impl B0rPairLoops for TransversePairLoops<'_> {
    type State = TransverseLoopState;

    fn leaf_count(&self) -> usize {
        self.workspace.rounded.exact_leaves.len()
    }

    fn state(&self) -> TransverseLoopState {
        (
            self.workspace.rounded.stats,
            self.workspace.partners,
            self.workspace.crossings,
            self.workspace.crossing_len,
        )
    }

    fn restore(&mut self, state: TransverseLoopState) {
        (
            self.workspace.rounded.stats,
            self.workspace.partners,
            self.workspace.crossings,
            self.workspace.crossing_len,
        ) = state;
    }

    fn pairs(&self) -> usize {
        self.workspace.rounded.stats.pairs
    }

    fn candidates(&self) -> PairCandidates {
        self.workspace.rounded.pair_candidates()
    }

    fn unboxed(&self) -> bool {
        self.workspace.rounded.b0r_unboxed()
    }

    fn reference(
        &mut self,
        max_pairs: usize,
        touched: &mut [LeafRow; ABSOLUTE_MAX_LEAVES],
    ) -> Result<(), TopologyError> {
        self.workspace
            .reference_pairs(self.marked_lines, self.policy, max_pairs, touched)
    }

    fn sweep(&mut self, max_pairs: usize) -> Result<(), TopologyError> {
        self.workspace
            .sweep_pairs(self.marked_lines, self.policy, max_pairs)
    }
}

#[cfg(test)]
impl RoundedKnotCubicTopologyWorkspace {
    fn b0r_unboxed(&self) -> bool {
        leaf_boxes(self.exact_leaves.iter().map(|leaf| &leaf.points[..])).1 != EMPTY_ROW
    }
}

/// The reference or shadow pair loop, or `None` for the production sweep.
#[cfg(test)]
fn b0r_pair_loop_override<L: B0rPairLoops>(
    loops: &mut L,
    max_pairs: usize,
) -> Option<Result<(), TopologyError>> {
    match B0R_PAIR_LOOP_MODE.with(core::cell::Cell::get) {
        B0rPairLoopMode::Sweep => None,
        B0rPairLoopMode::Reference => {
            let mut touched = [EMPTY_ROW; ABSOLUTE_MAX_LEAVES];
            Some(loops.reference(max_pairs, &mut touched))
        }
        B0rPairLoopMode::Shadow => Some(b0r_shadow_pairs(loops, max_pairs)),
    }
}

/// O3(b) and O3(c) on one pair-loop call. From the same starting state, the reference loop and
/// the sweep run for the real budget and for the budgets 0, 1, the reference's final counter
/// q - 1, q, q + 1, T/2, T - 1, T and one pseudo-random budget, so WorkLimit is compared at and
/// around every reachable stopping point. Every run is compared by result and complete loop
/// state (counter, partners, crossings array and length). The touched pairs of the real-budget
/// reference run must lie in C. The sweep's real-budget result and state are kept.
#[cfg(test)]
fn b0r_shadow_pairs<L: B0rPairLoops>(loops: &mut L, max_pairs: usize) -> Result<(), TopologyError> {
    let start = loops.state();
    let leaf_count = loops.leaf_count();
    let total = leaf_count * leaf_count.saturating_sub(1) / 2;
    let candidates = loops.candidates();

    let mut touched = [EMPTY_ROW; ABSOLUTE_MAX_LEAVES];
    let reference = loops.reference(max_pairs, &mut touched);
    let reference_state = loops.state();
    let reached = loops.pairs();
    let mut uncovered = 0u64;
    let mut touched_count = 0u64;
    for (left, &row) in touched.iter().enumerate().take(leaf_count) {
        for right in RowBits(row) {
            touched_count += 1;
            if !candidates.contains(left, right) {
                uncovered += 1;
            }
        }
    }

    let mut runs = 0u64;
    let mut work_limit_runs = 0u64;
    let mut failure_runs = 0u64;
    let mut mismatches = 0u64;
    let mut compare = |budget: usize,
                       reference: Result<(), TopologyError>,
                       reference_state: L::State,
                       sweep: Result<(), TopologyError>,
                       sweep_state: L::State| {
        runs += 1;
        match reference {
            Err(TopologyError::WorkLimit) => work_limit_runs += 1,
            Err(_) => failure_runs += 1,
            Ok(()) => {}
        }
        if reference != sweep || reference_state != sweep_state {
            mismatches += 1;
            eprintln!(
                "B0R sweep mismatch: leaves {leaf_count}, budget {budget}: reference {reference:?} \
                 {reference_state:?}, sweep {sweep:?} {sweep_state:?}"
            );
        }
    };

    let pseudo = (reached * 7 + leaf_count * 13 + 5) % (total + 2);
    let mut budgets = [
        0,
        1,
        reached.saturating_sub(1),
        reached,
        reached + 1,
        total / 2,
        total.saturating_sub(1),
        total,
        pseudo,
    ];
    budgets.sort_unstable();
    for (index, &budget) in budgets.iter().enumerate() {
        if budget == max_pairs || (index > 0 && budgets[index - 1] == budget) {
            continue;
        }
        loops.restore(start);
        let mut scratch = [EMPTY_ROW; ABSOLUTE_MAX_LEAVES];
        let budget_reference = loops.reference(budget, &mut scratch);
        let budget_reference_state = loops.state();
        loops.restore(start);
        let budget_sweep = loops.sweep(budget);
        let budget_sweep_state = loops.state();
        compare(
            budget,
            budget_reference,
            budget_reference_state,
            budget_sweep,
            budget_sweep_state,
        );
    }

    loops.restore(start);
    let result = loops.sweep(max_pairs);
    compare(max_pairs, reference, reference_state, result, loops.state());

    let candidate_count = candidates.len();
    let unboxed = loops.unboxed();
    update_shadow_tally(|tally| {
        tally.calls += 1;
        tally.runs += runs;
        tally.work_limit_runs += work_limit_runs;
        tally.failure_runs += failure_runs;
        tally.mismatches += mismatches;
        tally.touched += touched_count;
        tally.uncovered += uncovered;
        tally.candidates += candidate_count;
        tally.total_pairs += total as u64;
        tally.unboxed_calls += u64::from(unboxed);
    });
    result
}

/// B0R O3(a) test access: whether the section 4.2 boxes of two point sets (4 or 6 points each)
/// overlap as closed boxes (`None` if a box cannot be formed), and `closed_hulls_intersect` on
/// their hulls.
#[cfg(test)]
pub(crate) fn b0r_test_lemma_a(
    left: &[B0rTestPoint],
    right: &[B0rTestPoint],
) -> (Option<bool>, bool) {
    fn exact(points: &[B0rTestPoint]) -> Vec<ExactPoint> {
        points
            .iter()
            .map(|point| ExactPoint {
                x: point[0],
                y: point[1],
            })
            .collect()
    }
    fn hull_of(points: &[ExactPoint]) -> ([u8; 6], usize) {
        match points.len() {
            4 => {
                let (indices, len) = convex_hull(&<[ExactPoint; 4]>::try_from(points).unwrap());
                let mut wide = [0u8; 6];
                wide[..4].copy_from_slice(&indices);
                (wide, len)
            }
            6 => convex_hull(&<[ExactPoint; 6]>::try_from(points).unwrap()),
            other => panic!("Lemma A leaves have 4 or 6 points, not {other}"),
        }
    }
    let left = exact(left);
    let right = exact(right);
    let overlap = match (leaf_box(&left), leaf_box(&right)) {
        (Some(a), Some(b)) => Some(
            closed_le(a.x_lo, b.x_hi)
                && closed_le(b.x_lo, a.x_hi)
                && closed_le(a.y_lo, b.y_hi)
                && closed_le(b.y_lo, a.y_hi),
        ),
        _ => None,
    };
    let (left_indices, left_len) = hull_of(&left);
    let (right_indices, right_len) = hull_of(&right);
    let intersect = closed_hulls_intersect(
        ExactHull {
            points: &left,
            indices: &left_indices[..left_len],
        },
        ExactHull {
            points: &right,
            indices: &right_indices[..right_len],
        },
    );
    (overlap, intersect)
}

/// B0R O3 test access: the candidate pairs in processing order for synthetic boxes
/// `[x_lo, x_hi, y_lo, y_hi]` (`None`: no box) and contour ranges over the same leaves.
#[cfg(test)]
pub(crate) fn b0r_test_candidate_pairs(
    boxes: &[Option<[f64; 4]>],
    contours: &[TopologyRange],
) -> Vec<(usize, usize)> {
    assert!(boxes.len() <= ABSOLUTE_MAX_LEAVES);
    let mut values = [EMPTY_BOX; ABSOLUTE_MAX_LEAVES];
    let mut wild = EMPTY_ROW;
    for (index, value) in boxes.iter().enumerate() {
        match value {
            Some([x_lo, x_hi, y_lo, y_hi]) => {
                values[index] = LeafBox {
                    x_lo: *x_lo,
                    x_hi: *x_hi,
                    y_lo: *y_lo,
                    y_hi: *y_hi,
                }
            }
            None => set_bit(&mut wild, index),
        }
    }
    PairCandidates::new(boxes.len(), &values, wild, contours)
        .pairs()
        .collect()
}

/// B0R Lemma B test access: the emulated counter over `candidates` (lexicographic), with a body
/// that fails with `Unresolved` exactly at `failing`, which must be a candidate.
#[cfg(test)]
pub(crate) fn b0r_test_emulated_counter(
    leaf_count: usize,
    candidates: &[(usize, usize)],
    failing: Option<(usize, usize)>,
    max_pairs: usize,
) -> (Result<(), TopologyError>, usize) {
    fn run(
        pairs: &mut usize,
        leaf_count: usize,
        candidates: &[(usize, usize)],
        failing: Option<(usize, usize)>,
        max_pairs: usize,
    ) -> Result<(), TopologyError> {
        for &(left, right) in candidates {
            enter_pair(pairs, leaf_count, left, right, max_pairs)?;
            if failing == Some((left, right)) {
                return Err(TopologyError::Unresolved);
            }
        }
        finish_pairs(pairs, leaf_count, max_pairs)
    }
    let mut pairs = 0usize;
    let result = run(&mut pairs, leaf_count, candidates, failing, max_pairs);
    (result, pairs)
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

fn validate_mixed_source_kinds(
    input: TopologyInput<'_>,
    source_kinds: &[bool],
) -> Result<(), TopologyError> {
    if source_kinds.len() != input.cubics.len() {
        return Err(TopologyError::InvalidInput);
    }
    for (cubic, &marked_line) in input.cubics.iter().zip(source_kinds) {
        if !marked_line {
            continue;
        }
        let valid_adapter = same_point(cubic.points[0], cubic.points[1])
            && same_point(cubic.points[2], cubic.points[3])
            && !same_point(cubic.points[0], cubic.points[3]);
        let valid_full_leaf = cubic.leaves.count == 1
            && input.leaves[cubic.leaves.start].provenance.depth == 0
            && input.leaves[cubic.leaves.start].provenance.end_numerator == 1;
        if !valid_adapter || !valid_full_leaf {
            return Err(TopologyError::InvalidInput);
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

// B0R filters F0.1 and F2.1-F2.4 (docs/plans/p3-b0r-kernel-performance-contract.md sections
// 3.5 and 3.7). Each filtered predicate first tries a proof from binary64 enclosures of its exact
// inputs (fill_filter, R1-R3) and otherwise runs its unchanged exact routine once on the same
// inputs, so every returned value is the exact one. A filter never returns Equal; only F0.1, an
// exact identity, does.
//
// Width bounds ("decides when" in section 3.7). They affect speed only, never soundness. Let u =
// 2^-53. An enclosure of x (section 3.3) is at most four ulps wide, at most 8u|x|. With M the
// largest input magnitude:
// - a difference d = b - a of enclosed inputs has width at most 16uM + 6u|d|: the two input
//   widths, plus for each endpoint half an ulp of rounding and one ulp of R1 widening;
// - a product p = d1 * d2 has width at most |d1| w(d2) + |d2| w(d1) + w(d1) w(d2) + 6u|p|, that
//   is at most 16uM(|d1| + |d2|) + 18u|p| + 784u^2 M^2, using |d| <= 2M;
// - F2.1 and F2.4, D = p1 - p2: with S the sum of the four difference magnitudes and P = |p1| +
//   |p2|, w(D) <= 16uM S + 18u P + 3u|D| + 2^11 u^2 M^2. An interval that contains D and is
//   narrower than |D| excludes zero, so the filter decides when |D| > 32u(M S + P) + 2^11 u^2 M^2.
//   The second-order constant is larger than the 2^9 of section 3.7's first-order table, because
//   it also counts the R1 widening of the differences; it changes only when the filter decides;
// - F2.2, a dot (b - a) . v with v enclosed directly: the same bound with v's width 8u|v| in
//   place of one difference width, and for the three-term total P summed over all six products;
// - F2.3, disjoint enclosures: decides when |a - b| > 8u(|a| + |b|), at most 16uM.
//
// Exact zeros always fall back, unless F0.1 catches them.
//
// Scratch: each filtered helper adds at most six PointEnclosures (192 bytes) and three Intervals
// on the stack, plus closure copies of its by-value ExactPoint arguments (at most three, 1,728
// bytes) for the fallback; every helper stays inside the source-level envelopes declared above,
// below 32 KiB. Nothing is allocated or retained.

fn enclose_coordinate(value: &ExactCoordinate) -> Option<Interval> {
    enclose(value, GRID_UNIT_EXPONENT)
}

#[derive(Clone, Copy)]
struct PointEnclosure {
    x: Interval,
    y: Interval,
}

const UNDECIDED_POINT: PointEnclosure = PointEnclosure {
    x: UNDECIDED,
    y: UNDECIDED,
};

/// Encloses both coordinates; an unavailable enclosure yields the undecidable interval, which
/// every later interval operation propagates.
fn enclose_point(point: &ExactPoint) -> PointEnclosure {
    match (enclose_coordinate(&point.x), enclose_coordinate(&point.y)) {
        (Some(x), Some(y)) => PointEnclosure { x, y },
        _ => UNDECIDED_POINT,
    }
}

fn enclosure_sub(left: PointEnclosure, right: PointEnclosure) -> PointEnclosure {
    PointEnclosure {
        x: left.x.sub(right.x),
        y: left.y.sub(right.y),
    }
}

/// Interval form of `cross_vectors`: left.x * right.y - left.y * right.x.
fn enclosure_cross(left: PointEnclosure, right: PointEnclosure) -> Interval {
    left.x.mul(right.y).sub(left.y.mul(right.x))
}

/// Interval form of `dot`: left.x * right.x + left.y * right.y.
fn enclosure_dot(left: PointEnclosure, right: PointEnclosure) -> Interval {
    left.x.mul(right.x).add(left.y.mul(right.y))
}

/// Value equality of trimmed coordinates: sign, used length and the used limbs. Unused limbs
/// are zero in every value `fill_exact` builds, so this agrees with the derived equality.
fn same_coordinate(left: &ExactCoordinate, right: &ExactCoordinate) -> bool {
    left.negative == right.negative
        && left.used == right.used
        && left.limbs[..left.used] == right.limbs[..right.used]
}

fn same_exact_point(left: &ExactPoint, right: &ExactPoint) -> bool {
    same_coordinate(&left.x, &right.x) && same_coordinate(&left.y, &right.y)
}

/// Returns the filter's decision, or the exact routine's value when the filter is undecided.
fn decide_or(
    id: FilterId,
    decision: Option<Ordering>,
    exact: impl FnOnce() -> Ordering,
) -> Ordering {
    match decision {
        Some(value) => {
            fill_filter::record(id, true);
            value
        }
        None => {
            fill_filter::record(id, false);
            exact()
        }
    }
}

/// Topology orientation: F0.1, then F2.1, then the unchanged exact routine.
fn orient(start: ExactPoint, end: ExactPoint, query: ExactPoint) -> Ordering {
    // F0.1: the cross product of a zero vector, or of a vector with itself, is exactly zero.
    if same_exact_point(&start, &end)
        || same_exact_point(&start, &query)
        || same_exact_point(&end, &query)
    {
        fill_filter::record(FilterId::TopologyOrientIdentity, true);
        return Ordering::Equal;
    }
    let origin = enclose_point(&start);
    let filtered = enclosure_cross(
        enclosure_sub(enclose_point(&end), origin),
        enclosure_sub(enclose_point(&query), origin),
    )
    .sign();
    decide_or(FilterId::TopologyOrient, filtered, || {
        orient_exact(start, end, query)
    })
}

/// The exact orientation routine, unchanged; the fallback of `orient` and its reference.
fn orient_exact(start: ExactPoint, end: ExactPoint, query: ExactPoint) -> Ordering {
    cross_vectors(point_sub(end, start), point_sub(query, start)).cmp_zero()
}

/// F2.1 and F2.4: the sign of `cross_vectors(left, right)` for exact vectors, enclosed directly.
fn cross_sign(left: ExactPoint, right: ExactPoint) -> Ordering {
    let filtered = enclosure_cross(enclose_point(&left), enclose_point(&right)).sign();
    decide_or(FilterId::TopologyCrossSign, filtered, || {
        cross_vectors(left, right).cmp_zero()
    })
}

/// Interval form of `dot(point_sub(end, start), direction)`.
fn projection_enclosure(
    end: &ExactPoint,
    start: &ExactPoint,
    direction: PointEnclosure,
) -> Interval {
    enclosure_dot(
        enclosure_sub(enclose_point(end), enclose_point(start)),
        direction,
    )
}

/// F2.2: the sign of `dot(point_sub(end, start), direction)`.
fn projection_sign(
    end: ExactPoint,
    start: ExactPoint,
    direction: ExactPoint,
    direction_enclosure: PointEnclosure,
) -> Ordering {
    projection_sign_from(
        projection_enclosure(&end, &start, direction_enclosure),
        end,
        start,
        direction,
    )
}

fn projection_sign_from(
    enclosure: Interval,
    end: ExactPoint,
    start: ExactPoint,
    direction: ExactPoint,
) -> Ordering {
    decide_or(FilterId::TopologyDotSign, enclosure.sign(), || {
        dot(point_sub(end, start), direction).cmp_zero()
    })
}

fn projected_monotone(controls: ExactCubic) -> bool {
    let chord = point_sub(controls[3], controls[0]);
    if chord.x.is_zero() && chord.y.is_zero() {
        return false;
    }
    let chord_enclosure = enclose_point(&chord);
    let projections = [
        projection_sign(controls[1], controls[0], chord, chord_enclosure),
        projection_sign(controls[2], controls[1], chord, chord_enclosure),
        projection_sign(controls[3], controls[2], chord, chord_enclosure),
    ];
    projections.iter().all(|value| *value != Ordering::Less)
        && projections.contains(&Ordering::Greater)
}

/// The unfiltered `projected_monotone`, kept as the O1 differential reference.
#[cfg(test)]
fn projected_monotone_exact(controls: ExactCubic) -> bool {
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
    rounded_projected_monotone_points(&leaf.points, leaf.closure, direction)
}

/// F2.2 on every dot sign of `rounded_projected_monotone`, including the three-term `total`,
/// whose interval is the sum of the three projection intervals; each undecided sign falls back
/// to its exact computation.
fn rounded_projected_monotone_points(
    points: &[ExactPoint; 6],
    closure: bool,
    direction: ExactPoint,
) -> bool {
    let direction_enclosure = enclose_point(&direction);
    let source_progresses = if closure {
        projection_sign(points[3], points[0], direction, direction_enclosure) == Ordering::Greater
    } else {
        let mut projections = [UNDECIDED; 3];
        let mut nonnegative = true;
        for index in 0..3 {
            let enclosure =
                projection_enclosure(&points[index + 1], &points[index], direction_enclosure);
            projections[index] = enclosure;
            if projection_sign_from(enclosure, points[index + 1], points[index], direction)
                == Ordering::Less
            {
                nonnegative = false;
            }
        }
        let total = projections[0].add(projections[1]).add(projections[2]);
        let total_sign = decide_or(FilterId::TopologyDotTotal, total.sign(), || {
            let mut total = ExactProduct::zero();
            for index in 0..3 {
                total = total.add(dot(point_sub(points[index + 1], points[index]), direction));
            }
            total.cmp_zero()
        });
        nonnegative && total_sign == Ordering::Greater
    };
    source_progresses
        && projection_sign(points[5], points[4], direction, direction_enclosure)
            == Ordering::Greater
}

/// The unfiltered `rounded_projected_monotone`, kept as the O1 differential reference.
#[cfg(test)]
fn rounded_projected_monotone_exact(
    points: &[ExactPoint; 6],
    closure: bool,
    direction: ExactPoint,
) -> bool {
    let source_progresses = if closure {
        dot(point_sub(points[3], points[0]), direction).cmp_zero() == Ordering::Greater
    } else {
        let mut total = ExactProduct::zero();
        let mut nonnegative = true;
        for index in 0..3 {
            let projection = dot(point_sub(points[index + 1], points[index]), direction);
            if projection.cmp_zero() == Ordering::Less {
                nonnegative = false;
            }
            total = total.add(projection);
        }
        nonnegative && total.cmp_zero() == Ordering::Greater
    };
    source_progresses
        && dot(point_sub(points[5], points[4]), direction).cmp_zero() == Ordering::Greater
}

/// F2.3: disjoint enclosures decide; otherwise the unchanged exact comparison. `compare_points`
/// and `between_closed` reach the filter through this function.
fn compare_coordinate(left: ExactCoordinate, right: ExactCoordinate) -> Ordering {
    let filtered = match (enclose_coordinate(&left), enclose_coordinate(&right)) {
        (Some(left), Some(right)) => compare_enclosures(left, right),
        _ => None,
    };
    decide_or(FilterId::TopologyCompareCoordinate, filtered, || {
        compare_coordinate_exact(left, right)
    })
}

/// The exact coordinate comparison, unchanged; the fallback of `compare_coordinate`.
fn compare_coordinate_exact(left: ExactCoordinate, right: ExactCoordinate) -> Ordering {
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

/// The unfiltered `compare_points`, kept as the O1 differential reference.
#[cfg(test)]
fn compare_points_exact(left: ExactPoint, right: ExactPoint) -> Ordering {
    match compare_coordinate_exact(left.x, right.x) {
        Ordering::Equal => compare_coordinate_exact(left.y, right.y),
        value => value,
    }
}

/// The unfiltered `between_closed`, kept as the O1 differential reference.
#[cfg(test)]
fn between_closed_exact(
    value: ExactCoordinate,
    left: ExactCoordinate,
    right: ExactCoordinate,
) -> bool {
    let (minimum, maximum) = if compare_coordinate_exact(left, right) == Ordering::Greater {
        (right, left)
    } else {
        (left, right)
    };
    compare_coordinate_exact(value, minimum) != Ordering::Less
        && compare_coordinate_exact(value, maximum) != Ordering::Greater
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
    // Genuine closure records and explicitly marked affine LINE records use their endpoint
    // direction plus the equal actual chord, retaining both generators. They must not be treated
    // as duplicated cubic controls with zero edges.
    let (left_generators, left_len) = transverse_generators(left, left_closure);
    let (right_generators, right_len) = transverse_generators(right, right_closure);
    let mut orientation = 0i8;
    for &left_generator in &left_generators[..left_len] {
        for &right_generator in &right_generators[..right_len] {
            // F2.4 encloses each exact generator cross sign and falls back to it (section 3.7).
            let sign = match cross_sign(left_generator, right_generator) {
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

/// The unfiltered `transverse_orientation`, kept as the O1 differential reference.
#[cfg(test)]
fn transverse_orientation_exact(
    left: &[ExactPoint; 6],
    left_closure: bool,
    right: &[ExactPoint; 6],
    right_closure: bool,
) -> Option<i8> {
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

/// B0R U1 test access (oracles O1, O2 and O8): one filtered topology predicate and its exact
/// reference, on exact grid points given as `[x, y]` coordinate pairs.
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum B0rTopologyPredicate {
    /// `orient(p0, p1, p2)`: -1, 0 or 1.
    Orient,
    /// `cross_sign(p0, p1)` of two exact vectors.
    CrossSign,
    /// The sign of `dot(p0 - p1, p2)`.
    DotSign,
    /// `projected_monotone([p0, p1, p2, p3])`: 0 or 1.
    ProjectedMonotone,
    /// `rounded_projected_monotone` on six points `p0..p5`, direction `p6`.
    RoundedProjectedMonotone { closure: bool },
    /// `transverse_orientation` on `p0..p5` and `p6..p11`: -1, 1, or 2 for `None`.
    TransverseOrientation {
        left_closure: bool,
        right_closure: bool,
    },
    /// `compare_coordinate(p0.x, p1.x)`.
    CompareCoordinate,
    /// `compare_points(p0, p1)`.
    ComparePoints,
    /// `between_closed(p0.x, p1.x, p2.x)`: 0 or 1.
    BetweenClosed,
}

#[cfg(test)]
pub(crate) type B0rTestPoint = [ExactCoordinate; 2];

#[cfg(test)]
pub(crate) fn b0r_test_point(point: Point) -> B0rTestPoint {
    let exact = exact_point(point);
    [exact.x, exact.y]
}

/// The exact restriction of a cubic to the dyadic cell `[end - 1, end] / 2^depth`.
#[cfg(test)]
pub(crate) fn b0r_test_restrict(
    points: [Point; 4],
    end_numerator: u32,
    depth: u32,
) -> [B0rTestPoint; 4] {
    restrict_cell(exact_cubic(points), end_numerator, depth).map(|point| [point.x, point.y])
}

/// Evaluates one predicate, filtered (`exact == false`) or by its exact reference.
#[cfg(test)]
pub(crate) fn b0r_test_evaluate(
    predicate: B0rTopologyPredicate,
    points: &[B0rTestPoint],
    exact: bool,
) -> i32 {
    let p = |index: usize| ExactPoint {
        x: points[index][0],
        y: points[index][1],
    };
    let six = |start: usize| core::array::from_fn::<ExactPoint, 6, _>(|index| p(start + index));
    let ordering = |value: Ordering| value as i32;
    let flag = |value: bool| i32::from(value);
    match predicate {
        B0rTopologyPredicate::Orient => ordering(if exact {
            orient_exact(p(0), p(1), p(2))
        } else {
            orient(p(0), p(1), p(2))
        }),
        B0rTopologyPredicate::CrossSign => ordering(if exact {
            cross_vectors(p(0), p(1)).cmp_zero()
        } else {
            cross_sign(p(0), p(1))
        }),
        B0rTopologyPredicate::DotSign => ordering(if exact {
            dot(point_sub(p(0), p(1)), p(2)).cmp_zero()
        } else {
            projection_sign(p(0), p(1), p(2), enclose_point(&p(2)))
        }),
        B0rTopologyPredicate::ProjectedMonotone => {
            let controls = [p(0), p(1), p(2), p(3)];
            flag(if exact {
                projected_monotone_exact(controls)
            } else {
                projected_monotone(controls)
            })
        }
        B0rTopologyPredicate::RoundedProjectedMonotone { closure } => flag(if exact {
            rounded_projected_monotone_exact(&six(0), closure, p(6))
        } else {
            rounded_projected_monotone_points(&six(0), closure, p(6))
        }),
        B0rTopologyPredicate::TransverseOrientation {
            left_closure,
            right_closure,
        } => {
            let result = if exact {
                transverse_orientation_exact(&six(0), left_closure, &six(6), right_closure)
            } else {
                transverse_orientation(&six(0), left_closure, &six(6), right_closure)
            };
            result.map_or(2, i32::from)
        }
        B0rTopologyPredicate::CompareCoordinate => ordering(if exact {
            compare_coordinate_exact(p(0).x, p(1).x)
        } else {
            compare_coordinate(p(0).x, p(1).x)
        }),
        B0rTopologyPredicate::ComparePoints => ordering(if exact {
            compare_points_exact(p(0), p(1))
        } else {
            compare_points(p(0), p(1))
        }),
        B0rTopologyPredicate::BetweenClosed => flag(if exact {
            between_closed_exact(p(0).x, p(1).x, p(2).x)
        } else {
            between_closed(p(0).x, p(1).x, p(2).x)
        }),
    }
}

/// The section 3.3 enclosure of one topology coordinate.
#[cfg(test)]
pub(crate) fn b0r_test_enclose_coordinate(value: &ExactCoordinate) -> Option<Interval> {
    enclose_coordinate(value)
}

fn certify_transverse_rounded_pair(
    left: &RoundedExactLeaf,
    right: &RoundedExactLeaf,
) -> Option<i8> {
    certify_transverse_rounded_pair_with_kinds(left, left.closure, right, right.closure)
}

fn certify_transverse_rounded_pair_with_kinds(
    left: &RoundedExactLeaf,
    left_affine: bool,
    right: &RoundedExactLeaf,
    right_affine: bool,
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
        transverse_orientation(&left.points, left_affine, &right.points, right_affine)?;
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
