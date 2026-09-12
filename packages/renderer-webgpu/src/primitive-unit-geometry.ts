export const PRIMITIVE_UNIT_QUAD_VERTEX_STRIDE = 8;

export const PRIMITIVE_UNIT_QUAD_VERTICES: readonly number[] = Object.freeze([
  0, 0, 1, 0, 0, 1, 1, 1,
]);

export const PRIMITIVE_UNIT_QUAD_INDICES: readonly number[] = Object.freeze([0, 1, 2, 2, 1, 3]);

export function createPrimitiveUnitQuadVertexLayout(): GPUVertexBufferLayout {
  return {
    arrayStride: PRIMITIVE_UNIT_QUAD_VERTEX_STRIDE,
    stepMode: 'vertex',
    attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
  };
}

export function createPrimitiveUnitQuadData(): Readonly<{
  vertices: Float32Array;
  indices: Uint16Array;
}> {
  return Object.freeze({
    vertices: new Float32Array(PRIMITIVE_UNIT_QUAD_VERTICES),
    indices: new Uint16Array(PRIMITIVE_UNIT_QUAD_INDICES),
  });
}
