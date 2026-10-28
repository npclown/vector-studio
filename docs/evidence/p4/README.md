# P4 exit record: clip and mask

This directory holds the P4 exit record (unit U6 of the [P4 contract](../../plans/p4-clip-mask.md#7-units), rendering-track item E21). It indexes P4-A01 to A11 against the evidence of units U1 to U5. P4 exits when the user accepts this record.

## Identities

| Identity             | Value                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Exit commit          | `9ef77b5` (U5, #290); headed evidence committed in #291 (`0a89f4e`)                                                 |
| Units                | U1 #285 `b5beb2c`, U2 #286 `e689d03`, U3 #287 `de49573`, U4a #288 `a91d8a5`, U4b #289 `0b9f749`, U5 #290 `9ef77b5` |
| Release WASM SHA-256 | `58f26517603d0d599f187481c967832e3f6abea2eb53c738e5540b6200b4fd35` (unchanged since the P3 exit)                     |
| Mesh shader SHA-256  | `d306137cf0770f6bf7f9237f1c98b9ecd0a165cfdbfda916196d299e36b831a3` (`p3-mesh-fill-v0`, pinned by E10-A1, unchanged) |
| Reference PC         | DESKTOP-DKVUSAV, Windows 11 Pro 10.0.26200, NVIDIA Turing, Node 24.22.1                                             |
| Browsers             | Chrome 156.0.8078.48, Edge 156.0.4314.42                                                                          |

## Status per criterion

| ID     | Evidence                                                                                                                                                | State |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| P4-A01 | `tests/unit/p4-u1-scene-clip.test.ts` (13 tests) in `pnpm check` on every PR since U1: S1 to S3 accept and reject with their reasons and precedence, depth after reparenting and reordering, the listed source cases, depth 32 accepted and 33 rejected (also through a reparent-only change set) | PASS |
| P4-A02 | [U5](u5/README.md) `images-*` in Chrome and Edge, four configurations (1x and 4x, DPR 1 and 2): every listed rect case; interior within 0.5/255 (tolerance 2), edge and corner probes within 3/255 of P4-K1 (tolerance 4) | PASS, against P4-K1 as amended 2026-10-28 (the formula is the reference; the rendered P1 rectangle is an observation, at most 1.1/255 on the reference PC) |
| P4-A03 | U5 `images-*`: both fill rules with a hole, fill-less and hidden path sources, rectangle, ellipse and line sources, at 1x and 4x; edge probes against the source's own fill draw (P4-K2); every source coloured and the content white, so a painted source would fail | PASS |
| P4-A04 | U5 `images-*`: depths 0, 1, 2 and 32 alternating rect and mask levels (depth 32 edge probes within 1/255); depth 33 rejected with `unsupported-feature` and the previous frame byte-identical in every configuration; unit part in P4-A01 | PASS |
| P4-A05 | U5 `images-*`: overlapping 0.5-opacity children in two nested masks match the oracle and differ from the double-opacity and reordered counter-oracles by more than 24/255 on the named probes; both siblings after the depth-32 subtree match their unclipped probes | PASS |
| P4-A06 | U5 `counters-4x-dpr1`: rect-clip edit, translate and rotate 0 port calls, 1 clip-state write, 0 mask passes; scale equal port calls with and without the clip (fresh pages, non-vacuous); mask source edit 1 port call and 1 mask pass; pan 1 mask pass; DPR change and resizes re-render the visible masks (1 mask pass each) and their interior probes match the oracle (the resize steps check no edge probes). Unit parts: `p4-u2-clip-states`, `p4-u4b-mask-passes` | PASS |
| P4-A07 | U5 `counters-4x-dpr1`: culled leaves add no instance or mesh draw; ten leaves under one clip state add one batch; paint order kept across state changes. Unit part: `p4-u2-clip-states` | PASS |
| P4-A08 | U5 `counters-4x-dpr1` and `budget-1x`: accounting above baseline while clipped and back to it after removal, at each resize and after device loss; recovered frame byte-identical; dispose leaves no texture or buffer; pan residency within the visible-mask bound; 5 of 20 full-surface masks report `render.clip-resource-limit` as a paint-order suffix with 62,914,560 resident bytes. Unit part: `tests/unit/p4-u4b-mask-passes.test.ts` checks that the mask passes create the transient 4x targets and the `stencil8` attachment and release the transients after each submission (the headed reports see only resident textures and buffers, since transients are gone by the time of the readback) | PASS, with the budget limitations below disclosed |
| P4-A09 | Full headed `pnpm test:gpu` on the reference PC at `9ef77b5`: 132 passed (66 per browser), operator-reported, artifacts not committed. Shader hashes and pipeline keys: E10-A1 (`tests/unit/e10-default-invariance.test.ts`) pins `MESH_FILL_SHADER` and the golden GPU call log, which records every shader module's code as a SHA-256 and every pipeline's label and descriptor; no P4 commit changed the test, the golden log or any existing `tests/gpu` file | PASS on hashes, keys and the suite; byte-identical captures against pre-P4 `main` not run (departure, see the note) |
| P4-A10 | U5 `images-*`: a 200,000-point source failing with `work-limit` draws nothing of the subtree and reports only its path failure; a singular clip container and a hidden container that is both clipped and a mask parent (one combined case) draw nothing and report nothing | PASS |
| P4-A11 | U5 `observation-1x` and `observation-4x` in both browsers: 10,000 nodes, 20 masks, 100 panned frames; median encode and submit 65 to 69 ms, median frame interval 66.7 ms, 1,935 mask passes | Recorded (observation only, no claim) |

**P4-A09 byte identity (departure, for the user's decision).** The criterion asks for byte-identical frame captures of an all-`clip: null` scene against `main` before P4. That comparison was not run, so this part is unverified. What stands in for it is weaker:

- The unchanged E10-A1 golden log records every GPU call for an unclipped scene, with shader code and buffer writes as SHA-256. It comes from a recorded mock GPU, not real frames, and its scene has no containers.
- The U3 rule says an unclipped draw always uses a base pipeline.
- The U3 software-GPU check found unclipped frames byte-identical with the clip option on and off. This compares P4 code with itself.
- The existing headed suite passes unchanged (132 of 132).

The headed comparison (a container scene with `clip: null` captured at `1eb65be` and at `9ef77b5` on the reference PC) can be run before or after the exit if the user asks.

## Disclosed limitations (accepted for the exit, backlog)

These were owed to U6 by the unit records. None affects an acceptance criterion as run. Items 1, 2, 4 and 5 are backlog item [E22](../../plans/d9-rendering-track.md); item 3 is an accepted cost with no planned remedy.

1. **Silent clip loss without variants.** When the clip pipeline variants are unavailable (the service option `clips` left at `'none'`, or variant creation failing), clipped draws are not drawn and no renderer-wide diagnostic is emitted outside the test hooks (U3). Remedy: a `render.*` diagnostic when a clipped packet meets a backend without variants.
2. **Untracked analytic variant on partial failure.** If a mesh variant fails to build, the analytic variant already built stays in the pipeline cache, untracked by resource accounting until dispose (U3). Remedy: build all variants before caching any.
3. **Unused mask sources still mesh.** A path mask source is meshed even when its level is unused or over budget, and a stroked source keeps its stroke slot (U4a). Accepted cost: one fill port call per such source, no draw.
4. **Transient budget mismatch.** The budget counts resident textures plus the largest transient pass, but every re-rendered pass in a frame holds its own transient attachments until submission, and a level whose size changed holds its old and new textures until the commit (U4b). Peak use can exceed 64 MiB in a frame that re-renders many masks. Remedy: sum the transients in the plan, or share one transient pair across same-size passes.
5. **4K full-screen mask at 4x.** A full-screen mask at 3840 × 2160 needs about 74.6 MB at 4x (8.3 MB resident, 66.4 MB transient), so a 4x 4K scene draws no full-screen mask under the 64 MiB budget and reports `render.clip-resource-limit` instead; at 1x seven fit (U4a). The product's default is 1x. U6 choice (the question U4a left open): the transient stays inside the budget, because the 256 MB working-memory ceiling counts it, and the remedy is to tile the 4x mask pass so its transient fits; E22 carries it with item 4.

## Exit decision

Decided 2026-10-28 by the user: P4 exits on this record as written, with the A09 byte-identity departure disclosed and the limitations in backlog E22.
