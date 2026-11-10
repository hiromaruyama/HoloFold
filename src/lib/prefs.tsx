/**
 * Display preferences (theme, language, Easy view) and UI text lookup.
 *
 * Preferences are saved in this browser, per player: each profile on a shared device keeps
 * its own look, so a child and a grandparent can each have theirs.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { BadgeDef } from "../../shared/progress";
import type { GuidePlan, Language, Step } from "../../shared/schema";
import { en, type TextKey } from "../i18n/en";
import { ja } from "../i18n/ja";
import { enSimple, jaSimple } from "../i18n/simple";
import { LIBRARY_JA } from "../library/ja";

export type Theme = "holo" | "paper" | "washi";
export type Audience = "kid" | "adult" | "senior";

export interface Prefs {
  theme: Theme;
  lang: Language;
  /** Easy view. */
  large: boolean;
  calm: boolean;
  contrast: boolean;
  simple: boolean;
  /** Turn on reading steps aloud when the guide opens. */
  read: boolean;
  /** Who the app was set up for; null until the first-launch question is answered. */
  who: Audience | null;
}

export const THEMES: Theme[] = ["holo", "paper", "washi"];
export const LANGUAGES: { id: Language; label: string }[] = [
  { id: "en", label: "English" },
  { id: "ja", label: "日本語" },
];

/** What each answer to "Who's folding?" sets up. */
export const PRESETS: Record<Audience, Omit<Prefs, "lang" | "who">> = {
  kid: { theme: "paper", large: true, calm: false, contrast: false, simple: true, read: true },
  adult: { theme: "holo", large: false, calm: false, contrast: false, simple: false, read: false },
  senior: { theme: "washi", large: true, calm: true, contrast: true, simple: false, read: true },
};

const DICTS: Record<Language, Record<TextKey, string>> = { en, ja };
const SIMPLE: Record<Language, Partial<Record<TextKey, string>>> = { en: enSimple, ja: jaSimple };

const KEY = "holofold.prefs.v1";

function detectLanguage(): Language {
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  return langs.some((l) => l?.toLowerCase().startsWith("ja")) ? "ja" : "en";
}

function defaults(): Prefs {
  return { ...PRESETS.adult, lang: detectLanguage(), who: null };
}

function sanitize(raw: unknown): Prefs | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Prefs>;
  const d = defaults();
  return {
    theme: THEMES.includes(r.theme as Theme) ? (r.theme as Theme) : d.theme,
    lang: r.lang === "ja" || r.lang === "en" ? r.lang : d.lang,
    large: Boolean(r.large),
    calm: Boolean(r.calm),
    contrast: Boolean(r.contrast),
    simple: Boolean(r.simple),
    read: Boolean(r.read),
    who: r.who === "kid" || r.who === "adult" || r.who === "senior" ? r.who : null,
  };
}

function load(userId: string | null): Prefs | null {
  try {
    const own = userId ? localStorage.getItem(`${KEY}.${userId}`) : null;
    const raw = own ?? localStorage.getItem(KEY);
    return raw ? sanitize(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function save(p: Prefs, userId: string | null) {
  try {
    const raw = JSON.stringify(p);
    localStorage.setItem(KEY, raw);
    if (userId) localStorage.setItem(`${KEY}.${userId}`, raw);
  } catch {
    /* storage full or blocked: preferences just won't persist */
  }
}

export type Translate = (key: TextKey, vars?: Record<string, string | number>) => string;

interface PrefsContextValue {
  prefs: Prefs;
  setPrefs: (patch: Partial<Prefs>) => void;
  /** Apply a "Who's folding?" answer. */
  choose: (who: Audience) => void;
  /** True on first launch, before anyone answered "Who's folding?". */
  needsSetup: boolean;
  t: Translate;
  /** Calm motion, or the OS "reduce motion" setting. */
  reduced: boolean;
}

const PrefsContext = createContext<PrefsContextValue | null>(null);

export function PrefsProvider({ userId, children }: { userId: string | null; children: ReactNode }) {
  const [stored, setStored] = useState<Prefs | null>(() => load(null));
  const prefs = stored ?? defaults();

  // A signed-in player with saved preferences on this device gets theirs back.
  useEffect(() => {
    if (!userId) return;
    try {
      const own = localStorage.getItem(`${KEY}.${userId}`);
      if (own) setStored(sanitize(JSON.parse(own)));
      else if (stored) save(stored, userId);
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const setPrefs = useCallback(
    (patch: Partial<Prefs>) => {
      setStored((prev) => {
        const next = { ...(prev ?? defaults()), ...patch };
        save(next, userId);
        return next;
      });
    },
    [userId],
  );

  const choose = useCallback((who: Audience) => setPrefs({ ...PRESETS[who], who }), [setPrefs]);

  const [osReduced, setOsReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setOsReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // Reflect preferences on <html> so the stylesheet can switch themes and Easy view.
  useEffect(() => {
    const html = document.documentElement;
    html.dataset.theme = prefs.theme;
    html.lang = prefs.lang;
    html.toggleAttribute("data-large", prefs.large);
    html.toggleAttribute("data-calm", prefs.calm);
    html.toggleAttribute("data-contrast", prefs.contrast);
    const meta = document.querySelector('meta[name="theme-color"]');
    meta?.setAttribute("content", prefs.theme === "holo" ? "#03060d" : prefs.theme === "paper" ? "#fff6e8" : "#f4efe4");
  }, [prefs.theme, prefs.lang, prefs.large, prefs.calm, prefs.contrast]);

  const t = useMemo<Translate>(() => {
    const dict = DICTS[prefs.lang];
    const simple = prefs.simple ? SIMPLE[prefs.lang] : {};
    return (key, vars) => {
      let s = simple[key] ?? dict[key] ?? en[key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
      return s;
    };
  }, [prefs.lang, prefs.simple]);

  const value = useMemo<PrefsContextValue>(
    () => ({ prefs, setPrefs, choose, needsSetup: stored === null || stored.who === null, t, reduced: prefs.calm || osReduced }),
    [prefs, setPrefs, choose, stored, t, osReduced],
  );
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): PrefsContextValue {
  const v = useContext(PrefsContext);
  if (!v) throw new Error("usePrefs must be used inside <PrefsProvider>");
  return v;
}

// ---------- Localized content helpers ----------

/** Built-in models in the chosen language. Scanned plans are already written in the language they were scanned in. */
export function localizePlan(plan: GuidePlan, lang: Language): GuidePlan {
  const text = lang === "ja" ? LIBRARY_JA[plan.id] : undefined;
  if (!text) return plan;
  return {
    ...plan,
    title: text.title,
    summary: text.summary,
    paper: text.paper,
    steps: plan.steps.map((s, i): Step => {
      const st = text.steps[i];
      return st ? { ...s, title: st[0], instruction: st[1], tip: st[2] ?? s.tip } : s;
    }),
  };
}

export const actionText = (t: Translate, action: Step["action"]) => t(`action.${action}` as TextKey);
export const diffText = (t: Translate, d: GuidePlan["difficulty"]) => t(`diff.${d}` as TextKey);
export const levelText = (t: Translate, level: number, fallback: string) => {
  const key = `level.${Math.min(level, 10)}` as TextKey;
  return key in en ? t(key) : fallback;
};
export const badgeName = (t: Translate, b: BadgeDef) => (`badge.${b.id}` in en ? t(`badge.${b.id}` as TextKey) : b.name);
export const badgeHow = (t: Translate, b: BadgeDef) => (`badge.${b.id}.how` in en ? t(`badge.${b.id}.how` as TextKey) : b.how);
