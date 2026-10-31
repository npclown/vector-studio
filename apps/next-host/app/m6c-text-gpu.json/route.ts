import { readFile } from 'node:fs/promises';
import path from 'node:path';

// M6c-U2 (M6c contract, section 5): serves the committed M6c GPU text fixture (page `agreement`:
// the section 6.2 agreement fixtures over a white backdrop; page `scene`: the M6c-A05 scene of
// paint order, a frame clip, a mask group, a translucent group, a rotated node and an instance
// with and without a text override) to the page with `?fixture=text-gpu`. It is read at request
// time from the one shared fixture, so the page, the headed specs and the unit tests use the same
// file; nothing else under `tests/` is reachable.
export const dynamic = 'force-dynamic';

const fixturePath = path.resolve(
  process.cwd(),
  '../../tests/fixtures/m6-text/gpu/text-gpu.v6.json',
);

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
