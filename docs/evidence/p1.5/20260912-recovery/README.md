# P1.5 final visual and recovery validation

Disposition: **PASS — 16 tests, 1.4 minutes**, on 2026-09-12. This successor establishes all 240 visual fixtures and four latest-scene recovery cases after the two test-harness corrections described in the [Primary review](../../p1.5-visual-review-2026-09-12.md).

```powershell
$env:P1_EVIDENCE_OUTPUT_DIR='artifacts/p1.5/recovery-20260912-2'
pnpm test:gpu --grep 'P1 (visual|latest-scene)'
```

## Source and evidence

[source-manifest.json](source-manifest.json) and [source.zip](source.zip) retain 101 exact source/configuration files on base `c3e124685567acd6f5dacee05be19c86d857e48c`, with manifest SHA-256 `69b2225fec82145341ea00eb275c7cf14b66bc461ae187e77e0e6aa36abf1f97`. Every test records the same start/end source hash. [accepted.zip](accepted.zip) preserves full PNG/raw RGBA, per-test source manifests and observations. [summary.json](summary.json) identifies all 16 report hashes and their review outcome.

The source differs from the [N02 matrix capture](../20260912-matrix/README.md) only in `apps/playground/src/p1-fixture.ts` and the recovery body of `tests/gpu/p1-primitives.spec.ts`. The former allows exactly one intentionally destroyed old-generation loss while waiting for recovery; the latter asserts the exact lifecycle and uses a fresh revision for the unsupported-container input. Renderer product code, corpus, shader, native probe and both oracles are unchanged. The linked Primary review explicitly assesses reuse of the unchanged N02 results.

The earlier `recovery-20260912-1` command had 12 passed and four failed tests because the rejection fixture was stale. [rejected-stale-fixture.zip](rejected-stale-fixture.zip) preserves that attempt, including its measured source and runner error contexts. It is not silently replaced or counted as a passing invocation.

## Verified behavior

- Chrome `152.0.7977.83` and Edge `153.0.4234.32`, NVIDIA/Turing native adapter, Windows `10.0.26200` x64, headed, one worker, development build. Full limits/features are in each report. Viewport, DPR, target/readback and capability injection match the matrix record; recovery uses DPR 1 and both sample counts.
- All 12 visual matrices repeat 20 V01–V07 fixtures, DPR 1/1.5/2, samples 1/4, under unchanged color and contour tolerances.
- Three warmed unchanged frames upload no packet ranges and reproduce the same image. The isolated transform edit uploads only `transforms`, offset 0, 32 bytes, with no new pipeline or shader module during warmed frames.
- The intentional generation-1 loss is followed by generation-2 recovery start and success in order, with the correct loss context. Exactly that one loss error exists; unexpected errors and page errors are absent.
- An accepted edit during loss appears in the reconstructed generation-2 packet at revision 2 and the independently checked recovered image. Recovery attempts equal one; stale-generation submissions and pending frame callbacks equal zero. Pipeline count increases once for reconstruction.
- The unsupported opacity-0.5 container at revision 3 rejects as `unsupported-feature`; the following image remains identical to the recovered frame. Disposal leaves zero tracked live resources.

Primary directly inspected representative final asymmetric rectangle, forward/reverse overlap, rotated ellipse, thin line and recovered latest-position images. These visual observations supplement the independent numeric assertions; they do not replace them or establish performance/presentation timing.
