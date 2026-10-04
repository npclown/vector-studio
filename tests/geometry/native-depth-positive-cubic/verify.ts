import { actualPackedMixedSegments, expectedOwners } from '../native-mixed-cubic/verify.js';
import type { NativeMixedCubicRow } from '../native-mixed-cubic/native.js';
import { assertTriangleFreeCompositionCarrier } from '../native-triangle-free-cubic/verify.js';
import type { NativeDepthPositiveCubicFixtureRow } from './fixtures.js';

const EXACT_POLYGON_AREA_UNITS = 483n * (1n << 2144n);
const EXACT_MESH_TWICE_AREA = 121n * (1n << 2147n) - (1n << 2099n);

export function assertNativeDepthPositiveCubicCarrier(
  fixture: NativeDepthPositiveCubicFixtureRow,
  actual: NativeMixedCubicRow,
): void {
  const guard = 1152 * Number.EPSILON;
  assertTriangleFreeCompositionCarrier(
    fixture,
    actual,
    {
      topology: { leaves: 8, pairs: 28 },
      logicalCubics: 1,
      visits: 3,
      emittedLines: 2,
      oldMixedPairs: 13,
      oldTransversePairs: 11,
      flatBounds: [-3 - guard, -10, 3 + guard, 1],
      exactPolygonAreaUnits: EXACT_POLYGON_AREA_UNITS,
      exactMeshTwiceArea: EXACT_MESH_TWICE_AREA,
    },
    () => {
      const commands = actual.carrier.commands;
      if (!commands) throw new Error('depth-positive commands missing');
      const packed = actualPackedMixedSegments(fixture, commands, fixture.expectedLeafPartitions);
      return { packed, owners: expectedOwners(fixture, packed) };
    },
  );
}
