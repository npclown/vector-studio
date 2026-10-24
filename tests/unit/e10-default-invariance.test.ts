import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RendererInvalidationTarget, RenderSceneSnapshot } from '@vector-studio/contracts';
import { PrimitiveRendererService, type AnimationFrameClock } from '@vector-studio/renderer-core';
import { WebGpuBackend } from '@vector-studio/renderer-webgpu';
import { afterEach, describe, expect, it } from 'vitest';
import { MESH_FILL_SHADER } from '../../packages/renderer-webgpu/src/mesh-fill-shader.js';
import { GpuRecorder, installRecordedBrowserGpu } from '../support/e10-gpu-recorder.js';
import {
  createCountingPort,
  identity,
  pathNode,
  rectangleNode,
} from '../support/v3a-path-harness.js';
import { ScriptedStrokeMeshPort, strokedNode } from '../support/st-u6-stroke-harness.js';

// E10 contract, criterion E10-A1 (docs/plans/d9-e10-renderer-test-hooks-contract.md, section
// 6): with no hook option, the browser platform, backend and native scene issue the same
// ordered GPU calls as at the base commit of E10. The golden log was recorded before any E10
// renderer-webgpu change; a change to it needs a stated reason in its PR. Regenerate with
// E10_UPDATE_GOLDEN=1 only for such a reason.

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'e10-golden', 'default-gpu-log.json');
/** E3-U4's recorded SHA-256 of MESH_FILL_SHADER (E3 contract, section 16.5). */
const MESH_FILL_SHADER_SHA256 = 'd306137cf0770f6bf7f9237f1c98b9ecd0a165cfdbfda916196d299e36b831a3';

class ManualClock implements AnimationFrameClock {
  #callbacks = new Map<number, (timestampMs: number) => void>();
  #next = 0;
  #now = 0;

  public request(callback: (timestampMs: number) => void): number {
    this.#next += 1;
    this.#callbacks.set(this.#next, callback);
    return this.#next;
  }

  public cancel(handle: number): void {
    this.#callbacks.delete(handle);
  }

  public tick(): void {
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    this.#now += 16;
    for (const callback of callbacks) callback(this.#now);
  }
}

function scene(): RenderSceneSnapshot {
  const nodes = [
    pathNode('fill', 0),
    strokedNode('stroked', 40),
    strokedNode('joint', 80, { opacity: 0.5 }),
    rectangleNode('rect', 120),
  ];
  return { identity, revision: 1, nodes, rootOrder: nodes.map((node) => node.id) };
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

async function defaultLog(): Promise<unknown[][]> {
  const recorder = new GpuRecorder();
  const installed = installRecordedBrowserGpu(recorder);
  restore = () => installed.restore();
  const clock = new ManualClock();
  const backend = new WebGpuBackend({ animationFrameClock: clock, now: () => 0 });
  const invalidation: RendererInvalidationTarget = backend;
  const service = new PrimitiveRendererService(invalidation, {
    fillMesh: createCountingPort(),
    strokeMesh: new ScriptedStrokeMeshPort(),
  });
  backend.attachPrimitiveFrameSource(service);
  const result = await backend.initialize({
    canvas: installed.canvas,
    cssSize: { width: 320, height: 180 },
    devicePixelRatio: 1.5,
  });
  expect(result.supported, JSON.stringify(result)).toBe(true);
  expect(service.replaceSnapshot(scene()).status).toBe('applied');
  expect(service.setCamera({ position: { x: -10, y: -5 }, zoom: 1 }).status).toBe('applied');
  clock.tick();
  service.setCamera({ position: { x: 3, y: 2 }, zoom: 2 });
  clock.tick();
  backend.dispose();
  return recorder.log.map((entry) => [...entry]);
}

describe('E10-A1 default invariance', () => {
  it('E10-A1: MESH_FILL_SHADER is the source E3-U4 recorded', () => {
    expect(createHash('sha256').update(MESH_FILL_SHADER).digest('hex')).toBe(
      MESH_FILL_SHADER_SHA256,
    );
  });

  it('E10-A1: with no hook option the GPU call log equals the golden log', async () => {
    const log = await defaultLog();
    expect(log.some(([name]) => String(name).endsWith('.submit'))).toBe(true);
    expect(log.some(([name]) => String(name).endsWith('.draw'))).toBe(true);
    if (process.env.E10_UPDATE_GOLDEN === '1' || !existsSync(GOLDEN)) {
      if (process.env.E10_UPDATE_GOLDEN !== '1') throw new Error(`Golden log missing: ${GOLDEN}`);
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, `${JSON.stringify(log, null, 1)}\n`);
    }
    expect(log).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });
});
