# E24 contract: dash pattern and phase for path strokes

Status: DRAFT 2026-10-29, Full tier (shared surface: `packages/contracts` `PathStroke`, scene validation, the path stroke request path). Rendering-track item [E24](d9-rendering-track.md#status-index), MVP rendering need R-D ([MVP plan, section 5](mvp-editor-plan.md#5-rendering-track-needs)), needed by MVP M4. It resolves the P3 design gate "dash units/phase" ([graphics architecture](../graphics-engine-architecture.md#design-gates-before-later-implementation)) that the [B2 stroke proposal, section 3.5](p3-b2-stroke-proposal.md#35-dashes) moved to the appearance plan.

Owners: this file owns E24's execution order, acceptance criteria, fixtures and evidence. [requirements.md](../requirements.md#initial-appearance-model) owns "dash pattern". The [B2 stroke contract](p3-b2-stroke-contract.md) owns the stroke region of a path (ST-S1 to ST-S11, ST-P7). This contract only decides which path is stroked. [mvp-editor-plan.md](mvp-editor-plan.md#m4-appearance) owns the editor half of M4, including the projection rule that a dashed shape projects as a path.

## 1. Scope

In scope:

- An optional dash field on `PathStroke` with a pattern and a phase in node-local units.
- Dash semantics: how the pattern runs along each subpath, how it meets closed seams and zero-length dashes, and how it interacts with caps, joins and the ST-U7 joint fill draw.
- The realization: dash expansion in `renderer-core` ahead of the existing stroke port. The kernel and the port are unchanged.
- A dash-count work limit and its failure.
- Headed fixtures whose probes are the references the MVP M4 exit gate names ("headed pixel probes for … dash … against references written in the rendering items' contracts").

Out of scope, stated so the exit does not imply them:

- Dashes on P1 primitive strokes. `SceneStroke` is unchanged, and a dashed rectangle, ellipse or line projects as a path (MVP plan, projection rule).
- Non-scaling dashes, dash patterns in screen units, and per-dash caps different from the stroke's cap.
- Dash patterns adjusted to fit a path's length (Figma's "adjust dashes to fit"), and dash animation.
- Hit testing of dashed strokes (editor milestones).
- The document model, commands and panel controls of M4 (visualization track).

## 2. Scene contract (shared surface)

```ts
/** Node-local lengths along the stroked path, the units of `PathStroke.width`. */
export type SceneDash = Readonly<{ pattern: readonly number[]; phase: number }>;
export const SCENE_MAX_DASH_ENTRIES = 16;

PathStroke = {
  color: ScenePaint;
  width: number;
  cap: SceneStrokeCap;
  join: SceneStrokeJoin;
  miterLimit: number;
  /** Absent or null: a solid stroke. */
  dash?: SceneDash | null;
};
```

- **E24-S1 values.** `dash` is absent, `null` or exactly `{ pattern, phase }`.
  - `pattern` is an array of 1 to 16 entries. Each entry is finite and ≥ 0, and at least one is > 0.
  - `phase` is finite and may be any value, including negative values and values beyond one period.
  - A violation is `invalid-value` in `copyNode`. Seventeen or more entries are also `invalid-value`, because this is a value limit and not a structural one.
  - An absent field and `dash: null` are equal for replay equality, so a producer that omits the field and one that writes `null` describe the same scene.
- **E24-S2 support gate.**
  - The mirror gains the option `dashes: 'unsupported' | 'supported'`, defaulting to `'unsupported'`. Under `'unsupported'`, a change set with a non-null dash on a drawn stroke is rejected with `unsupported-feature`, so a consumer that cannot dash never draws a dashed stroke solid. This is the ST-S11 rule "no dash intent is silently ignored".
  - `PrimitiveRendererService` sets `'supported'` whenever it supports path strokes (U2). Strokes of width 0, and strokes on mask sources (P4-S2), are not drawn, so their dash is validated but never gated.
- **E24-S3 compatibility.** Every existing producer stays valid, because the field is optional. Consumers that build stroke requests or oracles read `dash` and treat absent as `null`. U1 lists them and makes sure none drops a non-null dash: `path-mesh-pipeline.ts` (paint keys and requests), `scene-validation.ts` (copy and replay equality), and the test stroke oracles. A scene with no dash renders exactly as before (E24-A06).
- **E24-S4 bounds.** The culling bounds of a dashed stroke are the B2 stroke bounds of the undashed stroke (`getPathLocalStrokeBounds`, section 9.7 with ST-A0), unchanged. Every dash piece lies within `r` of a point on the path for butt and round ends and joins, within `r · √2 < 1.5 · r` for a square end, and within the miter bound at a miter join. The path lies inside the hull of its control points.

## 3. Dash semantics

Notation: `r = width / 2`. Lengths are node-local, the space of `points` and `width`, so a dash scales with its node, including non-uniform scales, as the stroke width does (B2, local-space strokes).

- **E24-K1 pattern.** If `pattern` has an odd number of entries, it is repeated once to make an even list (SVG `stroke-dasharray`). Entries alternate between on (a dash) and off (a gap), starting with on. The period `P` is the sum of the entries, and P > 0 by E24-S1.
- **E24-K2 arc length.** Each subpath is dashed on its own, and the pattern restarts at every MOVE.
  - The arc length `s` runs along the subpath's drawing segments after ST-S1. Zero-length segments are removed. For a subpath that ends in CLOSE, the closing line is included when its endpoints differ.
  - Lines are exact in binary64 up to rounding. Cubics use the integral of `|B′(t)|`.
  - Pattern position at arc length s: `u(s) = (s + phase) mod P`, taken in `[0, P)`. A point is on when `u` falls in an on interval `[a_k, a_k + d_k)`.
- **E24-K3 dashes.** The dashes of a subpath of length L are the maximal intervals `[s0, s1]` within `[0, L]` where the pattern is on. Each dash becomes one open subpath that follows the original segments from `s0` to `s1`, with cubics split at their parameters by de Casteljau.
  - Corners strictly inside a dash keep the stroke's join.
  - Every dash end gets the stroke's cap, including dash ends cut off by the end of an open subpath. At the open ends of the path the result is the same as the solid stroke's cap.
- **E24-K4 closed seams (E24-Q2).** In a closed subpath, if the pattern is on at both `s = L` and `s = 0`, the last and first dashes are emitted as one open subpath. It runs from the last dash's start, through the closing point, to the first dash's end. The seam vertex therefore gets the stroke's join, with no caps there, as the solid closed stroke has. If the whole closed subpath is on, it is emitted closed and unchanged.
- **E24-K5 zero-length dashes (E24-Q3).**
  - An on entry of 0 produces a dash with `s0 = s1`, emitted as a zero-length open subpath at that point. ST-S10 and ST-P7 then apply: butt draws nothing, round draws a disk of radius r, and square draws a local-axis-aligned square of side `w`.
  - The orientation of the square is a disclosed departure from SVG, which aligns it with the path direction.
  - A subpath whose length L is 0 is passed through unchanged when `u(0)` is on, and dropped otherwise.
- **E24-K6 composition.** The dashed region replaces the stroke region in every existing rule, and nothing else changes.
  - The stroke region is the union of the dash pieces from the exact arrangement (B2). Overlapping dashes, at self-intersections or where caps meet across a short gap, are covered once.
  - The ST-U7 joint fill draw uses the dashed region as its stroke region. Fill shows in the gaps.
  - The stroke paint, solid or an E23 gradient, is evaluated as before. A gradient is in node-local space, so it does not depend on the dash.
- **E24-K7 precision and determinism.**
  - Dash boundaries on lines are exact up to binary64 rounding. On cubics, a boundary's arc length is within `2^-30 · L_seg + 2^-40` of the target, where `L_seg` is the segment's length.
  - Expansion uses only `+`, `−`, `×`, `÷` and `sqrt` in binary64, so equal inputs give bit-identical dashed paths in every engine.
  - The expansion does not depend on the camera, zoom, DPR or tolerance exponent. Dash ends therefore stay at the same document points at every zoom, and only the kernel's curve flattening varies, as for solid strokes.
- **E24-K8 work limit.** A stroke whose expansion has more than 4,096 dashes summed over all subpaths (E24-Q4) is not drawn. It reports `render.path-mesh-failure` with failure scope `renderer` and failure code `dash-limit`, under the existing notice rules (once per entry, as for `fringe-work-cap`). The node's fill is unaffected. A joint path draws its fill alone with the separate fill draw, the same as a path whose stroke mesh failed.
- **E24-K9 invalidation.** The dashed path is cached per node, keyed by the geometry and the dash, not by the camera.
  - A dash change (pattern or phase, or dashed to solid and back) makes one stroke port request for the node, 0 fill port calls and 0 primitive geometry builds.
  - A change of stroke colour or paint makes no port call, as today.
  - A camera pan or zoom runs no dash expansion. Zoom re-requests stroke meshes only under the existing tolerance-exponent rules, with the cached dashed path.

## 4. Realization (E24-Q1 (a))

- **Where.** A pure module `packages/renderer-core/src/stroke-dash.ts` maps `(verbs, points, dash)` to dashed `(verbs, points)`, or to a `dash-limit` failure. `path-mesh-pipeline.ts` calls it when it builds a stroke request.
  - The stroke paint key gains the dash, so a dash change is a different key, and memo entries and pending requests compare it.
  - The request's `verbs` and `points` are the dashed path. `width`, `cap`, `join`, `miterLimit` and `toleranceExponent` are unchanged.
  - With no dash, the request is built from the node's geometry exactly as today.
- **Kernel and port.** `StrokeMeshRequest`, `StrokeMeshPort`, the WASM ABI, the kernel and its census and identity tests are unchanged. A dashed request is an ordinary multi-subpath stroke request, and B2 already defines it, including zero-length open subpaths (ST-S10).
- **Arc length on cubics.** Adaptive 8-point Gauss–Legendre quadrature of `|B′(t)|`. An interval is split while its estimate and the sum of its halves differ by more than `2^-34 · L_seg`, to a depth of 24. A boundary parameter is found by safeguarded Newton iteration on the accumulated length, falling back to bisection, to the K7 bound. Then de Casteljau splits the cubic at the parameter. U2 pins the quadrature nodes as binary64 literals.
- **Cache.** The dashed path is stored with the node's mesh entry and counted against the existing path-mesh byte budget, at 1 byte per verb plus 16 bytes per point. It is released with the entry.
- **GPU.** No shader, pipeline, bind group or resource change. Dashed strokes draw with today's mesh fill, joint and clip pipelines.
- **Fringe.** A dashed stroke usually has more boundary vertices than its solid stroke. A mesh above the V4 fringe cap (`fringeBoundaryVertexCap`, 128) is drawn region-only with `fringe-work-cap`, as today, and 4x MSAA still antialiases it (section 8).
- **Architecture amendment (with this contract).** The design-gate row for P3 "dash units/phase" is marked resolved by E24: node-local units, phase in the same units, the pattern restarting per subpath, seam joining (E24-K4), and expansion ahead of the stroke port.

Alternatives:

- (b) Dash in the Rust kernel, with `StrokeMeshRequest` gaining `dash` fields. It keeps arc length next to the exact stroker, but it changes the port, the ABI, the WASM identity and census, and both native and WASM builds, for no gain in precision. The kernel would still need the same K7 bound.
- (c) Dash in the fragment shader, by discarding fragments by arc length. This needs a per-vertex arc-length attribute and breaks at joins and caps, because cap geometry is not part of the dash. It also changes the base pipelines and their identity.

## 5. Diagnostics

- `render.path-mesh-failure` with failure code `dash-limit` and failure scope `renderer`: the context is the existing one (`nodeId`, `failureScope`, `failureCode`, `toleranceExponent`, `paint: 'stroke'`), and it is not a new code.
- A dash under `dashes: 'unsupported'`, and 17 or more pattern entries: no diagnostic, because the change set is rejected.

## 6. Acceptance criteria and fixtures

Evidence goes to `docs/evidence/e24/`. Headed runs use the reference PC (DESKTOP-DKVUSAV, Chrome and Edge, DPR 1 and 2), as for E23.

The oracle dashes each fixture independently of `stroke-dash.ts`. It flattens to a polyline with segments no longer than 2^-12 local units and measures length along it. It then classifies probes by distance to the dash pieces with the stroke's caps and joins.

Probe classes:

- An **interior** probe is at least 2 physical px from every edge of the dashed region and of any fill.
- An **edge** probe is on a coverage ramp of an analytic straight dash end, which is a butt end on a line.

**Fixtures** (`D1` to `D9`, one headed page, each at DPR 1 and 2). They are the M4 exit-gate references. Placement not pinned below is chosen by U3 and recorded with its evidence.

| ID | Scene | What it pins |
| --- | --- | --- |
| D1 | Open path `M 0 0 L 300 0`, stroke width 10, `butt`, `miter`, solid blue, dash `{ pattern: [30, 20], phase: 0 }` | E24-K1, K2 on a line, butt dash ends |
| D2 | D1's line, `round` cap, dash `[0, 20]` (dots). A second copy rotated 30°, `square` cap, dash `[0, 20]` | E24-K5: round dots, and axis-aligned squares (the disclosed departure) |
| D3 | Closed path `M 0 0 L 200 0 L 200 120 L 0 120 Z`, width 8, `miter` join, `butt` cap, dash `[40, 20]`, phase 25 (on at both `s = 0` and `s = 640`) | E24-K4: one dash through the seam corner with a miter join, no caps there |
| D4 | Open cubic `M 0 0 C 100 -120 200 120 300 0`, width 6, `round` join, `butt` cap, dash `[24, 12, 6]` (odd, so doubled), phase −10 | Cubic arc length, odd pattern, negative phase |
| D5 | D1 in a node with transform scale (2, 0.5) then rotation 30° | Local units under a non-uniform node scale |
| D6 | D4's cubic closed with `L 300 80 L 0 80 Z`, solid fill yellow `(1,1,0,1)`, dashed stroke cyan `(0,1,1,1)`, node opacity 0.5 | E24-K6 with the ST-U7 joint draw: stroke over fill on dashes, fill alone in gaps |
| D7 | D4 at camera zoom 0.25, 1 and 8 | E24-K7: dash ends at the same document points at every zoom |
| D8 | `M 0 0 L 10000 0`, width 2, dash `[1, 1]` (5,000 dashes), with a solid fill on a separate closed subpath | E24-K8: stroke absent, `dash-limit` reported once, fill drawn |
| D9 | D1 with E23 G1's gradient on the stroke | E24-K6 with a gradient stroke paint |

| ID | Criterion | Evidence |
| --- | --- | --- |
| E24-A01 | Validation: E24-S1 and S2 accept and reject as written. That covers `invalid-value` for each malformed field: negative, non-finite or all-zero entries, 0 or 17 entries, a non-finite phase, and extra or missing fields. It covers `unsupported-feature` for a dash under `'unsupported'` on a drawn stroke, and no gate for width 0 or a mask source. Absent and `null` are replay-equal | Unit tests in `pnpm check` |
| E24-A02 | Dash geometry: `stroke-dash.ts` output for every K rule. Lines are exact. Cubic boundaries meet the K7 bound against a reference quadrature at `2^-50`. Also covered: odd doubling, phase modulo (negative, beyond a period), seam joining and its absence, a fully on closed subpath, zero-length dashes, zero-length subpaths, and multiple subpaths restarting the pattern. Equal inputs give bit-identical output, and the output does not depend on zoom | Unit tests |
| E24-A03 | Work limit: 4,096 dashes are drawn and 4,097 report `dash-limit` once and draw no stroke, with fill unaffected and joint paths falling back to the separate fill draw | Unit tests (scripted stroke port) |
| E24-A04 | Invalidation: E24-K9, measured by port-call, geometry-build and dash-expansion counters for dash edits, dashed↔solid, a colour edit, a camera pan and a zoom | Unit and GPU counters |
| E24-A05 | Interior probes of D1 to D9 equal the oracle within 2/255 per channel, and edge probes within 4/255. D7's dash-end positions agree across zooms within 0.5 physical px at the coarsest zoom | Headed GPU spec, readback |
| E24-A06 | Identity: with no dash, stroke requests are byte-equal to `main` at U1's merge base (unit: verbs, points and fields per request across the existing stroke fixtures). The kernel, port and WASM identity tests are unchanged, as are the E10-A1 golden log and shader hashes. Solid-only frame captures (E23's `a08-solid-capture.mjs` method) are byte-identical between that commit and U2 on the reference PC, and the existing `pnpm test:gpu` suite passes. If the capture comparison cannot run, the remaining parts stand and the gap is disclosed | Unit tests, headed full `pnpm test:gpu` |

## 7. Units

| Unit | Track | Scope | Gate |
| --- | --- | --- | --- |
| U1 | Rendering | `SceneDash`, `SCENE_MAX_DASH_ENTRIES`, `PathStroke.dash`, validation and replay equality, mirror option `dashes` (default `'unsupported'`), consumers checked | E24-A01; CI |
| U2 | Rendering | `stroke-dash.ts`, the paint key and request path, the dash cache, the `dash-limit` failure, counters, and the service setting `dashes: 'supported'` | E24-A02, A03, A04 unit part, A06 unit part |
| U3 | Visualization | Headed playground page for D1 to D9, GPU spec and independent oracle. SwiftShader run in the container | Headed run on the reference PC (A04 GPU part, A05, A06) |
| U4 | Rendering | Evidence record `docs/evidence/e24/` with the index of A01 to A06 | Item done; M4 may consume E24 |

Order: U1, U2, U3, U4. The WIP limit per track applies.

## 8. Risks

- **Fringe cap.** Dot patterns and many-dash paths exceed the V4 fringe cap of 128 boundary vertices. They are then drawn region-only and antialiased by 4x MSAA alone, as G3's stroke in E23 is. U3 records which fixtures hit it, and edge probes stay on uncapped dashes. Raising the cap is outside E24, which leaves the fringe rules unchanged.
- **Kernel work.** Each dash is a subpath for the exact stroker, so dense patterns raise kernel work, and the E2 work limits (`work-limit` failures) can trigger before `dash-limit`. Both fail closed with a diagnostic. A08-corpus-style measurement of dashed paths is not part of E24.
- **Arc-length cost.** The expansion cost is linear in segments and dashes, and quadrature per cubic is bounded by the depth limit. It runs once per geometry or dash change, not per frame.

## 9. Questions (each with a recommended option)

- **E24-Q1 realization.**
  - (a) Expand dashes in `renderer-core` ahead of the unchanged stroke port.
  - (b) Expand in the Rust kernel, with new port fields.
  - (c) Discard by arc length in the shader.
  - Recommended (a). It changes no ABI, WASM identity, kernel or shader. B2 already defines the stroke of the dashed path exactly, and the dash rule stays testable in TypeScript beside its oracle.
- **E24-Q2 closed seams.**
  - (a) Join the last and first dash through the seam when both are on (E24-K4).
  - (b) Keep them separate with caps at the seam (SVG 1.1 wording).
  - Recommended (a). A closed shape then has no visible start point. A dash that crosses a rectangle's start corner gets the corner's join, as Figma and most editors draw it. With caps, (b) would draw a doubled or notched corner at the start point only.
- **E24-Q3 zero-length dashes.**
  - (a) Use ST-S10 and ST-P7 as approved: round dots, butt nothing, square dots aligned to the local axes.
  - (b) Orient square dots along the path, which needs a kernel and port change.
  - Recommended (a). Round and butt match SVG, and the square departure is disclosed and pinned by D2. (b) would reopen the approved B2 rows and the port.
- **E24-Q4 work limit.**
  - (a) Use 4,096 dashes per stroke and fail closed with `dash-limit`.
  - (b) No limit, leaving it to the kernel work limits.
  - (c) Fall back to a solid stroke above the limit.
  - Recommended (a). It bounds the request size before the kernel sees it, and it reports the cause by name. (c) would draw a solid stroke the document did not ask for, against ST-S11.
- **E24-Q5 field shape.**
  - (a) An optional `dash?: { pattern, phase } | null` on `PathStroke`.
  - (b) Required `dashPattern` and `dashPhase` fields.
  - Recommended (a). Every existing producer and fixture stays valid without edits, and one field carries the whole intent.

## 10. Decisions

(none yet)
