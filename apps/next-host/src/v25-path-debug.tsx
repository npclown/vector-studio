import type { EditorSnapshot } from '@vector-studio/editor-core';
import type { NodeV6 } from '@vector-studio/model';
import { useEditorSelector } from '@vector-studio/ui';
import { useState } from 'react';

// V-25 slice 8 debugging aid (user request 2026-11-06: "show the path data in the right panel when
// a path is selected, I'll pass it on for debugging"). In the studio layout, one selected path
// shows its node as JSON (path verbs and points, frame, rotation, fill, stroke, opacity, parent)
// in a read-only box with a copy button. Host only; nothing in the editor changes.

/** The one selected path node, or null. A module-level selector, so the store is made once. */
function selectedPath(snapshot: EditorSnapshot): NodeV6 | null {
  if (snapshot.selection.length !== 1) return null;
  const node = snapshot.document.nodes[snapshot.selection[0]!];
  return node?.type === 'path' ? node : null;
}

/** The text the debug box shows for `node`: the node as stored, two-space JSON. */
export function pathDebugText(node: NodeV6): string {
  return JSON.stringify(node, null, 2);
}

export function PathDebugPanel() {
  const node = useEditorSelector(selectedPath);
  const [copied, setCopied] = useState(false);
  if (node === null) return null;
  const text = pathDebugText(node);
  const copy = () => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };
  return (
    <section className="vs-path-debug" data-testid="path-debug">
      <h2 className="vs-heading">
        Path data
        <button type="button" onClick={copy} data-testid="path-debug-copy">
          {copied ? 'copied' : 'copy'}
        </button>
      </h2>
      <textarea
        readOnly
        data-testid="path-debug-text"
        value={text}
        rows={12}
        spellCheck={false}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={() => setCopied(false)}
      />
    </section>
  );
}
