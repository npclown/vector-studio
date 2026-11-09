import {
  exportPng,
  useActivePage,
  useEditor,
  useEditorSelector,
  useNode,
  usePages,
  useSelection,
} from '@vector-studio/react';
import { useState } from 'react';
import {
  EXPORT_SCALES,
  exportButtonLabel,
  exportFileName,
  exportTargetName,
  type ExportFormat,
} from './export-model.js';
import { Row } from './fields.js';

// V-30 export contract (docs/plans/viz-v30-export-contract.md), V30-U1: the Export section. It
// exports the selection, or the active page with nothing selected, as PNG at a scale or as SVG,
// and downloads the file through an object URL. It reads the editor through the public hooks
// and the `exportScene`/`exportSvg` queries only.

/** Starts a download of `blob` as `name` in the page's document. */
function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // After the click has started the download; revoking at once can cancel it in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The scale choice's option text: `0.5x`, `1x`, … */
function scaleLabel(scale: number): string {
  return `${scale}x`;
}

/**
 * The Export section (V30-U1): a format choice (PNG, SVG), a PNG scale (0.5x to 4x, disabled for
 * SVG) and a button that exports the selection, or the page when nothing is selected, as one
 * file. The button is disabled with nothing selected on an empty page; an export that draws
 * nothing (every target hidden) shows "Nothing to export".
 */
export function ExportPanel() {
  const editor = useEditor();
  const selection = useSelection();
  const activePage = useActivePage();
  const pages = usePages();
  const single = useNode(selection.length === 1 ? selection[0]! : '');
  const pageEmpty = useEditorSelector(
    (snapshot) =>
      snapshot.document.pages.find((page) => page.id === snapshot.activePage)?.children.length ===
      0,
  );
  const [format, setFormat] = useState<ExportFormat>('png');
  const [scale, setScale] = useState<number>(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const pageName = pages.find((page) => page.id === activePage)?.name;
  const name = exportTargetName(selection, single?.name, pageName);
  const label = exportButtonLabel(selection, name);
  const disabled = busy || (selection.length === 0 && pageEmpty);

  const run = async () => {
    setMessage(null);
    const ids = selection.length === 0 ? undefined : selection;
    const file = exportFileName(name, format, scale);
    setBusy(true);
    try {
      if (format === 'svg') {
        const svg = editor.query(
          ids === undefined ? { type: 'exportSvg' } : { type: 'exportSvg', ids },
        );
        if (svg === null) {
          setMessage('Nothing to export');
          return;
        }
        download(new Blob([svg], { type: 'image/svg+xml' }), file);
      } else {
        const blob = await exportPng(editor, ids === undefined ? { scale } : { ids, scale });
        if (blob === null) {
          setMessage('Nothing to export');
          return;
        }
        download(blob, file);
      }
    } catch (error) {
      setMessage(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="vs-export" data-testid="export-panel">
      <legend>Export</legend>
      <Row>
        <select
          aria-label="Export format"
          value={format}
          onChange={(event) => setFormat(event.currentTarget.value as ExportFormat)}
        >
          <option value="png">PNG</option>
          <option value="svg">SVG</option>
        </select>
        <select
          aria-label="Export scale"
          value={String(scale)}
          disabled={format === 'svg'}
          onChange={(event) => setScale(Number(event.currentTarget.value))}
        >
          {EXPORT_SCALES.map((value) => (
            <option key={value} value={String(value)}>
              {scaleLabel(value)}
            </option>
          ))}
        </select>
      </Row>
      <button
        type="button"
        data-testid="export-button"
        disabled={disabled}
        onClick={() => void run()}
        title={exportFileName(name, format, scale)}
      >
        {label}
      </button>
      {message !== null && (
        <span role="status" data-testid="export-message">
          {message}
        </span>
      )}
    </fieldset>
  );
}
