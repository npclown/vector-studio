import { readFile } from 'node:fs/promises';
import path from 'node:path';

// M6a-U5 (M6a contract, section 5, M6a-Q13 (a)): serves the committed test font, a Hangul and
// Latin subset of Noto Sans KR 2.004 (OFL 1.1, its license beside it), which the page registers
// with `?fixture=text` and the test hook on request. Only this one approved file is reachable;
// it is read at request time, so the page and the unit tests use the same bytes.
export const dynamic = 'force-dynamic';

const fontPath = path.resolve(
  process.cwd(),
  '../../tests/fixtures/m6-text/fonts/NotoSansKR-Regular-subset.otf',
);

export async function GET(): Promise<Response> {
  try {
    const bytes = await readFile(/*turbopackIgnore: true*/ fontPath);
    return new Response(new Uint8Array(bytes), {
      headers: { 'Content-Type': 'font/otf', 'Cache-Control': 'no-store' },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
