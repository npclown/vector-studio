# Planning and design review: 2026-09-05

Status: Local validation PASS; PR/remote validation tracked in GitHub

## Scope and provenance

- Baseline: `2df8848`, clean `main`, equal to `origin/main` after `git fetch origin`.
- Review branch: `codex/p0-docs-design-review`.
- Environment: Windows/PowerShell, Node `24.15.0`, pnpm `11.1.2` (confirmed with `node --version` and `pnpm --version`).
- Scope: Markdown ownership, design boundaries, requirement coverage, P0 acceptance and benchmark evidence policy. Product code, dependencies, and historical GPU/benchmark artifacts are unchanged.
- Owning checkpoint: [P0 documentation review](../plans/p0-webgpu-foundation.md#documentation-review-checkpoint).

## Findings and disposition

| Finding                                                                    | Source inspected                                                           | Documentation outcome                                                                              |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Contradictory geometry dependencies and scene/backend input                | `ARCHITECTURE.md`, graphics architecture, current package boundary checker | [ADR 0001](../decisions/0001-port-composition.md) and separate scene/backend ownership             |
| MVP features have no explicit relationship to graphics milestones          | Requirements and P0-P5 roadmap                                             | [Coverage map](../prototype-plan.md#requirement-coverage), P5 gate, future plan entry requirements |
| Camera/suballocator/cache omitted from P0 acceptance                       | Roadmap vs active plan, backend/platform source                            | P0.5a and A13-A15; still unimplemented                                                             |
| Terminal recovery rule differs from implementation                         | `WebGpuBackend.initialize`, recovery handler, failure unit test            | P0.5b correction and regression acceptance; code unchanged                                         |
| Submission counted as presentation; constant stale counter                 | `WebGpuBackend.#render`, statistics and GPU tests                          | Explicit evidence limits and unverified timing/counter claims                                      |
| Re-running benchmarks overwrites old files; metadata/observers can mislead | `tests/benchmark/p0-3-foundation.spec.ts` and committed result JSON        | P0.5 exporter/schema requirements and benchmark provenance policy                                  |
| Native OOM not exercised by hardware test                                  | Unit error mapping and `tests/gpu/webgpu-recovery.spec.ts`                 | P0-A07 hardware OOM remains UNVERIFIED                                                             |
| Validation document predates toolchain; Markdown excluded from formatting  | `package.json`, `.prettierignore`                                          | Current command table and explicit Markdown checks                                                 |

These are source-review findings, not new runtime reproductions. Original P0.3/P0.4 observations remain intact; no performance threshold is lowered and no new benchmark result is claimed.

## Validation

- Local Markdown links/anchors using the script below: PASS, 14 local links/anchors across 18 Markdown files.
- `pnpm exec prettier --check --ignore-path <empty-ignore-file> <changed-markdown-files>`: PASS, all 10 changed/new Markdown files; see the reproducible path-selection command below.
- `git diff --check`: PASS, no whitespace errors.
- `pnpm check`: PASS, repository formatting, ESLint, TypeScript, 45 tests across 8 Vitest files, and four-package dependency-boundary validation.
- `pnpm build`: PASS, all three library packages and the Vite playground production bundle (16 transformed modules).
- `git diff --name-only` and `git ls-files --others --exclude-standard`: PASS, only the 10 intended Markdown documents; no product, lockfile, or historical run artifact changes. `results/TEMPLATE.md` is a template, not a run record.
- `pnpm test:browser`, `pnpm test:gpu`, and benchmarks: NOT RUN; documentation-only changes do not require new runtime/performance evidence. The legacy benchmark also overwrites historical results.
- Required remote CI: the PR's `Static, unit, boundaries, and build` job must pass on the committed revision; its outcome is tracked in GitHub rather than predicted by this local record.

## Reproduce the local Markdown link check

Run from the repository root in PowerShell. This checks existing local file targets and Markdown heading anchors in tracked and untracked non-ignored Markdown. It does not fetch remote URLs or interpret code-formatted path mentions as links.

```powershell
$reviewText = Get-Content -Raw -Encoding UTF8 docs/evidence/docs-review-2026-09-05.md
$reviewScript = [regex]::Match($reviewText, '(?ms)^\x60{3,}javascript\r?\n(.*?)^\x60{3,}\s*$').Groups[1].Value
if ([string]::IsNullOrWhiteSpace($reviewScript)) { throw 'Link-check script not found' }
$reviewScript | node --input-type=module
```

```javascript
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const files = [
  ...new Set(
    execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'], {
      encoding: 'utf8',
    })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean),
  ),
];
const withoutFences = (text) => text.replace(/^\x60{3,}[^\n]*\n[\s\S]*?^\x60{3,}\s*$/gm, '');
const anchors = (file) => {
  const duplicates = new Map();
  return new Set(
    [...withoutFences(readFileSync(file, 'utf8')).matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => {
      const base = match[1]
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_\-\s]/gu, '')
        .replace(/\s/g, '-');
      const count = duplicates.get(base) ?? 0;
      duplicates.set(base, count + 1);
      return count === 0 ? base : `${base}-${count}`;
    }),
  );
};
let checked = 0;
const failures = [];
for (const file of files) {
  const source = withoutFences(readFileSync(file, 'utf8'));
  for (const match of source.matchAll(/\[[^\]\n]*\]\((<[^>]+>|[^)\s]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, '');
    if (/^[a-z][a-z\d+.-]*:/i.test(target)) continue;
    const [relative, fragment] = target.split('#');
    const resolved = relative
      ? path.resolve(path.dirname(file), decodeURIComponent(relative))
      : path.resolve(file);
    checked += 1;
    if (!existsSync(resolved)) failures.push(`${file}: missing ${target}`);
    else if (
      fragment &&
      resolved.endsWith('.md') &&
      !anchors(resolved).has(decodeURIComponent(fragment))
    )
      failures.push(`${file}: missing anchor ${target}`);
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`PASS: ${checked} local links/anchors across ${files.length} Markdown files`);
}
```

For Markdown formatting, run the following before commit (or use the PR diff against `origin/main` after commit). The repository default excludes Markdown, so `pnpm check` alone is insufficient here.

```powershell
$reviewDocs = @((git diff --name-only -- '*.md')) + @((git ls-files --others --exclude-standard -- '*.md'))
if ($reviewDocs.Count -eq 0) { throw 'No changed Markdown paths; select the PR diff after commit' }
$reviewIgnore = New-TemporaryFile
pnpm exec prettier --check --ignore-path $reviewIgnore.FullName @reviewDocs
$reviewFormatExit = $LASTEXITCODE
Remove-Item -LiteralPath $reviewIgnore.FullName
if ($reviewFormatExit -ne 0) { throw 'Markdown formatting failed' }
```

## Remaining gate

This review establishes documentation acceptance and follow-up work only. P0.5, P0.5a, P0.5b, and P0.6 remain open. Hardware OOM and genuine presentation timing need appropriate evidence or a prospective owning-design revision; the documentation change cannot supply those observations.
