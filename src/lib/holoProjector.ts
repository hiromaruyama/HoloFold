/**
 * Canvas renderer for the hologram preview: a projector pad, a light beam, and the finished
 * model spinning above it as a dot-matrix hologram, with orbit rings, target reticles and
 * HUD read-outs. Everything is drawn additively so overlapping light gets brighter.
 *
 * The dot matrix works like an LED panel: faces are rasterized into a small offscreen
 * buffer (one pixel per dot), then each lit pixel is drawn as a square on the main canvas.
 */
import type { HoloModel, V3 } from "./holoModels";

export interface ProjectorState {
  /** Seconds since the preview opened. */
  t: number;
  /** Spin angle around the vertical axis (radians). */
  yaw: number;
  /** 0 → 1 materialize progress (the model builds up from the pad). */
  reveal: number;
  reduced: boolean;
  /** Seed for decorative read-outs, so each model shows its own binary strings. */
  seed: number;
  /** Look: the hologram, a colorful paper model on a craft mat, or an ink drawing on a wooden stand. */
  style?: "holo" | "paper" | "washi";
}

/** Paper colors per model in the Paper Craft theme. */
const PAPER_COLORS: Record<HoloModel["kind"], string> = {
  crane: "#e8613c",
  shuriken: "#3fae5a",
  plane: "#3a8fd9",
  cup: "#3fae5a",
  fortune: "#f2b84b",
  outline: "#8a5cd6",
};

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Base color lit by `light` (0 = deep shade, 1 = full light, >1 toward white). */
function shade([r, g, b]: [number, number, number], light: number): string {
  const f = (c: number) => Math.round(light <= 1 ? c * (0.55 + 0.45 * light) : c + (255 - c) * (light - 1));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

/** Full unit normal of a flat polygon (Newell's method). */
function normal3(face: V3[]): V3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < face.length; i++) {
    const a = face[i];
    const b = face[(i + 1) % face.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

const LIGHT: V3 = (() => {
  const v: V3 = [-0.45, 0.75, 0.55];
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
})();

interface Projected {
  pts: { x: number; y: number }[];
  nz: number;
  tone: number;
}

const PITCH = 0.3; // camera looks slightly down at the model
const CAM = 3.4; // camera distance in model radii

const DOT_COLORS = [
  "rgba(30,110,255,0.35)",
  "rgba(40,140,255,0.5)",
  "rgba(50,170,255,0.62)",
  "rgba(60,200,255,0.74)",
  "rgba(80,220,255,0.85)",
  "rgba(120,235,255,0.92)",
  "rgba(170,245,255,0.96)",
  "rgba(225,252,255,1)",
];

const rand = (i: number) => {
  const s = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
};
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function rotX(p: V3, a: number): V3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
}
function rotZ(p: V3, a: number): V3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]];
}
function rotY(p: V3, a: number): V3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
}

/** Unit normal of a flat polygon (Newell's method); only its z matters here. */
function normalZ(face: V3[]): number {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < face.length; i++) {
    const a = face[i];
    const b = face[(i + 1) % face.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  return nz / l;
}

function buildEdges(m: HoloModel): [V3, V3][] {
  const seen = new Set<string>();
  const out: [V3, V3][] = [];
  const k = (p: V3) => p.map((v) => v.toFixed(3)).join(",");
  const add = (a: V3, b: V3) => {
    const ka = k(a);
    const kb = k(b);
    const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push([a, b]);
  };
  for (const f of m.faces) for (let i = 0; i < f.length; i++) add(f[i], f[(i + 1) % f.length]);
  for (const [a, b] of m.lines) add(a, b);
  return out;
}

function binaryString(seed: number, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += rand(seed * 31 + i) > 0.5 ? "1" : "0";
  return s;
}

export class HoloProjector {
  private buf: HTMLCanvasElement;
  private bctx: CanvasRenderingContext2D;
  private edges: [V3, V3][];
  private bits: string;
  private traces: { pts: [number, number][]; key: string } | null = null;

  constructor(private model: HoloModel) {
    this.buf = document.createElement("canvas");
    this.bctx = this.buf.getContext("2d", { willReadFrequently: true })!;
    this.edges = buildEdges(model);
    this.bits = "";
  }

  draw(ctx: CanvasRenderingContext2D, w: number, h: number, s: ProjectorState) {
    if (s.style && s.style !== "holo") return this.drawSolid(ctx, w, h, s, s.style);
    if (!this.bits) this.bits = binaryString(s.seed, 96);
    const compact = w < 560;
    const R = Math.min(w * (compact ? 0.38 : 0.3), h * 0.29);
    const cx = w / 2;
    const baseY = h * 0.86;
    const cy = h * 0.43 + (s.reduced ? 0 : Math.sin(s.t * 1.2) * R * 0.025);
    const power = s.reduced ? 1 : clamp01(s.t / 0.35);
    let flicker = s.reduced ? 1 : 0.93 + 0.07 * Math.sin(s.t * 31) * Math.sin(s.t * 7.3);
    if (!s.reduced && rand(Math.floor(s.t * 8)) > 0.975) flicker *= 0.72;

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    this.drawTraces(ctx, w, h, s.t);
    this.drawAmbient(ctx, cx, cy, baseY, R, power);
    this.drawBeam(ctx, cx, cy, baseY, R, power, s.t);
    this.drawPad(ctx, cx, baseY, R, power, s.t, s.reduced);
    if (!s.reduced) this.drawParticles(ctx, cx, cy, baseY, R, power, s.t);

    const tilt = this.model.tilt;
    const sway = s.reduced ? 0 : Math.sin(s.t * 0.6) * 0.35;
    const xf =
      this.model.spin === "roll"
        ? (p: V3) => rotX(rotY(rotX(rotZ(p, s.yaw), tilt), sway), PITCH)
        : (p: V3) => rotX(rotY(p, s.yaw), tilt + PITCH); // turntable: tilt stays fixed toward the camera
    const proj = (p: V3) => {
      const k = (R * CAM) / (CAM - p[2]);
      return { x: cx + p[0] * k, y: cy - p[1] * k, z: p[2] };
    };
    const tones = this.model.tones;
    const faces: Projected[] = this.model.faces.map((f, i) => {
      const v = f.map(xf);
      return { pts: v.map(proj), nz: normalZ(v), tone: tones?.[i] ?? 1 };
    });

    const orbitY = cy + R * 0.18;
    this.drawOrbit(ctx, cx, orbitY, R, s.t, "back", power);
    const revealY = cy + R * 1.15 - s.reveal * R * 2.4;
    this.drawModel(ctx, faces, cx, cy, R, revealY, flicker, s);
    this.drawEdges(ctx, xf, proj, revealY, flicker);
    this.drawOrbit(ctx, cx, orbitY, R, s.t, "front", power);
    if (s.reveal >= 1) this.drawTargets(ctx, xf, proj, R, s.t);
    if (s.reveal > 0 && s.reveal < 1) {
      const g = ctx.createLinearGradient(cx - R * 1.3, 0, cx + R * 1.3, 0);
      g.addColorStop(0, "rgba(120,230,255,0)");
      g.addColorStop(0.5, "rgba(200,250,255,0.9)");
      g.addColorStop(1, "rgba(120,230,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(cx - R * 1.3, revealY - 1, R * 2.6, 2);
    }
    this.drawHud(ctx, cx, cy, R, s.t, power, compact);
    ctx.restore();
  }

  /** Faint circuit traces in the background, regenerated when the size changes. */
  private drawTraces(ctx: CanvasRenderingContext2D, w: number, h: number, t: number) {
    const key = `${Math.round(w)}x${Math.round(h)}`;
    if (!this.traces || this.traces.key !== key) {
      const pts: [number, number][] = [];
      for (let i = 0; i < 16; i++) {
        const x = rand(i * 5 + 1) * w;
        const y0 = rand(i * 5 + 2) * h;
        const y1 = y0 + (rand(i * 5 + 3) - 0.5) * h * 0.5;
        const x1 = x + (rand(i * 5 + 4) - 0.5) * w * 0.3;
        pts.push([x, y0], [x, y1], [x1, y1]);
      }
      this.traces = { pts, key };
    }
    const p = this.traces.pts;
    ctx.strokeStyle = "rgba(60,140,255,0.07)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < p.length; i += 3) {
      ctx.moveTo(p[i][0], p[i][1]);
      ctx.lineTo(p[i + 1][0], p[i + 1][1]);
      ctx.lineTo(p[i + 2][0], p[i + 2][1]);
    }
    ctx.stroke();
    for (let i = 0; i < p.length; i += 3) {
      const a = 0.1 + 0.12 * (0.5 + 0.5 * Math.sin(t * 2 + i));
      ctx.fillStyle = `rgba(80,170,255,${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(p[i + 2][0], p[i + 2][1], 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawAmbient(ctx: CanvasRenderingContext2D, cx: number, cy: number, baseY: number, R: number, power: number) {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.9);
    g.addColorStop(0, `rgba(30,120,255,${(0.2 * power).toFixed(3)})`);
    g.addColorStop(1, "rgba(30,120,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(cx - R * 2, cy - R * 2, R * 4, R * 4);
    ctx.save();
    ctx.translate(cx, baseY);
    ctx.scale(1, 0.22);
    const f = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 2);
    f.addColorStop(0, `rgba(40,150,255,${(0.28 * power).toFixed(3)})`);
    f.addColorStop(1, "rgba(40,150,255,0)");
    ctx.fillStyle = f;
    ctx.beginPath();
    ctx.arc(0, 0, R * 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawBeam(ctx: CanvasRenderingContext2D, cx: number, cy: number, baseY: number, R: number, power: number, t: number) {
    const top = cy - R * 0.2;
    const cone = (bw: number, tw: number, a0: number, a1: number) => {
      const g = ctx.createLinearGradient(0, baseY, 0, top - R * 0.4);
      g.addColorStop(0, `rgba(150,230,255,${(a0 * power).toFixed(3)})`);
      g.addColorStop(0.55, `rgba(60,160,255,${(a1 * power).toFixed(3)})`);
      g.addColorStop(1, "rgba(40,120,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(cx - bw, baseY);
      ctx.lineTo(cx - tw, top - R * 0.4);
      ctx.lineTo(cx + tw, top - R * 0.4);
      ctx.lineTo(cx + bw, baseY);
      ctx.closePath();
      ctx.fill();
    };
    cone(R * 0.34, R * 1.1, 0.42, 0.1);
    cone(R * 0.14, R * 0.42, 0.45, 0.12);
    // Flickering light streaks inside the cone.
    ctx.lineWidth = 1;
    for (let i = 0; i < 9; i++) {
      const u = (i / 8 - 0.5) * 2;
      const a = (0.05 + 0.13 * Math.abs(Math.sin(t * (2 + rand(i) * 3) + i))) * power;
      ctx.strokeStyle = `rgba(160,235,255,${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(cx + u * R * 0.3, baseY);
      ctx.lineTo(cx + u * R * 0.95, top - R * 0.2);
      ctx.stroke();
    }
  }

  private drawPad(ctx: CanvasRenderingContext2D, cx: number, baseY: number, R: number, power: number, t: number, reduced: boolean) {
    const rx = R * 1.0;
    const sq = 0.22;
    const ring = (r: number, width: number, alpha: number, dash: number[] = [], speed = 0) => {
      ctx.save();
      ctx.lineWidth = width;
      ctx.strokeStyle = `rgba(80,190,255,${(alpha * power).toFixed(3)})`;
      ctx.setLineDash(dash);
      ctx.lineDashOffset = reduced ? 0 : t * speed;
      ctx.beginPath();
      ctx.ellipse(cx, baseY, r, r * sq, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    };
    ring(rx * 1.22, 1, 0.45, [2, 9], 18);
    ring(rx * 1.04, 1.2, 0.55);
    ring(rx * 0.86, 6, 0.32, [18, 7], -28);
    ring(rx * 0.66, 1, 0.6);
    ring(rx * 0.5, 2.5, 0.5, [6, 4], 40);
    ring(rx * 1.04, 3, 0.18, [rx * 0.6, rx * 1.4], -60);

    const pulse = reduced ? 1 : 0.85 + 0.15 * Math.sin(t * 3.2);
    ctx.save();
    ctx.translate(cx, baseY);
    ctx.scale(1, sq);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx * 0.48);
    g.addColorStop(0, `rgba(235,252,255,${(0.95 * power * pulse).toFixed(3)})`);
    g.addColorStop(0.3, `rgba(110,215,255,${(0.6 * power).toFixed(3)})`);
    g.addColorStop(1, "rgba(20,100,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, rx * 0.48, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawParticles(ctx: CanvasRenderingContext2D, cx: number, cy: number, baseY: number, R: number, power: number, t: number) {
    const top = cy - R * 0.5;
    for (let i = 0; i < 36; i++) {
      const period = 2.4 + rand(i) * 2;
      const ph = (t / period + rand(i * 3 + 1)) % 1;
      const spread = (R * 0.3 + (R * 0.9 - R * 0.3) * ph) * (rand(i * 7 + 2) * 2 - 1);
      const x = cx + spread;
      const y = baseY - ph * (baseY - top);
      const a = Math.sin(ph * Math.PI) * 0.65 * power;
      ctx.fillStyle = `rgba(170,240,255,${a.toFixed(3)})`;
      ctx.fillRect(x - 1, y - 1, 2, 2);
    }
  }

  private drawOrbit(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, t: number, half: "back" | "front", power: number) {
    const rx = R * 1.24;
    const ry = R * 0.2;
    const [a0, a1] = half === "back" ? [Math.PI, Math.PI * 2] : [0, Math.PI];
    const alpha = (half === "back" ? 0.22 : 0.5) * power;
    ctx.save();
    ctx.strokeStyle = `rgba(90,200,255,${alpha.toFixed(3)})`;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 7]);
    ctx.lineDashOffset = -t * 14;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, a0, a1);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = `rgba(90,200,255,${(alpha * 0.45).toFixed(3)})`;
    ctx.beginPath();
    ctx.ellipse(cx, cy - R * 0.1, rx * 1.08, ry * 1.5, -0.28, a0, a1);
    ctx.stroke();
    ctx.restore();
    // A satellite blip riding the ring, drawn on whichever half it is on.
    const ang = (t * 0.9) % (Math.PI * 2);
    const onBack = Math.sin(ang) < 0;
    if (onBack === (half === "back")) {
      const x = cx + Math.cos(ang) * rx;
      const y = cy + Math.sin(ang) * ry;
      const g = ctx.createRadialGradient(x, y, 0, x, y, 9);
      g.addColorStop(0, `rgba(220,250,255,${(0.95 * power).toFixed(3)})`);
      g.addColorStop(1, "rgba(80,190,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x - 9, y - 9, 18, 18);
    }
  }

  private drawModel(
    ctx: CanvasRenderingContext2D,
    faces: Projected[],
    cx: number,
    cy: number,
    R: number,
    revealY: number,
    flicker: number,
    s: ProjectorState,
  ) {
    const cell = Math.max(3.5, R / 24);
    const span = R * 2.7;
    const x0 = cx - span / 2;
    const y0 = cy - span / 2;
    const cols = Math.ceil(span / cell);
    const rows = cols;
    if (this.buf.width !== cols || this.buf.height !== rows) {
      this.buf.width = cols;
      this.buf.height = rows;
    }
    const b = this.bctx;
    b.globalCompositeOperation = "source-over";
    b.clearRect(0, 0, cols, rows);
    b.globalCompositeOperation = "lighter";
    for (const f of faces) {
      const level = Math.min(255, (55 + 120 * Math.abs(f.nz)) * f.tone);
      b.fillStyle = `rgb(${(level * 0.25) | 0},${(level * 0.7) | 0},${level | 0})`;
      b.beginPath();
      f.pts.forEach((p, i) => {
        const x = (p.x - x0) / cell;
        const y = (p.y - y0) / cell;
        if (i === 0) b.moveTo(x, y);
        else b.lineTo(x, y);
      });
      b.closePath();
      b.fill();
    }

    // Soft glow: the tiny buffer scaled up with smoothing.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0 - R, revealY, span + 2 * R, span + R);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.5 * flicker;
    ctx.drawImage(this.buf, x0 - cell, y0 - cell, span + cell * 2, span + cell * 2);
    ctx.globalAlpha = 0.22 * flicker;
    ctx.drawImage(this.buf, x0 - cell * 5, y0 - cell * 5, span + cell * 10, span + cell * 10);
    ctx.restore();

    const data = b.getImageData(0, 0, cols, rows).data;
    const ds = cell * 0.74;
    const pad = (cell - ds) / 2;
    const buckets: number[][] = DOT_COLORS.map(() => []);
    const glitchOn = !s.reduced && s.t % 3.7 < 0.12;
    const gi = Math.floor(s.t / 3.7);
    const gr0 = Math.floor(rand(gi + 11) * rows);
    const gShift = (rand(gi + 23) - 0.5) * cell * 7;
    const bandY = s.reduced ? -1e9 : y0 + ((s.t * 0.42) % 1) * span;
    for (let r = 0; r < rows; r++) {
      const Y = y0 + r * cell;
      if (Y + cell < revealY) continue;
      const shift = glitchOn && r >= gr0 && r < gr0 + 3 ? gShift : 0;
      const inBand = Math.abs(Y - bandY) < cell * 1.6;
      for (let c = 0; c < cols; c++) {
        const g = data[(r * cols + c) * 4 + 1];
        if (g < 10) continue;
        let k = Math.min(7, Math.floor(g / 30));
        if (inBand) k = Math.min(7, k + 2);
        buckets[k].push(x0 + c * cell + pad + shift, Y + pad);
      }
    }
    ctx.save();
    ctx.globalAlpha = flicker;
    buckets.forEach((pts, k) => {
      if (!pts.length) return;
      ctx.fillStyle = DOT_COLORS[k];
      ctx.beginPath();
      for (let i = 0; i < pts.length; i += 2) ctx.rect(pts[i], pts[i + 1], ds, ds);
      ctx.fill();
    });
    ctx.restore();
  }

  private drawEdges(
    ctx: CanvasRenderingContext2D,
    xf: (p: V3) => V3,
    proj: (p: V3) => { x: number; y: number },
    revealY: number,
    flicker: number,
  ) {
    const segs = this.edges.map(([a, b]) => [proj(xf(a)), proj(xf(b))]);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, revealY, ctx.canvas.width, ctx.canvas.height);
    ctx.clip();
    const path = new Path2D();
    for (const [a, b] of segs) {
      path.moveTo(a.x, a.y);
      path.lineTo(b.x, b.y);
    }
    ctx.lineCap = "round";
    ctx.lineWidth = 4;
    ctx.strokeStyle = `rgba(60,170,255,${(0.16 * flicker).toFixed(3)})`;
    ctx.stroke(path);
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = `rgba(175,240,255,${(0.75 * flicker).toFixed(3)})`;
    ctx.stroke(path);
    ctx.fillStyle = `rgba(230,252,255,${(0.9 * flicker).toFixed(3)})`;
    for (const [a] of segs) ctx.fillRect(a.x - 1.5, a.y - 1.5, 3, 3);
    ctx.restore();
  }

  private drawTargets(
    ctx: CanvasRenderingContext2D,
    xf: (p: V3) => V3,
    proj: (p: V3) => { x: number; y: number; z: number },
    R: number,
    t: number,
  ) {
    const r = R * 0.12;
    this.model.targets.forEach((p, i) => {
      const q = proj(xf(p));
      const a = q.z > 0 ? 0.75 : 0.3;
      ctx.save();
      ctx.translate(q.x, q.y);
      ctx.strokeStyle = `rgba(150,230,255,${a})`;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.rotate(t * (i ? -1.4 : 1.1));
      ctx.setLineDash([r * 0.5, r * 0.35]);
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.66, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = 0; k < 4; k++) {
        const ang = (k * Math.PI) / 2;
        ctx.moveTo(Math.cos(ang) * r * 1.1, Math.sin(ang) * r * 1.1);
        ctx.lineTo(Math.cos(ang) * r * 1.45, Math.sin(ang) * r * 1.45);
      }
      ctx.stroke();
      ctx.restore();
    });
  }

  private drawHud(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, t: number, power: number, compact: boolean) {
    const a = (v: number) => (v * power).toFixed(3);
    // Sliding data bars, left and right of the model.
    const bars = (x: number, y: number, dir: 1 | -1, n: number, len: number) => {
      ctx.lineWidth = 2;
      for (let i = 0; i < n; i++) {
        const l = len * (0.55 + 0.45 * Math.abs(Math.sin(t * 0.8 + i * 1.7)));
        const off = len * 0.12 * i;
        ctx.strokeStyle = `rgba(80,190,255,${a(0.55 - i * 0.08)})`;
        ctx.beginPath();
        ctx.moveTo(x + dir * off, y + i * 7);
        ctx.lineTo(x + dir * (off + l), y + i * 7);
        ctx.stroke();
      }
    };
    bars(cx - R * 0.7, cy - R * 0.42, -1, 4, R * 0.9);
    bars(cx + R * 0.62, cy - R * 0.05, 1, 4, R * 0.95);
    bars(cx + R * 0.75, cy - R * 0.72, 1, 2, R * 0.5);

    // Equalizer ticks.
    const eq = (x: number, y: number, n: number) => {
      ctx.fillStyle = `rgba(90,200,255,${a(0.45)})`;
      for (let i = 0; i < n; i++) {
        const hgt = 2 + 7 * Math.abs(Math.sin(t * 2.6 + i * 0.7) * Math.sin(i * 1.3 + 1));
        ctx.fillRect(x + i * 4, y - hgt, 2, hgt);
      }
    };
    eq(cx - R * 1.62, cy - R * 0.16, Math.round(R * 0.2));
    eq(cx + R * 0.66, cy + R * 0.36, Math.round(R * 0.2));

    // Rows of status boxes that fill in like a loader.
    const boxes = (x: number, y: number) => {
      const sz = Math.max(8, R * 0.07);
      const lit = Math.floor(t * 2) % 8;
      for (let i = 0; i < 6; i++) {
        ctx.strokeStyle = `rgba(90,190,255,${a(0.5)})`;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + i * (sz + 3), y, sz, sz);
        if (i < lit) {
          ctx.fillStyle = `rgba(90,200,255,${a(0.32)})`;
          ctx.fillRect(x + i * (sz + 3) + 2, y + 2, sz - 4, sz - 4);
        }
      }
    };
    boxes(cx - R * 1.62, cy + R * 0.22);
    boxes(cx + R * 0.9, cy - R * 0.32);
    if (!compact) boxes(cx - R * 0.3, cy + R * 1.2);

    // Scrolling binary read-outs.
    if (!compact) {
      const fs = Math.max(11, Math.round(R * 0.075));
      ctx.font = `${fs}px "JetBrains Mono", ui-monospace, monospace`;
      ctx.fillStyle = `rgba(120,200,255,${a(0.38)})`;
      const shift = Math.floor(t * 5);
      const slice = (off: number, n: number) => {
        const st = (shift + off) % (this.bits.length - n);
        return this.bits.slice(st, st + n);
      };
      ctx.fillText(slice(0, 12), cx + R * 0.82, cy - R * 0.9);
      ctx.fillText(slice(17, 13), cx - R * 1.95, cy + R * 0.05);
      ctx.fillText(slice(41, 16), cx + R * 0.35, cy + R * 0.62);
    }
  }

  /** Paper Craft and Washi: a solid, shaded model on a mat or wooden stand. No glow, no HUD. */
  private drawSolid(ctx: CanvasRenderingContext2D, w: number, h: number, s: ProjectorState, style: "paper" | "washi") {
    const R = Math.min(w * (w < 560 ? 0.38 : 0.3), h * 0.3);
    const cx = w / 2;
    const baseY = h * 0.84;
    const pop = s.reduced ? 1 : s.reveal < 1 ? 1 + 1.6 * Math.pow(s.reveal - 1, 3) + 0.6 * Math.pow(s.reveal - 1, 2) : 1;
    const scale = Math.max(0.01, pop);
    const cy = h * 0.44 + (s.reduced ? 0 : Math.sin(s.t * 1.4) * R * 0.03);
    ctx.clearRect(0, 0, w, h);

    // Stand.
    const rx = R * 1.05;
    const ry = rx * 0.22;
    if (style === "paper") {
      ctx.fillStyle = "rgba(120, 70, 30, 0.12)";
      ctx.beginPath();
      ctx.ellipse(cx, baseY + 6, rx * 1.08, ry * 1.1, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffe3b0";
      ctx.beginPath();
      ctx.ellipse(cx, baseY, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#e8a25c";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.ellipse(cx, baseY, rx * 0.86, ry * 0.86, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      const band = ry * 0.7;
      ctx.fillStyle = "rgba(31, 42, 68, 0.1)";
      ctx.beginPath();
      ctx.ellipse(cx, baseY + band + 8, rx * 1.12, ry * 1.1, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#8a5f33";
      ctx.beginPath();
      ctx.ellipse(cx, baseY + band, rx, ry, 0, 0, Math.PI);
      ctx.lineTo(cx - rx, baseY);
      ctx.ellipse(cx, baseY, rx, ry, 0, Math.PI, 0, true);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#b9874f";
      ctx.beginPath();
      ctx.ellipse(cx, baseY, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(90, 55, 25, 0.35)";
      ctx.lineWidth = 1;
      for (const k of [0.75, 0.5]) {
        ctx.beginPath();
        ctx.ellipse(cx, baseY, rx * k, ry * k, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    // Soft contact shadow under the floating model.
    ctx.fillStyle = style === "paper" ? "rgba(120, 70, 30, 0.16)" : "rgba(31, 42, 68, 0.14)";
    ctx.beginPath();
    ctx.ellipse(cx, baseY, rx * 0.55 * scale, ry * 0.5 * scale, 0, 0, Math.PI * 2);
    ctx.fill();

    // Model, painted back to front.
    const tilt = this.model.tilt;
    const sway = s.reduced ? 0 : Math.sin(s.t * 0.6) * 0.35;
    const xf =
      this.model.spin === "roll"
        ? (p: V3) => rotX(rotY(rotX(rotZ(p, s.yaw), tilt), sway), PITCH)
        : (p: V3) => rotX(rotY(p, s.yaw), tilt + PITCH);
    const proj = (p: V3) => {
      const k = (R * scale * CAM) / (CAM - p[2]);
      return { x: cx + p[0] * k, y: cy - p[1] * k };
    };
    const base = hexRgb(PAPER_COLORS[this.model.kind]);
    const second = hexRgb("#f2b84b");
    const faces = this.model.faces.map((f, i) => {
      const v = f.map(xf);
      const n = normal3(v);
      const depth = v.reduce((sum, p) => sum + p[2], 0) / v.length;
      return { pts: v.map(proj), n, depth, tone: this.model.tones?.[i] ?? 1 };
    });
    faces.sort((a, b) => a.depth - b.depth);
    ctx.lineJoin = "round";
    for (const f of faces) {
      const lambert = Math.abs(f.n[0] * LIGHT[0] + f.n[1] * LIGHT[1] + f.n[2] * LIGHT[2]);
      ctx.beginPath();
      f.pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      if (style === "paper") {
        const rgb = this.model.tones && f.tone > 1 ? second : base;
        ctx.fillStyle = shade(rgb, 0.35 + 0.75 * lambert);
        ctx.fill();
        ctx.strokeStyle = "rgba(74, 44, 26, 0.75)";
        ctx.lineWidth = 2;
      } else {
        const l = 0.82 + 0.18 * lambert;
        ctx.fillStyle = `rgb(${Math.round(251 * l)},${Math.round(248 * l)},${Math.round(241 * l)})`;
        ctx.fill();
        ctx.strokeStyle = "#1f2a44";
        ctx.lineWidth = 1.6;
      }
      ctx.stroke();
    }
    if (this.model.lines.length) {
      ctx.save();
      ctx.strokeStyle = style === "paper" ? "rgba(74, 44, 26, 0.5)" : "#c0392b";
      ctx.lineWidth = style === "paper" ? 1.5 : 1.2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      for (const [a, b] of this.model.lines) {
        const p = proj(xf(a));
        const q = proj(xf(b));
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();
      ctx.restore();
    }

    // Paper Craft: a few twinkling stars around the model.
    if (style === "paper" && !s.reduced) {
      for (let i = 0; i < 5; i++) {
        const a = s.t * 0.5 + (i * Math.PI * 2) / 5;
        const x = cx + Math.cos(a) * R * 1.35;
        const y = cy + Math.sin(a) * R * 0.35 - R * 0.2;
        const tw = 0.5 + 0.5 * Math.sin(s.t * 3 + i * 1.7);
        ctx.fillStyle = ["#f2b84b", "#e8613c", "#3a8fd9", "#3fae5a", "#e0608a"][i];
        ctx.globalAlpha = 0.5 + 0.5 * tw;
        star(ctx, x, y, 4 + 4 * tw);
        ctx.globalAlpha = 1;
      }
    }
  }
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (i * Math.PI) / 5 - Math.PI / 2;
    const rr = i % 2 ? r * 0.45 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
}
