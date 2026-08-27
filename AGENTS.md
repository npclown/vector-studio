# Repository agent guide

This file is the source of truth for repository navigation and agent working rules. It does not define product behavior, architecture details, milestone scope, or test thresholds; follow the linked documents for those decisions.

## Read order

Before changing the repository, read the documents relevant to the task in this order:

1. `AGENTS.md` for workflow and navigation.
2. `docs/requirements.md` for product scope and user-visible requirements.
3. `ARCHITECTURE.md` for system boundaries and allowed dependency direction.
4. The relevant subsystem design, currently `docs/graphics-engine-architecture.md`.
5. `docs/prototype-plan.md` for milestone order and exit gates.
6. The active plan under `docs/plans/`, currently `docs/plans/p0-webgpu-foundation.md`.
7. `docs/validation.md` and `docs/benchmarks/README.md` before claiming verification or performance results.

When instructions conflict, the narrower document owns details inside its declared responsibility. A product requirement cannot be changed implicitly by an implementation plan, and a benchmark result cannot redefine its acceptance threshold.

## Documentation ownership

| Document | Source of truth for | Must not duplicate |
| --- | --- | --- |
| `AGENTS.md` | Repository navigation, agent workflow, change discipline | Product or technical design |
| `docs/requirements.md` | Product goals, supported behavior, scope and deferrals | Implementation sequence |
| `ARCHITECTURE.md` | System boundaries, ownership, dependency direction | Renderer algorithms |
| `docs/graphics-engine-architecture.md` | Graphics-engine internals and accepted rendering decisions | Whole-system package policy |
| `docs/prototype-plan.md` | P0-P5 milestone order and milestone-level gates | Active task checklist |
| `docs/plans/p0-webgpu-foundation.md` | P0 execution order, status, acceptance criteria and evidence | Cross-project validation policy |
| `docs/validation.md` | Test layers, validation policy and evidence requirements | Benchmark thresholds or results |
| `docs/benchmarks/README.md` | Benchmark methodology, metadata schema and result format | Milestone scope |
| `docs/benchmarks/results/*` | Immutable observations from individual runs | Requirements or thresholds |

## Working rules

- Preserve the direction `requirements -> architecture -> plan -> implementation -> evidence`.
- Do not write product code for a milestone until its execution plan has explicit acceptance criteria and validation methods.
- Update the active execution plan as work progresses. Mark an item complete only when its listed evidence exists.
- Keep durable document data independent from renderer, browser, GPU, React, and WASM runtime objects.
- Do not introduce a runtime renderer, scene graph, path renderer, or tessellation dependency without a new architecture decision and explicit user approval.
- Treat WebGPU resources and WASM allocations as reconstructible caches, never as the source of truth.
- Add or change a dependency only in the package that owns its use. Do not expose implementation dependencies through public contracts.
- A behavior change requires a requirement or architecture update before or with the code change.
- A performance claim requires a committed benchmark result that follows `docs/benchmarks/README.md`.
- Keep unrelated user changes intact. Never rewrite or remove work outside the active plan.

## Git and GitHub workflow

`main` is the protected integration branch. After the one-time repository bootstrap described below, no implementation, refactor, test, benchmark, or documentation change is committed or pushed directly to `main`.

For each independently reviewable work unit:

1. Start from an up-to-date `main` with a clean worktree.
2. Create an agent branch named `codex/<plan-item>-<short-slug>`, for example `codex/p0-0-repository-foundation`.
3. Keep the branch scoped to one execution-plan checkpoint or one tightly coupled correction.
4. Make changes and run the validation required by the active plan while changes are still uncommitted.
5. Review the diff for scope, generated files, secrets, dependency changes, and unrelated edits.
6. Update plan status and evidence, then create a focused commit only after local validation passes.
7. Push the feature branch and open a pull request targeting `main`.
8. Put the plan item, acceptance criteria, validation commands, benchmark result links, risks, and deferred work in the pull-request description.
9. Treat required remote checks and review as additional gates. Fix failures on the same feature branch and revalidate before each follow-up commit.
10. Merge only through the pull request. Prefer squash merge for a single work unit unless preserving multiple commits materially improves history.
11. Delete the remote feature branch after merge and begin the next work unit from the updated `main`.

Do not force-push or rewrite `main`. Do not bypass a required check, fabricate evidence, or merge an unvalidated change. A documentation-only emergency still uses a pull request after bootstrap unless the user explicitly authorizes an exception.

### One-time bootstrap exception

An unborn repository cannot open a pull request into a nonexistent default branch. The only permitted direct `main` commit is a user-authorized, documentation-only initial baseline that:

- renames the unborn branch to `main`;
- contains repository governance and planning documents but no product implementation;
- is pushed to establish `origin/main`;
- is followed immediately by default-branch and pull-request protection setup where the hosting plan permits it.

This exception expires as soon as `origin/main` exists. Record completion in the active execution plan.

### Pull-request gate

A pull request is ready for merge only when:

- its scope matches one active plan work unit;
- all applicable local acceptance criteria have evidence;
- the branch is up to date enough to evaluate conflicts and required checks;
- required CI checks pass;
- benchmark claims link to committed result records;
- unresolved risks and intentionally deferred items are explicit;
- no secrets, machine-local caches, or unrelated files are included.

### Pull-request description format

Every pull request created by an agent must use reviewable Markdown rather than compressing evidence into a paragraph. Use these required sections in this order:

```markdown
## Summary

- Describe the outcome and why it is needed.
- Keep each point independently scannable.

## Scope

State what is included and call out important exclusions or deferred work.

## Validation

- `exact command or check` — PASS: concrete result, count, or observation.
- `another command or check` — PASS: concrete result.

## Gate

State which execution-plan checkpoint or acceptance criteria this PR satisfies, and what remains before the next gate.
```

Rules:

- `Summary`, `Scope`, `Validation`, and `Gate` are required `##` headings.
- `Summary` and `Validation` use bullet lists.
- Validation entries name the actual command or check and its result. Do not write only “validated”, “tests passed”, or similarly unauditable claims.
- If a required check was not run, say `NOT RUN` and explain why; do not omit or imply success.
- Add `## Benchmark` only when the work includes benchmark execution or performance claims. Include scenario/version, environment, command, metrics, thresholds, and result-record links.
- Add `## Design Decisions` only when the PR introduces or changes an important architecture decision. Summarize the decision, consequences, and links to the owning architecture or decision record.
- Do not add empty, irrelevant, or speculative sections merely to fill a template.
- Prefer creating the PR body from a Markdown file or another method that preserves real line breaks and lists. Do not pass a compressed one-paragraph body when using GitHub CLI.

## Change workflow

1. Identify the owning source-of-truth document.
2. Check the active plan and its current gate.
3. Add or revise acceptance criteria before implementation when behavior is new or ambiguous.
4. Make the smallest change that crosses one plan checkpoint.
5. Run the validation required by that checkpoint.
6. Record commands, environment, artifacts, and unresolved risks in the plan or benchmark result.
7. Update documentation only where ownership requires it; link instead of copying text.

## Completion rule

A task is not complete because code compiles or a visual appears. Completion requires every applicable acceptance criterion to be linked to reproducible evidence. If hardware, browser policy, or unavailable tooling prevents validation, mark the plan item blocked or unverified rather than weakening the criterion.
