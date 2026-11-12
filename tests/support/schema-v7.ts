// E41 contract, section 3 (E41-S1): schema v7 is schema v6 with `effects: []` appended to every
// node. Tests that compare the model's output with committed v6 text or values upgrade the
// expectation with these helpers instead of committing a v7 copy of every fixture.

type Json = { [key: string]: unknown };

const FILL_TYPES = new Set(['rectangle', 'ellipse', 'path', 'custom', 'frame', 'symbol']);
const CONTAINERS = new Set(['group', 'maskGroup', 'frame', 'symbol', 'instance']);

/**
 * A v6 node as the model now writes it (V-35 contract, V35-S1): `fill` becomes `fills` in its
 * place, then `blendMode` and `effects: []` are appended.
 */
export function v8Node(node: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'effects' || key === 'blendMode') continue;
    if (key === 'fill' && FILL_TYPES.has(node.type as string)) {
      out.fills =
        value === null ? [] : [{ paint: value, visible: true, opacity: 1, blendMode: 'normal' }];
    } else out[key] = value;
  }
  out.blendMode =
    node.blendMode ?? (CONTAINERS.has(node.type as string) ? 'passThrough' : 'normal');
  out.effects = node.effects ?? [];
  return out;
}

/** A v8 node back in the v6 shape: `fills` as `fill` (its first fill's paint), no mode or effects. */
export function v6Node(node: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'effects' || key === 'blendMode') continue;
    if (key === 'fills') {
      const fills = value as Json[];
      out.fill = fills.length === 0 ? null : fills[0]!.paint;
    } else out[key] = value;
  }
  return out;
}

/** A v6 document value (or a persistence envelope holding one) as `migrateV6toV7` writes it. */
export function v7Value<T>(value: T): T {
  const record = value as unknown as Json;
  if ('envelopeVersion' in record) {
    return { ...record, document: v7Value(record.document) } as T;
  }
  const nodes = record.nodes as Record<string, Json>;
  return {
    ...record,
    schemaVersion: 8,
    nodes: Object.fromEntries(Object.entries(nodes).map(([key, node]) => [key, v8Node(node)])),
  } as T;
}

/** Canonical v6 text (a document or an envelope) as the model now writes it, at v7. */
export function v7Text(text: string): string {
  return `${JSON.stringify(v7Value(JSON.parse(text) as Json), null, 2)}\n`;
}

/** A v7 document value with `effects` removed from every node and `schemaVersion: 6`. */
export function v6Value<T>(value: T): T {
  const record = value as unknown as Json;
  const nodes = record.nodes as Record<string, Json>;
  return {
    ...record,
    schemaVersion: 6,
    nodes: Object.fromEntries(Object.entries(nodes).map(([key, node]) => [key, v6Node(node)])),
  } as T;
}

/**
 * A clipboard text written at v6 (marker line plus compact fragment JSON) as the editor now
 * writes it: `schemaVersion: 8` and `effects: []` on every node and carried source node.
 */
export function v7Fragment(text: string): string {
  const start = text.indexOf('{');
  const body = JSON.parse(text.slice(start)) as Json;
  const withEffects = (nodes: unknown) =>
    Object.fromEntries(
      Object.entries(nodes as Record<string, Json>).map(([key, node]) => [key, v8Node(node)]),
    );
  const upgraded: Json = { ...body, schemaVersion: 8, nodes: withEffects(body.nodes) };
  if ('sourceNodes' in body) upgraded.sourceNodes = withEffects(body.sourceNodes);
  return text.slice(0, start) + JSON.stringify(upgraded);
}

/** A fragment body (or document value) with every node and source node in the v6 shape. */
export function withoutEffects<T>(body: T): T {
  const record = body as unknown as Json;
  const strip = (nodes: unknown) =>
    Object.fromEntries(
      Object.entries(nodes as Record<string, Json>).map(([key, node]) => [key, v6Node(node)]),
    );
  const out: Json = { ...record, nodes: strip(record.nodes) };
  if (record.sourceNodes !== undefined) out.sourceNodes = strip(record.sourceNodes);
  return out as T;
}
