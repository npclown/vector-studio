# V-34 contract: auto layout for frames

Status: ADOPTED 2026-11-12 (review round 4 READY WITH FOLLOW-UPS, follow-ups applied), Full tier. V34-Q1 to Q6 take option (a), 추천안 자동 채택 2026-11-12. Visualization-track item [V-34](d9-visualization-track.md#status-index). The user asked for it on 2026-11-12 (project chat, item 4 of the Figma gap list: "1~10번까지 다 진행해줘"). That request lifts the deferral of auto layout in [requirements](../requirements.md#containers), recorded there with the date. The open choices in section 9 take the recommended option under the user's standing instruction of 2026-10-24 unless the user picks otherwise. Identifiers use the prefix **V34-**.

It changes shared surface:

- the document schema: two optional fields on the unreleased v8 (section 2);
- three new document commands, `addAutoLayout`, `removeAutoLayout` and `setLayout`, and two key bindings (section 5), listed in [host-api.md](../host-api.md);
- the editor's edit rules: a layout pass in the edit draft's `finish`, and the draft's frame resize skips constraints for auto-layout frames (section 4);
- the property panel and the context menu (section 6).

It changes no scene contract, projector output type, renderer, geometry port or threshold. A document stores the resolved child frames, so renderers, export and persistence read laid-out positions without knowing about auto layout.

Owners: this file owns V-34's rules, criteria, fixtures and evidence. The [M1 contract](mvp-m1-document-v2-contract.md) keeps the resize rules and group refit that section 4 extends; [M6a](mvp-m6a-text-model-contract.md) keeps text sizing.

**Schema version.** Under the coordinator's rule of 2026-11-12 for the ten parallel items, one scaffold PR introduces schema v8 (identity `migrateV7toV8`) and each item adds optional fields to the unreleased v8, its migration only filling defaults. V-34 adds its fields onto whatever v8 is on `main` at its merge.

## 1. What a user can do

- Select frames and press Shift+A (or "Add auto layout" in the context menu or the panel): each frame lays out its children in a row or a column, with a gap, padding and alignment. Selecting other nodes of one parent and pressing Shift+A wraps them in a new auto-layout frame.
- Change direction, gap, padding (each side), main-axis alignment (start, centre, end, space between) and cross-axis alignment (start, centre, end) in the panel's "Auto layout" section.
- Set width and height sizing per node: **Fixed**, **Hug** (an auto-layout frame fits its content) or **Fill** (a child of an auto-layout frame takes the free space).
- Resize, add, delete, hide, reorder, paste or edit the text of a child: the frame reflows. Drag a child along the row: on release it drops into the slot under its centre.
- Remove auto layout (Shift+Alt+A, menu, panel): children keep their current positions; the frame keeps its size.

## 2. Schema (v8 fields)

- **V34-S1 frame field.** A `frame` node may carry `autoLayout?: AutoLayout`, with exactly these keys. Absent means no auto layout. Other node types reject the key (`document.invalid-node`, path `/autoLayout`), symbols included (V34-Q2).

```ts
type AutoLayout = Readonly<{
  direction: 'horizontal' | 'vertical';
  /** Space between consecutive children on the main axis; negative overlaps them. */
  gap: number;
  /** Top, right, bottom, left. */
  padding: readonly [number, number, number, number];
  primaryAlign: 'start' | 'center' | 'end' | 'spaceBetween';
  counterAlign: 'start' | 'center' | 'end';
}>;
```

- **V34-S2 node field.** Every node may carry `layoutSizing?: LayoutSizing`, with exactly these keys; absent means fixed on both axes. Validation normalizes `{ horizontal: 'fixed', vertical: 'fixed' }` to absent, so the two never differ.

```ts
type AxisSizing = 'fixed' | 'hug' | 'fill';
type LayoutSizing = Readonly<{ horizontal: AxisSizing; vertical: AxisSizing }>;
```

- **V34-S3 limits.** `gap` finite in `[−10000, 10000]`; each padding finite in `[0, 10000]`; `−0` reads as `0`. `hug` is valid only on a frame that has `autoLayout`; elsewhere, text included, it is `document.invalid-node` at `/layoutSizing/<axis>`. `fill` is valid on any node and takes effect only when the parent is an auto-layout frame, as `constraints` take effect only under a frame. A loaded text with `autoWidth` and horizontal `fill` is valid; when its parent lays out, the pass sets it to `autoHeight` (4.2's rule) whether or not its width changes.
- **V34-S4 round trip.** Serialize writes the keys only when present, so input holding `fixed/fixed` does not round-trip byte for byte. The v7 to v8 migration adds neither. A v8 document whose child frames disagree with its layout is valid: frames are stored data, and the next edit that seeds the frame (section 4.3) resolves them.

## 3. Layout of one frame

### 3.1 Participants

The **participants** of an auto-layout frame `F` are its children with `visible: true`, in `children` order (first child first: left in a row, top in a column; this is back-to-front paint order). Hidden children keep their frames and take no space (V34-Q6).

A participant's **box** is its rotated bounds in `F`'s space (`rotatedBounds`, binary64), size `(m, c)` on the main and cross axes. A participant with rotation other than 0 or π is placed by its box and counts as fixed on both axes.

### 3.2 Steps

`pm` and `pc` are the padding sums on the main and cross axes, `n` the participants. "F's axis is fixed" means its sizing on that axis is not `hug` (a `fill` F has been sized by its parent). A fill child on an axis where F hugs acts as fixed there. In order:

1. **Cross fill.** If F's cross axis is fixed, each cross-fill child gets cross size `cross − pc` (3.3). This runs first because it can change a child's main size (a fill-width text in a column is measured again).
2. **Main hug.** If F hugs the main axis and `n > 0`, its main size is `pm + Σ m_i + gap·(n − 1)`, at least 0.
3. **Main fill.** Otherwise the free space `main − pm − Σ_fixed m_i − gap·(n − 1)` is shared equally by the main-fill children (3.3).
4. **Cross hug.** If F hugs the cross axis and `n > 0`, its cross size is `pc + max c_i`, measured after steps 1 and 3 (a main-fill text in a row is measured again in step 3).
5. **Positions** (3.4) from the boxes after steps 1 to 4.

Every fill size is at least 1 unit, so a child never collapses to 0 and can always grow back; fill children that do not fit overflow F. With `n = 0` a hug axis keeps its size. When F's size changes, its own top-left corner stays fixed in its parent's space (`resizeInOwnAxes` anchored at `(0, 0)`, so a rotated F does not drift).

### 3.3 Resizing a fill child

The child's frame takes the new size with its top-left corner kept, then:

- a frame, symbol or instance follows `resizeContainer` from its old frame; its settle (below) lays it out when it is itself an auto-layout frame, once;
- a group or mask group does not take fill: it counts as fixed on both axes (its size is its children's bounds; Figma alike);
- a text node keeps its runs (no scaling axis, `frameRule`); with `autoHeight` its height is measured again by the draft's text layouter, and without one the edit fails with `editor.no-text-layout`, as `Draft.refitText` does;
- a path, line or custom node is mapped by `mapNode` with the axis scale; an axis of old size 0 (a straight line) counts as fixed on that axis, in the share too.

**Settle.** After each inline resize, the subtree it changed is settled in one walk, deepest node first, each node doing the step of its kind: an auto text that the resize marked for a refit (`frameRule`) is measured again with the draft's layouter (none: `editor.no-text-layout`); an auto-layout frame whose size changed or whose children changed lays out (section 3) in place of the constraints it skipped; a group whose children changed is refit (as `expansion.ts` `refitChanged` does). So nested auto layout, text heights and group bounds come out the same whether F or the nested node was edited (L20).

### 3.4 Positions

- **Main axis.** Start at the start padding. `center` and `end` add half or all of the free space `main − pm − Σ m_i − gap·(n − 1)` (may be negative). `spaceBetween` with `n ≥ 2` and no main-fill child uses gap `(main − pm − Σ m_i)/(n − 1)`; with `n = 1` or a main-fill child it acts as `start` with `gap`.
- **Cross axis.** `start` at the start padding, `center` centred in `cross − pc`, `end` flush with the end padding.
- A participant translates so its box's origin lands on its slot; size and rotation stay. Positions are not rounded.

## 4. Editing rules

### 4.1 Order by drop (V34-Q3)

- **Candidates** are children of F that a command targeted and moved by translation alone against `placementBase`: the targets of `setFrames`, `nudgeNodes`, `alignNodes`, `distributeNodes`; nodes created, pasted, duplicated, grouped, ungrouped, adopted or moved into F from another parent. A resized target is not a candidate. A `moveNodes` within F keeps its explicit index and is not a candidate. Children moved by a layout, a container resize, a flip or a refit are never candidates. The draft records targets as commands place them (`markPlaced`).
- Before F lays out, the candidates that are participants are taken out of `children`, in their old order, and each is inserted immediately before the first remaining participant whose box centre on the main axis is past its own (at the end of `children` when none is). Hidden children keep their places.
- **New to F.** Nodes created, pasted, duplicated, grouped, ungrouped, adopted or moved into F from another parent are candidates whatever their placement, having none in F before.
- **Gestures.** On a gesture update a candidate floats: it does not seed F and, if F lays out for another reason, it is left out of the participants and keeps the pointer's position, so a dragged child follows the pointer and F lays out at commit. A resize of a child or of F seeds F, so it lays out on every update. A gesture accumulates its placed and resized sets across updates, as it accumulates `touched`, and `refitGesture` receives them with the text layouter.
- Consequences (disclosed): align, distribute and small nudges on auto-layout children snap back or reorder; dragging a child out of F needs `adoptIntoFrames`, otherwise the drag reorders.

### 4.2 Sizing changes by the user (V34-Q4)

- **Resized set.** The draft records nodes the command itself resized (`markResized`): `setFrames` targets whose size changed, descendants that `resizeContainer` or `mapNode` resized outside the pass (a group scale, a parent's constraints, the multi-select map gesture). A hug axis of a resized F whose size changed becomes `fixed` in the same step, and F keeps the new size; a fill axis of a resized child likewise. Sizes changed by the pass never count, so a child resize gesture under a hug F leaves F hug and a fill sibling fill.
- `fill` on the horizontal axis of an `autoWidth` text sets its sizing to `autoHeight`; `fill` on the vertical axis of a non-`fixed` text sets `fixed`. `setTextProps` setting `autoWidth` turns a horizontal `fill` into `fixed`, and `autoHeight` a vertical `fill`.
- Removing `autoLayout` by any command turns F's hug axes into `fixed`. `createSymbol` on a single auto-layout frame drops `autoLayout` and turns hug into fixed (V34-Q2). Detaching an instance keeps its `layoutSizing`.

### 4.3 The layout pass

`Draft.finish` runs the pass after the text refit, merged with the group refit into one pending set, deepest node first. All comparisons use `placementBase` (the gesture base at commit and on gesture updates, else the draft's base).

- **Seeds**, computed once from the command's changes: an auto-layout frame that is new, whose `autoLayout`, `layoutSizing`, size or `children` list changed, or that has a child that entered, left, has candidates (4.1), or changed placement, `visible` or `layoutSizing`; and the groups seeded today.
- **Propagation.** A pending group refits; a pending auto-layout frame lays out (section 3). Either one whose own frame changed makes its parent pending. A layout's changes to its children never seed it again.
- **Bound.** Each node lays out or refits at most once from the pending set (inline top-down layouts of 3.3 are separate). The pass therefore ends.
- **Gesture updates** (no group refit) run the pass with 4.1's float rule; the commit (`refitGesture`) runs it fully with the gesture's sets and the text layouter. If the commit's finish fails, the live document stays, as today (disclosed).
- Frames without `autoLayout` are never pending, so every edit of a document without auto layout gives the same result as before (V34-A07).
- **Constraints.** In the edit draft, resizing an auto-layout frame skips `applyConstraints` and the pass lays it out. Instance expansion keeps applying constraints (4.4).

### 4.4 Out of the pass

Loading, `loadDocument`, undo and redo take stored frames as they are. A font load changes text sizes but leaves stored frames until the next `refitText` (disclosed). Instance expansions copy the source's stored frames; an instance resized against its source maps an auto-layout frame inside it by the constraints, without layout (disclosed, backlog).

## 5. Commands and keys

- **`setLayout { ids, autoLayout?: Partial<AutoLayout> | null, layoutSizing?: Partial<LayoutSizing> }`**: one transaction for every listed node. `autoLayout` patches the listed frames that have it and leaves frames without it unchanged (a patch cannot create one; `addAutoLayout` does), and `null` removes it (4.2); `layoutSizing` patches every listed node and applies 4.2's text rules; a result that breaks S3 refuses the whole command with the model's code. A change of no value records no step. The panel uses it for multi-selection edits.
- **`addAutoLayout { ids }`** (Shift+A, context menu, panel "+"), rules in order:
  1. All listed nodes are frames: each without auto layout gets `autoLayout` inferred from its participants; the rest are unchanged. Inference: `direction` horizontal when the box centres spread wider in x than in y, else vertical (no participants: horizontal); participants re-sorted by box start on that axis into the participant slots of `children`; `gap` the rounded mean of the gaps between consecutive boxes (0 if negative or `n < 2`); padding the rounded distances from the boxes' bounds to the frame's edges, each at least 0 (no participants: 0); alignments `start`; hug on both axes, except an axis where the frame is already `fill` in its parent, which keeps `fill`. The layout then runs, so children can move (gaps become equal, cross offsets go to the start).
  2. Otherwise the nodes are wrapped in a new frame with `groupNodes`' checks and codes (`editor.not-siblings`, active page, clip depth, symbol nesting): at their bounds, rotation 0, `fill: null`, `stroke: null`, name "Frame", in the place of the topmost of them, settings inferred as in rule 1 with padding 0. Returns the frame ID and selects it.
- **`removeAutoLayout { ids }`** (Shift+Alt+A, menu, panel "−"): removes `autoLayout` from each listed frame that has it, hug becoming fixed; children keep their frames; their `fill` stays stored, inert. Other listed nodes are unchanged; no change records no step.
- Keymap actions `addAutoLayout` and `removeAutoLayout`, configurable like every binding.

## 6. UI

- **Panel "Auto layout" section** for a selection containing frames: "+" when none has auto layout (adds to each); otherwise direction (two toggle buttons), gap, padding top/right/bottom/left, main alignment, cross alignment, "−". "Mixed" where selected frames differ; each edit is one `setLayout`.
- **"Resizing" W and H selects** (Fixed / Hug / Fill), shown when a choice beyond Fixed exists: Hug for auto-layout frames, Fill for their children. Fill is shown disabled for children that count as fixed (groups, mask groups, rotated children, zero-size axes). The Constraints section is hidden for children of auto-layout frames, and their X/Y fields are read-only.
- **Context menu**: "Add auto layout" or "Remove auto layout" per the selection, with the key labels.
- No canvas overlay for gaps and padding (backlog).

## 7. Acceptance criteria

| ID | Criterion | Evidence |
| --- | --- | --- |
| V34-A01 | Schema: parse, validate, serialize round trip with and without the fields; exact keys; `fixed/fixed` normalized away (not byte-identical, S4); each S3 refusal; v7 migration adds neither; every existing fixture loads | Unit (model) |
| V34-A02 | Layout on fixtures L1 to L20: each participant's frame and F's size equal values computed in the test from `rotatedBounds` and section 3 in binary64, exactly; a second pass changes nothing | Unit (editor-core) |
| V34-A03 | Seeds and propagation per 4.3: child resize gesture under a hug F (F stays hug, a fill sibling stays fill), handle-resize of a child past a neighbour's centre (no reorder), text edit of an `autoWidth` child, add, paste, delete, hide, `reorderNodes` inside F, `groupNodes` and `ungroupNodes` inside F, a loaded `autoWidth` text with horizontal fill whose share equals its width (becomes `autoHeight`), reparent in and out, child rotation, drop order (4.1) with one and two candidates, a resize gesture shifting siblings without reordering them, a flip of F, a group scale over a hug F (hug becomes fixed), gesture updates (move floats; resize lays out live); each one undo step | Unit (editor-core) |
| V34-A04 | Commands: `addAutoLayout` inference on a row, a column, one child and an empty frame; several frames each get their own; a frame that is a fill child keeps `fill`; wrap of loose nodes; `editor.not-siblings`; `removeAutoLayout`; `setLayout` rules of 4.2 and S3 on one and several nodes as one step, an `autoLayout` patch on a frame without it (unchanged), refusals change nothing; `createSymbol` and detach per 4.2 | Unit (editor-core) |
| V34-A05 | Panel and menu models: sections per selection, Mixed values, Fill disabled for fixed-counting children, one `setLayout` per multi-selection edit | Unit (ui) |
| V34-A06 | next-host flows: Shift+A on three rectangles, gap change reflows on the canvas, Fill on one child, drag reorder, undo; Chrome and Edge | Headed spec `test:v34-next-host` on the reference PC |
| V34-A07 | Identity: every existing unit, geometry and SwiftShader suite passes unchanged apart from the schema version | CI |
| V34-A08 | Cost: one pass on a frame of 1,000 participants (100 fill) ≤ 5 ms and a 10-deep nest of hug frames ≤ 1 ms, median of 5, CI container | Unit timing, record in `docs/evidence/v34/` |

## 8. Fixtures

The text fixtures use a fake `TextLayouter`: each character 10 units wide, lines 20 high, wrapping at the frame width. L1 row, three fixed children, gap 10, padding 20, hug both; L2 the same as a column; L3 fixed frame, `primaryAlign` centre and end; L4 `spaceBetween` with three children, one child, and with a fill child; L5 `counterAlign` start, centre, end with children of different heights; L6 one main-fill child among fixed ones; L7 two main-fill children sharing space, free space below 0 (sizes 1, overflow), then growing back, for rectangles, a frame with `scale` children and a group (fixed); L8 cross fill, and a line under cross fill; L9 fill under a hug axis acts as fixed; L10 hidden child skipped; L11 a child rotated 45° placed by its box; L12 a hug row inside a hug column; L13 a fill frame child whose children follow constraints, and a fill auto-layout child laid out again; L14 an `autoWidth` text child; L15 a main-fill `autoHeight` text in a hug-cross row (cross size from the measured height); L16 a fill frame child holding a `scale`-constrained group (the group refit inline); L17 no participants, and negative gap; L18 a rotated hug F growing with its top-left corner fixed; L19 a hug-height column with a fill-width `autoHeight` text (cross fill before main hug); L20 a fill frame child holding a `startEnd` auto-layout row that hugs its height, with a fill child and a `startEnd` `autoHeight` text inside the row (settle order).

## 9. Open choices (recommended option first)

- **V34-Q1 sizing storage.** (a) `layoutSizing` on each node (Figma's model; copies with the node). (b) lists of child IDs in the parent's `autoLayout`.
- **V34-Q2 symbols.** (a) frames only; auto layout on symbols and layout inside resized instances go to the backlog. (b) symbols too, with layout at expansion time.
- **V34-Q3 moving a child.** (a) it floats while dragged and drops into the slot under its centre (Figma). (b) it snaps back; reorder only from the layer tree.
- **V34-Q4 resizing a hug or fill axis.** (a) the axis becomes fixed (Figma). (b) refuse the resize.
- **V34-Q5 Shift+A on other nodes.** (a) wrap them in a new auto-layout frame (Figma). (b) frames only.
- **V34-Q6 hidden children.** (a) take no space (Figma). (b) take space.

## 10. Units

| Unit | Scope | Gate |
| --- | --- | --- |
| U1 | This contract; requirements.md deferral lifted (dated); track row | Independent review READY |
| U2 | Schema fields on v8 (model); layout engine `editor-core/src/auto-layout.ts`; the pass in `finish`; candidates; commands, keymap actions, host-api.md | V34-A01 to A04, A07, A08; CI |
| U3 | Panel section, Resizing selects, context menu entries (ui); next-host headed spec | V34-A05, A06 |

**Backlog after V-34:** wrap, absolute-positioned children, min and max sizes, baseline alignment, strokes counted in layout, gap and padding handles on the canvas, auto layout on symbols and inside resized instances, reverse z-order.

## 11. Risks

- Merge conflicts with the nine parallel items on the v8 types, `finish` and the property panel; each rebase reruns A01 to A04 and A07.
- The pass runs on every command that touches an auto-layout frame's children; A08 bounds its cost, and deep documents of many auto-layout frames are not measured beyond it.
- The nine parallel items may claim key chords too; the keymap test catches duplicates at rebase.
- Fractional positions from centre alignment and fill shares can show half-pixel edges on the canvas; rounding is not part of V-34.

## 12. Review record

- Round 1 (2026-11-12, `reviewer`): NOT READY, 5 blocking (step order of hug and fill, fill resize on size 0 and text, drop candidates, seeds and termination) and 16 others. Round 2 rewrites sections 2 to 12 to resolve all of them.
- Round 2 (2026-11-12): NOT READY, 4 blocking (cross fill order, resized set, inline group refit, collapse to 0) and 10 others. Round 3 reorders 3.2 (cross fill first), adds `markResized`, inline group refit, a fill floor of 1 with groups fixed, translation-only candidates that float on gesture updates, gesture set carry-over, and the remaining fixes.
- Round 3 (2026-11-12): NOT READY, 1 blocking (no settle of the subtree under an inline resize) and 6 others. Round 4 adds the settle step (3.3) and L20, new-to-F candidates, floating candidates left out of an update's layout, Fill disabled where it counts as fixed, `fill` kept by `addAutoLayout`, the A02 range and the autoWidth-fill disclosure.
- Round 4 (2026-11-12): READY WITH FOLLOW-UPS, no blocking. Follow-ups applied: settle as one deepest-first walk (L20's row hugs its height), the autoWidth-fill rule applied by the pass directly, the fill child's own layout is its settle step.
