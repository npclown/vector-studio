import type {
  GlyphRasterPort,
  GlyphRasterRequest,
  GlyphRasterResult,
  RenderNodeSnapshot,
  SceneAffine,
  SceneColor,
} from '@vector-studio/contracts';

// E28 contract (docs/plans/d9-e28-text-glyph-atlas-contract.md): the fake raster port and text
// nodes shared by the E28 unit tests (U2 atlas plan, U3 backend).

const IDENTITY: SceneAffine = [1, 0, 0, 1, 0, 0];
const black: SceneColor = { r: 0, g: 0, b: 0, a: 1 };

/**
 * A fake raster port. A bitmap is `round(0.6 b) + 4` by `round(1.2 b) + 4` px with left 2 and top
 * `round(b) + 2`, filled with a byte that changes on every call (T9: a new raster never repeats
 * an earlier one). Texts 'FAIL', 'BIG' and 'THROW' fail, 'HUGE' is wider than 1,024 px and
 * 'BAD' is malformed; whitespace and texts starting with '~' are empty.
 */
export class FakeRaster implements GlyphRasterPort {
  readonly portVersion = 0 as const;
  readonly operationId = 'fake/raster-v0';
  readonly requests: GlyphRasterRequest[] = [];

  public rasterize(request: GlyphRasterRequest): GlyphRasterResult {
    this.requests.push(request);
    if (request.text === 'THROW') throw new Error('raster');
    if (request.text === 'FAIL') return { status: 'failed', reason: 'unavailable' };
    if (request.text === 'BIG') return { status: 'failed', reason: 'too-large' };
    if (request.text.trim() === '' || request.text.startsWith('~')) return { status: 'empty' };
    if (request.text === 'HUGE') {
      return {
        status: 'ok',
        width: 1100,
        height: 4,
        left: 0,
        top: 2,
        coverage: new Uint8Array(4400),
      };
    }
    if (request.text === 'BAD') {
      return { status: 'ok', width: 4, height: 4, left: 0, top: 2, coverage: new Uint8Array(3) };
    }
    const width = Math.round(0.6 * request.pixelSize) + 4;
    const height = Math.round(1.2 * request.pixelSize) + 4;
    return {
      status: 'ok',
      width,
      height,
      left: 2,
      top: Math.round(request.pixelSize) + 2,
      coverage: new Uint8Array(width * height).fill((this.requests.length % 255) + 1),
    };
  }
}

export type TextOptions = Readonly<{
  parentId?: string | null;
  size?: number;
  y?: number;
  generation?: number;
  transform?: SceneAffine;
  opacity?: number;
  color?: SceneColor;
  visible?: boolean;
}>;

/** A text node with one run; each cluster is [text, x]. */
export function textNode(
  id: string,
  clusters: readonly (readonly [string, number])[],
  options: TextOptions = {},
): RenderNodeSnapshot {
  const size = options.size ?? 16;
  return {
    id,
    parentId: options.parentId ?? null,
    transform: options.transform ?? IDENTITY,
    visible: options.visible ?? true,
    opacity: options.opacity ?? 1,
    kind: 'text',
    generation: options.generation ?? 0,
    lang: 'ko',
    runs: [
      {
        fontList: '"Arial", sans-serif',
        size,
        color: options.color ?? black,
        clusters: clusters.map(([text, x]) => ({ text, x, y: options.y ?? 20, advance: size / 2 })),
      },
    ],
  };
}

/** Distinct clusters: one CJK ideograph each. */
export function many(count: number, start = 0): [string, number][] {
  return Array.from({ length: count }, (_, index) => [
    String.fromCodePoint(0x4e00 + start + index),
    index,
  ]);
}
