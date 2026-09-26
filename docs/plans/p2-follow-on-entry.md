# D7: provisional P3 planning entry after the P2 reference result

Status: user-approved provisional advancement on 2026-09-26; applied here to P3 planning and contract preparation only.

## Decision and authority

After the explanation that A08 requires 1.20 paired speedup and non-regressing p95, the user instructed: "1배 이상이면 일단 넘어가자. 다음으로" (if it is at least 1x, move on for now; next). This is a sequencing exception using a 1.00 speedup floor, not a retrospective PASS for the original benchmark. It follows [D6](p1-follow-on-entry-proposal.md) and narrows its P3 entry restriction only as specified below.

Permit [P3 planning and private-contract preparation](p3-fill-stroke-meshes.md) without another P2 optimization/reference cycle. For this entry review, require every repetition of the latest valid reference run to have median paired per-path/batch duration ratio >=1.00. Keep the original 1.20 and p95 conditions in the P2 benchmark contract and evaluator. The p95 failures are deferred for this planning entry, not removed from performance acceptance. Do not mark full P2 acceptance complete.

This approval does not choose a public path API, new dependency, tessellation architecture or product-level stroke semantics. Freeze P3 implementation acceptance and resolve any required separate decisions before implementation. P4/P5 entry, P1 A09/A10 and final milestone gates remain unchanged.

## Evidence and limits

The committed [reference-02 result](../benchmarks/results/20260926-p2-batch-v1-reference-02/README.md) measured source `55f609196053d16d59ef5db4c89b5aaa84ef190d`. All ten repetitions have median paired B/A >=1.00: minimum `1.0056921086656014`, maximum `1.0185950413300466`. Therefore the user-selected entry floor is met on that measured revision. This is an explicit post-measurement advancement decision, not a prospectively passed benchmark or statistical proof of improvement.

All ten repetitions failed the original 1.20 criterion. Chrome 2/3/4 and Edge 1/2/5 also failed p95. Raw records, summaries and their FAIL disposition stay immutable. The runner continues to evaluate the original contract; D7 is not an alternative runner profile.

The current implementation additionally includes P2.6e at `b4316201af38af5afda36379ba5e3088b3cdf686` ([PR #51](https://github.com/npclown/vector-studio/pull/51)). Its [functional evidence](../evidence/p2.6e/README.md) does not measure reference performance. Proceeding accepts this uncertainty; do not transfer the older timing result to the latest source. P2 A08 remains FAIL on the last measured revision, latest-source performance remains UNVERIFIED, and further performance remediation is deferred while P3 planning proceeds.

## Dependency change

```text
P2 A01-A07 evidence + reference-02 every paired median >=1.00 + user D7
  -> P3.0a execution-plan entry
  -> P3.0b private contract, independent oracle and feasibility freeze
  -> implementation readiness review (separate API/product decisions if needed)

original P2 A01-A08 evidence -> full P2 acceptance (still open)
all P1 A01-A10 evidence -> P1.7 final acceptance (unchanged)
P3/P4/P5 final and later-entry gates (not waived)
```

## Risk and review boundary

P3 work may need rework if remaining P2 tail cost or P1 memory/latency obligations expose a foundational limitation. This checkpoint deliberately advances only documentation and contract preparation, with no product code, public API, benchmark logic or external dependency change. Primary owns consistency across the roadmap and plans and reviews delegated findings before adoption.

Validation for this documentation checkpoint: inspect the committed aggregate and its revision identity; check changed Markdown formatting, local links/anchors and whitespace; review scope against the owning requirements/architecture; require the protected PR static/unit/build check. No new browser/GPU/benchmark run is required or claimed.
