import { readFile } from 'node:fs/promises';
import path from 'node:path';

// E26-U1b (E26 contract, section 3.3): the bench loader's documents, `?doc=m1-a13` or
// `?doc=stress`, read at request time from `.tools/e26/docs/`, where the headed harness (U1c)
// writes them from `tests/e26/scenarios.ts` before a run; nothing else is reachable. A missing
// document is a 404, so the page reports the error instead of loading something else.
export const dynamic = 'force-dynamic';

const directory = path.resolve(process.cwd(), '../../.tools/e26/docs');
const DOCUMENTS = new Set(['m1-a13', 'stress']);

export async function GET(request: Request): Promise<Response> {
  const doc = new URL(request.url).searchParams.get('doc');
  if (doc === null || !DOCUMENTS.has(doc)) return new Response('Not found', { status: 404 });
  try {
    const text = await readFile(
      /*turbopackIgnore: true*/ path.join(directory, `${doc}.json`),
      'utf8',
    );
    return new Response(text, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
