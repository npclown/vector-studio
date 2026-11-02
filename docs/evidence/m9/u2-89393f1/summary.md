| Scenario | Variant | Project | Per-run p95 (ms; isolation: one / 16 rejections) | Max | Target | Result |
| --- | --- | --- | --- | --- | --- | --- |
| `e26-mixed-view-edit-10k/v1` | frame | chrome-dpr1 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v1` | frame | chrome-dpr2 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v1` | frame | edge-dpr1 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v1` | frame | edge-dpr2 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 16.7 | miss |
| `e26-mixed-all-edit-10k/v1` | frame | chrome-dpr1 | 66.7, 66.7, 66.8, 83.3, 66.8 | 83.3 | ≤ 33.3 | miss |
| `e26-mixed-all-edit-10k/v1` | frame | chrome-dpr2 | 66.7, 66.7, 66.7, 66.7, 66.7 | 66.7 | ≤ 33.3 | miss |
| `e26-mixed-all-edit-10k/v1` | frame | edge-dpr1 | 66.7, 66.7, 66.8, 66.7, 66.7 | 66.8 | ≤ 33.3 | miss |
| `e26-mixed-all-edit-10k/v1` | frame | edge-dpr2 | 83.3, 66.7, 66.7, 66.7, 66.7 | 83.3 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v1` | frame | chrome-dpr1 | 83.4, 83.5, 99.9, 83.5, 83.4 | 99.9 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v1` | frame | chrome-dpr2 | 66.8, 66.8, 66.8, 66.8, 83.2 | 83.2 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v1` | frame | edge-dpr1 | 66.8, 66.8, 66.8, 66.8, 66.8 | 66.8 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v1` | frame | edge-dpr2 | 66.8, 66.8, 66.8, 66.8, 66.8 | 66.8 | ≤ 33.3 | miss |
| `e26-simple-stress-10k/v1` | frame | chrome-dpr1 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 33.3 | pass |
| `e26-simple-stress-10k/v1` | frame | chrome-dpr2 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 33.3 | pass |
| `e26-simple-stress-10k/v1` | frame | edge-dpr1 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 33.3 | pass |
| `e26-simple-stress-10k/v1` | frame | edge-dpr2 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 33.3 | pass |
| `e26-pointer-busy-10k/v1` | busy | chrome-dpr1 | 169.5, 238.5, 184.1, 237.2, 174.1 | 238.5 | < 50 | miss |
| `e26-pointer-busy-10k/v1` | busy | chrome-dpr2 | 253, 250.6, 240.2, 174, 211.5 | 253 | < 50 | miss |
| `e26-pointer-busy-10k/v1` | busy | edge-dpr1 | 187.6, 252.9, 218.6, 268.1, 166 | 268.1 | < 50 | miss |
| `e26-pointer-busy-10k/v1` | busy | edge-dpr2 | 176.1, 257, 207.6, 195.6, 210.1 | 257 | < 50 | miss |
| `e26-pointer-busy-10k/v1` | plain | chrome-dpr1 | 207.6, 147.5, 188.5, 198, 231.2 | 231.2 | < 50 | miss |
| `e26-pointer-busy-10k/v1` | plain | chrome-dpr2 | 189, 139.9, 176.7, 151.3, 193.2 | 193.2 | < 50 | miss |
| `e26-pointer-busy-10k/v1` | plain | edge-dpr1 | 172.5, 192.7, 225.1, 180.2, 196.2 | 225.1 | < 50 | miss |
| `e26-pointer-busy-10k/v1` | plain | edge-dpr2 | 135.9, 204.6, 137.1, 153.3, 203 | 204.6 | < 50 | miss |
| `e26-isolation-m1-a13/v1` | isolation | chrome-dpr1 | 111 / 137.9, 115 / 130, 102.8 / 144.9, 115.1 / 126.1, 103.5 / 128.3 | 115.1 / 144.9 | ≤ 296.3 / 592.6 | pass |
| `e26-isolation-m1-a13/v1` | isolation | chrome-dpr2 | 90.2 / 120.3, 84.3 / 116.1, 104.3 / 131.7, 97.6 / 128.4, 91.9 / 112.6 | 104.3 / 131.7 | ≤ 285.2 / 570.4 | pass |
| `e26-isolation-m1-a13/v1` | isolation | edge-dpr1 | 101.1 / 145.5, 116.2 / 131.1, 115 / 136, 100.2 / 147.4, 105.6 / 149 | 116.2 / 149 | ≤ 308 / 616 | pass |
| `e26-isolation-m1-a13/v1` | isolation | edge-dpr2 | 93.3 / 122.8, 91.6 / 117.9, 89.2 / 120.7, 93.8 / 111.9, 92.2 / 132.7 | 93.8 / 132.7 | ≤ 290.3 / 580.6 | pass |
| `e26-mixed-view-edit-10k/v2` | frame | chrome-dpr1-v2 | 33.4, 33.4, 33.4, 33.4, 33.4 | 33.4 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v2` | frame | chrome-dpr2-v2 | 33.4, 33.4, 33.4, 33.4, 33.4 | 33.4 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v2` | frame | edge-dpr1-v2 | 33.4, 33.4, 33.4, 33.4, 33.4 | 33.4 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v2` | frame | edge-dpr2-v2 | 33.4, 33.4, 33.4, 33.4, 33.5 | 33.5 | ≤ 16.7 | miss |
| `e26-mixed-all-edit-10k/v2` | frame | chrome-dpr1-v2 | 83.4, 83.4, 83.4, 83.4, 83.4 | 83.4 | ≤ 33.3 | miss |
| `e26-mixed-all-edit-10k/v2` | frame | chrome-dpr2-v2 | 83.4, 83.4, 83.4, 83.5, 83.4 | 83.5 | ≤ 33.3 | miss |
| `e26-mixed-all-edit-10k/v2` | frame | edge-dpr1-v2 | 83.4, 83.4, 83.4, 83.4, 83.4 | 83.4 | ≤ 33.3 | miss |
| `e26-mixed-all-edit-10k/v2` | frame | edge-dpr2-v2 | 83.4, 83.4, 83.4, 83.4, 83.4 | 83.4 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | chrome-dpr1-v2 | 100.1, 100.1, 100.1, 100.1, 100.1 | 100.1 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | chrome-dpr2-v2 | 99.9, 100.1, 100.1, 99.9, 100 | 100.1 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | edge-dpr1-v2 | 100, 83.4, 83.4, 83.5, 83.5 | 100 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | edge-dpr2-v2 | 100, 100, 100, 99.9, 100 | 100 | ≤ 33.3 | miss |
| `e26-simple-stress-10k/v2` | frame | chrome-dpr1-v2 | 83.3, 83.4, 83.3, 83.4, 83.3 | 83.4 | ≤ 33.3 | miss |
| `e26-simple-stress-10k/v2` | frame | chrome-dpr2-v2 | 66.8, 83.3, 83.3, 83.3, 66.9 | 83.3 | ≤ 33.3 | miss |
| `e26-simple-stress-10k/v2` | frame | edge-dpr1-v2 | 66.8, 66.8, 83.4, 66.8, 83.3 | 83.4 | ≤ 33.3 | miss |
| `e26-simple-stress-10k/v2` | frame | edge-dpr2-v2 | 66.8, 66.8, 66.8, 66.8, 83.2 | 83.2 | ≤ 33.3 | miss |
| `e26-pointer-busy-10k/v2` | busy | chrome-dpr1-v2 | 1066.4, 1347.9, 774.9, 950.3, 1023.5 | 1347.9 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | busy | chrome-dpr2-v2 | 855.6, 646.6, 569.3, 808.3, 988.3 | 988.3 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | busy | edge-dpr1-v2 | 856.4, 727.6, 633, 888.2, 697 | 888.2 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | busy | edge-dpr2-v2 | 801.5, 787.9, 586.8, 855.8, 1068.3 | 1068.3 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | chrome-dpr1-v2 | 647.2, 417.3, 497.2, 696.1, 504.3 | 696.1 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | chrome-dpr2-v2 | 505.3, 368.7, 438.9, 479.8, 518.6 | 518.6 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | edge-dpr1-v2 | 444.2, 415, 371.7, 362.1, 817.7 | 817.7 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | edge-dpr2-v2 | 399.2, 524, 628.5, 829.9, 435.1 | 829.9 | < 50 | miss |
| `m9-typing-10k/v1` | typing | chrome-dpr1-v2 | 65.8, 81.2, 88.3, 83.4, 79.9 | 88.3 | recorded | recorded |
| `m9-typing-10k/v1` | typing | chrome-dpr2-v2 | 68.7, 71.2, 77.4, 77.4, 67.4 | 77.4 | recorded | recorded |
| `m9-typing-10k/v1` | typing | edge-dpr1-v2 | 69.3, 69.3, 68.1, 72.9, 73.5 | 73.5 | recorded | recorded |
| `m9-typing-10k/v1` | typing | edge-dpr2-v2 | 67.3, 68.1, 65.5, 68.9, 71.9 | 71.9 | recorded | recorded |
| `m9-ui-geometry` | geometry | chrome-dpr1-v2 | origin and size with and without ui=1 |  | equal | pass |
| `m9-ui-geometry` | geometry | chrome-dpr2-v2 | origin and size with and without ui=1 |  | equal | pass |
| `m9-ui-geometry` | geometry | edge-dpr1-v2 | origin and size with and without ui=1 |  | equal | pass |
| `m9-ui-geometry` | geometry | edge-dpr2-v2 | origin and size with and without ui=1 |  | equal | pass |
