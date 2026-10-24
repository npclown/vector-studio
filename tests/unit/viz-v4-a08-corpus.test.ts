import type {
  FillMesh,
  FillMeshPort,
  FillMeshRequest,
  StrokeMeshPort,
} from '@vector-studio/contracts';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  caseNode,
  fillRequestRecord,
  meshDigestBytes,
  physicalSize,
  type VizV4MeshCall,
} from '../../apps/playground/src/viz-v4-a08-cases.js';
import { ScriptedFillMeshPort, failedResult } from '../support/v3a-path-harness.js';
import {
  callKey,
  caseInput,
  classify,
  expectedEntry,
  headedStatus,
  recordingPorts,
  variantQuery,
  VIZ_V4_VARIANTS,
} from '../visual/viz-v4/cases.js';
import { A08_PARTS, a08CaseKey, a08Subset, summarizeA08Subset } from '../visual/viz-v4/subset.js';

// V-4 unit VZ4-U1 (docs/plans/viz-v4-a08-corpus-contract.md, sections 3, 4.3, 4.4 and 5.1): the
// A08 subset against its manifest, the page input and scene node, the mesh digest rule, and the
// status classification with scripted ports. No kernel runs on corpus cases (E3 section 5.5):
// every port here is a test double.

const root = path.resolve(import.meta.dirname, '../..');
const manifest = JSON.parse(
  readFileSync(path.join(root, 'tests/visual/viz-v4/a08-subset.manifest.json'), 'utf8'),
) as Record<string, unknown>;
const subset = a08Subset();

const MESH: FillMesh = {
  positions: Float64Array.from([0, 0, 1, 0, 0, 1]),
  indices: Uint32Array.from([0, 1, 2]),
  boundaryEdges: Uint32Array.from([0, 1, 1, 2, 2, 0]),
  bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
};

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const fillRequest: FillMeshRequest = {
  requestId: 7,
  verbs: Uint8Array.from([0, 1, 1, 3]),
  points: Float64Array.from([0, 0, 1, 0, 0, 1]),
  fillRule: 'nonzero',
  toleranceExponent: -8,
};

function portsAnswering(
  answer: 'ok' | 'empty' | 'work-limit',
): Readonly<{ fill: FillMeshPort; stroke: StrokeMeshPort }> {
  const fill = new ScriptedFillMeshPort({
    request: (request) =>
      answer === 'ok'
        ? {
            requestId: request.requestId,
            toleranceExponent: request.toleranceExponent,
            status: 'ok',
            mesh: MESH,
          }
        : answer === 'empty'
          ? {
              requestId: request.requestId,
              toleranceExponent: request.toleranceExponent,
              status: 'empty',
            }
          : failedResult(request, 'work-limit'),
  });
  const stroke: StrokeMeshPort = {
    portVersion: 0,
    operationId: 'test/viz-v4-stroke',
    buildStrokeMeshes: () => ({ status: 'batch-failed', code: 'internal-error' }),
  };
  return { fill, stroke };
}

function call(outcome: string): VizV4MeshCall {
  return { request: fillRequestRecord(fillRequest), outcome };
}

describe('A08 subset (section 3)', () => {
  it('matches its manifest', () => {
    const { contract, a04CorpusSha256, ...summary } = manifest;
    expect(contract).toBe('docs/plans/viz-v4-a08-corpus-contract.md');
    const e3 = JSON.parse(
      readFileSync(path.join(root, 'tests/geometry/e3-a04/corpus-v1.manifest.json'), 'utf8'),
    ) as { corpusSha256: string };
    expect(a04CorpusSha256).toBe(e3.corpusSha256);
    expect(summarizeA08Subset(subset)).toEqual(summary);
  });

  it('has the declared counts and roles', () => {
    expect(subset).toHaveLength(2280);
    expect(subset.filter((c) => c.gated)).toHaveLength(1032);
    const perDpr: Record<string, number> = {
      'C1-named-fill-lines': 160,
      'C3-named-fill-cubics': 120,
      'C4-near-coincidence': 48,
      'C12-t-junction-fills': 16,
      'C11-region-only-fills': 8,
      'C5-C9-named-strokes': 218,
    };
    for (const part of A08_PARTS)
      for (const dpr of [1, 1.5, 2, 3] as const) {
        const cases = subset.filter((c) => c.part === part.id && c.dpr === dpr);
        expect(cases, `${part.id} dpr ${String(dpr)}`).toHaveLength(perDpr[part.id]!);
        expect(cases.every((c) => c.gated === (part.role === 'gated' && dpr !== 3))).toBe(true);
      }
  });

  it('keys cases uniquely and re-projects DPR 1.5 by camera.dpr only', () => {
    expect(new Set(subset.map((c) => c.key)).size).toBe(subset.length);
    for (const c of subset) expect(c.key).toBe(a08CaseKey(c.a04Id, c.dpr));
    const byKey = new Map(subset.map((c) => [c.key, c]));
    for (const c of subset.filter((s) => s.dpr === 1.5)) {
      const base = byKey.get(a08CaseKey(c.a04Id, 1))!;
      const { camera, ...rest } = c.kase as unknown as Record<string, unknown>;
      const { camera: baseCamera, ...baseRest } = base.kase as unknown as Record<string, unknown>;
      expect(rest).toEqual(baseRest);
      expect({ ...(camera as object), dpr: null }).toEqual({
        ...(baseCamera as object),
        dpr: null,
      });
      expect(caseInput(c).dpr).toBe(1.5);
    }
  });
});

describe('page input (section 4.3)', () => {
  it('builds a fill-only or stroke-only white node at opacity 1', () => {
    const fill = subset.find((c) => c.part === 'C1-named-fill-lines')!;
    const stroke = subset.find((c) => c.part === 'C5-C9-named-strokes')!;
    const fillNode = caseNode(caseInput(fill));
    if (fillNode.kind !== 'path') throw new Error('a path node');
    expect(fillNode.id).toBe(fill.key);
    expect(fillNode.opacity).toBe(1);
    expect(fillNode.style).toEqual({ fill: { r: 1, g: 1, b: 1, a: 1 }, stroke: null });
    const strokeNode = caseNode(caseInput(stroke));
    if (strokeNode.kind !== 'path') throw new Error('a path node');
    expect(strokeNode.style.fill).toBeNull();
    expect(strokeNode.style.stroke?.color).toEqual({ r: 1, g: 1, b: 1, a: 1 });
  });

  it('gives integer physical sizes and refuses fractional ones', () => {
    expect(physicalSize(1)).toEqual({ width: 640, height: 360 });
    expect(physicalSize(1.5)).toEqual({ width: 960, height: 540 });
    expect(physicalSize(3)).toEqual({ width: 1920, height: 1080 });
    expect(() => physicalSize(1.1)).toThrow(/fractional/u);
  });

  it('maps the variants to the E10 hooks', () => {
    expect(VIZ_V4_VARIANTS.map(variantQuery)).toEqual([
      { samples: 1, fringe: 'on' },
      { samples: 4, fringe: 'on' },
      { samples: 4, fringe: 'off' },
    ]);
  });
});

describe('mesh digest (section 4.4, MESH-MISMATCH)', () => {
  it('serializes counts and little-endian data', () => {
    const bytes = meshDigestBytes(MESH);
    expect(bytes.byteLength).toBe(4 + 6 * 8 + 4 + 3 * 4 + 4 + 6 * 4);
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(6);
    expect(view.getFloat64(4 + 2 * 8, true)).toBe(1);
    expect(view.getUint32(4 + 48, true)).toBe(3);
  });

  it('separates meshes that differ only in boundary edges', () => {
    const other = { ...MESH, boundaryEdges: Uint32Array.from([0, 1, 1, 2, 0, 2]) };
    expect(sha(meshDigestBytes(other))).not.toBe(sha(meshDigestBytes(MESH)));
  });

  it("records Node's calls as the page does, batch failures included", () => {
    const outcome = (answer: 'ok' | 'empty' | 'work-limit') => {
      const recorder = recordingPorts(portsAnswering(answer));
      recorder.ports.fill.buildFillMeshes([fillRequest]);
      return recorder.take().map((c) => c.outcome);
    };
    expect(outcome('ok')).toEqual([`ok:${sha(meshDigestBytes(MESH))}`]);
    expect(outcome('empty')).toEqual(['empty']);
    expect(outcome('work-limit')).toEqual(['failed:work-limit']);
    const recorder = recordingPorts(portsAnswering('ok'));
    recorder.ports.stroke.buildStrokeMeshes([
      { ...fillRequest, width: 1, cap: 'butt', join: 'miter', miterLimit: 4 },
    ]);
    expect(recorder.take().map((c) => c.outcome)).toEqual(['batch:internal-error']);
  });
});

describe('headed status (section 4.4)', () => {
  const ok = `ok:${sha(meshDigestBytes(MESH))}`;
  const view = (notices: string[], meshTriangles: number, outcome = ok) => ({
    notices,
    meshTriangles,
    meshCalls: [call(outcome)],
  });

  it('is MESH-MISMATCH when a request, a digest or a call differs from Node', () => {
    const node = [callKey(call(ok))];
    expect(headedStatus(view([], 4), node)).toEqual({ status: 'RENDERED', reason: '' });
    expect(headedStatus(view([], 4, 'empty'), node).status).toBe('MESH-MISMATCH');
    const other = { ...call(ok), request: { ...call(ok).request, toleranceExponent: -7 } };
    expect(headedStatus({ notices: [], meshTriangles: 4, meshCalls: [other] }, node).status).toBe(
      'MESH-MISMATCH',
    );
    expect(headedStatus({ notices: [], meshTriangles: 4, meshCalls: [] }, node).status).toBe(
      'MESH-MISMATCH',
    );
  });

  it('classifies in the declared order', () => {
    const at = (notices: string[], drawn: boolean, outcome = ok) =>
      classify({ calls: [call(outcome)], notices, drawn });
    expect(at(['work-limit'], false, 'failed:work-limit')).toEqual({
      status: 'KERNEL-REJECTED',
      reason: 'failed:work-limit',
    });
    expect(at(['internal-error'], false, 'batch:internal-error').status).toBe('KERNEL-REJECTED');
    expect(at(['fringe-work-cap'], true)).toEqual({
      status: 'REGION-ONLY',
      reason: 'fringe-work-cap',
    });
    expect(at(['fringe-unsupported'], false).status).toBe('REGION-ONLY');
    expect(at(['packing-range'], false)).toEqual({
      status: 'RENDERER-FAILED',
      reason: 'packing-range',
    });
    expect(at([], false, 'empty')).toEqual({ status: 'EMPTY-CROP', reason: 'port-empty' });
    expect(classify({ calls: [], notices: [], drawn: false }).reason).toBe(
      'no mesh triangle drawn',
    );
    expect(at([], true)).toEqual({ status: 'RENDERED', reason: '' });
  });
});

describe('expected status (section 5.1), scripted ports only', () => {
  it('follows port failures and empty answers', () => {
    const fill = subset.find((c) => c.part === 'C1-named-fill-lines')!;
    for (const variant of VIZ_V4_VARIANTS) {
      const rejected = expectedEntry(fill, portsAnswering('work-limit'), variant);
      expect(rejected.status).toBe('KERNEL-REJECTED');
      expect(rejected.calls).toHaveLength(1);
      expect(rejected.calls[0]).toMatch(/ failed:work-limit$/u);
      expect(expectedEntry(fill, portsAnswering('empty'), variant)).toMatchObject({
        status: 'EMPTY-CROP',
        reason: 'port-empty',
      });
    }
  });

  it('is REGION-ONLY for an unsupported fringe and RENDERED for it under msaa-4x', () => {
    // Two squares meeting at one corner: the fringe builder refuses the pinch vertex.
    const c = subset.find((s) => s.a04Id.startsWith('C11/f07/') && s.dpr === 1)!;
    const pinch: FillMesh = {
      positions: Float64Array.from([0, 0, 8, 0, 8, 8, 0, 8, 8, 8, 16, 8, 16, 16, 8, 16]),
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]),
      boundaryEdges: Uint32Array.from([0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4]),
      bounds: { minX: 0, minY: 0, maxX: 16, maxY: 16 },
    };
    const ports = {
      ...portsAnswering('ok'),
      fill: new ScriptedFillMeshPort({
        request: (r) => ({
          requestId: r.requestId,
          toleranceExponent: r.toleranceExponent,
          status: 'ok',
          mesh: pinch,
        }),
      }),
    };
    for (const variant of ['fringe-1x', 'fringe-4x'] as const)
      expect(expectedEntry(c, ports, variant)).toMatchObject({
        status: 'REGION-ONLY',
        reason: 'fringe-unsupported',
      });
    expect(expectedEntry(c, ports, 'msaa-4x')).toMatchObject({ status: 'RENDERED', reason: '' });
  });
});
