import { useEffect, useMemo, useRef, useState } from "react";
import type { GuidePlan } from "../../shared/schema";
import { modelFor } from "../lib/holoModels";
import { HoloProjector } from "../lib/holoProjector";
import type { TextKey } from "../i18n/en";
import { diffText, usePrefs } from "../lib/prefs";

interface Props {
  plan: GuidePlan;
  onConfirm: () => void;
  onCancel: () => void;
}

const DIFF_LEVEL = { easy: 2, medium: 3, hard: 5 } as const;
const DIFF_PACE = { easy: 0.8, medium: 1.1, hard: 1.6 } as const;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) % 10000;
}

/**
 * Full-screen hologram preview of the finished model, shown before the AR guide starts.
 * The model materializes above a projector pad and spins; drag to turn it by hand.
 */
export function HoloPreview({ plan, onConfirm, onCancel }: Props) {
  const { t, prefs, reduced } = usePrefs();
  const style = prefs.theme;
  const model = useMemo(() => modelFor(plan), [plan]);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [leaving, setLeaving] = useState<null | "confirm" | "cancel">(null);

  const level = DIFF_LEVEL[plan.difficulty];
  const minutes = Math.max(3, Math.round(plan.steps.length * DIFF_PACE[plan.difficulty]));

  const leave = (kind: "confirm" | "cancel") => {
    if (leaving) return;
    setLeaving(kind);
    window.setTimeout(kind === "confirm" ? onConfirm : onCancel, kind === "confirm" ? 520 : 220);
  };

  // Keyboard, focus and scroll lock.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    confirmRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") leave("cancel");
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Render loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const projector = new HoloProjector(model);
    const seed = hash(plan.id);
    const auto = reduced ? 0.18 : 0.62;

    let w = 0;
    let h = 0;
    const resize = () => {
      const r = stage.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = r.width;
      h = r.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(stage);

    let yaw = model.kind === "plane" ? 0.9 : 0.5;
    let vel = auto;
    let dragging = false;
    let lastX = 0;
    let lastMoveT = 0;
    const down = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastMoveT = performance.now();
      canvas.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const now = performance.now();
      const dx = e.clientX - lastX;
      yaw += dx * 0.012;
      vel = (dx * 0.012) / Math.max(0.008, (now - lastMoveT) / 1000);
      lastX = e.clientX;
      lastMoveT = now;
    };
    const up = () => {
      dragging = false;
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);

    const t0 = performance.now();
    let last = t0;
    let raf = 0;
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = (now - t0) / 1000;
      if (!dragging) {
        vel += (auto - vel) * Math.min(1, dt * 1.6);
        yaw += vel * dt;
      }
      const rv = reduced ? 1 : Math.min(1, Math.max(0, (t - 0.3) / 1.1));
      const reveal = 1 - Math.pow(1 - rv, 3);
      if (w > 0 && h > 0) projector.draw(ctx, w, h, { t, yaw, reveal, reduced, seed, style });
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
    };
  }, [model, plan.id, reduced, style]);

  return (
    <div className={`hp${leaving ? ` hp--${leaving}` : ""}`} role="dialog" aria-modal="true" aria-labelledby="hp-title">
      <div className="hp__backdrop" onClick={() => leave("cancel")} />
      <div className="hp__frame">
        <header className="hp__top">
          <p className="hp__tag">
            <i /> {t("hp.tag")} <span>· {t(`model.${model.kind}` as TextKey)}</span>
          </p>
          <button className="icon-btn" onClick={() => leave("cancel")} aria-label={t("hp.close")}>
            ✕
          </button>
        </header>

        <div className="hp__stage" ref={stageRef}>
          <canvas ref={canvasRef} aria-label={t("hp.alt", { title: plan.title })} role="img" />
          <p className="hp__drag">{t("hp.drag")}</p>
        </div>

        <aside className="hp__info hp__info--left">
          <p className="hp__k">{t("hp.model")}</p>
          <h2 id="hp-title">{plan.title}</h2>
          <p className="hp__summary">{plan.summary}</p>
          <dl className="hp__stats">
            <div>
              <dt>{t("hp.difficulty")}</dt>
              <dd>
                <span className="hp__boxes" aria-label={t("hp.diffAria", { d: diffText(t, plan.difficulty), n: level })}>
                  {Array.from({ length: 5 }, (_, i) => (
                    <i key={i} className={i < level ? "on" : ""} />
                  ))}
                </span>
                {diffText(t, plan.difficulty)}
              </dd>
            </div>
            <div>
              <dt>{t("hp.steps")}</dt>
              <dd>{plan.steps.length}</dd>
            </div>
            <div>
              <dt>{t("hp.sheets")}</dt>
              <dd>{plan.sheets}</dd>
            </div>
            <div>
              <dt>{t("hp.time")}</dt>
              <dd>{t("hp.minutes", { n: minutes })}</dd>
            </div>
          </dl>
          <p className="hp__k">{t("hp.paper")}</p>
          <p className="hp__paper">{plan.paper}</p>
        </aside>

        <aside className="hp__info hp__info--right">
          <p className="hp__k">{t("hp.sequence")}</p>
          <ol className="hp__seq">
            {plan.steps.map((s, i) => (
              <li key={i} style={{ animationDelay: `${0.5 + i * 0.05}s` }}>
                <span>{String(i + 1).padStart(2, "0")}</span>
                {s.title}
              </li>
            ))}
          </ol>
        </aside>

        <footer className="hp__actions">
          <button className="btn ghost" onClick={() => leave("cancel")}>
            {t("hp.back")}
          </button>
          <button ref={confirmRef} className="btn primary hp__go" onClick={() => leave("confirm")}>
            <span className="btn__icon">◉</span> {t("hp.confirm")}
          </button>
        </footer>
      </div>
    </div>
  );
}
