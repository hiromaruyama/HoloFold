/**
 * Paper-space fold geometry shared by the SVG hologram and the AR overlay.
 * Works in "real" step coordinates: x scaled by the step's aspect so angles are true.
 */
import type { FoldLine, Point, Step } from "../../shared/schema";
import { add, clipHalfPlane, convexHull, dot, len, mul, norm, sub, type Vec } from "./geometry";

export const realPt = (p: Point, aspect: number): Vec => ({ x: p.x * aspect, y: p.y });
export const realShape = (step: Step): Vec[] => step.shape.map((p) => realPt(p, step.aspect));
export const realHull = (step: Step): Vec[] => convexHull(realShape(step));

export interface FoldFrame {
  a: Vec;
  b: Vec;
  dir: Vec;
  /** Unit normal pointing toward the moving flap. */
  n: Vec;
  length: number;
  line: FoldLine;
}

export function foldFrame(line: FoldLine, aspect: number): FoldFrame | null {
  const a = realPt(line.from, aspect);
  const b = realPt(line.to, aspect);
  const d = sub(b, a);
  const length = len(d);
  if (length < 1e-6) return null;
  const dir = norm(d);
  let n: Vec = { x: -dir.y, y: dir.x };
  if (line.flap) {
    const f = realPt(line.flap, aspect);
    if (dot(sub(f, a), n) < 0) n = mul(n, -1);
  }
  return { a, b, dir, n, length, line };
}

/**
 * The part of the outline that swings over: on the flap side of the line, within the
 * strip the crease segment spans (so a crease that stops mid-paper only moves the paper
 * beyond it), and bounded by the step's other valley/mountain creases that don't move
 * on their own — e.g. a petal fold's flap is the kite between its two mountain creases.
 */
export function flapPolygon(shape: Vec[], fr: FoldFrame, step?: Step): Vec[] {
  const tol = fr.length * 0.04;
  let poly = clipHalfPlane(shape, fr.a, fr.n, 0);
  poly = clipHalfPlane(poly, fr.a, fr.dir, -tol);
  poly = clipHalfPlane(poly, fr.b, mul(fr.dir, -1), -tol);
  if (step && fr.line.flap) {
    const f = realPt(fr.line.flap, step.aspect);
    for (const other of step.lines) {
      if (other === fr.line || other.flap || (other.assignment !== "V" && other.assignment !== "M")) continue;
      const a = realPt(other.from, step.aspect);
      const d = sub(realPt(other.to, step.aspect), a);
      if (len(d) < 1e-6) continue;
      let n: Vec = norm({ x: -d.y, y: d.x });
      const side = dot(sub(f, a), n);
      if (Math.abs(side) < 1e-4) continue;
      if (side < 0) n = mul(n, -1);
      const clipped = clipHalfPlane(poly, a, n, 0);
      if (clipped.length >= 3) poly = clipped;
    }
  }
  return poly;
}

/** Rotate a point about the crease by theta (0 = flat, π = folded flat over), seen from above. */
export function foldPoint(p: Vec, fr: FoldFrame, theta: number): Vec {
  const d = dot(sub(p, fr.a), fr.n);
  const foot = sub(p, mul(fr.n, d));
  return add(foot, mul(fr.n, d * Math.cos(theta)));
}

export const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export interface AnimFrame {
  /** Index into step.lines of the fold being animated, or -1. */
  lineIndex: number;
  theta: number;
  alpha: number;
  /** For turn-over: horizontal squash factor −1…1 (negative = showing the back). */
  flip: number;
  /** For rotate: radians. */
  rotate: number;
}

const FOLD_PERIOD = 2.8;

/** Where the looping demo animation is at time t (seconds). */
export function animationAt(step: Step, t: number): AnimFrame {
  const base: AnimFrame = { lineIndex: -1, theta: 0, alpha: 1, flip: 1, rotate: 0 };
  if (step.action === "turn-over") {
    const p = (t % 3) / 3;
    const k = p < 0.15 ? 0 : p > 0.75 ? 1 : ease((p - 0.15) / 0.6);
    return { ...base, flip: Math.cos(k * Math.PI), alpha: p > 0.9 ? 1 - (p - 0.9) / 0.1 : 1 };
  }
  if (step.action === "rotate") {
    const p = (t % 3) / 3;
    const k = p < 0.15 ? 0 : p > 0.75 ? 1 : ease((p - 0.15) / 0.6);
    const deg = step.rotateDegrees ?? 90;
    return { ...base, rotate: (k * deg * Math.PI) / 180, alpha: p > 0.9 ? 1 - (p - 0.9) / 0.1 : 1 };
  }
  const movers = step.lines.map((l, i) => (l.flap ? i : -1)).filter((i) => i >= 0);
  if (movers.length === 0) return base;
  const cycle = Math.floor(t / FOLD_PERIOD);
  const p = (t % FOLD_PERIOD) / FOLD_PERIOD;
  const lineIndex = movers[cycle % movers.length];
  const unfold = step.action === "crease-unfold";
  let k: number;
  let alpha = 1;
  if (p < 0.12) k = 0;
  else if (p < 0.55) k = ease((p - 0.12) / 0.43);
  else if (p < 0.72) k = 1;
  else if (unfold) k = 1 - ease(Math.min(1, (p - 0.72) / 0.22));
  else {
    k = 1;
    alpha = 1 - Math.min(1, (p - 0.72) / 0.22);
  }
  // Stop just short of π so the folded flap stays visible as a sliver of depth.
  return { ...base, lineIndex, theta: k * Math.PI * 0.985, alpha };
}

/** The cubic-free fold arrow: an arc from the flap's centroid to where it lands. */
export function foldArrow(flap: Vec[], fr: FoldFrame): Vec[] {
  if (flap.length < 3) return [];
  const c = flap.reduce((acc, p) => add(acc, p), { x: 0, y: 0 });
  const start = mul(c, 1 / flap.length);
  const end = foldPoint(start, fr, Math.PI);
  const span = len(sub(end, start));
  const mid = mul(add(start, end), 0.5);
  const ctrl = add(mid, mul(fr.dir, span * 0.45));
  const pts: Vec[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const a = add(mul(start, (1 - t) * (1 - t)), mul(ctrl, 2 * t * (1 - t)));
    pts.push(add(a, mul(end, t * t)));
  }
  return pts;
}

export const ACTION_LABEL: Record<Step["action"], string> = {
  valley: "Valley fold",
  mountain: "Mountain fold",
  "crease-unfold": "Fold & unfold",
  collapse: "Collapse",
  squash: "Squash fold",
  petal: "Petal fold",
  "inside-reverse": "Inside reverse",
  "outside-reverse": "Outside reverse",
  "rabbit-ear": "Rabbit ear",
  sink: "Sink",
  pleat: "Pleat",
  "turn-over": "Turn over",
  rotate: "Rotate",
  repeat: "Repeat",
  tuck: "Tuck",
  pull: "Pull",
  shape: "Shape",
  other: "Fold",
};
