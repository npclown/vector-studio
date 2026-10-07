import type { ProjectionInput } from '../mesh-projection/model.js';
import { certifyC2 } from '../position-certificate/wedge.js';
import { cropFor, type Crop } from './crop.js';
import { exteriorMesh, type ExteriorMesh } from './exterior.js';
import {
  coverageCorpus,
  coverageRowGeometry,
  type CoverageRow,
  type CoverageRowGeometry,
} from './positions.js';

/**
 * P3.1o O02 DPR variants (docs/plans/p3-o02-a5-coverage-contract.md, "Inputs and variants"). Each
 * O01 corpus row is re-projected at d in O02_DPRS. Only `dpr`, `width` and `height` change: the CSS
 * size is the recorded physical size divided by the recorded DPR, and the new physical size is the
 * CSS size times d. The world geometry, affine, camera, zoom and origin are unchanged.
 */

export const O02_DPRS = [1, 1.5, 2, 3] as const;
export const ACCEPTANCE_DPRS = [1, 1.5, 2] as const;
export type O02Dpr = (typeof O02_DPRS)[number];

export type O02Variant = Readonly<{
  rowIndex: number;
  id: string;
  kind: CoverageRow['kind'];
  dpr: O02Dpr;
  /** True when dpr equals the row's recorded input.dpr (the O01 projection itself). */
  identity: boolean;
  input: ProjectionInput;
}>;

function physical(size: number, recorded: number, dpr: number, label: string): number {
  const value = (size / recorded) * dpr;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`variant:${label}:${value}`);
  return value;
}

/** The row's input re-projected at `dpr`; throws unless the physical size is a positive integer. */
export function variantInput(input: ProjectionInput, dpr: number): ProjectionInput {
  return {
    ...input,
    dpr,
    width: physical(input.width, input.dpr, dpr, 'width'),
    height: physical(input.height, input.dpr, dpr, 'height'),
  };
}

/** All variants: coverageCorpus() row order, then dpr in O02_DPRS order. */
export function o02Variants(corpus: readonly CoverageRow[] = coverageCorpus()): O02Variant[] {
  return corpus.flatMap((row) =>
    O02_DPRS.map((dpr) => ({
      rowIndex: row.rowIndex,
      id: row.id,
      kind: row.kind,
      dpr,
      identity: dpr === row.input.dpr,
      input: variantInput(row.input, dpr),
    })),
  );
}

// ---------------------------------------------------------------------------------------------
// Variant status.

export const O02_STATUSES = [
  'RENDERED',
  'INPUT_UNSUPPORTED',
  'NOT_ADMITTED',
  'EMPTY_CROP',
  'FRAME_DEFERRED',
  'VERTEX_UNSUPPORTED',
  'EXTERIOR_NONCONFORMING',
] as const;
export type O02Status = (typeof O02_STATUSES)[number];

export type VariantStatus =
  | Readonly<{
      status: 'RENDERED';
      reason: null;
      geometry: CoverageRowGeometry;
      crop: Crop;
      exterior: ExteriorMesh;
    }>
  | Readonly<{
      status: Exclude<O02Status, 'RENDERED'>;
      reason: string | null;
      geometry: CoverageRowGeometry | null;
      crop: Crop | null;
    }>;

/**
 * The status of a variant in the contract's table order: INPUT_UNSUPPORTED (O01 geometry),
 * NOT_ADMITTED (certifyC2 with the row's own input.origin; reason `NOT_ADMITTED:<reason>`; the crop
 * field is still cropFor(geometry)),
 * EMPTY_CROP (O01 cropFor), then the exteriorMesh statuses (FRAME_DEFERRED, VERTEX_UNSUPPORTED,
 * EXTERIOR_NONCONFORMING), else RENDERED.
 */
export function variantStatus(input: ProjectionInput): VariantStatus {
  const geometry = coverageRowGeometry(input);
  if ('unsupported' in geometry)
    return {
      status: 'INPUT_UNSUPPORTED',
      reason: geometry.unsupported,
      geometry: null,
      crop: null,
    };
  const crop = cropFor(geometry);
  const certificate = certifyC2(input, input.origin);
  if (certificate.status !== 'ADMITTED')
    return { status: 'NOT_ADMITTED', reason: `NOT_ADMITTED:${certificate.reason}`, geometry, crop };
  if (crop === null) return { status: 'EMPTY_CROP', reason: null, geometry, crop: null };
  const exterior = exteriorMesh(input, geometry);
  if (exterior.status !== 'OK')
    return { status: exterior.status, reason: exterior.reason, geometry, crop };
  return { status: 'RENDERED', reason: null, geometry, crop, exterior };
}
