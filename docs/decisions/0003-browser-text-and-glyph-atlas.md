# ADR 0003: Browser-owned text layout and a browser-rasterized glyph atlas

Status: Accepted 2026-10-29, 추천안 자동 채택 under the standing rule of 2026-10-24; independent review (full tier) READY WITH FOLLOW-UPS 2026-10-29, applied. It records [M6 text plan](../plans/mvp-m6-text-plan.md) decisions M6-Q7 (a) and M6-Q2 (a), as plan section 14 records them. This is plan unit M6-ADR (section 8, full tier). The rendering item R-T is filed after it.

Outstanding user approval: plan section 5 route (a) asks for the user's approval of this route, and M6-Q2 and M6-Q7 are still open on the user's M6 decision card. If the user picks a different option on that card, this record is superseded or withdrawn, and R-T is not filed for route (a).

Date: 2026-10-29

## Context

The MVP requires text with styled runs, system fonts and host web fonts, wrapping, and Korean IME input ([requirements](../requirements.md#text)). The graphics architecture reserves separate font, shaping, layout, glyph-atlas and text-input services and says that committed text "will eventually render through GPU glyph atlases" ([text reservation](../graphics-engine-architecture.md#text-reservation)). It does not say where glyph bitmaps come from or who shapes.

Two facts constrain the choice:

- **No font bytes.** System fonts, Malgun Gothic among them, are not readable as files from a web page without the Local Font Access permission, which the MVP does not use (M6-Q4). Any route that parses outlines needs bytes, so it cannot cover system fonts or the Hangul fallback a Latin-only family needs.
- **The P3 path pipeline is not ready for glyphs.** Its disclosed defects are open: the V4 fringe cap of 128 boundary vertices, `work-limit` on 32-cubic paths (E14), A01 cracks and the A04 precision FAIL (plan section 5).

Editing already needs DOM layout: the caret, selection and IME composition must match what the browser lays out (plan sections 4 and 7). A second layout engine would have to agree with it exactly.

The [dependency policy](../graphics-engine-architecture.md#dependency-policy) needs an ADR for any runtime drawing engine. The chosen route adds no library, but it puts the browser's own text rasterizer inside the renderer's output, which the atlas reservation does not state. The plan therefore asks for this record (section 5, route (a)).

## Decision

**M6-Q2 (a): the browser owns shaping, line breaking and fallback.**

- Text is laid out by DOM layout in a hidden measurement element (plan section 4.1), behind a synchronous plain-data `TextLayoutPort` in `contracts` that `@vector-studio/text-dom` implements (M6-Q3 (a), plan section 4.2; the M6a contract fixes it).
- Per-character fallback is the browser's font matching over a CSS font list (M6-F2). Metrics are what browser layout reports (M6-F3).
- No font bytes are shipped and no shaping or font-parsing dependency is added. The one test font of M6-Q20 (a) is a test fixture asset, not a runtime dependency.

**M6-Q7 (a): glyphs are drawn from an atlas of browser-rasterized grapheme clusters.**

- Each grapheme cluster is rasterized with `OffscreenCanvas` 2D `fillText`, using the cluster's font list and `lang`, into an `r8` coverage atlas.
- The renderer draws each cluster as a textured quad at the `TextLayoutPort` cluster position, mapped by the node transform (M6-G1), and tints the coverage with the run color.
- Atlas entries are keyed by, or invalidated on, the layout `generation`, so a cluster rasterized with a fallback face is never reused after a web font loads (M6-F4).
- A `text` scene node kind and a text pipeline carry this. R-T owns their shape.

## Alternatives

Glyph route (plan section 5 table):

- **(b) Glyph outlines as paths through the P3 pipeline.** Needs font bytes and an outline parser (a new dependency). Expected, not measured: one path per text node exceeds the V4 fringe cap and draws region-only (aliased, 4x MSAA), which is poor at body sizes; 32-cubic paths still reach `work-limit`; A01 and A04 apply to every glyph; one path per glyph multiplies node counts against the 10,000-node M9 target. Rejected.
- **(c) SDF or MSDF atlas.** Sharp under zoom, but needs outlines as (b) does, plus a distance-field generator: the same font-byte and dependency problem. Rejected for the MVP. A later outline route above the raster cap stays possible (M6-Q8 (b)).
- **(d) DOM text layer over the canvas.** Needs nothing new, but breaks document paint order, clips, masks and isolated opacity. Rejected.

Shaping owner (M6-Q2):

- **(b) HarfBuzz WASM** (npm `harfbuzzjs`, roughly 1 to 2 MB of WASM uncompressed, unmeasured at a pinned version). A new runtime dependency that needs font bytes.
- **(c) `rustybuzz` and `ttf-parser` in the Rust kernel.** Size unmeasured, a kernel ABI change, and it also needs font bytes, so system fonts and Hangul fallback would need Local Font Access.
- **(d) Canvas `measureText` and an own UAX #14 line breaker.** No dependency, but layout would no longer match DOM editing.

## Consequences and costs

- **No dependency and no font bytes.** System fonts, host web fonts and Hangul fallback work as the browser draws them.
- **The browser is the layout and raster engine.** Breaking, shaping and fallback follow Chrome and Edge and can change with browser updates. Committed fixtures stay structural (line count, line of each cluster), never absolute pixels (M6-G4).
- **Main thread.** DOM layout needs a document, so the layout service is main-thread only (M6-L3). M6-S0 shows that a worker sees system fonts but not faces registered only in `document.fonts` (below; measured as advances, not pixels), so rasterization is on the main thread too, unless R-T registers the faces in the worker. Both cost main-thread time against M9's pointer priority.
- **Bitmaps, not outlines.** Entries are per size bucket and subpixel phase, so zoom re-rasterizes and atlas memory grows with sizes and families. Above a raster cap glyphs are scaled and blur, disclosed (M6-Q8 (a)).
- **Per-cluster rasterization.** Ligatures are off in layout and kerning is kept by positions (M6-Q9 (a)); fonts that rely on contextual alternates draw without them.
- **DOM and GPU share one layout.** Positions come from one layout result (M6-L1), so differences are expected to come mainly from rasterization and glyph placement within the cluster box. M6-S0 left one difference undiagnosed (the `mixed-sizes` subpixel offset of 1.0, which may be positional, such as baseline placement in a mixed-size line), so agreement is measured against the M6c tolerance (M6-G2), not assumed.
- **Grayscale coverage.** The `r8` atlas holds alpha coverage rasterized on a transparent surface, so GPU text is grayscale-antialiased and may look lighter than ClearType-rendered DOM text.
- **Machine-dependent auto-size frames.** They follow the fonts of the machine that last edited the node (plan section 4.3).
- **Color glyphs.** Color emoji fidelity is proposed out of MVP scope (plan section 1); an `r8` atlas cannot hold colour, so R-T decides the colour-glyph rule (an RGBA atlas or a disclosed limit).

## Evidence from M6-S0

The [main-PC record of 2026-10-29](../evidence/m6-s0/main-pc-2026-10-29.md) (Chrome 156 and Edge 156, hardware GPU, commit `d15f59a`) bears on the assumptions of this decision. The raw reports and the Korean IME traces are still owed there.

| Assumption | Result | Effect on this decision |
| --- | --- | --- |
| Layout does not depend on DPR (plan section 4.1) | Holds under `deviceScaleFactor` emulation on the main PC only: DPR 1.25, 1.5 and 2 give line breaks and positions identical to DPR 1 on 1,000 nodes, maximum difference 0 px, in both browsers. The container failure (SwiftShader) does not reproduce. Browser zoom and moving to another monitor NOT RUN | Supports layout at page units; the M6a contract settles M6-Q3. Until the manual checks or the M6a headed DPR spec (plan section 9) have run, a DPR change still bumps the layout generation (section 4.1, M6-F4) |
| DOM layout and canvas pick the same fallback (M6-F2) | Holds on the main thread: rules 1 to 3 of the M6-S0 README hold in both browsers (Malgun Gothic for Hangul and Han in an Arial run; whole-run widths within 1/64 px) | Rasterizing a cluster with its font list and `lang` gives the face the DOM used |
| A worker sees the same faces | Holds for system fonts: the worker matches the DOM within 1/64 px on all 21 non-alias rows. Does not hold for a face registered only in `document.fonts` (`aliasProbe` equals the monospace reference; `self.fonts` is empty). Measured as advances (`measureText`), not as rasterized pixels | Rasterize on the main thread, or R-T registers the same faces in the worker before using it |
| Canvas ink matches DOM ink within 0.5 px offset and 1 px size (M6-G2 proposal) | Open: exceeded. On integer bounds `small-9` reaches 3/4 px and `hangul`, `hangul-in-latin`, `han-in-latin` and `mixed-sizes` reach a size difference of 2 (integer boxes at DPR 1 cannot decide 0.5 px); `mixed-sizes` has a subpixel offset of 1.0 px at both DPRs, cause undiagnosed; other fixtures stay within 0.5/1 on subpixel bounds. The method draws canvas `fillText` over opaque white at the exact fractional origin (possibly LCD antialiasing, no quantization), so it bounds canvas against DOM, not the `r8` atlas (grayscale, subpixel phases) against DOM | The route is not rejected, but the tolerance is for the M6c contract to set from the subpixel data, the committed test font and a measurement of real atlas output |

Layout throughput was about 0.4 ms per node (about 6.5 µs per cluster) on 1,000 nodes. The plan states no budget for it, so it is an observation, not a claim.

## What R-T must honor

From plan section 5:

- plain-data glyph runs: cluster text, font list, `lang`, node-local positions, color and layout generation;
- no DOM object in `contracts`;
- atlas entries keyed by, or invalidated on, the layout generation (M6-F4);
- document paint order, the node transform, and clips, masks and isolated opacity as for any leaf;
- P1 D2 compositing;
- rasterization where the faces are registered (M6-F2): the main thread, unless R-T registers the faces in the worker.

## Open for R-T and M6c

- **R-T:** the `text` scene node shape and atlas keys; size buckets and subpixel phases; the raster cap and its scaled-bitmap behavior (M6-Q8 (a)); eviction and atlas memory bounds; rebuild after device loss (the atlas is a reconstructible cache); the colour-glyph rule; whether worker rasterization is used, with face registration.
- **R-T and M6c:** diagnose the `mixed-sizes` subpixel offset of 1.0 (positional or raster), and measure the real atlas output against DOM, since M6-S0 measured canvas `fillText` over white, not the `r8` atlas.
- **M6c:** the DOM and GPU agreement tolerance (M6-G2), set from the M6-S0 subpixel figures, the atlas measurement and the committed test font (M6-Q20 (a)); the agreement spec, including the font-load case.
- **M6-S0:** the Korean IME traces and the raw reports are still owed; they do not bear on this decision. The manual DPR checks, or their hand-off to the M6a headed DPR spec, are owed too.

## Migration impact

No code changes with this record, and no document schema change: lines, positions, fonts used and atlas keys are derived, never stored (M6-T6). M6a adds the text node, the layout port and `@vector-studio/text-dom`; R-T adds the scene node kind, atlas and pipeline. Existing scenes draw as before.

## Affected source-of-truth documents

- **M6 text plan.** Owns M6-Q2 and M6-Q7 and records their adoption (section 14). This record is linked from its sections 14 and 15.
- **Graphics architecture, [text reservation](../graphics-engine-architecture.md#text-reservation).** A dated pointer to this record is added; the paragraph's text is otherwise unchanged, since "GPU glyph atlases" covers the route. The M6b contract still amends the paragraph's DOM-overlay sentence (M6-Q14).
- **Graphics architecture, [dependency policy](../graphics-engine-architecture.md#dependency-policy).** Unchanged: no dependency is added.
- **`ARCHITECTURE.md`.** Unchanged here; M6a adds `@vector-studio/text-dom` and its boundary entry.
