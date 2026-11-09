import type { HandleCursor } from './m2-geometry';

// V-28 (Figma): the CSS cursor for a hover over a selection handle or rotate zone. Both cursors are
// SVG images turned to the handle's outward direction, so a rotated box shows arrows along its own
// axes; each falls back to the nearest standard cursor where a browser refuses the image.

/** Angles are rounded to this step (degrees) so a slow turn reuses the same cursor string. */
const STEP = 5;

const cache = new Map<string, string>();

function svgCursor(body: string, fallback: string): string {
  return (
    'url("data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
        body +
        '</svg>',
    ) +
    `") 12 12, ${fallback}`
  );
}

/** The standard resize cursor nearest to a double arrow along `angle` (screen degrees, y down). */
export function standardResizeCursor(angle: number): string {
  const folded = (((Math.round(angle / 45) * 45) % 180) + 180) % 180;
  return folded === 0
    ? 'ew-resize'
    : folded === 45
      ? 'nwse-resize'
      : folded === 90
        ? 'ns-resize'
        : 'nesw-resize';
}

/** The CSS `cursor` value for a handle cursor, or undefined for the default cursor. */
export function handleCursorCss(cursor: HandleCursor | null): string | undefined {
  if (cursor === null) return undefined;
  const angle = (((Math.round(cursor.angle / STEP) * STEP) % 360) + 360) % 360;
  const key = `${cursor.kind}:${angle}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let css: string;
  if (cursor.kind === 'resize') {
    // A horizontal double arrow, black with a white outline, turned to the handle direction.
    css = svgCursor(
      `<g transform="rotate(${angle} 12 12)">` +
        '<path d="M2 12 7 7v3h10V7l5 5-5 5v-3H7v3z" fill="#000" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>' +
        '</g>',
      standardResizeCursor(angle),
    );
  } else {
    // A quarter arc with an arrow head at each end, drawn bulging toward the lower right (45
    // degrees), turned so it curls around the hovered corner.
    const arc = 'M18 7A11 11 0 0 1 7 18';
    css = svgCursor(
      `<g transform="rotate(${angle - 45} 12 12)">` +
        `<path d="${arc}" fill="none" stroke="#fff" stroke-width="4.5"/>` +
        `<path d="${arc}" fill="none" stroke="#000" stroke-width="2"/>` +
        '<path d="M14 7.5 18 3l4 4.5z" fill="#000" stroke="#fff" stroke-linejoin="round"/>' +
        '<path d="M7.5 14 3 18l4.5 4z" fill="#000" stroke="#fff" stroke-linejoin="round"/>' +
        '</g>',
      'crosshair',
    );
  }
  cache.set(key, css);
  return css;
}
