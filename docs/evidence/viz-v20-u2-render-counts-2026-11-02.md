# V20-U2 right-column render counts (2026-11-02)

The [V20-U1 counting spec](viz-v20-u1-render-counts-2026-11-02.md), run again after levers L1 to L3 of the [V-20 contract](../plans/viz-v20-right-column-contract.md#3-levers). It has the same method and environment: headless Chromium 153 in the cloud container, with the renderer in its error state. It now also asserts V20-A01 and A02, and the browser half of A03 and A04 runs on the stress document. Counts only, no timing claim.

- Code: `994601c`, a clean tree. The next-host build was made from the same product code before the commit.
- Result: `pnpm test:v20-count` 5/5 PASS.

| Scenario (v2)                | Steps        | Layer rows | Mounted (U1) | Rows in view | `layers` | `layer-row` | `properties` | `appearance` | `panels` |
| ---------------------------- | ------------ | ---------- | ------------ | ------------ | -------- | ----------- | ------------ | ------------ | -------- |
| `e26-simple-stress-10k/v2`   | camera, 30   | 10,000     | 19 (10,000)  | 12           | 0        | 0           | 0            | 0            | 0        |
| `e26-mixed-all-pan-10k/v2`   | camera, 30   | 655        | 24 (655)     | 12           | 0        | 0           | 0            | 0            | 0        |
| `e26-mixed-view-edit-10k/v2` | drag, 1+30+1 | 655        | 24 (655)     | 12           | 1        | at most 5   | 0            | 1            | 0        |

The values are the most renders on any step after the first. "Rows in view" is the list's height over the row height, plus one. A02's bound is that number plus 16, which is 28 here.

- V20-A01 (stress v2 camera path): `layers`, `properties` and `panels` render 0 times per step. They rendered once per step at U1.
- V20-A02: at most 24 rows are mounted on both v2 documents, and at most 5 row components render per drag step. Both are within the bound of 28. At U1, all 655 or 10,000 rows were mounted and rendered on every step.
- During the drag, the tree and the appearance section still render once per step, because the document changes on each step. The rows whose nodes did not change are reused.

Records: [`viz-v20-u2/`](viz-v20-u2/), one JSON file per scenario.
