import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from '@playwright/test';

// PA-U5 (pre-alpha gate plan, PA-A06; P1 A10): one bounded, correlated physical-presentation
// attempt on `e26-pointer-busy-10k/v2`, with the PresentMon route of P1.0m. Test-only: the
// pinned PresentMon 2.5.1 binary (test-results/p1-tools, ignored) is elevated through
// tooling/p1-presentmon-elevated.ps1, which the user approves once at the UAC prompt; the
// browser and this runner stay unprivileged. No runtime dependency.
//
// What this module records, and its limits (the record states them again):
// - the GPU process the capture targets (one GPU process of this browser, its parent checked);
// - the helper's start and result records and the CSV (25 s, `--qpc_time --v2_metrics`);
// - clock pairs between the page's `performance.now()` and QPC, each read bracketed by Node's
//   monotonic clock, before the press and after the settle. The page-to-QPC offset is taken
//   from the pair with the smallest bracket, and its uncertainty is half of each bracket.
// No frame or content identity joins a CSV row to an input (P1.0m method assessment, J2), so
// any pointer-to-present number derived from these records is a bound under stated
// assumptions (tooling/pa-u5-presentmon-correlate.mjs), never a validated measurement.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** The output directory, a new child of test-results; unset means no capture. */
export const presentMonDirectory = process.env.E26_PRESENTMON;
/**
 * UAC consent wait limit: 90 s (P1.0m's Edge prompt expired after about 122 s). The run's test
 * timeout leaves room for it (e26-harness.spec.ts).
 */
const CONSENT_TIMEOUT_MS = 90_000;
/** A QPC read that takes longer than this fails the sync instead of hanging the test. */
const READ_TIMEOUT_MS = 5_000;
const CLOCK_PAIRS = 20;

export type Channel = 'chrome' | 'msedge';

export type ClockPair = Readonly<{
  /** Node monotonic midpoint of the page read, ms. */
  pageNodeMs: number;
  pageMs: number;
  pageBracketMs: number;
  qpcNodeMs: number;
  qpc: string;
  qpcBracketMs: number;
}>;

export type ClockSync = Readonly<{
  frequency: number;
  pairs: readonly ClockPair[];
  /** QPC ms minus page ms at the best brackets; page ms + offset = QPC ms. */
  offsetMs: number;
  uncertaintyMs: number;
}>;

export type PresentMonCapture = Readonly<{
  channel: Channel;
  directory: string;
  browserPid: number;
  gpuPid: number;
  startRecord: unknown;
  helper: ChildProcessWithoutNullStreams;
  completion: Promise<{ code: number | null; signal: string | null }>;
  stdout: () => string;
  stderr: () => string;
}>;

/** PowerShell 5.1 may write a byte order mark before the JSON. */
function readJson(file: string): unknown {
  const text = readFileSync(file, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
}

const nowMs = () => Number(process.hrtime.bigint()) / 1e6;

/** Starts the elevated capture on the browser's one GPU process and waits for consent. */
export async function startPresentMon(
  browser: Browser,
  channel: Channel,
): Promise<PresentMonCapture> {
  if (presentMonDirectory === undefined) throw new Error('E26_PRESENTMON is not set.');
  if (process.platform !== 'win32') throw new Error('PresentMon runs on Windows only.');
  const directory = path.resolve(root, presentMonDirectory);
  const allowed = path.join(root, 'test-results') + path.sep;
  if (!directory.startsWith(allowed))
    throw new Error('E26_PRESENTMON must be inside test-results.');
  if (existsSync(directory)) throw new Error('E26_PRESENTMON must name a new directory.');
  mkdirSync(directory);
  const cdp = await browser.newBrowserCDPSession();
  const processes = (
    (await cdp.send('SystemInfo.getProcessInfo')) as {
      processInfo: { type: string; id: number }[];
    }
  ).processInfo;
  const browserProcess = processes.find((entry) => entry.type === 'browser');
  const gpus = processes.filter((entry) => entry.type === 'GPU');
  if (browserProcess === undefined || gpus.length !== 1)
    throw new Error('Cannot isolate one GPU process of this browser.');
  const gpuPid = gpus[0]!.id;
  const parent = Number(
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${gpuPid}').ParentProcessId`,
      ],
      { encoding: 'utf8', windowsHide: true },
    ).trim(),
  );
  if (parent !== browserProcess.id) throw new Error("The GPU process is not this browser's.");
  const helper = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-File',
      path.join(root, 'tooling/p1-presentmon-elevated.ps1'),
      '-TargetProcessId',
      String(gpuPid),
      '-OutputDirectory',
      directory,
      '-Channel',
      channel,
    ],
    { windowsHide: true },
  );
  let stdout = '';
  let stderr = '';
  helper.stdout.on('data', (chunk) => (stdout += String(chunk)));
  helper.stderr.on('data', (chunk) => (stderr += String(chunk)));
  const completion = once(helper, 'close').then(
    ([code, signal]) => ({ code: code as number | null, signal: signal as string | null }),
    (error: unknown) => ({ code: null, signal: String(error) }),
  );
  let closed = false;
  void completion.then(() => (closed = true));
  const startFile = path.join(directory, `${channel}-elevated-start.json`);
  const waitStart = nowMs();
  const resultFile = path.join(directory, `${channel}-elevated-result.json`);
  while (!existsSync(startFile)) {
    if (closed) {
      // UAC cancelled or a launch error: the helper writes the reason to its result record.
      const reason = existsSync(resultFile) ? JSON.stringify(readJson(resultFile)) : stderr;
      throw new Error(`The helper ended before the capture started: ${reason}`);
    }
    if (nowMs() - waitStart > CONSENT_TIMEOUT_MS) {
      // Ending the launcher does not withdraw a prompt already shown: if it is approved later,
      // PresentMon still runs at most 25 s (`--timed 25 --terminate_after_timed`). The operator
      // is told to cancel the prompt.
      helper.kill();
      throw new Error(
        'UAC consent timed out after 90 s: cancel the UAC prompt if it is still open.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const startRecord = readJson(startFile);
  return {
    channel,
    directory,
    browserPid: browserProcess.id,
    gpuPid,
    startRecord,
    helper,
    completion,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

/** Clock pairs between the page and QPC (module comment); one QPC reader per call. */
export async function clockSync(page: Page): Promise<ClockSync> {
  const reader = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      '[Console]::Out.WriteLine([Diagnostics.Stopwatch]::Frequency); ' +
        'while (($line = [Console]::In.ReadLine()) -ne $null) ' +
        '{ [Console]::Out.WriteLine([Diagnostics.Stopwatch]::GetTimestamp()) }',
    ],
    { windowsHide: true },
  );
  const lines: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  let buffer = '';
  reader.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      const waiter = waiters.shift();
      if (waiter === undefined) lines.push(line);
      else waiter(line);
    }
  });
  let failure: string | null = null;
  reader.on('error', (error) => (failure = String(error)));
  reader.on('close', (code) => (failure ??= `QPC reader exited with ${String(code)}`));
  const next = () =>
    new Promise<string>((resolve, reject) => {
      const line = lines.shift();
      if (line !== undefined) return resolve(line);
      if (failure !== null) return reject(new Error(failure));
      // A timed-out waiter stays queued; harmless, because the sync then throws and ends.
      const timer = setTimeout(
        () => reject(new Error(failure ?? 'QPC reader did not answer within 5 s.')),
        READ_TIMEOUT_MS,
      );
      waiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  try {
    const frequency = Number(await next());
    if (!Number.isFinite(frequency) || frequency <= 0) throw new Error('No QPC frequency.');
    const pairs: ClockPair[] = [];
    for (let index = 0; index < CLOCK_PAIRS; index += 1) {
      const pageBefore = nowMs();
      const pageMs = await page.evaluate(() => performance.now());
      const pageAfter = nowMs();
      const qpcBefore = nowMs();
      reader.stdin.write('\n');
      const qpc = await next();
      const qpcAfter = nowMs();
      pairs.push({
        pageNodeMs: (pageBefore + pageAfter) / 2,
        pageMs,
        pageBracketMs: pageAfter - pageBefore,
        qpcNodeMs: (qpcBefore + qpcAfter) / 2,
        qpc,
        qpcBracketMs: qpcAfter - qpcBefore,
      });
    }
    const bestPage = pairs.reduce((a, b) => (b.pageBracketMs < a.pageBracketMs ? b : a));
    const bestQpc = pairs.reduce((a, b) => (b.qpcBracketMs < a.qpcBracketMs ? b : a));
    // Node ms = page ms + (pageNodeMs - pageMs); Node ms = QPC ms + (qpcNodeMs - QPC ms).
    const qpcMs = (Number(BigInt(bestQpc.qpc)) / frequency) * 1000;
    const offsetMs = bestPage.pageNodeMs - bestPage.pageMs - (bestQpc.qpcNodeMs - qpcMs);
    return {
      frequency,
      pairs,
      offsetMs,
      uncertaintyMs: bestPage.pageBracketMs / 2 + bestQpc.qpcBracketMs / 2,
    };
  } finally {
    reader.stdin.end();
    reader.kill();
  }
}

/**
 * A capture whose test failed before `finishPresentMon` (afterEach): the launcher is left to
 * finish its 25 s capture and write its result record (PresentMon also ends with the browser,
 * `--terminate_on_proc_exit`), and the record directory stays for the operator to keep.
 */
export async function abandonPresentMon(capture: PresentMonCapture): Promise<void> {
  await capture.completion;
}

/** Waits for the timed capture to end and lists what the helper wrote. */
export async function finishPresentMon(capture: PresentMonCapture) {
  const exit = await capture.completion;
  const resultFile = path.join(capture.directory, `${capture.channel}-elevated-result.json`);
  return {
    channel: capture.channel,
    directory: path.relative(root, capture.directory),
    browserPid: capture.browserPid,
    gpuPid: capture.gpuPid,
    startRecord: capture.startRecord,
    helperExit: exit,
    helperStdout: capture.stdout(),
    helperStderr: capture.stderr(),
    result: existsSync(resultFile) ? readJson(resultFile) : null,
    files: readdirSync(capture.directory).sort(),
  };
}
