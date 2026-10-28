# M1-A13 observation: 10,000-node v2 document (2026-10-28)

**This is an observation only. It makes no claim.** It is not a benchmark under [`docs/benchmarks/README.md`](../benchmarks/README.md), and it sets no threshold (MVP plan section 8; [M1 contract](../plans/mvp-m1-document-v2-contract.md) M1-A13). It was taken in a shared cloud container, not on the main PC. The numbers show where time goes and are meant to catch bad scaling early. The M9 benchmarks own every performance claim.

## What was run

- **Document.** `tests/m1-a13/document.ts` builds the document from a seed (`0x6d31a13`), so no JSON fixture is committed. It has exactly 10,000 nodes on two pages and is 3.75 MB as JSON.
  - Page 1 (active after load): 650 clusters, a chain of 40 nested groups, a chain of 10 nested frames, and 50 loose leaves. That is 9,200 nodes, 702 roots and 10,634 scene nodes once frame synthetic nodes are added.
  - Page 2: 50 clusters and 50 loose leaves.
  - A cluster is a frame of 14 nodes, some of them rotated or stroked. It holds a rectangle with per-corner radii, a group and a mask group.
    - The group (sometimes rotated) holds a rectangle, an ellipse, a path (a triangle or a cubic shape) and a rotated inner group with a line with arrows and an ellipse.
    - The mask group's source is a cubic path, and it also holds a rectangle and a rotated ellipse.
  - Leaves vary their opacity and visibility. Group frames are the bounds of their children, as the editor's refit keeps them.
- **Harness.** `tests/m1-a13/observation.check.ts` runs through `vitest.m1-a13.config.ts`. It is manual and never part of `pnpm test:unit` or CI. Each run uses a fresh editor and a fresh recording renderer (`tests/support/p5-recording-renderer.ts`, wrapped to time its scene calls). The recording renderer is the renderer-core `RetainedSceneMirror`, which validates every snapshot and change set.
- **Correctness.** After attach, after the move and after isolation, the check asserts that the mirror's identity, root order and every scene node equal `projectPage` of the active page, with nothing excluded. After the move it also asserts the 10/15 page shift of the selection bounds and one undo step. After isolation it asserts one rejected set, one empty snapshot and then only accepted one-unit sets.

| Step | What is timed |
| --- | --- |
| parse | `parseDocument` of the JSON text |
| construct | `createEditor` with the parsed document (validation and load) |
| project | `projectPage` of page 1 alone, with no renderer |
| attach | `attachRenderer`: first projection and the mirror's `replaceSnapshot` |
| move | Select-tool drag through `input` of a nested two-node selection (a rectangle and an ellipse in a rotated group inside a frame): pointer down, five pointer moves (one gesture update each), pointer up (the commit, with the group refit) |
| isolation | One `setFrames` of two loose leaves. The renderer rejects its set once (`invalid-scene`, `invalid-value`), so the projector sends an empty snapshot and then one set per unit for the whole page (9,250 sets). It needs two units, because a rejected one-unit set is that unit's own rejection (M1-U3 note 1) and starts no isolation |

## Environment

- Commit `7c799c5` (branch `m1-u6-wip` on `e072247`), clean worktree.
- Node v22.22.0. The repository pins 24.22.1, so pnpm warns about the engine.
- Linux 6.18.44-fc-v180. CPU from `/proc/cpuinfo`: Intel(R) Xeon(R) Processor @ 2.30GHz, 4 logical CPUs. This is a shared cloud container.
- Command: `pnpm observe:m1-a13`, after `tsc --build` (the `@vector-studio/model` and `contracts` imports resolve to their built `dist`). There were five runs and three isolations, the defaults of `M1_A13_RUNS` and `M1_A13_ISOLATION_RUNS`. The total run time was 968 s.
- Raw record: [`m1-a13-observation-2026-10-28/record.json`](m1-a13-observation-2026-10-28/record.json), a copy of `.tools/m1-a13/record.json` formatted by Prettier.

## Numbers

All values are in milliseconds. Steps marked "renderer" are the part of the step above them spent inside the renderer's scene calls.

| Step | Median | Min | Max | Runs |
| --- | ---: | ---: | ---: | --- |
| parse | 132.2 | 112.4 | 151.8 | 148.9, 151.8, 132.2, 119.0, 112.4 |
| construct | 55.5 | 54.4 | 92.4 | 86.8, 92.4, 55.5, 54.4, 55.0 |
| project (page 1, no renderer) | 15.8 | 12.6 | 29.5 | 29.5, 18.3, 15.8, 12.6, 13.0 |
| attach | 125.4 | 119.0 | 178.3 | 178.3, 134.9, 119.0, 125.4, 124.3 |
| renderer (`replaceSnapshot`) | 101.2 | 96.7 | 140.9 | |
| move: pointer down | 12.7 | 10.3 | 23.8 | |
| move: five pointer moves | 430.1 | 406.1 | 521.1 | |
| renderer | 317.5 | 304.3 | 406.2 | |
| move: pointer up (commit) | 173.0 | 158.9 | 192.7 | 167.0, 174.2, 192.7, 173.0, 158.9 |
| renderer | 123.7 | 120.5 | 147.0 | |
| forced isolation (9,250 sets) | 322,725 | 309,753 | 327,048 | 309,753, 327,048, 322,725 |
| renderer | 322,471 | 309,424 | 326,776 | |

Generating the document took 32 ms. The first run is the slowest in most steps, because the JIT is still warming up.

## Observations

- **Forced isolation takes about 5.4 minutes** on this page. That is about 35 ms per one-unit set, and 99.9% of it is spent inside the renderer (the mirror's per-set validation), not in the projector. The contract already expects this: each one-node set re-validates the scene, so isolating a 10,000-node page costs on the order of n² work (section 5). But the size is far beyond an interactive budget. For a user, one rejected multi-unit set on a page this large would freeze the editor for minutes. Before M9, the scene surface needs either a cheaper path for isolation (validation that grows with the set, or batched units with bisection) or a limit that falls back to a full snapshot minus the culprits.
- **Gesture updates take about 86 ms each** (430 ms for five moves), and about 74% of that is renderer time. The editor side is about 22 ms per update. This includes the projector's whole-page diff from the M1-U3 notes: each change diffs the whole active page, which is O(n). Both shares grow with page size and are well above a 16.7 ms frame here. The commit takes 173 ms, of which 124 ms is renderer time and about 49 ms is the editor (refit, history, diff).
- **Load is fast compared with isolation.** Parse, construct and attach add up to about 313 ms. The pure projection takes 16 ms. Most of attach (101 of 125 ms) is the mirror validating the 10,634-node snapshot.
- The renderer share here is the renderer-core mirror on the CPU. The WebGPU host adds GPU upload and drawing, which this observation does not measure.

## Known limits

- One shared, 4-vCPU cloud container. No pinned frequency or isolation, and the Node version is not the pinned one. Medians come from five runs, or three for isolation. Spread across runs is up to 1.7x, from JIT warm-up and a noisy host.
- No browser, no GPU, and no pixels.
- The document is synthetic. Every leaf is small and the layout has no overlap between clusters, so hit testing during pointer down is not a worst case.
