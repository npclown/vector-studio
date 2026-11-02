# M9-U2 e26-ui0-pointer-busy-10k/v1, chrome, reference, 20261102T162953Z-b810f89

Observed result of the M9-U2 reference sitting (M9 contract, section 5). Thresholds and verdicts are owned by the contract; this file reports facts.
The sitting's record, with the verdicts and findings, is [here](../../evidence/viz-v20/u3-b810f89.md).

| Project | Variant | Per-run p95 (ms) | Max | Target | Result |
| --- | --- | --- | --- | --- | --- |
| chrome-dpr1-v2 | busy | 1200.9, 583.6, 538.3, 400.9, 551.2 | 1200.9 | < 50 | miss |
| chrome-dpr2-v2 | busy | 526.3, 470.8, 534.6, 766, 576.3 | 766 | < 50 | miss |
| chrome-dpr1-v2 | plain | 428.9, 410.8, 1290.6, 512.6, 512.2 | 1290.6 | < 50 | miss |
| chrome-dpr2-v2 | plain | 429.5, 563.5, 529.9, 405.8, 724 | 724 | < 50 | miss |

Raw records: 20 files, listed with their SHA-256 in the [.json beside this file](2026-11-02_m9_e26-ui0-pointer-busy-10k-v1_chrome_reference_20261102T162953Z-b810f89.json).
