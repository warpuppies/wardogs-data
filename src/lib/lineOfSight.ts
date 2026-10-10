/** A point in world meters: [x, y, z] with Z up. */
export type Vec3 = readonly [number, number, number];

/** An axis-aligned box in world meters, as in `buildings.json`. */
export interface Box {
  min: Vec3;
  max: Vec3;
  id?: string;
}

/** Ground height in meters at a world position. */
export type HeightFn = (x: number, y: number) => number;

export interface Obstruction {
  kind: "terrain" | "building";
  /** Where the path is first blocked. */
  at: Vec3;
  /** Meters along the path from its start. */
  distance: number;
  /** The building's id when a building blocks the path. */
  id?: string;
}

export interface PathOptions {
  /** Ground height. Without it, terrain is ignored. */
  terrain?: HeightFn;
  /**
   * Building boxes. Boxes enclose their building, so they can block a path that really passes through a gap or over a
   * pitched roof. A path that starts inside a box is treated as starting at the building: that box does not block it.
   */
  buildings?: readonly Box[];
  /** Spacing in meters of terrain samples along the path. The heightmap is about 2 m per pixel, so 1 to 2 m is enough. Default 1. */
  step?: number;
  /** Meters the path must stay above the ground. Default 0. */
  clearance?: number;
  /**
   * Obstructions within this many meters of either end of the path are ignored. A shooter or a target stands on the
   * ground, and the ground height is only known to about a meter. Default 2.
   */
  endpointMargin?: number;
}

const distance = (a: Vec3, b: Vec3): number => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Where a segment first enters a box, as a fraction of the segment (0 to 1), or null when it misses. A segment that
 * starts inside the box enters at 0.
 */
export function segmentBoxEntry(from: Vec3, to: Vec3, box: Box): number | null {
  let tMin = 0;
  let tMax = 1;
  for (let axis = 0; axis < 3; axis++) {
    const start = from[axis]!;
    const delta = to[axis]! - start;
    const lo = box.min[axis]!;
    const hi = box.max[axis]!;
    if (Math.abs(delta) < 1e-12) {
      if (start < lo || start > hi) return null; // parallel to this slab and outside it
      continue;
    }
    let t1 = (lo - start) / delta;
    let t2 = (hi - start) / delta;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  return tMin;
}

/**
 * The first thing that blocks a path (a polyline of points), or null when it is clear. Buildings are tested exactly
 * against their boxes; terrain is sampled every `step` meters, so a ridge narrower than the step can be missed.
 */
export function firstObstruction(path: readonly Vec3[], options: PathOptions = {}): Obstruction | null {
  const { terrain, buildings = [], step = 1, clearance = 0, endpointMargin = 2 } = options;
  if (path.length < 2) return null;
  if (step <= 0) throw new Error("step must be positive");

  const lengths = path.slice(1).map((p, i) => distance(path[i]!, p));
  const total = lengths.reduce((a, b) => a + b, 0);
  let best: Obstruction | null = null;
  const consider = (candidate: Obstruction) => {
    if (candidate.distance < endpointMargin || candidate.distance > total - endpointMargin) return;
    if (!best || candidate.distance < best.distance) best = candidate;
  };

  let offset = 0;
  for (let i = 0; i < lengths.length; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const length = lengths[i]!;
    if (length === 0) continue;

    for (const box of buildings) {
      // The box is entered where the margin allows: a hit inside the margin is skipped, but the path may still enter later.
      const t = segmentBoxEntry(a, b, box);
      if (t !== null) {
        const d = offset + t * length;
        if (d >= endpointMargin || t > 0) consider({ kind: "building", at: lerp(a, b, t), distance: d, ...(box.id ? { id: box.id } : {}) });
      }
    }

    if (terrain) {
      const samples = Math.max(1, Math.ceil(length / step));
      for (let s = 0; s <= samples; s++) {
        const t = s / samples;
        const p = lerp(a, b, t);
        if (p[2] < terrain(p[0], p[1]) + clearance) consider({ kind: "terrain", at: p, distance: offset + t * length });
      }
    }
    offset += length;
  }
  return best;
}

/** True when the straight line between two points is not blocked. */
export function lineOfSight(from: Vec3, to: Vec3, options: PathOptions = {}): boolean {
  return firstObstruction([from, to], options) === null;
}

/**
 * Points along a parabolic arc from `from` to `to`, for shells. `apexRise` is how many meters the highest point is
 * above the higher of the two ends, so the apex is exact whatever the end heights. Use the points as the path for
 * `firstObstruction`: a small rise approximates direct fire, a large one artillery.
 */
export function ballisticArc(from: Vec3, to: Vec3, apexRise: number, segments = 64): Vec3[] {
  if (apexRise < 0) throw new Error("apexRise must not be negative");
  if (segments < 2) throw new Error("segments must be at least 2");
  // z(t) = z0 + slope * t + 4h * t * (1 - t). Its maximum is (z0 + z1) / 2 + h + slope^2 / (16 h); setting that to the
  // peak gives h^2 - K h + slope^2 / 16 = 0 with K = peak - (z0 + z1) / 2, and the larger root keeps the apex in range.
  const slope = to[2] - from[2];
  const peak = Math.max(from[2], to[2]) + apexRise;
  const k = peak - (from[2] + to[2]) / 2;
  const h = (k + Math.sqrt(Math.max(0, k * k - (slope * slope) / 4))) / 2;
  const points: Vec3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    points.push([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + slope * t + 4 * h * t * (1 - t)]);
  }
  points[0] = from;
  points[segments] = to;
  return points;
}
