import { createHash } from 'node:crypto';
import type {
  P2Capture,
  P2ProfileName,
  P2SessionCounters,
  P2VariantSample,
  P2WorkCounter,
} from '../geometry-benchmark/types.js';

const workKeys = [
  'logicalCubics',
  'sizingVisits',
  'emissionVisits',
  'emittedCubicLines',
  'attemptedPaths',
  'failedPaths',
] as const;
const variants = ['batch', 'per-path'] as const;
const hashPattern = /^[a-f0-9]{64}$/;

export function p2Hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function p2Profile(name: P2ProfileName) {
  return {
    name,
    warmupPairs: name === 'reference' ? 10 : 1,
    measuredPairs: name === 'reference' ? 30 : 2,
    repetitions: name === 'reference' ? 5 : 1,
  };
}

export function nearestRank(values: readonly number[], quantile: number): number | null {
  if (
    !values.length ||
    values.some((value) => !Number.isFinite(value)) ||
    quantile <= 0 ||
    quantile > 1
  )
    return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * quantile) - 1] ?? null;
}

function distribution(values: readonly number[]) {
  return {
    count: values.length,
    median: nearestRank(values, 0.5),
    p95: nearestRank(values, 0.95),
    p99: nearestRank(values, 0.99),
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
  };
}

export interface P2Analysis {
  disposition: 'FUNCTIONAL_PASS' | 'FUNCTIONAL_FAIL' | 'PASS' | 'FAIL' | 'UNVERIFIED';
  findings: string[];
  unverified: string[];
  batch: ReturnType<typeof distribution>;
  perPath: ReturnType<typeof distribution>;
  medianPairedSpeedup: number | null;
}

export interface P2RawRecord {
  schema: string;
  project: string;
  browserVersion: string;
  launchFlags: string[];
  profile: P2ProfileName;
  repetition: number;
  recordedAt: string;
  instrumentation: { headed: boolean; tracing: boolean; video: boolean; devtools: boolean };
  sourceSha256: string;
  buildSha256: string;
  wasmSha256: string;
  configurationSha256: string | null;
  capture: P2Capture | null;
  error: string | null;
}

export function aggregateP2Records(
  records: readonly unknown[],
  identity: {
    profile: P2ProfileName;
    sourceSha256: string;
    buildSha256: string;
    wasmSha256: string;
    integrityFindings: readonly string[];
  },
) {
  const findings = [...identity.integrityFindings];
  const expected = p2Profile(identity.profile);
  const seen = new Set<string>();
  const versions = new Map<string, string>();
  const repetitions: Array<{ project: string; repetition: number; analysis: P2Analysis }> = [];
  for (const value of records) {
    try {
      const record = value as P2RawRecord;
      const id = `${record.project}/${record.repetition}`;
      if (
        !['chrome', 'edge'].includes(record.project) ||
        !Number.isInteger(record.repetition) ||
        record.repetition < 1 ||
        record.repetition > expected.repetitions ||
        seen.has(id)
      ) {
        findings.push(`Invalid/duplicate repetition: ${id}`);
        continue;
      }
      seen.add(id);
      if (
        record.schema !== 'p2-record/v1' ||
        record.profile !== identity.profile ||
        record.sourceSha256 !== identity.sourceSha256 ||
        record.buildSha256 !== identity.buildSha256 ||
        record.wasmSha256 !== identity.wasmSha256
      )
        findings.push(`${id}: incompatible record identity.`);
      if (
        typeof record.browserVersion !== 'string' ||
        !record.browserVersion ||
        !Number.isFinite(Date.parse(record.recordedAt))
      )
        findings.push(`${id}: missing browser/time provenance.`);
      if (versions.has(record.project) && versions.get(record.project) !== record.browserVersion)
        findings.push(`${id}: browser version changed.`);
      versions.set(record.project, record.browserVersion);
      const modes = record.instrumentation;
      if (
        modes.headed !== (identity.profile === 'reference') ||
        modes.tracing ||
        modes.video ||
        modes.devtools ||
        !record.launchFlags.length ||
        record.launchFlags.some((flag) => typeof flag !== 'string')
      )
        findings.push(`${id}: incompatible instrumentation.`);
      if (
        identity.profile === 'reference' &&
        record.launchFlags.some(
          (flag) => flag.startsWith('--headless') || flag === '--auto-open-devtools-for-tabs',
        )
      )
        findings.push(`${id}: reference browser was headless or opened DevTools.`);
      if (record.error !== null) findings.push(`${id}: ${String(record.error)}`);
      if (
        record.capture === null ||
        record.configurationSha256 !==
          p2Hash({
            configuration: record.capture.configuration,
            profile: record.capture.profile,
            viewport: record.capture.environment.viewport,
          })
      )
        findings.push(`${id}: configuration hash differs.`);
      const analysis = analyzeP2Capture(
        record.capture,
        identity.profile,
        record.repetition,
        identity.wasmSha256,
      );
      repetitions.push({ project: record.project, repetition: record.repetition, analysis });
    } catch (error) {
      findings.push(`Malformed repetition record: ${String(error)}`);
    }
  }
  for (const project of ['chrome', 'edge']) {
    for (let repetition = 1; repetition <= expected.repetitions; repetition++) {
      if (!seen.has(`${project}/${repetition}`))
        findings.push(`Missing repetition: ${project}/${repetition}`);
    }
  }
  const invalid =
    findings.length > 0 || repetitions.some(({ analysis }) => analysis.findings.length > 0);
  const unverified = repetitions.some(({ analysis }) => analysis.unverified.length > 0);
  const disposition =
    identity.profile === 'functional'
      ? invalid
        ? 'FUNCTIONAL_FAIL'
        : 'FUNCTIONAL_PASS'
      : invalid || unverified
        ? 'UNVERIFIED'
        : repetitions.some(({ analysis }) => analysis.disposition === 'FAIL')
          ? 'FAIL'
          : 'PASS';
  const speedups = repetitions.flatMap(({ analysis }) =>
    analysis.medianPairedSpeedup === null ? [] : [analysis.medianPairedSpeedup],
  );
  return {
    schema: 'p2-aggregate/v1',
    profile: identity.profile,
    disposition,
    acceptance: 'Requires Primary review; not full P2/P1 acceptance',
    performanceDisposition: identity.profile === 'functional' ? 'NOT_APPLICABLE' : disposition,
    findings,
    worstMedianPairedSpeedup: speedups.length ? Math.min(...speedups) : null,
    repetitions,
  };
}

export function analyzeP2Capture(
  value: unknown,
  profile: P2ProfileName,
  repetition: number,
  wasmSha256: string,
): P2Analysis {
  const findings: string[] = [];
  const unverified: string[] = [];
  const batchTimes: number[] = [];
  const perPathTimes: number[] = [];
  const ratios: number[] = [];
  const require = (condition: unknown, message: string) => {
    if (!condition) findings.push(message);
  };
  const finite = (value: number) => typeof value === 'number' && Number.isFinite(value);
  const uint = (value: number) => Number.isSafeInteger(value) && value >= 0;
  const bigint = (value: string) => {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))
      throw new Error('Malformed u64 work counter');
    const parsed = BigInt(value);
    if (parsed > 0xffff_ffff_ffff_ffffn) throw new Error('Work counter exceeds u64');
    return parsed;
  };
  const sameWork = (a: P2WorkCounter, b: P2WorkCounter) =>
    workKeys.every((key) => bigint(a[key]) === bigint(b[key]));
  const cacheEmpty = (state: P2SessionCounters) =>
    [
      state.hits,
      state.misses,
      state.kernelPathBuilds,
      state.evictions,
      state.retainedPayloadBytes,
      state.liveLinearMemoryBytes,
      state.residentNodes,
      state.variantEntries,
    ].every(uint) &&
    state.evictions === 0 &&
    state.hits === 0 &&
    state.retainedPayloadBytes === 0 &&
    state.residentNodes === 0 &&
    state.variantEntries === 0;
  try {
    const capture = value as P2Capture;
    const expected = p2Profile(profile);
    require(capture.schema === 'p2-geometry-benchmark/v1', 'Capture schema differs.');
    require(capture.profile.name === expected.name &&
      capture.profile.warmupPairs === expected.warmupPairs &&
      capture.profile.measuredPairs === expected.measuredPairs &&
      capture.profile.repetitions ===
        expected.repetitions, 'Profile differs from frozen schedule.');
    require(capture.repetition === repetition &&
      Number.isInteger(repetition) &&
      repetition >= 1 &&
      repetition <= expected.repetitions, 'Repetition identity differs.');
    require(hashPattern.test(wasmSha256) &&
      capture.wasmSha256 === wasmSha256, 'WASM identity differs.');
    const config = capture.configuration;
    require(String(config.scenario) === 'p2-batch/v1' &&
      config.seed === 0x12345678 &&
      config.paths === 1000 &&
      config.cubicsPerPath === 32, 'Workload differs from frozen scenario.');
    require(config.cache.maxNodes === 0 &&
      config.cache.maxVariants === 0 &&
      config.cache.maxPayloadBytes === 0, 'Caches are not disabled.');
    require(config.inputPathCount === 1000 &&
      config.inputCubicCount === 32000 &&
      config.localTolerance === 0.25 &&
      config.zoom === 1 &&
      config.devicePixelRatio === 1 &&
      p2Hash(config.world) ===
        p2Hash([1, 0, 0, 1]), 'Coordinate/tolerance or input count configuration differs.');
    require(capture.errors.length === 0, `Capture errors: ${capture.errors.join('; ')}`);
    const viewport = capture.environment.viewport;
    require(viewport.width === 1280 &&
      viewport.height === 720 &&
      viewport.devicePixelRatio === 1, 'Unexpected viewport/DPR.');
    const windowState = capture.environment.window;
    require(windowState.innerWidth === viewport.width &&
      windowState.innerHeight === viewport.height &&
      finite(windowState.outerWidth) &&
      windowState.outerWidth > 0 &&
      finite(windowState.outerHeight) &&
      windowState.outerHeight > 0 &&
      finite(windowState.screenX) &&
      finite(windowState.screenY), 'Incomplete window metadata.');
    const screenState = capture.environment.screen;
    require([
      screenState.width,
      screenState.height,
      screenState.availWidth,
      screenState.availHeight,
      screenState.colorDepth,
      screenState.pixelDepth,
    ].every((value) => finite(value) && value > 0), 'Incomplete screen metadata.');
    const navigatorState = capture.environment.navigator;
    require([navigatorState.userAgent, navigatorState.platform, navigatorState.language].every(
      (value) => typeof value === 'string' && value.length > 0,
    ) &&
      navigatorState.languages.length > 0 &&
      navigatorState.languages.every((value) => typeof value === 'string' && value.length > 0) &&
      (navigatorState.hardwareConcurrency === null ||
        (uint(navigatorState.hardwareConcurrency) && navigatorState.hardwareConcurrency > 0)) &&
      (navigatorState.deviceMemoryGiB === null ||
        (finite(navigatorState.deviceMemoryGiB) &&
          navigatorState.deviceMemoryGiB > 0)), 'Incomplete navigator metadata.');
    require(capture.environment.visibilityStart === 'visible' &&
      capture.environment.visibilityEnd === 'visible' &&
      capture.environment.visibilityEvents.every(
        (event) => event.state === 'visible',
      ), 'Document was hidden.');
    const increments = capture.environment.clockProbe.positiveIncrementsMs;
    const validClock =
      increments.length >= 16 &&
      increments.every((increment) => finite(increment) && increment > 0);
    const quantum = capture.environment.clockProbe.minimumQuantumMs;
    const resolutionKnown =
      validClock && quantum !== null && finite(quantum) && quantum === Math.min(...increments);
    if (!resolutionKnown) unverified.push('Clock resolution is unavailable or inconsistent.');
    if (profile === 'functional') require(resolutionKnown, 'Missing/invalid clock observation.');
    require(finite(capture.setup.fetchMs) &&
      capture.setup.fetchMs >= 0 &&
      finite(capture.setup.compileMs) &&
      capture.setup.compileMs >= 0, 'Invalid fetch/compile duration.');
    for (const variant of variants) {
      require(capture.disposeStatuses[variant].length === 1 &&
        capture.disposeStatuses[variant][0] ===
          0, `${variant}: raw disposal was not acknowledged exactly once.`);
      require(finite(capture.setup.instantiationMs[variant]) &&
        capture.setup.instantiationMs[variant] >= 0 &&
        finite(capture.setup.preparationReserveMs[variant]) &&
        capture.setup.preparationReserveMs[variant] >= 0, `Invalid ${variant} setup duration.`);
      require(uint(capture.setup.preparedInputCapacity[variant]) &&
        capture.setup.preparedInputCapacity[variant] > 0 &&
        capture.setup.preparedInputCapacity[variant] <= 64 * 1024 * 1024 &&
        uint(capture.setup.preparedOutputCapacity[variant]) &&
        capture.setup.preparedOutputCapacity[variant] > 0 &&
        capture.setup.preparedOutputCapacity[variant] <=
          256 * 1024 * 1024, `Invalid ${variant} arena capacity.`);
      require(cacheEmpty(capture.cleanup[variant]) &&
        capture.cleanup[variant].liveLinearMemoryBytes ===
          0, `${variant} resources remain after disposal.`);
    }
    const phases = [
      { phase: 'preparation', count: 1 },
      { phase: 'warmup', count: expected.warmupPairs },
      { phase: 'measured', count: expected.measuredPairs },
    ] as const;
    require(capture.samples.length ===
      1 + expected.warmupPairs + expected.measuredPairs, 'Incomplete or extra sample pairs.');
    let cursor = 0;
    let previousEnd = -Infinity;
    const previous: Partial<Record<(typeof variants)[number], P2SessionCounters>> = {};
    const checksum = capture.setup.preparationChecksums.batch;
    require(typeof checksum === 'string' &&
      /^[a-f0-9]{16}$/.test(checksum) &&
      checksum ===
        capture.setup.preparationChecksums[
          'per-path'
        ], 'Preparation checksums differ or are malformed.');
    const inspect = (
      sample: P2VariantSample,
      variant: (typeof variants)[number],
      preparation: boolean,
    ) => {
      const prefix = `${cursor}/${variant}`;
      const calls = variant === 'batch' ? 1 : 1000;
      require(sample.variant === variant, `${prefix}: variant differs.`);
      const time = sample.timing;
      require(finite(time.startMs) &&
        finite(time.endMs) &&
        finite(time.durationMs) &&
        time.durationMs > 0 &&
        time.endMs - time.startMs === time.durationMs, `${prefix}: invalid timing.`);
      require(time.startMs >= previousEnd, `${prefix}: time/order overlap.`);
      previousEnd = time.endMs;
      require(sample.errors.length === 0, `${prefix}: sample errors ${sample.errors.join('; ')}.`);
      require(sample.batchStatuses.length === calls &&
        sample.batchStatuses.every(
          (status) => status === 'OK',
        ), `${prefix}: incorrect adapter calls/status.`);
      require(sample.checksum === checksum &&
        sample.resultCount === 1000, `${prefix}: missing or unequal geometry.`);
      require(sample.pathStatuses.OK === 1000 &&
        Object.keys(sample.pathStatuses).length ===
          1, `${prefix}: non-OK or missing path results.`);
      require(sample.calls.disposeStatuses.length === 0 &&
        uint(sample.calls.growths), `${prefix}: invalid lifetime observation.`);
      require(sample.calls.reserveStatuses.every((status) => status === 0) &&
        sample.calls.processStatuses.every(
          (status) => status === 0 || (preparation && status === 2),
        ), `${prefix}: failed kernel call.`);
      require(sample.calls.processStatuses.filter((status) => status === 0).length ===
        calls, `${prefix}: incorrect emission pass count.`);
      require(sample.calls.sizingPasses === sample.calls.processStatuses.length &&
        sample.calls.emissionPasses ===
          calls, `${prefix}: pass counters disagree with process statuses.`);
      if (!preparation) {
        require(sample.calls.reserveStatuses.length === 0 &&
          sample.calls.growths === 0 &&
          sample.calls.processStatuses.length ===
            calls, `${prefix}: reserve/growth/retry in steady sample.`);
        require(sample.statisticsBefore.liveLinearMemoryBytes ===
          sample.statisticsAfter.liveLinearMemoryBytes, `${prefix}: linear memory changed.`);
      }
      if (preparation) {
        const retries = sample.calls.processStatuses.filter((status) => status === 2).length;
        require(retries <= calls &&
          sample.calls.reserveStatuses.length === retries + 1 &&
          sample.calls.processStatuses.every(
            (status, index, statuses) => status !== 2 || statuses[index + 1] === 0,
          ), `${prefix}: preparation violates single exact retry/capacity reserve semantics.`);
      }
      const before = sample.statisticsBefore;
      const after = sample.statisticsAfter;
      require(cacheEmpty(before) &&
        cacheEmpty(after), `${prefix}: cached geometry was used or retained.`);
      require(uint(before.liveLinearMemoryBytes) &&
        uint(after.liveLinearMemoryBytes) &&
        after.liveLinearMemoryBytes > 0, `${prefix}: invalid memory counter.`);
      if (previous[variant])
        require(p2Hash(previous[variant]) ===
          p2Hash(before), `${prefix}: counter history is discontinuous.`);
      previous[variant] = after;
      require(after.misses - before.misses === 1000 &&
        after.hits - before.hits === 0, `${prefix}: input path/cache counts differ.`);
      require(after.kernelPathBuilds - before.kernelPathBuilds ===
        sample.calls.processStatuses.length *
          (variant === 'batch' ? 1000 : 1), `${prefix}: process/path counts differ.`);
      for (const key of workKeys)
        require(bigint(after.kernelWork[key]) - bigint(before.kernelWork[key]) ===
          bigint(sample.work[key]), `${prefix}: ${key} differs from raw counter delta.`);
      const work = sample.work;
      const attempted =
        BigInt(sample.calls.processStatuses.length) * (variant === 'batch' ? 1000n : 1n);
      require(bigint(work.logicalCubics) === attempted * 32n &&
        bigint(work.attemptedPaths) === attempted &&
        bigint(work.failedPaths) === 0n, `${prefix}: logical workload differs.`);
      require(bigint(work.emissionVisits) > 0n &&
        bigint(work.sizingVisits) >= bigint(work.emissionVisits) &&
        bigint(work.emittedCubicLines) > 0n, `${prefix}: missing subdivision work.`);
      if (!preparation)
        require(bigint(work.sizingVisits) ===
          bigint(work.emissionVisits), `${prefix}: unequal sizing/emission work.`);
      require(uint(sample.copiedPayloadBytes) &&
        uint(sample.peakRetainedPayloadBytes) &&
        sample.peakRetainedPayloadBytes > 0 &&
        sample.peakRetainedPayloadBytes <=
          sample.copiedPayloadBytes, `${prefix}: invalid output payload accounting.`);
      require(BigInt(sample.copiedPayloadBytes) ===
        29n *
          (bigint(work.emittedCubicLines) +
            1000n), `${prefix}: copied output payload differs from emitted geometry.`);
      require(variant === 'batch'
        ? sample.peakRetainedPayloadBytes === sample.copiedPayloadBytes
        : sample.peakRetainedPayloadBytes <
            sample.copiedPayloadBytes, `${prefix}: retained output scope differs.`);
    };
    for (const { phase, count } of phases) {
      for (let index = 0; index < count; index++) {
        const pair = capture.samples[cursor];
        if (!pair) throw new Error(`Missing ${phase} pair ${index}`);
        require(pair.phase === phase &&
          pair.pairIndex === index, `Unexpected phase or index at ${cursor}.`);
        const order = (repetition - 1 + index) % 2 === 0 ? 'AB' : 'BA';
        require(pair.order === order &&
          pair.errors.length === 0, `Pair ${cursor} order/errors differ.`);
        const ordered = order === 'AB' ? [pair.batch, pair.perPath] : [pair.perPath, pair.batch];
        inspect(ordered[0]!, order === 'AB' ? 'batch' : 'per-path', phase === 'preparation');
        inspect(ordered[1]!, order === 'AB' ? 'per-path' : 'batch', phase === 'preparation');
        require(pair.batch.copiedPayloadBytes ===
          pair.perPath.copiedPayloadBytes, `Pair ${cursor} output byte totals differ.`);
        if (phase !== 'preparation')
          require(sameWork(
            pair.batch.work,
            pair.perPath.work,
          ), `Pair ${cursor} kernel work differs.`);
        if (phase === 'measured') {
          batchTimes.push(pair.batch.timing.durationMs);
          perPathTimes.push(pair.perPath.timing.durationMs);
          ratios.push(pair.perPath.timing.durationMs / pair.batch.timing.durationMs);
          if (
            resolutionKnown &&
            quantum !== null &&
            Math.min(pair.batch.timing.durationMs, pair.perPath.timing.durationMs) < 100 * quantum
          )
            unverified.push(`Pair ${index} is shorter than 100 observed clock quanta.`);
        }
        cursor++;
      }
    }
    for (const variant of variants) {
      const last = previous[variant];
      require(last !== undefined &&
        (['hits', 'misses', 'kernelPathBuilds', 'evictions'] as const).every(
          (key) => last[key] === capture.cleanup[variant][key],
        ), `${variant}: cumulative counters changed during disposal.`);
      require(last !== undefined &&
        sameWork(
          last.kernelWork,
          capture.cleanup[variant].kernelWork,
        ), `${variant}: work changed after final sample.`);
    }
  } catch (error) {
    findings.push(`Malformed/incomplete capture: ${String(error)}`);
  }
  const batch = distribution(batchTimes);
  const perPath = distribution(perPathTimes);
  const medianPairedSpeedup = nearestRank(ratios, 0.5);
  let disposition: P2Analysis['disposition'];
  if (profile === 'functional')
    disposition = findings.length ? 'FUNCTIONAL_FAIL' : 'FUNCTIONAL_PASS';
  else if (findings.length || unverified.length) disposition = 'UNVERIFIED';
  else
    disposition =
      medianPairedSpeedup !== null &&
      medianPairedSpeedup >= 1.2 &&
      batch.p95 !== null &&
      perPath.p95 !== null &&
      batch.p95 <= perPath.p95
        ? 'PASS'
        : 'FAIL';
  return { disposition, findings, unverified, batch, perPath, medianPairedSpeedup };
}
