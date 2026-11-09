// E41 contract, section 3 (E41-S1): schema v7 is schema v6 with `effects: []` appended to every
// node. Tests that compare the model's output with committed v6 text or values upgrade the
// expectation with these helpers instead of committing a v7 copy of every fixture.

type Json = { [key: string]: unknown };

/** A v6 document value (or a persistence envelope holding one) as `migrateV6toV7` writes it. */
export function v7Value<T>(value: T): T {
  const record = value as unknown as Json;
  if ('envelopeVersion' in record) {
    return { ...record, document: v7Value(record.document) } as T;
  }
  const nodes = record.nodes as Record<string, Json>;
  return {
    ...record,
    schemaVersion: 7,
    nodes: Object.fromEntries(
      Object.entries(nodes).map(([key, node]) => [key, { ...node, effects: [] }]),
    ),
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
    nodes: Object.fromEntries(
      Object.entries(nodes).map(([key, node]) => {
        const rest = { ...node };
        delete rest.effects;
        return [key, rest];
      }),
    ),
  } as T;
}

/**
 * A clipboard text written at v6 (marker line plus compact fragment JSON) as the editor now
 * writes it: `schemaVersion: 7` and `effects: []` on every node and carried source node.
 */
export function v7Fragment(text: string): string {
  const start = text.indexOf('{');
  const body = JSON.parse(text.slice(start)) as Json;
  const withEffects = (nodes: unknown) =>
    Object.fromEntries(
      Object.entries(nodes as Record<string, Json>).map(([key, node]) => [
        key,
        { ...node, effects: [] },
      ]),
    );
  const upgraded: Json = { ...body, schemaVersion: 7, nodes: withEffects(body.nodes) };
  if ('sourceNodes' in body) upgraded.sourceNodes = withEffects(body.sourceNodes);
  return text.slice(0, start) + JSON.stringify(upgraded);
}

/** A fragment body (or document value) with `effects` removed from every node and source node. */
export function withoutEffects<T>(body: T): T {
  const record = body as unknown as Json;
  const strip = (nodes: unknown) =>
    Object.fromEntries(
      Object.entries(nodes as Record<string, Json>).map(([key, node]) => {
        const rest = { ...node };
        delete rest.effects;
        return [key, rest];
      }),
    );
  const out: Json = { ...record, nodes: strip(record.nodes) };
  if (record.sourceNodes !== undefined) out.sourceNodes = strip(record.sourceNodes);
  return out as T;
}
