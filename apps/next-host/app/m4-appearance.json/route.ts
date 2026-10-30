import { readFile } from 'node:fs/promises';
import path from 'node:path';

// M4-U4 (M4 contract, M4-A12): serves the committed M4 host fixture (H1 to H9: E23's G1 to G3,
// E24's D3 stroke on a rectangle and D1 on a line, the dashed arrow line H6, and E25's O1, O5 and
// O4 as a group, a mask group and a rotated frame, on two pages) to the page with
// `?fixture=appearance`. It is read at request time from the one shared fixture, so the page, the
// headed spec and the unit tests use the same file; nothing else under `tests/` is reachable.
export const dynamic = 'force-dynamic';

const fixturePath = path.resolve(process.cwd(), '../../tests/fixtures/m4-appearance/host.v6.json');

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
