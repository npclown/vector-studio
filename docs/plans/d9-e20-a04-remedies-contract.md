# E20 contract: A04 remedies (E3-U7)

Status: DRAFT 2026-10-28, Full tier (measurement harness, record format, A04 known classes and dated amendments to E3 section 22 (and 14.7 under E20-Q3 (b)); no kernel or `packages/` change). Rendering-track item [E20](d9-rendering-track.md#status-index). The user ordered E20 after E22 on 2026-10-28.

Owners: this file owns E20's rules, units, acceptance and the new A04 record. The [E3 contract](d9-e3-b4-precision-contract.md) keeps the metric (E3-K1 to K5), the oracle and its freeze record (section 19.7), the corpus, the 0.25 px threshold, the pass rule (section 7.3), the no-flip certificate (section 15.4), the flip-tolerant bound (section 20) and the three known classes of section 21. E20 changes only what section 2 names. It appends to E3 a pointer to the new record and the two amendments of E20-K5 and K10.

## 1. Scope

The [2026-10-27 reference run](d9-e3-b4-precision-contract.md#23-e3-u5-reference-run-record-2026-10-27) measured A04 **FAIL**: 5 FAIL and 1,924 UNDECIDED rows outside the known classes (section 23.2 to 23.4). E3 section 23.5 lists the remedies (E3-U7). Re-counted from the committed `record.json`:

| Bucket (record reason, `flipTolerant.reason`) | Rows | Strata (largest) | E20 answer |
| --- | --- | --- | --- |
| FAIL: `C1/g0029/T2`, sub-pixel shape whose mesh triangles all collapse | 5 | C1 | E20-K7 (Q1) |
| No-flip certificate, clipped draw (bound not run) | 658 | C5 stroke 262, C3 fill 151, C9 stroke 98 | E20-K1 |
| No-flip certificate, zero-area triangle off `M*` | 304 | C3 147, C2 95, C1 58 (all fill) | E20-K2 |
| `window-empty` within the guard (all with clipped triangles, `β_c ≤ 0.17`) | 261 | C5 79, C4 60, C1 33 | E20-K4 |
| No-flip certificate, edge with triangles on both sides (T-junction left open in the chain) | 217 | C9 stroke 121, C5 stroke 60, C2 27 | E20-K6 |
| No-flip certificate, boundary offset | 208 | C3 96, C5 35, C4 34 | E20-K3 |
| Straddles at the floor: 99 on the flip-tolerant bound, with `ρ` from 0.175 to 0.498 (median 0.36) and `E_hi ≤ 0.094` (85 of them `≤ 0.04`); one no-flip row with `β_c = 0.301` | 100 | C3 37, C5 37, C2 12 | E20-K3 (the 99) |
| Oracle work cap (`gcd step`, `rational`, `distance query`, `seam split`, `membership`); 117.5 worker-hours to reach the cap, median 45 min | 152 | strokes 136 (C5, C9), fills 16 | E20-K5 (Q3) |
| No-flip certificate, edge below binary64 | 24 | C9 18, C12 6 | E20-K3 |
| Record writer: `+∞` written as `null` | — | — | E20-K8 |

Out of scope:

- the metric, the window, the threshold, the corpus and the oracle source: the freeze record of E3 section 19.7 stands, and no re-freeze is needed;
- the fill and stroke kernels (`fill-v0+r4`, `stroke-v0+r7`): a kernel change would need a full re-run and the A01/A02 identity runs;
- E7 (conforming refinement), E18 (far-vertex carrier) and E19 (stroke zero-area triangles), except that E20-K2 may also decide rows now disclosed under E19's class;
- the GPU model check (E3-A6): E20 changes no shader, WASM or product path, so the 2026-10-27 check on the named subset stands;
- the evidence review of the 2026-10-27 record: it is not done separately. The E20 record's review (E20-A7) covers its carried rows too.

## 2. Rules

Every rule below is harness or record code under `tests/geometry/e3-a04/` or `tooling/run-e3-a04.mjs`. **Gating.** Each new path runs only where the 2026-10-27 harness ended a row UNDECIDED, behind the predicate that ended it (the failed no-flip certificate with a clipped triangle, a failed precondition, a failed offset search, a failed `window-empty` guard). A row that the old harness decided never reaches new code, so its values do not change. U1's review checks each predicate in the code, and E20-A5 checks the result on a sample. K8 changes only how `+∞` is written.

**E20-K1 (flip-tolerant bound on clipped draws).** The bound of E3 section 20 also runs when triangles cross the guard band. `M*` stays unclipped, as E3-K3 and the no-flip path take it. The clip polygons model only the GPU image: the visible part of a crossing triangle is within `β_c` of the moved unclipped triangle intersected with the viewport, because `β_c` includes `β_clip` (section 15.3). A shared clipped edge can open a hairline crack, because the GPU makes clip vertices per triangle (E3 section 19.1). As for T-junction cracks under E3-Q10 (b), the bound is stated on the crack-closed region: each shared clipped edge gets one clip point, placed within `β_clip` of the exact one. The crack is not scored by A04. Who owns clip cracks is open, because A01's crack report counts T-junctions only; U4 records it as a question for the P3 plan, which owns A01. The extension of section 20.2 and its proof are an annex written in U1 and independently reviewed before U3. If the review rejects the proof, K1 is dropped and its rows stay UNDECIDED.

**E20-K2 (zero-area triangles inside `M*`).** Precondition 1 of section 20.1 is relaxed. A zero-area triangle whose box meets `Ω ⊕ 3` is admitted when its segment lies in `M*`, by exact membership on the segment's pieces between its crossings with chain edges, and when every chain edge it adds satisfies precondition 2. Pieces are split at proper crossings, at chain vertices and at collinear overlaps. On the GPU the triangle opens into a sliver within `β_c` of a segment of `M*`, so `M_gpu ⊂ M* ⊕ β` still holds. The triangle's edges are already in the chain `C*`, and precondition 2 still binds them, so an interior zero-area triangle is admitted only when its edges cancel or are covered on one side. Today's rule, that the segment be covered by collinear edges, is a special case. A zero-area triangle with any point off `M*` keeps the case UNDECIDED. K2 applies to both paints. A stroke row that it decides leaves E19's `degenerate-stroke-triangle` class.

**E20-K3 (tighter offset certificate).** Section 20.3's search runs first, unchanged. Only when it fails, or when it gives `U > 0.25 ≥ L`, a refined search runs. Directions are taken every 15° within ±75° of the outward normal. Offsets start at `1.0625·β` and grow by a factor of `2^(1/4)`. Splitting goes to depth 16, no shorter than `β/8`. The work cap of `5·10^7` units stays. An edge whose binary64 offset test cannot separate (`edge below binary64`) falls back to the exact dyadic test of the translate against every candidate edge. `ρ = max(β_c, D_hi)` and `U = E_hi + ρ` are unchanged; the record keeps the smaller `D_hi` of the two searches. A row decided by the old search keeps its values.

**E20-K4 (`window-empty` guard at `β_c`).** Section 15.5 tests the boundary candidates against `Ω ⊕ 1`. Now a candidate passes when its distance from `Ω` is strictly greater than `β_c`, after `β_c` is rounded up with the slack of section 15.2: a candidate more than `β_c` from `Ω` cannot be moved into `Ω`. Clip cracks follow K1's convention. A case with `β_c ≥ 1` stays UNDECIDED, as before.

**E20-K5 (work-cap rows, E20-Q3).** The measurement work cap `measureWorkCap = 7.2·10^9` is a constant in the frozen oracle source, fixed by E3 section 14.7. Raising it for a re-measure is a run option, not an oracle change: the cap only stops the oracle (it throws), the harness already passes `workCap`, and the cap is in neither the merge identity nor the freeze record. Under Q3 (a) the 152 rows are not re-measured and are disclosed as the class `oracle-work-cap`. Under Q3 (b), a dated amendment to E3 section 14.7 allows a re-measure at `2·measureWorkCap`, a new `--work-cap` option, the cap written into each row, and a validator check that `work ≤ cap`.

**E20-K6 (T-junctions in the chain).** Under E3-Q10 (b), A04 is measured on the crack-closed region, where each T-vertex sits on its mapped edge at its exact parameter `λ`, within `β_c` of its `p*`. The chain of section 20.1 is built the same way. A chain edge is split at every vertex `p*` that lies exactly on it, and the split pieces cancel by the rule of precondition 2. Section 20.2 then applies to the split mesh, as E3-Q10 (b)'s proof applies section 7.1's. The harness records the number of T-vertices it split per row (`tJunctions`). A row left UNDECIDED after the split keeps its reason.

**E20-K7 (sub-pixel collapse, E20-Q1).** This rule discloses the five FAIL rows: a mesh is drawn, all of its triangles collapse, and `M*` is empty while `R` is not. See E20-Q1.

**E20-K8 (record writer).** `record.json` writes `+∞` as the string `"Infinity"`, as the run tool's `toJson` (`run.check.ts`) already does, in `eLo`, `eHi`, `u` and `l`. The validator accepts both forms in older records.

**E20-K9 (the new record).** The record carries:

- the 2026-10-27 record's run id as `supersedes`;
- each re-measured row's former status and reason;
- the E20 measurement commit (K10).

Section 7.3's verdict rule and section 21.2's disclosure rule apply unchanged.

**E20-K10 (measurement commit and merge, a dated amendment to E3 section 22).** The re-measure runs on a measurement branch: `7443c2b`, which carries the E11 snapshot's packages, plus the E20 commits under `tests/geometry/e3-a04/`, `tooling/` and `docs/` only. The record stays on the E11 snapshot that the P3 exit cites. The merge of section 22 is extended:

- a re-measured row replaces the 2026-10-27 row of the same index and id;
- the run tool checks that the measurement commit differs from `7443c2b` only under those paths;
- every other identity field must still agree: corpus, generator, oracle and its certification, WASM, shards, stride and start resolution;
- the provenance lists the two commits and the diff paths.

The E20 code also lands on `main` through its PRs.

## 3. Acceptance

| ID | Criterion | Method |
| --- | --- | --- |
| E20-A1 | K1: unit fixtures with a sliver strip crossing a viewport edge, in fill and stroke. The bound decides them, and random vertex moves of at most `β` stay within `ρ` of `∂M*`, as in section 20.4. A clip point placed farther than `β_clip` from the exact one is refused | Unit (`e3-a04-flip-tolerant.test.ts`) |
| E20-A2 | K2: a zero-area triangle inside a square is admitted. One that pokes out by `10^-6` px, or dangles off `M*`, is refused. The sampled move check of section 20.4 holds | Unit |
| E20-A3 | K3: on the 99 floor-straddle rows, the new `D_hi` is at most the old, and a row the old search decides is unchanged. A seeded defect that reports `D` without the exact fallback is caught on a sub-binary64 edge fixture | Unit, plus a sample run on those rows |
| E20-A4 | K4: a fixture whose candidate lies `1.5β_c` outside `Ω` is decided, and one at `0.5β_c` stays UNDECIDED. K6: a T-junction square (E3-PC13's shape) with a sliver is decided, and a long edge with triangles on both sides and no vertex on it stays UNDECIDED | Unit |
| E20-A5 | No-regression: a stride-25 sample of the 2026-10-27 PASS, FAIL, `window-empty` and rejected rows (976 rows) is re-measured on the measurement commit. Every row is byte-identical apart from `ms` and the `+∞` form of K8. Any difference stops the merge, and the run becomes a full 96-shard run | Run (K10) |
| E20-A6 | All 14 positive controls stay rejected, the negative controls stay accepted, and the seeded defects of E3 section 8.2 and section 20.4 are still caught | Unit and `--smoke` |
| E20-A7 | The new record is written and passes the validator, and it passes an independent evidence review (E3 section 7.4) | Run, review |
| E20-A8 | E3 section 23 (a pointer), sections 14.7 and 22 (amendments), the A04 and E20 track rows, and E11 section 7.2 (classes) are updated, with the measured verdict as it is; the clip-crack question is put to the P3 plan | Docs |

E20 is done when A1 to A8 hold, whatever the verdict. The expected verdict is `PASS with disclosure` if every bucket of section 1 resolves. Otherwise the verdict is UNVERIFIED, with fewer rows to remedy.

## 4. Units

| Unit | Content | Criteria |
| --- | --- | --- |
| U1 | K1, K2, K3, K4 and K6 in `harness.ts`, with the K1 and K6 proof annex appended to this file; tests; independent review of the proof and of the gating | E20-A1 to A4, A6 |
| U2 | K5 (per Q3), K7 (per Q1), K8 and K10 in `record.ts`, the validator and the run tool; K7's row field (the device bounding box of `R`, so the class test reads only the row); tests | E20-A6 |
| U3 | The run on the measurement branch: the re-measured rows and the A5 sample, on cloud containers (the measurement is CPU only); merge, record and evidence review | E20-A5, A7 |
| U4 | Docs: E3 pointer, track rows, E11 closed list | E20-A8 |

U1 and U2 are independent. U3 needs both.

## 5. Risks

- **E20-R1 the K1 proof.** If the clipping extension is unsound, rows would be scored PASS wrongly. Mitigation: the annex goes through an independent review before U3, and A1 has a refusing fixture. If the proof does not hold, K1 is dropped and its 658 rows stay UNDECIDED.
- **E20-R2 hidden coupling.** A harness change could move a decided row. The gating rule and its review prevent it; A5's sample checks it, and any byte difference sends the run to a full 96-shard run.
- **E20-R3 cost.** The re-measure is 3,097 rows (every 2026-10-27 UNDECIDED row, disclosed or not, except the 152 work-cap rows, plus the 5 FAIL rows for K7's row field) and the 976-row A5 sample: about a sixth of the corpus's measured rows, without the heaviest ones. The work-cap rows alone took 117.5 worker-hours to reach the cap, so Q3 (b) costs at least that again, up to 13 GB each.
- **E20-R4 drift on `main`.** `main` differs from the snapshot along the measured path (`path-mesh-pipeline.ts`, `primitive-scene-source.ts`, `scene-mirror.ts`, `scene-validation.ts`, `contracts/scene.ts`). K10 measures on the snapshot's packages, so this record says nothing about `main`; a later reference run on a later snapshot would.

## 6. Questions (each with a recommended option)

- **E20-Q1 sub-pixel collapse (5 FAIL rows).**
  - (a) A fourth known class, `sub-pixel-collapse`, that discloses FAIL rows. It covers fill rows only, when every triangle of the drawn mesh collapses (`noFlip.collapsed = checked`), `M*` is empty, and `R`'s device bounding box is under 1 px on both axes. The fringe still draws the shape's anti-aliasing band, which A08 measures.
  - (b) A fill-kernel change that keeps a positive-area mesh for such shapes. This needs `fill-v0+r5`, the A01 and A02 identity runs, and a full A04 re-run.
  - (c) Leave them FAIL. A04 then stays FAIL.
  - Recommended: (a). The error is below one pixel by construction. The class test reads only the row and the corpus bounds. It extends the rule "a FAIL outside `collapsed-feature` is never disclosed", so it is the user's to decide.
- **E20-Q2 what to re-measure.**
  - (a) The 3,097 rows of E20-R3 and the A5 sample, on the measurement branch of K10; the other rows carry over.
  - (b) A full 96-shard run on the measurement branch.
  - Recommended: (a). The gating rule keeps decided rows on the old code, A5 checks it, and (a) falls back to (b) on any difference.
- **E20-Q3 the 152 work-cap rows.**
  - (a) Disclose them as a class `oracle-work-cap`: the oracle could not decide them within its frozen cap, which says nothing about the kernel. A cheaper oracle path (a new oracle version and a full re-freeze) goes to the backlog.
  - (b) Re-measure them at `2·measureWorkCap` under a dated amendment to E3 section 14.7 (E20-K5); rows that still hit the cap stay UNDECIDED.
  - Recommended: (a). (b) costs at least 117.5 more worker-hours and the earlier sample suggests many rows would hit the doubled cap too. `far-vertices` already discloses a measurement limit the same way (section 21.1).

## 7. Decisions

- 2026-10-28, independent review r1: NOT READY. B1: K1 assumed shared clip points, which E3 does not; K1 now keeps `M*` unclipped and states the bound on the crack-closed region. B2: K6 contradicted E3-Q10 (b); it is now a remedy (split at T-vertices), not a class. B3: carry-over could not work; added the gating rule, K3 runs the old search first, and K10 measures on the snapshot's packages. S1 to S8 applied (K5 amendment and cost, counts, A5 size 976, K2 pieces and chain, K4 wording, K7 row field, the evidence review covered by A7).
