import { readFile } from 'node:fs/promises';
import path from 'node:path';

// M1-U5 (M1 contract, M1-A12): serves the committed M1 containers fixture (two pages, a rotated
// frame with clipped children and a border, a mask group and an arrow line) to the page with
// `?fixture=containers`. It is read at request time from the one shared fixture, so the page and
// the unit tests use the same file; nothing else under `tests/` is reachable.
export const dynamic = 'force-dynamic';

const fixturePath = path.resolve(process.cwd(), '../../tests/fixtures/m1-model/containers.json');

export async function GET(): Promise<Response> {
  try {
    const text = await readFile(/*turbopackIgnore: true*/ fixturePath, 'utf8');
    return new Response(text, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch {
    return new Response(`M1 fixture not found at ${fixturePath}`, { status: 404 });
  }
}
