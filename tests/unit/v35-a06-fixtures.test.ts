import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { RenderSceneSnapshot } from '@vector-studio/contracts';
import { parseDocument, type DocumentV8, type Effect } from '@vector-studio/model';
import { afterAll, describe, expect, it } from 'vitest';
import { ExpansionCache } from '../../packages/editor-core/src/expansion.js';
import { projectPage } from '../../packages/editor-core/src/projector.js';
import { PathMeshPipeline } from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import type { PrimitiveTarget } from '../../packages/renderer-core/src/primitive-packet.js';
import { PrimitiveSceneSource } from '../../packages/renderer-core/src/primitive-scene-source.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';
import { ScriptedStrokeMeshPort } from '../support/st-u6-stroke-harness.js';
import { createCountingPort } from '../support/v3a-path-harness.js';

// V-35 contract (docs/plans/viz-v35-fills-blend-contract.md), V35-A06 across the M-series and
// E41 fixtures (U4, the U2/U3 follow-up): for every committed M-series document
// (tests/fixtures/m4-appearance/migrated, the latest migrated copies), as written and with E41
// effects added to every node, each page projects to the same scene with the projector's
// `blend` gate off and on, and that scene prepares the same primitive packet under the
// renderer's `blend: 'none'` and `'v0'` (the target asking for blend layers). The equal packets
// are what the backend submits; tests/gpu/v35-blend.spec.ts checks equal bytes on a GPU.

const root = path.resolve(import.meta.dirname, '../..');
const directory = path.join(root, 'tests/fixtures/m4-appearance/migrated');
const SHADOW: Effect = {
  kind: 'dropShadow',
  visible: true,
  color: { r: 0, g: 0, b: 0, a: 0.25 },
  offsetX: 2,
  offsetY: 4,
  radius: 8,
};
const BLUR: Effect = { kind: 'layerBlur', visible: true, radius: 3 };

const target: PrimitiveTarget = {
  generation: 1,
  surfaceRevision: 1,
  width: 640,
  height: 360,
  devicePixelRatio: 1,
  sampleCount: 4,
  targetFormat: 'bgra8unorm',
};

function documents(): [string, DocumentV8][] {
  const out: [string, DocumentV8][] = [];
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith('.json') || name.includes('envelope')) continue;
    const result = parseDocument(readFileSync(path.join(directory, name), 'utf8'));
    if (!result.ok) continue;
    out.push([name, result.document]);
    // E41: the same document with a shadow on every container and a blur on every leaf.
    const nodes = Object.fromEntries(
      Object.entries(result.document.nodes).map(([id, node]) => [
        id,
        { ...node, effects: 'children' in node ? [SHADOW] : [BLUR] },
      ]),
    ) as DocumentV8['nodes'];
    out.push([`${name} + effects`, { ...result.document, nodes }]);
  }
  return out;
}

function scene(document: DocumentV8, pageId: string, blend: boolean): RenderSceneSnapshot {
  const projection = projectPage(
    document,
    pageId,
    () => null,
    new Set(),
    undefined,
    new ExpansionCache(),
    undefined,
    undefined,
    true,
    blend,
  );
  return {
    identity: { documentId: 'v35-a06', pageId },
    revision: 1,
    nodes: [...projection.nodes.values()],
    rootOrder: projection.rootOrder,
  };
}

function packet(snapshot: RenderSceneSnapshot, blend: 'none' | 'v0') {
  const mirror = new RetainedSceneMirror(undefined, {
    pathNodes: 'supported',
    pathFills: 'supported',
    pathStrokes: 'supported',
    dashes: 'supported',
    clips: 'supported',
    paints: 'gradient',
    groupOpacity: 'supported',
    effects: 'v0',
    blend,
  });
  mirror.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
  const result = mirror.replaceSnapshot(snapshot);
  const source = new PrimitiveSceneSource(
    mirror,
    new PathMeshPipeline({ port: createCountingPort(), strokePort: new ScriptedStrokeMeshPort() }),
  );
  return {
    status: result.status,
    packet:
      result.status === 'applied'
        ? source.prepare(blend === 'v0' ? { ...target, blendLayers: true } : target)
        : null,
  };
}

/** A packet with its per-source identity symbols (scene epoch, origin revision) made equal. */
function normalized(value: unknown): unknown {
  if (typeof value === 'symbol') return 'symbol';
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
  if (Array.isArray(value)) return value.map(normalized);
  if (value instanceof Map) {
    return new Map([...value].map(([key, entry]) => [normalized(key), normalized(entry)]));
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalized(entry)]));
}

/** The packet's frame echoes the target, which asks for blend layers under 'v0'. */
function expectSamePacket(v0: unknown, none: unknown) {
  if (v0 === null || none === null) {
    expect(v0).toBe(none);
    return;
  }
  const { frame, ...rest } = normalized(v0) as Record<string, unknown>;
  const { blendLayers, ...sameFrame } = frame as Record<string, unknown>;
  expect(blendLayers).toBe(true);
  expect({ ...rest, frame: sameFrame }).toEqual(normalized(none));
}

const statuses: string[] = [];

describe('V35-A06 across the M-series and E41 fixtures', () => {
  const cases = documents();

  afterAll(() => {
    // Most pages are drawn; a page past a limit (clip-33, depth) is refused under both.
    expect(statuses.filter((status) => status === 'applied').length).toBeGreaterThan(
      statuses.length / 2,
    );
  });

  it('reads the committed fixtures', () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });

  it.each(cases)('%s: the same scene with the gate off and on, the same packet', (_, document) => {
    for (const page of document.pages) {
      const off = scene(document, page.id, false);
      const on = scene(document, page.id, true);
      expect(on).toEqual(off);
      const none = packet(off, 'none');
      const v0 = packet(on, 'v0');
      expect(v0.status).toBe(none.status);
      statuses.push(none.status);
      // The packet's frame echoes the target, which asks for blend layers under 'v0'.
      expectSamePacket(v0.packet, none.packet);
    }
  });
});
