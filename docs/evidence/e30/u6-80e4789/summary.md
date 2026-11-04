| Scenario | Variant | Project | Per-run p95 (ms; isolation: one / 16 rejections) | Max | Target | Result |
| --- | --- | --- | --- | --- | --- | --- |
| `e26-ui0-pointer-busy-10k/v1` | busy | chrome-dpr1-v2 | 207.4, 173.3, 196.6 | 207.4 | < 50 | miss |
| `e26-ui0-pointer-busy-10k/v1` | busy | chrome-dpr2-v2 | 234.5, 164.4, 268.6 | 268.6 | < 50 | miss |
| `e26-ui0-pointer-busy-10k/v1` | busy | edge-dpr1-v2 | 231.7, 202.7, 202.5 | 231.7 | < 50 | miss |
| `e26-ui0-pointer-busy-10k/v1` | busy | edge-dpr2-v2 | 181, 183.2, 184.5 | 184.5 | < 50 | miss |
| `e26-ui0-mixed-all-edit-10k/v1` | frame | chrome-dpr1-v2 | 52.7, 52.9, 52.8 | 52.9 | ≤ 33.3 | miss |
| `e26-ui0-mixed-all-pan-10k/v1` | frame | chrome-dpr1-v2 | 70.8, 70.9, 54.2 | 70.9 | ≤ 33.3 | miss |
| `e26-ui0-mixed-view-edit-10k/v1` | frame | chrome-dpr1-v2 | 18.1, 18.1, 18.1 | 18.1 | ≤ 16.7 | miss |
| `e26-ui0-simple-stress-10k/v1` | frame | chrome-dpr1-v2 | 18.1, 18.1, 18 | 18.1 | ≤ 33.3 | pass |
| `e26-ui0-mixed-all-edit-10k/v1` | frame | chrome-dpr2-v2 | 53.3, 53.6, 53.5 | 53.6 | ≤ 33.3 | miss |
| `e26-ui0-mixed-all-pan-10k/v1` | frame | chrome-dpr2-v2 | 71.6, 71.3, 71.7 | 71.7 | ≤ 33.3 | miss |
| `e26-ui0-mixed-view-edit-10k/v1` | frame | chrome-dpr2-v2 | 18.1, 18.1, 18.1 | 18.1 | ≤ 16.7 | miss |
| `e26-ui0-simple-stress-10k/v1` | frame | chrome-dpr2-v2 | 18, 18.1, 18.1 | 18.1 | ≤ 33.3 | pass |
| `e26-ui0-mixed-all-edit-10k/v1` | frame | edge-dpr1-v2 | 52.8, 52.8, 53 | 53 | ≤ 33.3 | miss |
| `e26-ui0-mixed-all-pan-10k/v1` | frame | edge-dpr1-v2 | 71.1, 71.1, 71 | 71.1 | ≤ 33.3 | miss |
| `e26-ui0-mixed-view-edit-10k/v1` | frame | edge-dpr1-v2 | 18.1, 18.1, 18.1 | 18.1 | ≤ 16.7 | miss |
| `e26-ui0-simple-stress-10k/v1` | frame | edge-dpr1-v2 | 18, 18.1, 18 | 18.1 | ≤ 33.3 | pass |
| `e26-ui0-mixed-all-edit-10k/v1` | frame | edge-dpr2-v2 | 53.5, 53.5, 53.6 | 53.6 | ≤ 33.3 | miss |
| `e26-ui0-mixed-all-pan-10k/v1` | frame | edge-dpr2-v2 | 72.1, 88.4, 87.5 | 88.4 | ≤ 33.3 | miss |
| `e26-ui0-mixed-view-edit-10k/v1` | frame | edge-dpr2-v2 | 18.1, 18.1, 18.1 | 18.1 | ≤ 16.7 | miss |
| `e26-ui0-simple-stress-10k/v1` | frame | edge-dpr2-v2 | 18.1, 18, 18 | 18.1 | ≤ 33.3 | pass |
| `e26-ui0-pointer-busy-10k/v1` | plain | chrome-dpr1-v2 | 149.8, 314.5, 140.9 | 314.5 | < 50 | miss |
| `e26-ui0-pointer-busy-10k/v1` | plain | chrome-dpr2-v2 | 160.6, 152.8, 156.1 | 160.6 | < 50 | miss |
| `e26-ui0-pointer-busy-10k/v1` | plain | edge-dpr1-v2 | 252, 200.4, 327.9 | 327.9 | < 50 | miss |
| `e26-ui0-pointer-busy-10k/v1` | plain | edge-dpr2-v2 | 155.8, 159.5, 133.6 | 159.5 | < 50 | miss |
| `e26-mixed-view-edit-10k/v2` | frame | chrome-dpr1-v2 | 18.1, 18.1, 18.1 | 18.1 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v2` | frame | chrome-dpr2-v2 | 18.1, 18.1, 18.1 | 18.1 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v2` | frame | edge-dpr1-v2 | 18.1, 18.1, 18.1 | 18.1 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v2` | frame | edge-dpr2-v2 | 35.3, 18.1, 18.1 | 35.3 | ≤ 16.7 | miss |
| `e26-mixed-all-edit-10k/v2` | frame | chrome-dpr1-v2 | 52.8, 52.7, 53.5 | 53.5 | ≤ 33.3 | miss |
| `e26-mixed-all-edit-10k/v2` | frame | chrome-dpr2-v2 | 53.5, 53.9, 53.5 | 53.9 | ≤ 33.3 | miss |
| `e26-mixed-all-edit-10k/v2` | frame | edge-dpr1-v2 | 52.8, 53, 53.1 | 53.1 | ≤ 33.3 | miss |
| `e26-mixed-all-edit-10k/v2` | frame | edge-dpr2-v2 | 53.7, 53.6, 53.4 | 53.7 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | chrome-dpr1-v2 | 69.8, 70.2, 70.8 | 70.8 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | chrome-dpr2-v2 | 71.7, 88.4, 71.9 | 88.4 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | edge-dpr1-v2 | 71.2, 70.6, 70.7 | 71.2 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | edge-dpr2-v2 | 72, 88.1, 71.8 | 88.1 | ≤ 33.3 | miss |
| `e26-simple-stress-10k/v2` | frame | chrome-dpr1-v2 | 18.1, 18.1, 18.1 | 18.1 | ≤ 33.3 | pass |
| `e26-simple-stress-10k/v2` | frame | chrome-dpr2-v2 | 18, 18.1, 18.1 | 18.1 | ≤ 33.3 | pass |
| `e26-simple-stress-10k/v2` | frame | edge-dpr1-v2 | 18.1, 18.1, 18.1 | 18.1 | ≤ 33.3 | pass |
| `e26-simple-stress-10k/v2` | frame | edge-dpr2-v2 | 18, 18.1, 18.1 | 18.1 | ≤ 33.3 | pass |
| `e26-pointer-busy-10k/v2` | busy | chrome-dpr1-v2 | 204.5, 172, 208.7 | 208.7 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | busy | chrome-dpr2-v2 | 222, 289.4, 412.4 | 412.4 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | busy | edge-dpr1-v2 | 204.8, 232.7, 193.2 | 232.7 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | busy | edge-dpr2-v2 | 233.9, 249.9, 375.6 | 375.6 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | chrome-dpr1-v2 | 188.2, 235.9, 159.7 | 235.9 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | chrome-dpr2-v2 | 279.9, 201.9, 188.3 | 279.9 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | edge-dpr1-v2 | 172.3, 180.2, 250.5 | 250.5 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | edge-dpr2-v2 | 172.7, 343.6, 189.3 | 343.6 | < 50 | miss |
| `m9-typing-10k/v1` | typing | chrome-dpr1-v2 | 61.5, 60.4, 54.4 | 61.5 | recorded | recorded |
| `m9-typing-10k/v1` | typing | chrome-dpr2-v2 | 56.1, 55.2, 64.4 | 64.4 | recorded | recorded |
| `m9-typing-10k/v1` | typing | edge-dpr1-v2 | 51.8, 53.6, 51.8 | 53.6 | recorded | recorded |
| `m9-typing-10k/v1` | typing | edge-dpr2-v2 | 55.3, 57.4, 51.5 | 57.4 | recorded | recorded |
| `m9-ui-geometry` | geometry | chrome-dpr1-v2 | origin and size with and without ui=1 |  | equal | pass |
| `m9-ui-geometry` | geometry | chrome-dpr2-v2 | origin and size with and without ui=1 |  | equal | pass |
| `m9-ui-geometry` | geometry | edge-dpr1-v2 | origin and size with and without ui=1 |  | equal | pass |
| `m9-ui-geometry` | geometry | edge-dpr2-v2 | origin and size with and without ui=1 |  | equal | pass |
