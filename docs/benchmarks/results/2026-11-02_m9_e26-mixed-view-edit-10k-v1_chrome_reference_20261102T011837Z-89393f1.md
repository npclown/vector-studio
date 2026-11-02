# M9-U2 e26-mixed-view-edit-10k/v1, chrome, reference, 20261102T011837Z-89393f1

Observed result of the M9-U2 reference sitting (M9 contract, section 5). Thresholds and verdicts are owned by the contract; this file reports facts.
The sitting's record, with the verdicts and findings, is [here](../../evidence/m9/u2-89393f1.md).

| Project | Variant | Per-run p95 (ms) | Max | Target | Result |
| --- | --- | --- | --- | --- | --- |
| chrome-dpr1 | frame | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 16.7 | miss |
| chrome-dpr2 | frame | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 16.7 | miss |

Share of frame intervals over 1.5 refresh intervals, per run (M9-Q2 second line):

- chrome-dpr1: 3.8 % (22 of 576), 1.2 % (7 of 593), 1.0 % (6 of 594), 1.7 % (10 of 588), 1.5 % (9 of 590)
- chrome-dpr2: 1.2 % (7 of 592), 1.5 % (9 of 589), 1.2 % (7 of 590), 1.2 % (7 of 590), 2.1 % (12 of 586)

Raw records: 10 files, listed with their SHA-256 in the [.json beside this file](2026-11-02_m9_e26-mixed-view-edit-10k-v1_chrome_reference_20261102T011837Z-89393f1.json).
