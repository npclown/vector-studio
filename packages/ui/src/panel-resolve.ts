import type { ExtensionSummary } from '@vector-studio/react';
import type { ComponentType } from 'react';

// MVP M8 contract, section 6 (M8-P1, M8-P2): the UI-side panel contributions of host-registered
// extensions and the pure function that checks them against the `extensions` query.

/**
 * One panel an extension contributes (MVP M8 contract, section 6). The component receives no
 * props: it reads and writes through the hooks this package re-exports (M8-P4).
 */
export type PanelContribution = Readonly<{
  /** The panel ID: the extension's ID, or it plus a dot and more (M8-P2). */
  id: string;
  /** The panel's heading and accessible name. */
  title: string;
  /**
   * The panel body; rendered without props inside its own `PanelBoundary` (M8-P3). It must keep
   * a stable identity: define it at module level, not inside the host's render, where each
   * render makes a new component that remounts the panel and re-reports every panel error.
   */
  component: ComponentType;
}>;

/**
 * The UI half of an extension (MVP M8 contract, section 6, M8-Q4 (a)): the panels the host
 * passes to `PanelProvider`. The editor half, the `Extension` with node types, commands, tools
 * and bindings, is registered with `createEditor` as before; `extension` names its ID.
 */
export type UiExtension = Readonly<{
  /** The ID of the editor extension that owns the panels; it must be registered. */
  extension: string;
  /** The extension's panels, in display order. */
  panels: readonly PanelContribution[];
}>;

/**
 * Why a panel was not rendered or stopped rendering (MVP M8 contract, M8-P2 and M8-P3):
 * `ui.unknown-extension` (the owning extension is not in the `extensions` query),
 * `ui.unowned-panel` (the panel ID is not the extension's ID or under it), `ui.duplicate-panel`
 * (an earlier panel already renders with that ID) and `ui.panel-failed` (the panel threw while
 * rendering and its `PanelBoundary` shows the failed notice).
 */
export type PanelErrorCode =
  'ui.unknown-extension' | 'ui.unowned-panel' | 'ui.duplicate-panel' | 'ui.panel-failed';

/** One panel error, as `usePanelErrors` lists it and `onPanelError` receives it (M8-P1). */
export type PanelError = Readonly<{
  /** What went wrong. */
  code: PanelErrorCode;
  /** The ID of the panel it concerns. */
  panel: string;
}>;

/** A panel `resolvePanels` accepted, with the extension that contributed it. */
export type ResolvedPanel = Readonly<{
  /** The ID of the owning extension. */
  extension: string;
  /** The accepted contribution. */
  panel: PanelContribution;
}>;

/** What `resolvePanels` returns: the panels to render and the rejected ones' errors. */
export type PanelResolution = Readonly<{
  /** The accepted panels, in contribution order. */
  panels: readonly ResolvedPanel[];
  /** One error per rejected panel, in contribution order. */
  errors: readonly PanelError[];
}>;

/** Whether `panel` is `extension` or starts with it and a dot, as P5 command IDs are owned. */
function owns(extension: string, panel: string): boolean {
  return panel === extension || panel.startsWith(`${extension}.`);
}

/**
 * Checks panel contributions against the registered extensions (MVP M8 contract, M8-P2). Each
 * panel, in contribution order, is rejected with one error, the first that applies:
 * `ui.unknown-extension` when its `extension` is not in `extensions`, `ui.unowned-panel` when its
 * ID is not owned by that extension, `ui.duplicate-panel` when an earlier accepted panel has the
 * same ID. Every other panel is accepted. Pure: the result depends on the arguments alone.
 *
 * @param contributions The host's UI extensions, in display order.
 * @param extensions The editor's `extensions` query result.
 */
export function resolvePanels(
  contributions: readonly UiExtension[],
  extensions: readonly ExtensionSummary[],
): PanelResolution {
  const registered = new Set(extensions.map((summary) => summary.id));
  const accepted = new Set<string>();
  const panels: ResolvedPanel[] = [];
  const errors: PanelError[] = [];
  for (const { extension, panels: contributed } of contributions) {
    for (const panel of contributed) {
      const code: PanelErrorCode | null = !registered.has(extension)
        ? 'ui.unknown-extension'
        : !owns(extension, panel.id)
          ? 'ui.unowned-panel'
          : accepted.has(panel.id)
            ? 'ui.duplicate-panel'
            : null;
      if (code === null) {
        accepted.add(panel.id);
        panels.push({ extension, panel });
      } else {
        errors.push({ code, panel: panel.id });
      }
    }
  }
  return { panels, errors };
}

/** Whether two error lists hold the same errors in the same order. */
export function panelErrorsEqual(a: readonly PanelError[], b: readonly PanelError[]): boolean {
  return (
    a.length === b.length &&
    a.every((error, index) => error.code === b[index]!.code && error.panel === b[index]!.panel)
  );
}
