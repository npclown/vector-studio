// CSS strings for the M6a font list and font sources (docs/plans/mvp-m6a-text-model-contract.md,
// section 4, M6-F2). A name is escaped only where CSS needs it: `"` and `\` take a backslash and
// LF, CR and FF, which would end a CSS string, a hex escape; every other character, DEL and the
// other controls included, stays literal (review r1 B2). M6a-S3 excludes LF, CR and FF from family
// names, so a quoted family is at most 2 + 2 × 128 = 258 UTF-16 units and every font list's
// `.length` stays within E28-S2's 512, SCENE_TEXT_MAX_FONT_LIST (M6a-U2 rendering-track note).

/** `value` as a double-quoted CSS string. */
export function quoteCssString(value: string): string {
  let escaped = '';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (character === '"' || character === '\\') {
      escaped += `\\${character}`;
    } else if (code === 0x0a || code === 0x0d || code === 0x0c) {
      // LF, CR and FF would end the string. Families never hold one (M6a-S3); URLs might.
      escaped += `\\${code.toString(16)} `;
    } else {
      escaped += character;
    }
  }
  return `"${escaped}"`;
}

/** The fixed tail of every font list, with its leading separator (M6-F2). */
export const FONT_LIST_TAIL = ', "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';

/** Upper bound of the quoted `fallbackFamilies` part with its separators (M6a section 4). */
export const MAX_FALLBACK_PART = 200;

/** `, "<a>", "<b>"` for the host fallback families, or '' when there are none. */
export function fallbackPart(families: readonly string[]): string {
  return families.map((family) => `, ${quoteCssString(family)}`).join('');
}

/**
 * M6-F2: `"<family>", <fallbackFamilies quoted>, "Malgun Gothic", "Apple SD Gothic Neo",
 * sans-serif`. `fallback` is `fallbackPart(fallbackFamilies)`.
 */
export function buildFontList(family: string, fallback: string): string {
  return `${quoteCssString(family)}${fallback}${FONT_LIST_TAIL}`;
}

/** A `{ url }` font source as the `src` descriptor `url("<escaped>")`. */
export function fontUrlSource(url: string): string {
  return `url(${quoteCssString(url)})`;
}
