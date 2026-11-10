# E41 evidence index

Contract: [d9-e41-boolean-effects-contract.md](../../plans/d9-e41-boolean-effects-contract.md). Exit record: [exit-2026-11-10.md](exit-2026-11-10.md).

| File | Unit | Criteria | Where it ran |
| --- | --- | --- | --- |
| [u2-boolean-engine.md](u2-boolean-engine.md) | U2 | A02, A04 | CI container |
| [u5a-swiftshader.md](u5a-swiftshader.md) | U5a | A05, A06 (SwiftShader) | Cloud container, SwiftShader |
| [u5b-swiftshader.md](u5b-swiftshader.md) | U5b | A05 (shifted passes) | Cloud container, SwiftShader |
| [u5c-swiftshader.md](u5c-swiftshader.md) | U5c | A05 (clip chains) | Cloud container, SwiftShader |
| [u7b-swiftshader.md](u7b-swiftshader.md) | U7b | A05, A06 (remaining fixtures) | Cloud container, SwiftShader |
| [u7b-headed-reference-pc.md](u7b-headed-reference-pc.md) | U7b | A05, A06 captures | Reference PC, headed Chrome |
| [u7c-headed-reference-pc.md](u7c-headed-reference-pc.md) | U7c | A10, A06 bench, A07 to A09, A12 | Reference PC, headed Chrome and Edge |
| [pc-1bbec13/sitting.txt](pc-1bbec13/sitting.txt) | U8 | The sitting at 1bbec13: machine, browser versions, every command and its result | Reference PC |
| [pc-1bbec13/cards/](pc-1bbec13/cards/) | U7c | A10 run records (20) | Reference PC, headed Chrome |
| [pc-1bbec13/a06/](pc-1bbec13/a06/) | U7c | A06 bench run records (120), compared with [pa-u9/eadc1d7](../pa-u9/eadc1d7/timing/runs) | Reference PC, headed Chrome |
| [pc-1bbec13/ab-e8ba618/](pc-1bbec13/ab-e8ba618/) and [ab-1bbec13/](pc-1bbec13/ab-1bbec13/) | U8 | A06: the `-v2` A/B before and after the effects wiring (30 + 30 run records) | Reference PC, headed Chrome |
| [pc-1bbec13/viz-v4/](pc-1bbec13/viz-v4/) | U8 | A06 full suite: the A08 corpus statuses regenerated for the PC kernel and the corpus run timing | Reference PC, headed Chrome and Edge |
| [laptop-1bbec13/](laptop-1bbec13/e3-u4.txt) | U8 | A06 full suite: `e3-a04-readback` in Chrome and Edge at 1bbec13 (secondary record) | Laptop, Intel iGPU, headed Chrome and Edge |
| [pc-1bbec13/gpu/](pc-1bbec13/gpu/) | U7c, U8 | A07 to A09 reports; `full-suite/` holds the E41 reports of the full GPU suite (A05 to A09, Chrome and Edge) | Reference PC, headed Chrome and Edge |

Commands:

- Unit tests: `npx vitest run tests/unit/e41-`.
- SwiftShader GPU spec: `pnpm test:e41-swiftshader`. Set `E41_CHROMIUM` and `VECTOR_STUDIO_GEOMETRY_WASM`.
- Headed GPU spec: `pnpm test:gpu -g E41`.
- Editor flows (A12): `pnpm test:e41-next-host`.
- Cards benchmark (A10): `E26_SCENARIOS=e41 pnpm test:e26 --project=chrome-dpr1 --project=chrome-dpr2`. Run `pnpm build` first and set `M8_N3_BASELINE`.
