import { describe, expect, it } from 'vitest';
import {
  WORK_LIMIT_COARSER_STEPS,
  coarseFallbacksForTesting,
} from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import {
  ScriptedStrokeMeshPort,
  createStrokeHarness,
  strokeFailed,
  strokeOk,
  strokedNode,
} from '../support/st-u6-stroke-harness.js';
import {
  ScriptedFillMeshPort,
  createCountingPort,
  okResult,
  pathNode,
} from '../support/v3a-path-harness.js';

// V-25 (user report 2026-11-06): a pen path whose closing cubic is a tight hairpin drew nothing,
// because the geometry kernel refused its stroke (and at finer exponents its fill) with
// work-limit at the exponent the renderer asked for. The pipeline now asks again at up to
// WORK_LIMIT_COARSER_STEPS coarser exponents and publishes the first ok or empty result under
// the requested exponent. The kernel answers for that path are in
// tests/geometry/v25-hairpin-work-limit.test.ts.

/** A stroke port that answers work-limit below exponent `okFrom` and ok from it. */
function strokeOkFrom(okFrom: number): ScriptedStrokeMeshPort {
  return new ScriptedStrokeMeshPort({
    request: (request, tag) =>
      request.toleranceExponent < okFrom
        ? strokeFailed(request, 'work-limit')
        : strokeOk(request, tag),
  });
}

const exponents = (port: ScriptedStrokeMeshPort) =>
  port.calls.map((call) => call.map((request) => request.toleranceExponent));

describe('V-25 coarser retry after a work-limit', () => {
  it('draws a stroke the kernel builds only at a coarser exponent, and calls no more', () => {
    const stroke = strokeOkFrom(-1);
    const h = createStrokeHarness({
      fillPort: createCountingPort(),
      strokePort: stroke,
      nodes: [strokedNode('a', 0)],
    });
    const frame = h.prepare();
    expect(frame.draws.map((draw) => `${draw.nodeId}:${draw.paint}`)).toEqual([
      'a:fill',
      'a:stroke',
    ]);
    expect(frame.notices).toEqual([]);
    expect(exponents(stroke)).toEqual([[-3], [-2], [-1]]);
    expect(coarseFallbacksForTesting(h.pipeline)).toBe(1);
    expect(h.statistics()).toMatchObject({ memoEntries: 0 });
    for (let index = 0; index < 20; index += 1) h.prepare();
    expect(stroke.callCount).toBe(3);
  });

  it('draws a fill the kernel builds only at a coarser exponent', () => {
    const fill = new ScriptedFillMeshPort({
      request: (request) =>
        request.toleranceExponent < -2
          ? ({
              requestId: request.requestId,
              toleranceExponent: request.toleranceExponent,
              status: 'failed',
              code: 'work-limit',
            } as const)
          : okResult(request),
    });
    const h = createStrokeHarness({ fillPort: fill, nodes: [pathNode('a', 0)] });
    expect(h.drawn()).toEqual(['a:fill']);
    expect(fill.calls.map((call) => call.map((request) => request.toleranceExponent))).toEqual([
      [-3],
      [-2],
    ]);
    expect(coarseFallbacksForTesting(h.pipeline)).toBe(1);
  });

  it('memoizes the requested work-limit when every coarser step fails too', () => {
    const stroke = strokeOkFrom(Number.POSITIVE_INFINITY);
    const h = createStrokeHarness({
      fillPort: createCountingPort(),
      strokePort: stroke,
      nodes: [strokedNode('a', 0)],
    });
    const frame = h.prepare();
    expect(frame.draws).toEqual([]);
    expect(frame.notices).toEqual([
      expect.objectContaining({
        nodeId: 'a',
        failureScope: 'path',
        failureCode: 'work-limit',
        toleranceExponent: -3,
        paint: 'stroke',
      }),
    ]);
    expect(exponents(stroke)).toEqual(
      Array.from({ length: 1 + WORK_LIMIT_COARSER_STEPS }, (_, step) => [-3 + step]),
    );
    expect(coarseFallbacksForTesting(h.pipeline)).toBe(0);
    for (let index = 0; index < 20; index += 1) h.prepare();
    expect(stroke.callCount).toBe(1 + WORK_LIMIT_COARSER_STEPS);
  });

  it('retries only work-limit, and stops at a coarser answer that is not a valid result', () => {
    const other = new ScriptedStrokeMeshPort({
      request: (request) => strokeFailed(request, 'unsupported-geometry'),
    });
    const h1 = createStrokeHarness({
      fillPort: createCountingPort(),
      strokePort: other,
      nodes: [strokedNode('a', 0)],
    });
    expect(h1.drawn()).toEqual([]);
    expect(other.callCount).toBe(1);

    // A retry answered for the wrong exponent is invalid: the original work-limit is memoized.
    const wrong = new ScriptedStrokeMeshPort({
      request: (request, tag) =>
        request.toleranceExponent < -2
          ? strokeFailed(request, 'work-limit')
          : { ...strokeOk(request, tag), toleranceExponent: request.toleranceExponent + 1 },
    });
    const h2 = createStrokeHarness({
      fillPort: createCountingPort(),
      strokePort: wrong,
      nodes: [strokedNode('a', 0)],
    });
    const frame = h2.prepare();
    expect(frame.draws).toEqual([]);
    expect(frame.notices).toEqual([
      expect.objectContaining({ failureCode: 'work-limit', toleranceExponent: -3 }),
    ]);
    expect(exponents(wrong)).toEqual([[-3], [-2]]);
  });
});
