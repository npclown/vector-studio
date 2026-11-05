# AR-U4 install check at `99bc708`

Unit AR-U4 of the [alpha release plan](../plans/alpha-release-plan.md) (V-23): the packed alpha packages, installed from tarballs into two fresh apps outside the workspace, render a document and apply one edit. **Verdict: PASS** on the main PC's GPU, in both apps. This record makes no claim beyond the runs below.

## Method

`node tooling/alpha-install-check.mjs` ([script](../../tooling/alpha-install-check.mjs), `pnpm check:alpha-install`) at `99bc708`:

1. `pnpm build`, then `pnpm pack` for each of the eleven packages of `tooling/alpha-packages.mjs`. geometry-wasm's `prepack` builds the kernel with the pinned Rust 1.94.1.
2. For each host it copies a template from `tooling/alpha-install-check/templates/` into a new folder outside the repository, then runs `npm install` with the eleven tarballs and pinned host dependencies. The two hosts are:
   - **Vite**: React 19.2.9, Vite 8.3.6, `@vitejs/plugin-react` 6.2.1.
   - **Next.js**: Next 16.4.3 with a Server Component page that renders the client editor.
   
   Both use the same host component, the root README's usage plus a status line and a `LayerTree`.
3. It type-checks the Vite host with `tsc`: `strict`, `exactOptionalPropertyTypes` and `skipLibCheck: false`. This compiles the packages' published declarations. `next build` type-checks the Next.js host.
4. It builds both hosts and serves each production build on `127.0.0.1` (`vite preview`, `next start`).
5. [`drive.mjs`](../../tooling/alpha-install-check/drive.mjs) opens each page and runs these steps:
   - Waits for the renderer.
   - Draws a red 200 × 150 rectangle at (100, 100) with `createRectangle`.
   - Makes the edit: `nudgeNodes` by (150, 50).
   - Checks the moved frame, exactly one undo step for the edit, one layer-tree row, the kernel WASM served with HTTP 200, and no failed request or page error.
   - With `--channel`, it also counts the red pixels of the presented frame before and after the edit. It reads them through the backend's frame capture, which the host enables with the factory's public `backendOptions` and `afterInitialize` stage.

## Later script changes

Review r1 tightened the script after these runs. The changes:

- The pixel check now requires the move to be (150, 50) times the device pixel ratio, within 1 pixel. It used to check only the direction.
- On a GPU, a backend warning or error diagnostic now fails the check.
- A port that is already in use fails the run.
- `--tgz` must hold exactly the eleven alpha tarballs.
- Windows arguments are quoted.

The GPU values below meet the stricter checks: a (150, 50) move at ratio 1, and no diagnostics.

## Runs

| Run | Machine | Browser | Vite | Next.js |
| --- | --- | --- | --- | --- |
| GPU (counted) | Main PC DESKTOP-DKVUSAV, NVIDIA GeForce GTX 1660 SUPER, Node 24.22.1, npm 11.7.0 | Chrome 156.0.8078.81, headed (`--channel chrome`) | PASS, pixels required | PASS, pixels required |
| Container | Cloud Linux container, Node 22.23.4, npm 10.9.9 | Chrome for Testing 153.0.8010.12, headless SwiftShader | PASS, pixels not checked | PASS, pixels not checked |

### GPU run

The two hosts gave the same values:

- **Renderer:** `ready`, with no backend diagnostics, no page errors and no failures.
- **Create:** `createRectangle` returned ok, and the undo depth went to 1. The edit, `nudgeNodes`, returned ok. The frame is now `{x: 250, y: 150, width: 200, height: 150}`, and the undo depth went to 2, so the edit is one undo step. The layer tree shows the rectangle once.
- **Presented pixels:** 29,997 red pixels before the edit, in the box [100, 100, 299, 249] of the 800 × 600 frame. After the edit, 29,997 red pixels in the box [250, 150, 449, 299]. The rectangle moved exactly (150, 50) device pixels at zoom 1 and device pixel ratio 1.
- **Screenshots:** read on the PC, they show the red rectangle at (100, 100) before the edit and at (250, 150) after it, the same in both hosts.
- **Kernel WASM:** served as a bundler asset with HTTP 200. Vite served it as `/assets/kernel-bb454Vbc.wasm` and Next.js as `/_next/static/media/kernel.2b07_tlx0ektd.wasm`.
- **Packing:** all eleven tarballs were packed on the PC. The `package/dist/kernel.wasm` in geometry-wasm's tarball has SHA-256 `58f26517603d0d599f187481c967832e3f6abea2eb53c738e5540b6200b4fd35` (493,724 bytes), the SHA the alpha plan records.

Departures on the PC:

- The main checkout had untracked files, so the run used a temporary detached worktree at `99bc708`, removed afterwards.
- `CARGO_HOME` and `RUSTUP_HOME` pointed at the main checkout's `.tools/rust`.

The results are in `%TEMP%\vector-studio-alpha-aru4` on the PC.

### Container run

Everything except pixels passed in both hosts, with the same document, history, layer-tree and WASM values as the GPU run. SwiftShader WebGPU is not usable in the container: a bare `requestDevice()` on a blank localhost page is lost as `destroyed` within two seconds. The renderer reports `ready` and the backend then fails, so the presented pixels are reported as not checked. The m1 next-host spec skips pixels on SwiftShader for the same reason.

## Not covered

- Edge, other GPUs (integrated graphics stays unmeasured by the user's 2026-11-05 decision) and device pixel ratios other than 1.
- Dev servers (`vite`, `next dev`): the script checks production builds only. AR-U2's review checked the dev servers' asset handling.
- Installing from GitHub Packages. That is AR-U5, after the user's go-ahead, and needs the scope decision AR-Q4.
- Text layout (`@vector-studio/text-dom`) and persistence (`@vector-studio/persistence-idb`). They were installed but not exercised.
