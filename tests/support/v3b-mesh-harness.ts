import type { FillMesh } from '@vector-studio/contracts';
import type {
  MeshResourceId,
  MeshWrite,
  PrimitivePacket,
  PrimitiveReceipt,
} from '../../packages/renderer-core/src/primitive-packet.js';

// Shared helpers for the P3 V3 unit V3b tests: receipts built from a packet the way the
// backend builds them, and shadow copies of the mesh resources that apply packet writes.
// Functional evidence only: precision is UNVERIFIED against the 0.25 physical-pixel target.

export type MeshReceiptMode = 'submitted' | 'skipped' | 'none';

/** A receipt acknowledging every write of the packet, with the requested mesh part. */
export function receiptOf(
  packet: PrimitivePacket,
  mesh: MeshReceiptMode = 'submitted',
  submissionSerial = 1,
): PrimitiveReceipt {
  const base: PrimitiveReceipt = {
    scene: packet.scene,
    sceneEpoch: packet.sceneEpoch,
    cameraRevision: packet.cameraRevision,
    surfaceRevision: packet.surfaceRevision,
    originRevision: packet.originRevision,
    generation: packet.generation,
    packetId: packet.packetId,
    submissionSerial,
    resources: packet.resources.map((resource) => ({
      resourceId: resource.id,
      incarnation: resource.incarnation,
      records: packet.writes
        .filter((write) => write.resourceId === resource.id)
        .flatMap((write) => write.records),
    })),
  };
  const part = packet.mesh;
  if (part === undefined || mesh === 'none') return base;
  if (mesh === 'skipped') return { ...base, mesh: { status: 'skipped' } };
  return {
    ...base,
    mesh: {
      status: 'submitted',
      originRevision: part.originRevision,
      resources: part.resources.map((resource) => ({
        resourceId: resource.id,
        incarnation: resource.incarnation,
        records: part.writes
          .filter((write) => write.resourceId === resource.id)
          .flatMap((write) => write.records),
      })),
    },
  };
}

/** Byte shadows of the six mesh resources; writes land at their byte offsets. */
export class MeshShadow {
  readonly bytes = new Map<MeshResourceId, Uint8Array>();
  readonly written = new Map<MeshResourceId, Set<number>>();

  public apply(packet: PrimitivePacket): void {
    const part = packet.mesh;
    if (part === undefined) return;
    for (const resource of part.resources) {
      const current = this.bytes.get(resource.id);
      if (current === undefined || current.byteLength !== resource.capacityBytes) {
        const next = new Uint8Array(resource.capacityBytes);
        if (current !== undefined)
          next.set(current.subarray(0, Math.min(current.byteLength, next.byteLength)));
        this.bytes.set(resource.id, next);
      }
    }
    for (const write of part.writes) this.#write(write);
  }

  #write(write: MeshWrite): void {
    this.bytes.get(write.resourceId)!.set(write.bytes, write.byteOffset);
    let written = this.written.get(write.resourceId);
    if (written === undefined) {
      written = new Set();
      this.written.set(write.resourceId, written);
    }
    for (const record of write.records) written.add(record.index);
  }

  public f32(resource: MeshResourceId, byteOffset: number): number {
    const bytes = this.bytes.get(resource)!;
    return new DataView(bytes.buffer, bytes.byteOffset).getFloat32(byteOffset, true);
  }

  public u32(resource: MeshResourceId, byteOffset: number): number {
    const bytes = this.bytes.get(resource)!;
    return new DataView(bytes.buffer, bytes.byteOffset).getUint32(byteOffset, true);
  }
}

/** Decodes little-endian 32-bit words of a byte range. */
export function words(bytes: Uint8Array, kind: 'f32' | 'u32'): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.byteLength / 4 }, (_, index) =>
    kind === 'f32' ? view.getFloat32(4 * index, true) : view.getUint32(4 * index, true),
  );
}

/** A counter-clockwise fan mesh over the given polygon vertices, with exact bounds. */
export function fanMesh(points: readonly (readonly [number, number])[]): FillMesh {
  const positions = Float64Array.from(points.flat());
  const indices: number[] = [];
  for (let index = 1; index + 1 < points.length; index += 1) indices.push(0, index, index + 1);
  const boundaryEdges: number[] = [];
  for (let index = 0; index < points.length; index += 1) {
    boundaryEdges.push(index, (index + 1) % points.length);
  }
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return {
    positions,
    indices: Uint32Array.from(indices),
    boundaryEdges: Uint32Array.from(boundaryEdges),
    bounds: {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    },
  };
}
