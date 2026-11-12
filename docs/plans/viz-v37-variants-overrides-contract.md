# V-37 contract: component variants and property overrides

Status: DRAFT 2026-11-12 (review r1 and r2 NOT READY, r3 READY WITH FOLLOW-UPS, all applied); APPROVED 2026-11-12 under the standing rule, Full tier (document schema, public commands, clipboard fragment, product behaviour). Visualization-track item [V-37](d9-visualization-track.md#status-index). Requested by the user on 2026-11-12 (item 7 of the Figma gap list: "1~10번까지 다 진행해줘"); the request lifts the [requirements](../requirements.md#symbols) deferral of variants and general property overrides, which this contract's PR changes. Questions V37-Q1 to V37-Q9 (section 9) are adopted as recommended under the user's standing instruction of 2026-10-24 (추천안 자동 채택, recommended option auto-adopted).

Owners: this file owns the `symbolSet` node, the symbol `variant` and instance `overrides` fields and their rules, the override step of the expansion, the variant and override commands and codes, the fragment rule for sets, the UI of section 6, criteria V37-A01 to V37-A14 and the units. The [M7 contract](mvp-m7-symbols-contract.md) and the [M6a text overrides](mvp-m6a-text-model-contract.md) (M7-T3) stay in force except as section 1.2 lists. Nested instances (an instance inside a source) stay deferred.

## 1. Scope

A Figma user can:

- select two or more components (symbols) and **combine them as variants**: they move into a component set (`symbolSet`), each one named by property values such as `State=Hover, Size=Large`;
- edit the variant properties of a set (add, rename or remove a property, change a variant's values) and add a variant by duplicating one;
- place an instance of a set (its default variant) and **switch the instance's variant** from one dropdown per property, keeping its overrides where the layer exists in the new variant;
- **override properties** of any layer inside an instance (fill, stroke, opacity, visibility, effects), on top of the existing text override, then reset one layer or all of them;
- detach, copy and paste such instances with their overrides.

Out of scope: nested instances and instance swap properties; Figma "component properties" (boolean, text and instance-swap properties bound to layers); overriding a layer's position, size, geometry, corner radii or text style; interactive variants (prototyping); a set spanning pages; libraries shared between documents.

### 1.1 Starting point (main at dd0a14b)

- Schema v7 (`packages/model/src/types.ts:408-420`): `symbol` has a frame's fields plus `effects`; `instance` has `symbol`, `textOverrides` (keyed by text-node IDs of its source's subtree, M7-T3) and `effects`. A source may sit anywhere except inside a `symbol` (M7-S3).
- The expansion (`packages/editor-core/src/expansion.ts`) copies the source's descendants, replaces an overridden text node's `runs` before the scale map (`expansion.ts:192-209`), and caches per source child keyed by node identity and by override value (`sameOverrides`, `expansion.ts:133`).
- `pruneOverrides` (`draft.ts:162`, `draft.ts:213`) drops text-override keys whose node left the source; `instance-text.ts` maps override keys when a source is copied with its instance; fragments are version 2 with carried `sources` and `sourceNodes` (`clipboard.ts:126`).
- The property panel shows "Create instance" for a source, and "Detach instance" plus one "Reset text" per overridden text node for an instance (`packages/ui/src/property-model.ts:458-512`). A double-click on an instance does nothing (M7-Q14 (a)).

### 1.2 Changes to earlier rules

- M7 section 1 (out of scope: variants and general property overrides) and `requirements.md` Symbols: lifted as section 1 says.
- M7-S1 and M7-S3: a `symbol` may also be a child of a `symbolSet`; nothing else may (section 2).
- M7 section 5.1 (`setNodeProps` on an instance): unchanged; overrides of the instance's content go through section 4.2's commands.
- M7-Q14 (a): a double-click on an instance now focuses the layer under the pointer for override editing (section 6.3); `setScope` on an instance still fails.
- M7 section 5.3: an instance whose `symbol` changes counts as reparented, so the M7-S5 depth checks visit it (section 4.1, `setInstanceVariant`).
- M7 section 6: a root or carried `symbol` in a fragment never has a `variant` (section 5).
- M1 to M7, every rule for a `frame` (clip, background, border, effects, the top-level artboard hit and paste target, scope entry, marquee, snapping) applies to a `symbolSet` too, except as section 2.1 says.

## 2. Schema (v8, optional fields)

Per the coordinator's rule of 2026-11-12, the first Figma-gap item to merge introduces v8 and later items add optional fields to the unreleased v8 with no further bump; V-37's fields are optional, so its part of the v7 to v8 step changes no node (an absent field means no variant and no override). V-37 rebases onto the v8 on main at its merge slot.

```ts
type SymbolSetNode = NodeBaseV2 & NodeEffects & {
  type: 'symbolSet'; children: readonly string[]; fill: Paint | null; stroke: Stroke | null;
};
type SymbolNodeV8 = SymbolNodeV7 & { variant?: Readonly<Record<string, string>> };
type NodeOverride = Readonly<{
  fill?: Paint | null; stroke?: Stroke | null; opacity?: number; visible?: boolean; effects?: readonly Effect[];
}>;
type InstanceNodeV8 = InstanceNodeV7 & { overrides?: Readonly<Record<string, NodeOverride>> };
```

- **V37-S1 set.** A `symbolSet` is a frame-like container (clip, background, border, effects, opacity as a frame at v7) whose children are one or more `symbol` nodes and nothing else (`document.invalid-symbol` at `/nodes/<child>/parent`). It never has a `symbol` or `symbolSet` ancestor (same code at `/nodes/<id>/parent`). A set with no children is `document.invalid-field` at `/nodes/<id>/children`.
- **V37-S2 variant.** A `symbol` in a set has a `variant` with 1 to 16 entries; a symbol outside a set has none (`document.invalid-field` at `/nodes/<id>/variant` either way). Names and values are 1 to 64 UTF-16 units with no control character, no lone surrogate, and no `=` or `,` in a name (`document.invalid-field` at the entry). Every symbol of one set has the same set of names, and no two have equal values for every name (`document.invalid-variant` at `/nodes/<later sibling>/variant`, new). Serialized keys are in UTF-16 code unit order. The set's **properties** are derived: each name, with its values in first-appearance order over the children. The **default variant** is the set's first child.
- **V37-S3 overrides.** Each key of `overrides` names a node of the instance's source subtree, the source itself included (`document.invalid-symbol` at `/nodes/<id>/overrides/<key>` otherwise, as M7-T3); an override has at least one field; serialized keys in code unit order. A field must apply to the node: `fill` to a node with a `fill` field (not text, line or group), `stroke` to a node with a `stroke` field, `opacity` and `visible` to any descendant but not the source itself, `effects` to any descendant (the source's own effects stay the instance's `effects` field); otherwise `document.invalid-field` at `/nodes/<id>/overrides/<key>/<field>`. Values follow the node field's own rules (paint, stroke, `[0, 1]` opacity, E41-S3 effects). Text runs stay in `textOverrides`.
- **V37-S4 later items.** An overridable field changed by another v8 item (for example multiple fills) changes the override value type with it, in the same PR as that item if it lands after V-37, or in V-37's rebase if it lands before.
- Canonical form: `variant` and `overrides` are omitted when absent; an empty `overrides` is written as absent. `symbolSet` keys serialize as a frame's (`effects` included). `variant` is a symbol's last key and `overrides` an instance's last key among the keys in force when V-37 merges; an optional key another v8 item adds later goes after them, as `parse.ts` fixes its order.
- **Check order.** In `readDocumentV2`: V37-S1 and the M7-S3 nesting loop together (one pass, node map entry order), then V37-S2 per set in node map entry order, then the M7-T3 key rule over every instance, then V37-S3 over every instance (two passes, each in node map entry order; U1 amendment 2026-11-12), then M7-S5. Every V37-S3 key failure, a key naming no node included, uses the code of the M7-T3 key failure, `document.invalid-symbol` (`parse.ts:1331-1333`), at `/nodes/<id>/overrides/<key>`.
- **If V-37 merges before the v8 scaffold** (coordinator rule of 2026-11-12): it introduces v8 itself, with the scaffold's identity migration, the moved `unsupported-version` fixtures and the fragment pair (version 2 at schema 8) under M7 section 6's future-bump rule. Otherwise it only adds its fields and types to the scaffold's v8.

### 2.1 Editor behaviour of a set

- **As a frame.** A set is hit, selected, entered as scope, marquee-selected and snapped to as a frame. A top-level set is an artboard (`isFrameLike`), so a click inside it selects the variant under the pointer, and a click inside a variant selects that variant (its outermost ancestor below the scope); entering a variant as scope edits its content.
- **Resize.** `setFrames` on a set, and a resize of a group or frame holding one, change the set's own frame and never its children: a set applies no constraints, so resizing a set resizes no variant and no instance. A flip (V-24) of a set mirrors its variants' placement inside it but not their content, so no instance changes (U3 review amendment 2026-11-12).
- **Paste and adoption.** A selected set is the paste target (M2 section 6) only when every fragment root is a `symbol`; otherwise the paste goes to the set's parent. When the one selected node is a variant and every fragment root is a `symbol`, the target is its set, so pasting a copied variant next to a selected one adds a variant (U3 review amendment 2026-11-12). V-25 drop and draw adoption (`adopt.ts:116`) adopts a dragged `symbol` into a set under the pointer, as Figma does, and never adopts anything else into one; a variant dragged out of its set and dropped outside it is re-parented to the drop target (losing its `variant`, the set removed if left empty), as a frame child is.
- **Only symbols inside.** Any command that would put a node other than a `symbol` directly in a set (every creating command and `runCommand` with the set as `parent`, `moveNodes`, `groupNodes`, `booleanNodes`, `paste`, `duplicateNodes`) fails with `editor.invalid-parent` at the M1 position of the parent check. `ungroupNodes` on a set fails as on a frame. With a set as scope, the drawing tools and `paste` target the set's parent (the page for a top-level set), so drawing never fails there.
- **Removal.** A command that leaves a set with no children removes the set in the same transaction (one history entry); a removed set leaves the selection, and a scope at or inside it falls back to the set's parent scope.

## 3. Expansion

- **V37-X1 override step.** Before the scale map (M7-X1) and with the text override (M7-T3), each copied source node whose ID keys an override takes the override's fields in place of its own. The source's own `fill` and `stroke` override replaces the instance background and border taken from the source (M7 section 4.1). A descendant with `visible: false` after the override projects nothing, as any hidden node.
- **V37-X2 cache.** The reuse key of an expanded child subtree (M7-X4) adds its property overrides, compared by value as `sameOverrides` does for text; the instance's background key adds the source-key override.
- **V37-X3 validity and determinism.** M7-X3 and M7-X6 apply unchanged: an overridden expansion that fails `validateNode` is `editor.invalid-expansion`; an instance with no overrides expands exactly as at v7.
- **V37-X4 key upkeep.** When a node leaves a source's subtree (delete, cut, move out) or changes type so a field no longer applies, the same transaction drops the override keys or fields that no longer satisfy V37-S3, as `draft.ts` does for text keys (M7-T3). Undo restores them with the document.

## 4. Commands

### 4.1 Variants

- **`combineAsVariants { ids }`.** Two or more distinct `symbol` IDs, siblings on the active page, none in a set. A new `symbolSet` (one ID drawn after every check) takes their place at the topmost one's paint index, frame equal to their visual bounds union (M7 section 5.1's wrap rule) grown by 20 on each side, rotation 0, `start` constraints, fill null, stroke a 1-unit dashed `#9747FF` (pattern `[4, 4]`), name `Component set`. The symbols keep their page placement. Each gets `variant { Property 1: <value> }`, the value derived from its name (V37-N1) and made distinct (V37-N2) in the set's child order. Returns the set's ID. Codes in order: `editor.invalid-command` at `/ids` (not a list of at least two distinct strings), `editor.unknown-node`, `editor.not-a-symbol`, `editor.not-siblings`, `editor.invalid-variant` (one already in a set), then the wrap checks of M7 section 5.1 and `editor.duplicate-id`.
- **`setVariantProperties { updates: [{ id, variant }] }`.** Replaces the `variant` of each listed symbol (each must be in a set) in one transaction; the result must satisfy V37-S2 for every set touched, so renaming, adding or removing a property across a set is one call. Codes: `editor.invalid-command` (shape, an empty or repeated update list), `editor.unknown-node`, `editor.not-a-symbol`, `editor.invalid-variant` (not in a set), then the model's V37-S2 codes.
- **V37-N1 value from a name.** Control characters and lone surrogates removed, cut to at most 60 UTF-16 units without splitting a pair, and `Variant` when nothing is left.
- **V37-N2 distinct values.** A symbol whose tuple equals an earlier sibling's gets the smallest suffix ` 2`, ` 3` ... on its first property's value that makes it distinct, the value cut first so value plus suffix stay within 64 units. Only the new or entering symbols take suffixes; symbols already in the set keep their values. Entering symbols are processed in the set's child order after the command.
- **Entering and leaving a set.** A `symbol` whose parent changes from a non-set node to a set (`moveNodes`, `paste`), takes the set's names with the values of the set's first child before the command, then V37-N2. A `duplicateNodes` copy of a variant keeps its own values, then V37-N2 (so "Add variant" makes `Hover 2` from `Hover`). Several symbols entering in one command are processed in the set's child order after it. Reordering inside a set changes no value; moving the first child elsewhere changes the default variant (disclosed, as Figma's top-left default). A symbol whose parent changes from a set to a non-set node loses its `variant`; one moved from one set to another takes the new set's names as entering. A symbol in a set is a source like any other: M7 section 5.4 detaches its instances when it is deleted or cut, then the removal rule of section 2.1 applies.
- **`createInstance { symbol }`** accepts a `symbolSet` ID and places an instance of its default variant, with the default size and top-left of M7 section 5.1 taken from the default variant, not the set.
- **`setInstanceVariant { id, values }`.** `id` an instance on the active page; `values` maps one or more property names to values. The target is the symbol of the same set whose `variant` equals the instance's current source's with `values` applied. The instance's `symbol` becomes the target; its frame keeps its top-left and rotation, and takes the target's size when its size equals the old source's (Figma's unresized case), else keeps its size. Overrides carry by **layer path** (V37-Q3): a key's path is the list, from the source down, of each node's name and its index among same-named siblings; a key moves to the target's node with the same path and is dropped when there is none or V37-S3 rejects a field (that field dropped, the rest kept); text keys move only to a text node; a carried field equal to the target node's own value is dropped (section 4.2's rule). Returns empty `ids`; the selection is unchanged. Codes in order: `editor.invalid-command` (`/id` not a string, `/values` not an object with at least one entry, a value not a string at `/values/<name>`), `editor.unknown-node` (not on the active page), `editor.not-an-instance`, `editor.invalid-variant` (source not in a set, no path), `editor.no-such-variant` (new: a name the set does not have, or no symbol matching, at `/values/<name>` for the first unknown name, else `/values`), then the M7-S5 checks of the instance as a reparented node (`document.invalid-field` tree depth, `editor.clip-depth`), `editor.invalid-expansion` and `editor.expansion-limit` as M7 sections 5.1 and 5.5 order them for `createInstance`. A `values` that names the current variant changes nothing and pushes no history entry.

### 4.2 Overrides

- **`setInstanceOverride { id, node, props }`.** `props` holds any of the V37-S3 fields; a field set to `undefined` is invalid, a field whose value equals the source node's own value removes that field's override (so reset by value works), and an override left with no field is removed. Codes: `editor.invalid-command` (shape, unknown prop at `/props/<key>`), `editor.unknown-node`, `editor.not-an-instance`, `editor.invalid-override` (new: `node` not in the source subtree, path `/node`), then V37-S3's model codes and `editor.invalid-expansion`. Gesture-free; one history entry; the selection is unchanged. The instance must be on the active page.
- **`resetInstanceOverrides { id, node? }`.** Removes the property and text overrides of `node`, or every override without `node`, for an instance on the active page. Codes: `editor.invalid-command` (shape), `editor.unknown-node`, `editor.not-an-instance`, `editor.invalid-override` (`node` not in the source subtree); a reset that removes nothing pushes no history entry. `clearInstanceText` stays.
- **Detach** (M7 section 5.2): the detached frame's children are copies of the overridden expansion, so detach keeps every override. The frame takes the source-key fill and stroke override when present.

## 5. Clipboard

- **No variant in a fragment.** `copyFragment` writes a copied root `symbol` and every carried source without `variant`, since both land outside a set (a carried source keeps its own ID for linking, M7 section 6). A fragment root or carried root with a `variant` fails with `editor.invalid-clipboard` at `/nodes/<id>/variant` or `/sourceNodes/<id>/variant`, checked with the reference rules, before `validateFragmentTree` runs. A set copied as a root keeps its variants' values and pastes as a new, independent set with fresh IDs (M7-Q10 (a)); a root symbol pasted into a set takes values as section 4.1 says.
- **Linking is unchanged.** An instance whose source is a variant links to the carried ID by M7 section 6's rules (1) and (2); rule (2) compares the carried subtree, which never has a `variant`, against the target symbol with its `variant` left out. A linked copy in a document whose symbol is in a set can switch variants; a detached paste is a frame. The set is not carried (V37-Q9).
- **Overrides.** A copied instance keeps `overrides`, under the M7-T3 key rule: with its source copied too, keys map to the source copies; a linked copy keeps them; a detached paste bakes them in. `validateFragmentTree` skips the V37-S3 key rule as it skips M7-T3's (`parse.ts:213-219`); the fragment parse checks instead, after the instance references, that every key names a node of the copied or carried source subtree and every field applies to it (`editor.invalid-clipboard` at `/nodes/<id>/overrides/<key>`, the first failing field's path when the key exists). V37-S1 and V37-S2 run in `validateFragmentTree` like M7-S3.

## 6. UI (`ui`, `react`)

### 6.1 Selection of symbols and sets

- Two or more selected symbols, none in a set: a "Combine as variants" button in the property panel's Component section and a context-menu item of the same name.
- A selected set: a "Properties" list, each property with an editable name (rename across the set), its values listed, a remove button (disabled with one property left), an "Add property" button (new name `Property N`, every variant's value `Default`, values made distinct by suffix as above), and an "Add variant" button that duplicates the selected or first variant. The layers panel shows a set with its own icon, its variants as children.
- A selected symbol in a set: one text field per property for its value, writing through `setVariantProperties`; an invalid value shows the code inline and changes nothing.

### 6.2 Instances

- For an instance whose source is in a set, a "Variant" section with one dropdown per property listing the set's values; picking one calls `setInstanceVariant`. A value with no matching variant for the other current values is listed but disabled.
- A "Layers" list under the Component section: the source's subtree, indented, each row marked when it holds an override. Picking a row focuses that layer (section 6.3).
- With a focused layer: Fill and Stroke colour, Opacity, a visibility toggle, the Effects list of E41 (the same controls as a node's) and a "Reset" button, writing through `setInstanceOverride` and `resetInstanceOverrides`. "Reset all overrides" sits next to "Detach instance". The existing "Reset text" rows stay.

### 6.3 Canvas focus

A double-click on an instance focuses the deepest visible source layer under the pointer, through a new query `{ type: 'instanceLayerAt'; id; point }` (`point` in page coordinates) that hit-tests the expansion with the M1 section 6 rules and returns the source node ID or null. editor-core's select tool keeps doing nothing on a double-click of an instance (M7-Q14 (a), `tools.ts:2010-2030`) and emits the existing double-click input unchanged; the react studio layer reads the selection after it, and when the one selected node is an instance, runs the query with the pointer's page point. When the selection is a group holding instances, the layer under the point of the innermost instance under it is focused and that instance shown as the target in the panel, the group staying selected (A13 covers a top-level instance only; disclosed). A double-click on an instance inside a group first enters the group (M2 section 5) and selects the next node on the hit chain, so the group branch is reached through nested groups or a Layers-row pick; a direct child instance is simply focused as the one selected node (U4 review amendment 2026-11-12). The outline uses the query `{ type: 'instanceLayerCorners'; id; node }`, the page-space corners of the expanded node's rotated frame, so it matches the expansion under any scale. An Escape while a focus stands clears only the focus; an Escape in a panel field is the field's. The focused layer's rotated box is drawn as a thin outline in the selection overlay. The focus is UI state, not editor state: it clears when the selection changes, on Escape, and when the layer leaves the source. Selection, scope and history are unchanged (V37-Q2).

### 6.4 Failure codes

| Code | New | Where |
| --- | --- | --- |
| `document.invalid-variant` | yes | V37-S2 duplicate tuple or unequal names |
| `editor.invalid-variant` | yes | `combineAsVariants` over a set member, `setVariantProperties` or `setInstanceVariant` outside a set |
| `editor.no-such-variant` | yes | `setInstanceVariant` |
| `editor.invalid-override` | yes | `setInstanceOverride` with a node outside the source subtree |
| `editor.invalid-parent` | no | a non-symbol into a set (section 2.1) |

The new codes join the public code lists (`packages/editor-core/src/types.ts`, the model's code union) and `docs/host-api.md`. The new commands and the query join the command and query unions there.

## 7. Acceptance criteria

| ID | Criterion | Evidence |
| --- | --- | --- |
| V37-A01 | v7 documents load as v8 unchanged; a v8 document with sets, variants and overrides round-trips byte for byte through `serializeDocument`, the M5 envelope and IndexedDB | model and persistence unit tests |
| V37-A02 | Every V37-S1 to S3 violation fails with its code and path; fixtures under `malformed/` | model unit tests |
| V37-A03 | An overridden expansion equals the source copy with the override fields applied, then mapped (M7-X1); no overrides equals v7 output | editor-core unit tests |
| V37-A04 | Source edits still propagate to overridden instances on fields without an override; an overridden field keeps its override | editor-core unit tests |
| V37-A05 | The cache recomputes only the child subtrees whose overrides changed | editor-core unit test with expansion counters |
| V37-A06 | `combineAsVariants` (with V37-N1 and N2 names), `setVariantProperties`, the enter, leave, duplicate and reorder rules, the set rules of section 2.1 (resize, only symbols, drawing in a set scope) and adoption into and out of a set, the removal of an empty set (delete of a used variant, of the default variant, cut of a variant, delete of the set: instances detached, one undo step) give the documents of sections 2.1 and 4.1; every listed code fires in its order | editor-core unit tests |
| V37-A07 | `setInstanceVariant` swaps the source, applies the size rule, carries overrides by layer path and drops the rest (equal-value fields included), fails a too-deep target with the M7-S5 codes, and gives every listed code in order; `createInstance` of a set places the default variant; undo restores the instance byte for byte | editor-core unit tests |
| V37-A08 | `setInstanceOverride` and `resetInstanceOverrides` set, remove by equal value, and reset, with their codes in order; key upkeep (V37-X4) after delete, cut, move and type change | editor-core unit tests |
| V37-A09 | Detach keeps every override; the detached projection equals the instance's (M7-Q7 (a)) | editor-core unit test |
| V37-A10 | Copy and paste of an overridden instance of a variant, linked and detached, then a variant switch of the linked copy; copy of a lone variant and of a whole set; the fragment `variant` and override-key failures | editor-core unit tests |
| V37-A11 | Projection and SVG export (V-30) of an overridden instance show the overrides | editor-core unit tests |
| V37-A12 | The panel models of section 6 produce the listed controls and commands, including the innermost-instance focus under a selected group | ui unit tests |
| V37-A13 | Headed next-host: combine three symbols, switch an instance's variant from the dropdown, override a layer's fill from a double-click focus, reset it; Chrome and Edge | `tests/v37-next-host` on the main PC, or NOT RUN with the reason |
| V37-A14 | `pnpm check`, `pnpm build`, `pnpm test:unit` and CI pass | CI |

## 8. Units

| Unit | Content | Criteria |
| --- | --- | --- |
| V37-U1 | Model: `symbolSet`, `variant`, `overrides`, rules, serialize, fixtures, fragment validation | A01, A02 |
| V37-U2 | Expansion override step, cache key, key upkeep, detach | A03 to A05, A09, A11 |
| V37-U3 | Commands of section 4, clipboard of section 5 | A06 to A08, A10 |
| V37-U4 | UI and `instanceLayerAt`, next-host fixture and headed spec, requirements and status rows | A12, A13 |

Units may be merged into fewer PRs while each PR stays reviewable; each PR gets an independent review.

## 9. Questions (adopted as recommended, 2026-11-12)

- **V37-Q1 set representation.** (a) a `symbolSet` container holding the variant symbols, as Figma's component set [recommended: the set is visible on the canvas, carries properties by its children and needs no name matching]; (b) a `variantOf` string on loose symbols.
- **V37-Q2 override editing.** (a) the panel's Layers list plus a double-click focus that is UI state [recommended: keeps selection, scope and history on document IDs]; (b) full selection of expanded nodes as in Figma, which changes the selection model (M7-Q13).
- **V37-Q3 carrying overrides across variants.** (a) by layer name path with sibling index [recommended: Figma's behaviour; IDs differ between variants]; (b) drop all overrides on a switch.
- **V37-Q4 instance size on a switch.** (a) take the new variant's size only when the instance was not resized [recommended: Figma]; (b) always keep the instance's size.
- **V37-Q5 overridable fields.** (a) fill, stroke, opacity, visibility and effects [recommended: the appearance fields Figma overrides most; geometry and layout stay the source's]; (b) also corner radii and text style.
- **V37-Q6 combine naming.** (a) `Property 1` valued by each symbol's name [recommended: names are meaningful; Figma uses `Default`, `Variant2`]; (b) Figma's names.
- **V37-Q7 empty set.** (a) deleted with its last variant [recommended: Figma]; (b) kept as an empty container.
- **V37-Q8 schema field form.** (a) optional fields on v8, omitted when absent [recommended: the coordinator's shared-v8 rule]; (b) always-present fields as `textOverrides` at v5.
- **V37-Q9 sets in fragments.** (a) carry only the instance's own variant, so cross-document copies link or detach as in M7 [recommended: M7 never pastes carried sources as nodes]; (b) carry and paste the whole set.

## 10. Risks

- Shared v8: other Figma-gap items change the same parse, serialize and fixture files; V-37 rebases last-in-order and re-runs A01 and A02 after each rebase.
- Layer-path carrying depends on names; duplicate names fall back to sibling index, which can pick a different layer after reordering (disclosed, Figma has the same limit).
- Cost: overrides add a by-value comparison per overridden child to every projection; A05 checks reuse, and no performance claim is made.

## 11. Record

- **U1 to U3 (2026-11-12).** Commits f2acdf9 (U1, U2) and 529d8c3 plus follow-ups (U3) on `claude/project-thread-6usbvu`. Code review r1 READY WITH FOLLOW-UPS (B1 expansion cap with overrides, B2 IndexedDB round trip, S1 to S7), r2 READY WITH FOLLOW-UPS (flip of a set, extra A06 tests, paste with a selected variant, record), all applied. Unit tests `tests/unit/v37-variants-model.test.ts`, `v37-expansion.test.ts`, `v37-commands.test.ts`; `pnpm test:unit` passes except `p3-b0r-identity`, which fails locally on clean main too (CI green on main). PR and merge commit: see the PR.
- **U4 (2026-11-12).** Panel UI, `instanceLayerAt` and `instanceLayerCorners`, canvas focus, next-host fixture `v37-variants` and `tests/v37-next-host`. Code review READY WITH FOLLOW-UPS (Escape clearing the selection, group-focus reach, exact outline, store tests, docs), all applied. Headless Chromium smoke of the A13 spec 1/1 PASS in the container (not evidence); headed Chrome and Edge A13 on the main PC: see the U4 PR.
