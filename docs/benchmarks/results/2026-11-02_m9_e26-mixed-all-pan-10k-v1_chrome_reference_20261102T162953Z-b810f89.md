# M9-U2 e26-mixed-all-pan-10k/v1, chrome, reference, 20261102T162953Z-b810f89

Observed result of the M9-U2 reference sitting (M9 contract, section 5). Thresholds and verdicts are owned by the contract; this file reports facts.
The sitting's record, with the verdicts and findings, is [here](../../evidence/viz-v20/u3-b810f89.md).

| Project | Variant | Per-run p95 (ms) | Max | Target | Result |
| --- | --- | --- | --- | --- | --- |
| chrome-dpr1 | frame | 66.8, 66.8, 83.3, 66.8, 66.8 | 83.3 | ≤ 33.3 | miss |
| chrome-dpr2 | frame | 66.8, 83.3, 66.8, 66.8, 83.3 | 83.3 | ≤ 33.3 | miss |

Share of frame intervals over 1.5 refresh intervals, per run (M9-Q2 second line):

- chrome-dpr1: 100.0 % (163 of 163), 100.0 % (162 of 162), 100.0 % (158 of 158), 100.0 % (161 of 161), 100.0 % (161 of 161)
- chrome-dpr2: 100.0 % (159 of 159), 100.0 % (159 of 159), 100.0 % (161 of 161), 100.0 % (162 of 162), 100.0 % (151 of 151)

Raw records: 10 files, listed with their SHA-256 in the [.json beside this file](2026-11-02_m9_e26-mixed-all-pan-10k-v1_chrome_reference_20261102T162953Z-b810f89.json).
