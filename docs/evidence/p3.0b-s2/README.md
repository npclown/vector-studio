# P3.0b-s2 regular-stroke numerical feasibility

Status: **FEASIBILITY_ONLY**. Experimental completion PASS; candidate-wide feasibility **PARTIAL**. Fifty regular cases were independently certified, nine reached the frozen candidate work cap, and three stationary probes remained explicitly unsupported. This does not pass P3 C03-C05 or any runtime stroke/mesh acceptance.

## Scope and provenance

The [prospective contract](../../plans/p3-stroke-numeric-experiment.md) fixed arithmetic, corpus, caps, controls and evidence before implementation/execution. Its exact executed bytes are preserved in [contract.md.txt](contract.md.txt). Base: clean `5f163017a3e56ed0dfec709006f6ac9d1615a9d3`, equal to fetched origin/main; branch `codex/p3-0b-stroke-numeric-feasibility`. The contract/plan and ignored diagnostic tools existed during the run. Product source, dependencies, public APIs and historical results did not change.

Execution date: 2026-09-29; Node `v24.15.0`, Windows x64. Command: `node .tools/p3-stroke-capture.cjs p3-stroke-numeric-run-01`, which exclusively captured `node .tools/p3-stroke-numeric.cjs`. Exit 0, no timeout; first execution only. Source and contract hashes matched before/after. [Capture metadata](capture-01.json) preserves invocation, timestamps and runtime; timestamps do not constitute a benchmark. No GPU/browser/WASM runtime or performance timer was involved.

Source SHA-256: `593053f4bc14bf0b4b378ee6188348c18a37ea31ce1e51290b799fd3d1118431`. Raw decompressed SHA-256: `5a303173902170db2f28f576aaf0551454e3782aac482a7524ea309db8af8b66`. [Manifest](archive-manifest.json) records hashes and byte lengths for source, contract, capture, stderr, independent audit and lossless raw JSON.

## Observations

| Group                     | Observed result                                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Required sanity set       | 20/20 CERTIFIED: R1/R2 at all nine zoom/DPR pairs; R3/R4 at zoom1/DPR1                                                              |
| All regular cases         | 50/59 CERTIFIED; all successful candidate and independent continuous-verifier upper bounds <=1/8 physical pixel                     |
| Uncertified regular cases | Nine CANDIDATE_LIMIT: R4, R5 and R6 at zoom64, each with DPR1/2/3                                                                   |
| Stationary probes         | 3/3 STATIONARY_UNSUPPORTED; no emitted path or invented cusp/cap/join behavior                                                      |
| Rejecting controls        | 5/5 rejected for the required reason after their unmutated baselines certified                                                      |
| Arithmetic/guard checks   | Seven named groups PASS, including exact binary64/rational operations, root brackets, signed intervals and inclusive cap/bit guards |

All nine limited cases stopped before candidate visit 1024, after exactly 1023 visits. The record retains the first unvisited dyadic interval and depth. Their partial accepted prefixes contain 508-510 leaves, but published output count is zero and digest is null; they are not certified partial paths. No case hit the arithmetic, verifier-cell or candidate-depth limit. This demonstrates failure to complete under this candidate's frozen work cap, not observed geometric error above the target and not proof that the intended curve is unsupported.

Among certified cases, maximum work was 255 candidate visits / 128 emitted leaves, 344 verifier cells and 313,516 counted rational operations. Successful bounds are exact rational records; display approximations of the largest candidate/verifier upper bounds are respectively 0.12493948634804315 and 0.12174609500143398 physical pixel. Exact cross-multiplication, not these decimals, decides acceptance.

The five R4 metamorphisms (reversal, reflection, quarter-turn, shear and large exact translation) certified at zoom1/DPR1. These outcomes apply to the rational diagnostic and do not establish production Float64 cancellation or packing precision.

Wrong-output controls rejected as follows:

- Chord-normal R4: geometric endpoint error lower bound `151101894574802934333345/302231454903657293676544`, strictly greater than 1/8.
- Flipped R3 start normal: geometric endpoint error lower bound exactly 2.
- Shifted R1 start: geometric endpoint error lower bound exactly 1.
- Removed first R4 interval: initial coverage gap, before geometric evaluation.
- Duplicated first R4 interval: overlap/order rejection, before geometric evaluation.

## Primary review and delegation

One GPT-5.6 Sol high worker implemented only the ignored standalone diagnostic. A separate GPT-5.6 Sol medium worker audited contract and source read-only. Primary owned the contract, execution, independent record audit, archival and integration. No child delegation, renderer lifecycle changes or new library dependency.

Before implementation, review clarified physical endpoint-error units, absolute depth/caps, first-failure precedence, traversal/digest encoding and valid baseline carriers for controls. Primary rejected an unnecessary cap increase after proving the correlated square-root products fit the existing bit envelope; the auditor agreed. Before the first execution, review repaired unvalidated candidate depth, missing failure intervals, attempted-versus-completed operation counters, lost partial records on fatal errors, missing real guard checks and the bit-check-before-GCD ordering. Candidate and verifier formulas remained separate and conservative. All corrections preceded execution; no unsuccessful run was discarded.

Primary separately checked the raw source/contract hashes, all 62 unique inputs/outcomes, 54 family/scale metadata rows, the 20 required successes, stationary outcomes, exact accepted bounds, caps, zero publication for failed cases and all control reasons/lower bounds. The [independent record-audit source](audit.cjs.txt) reproduces those checks without importing or executing the candidate. The independent worker's final result review is recorded in the active plan.

## Archive and reproduction

- [Diagnostic source](stroke-numeric.cjs.txt), [executed contract](contract.md.txt), [raw JSON gzip](raw-01.json.gz), [stderr](stderr-01.txt).
- [Capture source](capture.cjs.txt), [capture metadata](capture-01.json), [record-audit source](audit.cjs.txt), [manifest](archive-manifest.json).

To inspect and audit existing evidence without rerunning the experiment, execute the following Node code from repository root (PowerShell here-string piped to `node` is sufficient). It refuses to overwrite a prior inspection directory:

```javascript
const fs = require('node:fs');
const zlib = require('node:zlib');
const cp = require('node:child_process');
const source = 'docs/evidence/p3.0b-s2/';
const target = '.tools/p3-stroke-archive-inspect';
fs.mkdirSync(target);
for (const [from, to] of [
  ['stroke-numeric.cjs.txt', 'source.cjs'],
  ['contract.md.txt', 'contract.md.txt'],
  ['capture-01.json', 'capture.json'],
  ['audit.cjs.txt', 'audit.cjs'],
]) {
  fs.writeFileSync(`${target}/${to}`, fs.readFileSync(source + from), { flag: 'wx' });
}
fs.writeFileSync(
  `${target}/raw.json`,
  zlib.gunzipSync(fs.readFileSync(source + 'raw-01.json.gz')),
  {
    flag: 'wx',
  },
);
cp.execFileSync(process.execPath, [`${target}/audit.cjs`, target], { stdio: 'inherit' });
```

For a fresh experiment replay, restore the diagnostic and capture source under their original `.tools` filenames in a clean checkout, refusing replacement with `flag: 'wx'`. Use a fresh `p3-stroke-numeric-run-NN` name with the capture command. The tool's embedded base identifies the original source; the capture wrapper records the actual replay checkout and timestamps. Verify source and contract bytes against the manifest before claiming equivalence; compare deterministic outcomes/counts/geometry digests, not timestamps. Do not overwrite this archived observation.

Validation: `node --check` for diagnostic/capture/audit PASS; first captured experiment exit 0; `node .tools/p3-stroke-audit.cjs .tools/p3-stroke-numeric-run-01` PASS. Explicit document formatting, local links/anchors, whitespace, archive-byte verification and protected CI are recorded in the active plan/PR. Local runtime unit/build/native/browser/GPU/benchmark commands are NOT RUN because no product code changed. Required CI still checks the committed revision.

## Interpretation and next dependency

The regular cone criterion is safe for the certified raw offset generators but insufficient within the frozen work cap for nine high-zoom cases. Next work should investigate a tighter, continuously justified candidate bound under a new prospective experiment; retain this observation and the unchanged target rather than simply raising caps or dropping cases. The independently implemented verifier remains a useful comparison route.

Production Float64 guards, all required regular families at extreme transforms, general stationary/root isolation, cusp handling and numerical source-join/cap construction, miter cutoff/tip precision, final resolved-region topology, round arcs, GPU packing/fringe and mesh transport remain open. The previously approved visible cap/join rules remain fixed. Neither raw offset correspondence nor an experimental sanity gate proves final stroke-region correctness or the full 1,000-path roadmap corpus.
