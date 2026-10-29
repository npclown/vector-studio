# E24 contract: dash pattern and phase for path strokes

Status: APPROVED 2026-10-29 (recommended options auto-adopted, section 10), Full tier. It touches shared surface: the `packages/contracts` type `PathStroke`, scene validation, the path stroke request path, and a new renderer failure code.

This is rendering-track item [E24](d9-rendering-track.md#status-index) and MVP rendering need R-D ([MVP plan, section 5](mvp-editor-plan.md#5-rendering-track-needs)), needed by MVP M4. It resolves the P3 design gate "dash units/phase" ([graphics architecture](../graphics-engine-architecture.md#design-gates-before-later-implementation)), which the [B2 stroke proposal, section 3.5](p3-b2-stroke-proposal.md#35-dashes) moved to the appearance plan.

Owners:

- This file owns E24's execution order, acceptance criteria, fixtures and evidence.
- [requirements.md](../requirements.md#initial-appearance-model) owns "dash pattern".
- The [B2 stroke contract](p3-b2-stroke-contract.md) owns the stroke region of a path (ST-S1 to ST-S10, ST-P7). This contract decides only which path is stroked.
- The [E11-U4 addendum](d9-e11-u4-failure-behavior-addendum.md) owns the failure outcomes.
- [mvp-editor-plan.md](mvp-editor-plan.md#m4-appearance) owns the editor half of M4, including the projection rule that a dashed shape projects as a path.
- Section 4 lists the amendments this contract makes to frozen texts.

## 1. Scope

In scope:

- An optional dash field on `PathStroke`, with a pattern and a phase in node-local units.
- Dash semantics: how the pattern runs along each subpath, how it meets closed seams, and how zero-length dashes behave. Also how dashes interact with caps, joins and the ST-U7 joint fill draw.
- The realization: dash expansion in `renderer-core` ahead of the existing stroke port. The kernel and the port are unchanged.
- A dash-count work limit and its failure.
- Headed fixtures whose probes are the references the MVP M4 exit gate names ("headed pixel probes for … dash … against references written in the rendering items' contracts").

Out of scope, stated so the exit does not imply them:

- Dashes on P1 primitive strokes. `SceneStroke` is unchanged, and a dashed rectangle, ellipse or line projects as a path (MVP plan, projection rule).
- Non-scaling dashes, dash patterns in screen units, and per-dash caps that differ from the stroke's cap.
- Dash patterns adjusted to fit a path's length (Figma's "adjust dashes to fit"), and dash animation.
- Raising the V4 fringe cap (E24-Q6), and hit testing of dashed strokes (editor milestones).
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

// renderer-core, beside paints? (E23) and clips? (P4):
PathSupport = { …; dashes?: 'unsupported' | 'supported' }; // absent: 'unsupported'
```

- **E24-S1 values.** `dash` is absent, `null`, or exactly `{ pattern, phase }`. Any of the following is `invalid-value` in `copyNode`:
  - `pattern` is not an array, or has 0 entries.
  - An entry is not finite and ≥ 0.
  - No entry is > 0.
  - The period `P`, which is the binary64 sum of the entries taken left to right, is not finite. For an odd pattern the sum runs over the doubled list of E24-K1 (amended 2026-10-29 by the U2 review: `[1.5e308]` has a finite sum but an infinite doubled period).
  - `phase` is not finite. Any other phase is allowed, including a negative phase or one beyond a period.

  More than 16 entries is `unsupported-feature`, because it is a structural limit. As with E23-S2's stop count, every entry is validated first, and the count travels as the node's unsupported flag, so the graph checks report first.
- **E24-S2 copy and equality.**
  - `copyPathStroke` accepts the five B2 fields plus an optional `dash`. Any other key is still `invalid-value`.
  - The copy keeps the producer's form: an absent field stays absent, and `null` stays `null`. Snapshots of existing producers are therefore unchanged.
  - Replay equality (`nullablePathStrokeEquals`) treats absent and `null` as equal. Two dashes are equal when their patterns have equal length and are equal entry by entry, and their phases are equal.
- **E24-S3 support gate.** Under `dashes` absent or `'unsupported'`, a change set with a node that has a non-null dash on a stroke of width > 0 is rejected with `unsupported-feature`. The flag is per node, in `copyNode`, like the existing `pathStrokes` gate, with no mask-source exemption. This keeps ST-S11's rule that no dash intent is silently ignored, for every consumer that cannot dash. `PrimitiveRendererService` sets `dashes: 'supported'` whenever it supports path strokes (U2).
- **E24-S4 compatibility.** Every existing producer stays valid, because the field is optional. U1 checks the consumers that build stroke requests or oracles: `path-mesh-pipeline.ts` (paint keys, pending-request and memo keys, requests), `scene-validation.ts`, and the test stroke oracles. None of them may drop a non-null dash. A scene with no dash renders exactly as before (E24-A06).
- **E24-S5 bounds.** The culling bounds of a dashed stroke are the B2 stroke bounds of the undashed stroke (`getPathLocalStrokeBounds`, section 9.7 with ST-A0), unchanged. The dashed path's points are the source points plus split points, and every split point is a convex combination of a cubic's control points, so it lies inside their hull. Dashing adds no joins and keeps the cap, so the expansion factor `k` still covers every piece, up to rounding.

## 3. Dash semantics

Notation: `r = width / 2`. Lengths are node-local, in the space of `points` and `width`. A dash therefore scales with its node, including non-uniform scales, as the stroke width does (B2, local-space strokes).

- **E24-K1 pattern.**
  - A pattern with an odd number of entries is repeated once to make an even list (SVG `stroke-dasharray`).
  - Entries alternate on (a dash) and off (a gap), starting with on. On-entry k covers the closed interval `[a_k, a_k + d_k]` of pattern positions, where `a_k` is the sum of the preceding entries and `d_k` may be 0.
  - The period `P` is the sum of the entries, as in E24-S1.
  - The phase is reduced once, in binary64, with the exact remainder: `φ = phase % P` (IEEE fmod, as JavaScript's `%`). If `φ < 0`, P is added. If the sum rounds to `P`, φ is 0. So `0 ≤ φ < P`.
- **E24-K2 arc length.** Each subpath is dashed on its own, and the pattern restarts at every MOVE.
  - Arc length `s` runs along the subpath's drawing segments after ST-S1: zero-length segments are removed, and for a subpath that ends in CLOSE, the closing line is included when its endpoints differ.
  - Lines are measured exactly in binary64, up to rounding. Cubics are measured by the integral of `|B′(t)|`, as in section 4.
  - The pattern position at `s` is `u(s) = (s + φ) mod P`. A point is on when `u(s)` falls in some on-interval. Because the intervals are closed, the end point of each dash is on.
- **E24-K3 dashes.**
  - The dashes of a subpath of length `L` are the maximal connected sets of on points in `[0, L]`. Each one is an interval `[s0, s1]`, with `s0 = s1` allowed.
  - Each dash becomes one open subpath. It follows the original segments from `s0` to `s1`, with cubics split at their boundary parameters by de Casteljau.
  - Source vertices strictly inside a dash are copied exactly and keep the stroke's join.
  - Every dash end gets the stroke's cap. This includes ends cut off by the end of an open subpath, which gives the same cap the solid stroke has there.
- **E24-K4 closed seams (E24-Q2).** In a closed subpath, when one dash ends at `s1 = L` and another starts at `s0 = 0`, they are emitted as one open subpath. That subpath runs from the last dash's start, through the closing point, to the first dash's end. The seam vertex therefore gets the stroke's join, with no caps there, as the solid closed stroke has. When a single dash covers all of `[0, L]`, the subpath is emitted closed and unchanged.
- **E24-K5 zero-length dashes (E24-Q3).**
  - A dash with `s0 = s1` is emitted as a zero-length open subpath at that point. ST-S10 and ST-P7 then apply:
    - a butt cap draws nothing;
    - a round cap draws a disk of radius `r`;
    - a square cap draws a local-axis-aligned square of side `w`. This orientation is a disclosed departure from SVG, which aligns the square with the path direction.
  - A subpath whose length `L` is 0 is passed through unchanged when `u(0)` is on, and dropped otherwise.
- **E24-K6 composition.** The dashed region replaces the stroke region in every existing rule.
  - The stroke region is the union of the dash pieces under the exact arrangement (B2). Overlapping dashes are covered once. Dashes can overlap at self-intersections, or where caps meet across a short gap.
  - The ST-U7 joint fill draw uses the dashed region as its stroke region, so the fill shows in the gaps.
  - The stroke paint, solid or an E23 gradient, is evaluated in node-local space, independent of the dash.
  - **Split tangents.** A cubic split at a dash end gets rounded control points. The kernel then applies ST-S2 and ST-S6 to the dashed path. Where a split piece meets a source vertex, its tangent can differ from the source cubic's tangent in the last bits. An exact reversal there can become a near-reversal, judged by the miter rules. The same applies to a cap's direction at a dash end close to a cusp. These are B2's rules applied to the path actually stroked, and are not a separate E24 rule. A08-style measurement of such cases is not part of E24 (section 8).
- **E24-K7 precision and determinism.**
  - The expansion follows the method pinned in section 4. It uses only `+`, `−`, `×`, `÷`, `%`, `sqrt` and `floor` in binary64, in a fixed order, so equal inputs give bit-identical dashed paths in every engine.
  - The expansion does not depend on the camera, zoom, DPR or tolerance exponent. Dash ends therefore stay at the same document points at every zoom; only the kernel's curve flattening varies, as for solid strokes.
  - The accuracy target is checked by E24-A02 against a double-double reference: dash boundaries on lines within `2^-40 · L` of exact, and on cubics within `2^-24 · L_seg + 2^-40 · L`, where `L_seg` is the segment's length.
- **E24-K8 work limit (E24-Q4).** A stroke whose expansion has more than 4,096 dashes, summed over all subpaths, fails with the new renderer-scope code `dash-limit`. The count is that of exact arithmetic: gaps too short for binary64 to separate still count (U2 review, 2026-10-29).
  - The failure does not depend on tolerance, so it is a state failure of the stroke paint. The expansion fails before any request is made, so the stroke port is not called.
  - It produces one notice on the `(node, 'stroke', 'dash-limit')` state transition, with `toleranceExponent: null` and `paint: 'stroke'`, under the V3 §d class table, with the §h outcome.
  - The outcome is E11-U4 **O1**: the whole path, fill and stroke, is not drawn, and every other node draws in order. This matches every other stroke failure. Hiding the fill when the stroke fails is B2 §9.6's chosen reading.
- **E24-K9 invalidation.** The dashed path is cached once per node, keyed by the node's geometry revision and the dash (section 4).
  - A dash change (pattern, phase, or dashed to solid and back) makes stroke port requests for the node, 0 fill port calls and 0 primitive geometry builds.
  - A change of stroke colour or paint makes no port call, as today.
  - A camera pan or zoom runs no dash expansion. Zoom re-requests stroke meshes only under the existing tolerance-exponent rules, using the cached dashed path. This holds also for a pending or resumed request, or for a tolerance variant rebuilt after eviction.

## 4. Realization (E24-Q1 (a))

- **Where.** A pure module, `packages/renderer-core/src/stroke-dash.ts`, maps `(verbs, points, dash)` either to a dashed `(verbs, points)` or to a `dash-limit` failure. `path-mesh-pipeline.ts` calls it when it builds a stroke request.
  - The stroke paint key gains the dash, which changes `paintKeysEqual`, `memoKey` and `sameKey`, so a dash change is a different key.
  - The request's `verbs` and `points` are the dashed path. `width`, `cap`, `join`, `miterLimit` and `toleranceExponent` are unchanged.
  - Without a dash, the request is built from the node's geometry exactly as today.
- **Dash cache.** It is one map per pipeline, from node to `{ revision, dash, result }`, separate from mesh entries and tolerance variants.
  - It is filled when a stroke request or state is first needed for that revision and dash, and replaced when either changes.
  - Its entry is removed when the node is removed or loses its dash.
  - Its bytes (1 per verb, 16 per point) are reported in `pathMeshMemoryBytes` and count against the existing path-mesh byte budget. Budget eviction never evicts it: an entry lives exactly as long as its node keeps that revision and dash, so E24-K9 does not depend on eviction.
- **Arc length on cubics.** The method is pinned:
  - Cubics are integrated with 8-point Gauss–Legendre quadrature of `|B′(t)|`, with the nodes and weights as binary64 literals in U2.
  - Integration is adaptive bisection in `t`. A cell is split while `|I(cell) − (I(left) + I(right))| > 2^-30 · I(cell)`. The depth limit is 24; at that depth the cell's estimate is accepted. Cells are summed left to right.
  - A boundary parameter is found inside its cell by safeguarded Newton iteration on the accumulated length, falling back to bisection, for at most 64 steps, or until the step in `t` is below `2^-52`.
  - A cusp, where `B′ = 0` at an interior `t`, needs no special case: quadrature cells refine around the kink, and the depth limit bounds the work.
- **Kernel and port.** The following are unchanged: `StrokeMeshRequest`, `StrokeMeshPort`, the WASM ABI, the kernel, and its census and identity tests. A dashed request is an ordinary multi-subpath stroke request, which B2 already defines, including zero-length open subpaths (ST-S10).
- **GPU.** No shader, pipeline, bind group or resource changes. Dashed strokes draw with today's mesh fill, joint and clip pipelines.
- **Fringe (E24-Q6).** A dashed stroke has more boundary vertices than its solid stroke. Dot patterns and dashed curves often exceed the V4 fringe cap (`fringeBoundaryVertexCap`, 128). Such a stroke takes E11-U4 O2: it is drawn region-only, antialiased by 4x MSAA alone, with one `fringe-work-cap` notice per marked variant, as today. The cap applies to the whole stroke mesh.

**Amendments made with this contract** (each gets a dated pointer line when U1 merges):

- **B2 stroke contract:**
  - ST-S11 becomes "dashes per E24".
  - The section 5 rows for `PathStroke` gain the optional `dash`.
  - The §9.8 failure-code table gains `dash-limit` (renderer scope, `paint: 'stroke'`, state failure).
- **E11-U4 addendum:** section 3 lists `dash-limit` under O1. `docs/requirements.md` "Path rendering failures" names it with O1.
- **Graphics architecture:** the P3 design-gate row "dash units/phase" is marked resolved by E24. The resolution is:
  - node-local units, with the phase in the same units;
  - the pattern restarting at each subpath;
  - seam joining (E24-K4);
  - expansion ahead of the stroke port.
- **MVP plan R-D and rendering-track E24:** the note "Kernel stroke work (Rust)" is replaced by "dash expansion in renderer-core; kernel unchanged (E24-Q1 (a))".

Alternatives:

- (b) Dash in the Rust kernel, with `StrokeMeshRequest` gaining dash fields. This keeps arc length next to the exact stroker. But it changes the port, the ABI, the WASM identity and census, and both the native and WASM builds, for no gain in precision.
- (c) Dash in the fragment shader, discarding fragments by arc length. This needs a per-vertex arc-length attribute, and it breaks at joins and caps, because cap geometry is not part of the dash. It also changes the base pipelines and their identity.

## 5. Diagnostics

- `render.path-mesh-failure` with failure code `dash-limit` (new renderer-scope code under the existing diagnostic code). The context is the existing shape: `nodeId`, `failureScope: 'renderer'`, `failureCode`, `toleranceExponent: null` and `paint: 'stroke'`.
- No diagnostic for a dash under `dashes: 'unsupported'`, or for more than 16 pattern entries, because the change set is rejected.

## 6. Acceptance criteria and fixtures

Evidence goes to `docs/evidence/e24/`. Headed runs use the reference PC (DESKTOP-DKVUSAV, Chrome and Edge, DPR 1 and 2), as for E23.

The oracle dashes each fixture independently of `stroke-dash.ts`. It flattens each segment into pieces no longer than 2^-12 local units, measures arc length along them, and classifies probes by their distance to the dash pieces, with the stroke's caps and joins.

Probe classes:

- An **interior** probe is at least 2 physical px from every edge of the dashed region and of any fill.
- An **edge** probe lies on the coverage ramp of a straight butt dash end, in a stroke mesh under the fringe cap.

**Fixtures** `D1` to `D9` are on one headed page, and each runs at DPR 1 and 2. They are the M4 exit-gate references. U3 chooses any placement not pinned below and records it with its evidence.

| ID | Scene | What it pins |
| --- | --- | --- |
| D1 | Open path `M 0 0 L 300 0`, stroke width 10, `butt`, `miter`, solid blue, dash `{ pattern: [30, 20], phase: 0 }` | E24-K1 and K2 on a line, butt dash ends, edge probes |
| D2 | D1's line, `round` cap, dash `[0, 20]` (dots). A second copy rotated 30°, `square` cap, dash `[0, 20]` | E24-K5: round dots, and axis-aligned squares (the disclosed departure) |
| D3 | Closed path `M 0 0 L 200 0 L 200 120 L 0 120 Z`, width 8, `miter` join, `butt` cap, dash `[40, 20]`, phase 25. Here `L = 640` and `P = 60`; `u(0) = 25` and `u(640) = 5` are on, so one 20-unit dash crosses the corner at (0, 0) | E24-K4: one dash through the seam corner with a miter join, and no caps there |
| D4 | Open cubic `M 0 0 C 100 -120 200 120 300 0`, width 6, `round` join, `butt` cap, dash `[24, 12, 6]` (odd, so doubled), phase −10 | Cubic arc length, odd pattern, negative phase |
| D5 | D1 in a node with transform scale (2, 0.5), then rotation 30° | Local units under a non-uniform node scale |
| D6 | D4's cubic closed with `L 300 80 L 0 80 Z`, solid fill yellow `(1,1,0,1)`, dashed stroke cyan `(0,1,1,1)`, node opacity 0.5 | E24-K6 with the ST-U7 joint draw: stroke over fill on dashes, fill alone in gaps |
| D7 | D4 at camera zoom 0.25, 1 and 8 | E24-K7: dash ends at the same document points at every zoom |
| D8 | Node A: `M 0 0 L 10000 0` with width 2, dash `[1, 1]` (5,000 dashes), and a solid fill on a separate closed subpath. Node B: D1, drawn after A | E24-K8: A is not drawn (O1) and reports `dash-limit` once; B draws |
| D9 | D1 with E23 G1's gradient on the stroke | E24-K6 with a gradient stroke paint |

| ID | Criterion | Evidence |
| --- | --- | --- |
| E24-A01 | Validation: E24-S1 to S3 accept and reject as written. `invalid-value` for each malformed field: 0 entries, an entry that is negative or non-finite, all-zero entries, an overflowing period, a non-finite phase, an extra or missing key. `unsupported-feature` for 17 entries, including its precedence against the graph checks, and for a dash under `'unsupported'` on a stroke of width > 0. A dash on width 0 needs no gate. Absent and `null` are kept as given and are replay-equal | Unit tests in `pnpm check` |
| E24-A02 | Dash geometry: `stroke-dash.ts` output under every K rule. Lines are exact. Boundaries meet E24-K7's bounds against a double-double reference, including cusp, near-cusp and depth-limit cubics. Also covered: odd doubling; phase reduction (negative, beyond a period, and a phase of 2^40); seam joining, its absence, and a dash ending at `L` while a gap starts at 0; a fully on closed subpath; zero-length dashes, including those at `s = 0` and `s = L`; zero-length subpaths; and several subpaths, each restarting the pattern. Equal inputs give bit-identical output, independent of zoom | Unit tests |
| E24-A03 | Work limit: 4,096 dashes are requested and 4,097 fail with `dash-limit`. The failure makes no port call and gives one notice on the transition. The outcome is O1 for a stroke-only path, a filled path and a joint path, and other nodes draw. U3 records whether the real kernel reaches its own `work-limit` at 4,096 dashes on D8's geometry; that is informational, not a gate | Unit tests (scripted stroke port), U3 note |
| E24-A04 | Invalidation: E24-K9, measured by port-call, geometry-build and dash-expansion counters. Cases: dash edits, dashed↔solid, a colour edit, a camera pan, a zoom, and a pending request resumed across prepares | Unit and GPU counters |
| E24-A05 | Interior probes of D1 to D9 equal the oracle within 2/255 per channel, and edge probes within 4/255. D7's dash-end positions agree across zooms within 0.5 physical px at the coarsest zoom | Headed GPU spec, readback |
| E24-A06 | Identity, against `main` at U1's merge base: with no dash, stroke requests are byte-equal (unit test: verbs, points and fields per request across the existing stroke fixtures). The kernel, port and WASM identity tests are unchanged, and so are the E10-A1 golden log and the shader hashes. Solid-only frame captures, using E23's `a08-solid-capture.mjs` method, are byte-identical between that commit and U2 on the reference PC. The existing `pnpm test:gpu` suite passes. If the capture comparison cannot run, the other parts stand and the gap is disclosed | Unit tests, headed full `pnpm test:gpu` |

## 7. Units

| Unit | Track | Scope | Gate |
| --- | --- | --- | --- |
| U1 | Rendering | `SceneDash`, `SCENE_MAX_DASH_ENTRIES`, `PathStroke.dash`, copy and replay equality, `PathSupport.dashes`, consumers checked, and the amendment pointer lines of section 4 | E24-A01; CI |
| U2 | Rendering | `stroke-dash.ts`, the paint key and request path, the dash cache, the `dash-limit` state failure, counters, and the service setting `dashes: 'supported'` | E24-A02, A03, the A04 unit part, the A06 unit part |
| U3 | Visualization | Headed playground page for D1 to D9, GPU spec and independent oracle; SwiftShader run in the container | Headed run on the reference PC (the A04 GPU part, A05, A06) |
| U4 | Rendering | Evidence record `docs/evidence/e24/` with the index of A01 to A06 | Item done; M4 may consume E24 |

Order: U1, U2, U3, U4. The WIP limit per track applies.

**Unit records.** U1 (2026-10-29): `SceneDash`, `SCENE_MAX_DASH_ENTRIES` and `PathStroke.dash?` in `packages/contracts`; `copyDash` and the optional key in `copyPathStroke`, which keep the producer's form, frozen; `nullableDashEquals` with absent equal to `null`; `DashSupport`, `PathSupport.dashes?` and the mirror option `dashes` (default `'unsupported'`), gating a non-null dash on a stroke of width > 0 per node, with the entry count reported after the graph checks; `tests/unit/e24-u1-scene-dash.test.ts` (A01). The section 4 amendment pointers are in the B2 stroke contract (ST-S11, section 5, section 9.8), the E11-U4 addendum (section 3), `docs/requirements.md`, the graphics architecture's design-gate section and the MVP plan's R-D row. No consumer sets `dashes: 'supported'` before U2, so no dashed stroke reaches the stroke path until then. Independent review READY WITH FOLLOW-UPS (2026-10-29): the entry count applies at width 0 too (only the support gate exempts width 0), the rendering-track note, the E11-U4 code count; all applied. Carried to U2: `dash` joins `paintKeysEqual`, `memoKey` and `sameKey` in the unit that sets `'supported'`.

U2 (2026-10-29): `packages/renderer-core/src/stroke-dash.ts` (`expandDash`, `DASH_LIMIT`) per E24-K1 to K5 and K7 and the section 4 method. In `path-mesh-pipeline.ts`, the stroke paint key carries `dash`, so `paintKeysEqual`, `memoKey`, `sameKey` and the reachability of cache and memo entries see a dash change. A per-node dash cache holds `{ revision, dash, result, bytes }`: it is never evicted, it is dropped in reconciliation when the node goes or its revision or dash changes, and its bytes count in the statistics' `bytes` and so in the budget and `pathMeshMemoryBytes`. `dash-limit` is checked last in the per-paint state chain, after `tolerance-range`, `fringe-range` and `packing-range`, and uses the existing state-failure notices. A dashed request carries the dashed `verbs` and `points`. A pattern that is off over the whole path gives an empty dashed path; its stroke is published as an empty entry without a port call, as a port `empty` result would be. The renderer service sets `dashes: 'supported'` exactly when it has a stroke port, and the playground state tables list `dash-limit` with the state failures. A test-only counter `getDashExpansionCount()`. `tests/unit/e24-u2-dash-expansion.test.ts` covers A02, A03, the A04 unit part (port calls and expansions; the primitive geometry-build counter is U3's GPU part) and the A06 unit part. A02's cubic reference is a compensated (double-double) sum of an 8-point Gauss–Legendre rule over 2,048 uniform cells per piece, broken at known cusps; its nodes and weights are binary64. Its depth-limit case (a cusp at t = 0.3) was confirmed by a one-off probe to reach depth 24. Independent review round 1 (2026-10-29): NOT READY, with two blocking findings, both fixed. (1) Zero gaps: a period's start and the previous end round apart, so `[0.1, 0]` gave a false `dash-limit` and `[0.25, 0]` on a 10^9 line ran unbounded. Now a zero gap joins on-entries by structure, a pattern of zero gaps is solid, and more than budget + 3 periods is `dash-limit`, which bounds the work. (2) Exactness: a piece reaching its segment's end now ends at the source vertex, and a dash starting at a vertex starts there, so interior vertices, path ends and the seam point are copied exactly. Also fixed: E24-S1 now checks the doubled period of an odd pattern, and an accepted quadrature cell keeps I(cell), as section 4 pins. Disclosed and not changed: dash-cache bytes are never evicted, so a cache larger than the budget alone evicts every non-working mesh entry each prepare (the over-budget counters report it); `emitDash` scans the subpath's segments once per dash, O(dashes × segments) within the 4,096-dash limit; and the empty dashed entry is published even when the stroke port is latched as disposed.

U3 (2026-10-29): `tests/gpu/e24-stroke-dash.spec.ts` and the independent oracle `tests/support/e24-dash-oracle.ts`, on the E23 headed page (its service hosts both real ports with clips and gradients and, since U2, dashes; the page's counters gain `dashExpansions` from the new `getDashExpansionCountForTesting()`). SwiftShader: 6/6, recorded in [docs/evidence/e24/u3-swiftshader.md](../evidence/e24/u3-swiftshader.md). Observed: D6 at DPR 2 takes O3 (`overlay-unsupported`) while its solid reference draws. The cause is the ST7-Q8 (a) class (`sloped-outer-edge`: dash butt ends put Steiner points on the sloped outer edges of the region-only fill), not the overlay work cap below. Decided 2026-10-29 (recommended option auto-adopted): it is disclosed as a known E24 failure, and the overlay-builder fix is backlog item E27. The real kernel reports `work-limit` on 4,096 `[1, 1]` dashes of D8's geometry (the A03 note), a section 8 risk. The A04 case of a request resumed while pending is covered by the U2 unit tests, not by the GPU part. E24-A05 is therefore met with one disclosed exception: D6 at DPR 2 is hidden (O3) and checked only as not drawn; U4's index names it. The A06 solid captures are byte-identical between `2d19b64` and U2 on SwiftShader. The reference-PC run (Chrome and Edge, DPR 1 and 2, the A06 captures and the full `pnpm test:gpu`) passed at `e313b96` (2026-10-29).

U4 (2026-10-29): the [evidence index](../evidence/e24/README.md) records E24-A01 to A06 as PASS, with A05's disclosed exception (D6 at DPR 2 takes O3; backlog E27). On the reference PC the headed spec passed 12 of 12 in Chrome and Edge. The worst A05 difference was 0.55/255 (D9 at DPR 2). D7's worst cross-zoom disagreement was 1.02 local units (0.25 physical px at zoom 0.25) at DPR 1, against the 0.5 px limit (2 units). The A06 solid captures at `2d19b64` and `e313b96` are byte-identical, and the full `pnpm test:gpu` passed 158 of 158. Independent review READY WITH FOLLOW-UPS (2026-10-29): the outcome wording, the probe and D7 units, the D8 note, and the A06 pointers; all applied. E24 is done, and MVP M4 may consume dashed strokes.

## 8. Risks

- **Fringe cap (E24-Q6).** Many real dashed strokes draw region-only with MSAA, and each such path raises a `fringe-work-cap` warning. U3 records which fixtures hit the cap. Edge probes run only on stroke meshes under the cap.
- **Overlay work cap.** A dashed stroke on a filled path at `0 < opacity < 1` gives the ST-U7 overlay many more stroke boundary edges. Its work cap can then trigger `overlay-unsupported` (E11-U4 O3, path hidden). U3 records whether D6 hits it. U3 did not observe it; D6's O3 at DPR 2 has another cause (see the U3 record).
- **Kernel work.** Each dash is a subpath for the exact stroker. Dense patterns raise kernel work, and the E2 work limits (`work-limit` failures) can trigger before `dash-limit` does. Both fail closed with a diagnostic.
- **Split tangents (E24-K6).** Rounded split control points can move a near-reversal or cusp case across a B2 miter or cap classification, compared with the solid stroke. A large-`miterLimit` near-reversal inside a dash can then fail with `numeric-range` where the solid stroke draws.
- **Arc-length cost.** Expansion is linear in segments and dashes. Quadrature per cubic is bounded by the depth limit. Expansion runs once per geometry or dash change, not once per frame.

## 9. Questions (each with a recommended option)

- **E24-Q1 realization.**
  - (a) Expand dashes in `renderer-core` ahead of the unchanged stroke port.
  - (b) Expand in the Rust kernel, with new port fields.
  - (c) Discard by arc length in the shader.
  - Recommended (a). It changes no ABI, WASM identity, kernel or shader. B2 already defines the stroke of the dashed path exactly, and the dash rule stays testable in TypeScript beside its oracle.
- **E24-Q2 closed seams.**
  - (a) When dashes meet at the seam, join the last and first into one (E24-K4).
  - (b) Keep them separate, with caps at the seam (SVG 1.1 wording).
  - Recommended (a). A closed shape then has no visible start point, and a dash that crosses a rectangle's start corner gets the corner's join, as Figma and most editors draw it. Option (b) draws a notched or doubled corner at the start point only.
- **E24-Q3 zero-length dashes.**
  - (a) Use ST-S10 and ST-P7 as approved: round dots, nothing for butt, square dots aligned to the local axes.
  - (b) Orient square dots along the path, which needs a kernel and port change.
  - Recommended (a). Round and butt match SVG, and the square departure is disclosed and pinned by D2. Option (b) would reopen the approved B2 rows and the port.
- **E24-Q4 work limit.**
  - (a) Allow 4,096 dashes per stroke, and fail with `dash-limit` under the existing O1 outcome.
  - (b) No limit; the kernel work limits decide.
  - (c) Fall back to a solid stroke above the limit.
  - Recommended (a). It bounds the request size before the kernel sees it, names the cause, and keeps E11-U4's one outcome for stroke failures. Option (c) would draw a solid stroke the document did not ask for, against ST-S11.
- **E24-Q5 field shape.**
  - (a) An optional `dash?: { pattern, phase } | null` on `PathStroke`.
  - (b) Required `dashPattern` and `dashPhase` fields.
  - Recommended (a). Every existing producer and fixture stays valid without edits, and one field carries the whole intent.
- **E24-Q6 fringe cap.**
  - (a) Keep the V4 fringe cap and E11-U4's O2 for dashed strokes above it: region-only with 4x MSAA and a notice. The fringe builder's placement (E12 or E6) decides later.
  - (b) Raise or remove the cap within E24.
  - Recommended (a). E24 then changes no coverage rule. The cap belongs to the fringe-builder decision, which also covers solid strokes such as E23's G3. MSAA keeps dash edges antialiased.

## 10. Decisions

**Review record.** Independent review (fresh context, reviewer role), 2026-10-29.

- **Round 1: NOT READY.** It found three blocking findings:
  - The `dash-limit` outcome contradicted B2 §9.6 and E11-U4 O1.
  - `dash-limit` is a new code, and its state-failure machinery was unspecified.
  - The half-open on test dropped zero-length dashes and seam joins.

  It also found seven further findings: the mask-source exemption, the copy and equality steps, the frozen-text amendments, the K7 method and phase precision, the cache location, split tangents, and the fringe cap. All were applied.
- **Round 2: READY WITH FOLLOW-UPS.** The follow-ups were the exact phase remainder, the dash cache staying out of budget eviction, the overlay work-cap risk, and the K8 cross-reference. All were applied.

- **2026-10-29, recommended options auto-adopted** under the user's standing instruction of 2026-10-24: E24-Q1 (a), E24-Q2 (a), E24-Q3 (a), E24-Q4 (a), E24-Q5 (a) and E24-Q6 (a). Q4 (a) and Q6 (a) are the visible product choices: a path over the dash limit is not drawn (O1), and dashed strokes above the fringe cap draw region-only with a notice. The user may reopen any of them before U1 merges. U1 makes the amendments of section 4.
