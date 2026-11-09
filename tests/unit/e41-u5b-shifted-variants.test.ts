import { describe, expect, it } from 'vitest';

import {
  MESH_FILL_CLIP_LAYER_SHADER,
  MESH_FILL_LAYER_SHADER,
  PRIMITIVE_ANALYTIC_CLIP_LAYER_SHADER,
  layerCompositePipelineKey,
  layerVariantKey,
} from '../../packages/renderer-webgpu/src/layer-pipeline.js';
import { meshPipelineKey } from '../../packages/renderer-webgpu/src/mesh-pipeline.js';
import { primitivePipelineKey } from '../../packages/renderer-webgpu/src/primitive-pipeline.js';
import {
  LAYER_COMPOSITE_SHIFTED_SHADER,
  MESH_FILL_CLIP_SHIFTED_SHADER,
  MESH_FILL_PAINT_CLIP_SHIFTED_SHADER,
  MESH_FILL_PAINT_SHIFTED_SHADER,
  MESH_FILL_SHIFTED_SHADER,
  PRIMITIVE_ANALYTIC_CLIP_SHIFTED_SHADER,
  PRIMITIVE_ANALYTIC_PAINT_CLIP_SHIFTED_SHADER,
  PRIMITIVE_ANALYTIC_PAINT_SHIFTED_SHADER,
  PRIMITIVE_ANALYTIC_SHIFTED_SHADER,
  TEXT_CLIP_SHIFTED_SHADER,
  TEXT_SHIFTED_SHADER,
  shiftedCompositeKey,
  shiftedLayerVariantKey,
  shiftedLayerVariantSource,
} from '../../packages/renderer-webgpu/src/shifted-layer-pipeline.js';

// E41 contract (docs/plans/d9-e41-boolean-effects-contract.md), unit U5b: the shifted layer
// variants' sources and keys. Their WGSL compiles on SwiftShader (tests/gpu/e41-effects.spec.ts).

const shifted = {
  PRIMITIVE_ANALYTIC_SHIFTED_SHADER,
  PRIMITIVE_ANALYTIC_CLIP_SHIFTED_SHADER,
  PRIMITIVE_ANALYTIC_PAINT_SHIFTED_SHADER,
  PRIMITIVE_ANALYTIC_PAINT_CLIP_SHIFTED_SHADER,
  MESH_FILL_SHIFTED_SHADER,
  MESH_FILL_CLIP_SHIFTED_SHADER,
  MESH_FILL_PAINT_SHIFTED_SHADER,
  MESH_FILL_PAINT_CLIP_SHIFTED_SHADER,
  TEXT_SHIFTED_SHADER,
  TEXT_CLIP_SHIFTED_SHADER,
  LAYER_COMPOSITE_SHIFTED_SHADER,
};

const count = (source: string, part: string) => source.split(part).length - 1;

describe('E41 U5b shifted layer variants', () => {
  it.each(Object.entries(shifted))(
    '%s maps vertices through the tile and reads target pixels',
    (_, source) => {
      expect(source).not.toContain('frame.physicalSize');
      expect(source).not.toContain('textTarget.size');
      expect(count(source, 'struct LayerPass {')).toBe(1);
      expect(count(source, '- layerPass.shift')).toBeGreaterThan(0);
      expect(count(source, '/ layerPass.size')).toBeGreaterThan(0);
      // Every fragment read of the position is shifted back to target pixels.
      expect(count(source, 'input.position.xy')).toBe(
        count(source, 'input.position.xy + layerPass.shift'),
      );
    },
  );

  it('keeps the fragment stage of E25 variants and changes only the vertex mapping', () => {
    const vertexMapping =
      /physicalPosition\.[xy] - layerPass\.shift\.[xy]\) \* 2\.0 \/ layerPass\.size\.[xy]/g;
    for (const [layer, variant] of [
      [PRIMITIVE_ANALYTIC_CLIP_LAYER_SHADER, PRIMITIVE_ANALYTIC_CLIP_SHIFTED_SHADER],
      [MESH_FILL_LAYER_SHADER, MESH_FILL_SHIFTED_SHADER],
      [MESH_FILL_CLIP_LAYER_SHADER, MESH_FILL_CLIP_SHIFTED_SHADER],
    ] as const) {
      expect(variant.match(vertexMapping)).toHaveLength(2);
      // Undo the vertex rewrite: the rest is E25's layer variant, character for character.
      const undone = variant
        .replace(
          '(physicalPosition.x - layerPass.shift.x) * 2.0 / layerPass.size.x - 1.0',
          'physicalPosition.x * 2.0 / frame.physicalSize.x - 1.0',
        )
        .replace(
          '1.0 - (physicalPosition.y - layerPass.shift.y) * 2.0 / layerPass.size.y',
          '1.0 - physicalPosition.y * 2.0 / frame.physicalSize.y',
        );
      expect(undone).toBe(layer);
    }
  });

  it('refuses a module it cannot shift', () => {
    expect(() => shiftedLayerVariantSource('@vertex fn main() {}')).toThrow(/maps no vertex/);
    const twice =
      'let ndc = pixel / textTarget.size * 2.0 - 1.0;\nlet ndc = pixel / textTarget.size * 2.0 - 1.0;';
    expect(() => shiftedLayerVariantSource(twice)).toThrow(/occurs twice/);
    expect(() =>
      shiftedLayerVariantSource(
        'let ndc = pixel / textTarget.size * 2.0 - 1.0;\nlet other = frame.physicalSize;',
      ),
    ).toThrow(/still reads frame.physicalSize/);
  });

  it('keys every variant apart from its E25 layer variant', () => {
    const analytic = primitivePipelineKey('bgra8unorm', 4, true);
    expect(shiftedLayerVariantKey(analytic)).toEqual({
      ...layerVariantKey(analytic),
      shaderKey: `${layerVariantKey(analytic).shaderKey}+shift-v0`,
    });
    const mesh = meshPipelineKey('bgra8unorm', 4, 'cover-nonzero');
    expect(shiftedLayerVariantKey(mesh).shaderKey).not.toBe(layerVariantKey(mesh).shaderKey);
    const composite = layerCompositePipelineKey('bgra8unorm', 4, true);
    expect(shiftedCompositeKey(composite).shaderKey).toBe(
      `${composite.shaderKey}+layer-v0+shift-v0`,
    );
    expect(shiftedCompositeKey(composite).layoutKey).toBe(composite.layoutKey);
  });
});
