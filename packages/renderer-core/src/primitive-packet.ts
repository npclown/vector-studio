import type { SceneVersion } from '@vector-studio/contracts';
import type { PathMeshNotice } from './path-mesh-pipeline.js';

export type PrimitiveResourceId = 'transforms' | 'geometry' | 'styles' | 'order' | 'frame';
export type PrimitiveTarget = Readonly<{
  generation: number;
  surfaceRevision: number;
  width: number;
  height: number;
  devicePixelRatio: number;
  sampleCount: 1 | 4;
  targetFormat: 'bgra8unorm' | 'rgba8unorm';
}>;
export type PrimitiveRecordVersion = Readonly<{ index: number; version: symbol }>;
export type PrimitiveResource = Readonly<{
  id: PrimitiveResourceId;
  incarnation: symbol;
  capacityBytes: number;
}>;
export type PrimitiveWrite = Readonly<{
  resourceId: PrimitiveResourceId;
  incarnation: symbol;
  byteOffset: number;
  bytes: Uint8Array;
  records: readonly PrimitiveRecordVersion[];
}>;
export type PrimitiveDraw = Readonly<{
  first: number;
  count: number;
  variant: 'analytic-v1';
}>;
/** P3 V3 contract, section f: the optional mesh packet part, version 0. */
export type MeshResourceId =
  | 'meshPositions'
  | 'meshTriangles'
  | 'meshFeatureLists'
  | 'meshFeatures'
  | 'meshInstances'
  | 'meshFrame';
export type MeshFillDraw = Readonly<{
  /** Number of analytic draws that precede this draw in paint order; equal values keep array order. */
  position: number;
  /** Path slot; selects the meshInstances record. */
  instance: number;
  /** Absolute record index in meshTriangles. */
  firstTriangle: number;
  /** Region and exterior triangles of the served variant, > 0. */
  triangleCount: number;
  /**
   * ST-U7 addendum, section 4.5: present only on a joint fill draw, which uses the joint
   * pipeline over the overlay variant's triangles and reads the stroke record named by word 15
   * of its instance record (stroke slot + 1). Absent on every other draw; layoutVersion stays 0.
   */
  composite?: 'joint-fill';
}>;
export type MeshResource = Readonly<{
  id: MeshResourceId;
  incarnation: symbol;
  capacityBytes: number;
}>;
export type MeshWrite = Readonly<{
  resourceId: MeshResourceId;
  incarnation: symbol;
  byteOffset: number;
  bytes: Uint8Array;
  records: readonly PrimitiveRecordVersion[];
}>;
export type MeshPacketPart = Readonly<{
  layoutVersion: 0;
  originRevision: symbol;
  /** The six resources in fixed order, or none for a part that carries notices only. */
  resources: readonly MeshResource[];
  writes: readonly MeshWrite[];
  draws: readonly MeshFillDraw[];
  notices: readonly PathMeshNotice[];
}>;
export type MeshReceiptResource = Readonly<{
  resourceId: MeshResourceId;
  incarnation: symbol;
  records: readonly PrimitiveRecordVersion[];
}>;
/** `skipped`: the mesh path is unavailable for this generation; only the P1 part is acknowledged. */
export type MeshReceiptPart =
  | Readonly<{
      status: 'submitted';
      originRevision: symbol;
      resources: readonly MeshReceiptResource[];
    }>
  | Readonly<{ status: 'skipped' }>;
export type PrimitivePacket = Readonly<{
  layoutVersion: 1;
  scene: SceneVersion;
  sceneEpoch: symbol;
  cameraRevision: number;
  surfaceRevision: number;
  originRevision: symbol;
  generation: number;
  packetId: symbol;
  mode: 'reconstruct' | 'incremental';
  resources: readonly PrimitiveResource[];
  writes: readonly PrimitiveWrite[];
  draws: readonly PrimitiveDraw[];
  frame: PrimitiveTarget;
  /** Absent for every primitive-only scene (P3 V3 contract, section f). */
  mesh?: MeshPacketPart;
}>;
export type PrimitiveReceipt = Readonly<{
  scene: SceneVersion;
  sceneEpoch: symbol;
  cameraRevision: number;
  surfaceRevision: number;
  originRevision: symbol;
  generation: number;
  packetId: symbol;
  submissionSerial: number;
  resources: readonly Readonly<{
    resourceId: PrimitiveResourceId;
    incarnation: symbol;
    records: readonly PrimitiveRecordVersion[];
  }>[];
  /** Present exactly when the packet has a mesh part. */
  mesh?: MeshReceiptPart;
}>;
export type PrimitiveSubmitResult =
  | Readonly<{ status: 'submitted'; receipt: PrimitiveReceipt }>
  | Readonly<{ status: 'not-ready' | 'stale-generation' }>
  | Readonly<{
      status: 'failed';
      reason: 'invalid-packet' | 'allocation-failed' | 'submission-failed';
    }>;
export interface PrimitivePacketConsumer {
  submitPrimitivePacket(packet: PrimitivePacket): PrimitiveSubmitResult;
}
export interface PrimitiveFrameSource {
  /**
   * True when the backend must create the mesh pipeline at initialization and recovery
   * (P3 V3 contract, section f). Optional; absent means false.
   */
  readonly requiresMeshPipeline?: boolean;
  prepare(target: PrimitiveTarget): PrimitivePacket | null;
  acknowledge(receipt: PrimitiveReceipt): void;
}
