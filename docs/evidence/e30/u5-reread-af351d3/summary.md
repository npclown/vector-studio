| Scenario | Variant | Project | Per-run p95 (ms; isolation: one / 16 rejections) | Max | Target | Result |
| --- | --- | --- | --- | --- | --- | --- |
| `e26-ui0-pointer-busy-10k/v1` | busy | chrome-dpr1-v2 | 402.9, 221.1, 243.7 | 402.9 | < 50 | miss |
| `e26-ui0-pointer-busy-10k/v1` | busy | chrome-dpr2-v2 | 277.4, 222.3, 191.7 | 277.4 | < 50 | miss |
| `e26-ui0-pointer-busy-10k/v1` | busy | edge-dpr1-v2 | 158.6, 162.8, 162.2 | 162.8 | < 50 | miss |
| `e26-ui0-pointer-busy-10k/v1` | busy | edge-dpr2-v2 | 291, 275.6, 284.8 | 291 | < 50 | miss |
| `e26-ui0-mixed-all-edit-10k/v1` | frame | chrome-dpr1-v2 | 52.6, 52.8, 52.8 | 52.8 | ≤ 33.3 | miss |
| `e26-ui0-mixed-all-pan-10k/v1` | frame | chrome-dpr1-v2 | 70.4, 70.7, 71 | 71 | ≤ 33.3 | miss |
| `e26-ui0-mixed-view-edit-10k/v1` | frame | chrome-dpr1-v2 | 18.1, 18.1, 18.1 | 18.1 | ≤ 16.7 | miss |
| `e26-ui0-simple-stress-10k/v1` | frame | chrome-dpr1-v2 | 18.1, 18.1, 18.1 | 18.1 | ≤ 33.3 | pass |
| `e26-ui0-mixed-all-edit-10k/v1` | frame | chrome-dpr2-v2 | 53.4, 53.4, 53.6 | 53.6 | ≤ 33.3 | miss |
| `e26-ui0-mixed-all-pan-10k/v1` | frame | chrome-dpr2-v2 | 71.8, 71.8, 71.6 | 71.8 | ≤ 33.3 | miss |
| `e26-ui0-mixed-view-edit-10k/v1` | frame | chrome-dpr2-v2 | 18.1, 18.1, 18.1 | 18.1 | ≤ 16.7 | miss |
| `e26-ui0-simple-stress-10k/v1` | frame | chrome-dpr2-v2 | 18.1, 18.1, 18.1 | 18.1 | ≤ 33.3 | pass |
| `e26-ui0-mixed-all-edit-10k/v1` | frame | edge-dpr1-v2 | 52.8, 52.8, 52.7 | 52.8 | ≤ 33.3 | miss |
| `e26-ui0-mixed-all-pan-10k/v1` | frame | edge-dpr1-v2 | 71, 70.9, 70.7 | 71 | ≤ 33.3 | miss |
| `e26-ui0-mixed-view-edit-10k/v1` | frame | edge-dpr1-v2 | 18.1, 18.1, 18.1 | 18.1 | ≤ 16.7 | miss |
| `e26-ui0-simple-stress-10k/v1` | frame | edge-dpr1-v2 | 18.1, 18.1, 18.1 | 18.1 | ≤ 33.3 | pass |
| `e26-ui0-mixed-all-edit-10k/v1` | frame | edge-dpr2-v2 | 53.6, 53.6, 53.5 | 53.6 | ≤ 33.3 | miss |
| `e26-ui0-mixed-all-pan-10k/v1` | frame | edge-dpr2-v2 | 72, 72.6, 83.3 | 83.3 | ≤ 33.3 | miss |
| `e26-ui0-mixed-view-edit-10k/v1` | frame | edge-dpr2-v2 | 18.1, 18.1, 18.1 | 18.1 | ≤ 16.7 | miss |
| `e26-ui0-simple-stress-10k/v1` | frame | edge-dpr2-v2 | 16.8, 16.8, 16.8 | 16.8 | ≤ 33.3 | pass |
| `e26-ui0-pointer-busy-10k/v1` | plain | chrome-dpr1-v2 | 144, 159.5, 147.5 | 159.5 | < 50 | miss |
| `e26-ui0-pointer-busy-10k/v1` | plain | chrome-dpr2-v2 | 165.3, 157.9, 152.4 | 165.3 | < 50 | miss |
| `e26-ui0-pointer-busy-10k/v1` | plain | edge-dpr1-v2 | 141.2, 153.2, 169.2 | 169.2 | < 50 | miss |
| `e26-ui0-pointer-busy-10k/v1` | plain | edge-dpr2-v2 | 184, 204.7, 142.4 | 204.7 | < 50 | miss |
| `e26-mixed-view-edit-10k/v2` | frame | chrome-dpr1-v2 | 18.1, 18.1, 18.2 | 18.2 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v2` | frame | chrome-dpr2-v2 | 18.1, 18.1, 18.1 | 18.1 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v2` | frame | edge-dpr1-v2 | 18.1, 18.1, 18.1 | 18.1 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v2` | frame | edge-dpr2-v2 | 18.1, 18.1, 18.1 | 18.1 | ≤ 16.7 | miss |
| `e26-mixed-all-edit-10k/v2` | frame | chrome-dpr1-v2 | 52.9, 52.8, 52.7 | 52.9 | ≤ 33.3 | miss |
| `e26-mixed-all-edit-10k/v2` | frame | chrome-dpr2-v2 | 53.5, 53.5, 53.5 | 53.5 | ≤ 33.3 | miss |
| `e26-mixed-all-edit-10k/v2` | frame | edge-dpr1-v2 | 52.8, 52.8, 53.1 | 53.1 | ≤ 33.3 | miss |
| `e26-mixed-all-edit-10k/v2` | frame | edge-dpr2-v2 | 53.6, 53.6, 53.6 | 53.6 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | chrome-dpr1-v2 | 70.4, 54.4, 70.8 | 70.8 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | chrome-dpr2-v2 | 71.3, 72.3, 71.6 | 72.3 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | edge-dpr1-v2 | 71.1, 70.9, 71.3 | 71.3 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | edge-dpr2-v2 | 72.1, 71.8, 72.1 | 72.1 | ≤ 33.3 | miss |
| `e26-simple-stress-10k/v2` | frame | chrome-dpr1-v2 | 18.1, 18.1, 18.1 | 18.1 | ≤ 33.3 | pass |
| `e26-simple-stress-10k/v2` | frame | chrome-dpr2-v2 | 18, 18.1, 18.1 | 18.1 | ≤ 33.3 | pass |
| `e26-simple-stress-10k/v2` | frame | edge-dpr1-v2 | 18, 18.1, 18.1 | 18.1 | ≤ 33.3 | pass |
| `e26-simple-stress-10k/v2` | frame | edge-dpr2-v2 | 18, 18.1, 18 | 18.1 | ≤ 33.3 | pass |
| `e26-pointer-busy-10k/v2` | busy | chrome-dpr1-v2 | 259.8, 209, 255.2 | 259.8 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | busy | chrome-dpr2-v2 | 202.2, 225.4, 268.3 | 268.3 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | busy | edge-dpr1-v2 | 202.6, 286, 206.3 | 286 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | busy | edge-dpr2-v2 | 255.3, 225.4, 192.2 | 255.3 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | chrome-dpr1-v2 | 171.6, 203.3, 315.3 | 315.3 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | chrome-dpr2-v2 | 276.8, 173.6, 237.7 | 276.8 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | edge-dpr1-v2 | 185.1, 215.3, 183.8 | 215.3 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | edge-dpr2-v2 | 170.8, 154.2, 164 | 170.8 | < 50 | miss |
| `m9-typing-10k/v1` | typing | chrome-dpr1-v2 | 53, 50.5, 52.4 | 53 | recorded | recorded |
| `m9-typing-10k/v1` | typing | chrome-dpr2-v2 | 57.3, 55.7, 55.8 | 57.3 | recorded | recorded |
| `m9-typing-10k/v1` | typing | edge-dpr1-v2 | 52.7, 50.1, 51.6 | 52.7 | recorded | recorded |
| `m9-typing-10k/v1` | typing | edge-dpr2-v2 | 57.7, 55.3, 61.4 | 61.4 | recorded | recorded |
| `m9-ui-geometry` | geometry | chrome-dpr1-v2 | origin and size with and without ui=1 |  | equal | pass |
| `m9-ui-geometry` | geometry | chrome-dpr2-v2 | origin and size with and without ui=1 |  | equal | pass |
| `m9-ui-geometry` | geometry | edge-dpr1-v2 | origin and size with and without ui=1 |  | equal | pass |
| `m9-ui-geometry` | geometry | edge-dpr2-v2 | origin and size with and without ui=1 |  | equal | pass |
