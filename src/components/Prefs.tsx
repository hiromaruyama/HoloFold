import { useEffect, useRef, useState } from "react";
import type { TextKey } from "../i18n/en";
import { LANGUAGES, THEMES, usePrefs, type Audience, type Prefs } from "../lib/prefs";
import { CRANE_FACETS } from "./HoloCrane";

function LanguageSwitch() {
  const { prefs, setPrefs } = usePrefs();
  return (
    <div className="seg" role="group" aria-label="Language / 言語">
      {LANGUAGES.map((l) => (
        <button key={l.id} aria-pressed={prefs.lang === l.id} onClick={() => setPrefs({ lang: l.id })} lang={l.id}>
          {l.label}
        </button>
      ))}
    </div>
  );
}

const SWATCH: Record<Prefs["theme"], string> = { holo: "◇", paper: "✿", washi: "折" };
const TOGGLES: { key: "large" | "calm" | "contrast" | "simple" | "read"; label: TextKey; sub: TextKey }[] = [
  { key: "large", label: "prefs.large", sub: "prefs.largeSub" },
  { key: "calm", label: "prefs.calm", sub: "prefs.calmSub" },
  { key: "contrast", label: "prefs.contrast", sub: "prefs.contrastSub" },
  { key: "simple", label: "prefs.simple", sub: "prefs.simpleSub" },
  { key: "read", label: "prefs.read", sub: "prefs.readSub" },
];

/** Side sheet with language, theme and Easy view settings. */
export function PrefsPanel({ onClose }: { onClose: () => void }) {
  const { prefs, setPrefs, t } = usePrefs();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="prefs-title">
      <div className="sheet__backdrop" onClick={onClose} />
      <div className="sheet__panel panel">
        <header className="sheet__head">
          <h2 id="prefs-title">{t("prefs.title")}</h2>
          <button ref={closeRef} className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </header>

        <p className="eyebrow">{t("prefs.language")}</p>
        <LanguageSwitch />

        <p className="eyebrow">{t("prefs.theme")}</p>
        <div className="theme-pick">
          {THEMES.map((th) => (
            <button key={th} className="theme-opt" aria-pressed={prefs.theme === th} onClick={() => setPrefs({ theme: th })}>
              <span className={`swatch swatch--${th}`} aria-hidden="true">
                {SWATCH[th]}
              </span>
              <span>
                <b>{t(`theme.${th}` as TextKey)}</b>
                <small>{t(`theme.${th}Sub` as TextKey)}</small>
              </span>
            </button>
          ))}
        </div>

        <p className="eyebrow">{t("prefs.easy")}</p>
        <div className="toggles">
          {TOGGLES.map((o) => (
            <label key={o.key} className="toggle">
              <span>
                <b>{t(o.label)}</b>
                <small>{t(o.sub)}</small>
              </span>
              <input type="checkbox" role="switch" checked={prefs[o.key]} onChange={(e) => setPrefs({ [o.key]: e.target.checked })} />
            </label>
          ))}
        </div>

        <div className="sheet__actions">
          <button
            className="btn ghost wide"
            onClick={() => {
              setPrefs({ who: null });
              onClose();
            }}
          >
            {t("prefs.who")}
          </button>
          <button className="btn primary wide" onClick={onClose}>
            {t("prefs.done")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Gear icon (an SVG, so it looks the same on every device). */
export function GearIcon() {
  return (
    <svg className="gear-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.3 2.6h3.4l.5 2.6 1.9.8 2.2-1.5 2.4 2.4-1.5 2.2.8 1.9 2.6.5v3.4l-2.6.5-.8 1.9 1.5 2.2-2.4 2.4-2.2-1.5-1.9.8-.5 2.6h-3.4l-.5-2.6-1.9-.8-2.2 1.5-2.4-2.4 1.5-2.2-.8-1.9-2.6-.5v-3.4l2.6-.5.8-1.9-1.5-2.2 2.4-2.4 2.2 1.5 1.9-.8z" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  );
}

/** Settings button for top bars: gear plus a "Settings" label (icon only on phones). */
export function PrefsButton({ className = "" }: { className?: string }) {
  const { t } = usePrefs();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={`icon-btn prefs-btn ${className}`} onClick={() => setOpen(true)} aria-label={t("prefs.open")} title={t("prefs.open")}>
        <GearIcon />
        <span className="prefs-btn__label">{t("prefs.button")}</span>
      </button>
      {open && <PrefsPanel onClose={() => setOpen(false)} />}
    </>
  );
}

const WHO_STYLE: Record<Audience, { fill: string; opacity: number; stroke: string; line: string }> = {
  kid: { fill: "#e8613c", opacity: 0.9, stroke: "#4a2c1a", line: "#3a8fd9" },
  adult: { fill: "#38f9ff", opacity: 0.25, stroke: "#38f9ff", line: "#ff4fd8" },
  senior: { fill: "#fbf8f1", opacity: 1, stroke: "#1f2a44", line: "#c0392b" },
};

function MiniCrane({ who }: { who: Audience }) {
  const s = WHO_STYLE[who];
  return (
    <svg viewBox="20 15 200 135" aria-hidden="true">
      {CRANE_FACETS.map((f, i) => (
        <polygon key={i} points={f.pts} fill={s.fill} fillOpacity={who === "adult" ? f.tone : s.opacity} stroke={s.stroke} strokeWidth={2} strokeLinejoin="round" />
      ))}
      <line x1="120" y1="120" x2="178" y2="22" stroke={s.line} strokeWidth="2" strokeDasharray="6 4" />
    </svg>
  );
}

/** First-launch question that picks a theme and Easy view settings in one tap. */
export function WhoPicker() {
  const { choose, t } = usePrefs();
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  const who: Audience[] = ["kid", "adult", "senior"];
  return (
    <div className="onboard" role="dialog" aria-modal="true" aria-labelledby="onboard-title">
      <div className="onboard__box">
        <div className="onboard__lang">
          <LanguageSwitch />
        </div>
        <h1 id="onboard-title">{t("onboard.title")}</h1>
        <p className="lede">{t("onboard.sub")}</p>
        <div className="who">
          {who.map((w, i) => (
            <button key={w} ref={i === 0 ? first : undefined} className={`who__card who__card--${w}`} onClick={() => choose(w)}>
              <MiniCrane who={w} />
              <span>
                <b>{t(`who.${w}` as TextKey)}</b>
                <small>{t(`who.${w}Sub` as TextKey)}</small>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
