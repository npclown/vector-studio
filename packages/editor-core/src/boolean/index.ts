// E41 contract (docs/plans/d9-e41-boolean-effects-contract.md), section 2: boolean operations.
export {
  BOOLEAN_EPSILON,
  BOOLEAN_ETA,
  BOOLEAN_MAX_INTERSECTIONS,
  BOOLEAN_MAX_SEGMENTS,
  booleanOp,
} from './engine.js';
export type { BFillRule, BShape, BooleanFailure, BooleanOp, BooleanResult } from './engine.js';
export type { BBox, BCubic, BLine, BPoint, BSegment } from './segment.js';
export { signedArea } from './segment.js';
