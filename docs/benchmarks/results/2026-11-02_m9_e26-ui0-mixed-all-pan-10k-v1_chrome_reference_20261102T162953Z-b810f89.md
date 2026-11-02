# M9-U2 e26-ui0-mixed-all-pan-10k/v1, chrome, reference, 20261102T162953Z-b810f89

Observed result of the M9-U2 reference sitting (M9 contract, section 5). Thresholds and verdicts are owned by the contract; this file reports facts.
The sitting's record, with the verdicts and findings, is [here](../../evidence/viz-v20/u3-b810f89.md).

| Project | Variant | Per-run p95 (ms) | Max | Target | Result |
| --- | --- | --- | --- | --- | --- |
| chrome-dpr1-v2 | frame | 83.4, 83.4, 83.4, 83.4, 83.4 | 83.4 | ≤ 33.3 | miss |
| chrome-dpr2-v2 | frame | 83.5, 83.5, 100, 83.5, 83.4 | 100 | ≤ 33.3 | miss |

Share of frame intervals over 1.5 refresh intervals, per run (M9-Q2 second line):

- chrome-dpr1-v2: 100.0 % (137 of 137), 100.0 % (137 of 137), 100.0 % (138 of 138), 100.0 % (139 of 139), 100.0 % (140 of 140)
- chrome-dpr2-v2: 100.0 % (131 of 131), 100.0 % (128 of 128), 100.0 % (128 of 128), 100.0 % (127 of 127), 100.0 % (131 of 131)

Raw records: 10 files, listed with their SHA-256 in the [.json beside this file](2026-11-02_m9_e26-ui0-mixed-all-pan-10k-v1_chrome_reference_20261102T162953Z-b810f89.json).
