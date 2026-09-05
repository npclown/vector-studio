# Benchmark result: <milestone>/<scenario>

Status: Exploratory | Accepted | Rejected

New runner output starts Exploratory. Acceptance and baseline selection require an execution-plan review; preserve this file after the run is committed.

## Identity

- Revision:
- Worktree: clean | dirty (describe)
- Dirty source delta / source-manifest artifact (if applicable):
- Unique run ID / schema version:
- Timestamp UTC:
- Local timezone:
- Runner command/version:
- Build mode:

## Environment

- OS:
- CPU / logical cores:
- Installed memory:
- GPU adapter / driver:
- WebGPU limits artifact:
- Browser / channel / version:
- Browser launch flags / hardware adapter verification:
- Display refresh rate / selected features / sample count:
- Viewport CSS / physical / DPR:
- Power source and mode:
- Known background load:

## Scenario

- ID and version:
- Seed:
- Configuration hash:
- Full configuration artifact / hash serialization:
- Warm-up:
- Measurement window:
- Repetitions:
- DevTools/tracing/recording:
- Clock / start and end events / availability by metric:
- Percentile method / per-run and aggregate sample counts:

## Results

| Metric                                            | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 | Aggregate |
| ------------------------------------------------- | ----: | ----: | ----: | ----: | ----: | --------: |
| Initialization ms                                 |       |       |       |       |       |           |
| First submission ms                               |       |       |       |       |       |           |
| Observed first present ms (or unavailable reason) |       |       |       |       |       |           |
| Frame interval p95 ms                             |       |       |       |       |       |           |
| CPU submit p95 ms                                 |       |       |       |       |       |           |
| Long tasks >50 ms                                 |       |       |       |       |       |           |
| Peak tracked GPU bytes                            |       |       |       |       |       |           |

## Acceptance evaluation

| Criterion                | Result                   | Evidence                |
| ------------------------ | ------------------------ | ----------------------- |
| Link to owning criterion | PASS / FAIL / UNVERIFIED | Artifact or observation |

- Evidence/metadata validity:
- Execution-plan acceptance review link (required for Accepted):

## Diagnostics and artifacts

- Raw JSON:
- Raw timing samples / measured-window boundaries:
- Screenshot:
- Trace, if diagnostic only:
- Warning/error diagnostics:

## Notes

Record anomalies, outliers, environment changes, and any reason this run should not become a baseline.
