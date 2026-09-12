// Offline evidence audit only. Never launches a browser or a capture.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
const read = (name) => readFileSync(new URL(name, import.meta.url));
const json = (name) => JSON.parse(read(name));
const digest = (data) => createHash('sha256').update(data).digest('hex');
const manifest = json('manifest.json');
for (const artifact of manifest.artifacts) {
  const bytes = read(artifact.path);
  assert.equal(bytes.length, artifact.bytes);
  assert.equal(digest(bytes), artifact.sha256);
}
for (const folder of ['prelaunch', 'chrome', 'edge']) {
  const source = json(`${folder}/source.json${folder === 'edge' ? '.txt' : ''}`);
  for (const [field, file] of [
    ['runnerSha256', 'p1-presentmon-feasibility.mjs.txt'],
    ['preflightSha256', 'p1-presentmon-preflight.ps1.txt'],
    ['elevationHelperSha256', 'p1-presentmon-elevated.ps1.txt'],
  ])
    assert.equal(digest(read(`${folder}/${file}`)), source[field]);
}
const acquisition = json('chrome/chrome-acquisition.json');
const raw = read('chrome/chrome.csv').toString('utf8').trim();
assert(!raw.includes('"'), 'This audit expects the observed unquoted CSV schema');
const [headers, ...rows] = raw.split(/\r?\n/).map((line) => line.split(','));
const field = (row, key) => row[headers.indexOf(key)];
for (const name of ['ProcessID', 'CPUStartQPC', 'TimeInQPC', 'MsUntilDisplayed'])
  assert(headers.includes(name));
for (const row of rows) {
  assert.equal(row.length, headers.length);
  assert.equal(Number(field(row, 'ProcessID')), acquisition.ownership.ProcessId);
  for (const key of ['CPUStartQPC', 'TimeInQPC'])
    assert(Number.isSafeInteger(Number(field(row, key))));
}
assert.equal(acquisition.postConsentValidated, true);
assert.equal(acquisition.elevatedResult.exitCode, 0);
assert.equal(acquisition.launcherExit.code, 0);
assert.equal(acquisition.elevatedProcessAfterCleanup, 'Absent');
const displayed = rows.filter((row) => field(row, 'MsUntilDisplayed') !== 'NA');
assert(displayed.every((row) => Number.isFinite(Number(field(row, 'MsUntilDisplayed')))));
const edge = json('edge/msedge-acquisition.json');
assert.equal(edge.elevatedResult.pid, null);
assert.equal(edge.elevatedResult.exitCode, null);
assert.match(edge.elevatedResult.error, /operation was canceled by the user/);
const markers = json('chrome/chrome-markers.json');
console.log(
  JSON.stringify(
    {
      artifactHashes: manifest.artifacts.length,
      sourceHashes: 9,
      chrome: {
        schema: 'PresentMon 2.5.1 default/non-v2; not pooled with v2',
        rows: rows.length,
        displayNumericRows: displayed.length,
        displayNARows: rows.length - displayed.length,
        swapChains: [...new Set(rows.map((row) => field(row, 'SwapChainAddress')))],
        timeInQpcFirstToLastSeconds:
          (Number(field(rows.at(-1), 'TimeInQPC')) - Number(field(rows[0], 'TimeInQPC'))) /
          json('chrome/preflight.json').qpcFrequency,
        processElapsedMs:
          Date.parse(acquisition.elevatedResult.endedUtc) -
          Date.parse(acquisition.elevatedResult.startedUtc),
        recordedFramesIncludingConsentWait: markers.frames.length,
        syntheticInputs: markers.inputs.length,
        allInputLatencyNA: rows.every((row) => field(row, 'MsAllInputToPhotonLatency') === 'NA'),
        fixtureContentToCsvRow: 'UNVERIFIED',
        browserToQpcMapping: 'UNVERIFIED',
      },
      edge: 'UAC canceled; no PresentMon process or CSV; no automatic retry',
      acceptance: 'A09/A10 UNVERIFIED; no latency percentile or performance gate',
    },
    null,
    2,
  ),
);
