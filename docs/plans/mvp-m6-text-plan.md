# MVP M6 text plan

Status: APPROVED 2026-10-29 (M6-Q1, Q2, Q7, Q20 decided and Q11, Q12, Q14, Q23 confirmed as option (a), 추천안 자동 채택 2026-10-29 under the standing rule of 2026-10-24; a later user pick on the decision cards replaces it); independent review round 1 NOT READY (B1 to B3, should-fix 1 to 13, minor 1 to 8), applied; round 2 READY WITH FOLLOW-UPS (S-a to S-e, minor 1 to 4), applied. Full tier (new node type and schema version, a new port in `packages/contracts`, a new package, a glyph rendering route, product behavior). Visualization-track item [V-12](d9-visualization-track.md#status-index). It is the architecture's "Post-P5 text plan" design gate ([graphics-engine architecture](../graphics-engine-architecture.md#design-gates-before-later-implementation)) and the text plan that [MVP plan M6](mvp-editor-plan.md#m6-text) and MVP-Q10 require before M6. It is a plan, not a milestone contract: each milestone it proposes (section 8) gets its own contract with acceptance criteria IDs before product code.

Owners: this file owns the M6 decisions listed in section 1, the milestone split, the plan-level exit criteria M6-A01 to M6-A13 and open questions M6-Q1 to M6-Q23. Product behavior stays in [`requirements.md`](../requirements.md#text) (Text), which this plan does not change; package boundaries in [`ARCHITECTURE.md`](../../ARCHITECTURE.md#dependency-direction); the migration policy in MVP-Q2; the glyph route's renderer contract in the rendering item R-T ([MVP plan, section 5](mvp-editor-plan.md#5-rendering-track-needs)). The P5 and M1 to M5 rules stay in force except where section 7 names an M2 change made by the M6b contract.

## 1. Scope

The plan decides, or leaves as questions with a recommendation: the text model, schema bump and migration (section 2); font loading and fallback (section 3); shaping and layout ownership and the one layout source of truth (section 4); the GPU glyph route and its cost against the disclosed P3 defects (section 5); DOM and GPU agreement and its fixtures (section 6); editing, key routing, Korean IME composition, undo granularity, caret and selection, plain-text paste (section 7); the milestone split and units (section 8); fixtures and headed specs (section 9).

The architecture reserves separate font, shaping, layout, glyph-atlas and text-input services ([text reservation](../graphics-engine-architecture.md#text-reservation)); here font, shaping and layout are the `text-dom` service behind the layout port (section 4), the glyph atlas is R-T (section 5), and text input is `EditorCanvas`'s hidden textarea over `editor-core`'s edit mode (section 7).

MVP scope, from requirements: several styled runs in a text node; font family, size and color per run; wrapping and auto width and height; letter spacing, line height and paragraph alignment; normal caret and selection; Korean IME composition; system fonts and host-provided web fonts; external rich-text paste normalized to plain text.

Out of scope (proposed; each that narrows a requirement is a question for the user): rich-text paste that keeps styles; font weight and italic as fields (M6-Q11); justified alignment and per-paragraph alignment (M6-Q12); vertical alignment other than top; right-to-left, bidirectional and joining or reordering scripts; vertical writing; text on a path; text stroke, gradient text fills and text as a mask source (MVP-Q12); color emoji fidelity (section 11); font embedding; Local Font Access; hyphenation; lists and tab stops; spell check; Hanja reconversion of committed text.

### 1.1 Starting point (main at 4d53f7e)

- **Model.** Schema v2 (`packages/model/src/types.ts:156`) has no text node; leaves are rectangle, ellipse, line, path and custom (`types.ts:149`). `parseDocument` accepts versions 1 and 2 and migrates v1 (`parse.ts:112-122`, `166-167`). M4 has no contract yet; if it adds persisted fields it bumps first, so M6 writes "vN+1", vN being the latest version when M6a starts.
- **Scene and ports.** `RenderNodeSnapshot` has `primitive`, `path` and `container` kinds only (`packages/contracts/src/scene.ts:102-107`). The ports in `contracts` are the renderer synchronization port (`scene.ts:146-153`) and the fill-mesh and stroke-mesh ports (`contracts/src/geometry.ts`); there is no text, glyph or texture node and no text port.
- **Editor.** `createEditor` takes `document`, `ids`, `extensions`, `keymap` and `platform` (`packages/editor-core/src/editor.ts:93-104`). History entries are whole-document `before`/`after` pairs with no session state (`editor.ts:159-163`). A gesture records one step from its base, and `replace` re-applies commands to that base (`editor.ts:129-157`); the gesture record keeps `pathEdit` (`editor.ts:172`), restored on cancel (`editor.ts:1666`). A host document command is applied to the pre-gesture base (`editor.ts:741`) and, if it succeeds, cancels the active gesture (`interrupt()`, `editor.ts:736-747`; M5-U2 note 2). The projector runs synchronously in `editor-core` with U+0000 synthetic scene IDs (`projector.ts:28-41`).
- **Input.** M2-I2 dispatch gives Space to navigation and other keydowns to the active tool, then the keymap (Backspace and Delete delete, arrows nudge, Enter `enterScope`, Mod+A `selectAll`); a consumed key is `preventDefault`ed (M2-I3, M2-I4). `keydown` carries `composing` (`types.ts:51-60`), and the keymap reads `code` for a composing or `Process` key (`keymap.ts:175-184`), so the `Process` keydown Chrome sends before `compositionstart` (with `isComposing` false) for ㄱ resolves to `KeyR`, the rectangle tool. Keydown reaches the editor through React `onKeyDown` on the canvas (`packages/react/src/canvas.tsx:140`), and wheel, blur and clipboard listeners are on the canvas (`packages/react/src/canvas-input.ts:316-324`); a DOM `paste` always runs `paste { text }` (`canvas-input.ts:250-253`), and text without the fragment marker fails with `editor.unsupported-clipboard` (`editor-core/src/clipboard.ts:136`), as MVP-Q6 (a) planned until M6. Fragments are written with `schemaVersion: 2` (`clipboard.ts:100`, `109`) and `parseFragment` rejects any other version (`clipboard.ts:178`).
- **Host.** next-host draws its overlay in DOM over the canvas (`apps/next-host/src/overlay.tsx`) and creates the editor at `apps/next-host/app/page.tsx:552`. No font is loaded or registered anywhere.
- **Architecture.** "Committed text will eventually render through GPU glyph atlases, while active editing uses a DOM overlay. No DOM or browser font object enters persistent document data" (`graphics-engine-architecture.md:271`). Runtime drawing engines and path renderers need an ADR ([dependency policy](../graphics-engine-architecture.md#dependency-policy)).

## 2. Text model (schema vN+1)

Proposed shape, final in the M6a contract:

```ts
type TextRun = Readonly<{ text: string; family: string; size: number; color: Color }>;
type TextNode = NodeBaseV2 &
  Readonly<{
    type: 'text';
    runs: readonly TextRun[];
    sizing: 'autoWidth' | 'autoHeight' | 'fixed';
    align: 'left' | 'center' | 'right'; // per node (M6-Q12)
    letterSpacing: number; // a fraction of each run's size (em), finite
    lineHeight: number; // a multiple of each run's size (CSS unitless), > 0
  }>;
```

- **M6-T1 content.** The text is the concatenation of the run texts; LF separates paragraphs and is the only control character accepted (CR, other C0 and C1 controls and lone surrogates are rejected; paste normalizes, M6-E7). `family` is one family name, never a CSS list. `size` is in page units. Bounds on text length, run count and size are fixed in M6a (M6-Q22).
- **M6-T2 canonical runs.** At least one run; no empty run unless it is the only one (an empty node keeps the style of its next character); adjacent runs differ in style. Commands return canonical runs, and the parser rejects others with `document.invalid-field`.
- **M6-T3 frame and sizing.** `frame` stays stored. `autoWidth`: width and height from layout, wrapping only at LF. `autoHeight`: stored width, wrapping, height from layout. `fixed`: both stored, wrapping, overflow drawn and not clipped. A command that changes content or style recomputes the auto dimensions at command time (section 4.3). Growth keeps the frame's top-left corner fixed in the node's own rotated axes; because rotation is about the frame centre (MVP-Q3), the command moves `x` and `y` so that corner stays put on the page (for `center` and `right` alignment the M6a contract may instead keep the top centre or top-right fixed).
- **M6-T4 resize.** A handle resize of an `autoWidth` node switches it to `autoHeight` (a horizontal edge handle) or `fixed` (a vertical edge or a corner handle); of an `autoHeight` node a vertical edge or corner handle switches it to `fixed` and a horizontal edge handle keeps `autoHeight`; as Figma does. Handle resize never changes `size`.
- **M6-T4a group and constraint scale (M6-Q23, user confirmation).** Recommended (a): a group's proportional scale (MVP-Q3) and a frame child's `scale` constraint scale the text frame and multiply every run's `size` by the uniform part of the scale, `s = √(sx · sy)` (letter spacing and line height are relative to `size`, so they follow). A uniform scale keeps the sizing mode (the command refits auto dimensions from layout, so they equal the scaled frame up to layout rounding); a non-uniform scale switches an `autoWidth` or `autoHeight` child to `fixed` with the scaled frame, since text cannot be skewed. Rotated descendants follow MVP-Q3's approximate rule. Reason: (b), frame only with `size` unchanged, would make text the one child a group does not scale proportionally, narrowing "Groups scale their children proportionally when resized"; under (b) an auto child would also have to switch to `fixed`, or its refit would undo the scale.
- **M6-T5 migration.** Under MVP-Q2 (a), a new node type bumps `schemaVersion` to vN+1 with a `migrate(vN -> vN+1)` that only rewrites the version, so older builds fail with `document.unsupported-version`. `serializeDocument` writes text fields in a fixed key order. Fragments are written at vN+1, and `parseFragment` accepts earlier fragment schema versions and migrates them like documents, so copy from an older build still pastes. The M5 envelope is unchanged.
- **M6-T6 no layout in the document.** Lines, positions, metrics, fonts used and atlas keys are derived, never stored (ARCHITECTURE, state classification). M7's text override replaces `runs`.

## 3. Fonts: loading and fallback

- **M6-F1 sources (M6-Q4).** System fonts by family name; nothing enumerates them. Host web fonts are registered by the host composition through the text service's registry `{ family, source: URL or ArrayBuffer, descriptors }`, which creates `FontFace` objects in `document.fonts`. Documents store family names only.
- **M6-F2 fallback (M6-Q5).** A run's **font list** is the CSS list `"<family>", <host fallback list>, "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`. Missing glyphs, Hangul in a Latin-only family included, fall back per character by the browser's font matching. That DOM layout and canvas rasterization pick the same fallback is an **M6-S0 hypothesis**, not a fact: Han and CJK fallback depends on `lang`, an `OffscreenCanvas` takes its locale from `ctx.lang` or its element, and a worker canvas uses `self.fonts`, not `document.fonts`. Both sides therefore set the same `lang` (the M6a contract fixes it, default `ko`) and rasterize on the main thread unless R-T registers the same faces in the worker.
- **M6-F3 metrics source.** Metrics are what browser layout reports (line boxes from `lineHeight` × size, measured baselines). No font file is parsed.
- **M6-F4 generation.** A registered face that finishes loading, `document.fonts` `loadingdone`, or a `devicePixelRatio` change (section 4.1) increments the service's layout `generation`; the editor re-lays out and re-projects text with no document change. The DOM cannot say which face drew a cluster, so a cluster's font list is the same before and after a load while its glyphs change; R-T keys atlas entries by generation (section 5).
- **M6-F5 detection.** `document.fonts.check` is not a reliable test for locally installed fonts, so the MVP shows no missing-font state; disclosed.

## 4. Shaping and layout

### 4.1 Ownership (M6-Q2, M6-Q3)

The browser shapes and lays out (recommended). The new package `@vector-studio/text-dom` (`-> contracts`) lays text out in a hidden measurement element inside its own shadow root with `all: initial`, so page styles do not leak in, and then sets `white-space: pre-wrap`, the stored width for wrapping modes, `letter-spacing` in em, unitless `line-height`, `text-align`, `lang`, `font-variant-ligatures: none` (M6-Q9) and the line-break rule of M6-Q13, with each run as a span. The block's own `font-family` and `font-size` are the first run's, so the strut makes every line at least `lineHeight` × the first run's size; the M6a contract chooses between disclosing that and a zero-size strut, with a mixed-size fixture. An empty node or an LF-only line is one line of height `lineHeight` × the size of the run at that offset (the run before an LF). Lines and grapheme-cluster rectangles are read with `Range.getClientRects`. No shaping library is added; the alternatives are in M6-Q2.

Layout is measured at page units, with no camera zoom applied. That the result does not depend on DPR, browser zoom or moving the window to another monitor (DirectWrite hinting, rounding of small sizes) is an **M6-S0 hypothesis**, measured at DPR 1, 1.25, 1.5 and 2. Until it holds, a DPR change bumps `generation`; if it fails, M6a measures at a fixed reference scale and divides (M6-Q3 records the choice).

### 4.2 The layout port (one source of truth)

`contracts` gains a synchronous, plain-data `TextLayoutPort`, injected as `createEditor({ textLayout })`:

```ts
interface TextLayoutPort {
  readonly portVersion: 0;
  readonly generation: number;
  layout(request: TextLayoutRequest): TextLayoutResult; // runs, sizing, width, align, spacing, lang
  subscribe(listener: () => void): () => void; // generation changes
}
// Result: generation; box width and height; lines (start, end, top, baseline, height);
// clusters (start, end UTF-16 offsets, line, x, advance, run index, font list).
```

- **M6-L1 single source.** The auto-size frame, the scene projection (positions for R-T), hit testing in edit mode, caret and selection geometry and Up and Down movement all read this one result. Nothing else measures text, so DOM and GPU positions agree by construction and only rasterization can differ (section 6).
- **M6-L2 test double.** Unit tests in Node use a committed fake port with fixed advances per code point class; the real service is tested in headed specs.
- **M6-L3 caching.** Results are cached by every layout input (runs, sizing, width, align, letter spacing, line height, `lang`) and `generation`; a generation change drops the cache. The service is main-thread only (it needs a document), a cost for M9 pointer priority.
- **M6-L4 no port.** Without a port, text commands fail with an editor code fixed in M6a and text nodes project nothing, with a diagnostic; a document with text still loads.

### 4.3 Font load and stored frames (M6-Q6)

A generation change re-projects text but does not rewrite stored frames; the document changes only through commands. An auto-size frame computed before a font loaded may differ from the drawn text until the node's next edit, which refits it, and a `refitText` command lets a host refit on demand. Disclosed: auto-size frames depend on the fonts of the machine that last edited the node.

## 5. Glyph rendering route (R-T, M6-Q7)

| Route | Needs | Cost and risk |
| --- | --- | --- |
| (a) Atlas of browser-rasterized grapheme clusters (recommended) | `OffscreenCanvas` 2D `fillText` of each cluster with its font list and `lang` into an `r8` coverage atlas tinted by run color, drawn as textured quads at the layout positions; a `text` scene node kind and pipeline | No font bytes, so system fonts and Hangul fallback work; no dependency. Bitmaps per size bucket and subpixel phase, so zoom re-rasterizes and memory grows; above a raster cap glyphs scale and blur (M6-Q8). It puts the browser's text rasterizer inside the renderer, which the atlas reservation does not state, so it needs an ADR (unit M6-ADR) and the user's approval |
| (b) Glyph outlines as paths through the P3 pipeline | Font bytes (not available for system fonts without the Local Font Access permission) and an outline parser (a new dependency) | Expected, not measured: one path per text node exceeds the V4 fringe cap of 128 boundary vertices and draws region-only (aliased, 4x MSAA), poor at body sizes; 32-cubic paths still reach `work-limit` (E14 open); A01 cracks and the A04 precision FAIL apply to every glyph; one path per glyph multiplies node counts against the 10,000-node M9 target |
| (c) SDF or MSDF atlas | Outlines, as (b), plus a distance-field generator | Sharp at zoom; the same font-byte and dependency problem as (b) |
| (d) DOM text layer over the canvas | Nothing new | Breaks paint order, clips, masks and isolated opacity; rejected |

R-T is filed on the rendering track after the ADR (MVP plan section 5) and owns the scene node shape, atlas keys, size buckets, the raster cap, eviction, device-loss rebuild and the color-glyph rule. It must honor: plain-data glyph runs (cluster text, font list, `lang`, node-local positions, color, layout generation); no DOM object in `contracts`; **atlas entries keyed by, or invalidated on, the layout generation**, so a cluster rasterized with a fallback face is never reused after the web font loads (M6-F4); document paint order; the node transform; clips, masks and isolated opacity as for any leaf; P1 D2 compositing; rasterization where the faces are registered (M6-F2).

## 6. DOM and GPU agreement

- **M6-G1 positions.** GPU glyph origins are the port's cluster positions mapped by the node transform; there is no second layout.
- **M6-G2 tolerance.** Differences come from atlas quantization and from DOM painting versus canvas `fillText`. The M6c contract sets the tolerance from M6-S0 data; the starting proposal is a cluster ink-box offset of at most 0.5 CSS px and a size difference of at most 1 CSS px at zoom 1, DPR 1 and 2, on the committed test font (M6-Q20).
- **M6-G3 method.** Each fixture cluster is drawn isolated (one cluster visible per probe, the others transparent, or color-coded per cluster) on both sides: the DOM side as a screenshot of the measurement element made visible, the GPU side by frame readback (the E10 hook). Ink boxes are thresholded coverage bounds, compared in CSS px.
- **M6-G4 fixtures.** Latin kerning pairs, Hangul syllables, mixed families and sizes, a Latin-only family with Hangul, wrap points, and a **font-load case** (register a web font, lay out and draw with the fallback, let it load, then check that layout, frame refit and GPU glyphs all follow the new face). Committed values are structural (line count, line of each cluster), never absolute pixels. Fixtures that depend on a system font (Malgun Gothic) are valid on the main PC only.
- **M6-G5 edit overlay.** While a node is edited the GPU keeps drawing its text from live layout, and the DOM overlay draws only the caret, selection and composition underline (M6-Q14), so entering edit mode moves no glyph.

## 7. Editing

- **M6-E1 edit mode.** Session state `textEdit: { id, anchor, focus, composition: { start, end } | null }`, never history, like `pathEdit`. Double-click on a text node enters it when the node is in the current scope; otherwise the M2 scope rule applies first (the first double-click enters the group or frame). Enter on one selected text node enters text edit instead of `enterScope`. The text tool's click makes a pending `autoWidth` node and its drag a pending `autoHeight` node: `textEdit` then holds `pending: { parent, frame, sizing, style }` instead of an existing ID, and the caret is drawn from it until the node exists (M6-E5). Escape, a click outside and a selection change leave edit mode.
- **M6-E2 input sink (M6-Q14).** `EditorCanvas` owns a hidden `<textarea>` (with `spellcheck=false`, `autocomplete`, `autocorrect` and `autocapitalize` off; Edge text prediction and Microsoft Editor can still inject input, a risk), placed at the caret so the IME candidate window appears there, and focused in edit mode. It holds only the active composition. The host maps `beforeinput` (`insertText`, `insertFromPaste`) and `compositionstart`, `compositionupdate` and `compositionend` into new `input` event kinds that M6b adds to `InputEvent`. Enter, Backspace and Delete are handled from `keydown` only (M6-E3 rule 3), because Chrome may fire no `deleteContentBackward` in an empty textarea, the usual state after a commit; `insertLineBreak` and `insertParagraph` are not mapped, and the prevented keydown means they do not fire. A `textEditOverlay` query gives the caret, selection rectangles and composition range in page space.
- **M6-E3 key routing in edit mode (an M2 change made by the M6b contract).** The textarea joins the canvas focus target, as M2-I4's hidden clipboard sink does, and the key, `copy`, `cut`, `paste` and blur listeners move to cover it. In edit mode the M2-I2 order changes: (1) a `keydown` with `key` `Process`, `isComposing` true or (read by the host) `keyCode` 229 goes nowhere in the editor (no navigation, tool or keymap) and is not prevented; (2) Space, letters, digits and punctuation skip navigation and the keymap and are left to `beforeinput`; (3) Enter, Backspace, Delete, Mod+Backspace and Mod+Delete are edit actions of the text edit state; (4) Escape, Mod+Z, Mod+Shift+Z and Mod+Y, Mod+A and the caret keys of M6-E6 are handled by the text edit state; (5) Tab does nothing; (6) everything else is unbound in edit mode in the MVP. Keys of rules 1 and 2 return a new pass-through result (handled, not consumed), so `EditorCanvas` does not call `preventDefault` and `beforeinput` and the IME keep working; keys of rules 3 to 5 are consumed and prevented, so an edit action runs once and Tab neither inserts nor moves focus.
- **M6-E4 IME composition as transactions (M6-Q15).** `compositionstart` begins a text gesture, whose base is the document and whose record holds `textEdit` (like `pathEdit`, `editor.ts:172`); its selection is the replaced range. Each `compositionupdate` is a gesture `replace` (cause `gesture-update`, so M5 autosave writes nothing). `compositionend` commits with its own `data`, which may differ from the last update; an empty end cancels when the replaced range was empty, and otherwise commits the deletion of that range. While composing, keyboard undo and redo are ignored (rule 1). A host `undo`, `redo` or document command, or a load, during a composition force-ends it: as a change to `run()` and M5-U2 note 2 made by the M6b contract, `run()` first commits the text gesture with the composing text as it stands, then applies the command to the committed document (today it applies to the pre-gesture base, `editor.ts:741`, and cancels). The host then blurs and resets the textarea to end the IME's composition, drops the browser's late `compositionend` for that composition (else the text goes in twice) and refocuses the textarea; this host-made blur fires neither the M2-I4 blur reset nor an edit-mode exit. `begin` during a pointer drag fails, and the host ends the composition the same way. The textarea is reset only after a `compositionend` that no `compositionstart` follows in the same task, since a final consonant can move into the next syllable through an immediate end and start; that this ordering holds is an M6-S0 hypothesis.
- **M6-E5 undo granularity (M6-Q16).** Requirements: text input is "merged into useful history steps". History entries gain the caret before and after (`textEdit` values), so undo and redo restore the caret. Consecutive insertions at a contiguous caret (typing and composition commits alike) merge into the last entry, in `run` (`editor.ts:736`) and in the gesture commit (`editor.ts:1630-1634`) alike; so do consecutive deletions in one direction. A merge ends at a caret move, selection change, style change, paste, deletion after insertion, leaving edit mode, an LF, and a whitespace typed after a non-whitespace character (so one step is about a word), with no timer. A pending node (M6-E1) is created only by its first input: a typed character creates it in that command's step, and a first composition's gesture `replace` holds `createText` and `setText`, so its commit creates the node in that step and its cancel leaves none. An abandoned node never enters the document or autosave (M6-Q19).
- **M6-E6 caret and selection (M6-Q17).** UTF-16 offsets over the node text, on grapheme-cluster boundaries (`Intl.Segmenter`). Left and Right by cluster, Up and Down by line with a goal x, Home and End to line ends, Mod+Home and Mod+End to text ends, Mod+Left and Mod+Right by word, Mod+Backspace and Mod+Delete by word, Shift extends (with click as well), click places, drag selects, double-click selects a word, Mod+A selects all. A caret at a soft wrap has an affinity. Tab is consumed and does nothing (M6-E3 rule 5). Backspace after a committed syllable deletes the whole syllable; jamo deletion happens only inside a composition. Typed text takes the style of the character before the caret.
- **M6-E7 plain-text paste (M6-Q18).** Only `text/plain` is read (`text/html` is ignored, the requirement's normalization); CRLF and CR become LF, tab a space, other controls are dropped. In edit mode the text replaces the selection in the caret's style as one step. Outside edit mode, non-fragment text creates an `autoWidth` text node at the last pointer position over the canvas, else the viewport centre (a DOM paste has no position), replacing `editor.unsupported-clipboard` for that case. Copy and cut in edit mode write the selected plain text.
- **M6-E8 commands.** Provisional: `createText`, `setText { id, start, end, text }`, `setTextStyle { id, start, end, style }`, `setTextProps { id, sizing?, align?, letterSpacing?, lineHeight? }`, `refitText`, and session commands for edit mode and text selection, with codes in M6a and M6b.

## 8. Milestone split and units (M6-Q1)

Recommended: a spike, an ADR and three milestones, each milestone with its own contract of 300 lines or fewer and exit record.

| Unit | Content | Tier |
| --- | --- | --- |
| M6-S0 | Playground spike, no product code: DOM layout throughput on 1,000 nodes; the DPR hypothesis (section 4.1); the fallback hypothesis (M6-F2); canvas versus DOM ink boxes; a Korean IME recorder (cases in section 9); evidence on the main PC with browser, OS and IME versions | Light (demo page, D10) |
| M6-ADR | ADR for the glyph route (M6-Q7 (a)) and the browser as shaping owner (M6-Q2 (a)), before the R-T contract | Full (architecture decision) |
| M6a | Schema vN+1, text node, migration, fragments, fixtures; `TextLayoutPort` in `contracts`; `@vector-studio/text-dom` (registry, DOM layout), boundary-policy entry and ARCHITECTURE update; fake port; text commands, sizing and resize; next-host font registration; headed layout spec | Full (shared surface: `contracts`, both-track review) |
| R-T | Rendering track: `text` scene node kind, glyph atlas, text pipeline (section 5) | Full (shared surface) |
| M6b | Text tool, edit mode, key routing (the M2 change), textarea, `textEditOverlay`, IME, undo merge, paste; caret fixtures; headed IME and caret specs; amends the architecture's text-reservation paragraph (M6-Q14) | Full |
| M6c | Projection of `text` scene nodes through R-T; agreement spec; the manual real-IME run; M6 exit record | Full |

Order: M6-S0 and M6-ADR, then M6a; then M6b and R-T in parallel; M6c after both. **M6b has no visible text** (GPU text arrives in M6c): its headed specs read the document, `textEdit` and `textEditOverlay` through the `?test=1` hook and draw only the DOM caret and selection; no debug text layer is added. The manual real-IME run is therefore in M6c. M7's text-override criterion needs M6a only; whether it waits for M6c, as MVP plan section 7 says now, is the user's choice (M6-Q1). The D10 WIP limit applies.

## 9. Fixtures and headed specs

- **Committed fixtures** in `tests/fixtures/m6-text/`: vN to vN+1 migration pairs and fragment migration; every text field and code; caret and selection scripts against the fake port (Hangul, combining marks, soft wraps, LF, and emoji ZWJ sequences limited to ones whose segmentation is the same in Node's and Chrome's ICU); the recorded IME traces of M6-S0, replayed through the host mapping in unit tests.
- **M6-S0 recorder cases.** A final consonant moving into the next syllable (end, then immediate start); Backspace in an empty textarea after a commit; a click during composition with and without focus moving (a `preventDefault`ed `pointerdown` keeps focus); arrows and Escape during composition; both Microsoft Korean IME versions on Windows 11 (the "previous version" toggle). Each trace records the IME version and toggle.
- **Headed specs** on the user's main PC in Chrome and Edge: M6a layout (test font, fallback, font-load case, DPR); M6b IME, replaying the traces through the Chrome DevTools Protocol's `Input.imeSetComposition` and `Input.insertText` (Chromium, so both browsers), and a caret spec against the real port (caret and selection rectangles against the measured clusters); M6c agreement (section 6) and one manual run with the real Microsoft Korean IME by the user, logged by the test hook with the IME version, because Playwright cannot drive an OS IME.
- **Not in the container.** The cloud container has no headed Chrome or Edge, no WebGPU adapter and no OS IME; it runs unit tests, `pnpm check` and formatting. Every headed result is from the main PC or NOT RUN.

## 10. Acceptance criteria (plan level)

Each milestone contract turns these into its own IDs and methods; none is met by this plan.

| ID | Criterion | Method |
| --- | --- | --- |
| M6-A01 | Text node vN+1 round trip byte for byte; committed vN fixtures and older fragments migrate; each invalid field, control character and non-canonical run fails with its code | Unit tests (M6a) |
| M6-A02 | `TextLayoutPort` is plain data; `contracts` and `editor-core` hold no DOM type; `text-dom` imports `contracts` only; `pnpm check:boundaries` covers it | Unit tests, boundary check (M6a) |
| M6-A03 | Fonts: a host web font loads through the registry and raises `generation`; the font-load case (register, measure with fallback, load, re-measure) re-projects with no document event and `refitText` refits; a missing family and Hangul in a Latin-only family fall back | Headed (M6a) |
| M6-A04 | Sizing, growth anchor under rotation, resize mode switches and group and constraint scale of M6-T3, M6-T4 and M6-T4a, with exact values on the fake port | Unit tests (M6a) |
| M6-A05 | Every text command and committed input gives byte-identical undo; the M6-E5 merge and break rules give the committed history depths and carets; a node made by the text tool and left empty leaves no entry | Unit tests (M6a, M6b) |
| M6-A06 | Caret and selection: the committed scripts give the committed offsets and rectangles (fake port); the headed caret spec agrees with the real port's clusters | Unit tests, headed (M6b) |
| M6-A07 | IME: start, update, end, empty end, interrupt (commit first, then the command; the late `compositionend` after the host blur dropped, so the text goes in once; no edit-mode exit) and drag cases of M6-E4, and a first composition on a pending node (commit creates, cancel leaves none) (events, causes, one step); traces replay to the committed text; headed CDP replay in Chrome and Edge; one recorded manual real-IME run | Unit tests, headed (M6b), manual record (M6c) |
| M6-A08 | Key routing: in edit mode Space, Backspace, Delete, arrows, letter keys and the first `Process` key never reach navigation or the keymap (no tool switch, no nudge, no delete of the node); Space, letters and the `Process` key are not prevented; Enter, Backspace and Delete act exactly once; Tab keeps focus and edit mode; Escape and Mod+Z keep their edit-mode meaning; key and clipboard events on the textarea reach the editor | Unit tests (editor and React), headed (M6b) |
| M6-A09 | Paste: `text/plain` only, M6-E7 normalization and position, in and outside edit mode | Unit tests, headed (M6b) |
| M6-A10 | GPU text in document paint order under clips, masks, isolated opacity, rotation and zoom, and atlas entries never reused across generations, per the R-T contract | Headed (R-T, M6c) |
| M6-A11 | DOM and GPU agreement within the M6c tolerance on the section 6 fixtures, the font-load case included | Headed (M6c) |
| M6-A12 | No new runtime dependency or asset without the user's recorded approval; earlier headed specs still pass | Diff review, headed |
| M6-A13 | Independent review of each unit (both tracks for shared-surface units); the user accepts each milestone's exit record | Review record |

The MVP plan's M6 exit gate (a headed Korean IME composition spec in both browsers and committed caret and selection fixtures) is M6-A06 and M6-A07.

## 11. Risks

- **Browser layout is not ours.** Breaking, shaping and fallback follow Chrome and Edge and can change with updates; structural fixtures catch it. A user "minimum font size" setting can clamp small DOM text; measured in M6-S0, not handled.
- **Machine-dependent frames** (section 4.3) and **main-thread layout and rasterization** with unknown cost until M6-S0 and M9.
- **Atlas quality and memory**: zoom re-rasterization, the raster cap, many sizes and families, generation-keyed entries; color emoji may need an RGBA atlas (R-T).
- **IME variance**: behavior differs by OS, IME version and toggle; CDP replay is synthetic; force-ending a composition on interrupt can surprise the user; Hanja conversion of committed text may not work, since the textarea holds only the composition; Edge text prediction and Microsoft Editor may inject input.
- **Ligatures off** (M6-Q9 (a)): fonts relying on contextual alternates draw without them.

## 12. Open questions

| ID | Question | Recommendation |
| --- | --- | --- |
| M6-Q1 | Split M6? (**user decision**: the MVP plan's milestone list) | (a) M6-S0, M6-ADR, M6a, M6b, M6c as section 8, M7's text override after M6a. (b) one M6 and one contract, beyond 300 lines and blocked on R-T throughout |
| M6-Q2 | Who shapes? (**user decision**: shaping ownership; (b) and (c) are new runtime dependencies) | (a) the browser, through DOM layout, no dependency. (b) HarfBuzz WASM, npm `harfbuzzjs`, roughly 1 to 2 MB of WASM uncompressed (to be measured at the pinned version before approval); needs font bytes. (c) `rustybuzz` and `ttf-parser` in the Rust kernel, size unmeasured, a kernel ABI change; it also needs font bytes, so system fonts and Hangul fallback need Local Font Access. (d) canvas `measureText` and an own UAX #14 breaker: no dependency, but layout no longer matches DOM editing |
| M6-Q3 | Where does layout live? | (a) `TextLayoutPort` in `contracts`, implemented by `@vector-studio/text-dom` (`-> contracts`), injected through `createEditor`; ARCHITECTURE gains the package; measurement at page units, or at a reference scale if M6-S0 rejects the DPR hypothesis. (b) inside next-host only: smaller, but every host rewrites it |
| M6-Q4 | Font sources | (a) system fonts by name and host-registered `FontFace` sources; family names only in documents. (b) embedded font bytes (deferred). (c) Local Font Access (permission prompt; not MVP) |
| M6-Q5 | Fallback chain | (a) M6-F2 with one `lang` on both sides; no missing-font detection |
| M6-Q6 | Stored frames after a font loads | (a) re-project only; refit on the next edit or by `refitText`. (b) an automatic refit transaction (a document change without a command). (c) derived auto-size frames (changes NodeBaseV2 meaning, hit testing, group bounds) |
| M6-Q7 | Glyph route (**user decision**: ADR, renderer behavior) | (a) browser-rasterized cluster atlas keyed by generation, section 5. (b) outlines as paths. (c) SDF or MSDF. (d) DOM layer |
| M6-Q8 | Glyphs above the raster cap | (a) scale the capped bitmap, disclosed blur; cap set in R-T. (b) an outline route above the cap, later |
| M6-Q9 | Cross-cluster shaping | (a) ligatures off in layout, per-cluster rasterization, kerning kept by positions. (b) rasterize line segments (exact, little reuse) |
| M6-Q10 | Per-run fields | (a) family, size and color per run (the requirement's list); letter spacing and line height per node. (b) all per run |
| M6-Q11 | Weight and italic (**user confirmation** of the requirement reading) | (a) none in the MVP, as requirements list family, size and color; a host may register a weight as its own family. (b) per-run weight and style, a requirement addition |
| M6-Q12 | Alignment (**user confirmation**: reading of "paragraph alignment") | (a) left, center and right, set per node for all its paragraphs; justify and per-paragraph values deferred; vertical top. (b) per-paragraph alignment, justify, or both |
| M6-Q13 | Korean line breaking | (a) `word-break: keep-all` with `overflow-wrap: anywhere`. (b) the browser default, breaking between Hangul syllables |
| M6-Q14 | Input sink (**user confirmation**: it changes the reading of "active editing uses a DOM overlay", `graphics-engine-architecture.md:271`) | (a) hidden textarea; `editor-core` owns text and caret; the GPU draws the text and the DOM overlay only caret and selection; M6b amends the text-reservation paragraph. (b) `contenteditable` overlay that draws the text while editing: native caret, but run mapping, undo and tests leave the editor |
| M6-Q15 | IME transaction model | (a) composition as a text gesture with forced end on interrupt, M6-E4. (b) a command per update, squashed at the end |
| M6-Q16 | Undo granularity | (a) M6-E5: contiguous merge with breaks at caret moves, LF and word boundaries, no timer. (b) one step per character or composition |
| M6-Q17 | Caret model | (a) UTF-16 offsets on grapheme boundaries with wrap affinity. (b) run index and offset pairs |
| M6-Q18 | Paste normalization | (a) M6-E7 |
| M6-Q19 | A text-tool node never typed into | (a) pending in session state until its first input, so it never exists empty (M6-E1, M6-E5). (b) created at click and deleted on exit (rewrites history after autosave) |
| M6-Q20 | Test font (**user decision**: third-party licensed asset) | (a) a subset of an OFL font with Hangul and Latin (for example Noto Sans KR) and its license in `tests/fixtures/m6-text/`. (b) system fonts only, main PC only |
| M6-Q21 | Headed IME method | (a) recorded traces, CDP replay in Chrome and Edge, one recorded manual real-IME run (section 9). (b) manual runs only |
| M6-Q22 | Bounds | (a) per-node limits on text length, run count and size fixed in M6a; commands beyond fail |
| M6-Q23 | Group and constraint scale of text (**user confirmation**: reading of "Groups scale their children proportionally") | (a) scale the frame and every run's `size` by `√(sx · sy)`; a non-uniform scale switches auto modes to `fixed` (M6-T4a). (b) frame only, `size` unchanged, auto children switched to `fixed`: narrows the requirement |

M6-Q3 to M6-Q6, M6-Q8 to M6-Q10, M6-Q13 and M6-Q15 to M6-Q22 except M6-Q20 change no requirement and add no dependency; they may be adopted as recommended under the user's standing rule of 2026-10-24 once the plan is reviewed. M6-Q1, M6-Q2, M6-Q7 and M6-Q20 need the user's explicit decision; M6-Q11, M6-Q12, M6-Q14 and M6-Q23 need the user's confirmation of the recommended reading.

## 13. Validation of this plan

Documentation only: local links and anchors were checked. Markdown formatting is not checked: `npx prettier --check` passes, but the repository's `.prettierignore` excludes `**/*.md`, so it skips these files. Code claims are grounded by `file:line` at 4d53f7e. No product, browser, GPU, IME or benchmark run is claimed; the costs and sizes in section 5 and M6-Q2 are estimates, and the DPR and fallback statements are M6-S0 hypotheses.

## 14. Gate

Independent review round 2 is READY WITH FOLLOW-UPS, applied. The plan then needs the user's decisions on M6-Q1, M6-Q2, M6-Q7 and M6-Q20 and confirmations on M6-Q11, M6-Q12, M6-Q14 and M6-Q23. On approval, M6-S0 (light tier) and M6-ADR may start; R-T is filed on the rendering track once the ADR is accepted, which is later than MVP plan section 5's "when the text plan is approved" (the MVP plan's M6 pointer says so); the M6a contract, a shared-surface change reviewed by both tracks, may be written. No M6 product code starts before the M6a contract is approved; M6 implementation entry follows the MVP plan's milestone order and the user's acceptance of the earlier exits.

Decided 2026-10-29: M6-Q1, M6-Q2, M6-Q7 and M6-Q20 take option (a), and M6-Q11, M6-Q12, M6-Q14 and M6-Q23 are confirmed as reading (a), 추천안 자동 채택 under the standing rule of 2026-10-24, recorded while the user's decision cards were open; if the user picks differently on a card, that pick replaces the option here before the unit it affects starts. M6-S0 and M6-ADR may start.

## 15. Progress

| Unit | State |
| --- | --- |
| Plan | APPROVED 2026-10-29: review round 1 NOT READY, applied; round 2 READY WITH FOLLOW-UPS, applied; user-level questions adopted as (a), 추천안 자동 채택 2026-10-29 (section 14) |
| M6-S0 | In progress: spike page and scripts (local) |
| M6-ADR | Not started |
| M6a | Not started |
| R-T | Not filed |
| M6b | Not started |
| M6c | Not started |
