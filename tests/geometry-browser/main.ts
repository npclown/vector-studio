import {
  createDifferentialCases,
  encodeCase,
  runPositiveControls,
  verifyCase,
  type DifferentialCase,
} from '../geometry/differential/index.js';

type Kernel = Readonly<{
  memory: WebAssembly.Memory;
  abi_version(): number;
  reserve(inputBytes: number, outputBytes: number): number;
  input_ptr(): number;
  input_capacity(): number;
  output_ptr(): number;
  output_capacity(): number;
  memory_epoch(): number;
  process(inputLength: number): number;
  result_len(): number;
  required_output_bytes(): number;
  dispose(): number;
}>;

export type BrowserDifferentialSummary = Readonly<{
  scenario: 'p2-geometry/v1';
  wasmSha256: string;
  caseCount: number;
  corpusCount: number;
  categoryCounts: Readonly<Record<string, number>>;
  successfulPaths: number;
  emittedLines: number;
  exactSizeRetries: number;
  positiveControls: Readonly<{ attempted: number; rejected: number }>;
}>;

declare global {
  interface Window {
    runP2GeometryDifferential(expectedSha256: string): Promise<BrowserDifferentialSummary>;
  }
}

const statusElement = document.querySelector<HTMLOutputElement>('#status');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function pointerRange(kernel: Kernel, pointer: number, length: number, label: string): void {
  assert(Number.isInteger(pointer) && pointer >= 0, `${label} pointer is invalid`);
  assert(pointer + length <= kernel.memory.buffer.byteLength, `${label} range exceeds memory`);
}

function caseDetail(testCase: DifferentialCase): string {
  return JSON.stringify(testCase, (_key, value: unknown) =>
    typeof value === 'number' && !Number.isFinite(value) ? String(value) : value,
  );
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function loadKernel(
  expectedSha256: string,
): Promise<Readonly<{ kernel: Kernel; hash: string }>> {
  assert(/^[0-9a-f]{64}$/i.test(expectedSha256), 'P2_WASM_SHA256 must be a 64-digit hex hash');
  const response = await fetch('/__p2/geometry.wasm', { cache: 'no-store' });
  assert(response.ok, `release WASM fetch failed with HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  const hash = await sha256(bytes);
  assert(
    hash === expectedSha256.toLowerCase(),
    `release WASM SHA-256 ${hash} != ${expectedSha256}`,
  );
  const module = await WebAssembly.compile(bytes);
  assert(
    WebAssembly.Module.imports(module).length === 0,
    'release WASM unexpectedly has host imports',
  );
  const instance = await WebAssembly.instantiate(module, {});
  const kernel = instance.exports as unknown as Kernel;
  assert(kernel.memory instanceof WebAssembly.Memory, 'release WASM memory export is missing');
  assert(kernel.abi_version() === 1, 'release WASM ABI version is not 1');
  for (const name of [
    'reserve',
    'input_ptr',
    'input_capacity',
    'output_ptr',
    'output_capacity',
    'memory_epoch',
    'process',
    'result_len',
    'required_output_bytes',
    'dispose',
  ] as const) {
    assert(typeof kernel[name] === 'function', `release WASM export ${name} is missing`);
  }
  return { kernel, hash };
}

function copyInput(kernel: Kernel, bytes: Uint8Array): void {
  const pointer = kernel.input_ptr() >>> 0;
  assert(kernel.input_capacity() >= bytes.length, 'reserved input capacity is too small');
  pointerRange(kernel, pointer, bytes.length, 'input');
  new Uint8Array(kernel.memory.buffer, pointer, bytes.length).set(bytes);
}

function processCase(
  kernel: Kernel,
  testCase: DifferentialCase,
): Readonly<{ successfulPaths: number; emittedLines: number; retried: boolean }> {
  const input = encodeCase(testCase);
  const reserveEpoch = kernel.memory_epoch() >>> 0;
  assert(kernel.reserve(input.length, 0) === 0, `${testCase.id}: input reserve failed`);
  assert(
    kernel.memory_epoch() >>> 0 === reserveEpoch + 1,
    `${testCase.id}: reserve did not advance memory epoch exactly once`,
  );
  copyInput(kernel, input);
  let beforeBuffer = kernel.memory.buffer;
  let beforeEpoch = kernel.memory_epoch() >>> 0;
  let beforeInputPointer = kernel.input_ptr() >>> 0;
  let beforeOutputPointer = kernel.output_ptr() >>> 0;
  let beforeInputCapacity = kernel.input_capacity() >>> 0;
  let beforeOutputCapacity = kernel.output_capacity() >>> 0;
  let batchStatus = kernel.process(input.length) >>> 0;
  assert(kernel.memory.buffer === beforeBuffer, `${testCase.id}: process grew or replaced memory`);
  assert(
    kernel.input_ptr() === beforeInputPointer,
    `${testCase.id}: process changed input pointer`,
  );
  assert(
    kernel.output_ptr() === beforeOutputPointer,
    `${testCase.id}: process changed output pointer`,
  );
  assert(
    kernel.input_capacity() === beforeInputCapacity,
    `${testCase.id}: process changed input capacity`,
  );
  assert(
    kernel.output_capacity() === beforeOutputCapacity,
    `${testCase.id}: process changed output capacity`,
  );
  assert(
    kernel.memory_epoch() >>> 0 === beforeEpoch + 1,
    `${testCase.id}: process did not advance memory epoch exactly once`,
  );

  let retried = false;
  if (batchStatus === 2) {
    retried = true;
    const required = kernel.required_output_bytes() >>> 0;
    assert(required > 0, `${testCase.id}: output-capacity status lacks exact required size`);
    assert(
      required > beforeOutputCapacity,
      `${testCase.id}: retry size does not exceed prior capacity`,
    );
    assert(kernel.result_len() === 0, `${testCase.id}: sizing pass published output`);
    beforeEpoch = kernel.memory_epoch() >>> 0;
    assert(
      kernel.reserve(input.length, required) === 0,
      `${testCase.id}: exact output reserve failed`,
    );
    assert(
      kernel.memory_epoch() >>> 0 === beforeEpoch + 1,
      `${testCase.id}: retry reserve did not advance memory epoch exactly once`,
    );
    copyInput(kernel, input);
    beforeBuffer = kernel.memory.buffer;
    beforeEpoch = kernel.memory_epoch() >>> 0;
    beforeInputPointer = kernel.input_ptr() >>> 0;
    beforeOutputPointer = kernel.output_ptr() >>> 0;
    beforeInputCapacity = kernel.input_capacity() >>> 0;
    beforeOutputCapacity = kernel.output_capacity() >>> 0;
    batchStatus = kernel.process(input.length) >>> 0;
    assert(kernel.memory.buffer === beforeBuffer, `${testCase.id}: retry process grew memory`);
    assert(
      kernel.input_ptr() === beforeInputPointer,
      `${testCase.id}: retry changed input pointer`,
    );
    assert(
      kernel.output_ptr() === beforeOutputPointer,
      `${testCase.id}: retry changed output pointer`,
    );
    assert(
      kernel.input_capacity() === beforeInputCapacity,
      `${testCase.id}: retry changed input capacity`,
    );
    assert(
      kernel.output_capacity() === beforeOutputCapacity,
      `${testCase.id}: retry changed output capacity`,
    );
    assert(
      kernel.memory_epoch() >>> 0 === beforeEpoch + 1,
      `${testCase.id}: retry process did not advance memory epoch exactly once`,
    );
    assert(
      batchStatus === testCase.expectedBatchStatus,
      `${testCase.id}: retry status ${batchStatus}`,
    );
    if (batchStatus === 0) {
      assert(
        kernel.result_len() === required,
        `${testCase.id}: retry did not publish exact sized output`,
      );
    }
  }

  const outputLength = kernel.result_len() >>> 0;
  let output = new Uint8Array(0);
  if (outputLength > 0) {
    const pointer = kernel.output_ptr() >>> 0;
    assert(kernel.output_capacity() >= outputLength, `${testCase.id}: output exceeds capacity`);
    pointerRange(kernel, pointer, outputLength, 'output');
    output = new Uint8Array(kernel.memory.buffer, pointer, outputLength).slice();
  }
  const verified = verifyCase(testCase, batchStatus, output);
  return {
    successfulPaths: verified.successfulPaths,
    emittedLines: verified.emittedLines,
    retried,
  };
}

window.runP2GeometryDifferential = async (expectedSha256) => {
  if (statusElement) statusElement.value = 'running';
  const { kernel, hash } = await loadKernel(expectedSha256);
  try {
    const positiveControls = runPositiveControls();
    const cases = createDifferentialCases();
    const categoryCounts: Record<string, number> = {};
    let successfulPaths = 0;
    let emittedLines = 0;
    let exactSizeRetries = 0;
    for (let index = 0; index < cases.length; index += 1) {
      const testCase = cases[index]!;
      categoryCounts[testCase.category] = (categoryCounts[testCase.category] ?? 0) + 1;
      let result: ReturnType<typeof processCase>;
      try {
        result = processCase(kernel, testCase);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${detail}\ncase=${caseDetail(testCase)}`, { cause: error });
      }
      successfulPaths += result.successfulPaths;
      emittedLines += result.emittedLines;
      if (result.retried) exactSizeRetries += 1;
      if (statusElement && index % 100 === 0) statusElement.value = `${index}/${cases.length}`;
      if (index % 50 === 49) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    assert(categoryCounts.corpus === 10_000, 'frozen corpus case count is not exactly 10,000');
    assert(exactSizeRetries > 0, 'browser run did not exercise exact output retry');
    const summary: BrowserDifferentialSummary = {
      scenario: 'p2-geometry/v1',
      wasmSha256: hash,
      caseCount: cases.length,
      corpusCount: categoryCounts.corpus,
      categoryCounts,
      successfulPaths,
      emittedLines,
      exactSizeRetries,
      positiveControls,
    };
    if (statusElement) statusElement.value = 'passed';
    return summary;
  } finally {
    const epoch = kernel.memory_epoch() >>> 0;
    assert(kernel.dispose() === 0, 'release WASM dispose failed');
    assert(kernel.memory_epoch() >>> 0 === epoch + 1, 'dispose did not advance memory epoch');
    assert(kernel.result_len() === 0, 'dispose retained a readable result');
  }
};
