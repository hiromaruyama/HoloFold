/**
 * Finds the sheet of paper in a video frame and fits the current step's outline to it.
 *
 * Pipeline (cv-assisted-origami's contour → polygon → homography idea, made robust for
 * hands, shadows, two-sided paper and tilted views):
 *   1. Downsample the frame and convert it to YCbCr planes.
 *   2. Color models. Background: k-means clusters sampled from the frame border (while
 *      searching) or from everything outside the last detection (while tracking), plus a
 *      fixed skin cluster so hands never count as paper. Paper: up to three clusters
 *      (colored front, white back, shaded paper) learned from inside good detections.
 *   3. Each pixel is paper if the paper model explains it better than the background does,
 *      with a spatial prior around where the paper was last frame.
 *   4. Clean the mask, pick the blob, take its convex hull, reduce it to the outline's corner
 *      count, then refit every edge as a straight line through sub-pixel color-edge samples
 *      (fingers and shadows become outliers) and intersect neighbouring edges.
 *   5. Order corners (Procrustes + previous frame), check the fit is a plausible camera view
 *      of the outline and actually explains the blob, then homography + One-Euro smoothing.
 *   When the paper is lost it searches the whole frame: regions unlike the border, the
 *   frame center, and the last known paper colors are all tried and the best fit wins.
 * It also reports whether the paper has been still for a moment ("hands away"), which is
 * when an AI check makes sense (Origami Sensei treats hand-occluded frames as transitions).
 */
import {
  centroid,
  clamp,
  convexHull,
  dist,
  homographyFrom,
  lerp,
  meanDistance,
  procrustes,
  rotateArray,
  signedArea,
  simplifyToN,
  applyH,
  type Mat3,
  type Vec,
} from "./geometry";

export interface TrackResult {
  found: boolean;
  /** Detected corners in video pixels, ordered to match the expected hull. */
  corners: Vec[];
  /** Paper-space (real step coords) → video pixels. */
  H: Mat3 | null;
  quality: number;
  stable: boolean;
  /** 0–1 how long the paper has been still, relative to the stability window. */
  stillness: number;
  motion: number;
  areaFrac: number;
  videoW: number;
  videoH: number;
  /**
   * Which outline the paper shows: the step's starting one ("before"), the finished one
   * ("after"), neither ("other"), or null when it can't be told (paper not seen, last step).
   */
  match: "before" | "after" | "other" | null;
  /** Corners of the finished outline in video pixels while match is "after". */
  afterCorners: Vec[] | null;
  /** Share of skin-colored pixels on and just around the paper (hands on it). */
  hands: number;
}

/** Pixels analyzed per frame (320×180 for 16:9, 180×320 for a phone held upright). */
const WORK_PX = 320 * 180;
/** While tracking, analyze a window this many times the paper's size at full detail. */
const ROI_ZOOM = 2;
/** Shape-match tolerance (Procrustes error) on the table plane / in the raw image. */
const TOL_PLANE = 0.014;
const TOL_IMAGE = 0.03;
/** The table-plane map is dropped after this long without being confirmed. */
const PLANE_MAX_AGE = 120000;
/** A steady sheet that matches nothing for this long means the camera moved: re-learn the plane. */
const RESEED_MS = 3000;
/** Smallest region (share of the analyzed image) that can be the paper. */
const MIN_BLOB = 0.0022;
/** Brightness step (0–255, per pixel) that counts as a strong edge when judging clutter. */
const EDGE_STRONG = 8;
const STILL_MS = 900;
/** Keep showing the last lock this long when a frame fails (a hand passing over). */
const GRACE_MS = 400;
/** After this long without a lock, search the whole frame again. */
const LOST_MS = 300;
/** Forget learned paper colors after this long without a lock. */
const FORGET_MS = 4000;

// Variance limits (YCbCr units²). Paper gets a wide luma floor because lighting varies
// across the sheet; chroma floors cover sensor noise.
const VY_PAPER = 18 * 18;
const VY_BG = 7 * 7;
const VY_MAX = 45 * 45;
const VC_MIN = 3.5 * 3.5;
const VC_MAX = 20 * 20;
/** Luma weight in k-means distances: hue separates surfaces better than brightness. */
const KM_LUMA = 0.5;

// Spatial prior (log-odds added in favor of paper).
const PAPER_BIAS = 0.5;
const PRIOR_IN = 1.5;
const PRIOR_OUT = 2.5;

// One-Euro filter (per corner, speed measured in paper sizes per second).
const EURO_MIN_HZ = 1.4;
const EURO_BETA = 8;
const EURO_D_HZ = 1.2;

interface Cluster {
  y: number;
  cb: number;
  cr: number;
  vy: number;
  vcb: number;
  vcr: number;
  /** Share of the samples this cluster came from. */
  w: number;
  iy: number;
  ib: number;
  ir: number;
  /** ½·log det, the Gaussian normalizer. */
  ld: number;
}

function cluster(y: number, cb: number, cr: number, vy: number, vcb: number, vcr: number, w: number, vyFloor: number): Cluster {
  vy = clamp(vy, vyFloor, VY_MAX);
  vcb = clamp(vcb, VC_MIN, VC_MAX);
  vcr = clamp(vcr, VC_MIN, VC_MAX);
  return { y, cb, cr, vy, vcb, vcr, w, iy: 1 / vy, ib: 1 / vcb, ir: 1 / vcr, ld: 0.5 * Math.log(vy * vcb * vcr) };
}

/** Skin tones sit in a narrow Cb/Cr band at any brightness. */
const SKIN = cluster(150, 110, 150, 55 * 55, 8 * 8, 9 * 9, 1, VY_BG);

function mahal(c: Cluster, y: number, cb: number, cr: number) {
  const dy = y - c.y;
  const db = cb - c.cb;
  const dr = cr - c.cr;
  return dy * dy * c.iy + db * db * c.ib + dr * dr * c.ir;
}

/**
 * Distance to a paper color that allows for shading: in a shadow both brightness and
 * color saturation drop together (Cb/Cr scale toward neutral with Y), so compare the
 * chroma to the paper's chroma scaled to this pixel's brightness.
 */
function mahalPaper(c: Cluster, y: number, cb: number, cr: number) {
  const k = clamp(y / Math.max(1, c.y), 0.45, 1.25);
  const dy = y - c.y;
  const db = cb - (128 + (c.cb - 128) * k);
  const dr = cr - (128 + (c.cr - 128) * k);
  return dy * dy * c.iy + db * db * c.ib + dr * dr * c.ir;
}

/** Strongly skin-like: in the skin band and clearly warmer (Cr) than bluish (Cb). */
function skinLike(c: { y: number; cb: number; cr: number }) {
  return c.cr - c.cb > 22 && mahal(SKIN, c.y, c.cb, c.cr) < 6;
}

/** k-means (farthest-point init) over packed [y, cb, cr] samples → clusters with variances. */
function kmeans(s: Float32Array, n: number, K: number, vyFloor: number, minShare = 0.02, iters = 6): Cluster[] {
  if (n === 0) return [];
  K = Math.min(K, n);
  const cy = new Float64Array(K);
  const cb = new Float64Array(K);
  const cr = new Float64Array(K);
  const d2 = (i: number, k: number) => {
    const a = (s[i * 3] - cy[k]) * KM_LUMA;
    const b = s[i * 3 + 1] - cb[k];
    const c = s[i * 3 + 2] - cr[k];
    return a * a + b * b + c * c;
  };
  const minD = new Float64Array(n).fill(Infinity);
  let idx = n >> 1;
  for (let k = 0; k < K; k++) {
    cy[k] = s[idx * 3];
    cb[k] = s[idx * 3 + 1];
    cr[k] = s[idx * 3 + 2];
    let far = 0;
    for (let i = 0; i < n; i++) {
      const d = d2(i, k);
      if (d < minD[i]) minD[i] = d;
      if (minD[i] > minD[far]) far = i;
    }
    idx = far;
  }
  const assign = new Int32Array(n);
  const cnt = new Float64Array(K);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bd = Infinity;
      for (let k = 0; k < K; k++) {
        const d = d2(i, k);
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
      assign[i] = best;
    }
    cy.fill(0);
    cb.fill(0);
    cr.fill(0);
    cnt.fill(0);
    for (let i = 0; i < n; i++) {
      const k = assign[i];
      cy[k] += s[i * 3];
      cb[k] += s[i * 3 + 1];
      cr[k] += s[i * 3 + 2];
      cnt[k]++;
    }
    for (let k = 0; k < K; k++) {
      if (!cnt[k]) continue;
      cy[k] /= cnt[k];
      cb[k] /= cnt[k];
      cr[k] /= cnt[k];
    }
  }
  const vy = new Float64Array(K);
  const vb = new Float64Array(K);
  const vr = new Float64Array(K);
  for (let i = 0; i < n; i++) {
    const k = assign[i];
    vy[k] += (s[i * 3] - cy[k]) ** 2;
    vb[k] += (s[i * 3 + 1] - cb[k]) ** 2;
    vr[k] += (s[i * 3 + 2] - cr[k]) ** 2;
  }
  const out: Cluster[] = [];
  for (let k = 0; k < K; k++) {
    if (cnt[k] < Math.max(3, n * minShare)) continue;
    out.push(cluster(cy[k], cb[k], cr[k], vy[k] / cnt[k], vb[k] / cnt[k], vr[k] / cnt[k], cnt[k] / n, vyFloor));
  }
  return out;
}

/** Fold freshly measured paper clusters into the current model without jumping. */
function blendModels(old: Cluster[], fresh: Cluster[], rate: number, keepFirst: boolean): Cluster[] {
  const out = old.map((c) => ({ ...c }));
  for (const f of fresh) {
    let bi = -1;
    let bd = Infinity;
    out.forEach((c, i) => {
      const d = mahal(c, f.y, f.cb, f.cr);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    });
    if (bi >= 0 && bd < 9) {
      if (keepFirst && bi === 0) continue;
      const c = out[bi];
      const m = (a: number, b: number) => a + (b - a) * rate;
      out[bi] = cluster(m(c.y, f.y), m(c.cb, f.cb), m(c.cr, f.cr), m(c.vy, f.vy), m(c.vcb, f.vcb), m(c.vcr, f.vcr), m(c.w, f.w), VY_PAPER);
    } else if (f.w > 0.15) {
      out.push(f);
    }
  }
  // At most three: drop the smallest, but never a tap-locked first cluster.
  while (out.length > 3) {
    let wi = keepFirst ? 1 : 0;
    for (let i = wi; i < out.length; i++) if (out[i].w < out[wi].w) wi = i;
    out.splice(wi, 1);
  }
  return out;
}

/** Fit a straight line to points, discarding outliers (fingers, shadows, creases). */
function robustLine(pts: Vec[]): { p: Vec; d: Vec; inliers: number } | null {
  let use = pts;
  let line: { p: Vec; d: Vec } | null = null;
  for (let pass = 0; pass < 3; pass++) {
    if (use.length < 4) return null;
    let mx = 0;
    let my = 0;
    for (const q of use) {
      mx += q.x;
      my += q.y;
    }
    mx /= use.length;
    my /= use.length;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (const q of use) {
      const ex = q.x - mx;
      const ey = q.y - my;
      sxx += ex * ex;
      sxy += ex * ey;
      syy += ey * ey;
    }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    line = { p: { x: mx, y: my }, d: { x: Math.cos(th), y: Math.sin(th) } };
    const res = pts.map((q) => Math.abs(-(q.x - mx) * line!.d.y + (q.y - my) * line!.d.x));
    const sorted = [...res].sort((a, b) => a - b);
    const tol = Math.max(0.6, 2.5 * sorted[sorted.length >> 1]);
    use = pts.filter((_, i) => res[i] <= tol);
  }
  return line ? { ...line, inliers: use.length } : null;
}

function intersect(l1: { p: Vec; d: Vec }, l2: { p: Vec; d: Vec }): Vec | null {
  const den = l1.d.x * l2.d.y - l1.d.y * l2.d.x;
  if (Math.abs(den) < 0.15) return null; // nearly parallel
  const t = ((l2.p.x - l1.p.x) * l2.d.y - (l2.p.y - l1.p.y) * l2.d.x) / den;
  return { x: l1.p.x + l1.d.x * t, y: l1.p.y + l1.d.y * t };
}

/**
 * Cleaning the mask rounds the paper's corners, so hull vertices sit slightly inside the
 * true corners. Fit a line to the boundary samples along the middle of each edge and
 * intersect neighbouring edges to recover sharp corners.
 */
export function refineCorners(corners: Vec[], samples: Vec[]): Vec[] {
  // Coarse pass with a wide band (the starting corners can be several pixels off),
  // then a tight pass around the improved edges.
  const coarse = refinePass(corners, samples, 0.1, 4);
  return refinePass(coarse, samples, 0.03, 2);
}

function refinePass(corners: Vec[], samples: Vec[], bandFrac: number, bandMin: number): Vec[] {
  const n = corners.length;
  const lines: ({ p: Vec; d: Vec } | null)[] = [];
  let minEdge = Infinity;
  for (let i = 0; i < n; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % n];
    const L = dist(a, b);
    if (L < 6) {
      lines.push(null);
      continue;
    }
    minEdge = Math.min(minEdge, L);
    const ux = (b.x - a.x) / L;
    const uy = (b.y - a.y) / L;
    const band = Math.max(bandMin, L * bandFrac);
    const near: Vec[] = [];
    for (const p of samples) {
      const rx = p.x - a.x;
      const ry = p.y - a.y;
      const t = (rx * ux + ry * uy) / L;
      if (t < 0.2 || t > 0.8 || Math.abs(-rx * uy + ry * ux) > band) continue;
      near.push(p);
    }
    lines.push(near.length >= 5 ? robustLine(near) : null);
  }
  return corners.map((c, i) => {
    const l1 = lines[(i - 1 + n) % n];
    const l2 = lines[i];
    if (!l1 || !l2) return c;
    const q = intersect(l1, l2);
    return q && dist(q, c) < Math.max(6, minEdge * 0.2) ? q : c;
  });
}

/**
 * Pick the outline's corners from the blob's convex hull. When a hand hides a corner the
 * hull has a short "chamfer" edge across it; simply dropping hull vertices would cut that
 * corner off. Instead keep the n longest straight hull edges and extend them until they
 * meet, which puts the hidden corner back where it really is.
 */
export function cornersFromHull(hull: Vec[], n: number): Vec[] {
  const base = simplifyToN(hull, n);
  if (hull.length <= n) return base;
  let P = simplifyToN(hull, Math.min(hull.length, n + 3));
  // Merge vertices where the outline barely turns (one edge split in two).
  for (let changed = true; changed && P.length > n; ) {
    changed = false;
    for (let i = 0; i < P.length && P.length > n; i++) {
      const a = P[(i - 1 + P.length) % P.length];
      const b = P[i];
      const c = P[(i + 1) % P.length];
      const t1 = Math.atan2(b.y - a.y, b.x - a.x);
      const t2 = Math.atan2(c.y - b.y, c.x - b.x);
      let turn = Math.abs(t2 - t1);
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      if (turn < 0.17) {
        P.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  const m = P.length;
  if (m === n) return P;
  if (m < n) return base;
  const size = Math.sqrt(Math.abs(signedArea(P))) || 1;
  const lens = P.map((a, i) => dist(a, P[(i + 1) % m]));
  const lines = P.map((a, i) => {
    const b = P[(i + 1) % m];
    return { p: a, d: { x: (b.x - a.x) / (lens[i] || 1), y: (b.y - a.y) / (lens[i] || 1) } };
  });
  let best: Vec[] | null = null;
  let bestLen = -1;
  const pick: number[] = [];
  const visit = (start: number) => {
    if (pick.length === n) {
      let total = 0;
      for (const i of pick) total += lens[i];
      if (total <= bestLen) return;
      const out: Vec[] = [];
      for (let k = 0; k < n; k++) {
        const q = intersect(lines[pick[(k - 1 + n) % n]], lines[pick[k]]);
        if (!q) return;
        // Don't extrapolate wildly: the corner must stay near the hull vertices it replaces.
        const from = pick[(k - 1 + n) % n];
        let near = Infinity;
        for (let j = from; ; j = (j + 1) % m) {
          near = Math.min(near, dist(q, P[(j + 1) % m]));
          if ((j + 1) % m === pick[k]) break;
        }
        if (near > 0.45 * size) return;
        out.push(q);
      }
      for (let k = 0; k < n; k++) {
        const a = out[k];
        const b = out[(k + 1) % n];
        const c = out[(k + 2) % n];
        if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) <= 0) return;
      }
      bestLen = total;
      best = out;
      return;
    }
    for (let i = start; i <= m - (n - pick.length); i++) {
      pick.push(i);
      visit(i + 1);
      pick.pop();
    }
  };
  visit(0);
  return best ?? base;
}

/** Rows a convex polygon covers: [xmin, xmax] per pixel row (NaN when the row misses it). */
function rowSpans(poly: Vec[], h: number): Float32Array {
  const spans = new Float32Array(h * 2).fill(NaN);
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    if (a.y === b.y) continue;
    const y0 = Math.max(0, Math.ceil(Math.min(a.y, b.y) - 0.5));
    const y1 = Math.min(h - 1, Math.floor(Math.max(a.y, b.y) - 0.5));
    for (let y = y0; y <= y1; y++) {
      const t = (y + 0.5 - a.y) / (b.y - a.y);
      const x = a.x + (b.x - a.x) * t;
      const lo = spans[y * 2];
      if (Number.isNaN(lo) || x < lo) spans[y * 2] = x;
      const hi = spans[y * 2 + 1];
      if (Number.isNaN(hi) || x > hi) spans[y * 2 + 1] = x;
    }
  }
  return spans;
}

function scalePoly(poly: Vec[], s: number): Vec[] {
  const c = centroid(poly);
  return poly.map((p) => ({ x: c.x + (p.x - c.x) * s, y: c.y + (p.y - c.y) * s }));
}

/** Singular-value ratio of the homography's Jacobian at p (1 = viewed head-on), and its determinant. */
function jacobian(H: Mat3, p: Vec): { aniso: number; det: number; w: number } {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  const u = (H[0] * p.x + H[1] * p.y + H[2]) / w;
  const v = (H[3] * p.x + H[4] * p.y + H[5]) / w;
  const a = (H[0] - u * H[6]) / w;
  const b = (H[1] - u * H[7]) / w;
  const c = (H[3] - v * H[6]) / w;
  const d = (H[4] - v * H[7]) / w;
  const E = (a + d) / 2;
  const F = (a - d) / 2;
  const G = (c + b) / 2;
  const Hh = (c - b) / 2;
  const Q = Math.hypot(E, Hh);
  const R = Math.hypot(F, G);
  const s2 = Math.abs(Q - R);
  return { aniso: s2 > 1e-12 ? (Q + R) / s2 : Infinity, det: a * d - b * c, w };
}

class OneEuro {
  private x: Vec[] | null = null;
  private speed: number[] = [];
  private t = 0;

  reset() {
    this.x = null;
  }

  filter(pts: Vec[], now: number, size: number): Vec[] {
    if (!this.x || this.x.length !== pts.length) {
      this.x = pts.map((p) => ({ ...p }));
      this.speed = pts.map(() => 0);
      this.t = now;
      return this.x;
    }
    const dt = Math.max(0.001, (now - this.t) / 1000);
    this.t = now;
    const alpha = (hz: number) => 1 / (1 + 1 / (2 * Math.PI * hz * dt));
    const ad = alpha(EURO_D_HZ);
    this.x = this.x.map((prev, i) => {
      const v = dist(pts[i], prev) / dt / size;
      this.speed[i] += (v - this.speed[i]) * ad;
      return lerp(prev, pts[i], alpha(EURO_MIN_HZ + EURO_BETA * this.speed[i]));
    });
    return this.x;
  }
}

interface Blob {
  label: number;
  area: number;
  cx: number;
  cy: number;
  border: number;
  inPrior: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

interface Fit {
  /** Work-resolution corners, ordered to match the expected hull. */
  corners: Vec[];
  err: number;
  coverage: number;
  outside: number;
  support: number;
  areaFrac: number;
  ok: boolean;
  score: number;
}

/** Do two step outlines differ in shape (ignoring size, position and rotation)? */
export function outlinesDiffer(a: Vec[], b: Vec[]): boolean {
  if (a.length !== b.length) return true;
  let best = Infinity;
  for (let k = 0; k < a.length; k++) best = Math.min(best, procrustes(a, rotateArray(b, k)).err);
  return best > 0.02;
}

export class PaperTracker {
  tolerance = 40;

  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private w = 0;
  private h = 0;
  private Y = new Float32Array(0);
  private CB = new Float32Array(0);
  private CR = new Float32Array(0);
  private mask = new Uint8Array(0);
  private tmp = new Uint8Array(0);
  private skin = new Uint8Array(0);
  private prior = new Int8Array(0);
  private labels = new Int32Array(0);
  private queue = new Int32Array(0);
  private samples = new Float32Array(0);
  private hasImage = false;
  private fg = new Uint8Array(0);
  /** The colors being segmented are skin-toned: only accept crisp, straight-edged shapes. */
  private strictShape = false;

  private paper: Cluster[] = [];
  private bg: Cluster[] = [];
  private locked = false;
  private tap: { x: number; y: number; until: number } | null = null;
  private tapV: { x: number; y: number; until: number } | null = null;
  private pendingTap: { nx: number; ny: number } | null = null;
  /** Counts up while a large paper-like region runs off the picture and nothing is locked. */
  private cutFrames = 0;
  private cutNow = false;

  // The analyzed window of the video: origin in video px, video px per work px.
  private roi = { x: 0, y: 0, sx: 1, sy: 1 };
  private zoomed = false;
  private vw = 0;
  private vh = 0;
  private mid: HTMLCanvasElement | null = null;
  private midCtx: CanvasRenderingContext2D | null = null;
  /** Last accepted outline and its per-frame velocity in video px (survive window changes). */
  private polyV: Vec[] | null = null;
  private velV: Vec[] | null = null;

  // New-frame detection.
  private watched: unknown = null;
  private frameSeq = 0;
  private seenSeq = -1;
  private rvfcBroken = false;

  // Step progress: video px → table plane (metric up to scale while the camera is still).
  private G: Mat3 | null = null;
  private gAt = 0;
  private refArea: number | null = null;
  private hullDiff = false;
  private otherSince = 0;
  private prevAfter: Vec[] | null = null;

  /** Last accepted fit, work-res corners (prior for the next frame). */
  private lastPoly: Vec[] | null = null;
  private velocity: Vec[] | null = null;
  private loosePrior = false;
  private euro = new OneEuro();
  private prevRaw: Vec[] | null = null;
  private key = "";
  private frame = 0;
  private stillSince = 0;
  private lastFound: TrackResult | null = null;
  private lastFoundAt = -Infinity;
  private lastLockAt = -Infinity;
  private lastResult: TrackResult | null = null;
  private lastVideoTime = -1;
  private lastProcessAt = 0;

  get calibrated() {
    return this.locked;
  }

  get maskSize() {
    return { w: this.w, h: this.h };
  }

  /** Where the mask sits in the video frame (0–1): the tracker zooms in on small paper. */
  get maskRect() {
    const { roi, w, h, vw, vh } = this;
    if (!vw || !vh) return { x: 0, y: 0, w: 1, h: 1 };
    return { x: roi.x / vw, y: roi.y / vh, w: (roi.sx * w) / vw, h: (roi.sy * h) / vh };
  }

  /** True when what looks like the paper is cut off by the edge of the picture. */
  get cutOff(): boolean {
    return this.cutFrames >= 5;
  }

  /** Sample the paper color at normalized video coordinates (from a tap) on the next frame. */
  calibrate(nx: number, ny: number) {
    if (!this.hasImage) return;
    this.pendingTap = { nx, ny };
    // Look at the whole frame again: the tap may be outside the zoomed window.
    this.polyV = null;
    this.lastPoly = null;
    this.lastLockAt = -Infinity;
  }

  private applyTap(now: number) {
    const t = this.pendingTap!;
    this.pendingTap = null;
    const c = this.sampleCluster(t.nx * this.w, t.ny * this.h, 3);
    if (!c) return;
    this.paper = [c];
    this.locked = true;
    this.tapV = { x: t.nx * this.vw, y: t.ny * this.vh, until: now + 1500 };
    this.tap = { x: t.nx * this.w, y: t.ny * this.h, until: now + 1500 };
    this.euro.reset();
  }

  resetCalibration() {
    this.locked = false;
    this.paper = [];
    this.tap = null;
    this.tapV = null;
    this.polyV = null;
    this.lastPoly = null;
    this.lastLockAt = -Infinity;
    this.euro.reset();
  }

  /** Paint the current paper mask (cyan) and skin (dim magenta) for the debug view. */
  paintMask(target: ImageData) {
    const { data } = target;
    for (let i = 0; i < this.mask.length && i * 4 < data.length; i++) {
      const on = this.mask[i];
      const sk = !on && this.skin[i];
      data[i * 4] = on ? 56 : sk ? 90 : 4;
      data[i * 4 + 1] = on ? 249 : sk ? 20 : 10;
      data[i * 4 + 2] = on ? 255 : sk ? 70 : 22;
      data[i * 4 + 3] = 255;
    }
  }

  /**
   * @param nextHull outline the paper has once this step is done (the next step's starting
   *   outline), or null. With it the result says whether the paper still shows the starting
   *   outline or already the finished one.
   */
  process(video: HTMLVideoElement, stepKey: string, expectedHull: Vec[], now: number, nextHull: Vec[] | null = null): TrackResult {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const empty: TrackResult = {
      found: false,
      corners: [],
      H: null,
      quality: 0,
      stable: false,
      stillness: 0,
      motion: 1,
      areaFrac: 0,
      videoW: vw,
      videoH: vh,
      match: null,
      afterCorners: null,
      hands: 0,
    };
    if (!vw || !vh || expectedHull.length < 3) return empty;
    // Displays refresh faster than cameras: don't re-analyze the same video frame.
    if (this.isRepeat(video, stepKey, now)) return this.lastResult!;
    this.lastProcessAt = now;

    const n = expectedHull.length;
    const next = nextHull && nextHull.length >= 3 ? nextHull : null;
    if (stepKey !== this.key) {
      // A new step changes the outline but not the paper: keep colors and location.
      this.key = stepKey;
      this.euro.reset();
      this.prevRaw = null;
      this.velV = null;
      this.stillSince = 0;
      this.lastFound = null;
      this.loosePrior = true;
      this.refArea = null;
      this.prevAfter = null;
      this.otherSince = 0;
      this.hullDiff = next ? outlinesDiffer(expectedHull, next) : false;
    }
    if (now - this.lastLockAt > FORGET_MS && !this.locked) this.paper = [];
    if (this.G && now - this.gAt > PLANE_MAX_AGE) this.G = null;
    if (this.tapV && now > this.tapV.until) this.tapV = null;

    const tracking = this.polyV !== null && now - this.lastLockAt < LOST_MS && this.paper.length > 0 && !this.pendingTap;
    this.grab(video, tracking ? this.pickRoi(vw, vh) : null);
    this.frame++;
    this.cutFrames = this.cutNow && !this.lastResult?.found ? Math.min(12, this.cutFrames + 1) : Math.max(0, this.cutFrames - 2);
    this.cutNow = false;
    if (this.pendingTap) this.applyTap(now);

    let fit: Fit | null = null;
    let fitA: Fit | null = null;
    if (tracking) {
      ({ fit, fitA } = this.trackFit(expectedHull, next));
      // The paper left the zoomed window: look at the whole frame again.
      if (!fit?.ok && !fitA?.ok && this.zoomed) this.grab(video, null);
    }
    if (!fit?.ok && !fitA?.ok) {
      fit = this.search(expectedHull, now);
      fitA = null;
      if (next && this.paper.length && (!fit?.ok || next.length !== n)) {
        if (!fit?.ok) {
          const near = this.lastPoly !== null && now - this.lastLockAt < 1000;
          if (near) this.buildPrior(this.lastPoly!, 1.6, 2.4);
          this.segment(this.paper, near);
        }
        fitA = this.fitBest(next, false, null);
      }
    }

    const { roi } = this;
    const toV = (p: Vec): Vec => ({ x: roi.x + p.x * roi.sx, y: roi.y + p.y * roi.sy });
    const rawA = next && fitA?.ok ? fitA.corners.map(toV) : null;
    const hands = this.handShare(fit?.ok ? fit.corners : fitA?.ok ? fitA.corners : null);

    if (!fit || !fit.ok) {
      const held = this.grace(empty, now);
      if (!rawA || !next) {
        this.prevAfter = null;
        return held;
      }
      // Not the starting outline any more, but the finished one fits: keep following the paper.
      const sizeA = Math.sqrt(Math.abs(signedArea(rawA))) || 1;
      const motionA = this.prevAfter && this.prevAfter.length === rawA.length ? meanDistance(rawA, this.prevAfter) / sizeA : 1;
      this.prevAfter = rawA;
      this.polyV = rawA;
      this.lastPoly = fitA!.corners;
      this.velV = null;
      this.velocity = null;
      this.lastLockAt = now;
      this.loosePrior = false;
      const shapeOk = !this.G || this.shapeErr(next, rawA) < TOL_PLANE;
      const out: TrackResult = { ...held, motion: motionA, match: shapeOk ? "after" : "other", afterCorners: rawA, hands };
      this.lastResult = out;
      return out;
    }
    this.prevAfter = null;

    // Accept.
    const raw = fit.corners.map(toV);
    const size = Math.sqrt(Math.abs(signedArea(raw))) || 1;
    const motion = this.prevRaw && this.prevRaw.length === n ? meanDistance(raw, this.prevRaw) / size : 1;
    if (this.prevRaw && this.prevRaw.length === n && this.polyV && this.polyV.length === n && motion < 0.3) {
      this.velV = raw.map((p, i) => ({ x: p.x - this.polyV![i].x, y: p.y - this.polyV![i].y }));
    } else {
      this.velV = null;
    }
    this.prevRaw = raw;
    if (motion > 0.3) this.euro.reset();
    const smooth = this.euro.filter(raw, now, size);
    const H = homographyFrom(expectedHull, smooth);
    if (!H) return this.grace(empty, now);
    this.polyV = raw;
    this.lastPoly = fit.corners;
    this.lastLockAt = now;
    this.loosePrior = false;

    const quality = clamp((fit.coverage - 0.7) / 0.25) * clamp(1 - fit.outside / 0.2) * clamp(0.4 + fit.support);
    // Keep the color model current: learn from the inside of confident, steady fits.
    if (quality > 0.6 && motion < 0.04 && this.frame % 8 === 0) this.learnPaper(fit.corners);

    if (motion < 0.012) {
      if (!this.stillSince) this.stillSince = now;
    } else if (motion > 0.02) {
      this.stillSince = 0;
    }
    const stillness = this.stillSince ? clamp((now - this.stillSince) / STILL_MS) : 0;

    let match: TrackResult["match"] = null;
    let afterCorners: Vec[] | null = null;
    if (next) {
      const tol = this.G ? TOL_PLANE : TOL_IMAGE;
      const errB = this.shapeErr(expectedHull, raw);
      if (this.hullDiff && next.length !== n) {
        // Different corner counts: which outline explains the paper region better?
        const errA = rawA ? this.shapeErr(next, rawA) : Infinity;
        const gain = rawA ? fitA!.coverage * (1 - fitA!.outside) - fit.coverage * (1 - fit.outside) : -1;
        // Without the table plane a tilted view can pass for either outline: ask for both signs.
        const after = errA < tol && (this.G ? errB >= tol || gain > 0.03 : errB >= tol && gain > 0.03);
        match = after ? "after" : errB < tol ? "before" : "other";
        if (after) afterCorners = rawA;
      } else if (this.hullDiff) {
        // Same corner count, different proportions: only the table plane can tell a
        // folded sheet from a tilted one.
        const errA = this.G ? this.shapeErr(next, raw) : Infinity;
        const after = errA < tol && errA + 0.008 < errB;
        match = after ? "after" : errB < tol ? "before" : "other";
        if (after) afterCorners = raw;
      } else {
        // Same outline before and after: a fold can only make it smaller on the table.
        const r = this.G && this.refArea ? this.planeArea(raw) / this.refArea : 1;
        match = errB >= tol ? "other" : r < 0.8 ? "after" : r > 0.87 && r < 1.15 ? "before" : "other";
        if (match === "after") afterCorners = raw;
      }

      // Learn the table plane from steady, confident views of the starting outline.
      if (stillness >= 0.5 && quality > 0.6) {
        if (match === "other") this.otherSince ||= now;
        else this.otherSince = 0;
        const moved = this.otherSince > 0 && now - this.otherSince > RESEED_MS;
        const confirm = match === "before" && this.G !== null;
        if (!this.G || moved || (confirm && n >= 4 && now - this.gAt > 500)) {
          const g = homographyFrom(raw, expectedHull);
          if (g) {
            this.G = g;
            this.gAt = now;
            this.refArea = this.planeArea(raw);
            this.otherSince = 0;
          }
        } else if (confirm) {
          this.gAt = now;
          this.refArea ??= this.planeArea(raw);
        }
      }
    }

    const result: TrackResult = {
      found: true,
      corners: smooth,
      H,
      quality,
      stable: stillness >= 1,
      stillness,
      motion,
      areaFrac: Math.abs(signedArea(raw)) / (vw * vh),
      videoW: vw,
      videoH: vh,
      match,
      afterCorners,
      hands,
    };
    this.lastFound = result;
    this.lastFoundAt = now;
    this.lastResult = result;
    return result;
  }

  /** Hold the last good lock briefly so a passing hand doesn't make the overlay flicker. */
  private grace(fallback: TrackResult, now: number): TrackResult {
    this.stillSince = 0;
    this.prevRaw = null;
    const r: TrackResult =
      this.lastFound && now - this.lastFoundAt < GRACE_MS
        ? { ...this.lastFound, stable: false, stillness: 0, match: null, afterCorners: null }
        : fallback;
    this.lastResult = r;
    return r;
  }

  /**
   * True when the camera hasn't delivered a new frame since the last call. Uses
   * requestVideoFrameCallback where it works; otherwise the video clock, with a short cap
   * because some phones don't advance currentTime for every camera frame.
   */
  private isRepeat(video: HTMLVideoElement, stepKey: string, now: number): boolean {
    if (this.watched !== video) {
      this.watched = video;
      this.frameSeq = 0;
      this.seenSeq = -1;
      const v = video as { requestVideoFrameCallback?: (cb: () => void) => number };
      this.rvfcBroken = typeof v.requestVideoFrameCallback !== "function";
      if (!this.rvfcBroken) {
        const tick = () => {
          if (this.watched !== video) return;
          this.frameSeq++;
          v.requestVideoFrameCallback!(tick);
        };
        v.requestVideoFrameCallback!(tick);
      }
    }
    const vt = (video as { currentTime?: number }).currentTime;
    const t = typeof vt === "number" ? vt : -1;
    let repeat = false;
    if (stepKey === this.key && this.lastResult && !this.pendingTap) {
      const since = now - this.lastProcessAt;
      if (!this.rvfcBroken) {
        if (this.frameSeq === this.seenSeq) {
          if (since < 250) repeat = true;
          else this.rvfcBroken = true; // callbacks aren't arriving here: use the clock instead
        }
      } else if (t >= 0 && t === this.lastVideoTime && since < 60) {
        repeat = true;
      }
    }
    if (!repeat) {
      this.seenSeq = this.frameSeq;
      this.lastVideoTime = t;
    }
    return repeat;
  }

  /** Follow the paper from where it was last frame. Also tries the finished outline. */
  private trackFit(expected: Vec[], next: Vec[] | null): { fit: Fit | null; fitA: Fit | null } {
    if (this.frame % 6 === 0 || this.bg.length === 0) this.learnBackground(this.lastPoly!);
    const predicted = this.predict();
    this.buildPrior(predicted, this.loosePrior ? 1.45 : 1.2, this.loosePrior ? 2.1 : 1.75);
    this.segment(this.paper, true);
    const fit = this.fitBest(expected, true, predicted);
    const fitA = next && (!fit?.ok || next.length !== expected.length) ? this.fitBest(next, true, predicted) : null;
    return { fit, fitA };
  }

  /** Search the whole frame for the starting outline. */
  private search(expectedHull: Vec[], now: number): Fit | null {
    const { w, h } = this;
    this.bg = this.ringBackground();
    const cands: { fit: Fit; model: Cluster[] | null }[] = [];
    let segmentedWith: Cluster[] | null = null;
    if (this.paper.length) {
      // Briefly lost (a hand went over it): it's probably still near where it was.
      const near = this.lastPoly !== null && now - this.lastLockAt < 1000;
      if (near) this.buildPrior(this.lastPoly!, 1.6, 2.4);
      this.segment(this.paper, near);
      segmentedWith = this.paper;
      const f = this.fitBest(expectedHull, false, null);
      if (f) cands.push({ fit: f, model: null });
    }
    if (!this.locked) {
      const fgs = this.foregroundModels();
      for (const fg of fgs) {
        this.segment(fg, false);
        segmentedWith = fg;
        const f = this.fitBest(expectedHull, false, null);
        if (f) cands.push({ fit: f, model: fg });
      }
      const center = this.sampleCluster(w / 2, h / 2, 4);
      if (center && (this.frame % 2 === 0 || !fgs.length)) {
        const model = [center];
        this.segment(model, false);
        segmentedWith = model;
        const f = this.fitBest(expectedHull, false, null);
        if (f) cands.push({ fit: f, model });
      }
    }
    const best = cands.filter((c) => c.fit.ok).sort((a, b) => b.fit.score - a.fit.score)[0];
    if (!best) {
      this.cutNow = this.middleRunsOff();
      return cands.sort((a, b) => b.fit.score - a.fit.score)[0]?.fit ?? null;
    }
    if (best.model) this.paper = best.model;
    // Re-segment with the winning colors so the skin map and debug view match the fit.
    if (segmentedWith !== this.paper) this.segment(this.paper, false);
    this.euro.reset();
    this.velV = null;
    this.velocity = null;
    return best.fit;
  }

  /**
   * True when the plain region in the middle of the picture runs off one side: most likely
   * the sheet held too close. Its color is then also seen at the picture's edge, so the
   * usual search takes it for background and finds nothing.
   */
  private middleRunsOff(): boolean {
    const { w, h, Y, CB, CR, tmp, queue } = this;
    const seed = (h >> 1) * w + (w >> 1);
    const y0 = Y[seed];
    const cb0 = CB[seed];
    const cr0 = CR[seed];
    tmp.fill(0);
    let head = 0;
    let tail = 0;
    const visit = (j: number) => {
      if (tmp[j] || Math.abs(Y[j] - y0) > 30 || Math.abs(CB[j] - cb0) > 9 || Math.abs(CR[j] - cr0) > 9) return;
      tmp[j] = 1;
      queue[tail++] = j;
    };
    visit(seed);
    let border = 0;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      const y = (i - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border++;
      if (x > 0) visit(i - 1);
      if (x < w - 1) visit(i + 1);
      if (y > 0) visit(i - w);
      if (y < h - 1) visit(i + w);
    }
    // A table would touch far more of the border, and a small patch isn't a sheet.
    return border > 0 && border < 0.4 * (w + h) && tail > w * h * 0.06 && tail < w * h * 0.6;
  }

  /** Shape difference between an outline and detected corners (video px), any corner order. */
  private shapeErr(hull: Vec[], raw: Vec[]): number {
    if (hull.length !== raw.length) return Infinity;
    const pts = this.G ? raw.map((p) => applyH(this.G!, p)) : raw;
    if (pts.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return Infinity;
    let best = Infinity;
    for (let k = 0; k < hull.length; k++) best = Math.min(best, procrustes(hull, rotateArray(pts, k)).err);
    return best;
  }

  private planeArea(raw: Vec[]): number {
    return this.G ? Math.abs(signedArea(raw.map((p) => applyH(this.G!, p)))) : 0;
  }

  /**
   * Share of pixels with a strong brightness edge between an outline scaled by k0 and the
   * same outline scaled by k1 (k0 = 0: everything inside k1). Hands don't count.
   */
  private edgeShare(poly: Vec[], k0: number, k1: number): number {
    const { w, h, Y, skin } = this;
    const outer = rowSpans(scalePoly(poly, k1), h);
    const inner = k0 > 0 ? rowSpans(scalePoly(poly, k0), h) : null;
    let total = 0;
    let strong = 0;
    for (let y = 1; y < h - 1; y++) {
      const lo = outer[y * 2];
      if (Number.isNaN(lo)) continue;
      const x0 = Math.max(1, Math.ceil(lo - 0.5));
      const x1 = Math.min(w - 2, Math.floor(outer[y * 2 + 1] - 0.5));
      const ilo = inner ? inner[y * 2] : NaN;
      const ihi = inner ? inner[y * 2 + 1] : NaN;
      for (let x = x0; x <= x1; x++) {
        if (!Number.isNaN(ilo) && x + 0.5 >= ilo && x + 0.5 <= ihi) continue;
        const i = y * w + x;
        if (skin[i]) continue;
        total++;
        if (Math.hypot(Y[i + 1] - Y[i - 1], Y[i + w] - Y[i - w]) > EDGE_STRONG * 2) strong++;
      }
    }
    return total >= 12 ? strong / total : 0;
  }

  /** Share of skin-colored pixels on and just around an outline (work coordinates). */
  private handShare(poly: Vec[] | null): number {
    if (!poly) return 0;
    const { w, h, skin } = this;
    const spans = rowSpans(scalePoly(poly, 1.35), h);
    let total = 0;
    let hit = 0;
    for (let y = 0; y < h; y++) {
      const lo = spans[y * 2];
      if (Number.isNaN(lo)) continue;
      const x0 = Math.max(0, Math.ceil(lo - 0.5));
      const x1 = Math.min(w - 1, Math.floor(spans[y * 2 + 1] - 0.5));
      for (let x = x0; x <= x1; x++) {
        total++;
        if (skin[y * w + x]) hit++;
      }
    }
    return total ? hit / total : 0;
  }

  // ---- Image & color models -------------------------------------------------------------

  /**
   * Small paper in a wide frame gets too few pixels for accurate corners, so while tracking
   * analyze only a window around the paper, at up to full camera detail.
   */
  private pickRoi(vw: number, vh: number): { x: number; y: number; sx: number; sy: number } | null {
    const p = this.polyV;
    const { w, h } = this;
    if (!p || !w || !h) return null;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    p.forEach((q, i) => {
      const v = this.velV && this.velV.length === p.length ? this.velV[i] : { x: 0, y: 0 };
      x0 = Math.min(x0, q.x + v.x);
      x1 = Math.max(x1, q.x + v.x);
      y0 = Math.min(y0, q.y + v.y);
      y1 = Math.max(y1, q.y + v.y);
    });
    const bw = x1 - x0;
    const bh = y1 - y0;
    const frac = clamp(Math.max(bw / vw, bh / vh) * ROI_ZOOM, Math.min(1, w / vw), 1);
    if (frac > 0.85) return null;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const cur = this.roi;
    const curFrac = (cur.sx * w) / vw;
    // Keep the current window while the paper sits comfortably inside it.
    if (
      this.zoomed &&
      curFrac >= frac * 0.8 &&
      curFrac <= frac * 1.4 &&
      cx - bw * 0.75 >= cur.x &&
      cx + bw * 0.75 <= cur.x + cur.sx * w &&
      cy - bh * 0.75 >= cur.y &&
      cy + bh * 0.75 <= cur.y + cur.sy * h
    ) {
      return cur;
    }
    const rw = Math.round(vw * frac);
    const rh = Math.round(vh * frac);
    return { x: Math.round(clamp(cx - rw / 2, 0, vw - rw)), y: Math.round(clamp(cy - rh / 2, 0, vh - rh)), sx: rw / w, sy: rh / h };
  }

  private grab(video: HTMLVideoElement, zoom: { x: number; y: number; sx: number; sy: number } | null) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    // Same pixel budget whichever way the phone is held.
    const k = Math.min(1, Math.sqrt(WORK_PX / (vw * vh)));
    const w = Math.max(8, Math.round(vw * k));
    const h = Math.max(8, Math.round(vh * k));
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
    }
    let roi = zoom;
    if (w !== this.w || h !== this.h) {
      roi = null;
      this.w = w;
      this.h = h;
      this.canvas.width = w;
      this.canvas.height = h;
      const N = w * h;
      this.Y = new Float32Array(N);
      this.CB = new Float32Array(N);
      this.CR = new Float32Array(N);
      this.mask = new Uint8Array(N);
      this.tmp = new Uint8Array(N);
      this.skin = new Uint8Array(N);
      this.fg = new Uint8Array(N);
      this.prior = new Int8Array(N);
      this.labels = new Int32Array(N);
      this.queue = new Int32Array(N);
      this.samples = new Float32Array(N * 3);
    }
    roi ??= { x: 0, y: 0, sx: vw / w, sy: vh / h };
    const prev = this.roi;
    // A different window shows different surroundings: learn the background again.
    if (roi.x !== prev.x || roi.y !== prev.y || roi.sx !== prev.sx || roi.sy !== prev.sy) this.bg = [];
    this.roi = roi;
    this.zoomed = zoom !== null && roi === zoom;
    this.vw = vw;
    this.vh = vh;

    const ctx = this.ctx!;
    const sw = roi.sx * w;
    const sh = roi.sy * h;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if (Math.max(roi.sx, roi.sy) > 2.2) {
      // Halve twice: browsers that only do bilinear scaling (Safari) would otherwise skip
      // most camera pixels, leaving noise and jagged edges.
      if (!this.mid) {
        this.mid = document.createElement("canvas");
        this.midCtx = this.mid.getContext("2d")!;
      }
      if (this.mid.width !== w * 2 || this.mid.height !== h * 2) {
        this.mid.width = w * 2;
        this.mid.height = h * 2;
      }
      const mctx = this.midCtx!;
      mctx.imageSmoothingEnabled = true;
      mctx.imageSmoothingQuality = "high";
      mctx.drawImage(video, roi.x, roi.y, sw, sh, 0, 0, w * 2, h * 2);
      ctx.drawImage(this.mid, 0, 0, w * 2, h * 2, 0, 0, w, h);
    } else {
      ctx.drawImage(video, roi.x, roi.y, sw, sh, 0, 0, w, h);
    }
    const { data } = ctx.getImageData(0, 0, w, h);
    const { Y, CB, CR } = this;
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      const r = data[p];
      const g = data[p + 1];
      const b = data[p + 2];
      Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      CB[i] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      CR[i] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    }
    this.hasImage = true;

    // Bring what we know about the paper into this window's coordinates.
    const toW = (p: Vec): Vec => ({ x: (p.x - roi.x) / roi.sx, y: (p.y - roi.y) / roi.sy });
    this.lastPoly = this.polyV ? this.polyV.map(toW) : null;
    this.velocity = this.velV ? this.velV.map((v) => ({ x: v.x / roi.sx, y: v.y / roi.sy })) : null;
    this.tap = this.tapV ? { ...toW(this.tapV), until: this.tapV.until } : null;
  }

  private sampleCluster(cx: number, cy: number, r: number): Cluster | null {
    const ys: number[] = [];
    const cbs: number[] = [];
    const crs: number[] = [];
    for (let y = Math.round(cy - r); y <= Math.round(cy + r); y++) {
      for (let x = Math.round(cx - r); x <= Math.round(cx + r); x++) {
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) continue;
        const i = y * this.w + x;
        ys.push(this.Y[i]);
        cbs.push(this.CB[i]);
        crs.push(this.CR[i]);
      }
    }
    if (ys.length < 4) return null;
    const med = (a: number[]) => [...a].sort((m, k) => m - k)[a.length >> 1];
    const mad = (a: number[], m: number) => med(a.map((v) => Math.abs(v - m))) * 1.4826;
    const my = med(ys);
    const mb = med(cbs);
    const mr = med(crs);
    // Taps are tiny samples: widen the spread so the rest of the sheet still matches.
    return cluster(my, mb, mr, (mad(ys, my) * 2) ** 2, (mad(cbs, mb) * 2) ** 2, (mad(crs, mr) * 2) ** 2, 1, VY_PAPER);
  }

  private pack(idx: (push: (i: number) => void) => void, cap: number): number {
    let n = 0;
    const s = this.samples;
    idx((i) => {
      if (n >= cap) return;
      s[n * 3] = this.Y[i];
      s[n * 3 + 1] = this.CB[i];
      s[n * 3 + 2] = this.CR[i];
      n++;
    });
    return n;
  }

  /** Background colors from a ring around the frame edge (used while searching). */
  private ringBackground(): Cluster[] {
    const { w, h } = this;
    const rw = Math.max(3, Math.round(h * 0.06));
    const n = this.pack((push) => {
      for (let y = 0; y < h; y += 2) {
        const edgeRow = y < rw || y >= h - rw;
        for (let x = 0; x < w; x += edgeRow ? 2 : 1) {
          if (!edgeRow && x >= rw && x < w - rw) {
            x = w - rw - 1;
            continue;
          }
          push(y * w + x);
        }
      }
    }, 4000);
    return kmeans(this.samples, n, 6, VY_BG, 0.005);
  }

  /** Background colors from everything outside the paper (used while tracking). */
  private learnBackground(poly: Vec[]) {
    const { w, h } = this;
    const spans = rowSpans(scalePoly(poly, 1.3), h);
    const n = this.pack((push) => {
      for (let y = 1; y < h; y += 3) {
        const lo = spans[y * 2];
        const hi = spans[y * 2 + 1];
        for (let x = (y % 2) + 1; x < w; x += 3) {
          if (!Number.isNaN(lo) && x + 0.5 >= lo && x + 0.5 <= hi) continue;
          push(y * w + x);
        }
      }
    }, 4000);
    if (n > 50) this.bg = kmeans(this.samples, n, 6, VY_BG, 0.005);
  }

  /** Learn paper colors (front, back, shaded) from the inside of a good fit. */
  private learnPaper(poly: Vec[]) {
    const { w, h } = this;
    const spans = rowSpans(scalePoly(poly, 0.8), h);
    const n = this.pack((push) => {
      for (let y = 0; y < h; y += 2) {
        const lo = spans[y * 2];
        const hi = spans[y * 2 + 1];
        if (Number.isNaN(lo)) continue;
        for (let x = Math.max(0, Math.ceil(lo)); x < Math.min(w, hi); x += 2) {
          const i = y * w + x;
          if (!this.skin[i]) push(i);
        }
      }
    }, 3000);
    if (n < 30) return;
    this.paper = blendModels(this.paper, this.mergeClose(kmeans(this.samples, n, 3, VY_PAPER)), 0.3, this.locked);
  }

  private mergeClose(cs: Cluster[]): Cluster[] {
    const out: Cluster[] = [];
    for (const c of [...cs].sort((a, b) => b.w - a.w)) {
      const near = out.findIndex((o) => mahal(o, c.y, c.cb, c.cr) < 6);
      if (near < 0) {
        out.push(c);
        continue;
      }
      const o = out[near];
      const t = c.w / (o.w + c.w);
      const m = (a: number, b: number) => a + (b - a) * t;
      out[near] = cluster(m(o.y, c.y), m(o.cb, c.cb), m(o.cr, c.cr), Math.max(o.vy, c.vy), Math.max(o.vcb, c.vcb), Math.max(o.vcr, c.vcr), o.w + c.w, VY_PAPER);
    }
    return out;
  }

  /**
   * Bootstrap paper colors from the most promising compact regions that look unlike the
   * frame border. Luma differences count less here so lighting gradients across the table
   * don't qualify. Skin-colored clusters are dropped unless they make up most of the region
   * (pink, orange or kraft paper), so a hand on the sheet doesn't become "paper".
   */
  private foregroundModels(): Cluster[][] {
    const { w, h, mask, Y, CB, CR, bg } = this;
    if (!bg.length) return [];
    const loose = bg.map((c) => cluster(c.y, c.cb, c.cr, Math.max(c.vy, 20 * 20), c.vcb, c.vcr, c.w, VY_BG));
    const { fg, skin } = this;
    for (let i = 0; i < w * h; i++) {
      const y = Y[i];
      const cb = CB[i];
      const cr = CR[i];
      let m = Infinity;
      for (const c of loose) m = Math.min(m, mahal(c, y, cb, cr));
      fg[i] = m > 12 ? 1 : 0;
      skin[i] = cr - cb > 22 && mahal(SKIN, y, cb, cr) < 6 ? 1 : 0;
    }
    const diag = Math.hypot(w, h);
    const models: Cluster[][] = [];
    // First with hands cut out (keeps a hand from gluing the sheet to an arm), then with
    // them kept in (skin-toned paper such as pink or kraft).
    for (const [cutSkin, take] of [[true, 2], [false, 1]] as const) {
      for (let i = 0; i < w * h; i++) mask[i] = fg[i] && !(cutSkin && skin[i]) ? 1 : 0;
      this.clean();
      const ranked = this.label(null)
        .filter((b) => b.area <= w * h * 0.85)
        .map((b) => {
          const solidity = b.area / ((b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1));
          const centerW = 1 - 0.5 * clamp(Math.hypot(b.cx - w / 2, b.cy - h / 2) / (0.5 * diag));
          const borderFrac = b.border / (2 * (w + h));
          return { b, score: b.area * centerW * Math.max(0.1, 1 - borderFrac * 3) * (0.4 + solidity) };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, take);
      for (const { b } of ranked) {
        const step = Math.max(1, Math.floor(Math.sqrt(b.area / 1500)));
        const n = this.pack((push) => {
          for (let y = b.y0; y <= b.y1; y += step) {
            for (let x = b.x0; x <= b.x1; x += step) {
              const i = y * w + x;
              if (this.labels[i] === b.label) push(i);
            }
          }
        }, 3000);
        if (n < 30) continue;
        let cs = this.mergeClose(kmeans(this.samples, n, 3, VY_PAPER));
        // A hand is a small part of the region; a skin-toned color covering a big share is
        // the paper itself (pink, orange, kraft).
        const keep = cs.filter((c) => !skinLike(c) || c.w >= 0.3);
        if (keep.length) cs = keep;
        if (cs.length) models.push(cs);
      }
    }
    return models;
  }

  // ---- Segmentation -----------------------------------------------------------------

  /** Mark where the paper probably is: +1 inside the predicted outline, 0 nearby, −1 far. */
  private buildPrior(poly: Vec[], sIn: number, sNear: number) {
    const { w, h, prior } = this;
    prior.fill(-1);
    const fill = (spans: Float32Array, v: number) => {
      for (let y = 0; y < h; y++) {
        const lo = spans[y * 2];
        if (Number.isNaN(lo)) continue;
        const x0 = Math.max(0, Math.ceil(lo - 0.5));
        const x1 = Math.min(w - 1, Math.floor(spans[y * 2 + 1] - 0.5));
        for (let x = x0; x <= x1; x++) prior[y * w + x] = v;
      }
    };
    fill(rowSpans(scalePoly(poly, sNear), h), 0);
    fill(rowSpans(scalePoly(poly, sIn), h), 1);
  }

  private segment(paper: Cluster[], usePrior: boolean) {
    this.strictShape = paper.length > 0 && skinLike(paper.reduce((a, c) => (c.w > a.w ? c : a)));
    const { w, h, Y, CB, CR, mask, skin, prior, bg } = this;
    const cap = (this.tolerance / 40) ** 2 * 16;
    for (let i = 0; i < w * h; i++) {
      const y = Y[i];
      const cb = CB[i];
      const cr = CR[i];
      let np = Infinity;
      let mp = Infinity;
      for (const c of paper) {
        const m = mahalPaper(c, y, cb, cr);
        const v = 0.5 * m + c.ld;
        if (v < np) {
          np = v;
          mp = m;
        }
      }
      const ms = mahal(SKIN, y, cb, cr);
      let nb = 0.5 * ms + SKIN.ld;
      let isSkin = true;
      for (const c of bg) {
        const v = 0.5 * mahal(c, y, cb, cr) + c.ld;
        if (v < nb) {
          nb = v;
          isSkin = false;
        }
      }
      let bias = PAPER_BIAS;
      if (usePrior) {
        const p = prior[i];
        bias += p > 0 ? PRIOR_IN : p < 0 ? -PRIOR_OUT : 0;
      }
      const on = mp < cap && np - bias < nb;
      mask[i] = on ? 1 : 0;
      skin[i] = !on && isSkin && ms < 12 ? 1 : 0;
    }
    this.clean();
  }

  /** Open (remove specks) then close (fill crease lines and small shadows). */
  private clean() {
    this.erode(this.mask, this.tmp);
    this.dilate(this.tmp, this.mask);
    this.dilate(this.mask, this.tmp);
    this.dilate(this.tmp, this.mask);
    this.erode(this.mask, this.tmp);
    this.erode(this.tmp, this.mask);
  }

  private erode(src: Uint8Array, dst: Uint8Array) {
    const { w, h } = this;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!src[i] || x === 0 || y === 0 || x === w - 1 || y === h - 1) {
          dst[i] = src[i] && (x === 0 || y === 0 || x === w - 1 || y === h - 1) ? src[i] : 0;
          continue;
        }
        dst[i] = src[i - 1] & src[i + 1] & src[i - w] & src[i + w];
      }
    }
  }

  private dilate(src: Uint8Array, dst: Uint8Array) {
    const { w, h } = this;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        dst[i] =
          src[i] |
          (x > 0 ? src[i - 1] : 0) |
          (x < w - 1 ? src[i + 1] : 0) |
          (y > 0 ? src[i - w] : 0) |
          (y < h - 1 ? src[i + w] : 0);
      }
    }
  }

  /** Connected components (BFS) with the stats blob selection needs. */
  private label(usePrior: boolean | null): Blob[] {
    const { w, h, mask, labels, queue, prior } = this;
    labels.fill(0);
    const total = w * h;
    const minArea = total * MIN_BLOB;
    const blobs: Blob[] = [];
    let label = 0;
    for (let start = 0; start < total; start++) {
      if (!mask[start] || labels[start]) continue;
      label++;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      labels[start] = label;
      let area = 0;
      let sx = 0;
      let sy = 0;
      let border = 0;
      let inPrior = 0;
      let x0 = w;
      let x1 = 0;
      let y0 = h;
      let y1 = 0;
      while (head < tail) {
        const i = queue[head++];
        const x = i % w;
        const y = (i / w) | 0;
        area++;
        sx += x;
        sy += y;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border++;
        if (usePrior && prior[i] > 0) inPrior++;
        if (x > 0 && mask[i - 1] && !labels[i - 1]) (labels[i - 1] = label), (queue[tail++] = i - 1);
        if (x < w - 1 && mask[i + 1] && !labels[i + 1]) (labels[i + 1] = label), (queue[tail++] = i + 1);
        if (y > 0 && mask[i - w] && !labels[i - w]) (labels[i - w] = label), (queue[tail++] = i - w);
        if (y < h - 1 && mask[i + w] && !labels[i + w]) (labels[i + w] = label), (queue[tail++] = i + w);
      }
      if (area >= minArea) blobs.push({ label, area, cx: sx / area, cy: sy / area, border, inPrior, x0, x1, y0, y1 });
    }
    return blobs;
  }

  // ---- Shape fitting ----------------------------------------------------------------

  /** Fit the outline to the most promising blobs of the current mask; return the best. */
  private fitBest(expected: Vec[], tracking: boolean, predicted: Vec[] | null): Fit | null {
    const { w, h } = this;
    const blobs = this.label(tracking);
    if (!blobs.length) return null;
    const diag = Math.hypot(w, h);
    const tap = this.tap;
    const rank = (b: Blob) => {
      if (tap) {
        const hit = this.labels[Math.round(clamp(tap.y, 0, h - 1)) * w + Math.round(clamp(tap.x, 0, w - 1))] === b.label;
        if (hit) return Infinity;
      }
      if (tracking) return b.inPrior + 0.25 * (b.area - b.inPrior);
      if (b.area > w * h * 0.9) return 0;
      const ref = this.lastPoly ? centroid(this.lastPoly) : { x: w / 2, y: h / 2 };
      const centerW = 1 - 0.6 * clamp(Math.hypot(b.cx - ref.x, b.cy - ref.y) / (0.5 * diag));
      const borderFrac = b.border / (2 * (w + h));
      return b.area * centerW * (borderFrac > 0.25 ? 0.15 : 1 - borderFrac * 2.5);
    };
    const ranked = blobs.map((b) => ({ b, r: rank(b) })).filter((x) => x.r > 0).sort((a, b) => b.r - a.r).slice(0, 3);
    let best: Fit | null = null;
    for (const { b } of ranked) {
      let f = this.fitBlob(b, expected, tracking);
      // Paper touching something of the same color: retry with the part near the prediction.
      if (tracking && predicted && f && !f.ok && f.outside > 0.1) {
        const spans = rowSpans(scalePoly(predicted, 1.2), h);
        const sub = this.restrict(b, spans);
        if (sub) {
          const f2 = this.fitBlob(sub, expected, tracking);
          if (f2 && (f2.ok || f2.score > f.score)) f = f2;
        }
      }
      if (f && (!best || (f.ok && !best.ok) || (f.ok === best.ok && f.score > best.score))) best = f;
      if (tracking && best?.ok) break;
    }
    return best;
  }

  /** Clip a blob to a polygon's rows; returns the relabeled sub-blob. */
  private restrict(b: Blob, spans: Float32Array): Blob | null {
    const { w, labels } = this;
    const nl = -b.label;
    let area = 0;
    let sx = 0;
    let sy = 0;
    let x0 = w;
    let x1 = 0;
    let y0 = this.h;
    let y1 = 0;
    for (let y = b.y0; y <= b.y1; y++) {
      const lo = spans[y * 2];
      const hi = spans[y * 2 + 1];
      for (let x = b.x0; x <= b.x1; x++) {
        const i = y * w + x;
        if (labels[i] !== b.label) continue;
        if (Number.isNaN(lo) || x + 0.5 < lo || x + 0.5 > hi) continue;
        labels[i] = nl;
        area++;
        sx += x;
        sy += y;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (area < w * this.h * MIN_BLOB) return null;
    return { label: nl, area, cx: sx / area, cy: sy / area, border: 0, inPrior: area, x0, x1, y0, y1 };
  }

  private fitBlob(b: Blob, expected: Vec[], tracking: boolean): Fit | null {
    const { w, h, labels } = this;
    const n = expected.length;
    // Boundary samples: left/right extremes per row and top/bottom per column.
    const pts: Vec[] = [];
    const bw = b.x1 - b.x0 + 1;
    const colMin = new Int32Array(bw).fill(-1);
    const colMax = new Int32Array(bw).fill(-1);
    for (let y = b.y0; y <= b.y1; y++) {
      let minX = -1;
      let maxX = -1;
      const row = y * w;
      for (let x = b.x0; x <= b.x1; x++) {
        if (labels[row + x] !== b.label) continue;
        if (minX < 0) minX = x;
        maxX = x;
        const c = x - b.x0;
        if (colMin[c] < 0) colMin[c] = y;
        colMax[c] = y;
      }
      if (minX >= 0) pts.push({ x: minX, y: y + 0.5 }, { x: maxX + 1, y: y + 0.5 });
    }
    for (let c = 0; c < bw; c++) {
      if (colMin[c] >= 0) pts.push({ x: b.x0 + c + 0.5, y: colMin[c] }, { x: b.x0 + c + 0.5, y: colMax[c] + 1 });
    }
    const hull = convexHull(pts);
    if (hull.length < n) return null;
    // Skin-toned colors are only trusted after a tap on the paper: on their own they are
    // far more often a hand or arm than a sheet. Even then, a region running off the
    // frame is an arm.
    if (this.strictShape && (!this.locked || b.border > 0)) return null;
    let corners = refineCorners(cornersFromHull(hull, n), pts);
    const snapped = this.snapEdges(corners);
    corners = snapped.corners;
    if (signedArea(corners) < 0) corners = corners.reverse();

    // Correspondence: every cyclic rotation; prefer the previous frame's ordering and the
    // diagram's orientation.
    const size = Math.sqrt(Math.abs(signedArea(corners))) || 1;
    const prev = this.lastPoly && this.lastPoly.length === n ? this.lastPoly : null;
    let ordered = corners;
    let err = Infinity;
    let bestCost = Infinity;
    for (let k = 0; k < n; k++) {
      const cand = rotateArray(corners, k);
      const fit = procrustes(expected, cand);
      let cost = fit.err + 0.02 * (1 - Math.cos(fit.angle));
      if (prev) cost += (3 * meanDistance(cand, prev)) / size;
      if (cost < bestCost) {
        bestCost = cost;
        ordered = cand;
        err = fit.err;
      }
    }

    const areaFrac = Math.abs(signedArea(ordered)) / (w * h);
    const fail = (score: number): Fit => ({ corners: ordered, err, coverage: 0, outside: 1, support: 0, areaFrac, ok: false, score });

    // Geometry: convex, non-degenerate, a plausible camera view of the outline.
    for (let i = 0; i < n; i++) {
      const a = ordered[i];
      const p = ordered[(i + 1) % n];
      const q = ordered[(i + 2) % n];
      if (dist(a, p) < 4) return fail(0);
      if ((p.x - a.x) * (q.y - p.y) - (p.y - a.y) * (q.x - p.x) <= 0) return fail(0);
    }
    if (areaFrac < MIN_BLOB * 1.2 || areaFrac > 0.9) return fail(0);
    const H = homographyFrom(expected, ordered);
    if (!H) return fail(0);
    const c0 = centroid(expected);
    const jc = jacobian(H, c0);
    if (jc.aniso > 2.8 || jc.det <= 0) return fail(0);
    let dmin = Infinity;
    let dmax = 0;
    for (const p of expected) {
      const j = jacobian(H, p);
      if (j.w <= 0 || j.det <= 0) return fail(0);
      dmin = Math.min(dmin, j.det);
      dmax = Math.max(dmax, j.det);
    }
    if (dmax / dmin > 8) return fail(0);
    if (n > 4) {
      let re = 0;
      for (let i = 0; i < n; i++) re += dist(applyH(H, expected[i]), ordered[i]);
      if (re / n / size > 0.035) return fail(0);
    }
    // An edge running along the frame border means the paper is cut off.
    for (let i = 0; i < n; i++) {
      const a = ordered[i];
      const p = ordered[(i + 1) % n];
      const m = 2;
      if ((a.x < m && p.x < m) || (a.y < m && p.y < m) || (a.x > w - m && p.x > w - m) || (a.y > h - m && p.y > h - m)) return fail(0);
    }
    // A region running off the frame is more often an arm or a sleeve than a sheet.
    if (!tracking && b.border > 0.25 * size) return fail(0);

    // Does the outline explain the blob? Count blob pixels inside/outside, and hands
    // (skin) inside as legitimate occluders.
    const spans = rowSpans(ordered, h);
    let polyPx = 0;
    let skinIn = 0;
    let blobIn = 0;
    const yA = Math.max(0, Math.min(b.y0, Math.floor(Math.min(...ordered.map((p) => p.y)))));
    const yB = Math.min(h - 1, Math.max(b.y1, Math.ceil(Math.max(...ordered.map((p) => p.y)))));
    for (let y = yA; y <= yB; y++) {
      const lo = spans[y * 2];
      if (Number.isNaN(lo)) continue;
      const x0 = Math.max(0, Math.ceil(lo - 0.5));
      const x1 = Math.min(w - 1, Math.floor(spans[y * 2 + 1] - 0.5));
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        polyPx++;
        if (labels[i] === b.label) blobIn++;
        else if (this.skin[i]) skinIn++;
      }
    }
    if (polyPx < 20) return fail(0);
    // Hands may hide part of the sheet, but the paper itself must fill most of the outline
    // (skin-toned tables would otherwise "explain" any outline).
    if (blobIn < polyPx * 0.6) return fail(0);
    const coverage = (blobIn + Math.min(skinIn, polyPx * 0.3)) / polyPx;
    const outside = (b.area - blobIn) / b.area;
    const support = snapped.support;
    const score = coverage * (1 - outside) * Math.sqrt(areaFrac) * (0.5 + 0.5 * support) * (tracking ? 1 : 1 - 0.5 * clamp(err / 0.2));
    const ok = coverage >= (tracking ? 0.8 : 0.86) && outside <= (tracking ? 0.14 : 0.1) && support >= (this.strictShape ? (tracking ? 0.6 : 0.7) : tracking ? 0.3 : 0.45);
    // Among clutter (a bookshelf, a busy desk) a patch of stripes or print can pass for a
    // sheet. Paper is plain, or at least lies on something plain: refuse a first lock on a
    // busy patch in busy surroundings unless the user tapped it.
    if (ok && !tracking && !this.tap && this.edgeShare(ordered, 0, 0.8) > 0.08 && this.edgeShare(ordered, 1.2, 1.7) > 0.12) return fail(score * 0.5);
    return { corners: ordered, err, coverage, outside, support, areaFrac, ok, score };
  }

  /**
   * Snap each edge to the real paper boundary: along the edge, find where the color crosses
   * halfway between inside and outside (sub-pixel, unbiased for blurred edges), then fit a
   * robust line and intersect neighbours. Fingers or shadows on an edge are outliers.
   */
  private snapEdges(corners: Vec[]): { corners: Vec[]; support: number } {
    const n = corners.length;
    const c = centroid(corners);
    const { w, h } = this;
    const lines: ({ p: Vec; d: Vec } | null)[] = [];
    let total = 0;
    let inl = 0;
    let minEdge = Infinity;
    for (let i = 0; i < n; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % n];
      const L = dist(a, b);
      minEdge = Math.min(minEdge, L);
      if (L < 8) {
        lines.push(null);
        continue;
      }
      const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
      let nr = { x: -u.y, y: u.x };
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if ((mid.x - c.x) * nr.x + (mid.y - c.y) * nr.y < 0) nr = { x: -nr.x, y: -nr.y };
      const R = clamp(L * 0.05, 2, 5);
      const M = Math.round(clamp(L / 3, 6, 30));
      const found: Vec[] = [];
      for (let j = 0; j < M; j++) {
        const t = 0.12 + (0.76 * j) / (M - 1);
        const p = { x: a.x + u.x * L * t, y: a.y + u.y * L * t };
        const ix = p.x - nr.x * R;
        const iy = p.y - nr.y * R;
        const ox = p.x + nr.x * R;
        const oy = p.y + nr.y * R;
        if (Math.min(ix, ox) < 1 || Math.min(iy, oy) < 1 || Math.max(ix, ox) > w - 1 || Math.max(iy, oy) > h - 1) continue;
        total++;
        const ci = this.color(ix, iy);
        const co = this.color(ox, oy);
        const d0 = co[0] - ci[0];
        const d1 = co[1] - ci[1];
        const d2 = co[2] - ci[2];
        const dd = d0 * d0 + d1 * d1 + d2 * d2;
        if (dd < 100) continue;
        let prevF = 0;
        let bestS: number | null = null;
        for (let s = -R + 0.5; s <= R + 1e-6; s += 0.5) {
          const q = this.color(p.x + nr.x * s, p.y + nr.y * s);
          const f = ((q[0] - ci[0]) * d0 + (q[1] - ci[1]) * d1 + (q[2] - ci[2]) * d2) / dd;
          if (prevF < 0.5 && f >= 0.5) {
            const sc = s - (0.5 * (f - 0.5)) / Math.max(1e-6, f - prevF);
            if (bestS === null || Math.abs(sc) < Math.abs(bestS)) bestS = sc;
          }
          prevF = f;
        }
        if (bestS !== null) found.push({ x: p.x + nr.x * bestS, y: p.y + nr.y * bestS });
      }
      const line = found.length >= 5 ? robustLine(found) : null;
      if (line) for (const q of found) if (Math.abs(-(q.x - line.p.x) * line.d.y + (q.y - line.p.y) * line.d.x) <= 1) inl++;
      lines.push(line);
    }
    const out = corners.map((cn, i) => {
      const l1 = lines[(i - 1 + n) % n];
      const l2 = lines[i];
      if (!l1 || !l2) return cn;
      const q = intersect(l1, l2);
      return q && dist(q, cn) < Math.max(4, minEdge * 0.25) ? q : cn;
    });
    return { corners: out, support: total ? inl / total : 0 };
  }

  private color(x: number, y: number): [number, number, number] {
    const { w, h, Y, CB, CR } = this;
    const fx = clamp(x - 0.5, 0, w - 1.001);
    const fy = clamp(y - 0.5, 0, h - 1.001);
    const x0 = fx | 0;
    const y0 = fy | 0;
    const tx = fx - x0;
    const ty = fy - y0;
    const i = y0 * w + x0;
    const k00 = (1 - tx) * (1 - ty);
    const k10 = tx * (1 - ty);
    const k01 = (1 - tx) * ty;
    const k11 = tx * ty;
    return [
      Y[i] * k00 + Y[i + 1] * k10 + Y[i + w] * k01 + Y[i + w + 1] * k11,
      CB[i] * k00 + CB[i + 1] * k10 + CB[i + w] * k01 + CB[i + w + 1] * k11,
      CR[i] * k00 + CR[i + 1] * k10 + CR[i + w] * k01 + CR[i + w + 1] * k11,
    ];
  }

  /** Where the paper should be this frame: last corners plus their recent velocity. */
  private predict(): Vec[] {
    const p = this.lastPoly!;
    if (!this.velocity || this.velocity.length !== p.length) return p;
    return p.map((q, i) => ({ x: q.x + this.velocity![i].x, y: q.y + this.velocity![i].y }));
  }
}
