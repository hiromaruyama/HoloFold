import { useEffect, useRef, useState } from "react";
import { emptyProgress, nextGoals, type BadgeAction } from "../../shared/progress";
import type { GuidePlan } from "../../shared/schema";
import { localDay, type User } from "../lib/account";
import type { Health } from "../lib/api";
import { diffText, localizePlan, usePrefs } from "../lib/prefs";
import { LIBRARY } from "../library";
import { HoloCrane } from "./HoloCrane";
import { PlayerChip } from "./Player";
import { PrefsButton } from "./Prefs";
import { GoalCard } from "./Profile";
import { StepHologram } from "./StepHologram";
import { UploadDrop } from "./UploadDrop";

interface Props {
  health: Health | null;
  user: User | null;
  scans: GuidePlan[];
  focus?: "generate";
  onScan: () => void;
  /** Files dropped or picked in the "your own instructions" box. */
  onUpload: (files: File[]) => void;
  onGenerate: (name: string) => void;
  onOpenLibrary: (plan: GuidePlan) => void;
  onOpenScan: (plan: GuidePlan) => void;
  onDeleteScan: (id: string) => void;
  onProfile: () => void;
  onAction: (action: BadgeAction) => void;
}

/** The most visually interesting step to preview on a card: the middle step with moving folds. */
function previewStep(plan: GuidePlan) {
  const withFlaps = plan.steps.filter((s) => s.lines.some((l) => l.flap));
  return withFlaps[Math.floor(withFlaps.length / 2)] ?? plan.steps[0];
}

export function AiChip({ health }: { health: Health | null }) {
  const { t } = usePrefs();
  if (!health) return <span className="chip dim">{t("ai.linking")}</span>;
  return health.ai ? (
    <span className="chip ok" title={health.model}>
      <i /> {t("ai.online")}
      <span className="chip__more"> · {health.model}</span>
    </span>
  ) : (
    <span className="chip warn" title={t("ai.offlineTitle")}>
      <i /> {t("ai.offline")}
      <span className="chip__more"> · {t("ai.libraryOnly")}</span>
    </span>
  );
}

export function Home({ health, user, scans, focus, onScan, onUpload, onGenerate, onOpenLibrary, onOpenScan, onDeleteScan, onProfile, onAction }: Props) {
  const { t, prefs } = usePrefs();
  const [name, setName] = useState("");
  const ai = Boolean(health?.ai);
  const progress = user?.progress ?? emptyProgress();
  const goals = nextGoals(progress, 2, localDay());
  const generateRef = useRef<HTMLElement>(null);
  const sheets = (n: number) => (n > 1 ? t("common.sheetN", { n }) : t("common.sheet1"));

  useEffect(() => {
    if (focus !== "generate") return;
    generateRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    generateRef.current?.querySelector("input")?.focus({ preventScroll: true });
  }, [focus]);

  return (
    <div className="home">
      <nav className="topbar">
        <div className="brand">
          <span className="brand__mark" />
          HOLO<b>FOLD</b>
        </div>
        <AiChip health={health} />
        <PrefsButton />
        <PlayerChip user={user} onClick={onProfile} />
      </nav>

      <header className="hero">
        <div className="hero__copy">
          <p className="eyebrow">{t("home.eyebrow")}</p>
          <h1>
            {t("home.title1")}
            <br />
            <span className="grad">{t("home.title2")}</span>
          </h1>
          <p className="lede">{t("home.lede")}</p>
          <div className="hero__cta">
            <button className="btn primary" onClick={onScan}>
              <span className="btn__icon">⌁</span> {t("home.scan")}
            </button>
            <a className="btn ghost" href="#library">
              {t("home.browse")}
            </a>
          </div>
          {!ai && health && <p className="hint">{t("home.keyHint")}</p>}
        </div>
        <HoloCrane />
      </header>

      {goals.length > 0 && (
        <section className="quests">
          <div className="quests__head">
            <p className="eyebrow">{user ? t("home.nextBadges") : t("home.startBadges")}</p>
            <button className="btn tiny ghost" onClick={onProfile}>
              {t("home.allBadges")}
            </button>
          </div>
          <div className="quests__row">
            {goals.map((g) => (
              <GoalCard key={g.badge.id} goal={g} onAction={onAction} />
            ))}
          </div>
        </section>
      )}

      <section className="upload-home">
        <div className="section-head">
          <p className="eyebrow">{t("upload.homeEyebrow")}</p>
          <h2>{t("upload.homeTitle")}</h2>
        </div>
        <UploadDrop variant="dock" paste onFiles={onUpload} />
      </section>

      <section className="generate panel" ref={generateRef}>
        <div>
          <p className="eyebrow">{t("home.noDiagram")}</p>
          <h3>{t("home.generateTitle")}</h3>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) onGenerate(name.trim());
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("home.generatePlaceholder")}
            disabled={!ai}
            aria-label={t("home.modelName")}
          />
          <button className="btn primary" disabled={!ai || !name.trim()}>
            {t("home.generate")}
          </button>
        </form>
      </section>

      <section id="library">
        <div className="section-head">
          <p className="eyebrow">{t("home.library")}</p>
          <h2>{t("home.ready")}</h2>
        </div>
        <div className="cards">
          {LIBRARY.map((raw) => {
            const plan = localizePlan(raw, prefs.lang);
            const stats = progress.models[plan.id];
            return (
              <button key={plan.id} className="card" onClick={() => onOpenLibrary(raw)} style={{ ["--accent" as string]: prefs.theme === "holo" ? plan.accent : undefined }}>
                <div className="card__art">
                  <StepHologram step={previewStep(plan)} />
                </div>
                <div className="card__body">
                  <h3>{plan.title}</h3>
                  <p>{plan.summary}</p>
                  <div className="card__meta">
                    {stats && (
                      <span className="folded" title={t("home.foldedTimes", { n: stats.count })}>
                        ✓ {stats.count > 1 ? `×${stats.count}` : t("home.folded")}
                      </span>
                    )}
                    <span className={`diff ${plan.difficulty}`}>{diffText(t, plan.difficulty)}</span>
                    <span>{t("common.steps", { n: plan.steps.length })}</span>
                    <span>{sheets(plan.sheets)}</span>
                  </div>
                </div>
                <span className="card__go">{t("home.preview")}</span>
              </button>
            );
          })}
        </div>
      </section>

      {scans.length > 0 && (
        <section>
          <div className="section-head">
            <p className="eyebrow">{t("home.yourScans")}</p>
            <h2>{t("home.savedHere")}</h2>
          </div>
          <div className="scans">
            {scans.map((plan) => (
              <div key={plan.id} className="scan-row panel">
                <button className="scan-row__main" onClick={() => onOpenScan(plan)}>
                  {(plan.thumb ?? plan.images?.[0]) ? <img src={plan.thumb ?? plan.images?.[0]} alt="" /> : <div className="scan-row__ph">AI</div>}
                  <div>
                    <b>{plan.title}</b>
                    <span>
                      {t("common.steps", { n: plan.steps.length })} · {plan.origin === "generated" ? t("home.generated") : t("home.scanned")}{" "}
                      {new Date(plan.createdAt).toLocaleDateString(prefs.lang)}
                    </span>
                  </div>
                </button>
                <button className="icon-btn" onClick={() => onDeleteScan(plan.id)} aria-label={t("home.delete", { title: plan.title })}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="how">
        <div className="section-head">
          <p className="eyebrow">{t("home.how")}</p>
          <h2>{t("home.howTitle")}</h2>
        </div>
        <ol className="how__grid">
          <li className="panel">
            <span className="how__n">01</span>
            <h4>{t("home.how1t")}</h4>
            <p>{t("home.how1")}</p>
          </li>
          <li className="panel">
            <span className="how__n">02</span>
            <h4>{t("home.how2t")}</h4>
            <p>{t("home.how2")}</p>
          </li>
          <li className="panel">
            <span className="how__n">03</span>
            <h4>{t("home.how3t")}</h4>
            <p>{t("home.how3")}</p>
          </li>
        </ol>
      </section>

      <footer className="foot">{t("home.foot")}</footer>
    </div>
  );
}
