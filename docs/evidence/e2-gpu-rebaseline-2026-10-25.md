# E2 headed GPU re-baseline, `stroke-v0+r6`, 2026-10-25

Follow-up to E2-U1 (`r5`, #237) and E2-U2 (`r6`, #239) of the [E2 contract](../plans/d9-e2-stroke-fast-rung-contract.md#9-units). Both units changed stroke outcomes that two headed GPU specs gate as observed literals, and both merged without a headed run (the container has no usable WebGPU device). The E14 thread's headed run at main `7662310` found the failures. This is functional evidence. It makes no performance claim, and precision stays **UNVERIFIED** until E3 measures it.

## Failure at main `7662310`

Headed, Chrome 155.0.8059.85 and Edge 156.0.4314.42 on the user's machine, WASM sha256 `0bc67a3ad01c8e27ed1f4054f1e920a37835c952628e2bc6eb8882427bc57373`. Both browsers gave byte-identical failure lists.

- `p3-b2-strokes` failed at DPR 1, 2 and 3. Only notice sets and mesh draw counts differed; every probe passed.
- `viz-v1-appearance` failed at DPR 1 and 2, in scenario N1 only: `v1-circle` at stroke width 8 reported `fringe-work-cap` instead of `work-limit`, and the "not drawn" probe saw the fill.
- `p3-v4-paths`, `viz-v2-path-data` and `viz-v3-integration` passed, as did every fill spec.

## Decision

Decided 2026-10-25 under the user's standing instruction of 2026-10-24, recommended option (추천안 자동 채택).

| Option | Consequence |
| --- | --- |
| (a) Re-baseline the literals, recommended | The outcome change is E2's goal: strokes that stopped at `work-limit` now mesh. The specs' own rule ([V-1 §4.1](../plans/viz-v1-path-appearance-contract.md#41-expected-literal-rule), the ST-U8 literal comment) says the PR that changes an outcome re-baselines it with a dated note. No kernel change. |
| (b) Change the stroke kernel | Would undo E2-U1/U2's gains or add a special case to restore `work-limit`, which is a regression of the product outcome, to satisfy a test literal. |

Within (a), V-1's N1 exists to exercise a path that is not drawn (V1-A9: backdrop probe, "not drawn" status, the notice log across a rebuild). Re-baselining N1 to `fringe-work-cap` would drop that coverage, since N2 already covers `fringe-work-cap`. So N1 sets the stroke width to 48 before turning the stroke on, which keeps every V1-A9 N1 check and literal. The radius-30 circle (butt, round) meshes up to width 24 and ends at `work-limit` from width 32, at every tolerance exponent from -6 to -2 (stroke port at `r6`, widths 8, 12, 16, 24, 32, 48, 64, 96).

## Changes

- `tests/gpu/p3-b2-strokes.spec.ts`: the five changed `dpr/view` literals, from the headed run at `7662310`, with a dated note.

  | View | Notices that changed | Mesh draws |
  | --- | --- | ---: |
  | `1/overview-zoom-1` | `fill-stroke-circle`, `wide-cubic`: `work-limit` → `fringe-work-cap`; `cusp-f16p` `fringe-work-cap` gone | 19 → 22 |
  | `1/zoom-0.25` | `cusp-f16-large`, `wide-cubic`: `work-limit` → `fringe-work-cap` | 21 → 23 |
  | `1/zoom-2-cusp` | `fill-stroke-circle`: `work-limit` → `fringe-work-cap` | 8 → 10 |
  | `2/overview-zoom-1` | `fill-stroke-circle`: `work-limit` → `fringe-work-cap` | 19 → 21 |
  | `3/overview-zoom-1` | `fill-stroke-circle`, `cusp-f16p`: `work-limit` → `fringe-work-cap`; `cusp-shared-a` `fringe-work-cap` gone | 18 → 21 |

- `tests/gpu/viz-v1-appearance.spec.ts`: N1 commits width 48 before the stroke goes on; its literals are unchanged.
- Contract notes: [V-1 §4.1](../plans/viz-v1-path-appearance-contract.md#41-expected-literal-rule) (N1 width) and [E2 §9](../plans/d9-e2-stroke-fast-rung-contract.md#9-units) (from E2-U3 on, an outcome-changing unit runs both specs headed and re-baselines them in its own PR, or marks them NOT RUN and runs them before E2 closes).

## Validation

- Headed GPU, user's machine, branch commit `b1a1187`, same WASM sha256 as above (the kernel source is unchanged): `pnpm exec playwright test -c playwright.gpu.config.ts tests/gpu/p3-b2-strokes.spec.ts tests/gpu/viz-v1-appearance.spec.ts` passed 10 of 10 in Chrome 155.0.8059.85 and Edge 156.0.4314.42, with empty failure lists and no page errors. The only console error is the expected favicon 404 on the `p3-b2-strokes` DPR 1 page.
  - The `p3-b2-strokes` notice sets and mesh draws equal the `7662310` observations above.
  - V-1 N1 at width 48, all four files (two browsers, DPR 1 and 2): `a-fill-only` `[]`; `b-stroke-on` and `c-stroke-off` `[v1-circle stroke work-limit]`; `d-stroke-on-again` two such notices. Every N1 probe is within tolerance, including the backdrop probes for "not drawn".
  - Evidence: `artifacts/p3-b2-strokes/2026-10-25T12-42-36-200Z-8908` (Chrome) and `2026-10-25T12-43-39-560Z-5060` (Edge); `artifacts/viz-v1-appearance/2026-10-25T12-42-53-460Z-8908` (Chrome) and `2026-10-25T12-43-57-357Z-5060` (Edge), on the user's machine (not committed, as for earlier headed runs).
- Fill-mesh and stroke-mesh kernels and adapters: unchanged, so `cargo test` and `pnpm test:geometry` are not re-run (NOT RUN: no code under `packages/` changed). At `7662310`, `cargo test` passed 513 on the user's machine.
- In the container, the headed specs are NOT RUN: the bundled Chromium's SwiftShader WebGPU device is lost on first use, so pixels and fringe notices are unusable there.
