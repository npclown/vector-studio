import { describe, expect, it } from 'vitest';
import { diffArgs, geometryFree, needsGeometry } from '../../tooling/ci-geometry-scope.mjs';

// CI scope (2026-11-06): the geometry jobs are skipped only when every changed file is on the
// geometry-free allow-list.

describe('CI geometry scope', () => {
  it('skips the geometry jobs for an editor UI change', () => {
    expect(
      needsGeometry([
        'apps/next-host/app/page.tsx',
        'apps/next-host/src/v25-text-box.ts',
        'packages/ui/src/property-panel.tsx',
        'packages/react/src/canvas.tsx',
        'tests/unit/v25-text-box.test.ts',
        'tests/m8-next-host/m8-next-host.spec.ts',
        'docs/plans/viz-v25-editor-ui-plan.md',
        'docs/plans/mvp-m8-host-api-ui-contract.md',
        'docs/plans/d9-visualization-track.md',
        'docs/host-api.md',
      ]),
    ).toBe(false);
  });

  it('runs them for anything the geometry suites read, or an unknown path', () => {
    for (const file of [
      'packages/editor-core/src/projector.ts',
      'packages/model/src/types.ts',
      'packages/contracts/src/geometry.ts',
      'packages/renderer-core/src/index.ts',
      'packages/text-dom/src/text-dom.ts',
      'apps/playground/src/scene-paint.ts',
      'tests/support/line-fill-sources.ts',
      'tests/geometry/stroke-oracle.test.ts',
      'docs/plans/d9-e3-b4-precision-contract.md',
      'docs/evidence/e8-u2-2026-10-24.md',
      'tooling/test-geometry.mjs',
      '.github/workflows/validate.yml',
      'package.json',
      'pnpm-lock.yaml',
      'tsconfig.json',
      'tsconfig.base.json',
      'apps/next-host/package.json',
      'packages/ui/package.json',
      'docs/plans/viz-v25-editor-ui-plan.md.bak',
    ]) {
      expect(geometryFree(file), file).toBe(false);
    }
    expect(needsGeometry(['apps/next-host/app/page.tsx', 'tsconfig.base.json'])).toBe(true);
    expect(needsGeometry([])).toBe(true);
  });

  it('lists both paths of a move (review r1 B1)', () => {
    expect(diffArgs('b', 'h')).toEqual(['diff', '--name-only', '--no-renames', 'b...h']);
    // A geometry contract moved onto the list still counts its old path.
    expect(
      needsGeometry([
        'docs/plans/p3-native-projection-readiness.md',
        'docs/plans/viz-native-projection-readiness.md',
      ]),
    ).toBe(true);
  });
});
