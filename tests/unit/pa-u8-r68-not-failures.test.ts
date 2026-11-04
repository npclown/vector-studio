import type {
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  RendererInvalidationTarget,
} from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import { buildPathFringe } from '../../packages/renderer-core/src/path-fringe.js';
import { PrimitiveRendererService } from '../../packages/renderer-core/src/primitive-renderer-service.js';
import {
  createCountingPort,
  createPathHarness,
  identity,
  pathNode,
  target,
} from '../support/v3a-path-harness.js';
import { pathStroke, strokedNode } from '../support/st-u6-stroke-harness.js';

// Pre-alpha gate, unit PA-U8, criterion PA-A09 (R68 half): one check per "not failures" case of
// requirements.md (section "Path rendering failures") and its stroke-port case. Each case
// states what is drawn and that nothing is reported. The first case, a renderer without a stroke port, first said "draws
// fills only"; the B2 stroke contract's section 9.1 amendment S4 (ST-A10) made it a rejection,
// and on 2026-11-04 the user had the requirement reworded to match ("Rejected, not drawn
// less"), so the check asserts the rejection. Functional evidence only; no precision or
// performance claim.

const invalidation: RendererInvalidationTarget = {
  invalidate: () => undefined,
  setMode: () => undefined,
};

function snapshot(nodes: readonly RenderNodeSnapshot[]): RenderSceneSnapshot {
  return {
    identity,
    revision: 1,
    nodes,
    rootOrder: nodes.filter((node) => node.parentId === null).map((node) => node.id),
  };
}

describe('PA-U8 R68: the path-rendering "not failures" cases', () => {
  it('case 1, no stroke port: a fill-only scene applies, but a stroke of width > 0 rejects the whole scene as unsupported-feature (R68 as reworded 2026-11-04)', () => {
    const fillOnly = () =>
      new PrimitiveRendererService(invalidation, { fillMesh: createCountingPort() });
    // A fill without a stroke applies and is not reported: the "draws fills only" half holds.
    expect(fillOnly().replaceSnapshot(snapshot([pathNode('fill', 0)])).status).toBe('applied');
    // A width-0 stroke draws nothing and is accepted without a stroke port.
    const zero = strokedNode('zero', 0, { stroke: pathStroke({ width: 0 }) });
    expect(fillOnly().replaceSnapshot(snapshot([zero])).status).toBe('applied');
    // R68 first said the fill draws and nothing is reported; reworded 2026-11-04 to what ships:
    // the scene is rejected with a reason, which the editor projector reports as the diagnostic
    // editor.renderer-unsupported.
    const stroked = strokedNode('stroked', 0);
    const result = fillOnly().replaceSnapshot(snapshot([pathNode('other', 40), stroked]));
    expect(result).toMatchObject({ status: 'invalid-scene', reason: 'unsupported-feature' });
  });

  it('case 2, no fringe builder: the mesh draws without a fringe and nothing is reported', () => {
    const without = createPathHarness({ port: createCountingPort(), nodes: [pathNode('a', 0)] });
    const frame = without.prepare();
    expect(frame.notices).toEqual([]);
    expect(frame.draws.map((draw) => [draw.nodeId, draw.fringe, draw.fringeBucket])).toEqual([
      ['a', null, null],
    ]);
    // Control: the same path with the builder installed draws with a fringe.
    const withBuilder = createPathHarness({
      port: createCountingPort(),
      nodes: [pathNode('a', 0)],
      fringeBuilder: buildPathFringe,
    });
    const served = withBuilder.prepare();
    expect(served.notices).toEqual([]);
    expect(served.draws).toHaveLength(1);
    expect(served.draws[0]!.fringe).not.toBeNull();
    // The renderer service with its builder turned off (`fringeForTesting: 'off'`, a test-only
    // option; the default is 'on') builds the same pipeline without a builder: the path is
    // meshed and sent, with no fringe variant and no notice.
    const service = new PrimitiveRendererService(invalidation, {
      fillMesh: createCountingPort(),
      fringeForTesting: 'off',
    });
    expect(service.replaceSnapshot(snapshot([pathNode('a', 0)])).status).toBe('applied');
    const packet = service.prepare(target);
    expect(packet).not.toBeNull();
    expect(packet!.mesh).toBeDefined();
    expect(packet!.mesh!.notices).toEqual([]);
    expect(
      service.getLastDrawRecordForTesting()?.draws.map((draw) => [draw.nodeId, draw.fringe]),
    ).toEqual([['a', 'region-only-off']]);
  });

  it('case 3, singular transform: the path is not drawn, nothing is reported, and its neighbour draws', () => {
    const port = createCountingPort();
    const h = createPathHarness({
      port,
      fringeBuilder: buildPathFringe,
      nodes: [
        pathNode('singular', 0, { transform: [1, 2, 2, 4, 0, 0] }),
        pathNode('zero', 20, { transform: [0, 0, 0, 0, 0, 0] }),
        pathNode('drawn', 40),
      ],
    });
    const frame = h.prepare();
    expect(frame.notices).toEqual([]);
    expect(frame.draws.map((draw) => draw.nodeId)).toEqual(['drawn']);
    expect(port.callCount).toBe(1);
    // A second prepare reports nothing either (no deferred notice).
    expect(h.prepare().notices).toEqual([]);
  });
});
