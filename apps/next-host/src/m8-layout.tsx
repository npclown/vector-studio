import {
  AppearancePanel,
  EditorPanels,
  LayerTree,
  PropertyPanel,
  type UiExtension,
} from '@vector-studio/ui';
import { starUiExtension } from './m8-star-panel';
import { faultPanelsQuery, testUiPanels } from './m8-test-panels';

// MVP M8 contract, M8-N1, M8-N3 and M8-N5 (M8-U6): the right side of next-host's canvas row.
//
// - Without `?bench=1`, the right column: `LayerTree` (240 px, its list scrolling), then the
//   property panel (the Appearance section directly under the tree, without its own size or
//   scroller, then the transform, layer, line, constraint, text and symbol sections), then the
//   extension panels. The column has the canvas row's height with `overflow-y: auto`, so it is
//   the only scroller: focusing a control in it scrolls the column, never the window, and the
//   page is no taller than at 17a2b0a. Its width is the 17a2b0a aside's: the same 300 px flex
//   basis, shrinking as the aside shrank (when a classic window scrollbar narrows the viewport,
//   or beside the wider bench canvas), so the layout is no wider than at 17a2b0a in any config;
//   the specs compare it with the aside width measured per config, not with 300.
// - With `?bench=1`, exactly the 17a2b0a aside: `AppearancePanel` with its default `'aside'`
//   layout (300 px, `maxHeight` 640, its own scroller) and none of the M8 sections or panels,
//   so the E26, E30 and M9 measurements see the 17a2b0a component set (M8-N5).

/** The 17a2b0a Appearance aside's width, the right column's flex basis (it shrinks alike). */
export const ASIDE_BASIS = 300;

/** The right column's style for a canvas row of `height` CSS px (M8-N3). */
export function rightColumnStyle(height: number) {
  return {
    width: ASIDE_BASIS,
    flexShrink: 1,
    minWidth: 0,
    height,
    overflowY: 'auto',
    boxSizing: 'border-box',
  } as const;
}

/**
 * The UI extensions the page passes to `PanelProvider` (M8-P1, M8-N2): none with `?bench=1`;
 * else the `ext.star` panel, plus the `test.ui` fault panels with `?test=1&faults=1` only.
 */
export function hostContributions(search: string, bench: boolean): readonly UiExtension[] {
  if (bench) return [];
  return faultPanelsQuery(search) ? [starUiExtension, testUiPanels] : [starUiExtension];
}

/** The right side of the canvas row (M8-N3, M8-N5); `height` is the canvas row's height. */
export function CanvasSide({ bench, height }: Readonly<{ bench: boolean; height: number }>) {
  if (bench) return <AppearancePanel />;
  return (
    <div data-testid="right-column" style={rightColumnStyle(height)}>
      <LayerTree />
      <PropertyPanel />
      <EditorPanels />
    </div>
  );
}
