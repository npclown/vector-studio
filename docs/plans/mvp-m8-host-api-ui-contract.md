# MVP M8 contract: host API and minimal UI

Status: APPROVED 2026-11-01 (#437, `24564c0`); independent review r1 NOT READY (B1 to B3, should-fix 1 to 10, nits), applied; r2 NOT READY (B1, B2), applied; r3 READY WITH FOLLOW-UPS, applied. M8-Q1 to M8-Q14 adopted as (a) (추천안 자동 채택 2026-11-01). Full tier (public API of `editor-core` and `react`, a new package and boundary-policy entry, product behavior of the panels). Visualization-track item V-18 in the [track status index](d9-visualization-track.md#status-index), milestone M8 of the [MVP editor plan](mvp-editor-plan.md#m8-host-api-and-minimal-ui). The user accepted the M6 exit ([exit record](../evidence/m6-exit-2026-11-01.md)) on 2026-11-01 at 08:54Z, recorded by status PR #436. Open questions M8-Q1 to M8-Q14 are in section 13.

Owners: this file owns M8 scope; the public type surface of `editor-core`, `react` and `ui` (section 2); the new hooks (section 3); the `extensions` query and typed extension commands (section 4); the `@vector-studio/ui` package, its boundary-policy entry and its public-import check (section 5); panel contributions (section 6); the toolbar, layer panel and property panel (section 7); the next-host composition changes and layout budget (section 8); the host API guide (section 9); acceptance criteria M8-A01 to M8-A15 and the units. Product behavior stays in [`requirements.md`](../requirements.md#sdk-model) (SDK model, Editing behavior, Extension direction), which this contract does not change; package boundaries in [`ARCHITECTURE.md`](../../ARCHITECTURE.md#dependency-direction) (`ui -> react`); the P5 and M1 to M7 rules stay in force except as section 1.3 lists. No shared surface under D9 changes (`packages/contracts` is untouched).

## 1. Scope

In scope: type re-exports so a consumer of `@vector-studio/react` alone can name every type of the public API, and one value re-export, the `extensionCommand` builder (M8-T2); named hooks for selection, active page, pages, tool, history, snapping, viewport, scope, a node, and a query; an equality option for `useEditorSelector`; an additive `extensions` query; the new package `@vector-studio/ui` (imports `@vector-studio/react` and the `react` npm package only) with a toolbar, a layer panel (pages and the node tree), a property panel (the M4 appearance panel moved, plus transform, layer, line, constraint, text and symbol fields) and panel contributions from host-registered extensions; next-host composed from the UI package, with a sample extension panel and the toolbar width fix; a host API guide; a headed next-host spec.

Out of scope: drag and drop in the layer panel (M8-Q7); adopting nodes into a frame on drop (M2-Q10, backlog); a collapsed-caret typing style (M8-Q9); multi-node forms of `setNodeProps`, `setTextProps` and `setTextStyle` (section 7); the selection, snap, path and text overlays, which stay in next-host (M8-Q12); restoring panel state (requirements, Persistence); theming, icons, localization and accessibility beyond roles and names; a published npm package (requirements, Product goal); any schema, renderer or `contracts` change; any change to the `?bench=1` layout (M8-N5); performance claims (M9).

### 1.1 Starting point (main at 17a2b0a)

- **editor-core.** The entry exports `createEditor`, `ZOOM_MIN`, `ZOOM_MAX`, `DEFAULT_KEYMAP`, `eventChord`, four `DEFAULT_*` paints, `createCounterIdSource`, `starExtension` and `export type * from './types.js'` (`packages/editor-core/src/index.ts:1-11`). `types.ts` imports 17 `model` types (`DocumentV6`, `NodeV6`, `PageV2`, `Paint`, `Stroke`, `TextRun`, …) and 5 `contracts` types (`RenderCamera`, `TextLayoutResult`, …) without re-exporting them (`types.ts:1-26`); `EditorOptions` names `TextLayoutPort` (`editor.ts:140-162`). A consumer that sees only `editor-core` cannot name `NodeV6`, `Paint` or `RenderCamera`. `runCommand` takes `id: string; args?: JsonValue` and is untyped (`types.ts:576`). No query lists registered extensions, tools or commands (`Query`, `types.ts:676-724`); `Extension` has `nodeTypes`, `commands`, `tools` and `bindings` and no UI field (`types.ts:917-928`). `setNodeProps`, `setTextProps` and `setTextStyle` take one node ID; `setStyle` takes several (`types.ts:269-496`).
- **react.** Exports `EditorProvider`, `useEditor`, `useEditorSelector`, `useEditorCommands`, `EditorCanvas` and the renderer handle types (`packages/react/src/index.ts`). `useEditorSelector` calls the selector on every read (`context.tsx:34-42`), so a selector returning a new array or object each time breaks `useSyncExternalStore`; next-host works around it by joining node types into one string (`apps/next-host/app/page.tsx:499-502`). No module of `packages/react` carries `'use client'` (next-host's `page.tsx:1` and `m4-appearance-panel.tsx:1` do). Unit tests render with `react-dom/server` in Node (`tests/unit/p5-react.test.ts`); no DOM test environment is installed.
- **next-host.** The page defines its own `Toolbar` (built-in tools only, `TOOLS` at `page.tsx:109`; star with frame `{ x: 360, y: 220, width: 160, height: 160 }`, group, mask, ungroup, undo, redo, delete, toggle closed, then file and zoom controls; `page.tsx:290-397`), `FileControls` (`404`), `ZoomControls` (`459`), `SymbolControls` (`496`), `Pages` (`541`, one button per page inside `data-testid="pages"`) and `Status` (`562`); row 2 holds `Pages` and `SymbolControls`, row 3 the canvas and the 300 px Appearance panel (`m4-appearance-panel.tsx:519`, `maxHeight` 640), so the canvas row is about 960 + 8 + 300 CSS px: the body margin is 0 (`app/layout.tsx:8`), `canvas-host` is 960 px wide and the canvas's 2 px border spills outside it; U6 measures the exact width. The M4 panel is next-host code that imports `model` types (`m4-appearance-panel.tsx:4`, landmark `complementary` named "Appearance" at `516`; pure helpers in `src/m4-appearance.ts`). There is no layer panel. The toolbar row is about 1302 CSS px wide ([M6b exit, follow-up 9](../evidence/m6b-exit-2026-10-30.md#follow-ups)). With `?bench=1` the canvas is 1280 × 720 (`src/e26-bench.ts:65`) in a 1400 × 1000 viewport (`playwright.e26.config.ts`).
- **Spec viewports.** P5 and M1 run at 1280 × 720 (the device presets override the M1 config's 1100 × 800, M6b exit `:87`); M2 to M7 configs state 1280 × 900.
- **Boundaries.** `tooling/boundary-policy.mjs` has no `ui` entry; `react -> contracts, editor-core` (`:11`); `externalDenied` denies `next` in `react` (`:55-64`); `packageDirectories` lists twelve directories (`:66`). ARCHITECTURE reserves `ui -> react` (`ARCHITECTURE.md:102`) and says the minimal UI "must use the same public contracts available to a host application" (`:82`).

### 1.2 Inherited items and follow-ups

| Source | Item | Disposition |
| --- | --- | --- |
| [M6b exit, follow-up 9](../evidence/m6b-exit-2026-10-30.md#follow-ups); M6c section 1.3 | Toolbar width under 1280 px; M1 headed config viewport per project; smoke runs with scrollbars | M8-U6 and A12 (M8-N3, M8-Q10) |
| M6b exit, follow-up 10; M6c section 1 | Text style panel; collapsed-caret typing style | Style panel in M8-U5 (A11); typing style backlog (M8-Q9) |
| [M4 contract, section 8](mvp-m4-appearance-contract.md); M4 exit | The appearance panel moves to the UI package; the canvas origin kept for earlier specs (M4-U4 note 2) | M8-U5 (A11), behavior unchanged; origin invariant M8-N3 |
| [M7 exit](../evidence/m7-exit-2026-10-30.md), deferred scope | Property-panel symbol controls | M8-U5 (A11) |
| `page.tsx:68` | The toolbar lists built-in tools only | Toolbar also lists extension tools (M8-L1) |
| `page.tsx:499-502` | String-join selector workaround | `useEditorSelector` equality option (M8-H2) |
| MVP plan, M8: "hooks for … panels" | Panel hooks | `PanelProvider`, `EditorPanels` and `usePanelErrors` in `ui` (section 6) over the `extensions` query |
| M2-Q10; M2 exit | Adopt nodes into a frame on drop | Backlog, not M8 |

### 1.3 Changes to earlier rules

- M4 section 8: the panel and its helpers move from next-host to `@vector-studio/ui`; every M4 panel rule (one `setStyle` per commit, Enter and blur commit, mixed values, no live preview) is kept, and `tests/unit/m4-u4-next-host.test.ts` follows the moved helpers unchanged in its expectations.
- P5, M1 to M7 headed specs: the next-host layout keeps the canvas origin (M8-N3); a spec changes only where a measured control position moved, each change listed in the U6 notes (M8-Q11).

## 2. Public type surface

- **M8-T1 editor-core reach.** The *reach* of a package entry is the set of named, exported declarations found by following, from every export of its built `dist/index.d.ts`, each type reference (aliases, interfaces and their members, unions, generic arguments, `typeof` queries) into declaration files of workspace packages; declarations under other `node_modules` (for example `@types/react`) are not followed. `editor-core` re-exports, type only, every `model` and `contracts` type in its reach, with names unchanged; the probe at 17a2b0a finds about 84 such names, including legacy names reached through alias chains (`PageV1` to `PageV5`, `InstanceNodeV5`, `NodeBaseV2`, `GroupNode`; M8-Q2). A value reached only through `typeof` (for example `DOCUMENT_ERROR_CODES` behind `DocumentErrorCode`) is not re-exported: its derived alias is. No other `model` or `contracts` value is re-exported.
- **M8-T2 react and ui re-exports.** `react` re-exports every type export of `editor-core` and one value, `extensionCommand` (M8-X2), a pure builder with no state, so an extension's UI can type its commands through the public chain without importing `editor-core`; `react -> editor-core, contracts` is unchanged (MVP plan, M8). `ui` re-exports everything `react` exports (`export * from '@vector-studio/react'`), so an extension panel imports `ui` alone (M8-N2).
- **M8-T3 check.** A type-level test compiles a consumer fixture that imports only `@vector-studio/react` (and a second that imports only `@vector-studio/ui`) and names every type in the reach of that entry, computed by the TypeScript compiler API from the built declarations, not written by hand; a reached name the fixture cannot import fails the test.

## 3. React hooks

- **M8-H1 named hooks.** `useSelection()`, `useActivePage()`, `useTool()`, `useHistory()`, `useSnapping()`, `useViewport()`, `useScope()` return that snapshot field; `usePages()` returns `snapshot.document.pages`; `useNode(id)` returns `snapshot.document.nodes[id] ?? null`. Each is a `useEditorSelector` over a part of the snapshot, so it is stable between changes.
- **M8-H2 equality.** `useEditorSelector(selector, isEqual?)` keeps its current result while `isEqual(previous, next)` holds (default `Object.is`, the current behavior); the result is recomputed only when the snapshot object changes.
- **M8-H3 queries.** `useEditorQuery(query, isEqual?)` re-reads `editor.query(query)` after each editor event and keeps the previous value while equal. The default equality is structural only for `handles`, `pathOverlay`, `textEditOverlay`, `snap` and `extensions`; for every other query it is `Object.is`, since a structural compare of document-sized results (`document`, `textLayout`) costs as much as the change.
- **M8-H4 store adapters.** Each hook is a thin wrapper over a `subscribe` and `getSnapshot` pair built by an internal adapter, which unit tests drive directly with a real editor (M8-Q5 (a)).
- **M8-H5 client modules.** The entry modules of `react` and `ui` begin with `'use client'`, so a Next.js server component can import them (requirements, SDK model); the built `dist/index.js` keeps the directive.

## 4. Extensions query and typed commands

- **M8-X1 query.** `query({ type: 'extensions' })` returns a frozen list sorted by extension ID of `{ id, nodeTypes, commands, tools, bindings }`, each the sorted IDs or chords the extension registered. It raises no event and is constant for the editor's lifetime.
- **M8-X2 typed commands.** `editor-core` exports `extensionCommand<Args extends JsonValue>(id)`, which returns `{ id, command(args: Args): Command }` building the `runCommand` command; a wrong argument shape is a type error. The extension's `run` still validates `args` at run time, and the result equals a `runCommand` sent by hand (M8-Q6 (a)). `editor-core` also exports the type `StarCreateArgs` (`{ frame, points?, innerRatio? }`); a star panel builds `extensionCommand<StarCreateArgs>('ext.star.create')` through `ui` (M8-T2).

## 5. `@vector-studio/ui` and its boundary

- **M8-B1 package.** `packages/ui`: `dependencies` `@vector-studio/react` only; `peerDependencies` `react`; `devDependencies` `react` and `@types/react` at the versions `react` already uses (no new external package). The tsconfig references `../react` only.
- **M8-B2 policy.** `boundaries`: `@vector-studio/ui -> {@vector-studio/react}`; `externalDenied`: `react-dom`, `next`; `packages/ui` in `packageDirectories`; next-host gains `@vector-studio/ui`. ARCHITECTURE gets a pointer paragraph, as M6a-U4 added one.
- **M8-B3 public imports only (exit gate).** Every import specifier in `packages/ui/src` is `react`, `react/jsx-runtime`, `@vector-studio/react` exactly, or relative inside `packages/ui/src`; a TypeScript program over the UI sources resolves `@vector-studio/react` only to `packages/react/dist/index.d.ts` (its `exports` entry). Negative fixtures (a subpath `@vector-studio/react/dist/context.js`, `@vector-studio/editor-core`, `@vector-studio/model`, a relative path into `packages/react/src`) each fail, by the boundary checker or by `tsc`, with the failure asserted.

## 6. Panel contributions

```ts
type PanelContribution = Readonly<{ id: string; title: string; component: ComponentType }>;
type UiExtension = Readonly<{ extension: string; panels: readonly PanelContribution[] }>;
```

- **M8-P1 registration.** The host passes `UiExtension`s to `<PanelProvider contributions={…} onPanelError={…}>` at build time, above both `<EditorPanels>` (which renders the panels) and the host's own status; the editor extension is registered with `createEditor` as before (M8-Q4 (a)). The provider keeps the list of reported errors, and `usePanelErrors()` reads it below the provider; `onPanelError` is optional and receives each error once.
- **M8-P2 ownership.** A panel ID is owned by its `extension` (equal, or it plus a dot and more, as P5 command IDs); the extension must appear in the `extensions` query. A pure function `resolvePanels(contributions, extensions)` returns the panels to render and the errors: `ui.unowned-panel`, `ui.unknown-extension` or `ui.duplicate-panel`, each once, in contribution order; the other panels render. The provider records those errors, and calls `onPanelError({ code, panel })` for each, in an effect.
- **M8-P3 isolation.** Each panel renders inside its own `PanelBoundary` (a class error boundary): `getDerivedStateFromError` sets the failed state, whose render is that panel's `ui.panel-failed` notice, also recorded by the provider and reported through `onPanelError`; the editor and the other panels keep working. Server rendering does not run error boundaries, so unit tests call `getDerivedStateFromError` and `render` as functions, and the headed spec checks the boundary in a browser (M8-A09, A14).
- **M8-P4 public API only.** A panel component receives no props; it reads and writes through the hooks `ui` re-exports, so it holds no store, renderer or editor internals (ARCHITECTURE, Extension boundary). Panel open and collapsed state is React state: never document, history or persisted (requirements, Editing behavior).

## 7. Toolbar, layer panel and property panel

Each control commits through one public command (one undo step for a document command); invalid input sends nothing and marks the field `aria-invalid`; a refused command shows its code. The panels' pure parts (row models, mixed values, command builders) are internal modules of `ui`, unit-tested exactly (M8-Q3 (a), the M4 precedent). Fields backed by a one-node command (`setFrames` for one frame, `setNodeProps`, `setTextProps`, `setTextStyle`) are editable for a single selected node only and show the common value or "mixed", read-only, for several; no multi-node command is added and no panel sends several commands for one edit.

### 7.1 Toolbar

- **M8-L1.** Row 1: the built-in tools, then each registered extension tool by ID (from the `extensions` query), with `aria-pressed` on the active one; group, mask, ungroup, undo, redo, delete, toggle closed. Row 2: the zoom controls and the symbol, instance and detach buttons, which keep the `create-symbol`, `create-instance` and `detach` test IDs and next-host's enable rules. Each row exports as its own component so hosts place them and add controls beside them (the `star` button and file controls stay host code, M8-N2).

### 7.2 Layer panel

- **M8-L2 pages.** `PageList` renders exactly one button per page, in order, inside one element (`data-testid="pages"`), the active one pressed (`setActivePage`); double-click opens a rename textbox (`renamePage` on Enter or blur). Add and remove (`addPage`, `removePage`) are buttons outside that element.
- **M8-L3 tree.** `LayerTree` lists the active page's nodes, front first (the last child on top), indented by depth, each row with name and type; containers, symbols and frames expand and collapse (React state); an instance's expansion is not listed (it is not a document node, M7). Click selects (`setSelection [id]`), Shift or Mod toggles the row in the selection; selected rows are marked.
- **M8-L4 row edits.** A visibility toggle per row (`setNodeProps visible` on that row's node); rename on double-click (`setNodeProps name`); forward, backward, front and back buttons on the selection (`reorderNodes`, M8-Q7 (a)).

### 7.3 Property panel

- **M8-R1 appearance.** The M4 panel unchanged (multi-node through `setStyle`), keeping its `complementary` landmark named "Appearance" (M8-Q11).
- **M8-R2 transform.** X, Y, W and H of the stored parent-local frame and the rotation in degrees, through one `setFrames` (M8-Q8 (a)).
- **M8-R3 layer, line and constraints.** Name and visibility; line start and end arrows (`setNodeProps startArrow`, `endArrow`); constraints of a child of a frame or symbol (`setNodeProps constraints`).
- **M8-R4 text.** Sizing, alignment, letter spacing and line height (`setTextProps`); family, size and colour (`setTextStyle`) over the text edit selection when it is not collapsed, else over the node's whole text; with a collapsed caret the run fields are disabled (M8-Q9 (a)).
- **M8-R5 symbols.** On a source: "Create instance"; on an instance: "Detach instance" and, per overridden text node, "Reset text" (`clearInstanceText`). These buttons carry no test IDs, so the toolbar's `create-instance` and `detach` stay unique in Playwright strict mode.

## 8. next-host composition

- **M8-N1 uses the UI package.** The page composes the toolbar rows, `PageList`, `LayerTree`, `PropertyPanel` and `EditorPanels` from `@vector-studio/ui`; its own `Toolbar`, `ZoomControls`, `SymbolControls`, `Pages` and `AppearancePanel` and `src/m4-appearance*.ts` are removed. File controls, the `star` button, persistence status, `Status`, overlays, fixtures, the test hook and `?bench=1` stay host code and keep their behavior.
- **M8-N2 sample extension panel.** `apps/next-host/src/m8-star-panel.tsx` contributes the `ext.star` panel: points and inner-ratio fields for one selected star (`setNodeProps data`) and a "Create star" button through `extensionCommand<StarCreateArgs>` (M8-X2). It imports only `@vector-studio/ui` and `react`, checked by a unit test as in M8-B3 (M8-Q13 (a)). The host `star` button keeps its test ID and frame `{ x: 360, y: 220, width: 160, height: 160 }` (`tests/p5-next-host/p5-next-host.spec.ts:146`). Only with `?test=1&faults=1`, which only the M8 spec loads, next-host registers a test extension `test.ui` with a panel that throws on a button press and one unowned panel, for A14; plain `?test=1`, which every earlier next-host spec loads, keeps the editor composition of 17a2b0a plus the star panel. Panel errors show in the host status under their own test ID, `panel-error`, never `error`, so the earlier specs' `error` count of 0 is unaffected.
- **M8-N3 layout budget.** U6 first measures, at 17a2b0a, per next-host config and in a project that shows scrollbars: the canvas content box's CSS origin, the canvas row's width and height, the computed width of the existing Appearance aside (which shrinks a few px in P5 and M1 at 1280 × 720 when a headed window scrollbar shows), the document's `scrollWidth` and `scrollHeight`, and row 2's height. A laptop with overlay scrollbars would miss the shrink, so the laptop pre-run is provisional and the official measurement is the main-PC U7 sitting (Windows classic scrollbars), which re-measures 17a2b0a before the M8 run. Rules, each asserted by every next-host spec after load against those measured values: (1) the canvas origin is unchanged; (2) the document is no wider and no taller than at 17a2b0a; (3) row 1 and row 2 each fit within the measured canvas row width, with `PageList` on the left of row 2; row 2's height is unchanged, also while a page rename textbox is open in `pages`; (4) the canvas origin's y plus the right column's height is at most the viewport height. The right column's width is the measured Appearance aside width of that config (no hard-coded 300 px), so the layout is no wider than at 17a2b0a in every config, Windows classic scrollbars included; its own vertical scrollbar takes space inside that width. It has a fixed height equal to the measured canvas row height with `overflow-y: auto`, so focusing any control in it scrolls the column, never the window, and the page is no taller than at 17a2b0a. Its sections are in a fixed order: `LayerTree` (fixed height 240 px, scrolling), then the Appearance section directly under it, without its own `maxHeight` 640 and `overflow-y`, so the column is the only scroller (the M6b-A13 focus target, `tests/m6b-next-host/m6b-next-host.spec.ts:1008`, at a known position), then the transform, layer, line, constraint, text and symbol sections, then the extension panels. Every next-host Playwright config states its viewport per project (the M1 config's real 1280 × 720 included), and each spec also checks `scrollWidth <= clientWidth` of the document after load, unless the U6 measurement shows the canvas row already overflows at 17a2b0a, which U6 then discloses (M8-Q10 (a)).
- **M8-N4 selectors kept.** The UI components keep every `data-testid`, role and accessible name the P5 to M7 and E26 specs use (M8-Q11 (a)).
- **M8-N5 bench page unchanged.** `?bench=1` is exempt from the M8-N3 column rules (width and fixed height): it keeps the 17a2b0a Appearance aside exactly, its `maxHeight` 640 and scrolling included. With `?bench=1` the page mounts neither `LayerTree`, the new property sections nor extension panels: the toolbar rows and the Appearance section keep today's layout and canvas size, so E26, E30 and M9 measure the 17a2b0a component set until E30 or M9 decides otherwise. The E26 and M6c-U5 records stay valid for their own commits.
- **M8-N6 source checks.** U6 updates, without weakening, the unit checks that pin next-host source: `tests/unit/m6b-u9-next-host.test.ts:123` (the `TOOLS` list), `tests/unit/m6c-u2-next-host.test.ts:305` and `:604-618`, `tests/unit/m6c-u3-agreement.test.ts:440-448` (page source text), `tests/unit/p5-react.test.ts:51` (prerender), and the root `tsconfig.json` include of `apps/next-host/src/m4-appearance.ts`; each change is listed in the U6 notes.

## 9. Host API guide

`docs/host-api.md` (new, M8-Q14 (a)) describes creating an editor, the provider, the hooks, commands and queries, events, extensions (node types, commands, tools, bindings, panels) and the UI package, with links to the type declarations as the source of truth; it copies no type. AGENTS.md gains its row in the documentation ownership table. Every export added by M8 carries TSDoc, checked mechanically.

## 10. Acceptance criteria

Unit tests use exact values with a real editor; the UI's pure modules are tested as functions and its markup with `react-dom/server` (M8-Q5 (a)).

| ID | Criterion | Method |
| --- | --- | --- |
| M8-A01 | M8-T1: every name in the reach of `editor-core` is importable from `editor-core`; `typeof`-only values are not re-exported; no other `model` or `contracts` value is; `model` and `contracts` are unchanged | Type-level unit test (compiler API), `pnpm typecheck` |
| M8-A02 | M8-T2 and T3: the consumer fixtures importing only `react`, and only `ui`, name every reached type; the runtime exports of `react` are the P5 ones plus section 3's hooks and `extensionCommand`; `ui`'s are `react`'s plus section 6 and 7 | Type-level unit test |
| M8-A03 | M8-H1, H3, H4: each hook's adapter returns the literal field after commands, undo, page switch and load; the same reference between unrelated events; `useEditorQuery` re-reads after a `textLayout` session event and uses `Object.is` outside the H3 list; markup with `renderToString` | Unit tests |
| M8-A04 | M8-H2: a selector returning a fresh array with an `isEqual` gives one reference while equal and a new one after a change; without `isEqual`, behavior equals today's | Unit tests |
| M8-A05 | M8-X1 and X2: the `extensions` query literally for `starExtension` plus a test extension, frozen, no event; `extensionCommand<StarCreateArgs>` compiles with valid arguments, `@ts-expect-error` on invalid ones, and its command deep-equals the hand-written `runCommand` | Unit and type-level tests |
| M8-A06 | M8-H5: `dist/index.js` of `react` and `ui` begins with `'use client'`; P5-A11 (clean Node import, prerender) still passes | Unit tests |
| M8-A07 | M8-B1 and B2: policy entries; fixtures show `ui` importing `editor-core`, `model`, `contracts`, `react-dom` or `next` fails and importing `@vector-studio/react` passes; next-host importing `ui` passes; `pnpm check:boundaries` passes | Unit tests, `pnpm check:boundaries` |
| M8-A08 | M8-B3 (exit gate): the UI sources pass the public-import check and each negative fixture fails with its asserted error | Type-level unit test |
| M8-A09 | M8-P1 to P4: a fixture panel renders through public hooks (`renderToString`); `resolvePanels` returns each code once for unowned, unknown-extension and duplicate panels and keeps the rest; `PanelBoundary.getDerivedStateFromError` and its failed `render` give the `ui.panel-failed` notice; panel state never reaches the document or history | Unit tests (pure functions); boundary in a browser by A14 |
| M8-A10 | M8-L1 to L4: toolbar rows, enable rules and tool list (with an extension tool); page and row models (front first, depth, expansions excluded), `PageList` markup with one button per page, and the literal command of each action; each document edit one undo step | Unit tests |
| M8-A11 | M8-R1 to R5: the moved M4 tests pass unchanged in expectations; transform, layer, line, constraint, text and symbol fields give literal commands for one node, mixed read-only values for several, and refusals; R5 buttons carry no test ID | Unit tests |
| M8-A12 | M8-N1 to N6: next-host defines none of the removed components and imports them from `ui`; the star panel's imports pass the M8-B3 check; the `star` button's frame literal; every next-host config states its viewport; the origin, width, height, row 2 height, column fit and scroll-width checks are in every next-host spec; `?bench=1` keeps the 17a2b0a aside; plain `?test=1` registers no fault panel and panel errors use the `panel-error` test ID; `?bench=1` mounts none of the N5 components (source check and markup); the N6 checks updated | Unit tests, source checks |
| M8-A13 | `docs/host-api.md` with the section 9 topics and local links; the AGENTS.md row; a compiler-API check that every new export of `editor-core`, `react` and `ui` has a TSDoc comment | Unit test, review, `npx prettier --check` |
| M8-A14 | Headed `tests/m8-next-host/` in Chrome and Edge at 1280 × 720 and 1280 × 900: the M8-N3 checks (origin, no wider or taller document, row 2 height with a rename open, no horizontal scroll), and focusing an Appearance field scrolls only the right column; layer panel select, Shift and Mod toggle, expand and collapse, rename, hide, reorder; add, rename, remove and switch pages; edit X, W and rotation, a line arrow and a child constraint; one invalid field shows `aria-invalid` and sends nothing; a text style over a selection; "Create instance", "Detach instance" and "Reset text" (role names matched with `exact: true`); create a star and change its points from the star panel; under `?test=1&faults=1`, the throwing panel shows `ui.panel-failed` while the others work, and the unowned panel's code reaches the status's `panel-error` element through the provider. Then the P5, M1 to M7 and M6a to M6c (`m6c-next-host`) specs pass; `m6c-u0-zoom` (headless) and the E26 harness smoke (`E26_CHROMIUM`) pass off the main PC; `m6c-observe` is not re-run (an observation, not judged; its record stays valid for its commit, and M9 owns typing cost) | Headed specs on the main PC (one sitting); laptop pre-run first |
| M8-A15 | Independent `reviewer` review of each unit; `pnpm check`; the exit record lists evidence for A01 to A14 and the disclosures, and the user accepts it | Review record |

The plan's exit gate is M8-A08 (the UI package imports nothing but public exports), M8-A09 with M8-A14 (an extension panel renders through the public API only), M8-A12 with M8-A14 (next-host uses the UI package), M8-A07 (the boundary checker covers it), and M8-A15.

## 11. Units

| Unit | Content | Tier |
| --- | --- | --- |
| M8-U1 | `editor-core`: type re-exports (T1), the `extensions` query (X1), `extensionCommand` and `StarCreateArgs` (X2) (A01, A05) | Full (public API) |
| M8-U2 | `react`: re-exports (T2, T3), equality option, named hooks, `useEditorQuery`, store adapters, `'use client'` (A02 to A04, A06) | Full (public API) |
| M8-U3 | `packages/ui`: manifest, tsconfig, policy entry, ARCHITECTURE pointer, re-export of `react`, public-import check, panel contributions, toolbar rows (A02 ui half, A06 ui half, A07 to A09, A10 toolbar half) | Full (new package, boundary) |
| M8-U4 | `ui`: `PageList` and `LayerTree` (A10) | Full (product behavior) |
| M8-U5 | `ui`: property panel with the moved M4 panel (A11) | Full (product behavior) |
| M8-U6 | next-host: UI composition, star panel and the `?test=1&faults=1` panels, layout budget and right-column height, bench page, config viewports, origin and scroll checks, N6 source checks, re-baselined positions, `docs/host-api.md` (A12, A13); laptop functional pre-run of every next-host spec, the M8-N3 measurements at 17a2b0a first, in a project that shows scrollbars | Full (host product behavior) |
| M8-U7 | Headed spec `tests/m8-next-host/`, `playwright.m8-next-host.config.ts`, `test:m8-next-host`; laptop pre-run, then **one main-PC headed sitting** for A14, which first re-measures the M8-N3 values at 17a2b0a | Light |
| M8-U8 | Exit record (A15); the user's acceptance | Full |

Order: U1, then U2, then U3, then U4 and U5 in either order, then U6, U7, U8. Every unit runs `pnpm check`. Only U7 needs a headed run on the main PC; it batches the M8 spec with every earlier next-host spec into one sitting. U4 to U6 use headless smoke projects and laptop pre-runs, which are spec checks, not evidence. The rendering track is told before U6 merges. The D10 WIP limit of two units waiting for review applies.

## 12. Risks

- **Layout churn in earlier specs.** Moving controls can shift positions the P5 to M7 specs measure; M8-N3 keeps the canvas origin and M8-N4 the selectors, and each re-baseline is listed. A missed one shows only in the headed sitting, so U6's laptop pre-run runs every next-host spec.
- **Canvas row already wide.** If the 17a2b0a canvas row (about 1268 px) overflows a viewport narrowed by a vertical scrollbar, the scroll check cannot pass without moving the canvas; the fixed-height right column keeps M8 from adding that scrollbar, and U6 discloses any overflow that 17a2b0a already had rather than moving the origin.
- **Re-export drift.** A later milestone that adds a `model` type to the API must re-export it; A01 and A02 fail until it does, by design.
- **Versioned and legacy names in the API** (`DocumentV6`, `PageV1` to `PageV5`, `InstanceNodeV5`, `NodeBaseV2`, `GroupNode`): a schema bump renames types the UI and hosts use, and the legacy names widen the surface (M8-Q2).
- **No DOM unit tests** (M8-Q5 (a)): event wiring and the error boundary are checked only by headed specs.
- **One-node fields** (section 7): several selected nodes cannot be renamed, restyled as text or constrained at once until a multi-node command exists.
- **Panel cost.** Re-rendering the layer tree on every snapshot of a 10,000-node page is unmeasured; `?bench=1` excludes it (M8-N5), and M9 owns any claim or remedy.

## 13. Open questions

| ID | Question | Recommendation |
| --- | --- | --- |
| M8-Q1 | How does the UI name model types? | (a) type-only re-exports through `editor-core` and `react` (M8-T1, T2), as the MVP plan says. (b) give `ui` a `model` dependency: changes ARCHITECTURE's `ui -> react` |
| M8-Q2 | Versioned and legacy type names | (a) re-export the reach as it is, legacy names included (`PageV1` to `PageV5`, `InstanceNodeV5`, `NodeBaseV2`, `GroupNode`); aliases backlog. (b) add unversioned aliases (`EditorDocument`) and flatten the model's alias chains first, a model change |
| M8-Q3 | Where do panel view models live? | (a) internal pure modules of `ui`, as M4 did in next-host; `react` gains generic hooks only. (b) `react` exports headless panel hooks, a larger public API to keep stable |
| M8-Q4 | How do extensions contribute panels? | (a) a UI-side `UiExtension` passed by the host, owner checked against the `extensions` query. (b) an opaque `ui` field on `editor-core`'s `Extension`, carrying React values through a framework-free package. (c) no owner check |
| M8-Q5 | Unit-test environment for the UI | (a) no new dependency: pure modules (`resolvePanels`, `PanelBoundary` statics), store adapters with a real editor, `renderToString`; interactions and the boundary in headed specs. (b) add a DOM environment (for example `happy-dom`) as a root dev dependency, which needs the user's approval |
| M8-Q6 | Command typing for extensions | (a) `extensionCommand<Args>(id)` builders, re-exported by `react` as its one value re-export, run-time validation unchanged. (b) declaration merging into an `ExtensionCommandArgs` interface keyed by ID, which types `runCommand` globally. (c) none |
| M8-Q7 | Reordering in the layer panel (user-visible) | (a) forward, backward, front and back buttons (`reorderNodes`); drag and drop and reparenting backlog. (b) drag and drop with `moveNodes` |
| M8-Q8 | Space of the transform fields (user-visible) | (a) the stored parent-local frame and rotation, one `setFrames`, exact undo (as Figma shows X and Y relative to the parent). (b) page-space bounds as the `handles` box, which needs a page-to-local mapping per edit |
| M8-Q9 | Text style with a collapsed caret (M6b follow-up 10; user-visible) | (a) run fields disabled; typing style backlog. (b) a typing style as new editor-core session state, an M6b amendment to text input |
| M8-Q10 | Toolbar layout (M6b follow-up 9; user-visible) | (a) two fixed rows within the canvas row's width, the canvas origin kept, viewports stated per project, origin and scroll-width checks in every spec. (b) a wrapping row, whose positions vary with the window |
| M8-Q11 | Selectors of earlier specs | (a) keep every test ID, role and name; re-baseline positions only. (b) move earlier specs to new selectors |
| M8-Q12 | The canvas overlays (selection, snap, path, text) | (a) stay in next-host; the plan names toolbar, layer and property panels only. (b) move them to `ui` |
| M8-Q13 | Where the sample extension panel lives | (a) next-host source with an import check. (b) a new package, more wiring for a sample |
| M8-Q14 | API documentation | (a) `docs/host-api.md` plus checked TSDoc, with an AGENTS.md ownership row. (b) TSDoc only |

No recommended option needs a new dependency or changes a requirement. M8-Q5 (b) would need the user's approval of a dependency; M8-Q1 (b) would need an architecture change. M8-Q7 to M8-Q10 are user-visible behavior; (a) keeps M8 small. All may be adopted as recommended under the user's standing rule of 2026-10-24 once the contract is approved; a later user pick replaces an option before the unit it affects starts.

## 14. Validation of this contract

Documentation only: Markdown formatting (`npx prettier --check`) and local links; claims about existing code are grounded by `file:line` at 17a2b0a, and the T1 reach count by the review r1 probe. No product, browser, GPU or benchmark run is claimed.

## 15. Gate

M8 "closes after M7" (MVP plan section 7); M7 was accepted on 2026-10-30, and the user accepted the M6 exit on 2026-11-01 at 08:54Z (status PR #436). Implementation starts at M8-U1 only after this contract is approved by independent review and #436 has merged, by the plan's one-milestone-at-a-time main line. The M8 exit is the user's acceptance of the M8-U8 record.

## 16. Progress

| Unit | State |
| --- | --- |
| M8-U1 | In review: PR (see below); independent review READY WITH FOLLOW-UPS, applied as these notes |
| M8-U2 | In review: independent review r1 NOT READY (shared-memo owner), fixed; notes below |
| M8-U3 | Not started |
| M8-U4 | Not started |
| M8-U5 | Not started |
| M8-U6 | Not started |
| M8-U7 | Not started |
| M8-U8 | Not started |

### M8-U1 notes

- Reach (M8-T1) at the U1 change: 155 named declarations in the reach of `editor-core`'s built entry, 87 of them from `model` or `contracts`: 86 types (44 `model`, 42 `contracts`, `PageV6` included), all re-exported type only, and one `typeof`-only value, `DOCUMENT_ERROR_CODES`, not re-exported. The section 2 "about 84" was the 17a2b0a probe.
- Two public names the contract does not list: `ExtensionSummary` (the element type of the `extensions` query result) and `ExtensionCommandBuilder<Args>` (the return type of `extensionCommand`). Both reach `react` and `ui` through M8-T2, so the M8-U2 fixtures include them.
- M8-X1 `bindings` are the canonical chords the `keymap` query uses: `Mod` resolved for the editor's platform (`Ctrl` or `Meta`), `action: null` unbinds included, sorted by code unit. They stay constant for the editor's lifetime.
- M8-A01's "model and contracts are unchanged" is shown by the U1 diff, which touches neither package; no test asserts it.
- The A01 test reads the built `dist`; `pnpm check` builds through `typecheck` before `test:unit`. `tests/support/m8-type-reach.ts` is shared with M8-U2 and U3, which keep an owner-export check so a reached internal type fails clearly.

### M8-U2 notes

- Reach (M8-T2, T3) of `react`'s built entry: 164 named declarations, 147 of them types (20 `react`, 57 `editor-core`, 45 `model`, 42 `contracts`); `DOCUMENT_ERROR_CODES` is the only `typeof`-only name. `react` re-exports editor-core's 142 type exports as an explicit type-only list, not `export type *`, which would also expose editor-core's values as type names; the A02 test fails when the list drifts.
- `useHistory` returns a value equal to `snapshot.history`, not always the same object: editor-core builds a new `history` object per snapshot, so the hook keeps the earlier object while the undo and redo depths are equal (M8-H1 stability). A03 checks it with deep equality.
- M8-A04 "without `isEqual`, behavior equals today's" holds for selectors that return a snapshot part or a primitive. A selector now runs once per snapshot object, so a fresh-array selector no longer returns a new value on each read (which tripped React's cached-snapshot check), and an impure selector that reads `editor.query` goes stale on events that keep the snapshot, such as `textLayout`; the TSDoc says selectors must be pure and points to `useEditorQuery`.
- Each store records itself as the owner of the shared memo; a store whose memo another store wrote re-runs its selector or query (review r1 blocking item, store-level tests).
- `extensionCommand` comes through the `'use client'` entry, so a Next.js Server Component sees a client reference it cannot call; server code imports it from `editor-core` (TSDoc; host guide in M8-U6).
- The query store adds one listener per editor that counts events, so a value read between render and subscribe is re-read; it lives as long as the editor.
