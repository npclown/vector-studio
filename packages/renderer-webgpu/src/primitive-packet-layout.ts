export const PRIMITIVE_PACKET_LAYOUT_VERSION = 1;
export const PRIMITIVE_TRANSFORM_STRIDE = 32;
export const PRIMITIVE_GEOMETRY_STRIDE = 48;
export const PRIMITIVE_STYLE_STRIDE = 48;
export const PRIMITIVE_ORDER_STRIDE = 4;
export const PRIMITIVE_FRAME_SIZE = 32;

export const PRIMITIVE_TRANSFORM_OFFSETS = Object.freeze({
  linear: 0,
  translation: 16,
  padding: 24,
});
export const PRIMITIVE_GEOMETRY_OFFSETS = Object.freeze({
  kind: 0,
  padding: 4,
  size: 8,
  radii: 16,
  line: 32,
});
export const PRIMITIVE_STYLE_OFFSETS = Object.freeze({
  fill: 0,
  stroke: 16,
  strokeWidth: 32,
  opacity: 36,
  flags: 40,
  padding: 44,
});
export const PRIMITIVE_FRAME_OFFSETS = Object.freeze({
  originMinusCamera: 0,
  zoom: 8,
  devicePixelRatio: 12,
  physicalSize: 16,
  padding: 24,
});

export const PRIMITIVE_PACKET_BINDINGS = Object.freeze({
  transforms: 0,
  geometry: 1,
  styles: 2,
  order: 3,
  frame: 4,
});

const VERTEX_AND_FRAGMENT_VISIBILITY = 0x3;

export function createPrimitiveBindGroupLayoutDescriptor(): GPUBindGroupLayoutDescriptor {
  return {
    label: 'vector-studio/p1-primitive-packet-layout',
    entries: [
      {
        binding: PRIMITIVE_PACKET_BINDINGS.transforms,
        visibility: VERTEX_AND_FRAGMENT_VISIBILITY,
        buffer: { type: 'read-only-storage' },
      },
      {
        binding: PRIMITIVE_PACKET_BINDINGS.geometry,
        visibility: VERTEX_AND_FRAGMENT_VISIBILITY,
        buffer: { type: 'read-only-storage' },
      },
      {
        binding: PRIMITIVE_PACKET_BINDINGS.styles,
        visibility: VERTEX_AND_FRAGMENT_VISIBILITY,
        buffer: { type: 'read-only-storage' },
      },
      {
        binding: PRIMITIVE_PACKET_BINDINGS.order,
        visibility: VERTEX_AND_FRAGMENT_VISIBILITY,
        buffer: { type: 'read-only-storage' },
      },
      {
        binding: PRIMITIVE_PACKET_BINDINGS.frame,
        visibility: VERTEX_AND_FRAGMENT_VISIBILITY,
        buffer: { type: 'uniform' },
      },
    ],
  };
}
