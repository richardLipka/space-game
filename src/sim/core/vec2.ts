/** Immutable 2D vector helpers. Units are SI (metres) unless stated otherwise (spec §2). */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export const vec2 = (x: number, y: number): Vec2 => ({ x, y });
export const ZERO: Vec2 = Object.freeze({ x: 0, y: 0 });

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const neg = (a: Vec2): Vec2 => ({ x: -a.x, y: -a.y });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
/** 2D cross product (z component of a × b). Positive = b is counter-clockwise from a. */
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const lengthSq = (a: Vec2): number => a.x * a.x + a.y * a.y;
export const length = (a: Vec2): number => Math.sqrt(lengthSq(a));
export const distance = (a: Vec2, b: Vec2): number => length(sub(a, b));

/** Unit vector; returns ZERO for zero-length input instead of NaN. */
export const normalize = (a: Vec2): Vec2 => {
  const len = length(a);
  return len === 0 ? ZERO : { x: a.x / len, y: a.y / len };
};

/** Rotate counter-clockwise by `angle` radians. */
export const rotate = (a: Vec2, angle: number): Vec2 => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
};

/** Perpendicular, rotated +90° (counter-clockwise). */
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });

export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

/** Unit vector at `angle` radians from +x. */
export const fromAngle = (angle: number): Vec2 => ({ x: Math.cos(angle), y: Math.sin(angle) });
export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x);

/** Signed angle from a to b in (-π, π]. */
export const angleBetween = (a: Vec2, b: Vec2): number => Math.atan2(cross(a, b), dot(a, b));

export const nearlyEqual = (a: Vec2, b: Vec2, eps = 1e-9): boolean =>
  Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;

export const degToRad = (deg: number): number => (deg * Math.PI) / 180;
export const radToDeg = (rad: number): number => (rad * 180) / Math.PI;
