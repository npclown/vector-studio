# E20 contract: A04 remedies (E3-U7)

Status: DRAFT 2026-10-28, Full tier (measurement harness, record format and A04 known classes; no kernel or `packages/` change). Rendering-track item [E20](d9-rendering-track.md#status-index). The user ordered E20 after E22 on 2026-10-28.

Owners: this file owns E20's rules, units, acceptance and the new A04 record. The [E3 contract](d9-e3-b4-precision-contract.md) keeps the metric (E3-K1 to K5), the oracle and its freeze record (section 19.7), the corpus, the 0.25 px threshold, the pass rule (section 7.3), the no-flip certificate (section 15.4), the flip-tolerant bound (section 20) and the three known classes of section 21. E20 changes only what section 2 names, and appends to E3 a pointer to the new record.

## 1. Scope

The [2026-10-27 reference run](d9-e3-b4-precision-contract.md#23-e3-u5-reference-run-record-2026-10-27) measured A04 **FAIL**: 5 FAIL and 1,924 UNDECIDED rows outside the known classes (section 23.2 to 23.4). E3 section 23.5 lists the remedies (E3-U7). Re-counted from the committed `record.json`:

| Bucket (record reason, `flipTolerant.reason`) | Rows | Strata (largest) | E20 answer |
| --- | --- | --- | --- |
| FAIL: `C1/g0029/T2`, sub-pixel shape whose mesh triangles all collapse | 5 | C1 | E20-K7 (Q1) |
| No-flip certificate, clipped draw (bound not run) | 658 | C5 stroke 262, C3 fill 151, C9 stroke 98 | E20-K1 |
| No-flip certificate, zero-area triangle off `M*` | 304 | C3 147, C2 95, C1 58 (all fill) | E20-K2 |
| `window-empty` within the guard (all with clipped triangles, `β_c ≤ 0.17`) | 261 | C5 79, C4 60, C1 33 | E20-K4 |
| No-flip certificate, edge with triangles on both sides (open T-junction) | 217 | C9 stroke 121, C5 stroke 60, C2 27 | E20-K6 |
| No-flip certificate, boundary offset | 208 | C3 96, C5 35, C4 34 | E20-K3 |
| Straddles at the floor: 99 have `E_hi ≤ 0.04` but `ρ ≈ 0.24` to `0.32` from the offset certificate | 100 | C3 37, C5 37, C2 12 | E20-K3 |
| Oracle work cap (`gcd step`, `rational`, `distance query`, `seam split`, `membership`) | 152 | C5, C9 strokes | E20-K5 |
| No-flip certificate, edge below binary64 | 24 | C9 18, C12 6 | E20-K3 |
| Record writer: `+∞` written as `null` | — | — | E20-K8 |

Out of scope:

- the metric, the window, the threshold, the corpus and the oracle source: the freeze record of E3 section 19.7 stands, and no re-freeze is needed;
- the fill and stroke kernels (`fill-v0+r4`, `stroke-v0+r7`): a kernel change would need a full re-run and the A01/A02 identity runs;
- E7 (conforming refinement), E18 (far-vertex carrier) and E19 (stroke zero-area triangles), except that E20-K2 may also decide rows now disclosed under E19's class;
- the GPU model check (E3-A6): E20 changes no shader, WASM or product path, so the 2026-10-27 check on the named subset stands.

## 2. Rules

Every rule below is harness or record code under `tests/geometry/e3-a04/` or `tooling/run-e3-a04.mjs`. Each one only adds a way for a case that the 2026-10-27 harness left UNDECIDED to be decided. None changes a path a PASS, FAIL, `window-empty` or rejected row took, and E20-A5 checks that on a sample.

**E20-K1 (flip-tolerant bound on clipped draws).** The bound of E3 section 20 also runs when triangles cross the guard band. Each crossing triangle enters `M*` as its exact clip polygon against the crossed planes (dyadic rational vertices). Its GPU image is within `β_c` of it, because `β_c` already includes `β_clip` (section 15.3). The proof extends section 20.2 to polygons. A clip point on an edge shared by two triangles is taken to be computed identically for both: the same assumption the no-flip path makes under E3-Q11 (a), which E3-U4's readback next to the viewport edge checked (2,668 clipped draws, no mismatch). The extension and its proof are written as an annex in U1 and reviewed before the run. If the review rejects the proof, the rows stay UNDECIDED.

**E20-K2 (zero-area triangles inside `M*`).** Precondition 1 of section 20.1 is relaxed. A zero-area triangle whose box meets `Ω ⊕ 3` is admitted when its segment lies in `M*`, by exact membership on the segment's pieces between its crossings with chain edges, and when every chain edge it adds satisfies precondition 2. On the GPU the triangle opens into a sliver within `β_c` of a segment of `M*`, so `M_gpu ⊂ M* ⊕ β` still holds. Today's rule, that the segment be covered by collinear edges, is a special case. A zero-area triangle with any point off `M*` keeps the case UNDECIDED. K2 applies to both paints. A stroke row that it decides leaves E19's `degenerate-stroke-triangle` class.

**E20-K3 (tighter offset certificate).** Section 20.3's search is refined. Directions are taken every 15° within ±75° of the outward normal. Offsets start at `1.0625·β` and grow by a factor of `2^(1/4)`. Splitting goes to depth 16, no shorter than `β/8`. The work cap of `5·10^7` units stays. An edge whose binary64 offset test cannot separate (`edge below binary64`) falls back to the exact dyadic test of the translate against every candidate edge. `ρ = max(β_c, D_hi)` and `U = E_hi + ρ` are unchanged. Only `D_hi` gets smaller.

**E20-K4 (`window-empty` guard at `β_c`).** Section 15.5 tests the boundary candidates against `Ω ⊕ 1`. It now tests them against `Ω ⊕ β_c`, rounded up with the slack of section 15.2: a `β_c` move cannot bring a candidate farther than `β_c` into `Ω`. A case with `β_c ≥ 1` stays UNDECIDED, as before.

**E20-K5 (work-cap rows re-measured with a larger cap).** The measurement work cap is a run parameter (E3 section 14.2 notes that the contract fixes no number). The work-cap rows are re-measured with a new run option `--work-cap` (U2, passed to the harness's existing `workCap` option) at 8 times the oracle's `measureWorkCap`, and `--heap 13000`. Both values are recorded per row in the merge provenance. The oracle source does not change. A row that still hits the cap stays UNDECIDED.

**E20-K6 (known class `open-t-junction`).** A row is in this class when it is UNDECIDED with `flipTolerant.reason` = `edge with triangles on both sides`, and the chain edge is a T-junction: a vertex `p*` lies exactly on the open edge. Such an edge is a real crack of width at most `2β_c` in `M_gpu`. No sound bound can score it below its distance from `∂R`. It is the A01 crack defect that the P3 exit disclosed, and E7 is its remedy. The class joins E3 section 21's table and the E11 section 7.2 closed list, and follows section 21.2's verdict rule.

**E20-K7 (sub-pixel collapse, E20-Q1).** This rule decides the five FAIL rows: a mesh is drawn, all of its triangles collapse, and `M*` is empty while `R` is not. See E20-Q1.

**E20-K8 (record writer).** `record.json` writes `+∞` as the string `"Infinity"`, as the run tool's `toJson` (`run.check.ts`) already does, in `eLo`, `eHi`, `u` and `l`. The validator accepts both forms in older records.

**E20-K9 (the new record).** Re-measuring follows E20-Q2. The record carries:

- the 2026-10-27 record's run id as `supersedes`;
- each re-measured row's former status and reason;
- the E20 harness commit.

Section 7.3's verdict rule and section 21.2's disclosure rule apply unchanged.

## 3. Acceptance

| ID | Criterion | Method |
| --- | --- | --- |
| E20-A1 | K1: unit fixtures with a sliver strip crossing a viewport edge, in fill and stroke. The bound decides them, and random vertex moves of at most `β` stay within `ρ` of `∂M*`, as in section 20.4. A mesh whose shared clipped edge has two different clip points is refused | Unit (`e3-a04-flip-tolerant.test.ts`) |
| E20-A2 | K2: a zero-area triangle inside a square is admitted. One that pokes out by `10^-6` px, or dangles off `M*`, is refused. The sampled move check of section 20.4 holds | Unit |
| E20-A3 | K3: on the 99 floor-straddle rows, the new `D_hi` is at most the old. A seeded defect that reports `D` without the exact fallback is caught on a sub-binary64 edge fixture | Unit, plus a sample run on those rows |
| E20-A4 | K4 and K6: a fixture whose candidate lies `1.5β_c` outside `Ω` is decided, and one at `0.5β_c` stays UNDECIDED. `knownClassOf` gives `open-t-junction` only for a T-junction chain edge | Unit |
| E20-A5 | No-regression: a stride-25 sample of the 2026-10-27 PASS, FAIL, `window-empty` and rejected rows, about 1,100 rows, is re-measured with the E20 harness. Every row is byte-identical apart from `ms` | Run on the E20 commit |
| E20-A6 | All 14 positive controls stay rejected, the negative controls stay accepted, and the seeded defects of E3 section 8.2 and section 20.4 are still caught | Unit and `--smoke` |
| E20-A7 | The new record is written and passes the validator, and it passes an independent evidence review (E3 section 7.4) | Run, review |
| E20-A8 | E3 section 23 (a pointer), the A04 and E20 track rows, and E11 section 7.2 (classes) are updated, with the measured verdict as it is | Docs |

E20 is done when A1 to A8 hold, whatever the verdict. The expected verdict is `PASS with disclosure` if every bucket of section 1 resolves. Otherwise the verdict is UNVERIFIED, with fewer rows to remedy.

## 4. Units

| Unit | Content | Criteria |
| --- | --- | --- |
| U1 | K1, K2, K3 and K4 in `harness.ts`, with the K1 proof annex appended to this file; tests; independent review of the proof | E20-A1 to A4, A6 |
| U2 | K6, K7 (per Q1) and K8 in `record.ts`, the validator, the run tool's `--work-cap` option and re-measure mode (Q2); tests | E20-A4, A6 |
| U3 | The run: the re-measured rows and the A5 sample, on cloud containers (the measurement is CPU only); merge, record and evidence review | E20-A5, A7 |
| U4 | Docs: E3 pointer, track rows, E11 closed list | E20-A8 |

U1 and U2 are independent. U3 needs both.

## 5. Risks

- **E20-R1 the K1 proof.** If the clipping extension is unsound, rows would be scored PASS wrongly. Mitigation: the annex goes through an independent review before U3, and A1 has a refusing fixture. If the proof does not hold, K1 is dropped and its 658 rows stay UNDECIDED.
- **E20-R2 hidden coupling.** A harness change could move a decided row. A5's sample would catch that, and any byte difference sends the run to a full 96-shard run (Q2 (b)).
- **E20-R3 cost.** Work-cap rows took up to 13 GB and hours each. U3 budgets about 12 container-hours for those 152 rows. Rows that do not finish stay UNDECIDED.
- **E20-R4 drift on `main`.** `path-mesh-pipeline.ts` changed after the snapshot (P4 clips). A5's identity sample is what shows that the current `main` measures A04 rows as the snapshot did (Q2).

## 6. Questions (each with a recommended option)

- **E20-Q1 sub-pixel collapse (5 FAIL rows).**
  - (a) A fourth known class, `sub-pixel-collapse`, that discloses FAIL rows. It covers fill rows only, when every triangle of the drawn mesh collapses (`noFlip.collapsed = checked`), `M*` is empty, and `R`'s device bounding box is under 1 px on both axes. The fringe still draws the shape's anti-aliasing band, which A08 measures.
  - (b) A fill-kernel change that keeps a positive-area mesh for such shapes. This needs `fill-v0+r5`, the A01 and A02 identity runs, and a full A04 re-run.
  - (c) Leave them FAIL. A04 then stays FAIL.
  - Recommended: (a). The error is below one pixel by construction. The class test reads only the row and the corpus bounds. It extends the rule "a FAIL outside `collapsed-feature` is never disclosed", so it is the user's to decide.
- **E20-Q2 what to re-measure, and on which commit.**
  - (a) On the E20 commit of `main`, which carries the same release WASM `58f26517…`: re-measure every 2026-10-27 row that is FAIL, UNDECIDED or disclosed (3,271 rows), plus the A5 sample. The other rows carry over only if the sample is byte-identical.
  - (b) A full 96-shard run on the E20 commit.
  - Recommended: (a). It costs about a tenth of (b), and A5 tests the premise that lets the PASS rows carry over. If the sample shows any difference, (a) falls back to (b).
- **E20-Q3 open T-junctions.**
  - (a) Disclose them as the class of K6, with E7 as the remedy.
  - (b) Leave them UNDECIDED.
  - Recommended: (a). They are the A01 crack defect that the P3 exit already disclosed, and no sound bound decides them.

## 7. Decisions

None yet.
