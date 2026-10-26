Label: **5ddec4e**

| Identity | Value |
| --- | --- |
| Run commit | 00e49bf20b3dcb08c459de335fe25bb2f8a0d8df |
| Clean tree | yes |
| Fill operation | geometry-wasm/fill-v0+r4 |
| Stroke operation | geometry-wasm/stroke-v0+r7 |
| Release WASM SHA-256 | 58f26517603d0d599f187481c967832e3f6abea2eb53c738e5540b6200b4fd35 |
| Map | tooling/p3-exit-a05-a06-map.json |
| Map SHA-256 | e3ebd44cc2430e3403a9b7b57a64eada4ac14e6c12b594aed01632e8383d526a |
| Rust host | x86_64-unknown-linux-gnu |
| Node | v24.15.0 |
| OS | Linux 6.18.44-fc-v153 x64 |

| Criterion | Entry | Kind | Runner | Tests | Verdict |
| --- | --- | --- | --- | --- | --- |
| A05 | V2-A3 | required | cargo | 33 | PASS |
| A05 | V2-A5 | required | geometry | 52 | PASS |
| A05 | C01-C18 (release WASM) | required | geometry | 20 | PASS |
| A05 | C01-C18 (test double) | required | unit | 20 | PASS |
| A05 | SC01-SC22 (release WASM) | required | geometry | 22 | PASS |
| A05 | SC01-SC22 (test double) | required | unit | 22 | PASS |
| A05 | Stroke kernel transport (B2 section 7) | supplementary | cargo | 18 | PASS |
| A05 | Stroke adapter (B2 section 8) | supplementary | geometry | 57 | PASS |
| A05 | Stale work: V3-A8 resumption | supplementary | unit | 1 | PASS |
| A06 | V3-A2 | required | unit | 4 | PASS |
| A06 | V3-A3 | required | unit | 4 | PASS |
| A06 | V3-A5 (pipeline) | required | unit | 6 | PASS |
| A06 | V3-A5 (buckets) | required | unit | 5 | PASS |
| A06 | V3-A6 | required | unit | 3 | PASS |
| A06 | V3-A7 | required | unit | 6 | PASS |
| A06 | B2 section 9.3 (stroke key, shared cache and memo, reuse) | required | unit | 9 | PASS |
| A06 | Opacity with both paints (ST-U7) | supplementary | unit | 1 | PASS |
| A06 | V-3 port-call deltas (VZ3-A4, A5, A6, A10, A11, A12) | headed | headed | 0 | HEADED |

- A05: PASS
- A06: PASS (CI part; headed part cited separately)
