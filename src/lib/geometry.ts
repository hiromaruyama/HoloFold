/** Small 2D geometry kit: vectors, hulls, clipping, homographies, Procrustes fits. */

export interface Vec {
  x: number;
  y: number;
}

export const vec = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Vec, b: Vec, t: number): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const norm = (a: Vec): Vec => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};
export const clamp = (v: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, v));

/** Shoelace area; positive for clockwise-on-screen (y-down) polygons. */
export function signedArea(poly: Vec[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function centroid(poly: Vec[]): Vec {
  const a = signedArea(poly);
  if (Math.abs(a) < 1e-9) {
    const s = poly.reduce((acc, p) => add(acc, p), vec(0, 0));
    return mul(s, 1 / Math.max(1, poly.length));
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  return vec(cx / (6 * a), cy / (6 * a));
}

export function withPositiveArea(poly: Vec[]): Vec[] {
  return signedArea(poly) < 0 ? [...poly].reverse() : poly;
}

/** Andrew's monotone chain. Returns the hull with positive signed area. */
export function convexHull(points: Vec[]): Vec[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const turn = (o: Vec, a: Vec, b: Vec) => cross(sub(a, o), sub(b, o));
  const lower: Vec[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return withPositiveArea(lower.concat(upper));
}

/**
 * Visvalingam–Whyatt: repeatedly drop the vertex whose removal loses the least area
 * until `n` remain. On a convex hull this finds the polygon's true corners.
 */
export function simplifyToN(poly: Vec[], n: number): Vec[] {
  const pts = [...poly];
  const triArea = (i: number) => {
    const a = pts[(i - 1 + pts.length) % pts.length];
    const b = pts[i];
    const c = pts[(i + 1) % pts.length];
    return Math.abs(cross(sub(b, a), sub(c, a)));
  };
  while (pts.length > n) {
    let best = 0;
    let bestArea = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const ar = triArea(i);
      if (ar < bestArea) {
        bestArea = ar;
        best = i;
      }
    }
    pts.splice(best, 1);
  }
  return pts;
}

/** Sutherland–Hodgman against one half-plane: keeps points with dot(p − a, n) ≥ offset. */
export function clipHalfPlane(poly: Vec[], a: Vec, n: Vec, offset = 0): Vec[] {
  if (poly.length === 0) return poly;
  const out: Vec[] = [];
  const side = (p: Vec) => dot(sub(p, a), n) - offset;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const sp = side(p);
    const sq = side(q);
    if (sp >= 0) out.push(p);
    if ((sp >= 0) !== (sq >= 0)) {
      const t = sp / (sp - sq);
      out.push(lerp(p, q, t));
    }
  }
  return out;
}

export function rotateArray<T>(arr: T[], k: number): T[] {
  const n = arr.length;
  return arr.map((_, i) => arr[(i + k) % n]);
}

export function meanDistance(a: Vec[], b: Vec[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += dist(a[i], b[i]);
  return s / Math.max(1, a.length);
}

/** Gaussian elimination with partial pivoting. */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export type Mat3 = number[]; // row-major 3×3

export function mat3Mul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}

export function applyH(H: Mat3, p: Vec): Vec {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w };
}

/** Hartley normalization: centroid to origin, mean distance √2. */
function normalizer(pts: Vec[]): { T: Mat3; Tinv: Mat3 } {
  const c = mul(
    pts.reduce((acc, p) => add(acc, p), vec(0, 0)),
    1 / pts.length,
  );
  const md = pts.reduce((s, p) => s + dist(p, c), 0) / pts.length || 1;
  const s = Math.SQRT2 / md;
  return {
    T: [s, 0, -s * c.x, 0, s, -s * c.y, 0, 0, 1],
    Tinv: [1 / s, 0, c.x, 0, 1 / s, c.y, 0, 0, 1],
  };
}

/**
 * Homography mapping src → dst (least squares for > 4 points, affine for exactly 3).
 */
export function homographyFrom(src: Vec[], dst: Vec[]): Mat3 | null {
  const n = Math.min(src.length, dst.length);
  if (n < 3) return null;
  const ns = normalizer(src.slice(0, n));
  const nd = normalizer(dst.slice(0, n));
  const s = src.slice(0, n).map((p) => applyH(ns.T, p));
  const d = dst.slice(0, n).map((p) => applyH(nd.T, p));

  let Hn: Mat3 | null;
  if (n === 3) {
    // Affine: [a b c; d e f; 0 0 1]
    const A: number[][] = [];
    const b: number[] = [];
    for (let i = 0; i < 3; i++) {
      A.push([s[i].x, s[i].y, 1, 0, 0, 0]);
      b.push(d[i].x);
      A.push([0, 0, 0, s[i].x, s[i].y, 1]);
      b.push(d[i].y);
    }
    const h = solveLinear(A, b);
    Hn = h ? [h[0], h[1], h[2], h[3], h[4], h[5], 0, 0, 1] : null;
  } else {
    // DLT with h33 = 1, solved via normal equations.
    const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
    const Atb = new Array(8).fill(0);
    const addRow = (row: number[], rhs: number) => {
      for (let i = 0; i < 8; i++) {
        Atb[i] += row[i] * rhs;
        for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
      }
    };
    for (let i = 0; i < n; i++) {
      const { x, y } = s[i];
      const { x: u, y: v } = d[i];
      addRow([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
      addRow([0, 0, 0, x, y, 1, -v * x, -v * y], v);
    }
    const h = solveLinear(AtA, Atb);
    Hn = h ? [...h, 1] : null;
  }
  if (!Hn || Hn.some((x) => !Number.isFinite(x))) return null;
  return mat3Mul(nd.Tinv, mat3Mul(Hn, ns.T));
}

/**
 * Best similarity transform (rotation + uniform scale + translation, no reflection)
 * from src onto dst. `err` is the residual relative to dst's spread (0 = perfect).
 */
export function procrustes(src: Vec[], dst: Vec[]): { err: number; angle: number; scale: number } {
  const n = src.length;
  const cs = mul(
    src.reduce((acc, p) => add(acc, p), vec(0, 0)),
    1 / n,
  );
  const cd = mul(
    dst.reduce((acc, p) => add(acc, p), vec(0, 0)),
    1 / n,
  );
  let a = 0;
  let b = 0;
  let ss = 0;
  let sd = 0;
  for (let i = 0; i < n; i++) {
    const p = sub(src[i], cs);
    const q = sub(dst[i], cd);
    a += p.x * q.x + p.y * q.y;
    b += p.x * q.y - p.y * q.x;
    ss += dot(p, p);
    sd += dot(q, q);
  }
  if (ss < 1e-12 || sd < 1e-12) return { err: Infinity, angle: 0, scale: 0 };
  const angle = Math.atan2(b, a);
  const scale = Math.hypot(a, b) / ss;
  // Residual of the optimal fit: sd − scale² · ss
  const resid = Math.max(0, sd - scale * scale * ss);
  return { err: resid / sd, angle, scale };
}
