import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createDifferentialCases, encodeCase } from '../geometry/differential/index.js';

// P3 V2 contract section k item 6 (P-C2): P2 output-byte identity. The
// existing P2 differential corpus runs through the P2 v1 exports of main's
// release WASM and of this branch's release WASM; every batch must return the
// same status and the same published output bytes. Run through
// `node tooling/compare-p2-wasm.mjs`, which builds main's WASM from
// `git archive` of the merge base with the pinned toolchain and flags.

interface P2Kernel {
  readonly memory: WebAssembly.Memory;
  abi_version(): number;
  reserve(inputBytes: number, outputBytes: number): number;
  input_ptr(): number;
  output_ptr(): number;
  process(inputLength: number): number;
  result_len(): number;
  required_output_bytes(): number;
  dispose(): number;
}

const OUTPUT_CAPACITY = 2;

async function load(variable: string): Promise<P2Kernel> {
  const file = process.env[variable];
  if (!file) throw new Error(`Run through node tooling/compare-p2-wasm.mjs (${variable})`);
  const { instance } = await WebAssembly.instantiate(await readFile(file), {});
  return instance.exports as unknown as P2Kernel;
}

function run(kernel: P2Kernel, input: Uint8Array): { status: number; output: Uint8Array } {
  let output = 256 * 1024;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    expect(kernel.reserve(input.length, output)).toBe(0);
    new Uint8Array(kernel.memory.buffer, kernel.input_ptr() >>> 0, input.length).set(input);
    const status = kernel.process(input.length);
    if (status === OUTPUT_CAPACITY && attempt === 0) {
      output = kernel.required_output_bytes() >>> 0;
      continue;
    }
    const length = kernel.result_len() >>> 0;
    return {
      status,
      output: new Uint8Array(kernel.memory.buffer, kernel.output_ptr() >>> 0, length).slice(),
    };
  }
  throw new Error('capacity retry did not converge');
}

describe('P2 output-byte identity against main', () => {
  it('publishes identical P2 output bytes for every differential batch', async () => {
    const main = await load('P2_MAIN_WASM_PATH');
    const branch = await load('P2_WASM_PATH');
    expect(main.abi_version()).toBe(1);
    expect(branch.abi_version()).toBe(1);
    const cases = createDifferentialCases();
    const mainDigest = createHash('sha256');
    const branchDigest = createHash('sha256');
    let bytes = 0;
    let published = 0;
    for (const testCase of cases) {
      const input = encodeCase(testCase);
      const expected = run(main, input);
      const actual = run(branch, input);
      expect(actual.status, testCase.id).toBe(expected.status);
      expect(Buffer.from(actual.output).equals(Buffer.from(expected.output)), testCase.id).toBe(
        true,
      );
      mainDigest.update(expected.output);
      branchDigest.update(actual.output);
      bytes += expected.output.length;
      if (expected.output.length > 0) published += 1;
    }
    const mainHash = mainDigest.digest('hex');
    expect(branchDigest.digest('hex')).toBe(mainHash);
    console.log(
      `P2 output-byte identity: ${String(cases.length)} batches, ${String(published)} published, ` +
        `${String(bytes)} bytes, SHA-256 ${mainHash}`,
    );
    main.dispose();
    branch.dispose();
  });
});
