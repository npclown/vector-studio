import { importSvgFiles, useEditor } from '@vector-studio/react';
import { useRef, useState } from 'react';
import { importMessages } from './import-model.js';

// V-33 SVG import contract (docs/plans/viz-v33-svg-import-contract.md), V33-U1: the Import
// section. Its button opens a file chooser; each chosen SVG file is pasted at the viewport
// centre as editable nodes through the public `paste` command (`importSvgFiles`).

/**
 * The Import section (V33-U1): an `Import SVG…` button opening a file chooser for `.svg` files
 * (several allowed), imported centred on the viewport, with a status line per V33-U1.
 */
export function ImportPanel() {
  const editor = useEditor();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<readonly string[]>([]);

  const run = async (files: FileList | null) => {
    if (files === null || files.length === 0) return;
    setBusy(true);
    try {
      setMessages(importMessages(await importSvgFiles(editor, files)));
    } catch (error) {
      setMessages([`Import failed: ${error instanceof Error ? error.message : String(error)}`]);
    } finally {
      setBusy(false);
      // The same file can be chosen again.
      if (input.current !== null) input.current.value = '';
    }
  };

  return (
    <fieldset className="vs-import" data-testid="import-panel">
      <legend>Import</legend>
      <input
        ref={input}
        type="file"
        accept=".svg,image/svg+xml"
        multiple
        hidden
        data-testid="import-file"
        onChange={(event) => void run(event.currentTarget.files)}
      />
      <button
        type="button"
        data-testid="import-button"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        Import SVG…
      </button>
      {messages.map((line) => (
        <span key={line} role="status" data-testid="import-message">
          {line}
        </span>
      ))}
    </fieldset>
  );
}
