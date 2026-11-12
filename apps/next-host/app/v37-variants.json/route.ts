import { readFile } from 'node:fs/promises';
import path from 'node:path';

// V-37 (V37-A13): serves the committed next-host fixture of the variants spec (three symbols
// `sA`, `sB` and `sC` of one rectangle each, and an instance `inst` of `sA`) to the page with
// `?fixture=v37-variants`. It is read at request time from the one shared fixture, so the page,
// the headed spec and the unit tests use the same file; nothing else under `tests/` is reachable.
export const dynamic = 'force-dynamic';

const fixturePath = path.resolve(
  process.cwd(),
  '../../tests/fixtures/v37-variants/next-host.v8.json',
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
