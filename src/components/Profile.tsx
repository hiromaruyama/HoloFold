import { useState } from "react";
import { BADGES, emptyProgress, levelInfo, nextGoals, type BadgeAction, type Goal } from "../../shared/progress";
import { localDay, renameUser, signOut, type Account, type User } from "../lib/account";
import { badgeHow, badgeName, levelText, localizePlan, usePrefs, type Translate } from "../lib/prefs";
import { LIBRARY } from "../library";
import type { Language } from "../../shared/schema";
import { Avatar, BadgeIcon, GoogleButton, LevelBar } from "./Player";
import { PrefsButton } from "./Prefs";

/** Library folds show in the current language; scans keep the title they were saved with. */
const logTitle = (planId: string, title: string, lang: Language) => {
  const plan = LIBRARY.find((p) => p.id === planId);
  return plan ? localizePlan(plan, lang).title : title;
};

interface Props {
  account: Account;
  onUser: (user: User | null) => void;
  onBack: () => void;
  onAction: (action: BadgeAction) => void;
}

export function actionLabel(t: Translate, lang: Language, action: BadgeAction): string | null {
  if (!action) return null;
  if (action.kind === "scan") return t("goal.scan");
  if (action.kind === "generate") return t("goal.generate");
  const plan = LIBRARY.find((p) => p.id === action.planId);
  return plan ? t("goal.fold", { title: localizePlan(plan, lang).title }) : null;
}

export function GoalCard({ goal, onAction, showAction = true }: { goal: Goal; onAction: (a: BadgeAction) => void; showAction?: boolean }) {
  const { t, prefs } = usePrefs();
  const label = showAction ? actionLabel(t, prefs.lang, goal.action) : null;
  return (
    <div className="goal panel">
      <BadgeIcon badge={goal.badge} earned={false} size={52} />
      <div className="goal__body">
        <b>{badgeName(t, goal.badge)}</b>
        <span>{badgeHow(t, goal.badge)}</span>
        <div className="goal__bar">
          <i style={{ width: `${(goal.current / goal.target) * 100}%` }} />
        </div>
        <small>
          {goal.current}/{goal.target}
        </small>
      </div>
      {label && (
        <button className="btn tiny" onClick={() => onAction(goal.action)}>
          {label} ▸
        </button>
      )}
    </div>
  );
}

const fmtDate = (ms: number, lang: Language) => new Date(ms).toLocaleDateString(lang, { month: "short", day: "numeric" });

export function Profile({ account, onUser, onBack, onAction }: Props) {
  const { t, prefs } = usePrefs();
  const { user, googleClientId } = account;
  const p = user?.progress ?? emptyProgress();
  const info = levelInfo(p.xp);
  const earned = BADGES.filter((b) => p.badges[b.id]).length;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user?.name ?? "");
  const [error, setError] = useState("");

  const saveName = async () => {
    setError("");
    try {
      onUser(await renameUser(name));
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="profile">
      <nav className="topbar">
        <button className="icon-btn" onClick={onBack} aria-label={t("profile.back")}>
          ←
        </button>
        <div className="brand small">
          <span className="brand__mark" />
          HOLO<b>FOLD</b>
          <span className="crumb">{t("profile.crumb")}</span>
        </div>
        <PrefsButton className="topbar__end" />
      </nav>

      <div className="profile__grid">
        <section className="panel id-card">
          <div className="id-card__top">
            <Avatar user={user} size={76} />
            <div className="id-card__who">
              <p className="eyebrow">{user ? (user.kind === "google" ? t("profile.google") : t("profile.guest")) : t("profile.none")}</p>
              {editing ? (
                <form
                  className="rename"
                  onSubmit={(e) => {
                    e.preventDefault();
                    saveName();
                  }}
                >
                  <input value={name} onChange={(e) => setName(e.target.value)} maxLength={24} autoFocus aria-label={t("profile.displayName")} />
                  <button className="btn tiny">{t("profile.save")}</button>
                  <button type="button" className="btn tiny ghost" onClick={() => setEditing(false)}>
                    {t("profile.cancel")}
                  </button>
                </form>
              ) : (
                <h1>
                  {user?.name ?? t("profile.newFolder")}
                  {user && (
                    <button
                      className="rename__btn"
                      onClick={() => {
                        setName(user.name);
                        setEditing(true);
                      }}
                      aria-label={t("profile.rename")}
                    >
                      ✎
                    </button>
                  )}
                </h1>
              )}
              {error && <p className="error">{error}</p>}
              {user?.email && <span className="id-card__mail">{user.email}</span>}
            </div>
          </div>

          <div className="id-card__rank">
            <div className="rank-num">
              <small>{t("profile.level")}</small>
              {info.level}
            </div>
            <div className="rank-bar">
              <b>{levelText(t, info.level, info.title)}</b>
              <LevelBar xp={p.xp} showTitle={false} />
              <span className="hint">{t("profile.toNext", { xp: info.xpNeeded - info.xpInto, level: info.level + 1 })}</span>
            </div>
          </div>

          <div className="stats">
            <div>
              <b>{p.folds}</b>
              <span>{t("profile.folds")}</span>
            </div>
            <div>
              <b>{p.stepsFolded}</b>
              <span>{t("profile.steps")}</span>
            </div>
            <div>
              <b>
                {p.streak.current}
                <small>d</small>
              </b>
              <span>{t("profile.streak", { n: p.streak.best })}</span>
            </div>
            <div>
              <b>
                {earned}
                <small>/{BADGES.length}</small>
              </b>
              <span>{t("profile.badges")}</span>
            </div>
          </div>

          <div className="id-card__auth">
            {user?.kind === "google" ? (
              <button
                className="btn ghost"
                onClick={async () => {
                  window.google?.accounts.id.disableAutoSelect();
                  await signOut();
                  onUser(null);
                }}
              >
                {t("profile.signOut")}
              </button>
            ) : (
              <>
                <p className="hint">
                  {user ? t("profile.signInKeep") : t("profile.signInStart")}
                </p>
                <GoogleButton clientId={googleClientId} onUser={onUser} />
              </>
            )}
          </div>
        </section>

        <section className="profile__side">
          <div className="section-head">
            <p className="eyebrow">{t("profile.objectives")}</p>
            <h2>{t("profile.keepFolding")}</h2>
          </div>
          <div className="goals">
            {nextGoals(p, 3, localDay()).map((g) => (
              <GoalCard key={g.badge.id} goal={g} onAction={onAction} />
            ))}
          </div>

          {p.history.length > 0 && (
            <>
              <div className="section-head">
                <p className="eyebrow">{t("profile.log")}</p>
                <h2>{t("profile.recent")}</h2>
              </div>
              <ul className="log panel">
                {p.history
                  .slice(-8)
                  .reverse()
                  .map((c) => (
                    <li key={c.at}>
                      <span className="log__date">{fmtDate(c.at, prefs.lang)}</span>
                      <b>{logTitle(c.planId, c.title, prefs.lang)}</b>
                      {c.verifiedSteps >= c.steps && <span className="log__flag">{t("profile.flawless")}</span>}
                      <span className="log__xp">+{c.xp} XP</span>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </section>
      </div>

      <section className="cabinet">
        <div className="section-head">
          <p className="eyebrow">{t("profile.cabinet")}</p>
          <h2>{t("profile.unlocked", { n: earned, total: BADGES.length })}</h2>
        </div>
        <div className="cabinet__grid">
          {BADGES.map((b) => {
            const at = p.badges[b.id];
            const { current, target } = b.progress(p);
            return (
              <div key={b.id} className={`cabinet__item ${at ? "earned" : ""}`}>
                <BadgeIcon badge={b} earned={Boolean(at)} size={78} />
                <b>{badgeName(t, b)}</b>
                <span>{badgeHow(t, b)}</span>
                <small>{at ? t("profile.earned", { date: fmtDate(at, prefs.lang) }) : target > 1 ? `${current}/${target}` : t("profile.locked")}</small>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
