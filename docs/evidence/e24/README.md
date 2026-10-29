# E24 dashed strokes: evidence index (2026-10-29)

This is the index of E24-A01 to A06 for the [E24 contract](../../plans/d9-e24-dash-contract.md), unit U4.

E24 is done: every criterion passes, with one disclosed exception. At DPR 2, D6 takes E11-U4 O3 (`overlay-unsupported`) and is not drawn (see A05). MVP M4 may consume dashed strokes.

The reference-PC run used DESKTOP-DKVUSAV with a GTX 1660 SUPER, Chrome and Edge, at commit `e313b96` (#341, U3's merge). Install and build exited 0. The report files stay on the PC; the figures below are copied from the run reports.

Another evidence file in this folder: [u3-swiftshader.md](u3-swiftshader.md), U3's spec run on SwiftShader in the container, including the A06 solid captures there.

## Index

| ID | Status | Evidence |
| --- | --- | --- |
| E24-A01 Validation | PASS | `tests/unit/e24-u1-scene-dash.test.ts`, in CI since #339 |
| E24-A02 Dash geometry | PASS | `tests/unit/e24-u2-dash-expansion.test.ts` (#340), against the double-double reference |
| E24-A03 Work limit | PASS | Unit: `e24-u2-dash-expansion.test.ts`. The U3 note on the real kernel is informational: see below |
| E24-A04 Invalidation | PASS | Unit: `e24-u2-dash-expansion.test.ts`. GPU counters: headed spec (below) |
| E24-A05 Probes, D1 to D9 | PASS, one disclosed exception | Headed `tests/gpu/e24-stroke-dash.spec.ts`, Chrome and Edge, DPR 1 and 2 (below). D6 at DPR 2 takes O3 and is not drawn; the fix is backlog item E27. SwiftShader: [u3](u3-swiftshader.md) |
| E24-A06 Identity | PASS | Unit part: `e24-u2-dash-expansion.test.ts` (undashed requests unchanged). The E10-A1 golden log (`tests/unit/e10-default-invariance.test.ts`) and the shader hashes are unchanged in CI. Nothing under `crates/` changed between `2d19b64` and `e313b96`, so the kernel, port and WASM identity tests are unchanged. Solid captures: byte-identical on the reference PC (below). Full headed `pnpm test:gpu`: 158 of 158 (below) |

## Headed spec: `tests/gpu/e24-stroke-dash.spec.ts`

12 of 12 tests passed in 3.9 min, in Chrome and Edge. The spec needs `--config playwright.gpu.config.ts`.

The report files match across the two browsers:

- `a04` and `a05-d7` are byte-identical.
- `a03-note` and `a05` differ only in timestamps.
- No report has a failure or a page error.

**A04 (GPU counters).** Each case reports dash expansions / stroke port calls / fill port calls / geometry builds.

| Case | Expansions | Stroke calls | Fill calls | Builds |
| --- | --- | --- | --- | --- |
| Dash edit | 1 | 1 | 0 | 0 |
| Phase edit | 1 | 1 | 0 | 0 |
| Dashed → solid | 0 | 1 | 0 | 0 |
| Solid → dashed | 1 | 1 | 0 | 0 |
| Colour edit | 0 | 0 | 0 | 0 |
| Pan | 0 | 0 | 0 | 0 |
| Zoom | 0 | 1 | 1 | 0 |

**A05 at DPR 1.**

- No fixture took O3: the report's `outcomes` is `{}`. The O2 fringe caps and D8 A's O1 are listed below the table.
- For each fixture, the table gives the probes, the content probes and the worst difference over them, in 1/255. The probes are the interior probes plus D1's edge probes, which are checked at 4/255.

| Fixture | Probes | Content | Worst |
| --- | --- | --- | --- |
| D1 | 18,030 | 50 | 0.5 |
| D2 | 17,586 | 70 | 0 |
| D3 | 17,625 | 22 | 0 |
| D4 | 17,985 | 4 | 0 |
| D5 | 17,859 | 26 | 0 |
| D6 | 17,417 | 2,218 | 0.5 |
| D6 solid reference | 17,243 | 2,131 | 0.5 |
| D8 | 17,997 | 50 | 0 |
| D9 | 17,997 | 50 | 0.525 |

- D7 at zoom 0.25, 1 and 8: content 0, 4 and 1,412, worst 0.
- Warnings:
  - `fringe-work-cap` on d2-round, d6, d6-solid and d7. These strokes are drawn region-only (E24-Q6).
  - `dash-limit` on d8-a, as A03 expects.

**A05 at DPR 2.**

- **D6** took O3 (`overlay-unsupported`) and has no content. This is the disclosed exception:
  - It is the ST7-Q8 (a) `sloped-outer-edge` class: dash butt ends put Steiner points on the sloped outer edges of the region-only fill.
  - It is not the overlay work cap.
  - The spec checks that D6 is not drawn, and its solid reference draws.
  - Decided 2026-10-29: disclosed, fix in backlog E27.
- Content / worst for the drawn fixtures:

  | Fixture | Content | Worst |
  | --- | --- | --- |
  | D1 | 550 | 0.5 |
  | D2 | 633 | 0 |
  | D3 | 972 | 0 |
  | D4 | 185 | 0 |
  | D5 | 403 | 0 |
  | D6 solid reference | 9,253 | 0.5 |
  | D8 | 550 | 0 |
  | D9 | 550 | 0.55 |

- D7 content: 0, 185 and 6,177.
- Warnings:
  - `fringe-work-cap` on d2-round, d4, d6 (twice), d6-solid (twice) and d7 (twice);
  - `overlay-unsupported` on d6;
  - `dash-limit` on d8-a.

**A05, D7 dash ends across zooms.**

| DPR | Worst, local units (limit) | Worst absolute (fine limit) |
| --- | --- | --- |
| 1 | 1.01648 (2) | 0.000186 (0.0625) |
| 2 | 0.16557 (1) | 0.0000930 (0.03125) |

At DPR 1, 23 dash ends gave 46 comparisons: zoom 1 and zoom 8, each against zoom 0.25. All 23 ends were also measured absolutely at zoom 8.

- The limit is 0.5 physical px at zoom 0.25: 2 local units at DPR 1 and 1 at DPR 2. The worst values are 0.25 px and 0.08 px.
- The fine limit is 0.5 physical px at zoom 8.

**A03 note (informational).** D8's stroke (width 2, `[1, 1]`) was drawn over `M 0 0 L 8190 0`, which is exactly 4,096 dashes. The frame status was `applied`, with 0 mesh draws. The real kernel reported one `render.path-mesh-failure` with `work-limit` (tolerance exponent −3), after 1 stroke port call, with `pathMeshMemoryBytes` 20,717,568. The contract's section 8 records this risk.

## A06 solid captures (headed Chrome)

The A06 captures used e313b96's `docs/evidence/e23/a08-solid-capture.mjs`, copied out of the repo unchanged (SHA-256 `AFCB55DB…E11C`). It ran on the real GPU at `2d19b64` (U1's merge base) and at `e313b96` (U3's merge, which contains U2's `b38bb46`). The two outputs, `a06-2d19b64.json` and `a06-e313b96.json`, are byte-identical. Both have SHA-256 `2664A1C271697387AD87FAD4EDF5BCC62223E78BD8FD272D7AC62FCAFFF55C0A`, the same hash as E23's A08 captures at `e96a034` and `d00af7c`.

## Full headed suite (E24-A06)

`pnpm test:gpu` at `e313b96`: **158 passed**, with 0 failed, 0 skipped, 0 flaky and 0 not run. It took 3.1 h in Chrome and Edge.

- The log runs continuously from 1/158 to 158/158, although the remote session restarted twice.
- The longest files: `viz-v4-a08-corpus` took 1.1 h in Edge and 59 min in Chrome, `p1-primitives` about 9 min in each browser, and `p4-clip-mask` 8.6 min in Edge.
- No processes from the job were left running.
