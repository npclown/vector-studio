# M4-A13 observation: 10,000 stroked rectangles, round and miter joins (2026-10-30)

**This is an observation only. It makes no claim.** It is not a benchmark under [`docs/benchmarks/README.md`](../benchmarks/README.md), and it sets no threshold (MVP plan section 8; [M4 contract](../plans/mvp-m4-appearance-contract.md) section 9, M4-A13, and section 11 "Path projection cost"). It is a **container observation**: it was taken in a shared cloud container, not on the main PC. The M9 benchmarks own every performance claim.

## What was run

- **Documents.** `tests/m4-a13/document.ts` builds them from indices, so no JSON fixture is committed: one page of 10,000 rectangles, 8 x 8 in a 100 x 100 grid of 10-unit cells, each with a solid fill and a 1-unit black stroke (butt cap, miter limit 4, no dash), 4.0 MB as JSON. The `round` document projects 10,000 P1 primitives; the `miter` document 10,000 M4-P4 outline paths (M4-P3).
- **Harness.** `tests/m4-a13/observation.check.ts` through `vitest.m4-a13.config.ts` (`pnpm observe:m4-a13`), manual and never part of `pnpm test:unit` or CI. Each run uses a fresh editor and a fresh recording renderer (`tests/support/p5-recording-renderer.ts`, the renderer-core `RetainedSceneMirror` with gradients, dashes and group opacity on, wrapped to time its scene calls).
- **Correctness.** After attach and after each `setStyle`, the check asserts that the mirror's root order and every scene node equal `projectPage` of the page, and that the scene kinds are as expected: the width edit keeps them, the join edit switches all 10,000 (primitive to path for `round`, path to primitive for `miter`), and history holds two steps.

| Step | What is timed |
| --- | --- |
| parse | `parseDocument` of the JSON text |
| construct | `createEditor` with the parsed document |
| project | `projectPage` of the page alone, no renderer |
| attach | `attachRenderer`: first projection and the mirror's `replaceSnapshot` |
| setStyle width | One `setStyle` over all 10,000 IDs with `{ stroke: { width: 2 } }` |
| setStyle join | One `setStyle` over all 10,000 IDs with the other join |

## Environment

- Code at this commit: branch `m4-u4` on main `045fcf9` (M4-U1 to U3 and M6a-U4c merged) plus M4-U4. Measured at a pre-amend local commit with the same code tree, clean worktree; the commit then added only this record. The record's `revision` field says so in place of that commit's hash.
- Node v22.22.0 (the repository pins 24.22.1, so pnpm warns), Linux, 4 logical CPUs, shared cloud container.
- Command: `pnpm observe:m4-a13` after `pnpm build`, five runs (the default of `M4_A13_RUNS`); Vitest reported 28.5 s in all.
- Raw record: [`m4-a13-observation-2026-10-30/record.json`](m4-a13-observation-2026-10-30/record.json), a copy of `.tools/m4-a13/record.json` formatted by Prettier.

## Numbers

Milliseconds, median (min to max) over five runs. "renderer" is the part of the step above it spent inside the mirror's scene calls.

| Step | round (primitives) | miter (paths) |
| --- | ---: | ---: |
| parse | 300.3 (247.2 to 397.7) | 289.2 (250.0 to 377.8) |
| construct | 140.5 (111.0 to 190.0) | 126.2 (108.7 to 142.1) |
| project (no renderer) | 20.1 (17.6 to 45.8) | 27.6 (23.7 to 34.7) |
| attach | 186.1 (173.4 to 331.8) | 236.2 (221.8 to 303.3) |
| renderer (`replaceSnapshot`) | 151.2 (143.7 to 299.9) | 190.0 (174.6 to 253.4) |
| setStyle width | 339.8 (309.5 to 478.6) | 389.2 (372.6 to 487.9) |
| renderer | 180.8 (148.0 to 207.1) | 203.9 (176.1 to 229.4) |
| setStyle join (switches every kind) | 445.0 (337.9 to 466.7) | 319.0 (288.6 to 341.9) |
| renderer | 201.1 (169.9 to 246.4) | 153.0 (138.2 to 167.4) |

Each `setStyle` sent one change set updating 10,000 scene nodes.

## Observations

- **On the CPU side the path projection costs little more than the primitive one**: projecting 10,000 outline paths took 27.6 ms against 20.1 ms for primitives, and attaching them 236 against 186 ms. M4-P4's outline is a few verbs per rectangle; the cost the contract's section 11 names (path meshes, P3's fringe) is in the WebGPU renderer's mesh work, which this Node observation does not reach.
- **One `setStyle` over 10,000 nodes takes about 340 to 390 ms**, about half of it in the mirror (validating and applying a 10,000-node change set) and half in the editor (validating and merging each node, and the diff). Switching the join, which turns every primitive into a path or back, costs 319 to 445 ms, the same order.
- Parse dominates load (about 290 to 300 ms for 4 MB of JSON); construct is 126 to 140 ms.

## Not measured here

- **Frame time: NOT RUN in the container.** The headed spec's `M4-A13: frame time of 10,000 stroked rectangles (observation)` test (`pnpm test:m4-next-host`) loads both documents in next-host, captures the first frame and five re-presented frames, and attaches the times; in this container SwiftShader's WebGPU device is lost right after the renderer starts, so no frame could be captured (M4-U4 note 7); the smoke run recorded only the in-page `loadDocument` plus `zoomTo` fit, one run each: 414 ms for `round` and 361 ms for `miter`. The frame time is to be taken on the main PC in Chrome and Edge.
- No GPU and no pixels; one shared 4-vCPU container, no pinned frequency, the Node version not the pinned one; the first run is the slowest in most steps (JIT warm-up).
