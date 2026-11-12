# V-31 contract: layer lock and hide

Status: APPROVED 2026-11-12 (independent review r1 NOT READY applied, r2 READY WITH FOLLOW-UPS applied), Full tier. Visualization-track item [V-31](d9-visualization-track.md#status-index). Requested by the user on 2026-11-12 ("1~10번까지 다 진행해줘", item 1 of the Figma gap list: layer lock and hide). Questions V31-Q1 to V31-Q4 (section 6) are adopted as recommended under the user's standing instruction of 2026-10-24 (추천안 자동 채택, recommended option auto-adopted).

Hide already exists: every node has `visible` (M1), hidden nodes are not projected (M1, `projectPage`), not hit (M1 section 6), not exported (V30-S2), and the layer tree's `layer-visible-<id>` button and the context menu toggle it (M8-L4, V-25 slice 10). This contract adds lock, gives both a keyboard action and makes the layer tree show them as Figma does. It changes `model` (document schema), `editor-core` (hit test, gestures, one command, two actions) and `ui` (layer tree, context menu). It changes no scene contract, renderer or persistence envelope.

It amends: the [M1 section 6](mvp-m1-document-v2-contract.md) hit and marquee rules (a locked subtree is skipped like a hidden one), the [M2 section 7](mvp-m2-interaction-contract.md) default keymap (two chords; the M2-U8 headed keymap check takes them), the [M8-L4](mvp-m8-host-api-ui-contract.md) layer row (a lock button) and the V-25 slice 10 context menu (a lock entry; show / hide becomes one step).

## 1. What a user can do

- Lock a layer from its layer-tree row (lock icon), the context menu, or `Mod+Shift+L`. A locked layer, and everything inside a locked container, cannot be clicked, marqueed, moved, resized or rotated on the canvas; clicks go through it to what is underneath (Figma).
- Select a locked layer from the layer tree and still edit it in the property panel, rename, reorder, delete or unlock it (Figma).
- Hide or show a layer from its row (eye icon), the context menu, or `Mod+Shift+H` (Figma's chord).
- See at a glance which rows are locked or hidden: the icons stay visible on such rows; on other rows they appear on hover or focus.

## 2. Document schema (`model`)

**V31-S1 field.** Schema v8 ([shared rule](viz-schema-v8.md), scaffold #571, under the coordinator's 2026-11-12 rule that the parallel items V-31 to V-40 add optional fields to the still unreleased v8) gains an optional node key `locked: boolean`:

- Read: absent or `false` reads as unlocked, and the normalized node has no `locked` key; `true` reads as `locked: true`; any other value fails `document.invalid-field` at the node's `locked` path. In memory the node type has `locked?: true | false`, and code tests `node.locked === true`.
- Write: the serializer writes `locked: true` only, after every other field of the node; an unlocked node is written without the key. A v8 document with no locked node is byte-identical to the scaffold's output, so documents autosaved between the scaffold and this item still load.
- `migrateV7toV8` gains no step (no key means unlocked).

A clipboard fragment carries `locked` as the document does. A fragment of an older schema version is refused as today (`validateFragmentTree` reads only the latest version).

**V31-S2 meaning.** `locked` is editor state that persists with the document: it changes no projection, export, bounds or snapping (a locked visible node stays a snap target, Figma). A node is *effectively locked* when it or any ancestor below the page is locked. An instance's expansion nodes take no part: the instance's own `locked` (and its ancestors') decide. `locked` does not count in the M7 section 6 content match of a symbol (the clipboard's copied-or-linked resolution normalizes it as it does `visible`).

**V31-S3 new nodes.** Every node the editor creates (drawing tools, group, mask group, boolean result, text) is unlocked (no `locked` key). Duplicate, paste and detach copy each source node's `locked`, as they copy `visible` (a pasted locked copy is selected but cannot be dragged, as in Figma). Grouping locked nodes gives an unlocked group.

## 3. Editor (`editor-core`)

**V31-E1 hit test.** The hit walk (`deepestHit`, `hitsAt`) and the marquee candidates skip an effectively locked node with its subtree, as they skip a hidden one. So a click on a locked node hits whatever is under it, a double-click cannot enter it or start path or text editing in it, and the overlap stack has no locked entry.

**V31-E2 gestures.** When the selection holds an effectively locked node, the select tool shows the selection outline but no resize handles, no edge resize and no rotate zone, and a press acts as it would with an empty selection: it resolves its own target from the hit test (which skips locked nodes), so a press on a selected unlocked node selects only that node and drags it, a press on a container background or on empty space inside the box selects or marquees as on empty canvas, and Alt-drag duplicates only what the press itself targets. So no canvas gesture moves, resizes, rotates or duplicates a locked node through the selection. A locked node inside a selected unlocked group still moves with the group (V31-Q4).

**V31-E2b keys and edit modes.** `enterScope` (Enter) on a single effectively locked node does nothing (consumed): it neither enters a locked container nor starts path or text editing. The host commands `enterPathEdit` and `enterTextEdit` are not refused (E4: commands never refuse a locked node); the canvas simply never reaches them for a locked node. The `nudge` action moves only the selected nodes that are not effectively locked (none left: a consumed no-op). Locking the node in path or text edit mode (by its layer-tree button or `setLayerState`) ends that mode first, as `exitScope` does, and keeps the selection. Inside text editing, key chords go to the text input as today, so `Mod+Shift+L` and `Mod+Shift+H` do nothing there.

**V31-E3 select all.** The `selectAll` action selects the scope's (or page's) children that are visible and not locked (Figma). An explicit `setSelection` still selects any node, locked or hidden.

**V31-E4 commands.** `setNodeProps` accepts `locked: boolean` on every node type, one undo step like `visible`. A new document command `setLayerState { ids, locked?, visible? }` sets either or both flags on every listed node of the active page in one transaction (one undo step; at least one flag; an unknown ID, or one on another page, fails `editor.unknown-node`; a change of no value records no step). Through either command `locked: false` removes the key, so the in-memory node equals its own parse (S1). No other command refuses a locked node: property edits, reorder, delete, group and the layer tree work on it (Figma). Frame adoption (drawing into a frame, `dropAdoption` on move or duplicate) does not adopt into an effectively locked frame (Figma).

**V31-E5 actions.** Two built-in actions, both on the selection through one `setLayerState`, nothing with an empty selection (consumed):

| Action | Default chord | Effect |
| --- | --- | --- |
| `toggleLocked` | `Mod+Shift+L` | If any selected node is unlocked, lock all; else unlock all |
| `toggleVisible` | `Mod+Shift+H` | If any selected node is visible, hide all; else show all |

Hiding or locking keeps the selection (Figma keeps it, and the layer tree still shows it).

## 4. UI (`ui`)

**V31-U1 layer tree.** Each row gets a lock button (`layer-lock-<id>`, `aria-pressed` when locked, accessible label `lock` / `unlock`) beside the existing visibility button (`layer-visible-<id>`, now an eye icon with the same `hide` / `show` accessible text). On a row that is locked or hidden the matching button is always shown; otherwise both are revealed on row hover or focus within the row by opacity only (they stay in the layout, focusable and clickable, never `display: none`). `LayerRow` gains `locked` and `inherited` (`'locked' | 'hidden' | null`: the row is inside a locked or hidden ancestor); a hidden row or one with an inherited state is drawn at half opacity, and its own buttons show its own state. Each button sends one `setNodeProps` for its row.

**V31-U2 context menu.** Beside the existing show / hide entry, a `Lock` / `Unlock` entry. Both entries run their E5 action (one `setLayerState`, one undo step; show / hide was one step per node) and show their chord label.

**V31-U3 property panel.** No change: the existing visibility checkbox stays; lock is not in the panel (Figma has none).

## 5. Acceptance criteria

| ID | Check | Method |
| --- | --- | --- |
| V31-A01 | A v8 node reads `locked` absent, `false` and `true` as S1 says and round-trips byte-identically; a non-boolean fails at its path; older versions migrate unlocked | `model` unit tests |
| V31-A02 | A click on a locked node, or a child of a locked group, selects what is under it; marquee skips it; double-click does not enter it | `editor-core` unit tests |
| V31-A03 | A locked selection made through `setSelection`, alone or mixed with unlocked nodes, shows no handles; presses inside its box, on a selected unlocked node, on a container background and Alt-drags never move or duplicate the locked node; nudges skip it; Enter does nothing; property edits apply | `editor-core` unit tests |
| V31-A04 | `setLayerState`, `toggleLocked`, `toggleVisible` and their chords follow E4 and the E5 table with one undo step each; `selectAll` skips locked and hidden; drawing into, moving onto or Alt-dragging onto a locked frame does not adopt; `locked: false` removes the key | `editor-core` unit tests |
| V31-A05 | Layer-tree lock and eye buttons, their always-shown state and the context-menu entry send the right command | `ui` unit tests |
| V31-A06 | In Chrome and Edge, `Mod+Shift+L` and `Mod+Shift+H` reach the editor (consumed, default prevented) and the M2-U8 keymap check passes with them | headed `test:m2-next-host` on the reference PC, or NOT RUN with reason |
| V31-A07 | In the studio editor, lock a shape from the layer tree, click it on the canvas and see the shape under it selected; hide one and see it vanish from the canvas and from an export | headed spec on the reference PC (serialized through the coordinator) or NOT RUN with reason |

## 6. Questions (adopted as recommended, 2026-11-12)

- **V31-Q1** Can a locked node be selected at all? (a) yes, from the layer tree and `setSelection`, not on the canvas (Figma), recommended; (b) never.
- **V31-Q2** Does `selectAll` take hidden nodes? (a) no, neither hidden nor locked (Figma), recommended; (b) keep hidden ones.
- **V31-Q3** Where is lock stored? (a) the document, persisted and undoable (Figma), recommended; (b) session-only editor state.
- **V31-Q4** Does a locked child of a selected unlocked group move with the group? (a) yes, lock only stops direct canvas selection (Figma), recommended; (b) no.

## 7. Record

- 2026-11-12 headed, reference PC (Windows 11 Pro 26200, GTX 1660 SUPER, Chrome 157.0.8103.51, Edge 157.0.4341.46) at `3a1df88`: `test:m2-next-host` 10/10 (V31-A06; the M2-A13 every-default-chord check now also presses the E41 boolean chords), `playwright.e41-studio.config.ts` `v31-lock-hide` + `e41-booleans` 4/4 (V31-A07). Container SwiftShader smoke of both: PASS.
- 2026-11-12: contract review r1 NOT READY (11 findings) and r2 READY WITH FOLLOW-UPS, applied. Implementation review r1 NOT READY (detach dropped the lock; an empty double-click test), r2 READY WITH FOLLOW-UPS, applied. A locked artboard's on-canvas name label selects nothing (E1); it can still be renamed by double-click. Rebased onto the v8 scaffold (73d6b68): the key is read only under the parser's `locked` schema dimension (`read` at v8), so a v7 input with `locked` fails as an unknown key.
