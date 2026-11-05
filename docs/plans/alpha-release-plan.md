# Alpha release plan (npm package)

Status: DRAFT 2026-11-05. Visualization-track item [V-23](d9-visualization-track.md#status-index), Full tier (new distribution form, package metadata, product scope of the first deliverable). Answers the pre-alpha plan's open question [PA-Q8](pre-alpha-gate-plan.md#8-open-questions): the alpha is a private package set on GitHub Packages (AR-Q1 (a)).

Owners: this file owns what the alpha is, the packaging work before it and the publish step. [`requirements.md`](../requirements.md) owns product behavior; [`prototype-plan.md`](../prototype-plan.md) owns the lower-tier constraint (see section 2); [`ARCHITECTURE.md`](../../ARCHITECTURE.md) and its ADRs own package boundaries, which AR-U1 changes; [`host-api.md`](../host-api.md) owns the host how-to, which AR-U1 and AR-U2 update.

**Fit with requirements.** [`requirements.md`](../requirements.md) says the first deliverable is "an in-repository prototype, not a production application or public package". A private package set readable only by repository readers (AR-Q1 (a)) is still not a public package, so that sentence is unchanged. A public release (AR-Q1 (b)) would need a requirements change first.

## 1. Where the repository stands (checked at `ac7354c`)

The editor passed the pre-alpha gate with disclosed misses ([exit record](../evidence/pre-alpha-exit-2026-11-05.md)). It runs as the in-repository next-host app. It is not installable as a package:

| Blocker | Detail |
| --- | --- |
| B1 private packages | All 13 workspace packages are `"private": true`, version `0.0.0`, with no `license`, `files`, `repository` or `publishConfig`. The repository has no LICENSE or README. |
| B2 renderer lives in the app | `createWebGpuRenderer` (the WebGPU renderer composition a host passes to `EditorCanvas`) is in `apps/next-host/src/webgpu-renderer.ts`, mixed with test and bench hooks. A host installing the packages cannot draw the canvas. |
| B3 WASM not packaged | The geometry kernel `.wasm` is built by Rust 1.94.1 into `.tools/geometry-build/` and served by a next-host route (the playground's Vite config serves it too). No package ships it. |
| B4 package set | A host imports `ui`, `react` or `editor-core` (closure: `contracts`, `model`), and its composition also needs `renderer-core`, `renderer-webgpu`, `geometry-wasm`, `text-dom` and `persistence-idb` to draw, lay out text and save. All of them must be published (or bundled); `geometry-reference` is a test oracle and is not. |
| B5 no install check | The `tsc` `dist` output has never been installed from a tarball into a fresh Next.js app. |

## 2. Recorded user decisions

- 2026-11-05 13:43Z, by the user: no lower-tier (integrated GPU) check before the alpha release. This closes [prototype-plan](../prototype-plan.md) constraint 2 ("a lower-tier GPU gate is added before alpha distribution") for the alpha by user decision, not by evidence; it follows the 2026-11-04 21:43Z decision that waived PA-A08. Lower-tier hardware stays unmeasured and is disclosed in the alpha README.
- 2026-11-05 13:57Z, by the user on a decision card: AR-Q1 (a), the alpha is published to GitHub Packages, private to repository readers. No licence choice is needed for it (AR-Q3 stays open for a later public release).

## 3. Units

| Unit | Work | Tier |
| --- | --- | --- |
| AR-U1 | Move the renderer composition into a new host-composition package `@vector-studio/webgpu-host` as a public factory with a `wasmUrl` (or `wasmModule`) option; next-host keeps its test and bench wrappers around it. It must not go into `renderer-webgpu`: the composition imports `geometry-wasm` (ports) and `react` (`RendererFactory`), and ARCHITECTURE.md forbids renderer packages from importing `geometry-wasm` (enforced by `check:boundaries` and `tests/unit/fill-port-boundaries.test.ts`). The unit adds an ADR and the ARCHITECTURE.md entry for the new package as a host composition root, and updates `host-api.md`. | Full (public surface, package boundaries) |
| AR-U2 | Ship the kernel `.wasm` in `@vector-studio/geometry-wasm` `dist/` with a reproducible build step and its SHA-256 recorded; document how a Next.js host serves or imports it. | Full |
| AR-U3 | Package metadata on the published packages: version `0.1.0-alpha.0`, `files`, `license`, `repository`, `sideEffects`, `publishConfig`; LICENSE and README with the disclosed misses, the unmeasured lower-tier hardware and the known autosave drag-release bug; the package scope per AR-Q4. | Full |
| AR-U4 | Install check: `pnpm pack` every published package, install the tarballs into a fresh Next.js app outside the workspace, render a document and run one edit; record it in `docs/evidence/`. | Light |
| AR-U5 | Publish with the `alpha` dist-tag to the registry chosen in AR-Q1. **Only after the user's explicit go-ahead**: publishing is outward-facing and, on the public npm registry, cannot be freely undone after 72 hours. | Full |

## 4. Open questions

| ID | Question | Options |
| --- | --- | --- |
| AR-Q1 | Where is the alpha published? **Decided 2026-11-05: (a).** | (a) GitHub Packages, private to repository readers; no licence choice needed yet. (b) Public npm with the `alpha` tag; needs a licence. (c) Tarballs handed over directly. **Recommended (a)**: reversible, and the alpha carries disclosed performance misses. |
| AR-Q2 | Many packages or one bundled package? | (a) Publish the packages as they are with one version: `contracts`, `model`, `editor-core`, `react`, `ui`, `renderer-core`, `renderer-webgpu`, `geometry-wasm`, `text-dom`, `persistence-idb` and AR-U1's `webgpu-host` (not `geometry-reference`). (b) One `@vector-studio/editor` bundle. **Recommended (a)**: keeps the boundaries the repository checks; revisit after the alpha. |
| AR-Q3 | Licence. **User decides** (needed for AR-Q1 (b) only). | — |
| AR-Q4 | Which npm scope? GitHub Packages only accepts a scope equal to the owning user or organization, and the repository is `npclown/vector-studio` while every package is `@vector-studio/*`. | (a) Rename the scope to `@npclown/*` (imports, boundary checker, docs). (b) Move the repository to a GitHub organization named `vector-studio`, if the name is free, and keep the names. **Recommended (b)** if the organization can be created, since the names then also fit a later public release; otherwise (a). **User decides** before AR-U3. |
