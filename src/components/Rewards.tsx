import { useEffect, useState } from "react";
import { BADGE_BY_ID, emptyProgress, levelInfo, nextGoals, type BadgeAction, type Reward } from "../../shared/progress";
import { localDay, type User } from "../lib/account";
import type { TextKey } from "../i18n/en";
import { badgeName, levelText, usePrefs } from "../lib/prefs";
import { BadgeIcon, LevelBar } from "./Player";
import { actionLabel, GoalCard } from "./Profile";

export type RewardState = { status: "saving" } | { status: "done"; reward: Reward; user: User | null } | { status: "error"; error: string };

interface Props {
  title: string;
  steps: number;
  planId: string;
  state: RewardState;
  googleReady: boolean;
  onAgain: () => void;
  onAction: (action: BadgeAction) => void;
  onProfile: () => void;
  onHome: () => void;
}

function CountUp({ to, delay = 200 }: { to: number; delay?: number }) {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf = 0;
    const id = setTimeout(() => {
      const t0 = performance.now();
      const tick = (now: number) => {
        const k = Math.min(1, (now - t0) / 1100);
        setV(Math.round(to * (1 - (1 - k) ** 3)));
        if (k < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }, delay);
    return () => {
      clearTimeout(id);
      cancelAnimationFrame(raf);
    };
  }, [to, delay]);
  return <>{v}</>;
}

export function Rewards({ title, steps, planId, state, googleReady, onAgain, onAction, onProfile, onHome }: Props) {
  const { t, prefs } = usePrefs();
  /** Server lines carry a translation key; fall back to the English label. */
  const line = (key: string | undefined, vars: Record<string, string | number> | undefined, fallback: string) => {
    if (!key) return fallback;
    const v = { ...vars };
    if (typeof v.difficulty === "string") v.difficulty = t(`diff.${v.difficulty}` as TextKey);
    return t(key as TextKey, v);
  };
  const nextLabel = (a: BadgeAction) => actionLabel(t, prefs.lang, a);
  const done = state.status === "done" ? state : null;
  const reward = done?.reward;
  const progress = done?.user?.progress ?? emptyProgress();
  const before = reward ? levelInfo(reward.xpBefore) : null;
  const after = reward ? levelInfo(reward.xpAfter) : null;
  const leveledUp = Boolean(before && after && after.level > before.level);
  // The next badge to chase, skipping "fold this same model again".
  const next = done && nextGoals(progress, 20, localDay()).find((g) => g.action && !(g.action.kind === "fold" && g.action.planId === planId));

  return (
    <div className="complete">
      <div className="complete__burst" />
      <div className="panel complete__box rewards">
        <p className="eyebrow">{t("rewards.complete")}</p>
        <h1>{title}</h1>
        <p className="lede">{t("rewards.allSteps", { n: steps })}</p>

        {state.status === "saving" && <p className="eyebrow pulse rewards__sync">{t("rewards.syncing")}</p>}
        {state.status === "error" && <p className="error">{t("rewards.saveError", { error: state.error })}</p>}

        {reward && !reward.counted && <p className="rewards__nocount">{line(reward.reasonKey, undefined, reward.reason ?? "")}</p>}

        {reward?.counted && (
          <>
            <div className="rewards__xp">
              +<CountUp to={reward.xp} />
              <small>XP</small>
            </div>
            <ul className="rewards__lines">
              {reward.breakdown.map((l) => (
                <li key={l.label}>
                  <span>{line(l.key, l.vars, l.label)}</span>
                  <b>+{l.xp}</b>
                </li>
              ))}
            </ul>
            <LevelBar xp={reward.xpAfter} from={reward.xpBefore} />
            {leveledUp && after && (
              <div className="rewards__levelup">
                {t("rewards.levelUp")} <b>{t("player.lv", { n: after.level })}</b> · {levelText(t, after.level, after.title)}
              </div>
            )}
            {reward.streak > 1 && (
              <p className="rewards__streak">
                {t("rewards.streak", { n: reward.streak })}
              </p>
            )}

            {reward.newBadges.length > 0 && (
              <div className="rewards__badges">
                <p className="eyebrow">{reward.newBadges.length > 1 ? t("rewards.badgesUnlocked", { n: reward.newBadges.length }) : t("rewards.badgeUnlocked")}</p>
                <div className="rewards__badge-row">
                  {reward.newBadges.map((id, i) => {
                    const b = BADGE_BY_ID[id];
                    return (
                      b && (
                        <div key={id} className="rewards__badge" style={{ animationDelay: `${0.5 + i * 0.25}s` }}>
                          <BadgeIcon badge={b} earned size={84} fresh />
                          <b>{badgeName(t, b)}</b>
                        </div>
                      )
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}

        {done && next && (
          <div className="rewards__next">
            <p className="eyebrow">{t("rewards.next")}</p>
            <GoalCard goal={next} onAction={onAction} showAction={false} />
          </div>
        )}

        {done?.user?.kind === "guest" && googleReady && (
          <p className="hint">{t("rewards.guest")}</p>
        )}

        <div className="hero__cta">
          {next && nextLabel(next.action) && (
            <button className="btn primary" onClick={() => onAction(next.action)}>
              {nextLabel(next.action)} ▸
            </button>
          )}
          <button className={`btn ${next ? "ghost" : "primary"}`} onClick={onAgain}>
            {t("rewards.again")}
          </button>
          <button className="btn ghost" onClick={onProfile}>
            {t("rewards.profile")}
          </button>
          <button className="btn ghost" onClick={onHome}>
            {t("rewards.home")}
          </button>
        </div>
      </div>
    </div>
  );
}
