| Scenario | Variant | Project | Per-run p95 (ms; isolation: one / 16 rejections) | Max | Target | Result |
| --- | --- | --- | --- | --- | --- | --- |
| `e26-mixed-view-edit-10k/v2` | frame | chrome-dpr1-v2 | 20.1, 20.1, 20.2 | 20.2 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v2` | frame | chrome-dpr2-v2 | 20.1, 20.1, 20.1 | 20.1 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v2` | frame | edge-dpr1-v2 | 20.1, 20.1, 20 | 20.1 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v2` | frame | edge-dpr2-v2 | 20, 20.1, 20.1 | 20.1 | ≤ 16.7 | miss |
| `e26-mixed-all-edit-10k/v2` | frame | chrome-dpr1-v2 | 40.4, 46.5, 40.2 | 46.5 | ≤ 33.3 | miss |
| `e26-mixed-all-edit-10k/v2` | frame | chrome-dpr2-v2 | 69.9, 69.8, 69.9 | 69.9 | ≤ 33.3 | miss |
| `e26-mixed-all-edit-10k/v2` | frame | edge-dpr1-v2 | 59.9, 60, 60 | 60 | ≤ 33.3 | miss |
| `e26-mixed-all-edit-10k/v2` | frame | edge-dpr2-v2 | 70, 70, 69.8 | 70 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | chrome-dpr1-v2 | 60.1, 50.2, 50.1 | 60.1 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | chrome-dpr2-v2 | 60.2, 60.1, 60.1 | 60.2 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | edge-dpr1-v2 | 50.1, 50.1, 50.2 | 50.2 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | edge-dpr2-v2 | 60.1, 60.1, 60.2 | 60.2 | ≤ 33.3 | miss |
| `e26-simple-stress-10k/v2` | frame | chrome-dpr1-v2 | 10.2, 10.3, 10.2 | 10.3 | ≤ 33.3 | pass |
| `e26-simple-stress-10k/v2` | frame | chrome-dpr2-v2 | 10.2, 11, 10.2 | 11 | ≤ 33.3 | pass |
| `e26-simple-stress-10k/v2` | frame | edge-dpr1-v2 | 10.2, 10.3, 10.2 | 10.3 | ≤ 33.3 | pass |
| `e26-simple-stress-10k/v2` | frame | edge-dpr2-v2 | 10.4, 10.3, 10.8 | 10.8 | ≤ 33.3 | pass |
| `e26-pointer-busy-10k/v2` | busy | chrome-dpr1-v2 | 161.7, 121.5, 112 | 161.7 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | busy | chrome-dpr2-v2 | 206.4, 153.8, 115.1 | 206.4 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | busy | edge-dpr1-v2 | 112.8, 125.1, 137 | 137 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | busy | edge-dpr2-v2 | 145.6, 138.6, 95.6 | 145.6 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | chrome-dpr1-v2 | 107.5, 145.1, 155.2 | 155.2 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | chrome-dpr2-v2 | 171.8, 125.5, 103.2 | 171.8 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | edge-dpr1-v2 | 107.9, 107, 124.8 | 124.8 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | edge-dpr2-v2 | 137.1, 121.5, 130.2 | 137.1 | < 50 | miss |
