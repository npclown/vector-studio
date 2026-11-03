| Scenario | Variant | Project | Per-run p95 (ms; isolation: one / 16 rejections) | Max | Target | Result |
| --- | --- | --- | --- | --- | --- | --- |
| `e26-mixed-view-edit-10k/v2` | frame | chrome-dpr1-v2 | 33.4, 33.4, 33.4, 33.4, 33.4 | 33.4 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v2` | frame | chrome-dpr2-v2 | 33.4, 33.4, 33.4, 33.4, 33.4 | 33.4 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v2` | frame | edge-dpr1-v2 | 33.4, 33.4, 33.4, 33.4, 33.4 | 33.4 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v2` | frame | edge-dpr2-v2 | 33.4, 33.4, 33.4, 33.4, 33.4 | 33.4 | ≤ 16.7 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | chrome-dpr1-v2 | 83.4, 83.4, 83.4, 83.4, 83.4 | 83.4 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | chrome-dpr2-v2 | 83.4, 100, 83.4, 83.4, 100 | 100 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | edge-dpr1-v2 | 83.4, 83.4, 83.4, 83.4, 83.4 | 83.4 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | edge-dpr2-v2 | 83.4, 83.4, 116.7, 116.6, 116.7 | 116.7 | ≤ 33.3 | miss |
| `e26-pointer-busy-10k/v2` | busy | chrome-dpr1-v2 | 398, 473.1, 390.5, 537.2, 996.5 | 996.5 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | busy | chrome-dpr2-v2 | 477.9, 656.7, 514.2, 424.7, 841.4 | 841.4 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | busy | edge-dpr1-v2 | 405.4, 691.4, 434.3, 713.1, 516 | 713.1 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | busy | edge-dpr2-v2 | 406.5, 626.2, 279, 360.7, 431.6 | 626.2 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | chrome-dpr1-v2 | 454.3, 395.6, 672.4, 549.3, 517.9 | 672.4 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | chrome-dpr2-v2 | 335.3, 479.6, 467.8, 486.8, 450.4 | 486.8 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | edge-dpr1-v2 | 788.4, 531.7, 412, 342.6, 953 | 953 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | edge-dpr2-v2 | 397.3, 267.6, 511.8, 501.8, 425.1 | 511.8 | < 50 | miss |
