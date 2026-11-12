# V-40 contract: pencil and polygon tools

Status: IMPLEMENTED 2026-11-12, Full tier (a new built-in tool name, a session command and a snapshot field). Visualization-track item [V-40](d9-visualization-track.md#status-index). Requested by the user on 2026-11-12 as item 10 of the Figma gap list ("1~10번까지 다 진행해줘"). Questions V40-Q1 to V40-Q4 (section 6) are adopted as recommended under the user's standing instruction of 2026-10-24 (추천안 자동 채택, recommended option auto-adopted).

It changes `editor-core` (two tools, one session command, one snapshot field and session event field, one default key binding) and `ui` (two toolbar buttons, two icons and a side count field). It changes no document schema, scene contract, renderer or kernel: both tools create ordinary `path` nodes through `createPath`.

## 1. What a user can do

- Pick the pencil (toolbar, or Shift+P) and drag to draw freely. On release the stroke becomes a smooth curve: an open path, or a closed one when the stroke ends near where it started.
- Pick the polygon tool (toolbar) and drag a box. A regular polygon fills the box, first vertex at the top. Shift makes the box square. ArrowUp and ArrowDown during the drag add or remove a side; the toolbar's Sides field (3 to 60) sets the count for the next polygon.
- Either result is one undo step, selected after it is made, and editable as any path (path edit mode, appearance, booleans).

## 2. Tool names and keys

**V40-T1.** `ToolName` gains `'pencil'` and `'polygon'`; `setTool` accepts both. The keymap's tool list includes them.

**V40-T2.** The default keymap binds `Shift+P` to `setTool { tool: 'pencil' }` (Figma's chord). The polygon tool has no default chord (V40-Q3).

**V40-T3.** Both honour the drawing options as the line and path tools do: `returnToSelect`, `adoptIntoFrames` (the owner under the press point; the page when the owner refuses) and, for the pencil, `drawStrokeColor`.

## 3. Pencil

**V40-P1 gesture.** A press begins a gesture; every move adds the pointer point to the samples and replaces the gesture's content with the preview path; the release adds its point, replaces the content with the final path and commits. Escape during the drag cancels the gesture. A stroke that is still a click on release (V40-P3) commits nothing.

**V40-P2 preview.** The preview is the samples, deduplicated and smoothed (V40-P3), as a polyline (`move`, then `line`s), so the drawn line does not shift while it grows.

**V40-P3 final path** (`freehandPath`). All lengths are CSS px divided by the zoom at the press:

1. Samples closer than 1 px to the previous kept sample are dropped (the true end point is kept). Non-finite samples are dropped.
2. Fewer than 2 samples, or a polyline shorter than 3 px, is a click: no path.
3. The stroke closes when it has at least 4 samples, ends within 8 px of its start and is longer than 32 px. The end samples within 1 px of the start are dropped and the loop ends on the start.
4. A moving average (2 samples each side, shrinking at the ends; wrapping for a closed stroke; end points of an open stroke fixed) takes out hand jitter.
5. Cubic Béziers are fitted to the smoothed samples (Schneider, Graphics Gems 1990): least squares with fixed end tangents, up to 8 Newton reparameterisations, split at the worst sample with a shared tangent, until every sample is within 2.5 px of its fitted point. A closed stroke shares one tangent at its start.
6. The result is `move` and `cubic`s, plus `close` when closed (the last cubic ends exactly on the start). Every coordinate is snapped to the 2^-16 px grid (as `ext.star`, #523).

The node is named `Pencil`, with the default path stroke (in `drawStrokeColor`'s colour when given) and no fill.

## 4. Polygon

**V40-G1 gesture.** As the box tools: a press begins a gesture, each move (and the release) replaces its content with the polygon in the box from the press point to the snapped pointer (M2 section 4.2 snapping of the dragged corner); with Shift the box is a square of the larger side, on the pointer's side. An empty box (zero width or height) holds no polygon. Escape cancels; a click commits nothing.

**V40-G2 shape** (`polygonPath`). A regular polygon of n sides with vertex 0 at angle -90° (top), stretched on each axis so that its vertices touch all four sides of the box. Vertex i and its mirror n - i use the same sine and cosine with x negated, so the shape is exactly mirror-symmetric about the vertical axis; coordinates are snapped to the 2^-16 grid. It is a closed path of `line`s with fill rule nonzero, named `Polygon`, filled with the rectangle's default fill and no stroke (as the rectangle and ellipse tools).

**V40-G3 side count.** The session holds `polygonSides`, an integer from 3 to 60, default 3 (Figma's triangle). `setPolygonSides { sides }` sets it; anything else is `editor.invalid-command` at `/sides`. A change raises the session event with field `polygonSides`. During a polygon drag ArrowUp and ArrowDown step it by one, clamped, and redraw; outside a drag the arrows keep their keymap meaning (nudge).

## 5. Validation

- `tests/unit/v40-pencil-polygon.test.ts`: fitting tolerance, closing, click, jitter, zoom, grid; polygon shape, box fit, exact symmetry, refusals; both tools through editor input (undo step, live preview, Escape, Shift, arrow keys, `setPolygonSides`, `returnToSelect`, `drawStrokeColor`, Shift+P).
- `tests/geometry/v40-pencil-polygon-kernel.test.ts`: the fill and a 1 px stroke (miter, bevel, round) of freehand paths (wave, jittered wave, closed loop, back-and-forth scribble at zoom 1 and 4) and polygons (3 to 60 sides) build on the real kernel at exponents -4 to -2.
- Updated expectations: the default keymap (M2-A11), the toolbar tool lists (M8-A10, M6b-U9).
- Headed: the editor's toolbar shows both tools; drawing on the main PC (owed, through the coordinator's PC slot).

## 6. Questions (adopted as recommended, 2026-11-12)

- **V40-Q1 polygon as a node type or a path?** (a) a path (recommended: no schema change, every path feature applies; the side count is not editable after creation, path edit mode is). (b) a parametric node type in schema v8. Adopted (a).
- **V40-Q2 pencil closing.** (a) close when the stroke ends within 8 CSS px of its start (recommended, Illustrator-like; a closed shape can take a fill). (b) never close (Figma). Adopted (a).
- **V40-Q3 polygon chord.** (a) none, toolbar only (recommended; Figma has none and the free letters are wanted by other items). Adopted (a).
- **V40-Q4 default sides.** (a) 3 (recommended, Figma). (b) 5 or 6 (Illustrator). Adopted (a).

## 7. Deferred

Pressure, variable width and a pencil smoothing setting; editing a polygon's side count or corner radius after creation; a star tool (the `ext.star` extension remains the sample).
