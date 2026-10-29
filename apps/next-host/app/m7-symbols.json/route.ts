import { readFile } from 'node:fs/promises';
import path from 'node:path';

// M7-U6 (M7 contract, M7-A11): serves the committed M7 symbols fixture (a source `s1` with
// instances on both pages, one inside a rotated group and one inside a frame, and an empty source)
// to the page with `?fixture=symbols`. It is read at request time from the one shared fixture, so
// the page, the headed spec and the unit tests use the same file; nothing else under `tests/` is
// reachable.
export const dynamic = 'force-dynamic';

const fixturePath = path.resolve(process.cwd(), '../../tests/fixtures/m7-symbols/symbols.v3.json');

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
