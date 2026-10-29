// D9 E11 unit E11-U4: the P3 path mesh failure behavior (docs/plans/d9-e11-u4-failure-behavior-
// addendum.md, section 6). E11-U4-A1: no interim code remains; E11-U4-A2: every failure code has
// exactly one outcome and the requirements name it; E11-U4-A5: the pointer lines exist. Drawing
// outcomes are checked by the existing V3, V4, ST-U6 and ST-U7 tests (E11-U4-A3).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { DIAGNOSTIC_CODES } from '../../packages/contracts/src/diagnostics.js';
import type { PathMeshFailureCode } from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import { isPathNotice, PATH_NOTICE_CODE } from '../../apps/playground/src/path-notices.js';
import { NOTICE_CODE } from '../../apps/playground/src/viz-v1-appearance-state.js';

const OUTCOME: Record<PathMeshFailureCode, 'O1' | 'O2' | 'O3'> = {
  'invalid-path': 'O1',
  'invalid-tolerance': 'O1',
  'invalid-stroke': 'O1',
  'numeric-range': 'O1',
  'work-limit': 'O1',
  'unsupported-geometry': 'O1',
  'internal-error': 'O1',
  'resource-limit': 'O1',
  'invalid-request': 'O1',
  disposed: 'O1',
  'tolerance-range': 'O1',
  'fringe-range': 'O1',
  'fringe-unsupported': 'O1',
  'packing-range': 'O1',
  'invalid-response': 'O1',
  'invalid-mesh': 'O1',
  'port-version': 'O1',
  'mesh-pipeline-unavailable': 'O1',
  'dash-limit': 'O1',
  'fringe-work-cap': 'O2',
  'overlay-unsupported': 'O3',
};

const root = path.resolve(import.meta.dirname, '..', '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(root, dir))) {
    // `.next` is the Next.js host's build output (P5-U6), not source.
    if (name === 'node_modules' || name === 'dist' || name === '.next') continue;
    const rel = path.join(dir, name);
    if (statSync(path.join(root, rel)).isDirectory()) out.push(...files(rel));
    else if (/\.(ts|mts|js|mjs|json|txt|html)$/u.test(name)) out.push(rel);
  }
  return out;
}

describe('E11-U4', () => {
  it('A1: no interim code remains outside the builder placement notes', () => {
    const self = path.join('tests', 'unit', 'e11-u4-failure-behavior.test.ts');
    const trees = [
      ...readdirSync(path.join(root, 'packages')).map((p) => path.join('packages', p, 'src')),
      'apps',
      'tests',
    ];
    const code = /path-mesh-interim-failure|PATH_MESH_INTERIM_FAILURE|interim: 'd8'/iu;
    const label = /d8[- ]interim/iu;
    // The fringe and overlay builders keep their D8-interim placement label (addendum section 5
    // item 3): exactly these lines, by file and text.
    const allowed = new Map<string, string>([
      [
        'packages/renderer-core/src/primitive-renderer-service.ts',
        'a D8-interim placement (V3-Q3 c)',
      ],
      ['packages/renderer-core/src/path-joint-overlay.ts', '// D8-interim placement (ST7-Q2 a)'],
      ['packages/renderer-core/src/path-fringe.ts', '// D8-interim placement (V3-Q3 c)'],
      ['apps/playground/src/p3-v4-paths.ts', 'fringe builder (a D8-interim placement)'],
    ]);
    const hits: string[] = [];
    for (const tree of trees) {
      let list: string[];
      try {
        list = files(tree);
      } catch {
        continue;
      }
      for (const file of list) {
        if (file === self) continue;
        const posix = file.split(path.sep).join('/');
        read(file)
          .split('\n')
          .forEach((line, i) => {
            const allowedText = allowed.get(posix);
            const allowedLabel = allowedText !== undefined && line.includes(allowedText);
            if (code.test(line) || (label.test(line) && !allowedLabel))
              hits.push(`${posix}:${i + 1}`);
          });
      }
    }
    expect(hits).toEqual([]);
  });

  it('A2: every failure code has one outcome, named under it in the requirements', () => {
    const text = read('docs/requirements.md');
    const section = text.slice(
      text.indexOf('## Path rendering failures'),
      text.indexOf('## Platform and performance'),
    );
    const bullets = Object.fromEntries(
      (['O1', 'O2', 'O3'] as const).map((o) => [
        o,
        section.split('\n').find((line) => line.startsWith(`- **${o},`)) ?? '',
      ]),
    );
    for (const [code, outcome] of Object.entries(OUTCOME)) {
      expect(bullets[outcome], code).toContain(`\`${code}\``);
      for (const other of ['O1', 'O2', 'O3'].filter((o) => o !== outcome))
        expect(bullets[other], code).not.toContain(`\`${code}\``);
    }
    expect(section).toContain(`\`${DIAGNOSTIC_CODES.PATH_MESH_FAILURE}\``);
  });

  it('A5: the pointer lines exist', () => {
    const pointers: Record<string, string[]> = {
      'docs/plans/p3-private-contract.md': ['U2', 'U4', 'D8 interim pointer'],
      'docs/plans/p3-v1-path-scene-port-proposal.md': ['section h'],
      'docs/plans/p3-v3-renderer-mesh-pipeline-contract.md': [
        'section h',
        'section m',
        'V4 amendment',
      ],
      'docs/plans/p3-b2-st-u7-joint-coverage-addendum.md': ['section 4.6, ST7-R10'],
      'docs/plans/p3-b2-stroke-contract.md': ['section 9.8'],
      'docs/graphics-engine-architecture.md': ['fringe cache identity'],
      'docs/plans/viz-v1-path-appearance-contract.md': ['section 3.4'],
      'docs/plans/viz-v3-a07-integration-contract.md': ['VZ3-A3, VZ3-A15'],
    };
    for (const [file, sections] of Object.entries(pointers))
      for (const section of sections)
        expect(read(file), `${file} ${section}`).toContain(
          `E11-U4 pointer (${section}), 2026-10-24:`,
        );
  });

  it('the playground pages filter on the product code', () => {
    expect(PATH_NOTICE_CODE).toBe('render.path-mesh-failure');
    expect(NOTICE_CODE).toBe(DIAGNOSTIC_CODES.PATH_MESH_FAILURE);
    expect(isPathNotice({ code: DIAGNOSTIC_CODES.PATH_MESH_FAILURE })).toBe(true);
    expect(isPathNotice({ code: 'render.path-mesh-interim-failure' })).toBe(false);
    for (const page of ['viz-v3-integration', 'p3-b2-strokes', 'p3-v4-paths'])
      expect(read(`apps/playground/src/${page}.ts`), page).toContain('isPathNotice');
  });
});
