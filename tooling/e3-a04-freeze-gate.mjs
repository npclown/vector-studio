// D9 E3 unit E3-U3: the freeze gate of the A04 measurement run
// (docs/plans/d9-e3-b4-precision-contract.md section 5.5, step 5 and section 15.3).
//
// "Only then is the kernel run on the corpus": the kernel must not run on `a04-corpus/v1` before
// the freeze note exists. The note is the committed file
// `tests/geometry/e3-a04/corpus-v1.freeze.json`, written when the oracle-only freeze check has
// passed on the full corpus and the dated freeze note has been appended to the contract. The gate
// refuses unless that file exists AND still describes the files on disk: the manifest's
// `corpusSha256`, the generator's SHA-256 and the oracle's source SHA-256 must all be the frozen
// ones. A changed generator or oracle after the freeze is a new version (sections 4.4 and 5.5),
// so the gate also stops a run on a drifted tree.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const FREEZE_NOTE = 'tests/geometry/e3-a04/corpus-v1.freeze.json';
export const MANIFEST = 'tests/geometry/e3-a04/corpus-v1.manifest.json';
export const GENERATOR = 'tests/geometry/e3-a04/corpus.ts';
export const ORACLE = 'packages/geometry-reference/src/a04-region.ts';

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * Returns `{ frozen, problems, freeze, manifest }`. `frozen` is true only when `problems` is
 * empty. It never throws for a missing or malformed note: that is a refusal, not an error.
 */
export function checkFreeze(root) {
  const problems = [];
  const notePath = path.join(root, FREEZE_NOTE);
  if (!existsSync(notePath)) {
    return {
      frozen: false,
      problems: [`no freeze note: ${FREEZE_NOTE} does not exist (section 5.5, step 5)`],
      freeze: null,
      manifest: null,
    };
  }
  let freeze;
  let manifest;
  try {
    freeze = JSON.parse(readFileSync(notePath, 'utf8'));
    manifest = JSON.parse(readFileSync(path.join(root, MANIFEST), 'utf8'));
  } catch (error) {
    return {
      frozen: false,
      problems: [`unreadable freeze note or manifest: ${error.message}`],
      freeze: null,
      manifest: null,
    };
  }
  const need = (field) => {
    if (typeof freeze[field] !== 'string' || freeze[field].length === 0)
      problems.push(`the freeze note has no ${field}`);
  };
  for (const field of ['version', 'frozenOn', 'corpusSha256', 'generatorSha256', 'oracleSha256'])
    need(field);
  const sha = /^[0-9a-f]{64}$/u;
  for (const field of ['corpusSha256', 'generatorSha256', 'oracleSha256'])
    if (typeof freeze[field] === 'string' && !sha.test(freeze[field]))
      problems.push(`${field} is not a SHA-256`);
  if (freeze.freezeCheck === undefined || freeze.freezeCheck === null)
    problems.push('the freeze note records no freeze-check result');
  else if (
    freeze.freezeCheck.oracleWork !== 0 ||
    freeze.freezeCheck.oracleUnsupported !== 0 ||
    freeze.freezeCheck.oracleInconsistent !== 0
  )
    problems.push('the freeze check left ORACLE-WORK, ORACLE-UNSUPPORTED or ORACLE-INCONSISTENT cases');
  if (problems.length === 0) {
    if (freeze.version !== manifest.version)
      problems.push(`version ${freeze.version} differs from the manifest's ${manifest.version}`);
    if (freeze.corpusSha256 !== manifest.corpusSha256)
      problems.push('corpusSha256 differs from the manifest');
    if (freeze.generatorSha256 !== sha256(path.join(root, GENERATOR)))
      problems.push('the generator changed since the freeze');
    if (manifest.generator.sha256 !== freeze.generatorSha256)
      problems.push('the manifest records a different generator SHA-256 than the freeze note');
    if (freeze.oracleSha256 !== sha256(path.join(root, ORACLE)))
      problems.push('the oracle changed since the freeze (a new oracle version needs a new freeze)');
  }
  return { frozen: problems.length === 0, problems, freeze, manifest };
}
