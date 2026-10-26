# P3 exit evidence at snapshot 5ddec4e

This directory holds the P3 exit evidence for A01-A08 on the [E11 exit snapshot record](../../../plans/d9-e11-p3-c03-c05-closure-contract.md#12-exit-snapshot-record) of 2026-10-26 (E11 section 7.1). There is one file per criterion, and each file is immutable once committed. A criterion is marked done in the [X1 index](../../../plans/d9-rendering-track.md#p3-exit-evidence-index-x1) only after an independent evidence review.

## Snapshot identities (E11-K1, copied from the record)

| Identity             | Value                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot commit      | `5ddec4e8d79185b4d620a058d95cf8bfc1077d9a`                                                                                                        |
| Fill operation       | `geometry-wasm/fill-v0+r4`                                                                                                                        |
| Stroke operation     | `geometry-wasm/stroke-v0+r7`                                                                                                                      |
| Release WASM SHA-256 | `58f26517603d0d599f187481c967832e3f6abea2eb53c738e5540b6200b4fd35`                                                                                |
| Mesh shader SHA-256  | `d306137cf0770f6bf7f9237f1c98b9ecd0a165cfdbfda916196d299e36b831a3` (`p3-mesh-fill-v0`), with the E17 write-once stencil state                     |
| Corpora              | `a04-corpus/v1` `7f4bb1c9…721c`, oracle `5b2fafc3…7e80`; `a08-subset/v1` keys `1d406287…92a4`; stress scene `p3-exit-stress/v1` seed `0x5eede111` |

## Runs

| Run                                 | Commit                                                                         | Where                                                                                | Parts                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| [Container run](container-00e49bf/) | `00e49bf` (clean; changes since 5ddec4e are documents, tests and harness only) | Cloud container, Linux x86_64, Node 24.15.0, Rust 1.94.1                             | `test:geometry`, A01 sweep, fill and stroke class diagnostics, A03 and A05/A06 runners |
| Protected CI                        | `c8a765d`, the #271 head, whose tree equals `00e49bf`                          | [Run 40276647840](https://github.com/npclown/vector-studio/actions/runs/40276647840) | `Static, unit, boundaries, and build`: PASS                                            |
| PC headed run                       | Pending                                                                        | User's PC                                                                            | A02 (V-4 fill rows), A03 (ST-U6, ST-U7, B2 page), A06 and A07 (V-3), A08 (V-4)         |
| A04 reference run                   | Pending (E3-U5)                                                                | PC and hosts of E3 section 19.6                                                      | A04, and A01's crack report                                                            |

## Status per criterion

| ID  | Record           | State                                                                                                                                                                  |
| --- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 | Pending          | Sweep part done in the container run: 0 structure, echo, isolation and batch failures, all 18 controls caught. Waits for the E3 crack report from the A04 run          |
| A02 | Pending          | Corpus part done: all 797 fill rejections are in a closed-list class (E14-Q1 312, exact-rung cap stop 463, `ZeroLengthLeaf` 22). Waits for V-4's headed fill-rule rows |
| A03 | Pending          | CI part PASS and all stroke rejections in a closed-list class or at a B2 literal status. Waits for the headed stroke specs                                             |
| A04 | Pending          | E3-U5 reference run                                                                                                                                                    |
| A05 | [A05.md](A05.md) | PASS (no headed part)                                                                                                                                                  |
| A06 | Pending          | CI part PASS. Waits for the V-3 headed port-call deltas                                                                                                                |
| A07 | Pending          | PC headed V-3 run in Chrome and Edge                                                                                                                                   |
| A08 | Pending          | V-4 counted run (V-4 thread)                                                                                                                                           |
