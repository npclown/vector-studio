import {
  isSceneGradient,
  type SceneAffine,
  type SceneColor,
  type SceneGradient,
  type ScenePaint,
} from '@vector-studio/contracts';

/**
 * E23 contract (docs/plans/d9-e23-gradient-paint-contract.md), unit U2: a gradient paint record.
 * `map` is G = M⁻¹ · W⁻¹ · T(origin), the affine from a document point relative to the record's
 * origin to gradient space, composed in binary64 and rounded once to binary32 (section 4).
 * `offsets` and `colors` hold the stops; colours are premultiplied in binary64 and rounded once.
 * Plain values; unit U3 owns the GPU layout.
 */
export type GradientPaintRecord = Readonly<{
  kind: 'linear' | 'radial';
  spread: SceneGradient['spread'];
  map: readonly number[];
  offsets: readonly number[];
  /** Four premultiplied lanes per stop. */
  colors: readonly number[];
}>;

/** A paint whose colour lanes the solid draw paths use: a gradient packs as transparent. */
export const GRADIENT_COLOR_LANES: SceneColor = Object.freeze({ r: 0, g: 0, b: 0, a: 0 });

/** The solid lanes of a paint: its colour, or transparent for a gradient (E23 U2). */
export function paintColorLanes(paint: ScenePaint): SceneColor {
  return isSceneGradient(paint) ? GRADIENT_COLOR_LANES : paint;
}

type Origin = Readonly<{ x: number; y: number }>;

/**
 * Builds a record, or null when a lane is not finite in binary32 (E23-K8). `world` is the
 * node's world affine and `origin` the packet origin the draw's frame is rebased to.
 */
export function buildGradientRecord(
  gradient: SceneGradient,
  world: SceneAffine,
  origin: Origin,
): GradientPaintRecord | null {
  // W⁻¹ · T(origin): d ↦ W⁻¹(d + origin).
  const local = invert(world);
  if (local === null) return null;
  const rebased: SceneAffine = [
    local[0],
    local[1],
    local[2],
    local[3],
    local[0] * origin.x + local[2] * origin.y + local[4],
    local[1] * origin.x + local[3] * origin.y + local[5],
  ];
  const inverse = invert(gradient.transform);
  if (inverse === null) return null;
  const map = compose(inverse, rebased).map(Math.fround);
  if (!map.every(Number.isFinite)) return null;
  const offsets = gradient.stops.map((stop) => Math.fround(stop.offset));
  const colors = gradient.stops.flatMap(({ color }) =>
    [color.r * color.a, color.g * color.a, color.b * color.a, color.a].map(Math.fround),
  );
  return Object.freeze({
    kind: gradient.kind,
    spread: gradient.spread,
    map: Object.freeze(map),
    offsets: Object.freeze(offsets),
    colors: Object.freeze(colors),
  });
}

type CacheEntry = Readonly<{
  gradient: SceneGradient;
  world: SceneAffine;
  origin: Origin;
  record: GradientPaintRecord | null;
}>;

/**
 * E23 U2: the frame's gradient records. Each frame numbers the drawn gradient paints from 1 in
 * the order they are requested (0 is a solid paint or an out-of-range record). A paint whose
 * gradient values, world affine and origin are unchanged keeps its record object, so `builds`
 * counts records whose values changed: a camera change builds none.
 */
export class GradientRecordTable {
  #cache = new Map<string, CacheEntry>();
  #seen = new Set<string>();
  #records: GradientPaintRecord[] = [];
  #builds = 0;

  public begin(): void {
    this.#seen = new Set();
    this.#records = [];
    this.#builds = 0;
  }

  /** The 1-based record index of a gradient paint, or 0 when it is out of binary32 range. */
  public indexOf(key: string, gradient: SceneGradient, world: SceneAffine, origin: Origin): number {
    this.#seen.add(key);
    let entry = this.#cache.get(key);
    if (
      entry === undefined ||
      !gradientEquals(entry.gradient, gradient) ||
      entry.origin.x !== origin.x ||
      entry.origin.y !== origin.y ||
      !entry.world.every((lane, index) => lane === world[index])
    ) {
      entry = Object.freeze({
        gradient,
        world,
        origin: Object.freeze({ x: origin.x, y: origin.y }),
        record: buildGradientRecord(gradient, world, origin),
      });
      this.#cache.set(key, entry);
      this.#builds += 1;
    }
    if (entry.record === null) return 0;
    this.#records.push(entry.record);
    return this.#records.length;
  }

  /** Ends the frame: entries not requested this frame are released. */
  public end(): Readonly<{ records: readonly GradientPaintRecord[]; builds: number }> {
    for (const key of [...this.#cache.keys()]) {
      if (!this.#seen.has(key)) this.#cache.delete(key);
    }
    return Object.freeze({ records: Object.freeze(this.#records), builds: this.#builds });
  }

  public clear(): void {
    this.#cache.clear();
    this.begin();
  }
}

/** Value equality: the mirror copies nodes on every change, so identity is not stable. */
function gradientEquals(left: SceneGradient, right: SceneGradient): boolean {
  return (
    left === right ||
    (left.kind === right.kind &&
      left.spread === right.spread &&
      left.transform.every((lane, index) => lane === right.transform[index]) &&
      left.stops.length === right.stops.length &&
      left.stops.every((stop, index) => {
        const other = right.stops[index]!;
        return (
          stop.offset === other.offset &&
          stop.color.r === other.color.r &&
          stop.color.g === other.color.g &&
          stop.color.b === other.color.b &&
          stop.color.a === other.color.a
        );
      }))
  );
}

function invert([a, b, c, d, e, f]: SceneAffine): SceneAffine | null {
  const determinant = a * d - b * c;
  if (determinant === 0 || !Number.isFinite(determinant)) return null;
  const inverse: SceneAffine = [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant,
  ];
  return inverse.every(Number.isFinite) ? inverse : null;
}

/** left · right: right is applied first. */
function compose(left: SceneAffine, right: SceneAffine): SceneAffine {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}
