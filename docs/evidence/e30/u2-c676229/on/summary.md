| Scenario | Variant | Project | Per-run p95 (ms; isolation: one / 16 rejections) | Max | Target | Result |
| --- | --- | --- | --- | --- | --- | --- |
| `e26-mixed-view-edit-10k/v2` | frame | chrome-dpr1-v2 | 33.4, 33.4, 33.4, 33.4, 33.4 | 33.4 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v2` | frame | chrome-dpr2-v2 | 33.4, 33.4, 33.4, 33.4, 33.4 | 33.4 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v2` | frame | edge-dpr1-v2 | 33.4, 33.4, 33.4, 33.4, 33.4 | 33.4 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v2` | frame | edge-dpr2-v2 | 33.4, 33.4, 33.4, 33.4, 33.4 | 33.4 | ≤ 16.7 | miss |
| `e26-mixed-all-edit-10k/v2` | frame | chrome-dpr1-v2 | 83.4, 83.3, 66.8, 83.4, 83.4 | 83.4 | ≤ 33.3 | miss |
| `e26-mixed-all-edit-10k/v2` | frame | chrome-dpr2-v2 | 83.3, 83.3, 83.4, 83.4, 83.3 | 83.4 | ≤ 33.3 | miss |
| `e26-mixed-all-edit-10k/v2` | frame | edge-dpr1-v2 | 83.5, 66.8, 83.4, 83.4, 83.4 | 83.5 | ≤ 33.3 | miss |
| `e26-mixed-all-edit-10k/v2` | frame | edge-dpr2-v2 | 83.3, 83.3, 83.3, 83.3, 83.3 | 83.3 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | chrome-dpr1-v2 | 99.9, 83.5, 83.4, 83.5, 83.4 | 99.9 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | chrome-dpr2-v2 | 83.4, 100, 99.9, 100, 83.4 | 100 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | edge-dpr1-v2 | 100, 100.1, 100, 100, 100 | 100.1 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | edge-dpr2-v2 | 83.5, 83.4, 83.4, 83.5, 83.4 | 83.5 | ≤ 33.3 | miss |
| `e26-simple-stress-10k/v2` | frame | chrome-dpr1-v2 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 33.3 | pass |
| `e26-simple-stress-10k/v2` | frame | chrome-dpr2-v2 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 33.3 | pass |
| `e26-simple-stress-10k/v2` | frame | edge-dpr1-v2 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 33.3 | pass |
| `e26-simple-stress-10k/v2` | frame | edge-dpr2-v2 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 33.3 | pass |
| `e26-pointer-busy-10k/v2` | busy | chrome-dpr1-v2 | 445.6, 366.7, 367.2, 439.7, 429 | 445.6 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | busy | chrome-dpr2-v2 | 582.2, 485.9, 545.6, 408.3, 408.9 | 582.2 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | busy | edge-dpr1-v2 | 269.9, 658.7, 455.9, 417.7, 405.7 | 658.7 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | busy | edge-dpr2-v2 | 358.8, 520.8, 424.2, 390.1, 518.4 | 520.8 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | chrome-dpr1-v2 | 304.6, 358.9, 361.3, 410.7, 422.8 | 422.8 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | chrome-dpr2-v2 | 845.1, 452.6, 503.5, 543.4, 440.6 | 845.1 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | edge-dpr1-v2 | 371.6, 354.2, 449.8, 299.3, 568.5 | 568.5 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | edge-dpr2-v2 | 454.6, 488.8, 722.1, 671.6, 490.3 | 722.1 | < 50 | miss |
