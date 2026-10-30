# E20 contract: A04 remedies (E3-U7)

Status: APPROVED 2026-10-28 (section 7, recommended options auto-adopted), Full tier (measurement harness, record format, A04 known classes and dated amendments to E3 section 22 (and 14.7 under E20-Q3 (b)); no kernel or `packages/` change). Rendering-track item [E20](d9-rendering-track.md#status-index). The user ordered E20 after E22 on 2026-10-28.

Owners: this file owns E20's rules, units, acceptance and the new A04 record. The [E3 contract](d9-e3-b4-precision-contract.md) keeps the metric (E3-K1 to K5), the oracle and its freeze record (section 19.7), the corpus, the 0.25 px threshold, the pass rule (section 7.3), the no-flip certificate (section 15.4), the flip-tolerant bound (section 20) and the three known classes of section 21. E20 changes only what section 2 names. It appends to E3 a pointer to the new record and the amendment of E20-K10 (and of K5 under E20-Q3 (b)).

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

**E20-K1 (flip-tolerant bound on clipped draws).** The bound of E3 section 20 also runs when triangles cross the guard band. `M*` stays unclipped, as E3-K3 and the no-flip path take it. The clip polygons model only the GPU image: the visible part of a crossing triangle is within `β_c` of the moved unclipped triangle intersected with the viewport, because `β_c` includes `β_clip` (section 15.3). A shared clipped edge can open a hairline crack, because the GPU makes clip vertices per triangle (E3 section 19.1). As for T-junction cracks under E3-Q10 (b), the bound is stated on the crack-closed region: each shared clipped edge gets one clip point, placed within `β_clip` of the exact one. The crack is not scored by A04. Routing clip cracks out of A04 extends E3-Q10 (b) beyond T-junctions; E3 section 19.1 and the no-flip path already take that position. E20-Q4 puts it to the user before U3. The extension of section 20.2 and its proof are an annex written in U1 and independently reviewed before U3. If the review rejects the proof, K1 is dropped and its rows stay UNDECIDED.

**E20-K2 (zero-area triangles inside `M*`).** Precondition 1 of section 20.1 is relaxed. A zero-area triangle whose box meets `Ω ⊕ 3` is admitted when its segment lies in `M*`, by exact membership on the segment's pieces between its crossings with chain edges, and when every chain edge it adds satisfies precondition 2. Pieces are split at proper crossings, at chain vertices and at collinear overlaps. On the GPU the triangle opens into a sliver within `β_c` of a segment of `M*`, so `M_gpu ⊂ M* ⊕ β` still holds. The triangle's edges are already in the chain `C*`, and precondition 2 still binds them, so an interior zero-area triangle is admitted only when its edges cancel or are covered on one side. Today's rule, that the segment be covered by collinear edges, is a special case. A zero-area triangle with any point off `M*` keeps the case UNDECIDED. K2 applies to both paints. A stroke row that it decides leaves E19's `degenerate-stroke-triangle` class.

**E20-K3 (tighter offset certificate).** Section 20.3's search runs first, unchanged. Only when it fails, or when it gives `U > 0.25 ≥ L`, a refined search runs. Directions are taken every 15° within ±75° of the outward normal. Offsets start at `1.0625·β` and grow by a factor of `2^(1/4)`. Splitting goes to depth 16, no shorter than `β/8`. The work cap of `5·10^7` units stays. An edge whose binary64 offset test cannot separate (`edge below binary64`) falls back to the exact dyadic test of the translate against every candidate edge. `ρ = max(β_c, D_hi)` and `U = E_hi + ρ` are unchanged; the record keeps the smaller `D_hi` of the two searches. A row decided by the old search keeps its values. The smaller `ρ` can also move a row from UNDECIDED to FAIL (`L = E_lo − ρ` rises), which is sound.

**E20-K4 (`window-empty` guard at `β_c`).** Section 15.5 tests the boundary candidates against `Ω ⊕ 1`. Now a candidate passes when its distance from `Ω` is strictly greater than `β_c`, after `β_c` is rounded up with the slack of section 15.2: a candidate more than `β_c` from `Ω` cannot be moved into `Ω`. Clip cracks follow K1's convention. A case with `β_c ≥ 1` stays UNDECIDED, as before.

**E20-K5 (work-cap rows, E20-Q3).** The measurement work cap `measureWorkCap = 7.2·10^9` is a constant in the frozen oracle source, fixed by E3 section 14.7. Raising it for a re-measure is a run option, not an oracle change: the cap only stops the oracle (it throws), the harness already passes `workCap`, and the cap is in neither the merge identity nor the freeze record. Under Q3 (a) the 152 rows are not re-measured and are disclosed as the class `oracle-work-cap`. Under Q3 (b), a dated amendment to E3 section 14.7 allows a re-measure at `2·measureWorkCap`, a new `--work-cap` option, the cap written into each row, and a validator check that `work ≤ cap`.

**E20-K6 (T-junctions in the chain).** Under E3-Q10 (b), A04 is measured on the crack-closed region, where each T-vertex sits on its mapped edge at its exact parameter `λ`, within `β_c` of its `p*`. The chain of section 20.1 is built the same way. A chain edge is split at every vertex `p*` that lies exactly on it, and the split pieces cancel by the rule of precondition 2. Section 20.2 then applies to the split mesh, as E3-Q10 (b)'s proof applies section 7.1's. The harness records the number of T-vertices it split per row as `flipTolerant.splitTVertices` (the oracle's `tJunctions` field keeps its E3-O10 meaning). A row left UNDECIDED after the split keeps its reason.

**E20-K7 (sub-pixel collapse, E20-Q1).** This rule discloses the five FAIL rows: a mesh is drawn, all of its triangles collapse, and `M*` is empty while `R` is not. See E20-Q1.

**E20-K8 (record writer).** `record.json` writes `+∞` as the string `"Infinity"`, as the run tool's `toJson` (`run.check.ts`) already does, in `eLo`, `eHi`, `u` and `l`. The validator accepts both forms in any record, since carried rows keep the `null` form.

**E20-K9 (the new record).** The record carries:

- the 2026-10-27 record's run id as `supersedes`;
- each re-measured row's former status and reason;
- the E20 measurement commit (K10);
- the old record's `hosts` and `retried` provenance, carried forward unchanged.

Section 7.3's verdict rule and section 21.2's disclosure rule apply unchanged.

**E20-K10 (measurement commit and merge, a dated amendment to E3 section 22).** The re-measure runs on a measurement branch: `7443c2b`, which carries the E11 snapshot's packages, with `tests/geometry/e3-a04/`, `tooling/run-e3-a04.mjs` and `docs/` taken byte-identical from the E20 commit that lands on `main` (which includes PR #277's section 22 tooling). A change to a root file (`package.json`, `vitest.*.config.ts`) falls outside the allowed paths and is not allowed. The branch head is kept reachable by a pushed tag `e20-a04-measure`. The merge starts from the committed 2026-10-27 `record.json`, checked against its SHA-256 `5df0c5a6…` (E3 section 23.6), because the old shard directories are not committed. The record stays on the E11 snapshot that the P3 exit cites. The merge of section 22 is extended:

- a re-measured row replaces the 2026-10-27 row of the same index and id;
- the run tool checks that the measurement commit differs from `7443c2b` only under those paths;
- every other identity field must still agree: corpus, generator, oracle and its certification, WASM, shards, stride and start resolution;
- the provenance lists the two commits and the diff paths.

The E20 code also lands on `main` through its PRs.

## 3. Acceptance

| ID | Criterion | Method |
| --- | --- | --- |
| E20-A1 | K1: unit fixtures with a sliver strip crossing a viewport edge, in fill and stroke. The bound decides them, and random vertex moves of at most `β` stay within `ρ` of `∂M*`, as in section 20.4. The sampled move check places each shared clip point anywhere within `β_clip` of the exact one | Unit (`e3-a04-flip-tolerant.test.ts`) |
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
  - Recommended: (a). The error is below one pixel by construction. The class test reads only the row, through a new row field (U2); a carried row without the field is not in the class. It extends the rule "a FAIL outside `collapsed-feature` is never disclosed", so it is the user's to decide.
- **E20-Q2 what to re-measure.**
  - (a) The 3,097 rows of E20-R3 and the A5 sample, on the measurement branch of K10; the other rows carry over.
  - (b) A full 96-shard run on the measurement branch.
  - Recommended: (a). The gating rule keeps decided rows on the old code, A5 checks it, and (a) falls back to (b) on any difference.
- **E20-Q3 the 152 work-cap rows.**
  - (a) Disclose them as a class `oracle-work-cap`: the oracle could not decide them within its frozen cap, which says nothing about the kernel. A cheaper oracle path (a new oracle version and a full re-freeze) goes to the backlog.
  - (b) Re-measure them at `2·measureWorkCap` under a dated amendment to E3 section 14.7 (E20-K5); rows that still hit the cap stay UNDECIDED.
  - Recommended: (a). (b) costs at least 117.5 more worker-hours. `far-vertices` already discloses a measurement limit the same way (section 21.1). Its limit, stated for the evidence review: the class can hide a real kernel error above 0.25 px on these rows, and unlike `far-vertices` (backed by E11-U2) nothing else checks them. The class covers every UNDECIDED row whose reason starts with `work cap:` and that no class of section 21 discloses first: the one `work cap: rational` row of C4 stays `collapsed-feature` and is re-measured with the 3,097. A row that E20 newly brings to the oracle can also stop at the cap (row 22554 did, in U2's sample run) and joins the class; the record states the class's size, split by `former` into old and new rows.

- **E20-Q4 clip cracks.**
  - (a) Route them out of A04, as E3-Q10 (b) routes T-junction cracks, and report them; their owner is A01 under the P3 plan, which is asked to add them to A01's crack report.
  - (b) Keep clipped rows that need K1 UNDECIDED.
  - Recommended: (a). E3 section 19.1 and the no-flip path already treat clip cracks this way, so (a) states an existing position; the cracks are hairlines within `β_clip` along the viewport edge.

## 7. Decisions

- 2026-10-28, independent review r1: NOT READY. B1: K1 assumed shared clip points, which E3 does not; K1 now keeps `M*` unclipped and states the bound on the crack-closed region. B2: K6 contradicted E3-Q10 (b); it is now a remedy (split at T-vertices), not a class. B3: carry-over could not work; added the gating rule, K3 runs the old search first, and K10 measures on the snapshot's packages. S1 to S8 applied (K5 amendment and cost, counts, A5 size 976, K2 pieces and chain, K4 wording, K7 row field, the evidence review covered by A7).
- 2026-10-28, independent review r2: READY WITH FOLLOW-UPS; S1 to S7 applied (measurement branch paths, tag and merge base, `splitTVertices`, `oracle-work-cap` limits, clip cracks as Q4, row field and `+∞` forms, wording).
- 2026-10-28, 추천안 자동 채택 under the user's standing instruction of 2026-10-24: E20-Q1 (a), Q2 (a), Q3 (a), Q4 (a). Q1 was also put to the user on a decision card; a different answer from the user replaces (a) before U2 lands.
- 2026-10-28, E20-U1 independent review r1 (code, annex, gating): READY WITH FOLLOW-UPS, no blocker; gating confirmed byte-identical for decided rows. S1 to S8 applied: partners defined by edge parameter and barycentrics, clip points shared along K6-split lines, the `Ω ∖ V` model convention made explicit, the clip-line strip, the K2 sliver as extra coverage, the work cap inside the K6 split, a K4 `measureCase` test, and the checks left to U3.
- 2026-10-28, E20-U2 independent review r1: NOT READY. B1: K7's region extent did not bound the binary64 rounding of `a·x + b·y` under cancellation; it now adds an absolute term of `2^-48` times the largest `|a·x| + |b·y|`. Applied: S1 the carried GPU check must name the same shader SHA-256; S3 the identity form treats only `"Infinity"` as the old `null`; S5 `--e20-commit` is required, checked (no diff in the E20 paths) and recorded as `e20Commit`; S7 the git ancestor checks fail closed; S2 the `oracle-work-cap` scope (Q3 text above). Left to U3's evidence review: S4 (a re-measured row's former class is read from the old record's `disclosed` lists) and S6 (the supersede logic is checked by its end-to-end runs, not unit tests). A worker that dies on a re-measured row is measured again in another directory with a larger `--heap`; the merge takes that row and records `failedCases`.
- 2026-10-28, E20-U3 run: cloud containers restart without warning and kill whole-group retry runs before they write `host.json`. The supersede merge now accepts a directory without `host.json` as `interrupted`, whatever stopped it. Its complete rows stand. A cut last line is dropped, and any other unreadable line refuses. The case it was measuring (`retry.current`) must come from another directory, and the record lists the run with `interrupted: true`, `interruptedAt` and `planned` (cases named) next to `cases` (rows kept). Exit codes and in-process restarts are unknown for such a run; the row checks (every named row present exactly once, and a dead worker's `harness-error` row measured elsewhere) stand in for them. Every row must be one of its directory's `retryCases`. The measurement branch takes the tool from this change. Retry directories from `147c4f6` still pass, because the commits differ only in the tool and `docs/`.
- 2026-10-30, E20-U3 record `2026-10-30T06-22-26-954Z-a143a695` (supersedes `de2951d7`). It covers 3,097 re-measured rows and the 976-row A5 sample. The measurement commit `9ce1104` is tag `e20-a04-measure`: `7443c2b` plus the E20 paths of main `ea41bb8`, which is `--e20-commit`. Most rows were measured on cloud containers at `147c4f6` or `3a11a22`, which are ancestors of `9ce1104` that differ only in the tool and `docs/`. 85 rows had a worker die at a smaller heap and were measured again with a larger one: 81 at `--heap 13000` and 4 at `--heap 30000` on a Windows host with 20 CPUs (7414, 12057, 19054 and 19215, all of which ended on the work cap). 7414, 12057 and 19054 had also died at `--heap 13000` on 15 GB containers. 19215 had died only at `--heap 4608` in the merged directories; it went to the larger host after a 13000 attempt restarted its container. Measured disposition: UNVERIFIED with disclosure. No FAIL is outside the classes. 668 rows are UNDECIDED outside the classes: 566 `no-flip certificate` and 102 `straddles at the floor`. Outside the classes, max U is 0.5166 px (`C2/g0161/T4/z0.01-d2/center/k0`, UNDECIDED), p99 0.24990 and p50 0.15085. The raw max U is `+∞`, on the disclosed `sub-pixel-collapse` row 3143. Of the old UNDECIDED rows, 719 now PASS and 273 are window-empty. `oracle-work-cap` has 268 rows. Split by `former`, 152 are old and 116 are new, and all 116 new rows were `no-flip certificate` before (as Q3 (a) foresaw for row 22554). `sub-pixel-collapse` has 5 rows (the five `C1/g0029/T2` FAIL rows).
- 2026-10-30, E20-U3 independent evidence review r1: NOT READY. B1: the record read back from JSON failed the validator, because the aggregates' `maxU = +∞` is written as `"Infinity"` (K8) and only row fields were revived. The validator now compares aggregates and coverage in their JSON form. A round-trip test was added, and the committed bytes of `a143a695` validate with no problems. The review checked and confirmed: the provenance and the identity fields; every planned row present exactly once and none a harness-error; the 24,365 other rows byte-identical to `de2951d7`; the identity sample (only the `+∞` form differs, on 12950 and 11825); `former` on exactly the 3,097 rows; the class lists, including S4 (the former class is read from the old `disclosed` lists); A3 on the 99 floor-straddle rows (0 violations); the `refined-offset` path on 132 rows; K4 on 267 window-empty rows; the K7 extent on the 5 rows; the aggregates; and the GPU carry (same shader SHA-256). Follow-ups for U4: state the counts outside the classes and the 152/116 split (S1); the refine before the oracle has no `e20` trace of its own (S3, backlog); disclose the Node versions (S4): 646 re-measured rows ran on Node 22.22.0 and 4 on 24.22.1, and the identity sample on 22.22.0 is byte-identical to the pinned run; K2 decided no row (S5); cite the user's answer to the E20-Q1 card for `sub-pixel-collapse`, which discloses 5 FAIL rows (S7). Backlog: an index-to-run manifest of the retry directories (S6). S2: the Q3 text already lets new rows join `oracle-work-cap`, and its stated limit (it can hide a real kernel error above 0.25 px, unchecked elsewhere) now covers 268 rows, not 152. Re-validated with the current code, `de2951d7` reports `disclosed cases differ from the rows`, because it predates the E20 classes. It is valid under its own commit.
- 2026-10-30, E20-U3 independent evidence review r2: READY WITH FOLLOW-UPS. B1 cleared: the committed `record.json` (SHA-256 `5240a85a…`) validates with no problems and no reviving, and the round-trip test fails on the old code. F1 to F3 (wording of the two entries above) applied. `record.ts` is an E20 path, so a later supersede run needs a measurement commit that carries this fix.
- 2026-10-30, E20-U4 docs (E20-A8): E3 section 24 points to the new record, and E3 section 22 has the K10 amendment. Section 14.7 is not amended, because Q3 took (a). The E3, E20 and X1 A04 rows of the rendering track are updated, and the track has an E20-U3 evidence entry. E11 section 7.2 gains `oracle-work-cap` and `sub-pixel-collapse` for A04. The clip-crack question of Q4 (a) is put to the P3 plan's A01 row as a dated note. The r2 follow-ups are handled as follows. S1 (the counts outside the classes and the 152/116 split) and S4 (the Node versions) are stated in E3 section 24. S5: K2 decided no row, so no claim is made for it. S7: Q1 (a) stands as auto-adopted; the user did not answer the 2026-10-28 decision card ("A04의 남은 FAIL 5건(1픽셀보다 작은 도형)을 어떻게 처리할까요?") before U2 landed, or since. S3 and S6 stay in the backlog.

## 8. E20-U1 annex: the remedies in the harness, 2026-10-28

The code is `flipTolerantBound` (option `e20`), `boundaryDistanceFromWindow` and `measureCase` in `tests/geometry/e3-a04/harness.ts`. The oracle does not change. Notation follows E3 section 20: `β = β_c`, `C*` the chain, `w_s` the winding number of the moving mesh at time `s`.

### 8.1 Gating

The new code runs at three places, each the predicate that ended a row UNDECIDED on 2026-10-27:

- **No-flip certificate.** `noFlip.failed > 0`, and the section-20 bound was not run (a crossing triangle) or returned no `ρ`. Here `flipTolerantBound(…, { e20: true })` runs: K1, K2, K3 and K6.
- **`window-empty` within the guard.** `boundaryMayMeetGuard` is true. Here K4 runs.
- **Straddle on the bound.** `U > 0.25 ≥ L` with a flip-tolerant `ρ` (old or new). Here the refined search runs on every edge (`refineAll`), and the row keeps the smaller `ρ`, with `U` and `L` from the same oracle interval.

A row decided by the old code meets none of them, so its values do not change. Its `flipTolerant` keeps the five old fields, and it has no `e20` field. Two additions to the gated paths:

- A new row with `ρ ≥ 0.25` gets the refined search before the oracle runs, since `U > 0.25` already holds.
- A row that a remedy leaves UNDECIDED keeps its old `flipTolerant` and reason. So the class of E3 section 21.3 still reads the old reason.

Each row that reached new code lists it under `e20`: the rule, the former section-20 result, the failed attempt when there is one, and K4's distance. A result from the new code also carries `splitTVertices`, `refinedEdges`, `exactEdges` and, for K1, `clipped`.

### 8.2 K6: splitting the chain at T-vertices

The rule splits each directed edge `a → b` whose box meets `Ω ⊕ 4` at every `p*` exactly inside it. The test is exact collinearity and `0 < (t − a)·(b − a) < |b − a|²`.

- **The chain is unchanged.** The split is a 1-chain identity, `a → b = a → t + t → b`, so the sum of the triangle boundaries is unchanged. The cancellation of pieces is exact, and `∂M* ⊂ C*_s`, the uncancelled pieces, because `w_0` changes only across them.
- **Edges split alike.** An edge and its reverse have one box, so they split alike. An edge kept whole, with a box off `Ω ⊕ 4`, can leave pieces of a split edge uncancelled. They lie outside `Ω ⊕ 4`, beyond every window that section 20.2 uses. There the offset test only meets them as extra obstacles.
- **On the GPU.** Under E3-Q10 (b), each T-vertex `t` is drawn at `t'' = (1 − λ)·a' + λ·b'`, on its mapped edge, with `|t'' − t*| ≤ β`. Along the straight-line homotopy `f_s`, `t_s = (1 − λ)·a_s + λ·b_s` for every `s`, because the map is affine in the end points. So the pieces `a_s → t_s → b_s` make up `a_s → b_s` at every `s`, and the cancellation at `s = 0` holds for all `s`.
- **Conclusion.** Section 20.2 then applies word for word with `C*_t`: precondition 2 is checked on `C*_t`, and the crack itself is A01's under E3-Q10 (b).
- **Cost.** The split tests every point in an edge's box, so the work cap of section 20.3 is checked inside the split, and the bound stops at `work cap` there too.

### 8.3 K2: zero-area triangles inside `M*`

A zero-area triangle near the window is admitted when its segment `uv` lies in the closed `M*`.

- **The test.** Let `C+` be the chain of the positive-area triangles alone, so `∂M* ⊂ C+`. The harness splits `uv` where it meets `C+`: at proper crossings, at `C+` vertices on `uv` (they bound every collinear overlap), and at the ends. Each open piece misses `∂M*` and is wholly in or out of `M*`, or it lies along an edge of `C+`, which is in `M*`.
- **One exact test decides each piece.** The middle of the piece is `u + τ(v − u)` with a rational `τ = N/M`. Its orientation against a triangle edge `ab` is `(M − N)·o(a, b, u) + N·o(a, b, v)`, an exact dyadic.
- **Why the bound still holds.** The GPU image of the triangle has vertices within `β` of `u`, `v` and the third point. By barycentric partners it lies in `uv ⊕ β ⊂ M* ⊕ β`, so the "Outside" step of section 20.2 holds. Its edges are in the chain, and precondition 2 binds them, so they must cancel or be boundary. With K6, an interior triangle's edges cancel at its middle vertex.
- **The sliver on the GPU.** Because K6 splits the long edge at the middle vertex, the closed model places that vertex back on its edge and the triangle stays degenerate there. The real image may open into a sliver: extra coverage, not a crack. The bound holds for the real image too, since the sliver lies in `uv ⊕ β ⊂ M* ⊕ β`, and the outside point `x ∉ M*` that `B_R` uses is more than `β` from `C* ⊃ ∂M*`, so more than `β` from `uv ⊂ M*` (any path from `x` to `uv` crosses `∂M*`), and so off the sliver.

### 8.4 K1: clipped draws

**Model.** This is E3-Q11 (a) as section 15.3 uses it. `T'` is a triangle with its vertices moved by at most `β_vertex`. The GPU draws `T' ∩ V` (`V` is the viewport) for each crossing triangle. Every new vertex is within `β_clip` of the exact clip point on `T'`. A triangle wholly beyond one plane is not drawn.

**Crack-closed convention (E20-K1, E20-Q4 (a)).**

- Clip points on one chain line are shared: two clipped edges with the same two `p*` (shared edges, and the two coincident edges of a collapsed triangle) get one clip point, and so do collinear pieces of a line that K6 splits (an edge `ab` and its neighbour's `at`, on the line `a't''b'`). A clip point that lands on an existing `p*` is that vertex.
- Each crossing triangle keeps its pieces beyond the clip lines, joined at the same displaced points. Those pieces are never drawn: they close the seam along the clip line, as E3-Q10 (b) closes a T-junction crack.
- The margin `Ω ∖ V` is scored on this model. The no-flip path has relied on this since E3-U3 (beyond `V` the drawn image is empty, so `E ≤ β_c` there holds only for the model), but E3 sections 7.1, 15.3 and 19.1 never wrote it down. This annex makes it explicit for E20-Q4 and the evidence review.

Call the result `M_gpu,closed`.

**Claim.** If the preconditions of section 20.1 hold on the unclipped `M*`, then `E_Ω(M_gpu,closed, M*) ≤ max(β_c, D_hi)`.

- **Partners.** A clip point `c` on the edge `a'b'` at parameter `μ` has the partner `c* = (1 − μ)·a* + μ·b*`. A viewport corner `c` inside `T'` with barycentric coordinates `λ` in `T'` has the partner with the same `λ` in `T*`. Neither needs `T*` or `T'` to have area, so zero-area triangles (K2) and flipped ones are covered. By convexity `|c − c*| ≤ β_vertex`, and the drawn position is within `β_vertex + β_clip ≤ β_c` of `c*`.
- **Refinement.** The pre-images of the clip lines cut each crossing `T*` into convex pieces with vertices at `T*`'s vertices and the points `c*`. The pieces tile `T*`, so the refined mesh `M*_r` has `M*`'s region, orientation and chain geometry.
  - Internal piece edges cancel exactly.
  - On a shared edge `ab`, both triangles see the same moved edge `a'b'`, because the vertices are bit-identical. So they share the crossing parameter `μ` and the point `c*`. By the convention they also share `c`'s drawn position, and the pieces cancel as in 8.2.
  - A culled neighbour stays whole. A neighbour's point on their shared edge is a T-vertex beyond a plane, so it is outside `V`, and E3-Q10 (b) places it.
- **Motion.** `M_gpu,closed` is `M*_r` with every vertex moved by at most `β_c`. Section 20.2 applies to `M*_r`, and its preconditions are those of `M*`. The no-flip path's rule, that `β_c` includes `β_clip`, carries over.
- **What the model leaves out.** Inside `V`, `M_gpu,closed` differs from the drawn image only along shared clipped edges and the clip line, by hairlines within `β_clip`. They are reported, not scored (E20-Q4 (a)). The clip readback of E3 section 19.1 already leaves clipped edges out. A clip point moved into `V` leaves an uncovered strip at most `β_clip` wide along the viewport edge, and since `β_clip < 0.25` and pixel centres lie 0.5 px inside the edge, no centre falls in it.

### 8.5 K3 and K4

- **K3, refined search.** It uses the old code with directions every 15° within ±75°, factor `2^(1/4)`, depth 16 and pieces down to `β/8`. Each edge keeps the smaller `D`, and every `D` is a valid bound.
- **K3, edge below binary64.** The harness translates the edge by a binary64 vector `w`, so the translate's end points are dyadic, and tests exactly:
  - for each candidate `cd` near it, that the two segments are disjoint and every end point is more than `β` from the other segment (squared distances);
  - that the translate's midpoint is outside `M*`.

  Then `D ≤ |w|`, rounded up with the slack of section 15.2.
- **K4.** The harness computes the distance from each boundary candidate to `Ω` in binary64, as the least of end point to box and box corner to segment (disjoint convex sets meet at a vertex), less `f64Margin`. A segment that meets the box gives 0. The case is `window-empty` when the least distance exceeds `β_c`: no point of a candidate can then move into `Ω`.

### 8.6 Tests

`tests/geometry/e3-a04-flip-tolerant.test.ts`, block "E20 remedies":

- **K2.** An interior zero-area triangle is admitted. One that pokes `2^-20` px out of the square, or dangles off it, is refused. The sampled moves of section 20.4 stay within `ρ`.
- **K6.** E3-PC13's T-junction shape with a sliver is decided. Triangles on both sides of an edge with no vertex on it stay refused.
- **K3.**
  - The refined `ρ` is at most the old one on the sliver and the L.
  - A chamfer `2^-60` px long is decided by the exact test.
  - A hole `2^-60` px across is refused.
  - The seeded defect `no-exact-fallback` accepts the hole, so the test catches it.
- **K4.** Squares `1.5β_c` and `0.5β_c` beyond `Ω` are decided and refused by `boundaryDistanceFromWindow`, and through `measureCase` a triangle whose edge passes `Ω`'s corner at about `1.5β_c` is `window-empty`, at about `0.5β_c` UNDECIDED.
- **K1.**
  - The sampled check moves vertices by `β/2` and puts each shared clip point anywhere within `β/2` of the exact one, with the far pieces kept. Membership changes only within `ρ` of `∂M*`.
  - Clipped strips in fill and stroke are decided through `measureCase`.
  - Two clipped slabs `10^-5` px apart stay UNDECIDED.
  - A row that the old bound decides has no `e20` field.
- **Left to U3.** A3's claim on the 99 floor-straddle rows (new `D_hi` at most the old) is checked on the U3 sample, since the unit test holds by construction. The two `measureCase` refine paths (`refined-offset` after the oracle, and the refine before it when `ρ ≥ 0.25`) have no synthetic fixture: no small mesh gives a flip-tolerant `ρ` near 0.25. The U3 sample reaches both, and the record lists them under `e20`.
