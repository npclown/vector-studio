import { readFile } from 'node:fs/promises';
import path from 'node:path';

// M6a-U5 (M6a contract, section 5, M6a-A11): serves the committed M6a text fixture (three sizing
// modes and alignments, runs with LF, Hangul and a ZWJ emoji, an empty node, text in a group and
// a frame, sizes 0.5 and 4096) to the page with `?fixture=text`. It is read at request time from
// the one shared fixture, so the page, the headed spec and the unit tests use the same file;
// nothing else under `tests/` is reachable.
export const dynamic = 'force-dynamic';

const fixturePath = path.resolve(process.cwd(), '../../tests/fixtures/m6-text/text.v4.json');

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
