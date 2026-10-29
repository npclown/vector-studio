import type { Premultiplied } from './e23-gradient-oracle.js';

// E25 contract (docs/plans/d9-e25-isolated-opacity-contract.md), unit U4: the CPU oracle of
// section 3 over isolated containers, in binary64. Leaves are the E23 and E24 oracles' element
// sources (paint, coverage, clip and mask regions, node opacity). An isolated container
// composes its children on a fully transparent target and contributes `α · L` source-over at
// its paint position (E25-K1); clips stay per leaf (E25-K2). The `multiplied` mode is the
// counter-oracle that multiplies each descendant leaf by the containers' opacities instead
// (E25-A03, O1). Probes are interior: any undecided leaf makes the probe undecided.

/** A leaf's source at a world point: premultiplied, 'none', or null when undecided. */
export type LeafSource = (
  wx: number,
  wy: number,
  pixelSize: number,
) => Premultiplied | 'none' | null;

export type LayerTree =
  | Readonly<{ kind: 'leaf'; source: LeafSource }>
  | Readonly<{ kind: 'group'; opacity: number; children: readonly LayerTree[] }>;

export type OracleMode = 'isolated' | 'multiplied';

const over = (source: Premultiplied, target: Premultiplied): Premultiplied =>
  [0, 1, 2, 3].map(
    (lane) => source[lane]! + target[lane]! * (1 - source[3]),
  ) as unknown as Premultiplied;

const times = (value: Premultiplied, factor: number): Premultiplied =>
  value.map((lane) => lane * factor) as unknown as Premultiplied;

/** Composes `nodes` in paint order onto `target`; null when any leaf is undecided. */
function compose(
  nodes: readonly LayerTree[],
  target: Premultiplied,
  wx: number,
  wy: number,
  pixelSize: number,
  mode: OracleMode,
  inherited: number,
): Premultiplied | null {
  let out = target;
  for (const node of nodes) {
    if (node.kind === 'leaf') {
      const source = node.source(wx, wy, pixelSize);
      if (source === null) return null;
      if (source === 'none') continue;
      out = over(times(source, inherited), out);
      continue;
    }
    // E25-K3: opacity 0 draws nothing; opacity 1 is not isolated.
    if (node.opacity === 0) continue;
    if (node.opacity === 1 || mode === 'multiplied') {
      const inner = compose(node.children, out, wx, wy, pixelSize, mode, inherited * node.opacity);
      if (inner === null) return null;
      out = inner;
      continue;
    }
    const layer = compose(node.children, [0, 0, 0, 0], wx, wy, pixelSize, mode, inherited);
    if (layer === null) return null;
    out = over(times(layer, node.opacity), out);
  }
  return out;
}

/**
 * The expected 8-bit-scale RGB at world point `(wx, wy)` over the page's opaque black, or null
 * when the probe is undecided.
 */
export function expectedLayeredAt(
  nodes: readonly LayerTree[],
  wx: number,
  wy: number,
  pixelSize: number,
  mode: OracleMode = 'isolated',
): readonly [number, number, number] | null {
  const out = compose(nodes, [0, 0, 0, 1], wx, wy, pixelSize, mode, 1);
  return out === null ? null : [out[0] * 255, out[1] * 255, out[2] * 255];
}

/** The isolation depth of a tree: the most nested containers with 0 < opacity < 1. */
export function isolationDepth(nodes: readonly LayerTree[]): number {
  let deepest = 0;
  for (const node of nodes) {
    if (node.kind === 'group') {
      const own = node.opacity > 0 && node.opacity < 1 ? 1 : 0;
      deepest = Math.max(deepest, own + isolationDepth(node.children));
    }
  }
  return deepest;
}
