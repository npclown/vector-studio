import { readFile } from 'node:fs/promises';
import path from 'node:path';

// M6b-U9 (M6b contract, M6b-A12 and A13): serves the committed M6b edit fixture (`t` "ab cd",
// the node the synthetic IME traces start in; `w`, wrapped Hangul and Latin lines with an LF and
// an empty line; `r`, a rotated node) to the page with `?fixture=text-edit`. It is read at request
// time from the one shared fixture, so the page, the headed spec and the unit tests use the same
// file; nothing else under `tests/` is reachable.
export const dynamic = 'force-dynamic';

const fixturePath = path.resolve(process.cwd(), '../../tests/fixtures/m6-text/edit-host.v6.json');

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
