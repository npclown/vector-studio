import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { headedWorkers } from '../../tooling/headed-run.mjs';
import { NEXT_HOST_SUITES, parse, stages } from '../../tooling/run-headed-tier.mjs';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('headedWorkers', () => {
  it('defaults to one worker', () => {
    vi.stubEnv('VS_HEADED_WORKERS', '');
    expect(headedWorkers()).toBe(1);
  });
  it('reads VS_HEADED_WORKERS', () => {
    vi.stubEnv('VS_HEADED_WORKERS', '3');
    expect(headedWorkers()).toBe(3);
  });
  it('keeps a serial suite at one worker', () => {
    vi.stubEnv('VS_HEADED_WORKERS', '3');
    expect(headedWorkers({ serial: true })).toBe(1);
  });
  it.each(['0', '-1', '2.5', 'x'])('rejects %j', (value) => {
    vi.stubEnv('VS_HEADED_WORKERS', value);
    expect(() => headedWorkers()).toThrow(/positive integer/u);
  });
});

describe('run-headed-tier', () => {
  it('parses the tier, workers and Playwright arguments', () => {
    expect(parse(['--tier', '2'])).toEqual({ tier: 2, workers: '1', extra: [] });
    expect(parse(['--tier', '3', '--workers', '4', '--', '--project', 'chrome'])).toEqual({
      tier: 3,
      workers: '4',
      extra: ['--project', 'chrome'],
    });
    expect(() => parse([])).toThrow(/Usage/u);
    expect(() => parse(['--tier', '1'])).toThrow(/Usage/u);
    expect(() => parse(['--tier', '2', '--workers', '0'])).toThrow(/Usage/u);
  });
  it('runs the corpus only at tier 3, first', () => {
    expect(stages(2).map((stage) => stage.script)[0]).toBe('test:gpu');
    expect(
      stages(3)
        .map((stage) => stage.script)
        .slice(0, 2),
    ).toEqual(['test:gpu:viz-v4', 'test:gpu']);
  });
  it('names every next-host suite of package.json', () => {
    const scripts = Object.keys(
      (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> })
        .scripts,
    );
    const suites = scripts
      .filter((name) => /^test:(p5|m\d+[a-z]?)-next-host$/u.test(name))
      .map((name) => name.slice('test:'.length, -'-next-host'.length));
    expect([...NEXT_HOST_SUITES].sort()).toEqual(suites.sort());
  });
});
