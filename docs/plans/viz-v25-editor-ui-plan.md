# V-25: editor UI usability plan

Status: slice 1 DONE 2026-11-06 (#511, `82002c1`; review r1 NOT READY applied, r2 READY WITH FOLLOW-UPS applied); slice 2 DONE 2026-11-06 (#512, `f2c48d5`; review r1 NOT READY fixed, r2 READY WITH FOLLOW-UPS fixed); slice 3 IN REVIEW 2026-11-06; slices 4 to 6 proposed. Tier: Full (product UI behaviour, new `@vector-studio/ui` exports). Track: visualization.

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

Recommendation: no new artboard node type and no schema change. A top-level frame on a page is an artboard, as in Figma. Artboard features (slice 2) are UI over existing frames; export per artboard (slice 6) is a new feature with its own contract.

## Slices

| Slice | Content | State |
| --- | --- | --- |
| 1 | Full-window studio layout: canvas fills the window; top bar with file controls, one-row icon toolbar with tooltips naming each control and its shortcut from the live keymap, zoom menu; left sidebar with pages and a full-height layer tree; right sidebar with properties and extension panels; one-line status bar | Done (#511, `82002c1`) |
| 2 | Artboards: frame names on the canvas (click selects, double-click renames), frame size presets in the frame tool, an artboard list that selects and zooms | Done (#512, `f2c48d5`) |
| 3 | Easy colour picking (swatches and the browser colour picker) and the drawing tools returning to Select after a shape | In review |
| 4 | Property panel: X/Y/W/H grid, collapsible sections | Proposed |
| 5 | Context menu (right click): group, arrange, delete, symbol actions | Proposed |
| 6 | Export per artboard (SVG, PNG) | Proposed; needs its own contract |

The order after slice 1 is the user's call: on 2026-11-06 the user chose slice 2 (artboards) next, then asked for slice 3 ("make colour picking easy, and always switch to Select when a shape is drawn"), which takes the colour swatches out of the old property panel slice.

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
