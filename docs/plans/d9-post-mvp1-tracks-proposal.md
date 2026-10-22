# D9: post-MVP 1 rendering and visualization tracks (proposal)

Status: DRAFT, 2026-10-22. Pending independent review and user approval. Nothing here is in force until the user approves it in chat. It is a full-tier process and ownership proposal. It changes no requirement, no threshold, no acceptance criterion and no milestone gate.

## Decision and authority

On 2026-10-22 the user decided in chat (paraphrased from the Primary's record):

1. MVP 1 is cut by the weekend of 2026-10-24 and 2026-10-25 and tagged `mvp-1`. The cut itself is recorded in the [P3 status index](p3-fill-stroke-meshes.md#d8-parallel-visualization-and-engine-tracks).
2. After the cut, development splits into two parallel tracks that raise features and performance independently: a **rendering track** (the engine) and a **visualization track**.
3. The first items of each track, the ownership boundary and the operating model below follow that direction. The user gave the direction, not this text, so every point here is a proposal to confirm.

D9 follows [D8](p3-d8-parallel-tracks.md). D8's "Track A, visualization" and "Track B, engine" were a P3-internal ordering. Track A owned the ports and Track B changed kernel internals only. D9 replaces that split after MVP 1 with a split by package ownership and retires the names Track A and Track B (see [D9-Q5](#open-questions-for-the-user)). D8's rules that are not about ownership (evidence labels, gates unchanged, the C04 carve-out) stay in force.

## Two tracks

### Rendering track (engine)

Owns `packages/geometry-wasm` (the kernel and its adapters), `packages/geometry-reference`, `packages/renderer-core` and the benchmarks (`docs/benchmarks/` and the harnesses behind them). Its goals are precision (the 0.25 physical pixel target, A04), work limits, performance and memory.

The first items, in this order:

| Order | Item                                                               | Tier  | Outcome                                                                                                                                                                                                                                                                                                      |
| ----- | ------------------------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E1    | ST-U9 (c): early abort when failure is certain                     | Full  | The stroke arrangement stops once its node or section count makes a `work-limit` failure certain, instead of spending up to about 0.8 s on a failing crossing stroke (recorded in the ST-U9 recommendation of the [P3 plan](p3-fill-stroke-meshes.md)). It needs a contract decision on what "certain" means |
| E2    | ST-U9 (a): family-B fast-rung contract                             | Full  | The certified direct-tessellation fast rung for strokes: consecutive non-overlapping pieces are meshed directly, and family A is the fallback where the certificate fails. The contract fixes the certificate, the fallback rule and its own performance gate before code                                    |
| E3    | B4: A04 corpus and measurement contract                            | Full  | The frozen, versioned corpus, the independent oracle from `geometry-reference`, the rejecting positive controls and the measurement run of [D8 B4](p3-d8-parallel-tracks.md#two-tracks). Until it has evidence, every result keeps the UNVERIFIED precision label                                            |
| E4    | ST-U3f fix decision                                                | Full  | A decision between the two deferred candidates recorded in the P3 plan: A1 (rounded-fill pin fall-through; it changes the V2 rounded-fill contract and six frozen fixtures) and S2 (a section 4.2 near-coincidence rule with an ST-G1 error argument). Until decided, the seven cases stay a known defect    |
| E5    | Measurements of the scopes the AL-Q6 (b) wording leaves unmeasured | Light | Measurements outside the committed baseline: unsnapped coordinates, crossings, the zoom range 1% to 6400%, strokes, and lower-tier hardware. A contract that fixes a decision rule is full tier; its run is light tier. See [D9-Q6](#open-questions-for-the-user) on what "AL-Q6 (b)" refers to              |
| E6    | Retire the D8-interim TypeScript overlay and fringe builders       | Full  | The time-bounded exception in [graphics-engine-architecture.md](../graphics-engine-architecture.md#anti-aliasing) ends at the R2/K1 placement decision. Moving the builders into the kernel changes the port output, so it is a contract change reviewed by both tracks (see [Boundary](#boundary))          |

E1 comes before E2 because the early abort is a smaller, independent bound on the failing cost and needs no new certificate. E3 can run in parallel with E1 and E2 if the rendering track has capacity, because it touches the corpus and the oracle and not the stroke kernel.

### Visualization track

Owns `apps/playground` and the future editor app, scene and document features, and UI. It uses only the published ports (`FillMeshPort`, the stroke mesh port) and the packet formats. It does not edit `packages/geometry-wasm`, `packages/geometry-reference`, `packages/renderer-core` or the benchmarks. Where it finds a defect or a missing capability, it files a rendering-track item with a fixture.

**First items: to be proposed with the user.** No feature list is decided. [D9-Q4](#open-questions-for-the-user) offers concrete options drawn from [`docs/requirements.md`](../requirements.md).

Packages not named above (`packages/contracts`, `packages/renderer-webgpu`) are shared. A change there that is not a contract change belongs to the track whose item needs it, and the PR description tells the other track. A `packages/contracts` change that alters a port is a contract change.

## Boundary

The tracks share only the port contracts and the operation identities (`geometry-wasm/fill-v0+rN`, `geometry-wasm/stroke-v0+rN` and their successors).

- **A contract change is full tier and is reviewed by both tracks.** That covers a port interface, a packet format, an operation identity or revision, an ABI field and a diagnostic code that a host reads. The review checks that the other track's consumer still works.
- **Within a contract, each track merges independently.** The rendering track may change kernel internals, limits and speed while the operation identity rules hold. The visualization track may add pages, scene features and UI that use the ports as published.
- **An outcome-changing kernel change bumps the operation revision** as today, so the visualization track sees a revision change and never an unannounced behavior change.
- **Durable document data stays independent of renderer, GPU and WASM objects** ([`AGENTS.md`](../../AGENTS.md#working-rules)). Scene and document features on the visualization track store only durable data. Meshes, GPU buffers and WASM allocations remain reconstructible caches.
- **No new dependency or renderer is implied.** [`AGENTS.md`](../../AGENTS.md#working-rules) still requires a new architecture decision and explicit user approval for a runtime renderer, scene graph, path renderer or tessellation dependency.

## Baseline and performance claims

The MVP 1 benchmark records are the comparison baseline. Any performance claim by either track needs a committed result record that follows [`docs/benchmarks/README.md`](../benchmarks/README.md) and compares against that baseline. A result cannot redefine its threshold. The visualization track makes no kernel performance claim; if a page needs a number, it asks the rendering track for the record.

## Operations

- **Lanes.** Each track has one development lane and one verification lane, four agents in total. A verification lane runs the fixed validation commands for its track and never edits the code it verifies. The independent `reviewer` in a fresh context is still used for full-tier contracts and evidence.
- **Branch prefixes.** `claude/eng-<item>-<slug>` for the rendering track and `claude/viz-<item>-<slug>` for the visualization track, for example `claude/eng-e1-stroke-early-abort`. This is an **amendment proposal for the branch naming in `AGENTS.md`**, which currently names `claude/<plan-item>-<short-slug>`. `AGENTS.md` is not edited by this proposal, and existing prefixes apply until it is amended.
- **Plan documents.** One plan per track, named per [D9-Q1](#open-questions-for-the-user). Proposed names: `docs/plans/eng-rendering-track.md` and `docs/plans/viz-visualization-track.md`. Each holds its status index, items, acceptance criteria and evidence. `docs/plans/p3-fill-stroke-meshes.md` keeps the P3 history and the P3 acceptance table.
- **Integration checkpoint.** A weekly checkpoint on shared `main`: the full GPU specs, a demo of the visualization track's current page, and a comparison against the MVP 1 baseline of any rendering-track claim made that week. It records what ran and what did not (NOT RUN with a reason), and it does not replace per-PR CI. Cadence: [D9-Q3](#open-questions-for-the-user).
- **Shared `main`.** Both tracks merge to `main` through pull requests, squash merge by default, with independent review per PR as today (full tier: contract review and evidence review; light tier: one review of the diff and CI). Each track rebases onto the updated `main` before it opens a PR.
- **Conflict rule.** If a PR needs a change in a package the other track owns, the PR is split, and the owning track merges that part first as its own PR.

## Relation to the milestones

D9 changes work order and ownership only. [`docs/prototype-plan.md`](../prototype-plan.md) is not changed in substance, and no milestone gate moves.

| Milestone | Mapping under D9                                                                                                                                                                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P3        | MVP 1 is a P3 delivery cut, not the P3 exit. The P3 exit gate (A01-A08, the 0.25 px target, the corpus and cache criteria) is closed by the rendering track's work, with the visualization track supplying the headed pages that A07 and A08 need. Whether the rendering track owns the exit is [D9-Q2](#open-questions-for-the-user) |
| P4        | Clip and mask. Entry rule unchanged: it begins after the P3 gate or by an explicit design revision. Renderer work belongs to the rendering track and scene-side clip nodes to the visualization track, joined by a port contract that is full tier                                                                                    |
| P5        | Editor integration slice. The editor app, commands, selection and the JSON round trip are visualization-track work. P5 entry is not changed by D9; the user did not select starting it in parallel at D8                                                                                                                              |

The visualization track's first items are product features on top of the P3 ports. They do not count as P4 or P5 work unless an item is part of the P5 slice itself, and then P5 entry applies.

## Documents that need amendment on approval

Listed only. This proposal edits none of them.

| Document                              | Amendment                                                                                                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`                           | The branch prefixes `claude/eng-` and `claude/viz-`; the read-order and documentation-ownership entries for the two track plans; the two-lane agent model |
| `docs/prototype-plan.md`              | The "Current position" entry for P3 (D9 after D8); no gate change                                                                                         |
| `docs/plans/p3-d8-parallel-tracks.md` | A dated status note that D9 supersedes the Track A and B ownership split after MVP 1 (D9-Q5)                                                              |
| `docs/plans/p3-fill-stroke-meshes.md` | The status index and the **Next** paragraph point to the two track plans; B-item rows move to the rendering track plan                                    |
| `docs/validation.md`                  | Only if the weekly checkpoint becomes a validation layer or evidence requirement (D9-Q3)                                                                  |
| `ARCHITECTURE.md`                     | Only if package ownership by track is to be stated there. Dependency direction is not changed                                                             |
| The two track plan documents          | New, created at approval                                                                                                                                  |

## Open questions for the user

Each question lists the recommended option first.

| ID    | Question                                            | Options                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D9-Q1 | Track plan document names                           | (a) `docs/plans/eng-rendering-track.md` and `docs/plans/viz-visualization-track.md`, matching the branch prefixes. (b) `docs/plans/d9-rendering-track.md` and `docs/plans/d9-visualization-track.md`, tied to this decision. (c) One shared `docs/plans/d9-tracks.md` with a section per track (less isolation, fewer files)                                                                                                                                                                                                                                                                                                                                                                                                     |
| D9-Q2 | Who owns the P3 exit gates (A01-A08)                | (a) The rendering track owns them, with the visualization track supplying the headed pages for A07 and A08. (b) The Primary owns them in `p3-fill-stroke-meshes.md`, and both tracks feed evidence. (c) Defer P3 exit until after the first visualization feature set                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| D9-Q3 | Cadence of the integration checkpoint               | (a) Weekly, on a fixed day, with the full GPU specs, a demo and a baseline comparison. (b) Per merged contract change, plus a monthly full run. (c) Every two weeks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D9-Q4 | The visualization track's first feature set         | (a) Appearance on paths: solid fill, stroke color and width, caps and joins, opacity (requirements: initial appearance model; needs only the P3 ports, smallest). (b) Document and persistence: a JSON-serializable page of nodes with a round trip and no editor UI (requirements: document, persistence). (c) Viewport and layers: zoom and pan, grouping, layer reordering and a minimal layer panel (requirements: editing behavior). (d) A selectable, movable scene: rectangle, ellipse, line and path creation with click and marquee selection, move and resize (requirements: node types, editing behavior; closest to the P5 slice, so it needs P5 entry to be decided and is the largest). Recommended: (a), then (b) |
| D9-Q5 | Whether the Track A and B names from D8 are retired | (a) Retired for post-MVP 1 work; D8 history keeps them and gets a status note. (b) Kept as aliases (Track A is visualization, Track B is engine) beside the new names. (c) Retired, and D8 is also amended in place to use the new names                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D9-Q6 | What E5 means by "AL-Q6 (b)"                        | The decision wording names "AL-Q6 (b) unmeasured scope". In the [fill ladder contract](p3-alt-a1-fill-ladder-contract.md) AL-Q6 is the question of when B1 starts, and its option (b) is B1 in parallel with the gate. (a) Treat E5 as the list in the rendering track table (unsnapped coordinates, crossings, zoom range, stroke, lower-tier hardware), independent of that label. (b) Name a different source for the scope list                                                                                                                                                                                                                                                                                              |

## Risks

- **Shared seams.** Both tracks touch the port output. The boundary rule and both-track review keep the contracts single-owner, but a contract change slows whichever track proposes it.
- **Rendering track load.** E1-E6 are mostly full tier, with contracts before code. The visualization track can run ahead, so its features may expose defects faster than the rendering track closes them. Defects go to the rendering track as items with fixtures.
- **Verification lane independence.** A verification lane shares context with the developer lane of its track. The fresh-context `reviewer` stays the independent check.
- **Branch prefix change.** Tooling or scripts that match `claude/` branches must still match the new prefixes. This is checked at approval, not here.
- **Precision stays UNVERIFIED.** Until E3 has evidence, every visualization result carries the UNVERIFIED label required by D8.

## Validation for this checkpoint

Markdown formatting, local links and anchors, whitespace checks, plus the protected PR CI. No product, browser, GPU or benchmark run is required or claimed. After approval, the independent review and the user's answers to D9-Q1 to D9-Q6 are recorded here with a date, and the documents above are amended in a separate PR.
