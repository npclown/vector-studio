# P3.0b contract preparation and closed-contour feasibility

Status: **FEASIBILITY_ONLY**. The small closed-contour experiment passes; P3 C03-C05 and all runtime acceptance remain incomplete. The [private contract](../../plans/p3-private-contract.md) is a preparation draft and the [visible-semantics proposal](../../plans/p3-visible-semantics-proposal.md) awaits the user's product decision.

## Scope and provenance

Preparation date: 2026-09-29. Base `4928a88eb45ef3f4b1d4716e432a2a1fe9eca358`, initially clean and equal to fetched origin/main; branch `codex/p3-0b-contract-review`. Documentation drafts and the ignored diagnostic script existed during execution, so this is not a clean-source production run. Product source, existing P2 benchmark/evaluator, dependencies and historical observations are unchanged. Source identity is the exact standalone tool hash below.

Environment: Windows x64, Node v24.15.0. No browser/GPU/device, external library, trace or performance timer was used. This is not a benchmark and carries no speedup or full-corpus claim.

The [execution plan](../../plans/p3-fill-stroke-meshes.md#independent-closed-contour-topology-experiment) fixed the method and limits before execution: closed integer line contours only, exact BigInt rational intersections/slabs, independent direct ray classification, analytic areas, interior/exterior probes and corrupt-output positive controls. Limits were 16 directed edges, 120 pair checks, 256 x events and 4,096 cells per rule. These are diagnostic safeguards, not production work limits.

## Execution and observations

Command: `node .tools/p3-0b-topology.cjs`, captured by a Node `spawnSync(process.execPath, [source])` wrapper into exclusively created `.tools/p3-0b-topology-01.json`. The wrapper checked source bytes before/after; exit 0, first executed version PASS. Pre-execution review corrections are described below; no failed run was discarded.

- Twelve fixture variants, each under nonzero/evenodd: 24 rule cases.
- All 24 exact areas match literal expectations. F01 100/100; F02 100/84; F03 84/84; F04 100/0; F05 0/0; F06 8/8; F07 8/8; F09 repeated-point 100/100; F09 contour-permutation 100/84; F10 same 24/16; F10 reversed 16/16; F11 32/32.
- Sixty literal samples and 516 generated interval/gap/outside probes agree with the direct oracle, with zero skipped source-edge candidates in this run.
- F07/F11 have four explicit shared-edge cases across the two rules: a boundary of a source contour is interior to the resolved region. F11's middle slab spans y=0 through y=8 without retaining y=4 as a region boundary.
- Removing one nonzero-area cell fails area validation. Duplicating one cell fails both area and interior-multiplicity validation. No invalid output is accepted by these positive controls.
- Maximum observed work per fixture/rule: 8 directed edges, 28 pair checks, 4 x events and 4 emitted cells, within the frozen small-input caps.

These are trapezoid cells, not a production indexed mesh. The 516 generated points are finite differential probes, not a proof of complete region equivalence. Their locations partly depend on slab intervals, while classifications use the separately coded ray oracle; literal areas and samples independently constrain this correlation. Exact rational success does not establish a robust Float64 implementation or continuous curve/stroke error.

## Primary review and delegation

One GPT-5.6 Sol worker with medium reasoning performed the independent technical audit and document review, then prepared only the ignored diagnostic script under the frozen scope. No child delegation. Primary owns documents, visible-choice escalation, contract decisions, execution, source/raw review and acceptance interpretation.

Before execution, Primary found that strict x-interval membership would misclassify F06's non-boundary samples on an event column, F09 combined two required metamorphic cases, and the first tool lacked generated interval/gap probes. The worker corrected these, moved edge-limit checking before the first excess insertion and preserved failure provenance. Primary reread the affected routines before the first run. No implementation acceptance was substituted for diagnostic success.

Primary independently recomputed all 24 areas from archived cells against separately enumerated expected areas, counted the 60/516 samples and four shared-edge records, and verified archived source/raw hashes. The worker independently audited the completed records read-only and agreed with these counts and the narrow interpretation. No rerun was needed.

The technical audit also identified two separate budget conflicts: P2 flattening and P1 GPU placement each permit the full 0.25 physical pixel. Primary recorded a separate P3 budget/operation direction, retained the combined target, and left actual stroke/packing proof, coverage representation, ABI and work caps open. Primary rejected adopting a single undifferentiated fill/stroke union paint or an inside-only coverage ramp without proof. This experiment does not resolve those blockers.

## Archive and reproduction

[Archive manifest](archive-manifest.json) records byte counts and SHA-256 for the [standalone source](topology.cjs.txt) and [lossless raw result](topology-01.json.gz).

- Source SHA-256: `e065573caa339c405a7abfdf49142167fad508b710639b7e3f0ded88c8a6bb1e`.
- Decompressed raw SHA-256: `3a349ff6e11e97beb1766156469d579e3bb244eee093495e23540bf6061909e6`.

Restore the source to a fresh `.cjs` name under ignored `.tools` and execute from the repository root using the pinned Node runtime. This example refuses to overwrite either replay artifact:

```javascript
const fs = require('node:fs');
const cp = require('node:child_process');
const source = '.tools/p3-0b-topology-replay.cjs';
const output = '.tools/p3-0b-topology-replay.json';
fs.mkdirSync('.tools', { recursive: true });
fs.writeFileSync(source, fs.readFileSync('docs/evidence/p3.0b/topology.cjs.txt'), { flag: 'wx' });
const fd = fs.openSync(output, 'wx');
const run = cp.spawnSync(process.execPath, [source], { encoding: 'utf8' });
fs.writeFileSync(fd, run.stdout);
fs.closeSync(fd);
process.exitCode = run.status ?? 1;
```

Run this CommonJS snippet through `node` stdin from PowerShell. A replay records its own invocation/base revision; compare fixture contents and scoped results, not whole JSON identity across different checkouts. Recover the original raw bytes with `node:zlib.gunzipSync`; do not edit the committed observation.

## Gate and validation limits

Source/raw/archive hash review and the diagnostic command PASS. Changed-document formatting, local link/anchor and whitespace checks plus protected CI belong to this checkpoint PR. Local `pnpm check`, build, browser/GPU and benchmark commands are NOT RUN: no product code changed and this preparation does not make a runtime/performance claim.

The next product decision is the explicit visible-semantics table. Technical work still required before C03-C05 freeze includes robust topology on the full corpus, continuous stroke error, mesh-specific GPU precision, coverage/composition, exact ABI/statuses and measured work-cap feasibility. P3.1/P3.2 product acceptance is not unlocked by this small experiment; P2 A08 and P1 A09/A10 remain unchanged.
