# D9 E16-U1: source caps and topology refinement for corpus fill rejections

Status: **DRAFT 2026-10-25**, documentation only, for independent review before implementation.

This is rendering-track item E16 ([D9 rendering track](d9-rendering-track.md#status-index)), unit E16-U1: the fix directions F1 and F3 of the [E16 cause record](../evidence/e16-fill-rejection-cause-2026-10-25.md#fix-directions-for-a-contract-not-decided). On 2026-10-25 the remedy was chosen over growing the E11 closed list (recommended option, adopted automatically under the user's standing instruction of 2026-10-24), with the order F1, F3, then F2 and F4 through E14-U2. The [F1 and F3 investigation](../evidence/e16-fill-rejection-cause-2026-10-25.md#f1-and-f3-investigation-2026-10-25) appended to the cause record measured both remedies with scratch probes. It is full tier: it changes fill output, the fill operation id and kernel caps. It changes no threshold of the [P3 acceptance table](p3-fill-stroke-meshes.md#runtime-acceptance-coverage-to-freeze-in-p30b), no tolerance bucket, no share of the 0.25 px budget, no stroke cap and no closed-list class. Identifiers use the prefix **E16-**.

## 1. Causes and what this contract changes

- **Source caps (cause 1, 84 requests).** The six named rows are all line-only polygons: C11 f01 (199 segments), f03 (16 pentagrams, 80 segments), f04 (a 321-segment stair), f06 (5 contours), f08 (6 contours) and C12 j02 (5 contours). Rung 0 meshes f01, f04 and j02 at most transforms once its source caps grow. f03, f06 and f08 cross themselves, so rung 0 refuses them (`CROSSING`) and they need the exact rung, which today stops at B1's 4 contours and 64 segments. For a line-only path the exact rung builds no topology certificate, so the cubic topology caps (4 contours, 64 cubics) do not apply to it.
- **Topology unresolved (cause 3, 993 of the 1,015 `unsupported-geometry` requests).** The last exact step fails at one of three checks: adjacent leaves without a common monotone direction (E8 addendum E8.3, 800 requests), a non-adjacent pair whose hulls meet without a certified transverse crossing (98), or a contour with fewer than three leaves (95). On every such path the leaves are coarse for the curve's turning: at the request's tolerance one or two leaves span a loop, a cusp-like turn or a whole small contour. Every named row of this cause fails only at zoom 0.01, where it is under a device pixel. Re-running the unchanged exact cascade at a finer flattening tolerance meshes 778 of the 993 requests, all 21 named ones among them, at 2^−1 to 2^−12 of the request's tolerance. The other 215 reach the exact rung's edge cap E = 256 before they resolve.
- **Change.** E16-K1 gives rung 0 its own source caps, as E14-K1 did for edges, and gives the exact rung larger source caps for line-only paths. E16-K2 retries the exact cascade at finer tolerances after a topology failure. Fill becomes `geometry-wasm/fill-v0+r4`.
- **Not changed.** The flattener, the tolerance buckets, E = 256, E0 = 8,192, W0, every `FILL_V0_LIMITS` field except `max_contours`, the topology caps (`ABSOLUTE_MAX_CONTOURS` 4, `ABSOLUTE_MAX_CUBICS` 64), rung 0's stages FR1 to FR8 and AL-FR9, the two-step cascade and its order, and every stroke cap.
- **Left to E14-U2 (F2, F4).** After E16-U1, an estimated 463 requests stay outside the closed list: cause 2 (234), cause 4 (10), the four f04 requests at `CLEARANCE` (cause 1, 321 segments over E), and the 215 F3 residuals. Each is a path that rung 0 refuses and whose exact rung stops at E. A02 therefore still fails after E16-U1 alone. The final counts come from E16-A6.

## 2. Terms

- **E** = 256 and **E0** = 8,192, as in [E14 §2](d9-e14-fill-rung0-edge-cap-contract.md#2-terms).
- **Line-only path**: a path with no CUBIC verb, the prefix's `all_line_eligible`. Its exact attempt runs the rounded line fill and no topology certificate.
- **e**: the request's tolerance exponent; the flattening tolerance is 2^e and the topology tolerance 2^(e−1) (`fill_export::tolerances`).
- **The cascade at e**: V2's two steps, `attempt`, then `attempt_triangle_free` after `KnotMismatch` or `Unresolved`, on tolerances(e).
- **Today** means `fill-v0+r3` on `main` d85f634.

## 3. E16-K1: source caps

1. **Rung 0's source caps.** `cubic_fill.rs` gains `MAX_FAST_CONTOURS = 512` and `MAX_FAST_SOURCE_SEGMENTS = 8,192` (= E0). `FAST_CAPS` takes them, with `source_verbs` = S0 + 2·C0 and `source_scalars` = 6·S0 + 2·C0 derived as B1's are, and `flat_commands` = E0 + 2·C0 and `contour_points` = E0 + C0. 512 is the stroke instance's contour cap (`MAX_PIECES`, E2-K3) on the same generic rung; 8,192 means a segment cap never binds before the edge cap, since every nonzero segment makes at least one flat edge.
2. **The exact rung's line-only caps.** A prefix run for the exact rung on a line-only path enforces `B1_LINE_CAPS`: 64 contours and E = 256 segments, verbs and scalars derived the same way. A path with a CUBIC verb keeps `B1_CAPS` (4 and 64) and today's `SourceLimit`. The caps are chosen from `input.verbs` before decoding, where `all_line_eligible` is known today. 64 contours of at least three edges fit within E. `FILL_V0_LIMITS.max_contours` becomes 64, so the rounded line fill takes them; its other fields are unchanged. `certify_topology` runs only on paths with a cubic, so its arrays and the topology limits stay at 4 and 64.
3. **Per-call caps.** As E14-K1 item 2: `prepare_prefix` enforces the fast caps, `attempt*` the exact caps for the path's kind, and every contour check that reads `MAX_CONTOURS` today reads `self.prefix_caps` instead (`decode_sources`, `push_source_range`, `collect_contours` and the two `range_len` checks). A new `contours` field of `PrefixCaps` carries the value.
4. **Rung 0's arrays.** `fill_ladder.rs`'s `MAX_CONTOURS` and `MAX_SOURCES` follow C0 and S0, so `FILL_CAPS` and every array sized from it grow (Alt-A1 §3.4, E2-K3). `MAX_TRIANGLES`, `MAX_DIAGONALS` and `MAX_BOUNDARY_RECORDS` keep their formulas in the new values. `MAX_BOUNDARY_RECORDS` = 3·(E0 + C0 + 2·C0 − 2) and the fill scratch check of E14-K1 item 5 follow.
5. **Storage.** The workspace arrays sized by source caps (`source_verbs`, `sources`, `source_ranges`, `contour_ranges`) leave the inline struct and become heap buffers sized for the fast caps, reserved fallibly at construction and counted in `allocated_bytes`, as E14-K1 item 4 did for the prefix arrays. `attempt_body`'s `references` array is sized by the exact line-only contour cap.
6. **Pre-B1 mode.** `new_pre_b1` keeps `PRE_B1_CAPS` for all three cap sets, so AL-I2, AL-I3, AL-F7 and AL-S1 see today's rung 0 and exact rung.
7. **Allocation rules.** As E14-K1 item 6. The growth of the fill engine's reserved bytes is recorded and is at most 4 MiB (E16-G3).

## 4. E16-K2: topology refinement in the exact rung

1. **Trigger.** In `build_path`, when the cascade at e ends in `Topology(KnotMismatch)` or `Topology(Unresolved)`, and only then.
2. **Retries.** For k = 1 to K, K = 16, while e − k ≥ `MIN_TOLERANCE_EXPONENT`, run the cascade at e − k on the same path, with both tolerances from tolerances(e − k).
   - Success with flat status `PATH_OK`: that attempt's output is the path's result, followed by `build_path`'s usual steps (`map_flat_status`, `refine`, the empty check).
   - `Topology(KnotMismatch)` or `Topology(Unresolved)`: continue with k + 1.
   - Any other result (a sizing status other than `PATH_OK`, `CommandLimit`, `OwnerLimit`, `Rounded(_)`, `Topology(WorkLimit)`, or anything else that maps to a path status): stop.
   - An error that maps to `Mapped::Internal`: the batch self-check fails, as on the first attempt today.
3. **Outcome after a stop or after K.** The path's outcome is the cascade at e's own outcome: today's status, `unsupported-geometry`. A retry never changes a rejected row's status, so E16-G1 holds by construction.
4. **Native diagnostics.** `BuiltPath` gains the refinement depth k, 0 when no retry ran or none succeeded, for tests and the identity tool. No port, framing or adapter change.
5. **Where it lives.** One function runs the cascade with the retries and is used by `build_path` and by `fill_ladder::exact_cascade`, so `FillLadder::run`, the diagnostics and the identity harness see the production order. The seeded defect switches of `build_path` (`cascade_inverted`, `fallback_partial`) apply to every retry as to the first cascade.
6. **Precision.** A retry's mesh is the exact rung's mesh at a finer flattening tolerance: its flattening error is at most 2^(e−k) < 2^e, by the same certificate. The label stays UNVERIFIED until E3's measurement on `r4`.
7. **Cost.** At most K + 1 cascades per path, and only on paths that fail today. Flat edges grow with each halving, so a large path stops at E within a few steps. Rows that are `ok` today run no retry.
8. **Pre-B1 mode.** No retries: the pre-B1 workspace keeps today's single cascade, so the frozen harnesses compare like with like.

## 5. Identity, documents and the precision label

- **Revision.** `FILL_V0_REVISION` becomes 4 in `fill_export.rs` and `fill-adapter.ts`, and `FILL_V0_OPERATION_ID` `'geometry-wasm/fill-v0+r4'` with its literal type. Every literal pin of `fill-v0+r3` follows; E16-U1 finds them with a repository search (today: `fill-adapter.ts`, `tests/geometry/fill-adapter.test.ts`, `p3-al-ob5-analysis.test.ts`, `p3-b0-wasm-analysis.test.ts`, `p3-fill-ladder-analysis.test.ts`, `tests/geometry/p3-fill-ladder/analysis.ts`, `tooling/p3-exit-a05-a06.mjs`, `tests/unit/p3-exit-a05-a06-map.test.ts` and the five GPU specs `p3-v4-paths`, `p3-b2-strokes`, `viz-v1-appearance`, `viz-v2-path-data`, `viz-v3-integration`). Committed evidence files keep their `r3` values. Transport version, `abi_version()` and `portVersion` are unchanged; V3 cache entries keyed by `r3` become unreachable (Alt-A1 §2.2).
- **AL-I3.** A path over the spike's source caps is a new allowed difference (spike `PREFIX`, production any outcome), listed per path like E14's.
- **E11.** The E16-U1 pull request adds dated notes to E11 §3.1 (`+r4` from E16-U1) and §3.2 (E16-U1 joins the preconditions). It changes no closed-list class of §7.2.
- **E3.** The E3 fill rows are measured on `r4`, or re-run if E3-U5 measures `r3` first. Rows that newly mesh enter A04 under E3-Q3.
- **Documents.** Dated notes in Alt-A1 §3.4 ("Caps"), the P3 plan's "B1 kernel caps" and the V2 cascade description point here. No requirement text changes: the outcome classes are E11-U4's, unchanged.

## 6. Gates

- **E16-G1, outcomes (deterministic).** `pnpm test:p3-fill-identity --failure-to-success --revision-change --base <merge base>`: every case is identical to `r3` or moves to `ok` from `work-limit` (K1) or `unsupported-geometry` (K2). No `ok` row changes. The size records are compared as recorded changes, as in E14-G1.
- **E16-G2, cost (diagnostic A/B, native release, one machine).** On the paths that are `ok` at `r3` (the AL-I3 corpus, the scene and the corpus requests), the per-path median time of `build_path` at `r4` is at most 1.10 × the `r3` median, per corpus. On the corpus requests that fail at both revisions, the `r4` time is recorded with the number of retries. A failure of the first bound blocks the unit. It is a gate, not a performance claim.
- **E16-G3, memory.** The growth of the fill engine's reserved bytes is at most 4 MiB, recorded before and after. `process_does_not_allocate_or_move_storage` passes on E16-F1, E16-F2 and E16-F5.
- **E16-G4, claims.** E16 makes no speed claim.

## 7. Acceptance, fixtures and validation

Fixtures are the corpus requests by row, transform and zoom as the sweep serves them, unless written as a literal; their expected results are the investigation's and are confirmed natively before the change runs.

| Fixture | Path | Today | Expected at `r4` |
| --- | --- | --- | --- |
| E16-F1 | C11 f01 at T0, zoom 1 (199-segment polygon) | `work-limit` (`SourceLimit`) | `ok`, rung 0 |
| E16-F2 | C11 f03 at T0, zoom 1 (16 pentagrams) | `work-limit` | Rung 0 `CROSSING`, then `ok` on the exact rung (line-only) |
| E16-F3 | 64 self-crossing quadrilaterals (bowties), 256 segments; and 65 of them; literal fixed in E16-U1 | `work-limit` | 64: rung 0 `CROSSING`, exact `ok` (inclusive caps). 65: rung 0 `CROSSING`, exact `SourceLimit`, `work-limit` |
| E16-F4 | Five crossing ellipses of cubics (a cubic path with five contours) | `work-limit` | Rung 0 `CROSSING`, exact `SourceLimit`, `work-limit` (cubic caps unchanged) |
| E16-F5 | C3 c04 (loop) at T0, zoom 0.01, DPR 1 | `unsupported-geometry` (adjacent leaves) | `ok`, exact rung, refinement depth 4 |
| E16-F6 | C3 c28 (concentric) at T0, zoom 0.01, DPR 1 | `unsupported-geometry` (non-adjacent pair) | `ok`, exact rung, depth 1 |
| E16-F7 | The lowest-index generated C3 request whose minimum-leaves failure resolves; named in E16-U1 | `unsupported-geometry` | `ok`, depth recorded |
| E16-F8 | The lowest-index generated C3 request whose retries stop at `CommandLimit`; named in E16-U1 | `unsupported-geometry` | `unsupported-geometry`, depth 0 (the outcome at e is kept) |
| E16-F9 | C11 f04 at the transform where rung 0 returns `CLEARANCE` | `work-limit` | `work-limit` (321 segments over E; left to E14-U2) |

| ID | Criterion |
| --- | --- |
| E16-A1 | E16-G1 to E16-G3 pass |
| E16-A2 | The fixture table holds, with rung, reason, exact error and depth read through `build_path` natively |
| E16-A3 | Every new mesh of the corpus sweep has zero structure issues (E11-U2 checker), and every new exact mesh within 256 triangles passes the `triangle-mesh` oracle |
| E16-A4 | AL-I1 and AL-I2 hold on every case of the identity tool's native layer with only the failure-to-success moves of E16-G1; AL-I3 holds with only the listed differences of section 5 |
| E16-A5 | Seeded defects are caught: E16-D1 the cubic path given the line-only caps (E16-F4 does not return `work-limit`, or the batch self-check fails); E16-D2 a stopped retry returns its own error instead of the outcome at e (E16-F8 becomes `work-limit`, E16-G1 fails); E16-D3 retries on a path whose cascade at e succeeded (an `ok` row's mesh changes, E16-G1 fails); E16-D4 the exponent bound not checked (a module-level test of the retry schedule at e = `MIN_TOLERANCE_EXPONENT` + 2 sees an exponent below the minimum) |
| E16-A6 | Corpus and scene report: `pnpm p3-exit:sweep --corpus --scene` on the release WASM and `pnpm e16:fill-diag` on its corpus record, with the fill `ok` counts, the rejected requests by cause and the rejections outside the closed list, appended to the cause record. The investigation's counts (80 of 84, 778 of 993) are for comparison, not a gate |
| E16-A7 | The release WASM meshes E16-F1, E16-F2 and E16-F5 through the adapter |

**Validation.** `pnpm check`, `pnpm build`, `pnpm test:geometry`, `pnpm test:p3-fill-identity --failure-to-success --revision-change`, the E16-G2 A/B run and the E16-A6 report. The five GPU specs that pin the operation id run headed in Chrome and Edge on the user's PC, since E11's invalidation table re-runs VZ3-A1 on a fill revision change; they need no new assertion.

## 8. Units

| Unit | Tier | Scope | Files |
| --- | --- | --- | --- |
| E16-U1 | Full | E16-K1, E16-K2, `r4`, E16-F1 to E16-F9, E16-A1 to E16-A7, the notes of section 5 | `cubic_fill.rs`, `fill_ladder.rs`, `fill_export.rs`, `fill-adapter.ts`, their tests, the AL-I3 difference list, the literal pins of section 5 |
| E14-U2 | Full | F2 and F4 for the requests of section 1, "Left to E14-U2": a contract first | [E14 §9](d9-e14-fill-rung0-edge-cap-contract.md#9-units) |

## 9. Questions and decisions

**E16-Q1. Which source caps?** (a) **Recommended.** Section 3: rung 0 512 contours and 8,192 segments; the exact rung 64 contours and 256 segments on line-only paths only. It meshes 80 of the 84 requests in the investigation. (b) Rung 0 only, the cause record's F1: meshes 36 of 84; f03, f06 and f08 stay `work-limit` and fail A02 as named rows. (c) Also raise the exact rung's caps for cubic paths: needs topology caps above 4 and 64, which no corpus row needs.

**E16-Q2. How to resolve the small topology failures?** (a) **Recommended.** Section 4: retry the unchanged exact cascade at e − 1 to e − 16, keep the first success, otherwise keep the outcome at e. It meshes 778 of 993 requests and every named one, with no new certificate. (b) A closed-list class for small unresolved paths: masks named rows (c04, c05, c10 to c12, c20, c21, c28, c29) against "named ordinary fixtures must succeed". (c) Retry in rung 0 at finer tolerances: the investigation found it meshes none of the 215 residuals and refuses most of the 778 (`MONOTONE` or `PREFIX`).

**Decision record.** Pending review.

## 10. Risks

- **E16-R1, retries on failing paths.** Up to 17 cascades per path. A path near E stops within a few steps; a path with many line edges and one small cubic could take all 16. E16-G2 records the time on failing rows; the scene report names the slowest.
- **E16-R2, a finer mesh than requested.** A retried path has more triangles than its tolerance needs, at most E edges. The renderer and the packet sizes take it as any exact mesh.
- **E16-R3, the residuals.** The 215 F3 residuals and causes 2 and 4 keep A02 failing until E14-U2 or a user decision on the closed list.
- **E16-R4, coupling with E14-U2.** E14-U2 changes the exact rung. E16-K2's retry loop calls the cascade; E14-U2's contract states how the two compose.

## 11. Review record

None yet.
