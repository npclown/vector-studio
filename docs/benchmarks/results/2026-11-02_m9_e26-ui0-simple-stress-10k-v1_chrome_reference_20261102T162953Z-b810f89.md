# M9-U2 e26-ui0-simple-stress-10k/v1, chrome, reference, 20261102T162953Z-b810f89

Observed result of the M9-U2 reference sitting (M9 contract, section 5). Thresholds and verdicts are owned by the contract; this file reports facts.
The sitting's record, with the verdicts and findings, is [here](../../evidence/viz-v20/u3-b810f89.md).

| Project | Variant | Per-run p95 (ms) | Max | Target | Result |
| --- | --- | --- | --- | --- | --- |
| chrome-dpr1-v2 | frame | 16.8, 16.8, 16.8, 16.8, 16.9 | 16.9 | ≤ 33.3 | pass |
| chrome-dpr2-v2 | frame | 16.8, 16.8, 16.8, 16.8, 16.9 | 16.9 | ≤ 33.3 | pass |

Share of frame intervals over 1.5 refresh intervals, per run (M9-Q2 second line):

- chrome-dpr1-v2: 0.0 % (0 of 599), 0.0 % (0 of 599), 0.0 % (0 of 599), 0.0 % (0 of 599), 0.0 % (0 of 599)
- chrome-dpr2-v2: 0.0 % (0 of 599), 0.0 % (0 of 599), 0.0 % (0 of 599), 0.0 % (0 of 599), 0.0 % (0 of 599)

Raw records: 10 files, listed with their SHA-256 in the [.json beside this file](2026-11-02_m9_e26-ui0-simple-stress-10k-v1_chrome_reference_20261102T162953Z-b810f89.json).
