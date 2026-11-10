/**
 * Low-poly 3D shapes of finished models for the spinning hologram preview.
 * x = right, y = up, z = toward the viewer (the model's front). Every face is a flat polygon.
 * Shapes follow photos of real folded models; they are normalized to fit a unit sphere.
 */
import type { GuidePlan } from "../../shared/schema";
import { realShape } from "./fold";

export type V3 = [number, number, number];

export interface HoloModel {
  kind: "crane" | "shuriken" | "plane" | "cup" | "fortune" | "outline";
  /** Short tag for the HUD, e.g. "TSURU". */
  label: string;
  faces: V3[][];
  /** Brightness multiplier per face (e.g. the two paper colors of a ninja star). Defaults to 1. */
  tones?: number[];
  /** Extra detail lines (creases), drawn with the edges. */
  lines: [V3, V3][];
  /** Fixed rotation about x (radians) applied before spinning. Negative leans the top away. */
  tilt: number;
  /** Two vertices that get target reticles. */
  targets: V3[];
  /** "yaw" turns around the vertical axis; "roll" spins a flat model around its own center like a thrown star. */
  spin: "yaw" | "roll";
}

type Shape = Omit<HoloModel, "kind" | "label" | "spin">;

const mx = (p: V3): V3 => [-p[0], p[1], p[2]];
const mz = (p: V3): V3 => [p[0], p[1], -p[2]];
const ox = (p: V3, dx: number): V3 => [p[0] + dx, p[1], p[2]];

/**
 * Traditional crane: a small body with a raised pyramid back, two big triangular wings
 * lifted in a shallow V, a thin neck rising forward with the head bent down, and a taller,
 * straighter tail.
 */
function crane(): Shape {
  const F: V3 = [0, -0.08, 0.34]; // where the neck leaves the body
  const B: V3 = [0, -0.08, -0.34]; // where the tail leaves the body
  const K: V3 = [0, -0.3, 0]; // bottom of the body pocket
  const P: V3 = [0, 0.2, 0]; // top of the pyramid back
  const Rf: V3 = [0.1, 0.04, 0.3]; // wing root, front
  const Rb: V3 = [0.1, 0.04, -0.3]; // wing root, back
  const Rm: V3 = [0.1, 0.1, 0]; // wing root middle (slight ridge)
  const tip: V3 = [0.95, 0.58, -0.14];

  const faces: V3[][] = [];
  for (const m of [(p: V3) => p, mx]) {
    // Pyramid back.
    faces.push([P, m(Rf), m(Rb)]);
    // Body side under the wing.
    faces.push([m(Rf), m(Rb), K], [m(Rf), K, F], [m(Rb), B, K]);
    // Broad wing along the whole body, creased down its middle.
    faces.push([m(Rf), m(tip), m(Rm)], [m(Rm), m(tip), m(Rb)]);
  }
  faces.push([P, Rf, mx(Rf)], [Rf, F, mx(Rf)], [P, Rb, mx(Rb)], [Rb, B, mx(Rb)]);

  // Neck, head and tail as thin two-layer points.
  const Nt: V3 = [0, 0.62, 0.72];
  const Nh: V3 = [0, 0.52, 0.64];
  const Hb: V3 = [0, 0.32, 0.86];
  const Tt: V3 = [0, 0.9, -0.68];
  for (const s of [-1, 1]) {
    faces.push([ox(F, 0.035 * s), Nt, ox([0, 0.05, 0.25], 0.035 * s)]);
    faces.push([ox(Nh, 0.025 * s), Nt, Hb]);
    faces.push([ox(B, 0.035 * s), Tt, ox([0, 0.05, -0.25], 0.035 * s)]);
  }
  const lines: [V3, V3][] = [
    [Rf, tip],
    [mx(Rf), mx(tip)],
  ];
  return { faces, lines, tilt: 0, targets: [tip, Hb] };
}

/**
 * Two-sheet ninja star: four pinwheel blades in alternating colors. Each blade covers one
 * quarter of the center square plus its point.
 */
function shuriken(): Shape {
  const C = 0.06; // center thickness (layers overlap there)
  const E = 0.035;
  const blade: [number, number][] = [
    [0.3, 0.3],
    [-0.3, 0.95],
    [-0.3, 0.3],
  ];
  const faces: V3[][] = [];
  const tones: number[] = [];
  const lines: [V3, V3][] = [];
  const targets: V3[] = [];
  const rot = (x: number, y: number, k: number): [number, number] => {
    let p: [number, number] = [x, y];
    for (let i = 0; i < k; i++) p = [p[1], -p[0]];
    return p;
  };
  for (let k = 0; k < 4; k++) {
    const [r, t, l] = blade.map(([x, y]) => rot(x, y, k));
    const tone = k % 2 ? 0.62 : 1.1;
    for (const side of [1, -1]) {
      const c: V3 = [0, 0, C * side];
      const R: V3 = [r[0], r[1], E * side];
      const L: V3 = [l[0], l[1], E * side];
      const T: V3 = [t[0], t[1], 0];
      faces.push([c, R, L], [R, T, L]);
      tones.push(tone, tone);
      if (side === 1) {
        lines.push([c, R]);
        if (k < 2) targets.push(T);
      }
    }
  }
  return { faces, tones, lines, tilt: -0.7, targets };
}

/**
 * Glider-style paper plane: wide delta wings with a center spine, a keel underneath and
 * upturned winglets along the outer edges.
 */
function plane(): Shape {
  const N: V3 = [0, 0, 0.95];
  const Tl: V3 = [0, 0, -0.7];
  const Wf: V3 = [0.62, 0.08, -0.02]; // outer wing corner, front
  const Wb: V3 = [0.62, 0.08, -0.7]; // outer wing corner, back
  const faces: V3[][] = [];
  for (const m of [(p: V3) => p, mx]) {
    faces.push([N, m(Wf), m(Wb), Tl]);
    // Winglet standing up along the outer edge.
    faces.push([m(ox(Wf, 0)), m(Wb), m([0.62, 0.32, -0.7]), m([0.62, 0.3, -0.16])]);
  }
  // Keel: two layers hanging under the spine.
  for (const s of [-1, 1]) faces.push([ox([0, 0, 0.82], 0.015 * s), ox(Tl, 0.015 * s), ox([0, -0.2, -0.7], 0.015 * s), ox([0, -0.2, 0.05], 0.015 * s)]);
  const lines: [V3, V3][] = [
    [N, [0.2, 0.026, -0.7]],
    [N, [-0.2, 0.026, -0.7]],
  ];
  return { faces, lines, tilt: 0, targets: [N, [0.62, 0.32, -0.7]] };
}

/** Classic cup: front and back panels bowed open, with the folded-down flap on the front. */
function cup(): Shape {
  const TL: V3 = [-0.83, 0.5, 0];
  const TM: V3 = [0, 0.5, 0.32];
  const BM: V3 = [0, -0.5, 0.12];
  const BL: V3 = [-0.34, -0.5, 0];
  const front: V3[][] = [
    [TL, TM, BM],
    [TL, BM, BL],
    [mx(TL), TM, BM],
    [mx(TL), BM, mx(BL)],
  ];
  const back = front.map((f) => f.map(mz));
  const flap: V3[] = [
    [-0.5, 0.5, 0.16],
    [0.5, 0.5, 0.16],
    [0, 0.0, 0.25],
  ];
  return { faces: [...front, ...back, flap], lines: [], tilt: 0, targets: [mx(TL), BM] };
}

/**
 * Fortune teller (cootie catcher): four square pockets, each a pyramid whose point leans
 * toward the center, so from above you see four squares creased toward the middle.
 */
function fortune(): Shape {
  const faces: V3[][] = [];
  const lines: [V3, V3][] = [];
  const targets: V3[] = [];
  const g = 0.04; // gap between pockets
  for (const sx of [1, -1])
    for (const sz of [1, -1]) {
      const q = (x: number, y: number, z: number): V3 => [x * sx, y, z * sz];
      const a = q(g, 0, g);
      const b = q(0.95, 0, g);
      const c = q(0.95, 0, 0.95);
      const d = q(g, 0, 0.95);
      const apex = q(0.36, 0.62, 0.36);
      faces.push([apex, a, b], [apex, b, c], [apex, c, d], [apex, d, a]);
      lines.push([apex, c]);
      if (sx === 1) targets.push(apex);
    }
  return { faces, lines, tilt: 0.6, targets };
}

/** Fallback for scanned or generated models: the final step's outline as a thin slab. */
function outline(plan: GuidePlan): Shape {
  const last = plan.steps[plan.steps.length - 1];
  if (!last || last.shape.length < 3) return shuriken();
  const pts = realShape(last).map((p) => [p.x, -p.y] as [number, number]);
  const face = (z: number) => pts.map(([x, y]) => [x, y, z] as V3);
  const lines: [V3, V3][] = last.lines.map((l) => [
    [l.from.x * last.aspect, -l.from.y, 0.04],
    [l.to.x * last.aspect, -l.to.y, 0.04],
  ]);
  const f = face(0.035);
  return { faces: [f, face(-0.035)], lines, tilt: -0.7, targets: [f[0], f[Math.floor(f.length / 2)]] };
}

function normalize(m: HoloModel): HoloModel {
  const all = [...m.faces.flat(), ...m.lines.flat()];
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of all)
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], p[i]);
      hi[i] = Math.max(hi[i], p[i]);
    }
  const c = lo.map((v, i) => (v + hi[i]) / 2);
  let r = 1e-6;
  for (const p of all) r = Math.max(r, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
  const f = (p: V3): V3 => [(p[0] - c[0]) / r, (p[1] - c[1]) / r, (p[2] - c[2]) / r];
  return {
    ...m,
    faces: m.faces.map((face) => face.map(f)),
    lines: m.lines.map(([a, b]) => [f(a), f(b)]),
    targets: m.targets.map(f),
  };
}

export function modelFor(plan: GuidePlan): HoloModel {
  const key = `${plan.id} ${plan.title}`.toLowerCase();
  let m: HoloModel;
  if (/crane|tsuru/.test(key)) m = { kind: "crane", label: "TSURU · CRANE", spin: "yaw", ...crane() };
  else if (/shuriken|ninja|throwing star/.test(key)) m = { kind: "shuriken", label: "SHURIKEN", spin: "roll", ...shuriken() };
  else if (/fortune|cootie|chatterbox|salt cellar/.test(key)) m = { kind: "fortune", label: "FORTUNE TELLER", spin: "yaw", ...fortune() };
  else if (/plane|dart|glider|jet/.test(key)) m = { kind: "plane", label: "GLIDER", spin: "yaw", ...plane() };
  else if (/\bcup\b/.test(key)) m = { kind: "cup", label: "VESSEL · CUP", spin: "yaw", ...cup() };
  else m = { kind: "outline", label: "FINAL OUTLINE", spin: "roll", ...outline(plan) };
  return normalize(m);
}
