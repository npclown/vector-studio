import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { RendererInvalidationTarget } from '@vector-studio/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  VIZ_V3_CAMERA,
  VIZ_V3_CHURN,
  VIZ_V3_SURFACE,
  buildVizV3Script,
  type VizV3Step,
} from '../../apps/playground/src/viz-v3-integration-scene.js';
import {
  createFillMeshPort,
  createStrokeMeshPort,
} from '../../packages/geometry-wasm/src/index.js';
import { MESH_STRIDES, PathMeshPacker } from '../../packages/renderer-core/src/path-mesh-packet.js';
import type {
  PrimitivePacket,
  PrimitiveTarget,
} from '../../packages/renderer-core/src/primitive-packet.js';
import { PrimitiveRendererService } from '../../packages/renderer-core/src/primitive-renderer-service.js';
import { receiptOf } from '../support/v3b-mesh-harness.js';

// Visualization track V-3 (docs/plans/viz-v3-a07-integration-contract.md), criterion VZ3-A19:
// INFORMATIONAL, not a leak gate. It drives the whole CPU pipeline headless, so the arena demand
// is the real one: PrimitiveRendererService with the real geometry-wasm fill and stroke ports, a
// fake invalidation target, the camera at zoom 1, and `prepare` with a synthetic PrimitiveTarget
// per generation at DPR 1 and at DPR 2, then `acknowledge` with a receipt for every write. It
// runs S0, the order states and the churn script over the whole scene (the order-zone paths,
// p-joint's overlay variant and the fringe variants built through buildPathFringe included).
//
// From each packet's mesh-part resource descriptors it records each region's capacity and
// incarnation: a capacity change is a growth, a new incarnation at equal capacities a repack.
// The demand per region is read from the service's PathMeshPacker statistics (capacity minus free
// elements, after a second prepare has released the previous packet's ranges); the packer
// instance is observed through its source module's prototype, which tests may import, as
// tests/unit/v3b-mesh-packet.test.ts does. It gates only that it runs and writes its report. If a
// field it reads is missing (the packet or packer changed shape), it skips with a report naming
// the missing field. Under D9-Q8 (a), a rendering-track PR that changes the packet or the packer
// updates or adapts this test in the same PR. Functional evidence only: precision is UNVERIFIED
// against the 0.25 physical-pixel target.

let module: WebAssembly.Module;
beforeAll(async () => {
  if (!process.env.P2_WASM_PATH) throw new Error('Run through pnpm test:geometry');
  module = await WebAssembly.compile(new Uint8Array(await readFile(process.env.P2_WASM_PATH)));
});

const GEOMETRY_REGIONS = [
  'meshPositions',
  'meshTriangles',
  'meshFeatureLists',
  'meshFeatures',
] as const;
const MESH_REGIONS = [...GEOMETRY_REGIONS, 'meshInstances'] as const;

const noInvalidation: RendererInvalidationTarget = {
  invalidate: () => undefined,
  setMode: () => undefined,
};

type StepRecord = {
  id: string;
  cycle: number | null;
  churnStep: string | null;
  /** Elements in use per geometry region; meshInstances: path slot demand from the draws. */
  demand: Record<string, number>;
  capacity: Record<string, number>;
  pendingReleases: number;
  repacks: number;
  arenaReplacements: number;
};

type RunReport = {
  devicePixelRatio: number;
  steps: StepRecord[];
  growths: Array<{ step: string; cycle: number | null; regions: string[] }>;
  repacks: Array<{ step: string; cycle: number | null }>;
  portCalls: { fill: number; stroke: number };
};

function missingFields(packet: PrimitivePacket, packer: PathMeshPacker | null): string[] {
  const missing: string[] = [];
  const part = packet.mesh as unknown as Record<string, unknown> | undefined;
  if (part === undefined) return missing;
  if (!Array.isArray(part.resources)) missing.push('packet.mesh.resources');
  else {
    for (const resource of part.resources as Array<Record<string, unknown>>) {
      if (typeof resource.id !== 'string') missing.push('packet.mesh.resources[].id');
      if (typeof resource.capacityBytes !== 'number')
        missing.push('packet.mesh.resources[].capacityBytes');
      if (typeof resource.incarnation !== 'symbol')
        missing.push('packet.mesh.resources[].incarnation');
    }
  }
  if (!Array.isArray(part.draws)) missing.push('packet.mesh.draws');
  if (packer === null) missing.push('PathMeshPacker instance (prototype.prepare)');
  else {
    const statistics = packer.getStatistics() as unknown as Record<string, unknown>;
    for (const key of [
      'capacities',
      'freeElements',
      'repacks',
      'arenaReplacements',
      'pendingReleases',
    ])
      if (!(key in statistics)) missing.push(`PathMeshPacker.getStatistics().${key}`);
    // The per-region sub-keys: a rename skips with a report instead of producing NaN.
    const capacities = statistics.capacities as Record<string, unknown> | undefined;
    const free = statistics.freeElements as Record<string, unknown> | undefined;
    for (const region of [...GEOMETRY_REGIONS, 'meshInstances']) {
      if (typeof capacities?.[region] !== 'number')
        missing.push(`PathMeshPacker.getStatistics().capacities.${region}`);
    }
    for (const region of GEOMETRY_REGIONS) {
      if (typeof free?.[region] !== 'number')
        missing.push(`PathMeshPacker.getStatistics().freeElements.${region}`);
    }
  }
  return [...new Set(missing)];
}

function run(
  dpr: number,
  steps: readonly VizV3Step[],
  initial: ReturnType<typeof buildVizV3Script>['initial'],
  ports: Awaited<ReturnType<typeof makePorts>>,
): RunReport | { missing: string[] } {
  const packers: PathMeshPacker[] = [];
  // eslint-disable-next-line @typescript-eslint/unbound-method -- restored in finally; called with its own this
  const original = PathMeshPacker.prototype.prepare;
  if (typeof original !== 'function') return { missing: ['PathMeshPacker.prototype.prepare'] };
  PathMeshPacker.prototype.prepare = function (this: PathMeshPacker, input) {
    if (!packers.includes(this)) packers.push(this);
    return original.call(this, input);
  };
  try {
    const service = new PrimitiveRendererService(noInvalidation, {
      fillMesh: ports.fill,
      fillMeshMemoryBytes: () => ports.fill.linearMemoryBytes(),
      strokeMesh: ports.stroke,
      strokeMeshMemoryBytes: () => ports.stroke.linearMemoryBytes(),
    });
    const target: PrimitiveTarget = {
      generation: 1,
      surfaceRevision: 1,
      width: VIZ_V3_SURFACE.width * dpr,
      height: VIZ_V3_SURFACE.height * dpr,
      devicePixelRatio: dpr,
      sampleCount: 4,
      targetFormat: 'bgra8unorm',
    };
    expect(service.setCamera(VIZ_V3_CAMERA).status).toMatch(/applied|unchanged/);
    expect(service.replaceSnapshot(initial).status).toBe('applied');
    const report: RunReport = {
      devicePixelRatio: dpr,
      steps: [],
      growths: [],
      repacks: [],
      portCalls: { fill: 0, stroke: 0 },
    };
    let previous: Map<string, { capacity: number; incarnation: symbol }> | null = null;
    let missing: string[] = [];
    const frame = (label: VizV3Step | null): void => {
      // Two prepares per step: the first does the work, the second releases the first packet's
      // ranges (they become reusable one packet later), so the free totals are the demand's.
      let slotDemand = 0;
      for (let pass = 0; pass < 2; pass += 1) {
        const packet = service.prepare(target);
        if (packet === null) throw new Error('prepare returned null');
        missing = missingFields(packet, packers[0] ?? null);
        if (missing.length > 0) return;
        const part = packet.mesh;
        if (part !== undefined && part.resources.length > 0) {
          const current = new Map(
            part.resources.map((resource) => [
              resource.id,
              {
                capacity: resource.capacityBytes / MESH_STRIDES[resource.id],
                incarnation: resource.incarnation,
              },
            ]),
          );
          if (previous !== null) {
            const grown = [...current].filter(
              ([id, value]) => previous!.get(id)?.capacity !== value.capacity,
            );
            const replaced = [...current].some(
              ([id, value]) => previous!.get(id)?.incarnation !== value.incarnation,
            );
            const where = { step: label?.id ?? 's0', cycle: label?.cycle ?? null };
            if (grown.length > 0)
              report.growths.push({ ...where, regions: grown.map(([id]) => id) });
            else if (replaced) report.repacks.push(where);
          }
          previous = current;
          for (const draw of part.draws) slotDemand = Math.max(slotDemand, draw.instance + 1);
        }
        service.acknowledge(receiptOf(packet));
      }
      const statistics = packers[0]!.getStatistics();
      const demand: Record<string, number> = {};
      const capacity: Record<string, number> = {};
      for (const region of GEOMETRY_REGIONS) {
        capacity[region] = statistics.capacities[region] / MESH_STRIDES[region];
        demand[region] = capacity[region] - statistics.freeElements[region];
      }
      capacity.meshInstances = statistics.capacities.meshInstances / MESH_STRIDES.meshInstances;
      demand.meshInstances = slotDemand;
      report.steps.push({
        id: label?.id ?? 's0',
        cycle: label?.cycle ?? null,
        churnStep: label?.churnStep ?? null,
        demand,
        capacity,
        pendingReleases: statistics.pendingReleases,
        repacks: statistics.repacks,
        arenaReplacements: statistics.arenaReplacements,
      });
    };
    frame(null);
    if (missing.length > 0) return { missing };
    for (const step of steps) {
      // S0, the order states and the churn script; R2's recovery edits run on the GPU page only.
      if (step.kind === 'recovery') continue;
      expect(
        service.applyChanges({
          ...step.changes,
          revision: revisionOf(service) + 1,
          baseRevision: revisionOf(service),
        }).status,
      ).toBe('applied');
      frame(step);
      if (missing.length > 0) return { missing };
    }
    const mesh = service.getPathMeshStatistics();
    report.portCalls = { fill: mesh?.portCalls ?? 0, stroke: mesh?.strokePortCalls ?? 0 };
    expect(mesh?.noticesQueued ?? 0).toBe(0);
    service.dispose();
    expect(packers).toHaveLength(1);
    return report;
  } finally {
    PathMeshPacker.prototype.prepare = original;
  }
}

function revisionOf(service: PrimitiveRendererService): number {
  return service.getSynchronizationState().current!.revision;
}

async function makePorts() {
  return { fill: await createFillMeshPort(module), stroke: await createStrokeMeshPort(module) };
}

/** Section 3.4's per-region bound from the measured demand, after warm-up, by parity. */
function bounds(report: RunReport) {
  const { cycles, warmup } = VIZ_V3_CHURN;
  const measured = cycles - warmup;
  const result: Record<string, unknown> = {};
  for (const region of MESH_REGIONS) {
    const perParity: Record<string, unknown> = {};
    for (const parity of ['odd', 'even'] as const) {
      const peaks = new Set<number>();
      const endsSet = new Set<number>();
      const capacities = new Set<number>();
      for (let c = warmup + 1; c <= cycles; c += 1) {
        if ((c % 2 === 1) !== (parity === 'odd')) continue;
        const of = report.steps.filter((step) => step.cycle === c);
        peaks.add(Math.max(...of.map((step) => step.demand[region]!)));
        endsSet.add(of.find((step) => step.churnStep === 'remove')!.demand[region]!);
        for (const step of of) capacities.add(step.capacity[region]!);
      }
      const dPeak = Math.max(...peaks);
      const dEnd = Math.max(...endsSet);
      const capacity = Math.min(...capacities);
      const d = dPeak - dEnd;
      const headroom = capacity - dEnd;
      perParity[parity] = {
        dPeak,
        dPeakValues: [...peaks],
        dEnd,
        dEndValues: [...endsSet],
        d,
        dOverDPeak: dPeak === 0 ? null : d / dPeak,
        capacity,
        capacityValues: [...capacities],
        headroom,
        /** A sustained leak of at least this fraction of d per cycle forces growth in N - W cycles. */
        detectableLeakFraction: d === 0 ? null : headroom / (measured * d),
        /** Cycles until growth for a leak of one element (or slot) per cycle. */
        cyclesForUnitLeak: headroom,
      };
    }
    result[region] = perParity;
  }
  return result;
}

describe('V-3 VZ3-A19: arena demand, growths and repacks under the churn script (informational)', () => {
  it('runs the CPU pipeline headless at DPR 1 and 2 and writes its report', async (context) => {
    const script = buildVizV3Script();
    const reports: Record<string, unknown> = {};
    const directory = path.resolve('artifacts/viz-v3-integration/packer-churn');
    mkdirSync(directory, { recursive: true });
    const file = path.join(
      directory,
      `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}.json`,
    );
    for (const dpr of [1, 2]) {
      const ports = await makePorts();
      try {
        const result = run(dpr, script.steps, script.initial, ports);
        if ('missing' in result) {
          writeFileSync(
            file,
            `${JSON.stringify({ skipped: true, devicePixelRatio: dpr, missing: result.missing }, null, 2)}\n`,
          );
          console.warn(`VZ3-A19 skipped: missing ${result.missing.join(', ')}; report ${file}`);
          context.skip();
          return;
        }
        const { cycles, warmup } = VIZ_V3_CHURN;
        const atWarmup = result.steps.filter((step) => step.cycle === warmup).at(-1)!;
        const last = result.steps.at(-1)!;
        reports[`dpr${dpr}`] = {
          route:
            'PrimitiveRendererService (headless; the PathMeshPipeline fallback was not needed)',
          portCalls: result.portCalls,
          growthsAfterWarmup: result.growths.filter((g) => g.cycle !== null && g.cycle > warmup),
          repacksAfterWarmup: result.repacks.filter((r) => r.cycle !== null && r.cycle > warmup),
          growthsTotal: result.growths,
          repacksTotal: result.repacks,
          packerStatistics: {
            atWarmup: { repacks: atWarmup.repacks, arenaReplacements: atWarmup.arenaReplacements },
            atEnd: { repacks: last.repacks, arenaReplacements: last.arenaReplacements },
          },
          pendingReleasesAtSamples: [...new Set(result.steps.map((step) => step.pendingReleases))],
          bounds: bounds(result),
          orderZone: result.steps.find((step) => step.id === 's5'),
          measuredCycles: cycles - warmup,
          steps: result.steps,
        };
      } finally {
        ports.fill.dispose();
        ports.stroke.dispose();
      }
    }
    writeFileSync(
      file,
      `${JSON.stringify(
        {
          label:
            'INFORMATIONAL (VZ3-A19): not a leak gate. Functional evidence only; precision is UNVERIFIED against the 0.25 physical-pixel target.',
          churn: VIZ_V3_CHURN,
          reports,
        },
        null,
        2,
      )}\n`,
    );
    console.info(`VZ3-A19 report: ${file}`);
    for (const dpr of [1, 2]) {
      const report = reports[`dpr${dpr}`] as Record<string, unknown>;
      console.info(
        `VZ3-A19 DPR ${dpr}: ${JSON.stringify({
          portCalls: report.portCalls,
          growthsAfterWarmup: report.growthsAfterWarmup,
          repacksAfterWarmup: (report.repacksAfterWarmup as unknown[]).length,
          packerStatistics: report.packerStatistics,
          pendingReleasesAtSamples: report.pendingReleasesAtSamples,
          bounds: report.bounds,
        })}`,
      );
    }
    // The only gate: it ran and wrote its report.
    expect(Object.keys(reports)).toEqual(['dpr1', 'dpr2']);
  });
});
