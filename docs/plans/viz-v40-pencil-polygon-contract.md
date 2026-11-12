# V-40 contract: pencil and polygon tools

Status: IN REVIEW 2026-11-12 (implemented in #570; headed check owed), Full tier (a new built-in tool name, a session command and a snapshot field). Visualization-track item [V-40](d9-visualization-track.md#status-index). Requested by the user on 2026-11-12 as item 10 of the Figma gap list ("1~10번까지 다 진행해줘"). Questions V40-Q1 to V40-Q4 (section 6) are adopted as recommended under the user's standing instruction of 2026-10-24 (추천안 자동 채택, recommended option auto-adopted).

The contract and the implementation were reviewed together by one independent review (section 8), written the same day as the user's request.

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
4. A moving average takes out hand jitter (about ±2 px at the 1 to 2 px sample spacing of an ordinary drag): each sample is averaged with the same count of neighbours on each side, the window growing while its two ends are within 12 px of each other in a straight line (at most 8 each side; at most a quarter of the loop for a closed stroke; the end points of an open stroke fixed). Jitter barely changes that span, while samples spaced far apart (a quick flick) stop it at once, so a sparse stroke keeps its size; the preview changes only near its tip. A stroke the smoothing would shrink below half its box diagonal (a tiny scribble) is fitted as drawn.
5. Cubic Béziers are fitted to the smoothed samples (Schneider, Graphics Gems 1990): least squares with fixed end tangents, up to 8 Newton reparameterisations, split at the worst sample with a shared tangent, until every sample is within 2.5 px of its fitted point (a split depth bound of 64, reached only by pathological input, ends the split without that guarantee; a tangent length outside (0, 2 × chord] falls back to a third of the chord). A closed stroke shares one tangent at its start.
6. The result is `move` and `cubic`s, plus `close` when closed (the last cubic ends exactly on the start). Every command coordinate is snapped to the 2^-16 px grid. A result whose box diagonal is under 3 px makes no path.

The node is named `Pencil`, with the default path stroke (in `drawStrokeColor`'s colour when given) and no fill.

## 4. Polygon

**V40-G1 gesture.** As the box tools: a press begins a gesture, each move (and the release) replaces its content with the polygon in the box from the press point to the snapped pointer (M2 section 4.2 snapping of the dragged corner); with Shift the box is a square of the larger side, on the pointer's side, and the corner does not snap (as the line tool's Shift), so no guide marks a point the corner is not on. An empty box (zero width or height) holds no polygon. Escape cancels; a click commits nothing.

**V40-G2 shape** (`polygonPath`). A regular polygon of n sides with vertex 0 at angle -90° (top), stretched on each axis so that its vertices touch all four sides of the box. Vertex i and its mirror n - i use the same sine and cosine with x negated, so the command points are exactly mirror-symmetric about the vertical axis and on the 2^-16 grid. `createPath` stores the points in unit coordinates of the frame, so the geometry the renderer receives (unit points times the frame size) keeps that symmetry only up to rounding; the kernel test (section 5) checks that stored geometry, fill and stroke, directly (rendering-track E36 is the open almost-mirrored stroke failure). It is a closed path of `line`s with fill rule nonzero, named `Polygon`, filled with the rectangle's default fill and no stroke (as the rectangle and ellipse tools).

**V40-G3 side count.** The session holds `polygonSides`, an integer from 3 to 60, default 3 (Figma's triangle). `setPolygonSides { sides }` sets it; anything else is `editor.invalid-command` at `/sides`. A change raises the session event with field `polygonSides`. During a polygon drag ArrowUp and ArrowDown step it by one, clamped, and redraw; outside a drag the arrows keep their keymap meaning (nudge).

**V40-G4 Sides field.** `EditorToolbar` shows `polygon-sides` while the polygon tool is active: typed text applies on Enter or blur (Escape reverts), ArrowUp and ArrowDown in the field step the count at once, and a refused value shows its code. The M8 `ToolbarPrimaryRow` lists the polygon tool without the field; there the count changes with the arrow keys during a drag or with `setPolygonSides`.

## 5. Validation

- `tests/unit/v40-pencil-polygon.test.ts`: fitting tolerance, closing, click, jitter, zoom, grid; polygon shape, box fit, exact symmetry, refusals; both tools through editor input (undo step, live preview, Escape, Shift, arrow keys, `setPolygonSides`, `returnToSelect`, `drawStrokeColor`, Shift+P).
- `tests/geometry/v40-pencil-polygon-kernel.test.ts`: the fill and a 1 px stroke (miter, bevel, round) of freehand paths (wave, jittered wave, closed loop, back-and-forth scribble at zoom 1 and 4) and polygons (3 to 60 sides) build on the real kernel at exponents -4 to -2, both for the command points and for the stored geometry as the projector scales it.
- Updated expectations: the default keymap (M2-A11), the toolbar tool lists (M8-A10, M6b-U9).
- Headed: the editor's toolbar shows both tools; drawing on the main PC (owed, through the coordinator's PC slot).

## 6. Questions (adopted as recommended, 2026-11-12)

- **V40-Q1 polygon as a node type or a path?** (a) a path (recommended: no schema change, every path feature applies; the side count is not editable after creation, path edit mode is). (b) a parametric node type in schema v8. Adopted (a).
- **V40-Q2 pencil closing.** (a) close when the stroke ends within 8 CSS px of its start (recommended, Illustrator-like; a closed shape can take a fill). (b) never close (Figma). Adopted (a).
- **V40-Q3 polygon chord.** (a) none, toolbar only (recommended; Figma has none and the free letters are wanted by other items). Adopted (a).
- **V40-Q4 default sides.** (a) 3 (recommended, Figma). (b) 5 or 6 (Illustrator). Adopted (a).

## 7. Deferred

Pressure, variable width and a pencil smoothing setting; editing a polygon's side count or corner radius after creation; a star tool (the `ext.star` extension remains the sample).

## 8. Review

Independent review (fresh-context reviewer, contract and diff together), 2026-11-12: NOT READY with B1 (a sparse pencil loop collapsed under the wrapped smoothing window) and B2 (the polygon's symmetry claim held for the command points only, and the kernel test did not check the stored geometry), S1 (the Sides field applied typed digits as spinner steps), S2 (process record), S3 (`adoptIntoFrames` untested), S4 (Shift-squared polygon showed a snap guide off its corner), nits N1 to N4. Applied: B1 (window cap, no smoothing under 8 samples, collapsed results refused, sparse-loop test), B2 (sections 3 and 4 reworded, kernel test on the stored geometry: PASS), S1 (Enter or blur only, arrow steps, model functions tested), S2 (this section, status), S3 (tests), S4 (no snapping under Shift, test), N1 (a refused final replace clears the preview), N2 and N3 (sections 3 and 4). N4 (a box under 2^-16 px) is unreachable within the zoom limits and left.

Round 2 (2026-11-12, fix commit reviewed): NOT READY on loops of 8 to 13 samples still shrinking (the sample-count window) and the test not catching it; should-fix: the per-axis extent check refused 45° strokes of 3 to 4.2 px and tiny scribbles, the preview jumped at the 8th sample, the kernel test lacked sparse inputs. Applied: the distance-measured window above (no sample-count threshold), the diagonal check, a loop test over 4 to 40 samples at radii 10, 30 and 100 measuring the curve (at least 90 % of the drawn width), 3 px strokes in four directions, a preview stability test, and sparse loops and a flick in the kernel test. The Sides field's mouse spinner still applies on blur or Enter (nit, noted).

Round 3 (2026-11-12): NOT READY: the round-2 window, measured along the noisy samples, mostly stopped smoothing ±1.5 to 2 px jitter (46 to 85 cubics for a stroke the round-1 code fitted with 4 to 7), and the jitter test passed with smoothing off. Applied: the window is bounded by the straight-line span of its ends (step 4), and the jitter test now uses seeded ±2 px noise at 1 and 2 px spacing on a line, an S-curve and a circle, requiring the smoothing to remove at least 40 % of the RMS error and the fit to stay within 8 cubics of the clean stroke (it fails with smoothing off).
