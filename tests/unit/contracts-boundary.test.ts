import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const contractsSource = path.resolve(import.meta.dirname, '../../packages/contracts/src');

async function readContractSources(): Promise<string> {
  const entries = await readdir(contractsSource, { withFileTypes: true });
  const sources = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => readFile(path.join(contractsSource, entry.name), 'utf8')),
  );
  return sources.join('\n');
}

describe('contracts architecture boundary', () => {
  it('does not import framework, browser, renderer implementation, or GPU API packages', async () => {
    const source = await readContractSources();
    const forbiddenImports = [
      /from\s+['"]react(?:\/[^'"]*)?['"]/u,
      /from\s+['"]@vector-studio\/renderer-(?:core|webgpu)['"]/u,
      /from\s+['"](?:@webgpu\/types|webgpu-types)['"]/u,
    ];

    for (const pattern of forbiddenImports) {
      expect(source).not.toMatch(pattern);
    }
  });

  it('does not expose browser or GPU runtime object types', async () => {
    const source = await readContractSources();

    expect(source).not.toMatch(/\b(?:HTMLCanvasElement|HTMLElement|GPU[A-Z][A-Za-z]+)\b/u);
  });
});
