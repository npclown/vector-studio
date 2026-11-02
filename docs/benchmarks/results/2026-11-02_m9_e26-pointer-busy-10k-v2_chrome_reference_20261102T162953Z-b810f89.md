# M9-U2 e26-pointer-busy-10k/v2, chrome, reference, 20261102T162953Z-b810f89

Observed result of the M9-U2 reference sitting (M9 contract, section 5). Thresholds and verdicts are owned by the contract; this file reports facts.
The sitting's record, with the verdicts and findings, is [here](../../evidence/viz-v20/u3-b810f89.md).

| Project | Variant | Per-run p95 (ms) | Max | Target | Result |
| --- | --- | --- | --- | --- | --- |
| chrome-dpr1-v2 | busy | 733, 527.7, 618.4, 866.4, 565.1 | 866.4 | < 50 | miss |
| chrome-dpr2-v2 | busy | 469.4, 392.4, 682.4, 763.7, 693.1 | 763.7 | < 50 | miss |
| chrome-dpr1-v2 | plain | 558, 527.7, 486.5, 358.4, 479.5 | 558 | < 50 | miss |
| chrome-dpr2-v2 | plain | 610.2, 621.1, 651.4, 767.4, 438 | 767.4 | < 50 | miss |

Raw records: 20 files, listed with their SHA-256 in the [.json beside this file](2026-11-02_m9_e26-pointer-busy-10k-v2_chrome_reference_20261102T162953Z-b810f89.json).
