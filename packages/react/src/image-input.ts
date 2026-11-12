import type { CommandResult, Editor, PagePoint } from '@vector-studio/editor-core';
import { imageAssetFromBlob, type ImageBlobLike } from './image-header.js';

// V-32 contract (docs/plans/viz-v32-image-contract.md), V32-H2 and H3: image files pasted,
// dropped or chosen in a file picker become rectangles with the image as their fill
// (`insertImages`). The header read and the hash are asynchronous (V32-E1), so the command runs
// after them; a file that cannot be an asset is skipped and reported as the notice
// `editor.image-unsupported-file`.

/** The code of the notice for skipped files (V32-H2). */
export const IMAGE_UNSUPPORTED_FILE_CODE = 'editor.image-unsupported-file';

/** The code of the notice for files whose `insertImages` was refused (for example the table cap). */
export const IMAGE_PLACE_FAILED_CODE = 'editor.image-place-failed';

/**
 * The notice raised when files were skipped (`editor.image-unsupported-file`) or when placing
 * them was refused (`editor.image-place-failed`, with the command's refusal code as `reason`):
 * the file names, in the order they came.
 */
export type ImageNotice = Readonly<{
  code: typeof IMAGE_UNSUPPORTED_FILE_CODE | typeof IMAGE_PLACE_FAILED_CODE;
  files: readonly string[];
  reason?: string;
}>;

/** A file as the placement reads it: the DOM `File` fits. */
export type ImageFileLike = Readonly<{ name: string; type: string }> & ImageBlobLike;

/** The file types the picker offers and a paste or drop takes (V32-M1). */
export const IMAGE_FILE_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

/** The most files one `insertImages` places (V32-E2); further files are skipped. */
export const IMAGE_PLACE_LIMIT = 32;

/**
 * Whether `file` is a raster image file V-32 takes: a PNG, JPEG, WebP or GIF by its type or, with
 * no type, by its name. An SVG file is not one (V-33 imports it).
 */
export function isImageFile(file: Readonly<{ name: string; type: string }>): boolean {
  if (IMAGE_FILE_TYPES.includes(file.type) || file.type === 'image/jpg') return true;
  return (
    (file.type === '' || file.type === 'application/octet-stream') &&
    /\.(png|jpe?g|gif|webp)$/iu.test(file.name)
  );
}

const listeners = new WeakMap<Editor, Set<(notice: ImageNotice) => void>>();

/**
 * Calls `listener` with each `editor.image-unsupported-file` notice raised for `editor` by a
 * paste, drop or picker of this package; returns the unsubscribe function. The notice is not an
 * editor event: the editor never sees the files.
 */
export function subscribeImageNotices(
  editor: Editor,
  listener: (notice: ImageNotice) => void,
): () => void {
  let set = listeners.get(editor);
  if (set === undefined) {
    set = new Set();
    listeners.set(editor, set);
  }
  set.add(listener);
  return () => {
    listeners.get(editor)?.delete(listener);
  };
}

/** Raises the V32-H2 notice for `files` (names) to the subscribers of `editor`. */
export function raiseImageNotice(editor: Editor, files: readonly string[], failure?: string): void {
  if (files.length === 0) return;
  const notice: ImageNotice =
    failure === undefined
      ? { code: IMAGE_UNSUPPORTED_FILE_CODE, files: [...files] }
      : { code: IMAGE_PLACE_FAILED_CODE, files: [...files], reason: failure };
  for (const listener of [...(listeners.get(editor) ?? [])]) {
    try {
      listener(notice);
    } catch {
      // A subscriber's throw reaches neither the others nor the input path.
    }
  }
}

/** The outcome of `placeImageFiles`. */
export type PlaceImagesOutcome = Readonly<{
  /** The `insertImages` result, or null when no file could be placed. */
  result: CommandResult | null;
  /** The names of the files skipped (also raised as the notice). */
  skipped: readonly string[];
}>;

/** Options of `placeImageFiles`. */
export type PlaceImagesOptions = Readonly<{
  /** The page point the first image centres on; omitted, the viewport centre. */
  at?: PagePoint;
}>;

const baseName = (name: string): string => {
  const stem = name.replace(/\.[^./\\]*$/u, '').trim();
  return stem === '' ? 'Image' : stem;
};

/**
 * V32-H2: places `files` as image rectangles in one `insertImages` (one undo step): each file's
 * header is read and its bytes hashed (V32-E1), the first image is centred on `at` (else the
 * viewport centre) and each later one is 20 page units further. Text edit mode that is on when
 * the command is about to run is exited, unless it began while the files were being read, which
 * drops the placement (as for an SVG file read, V33-P2). A refused command raises
 * `editor.image-place-failed`. Files over 32 MiB, whose header does not parse, that cannot be read, or past the
 * 32nd are skipped and raised as `editor.image-unsupported-file`. Resolves when the command ran.
 */
export async function placeImageFiles(
  editor: Editor,
  files: ArrayLike<ImageFileLike>,
  options: PlaceImagesOptions = {},
): Promise<PlaceImagesOutcome> {
  const chosen = Array.from(files);
  if (chosen.length === 0) return { result: null, skipped: [] };
  const editingAtStart = editor.getSnapshot().textEdit !== null;
  const read = await Promise.all(
    chosen.slice(0, IMAGE_PLACE_LIMIT).map((file) =>
      imageAssetFromBlob(file).then(
        (asset) => asset,
        () => null,
      ),
    ),
  );
  const assets: NonNullable<(typeof read)[number]>[] = [];
  const names: string[] = [];
  const skipped = chosen.slice(IMAGE_PLACE_LIMIT).map((file) => file.name);
  read.forEach((asset, index) => {
    const file = chosen[index]!;
    if (asset === null) skipped.push(file.name);
    else {
      assets.push(asset);
      names.push(baseName(file.name));
    }
  });
  raiseImageNotice(editor, skipped);
  if (assets.length === 0) return { result: null, skipped };
  if (editor.getSnapshot().textEdit !== null) {
    // Edit mode that began while the files were read keeps the text; the late placement is dropped.
    if (!editingAtStart) return { result: null, skipped };
    editor.execute({ type: 'exitTextEdit' });
  }
  const result = editor.execute({
    type: 'insertImages',
    assets,
    names,
    ...(options.at === undefined ? {} : { at: options.at }),
  });
  if (!result.ok) raiseImageNotice(editor, names, result.code);
  return { result, skipped };
}

/** The element a picker needs; the DOM `HTMLInputElement` fits. */
export type ImagePickerInput = {
  type: string;
  accept: string;
  multiple: boolean;
  hidden: boolean;
  readonly files: ArrayLike<ImageFileLike> | null;
  click(): void;
  remove(): void;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: () => void, options?: { once: boolean }): void;
};

/**
 * V32-H3: opens the browser's file chooser for images and resolves to the chosen files (empty
 * when cancelled). Call it inside a user activation (a click or key handler); the chooser opens
 * synchronously. `create` is for tests; the default makes an `<input type=file>` in the page.
 */
export function pickImageFiles(
  create: () => ImagePickerInput = () =>
    document.createElement('input') as unknown as ImagePickerInput,
): Promise<readonly ImageFileLike[]> {
  return new Promise((resolve) => {
    const input = create();
    input.type = 'file';
    input.accept = IMAGE_FILE_TYPES.join(',');
    input.multiple = true;
    input.hidden = true;
    input.setAttribute('data-testid', 'place-image-file');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const files = Array.from(input.files ?? []);
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', finish, { once: true });
    input.addEventListener('cancel', finish, { once: true });
    // Kept in the page while the chooser is open, so it is not collected before `change`.
    (globalThis as { document?: Document }).document?.body.append(input as unknown as Node);
    input.click();
  });
}

/**
 * V32-H3: the Place image action: a file chooser, then `placeImageFiles` at the viewport centre.
 * Resolves to the outcome, or null when no file was chosen. Call it inside a user activation.
 */
export async function placeImagesFromPicker(
  editor: Editor,
  create?: () => ImagePickerInput,
): Promise<PlaceImagesOutcome | null> {
  const files = await pickImageFiles(create);
  return files.length === 0 ? null : placeImageFiles(editor, files);
}
