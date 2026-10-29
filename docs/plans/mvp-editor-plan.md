# MVP editor plan

Status: APPROVED 2026-10-28 under the user's standing instruction of 2026-10-24, after independent review rounds 1 and 2 (NOT READY, applied) and 3 (READY WITH FOLLOW-UPS, applied); Full tier (milestone order, acceptance gates, product behavior and new shared-surface needs). Visualization-track item [V-7](d9-visualization-track.md#status-index). The user chose this plan as the main next work on 2026-10-28 (project chat), asking for E20 or E22 to run alongside it on the rendering track; E22 is proposed first there. Open questions MVP-Q1 to MVP-Q13 (section 9) are adopted as recommended under the user's standing instruction of 2026-10-24 once the plan is approved, except MVP-Q3, which narrows a requirement: the user chose MVP-Q3 (a) on 2026-10-28; entering MVP implementation (M1) is a separate user decision (section 11).

Owners: this file owns the MVP milestone order, each milestone's scope and exit gate, and the list of rendering-track needs. [`requirements.md`](../requirements.md) owns product behavior and is not changed here; [`ARCHITECTURE.md`](../../ARCHITECTURE.md) owns package boundaries; each milestone's own contract (section 6) owns its acceptance criteria and evidence, as [`AGENTS.md`](../../AGENTS.md#working-rules) requires before product code.

## 1. Goal and definition of MVP

The MVP is the editor that [`requirements.md`](../requirements.md) describes: every requirement under SDK model, Document, MVP node types, Path editing, Text, Containers, Symbols, Initial appearance model, Editing behavior, Persistence, Platform and performance, and Extension direction, as an in-repository prototype in desktop Chrome and Edge. It is not a public package or a production application (requirements, Product goal).

**MVP done** means: every row of the requirement coverage table in section 3 has its milestone exit accepted by the user, and the MVP exit record (M9) lists evidence for each requirement bullet, including the performance targets as committed benchmark results ([`docs/benchmarks/README.md`](../benchmarks/README.md)) on the main PC. Lower-tier hardware coverage, which the coverage table asks for before alpha, is after the MVP. Deferred items in requirements (images, auto layout, boolean operations, multiple fills, untrusted plugins and so on) stay deferred.

## 2. Starting point (main at 03f5afc)

| Area | Exists | Source |
| --- | --- | --- |
| Packages | `model` (schema v1), `editor-core` (commands, transactions, history, gestures, session, tools, hit testing, projector, extensions), `react` (provider, selector hook, `EditorCanvas`), `apps/next-host` | [P5 plan](p5-editor-slice.md), exit [#275](https://github.com/npclown/vector-studio/pull/275) |
| Document | One page; `rectangle`, `path`, `custom` nodes; axis-aligned `frame`; unit-box path points; strict v1 parse | P5 section 3 |
| Editing | Rectangle and path creation, click and marquee selection, move, 8-handle resize, undo and redo with one step per gesture | P5 section 4 |
| Renderer surface | Primitives (rectangle with four corner radii, ellipse, line), paths (fill rules, caps, joins, miter limit), node opacity on leaves, affine transforms, containers with `clip: null \| rect \| mask` to depth 32 | `packages/contracts/src/scene.ts`, [P4 contract](p4-clip-mask.md) |
| Renderer gaps | Gradients, dashes, container opacity other than 1 (rejected), text or glyphs; primitive strokes have no cap or join (`SceneStroke` is color and width, a `line` primitive draws butt caps) | Section 5 |
| Known defects | P3 exits with disclosed defects (A01 crack, A02/A08 INCONCLUSIVE, A04 FAIL); P4 follow-ups in E22 | [rendering track](d9-rendering-track.md#status-index) |

## 3. Requirement coverage to milestones

| Requirement area | Remaining MVP work (from [prototype-plan](../prototype-plan.md#requirement-coverage)) | Milestone |
| --- | --- | --- |
| Document and persistence | Multiple pages, migration policy, host save and load, last-open-page envelope, optional IndexedDB autosave | M1, M5 |
| Shapes and appearance | Ellipse, line and arrow nodes, independent corner radii, gradients, dashes, full appearance controls | M1, M4 |
| Containers | Group, frame (background, border, clip, basic constraints), mask group, isolated opacity | M1, M4 |
| Interaction | Zoom and pan interaction, rotate, snapping, align and distribute, clipboard, layer ordering, grouping, Alt-drag duplication, nudging, overlap cycling, frame entry, configurable shortcuts | M2 |
| Path editing | Anchor and handle editing, insertion and removal, open and close | M3 |
| Text | Styled runs, fonts, layout, caret and selection, Korean IME, plain-text paste | M6 |
| Symbols | Source and instance, propagation, independent placement, text override, detach | M7 |
| React/Next.js and host API | Complete headless API, selectors, hooks, minimal layer and property panels | M8 (panels grow with each milestone) |
| Extension direction | Node definitions, tools, commands, shortcuts and UI panels from host-registered extensions | M1 (custom nodes in containers and through `migrate`), M2 (tools, shortcuts), M8 (panel contributions) |
| Performance | 10,000 nodes, 60 fps typical editing, 30 fps 10,000-simple-node stress, pointer priority | M9 |

## 4. Milestones

Each milestone is one visualization-track item with its own contract of 300 lines or fewer (section 6), units in the P5 style, an independent review per unit and an exit record the user accepts. Order and dependencies are in section 7.

### M1: Document v2 and containers

- **Schema v2** with `migrate(v1 -> v2)` in `model` (the first migration; the policy is MVP-Q2). Adds: several pages, `ellipse`, `line` (with optional arrowheads, MVP-Q4), per-corner `cornerRadii` on rectangles, `rotation` on every node (MVP-Q3), container nodes `group`, `frame` and `maskGroup` whose `parent` and `children` nest (P5 section 3.4 reserved this). A child's frame is relative to its parent container's frame origin (top-left), inside the parent's rotation about its centre; a frame's clip is `{0, 0, width, height}` in that space (MVP-Q11). Whether a group's frame is stored or derived from its children is an M1-contract question.
- **Projector** emits `container` snapshots with `clip: null` (group), `rect` (frame) or `mask` (mask group, first child is the source as in P4-S2); frame background and border are projected as ordinary leaf nodes (P4 scope note). A frame projects as an outer `clip: null` container carrying the frame's ID, transform, opacity and visibility, holding an inner `rect`-clip container (background, then the children) followed by the border leaf, so the border is drawn above the content, is not cut by the clip, as in Figma, and shares the frame's opacity and visibility (a null clip adds no clip depth, P4). These synthetic nodes (inner container, background and border leaves) get scene IDs in a reserved form that document IDs cannot take, mapped back to the frame for hit testing and diagnostics. **Projection rule:** a stroked line, and any shape whose cap, join or dash the primitive pipeline cannot draw, projects as a `path` node, so caps, joins and dashes need only the path stroke. Node transforms become translation, rotation about the frame centre, and container nesting.
- **Mask group rule**: as the requirement says, the source is the first child and it must be a `path` node (P4-S2 rejects a container source); a command that would make any other node the first child fails. Its fill, opacity and visibility do not affect the mask (P4-S2). MVP-Q12.
- **Clip depth**: each frame and mask group adds one clip level, and the renderer rejects depth 33 (P4); a command that would exceed depth 32 fails with its own code, and loading a deeper v2 document is an M1-contract question.
- **Resize of a rotated node** scales it along its own axes about the opposite handle (handles follow the rotation).
- **Commands**: create the new node types, `group` and `ungroup`, `addPage`, `removePage`, `renamePage`, `setActivePage` (session), reparenting.
- **Group resize** scales children proportionally, with the MVP-Q3 rule for rotated descendants; **frame resize** applies basic constraints per child and axis (MVP-Q5). A group, frame or mask group whose opacity is not 1 is rejected by the command until M4 (renderer rejects it today).
- **Hit testing** through rotation, containers, frame clips and masks, in `editor-core` (MVP-Q7).
- Exit gate: a custom node inside a group survives migration and round trip; v1 fixtures migrate byte-for-byte to the committed v2 fixtures; every v2 node type round-trips; nested group/frame/mask documents project to scenes the renderer mirror accepts; undo of group, ungroup and reparent is byte-identical; headed next-host page shows a framed, masked, rotated document in Chrome and Edge.

### M2: Interaction completeness

- Zoom and pan interaction: wheel and pinch zoom about the pointer, pan by Space-drag, middle-drag and scroll, zoom shortcuts (zoom to fit, to selection, 100%).
- Rotate handle (snapping to 15° with Shift), snapping to object and frame edges and centres, equal spacing and rotation angles, with a snap overlay in session state.
- Align and distribute, layer ordering (forward, backward, front, back), Alt-drag duplication, keyboard nudging (1 and 10 page units, MVP-Q8 for zoom scaling), overlap-selection cycling, frame-entry editing (double-click enters, Escape exits).
- Clipboard: copy, cut and paste of node subtrees with fresh IDs (MVP-Q6).
- Configurable shortcuts: a keymap passed to `createEditor` and changeable at run time; extensions may contribute bindings and tools.
- Snapping and its overlay stay in `editor-core`, as hit testing does (MVP-Q7).
- Exit gate: each behavior, zoom and pan included, driven through `input` and checked by exact values in unit tests; an extension tool and binding work through public API; snapping and rotation keep one undo step per gesture; headed spec for clipboard and shortcuts in both browsers.

### M3: Path editing

- Anchor and handle editing on existing paths, handle symmetry modes (mirrored, independent), node insertion on a segment and removal, open and close subpaths, as a path edit mode entered by double-click.
- Edits keep the unit-box rule of P5 section 3.1: after each committed edit the frame is recomputed from the points and the points re-normalized, inside the same transaction.
- Exit gate: each edit is one undo step with byte-identical undo; every committed path stays in the renderer's path grammar; headed spec for a closed and an open path edit.

### M4: Appearance

- Solid fill, one linear or radial gradient, stroke color and width, dash pattern and phase, joins and caps, opacity, independent corner radii, through `setNodeProps` and the property panel.
- **Isolated container opacity** for groups, frames and mask groups (MVP-Q9), including its interaction with masks (the P4 design gate).
- Needs rendering items R-G, R-D and R-O (section 5) merged first; the editor half is model fields, commands, projection and panel controls.
- Exit gate: each appearance field round-trips and projects; headed pixel probes for gradient, dash and isolated group opacity against references written in the rendering items' contracts.

### M5: Persistence

- Host-controlled save and load (`serializeDocument`/`parseDocument` plus a persistence envelope `{ document, lastOpenPageId }`, MVP-Q2).
- Optional IndexedDB adapter package (`@vector-studio/persistence-idb`, imports `model` and `contracts` only, as ARCHITECTURE allows): the host composition wires `editor.subscribe` to it, so autosave runs on committed transactions, debounced, never on gesture updates. `model` defines only the envelope type and its parse codes, so host save and load and the adapter share them; the last-open-page value stays host and persistence state ([ARCHITECTURE](../../ARCHITECTURE.md#state-classification)). The package is added to `tooling/boundary-policy.mjs` in the unit that creates it; a fake IndexedDB, if used, is a dev dependency of the tests only; restore of content and last open page; selection, hover, zoom and panels are not restored.
- Exit gate: unit tests with a fake IndexedDB; headed reload test in next-host restores the document and page; a corrupt store entry fails with the model's codes and loads nothing.

### M6: Text

- Requires its own **text plan** first (the architecture's "Post-P5 text plan" design gate, [graphics-engine-architecture](../graphics-engine-architecture.md#design-gates-before-later-implementation)): font loading and fallback, shaping ownership, DOM/GPU layout agreement, Korean IME composition as transactions, caret and selection fixtures. The text plan is Full tier and decides the glyph rendering route and any new runtime dependency (MVP-Q10), each with user approval.
- MVP scope from requirements: styled runs (family, size, color), wrapping and auto width and height, letter spacing, line height, alignment, normal caret and selection, Korean IME, system and host web fonts, plain-text paste.
- Exit gate: set by the text plan; at least a headed Korean IME composition spec in both browsers and committed caret and selection fixtures.
- Text plan: [mvp-m6-text-plan.md](mvp-m6-text-plan.md) (V-12, draft 2026-10-29); it proposes splitting M6 into M6a, M6b and M6c (M6-Q1) and filing R-T once its glyph-route ADR is accepted, later than section 5's "when the text plan is approved".

### M7: Symbols

- Simplified symbol source and instances: source edits propagate to instances, instances have their own placement and size, instance text content may differ, instances can be detached. Nested instances, variants and general overrides stay deferred.
- Propagation, placement and detach may start after M1; the text-override criterion closes after M6, so M7 does not wait on all of text.
- Exit gate: propagation, override and detach as single undo steps with byte-identical undo; round trip with instances; a source deletion rule written in the M7 contract.

### M8: Host API and minimal UI

- Completes the headless API: selectors and hooks for selection, active page, tool, history state, snapping, panels; command typing for extensions; a minimal UI package (`@vector-studio/ui`, new, imports `react` only, as ARCHITECTURE allows) with toolbar, layer panel and property panel that use only the public API (requirements, SDK model). Because the UI needs node and command types, `editor-core` re-exports the `model` types its public API uses and `react` re-exports them from `editor-core`, keeping `react -> editor-core, contracts`; the package enters `tooling/boundary-policy.mjs` in its creating unit. Extensions contribute panels through the UI package.
- Panels grow in each milestone as needed for its headed specs; M8 closes the gaps and documents the API.
- Exit gate: a type-level test that the UI package imports nothing but public exports; an extension panel renders through public API only; the next-host app uses the UI package; the boundary checker covers it.

### M9: Performance and MVP exit

- Benchmarks, following [`docs/benchmarks/README.md`](../benchmarks/README.md), on the main PC: a 10,000-node mixed editor document (all visible worst case), typical editing at 60 fps, a 10,000-simple-node stress scene at 30 fps or more, and pointer-input latency while background work runs.
- MVP exit record: one row per requirement bullet with its evidence, the disclosed defects carried from P3 and P4, and the remaining backlog. The MVP exit is the user's acceptance of that record.

## 5. Rendering-track needs

The visualization track files these on the [rendering track](d9-rendering-track.md#status-index) with a fixture: R-G, R-D and R-O when M1 starts, so they are ready for M4; R-T when the text plan is approved; R-P at the M1 exit. Each is Full tier because it changes `packages/contracts` or renderer behavior; contract changes are shared surface under D9 and get review from both tracks. Labels are provisional until the rendering track assigns E numbers.

| Label | Need | Needed by | Note |
| --- | --- | --- | --- |
| R-G | Linear and radial gradient paint for primitives and paths (one gradient per paint) | M4 | New `ScenePaint` variant beside `SceneColor` |
| R-D | Dash pattern and phase for path strokes (`PathStroke`; dashed shapes project as paths) | M4 | Dash expansion in `renderer-core` ahead of the unchanged stroke port, kernel unchanged ([E24](d9-e24-dash-contract.md), E24-Q1 (a), 2026-10-29); this resolves the P3 design-gate item on dash units and phase |
| R-O | Isolated container opacity (offscreen group composite) | M4 | Lifts the P1 rejection, which requires isolated composition ([architecture](../graphics-engine-architecture.md#approved-p1-visual-behavior)); states the interaction with masks; uses the reserved offscreen textures |
| R-T | Glyph rendering route chosen by the text plan | M6 | Atlas or outline-as-path, decided in the text plan |
| R-P | Pointer-priority scheduling and a mixed 10,000-node benchmark workload | M9 | Benchmark methodology change only if needed |

Under the M1 projection rule, line and arrow nodes, caps and joins on any shape, frame background and border, and selection overlays (a DOM overlay in next-host) need no renderer change: the projector emits existing primitives and paths. E22 (P4 follow-ups) is not a dependency but lowers the risk of large masks in M1 and M4.

## 6. Milestone contracts

Before any product code of a milestone, its contract states: scope taken from section 4, schema changes, commands and their failure codes, acceptance criteria with IDs (`M1-A01` …), the validation method of each, units and their tiers, and its own open questions. It follows the P5 plan's form and the 300-line target. A milestone contract changes no requirement; a needed requirement change is a separate user decision.

## 7. Order and parallelism

```text
M1 -> M2 -> M3
M1 -> M4 (after R-G, R-D, R-O)
M1 -> M5
M6 text plan (can start after M1) -> M6
M1 -> M7 (start); M6 -> M7 (text-override criterion and exit)
M8 grows with every milestone, closes after M7
M9 after M1..M8
```

- The main line is M1, M2, M3 on the visualization track, one milestone in implementation at a time under the WIP limit of two units waiting for review.
- The rendering items of section 5 run on the rendering track in parallel once M1 has started, after E22 or alongside it as the rendering track's own WIP allows.
- The text plan is written while M2 or M3 is implemented, because its decisions (dependencies, glyph route) need user approval well before M6.
- M5 is small and may be taken whenever the main line is blocked on review.

## 8. Risks

- **Text is the largest unknown**: shaping and IME are new subsystems with new dependencies; the text plan may split M6 into several milestones.
- **Disclosed P3 defects** (cracks, A04) become visible editor bugs on real documents; editor milestones do not work around them and file fixtures to E20, E18 or E7.
- **Hit testing and snapping in `editor-core`** (ARCHITECTURE puts them in the geometry contract; P5 section 4.4 is the precedent) grow with rotation, clips and masks; if it diverges from rendering, a geometry hit-test port becomes a rendering item.
- **Performance** has no MVP-level evidence yet; P1 A09/A10 and P2 A08 are open performance debt, and M9 may surface renderer work late. A mixed 10,000-node smoke benchmark is taken at the M1 exit as an observation (no claim) to see this early.
- **Schema churn**: each milestone that adds persisted fields bumps `schemaVersion` with a migration (MVP-Q2), so migrations accumulate; each is small and tested by committed fixtures.

## 9. Open questions

| ID | Question | Recommendation |
| --- | --- | --- |
| MVP-Q1 | Milestone order: containers first (M1), or interaction first? | (a) M1 first: most later work (frames, masks, rotation, pages, symbols) needs the v2 tree, and P4 has just made containers renderable |
| MVP-Q2 | Migration policy | (a) integer `schemaVersion`; `parseDocument` accepts every earlier version and migrates in order; `serializeDocument` writes the latest only; unknown fields stay rejected, so each milestone that adds persisted fields bumps the version with a migration step; the last-open-page envelope is a persistence format beside the document, not in it |
| MVP-Q3 | Rotation representation (**decided by the user 2026-10-28: (a)**, accepting that (a) narrows "groups scale their children proportionally" as stated here) | (a) `frame` plus `rotation` in radians about the frame centre, so resize stays a frame change and undo stays exact. A non-uniform group resize would skew a rotated descendant, which (a) cannot store: a path descendant bakes the skew into its points (re-normalized frame, exact), any other rotated descendant scales its frame along its own axes (approximate). (b) a 2x3 affine per node: exact for every node, but resize and rotation handles, snapping and undo work on matrices |
| MVP-Q4 | Arrow model | (a) `line` node with `startArrow` and `endArrow` (`none`, `line`, `triangle`), projected by `editor-core` to path geometry; no renderer change |
| MVP-Q5 | Basic frame constraints | (a) per child and axis: `start`, `end`, `startEnd`, `center`, `scale`; default `start` |
| MVP-Q6 | Clipboard format | (a) a versioned JSON fragment written as `text/plain` with a marker prefix plus an in-memory copy; paste of foreign text creates nothing until M6 (then plain text) |
| MVP-Q7 | Hit testing and snapping through rotation, clips and masks | (a) stay in `editor-core`, extending the P5 section 4.4 precedent; a geometry port only if the risk in section 8 occurs |
| MVP-Q8 | Nudge distance | (a) 1 and 10 page units (Shift), independent of zoom, as Figma |
| MVP-Q9 | Container opacity | (a) isolated (offscreen composite, R-O), as the architecture requires for non-unit container opacity; until R-O lands, container opacity other than 1 is rejected by the command |
| MVP-Q10 | Text approach | (a) decide in the text plan, not here; this plan only reserves M6 and R-T |
| MVP-Q11 | Child coordinate space | (a) parent-local frames (origin and rotation as in M1): moving or rotating a container rewrites only the container, so undo and symbol propagation stay small |
| MVP-Q12 | Mask source kinds | (a) a `path` node only, as the requirement says ("first path"); widening to other leaves would be a requirement change for the user |
| MVP-Q13 | Roadmap phase | (a) add phase R5 "MVP editor" to D10, with this plan as its owner |

## 10. Validation of this plan

Documentation only: Markdown formatting and local links. No product, browser, GPU or benchmark run is claimed.

## 11. Gate

On approval, this plan is the MVP milestone plan. Writing the M1 contract may start on approval. **Implementation of M1** is an MVP phase entry and needs the user's decision, asked separately after this plan merges. Each later milestone starts its contract when its dependencies in section 7 allow and its implementation when its contract is approved.
