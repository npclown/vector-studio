import {
  DIAGNOSTIC_CODES,
  type FillMeshBatchResult,
  type FillMeshPort,
  type FillMeshRequest,
  type FillMeshResult,
  type RendererDiagnostic,
  type StrokeMeshBatchResult,
  type StrokeMeshPort,
  type StrokeMeshRequest,
  type StrokeMeshResult,
} from '@vector-studio/contracts';
import { createFillMeshPort, createStrokeMeshPort } from '@vector-studio/geometry-wasm';
import {
  PrimitiveRendererService,
  type PathDrawRecordForTesting,
} from '@vector-studio/renderer-core';
import { WebGpuBackend } from '@vector-studio/renderer-webgpu';

import {
  caseNode,
  fillRequestRecord,
  meshDigestBytes,
  physicalSize,
  strokeRequestRecord,
  VIZ_V4_VIEWPORT,
  type VizV4CaseInput,
  type VizV4MeshCall,
} from './viz-v4-a08-cases.js';

// V-4 unit VZ4-U1 (docs/plans/viz-v4-a08-corpus-contract.md, section 4): the A08 headed corpus
// page. A test-only measurement page listed in docs/validation.md, not a host: it may set the E10
// test hooks (docs/plans/d9-e10-renderer-test-hooks-contract.md, section 3). The query string
// selects the variant (`samples=1|4`, `fringe=on|off`) and the backend's DPR input (`dpr`). It
// draws one corpus case at a time through the product path, the release WASM fill and stroke
// ports, PrimitiveRendererService and WebGpuBackend, and returns the exact frame capture, the
// counts, the draw record, the notices and every port call with its mesh digest. Gates are
// evaluated offline (section 5); the spec checks only completeness and the capture identity.

export type VizV4RenderResult = Readonly<{
  key: string;
  width: number;
  height: number;
  sampleCount: number;
  devicePixelRatio: number;
  framesSubmittedDelta: number;
  prepareSerialDelta: number;
  meshTriangles: number;
  recordTriangles: number | null;
  record: PathDrawRecordForTesting | null;
  /** Renderer notice codes for this case's node (`fringe-work-cap`, a port failure, ...). */
  notices: readonly string[];
  meshCalls: readonly VizV4MeshCall[];
  rgbaBase64: string;
  counts: Readonly<{ samples: number; base64: string }>;
}>;

export type VizV4CorpusApi = Readonly<{
  ready: Promise<
    Readonly<{
      supported: boolean;
      reason: string | null;
      adapter: Record<string, unknown>;
      wasmSha256: string | null;
      variant: Readonly<{ samples: 1 | 4; fringe: 'on' | 'off'; dpr: number }>;
    }>
  >;
  physical: Readonly<{ width: number; height: number }>;
  render(input: VizV4CaseInput): Promise<VizV4RenderResult>;
  diagnostics(): readonly RendererDiagnostic[];
}>;

declare global {
  interface Window {
    __vectorStudioVizV4: VizV4CorpusApi;
  }
}

const WASM_URL = '/__vector-studio/geometry-kernel.wasm';
const parameters = new URLSearchParams(window.location.search);
const samples = parameters.get('samples') === '1' ? 1 : 4;
const fringe = parameters.get('fringe') === 'off' ? 'off' : 'on';
const dpr = Number(parameters.get('dpr') ?? '1');
const physical = physicalSize(dpr);

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

type PendingCall = {
  request: VizV4MeshCall['request'];
  /** The port's result, or `batch:<code>` for a failed batch. */
  result: FillMeshResult | StrokeMeshResult | string;
};

/** Records every request and result; digests are taken after the frame, off the port call. */
const pending: PendingCall[] = [];

function recordedFill(inner: FillMeshPort): FillMeshPort {
  return {
    portVersion: inner.portVersion,
    operationId: inner.operationId,
    buildFillMeshes(requests: readonly FillMeshRequest[]): FillMeshBatchResult {
      const batch = inner.buildFillMeshes(requests);
      requests.forEach((request, index) =>
        pending.push({
          request: fillRequestRecord(request),
          result: batch.status === 'ok' ? batch.results[index]! : `batch:${batch.code}`,
        }),
      );
      return batch;
    },
  };
}

function recordedStroke(inner: StrokeMeshPort): StrokeMeshPort {
  return {
    portVersion: inner.portVersion,
    operationId: inner.operationId,
    buildStrokeMeshes(requests: readonly StrokeMeshRequest[]): StrokeMeshBatchResult {
      const batch = inner.buildStrokeMeshes(requests);
      requests.forEach((request, index) =>
        pending.push({
          request: strokeRequestRecord(request),
          result: batch.status === 'ok' ? batch.results[index]! : `batch:${batch.code}`,
        }),
      );
      return batch;
    },
  };
}

async function settleCalls(): Promise<VizV4MeshCall[]> {
  const calls = pending.splice(0);
  return Promise.all(
    calls.map(async ({ request, result }) => ({
      request,
      outcome:
        typeof result === 'string'
          ? result
          : result.status === 'ok'
            ? `ok:${await sha256Hex(meshDigestBytes(result.mesh))}`
            : result.status === 'empty'
              ? 'empty'
              : `failed:${result.code}`,
    })),
  );
}

function base64(bytes: Uint8Array): string {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(text);
}

const canvas = document.createElement('canvas');
canvas.style.width = `${VIZ_V4_VIEWPORT.width}px`;
canvas.style.height = `${VIZ_V4_VIEWPORT.height}px`;
document.body.append(canvas);
const diagnostics: RendererDiagnostic[] = [];
const backend = new WebGpuBackend({
  sampleCountForTesting: samples,
  frameCaptureForTesting: true,
  countPassForTesting: true,
});
backend.subscribeDiagnostics((event) => diagnostics.push(event));
let service: PrimitiveRendererService | null = null;
let wasmSha256: string | null = null;
let revision = 0;

async function start() {
  const response = await fetch(WASM_URL, { cache: 'no-store' });
  if (!response.ok)
    throw new Error(
      `The geometry kernel WASM is not available at ${WASM_URL} (HTTP ${String(response.status)}).`,
    );
  const bytes = await response.arrayBuffer();
  wasmSha256 = await sha256Hex(new Uint8Array(bytes));
  // Two instances of the one kernel, as the V-1 host composes them.
  const fill = await createFillMeshPort(bytes);
  const stroke = await createStrokeMeshPort(bytes);
  service = new PrimitiveRendererService(backend, {
    fillMesh: recordedFill(fill),
    strokeMesh: recordedStroke(stroke),
    fringeForTesting: fringe,
  });
  backend.attachPrimitiveFrameSource(service);
  const result = await backend.initialize({
    canvas,
    cssSize: { ...VIZ_V4_VIEWPORT },
    devicePixelRatio: dpr,
  });
  return {
    supported: result.supported,
    reason: result.supported ? null : result.diagnostic.code,
    adapter: result.supported ? { ...result.capabilities.adapter } : {},
    wasmSha256,
    variant: { samples, fringe, dpr },
  } as const;
}

const ready = start();

/**
 * D8-interim notice codes since `from` for the node, or for no node (a batch or pipeline state
 * failure): the scene holds only this case's node, so both are this case's.
 */
function noticesFor(nodeId: string, from: number): string[] {
  return diagnostics
    .slice(from)
    .filter(
      (event) =>
        event.code === DIAGNOSTIC_CODES.PATH_MESH_INTERIM_FAILURE &&
        (event.context?.['nodeId'] === nodeId || event.context?.['nodeId'] === null),
    )
    .map((event) => String(event.context?.['failureCode'] ?? event.code));
}

async function render(input: VizV4CaseInput): Promise<VizV4RenderResult> {
  if (service === null) throw new Error('viz-v4: not ready');
  if (input.dpr !== dpr)
    throw new Error(`viz-v4: case DPR ${String(input.dpr)} on a DPR ${String(dpr)} page`);
  const from = diagnostics.length;
  pending.length = 0;
  revision += 1;
  const applied = service.replaceSnapshot({
    identity: { documentId: 'viz-v4', pageId: 'page' },
    revision,
    nodes: [caseNode(input)],
    rootOrder: [input.key],
  });
  if (applied.status !== 'applied') throw new Error(`viz-v4: scene ${applied.status}`);
  service.setCamera({ position: input.camera, zoom: input.zoom });
  // Let the scene's own frame settle first, so the capture's frame is the only one counted.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const frames = backend.getStatistics().framesSubmitted;
  const serial = service.getLastDrawRecordForTesting()?.prepareSerial ?? 0;
  const capture = await backend.captureFrameForTesting({ counts: true });
  const record = service.getLastDrawRecordForTesting();
  const recordTriangles =
    record === null
      ? null
      : record.draws.reduce(
          (sum, draw) =>
            draw.regionTriangles === null || draw.exteriorTriangles === null
              ? Number.NaN
              : sum + draw.regionTriangles + draw.exteriorTriangles,
          0,
        );
  return {
    key: input.key,
    width: capture.width,
    height: capture.height,
    sampleCount: capture.sampleCount,
    devicePixelRatio: capture.devicePixelRatio,
    framesSubmittedDelta: capture.framesSubmitted - frames,
    prepareSerialDelta: (record?.prepareSerial ?? 0) - serial,
    meshTriangles: capture.meshDraws.reduce((sum, draw) => sum + draw.triangleCount, 0),
    recordTriangles,
    record,
    notices: noticesFor(input.key, from),
    meshCalls: await settleCalls(),
    rgbaBase64: base64(capture.rgba),
    counts: {
      samples: capture.counts!.samples,
      base64: base64(new Uint8Array(capture.counts!.data.buffer)),
    },
  };
}

window.__vectorStudioVizV4 = Object.freeze({
  ready,
  physical,
  render,
  diagnostics: () => [...diagnostics],
});
