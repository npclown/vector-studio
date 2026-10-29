import {
  createEditor,
  starExtension,
  type Editor,
  type Platform,
} from '@vector-studio/editor-core';
import { createTextDom, type TextDom, type TextDomOptions } from '@vector-studio/text-dom';
import { persistQuery } from './m5-persistence';

// M6a-U5 (MVP M6a contract, section 5): the next-host text composition, kept free of React so it
// is unit tested in Node with an injected text-dom factory. An editor with a port is created on
// the client only, never during render or prerender, since `createTextDom` needs a `document`;
// page.tsx calls `startHostComposition` from a client effect and the effect's cleanup disposes
// the pair, so strict mode's double effect leaves one live pair. There is no editor dispose
// (M6a-Q20 (a)): disposing the text-dom instance removes its listeners, so the discarded editor's
// subscription is never called again and the editor is left to the garbage collector.

/**
 * The test font (M6a-Q13 (a), adopted under the user's standing rule as contract section 13 records): a subset of
 * Noto Sans KR 2.004 under the OFL 1.1, committed at `tests/fixtures/m6-text/fonts/` with its
 * license and served by the `app/m6a-test-font.otf` route. It registers under the family the
 * `?fixture=text` document's runs name, so a registered face hides any installed face of that
 * name and the fixture lays out with the committed file on every machine.
 */
export const TEST_FONT_FAMILY = 'Noto Sans KR';
export const TEST_FONT_URL = '/m6a-test-font.otf';

/** The host's editor and the text-dom instance it was created with (section 5). */
export type HostComposition = Readonly<{
  editor: Editor;
  textDom: TextDom;
  /** Disposes the text-dom instance; idempotent. */
  dispose(): void;
}>;

export type HostCompositionOptions = Readonly<{
  document: Document;
  platform: Platform;
  /** The text-dom factory; tests inject one. */
  createTextDom?: (options: TextDomOptions) => TextDom;
}>;

/** Creates the text-dom instance and the editor it feeds, in that order. */
export function composeHost(options: HostCompositionOptions): HostComposition {
  const textDom = (options.createTextDom ?? createTextDom)({ document: options.document });
  let editor: Editor;
  try {
    editor = createEditor({
      extensions: [starExtension],
      platform: options.platform,
      textLayout: textDom,
    });
  } catch (error) {
    textDom.dispose();
    throw error;
  }
  let disposed = false;
  return {
    editor,
    textDom,
    dispose() {
      if (disposed) return;
      disposed = true;
      textDom.dispose();
    },
  };
}

export type TestFontStatus = 'none' | 'loading' | 'loaded' | 'error';

/** Registers the committed test font under `family` (default the fixture's family). */
export function registerTestFont(
  textDom: TextDom,
  family: string = TEST_FONT_FAMILY,
): Promise<'loaded' | 'error'> {
  return textDom.registerFont({ family, source: { url: TEST_FONT_URL } });
}

/** What the page shows and the test hook exposes of a live composition. */
export type HostCompositionState = Readonly<{
  /** Distinct per composition in this realm, so the page keys its subtree by it. */
  id: number;
  composition: HostComposition;
  /** The `?fixture=text` registration, settled before the fixture loads; null otherwise. */
  testFont: Promise<'loaded' | 'error'> | null;
}>;

let compositions = 0;

/**
 * The client effect's body: composes the host, registers the test font when `textFixture` is
 * set, and hands the state to `publish`. The returned cleanup disposes the composition and stops
 * the font status reaching `onFontStatus` afterwards.
 */
export function startHostComposition(
  options: HostCompositionOptions &
    Readonly<{
      textFixture: boolean;
      publish(state: HostCompositionState): void;
      onFontStatus?(status: TestFontStatus): void;
    }>,
): () => void {
  const composition = composeHost(options);
  let live = true;
  let testFont: Promise<'loaded' | 'error'> | null = null;
  if (options.textFixture) {
    options.onFontStatus?.('loading');
    testFont = registerTestFont(composition.textDom);
    void testFont.then((status) => {
      if (live) options.onFontStatus?.(status);
    });
  }
  compositions += 1;
  options.publish({ id: compositions, composition, testFont });
  return () => {
    live = false;
    composition.dispose();
  };
}

/**
 * The text member of the page's `?test=1` hook (M6a-A11, M6a-U6): the editor's port, the
 * fixture's registration, and the test font under another family, for the font-load case (lay
 * out with fallback, register, re-lay out, `refitText`).
 */
export type TextTestHook = Readonly<{
  port: TextDom;
  family: string;
  fontUrl: string;
  testFont: Promise<'loaded' | 'error'> | null;
  registerTestFont(family?: string): Promise<'loaded' | 'error'>;
}>;

export function textTestHook(state: HostCompositionState): TextTestHook {
  const { textDom } = state.composition;
  return {
    port: textDom,
    family: TEST_FONT_FAMILY,
    fontUrl: TEST_FONT_URL,
    testFont: state.testFont,
    registerTestFont: (family) => registerTestFont(textDom, family),
  };
}

/**
 * `?fixture=text` asks for the test font; with `?persist=1` the fixture is ignored (M5 contract,
 * section 5.3), and so is the font.
 */
export function textFixtureQuery(search: string): boolean {
  return (
    new URLSearchParams(search).get('fixture') === 'text' && !persistQuery(search).fixtureIgnored
  );
}

/**
 * The page effect: `startHostComposition`, with a failure (a throwing `createTextDom` or a rejected
 * port) handed to `onError` instead of thrown, so the page can show it rather than a blank page.
 * Returns the cleanup, a no-op after a failure.
 */
export function runHostEffect(
  options: Parameters<typeof startHostComposition>[0],
  onError: (message: string) => void,
): () => void {
  try {
    return startHostComposition(options);
  } catch (error) {
    onError(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    return () => {};
  }
}
