# MVP M6b contract: text editing

Status: APPROVED 2026-10-30 (#392, 09d8a2a; review r1 NOT READY applied, r2 READY WITH FOLLOW-UPS applied). Review r1 NOT READY: B1 edit-mode pointer rules, B2 forced end on every cancel path, B3 host ordering; should-fix 1 to 12; minors. Full tier (input model and key routing, public commands, session state and codes, history semantics, a host-side input sink, product behavior, an architecture paragraph). Not a shared-surface change under D9: `contracts`, the scene projection and the renderer are untouched (M6b projects nothing new). Visualization-track item [V-16](d9-visualization-track.md#status-index), milestone M6b of the [M6 text plan](mvp-m6-text-plan.md#8-milestone-split-and-units-m6-q1) and of [MVP plan M6](mvp-editor-plan.md#m6-text). Open questions M6b-Q1 to M6b-Q16 are in section 13; appendix A lists the synthetic traces and the CDP limits.

Owners: this file owns M6b scope; the `textEdit` session state, the edit-mode commands, the `text` tool, the `textinput` and composition input kinds, the edit-mode key routing (the M2 change the plan's M6-E3 names), the hidden textarea's host protocol, the `textEditOverlay` query, the caret and selection rules, the text gesture and the forced end, the undo merge, plain-text paste and edit-mode copy and cut, their codes, acceptance criteria M6b-A01 to M6b-A15, the units and the synthetic trace list (appendix A). Product behavior stays in [`requirements.md`](../requirements.md#text) (Text, and "Continuous pointer movement and text input are merged into useful history steps"), which this contract does not change; the M6 plan keeps M6-E1 to M6-E8 and the decisions of its [section 12](mvp-m6-text-plan.md#12-open-questions) (all adopted as (a), its section 14), which this contract makes concrete; the model, `TextLayoutPort`, text-dom and the text commands stay in the [M6a contract](mvp-m6a-text-model-contract.md); GPU text stays in E28 and M6c; package boundaries in [`ARCHITECTURE.md`](../../ARCHITECTURE.md#dependency-direction). The P5, M1 to M5, M6a and M7 rules stay in force except as section 1.2 lists.

## 1. Scope

In scope: the `text` tool (click and drag, pending node); edit mode `textEdit` with entry, exit and the selection rules; caret and selection over the port's layout (grapheme stops, wrap affinity, word, line and text movement, click, drag, double-click word, Mod+A); typing, LF, Backspace, Delete and word deletion; IME composition as a text gesture and its forced end; caret-carrying and merged history entries; the edit-mode key routing; `EditorCanvas`'s hidden textarea joining the focus target and its `beforeinput` and composition mapping; `textEditOverlay` and next-host's DOM caret, selection and composition underline; plain-text paste in and outside edit mode, and plain-text copy and cut in edit mode; committed caret scripts on the fake port and synthetic IME traces; headed caret, key-routing, paste and CDP IME specs on the main PC; the amendment of the architecture's text-reservation paragraph (M6-Q14 (a)).

Out of scope: visible text (GPU text is M6c: M6b's headed specs read state through the `?test=1` hook, as the plan's section 8 says, and add no debug text layer); the manual real-IME run (M6c); a text style panel and a collapsed-caret "typing style" (M8; `setTextStyle` stays a host command over a non-empty range); editing text inside an instance on the canvas (M6b-Q9); rich-text paste; triple-click paragraph selection; drag and drop of text; autoscroll while drag-selecting; Hanja reconversion of committed text; spell check; everything the plan's section 1 defers.

### 1.1 Starting point (main at b655b77)

- **Model and port.** Schema v6 (M4-U1 took v6 after M7-U7's v5); text nodes per M6a-S1 to S7 and the M7 addendum; `MAX_TEXT_LENGTH` 16,384. `TextLayoutPort` gives lines (`start`, `end`, `top`, `height`, `baseline`, `left`, `width`) and clusters (`start`, `end`, `line`, `run`, `x`, `y`, `advance`) in node-local page units (M6a-L1); text-dom measures at the reference scale of M6-Q3 (b) since #388 and returns page units, so nothing in M6b sees the scale.
- **Editor.** Tools are a closed `ToolName` of six (`packages/editor-core/src/types.ts:30`). `InputEvent` has pointer, key, wheel, double-click and cancel kinds; `keydown` carries `composing` (`types.ts:45-74`). `dispatch` runs the M2-I2 order (`packages/editor-core/src/editor.ts:1321-1404`); `eventToken` reads `code` for a composing, `Process` or non-ASCII key (`packages/editor-core/src/keymap.ts:175-186`), so the `Process` keydown for ㄱ resolves to `KeyR`; `isSpaceKey` gives Space to navigation also under an IME (`keymap.ts:188-191`). A document command during a gesture applies to the pre-gesture base and cancels the gesture (`editor.ts:880-904`, `interrupt` at `1840-1844`). History entries are `{ before, after, touched, drawn }` with no session state (`editor.ts:174-183`); a gesture commit pushes one (`editor.ts:1830`). The gesture record keeps `pathEdit` (`editor.ts:185-198`); `GestureControl` is `begin` (returns a boolean), `update`, `replace`, `edit`, `commit`, `cancel` (`editor.ts:150-172`). `setText` is a document command (`editor.ts:243`) and not a relative command (`editor.ts:253`; M6a section 16, U3 notes: "M6b owns text gestures"). `styleBefore` and `replaceText` exist (`packages/editor-core/src/text.ts:222`, `263`). Double-click enters a path's edit mode or a container's scope (`packages/editor-core/src/tools.ts:674-690`); `enterScope` does the same for Enter (`editor.ts:1436-1444`).
- **Clipboard.** Unmarked text fails with `editor.unsupported-clipboard` (`packages/editor-core/src/clipboard.ts:443`); fragments are written at schema 6 (`clipboard.ts:105`, `167`).
- **Host.** `EditorCanvas`'s `<canvas tabIndex={0}>` takes keydown and keyup through React handlers (`packages/react/src/canvas.tsx:139-164`); wheel, blur, `copy`, `cut` and `paste` listeners are on the canvas, since the M2-U6 probe found that Chrome and Edge fire clipboard events on a focused canvas, so no hidden clipboard sink exists (`packages/react/src/canvas-input.ts:300-333`); a DOM `paste` always runs `paste { text }` (`canvas-input.ts:249-253`); a DOM `copy` or `cut` is left to the browser unless the command returns IDs (`canvas-input.ts:242-247`); a canvas blur whose `relatedTarget` is outside the target and a window blur both run `reset` (`canvas-input.ts:308-313`). next-host draws its overlay in DOM (`apps/next-host/src/overlay.tsx`).
- **Evidence.** The [M6-S0 record](../evidence/m6-s0/main-pc-2026-10-29.md) has no IME traces: `docs/evidence/m6-s0/traces/` does not exist yet and the recordings need the user at the main PC. The [recorder](../evidence/m6-s0/README.md#korean-ime-recorder) and its CDP smoke check exist. The [M6a exit record](../evidence/m6a-exit-2026-10-30.md) awaits the user's acceptance.

### 1.2 Changes to earlier rules

- **M2-I2 and M2-I3** (dispatch and `consumed`): in edit mode the order of section 5 replaces steps (1) and (4) for keys, and input results gain `passThrough` (section 5.2). Outside edit mode nothing changes.
- **M2-I4** (`EditorCanvas`): the hidden textarea joins the canvas's focus target, and the keydown, keyup, `copy`, `cut`, `paste` and blur listeners cover it (section 6). Focus moving between the canvas and the textarea is not a blur.
- **M2 section 6 and M7 section 6** (clipboard): unmarked non-empty text no longer fails outside edit mode; it creates a text node (section 9). `paste` gains `pointer`. In edit mode `copy`, `cut` and `paste` act on text; an edit-mode copy or cut puts plain text, not a fragment, into the in-memory clipboard and clears its carried-source link set (M7 rule (1)), so a later `paste {}` follows section 9.4. `EditorCanvas.clipboardCopy` handles the edit-mode result (section 9.2).
- **M2 section 7 and M3 section 4** (keymap, Enter, double-click): `enterScope` on one selected text node and a select-tool double-click whose target is a text node enter text edit (section 3.2); in edit mode no binding runs and a bound chord is a consumed no-op (section 5, rule 6); `DEFAULT_KEYMAP` gains `T` → `setTool { tool: 'text' }`.
- **M6-E2** (the plan's mapping list): `insertFromPaste` is not mapped, since paste arrives through the DOM `paste` event (M6b-Q3 (a)); `insertLineBreak` and `insertParagraph` are mapped in one case only (M6b-H3), where M6-E2 maps none.
- **P5 `run()`, `interrupt` and M5-U2 note 2**: every path that would cancel an active text gesture commits it first (section 7.3); other gestures keep today's rule.
- **P5 history**: entries gain the caret before and after, and text input merges into the top entry (section 8).
- **M6a section 6.1**: `setText` stays a document command; the composition gesture uses it through `replace` (section 7). M6a's notes that "M6b's editing surface must reproduce" the strut, hanging-space and alignment behavior hold by construction: under M6-Q14 (a) M6b draws no text, and caret and selection geometry come only from the port's result (section 4).
- **Architecture, [text reservation](../graphics-engine-architecture.md#text-reservation)**: "active editing uses a DOM overlay" becomes "active editing draws text through the same GPU route from live layout; a DOM overlay draws only the caret, selection and composition underline, and a hidden textarea receives input" (unit M6b-U0).

## 2. Session state

```ts
type TextCaret = Readonly<{ anchor: number; focus: number; affinity: 'downstream' | 'upstream' }>;
type TextEditState = Readonly<{
  id: string | null;                       // null while pending
  pending: Readonly<{ parent: string; index: number; frame: Frame; sizing: 'autoWidth' | 'autoHeight'; style: TextStyle }> | null;
  anchor: number; focus: number;           // UTF-16 offsets on grapheme boundaries
  affinity: 'downstream' | 'upstream';     // only meaningful when collapsed at a soft wrap
  composition: Readonly<{ start: number; end: number }> | null;
}>;
type TextStyle = Readonly<{ family: string; size: number; color: Color }>;
```

- **M6b-S1.** `textEdit: TextEditState | null` is session state (never history, never serialized), in `EditorSnapshot` and query `{ type: 'textEdit' }`; a change raises a `session` event with field `textEdit` after the events of the change that caused it. Exactly one of `id` and `pending` is null. While it is set the active tool is `select` (as M3 section 4), the selection is `[id]` (empty while pending), `handles` is null and the resize, rotate, Alt-drag and overlap-cycling gestures are off.
- **M6b-S2 text tool style.** Session state `textStyle: TextStyle` (snapshot field and session event `textStyle`), set by `setTextToolStyle { style }` (a full `TextStyle`, checked by M6a-S3 and the authored size floor) and by `EditorOptions.textStyle`; default `{ family: 'Arial', size: 16, color: { r: 0, g: 0, b: 0, a: 1 } }` (M6b-Q7). A pending node takes it.
- **M6b-S3 goal x.** Up and Down keep a goal x (node-local) across consecutive vertical moves, internal (no snapshot field); any other caret change clears it.
- **Without a port.** Every command of section 3, the text tool and every text input fail with `editor.no-text-layout` (M6a section 5) and change nothing; edit mode cannot be entered.

## 3. Entry, exit and the text tool

### 3.1 Commands (session)

| Command | Effect | Codes, in order |
| --- | --- | --- |
| `enterTextEdit { id, anchor?, focus? }` | Ends an active gesture (a text gesture commits by 7.3, any other is cancelled), sets the tool to `select`, the selection to `[id]`, `textEdit` to the caret (default: all text selected, M6b-Q4). Entering the edited node again only sets the caret | `editor.invalid-command`; `editor.unknown-node`; `editor.not-a-text-node`; a node not on the active page is `editor.unknown-node`; `editor.invalid-text-range` (not integers in `[0, length]`, splitting a surrogate pair, or not a grapheme boundary); `editor.no-text-layout` |
| `exitTextEdit {}` | Ends a composition by the forced end (7.3), sets `textEdit` null, keeps the selection; if pending, nothing is created. A no-op outside edit mode | none |
| `setTextSelection { anchor, focus, affinity? }` | Sets the caret of the edited node; ends the merge (8.2) | `editor.no-text-edit` (new); `editor.gesture-active` during a composition; `editor.invalid-text-range` |
| `endComposition {}` | Commits an active composition by 7.3 (the host's blur-time end, M6b-H2); a no-op without one | none |

A hidden node (itself or an ancestor not `visible`) may be entered by the command, not by double-click, as M3. A text node inside a `symbol` source is a document node and is edited like any other; an instance's expanded text is not a document node (M6b-Q9).

### 3.2 Entry by input

- **Double-click** (select tool): when the M1 and M2 selection target is a text node, enter edit mode with the caret at the double-click point (section 4.3), then select the word there (M6-E6); a container target keeps the M2 scope entry first, so text in a group needs two double-clicks. In edit mode the pointer follows section 4.4.
- **Enter** (`enterScope` action) on one selected text node: `enterTextEdit` with all text selected (M6b-Q4).
- **Text tool** (`ToolName` gains `'text'`; default binding `T`; extension tools unchanged): a press on a hittable text node enters edit mode on it at the point. Otherwise a click (movement under the M2 click threshold) makes a pending `autoWidth` node with a zero-width frame at the point (the M6a `createText` anchor rule then grows it by `align`, `left` by default) and a drag a pending `autoHeight` node with the dragged box's width and its top-left at the box's top-left; the parent is the scope if set, else the page; `index` on top. The press ends at release; the caret is drawn from `pending` (section 4.3, an empty layout in `textStyle`). The tool becomes `select` once edit mode starts, so the text tool is one-shot (M6b-Q5).

### 3.3 Exit

Edit mode ends, with the selection as the cause leaves it, on: `exitTextEdit`; Escape (section 5, rule 4; the node stays selected, a further Escape runs the M2 `exitScope`); a press outside the edited node's rotated box, which then runs the select tool's M2 rules in the same `input` (M6b-Q6); any selection change to a value other than `[id]`; `setTool`; `setScope` to a different value; a page switch; `loadDocument`; any change after which `id` is not a text node of the active page (delete, undo, redo), or, while pending, `pending.parent` is not a page or container of the active page. Undo and redo restore a caret only while edit mode is active on that node; they never enter edit mode (section 8.3). Leaving a pending node creates nothing, records no step and writes nothing to autosave (M6-Q19 (a)).

## 4. Caret, selection and geometry

### 4.1 Offsets and stops

Offsets are UTF-16 into the node text. **Stops** are the grapheme boundaries of each run, segmented per run as M6a-L1 does, by `Intl.Segmenter('ko', { granularity: 'grapheme' })`, so the run boundaries are stops (M6a-L1 makes them cluster boundaries) and no stop falls inside a cluster the layout reports; only a long cluster's start and end (M6a-L1's 32-unit pieces are not stops). LF is its own stop pair. **Words** are `Intl.Segmenter('ko', { granularity: 'word' })` segments with `isWordLike` (M6b-Q10). The word at an offset (double-click, 4.4) is the segment holding it, except that an offset at a word-like segment's end, where a non-word segment starts, picks that word; at the length it is the last segment. Every command and input keeps `anchor` and `focus` on stops; after the editor's own insertion the caret is the insertion's end moved **up** to the next stop (typing `e` before an existing U+0301 puts the caret after the accent, since `é` is now one cluster; disclosed); after any other document change in edit mode (undo, a host `setText`) each offset is clamped to the new length and moved **down** to the nearest stop.

### 4.2 Movement and deletion

| Keys (platform `other`; `mac` in M6b-Q12) | Collapsed caret | Non-empty selection |
| --- | --- | --- |
| Left, Right | previous or next stop | collapse to its start or end |
| Up, Down | the line above or below at the goal x (4.3); above the first line to 0, below the last to the length | collapse first, then move from the start (Up) or end (Down) |
| Home, End | the line's start, or its end before a soft wrap (affinity upstream) or LF | from the focus |
| Mod+Left, Mod+Right | previous word start, next word start (Windows convention; skipping non-word segments) | from the focus |
| Mod+Home, Mod+End | 0, length | from the focus |
| Shift with any of these | moves `focus` only | moves `focus` only |
| Mod+A | selects 0 to length | same |
| Backspace, Delete | deletes the previous or next cluster (a committed Hangul syllable is one cluster; jamo deletion exists only inside a composition, M6-E6) | deletes the selection |
| Mod+Backspace, Mod+Delete | deletes to the previous word start or the next word start | deletes the selection |
| Enter, Shift+Enter | inserts LF | replaces the selection with LF |

Shift+Backspace deletes as Backspace on both platforms; Shift+Delete is not an edit action (it is cut on Windows). At 0 Backspace, and at the length Delete, are consumed no-ops. A movement key that changes nothing is a consumed no-op.

### 4.3 Geometry (fake and real port alike)

From the node's `TextLayoutResult` `R` (the editor's cache, M6a section 5), node-local, y down:

- **Caret x at offset `o` on line `L`.** Over `L`'s clusters with M6a-L1's long-cluster pieces joined into their grapheme (so a long grapheme's end takes its whole advance): the `x` of the first cluster on `L` with `start = o`; else the `x + advance` of the last cluster on `L` with `end = o`; else (an empty line) `L.left`. Hanging spaces count, so a caret after trailing spaces may lie past the box width; for wrapping modes it is clamped to `R.width` (disclosed; Chrome does the same in a textarea).
- **Line of `o`.** The line with `start ≤ o ≤ end`; at a soft wrap (`o` is both `L.end` and `L+1.start`) the affinity picks: downstream `L+1`, upstream `L`. The caret is the segment from `(x, L.top)` to `(x, L.top + L.height)`.
- **Point to offset.** The point is mapped into the node's own axes (inverse of the frame transform with rotation about the centre, M1). Its line is the first whose `top + height` is greater than its y, clamped to the first and last lines. On that line, the candidate stops are its clusters' starts and the line end; the offset is the stop whose caret x is nearest to the point's x, ties to the earlier stop; a stop at a soft-wrapped line's end gets affinity upstream. Negative advances (M6a-S3 allows letter spacing −1) can make caret x non-monotonic; the nearest rule still gives one answer (disclosed).
- **Selection rectangles.** Per line meeting `[min, max)`: from the least to the greatest of the caret xs of `max(min, L.start)` and `min(max, L.end)` and the `[x, x + advance]` of every cluster of the line inside the range (so a selection over negative advances still covers its glyphs; a cluster of advance 0 alone stays 0 wide), over the line's `top` and `height`; a line whose LF is inside the selection extends by `0.25 ×` the size of the run at its LF, so selected empty lines show (M6b-Q11).
- **Composition underline.** The composition range's selection rectangles, drawn as segments at `baseline + 0.1 × size`, `size` that of the run at the segment's first offset.
- **Pending node.** An empty layout of `pending` (one empty run in its style) through the port.

### 4.4 Pointer in edit mode

Pointer navigation (M2-I2 step 1: middle button, Space-drag) is unchanged. A primary press inside the edited node's rotated box (a pending node's box grown by `HANDLE_RADIUS / zoom`) places the caret at the point (4.3), clears the goal x, breaks the merge and starts a **selection drag**: select-tool state, not a gesture, with no document step and no snapping; each move sets `focus` to the point's offset; release or `pointercancel` ends it, keeping the caret. Shift+press moves `focus` only and drags from the existing `anchor`. A double-click inside selects the word at the point. In edit mode a press inside never moves, resizes or rotates the node (M6b-Q16); a press outside follows 3.3.

### 4.5 `textEditOverlay` query

`{ type: 'textEditOverlay' }` returns null outside edit mode, else `{ id: string | null; caret: [PagePoint, PagePoint] | null; selection: readonly Quad[]; composition: readonly [PagePoint, PagePoint][]; inputRect: Readonly<{ x: number; y: number; height: number }> }` in page space (`Quad` four points in order), `caret` null when the selection is not collapsed. `inputRect` is the axis-aligned top-left and height of the focus caret's page segment, where the host places the textarea. Node-local points map to the page exactly as M3 section 5.1's `pathOverlay`. The overlay changes with the caret, the layout generation (a font load moves the caret with no `textEdit` event; the host re-queries on the `textLayout` session event) and the viewport.

## 5. Key routing in edit mode (M6-E3)

### 5.1 Rules

For a `keydown` while `textEdit` is set, before navigation, the tool and the keymap; the first matching rule applies:

1. **Composing.** `key` is `Process`, `composing` is true, or the host reports `keyCode` 229 (the event gains `ime?: boolean`, set by the host from `keyCode === 229`): nothing in the editor, result `passThrough` (5.2). So the first `Process` keydown before `compositionstart` (with `isComposing` false) no longer resolves to `KeyR`.
2. **Character keys.** No Ctrl, Meta or Alt (on `mac` Alt is allowed: Option produces characters), or Ctrl+Alt on `other` (AltGr), and `key` is one grapheme (Space included, so Space no longer reaches navigation in edit mode): `passThrough`, left to `beforeinput`.
3. **Edit actions.** Enter, Shift+Enter, Backspace, Delete, Mod+Backspace, Mod+Delete (section 4.2): run, consumed.
4. **Edit-state keys.** Escape (exit), Mod+Z (undo), Mod+Shift+Z and Mod+Y (redo), Mod+A and the movement keys of section 4.2: run, consumed.
5. **Tab, Shift+Tab**: consumed no-op, so focus stays and nothing is inserted.
6. **Everything else.** A chord that the effective keymap binds (Mod+D, Mod+G, …) is a consumed no-op, so neither the action nor the browser's default runs, except chords bound to `copy`, `cut` or `paste`; any other key is `consumed: false`, not `passThrough`. Mod+C, Mod+X and Mod+V (unbound by default, M2-Q4) are not prevented and raise the DOM clipboard events of section 9.

`keyup` in edit mode goes to the tool only and is never consumed, except a Space `keyup` whose `keydown` navigation saw before edit mode began (it still releases the pan); a Space `keydown` repeat while that Space is still held is consumed before rule 1, so it neither types nor reaches the browser (M6b-U4). No keymap action runs in edit mode (M6b-Q14). **After a passed-through key (rule 1).** An Enter or arrow keydown with `keyCode` 229 lets the IME commit; the editor caret does not move for it. A following non-229 keydown for the same key acts by rules 3 and 4; if none arrives and the browser fires `insertLineBreak` or `insertParagraph` before the next keydown, the host maps it to the Enter edit action (M6b-H3); which happens is for the traces to show (appendix A).

### 5.2 Results

`CommandResult` on `input` gains optional `passThrough: true`, present only with `consumed: false` (M6b-Q2). It means the editor took the key for text input: the host must neither `preventDefault` nor run its own shortcut. M2-I3 is otherwise unchanged: a consumed key is prevented, so an edit action runs once and Tab neither inserts nor moves focus.

### 5.3 Text input kinds

`InputEvent` gains, valid only in edit mode (outside it each fails with `editor.no-text-edit`, `consumed: false`, and changes nothing):

- `textinput { text: string }`: from `beforeinput` with `inputType` `insertText` (M6b-Q3). The text is normalized (section 9.1); empty after normalization is a consumed no-op. It replaces the selection (`setText`) in the style of the character before the selection start (M6a `styleBefore`), as one command with merging (section 8).
- `compositionstart {}`, `compositionupdate { data: string }`, `compositionend { data: string }`: section 7.

Each reports `consumed: true` when it acted and `consumed: false` with its code when it failed; the host treats a failed composition input as a forced end (M6b-H5). A `textinput` whose result would exceed `MAX_TEXT_LENGTH` fails with `document.invalid-field` at the path M6a's `setText` reports and changes nothing.

## 6. Host: the hidden textarea (M6-E2)

- **M6b-H1 element.** `EditorCanvas` renders a `<textarea>` beside the canvas inside its wrapper: `aria-label` "Text input", `spellcheck=false`, `autocomplete`, `autocorrect`, `autocapitalize` off, `opacity: 0`, `position: absolute`, width 1 CSS px, `resize: none`, `overflow: hidden`, `pointer-events: none`, `writingsuggestions="false"`, `font-size` equal to `inputRect.height × zoom` in CSS px, placed at `inputRect` mapped by the event-time viewport (M2-I4) and clamped to the canvas box, so the IME candidate window opens at the caret. It is mounted always and focused (`focus({ preventScroll: true })`) only while `textEdit` is set; on exit focus returns to the canvas only when the textarea still has focus.
- **M6b-H2 focus target.** The canvas and the textarea are one focus target (M2-I4): focus moving between them is not a blur. Keydown and keyup on the textarea run the same `CanvasInput` mapping as the canvas, plus `ime` from `keyCode`; `copy`, `cut`, `paste` and blur listeners are attached to both. A blur that leaves the target, or a window blur, still runs the reset (`pointercancel` and the Space `keyup`). In edit mode, if the host is between a `compositionstart` and its `compositionend` when the blur is handled (the browser may already have sent the end), it sends `endComposition {}` with the drop flag of M6b-H5 already set; this host-caused end does not run M6b-H5's blur, empty or refocus. It then sends `exitTextEdit` only when the blur is an element blur: `relatedTarget` outside the target and `document.hasFocus()` still true when the blur is handled; otherwise it is a window blur (Alt+Tab) and edit mode stays.
- **M6b-H3 mapping.** `beforeinput` `insertText` → `textinput` and `preventDefault`; `insertCompositionText` and `deleteCompositionText` (not cancelable) → nothing; every other cancelable `inputType` (`insertLineBreak`, `insertParagraph`, `deleteContent*`, `historyUndo`, `historyRedo`, `insertFromPaste`, `insertFromDrop`, `insertReplacementText` and the rest) → `preventDefault`, nothing sent. `insertLineBreak` and `insertParagraph` right after a passed-through Enter keydown with no rule-3 Enter since → the Enter edit action (5.1), prevented. `compositionstart`, `compositionupdate` and `compositionend` → the input kinds of 5.3 with `data`. A keydown result's `passThrough` or `consumed: false` leaves the event alone.
- **M6b-H4 reset.** The textarea holds only the active composition. After a `compositionend`, the host empties it (value `''`, selection 0) when a posted `MessageChannel` message runs, unless a `compositionstart` arrived before that message: the same mechanism as the M6-S0 recorder's "Clear textarea after each commit" ([README](../evidence/m6-s0/README.md#korean-ime-recorder)), so the traces show what this reset sees. Whether a final consonant's end-then-start falls before the message (M6-E4's ordering) is the hypothesis M6b-U10 checks against real traces.
- **M6b-H5 forced end.** Triggers: the editor's `textEdit.composition` becomes null while the host is still between a `compositionstart` and its `compositionend` (a session `textEdit` event the host did not cause through `compositionend`), or a composition input fails (a refused `compositionstart` never sets `composition`). The host then, in this order: sets a flag that drops the next `compositionend` and any `compositionupdate` before it (first, because Chrome may commit synchronously inside `blur()`); blurs the textarea; empties it; and focuses the textarea again if `textEdit` is still set, else the canvas. This host-made blur runs neither the M6b-H2 reset nor an exit. The flag clears at that `compositionend` or at the next `compositionstart`.

## 7. IME composition (M6-E4, M6-Q15 (a))

### 7.1 The text gesture

- `compositionstart` begins a gesture (base: the current document) whose record holds `textEdit` (as `pathEdit`, `editor.ts:185-198`); `composition` is set to the selection (the replaced range, possibly empty). During a selection drag (section 4.4) the drag ends at its current caret first. While another document gesture is active (a host or extension drag), the input fails with the new code `editor.gesture-active` and the host ends the composition by M6b-H5.
- Each `compositionupdate { data }` is a gesture `replace([setText { id, start, end, text: normalized data }])` over the replaced range (cause `gesture-update`, so M5 autosave writes nothing); `composition` becomes `{ start, start + n }`, `n` the normalized data's length, and the caret its end. An update whose result would exceed `MAX_TEXT_LENGTH` fails; the editor commits the last accepted state by 7.3 and the host runs M6b-H5.
- `compositionend { data }` replaces with its own `data` (it may differ from the last update), then commits. An empty end on an empty replaced range cancels the gesture (no step, document unchanged); on a non-empty range it commits the deletion of that range. The commit merges by section 8.
- **Pending node.** On a pending node, each `replace` holds `createText` with the composing text as its one run in `pending.style`, so the commit creates the node in that step and a cancel leaves none and restores `pending` from the gesture record; `textEdit.id` follows the ID the last replace drew (IDs drawn by discarded replace steps are skipped, as for any gesture; disclosed). A `textinput` on a pending node runs `createText` with that text as one command.
- While composing, rule 1 routes every keydown away from the editor, so keyboard undo and redo do nothing; `setTextSelection` fails with `editor.gesture-active`, and the public `GestureControl` methods (`editor.ts:150-172`) are inert: `begin` returns false, the others change nothing.
- **No text gesture.** A `compositionupdate` or `compositionend` with no active text gesture (a missed or refused start) fails with `editor.no-text-edit` outside edit mode and `editor.gesture-active` in it, `consumed: false`, and changes nothing; the host then runs M6b-H5.

### 7.2 Pointer during a composition

A press in edit mode while composing first force-ends the composition (7.3), then acts (caret placement inside the box, exit outside). The host prevents the `pointerdown` default only for presses inside the edited box, so focus stays on the textarea; the M6-S0 recorder's click cases decide whether the IME also commits on its own (then M6b-H5 drops the late end).

### 7.3 Forced end (change to `run()`)

Every path that today cancels or interrupts a gesture (`cancelGesture` and `interrupt`, `editor.ts:1840-1866`), and every command that ends edit mode or changes the caret, commits an active **text** gesture first, with the composing text as it stands (the 7.1 commit rule, so an empty composing text over an empty range records nothing; merged by section 8), sets `composition` null (raising `textEdit`), then proceeds on the committed document. The paths: a host document command (`run`, `editor.ts:880-904`, which today applies to the pre-gesture base and cancels), `undo`, `redo`, `loadDocument`, `pointercancel` (also sent by the host's reset), `setTool`, `setSelection`, `setScope`, `enterTextEdit`, `enterPathEdit`, `exitTextEdit`, `endComposition`, `setActivePage` (also to the current page), and the pointer case of 7.2. A document command that then fails leaves the commit in place. The only cancel is the empty end of 7.1. Other gestures keep today's rule. The host then runs M6b-H5. Disclosed: a host undo during a composition commits and merges first, so it undoes the whole merged word, the composing syllable included.

## 8. History (M6-E5, M6-Q16 (a))

### 8.1 Entries

`HistoryEntry` gains `caret: Readonly<{ id: string; before: TextCaret; after: TextCaret }> | null`, set by text input, edit actions, composition commits and edit-mode paste and cut (null for every other step); it is never serialized.

### 8.2 Merge

A new text step merges into the top undo entry (its `after`, `touched` and `drawn` extended, `before` kept) when all hold: the redo stack is empty; the top entry was made by text input in this edit session on the same node; the **kind** is the same (insertion: a `textinput` or a composition commit; backward deletion: Backspace; forward deletion: Delete); the step starts at the top entry's `after` caret (contiguous); and no **break** occurred since. Breaks: a caret or selection change other than the step's own; a style or prop change of the node; a paste or cut; leaving edit mode; any other document change; an inserted LF (an LF insertion is its own step and the next insertion starts a new one); an insertion that starts with whitespace after a non-whitespace character (so one step is about a word, with the space starting the next); a word deletion or a deletion of a non-empty selection (each its own step, M6b-Q13); an insertion that replaces a non-empty selection, by `textinput` or by composition alike, starts a new step, into which later insertions may merge. There is no timer. The pending node's creating step merges with following insertions.

### 8.3 Undo and redo

Undo restores `before` and redo `after` byte-identically (P5), and, when edit mode is active on `caret.id`, sets the caret to `caret.before` or `caret.after`; otherwise the caret is not touched and edit mode is not entered. An undo that removes the edited node ends edit mode (3.3).

## 9. Paste, copy and cut (M6-E7, M6-Q18 (a))

### 9.1 Normalization

Only `text/plain` is read (as M2 section 6; `text/html` is never read). CRLF, CR, U+0085, U+2028 and U+2029 become LF; tab becomes one space; every other character M6a-S1 rejects (C0 and C1 controls, the bidi controls, lone surrogates) is dropped. The same normalization applies to `textinput` and composition data.

### 9.2 In edit mode

`paste { text }`: unmarked text replaces the selection, normalized, in the style before the selection start, as one step that breaks the merge; a fragment pastes the texts of its `text` nodes in paint order joined by LF, and a fragment with none fails with `editor.unsupported-clipboard` (M6b-Q8). A result over `MAX_TEXT_LENGTH` fails as in section 5.3. `copy` and `cut` with a non-empty selection set the in-memory clipboard (and so the `clipboard` query) and `text/plain` to the selected plain text, clear the carried-source link set (M7 rule (1)), return `ids: [id]` so that `clipboardCopy` (`canvas-input.ts:242-247`) prevents the event and writes `text/plain` (`cut` deletes the text as one step); with a collapsed caret they do nothing and return `ids: []`, so the browser's event runs.

### 9.3 Outside edit mode

`paste { text, at?, pointer? }`: a fragment pastes as M2 and M7 say (`pointer` ignored). Unmarked text that is non-empty after normalization creates an `autoWidth` text node in `textStyle` whose box centre is `pointer`, else `at`, else the viewport centre (`editor.no-viewport-size` without one), in the M2 paste target, as one step, selected, edit mode not entered. Empty text keeps `editor.unsupported-clipboard`. No port: `editor.no-text-layout`. **`pointer`:** `EditorCanvas` keeps the client point of the last `pointermove` over the canvas, clears it on `pointerleave`, and maps it at paste time with `editor.getSnapshot().viewport` (M2-I4).

### 9.4 `paste {}` without text

The in-memory clipboard is used (M2 section 6): a fragment pastes as M2 and M7 outside edit mode and as 9.2 in it; plain text (from an edit-mode copy) is inserted in edit mode and creates a node by 9.3 outside it; none is `editor.empty-clipboard`.

## 10. Acceptance criteria

Unit tests use the fake port (`tests/support/fake-text-layout.ts`), exact values and committed fixtures under `tests/fixtures/m6-text/edit/` (caret scripts) and `tests/fixtures/m6-text/ime/` (traces, each labelled `synthetic` or `recorded` with its source).

| ID | Criterion | Method |
| --- | --- | --- |
| M6b-A01 | Caret model: committed scripts (Hangul syllables, combining marks, a 40-unit grapheme, soft wraps with both affinities, LF and empty lines, centre and right alignment, hanging spaces, mixed sizes, letter spacing −1, emoji ZWJ sequences that segment alike in Node and Chrome) give the committed offsets, caret segments, selection rectangles and point-to-offset results of section 4 | Unit tests |
| M6b-A02 | Movement and deletion table of 4.2 on the scripts, including the goal x across lines and the no-op cases | Unit tests |
| M6b-A03 | Edit mode: every entry and exit of section 3 with the session event order; the pointer rules of 4.4 (place, drag-select, Shift extends, double-click word, no move, resize or rotate, `pointercancel`); the press outside acting in the same `input`; scope unchanged; `handles` null; codes of 3.1; `textEditOverlay` literal values for a page-root, a rotated and a nested node and a pending node; no port gives `editor.no-text-layout` | Unit tests |
| M6b-A04 | Text tool: click and drag pending nodes; first `textinput` creates the node in one step; an abandoned pending node leaves no node, no history entry and no autosave write; the tool is `select` after entry | Unit tests (with the M5 autosave double) |
| M6b-A05 | Typing, LF and deletion through `input` with the M6a style rules and the bound; normalization of 9.1 | Unit tests |
| M6b-A06 | History: committed scripts give the committed history depths and carets for each merge and break rule of 8.2; undo and redo are byte-identical and restore carets only in edit mode (M6-A05) | Unit tests |
| M6b-A07 | Key routing, editor half: rules 1 to 6 with their results; the first `Process` key, Space, letters, Backspace, Delete and arrows never reach navigation, the tool or the keymap (no tool switch, nudge, pan or delete of the node) (M6-A08) | Unit tests |
| M6b-A08 | Key routing, React half: the textarea is in the focus target; keydown, keyup and clipboard events on it reach the editor; `preventDefault` exactly when consumed; `passThrough` keys not prevented; the M6b-H2 blur and exit rules; M6b-H3 mapping | Unit tests (React, fake DOM) |
| M6b-A09 | IME, editor half: start, update, end, a differing end, empty end on empty and non-empty ranges, the forced end by each 7.3 path, the pointer case, `endComposition`, inert `GestureControl`, update and end without a gesture, an update over the bound, `editor.gesture-active`, a pending cancel restoring `pending`, a pending node's first composition (commit creates, cancel leaves none); causes and step counts; no autosave write on updates (M6-A07) | Unit tests |
| M6b-A10 | IME, host half: every trace of appendix A replays through the host mapping into its committed text, caret and history depth; the M6b-H4 reset; the M6b-H5 order and the dropped late `compositionend`, synchronous and late (text goes in once, no exit); element and window blur, including an element blur to a panel input during a composition (focus stays on the panel; the host-caused end does not refocus); the Enter mapping | Unit tests |
| M6b-A11 | Paste, copy and cut of section 9 in and outside edit mode, the `pointer` placement and every code (M6-A09) | Unit tests |
| M6b-A12 | Headed caret spec, next-host, real port, committed test font: caret segments and selection rectangles from `textEditOverlay` against the measured clusters of the same layout; click placement; Up and Down (M6-A06 headed half) | Headed (main PC, Chrome and Edge) |
| M6b-A13 | Headed key-routing, paste and IME spec: real keyboard events through Playwright for rules 1 to 6 and Tab focus; a DOM paste of `text/plain` with HTML; the committed traces replayed through CDP `Input.dispatchKeyEvent` (`Process`, `keyCode` 229), `Input.imeSetComposition` and `Input.insertText` give the committed document, within appendix A's CDP limits (M6-A07, M6-A08, M6-A09 headed). Window-blur behaviour (case (10)) has no headed evidence until M6c's manual run | Headed (main PC, Chrome and Edge) |
| M6b-A14 | Recorded traces (M6b-Q1 (a)): the M6-S0 recordings replay in A10 and A13; the M6-E4 ordering hypothesis is confirmed or the contract amended | Unit tests, headed |
| M6b-A15 | No new dependency or asset; `pnpm check` and `pnpm check:boundaries` PASS; the earlier next-host headed specs pass; the architecture paragraph amended; independent review of each unit; the user accepts the exit record | Diff review, headed, review record |

The MVP plan's M6 exit gate (a headed Korean IME composition spec in both browsers and committed caret and selection fixtures) is M6b-A01, A12 and A13, with M6c's manual real-IME run.

## 11. Units

| Unit | Content | Tier |
| --- | --- | --- |
| M6b-U0 | Architecture text-reservation paragraph (1.2), with the ADR 0003 M6-Q3 citation follow-up of the M6a exit record if the reviewer agrees | Full (architecture) |
| M6b-U1 | `editor-core`: pure caret model (stops, words, geometry, point to offset, movement) over `TextLayoutResult`; caret scripts on the fake port (A01, A02) | Full |
| M6b-U2 | `editor-core`: `textEdit`, `textStyle`, the section 3.1 commands, entry and exit, `textEditOverlay`, `editor.no-text-edit` (A03) | Full |
| M6b-U3 | `editor-core`: the `text` tool and pending nodes (A04) | Full |
| M6b-U4 | `editor-core`: `textinput`, edit actions, key routing, `passThrough`, `ime` on keydown (A05, A07) | Full |
| M6b-U5 | `editor-core`: caret entries, merge and caret restore (A06) | Full |
| M6b-U6 | `editor-core`: composition kinds, the text gesture, forced end in `run()`, `editor.gesture-active` (A09) | Full |
| M6b-U7 | `react`: textarea, focus target, listener moves, M6b-H1 to H5; the hand-authored synthetic traces of appendix A and their replay (A08, A10) | Full |
| M6b-U8 | Paste, copy and cut in `editor-core`; `pointer` and the edit-mode `clipboardCopy` result in `react` (A11) | Full |
| M6b-U9 | next-host: text tool button, DOM caret, selection and underline from `textEditOverlay`, `?fixture=text-edit`, test-hook fields; headed specs `tests/m6b-next-host/` (A12, A13) | Light (headed on the main PC) |
| M6b-U10 | Recorded traces: commit the user's M6-S0 recordings, replay them in A10 and A13, amend H4 or H5 if they contradict (A14) | Light (evidence; headed on the main PC) |
| M6b-U11 | Exit record (A15) | Full |

Order: U0 any time; U1, U2, U4, then U3 and U5, then U6, then U7 and U8, then U9; U10 when the recordings exist (section 15); U11 last. Every unit runs `pnpm check`; headed results are from the main PC or NOT RUN. The D10 WIP limit applies.

## 12. Risks

- **Nothing visible in M6b.** Typing shows only a caret and selection over an empty-looking box until M6c, so usability cannot be judged by hand; specs read state.
- **Synthetic is not real.** CDP replay and hand-made traces fix what the host maps, not what the Microsoft IME sends; the M6-E4 ordering, the reset timing, Enter and click during composition and Edge text prediction or Microsoft Editor injections are unverified until M6b-U10 and M6c.
- **Forced end surprises** (plan section 11): a host command commits a half-typed syllable.
- **Per-keystroke layout** on the main thread (about 0.4 ms per node mean in M6-S0; a 16,384-unit node unmeasured); no performance claim (M6b-Q15). A font load bumps the generation, moves the caret and briefly blanks text under E28 (M6a-L3).
- **Caret geometry is ours, not Chrome's.** Negative advances, RTL characters under `bidi-override`, hanging spaces and the zero-size strut's low-`lineHeight` pitch (M6a section 4) can place the caret where a native textarea would not; the port's result is the only geometry, so it agrees with GPU text by construction.
- **ICU drift**: Node's and Chrome's word and grapheme segmentation can differ; fixtures keep to cases that agree.

## 13. Open questions

| ID | Question | Recommendation |
| --- | --- | --- |
| M6b-Q1 | How does M6b proceed without IME traces? (the method is decided by the plan, M6-Q21 (a), section 9 and M6-A07) | (a) hand-authored synthetic traces (appendix A) drive U6, U7 and A13; the recordings are a separate gate, M6b-U10 and A14, before the exit record. (b) block U6 and U7 until the recordings exist. (c) drop recordings from M6b and leave all real-IME evidence to M6c |
| M6b-Q2 | Pass-through result | (a) `consumed: false` plus `passThrough: true`. (b) a three-valued `consumed`, which breaks M2-I3's type |
| M6b-Q3 | Which `beforeinput` types map? | (a) `insertText` only; paste through the DOM `paste` event (M2 section 6), so `insertFromPaste` never reaches the editor (a narrowing of M6-E2's list). (b) also `insertFromPaste`: two paste paths |
| M6b-Q4 | Caret on entry by Enter or `enterTextEdit` without offsets | (a) all text selected (Figma). (b) caret at the end |
| M6b-Q5 | Tool after entry | (a) `select`, as M3 path edit; the text tool is one-shot. (b) `text` stays active, so a click outside starts a new node |
| M6b-Q6 | Press outside the edited node | (a) exits and acts in the same `input` (M3's rule). (b) only exits |
| M6b-Q7 | Default text tool style | (a) session `textStyle`, default Arial 16 black, host option and command; next-host sets the committed test font for its fixture. (b) no default; the host must supply one |
| M6b-Q8 | A fragment pasted in edit mode | (a) its text nodes' texts joined by LF; none is `editor.unsupported-clipboard`. (b) always `editor.unsupported-clipboard`. (c) exit and paste the nodes |
| M6b-Q9 | Editing an instance's text on the canvas (**user confirmation** recommended: it is user-visible, though "Instance text content may differ from the source" is met by M7's `setInstanceText`) | (a) not in M6b: double-click on an instance keeps M7-Q14 (a), overrides stay host commands; a backlog item. (b) in M6b, edit mode on an expanded text writing `textOverrides` (a second edit target and a larger contract) |
| M6b-Q10 | Word rule | (a) `Intl.Segmenter` word segments with `isWordLike`; Hangul words are space-delimited runs. (b) an own rule on spaces and punctuation |
| M6b-Q11 | Geometry edge rules | (a) as 4.3: caret clamp at the box width for wrapping modes, 0.25 em for a selected LF, Up on the first line to 0. (b) no clamp, no LF width |
| M6b-Q12 | macOS keys | (a) Alt+Left to the previous word start and Alt+Right to the next word end (macOS convention), Meta+Left and Right line ends, Meta+Up and Down text ends, Alt+Backspace and Alt+Delete by word (to the previous word start and the next word end), Meta+Backspace to the line start; untested (the main PC is Windows), disclosed. (b) the Windows table with `Mod` only |
| M6b-Q13 | Deletion merge | (a) Backspace runs and Delete runs merge; word and selection deletions never do. (b) every deletion its own step |
| M6b-Q14 | Keymap in edit mode | (a) no action runs; a bound chord other than `copy`, `cut` and `paste` is a consumed no-op (rule 6), so Mod+D or Mod+G neither act nor reach the browser. (b) host and extension bindings run after rule 6 |
| M6b-Q15 | Typing cost | (a) one headed observation (typing into a 16,384-unit node on the main PC) in the exit record, no gate, no claim. (b) a benchmark under `docs/benchmarks/` |
| M6b-Q16 | Press inside the edited node | (a) places the caret and drag-selects only; moving the node needs leaving edit mode (Figma). (b) a drag from the box edge moves it |

2026-10-30 추천안 자동 채택 (user's standing rule): M6b-Q1 to Q16 adopted as (a), including Q9 (canvas editing of instance text stays out of M6b), confirmed by the user on a decision card in the project thread on 2026-10-30 at 06:40Z.

No question needs a new dependency or changes a requirement. **Needs the user:** M6b-Q9 (a) was confirmed by the user on a decision card in the project thread on 2026-10-30 at 06:40Z. M6b-Q1 follows the plan's M6-Q21 (a); the recordings themselves are a user action (section 15).

## 14. Validation of this contract

Documentation only: `npx prettier --check` on the changed files (the repository's `.prettierignore` excludes `**/*.md`, so it skips them) and local links and anchors; code claims are grounded by `file:line` at b655b77. No product, browser, IME or benchmark run is claimed. CDP `Input.imeSetComposition` and `Input.insertText` behavior is stated as the M6-S0 recorder smoke check uses it, not verified against a real IME.

## 15. Gate

Independent review (full tier, visualization track) before approval. M6b implementation starts at M6b-U1 only after this contract is approved and the user has accepted the [M6a exit record](../evidence/m6a-exit-2026-10-30.md) (MVP plan milestone order; plan section 14); **User action:** the M6-S0 Korean IME recordings on the main PC (both Microsoft IME versions, Chrome and Edge, the recorder's cases), which M6b-U10 and A14 need before the exit record. R-T (E28) is done, so M6c follows M6b's exit. The M6b exit is the user's acceptance of the M6b-U11 record. On 2026-10-30 M6b-U1 started at the project coordinator's direction while the user's M6a exit acceptance was still pending; that acceptance (including the A12 manual DPR half) is required before the M6b exit record, and if the user's decision changes M6a, the started units are re-checked against it.

## 16. Progress

| Unit | State |
| --- | --- |
| Contract | APPROVED 2026-10-30 (#392, 09d8a2a; review r1 NOT READY applied, r2 READY WITH FOLLOW-UPS applied) |
| M6b-U0 | Not started |
| M6b-U1 | In review |
| M6b-U2 | In review |
| M6b-U3 | Not started |
| M6b-U4 | In review |
| M6b-U5 to U11 | Not started |

**M6b-U1 notes** (`packages/editor-core/src/text-caret.ts`, caret scripts under `tests/fixtures/m6-text/edit/`). Readings the unit took, now in sections 4.1 to 4.3 where they are rules: (1) stops are segmented per run, as the layout's clusters are (a whole-text segmentation would put a stop inside a cluster for regional indicators split across runs); (2) caret x joins M6a-L1's long-cluster pieces into their grapheme, so its end takes the whole advance; (3) a selection rectangle spans both end carets and the selected clusters' `[x, x + advance]`, and a line meets the range when its content overlaps it or its LF is selected; (4) the composition underline takes the size of the run at each segment's first offset; (5) the word at an offset prefers the word-like segment ending there over a non-word one starting there; (6) key-table edges: Shift extends movements and is ignored on Backspace; Shift+Delete, Shift+Mod+A and Shift with the word deletions are not edit actions; on `mac` Alt+Delete deletes to the next word end, Meta+Backspace to the line start, Home and End stay line keys and Meta+Home and Meta+End go to the text ends; modifier sets match exactly (Ctrl+Alt is none); Mod+A matches the keymap token `KeyA` (`eventToken`), so a non-Latin layout selects all; (7) the key-to-action table of 4.2 (`textEditKeyAction`) is in U1 so that A02 runs by key; rules 1 to 6 of section 5 stay in U4; (8) a clamp keeps the affinity only when no offset moved, else downstream.

**M6b-U2 notes** (`packages/editor-core/src/text-edit.ts`, the edit-mode commands, queries and sync in `editor.ts`, the select tool's edit-mode pointer rules in `tools.ts`; tests in `tests/unit/m6b-u2-text-edit.test.ts`). Readings the unit took: (1) `enterTextEdit` with one of `anchor` and `focus` sets a collapsed caret at it; a non-number offset is `editor.invalid-text-range` (not an integer), in both `enterTextEdit` and `setTextSelection`, and an `affinity` other than the two values is `editor.invalid-command` at `/affinity`, checked first (a malformed field before `editor.no-text-edit` and the offsets); failure paths are `/anchor`, `/focus` and `/id` (`editor.not-a-text-node`); (2) offsets are checked against the run stops of section 4.1 without a layout, so a bad range fails before `editor.no-text-layout`, as the 3.1 order lists; (3) a press outside the edited box runs the M2 rules with the handles off, as a press that ends M3 path edit mode, so it never starts a resize or rotation of the node whose handles the host was not drawing; (4) the double-click entry sets the word at the point in one `enterTextEdit` (one `textEdit` event), the caret placement and the word selection of 3.2 folded together; without a port it fails and the double-click is not consumed; (5) `inputRect` is the axis-aligned box of the focus caret's page segment, so its height shrinks with rotation (0 at 90°) and is computed from the page ends (page-space rounding), so M6b-U7 needs a height floor for the textarea's `font-size` and the IME window placement under rotation; (6) after a document change in edit mode the caret is clamped and moved down to stops (4.1) here, since edit mode must hold valid offsets; (7) `textStyle` is a snapshot field and session event only (no query), and `setTextToolStyle` reports the model's run rules under `/style/<key>`; (8) `TextCaret`, `TextAffinity`, `TextStyle`, `TextEditState`, `TextEditPending`, `TextEditOverlay` and `Quad` are public types (`types.ts`); `text-caret.ts` re-exports the caret types and gains `textStops`. Interim until M6b-U4: in edit mode a key reaches the tool and the keymap as before, but of the bindings only `exitScope` (Escape: ends edit mode with the node selected) and `undo` and `redo` run, as rule 4 will allow; every other bound chord (Delete, Backspace, the arrows' nudge, Mod+A, `R`, Mod+D, Enter's `enterScope`, …) is a consumed no-op, as rule 6 makes it, and unbound keys stay unconsumed. A selection drag keeps the edited node's ID and reads the live anchor on each move, so a host change that clamps the caret or moves edit mode to another node does not leave it stale; the drag stops on another node. The `pointercancel` result is unchanged: it is consumed only for a pan, Space, a gesture or a tool overlay, so cancelling a selection drag reports `consumed: false` (it ends the drag and keeps the caret). Owed: the `text` tool, pending nodes and their entry and A03's pending press through the editor to M6b-U3 (U2 implements the pending state's overlay, box test, empty layout and exit rule, and tests the overlay and box test directly; U3 must test the pending exit rule, `pendingParentHolds` and the empty selection, through the editor: the parent deleted, the parent undone away, a page switch and a non-empty selection); goal x clearing, `textinput` and key routing to U4; breaking the merge on `setTextSelection` and caret restore on undo and redo to U5; `endComposition` is a no-op, and the forced end (7.3) in `enterTextEdit`, `exitTextEdit` and the other paths, `editor.gesture-active` in `setTextSelection` and the composition clamp to U6 (each hook point carries a comment).

**M6b-U4 notes** (`packages/editor-core/src/text-input.ts` for the routing of rules 1 to 6 and the section 9.1 normalization, the `textinput` kind, `ime`, `passThrough`, the edit actions and the goal x in `editor.ts` and `types.ts`; tests in `tests/unit/m6b-u4-text-input.test.ts`). Readings the unit took: (1) the normalization is `normalizeInputText` in `editor-core`, which drops what the model's own M6a-S1 check rejects (`@vector-studio/model` now exports `isRejectedRunTextUnit` and `isValidRunText`; no rule changes), for U6's composition data and U8's paste to reuse; (2) `ime` is read only in edit mode, outside it a keydown routes as before; `textinput` carries no `modifiers` and never reaches a tool; (3) rule 2's "one grapheme" is one `Intl.Segmenter('ko')` grapheme, Shift is free, `mac` allows Alt alone and `other` Ctrl+Alt without Meta, so on `other` Mod+Alt+M (`maskGroup`) with a character `key` passes through by rule 2 before rule 6 can consume it (disclosed); (4) rule 4's Escape exits only without modifiers (Shift+Escape falls to rule 6), and Mod+Z, Mod+Shift+Z and Mod+Y are fixed chords matched by the keymap token (`code` on a non-Latin layout), not the effective keymap's `undo` and `redo`; Mod+Shift+Y is not redo; (5) rule 5 is Tab without Ctrl, Meta and Alt (Ctrl+Tab falls to rule 6); (6) rule 6 treats a chord bound to `copy`, `cut` or `paste` as unbound (`consumed: false`), and an extension command's chord as any other bound chord (a consumed no-op); until M6b-U8 the `copy`, `cut` and `paste` commands themselves are `{ ok: true, ids: [] }` no-ops in edit mode (9.2's collapsed-caret result, so the host leaves the DOM event alone), and the edited node is never copied, cut or pasted over; (7) an edit action that fails (the length bound) returns its code and path with `consumed: true`, since rule 3 consumes the key, while a failed `textinput` is `consumed: false` as 5.3 says; (8) without a port `textinput` fails with `editor.no-text-layout` (section 2) before `editor.no-text-edit`; (9) after a deletion the caret is the range start moved down to a stop (a deletion is not the editor's insertion of 4.1); after an insertion, LF included, the end moved up; (10) a text replaced by itself is still a step, since M6a's `setText` always writes; (11) the goal x is set by Up and Down, also when they change nothing, and cleared by every other caret change, every edit (also one that keeps the caret offset, such as Delete), `setTextSelection` (also to the same caret), entry and exit; (12) a keyup in edit mode goes to the tool and is not consumed, except the Space keyup of a pan held from before edit mode; keydown repeats of that held Space are consumed before rule 1 (the 5.1 note), so they neither type nor pan; (13) Escape during a selection drag exits edit mode, and the drag ends at its next pointer event. The U2 interim keymap is gone (no keydown reaches the keymap in edit mode); U2's interim test is narrowed to rule 6 chords. Owed: a `textinput` and an Enter on a pending node (`createText` as one command; now consumed no-ops) and the `T` binding to M6b-U3; the caret entries, the merge and the caret restore of section 8 to M6b-U5, which attach to `editText`, the one path every edit takes as one `setText` step today (its callers know the step's kind: a `textinput`, an LF, a cluster Backspace or Delete, a word deletion, a selection deletion or replacement), while undo and redo in edit mode only clamp the caret; the forced end of 7.3 in the Escape, undo and redo paths and the composition kinds to M6b-U6 (rule 1 already routes every composing keydown away); setting `ime` from `keyCode` 229, honouring `passThrough` and the M6b-H3 `beforeinput` mapping to M6b-U7; the edit-mode `copy`, `cut` and `paste` of section 9.2 to M6b-U8, which replaces U4's interim no-ops in `run` (the clipboard chords are left to the DOM events; the commands do nothing in edit mode until then).

## Appendix A. Synthetic traces and CDP limits

- **Source.** The synthetic traces are hand-authored JSON in the M6-S0 recorder's event format (`apps/playground/src/m6-s0-ime-recorder.ts`), committed under `tests/fixtures/m6-text/ime/` with `synthetic: true` and the event order each assumes; they are not made on the main PC, so U7 does not wait for it. Recorded traces (M6b-U10) join them with `synthetic: false` and their IME version and toggle.
- **List** (each through the host mapping, A10): (1) a syllable then a space, then a punctuation mark (keydown 229, `compositionend`, `beforeinput` `insertText`); (2) Enter during a composition, in both orders (end then a non-229 Enter keydown; end then `insertLineBreak` with no second keydown); (3) an arrow during a composition, both orders; (4) Backspace inside a composition (jamo) and in the empty textarea after a commit; (5) a final consonant moving into the next syllable (`compositionend` then `compositionstart` in the same task, and in separate tasks); (6) an empty end over an empty range and over a selection; (7) a forced end whose browser `compositionend` arrives synchronously inside `blur()`, and one that arrives after the refocus; (8) a click during a composition with focus kept (prevented `pointerdown`) and with focus moved; (9) a first composition on a pending node, committed and cancelled; (10) Alt+Tab during a composition (window blur).
- **CDP limits.** `Input.imeSetComposition` and `Input.insertText` drive Chromium's composition from outside; they cannot place `compositionend` and `compositionstart` in one task or reproduce a real IME's late `compositionend` after a blur. Cases (5), (7) and (10) are therefore unit-only (A10); A13 replays the others headed.
