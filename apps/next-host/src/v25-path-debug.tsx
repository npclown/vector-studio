import type { EditorSnapshot } from '@vector-studio/editor-core';
import type { NodeV7 } from '@vector-studio/model';
import { useEditorSelector } from '@vector-studio/ui';
import { useRef, useState } from 'react';

// V-25 slice 8 debugging aid (user request 2026-11-06: "show the path data in the right panel when
// a path is selected, I'll pass it on for debugging"). In the studio layout, one selected path
// shows its node as JSON (path verbs and points, frame, rotation, fill, stroke, opacity, parent)
// in a read-only box with a copy button. Host only; nothing in the editor changes.

/** The one selected path node, or null. A module-level selector, so the store is made once. */
function selectedPath(snapshot: EditorSnapshot): NodeV7 | null {
  if (snapshot.selection.length !== 1) return null;
  const node = snapshot.document.nodes[snapshot.selection[0]!];
  return node?.type === 'path' ? node : null;
}

/** The text the debug box shows for `node`: the node as stored, two-space JSON. */
export function pathDebugText(node: NodeV7): string {
  return JSON.stringify(node, null, 2);
}

export function PathDebugPanel() {
  const node = useEditorSelector(selectedPath);
  // The text last copied, so the label resets when the path or its data changes; 'failed' when
  // the clipboard refused (the text stays selected for a manual copy).
  const [copied, setCopied] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  if (node === null) return null;
  const text = pathDebugText(node);
  const failed = () => {
    area.current?.select();
    setCopied('failed');
  };
  const copy = () => {
    if (navigator.clipboard === undefined) {
      failed();
      return;
    }
    navigator.clipboard.writeText(text).then(() => setCopied(text), failed);
  };
  const label =
    copied === text ? 'copied' : copied === 'failed' ? 'copy failed: select text' : 'copy';
  return (
    <section className="vs-path-debug" data-testid="path-debug">
      <h2 className="vs-heading">
        Path data
        <button type="button" onClick={copy} data-testid="path-debug-copy">
          {label}
        </button>
      </h2>
      <textarea
        ref={area}
        readOnly
        aria-label="path data"
        data-testid="path-debug-text"
        value={text}
        rows={12}
        spellCheck={false}
        onFocus={(event) => event.currentTarget.select()}
      />
    </section>
  );
}
