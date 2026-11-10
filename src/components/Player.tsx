import { useEffect, useRef, useState, type CSSProperties } from "react";
import { levelInfo, type BadgeDef } from "../../shared/progress";
import { googleAllowedHere, loadGoogle, signInWithGoogle, type User } from "../lib/account";
import { badgeName, levelText, usePrefs } from "../lib/prefs";

const colorVar = (c: BadgeDef["color"]) => ({ ["--bc" as string]: `var(--${c})` }) as CSSProperties;

/** A holographic hexagon badge. Locked badges show their glyph dimmed so players see what's ahead. */
export function BadgeIcon({ badge, earned, size = 72, fresh = false }: { badge: BadgeDef; earned: boolean; size?: number; fresh?: boolean }) {
  const { t } = usePrefs();
  return (
    <div
      className={`hbadge ${earned ? "earned" : "locked"} ${fresh ? "fresh" : ""}`}
      style={{ ...colorVar(badge.color), width: size, height: size, fontSize: size * 0.36 }}
      role="img"
      aria-label={`${badgeName(t, badge)}${earned ? "" : t("badge.lockedSuffix")}`}
    >
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <polygon className="hbadge__outer" points="50,3 91,26.5 91,73.5 50,97 9,73.5 9,26.5" />
        <polygon className="hbadge__inner" points="50,14 81.5,32 81.5,68 50,86 18.5,68 18.5,32" />
      </svg>
      <span className="hbadge__glyph">{badge.glyph}</span>
    </div>
  );
}

export function Avatar({ user, size = 40 }: { user: User | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  const initial = (user?.name ?? "?").trim().charAt(0).toUpperCase();
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {user?.picture && !broken ? (
        <img src={user.picture} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
      ) : (
        <b>{user ? initial : "◇"}</b>
      )}
    </span>
  );
}

/** XP bar for the current level. `from` animates the fill up from an earlier XP total. */
export function LevelBar({ xp, from, compact = false, showTitle = true }: { xp: number; from?: number; compact?: boolean; showTitle?: boolean }) {
  const { t } = usePrefs();
  const info = levelInfo(xp);
  const [shown, setShown] = useState(from ?? xp);
  useEffect(() => {
    if (from === undefined) return setShown(xp);
    setShown(from);
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / 1400);
      setShown(Math.round(from + (xp - from) * (1 - (1 - k) ** 3)));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    const id = setTimeout(() => (raf = requestAnimationFrame(tick)), 350);
    return () => {
      clearTimeout(id);
      cancelAnimationFrame(raf);
    };
  }, [xp, from]);
  const s = levelInfo(shown);
  return (
    <div className={`levelbar ${compact ? "compact" : ""}`}>
      {!compact && (
        <div className="levelbar__head">
          <span>
            {showTitle && (
              <>
                <b>{t("player.lv", { n: s.level })}</b> · {levelText(t, s.level, s.title)}
              </>
            )}
          </span>
          <span className="levelbar__num">
            {s.xpInto}/{s.xpNeeded} XP
          </span>
        </div>
      )}
      <div className="levelbar__track" role="progressbar" aria-valuemin={0} aria-valuemax={info.xpNeeded} aria-valuenow={s.xpInto} aria-label={t("player.levelProgress")}>
        <i style={{ width: `${Math.max(2, s.fraction * 100)}%` }} />
      </div>
    </div>
  );
}

/** Top-bar button showing the player's avatar and level; opens the profile. */
export function PlayerChip({ user, onClick }: { user: User | null; onClick: () => void }) {
  const { t } = usePrefs();
  const xp = user?.progress.xp ?? 0;
  const { level } = levelInfo(xp);
  const streak = user?.progress.streak.current ?? 0;
  return (
    <button className="player-chip" onClick={onClick} aria-label={t("player.open")}>
      <Avatar user={user} size={30} />
      <span className="player-chip__info">
        <span className="player-chip__lv">
          {t("player.lv", { n: level })}
          {streak > 1 && <span className="player-chip__streak"> · {t("player.streak", { n: streak })}</span>}
        </span>
        <LevelBar xp={xp} compact />
      </span>
    </button>
  );
}

/** The official Sign in with Google button, or a note explaining why it can't show here. */
export function GoogleButton({ clientId, onUser }: { clientId: string | null; onUser: (u: User) => void }) {
  const { t, prefs } = usePrefs();
  const ref = useRef<HTMLDivElement>(null);
  const onUserRef = useRef(onUser);
  onUserRef.current = onUser;
  const [error, setError] = useState("");
  const allowed = googleAllowedHere();

  useEffect(() => {
    if (!clientId || !allowed) return;
    let cancelled = false;
    loadGoogle()
      .then((g) => {
        if (cancelled || !ref.current) return;
        g.initialize({
          client_id: clientId,
          ux_mode: "popup",
          callback: async ({ credential }) => {
            setError("");
            try {
              onUserRef.current(await signInWithGoogle(credential));
            } catch (e) {
              setError((e as Error).message);
            }
          },
        });
        g.renderButton(ref.current, {
          theme: prefs.theme === "holo" ? "filled_black" : "outline",
          size: "large",
          shape: "pill",
          text: "signin_with",
          logo_alignment: "left",
          locale: prefs.lang,
        });
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [clientId, allowed, prefs.theme, prefs.lang]);

  if (!clientId) return <p className="hint">{t("google.notSetup")}</p>;
  if (!allowed) return <p className="hint">{t("google.ipBlocked", { host: location.hostname })}</p>;
  return (
    <div className="gsi">
      <div ref={ref} className="gsi__btn" />
      {error && <p className="error">{error}</p>}
    </div>
  );
}
