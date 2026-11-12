import type { PathVerb } from '@vector-studio/model';
import type { Matrix } from './geometry.js';

// V-33 SVG import contract, V33-M3: SVG path data to the model's verbs (move, line, cubic,
// close), quadratics elevated, arcs as cubics; and the basic shapes as path data.

/** Path geometry in some user space: interleaved points, one per move or line, three per cubic. */
export type Outline = { verbs: PathVerb[]; points: number[] };

export const emptyOutline = (): Outline => ({ verbs: [], points: [] });

const COMMAND = /[MmZzLlHhVvCcSsQqTtAa]/;
/** Operands per command letter. */
const ARITY: Readonly<Record<string, number>> = {
  m: 2,
  l: 2,
  h: 1,
  v: 1,
  c: 6,
  s: 4,
  q: 4,
  t: 2,
  a: 7,
  z: 0,
};

class Scanner {
  at = 0;
  constructor(readonly text: string) {}

  skip(): void {
    while (this.at < this.text.length && /[\s,]/.test(this.text[this.at]!)) this.at += 1;
  }

  skipSpace(): void {
    while (this.at < this.text.length && /\s/.test(this.text[this.at]!)) this.at += 1;
  }

  /** A number (`-1.5e3`, `.5`, `1.5.5` read as `1.5` then `.5`), or null. */
  number(): number | null {
    this.skip();
    const match = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.at));
    if (match === null) return null;
    this.at += match[0].length;
    const value = Number(match[0]);
    return Number.isFinite(value) ? value : null;
  }

  /** An arc flag: one `0` or `1`, which needs no separator after it. */
  flag(): number | null {
    this.skip();
    const character = this.text[this.at];
    if (character !== '0' && character !== '1') return null;
    this.at += 1;
    return character === '1' ? 1 : 0;
  }
}

/**
 * The cubics of the SVG arc from `(x0, y0)` to `(x, y)` (SVG 1.1 implementation notes F.6:
 * endpoint to centre parameterization, radii scaled up when too small), at most one cubic per
 * quarter turn. A zero radius gives a line; equal endpoints give nothing.
 */
export function arcToCubics(
  x0: number,
  y0: number,
  rxIn: number,
  ryIn: number,
  angle: number,
  large: boolean,
  sweep: boolean,
  x: number,
  y: number,
): number[][] {
  if (x0 === x && y0 === y) return [];
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return [[x, y]];
  const phi = (angle * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x0 - x) / 2;
  const dy = (y0 - y) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rx *= scale;
    ry *= scale;
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let coefficient = den === 0 ? 0 : Math.sqrt(Math.max(0, num / den));
  if (large === sweep) coefficient = -coefficient;
  const cx1 = (coefficient * rx * y1) / ry;
  const cy1 = (-coefficient * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (x0 + x) / 2;
  const cy = sin * cx1 + cos * cy1 + (y0 + y) / 2;
  const vector = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const length = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let value = Math.acos(Math.max(-1, Math.min(1, dot / length)));
    if (ux * vy - uy * vx < 0) value = -value;
    return value;
  };
  const theta1 = vector(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let delta = vector((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  else if (sweep && delta < 0) delta += 2 * Math.PI;
  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / segments;
  const k = (4 / 3) * Math.tan(step / 4);
  const point = (t: number) => {
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    return [cos * ex - sin * ey + cx, sin * ex + cos * ey + cy];
  };
  const derivative = (t: number) => {
    const ex = -rx * Math.sin(t);
    const ey = ry * Math.cos(t);
    return [cos * ex - sin * ey, sin * ex + cos * ey];
  };
  const cubics: number[][] = [];
  for (let i = 0; i < segments; i += 1) {
    const a = theta1 + i * step;
    const b = a + step;
    const [ax, ay] = point(a);
    const [bx, by] = i === segments - 1 ? [x, y] : point(b);
    const [dax, day] = derivative(a);
    const [dbx, dby] = derivative(b);
    cubics.push([ax! + k * dax!, ay! + k * day!, bx! - k * dbx!, by! - k * dby!, bx!, by!]);
  }
  return cubics;
}

/**
 * Parses SVG path data (V33-M3). Parsing stops at the first error and keeps the segments before
 * it (SVG 1.1 F.2). A path that does not start with a move draws nothing.
 */
export function parsePathData(data: string): Outline {
  const out = emptyOutline();
  const scanner = new Scanner(data);
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  // The previous segment's second control point, for S and T reflections.
  let lastCubic: [number, number] | null = null;
  let lastQuad: [number, number] | null = null;
  let command = '';
  let first = true;
  let open = false;
  const ensureStart = () => {
    // A segment after `Z` starts at the subpath's start (a new implicit move).
    if (!open) {
      out.verbs.push('move');
      out.points.push(cx, cy);
      open = true;
    }
  };
  for (;;) {
    scanner.skip();
    if (scanner.at >= data.length) break;
    const character = data[scanner.at]!;
    if (COMMAND.test(character)) {
      command = character;
      scanner.at += 1;
    } else if (command === '' || command === 'z' || command === 'Z') {
      break;
    } else if (command === 'm') command = 'l';
    else if (command === 'M') command = 'L';
    if (first && command !== 'm' && command !== 'M') break;
    first = false;
    const lower = command.toLowerCase();
    const relative = command === lower;
    const arity = ARITY[lower]!;
    const values: number[] = [];
    let ok = true;
    for (let i = 0; i < arity; i += 1) {
      const value = lower === 'a' && (i === 3 || i === 4) ? scanner.flag() : scanner.number();
      if (value === null) {
        ok = false;
        break;
      }
      values.push(value);
    }
    if (!ok) break;
    const ox = relative ? cx : 0;
    const oy = relative ? cy : 0;
    switch (lower) {
      case 'm':
        cx = ox + values[0]!;
        cy = oy + values[1]!;
        startX = cx;
        startY = cy;
        out.verbs.push('move');
        out.points.push(cx, cy);
        open = true;
        lastCubic = null;
        lastQuad = null;
        // Later pairs of this command are lines.
        command = relative ? 'l' : 'L';
        continue;
      case 'z':
        if (open) out.verbs.push('close');
        open = false;
        cx = startX;
        cy = startY;
        lastCubic = null;
        lastQuad = null;
        continue;
      case 'l':
      case 'h':
      case 'v': {
        ensureStart();
        if (lower === 'l') {
          cx = ox + values[0]!;
          cy = oy + values[1]!;
        } else if (lower === 'h') cx = ox + values[0]!;
        else cy = oy + values[0]!;
        out.verbs.push('line');
        out.points.push(cx, cy);
        lastCubic = null;
        lastQuad = null;
        continue;
      }
      case 'c':
      case 's': {
        ensureStart();
        let x1: number;
        let y1: number;
        let rest: number[];
        if (lower === 'c') {
          x1 = ox + values[0]!;
          y1 = oy + values[1]!;
          rest = values.slice(2);
        } else {
          x1 = lastCubic === null ? cx : 2 * cx - lastCubic[0];
          y1 = lastCubic === null ? cy : 2 * cy - lastCubic[1];
          rest = values;
        }
        const x2 = ox + rest[0]!;
        const y2 = oy + rest[1]!;
        const x = ox + rest[2]!;
        const y = oy + rest[3]!;
        out.verbs.push('cubic');
        out.points.push(x1, y1, x2, y2, x, y);
        lastCubic = [x2, y2];
        lastQuad = null;
        cx = x;
        cy = y;
        continue;
      }
      case 'q':
      case 't': {
        ensureStart();
        let qx: number;
        let qy: number;
        let x: number;
        let y: number;
        if (lower === 'q') {
          qx = ox + values[0]!;
          qy = oy + values[1]!;
          x = ox + values[2]!;
          y = oy + values[3]!;
        } else {
          qx = lastQuad === null ? cx : 2 * cx - lastQuad[0];
          qy = lastQuad === null ? cy : 2 * cy - lastQuad[1];
          x = ox + values[0]!;
          y = oy + values[1]!;
        }
        // Degree elevation: the cubic's control points are 2/3 of the way to the quadratic's.
        out.verbs.push('cubic');
        out.points.push(
          cx + (2 / 3) * (qx - cx),
          cy + (2 / 3) * (qy - cy),
          x + (2 / 3) * (qx - x),
          y + (2 / 3) * (qy - y),
          x,
          y,
        );
        lastQuad = [qx, qy];
        lastCubic = null;
        cx = x;
        cy = y;
        continue;
      }
      case 'a': {
        ensureStart();
        const x = ox + values[5]!;
        const y = oy + values[6]!;
        const parts = arcToCubics(
          cx,
          cy,
          values[0]!,
          values[1]!,
          values[2]!,
          values[3] === 1,
          values[4] === 1,
          x,
          y,
        );
        for (const part of parts) {
          out.verbs.push(part.length === 2 ? 'line' : 'cubic');
          out.points.push(...part);
        }
        cx = x;
        cy = y;
        lastCubic = null;
        lastQuad = null;
        continue;
      }
    }
  }
  return out;
}

/** A closed polygon or an open polyline through `points` (interleaved). */
export function polyOutline(points: readonly number[], close: boolean): Outline {
  const out = emptyOutline();
  const count = Math.floor(points.length / 2);
  if (count < 1) return out;
  out.verbs.push('move');
  out.points.push(points[0]!, points[1]!);
  for (let i = 1; i < count; i += 1) {
    out.verbs.push('line');
    out.points.push(points[2 * i]!, points[2 * i + 1]!);
  }
  if (close) out.verbs.push('close');
  return out;
}

/** Kappa for a quarter ellipse as one cubic. */
const KAPPA = 0.5522847498307936;

/** An ellipse at centre `(cx, cy)` with radii `rx`, `ry`, clockwise from the right. */
export function ellipseOutline(cx: number, cy: number, rx: number, ry: number): Outline {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return {
    verbs: ['move', 'cubic', 'cubic', 'cubic', 'cubic', 'close'],
    points: [
      cx + rx,
      cy,
      cx + rx,
      cy + ky,
      cx + kx,
      cy + ry,
      cx,
      cy + ry,
      cx - kx,
      cy + ry,
      cx - rx,
      cy + ky,
      cx - rx,
      cy,
      cx - rx,
      cy - ky,
      cx - kx,
      cy - ry,
      cx,
      cy - ry,
      cx + kx,
      cy - ry,
      cx + rx,
      cy - ky,
      cx + rx,
      cy,
    ],
  };
}

/** A rectangle with elliptical corners `rx`, `ry` (already clamped), clockwise from the top. */
export function rectOutline(
  x: number,
  y: number,
  width: number,
  height: number,
  rx: number,
  ry: number,
): Outline {
  if (rx <= 0 || ry <= 0) {
    return polyOutline([x, y, x + width, y, x + width, y + height, x, y + height], true);
  }
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  const r = x + width;
  const b = y + height;
  return {
    verbs: ['move', 'line', 'cubic', 'line', 'cubic', 'line', 'cubic', 'line', 'cubic', 'close'],
    points: [
      x + rx,
      y,
      r - rx,
      y,
      r - rx + kx,
      y,
      r,
      y + ry - ky,
      r,
      y + ry,
      r,
      b - ry,
      r,
      b - ry + ky,
      r - rx + kx,
      b,
      r - rx,
      b,
      x + rx,
      b,
      x + rx - kx,
      b,
      x,
      b - ry + ky,
      x,
      b - ry,
      x,
      y + ry,
      x,
      y + ry - ky,
      x + rx - kx,
      y,
      x + rx,
      y,
    ],
  };
}

/** `outline` with every point mapped through `m`. */
export function transformOutline(outline: Outline, m: Matrix): Outline {
  const points: number[] = [];
  for (let i = 0; i + 1 < outline.points.length; i += 2) {
    const x = outline.points[i]!;
    const y = outline.points[i + 1]!;
    points.push(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]);
  }
  return { verbs: [...outline.verbs], points };
}

/** The extrema parameters in (0, 1) of one cubic coordinate. */
function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const roots: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) roots.push(-c / b);
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      roots.push((-b + root) / (2 * a), (-b - root) / (2 * a));
    }
  }
  return roots.filter((t) => t > 0 && t < 1);
}

const cubicAt = (p0: number, p1: number, p2: number, p3: number, t: number) => {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};

/** The tight bounding box of an outline (curve extrema, not control points), or null if empty. */
export function outlineBounds(
  outline: Outline,
): { x: number; y: number; width: number; height: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  };
  const p = outline.points;
  let at = 0;
  let lastX = 0;
  let lastY = 0;
  for (const verb of outline.verbs) {
    if (verb === 'move' || verb === 'line') {
      lastX = p[at]!;
      lastY = p[at + 1]!;
      add(lastX, lastY);
      at += 2;
    } else if (verb === 'cubic') {
      const xs = [lastX, p[at]!, p[at + 2]!, p[at + 4]!] as const;
      const ys = [lastY, p[at + 1]!, p[at + 3]!, p[at + 5]!] as const;
      for (const t of cubicExtrema(...xs)) add(cubicAt(...xs, t), cubicAt(...ys, t));
      for (const t of cubicExtrema(...ys)) add(cubicAt(...xs, t), cubicAt(...ys, t));
      lastX = xs[3];
      lastY = ys[3];
      add(lastX, lastY);
      at += 6;
    }
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
