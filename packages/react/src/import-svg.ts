import {
  isSvgText,
  svgToFragment,
  type CommandResult,
  type Editor,
  type PagePoint,
} from '@vector-studio/editor-core';

// V-33 SVG import contract (docs/plans/viz-v33-svg-import-contract.md), V33-P3 and V33-U1: files
// dropped on the canvas or chosen in the Import panel, each read as text and pasted (V33-P1).

/** A file as the import reads it: the DOM `File` fits. */
export type SvgFileLike = Readonly<{ name: string; type: string; text(): Promise<string> }>;

/** The outcome of one file of `importSvgFiles`. */
export type SvgFileImport = Readonly<{
  name: string;
  result: CommandResult;
  /** What V33-C1 dropped from the file (element and property names), empty on a failure. */
  skipped: readonly string[];
}>;

/** Options of `importSvgFiles`. */
export type ImportSvgFilesOptions = Readonly<{
  /** The page point the first file centres on; omitted, the viewport centre. */
  at?: PagePoint;
}>;

/** The page-unit step between files of one import (V33-P3). */
export const SVG_FILE_OFFSET = 16;

/** Whether `file` is an SVG file: its type is `image/svg+xml` or its name ends in `.svg`. */
export function isSvgFile(file: Readonly<{ name: string; type: string }>): boolean {
  return file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
}

/**
 * Imports the SVG files of `files` (others are ignored) in order (V33-P3, U1): each is read as
 * text and pasted, the first centred on `at` (else the viewport centre), each later one 16 page
 * units further down and right, one undo step per file. Text edit mode is exited first. Before
 * each later file the selection found before the first is restored, so every file goes to the
 * same paste target; a failed file is reported and the rest continue. Resolves to one outcome
 * per SVG file.
 */
export async function importSvgFiles(
  editor: Editor,
  files: ArrayLike<SvgFileLike>,
  options: ImportSvgFilesOptions = {},
): Promise<SvgFileImport[]> {
  const chosen = Array.from(files).filter(isSvgFile);
  if (chosen.length === 0) return [];
  const texts = await Promise.all(
    chosen.map((file) =>
      file.text().then(
        (text) => text,
        () => null,
      ),
    ),
  );
  if (editor.getSnapshot().textEdit !== null) editor.execute({ type: 'exitTextEdit' });
  const selection = editor.getSnapshot().selection;
  const base = options.at ?? viewportCentre(editor);
  const out: SvgFileImport[] = [];
  chosen.forEach((file, index) => {
    const text = texts[index];
    if (index > 0) editor.execute({ type: 'setSelection', ids: selection });
    if (text === null || text === undefined || !isSvgText(text)) {
      out.push({ name: file.name, result: { ok: false, code: 'editor.invalid-svg' }, skipped: [] });
      return;
    }
    const step = index * SVG_FILE_OFFSET;
    const at = base === null ? undefined : { x: base.x + step, y: base.y + step };
    const result = editor.execute(
      at === undefined ? { type: 'paste', text } : { type: 'paste', text, at },
    );
    const converted = result.ok ? svgToFragment(text) : null;
    out.push({
      name: file.name,
      result,
      skipped: converted !== null && converted.ok ? converted.skipped : [],
    });
  });
  // The last successful import stays selected.
  const last = [...out].reverse().find((entry) => entry.result.ok);
  if (last !== undefined && last.result.ok) {
    editor.execute({ type: 'setSelection', ids: last.result.ids });
  }
  return out;
}

function viewportCentre(editor: Editor): PagePoint | null {
  const { viewport, viewportSize } = editor.getSnapshot();
  if (viewportSize === null) return null;
  return {
    x: viewport.position.x + viewportSize.width / (2 * viewport.zoom),
    y: viewport.position.y + viewportSize.height / (2 * viewport.zoom),
  };
}
