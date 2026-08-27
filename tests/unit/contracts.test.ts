import {
  DIAGNOSTIC_CODES,
  INVALIDATION_REASONS,
  RENDERER_LIFECYCLE_STATES,
  RESOURCE_CATEGORIES,
  type PixelSize,
  type RendererCapabilityResult,
  type RendererInvalidation,
  type RendererLifecycle,
  type RendererStatistics,
} from '@vector-studio/contracts';
import { describe, expect, expectTypeOf, it } from 'vitest';

describe('renderer contracts', () => {
  it('exposes the accepted lifecycle state machine states', () => {
    expect(RENDERER_LIFECYCLE_STATES).toEqual([
      'idle',
      'initializing',
      'ready',
      'unsupported',
      'lost',
      'recovering',
      'failed',
      'disposed',
    ]);
  });

  it('keeps sizing, invalidation, capability, and statistics as plain contracts', () => {
    expect(INVALIDATION_REASONS).toContain('resize');
    expectTypeOf<PixelSize>().toMatchTypeOf<{ readonly width: number; readonly height: number }>();
    expectTypeOf<RendererInvalidation>().toHaveProperty('reason');
    expectTypeOf<RendererCapabilityResult>().toHaveProperty('supported');
    expectTypeOf<RendererStatistics>().toHaveProperty('resources');
    expectTypeOf<RendererLifecycle<{ readonly surfaceId: string }>['initialize']>()
      .parameter(0)
      .toEqualTypeOf<{ readonly surfaceId: string }>();
  });

  it('assigns unique stable codes to every required diagnostic category', () => {
    const codes = Object.values(DIAGNOSTIC_CODES);
    const requiredPrefixes = [
      'capability.',
      'initialization.',
      'validation.',
      'device-loss.',
      'recovery.',
      'allocation.',
      'render.',
      'disposal.',
    ];

    expect(new Set(codes).size).toBe(codes.length);
    expect(Object.isFrozen(DIAGNOSTIC_CODES)).toBe(true);
    for (const prefix of requiredPrefixes) {
      expect(
        codes.some((code) => code.startsWith(prefix)),
        prefix,
      ).toBe(true);
    }
  });

  it('defines the complete P0 resource category set', () => {
    expect(RESOURCE_CATEGORIES).toEqual([
      'buffer',
      'texture',
      'texture-view',
      'sampler',
      'bind-group',
      'bind-group-layout',
      'pipeline-layout',
      'render-pipeline',
      'shader-module',
    ]);
    expect(Object.isFrozen(RENDERER_LIFECYCLE_STATES)).toBe(true);
    expect(Object.isFrozen(INVALIDATION_REASONS)).toBe(true);
    expect(Object.isFrozen(RESOURCE_CATEGORIES)).toBe(true);
  });
});
