import { execFile } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createCounterIdSource, createEditor, type Editor } from '@vector-studio/editor-core';
import {
  EditorCanvas,
  EditorProvider,
  useEditorSelector,
  type RendererFactory,
} from '@vector-studio/react';
import { createElement, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The repository's executable boundary policy is JavaScript tooling.
import { boundaries, evaluatePackageBoundaries } from '../../tooling/boundary-policy.mjs';

// P5-U6 (P5 editor-slice plan, section 6): the React bindings and the Next.js host page, in
// Node: P5-A11 and the seeded boundary edges of P5-A13.

const root = path.resolve(import.meta.dirname, '../..');
const run = promisify(execFile);
const policy = boundaries as ReadonlyMap<string, ReadonlySet<string>>;
const evaluate = evaluatePackageBoundaries as (input: {
  manifest: { name: string; dependencies?: Record<string, string> };
  sources: { path: string; text: string }[];
  packageRoots: Map<string, string>;
}) => string[];

function editor(): Editor {
  return createEditor({ ids: createCounterIdSource('n') });
}

describe('P5-A11 imports without browser globals', () => {
  it('imports the built model, editor-core and react packages in a clean Node process', async () => {
    const entries = ['packages/model', 'packages/editor-core', 'packages/react'].map(
      (dir) => pathToFileURL(path.join(root, dir, 'dist/index.js')).href,
    );
    const script = [
      `for (const entry of ${JSON.stringify(entries)}) await import(entry);`,
      "const globals = ['window', 'document', 'navigator'].filter((name) => name in globalThis);",
      // Node 21+ defines a navigator global of its own; only window and document are browser-only.
      "console.log(JSON.stringify(globals.filter((name) => name !== 'navigator')));",
    ].join('\n');
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script]);
    expect(JSON.parse(stdout)).toEqual([]);
  });

  it('imports and prerenders the next-host page module graph in Node', async () => {
    expect(typeof window).toBe('undefined');
    const page = path.join(root, 'apps/next-host/app/page.tsx');
    const module = (await import(page)) as { default: ComponentType };
    expect(typeof window).toBe('undefined');
    const html = renderToString(createElement(module.default));
    expect(html).toContain('<canvas');
    expect(html).toContain('data-testid="tool-select"');
  });
});

describe('P5-U6 React bindings', () => {
  it('reads the snapshot through useEditorSelector', () => {
    const target = editor();
    ok(target);
    function Revision() {
      const revision = useEditorSelector((snapshot) => snapshot.revision);
      const nodes = useEditorSelector((snapshot) => snapshot.document.pages[0].children.length);
      return createElement('span', null, `${revision}:${nodes}`);
    }
    const html = renderToString(
      createElement(EditorProvider, { editor: target }, createElement(Revision)),
    );
    expect(html).toBe('<span>1:1</span>');
  });

  it('throws outside an EditorProvider', () => {
    function Lost() {
      useEditorSelector((snapshot) => snapshot.revision);
      return null;
    }
    expect(() => renderToString(createElement(Lost))).toThrow(/EditorProvider/u);
  });

  it('renders a canvas without calling the renderer factory on the server', () => {
    let calls = 0;
    const factory: RendererFactory = () => {
      calls += 1;
      return Promise.reject(new Error('not on the server'));
    };
    const html = renderToString(
      createElement(
        EditorProvider,
        { editor: editor() },
        createElement(EditorCanvas, { width: 200, height: 100, createRenderer: factory }),
      ),
    );
    expect(html).toContain('<canvas');
    expect(calls).toBe(0);
  });
});

describe('P5-A13 boundaries of the React and Next.js packages', () => {
  it('allows react only contracts, editor-core and model', () => {
    expect([...policy.get('@vector-studio/react')!].sort()).toEqual([
      '@vector-studio/contracts',
      '@vector-studio/editor-core',
      '@vector-studio/model',
    ]);
  });

  it('rejects the seeded edge react -> renderer-webgpu, by source and by manifest', () => {
    const source = {
      path: path.join(root, 'packages/react/src/seeded.tsx'),
      text: "import { WebGpuBackend } from '@vector-studio/renderer-webgpu';\n",
    };
    expect(
      evaluate({
        manifest: {
          name: '@vector-studio/react',
          dependencies: { '@vector-studio/renderer-webgpu': 'workspace:*' },
        },
        sources: [source],
        packageRoots: new Map([['@vector-studio/react', path.join(root, 'packages/react')]]),
      }),
    ).toEqual([
      '@vector-studio/react: manifest dependency on @vector-studio/renderer-webgpu is forbidden',
      `${source.path}: source import of @vector-studio/renderer-webgpu is forbidden`,
    ]);
  });

  it('lets the next-host composition root depend on geometry-wasm and renderer-webgpu', () => {
    const allowed = policy.get('@vector-studio/next-host')!;
    expect(allowed.has('@vector-studio/geometry-wasm')).toBe(true);
    expect(allowed.has('@vector-studio/renderer-webgpu')).toBe(true);
    expect(allowed.has('@vector-studio/geometry-reference')).toBe(false);
  });
});

function ok(target: Editor) {
  const result = target.execute({
    type: 'createRectangle',
    frame: { x: 0, y: 0, width: 10, height: 10 },
  });
  if (!result.ok) throw new Error(result.code);
}
