// V-30 export contract (docs/plans/viz-v30-export-contract.md), sections 1 and 4: the export
// panel's choices and file names, without React.

export type ExportFormat = 'png' | 'svg';

/** V30-U1: the PNG scales the panel offers. */
export const EXPORT_SCALES = [0.5, 1, 2, 3, 4] as const;

/** A name safe as a download file name: no path or reserved characters, at most 100 units. */
export function safeFileName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F/\\:*?"<>|]/g, '_')
    .trim()
    .slice(0, 100);
  const stripped = cleaned.replace(/^\.+/, '').trim();
  return stripped === '' ? 'export' : stripped;
}

/** V30-S1 file names: `<name>.svg`, `<name>.png` at 1x, `<name>@<scale>x.png` otherwise. */
export function exportFileName(name: string, format: ExportFormat, scale: number): string {
  const base = safeFileName(name);
  if (format === 'svg') return `${base}.svg`;
  return scale === 1 ? `${base}.png` : `${base}@${scale}x.png`;
}

/**
 * V30-S1: the name of what the panel exports: the one selected node's name, `export` for
 * several, the page's name with no selection.
 */
export function exportTargetName(
  selection: readonly string[],
  nodeName: string | undefined,
  pageName: string | undefined,
): string {
  if (selection.length === 0) return pageName ?? 'page';
  if (selection.length === 1) return nodeName ?? 'export';
  return 'export';
}

/** The button text: what is exported. */
export function exportButtonLabel(selection: readonly string[], name: string): string {
  if (selection.length === 0) return `Export page ${name}`;
  if (selection.length === 1) return `Export ${name}`;
  return `Export ${selection.length} layers`;
}
