| Scenario | Variant | Project | Per-run p95 (ms; isolation: one / 16 rejections) | Max | Target | Result |
| --- | --- | --- | --- | --- | --- | --- |
| `e26-ui0-pointer-busy-10k/v1` | busy | chrome-dpr1-v2 | 147.5, 286.9, 178.3, 149.1, 229.2 | 286.9 | < 50 | miss |
| `e26-ui0-pointer-busy-10k/v1` | busy | chrome-dpr2-v2 | 320.2, 297.3, 573, 426.7, 256.4 | 573 | < 50 | miss |
| `e26-ui0-pointer-busy-10k/v1` | busy | edge-dpr1-v2 | 148.8, 178.3, 177.3, 161.7, 163.3 | 178.3 | < 50 | miss |
| `e26-ui0-pointer-busy-10k/v1` | busy | edge-dpr2-v2 | 157.4, 193.3, 161.9, 209, 173.1 | 209 | < 50 | miss |
| `e26-ui0-mixed-all-edit-10k/v1` | frame | chrome-dpr1-v2 | 50, 50, 50, 50, 50 | 50 | ≤ 33.3 | miss |
| `e26-ui0-mixed-all-pan-10k/v1` | frame | chrome-dpr1-v2 | 66.7, 66.6, 66.6, 66.6, 66.7 | 66.7 | ≤ 33.3 | miss |
| `e26-ui0-mixed-view-edit-10k/v1` | frame | chrome-dpr1-v2 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 16.7 | miss |
| `e26-ui0-simple-stress-10k/v1` | frame | chrome-dpr1-v2 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 33.3 | pass |
| `e26-ui0-mixed-all-edit-10k/v1` | frame | chrome-dpr2-v2 | 50.1, 50.1, 50.1, 50, 50.1 | 50.1 | ≤ 33.3 | miss |
| `e26-ui0-mixed-all-pan-10k/v1` | frame | chrome-dpr2-v2 | 66.7, 66.8, 66.8, 66.7, 66.7 | 66.8 | ≤ 33.3 | miss |
| `e26-ui0-mixed-view-edit-10k/v1` | frame | chrome-dpr2-v2 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 16.7 | miss |
| `e26-ui0-simple-stress-10k/v1` | frame | chrome-dpr2-v2 | 16.8, 16.8, 16.8, 16.8, 1016.7 | 1016.7 | ≤ 33.3 | miss |
| `e26-ui0-mixed-all-edit-10k/v1` | frame | edge-dpr1-v2 | 50, 50.1, 50, 50, 50 | 50.1 | ≤ 33.3 | miss |
| `e26-ui0-mixed-all-pan-10k/v1` | frame | edge-dpr1-v2 | 66.7, 66.6, 66.7, 66.6, 66.6 | 66.7 | ≤ 33.3 | miss |
| `e26-ui0-mixed-view-edit-10k/v1` | frame | edge-dpr1-v2 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 16.7 | miss |
| `e26-ui0-simple-stress-10k/v1` | frame | edge-dpr1-v2 | 16.8, 16.7, 16.8, 16.8, 16.8 | 16.8 | ≤ 33.3 | pass |
| `e26-ui0-mixed-all-edit-10k/v1` | frame | edge-dpr2-v2 | 50.1, 50.1, 50.1, 50.1, 50.1 | 50.1 | ≤ 33.3 | miss |
| `e26-ui0-mixed-all-pan-10k/v1` | frame | edge-dpr2-v2 | 66.7, 83.4, 66.7, 66.7 | 83.4 | ≤ 33.3 | miss |
| `e26-ui0-mixed-view-edit-10k/v1` | frame | edge-dpr2-v2 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 16.7 | miss |
| `e26-ui0-simple-stress-10k/v1` | frame | edge-dpr2-v2 | 16.8, 16.8, 16.8, 16.7, 16.8 | 16.8 | ≤ 33.3 | pass |
| `e26-ui0-pointer-busy-10k/v1` | plain | chrome-dpr1-v2 | 178.2, 179.3, 171.6, 166.4, 133.7 | 179.3 | < 50 | miss |
| `e26-ui0-pointer-busy-10k/v1` | plain | chrome-dpr2-v2 | 338.6, 153.8, 518.3, 177.9, 195.7 | 518.3 | < 50 | miss |
| `e26-ui0-pointer-busy-10k/v1` | plain | edge-dpr1-v2 | 129.1, 167.4, 136.5, 178, 165.6 | 178 | < 50 | miss |
| `e26-ui0-pointer-busy-10k/v1` | plain | edge-dpr2-v2 | 202.9, 136.8, 109.1, 124.7, 162.3 | 202.9 | < 50 | miss |
| `e26-mixed-view-edit-10k/v1` | frame | chrome-dpr1 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v1` | frame | chrome-dpr2 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v1` | frame | edge-dpr1 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v1` | frame | edge-dpr2 | 16.8, 16.8, 16.7, 16.8, 16.8 | 16.8 | ≤ 16.7 | miss |
| `e26-mixed-all-edit-10k/v1` | frame | chrome-dpr1 | 50, 50.1, 50, 50, 50.1 | 50.1 | ≤ 33.3 | miss |
| `e26-mixed-all-edit-10k/v1` | frame | chrome-dpr2 | 50.1, 50.1, 50.1, 50.1, 50.1 | 50.1 | ≤ 33.3 | miss |
| `e26-mixed-all-edit-10k/v1` | frame | edge-dpr1 | 50, 50, 50, 50, 50 | 50 | ≤ 33.3 | miss |
| `e26-mixed-all-edit-10k/v1` | frame | edge-dpr2 | 50.1, 50.1, 50.1, 50.1, 50.1 | 50.1 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v1` | frame | chrome-dpr1 | 66.7, 66.7, 66.7, 66.7, 66.7 | 66.7 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v1` | frame | chrome-dpr2 | 66.7, 66.7, 66.8, 66.8, 66.8 | 66.8 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v1` | frame | edge-dpr1 | 66.7, 66.7, 66.7, 66.7, 66.7 | 66.7 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v1` | frame | edge-dpr2 | 66.8, 66.8, 66.8, 66.8, 66.7 | 66.8 | ≤ 33.3 | miss |
| `e26-simple-stress-10k/v1` | frame | chrome-dpr1 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 33.3 | pass |
| `e26-simple-stress-10k/v1` | frame | chrome-dpr2 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 33.3 | pass |
| `e26-simple-stress-10k/v1` | frame | edge-dpr1 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 33.3 | pass |
| `e26-simple-stress-10k/v1` | frame | edge-dpr2 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 33.3 | pass |
| `e26-pointer-busy-10k/v1` | busy | chrome-dpr1 | 73.9, 74.6, 71.9, 81.1, 84.6 | 84.6 | < 50 | miss |
| `e26-pointer-busy-10k/v1` | busy | chrome-dpr2 | 109.2, 101.3, 75.2, 88.7, 85.4 | 109.2 | < 50 | miss |
| `e26-pointer-busy-10k/v1` | busy | edge-dpr1 | 78.1, 83.8, 67, 72.2, 135.8 | 135.8 | < 50 | miss |
| `e26-pointer-busy-10k/v1` | busy | edge-dpr2 | 78.5, 124.8, 91.5, 74.4, 102.6 | 124.8 | < 50 | miss |
| `e26-pointer-busy-10k/v1` | plain | chrome-dpr1 | 75.7, 149.2, 70.7, 68.6, 76.4 | 149.2 | < 50 | miss |
| `e26-pointer-busy-10k/v1` | plain | chrome-dpr2 | 89.8, 74.3, 73.6, 83.7, 84.6 | 89.8 | < 50 | miss |
| `e26-pointer-busy-10k/v1` | plain | edge-dpr1 | 79.3, 67.1, 76.3, 72.8, 80.1 | 80.1 | < 50 | miss |
| `e26-pointer-busy-10k/v1` | plain | edge-dpr2 | 84, 82.5, 74.9, 70.5, 66.3 | 84 | < 50 | miss |
| `e26-isolation-m1-a13/v1` | isolation | chrome-dpr1 | 95.7 / 109.9, 86.3 / 111.3, 93.2 / 121.3, 88.1 / 116.3, 96.7 / 115.3 | 96.7 / 121.3 | ≤ 276.2 / 552.4 | pass |
| `e26-isolation-m1-a13/v1` | isolation | chrome-dpr2 | 88.4 / 117.7, 88.7 / 113.3, 97.3 / 115, 94.1 / 109.2, 93.2 / 114.3 | 97.3 / 117.7 | ≤ 278.9 / 557.8 | pass |
| `e26-isolation-m1-a13/v1` | isolation | edge-dpr1 | 84.3 / 126.9, 87.7 / 119, 90 / 118.3, 92.4 / 111.6, 86 / 122.8 | 92.4 / 126.9 | ≤ 287.6 / 575.2 | pass |
| `e26-isolation-m1-a13/v1` | isolation | edge-dpr2 | 90.8 / 113.1, 99.4 / 179.5, 104 / 128.9, 102 / 129.6, 100.3 / 130.9 | 104 / 179.5 | ≤ 288.5 / 577 | pass |
| `e26-mixed-view-edit-10k/v2` | frame | chrome-dpr1-v2 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v2` | frame | chrome-dpr2-v2 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v2` | frame | edge-dpr1-v2 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 16.7 | miss |
| `e26-mixed-view-edit-10k/v2` | frame | edge-dpr2-v2 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 16.7 | miss |
| `e26-mixed-all-edit-10k/v2` | frame | chrome-dpr1-v2 | 50.1, 50.1, 50.1, 50.1, 50 | 50.1 | ≤ 33.3 | miss |
| `e26-mixed-all-edit-10k/v2` | frame | chrome-dpr2-v2 | 50.1, 50.1, 50.1, 50.1, 50.1 | 50.1 | ≤ 33.3 | miss |
| `e26-mixed-all-edit-10k/v2` | frame | edge-dpr1-v2 | 50.1, 50.1, 50, 50.1, 50.1 | 50.1 | ≤ 33.3 | miss |
| `e26-mixed-all-edit-10k/v2` | frame | edge-dpr2-v2 | 50.1, 50.1, 50.1, 50.1, 50.1 | 50.1 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | chrome-dpr1-v2 | 66.6, 66.7, 66.7, 66.7, 66.6 | 66.7 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | chrome-dpr2-v2 | 66.7, 66.7, 66.7, 66.7, 66.8 | 66.8 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | edge-dpr1-v2 | 66.6, 66.6, 66.6, 66.7, 66.6 | 66.7 | ≤ 33.3 | miss |
| `e26-mixed-all-pan-10k/v2` | frame | edge-dpr2-v2 | 66.7, 66.7, 66.7, 66.7, 66.8 | 66.8 | ≤ 33.3 | miss |
| `e26-simple-stress-10k/v2` | frame | chrome-dpr1-v2 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 33.3 | pass |
| `e26-simple-stress-10k/v2` | frame | chrome-dpr2-v2 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 33.3 | pass |
| `e26-simple-stress-10k/v2` | frame | edge-dpr1-v2 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 33.3 | pass |
| `e26-simple-stress-10k/v2` | frame | edge-dpr2-v2 | 16.8, 16.8, 16.8, 16.8, 16.8 | 16.8 | ≤ 33.3 | pass |
| `e26-pointer-busy-10k/v2` | busy | chrome-dpr1-v2 | 222.2, 199.9, 483, 286.4, 225.6 | 483 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | busy | chrome-dpr2-v2 | 209.6, 257.7, 480.4, 197.7, 227.7 | 480.4 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | busy | edge-dpr1-v2 | 347, 251, 199.6, 216.5, 241.6 | 347 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | busy | edge-dpr2-v2 | 217.6, 259.6, 257.1, 257.6, 190.3 | 259.6 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | chrome-dpr1-v2 | 220.8, 202.7, 164.2, 225.4, 244.1 | 244.1 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | chrome-dpr2-v2 | 222.8, 245, 211.4, 196.4, 262.2 | 262.2 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | edge-dpr1-v2 | 195.1, 147.6, 188.6, 253.9, 185.1 | 253.9 | < 50 | miss |
| `e26-pointer-busy-10k/v2` | plain | edge-dpr2-v2 | 181.6, 208.9, 137.2, 295.9, 179.3 | 295.9 | < 50 | miss |
| `m9-typing-10k/v1` | typing | chrome-dpr1-v2 | 51.4, 52, 52.5, 51, 53.8 | 53.8 | recorded | recorded |
| `m9-typing-10k/v1` | typing | chrome-dpr2-v2 | 58.9, 64.2, 60.1, 59, 63.4 | 64.2 | recorded | recorded |
| `m9-typing-10k/v1` | typing | edge-dpr1-v2 | 56.4, 53.1, 53.2, 50.7, 50.1 | 56.4 | recorded | recorded |
| `m9-typing-10k/v1` | typing | edge-dpr2-v2 | 65.2, 54.8, 57.6, 56.2, 58.7 | 65.2 | recorded | recorded |
| `m9-ui-geometry` | geometry | chrome-dpr1-v2 | origin and size with and without ui=1 |  | equal | pass |
| `m9-ui-geometry` | geometry | chrome-dpr2-v2 | origin and size with and without ui=1 |  | equal | pass |
| `m9-ui-geometry` | geometry | edge-dpr1-v2 | origin and size with and without ui=1 |  | equal | pass |
| `m9-ui-geometry` | geometry | edge-dpr2-v2 | origin and size with and without ui=1 |  | equal | pass |
