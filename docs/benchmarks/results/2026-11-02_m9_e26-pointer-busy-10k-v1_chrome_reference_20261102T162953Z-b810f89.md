# M9-U2 e26-pointer-busy-10k/v1, chrome, reference, 20261102T162953Z-b810f89

Observed result of the M9-U2 reference sitting (M9 contract, section 5). Thresholds and verdicts are owned by the contract; this file reports facts.
The sitting's record, with the verdicts and findings, is [here](../../evidence/viz-v20/u3-b810f89.md).

| Project | Variant | Per-run p95 (ms) | Max | Target | Result |
| --- | --- | --- | --- | --- | --- |
| chrome-dpr1 | busy | 203, 265.5, 183.7, 245.1, 215.5 | 265.5 | < 50 | miss |
| chrome-dpr2 | busy | 283.6, 205, 185.3, 163.9, 276 | 283.6 | < 50 | miss |
| chrome-dpr1 | plain | 198.6, 260.8, 150.9, 202.7, 212.6 | 260.8 | < 50 | miss |
| chrome-dpr2 | plain | 198.4, 198.1, 189.6, 240.2, 165.3 | 240.2 | < 50 | miss |

Raw records: 20 files, listed with their SHA-256 in the [.json beside this file](2026-11-02_m9_e26-pointer-busy-10k-v1_chrome_reference_20261102T162953Z-b810f89.json).
