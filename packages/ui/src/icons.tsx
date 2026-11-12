import type { ReactNode } from 'react';

// V-25: the toolbar's 16 px line icons, drawn in `currentColor` so a host's text colour themes
// them. Decorative: each button names itself with `aria-label`.

const PATHS: Readonly<Record<string, ReactNode>> = {
  select: <path d="M3.5 2.5 L12.5 8 L8.4 9 L10.6 13.3 L9 14 L6.9 9.8 L3.5 12.5 Z" />,
  rectangle: <rect x="2.5" y="3.5" width="11" height="9" rx="0.5" />,
  ellipse: <ellipse cx="8" cy="8" rx="5.5" ry="5" />,
  line: <path d="M3 13 L13 3" />,
  frame: <path d="M5 1.5 V14.5 M11 1.5 V14.5 M1.5 5 H14.5 M1.5 11 H14.5" />,
  path: (
    <>
      <path d="M2.5 13.5 C4 7 8 4 13.5 2.5" />
      <rect x="1" y="12" width="3" height="3" />
      <rect x="12" y="1" width="3" height="3" />
    </>
  ),
  text: <path d="M3 3.5 H13 M8 3.5 V13.5 M6 13.5 H10" />,
  // V-40: a freehand squiggle with a pencil tip, and a pentagon.
  pencil: (
    <>
      <path d="M1.5 12.5 C3 9.5 5 14 7 11 S9.5 8 10.5 9" />
      <path d="M9.5 6.5 L13 3 L14.5 4.5 L11 8 L9 8.5 Z" />
    </>
  ),
  polygon: <path d="M8 2 L14 6.5 L11.7 13.5 H4.3 L2 6.5 Z" />,
  // V-39: a pipette, tip at the lower left.
  eyedropper: (
    <path d="M2.5 13.5 L3.5 12.5 L9 7 M7 5 L11 9 M9 3 L13 7 M10.2 1.8 A2 2 0 0 1 14.2 5.8 L12.5 7.5 L8.5 3.5 Z M9 7 L3.5 12.5" />
  ),
  undo: <path d="M5.5 3.5 L2.5 6.5 L5.5 9.5 M2.5 6.5 H10 A3.5 3.5 0 0 1 10 13.5 H7" />,
  redo: <path d="M10.5 3.5 L13.5 6.5 L10.5 9.5 M13.5 6.5 H6 A3.5 3.5 0 0 0 6 13.5 H9" />,
  group: (
    <>
      <rect x="1.5" y="1.5" width="13" height="13" strokeDasharray="2 2" />
      <rect x="4" y="4" width="4" height="4" />
      <rect x="8" y="8" width="4" height="4" />
    </>
  ),
  ungroup: (
    <>
      <rect x="2" y="2" width="5" height="5" />
      <rect x="9" y="9" width="5" height="5" />
    </>
  ),
  mask: (
    <>
      <circle cx="6" cy="8" r="4.5" />
      <circle cx="10" cy="8" r="4.5" />
    </>
  ),
  delete: (
    <path d="M2.5 4.5 H13.5 M6 4.5 V2.5 H10 V4.5 M4 4.5 L4.8 14 H11.2 L12 4.5 M6.8 7 V11.5 M9.2 7 V11.5" />
  ),
  'toggle-closed': (
    <>
      <path d="M3 12 C3 5 13 5 13 12" />
      <circle cx="3" cy="12" r="1.5" />
      <circle cx="13" cy="12" r="1.5" />
    </>
  ),
  'create-symbol': <path d="M8 1.5 L14.5 8 L8 14.5 L1.5 8 Z M8 5 L11 8 L8 11 L5 8 Z" />,
  'create-instance': <path d="M8 1.5 L14.5 8 L8 14.5 L1.5 8 Z" />,
  detach: <path d="M8 1.5 L11 4.5 M14.5 8 L11.5 11 M8 14.5 L5 11.5 M1.5 8 L4.5 5" />,
  // E41-U3b: two overlapping squares, the result region filled.
  'boolean-union': (
    <path d="M2 2 H10 V6 H14 V14 H6 V10 H2 Z" fill="currentColor" fillOpacity={0.35} />
  ),
  'boolean-subtract': (
    <>
      <path d="M2 2 H10 V6 H6 V10 H2 Z" fill="currentColor" fillOpacity={0.35} />
      <path d="M6 6 H14 V14 H6 Z" strokeDasharray="1.5 1.5" />
    </>
  ),
  'boolean-intersect': (
    <>
      <path d="M2 2 H10 V10 H2 Z M6 6 H14 V14 H6 Z" strokeDasharray="1.5 1.5" />
      <path d="M6 6 H10 V10 H6 Z" fill="currentColor" fillOpacity={0.35} />
    </>
  ),
  'boolean-exclude': (
    <path
      d="M2 2 H10 V6 H14 V14 H6 V10 H2 Z M6 6 H10 V10 H6 Z"
      fill="currentColor"
      fillOpacity={0.35}
      fillRule="evenodd"
    />
  ),
  // V-31: the layer row's visibility and lock buttons.
  eye: (
    <>
      <path d="M1.5 8 C3.5 4.5 5.5 3.5 8 3.5 C10.5 3.5 12.5 4.5 14.5 8 C12.5 11.5 10.5 12.5 8 12.5 C5.5 12.5 3.5 11.5 1.5 8 Z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  'eye-off': (
    <path d="M2 10 C4 11.7 6 12.5 8 12.5 C10 12.5 12 11.7 14 10 M4 11.5 L3 13 M8 12.5 V14.5 M12 11.5 L13 13" />
  ),
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="7" rx="1" />
      <path d="M5.5 7 V5 A2.5 2.5 0 0 1 10.5 5 V7" />
    </>
  ),
  unlock: (
    <>
      <rect x="3.5" y="7" width="9" height="7" rx="1" />
      <path d="M5.5 7 V5 A2.5 2.5 0 0 1 10.5 4" />
    </>
  ),
};

/** Whether `name` has an icon. */
export function hasIcon(name: string): boolean {
  return Object.hasOwn(PATHS, name);
}

/** The icon named `name` (a tool ID or an action button's test ID), or null. */
export function Icon({ name }: Readonly<{ name: string }>) {
  if (!hasIcon(name)) return null;
  return (
    <svg
      aria-hidden
      focusable="false"
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinejoin="round"
      strokeLinecap="round"
      style={{ display: 'block' }}
    >
      {PATHS[name]}
    </svg>
  );
}
