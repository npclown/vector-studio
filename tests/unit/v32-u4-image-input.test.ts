// V-32 contract (docs/plans/viz-v32-image-contract.md), unit U4, V32-H2 and V32-H3: pasted,
// dropped and picked image files become image rectangles; skipped files raise the notice
// `editor.image-unsupported-file`; Ctrl or Cmd+Shift+K opens the picker from the keydown.
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
  type ImagePaint,
} from '../../packages/editor-core/src/index.js';
import { CanvasInput } from '../../packages/react/src/canvas-input.js';
import {
  IMAGE_PLACE_LIMIT,
  isImageFile,
  pickImageFiles,
  placeImageFiles,
  placeImagesFromPicker,
  subscribeImageNotices,
  type ImageFileLike,
  type ImageNotice,
} from '../../packages/react/src/image-input.js';
import { createFakeTextLayout } from '../support/fake-text-layout.js';

const be32 = (value: number) => [
  (value >>> 24) & 255,
  (value >>> 16) & 255,
  (value >>> 8) & 255,
  value & 255,
];

/** A PNG header plus `seed` filler, so files of different seeds hash differently. */
function pngBytes(width: number, height: number, seed = 0): Uint8Array {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...be32(13),
    0x49,
    0x48,
    0x44,
    0x52,
    ...be32(width),
    ...be32(height),
    8,
    6,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    seed,
    seed,
  ]);
}

function file(name: string, bytes: Uint8Array, type = 'image/png'): ImageFileLike {
  return {
    name,
    type,
    size: bytes.length,
    arrayBuffer: () => Promise.resolve(bytes.slice().buffer),
  };
}

const text = (name: string): ImageFileLike => file(name, Uint8Array.from([104, 105]), 'text/plain');

function editor(): Editor {
  return createEditor({
    ids: createCounterIdSource('n'),
    textLayout: createFakeTextLayout(),
  });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  expect(result).toMatchObject({ ok: true });
  return result.ok ? result.ids : [];
}

const canvasLike = {
  getBoundingClientRect: () => ({ left: 0, top: 0 }),
  clientLeft: 0,
  clientTop: 0,
};

function host() {
  const target = editor();
  ok(target, { type: 'setViewportSize', width: 800, height: 600 });
  const commands: Command[] = [];
  const execute = target.execute.bind(target);
  target.execute = (command) => {
    commands.push(command);
    return execute(command);
  };
  const notices: ImageNotice[] = [];
  subscribeImageNotices(target, (notice) => notices.push(notice));
  const input = new CanvasInput(
    target,
    () => 400,
    () => canvasLike,
  );
  return { target, input, commands, notices };
}

const inserts = (commands: readonly Command[]) =>
  commands.filter((command) => command.type === 'insertImages');
const pastes = (commands: readonly Command[]) =>
  commands.filter((command) => command.type === 'paste');

function clipboard(data: Record<string, string>, files: ImageFileLike[] = []) {
  let prevented = 0;
  return {
    event: {
      clipboardData: {
        getData: (format: string) => data[format] ?? '',
        setData: () => undefined,
        files,
      },
      preventDefault: () => (prevented += 1),
    },
    prevented: () => prevented,
  };
}

/** Lets the hashing and command promise chains settle. */
async function settle() {
  for (let index = 0; index < 20; index += 1)
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function rectangles(target: Editor) {
  const document = target.query({ type: 'document' });
  return Object.values(document.nodes).filter((node) => node.type === 'rectangle');
}

describe('V32-H2 file kinds', () => {
  it('takes PNG, JPEG, WebP and GIF by type, or by name when the type is empty; not SVG', () => {
    expect(isImageFile({ name: 'a', type: 'image/png' })).toBe(true);
    expect(isImageFile({ name: 'a', type: 'image/jpeg' })).toBe(true);
    expect(isImageFile({ name: 'a', type: 'image/webp' })).toBe(true);
    expect(isImageFile({ name: 'a', type: 'image/gif' })).toBe(true);
    expect(isImageFile({ name: 'photo.JPG', type: '' })).toBe(true);
    expect(isImageFile({ name: 'photo.txt', type: '' })).toBe(false);
    expect(isImageFile({ name: 'a.svg', type: 'image/svg+xml' })).toBe(false);
    expect(isImageFile({ name: 'a.bmp', type: 'image/bmp' })).toBe(false);
  });
});

describe('V32-H2 paste', () => {
  it('places a pasted image file at the pointer, selected, as one insertImages', async () => {
    const { target, input, commands } = host();
    input.pointerMove({
      clientX: 200,
      clientY: 100,
      currentTarget: canvasLike,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      ctrlKey: false,
    });
    const { event, prevented } = clipboard({}, [file('shot.png', pngBytes(40, 20))]);
    input.clipboardPaste(event);
    expect(prevented()).toBe(1);
    // Nothing runs synchronously: the file is hashed first.
    expect(commands.filter((command) => command.type !== 'input')).toEqual([]);
    await settle();
    const [command] = inserts(commands);
    expect(command).toMatchObject({
      type: 'insertImages',
      at: { x: 200, y: 100 },
      names: ['shot'],
    });
    const [node] = rectangles(target);
    expect(node).toMatchObject({ name: 'shot', frame: { x: 180, y: 90, width: 40, height: 20 } });
    expect((node as unknown as { fills: { paint: ImagePaint }[] }).fills[0]!.paint).toMatchObject({
      kind: 'image',
      scaleMode: 'fill',
    });
    expect(target.query({ type: 'selection' })).toEqual([node!.id]);
  });

  it('places at the view centre when the pointer is off the canvas', async () => {
    const { target, input, commands } = host();
    input.clipboardPaste(clipboard({}, [file('a.png', pngBytes(40, 20))]).event);
    await settle();
    expect(inserts(commands)[0]).not.toHaveProperty('at');
    expect(rectangles(target)).toHaveLength(1);
  });

  it('wins over text/plain, but a vector-studio fragment wins over the file', async () => {
    const { input, commands } = host();
    input.clipboardPaste(
      clipboard({ 'text/plain': 'hello' }, [file('a.png', pngBytes(4, 4))]).event,
    );
    await settle();
    expect(inserts(commands)).toHaveLength(1);
    expect(pastes(commands)).toEqual([]);
    input.clipboardPaste(
      clipboard({ 'text/plain': 'vector-studio/fragment\n{}' }, [file('b.png', pngBytes(4, 4, 1))])
        .event,
    );
    await settle();
    expect(inserts(commands)).toHaveLength(1);
    expect(pastes(commands)).toEqual([{ type: 'paste', text: 'vector-studio/fragment\n{}' }]);
  });

  it('ignores image files in text edit mode and pastes the text', async () => {
    const { target, input, commands } = host();
    const [id] = ok(target, {
      type: 'createText',
      frame: { x: 0, y: 0, width: 10, height: 10 },
      runs: [{ text: 'x', family: 'Test', size: 10, color: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    ok(target, { type: 'enterTextEdit', id: id!, anchor: 1, focus: 1 });
    input.clipboardPaste(clipboard({ 'text/plain': 'a' }, [file('a.png', pngBytes(4, 4))]).event);
    await settle();
    expect(inserts(commands)).toEqual([]);
    expect(pastes(commands)).toEqual([{ type: 'paste', text: 'a' }]);
  });

  it('pastes text when the only file is not an image', async () => {
    const { input, commands, notices } = host();
    input.clipboardPaste(clipboard({ 'text/plain': 'a' }, [text('notes.txt')]).event);
    await settle();
    expect(pastes(commands)).toEqual([{ type: 'paste', text: 'a' }]);
    expect(notices).toEqual([]);
  });

  it('raises the notice for an image file whose header does not parse', async () => {
    const { input, commands, notices } = host();
    input.clipboardPaste(clipboard({}, [file('fake.png', Uint8Array.from([1, 2, 3, 4]))]).event);
    await settle();
    expect(inserts(commands)).toEqual([]);
    expect(notices).toEqual([{ code: 'editor.image-unsupported-file', files: ['fake.png'] }]);
  });
});

describe('V32-H2 drop', () => {
  function dropEvent(files: ImageFileLike[], x = 300, y = 200) {
    let prevented = 0;
    const transfer = { types: ['Files'], files, dropEffect: 'none' };
    return {
      event: {
        clientX: x,
        clientY: y,
        dataTransfer: transfer,
        preventDefault: () => (prevented += 1),
      },
      prevented: () => prevented,
      transfer,
    };
  }

  it('places two dropped files, the first centred on the drop point, the next 20 units on', async () => {
    const { target, input, commands, notices } = host();
    const { event, prevented, transfer } = dropEvent([
      file('one.png', pngBytes(40, 20, 1)),
      file('two.png', pngBytes(10, 10, 2)),
    ]);
    input.dragOver(event);
    expect(transfer.dropEffect).toBe('copy');
    await input.drop(event);
    expect(prevented()).toBe(2);
    expect(inserts(commands)).toHaveLength(1);
    const nodes = rectangles(target);
    expect(nodes.map((node) => [node.name, node.frame])).toEqual([
      ['one', { x: 280, y: 190, width: 40, height: 20 }],
      ['two', { x: 315, y: 215, width: 10, height: 10 }],
    ]);
    expect(notices).toEqual([]);
    expect(target.query({ type: 'history' }).undoDepth).toBe(1);
  });

  it('skips other files, oversized files and unparsable headers with the notice', async () => {
    const { target, input, notices } = host();
    const big: ImageFileLike = {
      name: 'big.png',
      type: 'image/png',
      size: 32 * 1024 * 1024 + 1,
      arrayBuffer: () => Promise.reject(new Error('never read')),
    };
    const { event } = dropEvent([
      file('ok.png', pngBytes(8, 8)),
      text('notes.txt'),
      big,
      file('broken.png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47])),
    ]);
    await input.drop(event);
    expect(rectangles(target)).toHaveLength(1);
    // The unsupported type is reported at once, the image files after their read.
    expect(notices.flatMap((notice) => notice.files).sort()).toEqual([
      'big.png',
      'broken.png',
      'notes.txt',
    ]);
    expect(notices.every((notice) => notice.code === 'editor.image-unsupported-file')).toBe(true);
  });

  it('leaves SVG files to the SVG import and raises no notice for them', async () => {
    const { input, notices, commands } = host();
    const svg = {
      name: 'a.svg',
      type: 'image/svg+xml',
      size: 10,
      text: () =>
        Promise.resolve(
          '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>',
        ),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    };
    await input.drop(dropEvent([svg]).event);
    expect(pastes(commands)).toHaveLength(1);
    expect(inserts(commands)).toEqual([]);
    expect(notices).toEqual([]);
  });

  it('exits text edit mode before placing', async () => {
    const { target, input } = host();
    const [id] = ok(target, {
      type: 'createText',
      frame: { x: 0, y: 0, width: 10, height: 10 },
      runs: [{ text: 'x', family: 'Test', size: 10, color: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    ok(target, { type: 'enterTextEdit', id: id!, anchor: 1, focus: 1 });
    await input.drop(dropEvent([file('a.png', pngBytes(8, 8))]).event);
    expect(target.getSnapshot().textEdit).toBeNull();
    expect(rectangles(target)).toHaveLength(1);
  });

  it('drops a placement whose text edit mode began while the files were read', async () => {
    const { target, notices } = host();
    const [id] = ok(target, {
      type: 'createText',
      frame: { x: 0, y: 0, width: 10, height: 10 },
      runs: [{ text: 'x', family: 'Test', size: 10, color: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    const bytes = pngBytes(8, 8);
    const late: ImageFileLike = {
      name: 'late.png',
      type: 'image/png',
      size: bytes.length,
      arrayBuffer: () => {
        // The user starts editing text while the file is being read.
        ok(target, { type: 'enterTextEdit', id: id!, anchor: 1, focus: 1 });
        return Promise.resolve(bytes.slice().buffer);
      },
    };
    const outcome = await placeImageFiles(target, [late]);
    expect(outcome.result).toBeNull();
    expect(target.getSnapshot().textEdit).not.toBeNull();
    expect(rectangles(target)).toHaveLength(0);
    expect(notices).toEqual([]);
  });

  it('raises editor.image-place-failed when insertImages is refused', async () => {
    const { target, notices } = host();
    const execute = target.execute.bind(target);
    target.execute = (command) =>
      command.type === 'insertImages'
        ? { ok: false, code: 'editor.image-too-large', message: 'x' }
        : execute(command);
    const outcome = await placeImageFiles(target, [file('big.png', pngBytes(8, 8))]);
    expect(outcome.result).toMatchObject({ ok: false });
    expect(notices).toEqual([
      { code: 'editor.image-place-failed', files: ['big'], reason: 'editor.image-too-large' },
    ]);
  });

  it('prevents a drop that is not files and does nothing', async () => {
    const { input, commands } = host();
    let prevented = 0;
    await input.drop({
      clientX: 0,
      clientY: 0,
      dataTransfer: { types: ['text/plain'], files: [], dropEffect: 'none' },
      preventDefault: () => (prevented += 1),
    });
    expect(prevented).toBe(0);
    expect(inserts(commands)).toEqual([]);
  });
});

describe('V32-H2 placeImageFiles', () => {
  it('names each rectangle by its file without the extension and drops files past 32', async () => {
    const { target, notices } = host();
    const files = Array.from({ length: IMAGE_PLACE_LIMIT + 2 }, (_, index) =>
      file(`img ${index}.v2.png`, pngBytes(4, 4, index)),
    );
    const outcome = await placeImageFiles(target, files);
    expect(outcome.result).toMatchObject({ ok: true });
    expect(rectangles(target)).toHaveLength(IMAGE_PLACE_LIMIT);
    expect(rectangles(target)[0]!.name).toBe('img 0.v2');
    expect(outcome.skipped).toEqual(['img 32.v2.png', 'img 33.v2.png']);
    expect(notices).toEqual([
      { code: 'editor.image-unsupported-file', files: ['img 32.v2.png', 'img 33.v2.png'] },
    ]);
  });

  it('places the same image twice under one table entry', async () => {
    const { target } = host();
    await placeImageFiles(target, [file('a.png', pngBytes(4, 4)), file('b.png', pngBytes(4, 4))]);
    expect(rectangles(target)).toHaveLength(2);
    expect(Object.keys(target.query({ type: 'document' }).images ?? {})).toHaveLength(1);
  });

  it('does nothing for no files and raises no notice', async () => {
    const { target, notices } = host();
    expect(await placeImageFiles(target, [])).toEqual({ result: null, skipped: [] });
    expect(notices).toEqual([]);
  });
});

describe('V32-H3 picker and shortcut', () => {
  function fakeInput(chosen: ImageFileLike[] | null) {
    const listeners = new Map<string, () => void>();
    const input = {
      type: '',
      accept: '',
      multiple: false,
      hidden: false,
      files: chosen,
      attributes: {} as Record<string, string>,
      removed: 0,
      clicks: 0,
      click() {
        input.clicks += 1;
        // The chooser answers after the click, as a browser does.
        queueMicrotask(() => listeners.get(chosen === null ? 'cancel' : 'change')?.());
      },
      remove() {
        input.removed += 1;
      },
      setAttribute(name: string, value: string) {
        input.attributes[name] = value;
      },
      addEventListener(type: string, listener: () => void) {
        listeners.set(type, listener);
      },
    };
    return input;
  }

  it('opens a multiple-file chooser for the four image types, and resolves the files', async () => {
    const chosen = [file('a.png', pngBytes(4, 4))];
    const input = fakeInput(chosen);
    const files = await pickImageFiles(() => input);
    expect(input).toMatchObject({
      type: 'file',
      accept: 'image/png,image/jpeg,image/webp,image/gif',
      multiple: true,
      clicks: 1,
      removed: 1,
    });
    expect(files).toEqual(chosen);
  });

  it('resolves no files on cancel, and Place image then does nothing', async () => {
    const { target } = host();
    expect(await pickImageFiles(() => fakeInput(null))).toEqual([]);
    expect(await placeImagesFromPicker(target, () => fakeInput(null))).toBeNull();
    expect(rectangles(target)).toHaveLength(0);
  });

  it('places the chosen files at the viewport centre', async () => {
    const { target } = host();
    const outcome = await placeImagesFromPicker(target, () =>
      fakeInput([file('c.png', pngBytes(100, 50))]),
    );
    expect(outcome?.result).toMatchObject({ ok: true });
    // The view centre of the 800 × 600 viewport at the origin.
    expect(rectangles(target)[0]!.frame).toEqual({ x: 350, y: 275, width: 100, height: 50 });
  });

  const key = (
    extra: Partial<Record<'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey', boolean>>,
    code = 'KeyK',
  ) => {
    let prevented = 0;
    return {
      event: {
        key: 'K',
        code,
        repeat: false,
        isComposing: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        ctrlKey: false,
        ...extra,
        preventDefault: () => (prevented += 1),
      },
      prevented: () => prevented,
    };
  };

  it('runs the host picker on Ctrl or Cmd+Shift+K, prevented, and not through the editor', () => {
    const { input, commands } = host();
    let opened = 0;
    input.placeImage = () => (opened += 1);
    for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
      const { event, prevented } = key({ shiftKey: true, ...mod });
      input.keyDown(event);
      expect(prevented()).toBe(1);
    }
    expect(opened).toBe(2);
    expect(commands.filter((command) => command.type === 'input')).toEqual([]);
  });

  it('leaves other chords and a held key alone', () => {
    const { input } = host();
    let opened = 0;
    input.placeImage = () => (opened += 1);
    input.keyDown(key({ ctrlKey: true }).event);
    input.keyDown(key({ shiftKey: true }).event);
    input.keyDown(key({ shiftKey: true, ctrlKey: true, altKey: true }).event);
    input.keyDown(key({ shiftKey: true, ctrlKey: true }, 'KeyJ').event);
    expect(opened).toBe(0);
    input.keyDown({ ...key({ shiftKey: true, ctrlKey: true }).event, repeat: true });
    expect(opened).toBe(0);
  });

  it('does nothing without a host picker, and not in text edit mode', () => {
    const { target, input, commands } = host();
    input.keyDown(key({ shiftKey: true, ctrlKey: true }).event);
    expect(commands.some((command) => command.type === 'input')).toBe(true);
    const [id] = ok(target, {
      type: 'createText',
      frame: { x: 0, y: 0, width: 10, height: 10 },
      runs: [{ text: 'x', family: 'Test', size: 10, color: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    ok(target, { type: 'enterTextEdit', id: id!, anchor: 1, focus: 1 });
    let opened = 0;
    input.placeImage = () => (opened += 1);
    input.keyDown(key({ shiftKey: true, ctrlKey: true }).event);
    expect(opened).toBe(0);
  });
});
