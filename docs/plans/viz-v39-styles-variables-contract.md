# V-39 contract: eyedropper, colour styles and variables

Status: APPROVED 2026-11-12 (independent review r3 READY), Full tier. Visualization-track item [V-39](d9-visualization-track.md#status-index). Owners: the visualization track (Primary). Requested by the user on 2026-11-12 (item 9 of the Figma gap list, "1~10번까지 다 진행해줘"). It moves colour styles and variables (design tokens) into the supported behavior of [requirements](../requirements.md#initial-appearance-model). Questions V39-Q1 to V39-Q8 (section 9) take the recommended option under the user's standing instruction of 2026-10-24 (추천안 자동 채택, recommended option auto-adopted) unless the user picks otherwise. Section 11 records the reviews.

It changes `model` (optional document and node fields of schema v8), `editor-core` (commands, two queries, one tool, the binding rules), `react` (re-exports), `ui` (panels and controls) and `apps/next-host` (the studio mounts the panel, the overlay draws the eyedropper). It changes no scene contract, renderer, projector output or export: a bound property always holds its concrete value (V39-Q1), so every reader of the document reads it as today.

## 1. What a user can do

- **Eyedropper.** Press `I` (or the toolbar's eyedropper) and click anything on the canvas: the selection takes that colour as its fill (Shift-click: its stroke). With nothing selected the colour is shown and copied as `#RRGGBB`. Each colour well also offers "Pick from screen" (the browser's screen eyedropper) where the browser has one.
- **Colour styles.** Save a fill or stroke paint (solid or gradient) as a named style, apply it to a fill, a stroke or a text colour from a style menu, edit the style once and every user changes, detach a node, delete a style (its users keep the colour).
- **Variables.** Define colour and number variables with values per mode (for example Light and Dark), bind colour variables to fill, stroke and text colour and number variables to opacity, stroke width and corner radius, and switch the document's active mode to restyle every bound node.

## 2. Model (schema v8, optional fields)

The project's schema rule of 2026-11-12: one scaffold PR introduces v8 (renames and an identity `migrateV7toV8`); each gap item adds optional fields to v8 with no further bump. V-39 adds three optional fields; the migration adds none of them (absent means none). Older builds reject v8 documents and v8 fragments by version (M5's rule); that is accepted.

**V39-S1 colour styles.** `DocumentV8.colorStyles?: readonly ColorStyle[]`, 1 to 1,000 entries when present (removing the last style removes the key), in panel order:

```ts
type ColorStyle = { id: string; name: string; paint: Paint }; // Paint = Color | Gradient (M4-S1)
```

**V39-S2 variables.** `DocumentV8.variables?: VariableSet`, present only with at least one variable (removing the last variable removes the key, modes included):

```ts
type VariableMode = { id: string; name: string };
type Variable =
  | { id: string; name: string; type: 'color'; values: Readonly<Record<string, Color>> }
  | { id: string; name: string; type: 'number'; values: Readonly<Record<string, number>> };
type VariableSet = { modes: readonly VariableMode[]; mode: string; items: readonly Variable[] };
```

`modes` has 1 to 16 entries, `mode` names one of them (the active mode), `items` has 1 to 1,000 variables, each variable's `values` has exactly one key per mode (any key order). Number values are finite, `-0` normalized to `0`. With no variable set, the mode commands fail with `editor.unknown-mode` and the panel's mode controls are disabled.

**V39-S3 IDs and names.** Style, variable and mode IDs follow the model's ID rule (`isValidId`) and are unique across the document ID, the page IDs, the node IDs and the three tables together. The editor's ID source skips them too (`freshId`, every create, paste remap and `addPage`). Names are 1 to 200 UTF-16 units of valid run text (`isValidRunText`); names need not be unique.

**V39-S4 bindings.** Any node may carry `bindings?: Readonly<Partial<Record<BindingKey, BindingRef>>>`, never empty:

```ts
type BindingRef = { style: string } | { variable: string };
type BindingKey = 'fill' | 'stroke' | 'text' | 'opacity' | 'strokeWidth' | 'cornerRadius';
```

| Key | Allowed on | Property | Reference |
| --- | --- | --- | --- |
| `fill` | nodes with a `fill` field, non-null | `fill` | a style, or a colour variable |
| `stroke` | nodes with a non-null `stroke` | `stroke.color` | a style, or a colour variable |
| `text` | text nodes | the `color` of every run | a style whose paint is a `Color`, or a colour variable |
| `opacity` | every node | `opacity` | a number variable |
| `strokeWidth` | nodes with a non-null `stroke` | `stroke.width` | a number variable |
| `cornerRadius` | nodes with `cornerRadii` (rectangles today) | all four radii | a number variable |

**V39-S5 consistency.** Every bound property is present (a non-null `fill` or `stroke` for those keys) and equals its resolved value: a style's `paint`, or a variable's value in the active mode. Equality is after the model's normalization: numbers by `===`, colours per channel, gradients deep (kind, transform, stops, spread). A number variable bound to any property satisfies that property's range in **every** mode (opacity in [0, 1], width and radius at least 0 and within the model's limits), so switching modes never leaves the range.

**V39-S6 validation order and codes.** Node checks (`validateNode`, also run for fragments and by commands on the nodes they build): `bindings` is a non-empty plain object whose keys are binding keys whose field the node's **type** has (S4's first column read by type, never by the field's current value) and whose values are exactly `{ style }` or `{ variable }` with a valid ID; else `document.invalid-field` at the offending key. Whether the field is non-null and consistent is a document check, which E4 keeps true in the editor. Document checks, after every existing node and tree rule (after `readTree`'s mask and symbol rules): (1) the tables' shapes, limits, names and the `values` keys (one per mode), `document.invalid-field`; (2) ID uniqueness across S3, `document.duplicate-id`; (3) `mode` naming no mode, `document.dangling-reference` at `/variables/mode`; (4) per node in code-unit ID order, per key in the table order of S4: a missing style or variable, `document.dangling-reference`; a reference of the wrong kind or type, a null bound field, a value that differs, or a bound number variable out of range in any mode (S5), `document.invalid-field`. Paths point at the binding (`/nodes/<id>/bindings/<key>`).

**V39-S7 serialization.** Document keys: `schemaVersion`, `id`, `colorStyles` (if present), `variables` (if present), `pages`, `nodes`. A style: `id`, `name`, `paint`. A variable set: `modes` (each `id`, `name`), `mode`, `items` (each `id`, `name`, `type`, `values` with its keys in code-unit order; integer-like keys still come first in numeric order, as for the node map and `textOverrides`). A node's `bindings` (if present) is its last key, after `effects`, keys in the S4 table order, each `{ style }` or `{ variable }`.

**V39-S8 fragments.** Clipboard fragments stay `{ schemaVersion, id, pages, nodes }` at the document version; nodes carry `bindings` checked by the node rules only. Paste applies V39-E5.

**V39-S9 expansions.** An instance's expansion nodes copy their source nodes, `bindings` included; they are never S5-checked (they are not document nodes).

## 3. Editor commands (`editor-core`)

Each is one `DocumentCommand` and one undo step through an edit draft; a command that changes nothing records no step. Every command that changes a style's paint, a variable's value, the active mode, or removes a mode rewrites the bound properties of every node in the document (all pages) to their new resolved values in the same draft (**V39-E1 resync**), and the draft's normal checks then run (isolation depth, expansions, text refit).

| Command | Effect | Returns |
| --- | --- | --- |
| `createColorStyle { name, paint }` | appends a style | `[id]` |
| `updateColorStyle { id, name?, paint? }` | renames or repaints; resync | `[]` |
| `removeColorStyle { id }` | removes it; its bindings are dropped, the nodes keep their values | `[]` |
| `createVariable { name, type, value }` | appends a variable with `value` in every mode; creates the set with one mode `Mode 1` if absent | `[id]` |
| `updateVariable { id, name?, values? }` | renames, or sets the values of the listed modes; resync | `[]` |
| `removeVariable { id }` | as `removeColorStyle` | `[]` |
| `addVariableMode { name }` | appends a mode; each variable's value in it is its value in the active mode | `[id]` |
| `renameVariableMode { id, name }` | | `[]` |
| `removeVariableMode { id }` | the active mode moves to the first remaining one; resync | `[]` |
| `setVariableMode { id }` | sets the active mode; resync | `[]` |
| `bindProperty { ids, key, ref }` | V39-E2 | the changed IDs |

**V39-E2 bind.** `bindProperty` sets the property `key` of each listed node (active page, any depth) to the resolved value of `ref` and records the binding; `ref: null` drops the binding and keeps the value. Nodes that cannot carry `key` (S4) are skipped, except that `fill` on a node whose fill is null and `stroke` on a node whose stroke is null set the paint (the stroke: `DEFAULT_PATH_STROKE` for lines, paths and custom nodes, `DEFAULT_SHAPE_STROKE` otherwise, as `setStyle`). If no listed node can carry `key` the command is `editor.invalid-command` at `/key`. A `text` binding sets every run's colour and re-canonicalizes the runs (adjacent runs equal but for colour merge, M6a-S1).

**V39-E3 failure order.** For every section 3 command: `editor.invalid-command` (malformed fields, with a pointer; a name that breaks S3; a paint, value or `values` key that breaks S1 or S2; a `value` of the wrong type for `type`); `editor.unknown-node` (`bindProperty` IDs not on the active page); `editor.invalid-command` at `/key` when no listed node can carry `key`; `editor.unknown-style`, `editor.unknown-variable`, `editor.unknown-mode`; `editor.binding-type` (a number variable on a paint key, a colour variable on a number key, a gradient style on `text`, and `updateColorStyle` giving a gradient to a style bound to any `text`); `editor.binding-range` (a number value, in any mode, out of the range of a property bound to it or being bound, at `updateVariable` and `bindProperty`; S5 makes it hold for stored documents, so `setVariableMode` and `removeVariableMode` never fail on range); `editor.table-limit` (a 1,001st style or variable, or a 17th mode); `editor.last-mode` (removing the only mode); then the draft's checks (`editor.isolation-depth` and the others, in their M4 order).

**V39-E4 detach on edit.** At the end of every edit draft (`Draft.finish`, after the text refit, before the node checks), each node the draft touched loses every binding that no longer holds against the draft's tables: the reference is gone, the node can no longer carry the key (its stroke or fill set to null), or the value differs (S5). This covers commands, gesture updates and commits, paste, symbol, boolean and extension commands alike. So editing a bound colour, run colour, opacity, stroke width or radius detaches that property only (Figma), and a flip that mirrors a gradient (`mirrorContent`) detaches a gradient style binding. The draft and every document editor-core builds (`emptyDocument`, the clipboard's holders) carry the document-level fields. Undo, redo and load run no pass (a stored document is consistent, S5). A node built from another node's fields (duplicate, paste, detach, boolean result) carries its bindings and the pass drops those that no longer hold.

**V39-E5 paste.** Follows from E4: a pasted node keeps a binding only if the reference exists in the target document and the value holds. Fragments carry no tables (V39-Q6).

**V39-E6 sample.** `{ type: 'sampleColor'; point: PagePoint }` returns the colour under the page point on the active page, or null. The walk is the hit test's (reverse paint order, through groups, mask clips, frames and instance expansions, locked nodes included) with a paint rule instead of the hit tolerance: in a node's part drawn on top, the stroke within half its width of the outline (dash gaps included), else the fill area; a frame's or an instance source's border then background; a text node's box gives its first run's colour. The colour is the paint's: a solid as is, a gradient evaluated at the point (M4-S2 unit box, E23-K1 to K3, premultiplied interpolation, returned with straight alpha). Node and ancestor opacity are not applied, and fully transparent paints are sampled (V39-Q5).

**V39-E7 eyedropper tool.** Built-in tool `eyedropper` (in `ToolName`, `TOOL_NAMES`, `BUILT_IN_TOOLS`, so the M8 toolbar shows it too), default key `I`. While active the overlay is `{ kind: 'eyedropper'; point; color }` for the pointer's last position. A primary press samples; with a colour and a selection it applies it in one undo step (a gesture `replace` of `setStyle` and `setTextStyle` commands): `fill` on nodes with a fill field, the stroke colour on lines, the whole text's run colour on text nodes; with Shift the stroke colour on every node with a stroke field (a null stroke getting the `setStyle` default) and the run colour on text. Groups, mask groups and instances take nothing. The selection is kept. It then sets `pickedColor` (snapshot field, query `pickedColor`, session event field `pickedColor`; kept across `loadDocument`) and returns to the select tool. A press on nothing does nothing; Escape returns to the select tool. An extension tool ID `eyedropper` now collides with the built-in (as any built-in name).

## 4. Sibling items

- **Multiple fills.** `fill` binds the single `fill` field. If the multiple-fills item adds a fill list, binding list entries is that item's follow-up; until then a node with a list cannot carry the `fill` binding (E4 drops it).
- **Images.** A style paint is never an image. E6 returns null for an image paint (no pixel decoding).
- **Lock and hide.** E6 samples locked nodes; hidden nodes are skipped as by the hit test.
- **Auto layout.** If stroke width enters a layout, resync changes it through the draft, so that item's relayout in the draft applies.

## 5. UI (`ui`, `apps/next-host`)

**V39-U1 eyedropper.** The eyedropper is a tool button after Text (extension tools follow it). With nothing selected a pick copies `#RRGGBB` through `navigator.clipboard` (best effort) and the toolbar shows `Copied #RRGGBB` for 2 s. next-host's overlay draws a swatch of `color` beside the pointer. Every `ColorWell` gets a "Pick from screen" button where `window.EyeDropper` exists; its result commits as a picker change.

**V39-U2 style menu.** The appearance panel's fill and stroke rows and the property panel's text colour row get a Style button (four dots) with the colour styles (swatch and name), the colour variables, "Create style" (from the row's current paint, named `Color <n>`) and "Detach" when bound. A row whose selected nodes share one binding shows its name and swatch in place of the hex field; mixed bindings show `Mixed`. Editing the colour detaches (E4).

**V39-U3 number bindings.** The opacity, corner radius and stroke width fields get a bind button with the number variables and "Detach"; a bound field shows the variable's name and value; typing a value detaches.

**V39-U4 local styles panel.** `StylesPanel` (heading `Local styles`), mounted by the studio's right column when nothing is selected (not by the M8 layout): the colour styles (swatch, inline rename, a colour well for a solid style, delete) and `+` (a new style `#D9D9D9`, `Color <n>`); the variables with an active-mode selector, add, rename and remove mode, a row per variable (name, type, one value per mode as a colour well or number field, delete), and add colour or number variable.

## 6. Acceptance criteria

| ID | Criterion | Validation |
| --- | --- | --- |
| V39-A01 | The model reads, validates (S1 to S6 in order) and writes (S7) the fields; the migration adds none; fragments run the node rules only; a round trip is byte-identical | unit `tests/unit/v39-model.test.ts` |
| V39-A02 | Each section 3 command, its E3 failures in order, its single undo step and the resync across pages; after every command `validateDocument` passes | unit `tests/unit/v39-commands.test.ts` |
| V39-A03 | E4: `setStyle` on a bound fill, stroke colour or width (also inside a gesture `update`), `setTextStyle` on a run colour, `setNodeProps` opacity, a radius edit, and a flip of a gradient-style node drop only that binding; removing a stroke drops `stroke` and `strokeWidth`; duplicate, detach and a boolean result carry the bindings that still hold; undo restores; `validateDocument` passes after each | unit |
| V39-A04 | E6 samples a solid, linear and radial gradients with each spread, a stroke over its fill, text, a frame background and border, an expanded instance node and the topmost of overlapping nodes; null on empty canvas | unit `tests/unit/v39-eyedropper.test.ts` |
| V39-A05 | E7: fill, Shift stroke, text runs, groups skipped, one undo step, selection kept, `pickedColor`, return to select, Escape, empty press, the overlay | unit |
| V39-A06 | E5 paste within a document and into one without the tables | unit |
| V39-A07 | The UI: eyedropper button and copy notice; style menu applies, creates and detaches; number bind buttons; the panel creates, renames, edits and deletes styles and variables, adds a mode and switches it so a bound rectangle recolours on the canvas | unit (`ui` models and markup) + `tests/v39-styles/v39-styles.spec.ts`; acceptance needs the headed Chrome and Edge run on the main PC; the headless smoke project is the CI-free check |
| V39-A08 | New exports carry TSDoc and enter the M8 export lists and `docs/host-api.md`; the toolbar, keymap and tool lists include the eyedropper; requirements list styles and variables | `m8-u2-react-api`, `m8-u3-ui-api`, `m8-u3-ui-toolbar`, `m2-keymap` tests; review |
| V39-A09 | Regression: the unit suite in CI and `pnpm test:m8-next-host` headed on the main PC | CI + headed run |

## 7. Performance

E4 runs over the draft's touched nodes, so a gesture update costs O(touched) plus one table index per draft (built lazily, only when a touched node has bindings). Resync scans the document's nodes once per table change, O(nodes), which a style edit (one undo step) can afford; no binding index is kept. No renderer cost: projection sees concrete values only.

## 8. Known limits (disclosed)

- The canvas eyedropper samples the document's paint, not the rendered pixel: opacity, translucent layering, effects and anti-aliasing are not mixed in, dash gaps and fully transparent paints are sampled, and text gives its first run colour anywhere in its box. The screen picker of U1 samples pixels.
- Styles hold one paint; Figma's multi-paint, text, effect and grid styles are not included. A style cannot reference a variable. Variables have one collection, colour and number types only, one active mode per document (no per-frame mode), no aliasing and no scoping.
- Text binding covers the whole node, not a run range; instance text overrides keep their own colours.
- A flip mirrors gradient paints, so it detaches a gradient style (E4).
- Fragments do not carry styles or variables, so pasting into another document detaches.
- Styles and variables cannot be reordered in the panel yet.
- Removing the last variable removes the variable set, user-defined modes included.

## 9. Questions (recommended option first; adopted 2026-11-12, 추천안 자동 채택)

- **V39-Q1 storage.** (a) The node keeps the concrete value and a binding; commands keep them in step. (b) The node stores only a reference, resolved by the projector, export, hit test and panels. Recommended (a): no change to the projector, renderer, export, visual bounds or the sibling items' readers.
- **V39-Q2 direct edits.** (a) Detach the edited property (Figma). (b) Refuse the edit. (c) Write through to the style. Recommended (a).
- **V39-Q3 inconsistent stored documents.** (a) Invalid (S5). (b) Accepted and re-synced on load. Recommended (a): a load never rewrites the document.
- **V39-Q4 variable model.** (a) One collection, colour and number, modes. (b) Collections, all four Figma types, aliasing. Recommended (a), the smallest model with theme switching.
- **V39-Q5 canvas eyedropper source.** (a) The document paint under the point. (b) The rendered pixel by GPU readback. Recommended (a): exact colours, no renderer work, testable; the browser's screen picker covers pixels.
- **V39-Q6 paste across documents.** (a) Detach. (b) Carry the referenced tables in the fragment. Recommended (a).
- **V39-Q7 removing a style or variable.** (a) Users keep the value, detached (Figma). (b) Refuse while used. Recommended (a).
- **V39-Q8 panel placement.** (a) The right column with nothing selected (Figma's local styles). (b) A separate left tab. Recommended (a).

## 10. Units

- **V39-U-a** this contract.
- **V39-U-b** eyedropper: E6, E7, U1 (no schema change).
- **V39-U-c** model and commands: S1 to S9, E1 to E5 (after the v8 scaffold merges).
- **V39-U-d** UI: U2 to U4, the browser spec, host-api and requirements.
- **V39-U-e** record: headed run, status row.

## 11. Review record

- r1 (2026-11-12) NOT READY: E4 hook and the draft's document-level fields (B1), gradient style on text (B2), failure order and codes (B3), serialization and the v8 bump (B4), flip and A03 (B5), sibling items (B6), plus should-fix items (ID source, equality, carried bindings, run merge, ranges in every mode, E6 paint rule, E7 targets, public surface, packages, mixed rows, A02/A03 cross-check, performance, links). All applied in r2. The r1 note that `hit-test.ts` already had V-39 code: the eyedropper spike (E6, E7, U1's tool button and overlay: `editor-core` `eyedropper.ts`, `hit-test.ts`, `editor.ts`, `types.ts`, `keymap.ts`; `ui` toolbar lists and icon; next-host `overlay.tsx`; the keymap, toolbar and m6b tests; `tests/unit/v39-eyedropper.test.ts`) is held on the branch until this contract is accepted.
- r2 (2026-11-12) NOT READY: binding keys in `validateNode` would block removing a bound stroke or fill (N1, now type-level only), `values` key order impossible for integer-like IDs (N2, now any order, written in code-unit order), mode switching after loading out-of-range values (N3, S5 now requires the range in every mode); should-fix (no variable set, E3 order, mode limit wording, carried-binding tests, sibling wording, spike record) applied in r3.
- r3 (2026-11-12) READY; its optional note (`binding-range` cannot fire at `addVariableMode`) applied. The spike goes through its own diff review as V39-U-b.
