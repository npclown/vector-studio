# Vector Studio

An embeddable vector editor SDK for React and Next.js applications, drawn by its own WebGPU graphics engine. This is an **alpha** (`0.1.0-alpha.0`): it is published privately to GitHub Packages for readers of this repository, and its APIs may change without notice.

## Requirements

- A browser with WebGPU: current Chrome or Edge on desktop. There is no fallback renderer.
- A **secure context**: the page must be served over `https://`, or from `http://localhost` / `http://127.0.0.1` on the same machine. A network address over plain `http://` (for example `http://192.168.x.x:3000`) is not a secure context, and the canvas fails with `WebGpuUnavailableError`, whose message says so.
- React 19.2 or later. Next.js works through client components; server-side rendering of the editor is not supported.

## Install

The packages are on GitHub Packages. Add a project `.npmrc` that points the scope at it and authenticates with a GitHub token that has `read:packages`:

```ini
@vector-studio:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Then install the packages a host uses:

```sh
npm install @vector-studio/ui @vector-studio/editor-core @vector-studio/webgpu-host @vector-studio/geometry-wasm @vector-studio/text-dom
```

`@vector-studio/ui` brings `@vector-studio/react`; the renderer, model and contracts packages come as dependencies.

## Use

Create the editor and the renderer on the client, then render the canvas inside the provider:

```tsx
'use client';
import { useMemo } from 'react';
import { createEditor } from '@vector-studio/editor-core';
import { EditorCanvas, EditorProvider } from '@vector-studio/ui';
import { createWebGpuRendererFactory } from '@vector-studio/webgpu-host';
import { geometryKernelUrl } from '@vector-studio/geometry-wasm/kernel';

const createRenderer = createWebGpuRendererFactory({ wasm: geometryKernelUrl });

export function Editor() {
  // EditorOptions (document, extensions, text layout port, ...) are all optional.
  const editor = useMemo(() => createEditor(), []);
  return (
    <EditorProvider editor={editor}>
      <EditorCanvas width={1280} height={800} createRenderer={createRenderer} />
    </EditorProvider>
  );
}
```

`geometryKernelUrl` is resolved by your bundler (Vite, webpack 5 and Next.js emit `kernel.wasm` as an asset). If your bundler does not handle `new URL(..., import.meta.url)`, copy `@vector-studio/geometry-wasm/kernel.wasm` to your public folder and pass its URL instead. The [host API guide](docs/host-api.md) covers editor options, text layout (`@vector-studio/text-dom`), hooks, commands, queries, events, extensions and the UI components; [`apps/next-host`](apps/next-host) is a complete example host.

## Known limitations of this alpha

The editor passed the pre-alpha gate with these misses disclosed ([exit record](docs/evidence/pre-alpha-exit-2026-11-05.md)):

- **Frame time on 10,000-node documents** on the reference PC: typical editing at 16.8 ms (one refresh over the 16.7 ms target), and editing or panning with everything visible at 50 to 67 ms (target 33.3 ms).
- **Pointer latency under load**: the 95th percentile on a busy 10,000-node document is 244 to 483 ms (target under 50 ms).
- **Memory** on the stress document at device pixel ratio 2 is close to the 256 MB ceiling and not verified under it.
- **Lower-tier GPUs** (integrated graphics) are not measured; the user decided no lower-tier check runs before this alpha.
- **Known intermittent bug**: if an autosave write happens while the pointer is held, the drag release can be dropped.
- Geometry precision is UNVERIFIED (A04), with known defect classes disclosed in the P3 exit record.

## Licence

No licence is granted yet (`UNLICENSED`, see [LICENSE](LICENSE)); the licence for a public release is still to be chosen.

## Development

This repository is a pnpm workspace (Node 24.22.1, pnpm 11.1.2). `pnpm install`, `pnpm build` and `pnpm check` build and check it; `pnpm build:kernel` builds the geometry kernel WASM with the pinned Rust 1.94.1. Working rules are in [AGENTS.md](AGENTS.md), the architecture in [ARCHITECTURE.md](ARCHITECTURE.md), and the alpha plan in [docs/plans/alpha-release-plan.md](docs/plans/alpha-release-plan.md).
