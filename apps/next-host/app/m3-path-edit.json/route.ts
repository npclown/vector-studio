import { readFile } from 'node:fs/promises';
import path from 'node:path';

// M3-U4 (M3 contract, M3-A12): serves the committed M3 path-edit fixture (a closed cubic path on
// the page and an open path inside a rotated group) to the page with `?fixture=path-edit`. It is
// read at request time from the one shared fixture, so the page, the headed spec and the unit
// tests use the same file; nothing else under `tests/` is reachable.
export const dynamic = 'force-dynamic';

const fixturePath = path.resolve(process.cwd(), '../../tests/fixtures/m3-path-edit/path-edit.json');

export async function GET(): Promise<Response> {
  try {
    const text = await readFile(/*turbopackIgnore: true*/ fixturePath, 'utf8');
    return new Response(text, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
