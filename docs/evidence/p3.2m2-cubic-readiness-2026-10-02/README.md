# P3.2m2 full cubic readiness observation

Status: M05 observation COMPLETE and independent full-frame AUDIT PASS. This is a diagnostic readiness record, not a performance result or full P3 acceptance. The [frozen census contract](../../plans/p3-cubic-census-contract.md) owns the unchanged workload, proof target, limits and reporting semantics; the [active plan](../../plans/p3-fill-stroke-meshes.md) owns execution status.

## Source and reproduction

The single full observation started from clean integrated source `9508a6615f6b6e941aee26802a49eb9ca1b9dbd0` on `codex/p3-2m2-cubic-readiness-evidence`, following [PR #74](https://github.com/npclown/vector-studio/pull/74). Its required CI passed on `55c2203d89e87b4b13dc6ba11db3cb26fb15e7c3` ([run36985763300](https://github.com/npclown/vector-studio/actions/runs/36985763300), job110770307120). The worktree remained clean throughout RUN and AUDIT.

- Exact command: `node tooling/run-p3-cubic-census.mjs --full --output .tools/p3-2m2-cubic-readiness-20261002-01`.
- Environment: Windows x86_64, Node24.15.0, pnpm11.1.2; Rust1.94.1 commit `e408947bfd200af42db322daf0fadfe7e26d3bd1`, host `x86_64-pc-windows-msvc`. Native-only; no ambient WASM/browser/GPU dependency.
- Workload: frozen `p2-batch/v1`, seed `0x12345678`, exactly1000 paths with32 connected cubics each. Diagnostic tolerance1/8 under the identity screen transform. This does not change the P2 performance workload tolerance or threshold.
- RUN started2026-10-02 17:49:35 Asia/Seoul and passed its single census test; AUDIT started17:56:16 and passed its separate full-frame replay test. No retries or post-observation bound changes were used.
- Start/end normalized source manifest SHA256 both `d443f5e5e18d5b60c11cb546cbaa15e36da5abec1bc8f58cd1df4f27b5507f0b` (62 entries). The start-only invocation intentionally has a null end hash; the completed census records both.

To reproduce, check out the recorded source, satisfy the pinned toolchain and clean-worktree checks, and use the same command with a fresh ignored output directory. The wrapper executes both RUN and AUDIT. The local output directory retains native input/output frames and phase logs; these machine-local artifacts are not committed. Every row binds source and native frame hashes. A fresh reproduction regenerates the frames and repeats all proofs; the archived audit is evidence of the completed original replay, not a substitute for a future replay.

## Immutable records

The following are copied byte-for-byte from the completed output. Do not format or edit them.

| Record                             |   Bytes | SHA256                                                             |
| ---------------------------------- | ------: | ------------------------------------------------------------------ |
| [invocation.json](invocation.json) |   11999 | `460b63483f0377832674bd9296400940d2c259c003e504df5938228cbd0763d6` |
| [census.json](census.json)         |   13498 | `869c93b782d833cb6e28503bf4e80ee65155edfc6e68e5fe06c38af8d34cf803` |
| [rows.ndjson](rows.ndjson)         | 7381226 | `e9536c9b8c51aa6bc5132692c8bb506b367da8e010ffbabd80e800b873a2d634` |
| [audit.json](audit.json)           |    1514 | `ba298dabe8306c233b105a7d25b29323b10962c23dd9e3d0d7e31070e081dd80` |

## Observations and limits

All1000 ordered rows completed successfully at the native ABI level, with zero capacity retries. All32000 source-cubic position proofs are CERTIFIED. They cover each source's canonical start and supplied leaf provenance under P3.1d; this record does not claim topology or a more general globally carried rounded-source-start proof.

All1000 preparation results are `KNOT_MISMATCH`, with concrete retained findings. The later projection stage is therefore not established. All1000 sources also exceed the current cheap private caps:33 verbs/194 scalars versus24/104. The later16-source decode cap is not reported as an additional executed failure. Increasing capacity alone cannot satisfy the current exact-knot prerequisite.

Emitted lines total1326192, ranging from1202 to1461 per path; observed maximum depth is6. The prospectively proved depth7/128-per-source/4096-per-path ceiling remains unchanged. Boundary proof cells total1327342 with maximum64 at path9/source ordinal26. Maximum certified squared error is exactly `18888890647396521515625 / 1208925819614629174706176` at path287/source ordinal28, below1/64.

There are1000 prospective implicit closure edges. Prospective edges total1327192, maximum1462 at path463. Prospective unordered pairs total881038654, maximum1067991 at path463. These counts do not claim zero-edge normalization, disjointness, crossing support or successful topology. Every row records pair topology `NOT_EVALUATED`. Intersection, rounded fill and mesh stages were also not evaluated.

## Review and validation

Primary owned execution, source freeze, archive and interpretation. A GPT-5.6 Sol medium reviewer independently parsed all1000 journal rows without importing the runner schema or summarizer; it checked identities, source/cubic order, hashes, statuses, exact rational comparison, every aggregate and source manifests. That independent arithmetic/source audit PASS agrees with the separate built-in full-frame AUDIT, which regenerated inputs and recomputed complete rows and proofs. The subsequent independent archive/README/active-plan review also PASS: no result or scope mismatch. No recursive delegation.

- Full command above: PASS,1000 rows, complete summary and null failure; separate AUDIT PASS with matching census/journal hashes and summary.
- Independent journal/source arithmetic audit: PASS, all1000 rows and62 manifest entries match; no inconsistent count, out-of-range finding or hash was found.
- Archive copy/hash comparison and staged-byte verification: PASS, all four byte lengths and SHA256 values match the captured originals.
- Changed-Markdown formatting and `git diff --check`: PASS. Repository Markdown link audit: PASS,686 local links/anchors across136 Markdown files.
- Numeric unit suites and build: NOT RERUN locally in this evidence-only checkpoint; unchanged tooling was validated locally and by PR #74 CI. Required CI still gates this checkpoint's integration.
- Browser/GPU, benchmark, full P3 gate: NOT RUN; not applicable to this diagnostic checkpoint. Historical P2 A08 FAIL and latest-source performance UNVERIFIED remain unchanged. Stroke refinement remains user-deferred.

## Next prerequisite

A separately frozen, test-only rounded-internal-knot topology certificate is the next candidate. Keep source endpoints exact so the existing P3.1d per-source positional proof continues to cover the actual chain. Expanded source/line hulls and a common directed projection at every cyclic adjacent join need an independent proof and fixed analytic controls before implementation. The present census does not establish that this prospective certificate will accept these1000 paths. General crossings, tangencies, larger runtime capacities, mesh composition and final P3 gates remain open.
