# M9-U2 e26-mixed-view-edit-10k/v1, chrome, reference, 20261102T162953Z-b810f89

Observed result of the M9-U2 reference sitting (M9 contract, section 5). Thresholds and verdicts are owned by the contract; this file reports facts.
The sitting's record, with the verdicts and findings, is [here](../../evidence/viz-v20/u3-b810f89.md).

| Project | Variant | Per-run p95 (ms) | Max | Target | Result |
| --- | --- | --- | --- | --- | --- |
| chrome-dpr1 | frame | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 16.7 | miss |
| chrome-dpr2 | frame | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 16.7 | miss |

Share of frame intervals over 1.5 refresh intervals, per run (M9-Q2 second line):

- chrome-dpr1: 1.5 % (9 of 591), 1.7 % (10 of 588), 1.9 % (11 of 586), 3.8 % (22 of 576), 2.7 % (16 of 584)
- chrome-dpr2: 0.8 % (5 of 594), 1.4 % (8 of 591), 1.4 % (8 of 591), 0.7 % (4 of 593), 2.2 % (13 of 586)

Raw records: 10 files, listed with their SHA-256 in the [.json beside this file](2026-11-02_m9_e26-mixed-view-edit-10k-v1_chrome_reference_20261102T162953Z-b810f89.json).
