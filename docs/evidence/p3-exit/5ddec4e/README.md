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

| Run                                                                  | Commit                                                                         | Where                                                                                | Parts                                                                                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [Container run](container-00e49bf/)                                  | `00e49bf` (clean; changes since 5ddec4e are documents, tests and harness only) | Cloud container, Linux x86_64, Node 24.15.0, Rust 1.94.1                             | `test:geometry` ([log](container-00e49bf/test-geometry-and-sweep.log)), A01 sweep, fill and stroke class diagnostics, A03 and A05/A06 runners |
| Protected CI                                                         | `c8a765d`, the #271 head, whose tree equals `00e49bf`                          | [Run 40276647840](https://github.com/npclown/vector-studio/actions/runs/40276647840) | `Static, unit, boundaries, and build`: PASS                                                                                                   |
| [PC headed run](headed-pc-2026-10-26/)                               | `00e49bf`, clean                                                               | User's PC, Chrome 155 and Edge 156                                                   | ST-U6, ST-U7, p3-b2-strokes, viz-v3-integration: 20/20 (A03, A06)                                                                             |
| [A04 reference run](../../e3-a04/2026-10-27T00-33-11-173Z-de2951d7/) | `a83b7db` (shards at `7443c2b`), E3-U5, #278                                   | PC and hosts of E3 section 19.6                                                      | A04, and A01's crack report (GPU readback in Chrome 155 and Edge 156)                                                                         |

## Container run commands

Run in a clean worktree at `00e49bf` with Node 24.15.0 and `CARGO_HOME=~/.cargo RUSTUP_HOME=~/.rustup`, in this order:

1. `pnpm install --frozen-lockfile`, `pnpm build`, then `test:geometry` from the host-adjusted copy described in [A05](A05.md).
2. `pnpm p3-exit:sweep --scene --corpus` ([provenance](container-00e49bf/sweep-provenance.json), [scene](container-00e49bf/sweep-scene-summary.json), [corpus](container-00e49bf/sweep-corpus-summary.json)).
3. `pnpm e16:fill-diag <corpus.json of step 2>` ([summary](container-00e49bf/fill-diag-summary.tsv), [classes](container-00e49bf/fill-diag-classes.tsv)). It reads that record, whose provenance names the commit and clean tree.
4. `pnpm a03:stroke-diag <corpus.json of step 2>` ([provenance](container-00e49bf/stroke-diag-provenance.json), [summary](container-00e49bf/stroke-diag-summary.tsv), [named rows](container-00e49bf/stroke-named.tsv)).
5. `pnpm p3-exit:a05-a06 --label 5ddec4e` and `pnpm p3-exit:a03 --label 5ddec4e` ([A05/A06](container-00e49bf/a05-a06-summary.md), [A03](container-00e49bf/a03-summary.md)).

The closed-list rule of E11 section 7.2 applies to rejected `a04-corpus/v1` rows, so the class diagnostics cover the corpus phase. The stress scene (A01) has 252 fill and 746 stroke rejections; A01 needs every scene request to end within its cap with a valid structure, not a class.

## Status per criterion

| ID  | Record                                                                   | State                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 | [A01.md](A01.md)                                                         | FAIL on crack width only, pending the independent review: GPU T-junction cracks up to 0.00108 physical px against "crack width 0". Structure, isolation and bounded work PASS                                   |
| A02 | Pending                                                                  | Corpus part done: all 797 corpus fill rejections are in a closed-list class (E14-Q1 312, exact-rung cap stop 463, `ZeroLengthLeaf` 22). Waits for V-4's headed fill-rule rows |
| A03 | [A03.md](A03.md)                                                         | PASS: runner CI part, corpus classes and the headed ST-U6, ST-U7 and B2 specs in Chrome and Edge                                                                              |
| A04 | [E3-U5 record](../../e3-a04/2026-10-27T00-33-11-173Z-de2951d7/record.md) | FAIL, recorded as is by the user's decision of 2026-10-27; disclosed, remedies in backlog E20                                                                                 |
| A05 | [A05.md](A05.md)                                                         | PASS (no headed part)                                                                                                                                                         |
| A06 | [A06.md](A06.md)                                                         | PASS: runner CI part and the V-3 headed port-call deltas in Chrome and Edge                                                                                                   |
| A07 | Pending                                                                  | PC headed V-3 run in Chrome and Edge                                                                                                                                          |
| A08 | Pending                                                                  | V-4 counted run (V-4 thread)                                                                                                                                                  |
