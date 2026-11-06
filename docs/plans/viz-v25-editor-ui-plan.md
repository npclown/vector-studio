# V-25: editor UI usability plan

Status: slice 1 IMPLEMENTED 2026-11-06 (this PR); slices 2 to 5 proposed. Tier: Full (product UI behaviour, new `@vector-studio/ui` exports). Track: visualization.

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

Recommendation: no new artboard node type and no schema change. A top-level frame on a page is an artboard, as in Figma. Artboard features (slice 2) are UI over existing frames; export per artboard (slice 5) is a new feature with its own contract.

## Slices

| Slice | Content | State |
| --- | --- | --- |
| 1 | Full-window studio layout: canvas fills the window; top bar with file controls, one-row icon toolbar with tooltips naming each control and its shortcut from the live keymap, zoom menu; left sidebar with pages and a full-height layer tree; right sidebar with properties and extension panels; one-line status bar | Implemented (this PR) |
| 2 | Artboards: frame names on the canvas (click selects, double-click renames), frame size presets in the frame tool, go to an artboard from the layer tree | Proposed, recommended next |
| 3 | Property panel: X/Y/W/H grid, colour swatches, collapsible sections | Proposed |
| 4 | Context menu (right click): group, arrange, delete, symbol actions | Proposed |
| 5 | Export per artboard (SVG, PNG) | Proposed; needs its own contract |

The order after slice 1 is the user's call (decision card 2026-11-06).

## Slice 1 design

- `@vector-studio/ui` adds `EditorToolbar` (one row: tools, then undo/redo, group/ungroup/mask, symbol/instance/detach, toggle closed/delete) and `ZoomMenu` (the zoom as a whole percentage; zoom in, out, fit, selection and 100% in a menu). Both reuse `toolbar-model.ts` commands, enable rules and test IDs, so they behave as the M8 rows do. Tooltips and menu shortcuts come from the `keymap` query, so a host keymap layer shows its own chords. The components carry `vs-*` class names and no colours. `LayerTree` takes an optional `height` (default 240, unchanged).
- `apps/next-host/src/v25-studio.tsx` is the studio layout: a CSS grid (`240px | 1fr | 280px`, `44px | 1fr | 24px`), its styles scoped under `.vs-studio`. The canvas size follows its cell through a `ResizeObserver`, settled for 120 ms because each size change recreates the renderer.
- The studio is the default for a plain URL. `?test=1`, `?bench=1` and `?layout=legacy` keep the M8 layout unchanged, so no headed spec, M8-N3 budget or bench sees a change.
- Not changed: commands, keymap defaults, document schema, the M8 rows (`ToolbarPrimaryRow`, `ToolbarSecondaryRow`) and their test IDs.

## Validation (slice 1)

- Unit: `tests/unit/v25-editor-ui.test.ts` (shortcut labels against a real editor's keymap per platform and with a host layer; toolbar and zoom menu markup and enable rules; the studio switch and canvas sizing); the M8 export lists gain the new names.
- Layout: screenshot of the studio in the container's Chromium (no WebGPU there, so the canvas is empty and the status shows the renderer error).
- Headed: the studio on the main PC with the real renderer (draw, select, resize the window, zoom menu). Recorded in the PR.
- Unchanged by construction: every headed spec opens `?test=1` or `?bench=1`.
