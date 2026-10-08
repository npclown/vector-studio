# D8: parallel visualization and engine tracks for P3

Status: user-approved on 2026-10-08. It changes P3 work order, the process tiers and the A04 verification method. No acceptance threshold changes.

## Decision and authority

On 2026-10-08 the user was shown the roadmap position:

- P0 complete;
- P1 and P2 functionally complete, with open performance gates;
- P3 still in contract work, with runtime acceptance A01-A08 all TODO;
- no path ever drawn on screen.

The user then chose, in chat:

1. "수직 슬라이스로 전환" (switch to a vertical slice). This was the recommended option.
2. "계획을 바꿔서 시각화하는것과 엔진을 같이 진행하는게 좋을꺼 같아" (change the plan so that visualization and engine work proceed together).
3. "이 구조가 좋을꺼 같아" (this structure looks good). This approves the two-track structure below.
4. From a list of further roadmap changes, the user selected three, all marked recommended:
   - lighter process for internal work;
   - a changed A04 verification method;
   - performance feasibility first.

   The user did not select starting P5 editor-core work in parallel, so P5 entry stays unchanged.
5. The user asked that the plans, written under Codex, be adapted to Claude Code, for example the model names. `AGENTS.md` now owns the role and model mapping and the branch prefix.

D8 follows [D7](p2-follow-on-entry.md). It narrows the roadmap rule that "later milestones do not begin when a foundational gate fails" only for P3's own internal order: P3 integration (P3.6) may proceed before P3.1-P3.5 acceptance. It does not authorize P4 or P5 entry.

## Two tracks

**Track A, visualization, leads.** Each checkpoint has a visible result.

| Checkpoint | Outcome | Needs |
| --- | --- | --- |
| V1 | Path scene and port proposal: path node, fill rule, path data, a mesh port that renderer-core consumes | User approval; an `ARCHITECTURE.md` update and an ADR, because it changes a boundary |
| V2 | A geometry-wasm fill-mesh export, added beside P2 ABI v1 without changing it, plus its adapter | V1 |
| V3 | A renderer mesh pipeline: a mesh draw variant, coverage by the [O02 A5 rule](p3-o02-a5-coverage-contract.md), and paint order interleaved with analytic primitives | V1 |
| V4 | A playground path page: fills, holes, both fill rules, pan, zoom and rotation, with headed screenshots | V2 and V3 |

**Track B, engine, supports.**

| Checkpoint | Outcome |
| --- | --- |
| B0 | **Performance feasibility first.** Measure whether the mesh approach can meet the roadmap workload of 1,000 paths × 32 cubics: tessellation time, mesh size and draw cost. Today a path is limited to 24 verbs and 4 contours. A negative result goes to the user as an architecture decision before B1 |
| B1 | Raise the fill-kernel caps toward that workload, in the direction B0 supports |
| B2 | Begin stroke: a stroke semantics and contract proposal. The user deferred only stroke-bound refinement; B2 needs its own approval before implementation |
| B3 | Fix kernel defects that Track A exposes, in the order A finds them |

**Parked.** The P3.1p precision-certificate line is paused. That covers the [T04 contract](p3-t04-sliver-mitigation-contract.md), which stays FROZEN and can resume unchanged, and the R2 revision 5 that would follow it. Its residual set R (16 ids, from [T03](../evidence/p3.1p-t03/review-2026-10-08.md)) is a known open risk, not a waiver.

## Roadmap changes adopted with D8

**Process tiers.** [`AGENTS.md`](../../AGENTS.md#change-workflow) now defines a full tier and a light tier.

- Full tier: a public API, a package boundary, an ABI, an acceptance criterion or threshold, or user-visible behavior. V1, V2's ABI, V3's draw contract and B2 are full-tier.
- Light tier: internal kernel and renderer work, tests, fixtures, tooling and demos. B0, B1, B3 and V4 are expected to be light-tier unless they touch a full-tier item.

**A04 verification method.** The target is unchanged: combined geometric error of at most 0.25 physical pixel across the declared transforms, zoom and DPR. What changes is how A04 is evidenced.

- **Primary evidence.** Measured error on a frozen, versioned corpus against an independent oracle, with rejecting positive controls.
  - The corpus covers the declared transforms, zoom 0.01/1/64 and DPR 1/2/3.
  - A sample that exceeds 0.25 px fails A04.
- **Certificates.** An exact certificate is no longer required for every transform. It stays as optional, stronger evidence for paths where it already exists, such as P2 flattening and the P3.1m position certificate.
- **Contract.** The A04 corpus and measurement contract is full-tier, frozen before its run.

**Performance feasibility first.** B0 runs before cap raising. The prototype plan's P3 workload stays the target.

## Rules

- **Contract first.** Every checkpoint is still its own plan item, at the tier above. Acceptance criteria and validation come before code, as `AGENTS.md` requires, and each checkpoint uses its own PR.
- **Ownership.** Track A owns `packages/contracts`, the geometry-wasm ABI and adapter, and the renderers. Track B changes kernel internals only. A B change that needs a new ABI field goes through Track A.
- **Evidence labels.** V2-V4 results are functional evidence. Until A04 has evidence, every screenshot and report states that precision is UNVERIFIED against the 0.25-pixel target.
- **Gates unchanged.** P3 A01-A08, the 0.25-pixel target, P1 A09/A10, P2 A08 and the P3-P5 exit gates stay as written. D8 changes order, process and the A04 evidence method, not any threshold.

## Dependency change

```text
D8 -> V1 (user approval) -> V2 + V3 -> V4
   -> B0 -> B1, B2 (approval before code), B3 (fed by V2-V4)
parked: P3.1p T04 -> R2 revision 5
P3 A01-A08 evidence -> P3 acceptance (unchanged)
```

## Risk

- **Rework.** The visible slice may be built on a kernel that later fails a precision gate. That would mean rework in the kernel, not in the API or the renderer. The parked line's residuals are sub-pixel needle and near-coincident-diagonal cases.
- **Shared seams.** Both tracks touch geometry output. The ownership rule above keeps the ABI and contracts single-owner.

Validation for this documentation checkpoint: Markdown formatting, local links and whitespace checks, plus the protected PR CI. No product, browser, GPU or benchmark run is required or claimed.
