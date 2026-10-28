# MVP M1 contract: document v2 and containers

Status: APPROVED 2026-10-28 under the user's standing instruction of 2026-10-24, after independent review rounds 1 to 3 (NOT READY, applied) and 4 (READY WITH FOLLOW-UPS, applied); Full tier (document schema, public commands, product behavior). Visualization-track item [V-8](d9-visualization-track.md#status-index), milestone M1 of the [MVP editor plan](mvp-editor-plan.md#m1-document-v2-and-containers). The user approved starting M1 on 2026-10-28 (decision card: contract first, then implementation). Open questions M1-Q1 to M1-Q8 (section 10) are adopted as recommended under that instruction (recommended options auto-adopted, 2026-10-28).

Owners: this file owns M1 scope, schema v2, the M1 commands and their failure codes, projection and hit-testing rules for the new nodes, acceptance criteria M1-A01 to M1-A14 and the units. Product behavior stays in [`requirements.md`](../requirements.md); the milestone order in the MVP plan; the P5 rules that M1 does not restate stay in force as written in the [P5 plan](p5-editor-slice.md) (transactions, gestures, history, events, extension boundary).

## 1. Scope

In scope: schema v2 and the v1 migration; several pages and the active page; `ellipse`, `line` (with arrowheads), per-corner rectangle radii and `rotation` on every node; containers `group`, `frame` and `maskGroup`; grouping, ungrouping and reparenting; proportional group resize and basic frame constraints; container projection onto the P4 scene surface; hit testing and selection through rotation, containers, frame clips and masks; creation tools for ellipse, line and frame; a headed next-host page.

Out of scope (later milestones): rotate handle, snapping, frame-entry editing, overlap cycling (M2); container opacity other than 1 (M4, R-O); gradients, dashes, stroke joins on primitives (M4); persistence envelope (M5); text, symbols, panels.

## 2. Schema v2

```ts
type DocumentV2 = { schemaVersion: 2; id: string; pages: PageV2[]; nodes: Record<string, NodeV2> };
type PageV2 = { id: string; name: string; children: string[] };          // one or more pages
type Constraints = { horizontal: Constraint; vertical: Constraint };
type Constraint = 'start' | 'end' | 'startEnd' | 'center' | 'scale';
type NodeBase = { id; name; parent: string; frame: Frame; rotation: number;
                  constraints: Constraints; opacity: number; visible: boolean };
type NodeV2 =
  | NodeBase & { type: 'rectangle'; cornerRadii: [number, number, number, number]; fill: Color | null; stroke: RectStroke | null }
  | NodeBase & { type: 'ellipse'; fill: Color | null; stroke: RectStroke | null }
  | NodeBase & { type: 'line'; points: [number, number, number, number]; stroke: PathStroke | null;
                 startArrow: Arrow; endArrow: Arrow }
  | NodeBase & { type: 'path'; path: PathData; fill: Color | null; stroke: PathStroke | null }
  | NodeBase & { type: 'custom'; customType: string; data: JsonValue; fill: Color | null; stroke: PathStroke | null }
  | NodeBase & { type: 'group' | 'maskGroup'; children: string[] }
  | NodeBase & { type: 'frame'; children: string[]; fill: Color | null; stroke: RectStroke | null };
type Arrow = 'none' | 'line' | 'triangle';
```

- **M1-S1 placement.** A node's `frame` is in its parent's local space: a page's space is page units; a container's local space has its origin at the container frame's top-left corner and its axes rotated by the container's `rotation`. `rotation` is radians, clockwise on screen (y down), about the frame centre. Every command and parsing normalize it: `t = θ − 2π·round(θ / 2π)`, then `t ≤ −π` adds 2π and `t > π` subtracts 2π, negative zero becomes 0; a non-finite value is `document.invalid-field`.
- **M1-S2 fields.** `cornerRadii` is top-left, top-right, bottom-right, bottom-left, each finite and at least 0 (larger radii are clamped at projection, section 5). `line.points` are the two endpoints in the unit box of the frame, as `path` points (P5 section 3.1). `constraints` is stored on every node and has effect only on a child of a frame (section 4.4).
- **M1-S3 tree.** A node's `parent` is a page or a container; the node is in exactly that owner's `children`; no node is its own ancestor (`document.cyclic-parent`, new). A `group` or `maskGroup` has at least one child; a `maskGroup`'s first child is a `path` node (`document.invalid-mask-source`, new). A `frame` may be empty. The tree depth (ancestors of a node, containers only) is at most 256 (`document.invalid-field` at the node's `parent`), so every tree algorithm is bounded. The frame of a group is not checked against its children's bounds on load; commands keep it equal (section 4.2).
- **M1-S4 IDs.** As P5, plus: an ID may not contain U+0000, so that synthetic scene IDs (section 5) never collide (`document.invalid-field`).
- **M1-S5 opacity.** A container's `opacity` must be 1 in M1 (`document.invalid-field`), because the renderer rejects container opacity other than 1 until R-O; the field exists so M4 adds no migration.
- Unknown fields stay rejected; nesting depth, sparse arrays and duplicate keys keep the P5-U1 rules.

### 2.1 Migration and versions

`parseDocument` accepts `schemaVersion` 1 and 2 and returns a v2 document; v1 is migrated by `migrateV1toV2`, which adds `rotation: 0`, `constraints: { horizontal: 'start', vertical: 'start' }` on every node and `cornerRadii: [0, 0, 0, 0]` on rectangles and changes nothing else. A v1 document with U+0000 in an ID fails migration with `document.invalid-field`. `serializeDocument` writes v2 only, keys sorted as in P5-U1. `validateDocument` checks an in-memory v2 value; `validateAnyDocument` checks an in-memory v1 or v2 value with the same rules and returns v2 (migrating v1), and is what `loadDocument` and the editor constructor use; the constructor throws on any failure, clip depth included, as it does for invalid documents in P5. `editor-core` holds and returns v2 documents only. After the model's rules, `editor-core` re-runs each custom node's `validate` on load wherever the node is nested (P5-U5 order).

## 3. Pages

- Commands: `addPage { name?, index? }` (returns the new page ID; `index` in `0..pages.length`, default the end; default name `Page N`, N the new page count; it does not change the active page), `removePage { id }` (deletes its nodes; `editor.last-page` on the only page), `renamePage { id, name }`, `movePage { id, index }` (`index` into the list after removal, `0..pages.length − 1`). An unknown page is `editor.unknown-page`, an index out of range `editor.invalid-index`. Each is one transaction.
- Session: `setActivePage { id }` is never history; an unknown ID is `editor.unknown-page`; the same page is a no-op. Like `setTool`, it first cancels an active gesture. The active page is `pages[0]` after construction and `loadDocument`; removing or undoing away the active page activates the page now at its index, else the last one. A change of active page clears the selection and resets the active tool (its `reset`, the tool stays selected). `EditorSnapshot` gains `activePage`, and a change raises a `session` event with field `activePage`.
- Tools, hit testing and the projector work on the active page only. A command may name nodes on another page (for example `setNodeProps` from a panel); creation without `parent` uses the active page's root.
- Queries: `activePage`, `pages`, `handles` (section 7).

## 4. Commands and editing rules

### 4.1 Creation

`createRectangle`, `createPath` and `createCustomNode` gain optional `cornerRadii` (rectangle), `rotation`, `parent` and `index`; new commands are `createEllipse { frame }`, `createLine { start, end, stroke?, startArrow?, endArrow? }` and `createFrame { frame, fill?, stroke? }`, with the same optional fields. Frames, page points and path points of a creation are in **page space** and are mapped into the parent's local space (the new node's rotation is the given one minus the parent chain's); `index` defaults to the top of the parent. Defaults: names `Ellipse`, `Line`, `Frame`, `Group`, `Mask group` as P5's `Rectangle` and `Path`; ellipse style as rectangle; line stroke the 1-unit black butt-miter stroke, arrows `none`; frame fill white `{1, 1, 1, 1}`, no stroke; constraints `start`/`start` for every new node.

### 4.2 Placement edits

- `setFrames` entries gain optional `rotation`; frames are parent-local. A changed `width` or `height` of a container applies the resize rules of section 4.4 to its descendants in the same transaction (group mapping, frame constraints); an axis whose old size is 0 is not scaled; `x`, `y` and `rotation` alone move the subtree rigidly. After a group's refit its stored frame may differ from the requested one (the approximation changes the children's bounds); this is intended. One call that names a container and one of its descendants fails with `editor.invalid-command`. Tools convert page deltas through the inverse of the parent chain.
- `setNodeProps` gains `cornerRadii`, `startArrow`, `endArrow` and `constraints`; `opacity` other than 1 on a container is `document.invalid-field`.
- **Group refit.** After any committed change to the frames or membership of a `group` or `maskGroup`'s children, innermost first, its frame is refit: with `b = (bx, by, bw, bh)` the bounds of its children's rotated frames in its local space, `c = (w/2, h/2)`, `c' = (bw/2, bh/2)` and `R` its rotation, the new origin is `p + c − R·c + R·(bx, by) + R·c' − c'`, the new size `(bw, bh)`, and every child's `x`, `y` shift by `−(bx, by)`, so no descendant moves on the page (up to binary64 rounding). Frames never refit. A gesture refits only at commit.
- **Delete.** `deleteNodes` deletes each listed node with its subtree (a listed descendant of a listed node is ignored). A `group` or `maskGroup` left without children is deleted in the same transaction. If a `maskGroup`'s first child is deleted or moved away, the next child becomes the source and must be a path, else the command fails with `editor.invalid-mask-source`.

### 4.3 Grouping and reparenting

- `groupNodes { ids, kind: 'group' | 'maskGroup' }`: a non-empty list of node IDs sharing one parent; the new container takes the place of the topmost of them in paint order, keeps their relative order, its frame is their bounds in the parent space (rotation 0, constraints `start`/`start`). For `maskGroup` the bottom-most node must be a path. Returns the container ID.
- `ungroupNodes { id }` on a `group` or `maskGroup`: its children move to its parent at its index, in order, with the container's rotation and position composed into each child so nothing moves on the page; the container is deleted.
- `moveNodes { ids, parent, index }`: reparents within one page, preserving page placement (frame and rotation recomposed); `index` is into the target's children after the moved nodes are removed; a listed descendant of a listed node is ignored (as `deleteNodes`); the moved nodes keep their document pre-order; containers left empty are deleted (section 4.2).
- **Clip depth.** Every `frame` and `maskGroup` adds one clip level to its descendants, and a `frame`'s background leaf sits at the frame's own depth plus one. So a `frame` or `maskGroup` whose own clip depth is 32 or more, or a node at clip depth 33 or more, fails a command with `editor.clip-depth`, and `loadDocument` of such a document fails with the same code and loads nothing (M1-Q3).

### 4.3.1 Failure codes

| Code | When |
| --- | --- |
| `editor.unknown-node` | An ID names no node (as P5); a page ID where a node is required |
| `editor.unknown-page` | A page ID names no page |
| `editor.invalid-index` | An index is not an integer in range |
| `editor.last-page` | `removePage` of the only page |
| `editor.invalid-parent` | A parent that is not a page or container, is on another page, or is a moved node or its descendant |
| `editor.not-siblings` | `groupNodes` with an empty list or nodes of different parents |
| `editor.not-a-group` | `ungroupNodes` on a frame or leaf |
| `editor.invalid-mask-source` | A command that leaves a `maskGroup` without a path first child |
| `editor.clip-depth` | Section 4.3 |
| `document.invalid-field` | A field value fails the M1-S rules (non-finite points, container opacity, tree depth over 256), with a path |

When several rules fail, the first in this order wins: `editor.invalid-command` (shape), the `unknown-*` codes, `editor.invalid-command` for a container named with its descendant, `editor.duplicate-id`, `editor.invalid-index`, `document.invalid-field`, `document.cyclic-parent`, `document.invalid-mask-source`, `document.unknown-custom-type`, `document.invalid-custom-data`, then the `editor.*` structural codes in table order.

### 4.4 Resize rules

A resize applies an axis-aligned scale `(sx, sy)` about a fixed point in some **scale space** (page space for a multi-selection, the node's own parent space rotated by its rotation for a single node, a frame's local space for constraints, a group's local space for group resize).

- **Rotated node, single selection.** The eight handles follow the node's rotation; the box scales in the node's own axes about the opposite handle (P5 section 4.4 rules in that space).
- **Approximation (MVP-Q3 (a)).** A node whose axes make an angle θ (normalized as M1-S1) with the scale space's axes, under `sx ≠ sy`, keeps its rotation. For θ ∈ {0, Math.PI} its size scales by `(sx, sy)` and for θ = ±Math.PI/2 by `(sy, sx)`, exactly; otherwise its centre maps exactly, and its width and height scale by `s_u = hypot(sx·cos θ, sy·sin θ)` and `s_v = hypot(sx·sin θ, sy·cos θ)`.
- **Several nodes.** The selection box is the page-aligned bounds of the rotated frames; each selected node maps by the box scale as in a group resize (below), so a `path` or `line` maps exactly and grouping first gives the same result.
- **Group resize.** Top-down through the group's descendants: a leaf maps through the group's scale composed down its chain (centre exact, approximation applied with θ relative to the group's axes), except that a `path` or `line` maps its points through the full affine (skew included) and recomputes its frame and unit-box points, rotation kept; a `frame` descendant maps like a leaf (centre exact, approximation if rotated) and its children then follow its constraints for its new size, not the group mapping; group and mask group descendants keep their rotation and their children are mapped in turn; then groups and mask groups refit innermost first (section 4.2).
- **Frame resize** applies each child's constraints per axis to the child's bounds in the frame's space: `start` keeps the offset from the left (top) edge, `end` from the right (bottom), `startEnd` both (the child stretches), `center` keeps the centre's offset from the frame centre, `scale` maps position and size proportionally. Stretched sizes clamp at 0; on a frame axis of size 0, `scale` does not scale (P5 zero-axis rule). A stretched or scaled child applies the approximation if rotated (a `path` or `line` maps its points exactly, as in a group resize), or group resize if it is a group; a nested frame applies its own children's constraints in turn.
- **Undo** of every M1 command is byte-identical, as in P5 (snapshots, not inverse arithmetic).

## 5. Projection

- **Transform.** For θ = 0 a node's scene transform is exactly `[1, 0, 0, 1, x, y]`, so P5 projections are unchanged. Otherwise it is `[cos θ, sin θ, −sin θ, cos θ, e, f]` (the renderer maps `x' = a·x + c·y + e`, `y' = b·x + d·y + f`) with `e = x + w/2 − (w/2·cos θ − h/2·sin θ)` and `f = y + h/2 − (w/2·sin θ + h/2·cos θ)`.
- **Parents.** Page children have `parentId: null`. A child of a group or mask group has the container's ID; a child of a frame has `frameId + "\u0000content"`.
- **Leaves.** `rectangle` and `ellipse` are primitives; `cornerRadii` are scaled by `f = min(1, w/(tl+tr), w/(bl+br), h/(tl+bl), h/(tr+br))`, zero sums skipped, and hit testing uses the same clamped radii. `path` and `custom` project as P5.
- **Line.** In local units, with endpoints `P0`, `P1` (unit-box points times the frame size), stroke width `w`, unit direction `d = (P1 − P0)/|P1 − P0|` and normal `n = (−d.y, d.x)`. An arrowhead at an end with tip `T` (the endpoint) and outward direction `u` (`d` at `P1`, `−d` at `P0`) has base centre `B = T − 4w·u` and base corners `B ± 2w·n`. A line with no stroke, `w = 0` or zero length has no arrowheads and always projects in stroke mode.
  - **Stroke mode** (no `triangle` end): one `path` node, `fill: null`, the line's stroke, subpaths in this order: the segment `P0 → P1`, then for each `line` arrow (`P0` end first) one open polyline `B + 2w·n → T → B − 2w·n`, drawn with the line's cap and join.
  - **Fill mode** (any `triangle` end): one `path` node, `stroke: null`, `fill` the stroke colour, `nonzero`, all subpaths closed, in this order: the shaft, then the `P0` end's head, then the `P1` end's head. `S` is `B` at a triangle end and the endpoint otherwise; the shaft is omitted, together with its cap pieces, if `(S1 − S0)·d ≤ 0` (tested before any cap extension). A `triangle` head is drawn as a triangle; a `line` head as two rectangles of width `w` from `T` to each base corner (butt ends; it looks slightly different from stroke mode, accepted in M1); a `square` cap at a non-triangle end extends the shaft by `w/2` along the line; a `round` cap adds a half disc of radius `w/2`. Each subpath is a `move` to its first vertex, then `line`s, then `close`, listed so its shoelace area over the control polygon is positive and all union under `nonzero` (no reversal at run time): shaft `S0 − (w/2)n, S1 − (w/2)n, S1 + (w/2)n, S0 + (w/2)n` after any square extension; triangle at `P1` `T, B + 2w·n, B − 2w·n`, at `P0` `T, B − 2w·n, B + 2w·n`; line-head rectangle for base corner `C`, with `m = (C − T)/|C − T|` and `q = (−m.y, m.x)`, `T − (w/2)q, C − (w/2)q, C + (w/2)q, T + (w/2)q`; half disc at endpoint `E` with outward `u` and side `N` (`N = n` at `P0`, `−n` at `P1`): a 16-segment half circle, vertices `E + (w/2)(cos(kπ/16)·N + sin(kπ/16)·u)` for k = 0..16 (start `E + (w/2)N`, end exactly `E − (w/2)N`); chord error `(w/2)(1 − cos(π/32))` (M1-U5: the fill kernel's exact rung rejects cubic caps touching line contours, so caps are flattened). No stroke draw means no joint overlay (the P3 sloped-open-subpath class does not arise) and a translucent colour paints once.
- **Group** → `container`, `clip: null`. **Mask group** → `container`, `clip: { kind: 'mask' }`, first child the source (P4-S2).
- **Frame** → an outer `container` with the frame's ID, transform, visibility and opacity, `clip: null`, children `[content, border?]`; `content` (`frameId + "\u0000content"`) is a container with identity transform, `visible: true`, opacity 1, `clip: { kind: 'rect', x: 0, y: 0, width: w, height: h }`, children `[background?, ...frame.children]`; `background` (`frameId + "\u0000background"`) and `border` (`frameId + "\u0000border"`) are rectangle primitives of size `w × h` with identity transform, `visible: true`, opacity 1, corner radii 0, the frame's fill and no stroke, or no fill and the frame's stroke. Each is omitted when its paint is null; toggling it is an insert or remove plus its container's new children (an order entry, or the container's own `children` when the container is updated in the same set).
- **Synthetic IDs** map back to the frame ID in hit testing, diagnostics and `touched`; they never appear in the public API.
- **Synchronization** keeps P5 section 4.5. Identity is `{ documentId, pageId: activePage }`; a change of active page sends a `replaceSnapshot` under the new identity. A projected container's `children` lists only nodes the renderer already holds or that the same set inserts. An `orders` entry is sent only for a container the set neither inserts nor updates (the renderer rejects an order for a container in `inserted` or `updated` with `conflicting-operation`); otherwise the container's own `children` carries the new order. **Isolation** (replaces the P5-U4 per-node retry in M1): after a rejected set, the projector sends an empty snapshot, then one set per node in document pre-order, each holding the node (a frame with its synthetic nodes as one unit; a container's `children` limited to nodes held or inserted by the same set) plus an order entry for its **scene** parent (for a frame child the frame's content container, whose order starts with the background when there is one); a node the renderer rejects is excluded with its subtree, and a mask group whose source is rejected is removed with its subtree and excluded. **Exclusion is per subtree:** a node with an excluded ancestor, and a mask group whose source is excluded, are never projected; a change that touches any node in an excluded subtree retries the whole subtree from its excluded root in pre-order (a mask group, then its source, then the rest) through the same one-node-per-set path; a rejected retry only excludes that subtree again and starts no new isolation. The rest of the P5-U4 notes stays: isolation starts only on `invalid-scene` with a reason other than `stale-snapshot` or `revision-conflict` (those, also for the empty snapshot, are revision bookkeeping, retried once above the renderer's revision), and `resync-required` during isolation or a rejected empty snapshot ends in one full snapshot of the projection minus the exclusions, at most once per change. Each one-node set re-validates the scene, so isolation of a 10,000-node page costs on the order of n² work; it is timed once as part of M1-A13. Orders omit excluded children.

## 6. Hit testing and selection

- **Geometry.** A point is mapped into a node's local space through the inverse of its transform chain (rigid: translation and rotation, so distances are unchanged). Leaves keep the P5 hit rules in local space; an ellipse is hit inside when filled and near its flattened outline (P5 tolerance); a line is hit near its segment and arrowheads with the P5 radius `max(w/2, 4 / zoom)` in either mode, and inside a triangle head. A node is hittable only if it and every ancestor are `visible`.
- **Clips and masks.** A leaf inside a frame is hit only where the point is also inside the frame's rect; a leaf inside a mask group only where it is inside the mask source's fill region (fill rule applied; fill, opacity and visibility ignored). The mask source itself is not hittable. A frame is hit on its background (when filled) and near its border (when stroked).
- **Selection target.** For a hit leaf, the target is its outermost ancestor below the **scope**: the page, or a frame whose parent is the page (a top-level frame acts as an artboard). A hit on a top-level frame's own background or border targets the frame.
- **Marquee.** A marquee starts on empty page canvas; its candidates are the page children (top-level frames included); a top-level frame is selected only when the marquee contains the page bounds of its rotated frame entirely, while its children are not candidates; other candidates intersect (P5-Q5). Press-and-drag on a top-level frame's background moves the frame.
- **Selection.** `setSelection` accepts nodes of the active page at any depth; IDs on other pages are `editor.unknown-node`. A selection holding a node and its descendant is normalized to the ancestor, so move and resize apply once.
- **Bounds.** `boundsOf` returns page-aligned bounds of rotated frames.

## 7. Tools

`ToolName` gains `ellipse`, `line` and `frame`. Ellipse and frame drag as the rectangle tool; line drags from start to end and Shift constrains to 45° steps. Drawing tools create at the page root in M1, also over a top-level frame, and a new frame does not adopt the nodes under it (M1-Q6). Move drags convert the page delta into each node's parent space; resize follows section 4.4.

**Handles query (M1-U5).** `{ type: 'handles' }` returns `SelectionHandles | null`: `null` for an empty selection; otherwise a frozen `{ corners, rotation, handles }` in page space. The box is the page-aligned bounds of the rotated frames when the selection has several nodes or one page-root node with rotation 0, and otherwise the single node's own box through its parent chain. `corners` are top-left, top-right, bottom-right, bottom-left in the box's own axes; `rotation` is the box's page rotation normalized to (−π, π]; `handles` lists the active handles clockwise from top-left (corners and edge midpoints), a handle being active when it scales an axis of nonzero size. The select tool picks handles from the same box, so the query and the tool agree.

## 8. Acceptance criteria

| ID | Criterion | Method |
| --- | --- | --- |
| M1-A01 | Every committed v1 fixture migrates and serializes byte-for-byte to its committed v2 fixture; `parse(serialize(d))` deep-equals `d` for every v2 fixture, with every node type; a v1 `ext.star` node migrates, is grouped and framed, round-trips byte-identically and has its `validate` re-run on load while nested | Unit tests on fixtures |
| M1-A02 | Each M1-S rule and each new code (`document.cyclic-parent`, `document.invalid-mask-source`, U+0000, container opacity) is returned for its own malformed fixture, with no partial document | Unit tests |
| M1-A03 | Page commands and `setActivePage` follow section 3, including last-page failure, active-page fallback, selection clear and history exclusion | Unit tests |
| M1-A04 | Creation commands for every node type produce literal expected documents, with defaults and parents | Unit tests |
| M1-A05 | `groupNodes`, `ungroupNodes` and `moveNodes` keep every descendant's page placement within `1e-9·max(1, |coordinate|)` page units and 1e-12 rad (fixtures within ±10^6 page units), and undo is byte-identical | Unit tests with rotated, nested fixtures |
| M1-A06 | Group refit, empty-group deletion and mask-source rules follow section 4.2 | Unit tests |
| M1-A07 | 32 nested frames (the innermost empty and filled) and 32 nested mask groups succeed, 33 fail with `editor.clip-depth`, for create, move, group and load; tree depth 256 and 257 | Unit tests |
| M1-A08 | Resize: rotated single node, multi-selection approximation (literal values), exact path and line skew in group resize, a frame inside a resized group, θ = ±π/2 swaps, and each constraint mode on a frame resize | Unit tests, exact values |
| M1-A09 | The projection of every v2 fixture is accepted by the renderer-core scene mirror; frames, masks and both line modes have the literal scene structure and vertices of section 5, and θ = 0 transforms equal P5's; `moveNodes` into a rotated group, a frame stroke toggle with a visibility change in one command, and a mask source rejected by a renderer without a fill port produce sets the mirror accepts; after a rejected `moveNodes` into a mask group and after an ungroup, isolation leaves the mirror equal to the projection minus the excluded subtrees, and a later edit inside an excluded subtree retries it whole; after every M1 command, undo, redo and page switch the mirror holds exactly the projection | Unit tests with the recording renderer |
| M1-A10 | Hit testing and selection targets follow section 6 on fixtures with rotation, nested groups, top-level and nested frames, clips and masks | Unit tests |
| M1-A11 | Ellipse, line and frame tools follow section 7 through `input` | Unit tests |
| M1-A12 | The next-host page renders a fixture with pages, a rotated frame with clipped children and border, a mask group and an arrow, and edits it (create, group, move, resize, undo) in headed Chrome and Edge | Headed GPU spec on the main PC |
| M1-A13 | A 10,000-node mixed v2 document loads and projects; load, projection, one move commit and one forced isolation are timed as an observation only (no claim, MVP plan section 8) | Committed observation under `docs/evidence/` |
| M1-A14 | Independent `reviewer` review of each unit; the exit record lists evidence for M1-A01 to A13 | Review record |

## 9. Units

| Unit | Content | Tier |
| --- | --- | --- |
| M1-U1 | `model`: v2 types, migration, parse and serialize, codes, fixtures (A01, A02) | Full (schema) |
| M1-U2 | `editor-core`: pages, creation, placement edits, refit, group/ungroup/move, depth, resize rules (A03 to A08) | Full (public commands) |
| M1-U3 | Projector: transforms, containers, frames, arrows, page identity (A09) | Light |
| M1-U4 | Hit testing, selection scopes and tools (A10, A11) | Light |
| M1-U5 | next-host page and headed spec (A12) | Light |
| M1-U6 | Observation (A13) and exit record (A14) | Full |

Order: U1, U2, then U3 and U4 in any order, then U5, then U6. Every unit runs `pnpm check`; headed specs run on the user's PC or are NOT RUN. Rendering items R-G, R-D and R-O (MVP plan section 5) are reserved on the rendering track as E23, E24 and E25 (2026-10-28), backlog, needed by M4.

## 10. Open questions

| ID | Question | Recommendation |
| --- | --- | --- |
| M1-Q1 | Is a group's frame stored or derived? | (a) stored and refit by commands (section 4.2): keeps children parent-local and undo a snapshot |
| M1-Q2 | Where are `constraints` stored? | (a) on every node, effective only under a frame: no field churn on reparent |
| M1-Q3 | Loading a document deeper than clip depth 32 | (a) rejected with `editor.clip-depth`, nothing loaded, as other invalid loads |
| M1-Q4 | Selection target inside containers | (a) outermost ancestor below the page or a top-level frame, as in Figma; entering groups is M2 |
| M1-Q5 | Arrowhead size and drawing | (a) length `4w`, half-width `2w`; a line with a triangle end is drawn as one filled outline (section 5), so no joint overlay is needed |
| M1-Q6 | Does a newly drawn frame adopt the nodes under it? | (a) no in M1; adoption on drop is an M2 interaction |
| M1-Q7 | Synthetic scene ID form | (a) frame ID plus U+0000 and a role, with U+0000 forbidden in document IDs |
| M1-Q8 | Primitive strokes on rectangle, ellipse and frame keep `RectStroke` (no join) | (a) yes until M4 adds joins by projecting such shapes as paths |

## 11. Gate

On approval this contract is the M1 execution plan; implementation starts at M1-U1 under the user's decision of 2026-10-28. The M1 exit is the user's acceptance of the M1-U6 record.

## 12. Progress

| Unit | State |
| --- | --- |
| M1-U1 | Done (#298): schema v2 in `packages/model` staged beside v1 (`parseDocumentV2`, `validateNodeV2`, `serializeDocumentV2`; M1-U2 flipped them to the unsuffixed names), `migrateV1toV2`, fixtures `tests/fixtures/m1-model/`, `tests/unit/m1-model.test.ts` (M1-A01 model half, M1-A02) |
| M1-U2 | Done (#299): `parseDocument`/`validateDocument`/`serializeDocument` on v2, `editor-core` on v2 (pages, sections 3, 4 and the section 6 selection rule), `tests/unit/m1-editor-core.test.ts` (M1-A01 editor half, M1-A03 to M1-A08) |
| M1-U3 | Done (#301): `editor-core` projector on the full section 5 (containers, frames, ellipses, both line modes, page identity, subtree isolation), `tests/unit/m1-projector.test.ts` (M1-A09) |
| M1-U4 | Done (#300): hit testing, selection targets and marquee (section 6), ellipse, line and frame tools and the select tool's rotated, nested and multi-selection resize (section 7), `tests/unit/m1-hit-test.test.ts` (M1-A10), `tests/unit/m1-tools.test.ts` (M1-A11) |
| M1-U5 | In review: next-host page (all M1 tools, page switcher, `?fixture=containers`, page-space overlay from the `handles` query), `tests/m1-next-host/m1-next-host.spec.ts` (M1-A12, headed Chrome and Edge on the user's PC), `tests/geometry/m1-line-round-cap.test.ts` |

M1-U2 notes. Choices inside this contract: (1) creating commands, `groupNodes` and `addPage` check `editor.duplicate-id` last, so a failed command draws no ID (an exception to the 4.3.1 order); (2) a `parent` naming neither a page nor a node is `editor.unknown-node`; (3) `setActivePage` to the active page still cancels the gesture; (4) `ungroupNodes` returns empty `ids`; (5a) a prop the node type lacks is `editor.invalid-command` at `/props/<key>`; (5b) a size-0 child under `startEnd` keeps size 0, as an axis of old size 0 is not scaled; (5c) `editor.not-siblings` precedes tree depth, and `moveNodes` checks tree depth after `editor.invalid-parent`. A `groupNodes` failure inside the new container has a path relative to it (for example `/children/0`), as for creation. A gesture resizes a container from its pre-gesture state, so a drag does not compound; descendants a later update does not name return to their pre-gesture state (the select tool names the same nodes on every update). The P5 fixture `malformed/unsupported-version.json` moved to `schemaVersion` 3. Intermediate state until later units: the projector and hit testing covered page-root rectangles, paths and custom nodes only, and the select tool offered resize handles only for page-root selections with rotation 0 (M1-U3 replaces the projector part, M1-U4 the hit-testing and handle parts).

M1-U3 notes. Choices inside this contract: (1) the P5-U4 single-unit shortcut stays: a rejected set holding one unit and no removals (or a snapshot of one unit) is that unit's own rejection, with the same end state as isolation, so no empty snapshot is sent; (2) a rejected set of removals only reports the removed IDs, then sends one full snapshot (P5-U4); (3) in fill mode the round-cap half discs follow the shaft, P0 then P1, before the heads; (4) line-head rectangles start at `B + 2w·n`, then `B − 2w·n`; (5) a rejected mask source is named in the diagnostic, and its mask group is excluded without a diagnostic of its own; (6) diff sets carry a container's new order in its own `children` (an update) and never send a container order entry, while isolation and retry sets order on the scene parent; (7) the recording test renderer draws clips by default (`clips: 'supported'`). A load or a page-switching change releases the excluded subtrees its `touched` reaches before the snapshot. Risks: each change diffs the whole active page (O(n), to watch in the M1-A13 timing); leaves compare by identity (a touched leaf is re-sent as in P5), containers by value and synthetic frame nodes by JSON; exclusions persist across page switches until a change touches them.

M1-U4 notes. Choices inside this contract: (1) a multi-selection resize and a line drag use a package-internal gesture edit (`GestureControl.edit`, `applyGestureEdit` with `map` and `line` edits), not exported, so the public API is unchanged; the `map` edit applies `mapNodeInPageSpace` from the pre-gesture state; (2) a press on a selected node below its section 6 target keeps the selection and drags that node, and a click without movement selects the target; (3) Shift on the line tool snaps to 45° steps and keeps the drag length; (4) hit outlines of ellipses and rounded corners are flattened within 0.25 / zoom, while rounded-rectangle fill hits are exact; (5) a multi-selection `map` update lists every mapped subtree in `touched`, including nodes with no net change. Open for M1-U5: the next-host toolbar lacks the ellipse, line and frame tools, and hosts have no query for the rotated handle box of a single selection.

M1-U5 notes. (1) New public query `{ type: 'handles' }` returns `SelectionHandles | null` (four page-space corners and rotation of the section 4.4 handle box, shared with the select tool), closing the U4 open item; (2) fill-mode round caps are 16-segment half circles (section 5), adopted on 2026-10-28 as the recommended option under the user's standing rule of 2026-10-24 (adopt the recommended option for approval-needed decisions, record it with the date and notify the user), the `handles` query (section 7) likewise after the real kernel failed the cubic caps with `work-limit` or `unsupported-geometry`; they mesh at zoom 1, 2 and 8 within the 128-vertex fringe cap and stay within 0.25 px up to about zoom 21 at w = 5; (3) the next-host renderer passes `clips: 'all'` (P5-Q8 used the V-1 composition), and with `?test=1` exposes the E10 test-only frame capture and backend diagnostics; (4) an app route serves `tests/fixtures/m1-model/containers.json`; (5) the cubic-cap failure (a small cubic cap touching a line contour fails fill with `work-limit` at tolerance exponents −3, −4, −6, also reachable from path-tool shapes) is input to the E14 fill `work-limit` backlog item; (6) `?test=1` also enables the capture hooks for the P5 next-host spec, which is stricter than the shipped configuration; (7) stroke-mode round caps can still draw without the coverage fringe above 128 boundary vertices, the existing P3 O2 region-only class (E11-U4 addendum), not M1-specific.
