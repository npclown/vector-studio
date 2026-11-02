# M9-U2 e26-mixed-view-edit-10k/v2, chrome, reference, 20261102T011837Z-89393f1

Observed result of the M9-U2 reference sitting (M9 contract, section 5). Thresholds and verdicts are owned by the contract; this file reports facts.
The sitting's record, with the verdicts and findings, is [here](../../evidence/m9/u2-89393f1.md).

| Project | Variant | Per-run p95 (ms) | Max | Target | Result |
| --- | --- | --- | --- | --- | --- |
| chrome-dpr1-v2 | frame | 33.4, 33.4, 33.4, 33.4, 33.4 | 33.4 | ≤ 16.7 | miss |
| chrome-dpr2-v2 | frame | 33.4, 33.4, 33.4, 33.4, 33.4 | 33.4 | ≤ 16.7 | miss |

Share of frame intervals over 1.5 refresh intervals, per run (M9-Q2 second line):

- chrome-dpr1-v2: 62.6 % (229 of 366), 67.0 % (237 of 354), 67.6 % (240 of 355), 64.5 % (233 of 361), 70.9 % (246 of 347)
- chrome-dpr2-v2: 63.6 % (231 of 363), 59.2 % (222 of 375), 64.8 % (234 of 361), 61.0 % (227 of 372), 62.5 % (228 of 365)

Raw records: 10 files, listed with their SHA-256 in the [.json beside this file](2026-11-02_m9_e26-mixed-view-edit-10k-v2_chrome_reference_20261102T011837Z-89393f1.json).
