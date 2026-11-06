# V-25: editor UI usability plan

Status: slice 1 DONE 2026-11-06 (#511, `82002c1`; review r1 NOT READY applied, r2 READY WITH FOLLOW-UPS applied); slice 2 DONE 2026-11-06 (#512, `f2c48d5`; review r1 NOT READY fixed, r2 READY WITH FOLLOW-UPS fixed); slice 3 DONE 2026-11-06 (#513, `b41a9b6`; review r1 READY WITH FOLLOW-UPS applied); slice 4 DONE 2026-11-06 (#514, `f95ea08`; review r1 NOT READY fixed, r2 READY WITH FOLLOW-UPS applied); slices 5 to 7 DONE 2026-11-06 (#515 `41acd8a`, #516 `a4e6b4c`, #517 `351e0cd`); slice 8 (pen paths and curves) IN REVIEW 2026-11-06; slices 9 to 11 proposed. Tier: Full (product UI behaviour, new `@vector-studio/ui` exports). Track: visualization.

## Request

The user (2026-11-06) found the M8 minimal UI hosted by `apps/next-host` too inconvenient to use, and asked for a Figma or Illustrator style infinite canvas managed per page and per frame (artboard).

## Review of the M8 UI (2026-11-06)

Checked on the main PC's next-host and against the M8 sources (`packages/ui`, `apps/next-host/app/page.tsx`):

1. The canvas is a fixed 960 by 640 CSS px box; a larger window adds no work area.
2. The toolbar is two rows of about 20 text buttons (tools, edit actions, zoom, symbols) with no icons and no shortcut hints.
3. The layer tree is a 240 px block in the right column, above the property panel; the property panel has no padding or section styling.
4. Debug text (revision, scope, node count) shows below the canvas.
5. Frames have no on-canvas name, no size presets and no export.

The M8 layout is kept on purpose for specs and benches: its canvas origin, row heights and right column are the M8-N3 budget, and every headed spec and the E26, E30 and M9 benches open the page with `?test=1` or `?bench=1`.

## Infinite canvas and artboards

The engine already has most of it: the viewport is unbounded (pan, wheel and pinch zoom, zoom to fit and to selection), documents have pages, and `frame` nodes are containers with fill and stroke. What is missing is UI.

Recommendation: no new artboard node type and no schema change. A top-level frame on a page is an artboard, as in Figma. Artboard features (slice 2) are UI over existing frames; export per artboard (slice 11) is a new feature with its own contract.

## Slices

| Slice | Content | State |
| --- | --- | --- |
| 1 | Full-window studio layout: canvas fills the window; top bar with file controls, one-row icon toolbar with tooltips naming each control and its shortcut from the live keymap, zoom menu; left sidebar with pages and a full-height layer tree; right sidebar with properties and extension panels; one-line status bar | Done (#511, `82002c1`) |
| 2 | Artboards: frame names on the canvas (click selects, double-click renames), frame size presets in the frame tool, an artboard list that selects and zooms | Done (#512, `f2c48d5`) |
| 3 | Easy colour picking (swatches and the browser colour picker) and the drawing tools returning to Select after a shape | Done (#513, `b41a9b6`) |
| 4 | Frame adoption: a shape drawn in a frame becomes its child; a shape dropped on a frame moves into it, or out onto the page | Done (#514, `f95ea08`) |
| 5 | Text colour: the colour picker and swatches for the text run colour | Done (#515, `41acd8a`) |
| 6 | Text box outline: text edit mode outlines the edited text's box | Done (#516, `a4e6b4c`) |
| 7 | Readable text on the black canvas: new text and the caret contrast with what lies under them; the outline clears the caret | Done (#517, `351e0cd`) |
| 8 | Pen paths and curves: a new line or path is stroked to read on what lies under it; the pen previews its pending curves, the last anchor's handles and the next segment to the pointer; Alt-drag breaks the handles | In review |
| 9 | Property panel: X/Y/W/H grid, collapsible sections | Proposed |
| 10 | Context menu (right click): group, arrange, delete, symbol actions | Proposed |
| 11 | Export per artboard (SVG, PNG) | Proposed; needs its own contract |

The order after slice 1 is the user's call: on 2026-11-06 the user chose slice 2 (artboards) next, then asked for slice 3 ("make colour picking easy, and always switch to Select when a shape is drawn"), which takes the colour swatches out of the old property panel slice. Slice 4 answers the user's question the same day ("how do I put a shape inside a Frame? I can't find a way"): the only way was cut and paste with the frame selected or entered.

## Slice 1 design

- `@vector-studio/ui` adds `EditorToolbar` (one row: tools, then undo/redo, group/ungroup/mask, symbol/instance/detach, toggle closed/delete) and `ZoomMenu` (the zoom as a whole percentage; zoom in, out, fit, selection and 100% in a menu). Both reuse `toolbar-model.ts` commands, enable rules and test IDs, so they behave as the M8 rows do. Tooltips and menu shortcuts come from the `keymap` query, so a host keymap layer shows its own chords. The components carry `vs-*` class names and no colours. `LayerTree` takes an optional `height` (default 240, unchanged).
- `apps/next-host/src/v25-studio.tsx` is the studio layout: a CSS grid (`240px | 1fr | 280px`, `44px | 1fr | 24px`), its styles scoped under `.vs-studio`. The canvas size follows its cell through a `ResizeObserver`, settled for 120 ms because each size change recreates the renderer.
- The studio is the default for a plain URL. `?test=1`, `?bench=1` and `?layout=legacy` keep the M8 layout unchanged, so no headed spec, M8-N3 budget or bench sees a change.
- Not changed: commands, keymap defaults, document schema, the M8 rows (`ToolbarPrimaryRow`, `ToolbarSecondaryRow`) and their test IDs.

## Acceptance criteria (slice 1)

| ID | Criterion | Method |
| --- | --- | --- |
| V25-A01 | Under `?test=1`, `?bench=1` and `?layout=legacy` the page renders the M8 layout: same canvas host markup, sizes, test IDs and order | M8 and M9 unit suites unchanged in expectation (`m8-u6-next-host`, `m9-u1-bench`); review of `page.tsx` |
| V25-A02 | `EditorToolbar` and `ZoomMenu` run the M8 rows' commands with their enable rules, selection follow-ups and test IDs | Unit markup tests; shared `toolbar-model.ts` |
| V25-A03 | Every toolbar button and zoom menu item is named, and shows its shortcut from the live `keymap` query (per platform, host layer respected) or none | Unit tests against a real editor |
| V25-A04 | The zoom menu opens and closes by click, Escape (focus back on its button), a pick or a press outside; arrow keys move between items | Unit model test; headed check |
| V25-A05 | In the studio the canvas fills its grid cell and follows window resizes once they settle | Unit test of the sizing rule; headed check on the main PC |
| V25-A06 | New `ui` exports carry TSDoc, are in the export lists and in `docs/host-api.md` | `m8-u3-ui-api`, `m8-u6-host-api` tests; review |

## Validation (slice 1)

- Unit: `tests/unit/v25-editor-ui.test.ts` (shortcut labels against a real editor's keymap per platform and with a host layer; toolbar and zoom menu markup and enable rules; the studio switch and canvas sizing); the M8 export lists gain the new names.
- Layout: screenshot of the studio in the container's Chromium (no WebGPU there, so the canvas is empty and the status shows the renderer error).
- Headed: the studio on the main PC (DESKTOP-DKVUSAV) at `ca070af` with the real WebGPU renderer, 2026-11-06: the containers fixture renders; drawing a rectangle selects it and fills the property panel and layer tree; the zoom menu opens; resizing the window from 1440 by 900 to 1100 by 700 resizes the canvas (the renderer is recreated, with a short blank frame). Not an automated spec.
- Zoom menu keys (V25-A04) at `dba53d1` in the container's Chromium (the menu needs no GPU): a click opens it with focus on Zoom in; ArrowDown, End, ArrowDown (wraps to Zoom in) and ArrowUp (wraps to 100%) move focus; Escape closes it with focus on the zoom button; ArrowDown on the button opens it; Enter on Zoom in zooms to 200% and returns focus to the button.
- Unchanged by construction: every headed spec opens `?test=1` or `?bench=1`.

## Follow-ups seen in slice 1

- The canvas outside the document is the renderer's opaque black clear; a grey pasteboard needs a clear-colour renderer option (rendering track).
- A shape tool stays active after drawing (editor behaviour since M1); Figma returns to Select. Done in slice 3 for the studio layout.
- Each settled canvas resize disposes and recreates the renderer (WASM fetched and compiled again, a new device, the glyph atlas rebuilt), with a short blank frame. Bounded by the 120 ms settle; a renderer resize path or a cached compiled kernel is a rendering-track follow-up.

## Slice 2 design: artboards

- An artboard is a top-level frame of the active page (`artboardsOf`, front first like the layer tree); nested frames are not artboards. No schema, command or `ui` export change: everything is in `apps/next-host/src/v25-artboards.tsx`, mounted by the studio layout only.
- Labels: each artboard's name sits just above its top-left corner on the canvas (the corner from `nodePageCorners`, so a rotated artboard's label follows its corner; the label itself is not rotated). A click selects it (`setSelection`), Shift or Mod toggles it, a double-click opens a rename textbox (`setNodeProps name` on Enter or blur, trimmed, nothing sent when empty or unchanged, Escape cancels). Only the labels take pointer events; a label never takes keyboard focus from the canvas, and the canvas gets it back after a rename. Only the first close of a rename acts (Enter or Escape, then the unmount blur, as `useRename` in the layer tree). The label sits over the strip above a selected artboard's top-left corner, so a press there selects rather than starting a resize or rotate from outside the corner; Figma has the same overlap, accepted.
- List: an Artboards section in the left sidebar between Pages and Layers, each row with the name and size; a click selects the artboard and zooms to it (`zoomTo selection`). With none, a hint.
- Presets: while the frame tool is active the right sidebar starts with seven sizes (Desktop 1440 by 1024, Laptop 1280 by 832, Tablet 834 by 1194, Phone 393 by 852, A4 595 by 842, Letter 612 by 792, Square 1080 by 1080). A pick runs one `createFrame` (one undo step) named after the preset, placed 100 units right of the page's artboards and top-aligned with them, or centred in the view when there are none; then it selects the new artboard, returns to the Select tool and zooms to it (session commands).

## Acceptance criteria (slice 2)

| ID | Criterion | Method |
| --- | --- | --- |
| V25-A07 | The artboards are the active page's top-level frames, front first, per page | Unit tests against a real editor |
| V25-A08 | A preset creates one frame (one undo step) with the preset's name and size at the stated place, then selects it, returns to Select and zooms to it | Unit tests; headed check |
| V25-A09 | Labels sit at each artboard's corner in canvas px for the current camera; click, toggle and rename follow the rules above | Unit markup and model tests; headed check |
| V25-A10 | The list shows each artboard with its size and a click selects and zooms to it | Unit markup test; headed check |
| V25-A11 | The M8 layout (`?test=1`, `?bench=1`, `?layout=legacy`) mounts none of it | Review: only `v25-studio.tsx` imports the module |

## Validation (slice 2)

- Unit: `tests/unit/v25-artboards.test.ts` (artboards, placement, preset commands and undo, click and rename rules, the rename guard, markup).
- Layout: the containers fixture in the container's Chromium after a Phone preset: the Phone artboard is placed, selected, labelled and listed, the tool is back on Select.
- Label interactions at the review r1 fix, container Chromium (Playwright, DOM only): a label click selects with focus on the canvas; double-click, type, Enter renames once (one undo restores the old name) with focus back on the canvas; double-click, type, Escape leaves the name unchanged.

## Slice 3 design: colour picking and return to Select

- Return to Select: `EditorOptions.returnToSelect` (default false). When true, the rectangle, ellipse, frame, line and path tools set the tool to `select` after each node they create, right after selecting it; both are session commands, so the shape stays one undo step. A click that creates nothing, an Escape during a drag and a path still collecting anchors keep the tool. A path closed by a double-click on its first anchor closes on the first press; the second press reaches the select tool, so the double-click enters path edit mode on the new path (review note, accepted). The text tool already returns to Select (M6b-Q5 (a)). next-host passes `returnToSelect` in the studio layout only, so the M8 layout under `?test=1`, `?bench=1` and `?layout=legacy` keeps the M2 behaviour every headed spec and bench was written for. This amends M2 (section 1.3 of the M8 contract records it).
- Colour picking, in the shared appearance panel (so the M8 layout shows it too): a solid fill or stroke gets the browser's colour picker (`<input type="color">`, name "Fill colour picker" or "Stroke colour picker") before its hex field. It shows the colour live while the picker is open and commits once on the input's native `change`, so a pick is one `setStyle` and one undo step, as M4-Q13 (a) asks (no live preview in the document). Under fills and strokes that are all empty or solid (mixed colours included), a row of twelve swatches (black, white, two greys, red, orange, yellow, green, teal, blue, purple, pink; group "Fill swatches", buttons "Fill swatch #rrggbb") writes that colour in one click, keeping the alpha of the first solid paint, opaque from none, so a node with no fill gets one without first changing the type. When any selected paint is a gradient, the swatches are hidden (a swatch would replace the gradient), and a gradient shows no picker. The picker drops a draft colour when the document value changes, so a dismissed picker never shows a stale colour. The M4 names, test IDs and commit rules of the existing fields are unchanged.

## Acceptance criteria (slice 3)

| ID | Criterion | Method |
| --- | --- | --- |
| V25-A12 | With `returnToSelect`, a drag with the rectangle, ellipse, frame or line tool, or a finished path, creates one node in one undo step, selects it and sets the tool to `select`; a click that creates nothing or an Escape keeps the tool | Unit tests against a real editor |
| V25-A13 | Without `returnToSelect` (default) or with false, a drawing tool stays active (M2) | Unit test |
| V25-A14 | next-host passes `returnToSelect` in the studio layout only | Review of `page.tsx` (`studioLayout`) |
| V25-A15 | A swatch writes its colour as one solid paint with the first solid paint's alpha, opaque from none; the swatches show when every selected paint is empty or solid and not when any is a gradient, the current one pressed | Unit model and markup tests; headed check |
| V25-A16 | The colour picker shows the solid colour and commits one `setStyle` on its native `change` only | Unit markup test; review; headed check |

## Validation (slice 3)

- Unit: `tests/unit/v25-color-tool-return.test.ts` (each drawing tool with and without the option, no-op click and Escape, `solidFromHex`, the panel markup).
- Full unit suite: 5280 passed; the one failure, `p3-b0r-identity`, fails on main too under the container's Node 22 (environment, not a regression).
- Headed: the studio on the main PC after merge (the relaunch on :4194).

## Slice 4 design: frame adoption

- Request (2026-11-06): the user could not find how to put a shape inside a frame. Before this slice a shape drawn over a frame went on the page, a drop changed no parent (M2-Q10, deferred) and the layer tree has no drag and drop (M8-Q7); only cut, then paste with the frame selected or entered (M2 section 6), did it.
- `EditorOptions.adoptIntoFrames` (default false), set by next-host in the studio layout only, so the M8 layout under `?test=1`, `?bench=1` and `?layout=legacy` keeps M2-Q10 for every headed spec and bench. Logic in `packages/editor-core/src/adopt.ts`.
- Owner at a point (`adoptionOwner`): the innermost visible `frame` whose box holds the point, front first, searching through groups; a frame's children only when the point is inside it, since frames clip. Symbols, mask groups and instances are not entered. With a session scope, the scope's subtree is searched only when the point is in the scope's visible part (inside the scope if it is a frame and inside every frame above it); then the scope itself is the owner when no frame inside it is. Otherwise the page's frames, else the page.
- Drawing: the rectangle, ellipse and frame tools take the owner at the press point and draw the box in the owner's axes (created from its page placement, then resized parent-locally with `setFrames`); the line tool takes the owner at its start, the path tool at its first anchor. One `create` with `parent`, so one undo step as before. When the owner refuses the node (clip or tree depth), it is created on the page, as without adoption.
- Dropping: when a select-tool move or Alt-drag duplicate that moved ends, the owner at the release point (the dragged nodes and their subtrees excluded) adopts each dragged node whose parent is the page or a frame and differs from it, through one `moveNodes` (page placement kept, on top of the owner's children) applied to the gesture before its commit, so the move and the reparent are one undo step. The owner is the page or a frame; nodes in a symbol source and owners in one are left alone (M7 rules), a group's child stays in its group, and a group scope as owner adopts nothing. A top-level frame (an artboard) moves into the frame under the pointer only when its whole box lies inside that frame (a larger frame further out is not tried; review r2 follow-up, accepted), so artboards dragged past each other never nest while a frame can still be nested deliberately. A node dropped out of the session scope ends the scope (set to null after the commit). A drop `moveNodes` refuses (clip or tree depth) leaves the plain move, with no message (review r1 F3, accepted).

## Acceptance criteria (slice 4)

| ID | Criterion | Method |
| --- | --- | --- |
| V25-A17 | With `adoptIntoFrames`, a rectangle, ellipse, frame, line or path drawn inside a frame (the innermost, nested frames included) is created as its child at the drawn page place, one undo step; outside every frame on the page | Unit tests against a real editor |
| V25-A18 | A move dropped on a frame moves the dragged node into it, and one dropped outside its frame moves it onto the page, page placement kept, one undo step with the move | Unit tests |
| V25-A19 | A top-level frame partly over another frame stays on the page and one wholly inside it nests; a group's child stays in its group; a drop out of the scope ends the scope; a press in a scope frame's clipped-away part never reaches its children | Unit tests |
| V25-A20 | Without the option (default) nothing is adopted (M2-Q10), and next-host sets it in the studio layout only | Unit test; review of `page.tsx` |

## Validation (slice 4)

- Unit: `tests/unit/v25-frame-adoption.test.ts` (nested and rotated frame drawing in local coordinates, page fallback, line and path, drop in and out with undo, artboard partly over and wholly inside, scope clipping and scope exit, Alt-drag copy, group child, option off).
- Review r1 NOT READY (B1: a frame scope's child frame was reachable in its clipped-away part): fixed with the visible-part rule above, with F1 (scope exit), F2 (symbol sources), F3 (draw fallback) and F4 (artboards nest when wholly inside) and the F5 tests. Review r2 READY WITH FOLLOW-UPS: the artboard rule is worded as the frame under the pointer.
- Full unit suite: 5290 passed; the only failure is the Node 22 `p3-b0r-identity` environment case, as on main.
- Headed: on the main PC after merge (relaunch on :4194).

## Slice 5 design: text colour picker

- Request (2026-11-06): "the text colour should use the colour picker too".
- The picker and swatches move to `packages/ui/src/color-controls.tsx` (not exported from the package), shared by the appearance panel's solid paints and the text section. The text section's run colour gets the browser colour picker ("Text colour picker") after its hex field, so Tab from Font size still reaches Text colour as the M8 headed spec presses, and the twelve swatches ("Text swatches") below the row. Each writes one `setTextStyle` with the shown colour's alpha (opaque when mixed), on the text edit selection or the whole text, as the hex field.
- Text edit mode (M8-R4): the picker and the swatches carry `data-text-edit-focus` and exit edit mode when focus leaves them for outside that target, as the run fields; a swatch mouse press never takes focus (`mousedown` default prevented), so the canvas keeps the text edit selection. The picker records the run range when it takes focus or is clicked and commits its pick there (`pickedColorCommand`): Chrome's popup on Windows closes on a click outside it and queues its `change` after that click, whose blur can end edit mode or move the caret first (review r1). Both are disabled for a collapsed caret, as the other run fields (M8-Q9 (a)). The fill and stroke swatches now also keep focus where it was.

## Acceptance criteria (slice 5)

| ID | Criterion | Method |
| --- | --- | --- |
| V25-A21 | The text section shows the run colour in a colour picker after the hex field and the swatches, the current one pressed | Unit markup test |
| V25-A22 | A pick or swatch writes the run colour on the text edit selection (or the whole text) in one `setTextStyle`; the picker is in the text edit focus target and both are disabled for a collapsed caret | Unit markup test; review; headed check |

## Validation (slice 5)

- Unit: `tests/unit/v25-text-colour.test.ts` (markup, alpha rule, a pick committed to its opening range after edit mode ended); the slice 3 tests still pass with the shared controls.
- Review r1 NOT READY (B1: the picker's queued `change` could land on the whole text or a moved caret): fixed by the opening-range capture; S1 (keyboard swatches left edit mode) and S2 (write tests) applied.
- Review r2 NOT READY (B2: that click can change the shown colour first, and React writes it into the input before `change`): the picker keeps the last `input` value apart (`pending`) and compares it with the colour shown when it opened. Checked in the container's Chromium on next-host `?test=1` (DOM only): "Hello " red and "world" black, "world" selected, focus and click the picker, an `input` of `#0000ff`, a blur that ends edit mode (the element then shows `#000000`), then `change`: "world" becomes blue and "Hello " stays red.
- Review r3 READY WITH FOLLOW-UPS: only a value the user picked (an `input` since focus) commits, so a popup closed without a pick never writes the colour React put in the input; the opening value follows the document between picks, and a click on the picker that closes its popup keeps the pick. The same DOM check with no `input` leaves both runs unchanged.
- Headed (V25-A22): pick a colour on a selection and close the popup by a click on blank panel space, a click on the canvas over a run of another colour and Enter, with and without picking; only the selection changes, and nothing changes without a pick. macOS (a non-modal colour panel) is not covered.
- Full unit suite: 5298 passed; the only failure is the Node 22 `p3-b0r-identity` environment case, as on main.
- Headed: on the main PC after merge.

## Slice 6 design: text box outline

- Request (2026-11-06): "while typing text the text box border is not visible, which is inconvenient".
- The `handles` query is null in text edit mode (M6b-S1), so the selection box disappears while typing. In the studio layout the page now outlines the edited text's box in the selection blue (`text-edit-box` in the overlay), as Figma does: the edited node's page corners (rotation and nesting included), following the node as typing grows it, or a pending node's page-space frame before its first character (a zero-width line for an `autoWidth` click).
- Host only (`apps/next-host/src/v25-text-box.ts`, `overlay.tsx`, `page.tsx`): the editor, the `textEditOverlay` query (M6b section 4.5) and the M8 layout (`?test=1`, `?bench=1`, `?layout=legacy`) are unchanged.

## Acceptance criteria (slice 6)

| ID | Criterion | Method |
| --- | --- | --- |
| V25-A23 | In the studio layout, text edit mode draws the edited text's box outline in CSS px for the current camera: the node's rotated box, or a pending node's frame; none outside edit mode | Unit tests against a real editor; headed check |
| V25-A24 | The outline follows the node as typing changes its frame | Unit test |
| V25-A25 | The M8 layout draws no outline | Unit markup test; review of `page.tsx` |

## Validation (slice 6)

- Unit: `tests/unit/v25-text-box.test.ts` (6 tests: none outside edit mode, CSS px at a camera and growth on typing, a rotated node, a node in a rotated frame matching its selection box, a pending node, the overlay draws it only when the page passes it).
- Review r1 READY WITH FOLLOW-UPS: the nested case and the include-list order applied. Headed check to look at a pending node in a rotated scope (the outline is the page-space frame the contract names; it should not jump on the first character).
- Headed: on the main PC after merge.

## Slice 7 design: readable text on the black canvas

- Requests (2026-11-06): "the text box outline's right end is not closed properly" (with a screenshot) and "make the default text colour white when the background is black".
- Cause of the first: the WebGPU renderer clears the canvas to opaque black (`native-primitive-scene.ts`, the primitive pass; the studio's grey CSS backdrop only shows when the renderer is down). The M6b caret is drawn black, and at the end of a line it lies exactly on the outline's right edge, so it covered that edge on screen and was itself invisible on black. Measured on the main PC at DPR 1: the glyphs end inside the outline (Arial 16 `asdfsadf`: glyphs to x 359, outline 360.48), so the text does not overflow the box.
- The outline now sits 1 CSS px outside the box along its own axes (`TEXT_BOX_OUTSET`), so the caret never covers it.
- In the studio the caret is white over a dark backdrop and black over a light one; the text tool starts white (the canvas is black), and a text tool press switches the text tool's colour between black and white the same way before it reaches the canvas (`v25-text-colour-default.ts`). The backdrop is the frontmost visible frame, rectangle or ellipse under the point with a mostly opaque fill (fill alpha times node opacity at least 0.5; a gradient by the mean of its stops), frames clipping their children and groups searched through, else the black canvas; dark means relative luminance below 0.179, where black and white text have equal contrast. A colour other than pure black or white (set by the user) is kept.
- Host only; the renderer's clear colour, the editor's default text style and the M8 layout are unchanged. A lighter canvas (Figma's grey) would change the renderer's clear colour and the GPU evidence that compares against it; not done here.

## Acceptance criteria (slice 7)

| ID | Criterion | Method |
| --- | --- | --- |
| V25-A26 | The text edit outline sits 1 CSS px outside the box on every side, along the box's axes | Unit test |
| V25-A27 | In the studio, a text tool press over the black canvas or a dark fill makes new text white, over a light fill black; a user-chosen colour is kept | Unit tests against a real editor; DOM check; headed check |
| V25-A28 | In the studio the caret contrasts with the backdrop under it; the M8 layout keeps the black caret and draws no outline | Review of `page.tsx`; DOM check |

## Validation (slice 7)

- Unit: `tests/unit/v25-text-box.test.ts` (7 tests, with the outset) and `tests/unit/v25-text-colour-default.test.ts` (7 tests: the canvas, a white artboard and a dark child, hidden, transparent and elliptic nodes, ancestor opacity, the studio start and the caret colour, a kept colour, luminance).
- Review r1 READY WITH FOLLOW-UPS, applied: ancestor (group and frame) opacity counts into a fill's opacity; only a primary-button press switches the style; the studio starts the text tool white over the black canvas, so a plain-text paste outside text edit mode reads too. Kept as limits: symbols, instances, paths, lines and other leaves are not read as backdrops (white text over a white instance card stays possible), and a press on existing text also recomputes the tool style (harmless: the next creating press recomputes it).
- DOM check in the container's Chromium on the studio layout (renderer down, DOM only): text tool, click, type `asdfsadf`: the text colour is `#ffffff`, the outline is `299,199 361.48,199 361.48,220.2 299,220.2` and the white caret is at x 360.48, inside it.
- Headed: on the main PC after merge.

## Slice 8 design: pen paths and curves

- Request (2026-11-06): "a path draws, but its stroke or fill sometimes shows and sometimes does not; also make curves possible".
- Cause, reproduced on the main PC (:4194): a pen path is created with no fill and the editor's default path stroke, black 1 px (`DEFAULT_PATH_STROKE`, P5 plan section 14). Over the black canvas (the renderer's clear colour, slice 7) it is invisible; over a white artboard it shows, hence "sometimes". A fill or stroke chosen in the property panel rendered correctly every time (closed triangle, blue fill, white stroke). Lines had the same default.
- Fix: a new editor option `drawStrokeColor(document, page, point)` gives the line and path tools the stroke colour for the first point; the default stroke takes that colour, one undo step as before. Without the option, or when it returns null, throws or returns something that is not a colour, the command's default (black) is kept, so the M8 layout's strokes, the specs and the benches are unchanged (the preview and the Alt cusp below apply in every layout). The studio passes `readableStrokeColor` (`v25-text-colour-default.ts`): white over a dark backdrop, black over a light one, by the slice 7 backdrop rule. A new pen path still has no fill, as in Figma; the property panel sets one.
- Curves: the path tool already made a cubic anchor on press-and-drag (symmetric handles, P5 section 4.4), but the overlay drew a polyline through the anchor points, so a curve looked straight until Enter. The overlay now draws the pending path as the tool will create it (a line where neither end has a handle, else the cubic), the last anchor's handles, and in the studio and M8 layouts the next segment from the last anchor to the pointer (host hover, `v25-pen-preview.ts`; the editor gets no hover events). Over the first anchor of two or more the first anchor fills to show that a press closes the path. With Alt held during the drag only the out handle follows the pointer, so the path turns a corner at the anchor (a cusp); the in handle keeps its last symmetric position (none when Alt is held from the first move, so the segment into the anchor has no in handle), and releasing Alt mid-drag makes the handles symmetric again. The P5 path-tool row and the M8 contract carry the amendment; the next segment is hidden while a button is held.
- Unchanged: Enter finishes an open path, a press on the first anchor closes it, Escape drops the pending anchors (M2).

## Acceptance criteria (slice 8)

| ID | Criterion | Method |
| --- | --- | --- |
| V25-A29 | In the studio a new path or line over the black canvas or a dark fill is stroked white, over a light fill black; without the option (M8 layout) the stroke stays black; a failing or invalid host colour keeps black | Unit tests against a real editor; headed check |
| V25-A30 | The pending pen path is drawn with its curves, the last anchor's handles and the next segment to the pointer, and shows the close over the first anchor | Unit tests (preview and overlay markup); headed check |
| V25-A31 | Alt during a pen drag moves only the out handle; the created path has the cubic segments | Unit test against a real editor |

## Validation (slice 8)

- Unit: `tests/unit/v25-pen-paths.test.ts` (12 tests: white path on the canvas, black line on a white artboard, the black default without or with a failing host colour, symmetric and Alt-broken handles with the created verbs, preview lines and curves, the next segment and the close, the overlay markup at zoom 2), plus review r1 follow-ups: one undo step for a coloured line and path, a cubic closing segment in the preview and the created path, Alt from the first move and released mid-drag, and the preview's close radius pinned to the tool's.
- DOM check in the container's Chromium on the studio layout (renderer down, DOM only): pen, click, then press-and-drag, then hover: the pending path is `M 200 200 C 200 200 300 140 350 200` with both handles of the last anchor and the next segment curving out of the out handle to the pointer; hovering the first anchor sets `data-closing`, a press there closes and selects the path, and the property panel shows its stroke `#ffffff`.
- Headed: on the main PC after merge.
- Review r1 READY WITH FOLLOW-UPS, applied: contract amendments (host API, M8, P5 path row), the tests above, the next segment hidden while a button is held (it went stale during a handle drag), a host colour read inside the tool's guard. Kept: the pen preview re-renders the page on each pointer move while anchors are pending.
- Follow-up (2026-11-06, user: "one pen path draws, the other shows only its selection box; changing its stroke and fill keeps it black"): reproduced on the main PC at :4194 (94cf3c3). A pen click whose pointer jitters about 1 CSS px between press and release made a press-and-drag cubic anchor with handles about 1 px long, and the renderer drew that path as nothing, neither fill nor stroke. Handles of 3.6 and 6 CSS px rendered. Fix: a press that moves less than 4 CSS px (`PEN_DRAG_THRESHOLD`, at the camera zoom) is a click and makes a corner anchor; the threshold does not latch, so a drag that comes back within it is a click too and the pen never makes a handle shorter than 4 CSS px. Unit tests in `tests/unit/v25-pen-paths.test.ts` (15 tests: zoom 2 and 0.5, Alt under the threshold, a drag that comes back). Review r1 READY WITH FOLLOW-UPS applied (M3 contract amendment, tests, the no-latch rule stated). Still open, rendering track (paused by the user 2026-11-01): a path whose cubic has handles about 1 px long renders nothing; path edit mode can still make one by dragging a handle onto its anchor.
