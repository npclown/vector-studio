# M7-A10 observation: 100 instances of a 100-node source (2026-10-29)

**This is an observation only. It makes no claim.** It is not a benchmark under [`docs/benchmarks/README.md`](../benchmarks/README.md), and it sets no threshold (MVP plan section 8; [M7 contract](../plans/mvp-m7-symbols-contract.md) section 9 and M7-A10). It was taken in a shared cloud container, not on the main PC. The numbers show where time goes and are meant to catch bad scaling early, as the [M1-A13 observation](m1-a13-observation-2026-10-28.md) did. The M9 benchmarks own every performance claim.

## What was run

- **Document.** `tests/m7-a10/document.ts` builds the document from indices, so no JSON fixture is committed. It has 200 document nodes on one page and is 64 KB as JSON.
  - The source `S` is a `symbol` of 100 nodes (itself and 99 descendants): 200 x 200, a white fill and no stroke, holding 11 groups (four of them rotated 0.2) of 8 leaves each: rectangles (one rotated, some with per-corner radii, one stroked), ellipses (one stroked), paths (a triangle and a cubic shape, filled or stroke only) and lines with arrows. Group frames are the bounds of their children.
  - 100 instances `I0` to `I99` of `S` in a 10 x 10 grid. Even-numbered ones are 200 x 200, the source's size (an expansion at scale 1 is the source's own nodes, M7-X1); odd-numbered ones are 300 x 250, so their content is mapped (M7-Q4 (c)).
  - The page projects 10,302 scene nodes: 102 for the source (its frame, content and background nodes and its 99 descendants) and 102 for each instance (outer, content and background nodes and 99 expanded nodes).
- **Harness.** `tests/m7-a10/observation.check.ts` runs through `vitest.m7-a10.config.ts` (`pnpm observe:m7-a10`). It is manual and never part of `pnpm test:unit` or CI. Each run uses a fresh editor and a fresh recording renderer (`tests/support/p5-recording-renderer.ts`, wrapped to time its scene calls); the recording renderer is the renderer-core `RetainedSceneMirror`, which validates every snapshot and change set.
- **Correctness.** After attach and after every step, the check asserts that the mirror's identity, root order and every scene node equal `projectPage` of the page with a fresh expansion cache, with no instance left out as invalid. After the source edit every instance's expanded copy of the edited leaf holds the new fill in the mirror. After the drag the group moved by (10, 15) to within 1e-9 (`toBeCloseTo`, 9 digits) and history holds two steps. After the detach the instance is a `frame` and the document holds 99 more nodes.

| Step | What is timed |
| --- | --- |
| parse | `parseDocument` of the JSON text |
| construct | `createEditor` with the parsed document (validation, load, and the expansion validity and cap checks of every instance) |
| project | `projectPage` of the page alone, with a fresh expansion cache and no renderer |
| attach | `attachRenderer`: first projection and the mirror's `replaceSnapshot` |
| source edit | One `setNodeProps` fill of the leaf `G0-0` inside the source: a commit that reaches the source and all 100 instances |
| source drag | Select-tool drag through `input` of the group `G0` inside the top-level source (the press selects it as the artboard target): pointer down, five pointer moves (one gesture update each, which re-expands every instance), pointer up (the commit) |
| instance move | One `setFrames` of `I0` by 10 to the right (the M7-U3 review asked where an instance move's time goes) |
| detach | One `detachInstances` of the scaled instance `I1` |

## Environment

- Commit `6ff93bf` (branch `m7-u6` on `46490ff`, which includes M7-U1 to U5), clean worktree.
- Node v22.22.0. The repository pins 24.22.1, so pnpm warns about the engine.
- Linux, CPU from `/proc/cpuinfo`: Intel(R) Xeon(R) Processor @ 2.80GHz, 4 logical CPUs. This is a shared cloud container.
- Command: `pnpm observe:m7-a10`, after `pnpm build`. Five runs, the default of `M7_A10_RUNS`. Vitest reported a total duration of 24 s.
- Raw record: [`m7-a10-observation-2026-10-29/record.json`](m7-a10-observation-2026-10-29/record.json), a copy of `.tools/m7-a10/record.json` formatted by Prettier.

## Numbers

All values are in milliseconds. Steps marked "renderer" are the part of the step above them spent inside the renderer's scene calls.

| Step | Median | Min | Max | Runs |
| --- | ---: | ---: | ---: | --- |
| parse | 7.2 | 3.6 | 14.0 | 14.0, 7.2, 12.8, 3.6, 3.9 |
| construct | 60.7 | 51.2 | 145.3 | 145.3, 60.7, 73.3, 51.8, 51.2 |
| project (no renderer) | 109.0 | 97.1 | 174.2 | 174.2, 103.3, 97.1, 113.7, 109.0 |
| attach | 322.1 | 250.4 | 543.7 | 543.7, 273.4, 322.1, 327.3, 250.4 |
| renderer (`replaceSnapshot`) | 266.7 | 210.0 | 486.4 | |
| source edit (commit) | 186.7 | 131.2 | 269.2 | 269.2, 195.7, 186.7, 149.7, 131.2 |
| renderer | 151.1 | 100.5 | 168.6 | |
| source drag: pointer down | 1.6 | 1.1 | 7.0 | |
| source drag: five pointer moves | 843.8 | 640.8 | 990.1 | 938.3, 690.2, 990.1, 843.8, 640.8 |
| renderer | 633.9 | 493.7 | 773.0 | |
| source drag: pointer up (commit) | 40.9 | 33.7 | 48.3 | 48.3, 34.3, 44.8, 40.9, 33.7 |
| renderer | 0 | 0 | 0 | |
| instance move | 115.3 | 99.9 | 158.1 | 158.1, 99.9, 123.9, 114.7, 115.3 |
| renderer | 106.0 | 90.9 | 138.1 | |
| detach | 122.8 | 112.1 | 240.8 | 147.6, 122.8, 240.8, 122.6, 112.1 |
| renderer | 107.4 | 97.0 | 217.5 | |

Generating the document took 1.9 ms. The change sets of the last run: the source edit sent one set updating 101 scene nodes (the leaf in the source and its copy in each instance); the drag commit sent nothing; the instance move sent one set updating 1 node; the detach sent one set inserting 99 nodes, removing 99 and updating 1, so the page still projects 10,302 scene nodes.

## Observations

- **A gesture inside a source costs about 169 ms per update** (844 ms for five moves) on this page, about 75 % of it in the renderer (the mirror). The editor side is about 42 ms per update: the drag re-expands every instance (section 4.1 discloses that a gesture inside a source repeats the M7-X3 and cap checks on every pointer move) and the projector diffs the page. This is about twice the 77 ms per update M1-A13 saw on a 10,634-node page without instances, and well above a 16.7 ms frame. The commit itself is cheap (41 ms, nothing sent).
- **Most of every edit is the renderer mirror, not the expansion.** An instance move updates one scene node, yet 106 of its 115 ms are in the mirror; the detach sends 199 nodes and spends 107 of 123 ms there. For this page this bears on the M7-U3 review's question (M5) without settling it: the time of a moved instance is measured inside the mirror's `applyChanges`, not in the editor's expansion, which the per-node memo reuses. That a one-node set costs about as much as a 199-node one is consistent with the mirror validating each set against the whole retained scene, the O(n) per set the M1-A13 observation found and the E26 backlog item names, but this observation does not profile inside the mirror, so the cause is not measured here.
- **The projection of instances is about 8.6 times dearer per scene node than of plain nodes.** A pure projection of this page takes 109.0 ms for 10,302 scene nodes (0.0106 ms each) against 13.1 ms for M1-A13's 10,634 (0.0012 ms each), because each of the 100 expansions is computed (half of them mapped at a scale other than 1) and each expanded node gets its own snapshot. The M7-U2 review (M1) recorded that subtree work is not shared between instances of one source at the same scale; that sharing could recover part of this. Construct (61 ms) includes the expansion checks of every instance and stays small.
- **A source edit reaches all instances in one set** of 101 updated nodes: 187 ms, 151 ms of it in the mirror.
- The cap-scale figures from the M7-U3 review (M5), about 1.9 s for the first projection of a page at the 100,000-node cap and about 1.9 s for an instance move there, are about 17 times these 10,302-node figures (109 ms and 115 ms) for about 10 times the scene nodes: somewhat worse than linear, from another container and run, so only the order of growth is comparable.
- The renderer share here is the renderer-core mirror on the CPU. The WebGPU host adds GPU upload and drawing (one copy of each expanded path mesh per instance, section 9), which this observation does not measure.

## Known limits

- One shared, 4-vCPU cloud container. No pinned frequency or isolation, and the Node version is not the pinned one. Medians come from five runs. Spread across runs is up to 2.8x for construct and up to 3.9x for parse, from JIT warm-up (the first run is the slowest in most steps) and a noisy host.
- No browser, no GPU, and no pixels.
- The document is synthetic: one source, leaves of 8 x 8 units, no overlap between instances, and no frame or mask group inside the source, so frame-role nodes of expanded frames and clip work through an expansion are not exercised.
