# P2 Rust/WASM geometry kernel execution plan

Status: P2.0 contract frozen locally, 2026-09-26; protected PR integration remains required before implementation. Entry is authorized by [D6](p1-follow-on-entry-proposal.md). P1 A09/A10 and full P1 acceptance remain UNVERIFIED; this plan does not authorize P3-P5.

## Scope and contract

Implement only the P2 scope in the [roadmap](../prototype-plan.md#p2-rustwasm-geometry-kernel): packed canonical paths, cubic bounds, adaptive flattening, batch/reserve ABI, reconstructible geometry cache and independent TypeScript reference. The [private contract](p2-private-contract.md) fixes numeric/error/ownership behavior before code. The graphics architecture owns the physical-pixel interpretation. No public editor API, renderer lifecycle, document schema, tessellator or dependency is added.

Rust tooling is absent from the current PATH. Tool acquisition is a separate pending user decision: pinned Rust 1.94.1 with wasm32-unknown-unknown, rustfmt and Clippy via SHA-verified rustup 1.28.2, using a project-specific tool cache and the already installed MSVC toolchain. No permanent PATH change or third-party crate is proposed. P2.1 may proceed using existing TypeScript tools while that decision is pending.

## Acceptance and deterministic fixtures

| ID  | Required evidence                                                                                                                                                                            | Status |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| A01 | Packed v1 input/output exact layout, terminal offsets, aligned/range-checked sections, source echoes, empty/multiple subpaths; malformed envelope versus per-path atomic failures            | TODO   |
| A02 | Analytic and independent bracketed bounds agree within private tolerances; extrema, near-linear roots, repeated roots, large/small translated inputs, nonfinite/uncertain rejection          | TODO   |
| A03 | Every successful flattened cubic passes independent continuous <=0.25 physical-pixel check; zoom/world scale/shear/DPR bucket transitions and positive controls                              | TODO   |
| A04 | Bounded adversarial work, deterministic output/errors, no trap/partial failed-path output; valid path after failed path still succeeds                                                       | TODO   |
| A05 | Reserve/growth/relocation/view invalidation, insufficient-output retry, allocation-failure seam, disposal and recreated-instance isolation                                                   | TODO   |
| A06 | One of 10,000 paths edited builds exactly one path; unchanged calls hit, bucket change affects only changed requests; stale/revision conflict, LRU/oversize/byte accounting/dispose fixtures | TODO   |
| A07 | At least 10,000 seeded cubics plus named adversarial/metamorphic corpus; native Rust and browser WASM agree with independent reference without production helper imports                     | TODO   |
| A08 | Fair end-to-end batch/per-path benchmark meets frozen speedup below with every repetition, failure, source/environment record retained                                                       | TODO   |

Corpus version `p2-geometry/v1` uses xorshift32 (shifts 13,17,5, unsigned after each update), seeds 1, 0x12345678, 0x9e3779b9, 0xdeadbeef, 2,500 cubics per seed. Draw u=state/2^32. Base control components are (2*u-1)_1000, generated x then y for P0..P3. Cycle transformations by index: identity; translation (1e9,-1e9); scale 1e-6; rotation pi/7; shear x'=x+3_y. These are local-control metamorphisms. Independently cycle world matrices W=[identity, diag(4,0.25), [[1,3],[0,1]], rotation(pi/7), diag(-1,1)] by floor(index/5)%5, zoom [0.01,1,64] by floor(index/25)%3 and DPR [1,2,3] by floor(index/75)%3. Retain each concrete W, zoom, DPR and independently checked bucket in failure records. Compare geometry in local space and error after the declared screen linear transform; record concrete parameters on failure.

Named fixtures also include empty/MOVE-only/LINE/CLOSE, nested subpaths, line-equivalent cubic, exact interior extrema, near-linear derivative, double root, S-curve, cusp, collinear overshoot, retracing, closed loop, tiny controls, huge unrepresentable finite controls, invalid state/arity/terminal offsets/nonfinite coordinates, bucket neighbors, depth/output/visited-node and arena cap boundaries, adjacent cubics with unequal leaf depths, zero-screen-transform behavior and mixed failed/success paths. Numeric failure expectations are explicit; do not classify every inconvenient seed as acceptable rejection. Ordinary generated corpus must succeed; specially labeled precision/work-limit fixtures must return their expected status. P2.1 records fixtures and independent oracle positive controls before Rust differential acceptance.

## Task graph and ownership

| Task | Scope / anticipated files                                                                          | Predecessors             | Model / effort                        | Risk and completion evidence                                                                     |
| ---- | -------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| P2.0 | Private contract, acceptance, navigation and architecture decision links                           | D6                       | Primary Astra high                    | High numeric/cross-boundary impact; independent review and doc checks before code                |
| P2.1 | Independent reference/corpus in geometry-reference, package boundary/compile wiring, unit fixtures | P2.0                     | Sol medium; Primary integration       | Medium; analytic/positive/metamorphic oracle tests, root check/build; no Rust acquisition needed |
| P2.2 | Rust private kernel, raw ABI, deterministic native tests, reproducible WASM build                  | P2.0 + tool approval     | Sol high                              | High numeric/unsafe-memory risk; rustfmt, Clippy, cargo test and WASM build; no renderer changes |
| P2.3 | TypeScript adapter, reserve/view ownership and bounded cache                                       | P2.2                     | Primary or Sol high under one owner   | High lifetime risk; A01/A04-A06 contract fixtures and root check/build                           |
| P2.4 | Independent differential runner/native browser coverage                                            | P2.1 + P2.3              | Sol medium                            | A02/A03/A07 corpus and browser WASM evidence; Primary numerical review                           |
| P2.5 | Production benchmark runner, metadata/source/raw-record validation and functional profile          | P2.4                     | Terra medium; Primary timing review   | Freeze commands before execution, functional record integrity tests; no speedup claim yet        |
| P2.6 | Serial reference runs, evidence and P2 gate review                                                 | P2.5 + valid environment | Luna low commands; Primary acceptance | A08 and all A01-A08 evidence; independent P1 obligations remain open                             |

```text
D6 -> P2.0 -> P2.1 --------------------+
          -> approved tooling -> P2.2 -> P2.3 -> P2.4 -> P2.5 -> P2.6
P1.6b B05 environment -> A05/A08 observations (independent; serial hardware use)
P1.0m A09/A10 -> full P1 gate (unchanged)
```

P2.1/P2.2 can use disjoint files after freeze; Primary owns shared package/build/CI wiring and contracts. Keep each checkpoint on its own protected PR, or one tightly coupled reviewed work unit if shared ABI integration requires it. Never concurrently mutate a shared branch or lifecycle file. No recursive delegation by default. Escalate any required third-party dependency, meaningful public API, top-level boundary or acceptance change.

## Prospective benchmark contract

Scenario `p2-batch/v1`: 1,000 paths, each MOVE plus 32 connected CUBIC segments. Generator seed 0x12345678, same xorshift above; initial MOVE=(0,0); each control and endpoint is a relative delta ((2*u-1)*100,(2*u-1)*100) from the previous endpoint. Use local tolerance 0.25, zoom/DPR/world identity, no cache. Inputs are generated once outside timing and identical for both variants. Batch variant calls process once for all paths; comparison uses 1,000 process calls with one path each through the same kernel/adapter code. Neither variant uses a dummy per-node loop or different algorithm/build. Both must produce equal status/bounds/output checksums before timing can count.

Each measured sample starts before packing and includes packing, copying into reserved WASM memory, process calls, refreshed output views, retained-result copies and traversal/checksum of every output scalar/verb/provenance value. End after checksum publication. Instantiation and reserve are measured/reported separately, then excluded equally from steady samples. Pre-reserve sufficient capacities for each variant; any measured growth or invalid result invalidates the repetition. Caches are disabled in both; logical input counters must equal 32,000 source cubics per sample. Separately report actual sizing/emission passes and subdivision work so two-pass processing is not hidden. Use separate equally warmed instances; no hidden cached outputs.

On the current reference machine, production browser WASM runs serially in headed Chrome then Edge, five fresh page repetitions each. Each repetition has ten untimed sample pairs then thirty measured pairs, alternating AB/BA by pair index (start order alternates by repetition). No tracing, recording or DevTools. A=batched, B=per-path. Preserve every duration/checksum/counter and failed repetition. Browser performance.now is the elapsed monotonic clock; record observed resolution before timing. If sample durations are too small relative to resolution (less than 100 clock quanta), mark UNVERIFIED rather than change repetitions post hoc.

For each repetition compute nearest-rank median/p95/p99 per variant and the median of paired B/A duration ratios. Every repetition in both browsers must have median paired speedup >=1.20 and batch p95 <= per-path p95. Report worst repetition, all sample counts, min/max and browser-specific results; do not pool away a failure. This prospectively concretizes the roadmap's measurable speedup; failure leads to investigation, not a lower threshold. No comparison with TypeScript speed is required by P2.

Record the full [benchmark metadata](../benchmarks/README.md), pinned Rust/compiler flags/WASM SHA-256, configuration/source manifests, all environment observations and owned-buffer/linear-memory counters with exclusions. Functional runner tests have no performance disposition. Benchmark implementation must provide exclusive output directories and source-start/end integrity checks. No P1 A09 or A10 claim follows from these measurements.

## Validation commands and progress

Current commands: `pnpm check`, `pnpm build`; changed Markdown requires explicit Prettier and local link/anchor checks. Planned root aliases introduced with their owning implementation are `pnpm test:geometry` (Rust format/Clippy/native tests and deterministic WASM build), `pnpm test:geometry:browser` (independent browser differential fixtures), and `pnpm benchmark:p2 --profile functional|reference` (production runner). Document exact executable commands, toolchain and results before marking their checkpoint complete; these aliases do not exist at P2.0.

P2.0 starts from clean main `c599d39`, after [P1.6b PR #39](https://github.com/npclown/vector-studio/pull/39). Its [functional evidence](../evidence/p1.6b/20260926-functional/README.md) does not provide P1 reference acceptance or any P2 evidence. All P2 runtime criteria are TODO. Rust installation and fresh B05 environment confirmation remain pending separate answers.

P2.0 review: Primary owns the contract; a GPT-5.6 Sol medium worker performed two read-only reviews, with no child delegation. Findings corrected before freeze: derivative double-root and discriminant uncertainty rules, resident revision identity independent of variant keys, whole-batch cap/atomic sizing behavior, two-pass work accounting, distinct local/world fixture transforms, cubic provenance reset and failed/oversized cache admission. Primary replaced repeated absolute-origin rounding with P0-relative arithmetic before implementation. A read-only scalar budget check at sigma=192,768,634.132922444543 found the worst declared domain guard 0.021828811441082507 physical pixel; this checks budget feasibility only, not continuous or runtime acceptance.

Local documentation validation: explicit Prettier check of all six changed Markdown files; the heading/HTML-anchor checker documented in [P1.0b evidence](../evidence/p1.0b-contract-review-2026-09-12.md#validation-and-limits); `git diff --check`; Primary source-of-truth/scope review. Exact results are recorded on the checkpoint PR. Product/build/browser/benchmark checks are NOT RUN locally for this documentation-only change; required remote static/unit/boundary/build CI remains mandatory. No dependency, generated output, product file or historical observation is changed.
