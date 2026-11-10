/** Draws the AR layer over the camera feed, in the colors of the current theme. */
import type { Step } from "../../shared/schema";
import { animationAt, flapPolygon, foldArrow, foldFrame, foldPoint } from "./fold";
import { applyH, centroid, clamp, sub, type Vec } from "./geometry";
import type { ArPalette } from "./themes";
import type { TrackResult } from "./tracker";

const DASH: Record<string, number[]> = {
  V: [16, 10],
  M: [16, 6, 3, 6, 3, 6],
  F: [3, 7],
  U: [8, 8],
};

export function lineColor(pal: ArPalette, assignment: string): string {
  return assignment === "V" ? pal.valley : assignment === "M" ? pal.mountain : assignment === "F" ? pal.existing : pal.unknown;
}

export interface ViewTransform {
  scale: number;
  ox: number;
  oy: number;
  mirror: boolean;
  cw: number;
}

/** object-fit: cover mapping from video pixels to CSS pixels. */
export function coverTransform(vw: number, vh: number, cw: number, ch: number, mirror: boolean): ViewTransform {
  const scale = Math.max(cw / vw, ch / vh);
  return { scale, ox: (cw - vw * scale) / 2, oy: (ch - vh * scale) / 2, mirror, cw };
}

export function viewToVideo(v: ViewTransform, px: number, py: number): Vec {
  const x = v.mirror ? v.cw - px : px;
  return { x: (x - v.ox) / v.scale, y: (py - v.oy) / v.scale };
}

export interface ArLabels {
  placePaper: string;
  placeHint: string;
  turnOver: string;
  rotate: string;
}

export interface RenderState {
  ctx: CanvasRenderingContext2D;
  cw: number;
  ch: number;
  view: ViewTransform | null;
  track: TrackResult | null;
  step: Step;
  shapeReal: Vec[];
  t: number;
  /** 0–1 lock fade-in. */
  lock: number;
  flash: { kind: "complete" | "mistake"; t0: number } | null;
  checking: boolean;
  autoCheckProgress: number;
  pal: ArPalette;
  labels: ArLabels;
  /** Calm motion: no marching dashes, beams or pulsing. */
  reduced: boolean;
}

export function renderFrame(s: RenderState) {
  const { ctx, cw, ch, pal } = s;
  const t = s.reduced ? 0 : s.t;
  ctx.clearRect(0, 0, cw, ch);
  if (pal.chrome) drawFrameChrome(ctx, cw, ch, t, pal.chrome);

  const track = s.track;
  // The fold is done and only the finished outline fits: show that instead of "searching".
  const done = track && s.view && track.match === "after" && track.afterCorners ? track.afterCorners.map((p) => toView(s.view!, p)) : null;
  if (!track || !track.H || !s.view || s.lock <= 0.01) {
    if (done) {
      drawFinished(s, done, true);
      return;
    }
    drawSearching(ctx, cw, ch, t, s.lock, pal, s.labels);
    if (!track?.found) return;
  }
  if (!track.H || !s.view) return;

  const H = track.H;
  const view = s.view;
  const proj = (p: Vec): Vec => {
    const q = applyH(H, p);
    const x = q.x * view.scale + view.ox;
    return { x: view.mirror ? view.cw - x : x, y: q.y * view.scale + view.oy };
  };
  const k = pal.lineScale;

  ctx.save();
  ctx.globalAlpha = s.lock;
  const outline = s.shapeReal.map(proj);
  const step = s.step;

  // Paper body: soft fill, plus grid and scan beam in the hologram theme.
  ctx.save();
  pathPoly(ctx, outline);
  ctx.clip();
  const c = centroid(outline);
  const grad = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, Math.max(cw, ch) * 0.5);
  grad.addColorStop(0, pal.fill0);
  grad.addColorStop(1, pal.fill1);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, cw, ch);
  if (pal.grid) drawGrid(ctx, s.shapeReal, proj, pal.grid);
  if (pal.scanBeam && !s.reduced) drawScanBeam(ctx, s.shapeReal, proj, s.t);
  ctx.restore();

  // Outline.
  ctx.save();
  if (pal.halo) {
    ctx.strokeStyle = pal.halo;
    ctx.lineWidth = 2.2 * k + 4;
    ctx.lineJoin = "round";
    pathPoly(ctx, outline);
    ctx.stroke();
  }
  ctx.shadowColor = pal.outline;
  ctx.shadowBlur = 16 * pal.glow;
  ctx.strokeStyle = pal.outline;
  ctx.lineWidth = 2.2 * k;
  ctx.lineJoin = "round";
  pathPoly(ctx, outline);
  ctx.stroke();
  ctx.restore();
  if (pal.brackets) drawCornerBrackets(ctx, outline, t, pal);

  // Fold lines.
  step.lines.forEach((line) => {
    const color = lineColor(pal, line.assignment);
    const a = proj({ x: line.from.x * step.aspect, y: line.from.y });
    const b = proj({ x: line.to.x * step.aspect, y: line.to.y });
    const width = (line.assignment === "F" ? 1.6 : 3.2) * k;
    ctx.save();
    ctx.lineCap = "round";
    if (pal.halo) {
      ctx.strokeStyle = pal.halo;
      ctx.lineWidth = width + 4;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 14 * pal.glow;
    ctx.lineWidth = width;
    ctx.setLineDash((DASH[line.assignment] ?? DASH.U).map((d) => d * Math.sqrt(k)));
    ctx.lineDashOffset = -t * 42;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
    if (pal.sparks && line.assignment !== "F" && !s.reduced) drawSparks(ctx, a, b, color, s.t);
  });

  // Animated ghost flap, landing outline and fold arrow. Calm motion shows the folded result, still.
  const anim = animationAt(step, s.reduced ? 1.2 : s.t);
  if (anim.lineIndex >= 0) {
    const line = step.lines[anim.lineIndex];
    const fr = foldFrame(line, step.aspect);
    if (fr) {
      const flap = flapPolygon(s.shapeReal, fr, step);
      if (flap.length >= 3) {
        const color = lineColor(pal, line.assignment);
        const landing = flap.map((p) => proj(foldPoint(p, fr, Math.PI)));
        ctx.save();
        ctx.setLineDash([4, 6]);
        ctx.strokeStyle = pal.landing;
        ctx.lineWidth = 1.2 * k;
        pathPoly(ctx, landing);
        ctx.stroke();
        ctx.restore();

        const moving = flap.map((p) => proj(foldPoint(p, fr, anim.theta)));
        const back = anim.theta > Math.PI / 2;
        ctx.save();
        ctx.globalAlpha = s.lock * anim.alpha * (line.assignment === "M" ? 0.6 : 1);
        ctx.fillStyle = back ? pal.flapBack : pal.flapFront;
        ctx.strokeStyle = back ? pal.flapBackStroke : pal.flapFrontStroke;
        ctx.shadowColor = ctx.strokeStyle;
        ctx.shadowBlur = 18 * pal.glow;
        ctx.lineWidth = 2 * k;
        if (line.assignment === "M") ctx.setLineDash([6, 5]);
        pathPoly(ctx, moving);
        ctx.fill();
        ctx.stroke();
        ctx.restore();

        const arrow = foldArrow(flap, fr).map(proj);
        drawArrow(ctx, arrow, color, line.assignment === "M", s.lock * 0.95, pal);
      }
    }
  }

  if (step.action === "turn-over" || step.action === "rotate") {
    drawSpinGlyph(ctx, outline, t, step.action === "turn-over" ? s.labels.turnOver : s.labels.rotate, pal);
  }

  if (done) drawFinished(s, done, false);

  // Auto-check progress ring / checking pulse.
  if (s.checking || s.autoCheckProgress > 0) {
    const r = 34;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.strokeStyle = pal.halo ?? "rgba(56,249,255,0.25)";
    ctx.lineWidth = 3 * k;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = pal.ok;
    ctx.shadowColor = pal.ok;
    ctx.shadowBlur = 12 * pal.glow;
    ctx.beginPath();
    if (s.checking) ctx.arc(0, 0, r, s.t * 6, s.t * 6 + Math.PI * 0.6);
    else ctx.arc(0, 0, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * s.autoCheckProgress);
    ctx.stroke();
    ctx.restore();
  }

  // Result flash.
  if (s.flash) {
    const age = s.t - s.flash.t0;
    if (age < 1.4) {
      const col = s.flash.kind === "complete" ? pal.ok : pal.bad;
      ctx.save();
      ctx.globalAlpha = clamp(1 - age / 1.4);
      ctx.strokeStyle = col;
      ctx.shadowColor = col;
      ctx.shadowBlur = 30 * pal.glow;
      ctx.lineWidth = 4 * k + age * 10;
      pathPoly(ctx, outline);
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.restore();
}

function toView(v: ViewTransform, p: Vec): Vec {
  const x = p.x * v.scale + v.ox;
  return { x: v.mirror ? v.cw - x : x, y: p.y * v.scale + v.oy };
}

/**
 * Outline of the finished fold while it is being confirmed. `alone` is when nothing else is
 * drawn (the starting outline no longer fits), so the progress ring and flash go here too.
 */
function drawFinished(s: RenderState, pts: Vec[], alone: boolean) {
  const { ctx, pal } = s;
  const k = pal.lineScale;
  ctx.save();
  ctx.lineJoin = "round";
  if (pal.halo) {
    ctx.strokeStyle = pal.halo;
    ctx.lineWidth = 3 * k + 4;
    pathPoly(ctx, pts);
    ctx.stroke();
  }
  ctx.strokeStyle = pal.ok;
  ctx.shadowColor = pal.ok;
  ctx.shadowBlur = 14 * pal.glow;
  ctx.lineWidth = 3 * k;
  pathPoly(ctx, pts);
  ctx.stroke();
  if (alone) {
    const c = centroid(pts);
    if (s.autoCheckProgress > 0) {
      ctx.lineWidth = 3 * k;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 34, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * s.autoCheckProgress);
      ctx.stroke();
    }
    const age = s.flash ? s.t - s.flash.t0 : Infinity;
    if (s.flash?.kind === "complete" && age < 1.4) {
      ctx.globalAlpha = clamp(1 - age / 1.4);
      ctx.shadowBlur = 30 * pal.glow;
      ctx.lineWidth = 4 * k + age * 10;
      pathPoly(ctx, pts);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function pathPoly(ctx: CanvasRenderingContext2D, pts: Vec[]) {
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
}

function bounds(pts: Vec[]) {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

function drawGrid(ctx: CanvasRenderingContext2D, shape: Vec[], proj: (p: Vec) => Vec, color: string) {
  const b = bounds(shape);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  const N = 8;
  ctx.beginPath();
  for (let i = 1; i < N; i++) {
    const x = b.x0 + ((b.x1 - b.x0) * i) / N;
    const y = b.y0 + ((b.y1 - b.y0) * i) / N;
    const p1 = proj({ x, y: b.y0 });
    const p2 = proj({ x, y: b.y1 });
    const p3 = proj({ x: b.x0, y });
    const p4 = proj({ x: b.x1, y });
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.moveTo(p3.x, p3.y);
    ctx.lineTo(p4.x, p4.y);
  }
  ctx.stroke();
}

function drawScanBeam(ctx: CanvasRenderingContext2D, shape: Vec[], proj: (p: Vec) => Vec, t: number) {
  const b = bounds(shape);
  const k = (t * 0.45) % 1.4;
  const y = b.y0 + (b.y1 - b.y0) * (k - 0.2);
  const h = (b.y1 - b.y0) * 0.16;
  const quad = [proj({ x: b.x0, y: y - h }), proj({ x: b.x1, y: y - h }), proj({ x: b.x1, y }), proj({ x: b.x0, y })];
  const g = ctx.createLinearGradient((quad[0].x + quad[1].x) / 2, (quad[0].y + quad[1].y) / 2, (quad[2].x + quad[3].x) / 2, (quad[2].y + quad[3].y) / 2);
  g.addColorStop(0, "rgba(56,249,255,0)");
  g.addColorStop(1, "rgba(56,249,255,0.22)");
  ctx.fillStyle = g;
  pathPoly(ctx, quad);
  ctx.fill();
  ctx.strokeStyle = "rgba(160, 255, 255, 0.55)";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(quad[3].x, quad[3].y);
  ctx.lineTo(quad[2].x, quad[2].y);
  ctx.stroke();
}

function drawCornerBrackets(ctx: CanvasRenderingContext2D, pts: Vec[], t: number, pal: ArPalette) {
  const L = 16 + Math.sin(t * 4) * 2;
  ctx.save();
  ctx.strokeStyle = pal.brackets!;
  ctx.shadowColor = pal.outline;
  ctx.shadowBlur = 10 * pal.glow;
  ctx.lineWidth = 3 * pal.lineScale;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const prev = pts[(i - 1 + pts.length) % pts.length];
    const next = pts[(i + 1) % pts.length];
    const toward = (q: Vec) => {
      const d = sub(q, p);
      const l = Math.hypot(d.x, d.y) || 1;
      const kk = Math.min(L, l * 0.3) / l;
      return { x: p.x + d.x * kk, y: p.y + d.y * kk };
    };
    const a = toward(prev);
    const b = toward(next);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(p.x, p.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawSparks(ctx: CanvasRenderingContext2D, a: Vec, b: Vec, color: string, t: number) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  for (let i = 0; i < 3; i++) {
    const k = (t * 0.35 + i / 3) % 1;
    const x = a.x + (b.x - a.x) * k;
    const y = a.y + (b.y - a.y) * k;
    ctx.globalAlpha = Math.sin(k * Math.PI);
    ctx.beginPath();
    ctx.arc(x, y, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function drawArrow(ctx: CanvasRenderingContext2D, pts: Vec[], color: string, halfHead: boolean, alpha = 1, pal?: ArPalette) {
  if (pts.length < 2) return;
  const k = pal?.lineScale ?? 1;
  const end = pts[pts.length - 1];
  const before = pts[Math.max(0, pts.length - 4)];
  const ang = Math.atan2(end.y - before.y, end.x - before.x);
  const s = 13 * Math.sqrt(k);
  const head = () => {
    ctx.beginPath();
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(end.x - s * Math.cos(ang - 0.45), end.y - s * Math.sin(ang - 0.45));
    if (halfHead) ctx.lineTo(end.x - s * 0.8 * Math.cos(ang), end.y - s * 0.8 * Math.sin(ang));
    else ctx.lineTo(end.x - s * Math.cos(ang + 0.45), end.y - s * Math.sin(ang + 0.45));
    ctx.closePath();
  };
  const body = () => {
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  };
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (pal?.halo) {
    ctx.strokeStyle = pal.halo;
    ctx.lineWidth = 2.6 * k + 4;
    body();
    ctx.stroke();
    head();
    ctx.stroke();
  }
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 12 * (pal?.glow ?? 1);
  ctx.lineWidth = 2.6 * k;
  body();
  ctx.stroke();
  head();
  ctx.fill();
  ctx.restore();
}

function drawSpinGlyph(ctx: CanvasRenderingContext2D, outline: Vec[], t: number, label: string, pal: ArPalette) {
  const c = centroid(outline);
  const b = bounds(outline);
  const r = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.62;
  ctx.save();
  ctx.translate(c.x, c.y);
  const start = t * 1.6;
  for (let k = 0; k < 2; k++) {
    const a0 = start + k * Math.PI;
    const arc: Vec[] = [];
    for (let i = 0; i <= 20; i++) {
      const a = a0 + (i / 20) * Math.PI * 0.7;
      arc.push({ x: Math.cos(a) * r, y: Math.sin(a) * r * 0.42 });
    }
    drawArrow(ctx, arc, pal.accent, false, 1, pal);
  }
  ctx.restore();
  drawTag(ctx, label, c.x, b.y0 - 22, pal.accent, pal);
}

/** A label on a tag that stays readable over any paper color. */
function drawTag(ctx: CanvasRenderingContext2D, label: string, x: number, y: number, color: string, pal: ArPalette) {
  ctx.save();
  ctx.font = `700 ${Math.round(15 * Math.sqrt(pal.lineScale))}px ${pal.font}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const w = ctx.measureText(label).width + 26;
  const h = 28 * Math.sqrt(pal.lineScale);
  const x0 = Math.max(4, x - w / 2);
  const y0 = Math.max(4, y - h / 2);
  ctx.fillStyle = pal.tagBg;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2 * pal.lineScale;
  ctx.beginPath();
  if (pal.glow > 0) {
    ctx.moveTo(x0 + 8, y0);
    ctx.lineTo(x0 + w, y0);
    ctx.lineTo(x0 + w, y0 + h - 8);
    ctx.lineTo(x0 + w - 8, y0 + h);
    ctx.lineTo(x0, y0 + h);
    ctx.lineTo(x0, y0 + 8);
    ctx.closePath();
  } else {
    ctx.roundRect(x0, y0, w, h, h / 2);
  }
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = pal.tagText ?? color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 10 * pal.glow;
  ctx.fillText(label, x0 + w / 2, y0 + h / 2 + 1);
  ctx.restore();
}

function drawSearching(ctx: CanvasRenderingContext2D, cw: number, ch: number, t: number, lock: number, pal: ArPalette, labels: ArLabels) {
  const r = Math.min(cw, ch) * 0.18;
  const k = pal.lineScale;
  ctx.save();
  ctx.globalAlpha = 1 - lock;
  ctx.translate(cw / 2, ch / 2);
  if (pal.halo) {
    ctx.strokeStyle = pal.halo;
    ctx.lineWidth = 1.5 * k + 4;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = pal.outline;
  ctx.shadowColor = pal.outline;
  ctx.shadowBlur = 10 * pal.glow;
  ctx.lineWidth = 1.5 * k;
  ctx.setLineDash([10, 14]);
  ctx.lineDashOffset = t * 30;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  if (pal.glow > 0) {
    ctx.setLineDash([2, 10]);
    ctx.lineDashOffset = -t * 20;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.25, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.rotate(t * 0.8);
  ctx.lineWidth = 3 * k;
  for (let i = 0; i < 4; i++) {
    ctx.rotate(Math.PI / 2);
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.82, -0.25, 0.25);
    ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = (1 - lock) * (0.65 + 0.35 * Math.sin(t * 3));
  ctx.textAlign = "center";
  const y = ch / 2 + r * 1.25 + 28;
  ctx.font = `600 ${Math.round(13 * Math.sqrt(k))}px ${pal.font}`;
  if (pal.glow === 0) {
    // Flat themes: a readable tag instead of glowing text.
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = 1 - lock;
    drawTag(ctx, labels.placePaper, cw / 2, y, pal.outline, pal);
  } else {
    ctx.fillStyle = pal.outline;
    ctx.shadowColor = pal.outline;
    ctx.shadowBlur = 8;
    ctx.fillText(labels.placePaper, cw / 2, y);
  }
  ctx.font = `500 ${Math.round(12 * Math.sqrt(k))}px ${pal.font}`;
  ctx.fillStyle = pal.hintColor;
  ctx.shadowColor = "rgba(0,0,0,0.8)";
  ctx.shadowBlur = pal.glow === 0 ? 4 : 0;
  ctx.fillText(labels.placeHint, cw / 2, y + 26);
  ctx.restore();
}

function drawFrameChrome(ctx: CanvasRenderingContext2D, cw: number, ch: number, t: number, color: string) {
  const m = 14;
  const L = 34;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  const corners: [number, number, number, number][] = [
    [m, m, 1, 1],
    [cw - m, m, -1, 1],
    [m, ch - m, 1, -1],
    [cw - m, ch - m, -1, -1],
  ];
  for (const [x, y, sx, sy] of corners) {
    ctx.beginPath();
    ctx.moveTo(x, y + sy * L);
    ctx.lineTo(x, y);
    ctx.lineTo(x + sx * L, y);
    ctx.stroke();
  }
  // Ticking ruler along the bottom edge.
  ctx.globalAlpha = 0.36;
  ctx.lineWidth = 1;
  const off = (t * 20) % 24;
  ctx.beginPath();
  for (let x = m + L + 10 - off; x < cw - m - L - 10; x += 24) {
    ctx.moveTo(x, ch - m);
    ctx.lineTo(x, ch - m - 6);
  }
  ctx.stroke();
  ctx.restore();
}
