# V-41 contract: canvas background and canvas grid colours

Status: DONE 2026-11-13 (#601, `cadfcee`; headed record in section 9), Full tier (two optional page fields of schema v8, a document command, an optional renderer synchronization method and a host overlay). Visualization-track item [V-41](d9-visualization-track.md#status-index). Requested by the user on 2026-11-13: "현재 전체 캔버스의 배경색을 고를수 잇는 기능이 필요하고, Grids를 눌렀을떄 그리드가 안보이는데 이것도 색상을 고를수 잇게 해줘" (a picker for the whole canvas background, and the Grids toggle shows no grid; let the grid colour be picked too). Questions V41-Q1 to V41-Q5 (section 8) are adopted as recommended under the user's standing instruction of 2026-10-24 (추천안 자동 채택, recommended option auto-adopted).

Process note: the implementation was started in the same branch while the r1 contract review ran, the way V-40 reviewed contract and implementation together; r1 (NOT READY) asked for this record, the acceptance list (section 6) and the disclosures (section 7), all added in r2 before the implementation review.

It changes `contracts` (one optional method of `RendererSceneSynchronization`), `model` (two optional page fields of the unreleased v8, admitted by the 2026-11-13 amendment of the [v8 rule](viz-schema-v8.md)), `editor-core` (one document command; the projector sends the clear colour), `renderer-core` and `renderer-webgpu` (the main pass clears to the given colour), `ui` (a Canvas section of the property panel) and next-host (the canvas grid overlay, the studio's start state, the backdrop colour). It amends [V-38](viz-v38-rulers-guides-grids-contract.md) V38-C3 and V38-H3 (section 4).

## 1. Diagnosis

The V-38 `Grids` toggle (`layoutGridsVisible`) draws only frame layout grids (V38-H3). A page whose frames have no `layoutGrids` draws nothing, so the toggle looks broken; there is no canvas-wide grid. The canvas background is the WebGPU main pass's fixed clear colour, opaque black (`native-primitive-scene.ts`), and nothing can change it.

## 2. What a user can do

- With nothing selected, the property panel shows a **Canvas** section: the page's background colour (hex field and picker), the grid colour (hex field, picker and opacity in %) and the grid size in page units. Each change is one undo step and is saved with the document, per page (Figma's page background).
- Press **Grids** (or Ctrl+Shift+4): a grid covers the whole canvas in the page's grid colour, following pan and zoom, with frame layout grids as before. Press again to hide both.

## 3. Document (`model`, schema v8)

**V41-S1 background.** A v8 page may carry `background: Color`, opaque: `r, g, b` in [0, 1] and `a` exactly 1 (anything else fails at `/pages/<i>/background/<key>`). Absent means `DEFAULT_PAGE_BACKGROUND = { r: 0, g: 0, b: 0, a: 1 }`, today's clear colour, so every existing document draws as before. A value equal to the default is kept as given.

**V41-S2 grid.** A v8 page may carry `grid: { size: number; color: Color }`, key order `size, color`, `size` in (0, 1e4] (`MAX_GRID_SIZE`, as V38-S2), `color` any `Color`. Absent means `DEFAULT_PAGE_GRID = { size: 10, color: { r: 0.5, g: 0.5, b: 0.5, a: 0.35 } }`, mid grey that shows on a dark and on a light background.

**V41-S3 versions.** Both keys are read only by the `V8` parse schema (the V-38 `layout: 'read'` dimension, which every schema reading an older input leaves unset), so a v7 input carrying either fails at that key and an older input reads with both absent. The page key order is `id, name, children, guides, background, grid`; an absent field is not written. `validatePageBackground(value)` and `validatePageGrid(value)` check a value with these rules for the command (paths relative to the value).

## 4. Commands, rendering and overlay

**V41-C1 `setPageCanvas`.** `{ type: 'setPageCanvas'; page: string; background?: Color | null; grid?: PageGrid | null }` sets the two fields of any page as one undo step. A key that is absent or `undefined` leaves its field unchanged; `null` removes the field (back to the default). Failures, in this order: `page` not a string, `editor.invalid-command` at `/page`; no such page, `editor.unknown-page`; a background S1 refuses, `document.invalid-field` at `/background` plus the model path (for example `/background/a`); then a grid S2 refuses, at `/grid` plus the path. A command that leaves both fields as they are (equal values, or neither key) changes nothing and records no step.

**V41-R1 clear colour (`contracts`).** `RendererSceneSynchronization` gains the optional `setClearColor?(color: SceneColor): void`: the colour the renderer clears the canvas to before drawing the scene, straight (not premultiplied) alpha. A colour with a component that is not finite or outside [0, 1] is ignored. A renderer without the method keeps its own background; the projector skips it.

**V41-R2 projector (`editor-core`).** After each `replace` and `change` (attach, load, page switch, every document change including undo and redo) the scene projector sends the active page's background (S1 default when absent) through `setClearColor`, only when it differs from the colour it last sent; a new attach is a new projector, so it sends once.

**V41-R3 renderer (`renderer-core`, `renderer-webgpu`).** `PrimitiveRendererService.setClearColor` keeps the colour and, when it changes, invalidates with reason `'scene'` (as the image source does; `prepare` returns a packet for any held scene and camera, so the frame redraws). `PrimitiveFrameSource` gains the optional `clearColor?: SceneColor`; the WebGPU backend hands it (opaque black when absent) to the primitive scene's optional `setClearColor` before each submit, so device recovery keeps it; the main pass's first segment clears to it premultiplied (resumed segments load, MSAA resolves on the last segment). Layer, mask and capture passes keep their transparent clears. With the default colour the GPU call log is unchanged (the E10 golden log).

**V41-H1 canvas grid (next-host, amends V38-H3).** While `layoutGridsVisible` is true the host overlay draws the page grid over the whole canvas: vertical and horizontal lines at page multiples of `step`, where `step` starts at `size` and doubles (at most 64 times) until `step · zoom >= 8` CSS px, as one SVG path (`data-testid="canvas-grid"`, `data-step`) stroked in the grid colour at 1 CSS px, before (under) the layout grids and guides in the same overlay, no pointer events, never exported. A step still under 8 CSS px after the 64 doublings (a tiny size at a small zoom) draws nothing, so the overlay draws at most about width / 8 + 1 lines per axis. The overlay lies over the WebGPU canvas, so the grid draws over the document's shapes (section 7). The Grids button's tooltip names both grids.

**V41-H2 studio start (amends V38-C3).** The editor's default stays `layoutGridsVisible: true`. The studio layout turns it off at start, as it turns rulers on, so the grid is hidden until Grids is pressed (V41-Q2). The M8 layout keeps the editor default.

**V41-H3 backdrop.** `backdropColor` (`v25-text-colour-default.ts`) falls back to the active page's background instead of the fixed black. It feeds the readable default text colour on a text tool press (V-25 slice 7), the text caret's contrast and the readable pen and line stroke colour (slice 8). `canvasTextStyle`, the studio's start style, still assumes the default black canvas; the first text press over a light background then switches the colour to black.

**V41-U1 Canvas section (`ui`).** `PropertyPanel` renders `CanvasSection` (`data-testid="canvas-panel"`, legend "Canvas") after the property sections when the selection is empty, for the active page: fields labelled `Canvas background`, `Canvas grid colour`, `Canvas grid opacity` (0 to 100 %) and `Canvas grid size`, and the pickers `canvas-background-picker` and `canvas-grid-colour-picker`. The background is written opaque (the fields take `#rrggbb`; an 8-digit hex is refused, as S1 allows no alpha); the grid colour keeps its opacity and size when its hex changes, and so on for each field. Each commit runs one `setPageCanvas`; a text that is not a value, or a refused command, marks the field `aria-invalid`. It adds nothing to toolbar row 1 (M8 row-1 headroom unchanged).

## 5. Validation

`tests/unit/v41-canvas.test.ts` holds A1 to A7; A8 is headed.

## 6. Acceptance criteria

- **V41-A1** S1 to S3: both fields read at v8 with the stated refusals and paths (including a translucent background), defaults when absent, key order and omission on write, round trip; a v7 input with either key fails, an older input reads without them; the UI defaults equal the model's.
- **V41-A2** C1: set, partial, `null` removes, one undo step each, undo restores; no step for an equal value or an empty command; refusals in the stated order.
- **V41-A3** R2: with a recording renderer the colour is sent on attach, on a background change, on undo and on a page switch, not again for an unrelated change; it reaches the method through a forwarding Proxy (the next-host wrappers); a renderer without the method attaches.
- **V41-A4** R3: the service keeps a valid colour, ignores invalid ones and invalidates `'scene'` only on a change.
- **V41-A5** H1: the step rule, the path of the visible lines, a bounded line count, and no lines for a tiny size at a small zoom.
- **V41-A6** H3 and U1: the backdrop and caret over an empty light page, and each field's command.
- **V41-A7** R3 in the recorded WebGPU harness: the first main pass clears to opaque black, and after `setClearColor({ r: 1, g: 0.5, b: 0, a: 0.5 })` to its premultiplied value; the E10 golden log (`e10-default-invariance`) stays equal.
- **V41-A8** headed, main PC through the coordinator: `test:v38-rulers` Chrome and Edge (adjusted for H2, with the canvas grid shown after Grids), m8 36/36, and a pixel check that a white page background lands in the captured frame while the default page stays black.

## 7. Disclosures

- A V-35 blend mode or V-36 background blur on a top-level layer over the empty canvas now meets the page background instead of black; exports draw no background (V41-Q4), so such a layer can look different on screen and in an export unless the background is the default.
- The canvas grid draws over the document's shapes (overlay), as V-38's layout grids already do.
- With grids hidden at the studio's start (H2), snapping to frame layout grid lines (V-38 section 4) is off until Grids is pressed; guide snapping is unaffected.

## 8. Questions (adopted as recommended, 2026-11-13)

- **V41-Q1 where the colours live.** (a) per page, in the document, undoable and saved (recommended, Figma's page background). (b) a session or host setting. Adopted (a).
- **V41-Q2 grid default in the studio.** (a) hidden at start, Grids shows it (recommended: the canvas stays as it is until asked). (b) shown at start. Adopted (a).
- **V41-Q3 one toggle.** (a) Grids shows the canvas grid and the frame layout grids together (recommended: no new top bar button). (b) a separate canvas grid toggle. Adopted (a).
- **V41-Q4 exports.** (a) the background is not exported (recommended: the background is the canvas, as in Figma, and V-30 stays as recorded). (b) export it. Adopted (a).
- **V41-Q5 default background.** (a) keep today's black (recommended: no change to existing documents or GPU baselines). (b) Figma's light grey. Adopted (a).

## 9. Review and record

- Contract review r1 (2026-11-13): NOT READY, two blocking (v8 rule scope, no acceptance list) and eight should-fix findings; all applied in r2 (rule amended; sections 6 and 7; opaque background; precise amendments, call sites, order and step rule; host-api and track row).
- Implementation review r1 (2026-11-13): NOT READY, one blocking finding (an unbounded canvas grid line count for a tiny size at a small zoom) and four should-fix; the blocking one, the record, the hex note and the headed spec's renderer assertion are applied. Follow-up, not taken: a recorded WebGPU case with a blend split (the resumed segment loads; the code path is shared with V-35 and unchanged).
- Implementation review r2 (2026-11-13): READY WITH FOLLOW-UPS (A8 headed evidence; the recorded blend-split case stays a follow-up).
- Headed record (main PC, 2026-11-13, at `11eed15`, Chrome 157.0.8103.51 and Edge 157.0.4341.46): `test:m8-next-host` 36/36; `test:v38-rulers` 11/12 with the V41-U1/A8 test (Canvas section and captured-frame white-background pixel) passing in both browsers. The one failure, [edge] "a guide from the top ruler" (the dropped guide stayed), passed 3/3 on an Edge `--repeat-each 3` rerun and in Chrome; judged a flake outside V-41 (no frames in that test, grids start hidden, the canvas grid overlay takes no pointer events, the right column is a fixed 280 px). `cd8bbc3`, the merged head, changed only the grid path guard, the spec's renderer assertion and docs. Merged as #601 (`cadfcee`).
