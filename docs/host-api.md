# Host API guide

This guide shows how a host application embeds the editor: it creates an editor, provides it to React, reads state through hooks, sends commands, runs queries, listens to events, registers extensions and composes the UI package. It owns the order and the how-to; the type declarations linked from each section are the source of truth for every name, field and union, and this guide copies none of them. Product behavior is in [`requirements.md`](requirements.md#sdk-model), package boundaries in [`ARCHITECTURE.md`](../ARCHITECTURE.md#dependency-direction), and the M8 public surface in the [M8 contract](plans/mvp-m8-host-api-ui-contract.md).

The packages a host uses:

| Package | Use | Entry |
| --- | --- | --- |
| `@vector-studio/editor-core` | The framework-free editor: documents, commands, queries, events, extensions. Re-exports every `model` and `contracts` type of its API (M8-T1). | [`src/index.ts`](../packages/editor-core/src/index.ts) |
| `@vector-studio/react` | The React bindings: provider, hooks and `EditorCanvas`. Re-exports every type of `editor-core` and the `extensionCommand` builder (M8-T2). | [`src/index.ts`](../packages/react/src/index.ts) |
| `@vector-studio/ui` | The minimal editor UI: toolbar rows, page list, layer tree, property panel and extension panels. Re-exports everything `react` exports (M8-T2). | [`src/index.ts`](../packages/ui/src/index.ts) |

A host that uses the UI package imports `@vector-studio/ui` alone for its React code; one that builds its own UI imports `@vector-studio/react`. Both entries are `'use client'` modules (M8-H5), so a Next.js Server Component may import them and render their components, but cannot call their functions on the server; server code that needs an editor-core value imports `@vector-studio/editor-core`.

## Creating an editor

`createEditor(options)` returns an `Editor`; see `EditorOptions` in [`editor.ts`](../packages/editor-core/src/editor.ts) and the `Editor` interface in [`types.ts`](../packages/editor-core/src/types.ts). The options give the initial document, the ID source, the extensions, extra key bindings, the platform (which resolves `Mod` in key bindings), the optional text layout port (for example `createTextDom` from `@vector-studio/text-dom`) and the text tool style.

Create the editor on the client, outside render: next-host does it in a client effect together with its text-dom port and disposes the port in the effect's cleanup ([`m6a-text-host.ts`](../apps/next-host/src/m6a-text-host.ts)). The document lives in the editor; renderers and WASM handles are caches that can be rebuilt (requirements, SDK model).

## The provider and the canvas

Wrap the editor UI in `EditorProvider` with the editor; every hook and UI component reads the nearest provider ([`context.tsx`](../packages/react/src/context.tsx)). `EditorCanvas` draws the editor through a renderer the host creates in `createRenderer` and forwards pointer, keyboard, clipboard and text input to the editor ([`canvas.tsx`](../packages/react/src/canvas.tsx)). The host owns the renderer choice. The editor's WebGPU renderer is `createWebGpuRendererFactory({ wasm })` from `@vector-studio/webgpu-host` ([`src/index.ts`](../packages/webgpu-host/src/index.ts), [ADR 0004](decisions/0004-packaged-webgpu-host-composition.md)): `wasm` is the geometry kernel's URL, bytes or a loader. The kernel ships in `@vector-studio/geometry-wasm` as `dist/kernel.wasm`; `import { geometryKernelUrl } from '@vector-studio/geometry-wasm/kernel'` gives its URL through `new URL(..., import.meta.url)`, which Vite 8 and Next.js 16 (webpack and Turbopack) were checked to emit as an asset, so `createWebGpuRendererFactory({ wasm: geometryKernelUrl })` needs no server route. Import it in client code (next to the factory call): a `URL` cannot pass from a Server Component as a prop, and its server-side value differs from the client's. A host whose bundler does not follow that pattern copies `@vector-studio/geometry-wasm/kernel.wasm` to its public folder and passes that URL. Call the returned factory only on the client. If WebGPU is unavailable it throws `WebGpuUnavailableError`, whose message says what to do (for example open the page over https:// or from localhost, since a plain-http network address is not a secure context); the canvas reports it through `onRendererError`. next-host adds its test and bench hooks through the factory's stages ([`webgpu-renderer.ts`](../apps/next-host/src/webgpu-renderer.ts)).

Focus leaving the canvas ends text edit mode, except for focus moving to the property panel's text run fields, which edit the text edit selection. The canvas and those fields recognize each other through a `data-text-edit-focus` attribute: an internal marker between `react` and `ui`, not an API for host controls. It is page-wide, so a page holds one editor.

## Hooks

The hooks are in [`context.tsx`](../packages/react/src/context.tsx) and [`hooks.ts`](../packages/react/src/hooks.ts):

- `useEditor` returns the editor, and `useEditorCommands` its `execute`.
- `useEditorSelector(selector, isEqual?)` reads a part of the snapshot. The selector must be pure; with `isEqual` a fresh array or object keeps its previous reference while equal (M8-H2).
- `useSelection`, `useActivePage`, `usePages`, `useTool`, `useHistory`, `useSnapping`, `useViewport`, `useScope` and `useNode(id)` read one field of the snapshot each (M8-H1).
- `useEditorQuery(query, isEqual?)` re-reads a query after each editor event, for queries whose result changes without a new snapshot (for example `textEditOverlay` after a font loads) (M8-H3).

A hook's value is stable between unrelated changes, so a component re-renders only when its part changes.

## Commands and queries

Every edit is a command sent through `execute` (or `useEditorCommands`): the `Command` union, with `DocumentCommand` (one undo step each) and `SessionCommand` (selection, tool, viewport and other session state, never in history), is in [`types.ts`](../packages/editor-core/src/types.ts). The result is a `CommandResult`: `ok` with the IDs it created or touched, or a refusal with an `EditorErrorCode` and a path. A UI shows a refusal's code and leaves the document as it was.

`query` answers read-only questions: the `Query` union and `QueryResult` in the same file list them, from `document` and `node` to `handles`, `pathOverlay`, `textEditOverlay`, `snap`, `keymap` and `extensions`. A query never changes state or raises an event.

## Events

`subscribe(listener)` calls the listener after each change with an `EditorEvent` (document changes with their cause, session changes, diagnostics) and returns the function that unsubscribes; `getSnapshot()` returns the immutable snapshot the hooks read ([`types.ts`](../packages/editor-core/src/types.ts)). A host logs or reacts to events; it never mutates the document outside a command.

## Extensions

An `Extension` ([`types.ts`](../packages/editor-core/src/types.ts)) is registered with `createEditor` and contributes, each under its own ID:

- **Node types**: a `CustomNodeType` with its validator, defaults and scene projection; documents store it as a `custom` node.
- **Commands**: an `ExtensionCommand` run by `runCommand` with JSON arguments, through the `ExtensionApi` it receives (public commands and queries only). `extensionCommand<Args>(id)` builds a typed `runCommand` ([`extension-command.ts`](../packages/editor-core/src/extension-command.ts)); `run` still validates its arguments.
- **Tools**: an `ExtensionTool` that `setTool` activates by ID; the UI toolbar lists it after the built-in tools.
- **Bindings**: `KeyBinding`s layered over the default keymap.

The sample is `starExtension` ([`star.ts`](../packages/editor-core/src/star.ts)): the `ext.star` node type and the `ext.star.create` command, whose arguments are `StarCreateArgs`. The `extensions` query lists every registered extension's IDs (M8-X1).

### Panels

An extension's UI half is a `UiExtension` with `PanelContribution`s ([`panel-resolve.ts`](../packages/ui/src/panel-resolve.ts)). The host passes them to `PanelProvider`, which checks each panel against the `extensions` query (its owner registered, its ID the owner's ID or under it, no duplicate), and `EditorPanels` renders the accepted panels, each inside its own error boundary ([`panels.tsx`](../packages/ui/src/panels.tsx)). A panel component takes no props and uses the hooks only; `usePanelErrors` and `onPanelError` report rejected and failed panels. A panel's open or collapsed state is React state, never document or history.

next-host's sample is the `ext.star` panel ([`m8-star-panel.tsx`](../apps/next-host/src/m8-star-panel.tsx)), which imports `@vector-studio/ui` and `react` only.

## The UI package

`@vector-studio/ui` ([`index.ts`](../packages/ui/src/index.ts)) gives the components next-host composes ([`page.tsx`](../apps/next-host/app/page.tsx), [`m8-layout.tsx`](../apps/next-host/src/m8-layout.tsx)):

- `ToolbarPrimaryRow` (tools and edit actions) and `ToolbarSecondaryRow` (zoom and symbols), each a row that takes host controls as `children` ([`toolbar.tsx`](../packages/ui/src/toolbar.tsx)).
- `PageList` and `LayerTree` ([`layers.tsx`](../packages/ui/src/layers.tsx)).
- `PropertyPanel`, which holds `AppearancePanel` and `PropertySections` ([`property-panel.tsx`](../packages/ui/src/property-panel.tsx), [`appearance-panel.tsx`](../packages/ui/src/appearance-panel.tsx)).
- `PanelProvider`, `EditorPanels` and `usePanelErrors` (section above).
- V-25 ([plan](plans/viz-v25-editor-ui-plan.md)): `EditorToolbar`, one row of icon buttons with the same tools, actions, enable rules and test IDs as the two M8 rows, each named with its shortcut from the `keymap` query, and host controls as `children`; and `ZoomMenu`, a button showing the zoom that opens zoom in, out, fit, selection and 100% ([`editor-toolbar.tsx`](../packages/ui/src/editor-toolbar.tsx)). They carry `vs-*` class names and no colours, so the host styles them. `LayerTree` takes an optional `height` (default 240 px); with `'100%'` its parent needs a definite height. next-host's full-window studio layout composes them ([`v25-studio.tsx`](../apps/next-host/src/v25-studio.tsx)).

Each control sends one public command per committed edit and shows a refusal's code; the components hold no editor internals, so a host can replace any of them with its own built on the same hooks. The package imports `@vector-studio/react` and `react` only, which `pnpm check:boundaries` enforces (M8-B3).
