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
| [u7c-headed-reference-pc.md](u7c-headed-reference-pc.md) | U7c | A10, A06 bench, A07 to A09 | Reference PC, headed Chrome |

Commands:

- Unit tests: `npx vitest run tests/unit/e41-`.
- SwiftShader GPU spec: `pnpm test:e41-swiftshader`. Set `E41_CHROMIUM` and `VECTOR_STUDIO_GEOMETRY_WASM`.
- Headed GPU spec: `pnpm test:gpu -g E41`.
- Editor flows (A12): `pnpm test:e41-next-host`.
- Cards benchmark (A10): `E26_SCENARIOS=e41 pnpm test:e26 --project=chrome-dpr1 --project=chrome-dpr2`. Run `pnpm build` first and set `M8_N3_BASELINE`.
