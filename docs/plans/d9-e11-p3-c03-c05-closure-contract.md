# D9 E11: P3 C03-C05 closure and exit snapshot

Status: **DRAFT, 2026-10-24.** Written for independent review and user approval. Nothing here is in force until the user answers [E11-Q1 and E11-Q2](#9-decisions-for-the-user) in chat.

This is rendering-track item E11 ([D9 rendering track](d9-rendering-track.md#status-index)). It is full tier: it fixes how the P3 exit criteria A01-A08 are evidenced, and E11-Q1 and E11-Q2 change what the exit gate requires. It is a contract only. It changes no threshold, no tolerance, no frozen contract text and no product behavior. Identifiers use the prefix **E11-**.

## 1. Why this item exists

The [P3 private contract](p3-private-contract.md) owns C03-C05 and has been `PARTIAL` since 2026-09-29. The [P3 checkpoint table](p3-fill-stroke-meshes.md) defines them:

| ID  | Definition (quoted)                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- |
| C03 | Exact private fill/stroke numeric semantics, combined error budget, work limits and error precedence fixed with deterministic fixtures |
| C04 | Mesh ABI/version/layout, ownership, cache keys and stale/dispose behavior fixed without reinterpreting P2 v1                           |
| C05 | Independent oracle, positive controls, corpus, commands and evidence rules fixed before corresponding implementation                   |

They were written for a single prospective freeze before implementation. [D8](p3-d8-parallel-tracks.md) then changed the order: a functional transport and renderer were built under the [C04 carve-out](p3-private-contract.md#private-transport-and-lifetime-requirements), and A04 became a measurement on a frozen corpus. Each later unit froze its own fixtures, limits, oracles and commands, but nothing closed C03-C05. Two rules now block the exit:

- The P3 acceptance table: A01-A08 "are not executable acceptance until C03-C05 supply exact fixtures, tolerances and commands".
- The carve-out: "acceptance evidence counts only after C03-C05 are complete, on the frozen layout and carrier". [V-4](viz-v4-a08-corpus-contract.md) (VZ4-D4, VZ4-Q1) and [V-3](viz-v3-a07-integration-contract.md) (VZ3-Q9) wait on this.

D10 makes the P3 exit the next goal, so this item is in phase R1.

## 2. Approach

E11 does not re-specify anything that a frozen contract already fixes. It:

1. defines the **exit snapshot**, the one frozen layout and carrier on which all A01-A08 evidence runs (section 3);
2. maps every C03, C04 and C05 obligation to the frozen contract that fixes it, or to a decision or deferral here (sections 4 to 6);
3. gives, per exit criterion, the fixtures, the tolerance as already approved, the command and the record (section 7);
4. names the two new units that the map shows are missing (section 8).

C03-C05 are complete when this contract is approved and the exit snapshot record of section 3.2 exists. The private contract's status line then points here.

## 3. The exit snapshot

### 3.1 E11-K1: identities

Under E11-Q1 (a), "the frozen layout and carrier" is the following set, recorded by value:

| Identity                 | Current value on `main` dbbaaeb                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fill operation           | `geometry-wasm/fill-v0+r2`, `fill_v0_revision() == 2`, transport version 0 ([V2](p3-v2-fill-mesh-transport-contract.md), [Alt-A1](p3-alt-a1-fill-ladder-contract.md))                      |
| Stroke operation         | `geometry-wasm/stroke-v0+r4`, `stroke_v0_revision() == 4` ([B2 section 7](p3-b2-stroke-contract.md#7-kernel-export-stroke_v0_))                                                            |
| Release WASM             | SHA-256 of the built artifact at the snapshot commit                                                                                                                                       |
| Renderer mesh part       | Version 0, strides and offsets of [V3 section f](p3-v3-renderer-mesh-pipeline-contract.md#f-the-mesh-packet-part-and-the-mesh-draw); the WGSL shader-identity hash used by E3            |
| Carrier                  | K4 midpoint carrier with the per-view O-PX(128) origin ([V3 section f](p3-v3-renderer-mesh-pipeline-contract.md#f-the-mesh-packet-part-and-the-mesh-draw))                                  |
| Coverage and composition | A5 as realized by [V3 section e](p3-v3-renderer-mesh-pipeline-contract.md#e-a5-coverage-on-k4), the D8-interim TypeScript fringe builders, ST-U7 joint coverage                             |
| Failure outcome          | The D8-interim V1-Q4 outcome: a path the kernel cannot mesh is not drawn and gets a warning diagnostic                                                                                      |

### 3.2 Snapshot record and invalidation

- **When.** The snapshot is taken after the last planned output-changing change of R1: E8-U2 and, if A01 promotes it, E7. E10 adds test hooks only and does not change output when they are off; it may land before or after.
- **Record.** A dated "**Exit snapshot record**" line is appended to this contract with the commit, every identity of E11-K1 and the E3 `corpusSha256`. The record is made by a docs PR, after `pnpm build` and `pnpm test:geometry` pass at that commit.
- **Invalidation.** Evidence for A01-A08 counts only if its record names the snapshot identities. A later change to any identity invalidates every criterion whose evidence depends on it: a fill or stroke operation change invalidates A01-A04 and A08; a mesh part, shader or carrier change invalidates A04, A07 and A08. Affected criteria are re-run on a new snapshot record. Evidence produced before the record is `PRE-FREEZE` and closes nothing, as V-4 already rules.

## 4. C03: numeric semantics, budget, limits and precedence

| C03 obligation                                         | Fixed by                                                                                                                                                                                                         | State under E11 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Separate P3 operation and budget identity              | V2 section a (operation identity rule), B2 section 7.1                                                                                                                                                           | Fixed           |
| Fill tolerance and bucket                              | V2 section d; V3 section c (`2^e · sigmaMax(S) ≤ 0.125` by exact predicates)                                                                                                                                     | Fixed           |
| Stroke semantics, caps, joins, miter, degenerates      | B2 sections 2 to 4; [visible semantics](p3-visible-semantics-proposal.md)                                                                                                                                        | Fixed           |
| Combined 0.25 physical-pixel budget                    | Total measured by [E3](d9-e3-b4-precision-contract.md) (A04). The three private-contract rows stay design allocations, not gates (E3 section 1.2)                                                                 | Fixed (D8)      |
| Stroke-boundary error not proved by centerline closeness | E3 measures the drawn stroke region against an ideal stroke region (E3-K1, K4), never a centerline. D8 made a certificate optional                                                                              | Fixed (D8), E11-R1 |
| Work limits with limit and limit + 1 fixtures          | `FILL_V0_LIMITS` and the B1 caps addendum (V2); `STROKE_V0_LIMITS` (B2 section 7.6), SC17; E1 early abort                                                                                                       | Fixed for v0    |
| Error precedence, per-path versus batch                | V2 section e; B2 section 7.8; V3 sections b, d, h (bisection isolation)                                                                                                                                         | Fixed           |
| Distinguishable topology-ambiguity failure             | v0 folds it into `unsupported-geometry` (V2 section l item 3)                                                                                                                                                    | Deferred, E11-Q1 |
| Final failure behavior (U2, U4)                        | D8-interim V1-Q4 outcome                                                                                                                                                                                         | Deferred, E11-Q1 |
| Deterministic fixtures                                 | F01-F11 and S01-S03 of the private contract, realized in the line-fill and fill-region oracle tests and V3-A11; V2 C01-C18; ST-F1 to ST-F26 and SC01-SC22; the frozen E3 corpus                                  | Fixed           |

**E11-R1 (reading, for review).** The private contract says "Do not mark C03 complete by substituting the P2 centerline oracle for a stroke-boundary proof". E11 reads D8 as replacing the proof by E3's region measurement, which is not a centerline substitute. If review rejects this reading, C03 needs the parked stroke certificate line and E11-Q1 must be asked again.

## 5. C04: layout, ownership, cache and lifetime

C04's six items are fixed functionally, item by item, in [V2 section l](p3-v2-fill-mesh-transport-contract.md#l-c04-items-1-6-what-v0-fixes-and-leaves-open), [V3 section j](p3-v3-renderer-mesh-pipeline-contract.md#j-c04-items-for-v3) and [B2 section 10](p3-b2-stroke-contract.md#10-c04-items-for-the-stroke-transport-and-draw), with ST-U6 and ST-U7 closing fill and stroke ordering and joint coverage. Under E11-Q1 (a), C04 is complete **for the P3 exit** on that functional layout, frozen by the snapshot. What those sections leave open moves, unchanged, to backlog item **E12** (production mesh layout):

- version negotiation beyond exact match and the final operation and budget identity scheme (item 1);
- the M01-M06 position certificate, Float32 packing beyond K4, the K1 carrier with E1 shared records, region labels (item 2);
- explicit product limits and a distinguishable topology-ambiguity failure (item 3);
- a shared-arena design (item 4);
- per-cell cache identity under E2 (item 5);
- tile caches and epoch builds under E2 (item 6).

The R2 direction (K1, E1-E3) and the U2 failure-path decisions stay in force as directions; E12 owns them. The carve-out's statement that a later C04 layout may replace v0 "without a requirement change" still holds, and such a replacement re-runs the exit criteria it touches (section 3.2).

## 6. C05: oracles, controls, corpus, commands and evidence rules

| C05 obligation       | Fixed by                                                                                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Independent oracles  | `packages/geometry-reference` (fill region, triangle mesh, stroke region, continuous error); the E3 oracle (E3 sections 4 and 14); ST-O1 to ST-O5; O02 `checkPartition`; V-3's painter's-order oracle                          |
| Positive controls    | Private contract list (missing or duplicated triangle, wrong parity, flipped or out-of-range index, NaN, bounds, cap, miter, stale echo, ownership), realized in the [mesh oracle](p3-mesh-oracle-contract.md) M01-M06 rejections, B2 section 11.3 seeded defects and V2 C01-C18; E3-PC1 to PC14 and E3-D1 to D14 |
| Corpus               | `a04-corpus/v1` with its freeze record (E3 section 5.5); the named fixture sets above; the P3 stress scene of E11-U2                                                                                                             |
| Commands             | Section 7. A command not in `package.json` today is introduced by its own unit (section 8) before use                                                                                                                           |
| Evidence rules       | E3 section 7.4 for A04; V-4 for A08; section 7.1 here for the rest                                                                                                                                                                |

## 7. Exit evidence per criterion

Requirement text and thresholds stay in the [P3 acceptance table](p3-fill-stroke-meshes.md#runtime-acceptance-coverage-to-freeze-in-p30b). "CI" is the protected Windows CI. "PC" is a headed run on the user's PC through Remote Control; GPU results hold for the recorded adapter and browsers only, and other adapters stay UNVERIFIED.

| ID  | Fixtures and corpus                                                                                                       | Tolerance (as approved)                                                                                          | Command and where                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| A01 | `a04-corpus/v1` geometry and the P3 stress scene through the release WASM; V2 C01-C18, SC01-SC22 caps and limit + 1; E1 corpus | Zero invalid indices, non-finite vertices, bounds violations or failed isolation; watertight under f32 (A01 amendment, E3-Q10 (b)): E3's crack width must be 0 | `pnpm p3-exit:sweep` (E11-U2), CI; `pnpm test:geometry`, CI; E3 crack report, PC                     |
| A02 | F01-F11 and the line-fill 32 cases against the fill-region oracle; V2 C01-C18; V-4 fill-rule rows                        | Exact membership and area (oracle tests); image: Q4 interior and exterior within 2/255 against oracle colors     | `pnpm check`, `pnpm test:geometry`, CI; V-4 headed run, PC                                             |
| A03 | ST-F1 to ST-F26 with ST-O1 to ST-O5; SC01-SC22; ST-U6 and ST-U7 headed specs                                              | Literal expectations of B2 section 11.2; ST-A10 probes                                                           | `pnpm check`, `pnpm test:geometry`, CI; `pnpm test:gpu` (stroke specs), PC                             |
| A04 | `a04-corpus/v1`, frozen                                                                                                   | E3 section 7.3 pass rule, ≤ 0.25 physical px                                                                     | `pnpm e3-a04:run` and the E3-U5 readback, PC; record under `docs/evidence/e3-a04/`                     |
| A05 | V2-A3, V2-A5, C01-C18; B2 SC01-SC22 (capacity, epochs, owned copies, dispose, isolation)                                  | Exact expectations of those suites                                                                               | `pnpm test:geometry`, `pnpm check`, CI                                                                 |
| A06 | V3-A2, A3, A5 to A7; B2 section 9.3 tests; V-3 port-call deltas                                                            | Exact call counts and byte accounting of those criteria                                                          | `pnpm check`, CI; V-3 headed spec, PC                                                                  |
| A07 | V-3 (VZ3-A3 to A14) plus its "remains open" rows that do not move to E12                                                  | VZ3 section 4                                                                                                     | `pnpm test:gpu` (`viz-v3-integration.spec.ts`), PC                                                     |
| A08 | V-4 named subset                                                                                                          | V3 section k: Q4 at DPR 1, 1.5, 2 on the fringe at 1x and 4x; MSAA-only reported                                 | V-4 headed run, PC                                                                                     |

### 7.1 Evidence rules for A01-A03 and A05-A08

- Every row is run at the snapshot commit, clean, and its record names the E11-K1 identities. A CI run is cited by its run URL and commit; a headed run follows the metadata of [accepted reference runs](../benchmarks/README.md#accepted-reference-runs) (OS, GPU, driver, browser and version, DPR, flags), without timing.
- Records go to `docs/evidence/p3-exit/<snapshot short SHA>/`, one file per criterion, immutable once committed. A04 and A08 keep their own record locations and are linked from there.
- A row is marked done in the [X1 index](d9-rendering-track.md#p3-exit-evidence-index-x1) only after an independent evidence review. The Primary accepts the exit; the user approves it (D10 R1 gate).
- Every result before the snapshot record keeps the UNVERIFIED and `PRE-FREEZE` labels.
- **"Expected reference images" (E11-R2, reading, for review).** The prototype exit gate says fill-rule fixtures "match expected reference images". E11 realizes this as per-pixel expected colors computed from the independent oracle under the Q4 gates, as V3-A14 and V-4 already do, not as stored PNG files. No implementation output is ever used as an expected image.

### 7.2 Known defects at the exit

The exit gate requires "no crashes, invalid indices, NaN vertices, or out-of-range writes on the corpus". It does not require every path to mesh. Two known classes fail by design today: the seven ST-U3f cases (E4, kept as a known defect with fixtures by D10) and any E8 residue after E8-U2. E3 excludes rejected cases from A04 and reports them (E3-Q3). Under E11-Q2 (a), the exit accepts a **closed list** of named known defects, recorded in the snapshot record, each with a fixture and a backlog item; any other ordinary fixture that fails to mesh fails A02 or A03.

## 8. Units

| Unit   | Content                                                                                                                                                                                                                                       | Tier  |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| E11-U1 | This contract; the status pointers in the private contract, the P3 plan and the rendering track; E12 in the backlog                                                                                                                         | Full  |
| E11-U2 | `pnpm p3-exit:sweep`: a deterministic Node runner over the release WASM that feeds every fill and stroke request of `a04-corpus/v1` and a seeded stress scene (1,000 paths × 32 cubics, the prototype plan's scene) and checks structure with its own checker (in-range indices, finite vertices, enclosing bounds, nondegenerate counter-clockwise triangles, conformity), written independently of the adapters and cross-checked against the `triangle-mesh` oracle on meshes within that oracle's 256-triangle cap. Writes a record per section 7.1. Seeded positive controls (a corrupted index, a NaN vertex, an out-of-range range) must be rejected | Light |
| E11-U3 | The exit snapshot record (section 3.2) and the evidence collection run: CI rows, then the PC headed rows in one Remote Control session                                                                                                     | Full  |

E11-U2 adds a tool and tests only; it changes no package output. Its scene generator and seed are committed before its first run.

## 9. Decisions for the user

| ID     | Question                                                                                                                         | Options                                                                                                                                                                                                                                                                                                                         | Recommended |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| E11-Q1 | What is "the frozen layout and carrier" for the P3 exit?                                                                         | (a) The functional v0 layout on K4, frozen by the E11-K1 snapshot; the open C04 parts move to E12 after the exit. (b) The full C04 joint freeze, including K1 with E1-E3 and a production failure behavior, before the exit; this adds the R2 tiling implementation and a new failure contract to R1                           | (a)         |
| E11-Q2 | May the exit pass with known `unsupported-geometry` defects?                                                                     | (a) Yes, a closed named list (E4's seven ST-U3f cases and the E8 residue after E8-U2), each with a fixture and backlog item; nothing else may fail. (b) No; promote E4 and finish E8 so every named fixture meshes before the exit                                                                                             | (a)         |

Why (a) for E11-Q1: every R1 contract (E3, V-3, V-4) already measures the v0 layout on K4 and names those identities in its record, and the D9 tracks were built on it. Option (b) moves the exit by the size of R2, which the [U2 direction](p3-private-contract.md#user-decisions-on-mesh-position-representation-2026-10-06) never scheduled for P3. Option (a) changes no threshold: it decides which layout the unchanged thresholds are measured on.

Why (a) for E11-Q2: the exit gate's wording is about crashes and invalid output, which the known defects do not cause, and D10 already chose to keep E4 as a known defect. Option (b) is the stricter reading and adds E4 to R1.

## 10. Acceptance and validation for this contract

| ID     | Criterion                                                                                       | Method                                                                                             |
| ------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| E11-A1 | Every C03-C05 obligation of the private contract maps to a row in sections 4 to 6               | Independent `reviewer` review against `p3-private-contract.md`                                     |
| E11-A2 | No threshold, tolerance or frozen contract text changes; E11-R1 and E11-R2 are accepted readings | Review of the diff                                                                                 |
| E11-A3 | E11-Q1 and E11-Q2 answered by the user                                                          | Chat record, transcribed here with the date                                                        |
| E11-A4 | Documentation checks                                                                            | `pnpm exec prettier --check` on changed Markdown, local link and anchor check, `git diff --check`; CI |

No product, browser, GPU or benchmark run is claimed by this contract.

## 11. Review and approval record

Pending.
