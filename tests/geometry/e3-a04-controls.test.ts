// D9 E3 unit E3-U3: the rejecting positive controls and negative controls of contract section 8.1
// that the harness owns (E3-A5), run through the whole harness path on hand-made meshes and
// synthetic ports. No kernel output is read, so they are allowed before the corpus freeze
// (section 5.5). E3-PC12 belongs to the GPU model check of E3-U4.
import { describe, expect, it } from 'vitest';

import { CONTROL_IDS, admittedChords, chordDeviation, runControls } from './e3-a04/controls.js';

describe('E3-A5: positive and negative controls through the harness', () => {
  for (const id of CONTROL_IDS.filter((x) => x !== 'E3-PC12')) {
    it(`${id} meets its expectation`, () => {
      const [outcome] = runControls([id]);
      expect(outcome!.detail).toBeTruthy();
      expect(outcome).toMatchObject({ id, ok: true });
    }, 900_000);
  }
  it('E3-PC12 is owned by E3-U4: the harness reports it as not run, never as met', () => {
    const [outcome] = runControls(['E3-PC12']);
    expect(outcome).toMatchObject({ id: 'E3-PC12', ok: false, observed: 'NOT RUN' });
  });
  it('a control that throws is reported as not met, not skipped', () => {
    const [outcome] = runControls(['E3-PC99']);
    expect(outcome).toMatchObject({ ok: false, observed: 'ERROR' });
  });
});

describe('E3-PC3: the chord count that the e + 3 tolerance admits', () => {
  it('is 4 chords per cubic for the S-curve row, with a deviation between 0.3 and 1 px', () => {
    // T0, zoom 1, DPR 1: e = -3, so the admitted tolerance 2^(e + 3) is 1 px.
    const m = admittedChords(1);
    expect(m).toBe(4);
    const deviation = chordDeviation(
      [
        [0, 0],
        [4, 8],
        [8, -8],
        [12, 0],
      ],
      m,
    );
    expect(deviation).toBeGreaterThan(0.3);
    expect(deviation).toBeLessThanOrEqual(1);
    // One chord fewer would exceed the tolerance.
    expect(
      chordDeviation(
        [
          [0, 0],
          [4, 8],
          [8, -8],
          [12, 0],
        ],
        m - 1,
      ),
    ).toBeGreaterThan(1);
  });
});
