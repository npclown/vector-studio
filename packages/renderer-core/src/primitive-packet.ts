import type { SceneVersion } from '@vector-studio/contracts';
import type { ClipStateRecord, MaskBudgetNotice, MaskLevelRecord } from './clip-resolution.js';
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
  /** P4 contract, U2: the 1-based clip state of a clipped run; absent when unclipped. */
  clipState?: number;
}>;
/**
 * P4 contract, U4: a mask level of the clip part. A mesh source carries its packed fill draw in
 * the mesh part's resources, or null when it did not reach the packet (it then covers nothing).
 */
export type ClipMaskPacketLevel = Omit<MaskLevelRecord, 'source'> &
  Readonly<{
    source:
      | Readonly<{ kind: 'primitive'; slot: number }>
      | Readonly<{
          kind: 'mesh';
          nodeId: string;
          draw: Readonly<{ instance: number; firstTriangle: number; triangleCount: number }> | null;
        }>;
  }>;
/**
 * P4 contract, U2: the frame's clip states, present only when a drawn draw is clipped. Plain
 * records; U3 and U4 own their GPU layout.
 */
export type ClipPacketPart = Readonly<{
  layoutVersion: 0;
  /** In index order; indices may have gaps, so a GPU table is sized by `maxIndex`. */
  states: readonly ClipStateRecord[];
  maxIndex: number;
  /**
   * U4: the frame's drawable mask levels, each after its parent level; empty without a mask
   * level. A content state reads the level named last in its `masks`.
   */
  masks: readonly ClipMaskPacketLevel[];
  /**
   * U3: the packet's primitive origin, which rect records are rebased to on the GPU so a camera
   * move rewrites no record, and the camera, which maps a physical pixel to the world:
   * `world = camera + pixel / (zoom * devicePixelRatio)`.
   */
  origin: Readonly<{ x: number; y: number }>;
  camera: Readonly<{ x: number; y: number; zoom: number }>;
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
  /** P4 contract, U2: the 1-based clip state of a clipped draw; absent when unclipped. */
  clipState?: number;
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
  /** Absent for every unclipped frame (P4 contract, U2). */
  clip?: ClipPacketPart;
  /**
   * P4 contract, U4 and section 5: mask levels newly over the mask texture budget, at most 32;
   * absent when none. Emitted as `render.clip-resource-limit`.
   */
  clipNotices?: readonly MaskBudgetNotice[];
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
  /**
   * P4 contract, U3: true when the backend must create the clip pipeline variants at
   * initialization and recovery. Optional; absent means false.
   */
  readonly requiresClipPipeline?: boolean;
  prepare(target: PrimitiveTarget): PrimitivePacket | null;
  acknowledge(receipt: PrimitiveReceipt): void;
}
