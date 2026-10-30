import type { TextLayoutPort, TextLayoutRequest, TextLayoutResult } from '@vector-studio/contracts';
import { assembleLayout } from './assemble.js';
import { buildFontList, fallbackPart, MAX_FALLBACK_PART, fontUrlSource } from './css.js';
import { nextGeneration } from './generation.js';
import { createListeners } from './listeners.js';
import { createMeasurer } from './measure.js';
import { measurementScale, scaleRequest, unscaleResult } from './scale.js';
import { checkRequest, isValidFamily, isValidLang } from './validate.js';

// `@vector-studio/text-dom` (docs/plans/mvp-m6a-text-model-contract.md, section 4): the browser
// implementation of `TextLayoutPort`. The host composition creates it on the client and injects
// it into the editor; the owner disposes it with the editor it fed (section 5).

export type TextDomFontSource = Readonly<{ url: string }> | Readonly<{ bytes: ArrayBuffer }>;

export type TextDomFont = Readonly<{
  /** One family name (M6a-S3), registered as is. */
  family: string;
  source: TextDomFontSource;
}>;

export type TextDomOptions = Readonly<{
  document: Document;
  /** BCP 47 by E28-S1's syntax only; default `ko` (M6a-Q1). */
  lang?: string;
  /** Families tried after the run's own, before the fixed tail (M6-F2). */
  fallbackFamilies?: readonly string[];
}>;

export interface TextDom extends TextLayoutPort {
  /**
   * Adds a `FontFace` to `document.fonts` and loads it. Resolves `'loaded'` or `'error'`, never
   * rejects (M6-F1). Throws `TypeError` for a family failing M6a-S3 or a malformed source.
   */
  registerFont(font: TextDomFont): Promise<'loaded' | 'error'>;
  /**
   * Removes listeners, the measurement host and the faces this instance registered; a
   * registration still in flight resolves 'error'.
   */
  dispose(): void;
  /** How many layouts fell back because a probe moved a cluster to another line (section 4). */
  readonly fallbacks: number;
}

const DEFAULT_LANG = 'ko';

function isDocument(value: unknown): value is Document {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { nodeType?: unknown }).nodeType === 9 &&
    typeof (value as { defaultView?: unknown }).defaultView === 'object' &&
    (value as { defaultView?: unknown }).defaultView !== null
  );
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

/** The `FontFace` source argument for a validated font source, or a `TypeError`. */
function faceSource(source: unknown): string | ArrayBuffer {
  if (typeof source !== 'object' || source === null) {
    throw new TypeError('text-dom: the font source is not an object');
  }
  const keys = Object.keys(source);
  if (keys.length === 1 && keys[0] === 'url') {
    const url = (source as { url: unknown }).url;
    if (typeof url === 'string' && url.length > 0) return fontUrlSource(url);
  }
  if (keys.length === 1 && keys[0] === 'bytes') {
    const bytes = (source as { bytes: unknown }).bytes;
    if (isArrayBuffer(bytes)) return bytes;
  }
  throw new TypeError('text-dom: the font source is neither { url } nor { bytes }');
}

export function createTextDom(options: TextDomOptions): TextDom {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('text-dom: options are not an object');
  }
  const document = options.document;
  if (!isDocument(document)) throw new TypeError('text-dom: document is not a Document');
  const lang = options.lang ?? DEFAULT_LANG;
  if (!isValidLang(lang)) throw new TypeError('text-dom: invalid lang');
  const fallbackFamilies = options.fallbackFamilies ?? [];
  if (!Array.isArray(fallbackFamilies) || !fallbackFamilies.every(isValidFamily)) {
    throw new TypeError('text-dom: invalid fallbackFamilies');
  }
  const fallback = fallbackPart(fallbackFamilies);
  if (fallback.length > MAX_FALLBACK_PART) {
    throw new TypeError('text-dom: fallbackFamilies exceed 200 characters when quoted');
  }

  const view = document.defaultView!;
  const fonts = (document as { fonts?: FontFaceSet }).fonts;
  const listeners = createListeners();
  const measurer = createMeasurer(document, lang);
  const faces = new Set<FontFace>();
  let generation = nextGeneration();
  let fallbacks = 0;
  let disposed = false;

  // M6a-L3: each event takes the realm counter's next value, then runs the listeners.
  const bump = (): void => {
    if (disposed) return;
    generation = nextGeneration();
    listeners.dispatch();
  };

  fonts?.addEventListener('loadingdone', bump);
  fonts?.addEventListener('loadingerror', bump);

  // A device pixel ratio change, browser zoom included, re-armed after each change (M6a-Q15).
  let resolution: MediaQueryList | null = null;
  const onResolution = (): void => {
    arm();
    bump();
  };
  const arm = (): void => {
    resolution?.removeEventListener('change', onResolution);
    resolution =
      typeof view.matchMedia === 'function'
        ? view.matchMedia(`(resolution: ${view.devicePixelRatio}dppx)`)
        : null;
    resolution?.addEventListener('change', onResolution);
  };
  arm();

  const fontListsOf = (request: TextLayoutRequest): string[] =>
    request.runs.map((run) => buildFontList(run.family, fallback));

  return {
    portVersion: 0,
    get generation() {
      return generation;
    },
    get fallbacks() {
      return fallbacks;
    },
    layout(request: TextLayoutRequest): TextLayoutResult {
      if (disposed) throw new Error('text-dom: layout after dispose');
      checkRequest(request);
      const fontLists = fontListsOf(request);
      // M6-Q3 (b): measured and assembled at the reference scale, divided back (section 3.2).
      const scale = measurementScale(request);
      const measured = scaleRequest(request, scale);
      const measurement = measurer.measure(measured, fontLists);
      if (measurement.metrics === null) fallbacks += 1;
      const result = assembleLayout({
        request: measured,
        generation,
        lang,
        fontLists,
        ...measurement,
      });
      return unscaleResult(result, request, scale);
    },
    subscribe(listener: () => void): () => void {
      if (typeof listener !== 'function')
        throw new TypeError('text-dom: listener is not a function');
      if (disposed) return () => {};
      return listeners.add(listener);
    },
    registerFont(font: TextDomFont): Promise<'loaded' | 'error'> {
      if (disposed) return Promise.resolve('error');
      if (typeof font !== 'object' || font === null) {
        throw new TypeError('text-dom: the font is not an object');
      }
      if (!isValidFamily(font.family)) throw new TypeError('text-dom: invalid font family');
      const source = faceSource(font.source);
      const FontFaceConstructor = (view as { FontFace?: typeof FontFace }).FontFace;
      if (fonts === undefined || typeof FontFaceConstructor !== 'function') {
        return Promise.resolve('error');
      }
      let face: FontFace;
      try {
        // Chrome takes the constructor's family as the raw name, not as CSS (M6a-U4 notes).
        face = new FontFaceConstructor(font.family, source);
        fonts.add(face);
      } catch {
        return Promise.resolve('error');
      }
      faces.add(face);
      bump(); // A registry change.
      // The face settled; one still in flight at `dispose` resolves 'error', since dispose
      // removed it from `document.fonts` (review r1 N2).
      return face.load().then(
        () => {
          if (disposed) return 'error' as const;
          bump();
          return 'loaded' as const;
        },
        () => {
          bump();
          return 'error' as const;
        },
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      fonts?.removeEventListener('loadingdone', bump);
      fonts?.removeEventListener('loadingerror', bump);
      resolution?.removeEventListener('change', onResolution);
      resolution = null;
      for (const face of faces) fonts?.delete(face);
      faces.clear();
      measurer.remove();
    },
  };
}
