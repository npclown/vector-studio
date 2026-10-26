# P5 execution plan: editor integration slice

Status: APPROVED 2026-10-24 under the user's standing instruction of 2026-10-24 (adopt the recommended options and continue), after independent review rounds 1 and 2 (sections 12 and 13); P5-Q1 to P5-Q8 are decided as recommended. **Implementation approved 2026-10-25** by the user's separate approval under [D10](d10-roadmap-reset.md) decision 4: P5 units run in plan order in parallel with the P3 exit (section 14). The P5 entry rule of [`prototype-plan.md`](../prototype-plan.md#current-position-and-plan-entry-rule) is otherwise unchanged.

Track: visualization. Item: V-5 of the [D9 visualization track plan](d9-visualization-track.md#status-index). Tier: full, because it fixes acceptance criteria, adds packages and dependency edges, and defines product behavior.

This plan owns P5's scope, package layout, document schema v1, command and history semantics, the extension slice, acceptance criteria P5-A01 to P5-A14 and their validation. It makes the five exit-gate bullets of [`prototype-plan.md`, P5](../prototype-plan.md#p5-editor-integration-slice) concrete and does not change them. Product behavior stays owned by [`requirements.md`](../requirements.md), and boundaries by [`ARCHITECTURE.md`](../../ARCHITECTURE.md). Questions are P5-Q1 to P5-Q8.

## 1. Scope

### 1.1 In scope (the slice of `prototype-plan.md`)

1. One document with one page and one viewport.
2. Rectangle creation and path creation.
3. Click selection and marquee selection.
4. Move and resize of the selection.
5. Commands, transactions, undo and redo.
6. JSON round trip of the document.
7. One custom node type registered through the extension boundary.
8. React client bindings, used from a Next.js client component.

### 1.2 Out of scope

Everything else in [`requirements.md`](../requirements.md), as the [requirement coverage table](../prototype-plan.md#requirement-coverage) says: multiple pages, rotate, snapping, align and distribute, clipboard, layer reordering, groups, frames, masks, symbols, text, gradients, dashes, anchor and handle editing, shortcut configuration, IndexedDB and SSR canvas rendering. P5 builds none of them, and its schema must not make them impossible (section 3.4).

## 2. Packages and dependency direction

The packages follow the reserved graph of [`ARCHITECTURE.md`, Dependency direction](../../ARCHITECTURE.md#dependency-direction). Each new package extends `tooling/boundary-policy.mjs` and `pnpm check:boundaries` in the same unit that creates it.

| Package | Imports | Owns in P5 |
| --- | --- | --- |
| `@vector-studio/model` (new) | nothing | Schema v1 types, `parseDocument`, `serializeDocument`, validation codes, ID rules |
| `@vector-studio/editor-core` (new) | `model`, `contracts` | Commands, transactions, history, session (selection, active tool, viewport), tools, queries, hit testing, the scene projector, the extension registry |
| `@vector-studio/react` (new) | `editor-core`, `contracts` | `EditorProvider`, `useEditorSelector`, `useEditorCommands`, headless `EditorCanvas` |
| `apps/next-host` (new) | `react`, `editor-core`, `model`, plus the concrete adapters as host composition | The Next.js client-component host |
| `apps/playground` | unchanged | Keeps its pages; may host a vanilla P5 page |

- `contracts -> model`, which the reserved graph shows, is **not** added in P5: no contract type needs a model type. The edge stays reserved.
- `editor-core` reaches the renderer only through `RendererSceneSynchronization` and the camera contract in `packages/contracts/src/scene.ts`. It never imports `renderer-core`, `renderer-webgpu` or `geometry-wasm` ([ADR 0001](../decisions/0001-port-composition.md)).
- **New runtime dependencies.** `react` and `react-dom` in `@vector-studio/react` (peer dependencies) and `apps/next-host`; `next` in `apps/next-host` only. No renderer, scene-graph or tessellation dependency is added ([`AGENTS.md`](../../AGENTS.md#working-rules)). See [P5-Q1](#9-open-questions).

## 3. Document schema v1

### 3.1 Shape

```ts
type DocumentV1 = {
  schemaVersion: 1;
  id: string;
  pages: [{ id: string; name: string; children: string[] }]; // exactly one page in P5
  nodes: Record<string, NodeV1>;
};
type NodeBase = { id: string; name: string; parent: string; frame: Frame; opacity: number; visible: boolean };
type Frame = { x: number; y: number; width: number; height: number }; // page units, axis-aligned
type NodeV1 =
  | (NodeBase & { type: 'rectangle'; fill: Color | null; stroke: RectStroke | null })
  | (NodeBase & { type: 'path'; path: PathData; fill: Color | null; stroke: PathStroke | null })
  | (NodeBase & { type: 'custom'; customType: string; data: JsonValue; fill: Color | null; stroke: PathStroke | null });
```

- `PathData` holds `verbs` (`move`, `line`, `cubic`, `close`) and `points` in the unit box `[0, 1]²` of the node's `frame`, plus `fillRule`. Storing path points relative to the frame makes resize a frame change only (section 4.4).
- **Path frame.** On creation the frame is the bounding box of all points, cubic control points included. Points are mapped into the unit box by `(p − origin) / size` per axis; on an axis whose size is 0 every unit coordinate is 0. Parsing rejects a unit coordinate outside `[0, 1]` (`document.invalid-field`).
- **Negative zero** is normalized to 0 by every command and by `parseDocument`, so the byte-identical rules of section 4.2 hold.
- `Color` is `{ r, g, b, a }` in `[0, 1]`. `RectStroke` is `{ color, width }`, the fields of the primitive `SceneStroke` in `contracts`; `PathStroke` is `{ color, width, cap, join, miterLimit }`, the fields of the contract's `PathStroke`. Stroke width is in page units.
- **Paint order** is the order of `children`: index 0 is painted first. A node's `parent` is the ID of a page or of a node; in P5 it is always the page.
- **IDs** are opaque non-empty strings, unique across the document (pages and nodes). `editor-core` takes an injected ID source; tests use a deterministic counter.
- Numbers are finite binary64 values. `width` and `height` are at least 0; `opacity` is in `[0, 1]`.

### 3.2 What is not in the document

Selection, hover, active tool, viewport and camera, history, renderer caches, meshes, GPU or WASM handles, and React state ([`ARCHITECTURE.md`, State classification](../../ARCHITECTURE.md#state-classification)). The last-open-page envelope is a persistence concern and is out of P5.

### 3.3 Parse and serialize

`serializeDocument(doc)` emits JSON with keys in a fixed order, and `parseDocument(text)` returns `{ ok: true, document }` or `{ ok: false, code, path }`. The codes are:

| Code | When |
| --- | --- |
| `document.malformed-json` | The text is not JSON |
| `document.unsupported-version` | `schemaVersion` is missing, not an integer, or not 1 |
| `document.invalid-field` | A field has the wrong type or range; `path` names it |
| `document.duplicate-id` | Two entities share an ID |
| `document.dangling-reference` | A `children` entry names no node; a `parent` names no page or node; a node's `parent` differs from the owner of the `children` list it is in; or a node is in no `children` list or in more than one |
| `document.unknown-custom-type` | A `custom` node names a type that no registered extension owns (checked by `editor-core` on load, not by `model`) |
| `document.invalid-custom-data` | A `custom` node's `data` fails its extension's `validate` (checked by `editor-core` on load) |

Unknown fields are rejected (`document.invalid-field`) in v1, so a later version cannot be mistaken for v1 ([P5-Q3](#9-open-questions)).

### 3.4 Migration path

`schemaVersion` is an integer. A future version adds a `migrate(vN -> vN+1)` step in `model`; v1 adds no migration code. Groups, frames and more pages fit the shape without changing any v1 field: `parent` may name a container node, and `pages` may have more entries.

## 4. Editor core

### 4.1 Commands and transactions

- The public API is `editor.execute(command)` and `editor.query(query)`; every persistent change goes through a command inside a transaction ([`ARCHITECTURE.md`, Cross-cutting policies](../../ARCHITECTURE.md#cross-cutting-policies)).
- Document commands: `createRectangle`, `createPath`, `createCustomNode(customType, frame, data, style)` (runs the extension's `validate`), `setFrames` (move and resize of several nodes), `setNodeProps` (fill, stroke, opacity, visibility, name, custom `data`, validated likewise), `deleteNodes`, `loadDocument`, `undo`, `redo`.
- Session commands, never in history: `setSelection(ids)`, `setTool(tool)`, `setViewport(camera)`, and `input(event)`, which feeds pointer and key events (`pointerdown`, `pointermove`, `pointerup`, `keydown`, with page-space point and modifiers) to the active tool. Tools act only by issuing the commands above, so creation, selection, move and resize all run through the public API.
- A transaction applies all of its changes or none. A command that fails validation returns `{ ok: false, code }` and leaves the document and history unchanged.
- Each committed transaction increments the document revision and emits one change event with the IDs it touched.

### 4.2 History

- Undo and redo work on transactions. Undo restores the exact durable content from before the transaction: the serialized document is byte-identical. Redo restores the exact content from after it.
- **Gestures.** A pointer drag is `beginGesture`, `updateGesture`…, `commitGesture` or `cancelGesture`. Updates change the live document and emit change events, but they create no history entry. Commit creates **one** undo step, from the pre-gesture state to the final state. Cancel restores the pre-gesture state and creates no step. The gesture calls are internal to the tools, reached only through `input`.
- **During a gesture**, `undo`, `redo`, `loadDocument` and `setTool` first cancel the gesture, then run; a second `pointerdown` is ignored until the gesture ends. So history never records a step from a base state that no longer exists.
- A new transaction after an undo clears the redo stack. `loadDocument` clears the history.
- Selection and viewport changes are never history.

### 4.3 Session state

Selection (an ordered set of node IDs), the active tool, the viewport (camera position and zoom) and hover are editor session state. They are set by the session commands of section 4.1 and read through queries and subscriptions and are excluded from serialization and history. Deleting or undoing away a selected node removes it from the selection.

### 4.4 Tools

| Tool | Behavior |
| --- | --- |
| Rectangle | Drag from a to b creates a rectangle with frame `min(a, b)` to `max(a, b)`, as one gesture; a click without movement creates nothing |
| Path | Each click adds a line anchor; press-and-drag adds a cubic anchor with symmetric handles; Enter or a click on the first anchor ends it (closed on the first anchor, open on Enter); Escape cancels. Until it ends, the path lives in the tool's overlay state, not the document, so no change event or scene update is sent; the whole creation is one transaction at the end |
| Select, click | Selects the topmost visible node hit at the point, in reverse paint order; shift toggles it; a click on empty canvas clears the selection |
| Select, marquee | Dragging on empty canvas selects every visible node whose frame intersects the marquee rectangle; shift adds to the selection. A path's frame includes its control points, so a marquee near them can select it; this is accepted in P5 |
| Move | Dragging a selected node moves every selected frame by the same page delta, as one gesture |
| Resize | Eight handles on the selection's bounding box; the box is scaled about the opposite handle and every selected frame is mapped by the same affine; sizes clamp at 0. On an axis where the box has size 0, that axis is not scaled and its handles do nothing; a node clamped to size 0 on an axis is recovered by undo only, which is intended in P5. One gesture |

**Hit testing (P5).** Let `r = max(w / 2, 4 / zoom)` page units, where `w` is the stroke width, or 0 without a stroke. A rectangle is hit inside its frame when it has a fill, and within `r` of its frame outline in every case. A path, and a custom node through its `toScene` geometry, is hit inside its fill region when it has a fill, and within `r` of its outline in every case. Outlines are flattened by `editor-core` itself at a tolerance of `0.25 / zoom` page units. Exact geometry-port hit testing is deferred ([P5-Q4](#9-open-questions)).

### 4.5 Scene projector

`editor-core` maps the document to `contracts` scene data: one `RenderNodeSnapshot` per node, in paint order, with `visible` and `opacity` copied. The node's `transform` is the translation to the frame origin only. A rectangle becomes a `primitive` rectangle of the frame's width and height with zero corner radii. A path's unit-box points are multiplied by the frame's width and height on projection, so stroke width stays in page units and is never scaled by a non-uniform resize. Selection outlines and handles are an overlay drawn by the host UI, not document nodes. A custom node is projected as a `path` node whose geometry is its extension's frame-local `toScene` output and whose style is the node's own `fill` and `stroke` (section 5).

Synchronization with the injected `RendererSceneSynchronization` (`packages/contracts/src/scene.ts`):

- **Identity.** `SceneIdentity = { documentId: document.id, pageId: page.id }`. Page children are root nodes: `parentId: null`, in `rootOrder`.
- **Scene revision.** The projector keeps its own revision, separate from the document revision. It increases by one for every scene it sends, so `revision > baseRevision` always holds.
- **Snapshots.** It sends `replaceSnapshot` when the renderer is attached, after `loadDocument`, and after any `resync-required` result.
- **Change sets.** It sends one `RenderChangeSet` after every document change: a committed transaction, a gesture update, commit or cancel, an undo and a redo. After each, the renderer's scene equals the projection of the current document.
- **Base revision.** Each change set's `baseRevision` is the `current.revision` of the last result, not the projector's own counter.
- **Rejection.** On `invalid-scene` the projector emits the structured diagnostic `editor.scene-rejected` with the reason and the node IDs of the rejected set (a set of several nodes is first retried one node at a time, so the rejected set is the nodes rejected on their own; P5-U4 notes in section 14), then marks those nodes as excluded: later snapshots and change sets omit them until a document change touches them again. `unsupported-feature` is reported as `editor.renderer-unsupported` (a host capability fact, for example a renderer without path support); any other reason is a projector defect. Neither is retried unchanged, so one rejection never blocks later edits.
- **Camera.** `setViewport` calls `setCamera`; on `invalid-camera` the viewport is left unchanged and the command returns `{ ok: false, code: 'editor.invalid-camera' }`.

## 5. Extension slice

- The host registers extensions at construction: `createEditor({ extensions: [starExtension], ... })`.
- An extension declares `{ id, nodeTypes: [{ customType, validate(data), defaults(), toScene(data, frame) }], commands?: [{ id, run(args, api) }] }`. `toScene` returns plain `contracts` path geometry in frame-local page units. An extension command's `run` receives only `api = { execute, query }` and composes core commands, so it creates nodes through `createCustomNode`.
- An extension receives only the public `execute` and `query` API (P5-U5 notes, section 14). It gets no mutable store, no renderer, GPU or WASM handle, and no other extension's internals ([`ARCHITECTURE.md`, Extension boundary](../../ARCHITECTURE.md#extension-boundary)).
- The P5 sample is `ext.star`: `data = { points: integer 3..32, innerRatio: (0, 1) }`, created by its own command `ext.star.create` (which calls `createCustomNode`), edited through `setNodeProps`, round-tripped through JSON, and undone like any other node.

## 6. React and Next.js

- `EditorProvider` takes an editor instance created by the host. `useEditorSelector(selector)` is built on `useSyncExternalStore` over editor snapshots; `useEditorCommands()` returns `execute`.
- `EditorCanvas` is headless: it renders a `<canvas>` and pointer handlers, and it creates the renderer only in an effect through a host-supplied factory, so the WebGPU backend stays a host choice.
- `apps/next-host` uses one `'use client'` page. **No browser access at module import:** importing `model`, `editor-core` and `react`, and the next-host page module graph, in Node with no `window`, `document` or `navigator` must not throw. The page loads `renderer-webgpu` and `geometry-wasm` by dynamic `import()` inside the canvas effect, so they are not evaluated during prerender.
- SSR canvas rendering stays out of scope.

## 7. Acceptance criteria

| ID | Criterion (exit-gate bullet) | Method |
| --- | --- | --- |
| P5-A01 | Rectangle and path creation produce the expected nodes through `execute` (1) | Unit tests with literal expected documents |
| P5-A02 | Click and marquee selection, driven through `input` and read through `query`, follow section 4.4, including reverse paint order, shift, empty-canvas and unfilled-shape cases (1) | Unit tests on fixtures with overlapping nodes |
| P5-A03 | Move and resize, driven through `input`, map frames as section 4.4 states, unit-box path points unchanged, zero-size axes unscaled (1) | Unit tests, exact values |
| P5-A04 | A continuous drag with 50 updates creates exactly one undo step; undo gives the byte-identical pre-drag JSON; redo gives the byte-identical post-drag JSON; cancel creates no step; `undo` during a drag cancels the drag first and then undoes the previous step (1) | Unit tests |
| P5-A05 | Failed commands change neither document nor history; selection and viewport never enter history (1) | Unit tests |
| P5-A06 | `parse(serialize(d))` deep-equals `d`, and `serialize(parse(t)) = t` for the committed fixture documents; IDs, frames, path data and paint order are preserved (2) | Unit tests on fixtures, including `ext.star` |
| P5-A07 | Each section 3.3 code is returned for its own malformed fixture, and no partial document is produced (2) | Unit tests |
| P5-A08 | Serialized output contains no selection, viewport, history or cache field (2) | Unit test on the key set |
| P5-A09 | The same command script yields identical documents, history and change events with a recording test renderer and with the WebGPU host; the recording renderer's final scene equals the document's projection after a commit, a cancelled drag, an undo, a redo and a `loadDocument`, and its first call is `replaceSnapshot` (3) | Unit test plus headed GPU spec |
| P5-A10 | `ext.star` registers, creates, edits, round-trips and undoes through public API only; a type-level test shows the extension context exposes no store, renderer or GPU member (4) | Unit and type tests |
| P5-A11 | `model`, `editor-core`, `react` and the next-host page module graph import in Node without browser globals (5) | Unit test in a clean Node context |
| P5-A12 | `apps/next-host` builds with `next build` and its page edits a document in headed Chrome and Edge through `EditorCanvas` (5) | CI build, headed GPU spec |
| P5-A13 | `pnpm check:boundaries` covers the new packages and rejects the seeded forbidden edges `editor-core -> renderer-webgpu` and `react -> renderer-webgpu` | Boundary test |
| P5-A14 | Independent `reviewer` review of each unit; the exit record lists evidence for P5-A01 to P5-A13 | Review record |

No performance claim is made in P5. Rendering precision stays UNVERIFIED until P3 A04 evidence exists.

## 8. Units and order

| Unit | Content | Tier under this plan |
| --- | --- | --- |
| P5-U1 | `model`: schema types, parse, serialize, codes, fixtures (P5-A06 to A08) | Full (new package, boundary) |
| P5-U2 | `editor-core`: commands, transactions, history, gestures, session (P5-A01, A04, A05) | Full |
| P5-U3 | Tools and hit testing (P5-A02, A03) | Light |
| P5-U4 | Scene projector and recording test renderer (P5-A09 unit half) | Light |
| P5-U5 | Extension registry and `ext.star` (P5-A10) | Full (public extension contract) |
| P5-U6 | `@vector-studio/react` and `apps/next-host` (P5-A11, A12, A09 headed half); the `ARCHITECTURE.md` pointer that `apps/next-host`, as host composition, may depend on `geometry-wasm` and `renderer-webgpu`, and its `boundary-policy.mjs` entry | Full (new dependencies) |
| P5-U7 | Exit record and review (P5-A13, A14) | Full |

Order: U1, U2, then U3 to U5 in any order, then U6, then U7. Every unit runs `pnpm check`; headed specs run on the user's PC or are reported NOT RUN.

## 9. Open questions

| ID | Question | Recommendation |
| --- | --- | --- |
| P5-Q1 | Add `react`, `react-dom` and `next` as new runtime dependencies in P5-U6? | (a) yes, at the versions current when U6 starts, pinned in the lockfile; the requirement names React and Next.js |
| P5-Q2 | Store path points relative to the frame (unit box), or in page units? | (a) unit box: resize stays a frame change and undo stays exact |
| P5-Q3 | Reject unknown fields in v1, or preserve them? | (a) reject: keeps v1 strict until a migration policy exists |
| P5-Q4 | Hit testing in `editor-core` (section 4.4), or a new geometry hit-test port? | (a) in `editor-core` for P5: a new port is a shared-surface change outside the slice |
| P5-Q5 | Marquee rule: intersect, or full containment? | (a) intersect, the common editor default |
| P5-Q6 | Create `apps/next-host`, or a Next.js page inside `apps/playground`? | (a) a separate app: the playground is a Vite app, and mixing build systems complicates both |
| P5-Q7 | Axis-aligned frames only in P5 (no rotation field)? | (a) yes: rotate is out of the slice; a later version adds a rotation field by migration |
| P5-Q8 | Which renderer does `apps/next-host` use: P1 primitives and P3 paths through `geometry-wasm`, as V-1 composes them? | (a) yes, the same composition as `apps/playground/src/viz-v1-appearance.ts` |

## 10. Risks

- **P3 exit later than planned.** P5 code waits; this plan stays valid because it depends only on the published `contracts` scene surface.
- **Scene contract gaps.** If `RenderNodeSnapshot` cannot express a node (for example per-node opacity on paths), the gap is filed as a rendering item, not worked around in `editor-core`.
- **Next.js build time in CI** may lengthen the Windows job; the build may run as a separate job.
- **Hit-test flattening** in `editor-core` duplicates kernel work in a simpler form; it is test-sized and replaceable by a later port.

## 11. Gate

On approval, this plan is the P5 execution plan. P5 implementation starts at P5-U1 after the P3 exit, or earlier on a separate user approval (D10 decision 4); that approval was given on 2026-10-25 (section 14). The P5 exit is the user's acceptance of the record of P5-U7.

## 12. Review round 1 (2026-10-24)

Independent `reviewer` review: NOT READY, three blocking and nine should-fix items, all applied.

- B1: the projector now states identity, the initial and resync `replaceSnapshot`, a separate monotonic scene revision, change sets for undo, redo and cancel, and rejection handling; P5-A09 checks the final scene (section 4.5).
- B2: session commands and `input` make creation, selection, move and resize run through the public API; P5-A02 and P5-A03 say so (section 4.1).
- B3: `createCustomNode` and the extension command signature (sections 4.1, 5).
- Should-fix: reference rules, the path frame and zero-size axes, zero-size resize, consistent hit testing, custom-node style, the next-host module graph in P5-A11, the `ARCHITECTURE.md` pointer and a second seeded edge, "P3 A04", the D10 timing note, and negative zero.

## 13. Review round 2 and decisions (2026-10-24)

Round 2: READY WITH FOLLOW-UPS, no blocking item; the five follow-ups are applied: rejection recovery with `baseRevision` from the last result and a separate `unsupported-feature` code; commands during a gesture; the path tool's overlay state; the zero-size clamp; `document.invalid-custom-data`, `setCamera` handling and the marquee note.

Decisions: P5-Q1 to P5-Q8 adopted as recommended under the user's standing instruction of 2026-10-24, including the new runtime dependencies `react`, `react-dom` and `next` (P5-Q1), which are added only when P5-U6 starts.

## 14. Implementation decision and progress (2026-10-25)

Decision, 2026-10-25: the user approved starting P5 implementation now, in parallel with the P3 exit (the separate approval of D10 decision 4). Units run in the order of section 8 on `claude/viz-p5-...` branches. They do not touch rendering-kernel files under change for the P3 exit, and headed GPU runs on the user's PC are scheduled around the rendering track's runs and V-4. Rendering precision stays UNVERIFIED until P3 A04 evidence exists.

| Unit | State |
| --- | --- |
| P5-U1 | Merged ([PR #252](https://github.com/npclown/vector-studio/pull/252)); independent review round 1 NOT READY, findings applied, round 2 READY: `packages/model`, fixtures `tests/fixtures/p5-model/`, `tests/unit/p5-model.test.ts` (P5-A06 to A08; the two `editor-core` codes of P5-A07 land with P5-U5) |
| P5-U2 | Merged ([PR #255](https://github.com/npclown/vector-studio/pull/255)); independent review rounds 1 and 2 NOT READY, findings applied, round 3 READY: `packages/editor-core` (commands, transactions, history, gestures, session), `tests/unit/p5-editor-core.test.ts` (P5-A01, A04, A05) |
| P5-U3 | Merged ([PR #257](https://github.com/npclown/vector-studio/pull/257)); independent review READY WITH FOLLOW-UPS, follow-ups applied: select, rectangle and path tools and hit testing in `packages/editor-core` (`tools.ts`, `hit-test.ts`), `tests/unit/p5-tools.test.ts` (P5-A02, A03) |
| P5-U4 | Merged ([PR #259](https://github.com/npclown/vector-studio/pull/259)); independent review round 1 NOT READY, findings applied, round 2 READY WITH FOLLOW-UPS, follow-ups applied: scene projector in `packages/editor-core` (`projector.ts`, `attachRenderer`), `tests/support/p5-recording-renderer.ts`, `tests/unit/p5-projector.test.ts` (P5-A09) |
| P5-U5 | Merged ([PR #262](https://github.com/npclown/vector-studio/pull/262)); independent review round 1 NOT READY, findings applied, round 2 READY WITH FOLLOW-UPS, follow-ups applied: extension registry and `ext.star` in `packages/editor-core` (`extensions.ts`, `star.ts`, `createCustomNode`, `runCommand`), fixtures `tests/fixtures/p5-model/malformed-custom/`, `tests/unit/p5-extensions.test.ts` (P5-A10, the two custom codes of P5-A07) |
| P5-U6 | Implemented; independent review round 1 READY WITH FOLLOW-UPS, follow-ups applied, round 2 READY: `packages/react`, `apps/next-host`, `tests/unit/p5-react.test.ts` (P5-A11, the react seeded edge of P5-A13), headed spec `tests/p5-next-host/` (P5-A12, P5-A09 headed half) PASS 4/4 on the main PC (DESKTOP-DKVUSAV), Chrome and Edge headed, 2026-10-25, at c13b8aa |
| P5-U7 | Not started |

P5-U1 notes. Serialization is two-space JSON with a final newline; node and custom-data keys are written in sorted order, so the text does not depend on creation or undo order. A key repeated inside one JSON object is rejected (`document.duplicate-id` under `nodes`, `document.invalid-field` elsewhere), because `JSON.parse` would silently keep one of the two. Path verbs follow the renderer's path grammar (a `move` opens each subpath), so a valid document never projects to a rejected path. `validateDocument` checks an in-memory value with the same rules, for `loadDocument` in P5-U2, and `validateNode` applies the field rules to one node, for the commands. Nesting deeper than 256 containers, data included, is rejected as `document.invalid-field` (text and in-memory values alike), so a small hostile file cannot exhaust memory or the stack; sparse arrays are rejected. The node key is the node's ID, so a node whose `id` differs from its key is `document.invalid-field`, not `document.duplicate-id`. Parsing checks unit-box points only for `[0, 1]`; that a path's points span its frame is a creation rule of P5-U2.

P5-U2 notes. Every document command, not only the four of section 4.2, ends an active gesture: it applies to the pre-gesture document, and only when it succeeds is the drag cancelled and the step recorded, so no step has a stale base. A failed command (an empty undo or redo stack, an invalid load, a failing edit) changes nothing and the drag goes on. Whenever a command ends a drag, and on every load or `setTool`, the active tool's `reset` runs, so tool state never outlives its base. The document revision counts every document change event: commands, gesture updates, commit and cancel, undo, redo and load. A gesture commit with no update (a click) records no step; empty `setFrames` and `setNodeProps` are rejected. Events reach listeners in change order: those raised during a top-level `execute` are held until it has fully committed, and one raised inside a listener waits for the current one, so a listener's snapshot may be newer than its event. A throwing listener does not stop delivery (its error is rethrown asynchronously), and every document, snapshot, selection and viewport the editor holds or returns is deep-frozen, so history stays byte-identical. Creation defaults when the command names no style: a rectangle gets fill `{0.8, 0.8, 0.8, 1}` and no stroke, a path no fill and a black 1-unit butt-miter stroke (miter limit 4); new nodes go on top of the paint order, commands never change the selection, and a failed create draws no ID. Command failures return the model's `document.invalid-field` with a node path (relative to the new node for creates), or an `editor.*` code (`invalid-command`, `unknown-node`, `unknown-tool`, `duplicate-id`, `nothing-to-undo`, `nothing-to-redo`, `invalid-camera`). The gesture API and the tool registry are package-internal (`internalsOf`), for the P5-U3 tools (events are held during `input`, so a tool's drag cannot end under it; a caller outside `input` checks `gesture.active` after an update); the editor object carries them, so P5-U5 gives extensions a facade with only `execute` and `query`, never the editor itself. `createCustomNode` lands with the extension registry in P5-U5, and `setViewport` calls the renderer's `setCamera` once the P5-U4 projector attaches one. As in the model, node IDs are unique against pages and nodes only; a node may share the document's ID.

P5-U3 notes. Resize handles sit at the corners and edge midpoints of the selection's bounding box and are reached within 6 / zoom page units; the nearest wins, and a handle wins over a node hit under it, except on a box narrower than 24 / zoom on an axis, where a press inside the box on a selected node moves it. Handles that could scale no axis (an edge handle on a zero-size axis) are not handles. A press on a node that is not selected selects it and starts a move; a click without movement on a node selects only that node, even inside a larger selection; a shift press toggles it and starts nothing; a shift click on empty canvas keeps the selection. The pointerup point is the end of every drag; a rectangle drag that returns to its start creates a 0×0 rectangle, consistent with `min(a, b)` to `max(a, b)`. Escape cancels a move, resize, rectangle drag or marquee, and clears the path tool's anchors; undo leaves pending path anchors in place, as only a drag, a load or a tool switch resets a tool. The rectangle and path tools select what they create (a session change, never history). The path tool ignores a second press on its last anchor, closes on a press within 4 / zoom of the first anchor once it has two anchors, and keeps its anchors if the create fails; a segment is a cubic when either end has a handle, using the anchor itself for the missing control point. The editor hands tools a frozen copy of each input event, and the marquee and path anchors are frozen overlay state, read with the `overlay` query and drawn by the host. Cubics are flattened into at most 4096 segments, which holds the 0.25 / zoom bound for curves up to about 10^5 / zoom page units across; larger curves are flattened more coarsely, accepted in P5. Custom nodes are not hittable until P5-U5 supplies their geometry. The tests build their overlapping-node fixtures inline.

P5-U4 notes. `attachRenderer` sends the projection as a snapshot, then the current viewport; a second attach replaces the first renderer, and a renderer that reports `disposed` is detached while editing goes on. The renderer is brought up to date inside each document change, before any listener runs, and a projector diagnostic event follows the change event it came from. A change set carries the touched nodes as inserts or updates (by what the renderer holds), the removed ones, and an order entry only when the paint order changes; nothing is sent when nothing changed for the renderer. When a set with more than one node is rejected, the projector applies the removals alone and then sends each node on its own, so only the nodes the renderer rejects on their own are reported (once per reason) and left out; a rejected snapshot is replaced by an empty one filled the same way, so one unsupported path at attach does not blank the scene. A rejected update also removes the renderer's older copy; a rejected removal and any `resync-required` during that isolation end in a full snapshot, at most once per change, so a renderer that keeps failing is retried at the next change. Every snapshot starts above the renderer's current revision, and a `stale-snapshot` or `revision-conflict` answer to a snapshot is revision bookkeeping (one retry above the renderer's revision), never a node rejection, so re-attaching a renderer that already holds a scene works. A renderer that rejects the viewport on attach keeps its own camera until the next `setViewport`. The tests use the renderer-core scene mirror, which validates snapshots and change sets as the WebGPU renderer does, as the recording renderer, and check after every step that it holds exactly the projection of the document. Custom nodes project to nothing until P5-U5.

P5-U5 notes. Extensions are registered once through `createEditor({ extensions })`; an empty extension ID, one that equals or is a dot-prefix of another extension's ID (so every ID has one owner), a custom type or command ID that is neither the extension's ID nor starts with it and a dot, a type or command registered twice, or an entry without its functions throws at construction, as a host programming error. The registry keeps frozen copies of the registered functions, bound to their own objects. `createCustomNode` (a document command) runs the type's `validate`, filling `data` from `defaults()` when the command gives none (`null` is data, not absence; a throwing `defaults()` or one returning `undefined` is `document.invalid-custom-data`); its style defaults are those of a path (no fill, the 1-unit black stroke) and its name defaults to the custom type. `setNodeProps` and `setFrames` re-check a custom node, and `loadDocument` and the constructor check every custom node after the model's rules, in sorted ID order, on deep-frozen values, so `validate` cannot change what is stored: an unowned type is `document.unknown-custom-type` at `.../customType`, data that fails `validate` (or makes it throw) is `document.invalid-custom-data` at `.../data`; the two committed fixtures in `malformed-custom/` are checked by `editor-core`, not `model`. Extension commands run through `execute({ type: 'runCommand', id, args })` (`editor.unknown-command` otherwise) and receive a frozen object with only `execute` and `query`: no `subscribe`, since P5 has no extension lifecycle to hold a subscription, and no store, renderer, GPU or WASM handle (a type-level test checks the key set). Events stay held until the command returns, and each core command it composes is its own undo step; it ends an active drag as any document command does. A command that throws, returns something other than a `CommandResult` with a known code (and, on success, IDs of existing nodes), or nests `runCommand` deeper than 16 returns `editor.extension-failed`; the commands it already composed stay, and a thrown error is rethrown asynchronously, as for listeners. `toScene` output is copied and checked (known verbs in the renderer's path grammar, where a `move` opens every subpath, matching point count, finite numbers, at least one verb); a throwing or malformed `toScene` leaves the node out of the scene and of hit testing, without a diagnostic. Custom nodes are projected and hit tested through that geometry in frame-local page units, so their stroke width, like a path's, is never scaled. `ext.star` is exported from `editor-core` for hosts; it uses only the public types.

P5-U6 notes. The new runtime dependencies are `react` and `react-dom` 19.3.1 and `next` 16.4.3, pinned exactly (P5-Q1); `@vector-studio/react` takes React as a peer (`^19.2.0`). `useEditorSelector` re-reads the snapshot after every editor event, so a selector must return a part of the snapshot or a primitive. The editor snapshot now carries the active tool's `overlay`, and a change to it raises a `session` event with field `overlay` after the command that changed it, so a host redraws the marquee and path anchors without polling. `EditorCanvas` turns pointer drags (moves without a pressed button are ignored) and key presses into `input` commands in page space, `page = camera.position + css / zoom`, and creates its renderer through the host factory inside an effect. Creations on one canvas are chained, so a renderer is released before the next is created (StrictMode runs effects twice in development); a renderer that resolves after unmount is disposed, and `onRendererReady` reports the attach. Only the primary button drags, page points are measured inside the canvas border, and a cancelled pointer cancels the drag as Escape does. The next-host page composes the V-1 renderer (P5-Q8) and serves the kernel WASM from the local build at `/geometry-kernel.wasm`, as the playground's dev server does; `?test=1` exposes the editor and its events to the headed spec. `pnpm build` runs `next build` in CI (P5-A12 build half); the boundary checker now reads `.tsx` sources and the next-host `app/` directory, and rejects `react`, `react-dom` and `next` in `contracts`, `model` and `editor-core`, and `next` in `react`, by manifest and by source. The factory releases everything it created, kernel ports included, on dispose and on any failure. The headed spec waits for `data-renderer="ready"` before it runs, so it cannot pass without the WebGPU renderer. The headed spec needs `pnpm build` and `pnpm test:geometry` and runs with `pnpm test:p5-next-host` on the user's PC.
