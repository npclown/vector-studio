# V-38 contract: rulers, guides and layout grids

Status: APPROVED r3 2026-11-12, Full tier. Visualization-track item [V-38](d9-visualization-track.md#status-index). Requested by the user on 2026-11-12 (item 8 of the Figma gap list in the thread "Compare Vector Studio with Figma, Illustrator, Excalidraw"; the user asked for items 1 to 10). It adds rulers, page guides and frame layout grids to [requirements, editing behavior](../requirements.md#editing-behavior). Questions V38-Q1 to V38-Q7 (section 8) are adopted as recommended under the user's standing instruction of 2026-10-24 (추천안 자동 채택, recommended option auto-adopted).

It changes `model` (two optional fields of schema v8), `editor-core` (one document command, a `setNodeProps` key, two session flags, two keymap actions, snapping to guides and grid lines, a layout-grid geometry helper), `ui` (a Layout grid section of the property panel) and next-host (rulers, guide dragging, the guide and grid overlay, two toggle buttons). It changes no scene contract or renderer: rulers, guides and grids are host overlay, never drawn by the renderer and never exported (V-30). It amends the MVP M2 contract, sections 4.2 (snapping) and 7 (default keymap).

## 1. What a user can do (Figma)

- See a horizontal ruler along the top of the canvas and a vertical one along its left, in page units, following pan and zoom; the selection's extent is shaded on both. Shift+R shows or hides them.
- Drag from the top ruler down to create a horizontal guide, from the left ruler right to create a vertical guide. Drag a guide to move it; drag it back onto its ruler (or off the canvas) to remove it. Guides belong to the page, are saved with the document and undo as one step per drag.
- While moving, resizing or drawing, objects snap to guides as they snap to other objects' edges.
- Give a frame (or symbol) layout grids in the property panel: a uniform grid, columns or rows, each with its colour and visibility. Grids draw over the frame; Ctrl+Shift+4 shows or hides all layout grids. While grids are shown, objects inside or touching a frame snap to its grid lines and column or row edges.

## 2. Document (`model`, schema v8)

**V38-S0 version.** Under the coordinator rule of 2026-11-12, the V-35 thread lands the v8 scaffold (`schemaVersion: 8`, `DocumentV8` and `NodeV8` types, `migrateV7toV8` as identity plus version, the entry points and clipboard fragments at v8). V-38 merges after it and adds its two fields to v8 as optional keys: no further bump, and `migrateV7toV8` adds nothing for them. A v7 input carrying either key fails at that key (`document.invalid-field`), as any unknown key does. If the scaffold has not merged when V-38 takes its merge slot, V-38 waits for it.

**V38-S1 guides.** A v8 page may carry `guides`: an array of at most 1,000 `Guide = { axis: 'x' | 'y'; value: number }`, key order `axis, value`. `axis: 'x'` is a vertical line at page x = `value`; `'y'` a horizontal line at page y = `value`. `value` is finite with `|value| <= 1e7`. Duplicates are allowed. The page key order is `id, name, children, guides`. An empty array is accepted on input and normalized away: the read page has no `guides` key, and none is written.

**V38-S2 layout grids.** A v8 `frame` or `symbol` may carry `layoutGrids`, after `stroke` and before `effects`: an array of at most 16 entries, each

- `{ type: 'grid'; size; color; visible }`: lines every `size` (> 0, <= 1e4) page units from the frame's top-left, both axes; or
- `{ type: 'columns' | 'rows'; count; align; size; gutter; offset; color; visible }` in that key order: `count` an integer in [1, 1000]; `align` one of `stretch`, `start`, `center`, `end`; `size` in (0, 1e7] (the column width or row height, ignored by `stretch`); `gutter` and `offset` in [0, 1e7] (`offset` is the margin for `stretch`, the distance from the aligned side for `start` and `end`, ignored by `center`).

`color` is a `Color` (`r, g, b, a` in [0, 1]), `visible` a boolean. An empty array is normalized away as in S1. The key on any other node type fails at `layoutGrids`; an instance does not draw its source's grids. `detachInstances` and a detached paste give the new frame the source symbol's `layoutGrids` (as E41-S10 does for effects).

**V38-S3 geometry.** `layoutGridLines(width, height, grid): LayoutGridGeometry` (exported by `editor-core`) returns `{ lines, bands }` in the frame's local space (origin at its top-left): `lines` are `{ axis, value }` with the `Guide` axis convention (a column edge is `axis: 'x'`), `bands` are `{ axis, low, high }`.

- grid: on each axis the values `k · size` for whole `k` with `0 < value < extent` (the frame edges are not repeated). An axis that would have more than 4,096 lines has none; the other axis is unaffected (V38-Q5). No bands.
- columns over width `W` (rows the same over height): `stretch` has band width `w = (W − 2·offset − (count − 1)·gutter) / count` and band `i` at `offset + i·(w + gutter)`, no bands when `w <= 0`; `start` puts band `i` at `offset + i·(size + gutter)`; `end` mirrors `start` from `W`, listed left to right; `center` starts at `(W − (count·size + (count − 1)·gutter)) / 2`. Bands are clipped to `[0, W]`, a band with nothing left is dropped, and the lines are the kept bands' edges in band order without repeats.

## 3. Commands and session state (`editor-core`)

**V38-C1 `setGuides`.** `{ type: 'setGuides'; page: string; guides: readonly Guide[] }` replaces the guides of any page as one undo step. Failures, in this order: `page` not a string, `editor.invalid-command` at `/page`; no such page, `editor.unknown-page`; a value S1 refuses, `document.invalid-field` at `/guides` plus the model path (for example `/guides/3/value`). Guides equal to the page's (same length, axes and values in order, after normalization) change nothing and record no step; an empty list removes the key.

**V38-C2 layout grids through `setNodeProps`.** `NodeProps` gains `layoutGrids`, allowed for `frame` and `symbol` only, with `setNodeProps`'s existing rules and codes: an unknown node is `editor.unknown-node`; the key on another type is `editor.invalid-command` at `/props/layoutGrids`; a value S2 refuses is `document.invalid-field` at `/nodes/<id>/layoutGrids/...`. An empty list removes the key. Equal grids follow `setNodeProps` as for any other key. No new command.

**V38-C3 session flags.** The snapshot gains `rulersVisible: boolean` (default false; next-host's studio turns it on at start) and `layoutGridsVisible: boolean` (default true), with queries `{ type: 'rulersVisible' }` and `{ type: 'layoutGridsVisible' }` and session commands `{ type: 'setRulersVisible'; visible }` and `{ type: 'setLayoutGridsVisible'; visible }` (a non-boolean is `editor.invalid-command` at `/visible`). A change raises a `session` event with the field name; neither is history, and both survive `loadDocument` as `snapping` does. Amended by [V41-H2](viz-v41-canvas-background-grid-contract.md#4-commands-rendering-and-overlay) (2026-11-13): the studio turns `layoutGridsVisible` off at start.

**V38-C4 keymap (amends M2 section 7).** Built-in actions `toggleRulers` and `toggleLayoutGrids`, default chords `Shift+R` and `Ctrl+Shift+$` (key tokens as a US layout produces them, M2 section 7; Ctrl on every platform, as Figma, since Cmd+Shift+4 is a macOS screenshot key). The M2 default list and the M2-U8 headed keymap check take both.

## 4. Snapping (amends MVP M2 contract, section 4.2)

**V38-N1 line candidates.** The candidate set of a gesture also holds line candidates, kept apart from the node candidates (spacing, centring and rotation targets never see them):

- every guide of the active page, over the whole page, whether rulers are shown or not;
- while `layoutGridsVisible` is on, the visible grids of each frame or symbol of the active page that is visible through its ancestors, has a page transform that is a translation (no rotation in its chain), and is not a moving node or in a moving node's subtree (a frame being moved or resized does not snap to its own grid; a child moved inside a frame does). Lines are mapped to page space; each keeps its frame's page box.

A line is an align target on its own axis only: `o = c − m` for each moving value of that axis, with the M2 threshold and the tie key `[|o|, 0, c, index, order]`, where `order` continues after every node candidate (guides in page order, then grid lines in frame pre-order and line order). A grid line is offered only when the gesture's raw box `B` (the raw point for a point gesture: a draw corner or a line end) meets its frame's page box (closed). The set is built once per gesture (M2-U3), reading `layoutGridsVisible` then. In the snap overlay a matched line widens the matched value's segment: across the snapped box for a guide, and across the frame for a grid line. At most 20,000 grid lines enter one set: the walk stops at the first frame whose lines would pass that bound (no performance claim is made).

## 5. Host (next-host studio layout and `ui`)

**V38-H1 rulers.** While `rulersVisible` is on, a 20 CSS px ruler runs along the top and the left of the canvas cell, over the canvas, with a corner square; they take the pointer events in their area, and the host forwards wheel events over them to the canvas, so wheel zoom and pan work there as before. Ticks follow the camera: the labelled step is the smallest of 1, 2, 5 × 10^k page units at least 50 CSS px apart, with minor ticks at a tenth of it where they are at least 5 px apart (else at a half, else none). The selection's page-aligned bounds (from the `handles` corners) are shaded on both rulers with their edges labelled. Zoom to fit does not leave room for the rulers (section 7).

**V38-H2 guides.** While rulers are shown, guides draw as 1 CSS px lines (`#ff5a36`) across the canvas, above layout grids and below the selection overlay. A press on the top ruler creates a horizontal guide (`axis: 'y'`), on the left ruler a vertical one (`axis: 'x'`), which follows the pointer. A press within 3 CSS px of a guide picks it up only when the select tool is active with no gesture or edit mode, and the press is not where M2 press precedence would start a resize, an edge resize or a rotation (within 18 CSS px of the selection box, measured in the box's own axes, so handles, edges and the rotate zone keep precedence); the cursor shows `row-resize` or `col-resize` over a pickable guide. The dragged guide is identified by its index at press. During a guide drag the host follows the pressing pointer and consumes pointer events and key presses, so the editor sees none of them; key releases pass, so held-key state stays right. A held Space (the pan gesture) picks up no guide. Window blur or a move with no button down ends the drag unwritten, and the release's click and a following double-click on the canvas cell are swallowed for 500 ms. The value is the pointer's page coordinate rounded to a whole page unit and clamped to ±1e7, shown in a label. On release one `setGuides` writes the page's current guides with the dragged one added, moved or (when the pointer is over its ruler or outside the canvas cell) removed. Escape cancels the drag; a document revision or active page change during the drag cancels it too, so an undo is never reapplied.

**V38-H3 layout grids.** While `layoutGridsVisible` is on, each visible grid of each visible frame or symbol of the active page draws over the canvas in its colour, in the frame's page transform (a rotated frame's grid draws rotated): lines 1 CSS px, bands as filled rectangles. A uniform grid whose spacing is under 2 CSS px is not drawn (it stays snappable); columns and rows always draw. Amended by [V41-H1](viz-v41-canvas-background-grid-contract.md#4-commands-rendering-and-overlay) (2026-11-13): the page's canvas grid draws under them while the flag is on.

**V38-U1 panel.** With exactly one frame or symbol selected, the property panel shows a Layout grid section: `+ Grid` (adds `{ grid, size 10, colour (1, 0, 0, 0.1), visible }`), `+ Columns` and `+ Rows` (add `{ stretch, count 5, size 100, gutter 20, offset 20, colour (1, 0, 0, 0.1), visible }`), and per grid a visible checkbox, its type, colour and opacity, its numbers (size for a grid; count, alignment, size unless stretch, gutter, offset unless center) and remove. Each edit is one `setNodeProps`; invalid text marks the field and sends nothing. Several nodes, or one node of another type, show no section. The studio top bar shows two toggle buttons before the zoom menu, Rulers (Shift+R) and Layout grids (Ctrl+Shift+4), pressed while shown.

## 6. Acceptance criteria

| ID | Criterion | Validation |
| --- | --- | --- |
| V38-A01 | S0 to S2: v8 parses and validates both fields (each bad value fails at its path), normalizes empty lists, writes canonical order, round-trips; v7 input with either key fails at it; detach keeps grids | unit `tests/unit/v38-model.test.ts` |
| V38-A02 | S3 for a grid (incl. the per-axis cap), each column alignment, rows, an over-full stretch and clipping | unit `tests/unit/v38-layout-grid.test.ts` |
| V38-A03 | C1 to C4: one step per command, no step for equal guides, each failure code and path in order, flags with their queries and session events, the chords in the default keymap | unit `tests/unit/v38-commands.test.ts` |
| V38-A04 | N1: a move, a resize and a draw snap to a guide (rulers hidden too) and to grid lines; not to grids when hidden, outside the frame, of the moving frame or a rotated frame, nor with snapping off; a node edge and a guide at one value; overlay segments | unit `tests/unit/v38-snap.test.ts` |
| V38-A05 | Ruler ticks and the guide drag model: create, move, remove on the ruler, cancel, rounding and clamp, pick-up refused with another tool, near the selection box or in its rotate zone | unit `tests/unit/v38-rulers.test.ts` (pure model functions) |
| V38-A06 | U1 model: add, edit and remove grids with one command each; no section for several nodes or a non-frame | unit |
| V38-A07 | Studio: a guide dragged from the top ruler is one undo step and a moved rectangle snaps to it; dragging it back removes it; Escape cancels without leaving the scope; a frame with columns draws them; Shift+R hides the rulers | headed `tests/v38-rulers/v38-rulers.spec.ts` on the main PC, or NOT RUN with the reason |
| V38-A08 | New exports carry TSDoc and enter the M8 export lists and `docs/host-api.md`; M2 keymap docs, `requirements.md` (Editing behavior) and the V-38 track row updated in the contract PR | M8 export-list tests; review |

## 7. Known limits (disclosed)

- Guides belong to the page; Figma's frame-local guides are not in V-38. A guide drag does not snap to objects; it rounds to whole page units.
- A rotated frame's grids draw rotated but do not snap. In a document with more than 20,000 grid lines on a page, frames late in page order do not snap to their grids.
- Rulers measure page coordinates; they do not switch their origin to the selected frame as Figma's do. They cover 20 px of the canvas, and zoom to fit does not account for them.
- Layout grids do not constrain children ("constraints to columns") and are not exported.

## 8. Questions (adopted as recommended, 2026-11-12)

- **V38-Q1 where guides live.** (a) In the document, per page. (b) Session only. Recommended (a): Figma saves them.
- **V38-Q2 storage.** (a) Optional fields of schema v8 under the coordinator's one-version rule. (b) A side store. Recommended (a).
- **V38-Q3 hidden rulers.** (a) Hide guides with the rulers but keep snapping to them. (b) Keep guides visible. Recommended (a), as Figma.
- **V38-Q4 rulers' home.** (a) next-host overlay, with the flags and logic in `editor-core`. (b) A `ui` component. Recommended (a); a `ui` component can follow when an embedder asks.
- **V38-Q5 grid line cap.** (a) 4,096 lines per axis per grid and 20,000 per gesture. (b) Unlimited. Recommended (a).
- **V38-Q6 defaults.** (a) Figma's: grid 10, columns and rows 5 stretch, gutter 20, margin 20, red at 10 %. Recommended (a).
- **V38-Q7 layout grid command.** (a) A `setNodeProps` key. (b) A new command. Recommended (a): no new command surface.

## 9. Record

- r1 independent review 2026-11-12 NOT READY (keymap chord, error codes, schema version, guide pick-up precedence; should-fix on own-frame wording, point gestures, return shape, empty lists, detach, drag robustness, M2 amendment, naming, cost, requirements, ruler geometry, acceptance gaps): all applied in r2. r2 review NOT READY on one item (pick-up exclusion smaller than the M2 rotate zone; should-fix on the line cap cut, requirements and track row, wheel over rulers, the 2 px rule; nits on equal grids and the drag index): all applied in r3, the reviewer's stated condition for READY WITH FOLLOW-UPS; contract approved.
- Implemented on `claude/project-thread-ui86t0` (2026-11-12): A01 to A06 and A08 by the unit tests named in section 6 and the M8 export-list tests; A07 `pnpm test:v38-rulers` 5/5 in the headless smoke project (container Chromium, no WebGPU); headed Chrome and Edge on the main PC owed after the merge. Implementation review NOT READY (B1, B2, S1 to S6) applied in 6067218; re-review READY, its three should-fix items applied. Rebased onto the v8 scaffold (#571, 73d6b68): the fields moved to `PageV8`, `FrameNodeV8` and `SymbolNodeV8` (S6: the v7 types no longer admit them), read only by the `V8` schema; a v7 input or a fragment below v8 carrying either key fails at it.
- Merged 2026-11-12 as #574 (20cb384). Headed on the main PC at 20cb384: `pnpm test:v38-rulers` Chrome 5/5 and Edge 5/5 (16.6 s); `pnpm test:m2-next-host` 10/10 (1.7 min), the every-default-chord check (M2-U8, with Shift+R and Ctrl+Shift+$) passing in both browsers. Editor relaunched at :4194 on 20cb384. A07 done; V-38 DONE.
