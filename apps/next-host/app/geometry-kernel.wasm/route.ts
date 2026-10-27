import { readFile } from 'node:fs/promises';
import path from 'node:path';

// P5-U6: serves the geometry kernel WASM from the local build, never from a committed binary,
// as the playground's dev server does. VECTOR_STUDIO_GEOMETRY_WASM overrides the default
// `pnpm test:geometry` output path.
export const dynamic = 'force-dynamic';

const defaultPath = path.resolve(
  process.cwd(),
  '../../.tools/geometry-build/wasm32-unknown-unknown/release/vector_studio_geometry_kernel.wasm',
);

export async function GET(): Promise<Response> {
  const wasmPath = process.env.VECTOR_STUDIO_GEOMETRY_WASM ?? defaultPath;
  try {
    // The kernel lives outside the app; only this route reads it, at request time.
    const bytes = await readFile(/*turbopackIgnore: true*/ wasmPath);
    return new Response(new Uint8Array(bytes), {
      headers: { 'Content-Type': 'application/wasm', 'Cache-Control': 'no-store' },
    });
  } catch {
    return new Response(`Geometry kernel WASM not found at ${wasmPath}`, { status: 404 });
  }
}
