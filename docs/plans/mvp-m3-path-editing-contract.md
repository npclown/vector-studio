# MVP M3 contract: path editing

Status: DRAFT 2026-10-28, in independent review; Full tier (public commands, session state, product behavior). Visualization-track item [V-10](d9-visualization-track.md#status-index), milestone M3 of the [MVP editor plan](mvp-editor-plan.md#m3-path-editing), after M2 ([V-9](d9-visualization-track.md#status-index), [contract](mvp-m2-interaction-contract.md), [exit record](../evidence/m2-exit-2026-10-28.md), user acceptance pending). Open questions M3-Q1 to M3-Q13 (section 10) each carry a recommended option; under the user's standing instruction of 2026-10-24 the recommended options are adopted on approval unless one narrows a requirement (none does).

Owners: this file owns M3 scope, the path anchor model, the path commands and their failure codes, the re-normalization rule, path edit mode and its session state, the edit-mode gestures, the `pathOverlay` query, acceptance criteria M3-A01 to M3-A13 and the units. Product behavior stays in [`requirements.md`](../requirements.md) (Path editing), which this contract does not change; the milestone order in the MVP plan; the P5 rules ([P5 plan](p5-editor-slice.md): transactions, gestures, history, events, the section 3.1 unit-box rule), the M1 rules ([M1 contract](mvp-m1-document-v2-contract.md): schema v2, parent-local frames, rotation, group refit, hit testing) and the M2 rules ([M2 contract](mvp-m2-interaction-contract.md): input dispatch M2-I2, `consumed`, gesture `replace` (S1), scope, snapping, keymap) stay in force except as section 1.2 lists.

## 1. Scope

In scope: a path edit mode on `path` nodes, entered by double-click or the `enterScope` action (Enter) and exited by Escape, Enter, a click outside and selection changes; anchor and handle selection and drag; handle symmetry (mirrored and independent); node insertion on line and cubic segments; node removal; closing and opening subpaths; multi-anchor selection, marquee and nudge; point snapping of a dragged anchor; re-normalization of frame and unit-box points inside every edit; an anchor overlay query for hosts; a next-host page and headed spec.

Out of scope: schema changes (M3 adds no persisted field, so no migration, M3-Q1); the `aligned` symmetry mode (M3-Q2); editing `line`, `rectangle`, `ellipse` and `custom` nodes as paths, and a flatten-to-path command (M3-Q7); continuing a path from an endpoint with the path tool, joining two endpoints, splitting an open subpath at a segment (M3-Q5); snapping handles or snapping to the path's own anchors (M3-Q6); Shift constraints on anchor and handle drags; curve fitting on removal (M3-Q3); property-panel path controls (M8). Performance note (no gate): every path edit re-projects the edited node only; M3 makes no performance claim.

### 1.1 Starting point (main at ccb4b56)

- **Path data.** `PathData = { verbs, points, fillRule }` with interleaved points in the unit box `[0, 1]²` of the node's frame (P5 section 3.1; `packages/model/src/types.ts`). The model's `readPathData` (`packages/model/src/parse.ts`) and the renderer's `hasPathGrammar` (`packages/renderer-core/src/scene-validation.ts`) check the same **path grammar**: `move` opens a subpath, `line` and `cubic` need an open one, `close` ends one; `move` and `line` take one point, `cubic` three, `close` none; the point count must match. The grammar allows an empty path, a `move` followed by `move`, and `move`, `close`.
- **No public command changes path data.** `setNodeProps` has no `path` prop; only resize maps points (M1 section 4.4, group resize). `fitPoints` (`packages/editor-core/src/geometry.ts`) fits a frame and unit points to parent-space points.
- **Path tool** (`tools.ts`, `createPathTool`). Click adds a line anchor, press-and-drag a cubic anchor with mirrored handles (`in = 2·point − out`); a segment is a `line` when neither end has a handle, else a `cubic` with `c1 = from.out ?? from.point`, `c2 = to.in ?? to.point`. A closed path is written with an explicit closing segment back to the first anchor's point, then `close`.
- **Select tool.** M2 frame entry: a `doubleclick` whose target is a container enters it; on a leaf target it does nothing (M2 section 5, U5 notes). The `handles` query (M1 section 7) and the resize, rotate, Alt-drag and overlap-cycling gestures act on the node selection. Hit testing flattens outlines uniformly in t with Wang's segment count at `0.25 / zoom` (`hit-test.ts`, `flatten`); `snapPoint` (`snap.ts`) snaps a single page point.

### 1.2 Changes to M1 and M2 rules

- M1 section 7: the `handles` query is null while a path is in edit mode (section 4).
- M2 section 5: a `doubleclick` whose target is a path, and the `enterScope` action on a single selected path, enter edit mode instead of doing nothing; `exitScope` and `enterScope` in edit mode exit it instead of their M2 effect.
- M2 section 7: in edit mode the `delete`, `nudge` and `selectAll` actions act on anchors, whichever keymap layer binds them.
- M2 sections 4.1 and 5: resize, rotate, Alt-drag duplication and overlap cycling are off in edit mode.
- M2 section 6: copy and cut act on the whole edited node (the selection is `[id]`); paste selects the pasted roots and so ends edit mode.
- M2-I2 and U7 note 8: a tool reset (`pointercancel`, blur) cancels a gesture but does not end edit mode.

## 2. Path anchor model

The anchor model is a function of the stored `PathData`; editing reads it, changes it and writes it back (section 3). Positions in this section are in **node-local units**: a stored unit point `(u, v)` is `L = (u·W, v·H)` with `W, H` the frame's width and height; equality tests compare stored unit values (section 3.1, provenance).

- **M3-P1 subpaths.** Subpath `s` (from 0) is the run of verbs from a `move` up to the next `move` or the end. It is **closed** when it ends with `close`. Its **segments** are its `line` and `cubic` verbs, in order. Anchor 0 is the `move` point; the end point of segment `k` is anchor `k + 1`, except in the **explicit closing form**: a closed subpath with at least one segment whose last segment ends at exactly the stored point of anchor 0 (both unit coordinates equal) has that end point as anchor 0 again. So an explicitly closed subpath with `m` segments has `n = m` anchors; any other subpath has `n = m + 1`, and a closed one in the **implicit form** gains a virtual closing segment `n − 1`, a straight line from anchor `n − 1` to anchor 0. A one-anchor subpath without segments has no virtual closing segment.
- **Segment indices.** Segment `k` runs from anchor `k` to anchor `(k + 1) mod n`; an open subpath has segments `0..n − 2`, a closed one `0..n − 1` (none for a one-anchor subpath without segments).
- **Handles.** Anchor `a`'s `out` handle is `c1` of the segment starting at `a` when that segment is a `cubic`; its `in` handle is `c2` of the segment ending at `a` when that one is a `cubic`; otherwise the handle is absent. A side has a **segment** when such a segment exists (a line or a cubic); the open ends of an open subpath have no `in` (anchor 0) or `out` (anchor `n − 1`) segment.
- **Mirrored.** An anchor with both handles is **mirrored** when `|in.x + out.x − 2·A.x| ≤ 1e-9·max(1, |in.x|, |out.x|, |A.x|)` and the same holds for y (node-local units; the midpoint condition is affine-invariant, so re-normalization keeps it up to rounding). Any other anchor is independent. This is how M3 keeps symmetry without a stored mode (M3-Q1).
- **References.** `PathAnchorRef = { subpath: number; anchor: number }` (integers in range); a list of refs is canonical when sorted by `(subpath, anchor)` without repeats.
- **M3-P2 serializer.** A subpath that an edit changes **structurally** (an anchor added, removed or rotated to the start, its closed flag, or a segment's verb) is written from its anchor model: `move A0`; segment `k` for `k = 0..n − 2` as `line` with its end point, or `cubic` with `c1`, `c2` and its end point; for a closed subpath the closing segment `n − 1`, written only when it is a `cubic` or the subpath was in the explicit form, with its end point a copy of anchor 0 (section 3.1); then `close`. A closed subpath keeps its form, except that a closing segment that becomes a `cubic` is written explicitly. Every other subpath keeps its verbs; its points change only by the coordinates the edit writes and by section 3.1. Subpaths keep their order; a dropped subpath loses its verbs and points. So every result is in the path grammar and its point count matches; the edited node is then re-validated by the model's node rules (`document.invalid-field` with a path, for example a non-finite result at `/path/points/7`).

## 3. Path commands

All path commands are document commands, one transaction each with byte-identical undo and redo (P5 snapshots). Each names a `path` node of the active page at any depth (`editor.unknown-node` otherwise; `editor.not-a-path` for another node type), returns `{ ok: true, ids: [id] }`, and a command whose result equals the stored node records no step and no event and returns `{ ok: true, ids: [] }`. Page points and vectors are mapped into node-local units through the node's chain `C = spaceOf(parent).matrix · localTransform(frame, θ)` (rigid, M1-S1): a point by `invertRigid(C)`, a vector `(dx, dy)` by `rotate(−φ, dx, dy)` with `φ = spaceOf(parent).rotation + θ` (exact for `φ = 0`); for a page-root node with `θ = 0`, a point maps to `(p.x − x, p.y − y)` exactly. Interpolation is `lerp(a, b, t) = a + t·(b − a)` per coordinate. Groups and mask groups above the node refit after the command, and inside a gesture at its commit (M1 section 4.2, `refitGesture`), so no other node moves on the page; frames do not refit. **Gestures (S1):** every path command is a relative command, because re-normalization would compound rounding: inside a gesture it goes through `replace`, and passing it to `update` fails with `editor.invalid-command` (M3-Q10).

### 3.1 Re-normalization (P5 section 3.1 after an edit)

After the edit, with all points (anchors and controls) of the node as node-local `L′`: `minX`, `maxX`, `minY`, `maxY` over them, `w′ = maxX − minX`, `h′ = maxY − minY`.

- **Value provenance.** A coordinate the edit **computes** (moved by `δ`, mapped from a page point, a `lerp`, `2·A − T`) is new; a coordinate **copied** from an existing stored point keeps that point's stored value: `P0` and `P3` of a split, the other end's anchor for a new control, `A` for a retracted handle, the outer handles of a removal join, kept segments, and anchor 0's closing copy (which takes anchor 0's stored value, or its computed value when anchor 0 moves). Every "equals exactly" test (cubic to line on retraction, the explicit form, the close merge) compares stored unit values.
- **Box unchanged.** When `minX = 0`, `minY = 0`, `w′ = W` and `h′ = H`, the frame is kept; each computed coordinate is stored as `L′x / W` (`L′y / H`), 0 on an axis of size 0; every copied or untouched coordinate keeps its stored value bit for bit.
- **Box changed.** Every coordinate, computed or copied, becomes `u′ = (L′x − minX) / w′` and `v′ = (L′y − minY) / h′` (0 on an axis of size 0). The frame size is `(w′, h′)`. For `θ = 0` the origin is `(x + minX, y + minY)`; otherwise, with `c = apply(localTransform(frame, θ), minX + w′/2, minY + h′/2)`, it is `(c.x − w′/2, c.y − h′/2)`. The stored rotation is unchanged. Equal `L′` give equal `u′`, so copies stay equal.
- Negative zero becomes 0. Values stay in `[0, 1]`, since `L′x − minX ≤ w′` under rounding. Anchors and handles the edit did not move keep their page placement within `1e-9·max(1, |coordinate|)` page units (fixtures within ±10^6 page units), through rotation and nested rotated containers (the M1-A05 bound).

### 3.2 Moving anchors and handles

- **`movePathAnchors { id, anchors: PathAnchorRef[], dx, dy }`** (page vector, finite): each listed anchor `A` and each handle it has move by the local vector `δ`: `A + δ`, `in + δ`, `out + δ`. In the explicit closing form anchor 0's two stored copies are both written. The `nudge` action and anchor drags use it (section 5).
- **`setPathHandle { id, anchor: PathAnchorRef, side: 'in' | 'out', to: PagePoint | null, mirror?: boolean }`**: the side must have a segment (`editor.invalid-path-ref` at `/side`). With `to` mapped to local `T`: a `line` segment on that side becomes a `cubic` whose other control is the other end's anchor point, then this side's control becomes `T`. With `mirror: true` (default false) and a segment on the opposite side, the opposite control becomes `2·A − T` per coordinate (a line there first becomes a cubic likewise). With `to: null` the side's control becomes `A` (a line stays a line), and with `mirror` the opposite cubic control too; then each affected cubic whose stored `c1` equals its start anchor's and `c2` its end anchor's stored values exactly becomes a `line`. A one-anchor closed subpath's loop segment has both sides on one segment.

### 3.3 Insertion and removal

- **`insertPathAnchor { id, subpath, segment, t }`** with `0 < t < 1` (`editor.invalid-command` at `/t`): segment `segment` from `P0` to `P3` is split at `t`, and the new anchor is anchor `segment + 1`. A `line` (the implicit closing segment included) becomes two lines through `S = lerp(P0, P3, t)`; an implicit closing segment gains one `line` to `S` before `close`. A `cubic` with controls `P1`, `P2` splits by de Casteljau: `Q0 = lerp(P0, P1, t)`, `Q1 = lerp(P1, P2, t)`, `Q2 = lerp(P2, P3, t)`, `R0 = lerp(Q0, Q1, t)`, `R1 = lerp(Q1, Q2, t)`, `S = lerp(R0, R1, t)`; it becomes `cubic Q0 R0 S` then `cubic R1 Q2 P3`. The removed controls `P1` and `P2` can shrink the box, so section 3.1 applies. The new anchor's handles are collinear but in general not mirrored (the section 2 test holds for `t = 0.5`, and trivially when `R0 = R1`).
- **`removePathAnchors { id, anchors: PathAnchorRef[] }`**: per subpath, the remaining anchors keep their order, starting at the lowest remaining index (for a closed subpath this rotates the start). A subpath that lost an anchor and has fewer than 2 left is dropped; untouched subpaths stay, whatever their size. Listed anchors of a one-anchor subpath without segments (`move, close` or a lone `move`) are ignored, a no-op for that subpath. Between consecutive remaining anchors `p`, `q` (and last to first when closed) with no removed anchor between them, the segment is kept as it was. Otherwise the new segment joins them: `c1` is `p`'s `out` handle if the original segment leaving `p` was a cubic, else `p`'s point; `c2` is `q`'s `in` handle if the original segment entering `q` was a cubic, else `q`'s point; it is a `line` when both of those segments were lines, else a `cubic` (no curve fitting, M3-Q3). In an open subpath the segments before the first and after the last remaining anchor are removed. If no subpath remains, the command fails with `editor.empty-path` (M3-Q4).

### 3.4 Open and close

- **`closePathSubpath { id, subpath }`**: an open subpath with `n ≥ 2` anchors (`editor.too-few-anchors` otherwise) gets `close`, in the implicit form; when its last anchor's stored point equals anchor 0's exactly, the result is in the explicit form instead and that anchor merges into anchor 0 (its `in` handle becomes anchor 0's). Closing a closed subpath is a no-op.
- **`openPathSubpath { id, subpath, segment? }`**: the ref check comes first: a given `segment` outside the subpath's segment indices (section 2) is `editor.invalid-path-ref` at `/segment`, also on an open subpath. On a closed subpath with `n` anchors it removes segment `k` (`segment`, default `n − 1`, the closing segment); on `move, close` it removes `close` only. The result is open with anchors `A(k+1), …, A(n−1), A0, …, Ak` and their other segments unchanged; for `k = n − 1` only the closing segment (explicit form) and `close` go. Opening an open subpath is a no-op.

### 3.5 Failure codes

New codes, added to `EditorErrorCode` and accepted from extension results:

| Code | When |
| --- | --- |
| `editor.not-a-path` | A path command or `enterPathEdit` names a node that is not a `path` |
| `editor.invalid-path-ref` | A subpath, anchor or segment index is not an integer in range, or a handle side has no segment, with a path such as `/anchors/2` |
| `editor.too-few-anchors` | `closePathSubpath` on a subpath with fewer than 2 anchors |
| `editor.empty-path` | `removePathAnchors` would leave no subpath |
| `editor.no-path-edit` | `setPathSelection` while no path is in edit mode |

With several bad refs, the first failing one in list order wins, and within `setPathHandle` `/anchor` is checked before `/side`. An empty `anchors` list, a repeated ref, a non-finite number and a malformed field are `editor.invalid-command` with the field's path. When several rules fail, the first in this order wins: `editor.invalid-command` (shape, `t`, a path command in `update`), `editor.unknown-node`, `editor.not-a-path`, `editor.no-path-edit`, `editor.invalid-path-ref`, `editor.too-few-anchors`, `editor.empty-path`, then the model codes of the re-validated node (`document.invalid-field`). No path command creates nodes or draws IDs, and none changes clip or tree depth.

## 4. Path edit mode

- **State.** New session state `pathEdit: { id: string; anchors: readonly PathAnchorRef[] } | null` (never history, never serialized), in `EditorSnapshot` and query `{ type: 'pathEdit' }`; a change raises a `session` event with field `pathEdit` after the events of the change that caused it. While it is set, the selection is exactly `[id]` and the active tool is `select`, which runs the edit-mode rules of section 5; the `handles` query returns null, and the resize, rotate, Alt-drag and overlap-cycling gestures are off (M3-Q8).
- **Commands (session).** `enterPathEdit { id }`: a `path` of the active page at any depth (`editor.unknown-node`, `editor.not-a-path`); cancels an active gesture, sets the tool to `select` if needed, the selection to `[id]` and `pathEdit` to `{ id, anchors: [] }`; entering the edited path again is a no-op. A hidden path (itself or an ancestor not `visible`) may be entered by the command, not by double-click, since it is not hittable. `exitPathEdit {}`: sets `pathEdit` to null and keeps the selection; a no-op outside edit mode. `setPathSelection { anchors }`: refs valid for the edited node (`editor.no-path-edit`, `editor.invalid-path-ref`, a repeat is `editor.invalid-command`), stored canonical.
- **Entry.** A select-tool `doubleclick` whose selection target (M1 section 6 with the M2 scope) is a `path` enters edit mode on it; a container target keeps the M2 frame entry, so a path inside a group is reached by double-clicking twice. The `enterScope` action on a single selected `path` enters edit mode (Enter, M3-Q11). The scope is not changed by entry or exit.
- **Exit.** Edit mode ends (the selection stays as the cause leaves it) on: `exitPathEdit`; the `exitScope` or `enterScope` action (Escape, Enter; the path stays selected and a further Escape runs the M2 `exitScope`); a press that hits another node (the press then runs the M2 select-tool rules in the same `input`); a click without movement on empty page canvas (the selection clears, as M2); any selection change to a value other than `[id]`; `setTool` to another tool; `setScope` to a different value; a page switch; `loadDocument`; and any change after which the node is not a `path` of the active page (deletion, undo or redo).
- **Anchor selection retention.** After a document change in edit mode, `anchors` is kept when the node's **structure** (subpath count, and each subpath's anchor count and closed flag) is unchanged, else cleared; the tool then sets it as section 5 says. Cancelling an edit-mode gesture restores the anchor selection recorded at its start, with the M2 selection rule.
- **Keymap (M2-I2 step 4).** In edit mode the built-in actions act on anchors: `delete` runs `removePathAnchors` on the anchor selection, and when that fails with `editor.empty-path` runs `deleteNodes { ids: [id] }` instead (one step; edit mode ends with the node); `nudge { dx, dy }` runs `movePathAnchors`; `selectAll` selects every anchor; with an empty anchor selection `delete` and `nudge` are consumed no-ops. New action `togglePathClosed`, unbound by default (M3-Q11): when the selected anchors lie in one subpath it closes an open one, and opens a closed one at segment `k` when exactly the two ends of segment `k` are selected (the lowest such `k` when several match), else at `n − 1`; otherwise, and outside edit mode, a consumed no-op. Every other action keeps its M2 meaning, and one that changes the selection ends edit mode.

## 5. Edit-mode gestures

- **Targets at a point**, page space, radius `ρ = HANDLE_RADIUS / zoom` with `HANDLE_RADIUS = 6`: (1) an anchor within `ρ`, the nearest, ties to the lower ref; (2) a **visible** handle within `ρ`, the nearest, ties to the lower ref then `in` before `out`; (3) a segment within the P5 radius `max(w / 2, 4 / zoom)` of its flattened outline (`flatten` at `0.25 / zoom`), the nearest, ties to the lower `(subpath, segment)`; (4) the edited path's fill region when it has a fill; else (5) the M2 hit rules. A hit on the scope node (M2 section 5) counts as empty canvas here and in the rules below. Anchors win over handles so a zero-length handle (`c1 = A`, made by the path tool) never hides its anchor (M3-Q9). A handle is visible when its anchor is selected or the other end of its segment is selected; targets (1) to (4) ignore ancestor clips and masks and the M1 mask-source rule.
- **Anchor press.** Without modifiers it selects the anchor unless already selected; Shift toggles it and starts no drag (a Shift-drag is ignored, not a marquee). A drag moves the anchor selection: each move issues `replace([movePathAnchors { id, anchors, dx, dy }])` with the raw page delta plus the snap offset of the pressed anchor (below); a click without movement on an anchor of a larger selection selects only it.
- **Handle drag.** With `h0` the handle's page point and `p` the point at press, each move to `q` issues `replace([setPathHandle { id, anchor, side, to: h0 + (q − p), mirror }])`, `mirror` true when the anchor was mirrored at press (section 2) and Alt is not held; Alt drags the handle independently (M3-Q1).
- **Alt on an anchor.** An Alt-drag pulls new mirrored handles: `replace([setPathHandle { side: 'out', to: q, mirror: true }])`, turning adjacent lines into cubics; at the last anchor of an open subpath, which has no `out` segment, the side is `in` and `to` is the page point `2·A − q`; an anchor with no segment does nothing. An Alt-click without movement retracts both handles (`to: null, mirror: true`, side `in` at that last anchor), so the anchor becomes a corner and fully retracted segments become lines.
- **Segment press.** Selects both end anchors (Shift adds both) and drags them as an anchor drag without snapping. A `doubleclick` on a segment (target 3) inserts an anchor there: with the segment flattened into `N` chords (lines `N = 1`) and the nearest chord `j` (ties to the lower `j`) with clamped projection parameter `σ`, `t = (j + σ) / N`; when `0 < t < 1` the tool runs `insertPathAnchor` and selects the new anchor (M3-Q12). For a line `t = σ` exactly. A `doubleclick` in edit mode on an anchor, a handle or the fill is a consumed no-op.
- **Marquee.** A press on target (4), or on empty canvas, starts an anchor marquee (the `marquee` overlay): at release the anchors whose page point lies in the closed box become the anchor selection, Shift adds. A click without movement on target (4) clears the anchor selection; on empty canvas it ends edit mode (section 4).
- **Snapping** (M2 section 4.2, M3-Q6). An anchor drag snaps the pressed anchor's page point by `snapPoint` against `snapSet(pre-gesture document, page, scope, [id])` (the edited path is the moving node, so it and its group ancestors are no candidates), with the snap overlay; it is off with Ctrl or Meta or `setSnapping false`. Handle and segment drags do not snap.
- Every drag is one gesture and one undo step (no step when it ends on the pre-gesture document); Escape and `pointercancel` cancel it (M2-I2), restoring the document, the selection and the anchor selection.

### 5.1 Overlay query

`{ type: 'pathOverlay' }` returns `PathEditOverlay | null`, null outside edit mode, else a frozen value computed from the current document and `pathEdit`, in page space, from which the tool picks its targets:

```ts
type PathEditOverlay = Readonly<{ id: string; subpaths: readonly Readonly<{ closed: boolean; anchors: readonly PathEditAnchor[] }>[] }>;
type PathEditAnchor = PathAnchor & Readonly<{ selected: boolean; mirrored: boolean }>; // PathAnchor: { point, in, out }
```

A node-local point maps to the page by `apply(C, L.x, L.y)`, and exactly to `(x + u·W, y + v·H)` for a page-root node with `θ = 0` (as `flatten`). `in` and `out` are the visible handles only (section 5), else null; anchor 0 of an explicitly closed subpath is listed once.

## 6. Acceptance criteria

Unit tests drive each behavior through commands and `input` and compare exact values: literal numbers where the arithmetic is exact (for example `t = 0.5` and `t = 0.25` on dyadic coordinates), otherwise the binary64 evaluation of the formulas stated here (M3-Q13).

| ID | Criterion | Method |
| --- | --- | --- |
| M3-A01 | The anchor model of M3-P1 on fixtures: open, explicitly closed (path-tool output), implicitly closed, a one-anchor loop (`move P, cubic …, P, close`), `move, close`, `move, move`, several subpaths; anchors, segments, handles and the mirrored test (inside and just outside the tolerance) are literal; an unedited path written back by M3-P2 is byte-identical | Unit tests on fixtures |
| M3-A02 | Re-normalization per section 3.1: the box-unchanged case keeps unwritten coordinates and the frame bit for bit; a growing and a shrinking box give the formula's frame and points; zero-size axes (a horizontal path) in both directions; `θ = 0.3` and a path in a rotated group inside a rotated frame keep every unmoved point's page placement within the bound; the group refits, also at a gesture's commit; a mask-source path (the mask group refits) and a path inside a clipping frame; negative zero | Unit tests, exact values |
| M3-A03 | `movePathAnchors` and `setPathHandle`: handles follow anchors; anchor 0 in the explicit form; line to cubic on a new handle; mirror; retraction back to a line; value provenance (copied values bit for bit); a path command in gesture `update` fails; `editor.not-a-path`, `editor.invalid-path-ref` (first bad ref wins, `/anchor` before `/side`), `editor.invalid-command` and `document.invalid-field` in their order; no-op records no step | Unit tests, exact values |
| M3-A04 | Insertion: line, cubic, implicit closing and explicit closing segments at `t` = 0.5, 0.25 and 0.3 give the section 3.3 points and new anchor index; a cubic split that shrinks the frame; `t` = 0, 1 and non-finite fail | Unit tests, exact values |
| M3-A05 | Removal: interior anchor between lines, between cubics and mixed (the stated controls); the end of an open subpath; anchor 0 of a closed subpath in both forms (start rotated, form kept, implicit becoming explicit when the closing segment is a cubic); several anchors over two subpaths; a subpath dropped below 2 anchors while an untouched one-anchor subpath stays; listed anchors of `move, close` ignored; `editor.empty-path` | Unit tests, exact values |
| M3-A06 | Close and open: implicit close, close merging a coincident last anchor, open at the closing segment and at an interior segment (rotated anchors), one-anchor loop, `move, close` (removes `close` only), no-ops, a bad `segment` on an open subpath, `editor.too-few-anchors`, `editor.invalid-path-ref`, and the full section 3.5 order | Unit tests |
| M3-A07 | Grammar and history: from each A01 fixture (page-root, rotated, nested), 1,000 seeded pseudo-random path commands; after each, `validateDocument` passes, the renderer-core scene mirror accepts the projection, undo is byte-identical to the state before and redo to the state after | Unit tests (seeded, deterministic) |
| M3-A08 | Edit mode: entry by double-click (page-root, and inside a group after M2 entry), by Enter and by `enterPathEdit`; every exit of section 4, the press on another node acting in the same `input`; scope unchanged; `handles` null; retention and its clearing; `session` event order; resize, rotate, Alt-drag and cycling off; double-click on an anchor, handle or fill consumed with no effect; edit mode survives `pointercancel` and blur; a hidden path entered by command only; `editor.not-a-path`, `editor.no-path-edit` | Unit tests |
| M3-A09 | Gestures through `input`: target precedence including a zero-length handle; Shift toggle; a click in a larger anchor selection; multi-anchor drag; segment press; handle drag mirrored by inference and independent with Alt; Alt-drag and Alt-click on an anchor; segment double-click insertion at the stated `t`; marquee; Delete (also the empty-path delete), nudge by 1 and 10 at zoom 0.5, 1 and 8 giving one document, select all, `togglePathClosed`; each gesture one step with byte-identical undo; Escape and `pointercancel` restore document, selection and anchor selection | Unit tests, exact values |
| M3-A10 | Snapping: the pressed anchor snaps to candidate edges and centres (the edited path excluded) with the literal overlay; off with Ctrl, Meta and `setSnapping false`; handle and segment drags never snap | Unit tests, exact values |
| M3-A11 | `pathOverlay` is null outside edit mode and gives literal page-space anchors, visible handles, `selected` and `mirrored` for a page-root, a rotated and a nested path; the tool's targets agree with it | Unit tests |
| M3-A12 | The next-host page edits a closed cubic path (enter by double-click, drag an anchor, drag a handle mirrored and with Alt, insert by double-click, delete an anchor, open it, exit by Escape) and an open path inside a rotated group (enter by Enter, nudge, insert on a line, remove an end, close it, exit by a click outside), checking the serialized document after each step and after each undo, no `editor.scene-rejected` diagnostic, and the overlay markers against `pathOverlay`, in headed Chrome and Edge; the P5, M1 and M2 headed specs still pass | Headed spec on the main PC; other headed runs NOT RUN unless a unit needs them |
| M3-A13 | Independent `reviewer` review of each unit; the exit record lists evidence for M3-A01 to A12 and the user accepts it | Review record |

## 7. Units

| Unit | Content | Tier |
| --- | --- | --- |
| M3-U1 | Anchor model (M3-P1), serializer (M3-P2), re-normalization (3.1), `movePathAnchors`, `setPathHandle`, the S1 relative rule and the failure codes in `editor-core`; no `model` change (A01 to A03) | Full (public commands) |
| M3-U2 | Edit-mode state and session commands, entry and exit, retention, `pathOverlay`, the select tool's edit mode (targets, anchor and handle drags, Alt, marquee, snapping), keymap routing (A08, A09 for move and handle edits, A10, A11) | Full (session state, product behavior) |
| M3-U3 | `insertPathAnchor`, `removePathAnchors`, `closePathSubpath`, `openPathSubpath`, the segment double-click, `delete` and `togglePathClosed` in edit mode, the grammar property test (A04 to A07, A09 rest) | Full (public commands) |
| M3-U4 | next-host page (anchor overlay from `pathOverlay`, a toggle-closed button, `?fixture=path-edit`) and headed spec (A12) | Light |
| M3-U5 | Exit record (A13) | Full |

Order: U1, then U2, then U3 (its gestures use the U2 mode), then U4, then U5. Every unit runs `pnpm check`; headed runs are on the user's main PC or NOT RUN. The D10 WIP limit of two units waiting for review applies.

## 8. Risks

- **Kernel rejections.** Edited shapes reach fill and stroke paths that P3 disclosed as defects (cracks, the A04 class, the E14 fill `work-limit`); the projector excludes a rejected node (M1 section 5) and reports `editor.scene-rejected`. M3 does not work around them; a reproducible case is filed with a fixture on the rendering track (MVP plan section 8). The headed fixture uses shapes the kernel accepts.
- **Symmetry without a stored mode.** A mirrored anchor stays mirrored only while its geometry passes the section 2 test; an inserted anchor at `t ≠ 0.5` is independent until an Alt-drag re-pulls its handles. Accepted for M3 (M3-Q1, M3-Q2). Disclosure for the M3 exit record: an independent anchor whose handles are exactly symmetric acts as mirrored (M3-Q1 (a)).
- **Rounding into the explicit form.** In the box-changed case an implicitly closed subpath whose last anchor lies within rounding of anchor 0 can round onto it after an unrelated edit and then read as the explicit form with one anchor fewer.
- **Implicit form merge.** Dragging an implicitly closed subpath's last anchor exactly onto anchor 0 (snapping can do it) makes the stored data read as the explicit form with one anchor fewer; this follows from M3-P1 and is tested in A01.
- **Headed specs.** Double-click on a path now enters edit mode; M3-U4 checks that the M1 and M2 specs do not rely on the M2 no-op.

## 9. Validation of this contract

Documentation only: Markdown formatting and local links. No product, browser, GPU or benchmark run is claimed.

## 10. Open questions

| ID | Question | Recommendation |
| --- | --- | --- |
| M3-Q1 | Handle symmetry modes and persistence | (a) no schema change: an anchor is mirrored when its geometry passes the section 2 test, a handle drag keeps that mode, Alt drags independently and Alt-dragging the anchor re-pulls mirrored handles. (b) a per-anchor `mode` array in `PathData`: schema v3 with a migration, for a gain only in the rare case where handles are mirrored by coincidence |
| M3-Q2 | Aligned mode (same direction, own length) | (a) out of M3: requirements do not list it, the MVP plan names only mirrored and independent, and without a stored mode an aligned anchor cannot be told from an independent one with collinear handles except by an angle tolerance; backlog with a stored mode if the user asks |
| M3-Q3 | Curve after removing an anchor | (a) join with the outer handles kept (section 3.3): exact, deterministic, as Figma; (b) fit a cubic to the removed span (Illustrator): numeric fitting and no exact expected values |
| M3-Q4 | Removing every anchor | (a) the command fails with `editor.empty-path`, so no command writes an empty path; the edit-mode `delete` action deletes the node instead, in one step. (b) the command deletes the node itself |
| M3-Q5 | How subpaths open and close | (a) `closePathSubpath` (implicit straight close) and `openPathSubpath` at a segment, with `togglePathClosed` for the UI; continuing a path with the path tool, joining two endpoints and splitting an open subpath are backlog |
| M3-Q6 | Anchor snapping | (a) reuse the M2 point snap for the pressed anchor against the M2 candidate set; no handle snapping and no snapping to the path's own anchors in M3 |
| M3-Q7 | Which nodes enter edit mode | (a) `path` only; `line` keeps its endpoint editing (line tool, resize), and converting rectangles, ellipses and custom nodes to paths is a backlog command |
| M3-Q8 | Where edit mode lives | (a) session state `pathEdit` handled by the select tool, so selection, scope and keymap rules stay in one tool; (b) a new built-in `pathEdit` tool in `ToolName` |
| M3-Q9 | Anchor or handle first at one point | (a) anchors first: the path tool makes zero-length handles that would otherwise hide their anchors; a handle within 6 px of its anchor is reached by zooming in |
| M3-Q10 | Path commands inside gestures | (a) relative (S1, `replace` only), so every update re-normalizes once from the pre-gesture document and drags never compound rounding |
| M3-Q11 | Bindings | (a) Enter enters and exits (the `enterScope` action), Escape exits (`exitScope`), Delete and Backspace remove anchors, arrows nudge anchors, Mod+A selects all anchors; `togglePathClosed` unbound by default (next-host offers a button; a host may bind it) |
| M3-Q12 | Insertion parameter from the pointer | (a) the nearest point of the flattened chords mapped linearly to `t` (within the 0.25 px flattening bound, exact for lines); (b) an exact nearest-point root solve on the cubic |
| M3-Q13 | Exactness under binary64 | (a) as M2-Q14: tests compare with the binary64 evaluation of the stated formulas, literal values only where exact; page placement of unmoved points within the M1-A05 bound |

## 11. Gate

This contract is drafted while the M2 exit record (M2-U9, #318) awaits the user's acceptance. It needs an independent `reviewer` review before approval. Under MVP plan section 7 (M2 then M3), implementation starts at M3-U1 only after both this contract's approval and the user's acceptance of the M2 exit; approval alone does not start implementation. The M3 exit is the user's acceptance of the M3-U5 record.

## 12. Progress

| Unit | State |
| --- | --- |
| M3-U1 | Not started |
| M3-U2 | Not started |
| M3-U3 | Not started |
| M3-U4 | Not started |
| M3-U5 | Not started |
