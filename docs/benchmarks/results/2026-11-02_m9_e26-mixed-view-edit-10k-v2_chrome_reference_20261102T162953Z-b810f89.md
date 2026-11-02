# M9-U2 e26-mixed-view-edit-10k/v2, chrome, reference, 20261102T162953Z-b810f89

Observed result of the M9-U2 reference sitting (M9 contract, section 5). Thresholds and verdicts are owned by the contract; this file reports facts.
The sitting's record, with the verdicts and findings, is [here](../../evidence/viz-v20/u3-b810f89.md).

| Project | Variant | Per-run p95 (ms) | Max | Target | Result |
| --- | --- | --- | --- | --- | --- |
| chrome-dpr1-v2 | frame | 33.4, 33.4, 33.4, 33.4, 33.4 | 33.4 | ≤ 16.7 | miss |
| chrome-dpr2-v2 | frame | 33.4, 33.4, 33.4, 33.4, 33.4 | 33.4 | ≤ 16.7 | miss |

Share of frame intervals over 1.5 refresh intervals, per run (M9-Q2 second line):

- chrome-dpr1-v2: 37.8 % (164 of 434), 33.9 % (151 of 446), 35.3 % (156 of 442), 33.0 % (149 of 451), 33.8 % (151 of 447)
- chrome-dpr2-v2: 36.3 % (159 of 438), 34.4 % (153 of 445), 35.3 % (156 of 442), 33.6 % (150 of 447), 33.3 % (149 of 447)

Raw records: 10 files, listed with their SHA-256 in the [.json beside this file](2026-11-02_m9_e26-mixed-view-edit-10k-v2_chrome_reference_20261102T162953Z-b810f89.json).
