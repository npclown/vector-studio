import type {
  FillMeshRequest,
  RenderNodeSnapshot,
  SceneAffine,
  ScenePathVerb,
  StrokeMeshRequest,
} from '@vector-studio/contracts';

// V-4 unit VZ4-U1 (docs/plans/viz-v4-a08-corpus-contract.md, sections 4.3 and 5.1): the plain
// case input the spec hands the A08 corpus page, the scene node built from it, and the mesh digest
// rule that the page and Node share for the MESH-MISMATCH check. No DOM and no GPU here, so Node
// imports it too.

export type VizV4Paint =
  | Readonly<{ kind: 'fill'; rule: 'nonzero' | 'evenodd' }>
  | Readonly<{
      kind: 'stroke';
      width: number;
      cap: 'butt' | 'round' | 'square';
      join: 'miter' | 'round' | 'bevel';
      miterLimit: number;
    }>;

export type VizV4CaseInput = Readonly<{
  /** The A08 case key, also the scene node id, so no mesh is served from another case. */
  key: string;
  verbs: readonly ScenePathVerb[];
  points: readonly number[];
  transform: SceneAffine;
  camera: Readonly<{ x: number; y: number }>;
  zoom: number;
  dpr: number;
  paint: VizV4Paint;
}>;

/** E3's viewport in CSS pixels (E3 section 13.7); the physical size is this times the DPR. */
export const VIZ_V4_VIEWPORT = Object.freeze({ width: 640, height: 360 });

export function physicalSize(dpr: number): Readonly<{ width: number; height: number }> {
  const width = VIZ_V4_VIEWPORT.width * dpr;
  const height = VIZ_V4_VIEWPORT.height * dpr;
  if (!Number.isInteger(width) || !Number.isInteger(height))
    throw new Error(`DPR ${String(dpr)} gives a fractional physical size`);
  return { width, height };
}

const WHITE = Object.freeze({ r: 1, g: 1, b: 1, a: 1 });

/**
 * One path node, painted opaque white at opacity 1 on the backend's opaque black clear, so the
 * captured red channel is the coverage `obs` (section 4.3). A stroke case strokes only; a fill
 * case fills only. The case's own opacity is not used: coverage is measured at opacity 1.
 */
export function caseNode(input: VizV4CaseInput): RenderNodeSnapshot {
  return {
    id: input.key,
    parentId: null,
    transform: input.transform,
    visible: true,
    opacity: 1,
    kind: 'path',
    geometry: {
      kind: 'path',
      verbs: input.verbs,
      points: input.points,
      fillRule: input.paint.kind === 'fill' ? input.paint.rule : 'nonzero',
    },
    style:
      input.paint.kind === 'fill'
        ? { fill: WHITE, stroke: null }
        : {
            fill: null,
            stroke: {
              color: WHITE,
              width: input.paint.width,
              cap: input.paint.cap,
              join: input.paint.join,
              miterLimit: input.paint.miterLimit,
            },
          },
  };
}

/** A port request the page saw, in plain data, so Node can re-issue it to its own WASM port. */
export type VizV4MeshRequest =
  | Readonly<{
      paint: 'fill';
      verbs: readonly number[];
      points: readonly number[];
      fillRule: 'nonzero' | 'evenodd';
      toleranceExponent: number;
    }>
  | Readonly<{
      paint: 'stroke';
      verbs: readonly number[];
      points: readonly number[];
      width: number;
      cap: string;
      join: string;
      miterLimit: number;
      toleranceExponent: number;
    }>;

export type VizV4MeshCall = Readonly<{
  request: VizV4MeshRequest;
  /** `ok:<sha256>`, `empty` or `failed:<code>`. */
  outcome: string;
}>;

export function fillRequestRecord(request: FillMeshRequest): VizV4MeshRequest {
  return {
    paint: 'fill',
    verbs: Array.from(request.verbs),
    points: Array.from(request.points),
    fillRule: request.fillRule,
    toleranceExponent: request.toleranceExponent,
  };
}

export function strokeRequestRecord(request: StrokeMeshRequest): VizV4MeshRequest {
  return {
    paint: 'stroke',
    verbs: Array.from(request.verbs),
    points: Array.from(request.points),
    width: request.width,
    cap: request.cap,
    join: request.join,
    miterLimit: request.miterLimit,
    toleranceExponent: request.toleranceExponent,
  };
}

/**
 * The digested bytes of a mesh: positions as little-endian binary64, then indices and boundary
 * edges as little-endian u32, each preceded by its element count as a u32.
 */
export function meshDigestBytes(
  mesh: Readonly<{ positions: Float64Array; indices: Uint32Array; boundaryEdges: Uint32Array }>,
): Uint8Array<ArrayBuffer> {
  const parts = [mesh.positions, mesh.indices, mesh.boundaryEdges] as const;
  const size = parts.reduce((sum, part) => sum + 4 + part.byteLength, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setUint32(offset, part.length, true);
    offset += 4;
    for (let index = 0; index < part.length; index += 1) {
      if (part instanceof Float64Array) {
        view.setFloat64(offset, part[index]!, true);
        offset += 8;
      } else {
        view.setUint32(offset, part[index]!, true);
        offset += 4;
      }
    }
  }
  return out;
}
