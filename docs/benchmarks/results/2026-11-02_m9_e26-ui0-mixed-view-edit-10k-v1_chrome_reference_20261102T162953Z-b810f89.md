# M9-U2 e26-ui0-mixed-view-edit-10k/v1, chrome, reference, 20261102T162953Z-b810f89

Observed result of the M9-U2 reference sitting (M9 contract, section 5). Thresholds and verdicts are owned by the contract; this file reports facts.
The sitting's record, with the verdicts and findings, is [here](../../evidence/viz-v20/u3-b810f89.md).

| Project | Variant | Per-run p95 (ms) | Max | Target | Result |
| --- | --- | --- | --- | --- | --- |
| chrome-dpr1-v2 | frame | 33.4, 33.4, 33.4, 33.4, 33.4 | 33.4 | ≤ 16.7 | miss |
| chrome-dpr2-v2 | frame | 33.5, 33.4, 33.4, 33.4, 33.4 | 33.5 | ≤ 16.7 | miss |

Share of frame intervals over 1.5 refresh intervals, per run (M9-Q2 second line):

- chrome-dpr1-v2: 31.2 % (142 of 455), 30.0 % (138 of 460), 31.4 % (143 of 456), 29.8 % (137 of 459), 29.0 % (134 of 462)
- chrome-dpr2-v2: 31.7 % (143 of 451), 28.1 % (131 of 467), 26.7 % (126 of 472), 31.5 % (143 of 454), 29.1 % (135 of 464)

Raw records: 10 files, listed with their SHA-256 in the [.json beside this file](2026-11-02_m9_e26-ui0-mixed-view-edit-10k-v1_chrome_reference_20261102T162953Z-b810f89.json).
