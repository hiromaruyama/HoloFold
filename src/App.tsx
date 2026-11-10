import { useEffect, useMemo, useState } from "react";
import type { BadgeAction } from "../shared/progress";
import type { GuidePlan } from "../shared/schema";
import { Guide } from "./components/Guide";
import { HoloPreview } from "./components/HoloPreview";
import { Home } from "./components/Home";
import { WhoPicker } from "./components/Prefs";
import { Profile } from "./components/Profile";
import { Scan } from "./components/Scan";
import { getAccount, type Account, type User } from "./lib/account";
import { getHealth, type Health } from "./lib/api";
import { localizePlan, PrefsProvider, usePrefs } from "./lib/prefs";
import { LIBRARY } from "./library";
import { deleteScan, loadScans } from "./lib/storage";

type Screen =
  | { name: "home"; focus?: "generate" }
  | { name: "scan"; generate?: string; plan?: GuidePlan; files?: File[]; key: number }
  | { name: "guide"; plan: GuidePlan }
  | { name: "profile" };

export function App() {
  const [account, setAccount] = useState<Account>({ user: null, googleClientId: null });
  useEffect(() => {
    getAccount().then(setAccount);
  }, []);
  return (
    <PrefsProvider userId={account.user?.id ?? null}>
      <Main account={account} setAccount={setAccount} />
    </PrefsProvider>
  );
}

function Main({ account, setAccount }: { account: Account; setAccount: React.Dispatch<React.SetStateAction<Account>> }) {
  const { prefs, needsSetup } = usePrefs();
  const [health, setHealth] = useState<Health | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: "home" });
  const [scans, setScans] = useState<GuidePlan[]>(() => loadScans());
  /** The model whose hologram preview is open; confirming it starts the AR guide. */
  const [preview, setPreview] = useState<GuidePlan | null>(null);

  useEffect(() => {
    getHealth().then(setHealth);
  }, []);

  useEffect(() => {
    if (screen.name === "home") setScans(loadScans());
    if (!(screen.name === "home" && screen.focus)) window.scrollTo(0, 0);
  }, [screen]);

  // Built-in models follow the chosen language.
  const guidePlan = useMemo(() => (screen.name === "guide" ? localizePlan(screen.plan, prefs.lang) : null), [screen, prefs.lang]);
  const previewPlan = useMemo(() => (preview ? localizePlan(preview, prefs.lang) : null), [preview, prefs.lang]);

  const home = () => setScreen({ name: "home" });
  const profile = () => setScreen({ name: "profile" });
  const setUser = (user: User | null) => setAccount((a) => ({ ...a, user }));

  /** Jump to whatever moves the player toward a badge. */
  const runAction = (action: BadgeAction) => {
    if (!action) return;
    if (action.kind === "fold") {
      const plan = LIBRARY.find((p) => p.id === action.planId);
      if (!plan) return;
      setScreen({ name: "home" });
      setPreview(plan);
    } else if (action.kind === "scan") setScreen({ name: "scan", key: Date.now() });
    else setScreen({ name: "home", focus: "generate" });
  };

  let content;
  if (screen.name === "guide" && guidePlan)
    content = (
      <Guide
        key={guidePlan.id}
        plan={guidePlan}
        health={health}
        account={account}
        onExit={home}
        onUser={setUser}
        onAction={runAction}
        onProfile={profile}
      />
    );
  else if (screen.name === "profile") content = <Profile account={account} onUser={setUser} onBack={home} onAction={runAction} />;
  else if (screen.name === "scan")
    content = (
      <Scan
        key={screen.key}
        health={health}
        generateName={screen.generate}
        plan={screen.plan}
        initialFiles={screen.files}
        onBack={home}
        onStart={setPreview}
      />
    );
  else
    content = (
      <Home
        health={health}
        user={account.user}
        scans={scans}
        focus={screen.name === "home" ? screen.focus : undefined}
        onScan={() => setScreen({ name: "scan", key: Date.now() })}
        onUpload={(files) => setScreen({ name: "scan", files, key: Date.now() })}
        onGenerate={(name) => setScreen({ name: "scan", generate: name, key: Date.now() })}
        onOpenLibrary={setPreview}
        onOpenScan={(plan) => setScreen({ name: "scan", plan, key: Date.now() })}
        onDeleteScan={(id) => {
          deleteScan(id);
          setScans(loadScans());
        }}
        onProfile={profile}
        onAction={runAction}
      />
    );

  return (
    <>
      {content}
      {previewPlan && preview && (
        <HoloPreview
          key={previewPlan.id}
          plan={previewPlan}
          onCancel={() => setPreview(null)}
          onConfirm={() => {
            setScreen({ name: "guide", plan: preview });
            setPreview(null);
          }}
        />
      )}
      {needsSetup && <WhoPicker />}
    </>
  );
}
