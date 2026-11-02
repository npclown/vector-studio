// V-20 contract, V20-U1: a package-internal render probe for the bench. The E26 bench page
// (`?bench=1` only, M9-A03's rule) installs `globalThis.__vsRenderProbe`; each counted component
// calls `countRender` in its render. Without the bench the global is absent and the call does
// nothing. Not exported from the package entry, so it is no part of the public API.

type RenderProbe = (id: string) => void;

/** Reports one render of `id` to the bench's probe, if one is installed. */
export function countRender(id: string): void {
  (globalThis as { __vsRenderProbe?: RenderProbe }).__vsRenderProbe?.(id);
}
