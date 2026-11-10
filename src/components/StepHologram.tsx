import { useEffect, useId, useMemo, useState } from "react";
import type { Step } from "../../shared/schema";
import { animationAt, flapPolygon, foldArrow, foldFrame, foldPoint, realShape } from "../lib/fold";
import { centroid, type Vec } from "../lib/geometry";
import { usePrefs } from "../lib/prefs";

const DASH: Record<string, string> = {
  V: "7 4.5",
  M: "7 2.5 1.4 2.5 1.4 2.5",
  F: "1.2 3",
  U: "4 4",
};
const COLOR: Record<string, string> = {
  V: "var(--valley)",
  M: "var(--mountain)",
  F: "var(--sh-crease)",
  U: "var(--amber)",
};

function useClock(playing: boolean) {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      setT((now - t0) / 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  return t;
}

/** Animated SVG hologram of one step: outline, crease notation, folding flap and arrow. */
export function StepHologram({ step, playing = true, className }: { step: Step; playing?: boolean; className?: string }) {
  const uid = useId().replace(/:/g, "");
  const { prefs, reduced } = usePrefs();
  const glow = prefs.theme === "holo" ? `url(#glow-${uid})` : undefined;
  playing = playing && !reduced;
  const t = useClock(playing);
  const shape = useMemo(() => realShape(step), [step]);

  const size = 100;
  const pad = 18;
  const s = (size - 2 * pad) / Math.max(step.aspect, 1);
  const ox = (size - step.aspect * s) / 2;
  const oy = (size - s) / 2;
  const map = (p: Vec): Vec => ({ x: ox + p.x * s, y: oy + p.y * s });
  const pts = (arr: Vec[]) =>
    arr
      .map(map)
      .map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`)
      .join(" ");

  const anim = animationAt(step, playing ? t : 1.2);
  const c = map(centroid(shape));
  const transform =
    step.action === "turn-over"
      ? `translate(${c.x} ${c.y}) scale(${anim.flip.toFixed(3)} 1) translate(${-c.x} ${-c.y})`
      : step.action === "rotate"
        ? `rotate(${((anim.rotate * 180) / Math.PI).toFixed(2)} ${c.x} ${c.y})`
        : undefined;
  const backSide = step.action === "turn-over" && anim.flip < 0;

  let flapEl = null;
  if (anim.lineIndex >= 0) {
    const ln = step.lines[anim.lineIndex];
    const fr = foldFrame(ln, step.aspect);
    if (fr) {
      const flap = flapPolygon(shape, fr, step);
      if (flap.length >= 3) {
        const moving = flap.map((p) => foldPoint(p, fr, anim.theta));
        const landing = flap.map((p) => foldPoint(p, fr, Math.PI));
        const arrow = foldArrow(flap, fr).map(map);
        const back = anim.theta > Math.PI / 2;
        flapEl = (
          <g>
            <polygon points={pts(landing)} fill="none" style={{ stroke: "var(--sh-landing)" }} strokeWidth={0.5} strokeDasharray="1.5 2" />
            <polygon
              points={pts(moving)}
              style={{ fill: back ? "var(--sh-flap-back)" : "var(--sh-flap)", stroke: back ? "var(--sh-back-stroke)" : "var(--sh-outline)" }}
              strokeWidth={0.8}
              strokeDasharray={ln.assignment === "M" ? "2 1.6" : undefined}
              opacity={anim.alpha}
              filter={glow}
            />
            {arrow.length > 1 && (
              <path
                d={`M${arrow.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" L")}`}
                fill="none"
                style={{ stroke: COLOR[ln.assignment] }}
                strokeWidth={0.9}
                markerEnd={`url(#${ln.assignment === "M" ? "half" : "head"}-${uid})`}
                opacity={0.9}
              />
            )}
          </g>
        );
      }
    }
  }

  return (
    <svg className={`step-holo ${className ?? ""}`} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={step.title}>
      <defs>
        <filter id={`glow-${uid}`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.2" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <linearGradient id={`fill-${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: backSide ? "var(--sh-flap-back)" : "var(--sh-fill-a)" }} />
          <stop offset="1" style={{ stopColor: backSide ? "var(--sh-flap-back)" : "var(--sh-fill-b)" }} />
        </linearGradient>
        <marker id={`head-${uid}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" style={{ fill: "var(--valley)" }} />
        </marker>
        <marker id={`half-${uid}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 5 z" style={{ fill: "var(--mountain)" }} />
        </marker>
        <pattern id={`grid-${uid}`} width="5" height="5" patternUnits="userSpaceOnUse">
          <path d="M5 0H0V5" fill="none" style={{ stroke: "var(--sh-grid)" }} strokeWidth="0.3" />
        </pattern>
      </defs>
      <rect width={size} height={size} fill={`url(#grid-${uid})`} />
      <ellipse cx="50" cy="94" rx="30" ry="3.2" fill="none" style={{ stroke: "var(--sh-base)" }} strokeWidth="0.5" />
      <g transform={transform} opacity={step.action === "turn-over" || step.action === "rotate" ? anim.alpha * 0.6 + 0.4 : 1}>
        <polygon points={pts(shape)} fill={`url(#fill-${uid})`} style={{ stroke: "var(--sh-outline)" }} strokeWidth={0.9} filter={glow} />
        {step.lines.map((ln, i) => {
          const a = map({ x: ln.from.x * step.aspect, y: ln.from.y });
          const b = map({ x: ln.to.x * step.aspect, y: ln.to.y });
          return (
            <line
              key={i}
              className="holo-crease"
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              style={{ stroke: COLOR[ln.assignment] }}
              strokeWidth={ln.assignment === "F" ? 0.5 : 0.9}
              strokeDasharray={DASH[ln.assignment]}
              strokeLinecap="round"
            />
          );
        })}
        {flapEl}
      </g>
    </svg>
  );
}
