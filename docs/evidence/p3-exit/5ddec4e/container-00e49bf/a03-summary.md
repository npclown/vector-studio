Label: **5ddec4e**

| Identity             | Value                                                            |
| -------------------- | ---------------------------------------------------------------- |
| Run commit           | 00e49bf20b3dcb08c459de335fe25bb2f8a0d8df                         |
| Clean tree           | yes                                                              |
| Fill operation       | geometry-wasm/fill-v0+r4                                         |
| Stroke operation     | geometry-wasm/stroke-v0+r7                                       |
| Release WASM SHA-256 | 58f26517603d0d599f187481c967832e3f6abea2eb53c738e5540b6200b4fd35 |
| Map                  | tooling/p3-exit-a03-map.json                                     |
| Map SHA-256          | d5c595ecfc1ae457d59a0d5380f9c1c3ca013c8ad7608dbc225841bd39e7c863 |
| Rust host            | x86_64-unknown-linux-gnu                                         |
| Node                 | v24.15.0                                                         |
| OS                   | Linux 6.18.44-fc-v153 x64                                        |

| Criterion | Entry                                                    | Kind          | Runner   | Tests | Verdict |
| --------- | -------------------------------------------------------- | ------------- | -------- | ----- | ------- |
| A03       | ST-F1 to ST-F14, ST-F21 to ST-F26 (kernel, line strokes) | required      | cargo    | 13    | PASS    |
| A03       | ST-F15 to ST-F20 (kernel, cubic strokes)                 | required      | cargo    | 7     | PASS    |
| A03       | ST-F1 to ST-F26 with ST-O1 to ST-O5 (dump hand-off)      | required      | geometry | 20    | PASS    |
| A03       | ST-O1 to ST-O5 oracle, fixtures and positive controls    | required      | unit     | 173   | PASS    |
| A03       | SC01-SC22 (release WASM)                                 | required      | geometry | 22    | PASS    |
| A03       | SC01-SC22 (test double)                                  | required      | unit     | 22    | PASS    |
| A03       | ST-A10 probes (scene validation)                         | required      | unit     | 16    | PASS    |
| A03       | ST-A10 probes (stroke pipeline)                          | required      | unit     | 33    | PASS    |
| A03       | Stroke kernel transport (B2 section 7)                   | supplementary | cargo    | 18    | PASS    |
| A03       | Early abort (B2 S7)                                      | supplementary | cargo    | 13    | PASS    |
| A03       | E2-K1 seam merge and E2-K3 family-B rung                 | supplementary | cargo    | 11    | PASS    |
| A03       | E2-K2 band leaf rule                                     | supplementary | cargo    | 7     | PASS    |
| A03       | Stroke adapter (B2 section 8)                            | supplementary | geometry | 57    | PASS    |
| A03       | ST-U6 headed stroke fixtures (ST-A10)                    | headed        | headed   | 0     | HEADED  |
| A03       | ST-U7 headed joint fixtures (ST-A11, ST-A16, ST-A17)     | headed        | headed   | 0     | HEADED  |
| A03       | B2 stroke page (p3-b2-strokes)                           | headed        | headed   | 0     | HEADED  |

- A03: PASS (CI part; headed part cited separately)
