# P1.5 matrix capture: 2026-09-12

Disposition: the 24 visual/precision matrix tests PASS. The whole command returned exit 1: **34 passed, 4 failed, 25.3 minutes**. All four failures are recovery tests whose harness rejected the deliberately induced loss diagnostic; they require successor evidence. This record does not describe a passing whole-suite run.

Owning interpretation: [Primary review](../../p1.5-visual-review-2026-09-12.md). Frozen inputs and thresholds: [P1 private contract](../../../plans/p1-private-contract.md) and [active plan](../../../plans/p1-instanced-primitives.md).

## Command and source

```powershell
$env:P1_EVIDENCE_OUTPUT_DIR='artifacts/p1.5/final-20260912-2'
pnpm test:gpu
```

The run used the dirty feature branch based on `c3e124685567acd6f5dacee05be19c86d857e48c`. [source-manifest.json](source-manifest.json) identifies 101 source/configuration files with manifest SHA-256 `4595378df84f44df996d870dbb49338058dccf38e5fca53d68d4040617f45b77`. [source.zip](source.zip) contains those exact files for overlay on that base. Each completed matrix report records matching start/end manifests. Subsequent recovery-only source changes are assessed separately in the Primary review; original observations are unchanged.

After restoring the archived source on its recorded base, use the pinned Node/pnpm versions, install the lockfile dependencies, run `pnpm build`, then the command above with a fresh output identity. Installed Chrome/Edge and native WebGPU support are required. Later browser/driver observations are new runs, not replacements for these records.

## Environment and method

- Windows `10.0.26200`, x64; Node `24.15.0`, pnpm `11.1.2`.
- Headed Chrome `152.0.7977.83` and Edge `153.0.4234.32`, one worker, development Vite page, `--enable-unsafe-webgpu`.
- Native adapter exposes NVIDIA / Turing; description and driver version are not exposed in these functional records. Full actual WebGPU limits and selected features are in every observations JSON.
- Fixed canvas 640 × 360 CSS; DPR 1, 1.5, 2; actual sample count 1 and 4. Browser viewport is 800 × 500. The 1× tests exercise the existing fallback through deliberate 4× capability rejection.
- V02/V03 use transparent clear; other fixtures use opaque black. Raw canvas texture bytes retain premultiplied RGBA. PNG encoding explicitly unpremultiplies. Native vertex-body float readback and independent f64 comparisons are separate from the production raster images.
- No benchmark, physical presentation measurement, power/refresh-rate acceptance or P1 performance claim is made. Test traces are disabled for P1 because explicit full images and numeric records preserve the relevant evidence.

## Results and archives

The [summary](summary.json) checks all 24 reports, matching source manifests, 6,288 PNG signatures, 6,288 decompressed raw RGBA lengths, no page/unexpected diagnostic errors, and terminal live resources zero. It records report hashes and per-matrix maxima.

| Observation                                    | Result                                                       |
| ---------------------------------------------- | ------------------------------------------------------------ |
| V01–V07                                        | 240 fixtures PASS                                            |
| N02                                            | 6,048 fixtures PASS                                          |
| Pixel centers checked                          | 60,530,420                                                   |
| Largest classified-region contour error        | 0.5562500000000057 physical px; threshold 1 px               |
| Largest native position/guard comparison error | 0.07497283827566124 physical px; threshold 0.25 px           |
| Stable interior/exterior RGBA                  | All checks within 2/255 at least 2 physical px from contours |
| Existing P0 headed regressions                 | 10 tests PASS                                                |

[chrome.zip](chrome.zip) and [edge.zip](edge.zip) each contain full PNGs, `.rgba.gz` raw images, source manifests and observations for all 12 matrix combinations. Recovery directories are empty because their failing capture never returned. [runner-output.zip](runner-output.zip) preserves the full runner output directory, including P0 regression evidence and four recovery error contexts, before the successor command can clean it. The console result above was observed directly; a complete console transcript was not captured.

The deterministic sample/oracle algorithms are in the archived source. Bounded color and edge comparison arrays accompany full raw pixels; they are not implementation-generated golden images. The recovery harness correction does not alter corpus, oracle, probe, shader, packet path or native implementation. Final acceptance and the successor source delta belong in the linked Primary review.
