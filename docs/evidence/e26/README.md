# E26 pointer priority and the 10,000-node workload: evidence

This folder holds the evidence for the [E26 contract](../../plans/d9-e26-pointer-priority-contract.md).

- [baseline-bc071b0.md](baseline-bc071b0.md): the pinned baseline (U1c, section 3.5) on the reference PC at `bc071b0`. Every target is missed, and the record holds the findings and what they mean for U5 and U6. The raw run records are in [baseline-bc071b0/runs/](baseline-bc071b0/runs/), and [baseline-bc071b0/summary.json](baseline-bc071b0/summary.json) summarizes them with `tooling/e26-summarize.mjs`.
- [early-127fba3.md](early-127fba3.md): the early run after U5a to U5c (section 4.4.1), at `127fba3`. It still misses every target and sets U5d's three units. Raw records in [early-127fba3/runs/](early-127fba3/runs/), summary in [early-127fba3/summary.json](early-127fba3/summary.json).
- [rerun-59bf080.md](rerun-59bf080.md): the re-run after U5d, at `59bf080`. The stress row passes, the typical view holds one vsync, and the all-visible rows and pointer latency still miss. Raw records in [rerun-59bf080/runs/](rerun-59bf080/runs/), summary in [rerun-59bf080/summary.json](rerun-59bf080/summary.json).
