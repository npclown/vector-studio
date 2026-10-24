import type { MeshFillDraw, PrimitivePacket } from '@vector-studio/renderer-core';

import { halfToNumber } from './mesh-count-shader.js';
import type {
  WebGpuResourceTracker,
  WebGpuSceneCaptureForTesting,
  WebGpuSceneCaptureRequestForTesting,
} from './webgpu-platform.js';

// E10 contract, sections 4 and 5 (docs/plans/d9-e10-renderer-test-hooks-contract.md): the
// test-only frame capture and count pass, encoded into the frame's own command encoder after the
// main pass. Nothing here runs unless a capture was armed.

const MAP_READ_USAGE = 0x01;
const COPY_DESTINATION_USAGE = 0x08;
const TEXTURE_COPY_SOURCE_USAGE = 0x01;
const TEXTURE_BINDING_USAGE = 0x04;
const RENDER_ATTACHMENT_USAGE = 0x10;
const MAP_MODE_READ = 0x01;
/** binary16 is exact for integers up to 2048; a count of 2048 or more is reported, not rounded. */
const COUNT_OVERFLOW = 2048;

/** The count pipelines of a generation (E10 contract, section 5). */
export interface CountPipelineState {
  readonly fill: GPURenderPipeline;
  readonly joint: GPURenderPipeline;
  /** 4x only: the readout pipeline and its bind group layout. */
  readonly readout: Readonly<{ pipeline: GPURenderPipeline; layout: GPUBindGroupLayout }> | null;
}

export interface CaptureFrame {
  readonly device: GPUDevice;
  readonly encoder: GPUCommandEncoder;
  readonly resources: WebGpuResourceTracker;
  readonly idPrefix: string;
  readonly packet: PrimitivePacket;
  readonly presentation: GPUTexture;
  readonly width: number;
  readonly height: number;
  readonly sampleCount: 1 | 4;
  readonly format: 'bgra8unorm' | 'rgba8unorm';
  /** The mesh draws encoded in the main pass, with the bind group they used; null if none. */
  readonly mesh: Readonly<{ bindGroup: GPUBindGroup; draws: readonly MeshFillDraw[] }> | null;
  readonly count: CountPipelineState | null;
}

/** Owns the capture's GPU objects until the readback settles or the frame fails. */
export class PendingCapture {
  readonly #request: WebGpuSceneCaptureRequestForTesting;
  readonly #resources: WebGpuResourceTracker;
  readonly #owned: Array<Readonly<{ id: string; destroy: () => void }>> = [];
  #rgba: Readonly<{ buffer: GPUBuffer; bytesPerRow: number }> | null = null;
  #counts: Readonly<{ buffer: GPUBuffer; bytesPerRow: number; samples: 1 | 4 }> | null = null;
  #frame: CaptureFrame | null = null;
  #settled = false;
  readonly #onSettled: () => void;

  public constructor(
    request: WebGpuSceneCaptureRequestForTesting,
    resources: WebGpuResourceTracker,
    onSettled: () => void = () => undefined,
  ) {
    this.#request = request;
    this.#resources = resources;
    this.#onSettled = onSettled;
  }

  /** Encodes the count pass (if requested) and both copies after the main pass. */
  public encode(frame: CaptureFrame): void {
    this.#frame = frame;
    const { device, encoder, width, height } = frame;
    if (this.#request.counts) {
      // Assert: the scene refuses a counts capture without count pipelines when it is armed.
      if (frame.count === null) throw new CaptureError('capture-disabled', 'no count pipelines');
      const counts = this.#texture(frame, 'counts', frame.sampleCount, frame.sampleCount === 1);
      const pass = encoder.beginRenderPass({
        label: 'vector-studio/e10-count-pass',
        colorAttachments: [
          {
            view: counts.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      if (frame.mesh !== null && frame.mesh.draws.length > 0) {
        pass.setBindGroup(0, frame.mesh.bindGroup);
        let bound: GPURenderPipeline | null = null;
        for (const draw of frame.mesh.draws) {
          const pipeline = draw.composite === 'joint-fill' ? frame.count.joint : frame.count.fill;
          if (pipeline !== bound) {
            pass.setPipeline(pipeline);
            bound = pipeline;
          }
          pass.draw(3 * draw.triangleCount, 1, 3 * draw.firstTriangle, draw.instance);
        }
      }
      pass.end();
      let source = counts;
      if (frame.sampleCount === 4) {
        const readout = frame.count.readout!;
        source = this.#texture(frame, 'count-readout', 1, true);
        const group = device.createBindGroup({
          label: 'vector-studio/e10-count-readout',
          layout: readout.layout,
          entries: [{ binding: 0, resource: counts.createView() }],
        });
        const second = encoder.beginRenderPass({
          label: 'vector-studio/e10-count-readout-pass',
          colorAttachments: [
            {
              view: source.createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
        });
        second.setPipeline(readout.pipeline);
        second.setBindGroup(0, group);
        second.draw(3);
        second.end();
      }
      const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
      const buffer = this.#buffer(frame, 'count-staging', bytesPerRow * height);
      encoder.copyTextureToBuffer(
        { texture: source },
        { buffer, bytesPerRow, rowsPerImage: height },
        { width, height },
      );
      this.#counts = { buffer, bytesPerRow, samples: frame.sampleCount };
    }
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const buffer = this.#buffer(frame, 'rgba-staging', bytesPerRow * height);
    encoder.copyTextureToBuffer(
      { texture: frame.presentation },
      { buffer, bytesPerRow, rowsPerImage: height },
      { width, height },
    );
    this.#rgba = { buffer, bytesPerRow };
  }

  /** After the frame's submit: maps the staging buffers and settles the request. */
  public submitted(): void {
    this.#request.encoded();
    const rgba = this.#rgba!;
    const counts = this.#counts;
    void Promise.all([
      rgba.buffer.mapAsync(MAP_MODE_READ),
      counts?.buffer.mapAsync(MAP_MODE_READ),
    ]).then(
      () => {
        try {
          this.#resolve(rgba, counts);
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error(String(error)));
        }
      },
      (error: unknown) =>
        this.fail(new CaptureError('device-lost', `mapping failed: ${String(error)}`)),
    );
  }

  /** Releases every owned object and rejects the request; idempotent. */
  public fail(error: Error): void {
    this.#release();
    if (this.#settled) return;
    this.#settled = true;
    this.#onSettled();
    this.#request.reject(error);
  }

  #resolve(
    rgba: Readonly<{ buffer: GPUBuffer; bytesPerRow: number }>,
    counts: Readonly<{ buffer: GPUBuffer; bytesPerRow: number; samples: 1 | 4 }> | null,
  ): void {
    const frame = this.#frame!;
    const { width, height } = frame;
    const mapped = new Uint8Array(rgba.buffer.getMappedRange().slice(0));
    rgba.buffer.unmap();
    const pixels = new Uint8Array(width * height * 4);
    for (let row = 0; row < height; row += 1) {
      pixels.set(
        mapped.subarray(row * rgba.bytesPerRow, row * rgba.bytesPerRow + width * 4),
        row * width * 4,
      );
    }
    if (frame.format === 'bgra8unorm') {
      for (let index = 0; index < pixels.length; index += 4) {
        const blue = pixels[index]!;
        pixels[index] = pixels[index + 2]!;
        pixels[index + 2] = blue;
      }
    }
    let countData: WebGpuSceneCaptureForTesting['counts'];
    if (counts !== null) {
      const view = new DataView(counts.buffer.getMappedRange().slice(0));
      counts.buffer.unmap();
      const data = new Uint16Array(width * height * counts.samples);
      for (let row = 0; row < height; row += 1) {
        for (let column = 0; column < width; column += 1) {
          for (let sample = 0; sample < counts.samples; sample += 1) {
            const value = halfToNumber(
              view.getUint16(row * counts.bytesPerRow + column * 8 + sample * 2, true),
            );
            // A non-integer, negative or non-finite value is also reported as count-overflow:
            // additive blending of 1s can only leave one past binary16's exact range.
            if (!(value >= 0 && value < COUNT_OVERFLOW) || !Number.isInteger(value)) {
              const kind = Number.isInteger(value) ? 'count' : 'non-integer count';
              throw new CaptureError(
                'count-overflow',
                `${kind} ${value} at pixel (${column}, ${row}), sample ${sample}`,
              );
            }
            data[(row * width + column) * counts.samples + sample] = value;
          }
        }
      }
      countData = Object.freeze({ samples: counts.samples, data });
    }
    this.#release();
    if (this.#settled) return;
    this.#settled = true;
    this.#onSettled();
    const packet = frame.packet;
    this.#request.resolve(
      Object.freeze({
        generation: packet.generation,
        surfaceRevision: packet.surfaceRevision,
        cameraRevision: packet.cameraRevision,
        width,
        height,
        sampleCount: frame.sampleCount,
        targetFormat: frame.format,
        rgba: pixels,
        meshDraws: Object.freeze(
          (packet.mesh?.draws ?? []).map((draw) =>
            Object.freeze({
              instance: draw.instance,
              firstTriangle: draw.firstTriangle,
              triangleCount: draw.triangleCount,
              composite: draw.composite === 'joint-fill' ? 'joint-fill' : 'plain',
            }),
          ),
        ),
        ...(countData === undefined ? {} : { counts: countData }),
      }),
    );
  }

  #texture(frame: CaptureFrame, name: string, sampleCount: 1 | 4, copySource: boolean) {
    const id = `${frame.idPrefix}/${name}`;
    const texture = frame.device.createTexture({
      label: id,
      size: { width: frame.width, height: frame.height },
      sampleCount,
      format: 'rgba16float',
      usage:
        RENDER_ATTACHMENT_USAGE | (copySource ? TEXTURE_COPY_SOURCE_USAGE : TEXTURE_BINDING_USAGE),
    });
    this.#own(id, () => texture.destroy(), {
      category: 'texture',
      dimension: '2d',
      width: frame.width,
      height: frame.height,
      depthOrArrayLayers: 1,
      mipLevelCount: 1,
      sampleCount,
      bytesPerTexel: 8,
    });
    return texture;
  }

  #buffer(frame: CaptureFrame, name: string, size: number): GPUBuffer {
    const id = `${frame.idPrefix}/${name}`;
    const buffer = frame.device.createBuffer({
      label: id,
      size,
      usage: MAP_READ_USAGE | COPY_DESTINATION_USAGE,
    });
    this.#own(id, () => buffer.destroy(), { category: 'buffer', size });
    return buffer;
  }

  #own(
    id: string,
    destroy: () => void,
    descriptor: Parameters<WebGpuResourceTracker['track']>[1],
  ): void {
    try {
      this.#resources.track(id, descriptor);
    } catch (error) {
      destroy();
      throw error;
    }
    this.#owned.push({ id, destroy });
  }

  #release(): void {
    for (const { id, destroy } of this.#owned.splice(0)) {
      try {
        destroy();
      } catch {
        // Release is best effort; accounting is still cleared.
      }
      try {
        this.#resources.release(id);
      } catch {
        // Accounting cleanup is best effort.
      }
    }
  }
}

/** A capture failure whose message starts with its section 4 code. */
export class CaptureError extends Error {
  public constructor(
    public readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'CaptureError';
  }
}
