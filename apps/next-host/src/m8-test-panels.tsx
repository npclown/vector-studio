import type { Extension } from '@vector-studio/editor-core';
import type { UiExtension } from '@vector-studio/ui';
import { useState } from 'react';

// MVP M8 contract, M8-N2 (M8-U6) for M8-A14: the fault panels, registered only with
// `?test=1&faults=1`, which only the M8 headed spec loads. The editor extension `test.ui` owns
// two contributions: `test.ui.throws`, whose button makes its next render throw (its
// `PanelBoundary` then shows `ui.panel-failed`), and `other.unowned`, whose ID is not under
// `test.ui`, so `resolvePanels` rejects it with `ui.unowned-panel`. Plain `?test=1` registers
// neither, keeping every earlier spec's composition.

/** True for `?test=1&faults=1` only. */
export function faultPanelsQuery(search: string): boolean {
  const query = new URLSearchParams(search);
  return query.get('test') === '1' && query.get('faults') === '1';
}

/** The editor half: an extension with nothing but its ID, so the `extensions` query lists it. */
export const testUiExtension: Extension = Object.freeze({ id: 'test.ui' });

/** A panel that renders a button; once pressed, its next render throws. */
export function ThrowingPanel() {
  const [armed, setArmed] = useState(false);
  if (armed) throw new Error('test.ui.throws: thrown on purpose (M8-A14)');
  return (
    <button type="button" onClick={() => setArmed(true)}>
      Throw
    </button>
  );
}

/** The unowned panel's body; it is never rendered. */
export function UnownedPanel() {
  return <p>unowned</p>;
}

/** The UI half: one throwing panel and one unowned panel. */
export const testUiPanels: UiExtension = Object.freeze({
  extension: 'test.ui',
  panels: Object.freeze([
    Object.freeze({ id: 'test.ui.throws', title: 'Throwing panel', component: ThrowingPanel }),
    Object.freeze({ id: 'other.unowned', title: 'Unowned panel', component: UnownedPanel }),
  ]),
});
