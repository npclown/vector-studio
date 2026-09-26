# D6 proposal: continue development while P1 measurement gates remain open

Status: **PROPOSED, NOT APPROVED.** Recording this proposal or merging its documentation does not authorize its execution. The user's instruction to continue autonomously preserves the earlier requirement to ask about changes to acceptance or product-level sequencing.

## Problem and unchanged commitments

P1.6a is integrated through [PR #36](https://github.com/npclown/vector-studio/pull/36) at `fe84ce2`. Its functional observations do not close A09 simultaneous combined memory or A10 pointer-to-physical-presentation. [D5](p1-instanced-primitives.md#d5-approved-p16a-runner-entry-exception-2026-09-26) still blocks full P1.6, P1.7 and P2. The [current coverage audit](../evidence/p1.0m-current-coverage-2026-09-26.md) identifies the remaining evidence gaps in implemented code.

Keep A09 at simultaneous combined peak <= 256,000,000 bytes and A10 at pointer-to-present p95 < 50 ms. Keep their category, timing, identity and evidence rules. Do not label P1 complete, replace a physical endpoint with queue completion, or use sampled memory as a proven peak. Previously accepted correctness evidence and raw observations remain unchanged.

## Concrete proposed dependency change

1. Permit a separate P1.6b plan for A05 CPU geometry/update observations and the frozen A08 reference-duration runner, without waiting for A09/A10. Freeze acceptance and metadata before implementation; retain every repetition and failure. Criterion-specific A05/A08 results must be clearly separate from overall P1 acceptance. Hardware runs still require a valid reference environment and run serially.
2. Permit P2 planning while P1.6b proceeds. Begin P2 implementation only after its own execution plan, private geometry/ownership contracts, independent oracle and validation methods are explicit. Use existing accepted Rust/WASM architecture; this exception does not choose new public API meanings, approve dependencies, or waive any later milestone criterion.
3. Preserve `all P1 A01-A10 evidence -> P1.7 final acceptance`. A09/A10 remain open P1 obligations during P2; P2 progress must never be represented as resolving them. This proposal does not by itself authorize P3-P5 implementation.

Proposed graph, effective **only after explicit approval**:

```text
P1.6a integrated -> P1.6b A05/A08 plan -> implementation -> criterion-specific validation
P1.6a integrated -> P2 execution plan -> P2 contract/validation freeze -> P2 implementation
P1.0m A09/A10 methods -> full P1.6 measurement readiness
all P1 A01-A10 evidence -> P1.7 final acceptance
```

Primary keeps shared contracts and cross-module decisions. Delegate only disjoint implementation after contract freeze; use Sol medium for geometry/algorithm work, Terra medium for local fixtures, and Luna low for command-only validation where it frees Primary for review. No recursive delegation by default.

## Risk and alternative

This accepts possible rework in P2 if later P1 memory or latency measurements require architectural changes. It does not lower the thresholds, but it changes when their evidence is required relative to implementation; that sequencing risk is a user decision.

Alternative: retain D5 exactly. Continue only P1.0m strict-method investigation; no P1.6b reference measurement or P2 implementation starts. A bounded new browser/OS instrumentation or optical method would require its own concrete scope, compatibility and cost review. Another unchanged PresentMon CSV or sampled heap result is insufficient.

## Approval application checklist

Before executing an approved option, record the user's selected scope/date in the active P1 plan, this proposal and the roadmap. Update dependency edges consistently. Freeze the next task's acceptance criteria and validation methods before product code. Additional external dependencies, API meaning changes, core architecture changes, new UAC/tool acquisition and acceptance-semantic changes retain their separate user-decision requirements.
