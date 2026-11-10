import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BadgeAction } from "../../shared/progress";
import type { GuidePlan, VerifyResult } from "../../shared/schema";
import { localDay, recordCompletion, type Account, type User } from "../lib/account";
import { verifyStep, type Health } from "../lib/api";
import { AutoAdvance, type Evidence } from "../lib/autoAdvance";
import { realHull, realShape } from "../lib/fold";
import { captureFrame, splitDataUrl } from "../lib/images";
import { coverTransform, renderFrame, viewToVideo, type RenderState, type ViewTransform } from "../lib/renderer";
import { listenForCommands, speak, stopSpeaking, voiceSupported, type VoiceCommand } from "../lib/speech";
import { actionText, usePrefs, type Translate } from "../lib/prefs";
import { arPalette } from "../lib/themes";
import { outlinesDiffer, PaperTracker, type TrackResult } from "../lib/tracker";
import { PrefsButton } from "./Prefs";
import { Rewards, type RewardState } from "./Rewards";
import { useCrops } from "./Scan";
import { StepHologram } from "./StepHologram";

interface Props {
  plan: GuidePlan;
  health: Health | null;
  account: Account;
  onExit: () => void;
  onUser: (user: User | null) => void;
  onAction: (action: BadgeAction) => void;
  onProfile: () => void;
}

interface HudState {
  found: boolean;
  quality: number;
  stable: boolean;
  fps: number;
  calibrated: boolean;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function cameraErrorMessage(e: unknown, t: Translate): string {
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError") return t("cam.denied");
  if (name === "NotFoundError" || name === "OverconstrainedError") return t("cam.notFound");
  if (name === "NotReadableError") return t("cam.inUse");
  return (e as Error)?.message ?? t("cam.failed");
}

function Typewriter({ text, instant }: { text: string; instant: boolean }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (instant) return setN(text.length);
    setN(0);
    const id = setInterval(() => setN((v) => (v >= text.length ? (clearInterval(id), v) : v + 2)), 14);
    return () => clearInterval(id);
  }, [text, instant]);
  return (
    <>
      {text.slice(0, n)}
      {n < text.length && <i className="caret" />}
    </>
  );
}

export function Guide({ plan, health, account, onExit, onUser, onAction, onProfile }: Props) {
  const { t, prefs, reduced } = usePrefs();
  const pal = useMemo(() => arPalette(prefs.theme, prefs.contrast), [prefs.theme, prefs.contrast]);
  const sayOpts = { lang: prefs.lang, slow: prefs.calm };
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const maskRef = useRef<HTMLCanvasElement>(null);
  const trackerRef = useRef<PaperTracker | null>(null);
  trackerRef.current ??= new PaperTracker();

  const [stepIndex, setStepIndex] = useState(0);
  const [camState, setCamState] = useState<"starting" | "live" | "error">("starting");
  const [camError, setCamError] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | undefined>();
  const [mirror, setMirror] = useState(false);
  const [hud, setHud] = useState<HudState>({ found: false, quality: 0, stable: false, fps: 0, calibrated: false });
  const [tts, setTts] = useState(prefs.read);
  const [voice, setVoice] = useState(false);
  const [autoCheck, setAutoCheck] = useState(false);
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tolerance, setTolerance] = useState(40);
  const [showMask, setShowMask] = useState(false);
  const [checking, setChecking] = useState(false);
  const [verdict, setVerdict] = useState<VerifyResult | null>(null);
  const [finished, setFinished] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [diagramOpen, setDiagramOpen] = useState(true);
  const [rewardState, setRewardState] = useState<RewardState>({ status: "saving" });
  /** When this run of the model started, and which steps a check (camera or AI) confirmed. */
  const run = useRef({ startedAt: Date.now(), verified: new Set<number>(), submitted: false });
  const crops = useCrops(plan);
  const ai = Boolean(health?.ai);

  const n = plan.steps.length;
  const step = plan.steps[stepIndex];
  const hulls = useMemo(() => plan.steps.map(realHull), [plan]);
  const shapes = useMemo(() => plan.steps.map(realShape), [plan]);
  /** What the camera can use as proof that each step is done (see autoAdvance.ts). */
  const kinds = useMemo<Evidence[]>(
    () =>
      plan.steps.map((s, i) => {
        if (i >= plan.steps.length - 1) return "none";
        if (outlinesDiffer(hulls[i], hulls[i + 1])) return "shape";
        return s.action === "crease-unfold" ? "sequence" : "activity";
      }),
    [plan, hulls],
  );

  // Mutable state read by the render loop without re-subscribing.
  const live = useRef({
    stepIndex: 0,
    mirror: false,
    autoCheck: false,
    autoAdvance: true,
    ai: false,
    /** A step was just accepted and the guide is about to move on. */
    advancing: false,
    match: null as TrackResult["match"],
    /** Where the paper is in the camera image, for cropping the frame sent to the AI. */
    paper: null as TrackResult["corners"] | null,
    checking: false,
    showMask: false,
    sawMotion: true,
    lastCheckAt: 0,
    flash: null as RenderState["flash"],
    view: null as ViewTransform | null,
    pal,
    reduced,
    labels: { placePaper: "", placeHint: "", turnOver: "", rotate: "" },
    cutLabels: { placePaper: "", placeHint: "", turnOver: "", rotate: "" },
  });
  live.current.pal = pal;
  live.current.reduced = reduced;
  live.current.labels = { placePaper: t("ar.placePaper"), placeHint: t("ar.placeHint"), turnOver: t("ar.turnOver"), rotate: t("ar.rotate") };
  live.current.cutLabels = { ...live.current.labels, placePaper: t("ar.cutPaper"), placeHint: t("ar.cutHint") };
  live.current.stepIndex = stepIndex;
  live.current.mirror = mirror;
  live.current.autoCheck = autoCheck;
  live.current.autoAdvance = autoAdvance && !finished;
  live.current.ai = ai;
  live.current.showMask = showMask;

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    if (trackerRef.current) trackerRef.current.tolerance = tolerance;
  }, [tolerance]);

  const tRef = useRef(t);
  tRef.current = t;

  // Camera.
  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    (async () => {
      setCamState("starting");
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error(window.isSecureContext ? tRef.current("cam.noBrowser") : tRef.current("cam.insecure"));
        }
        const size = { width: { ideal: 1280 }, height: { ideal: 720 } };
        stream = await navigator.mediaDevices.getUserMedia({
          video: deviceId ? { deviceId: { exact: deviceId }, ...size } : { facingMode: { ideal: "environment" }, ...size },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play().catch(() => {});
        setCamState("live");
        const all = await navigator.mediaDevices.enumerateDevices();
        if (!cancelled) setDevices(all.filter((d) => d.kind === "videoinput"));
      } catch (e) {
        if (!cancelled) {
          setCamState("error");
          setCamError(cameraErrorMessage(e, tRef.current));
        }
      }
    })();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [deviceId]);

  const go = useCallback(
    (i: number) => {
      if (i >= n) {
        setFinished(true);
        return;
      }
      const next = Math.max(0, i);
      setStepIndex(next);
      live.current.stepIndex = next;
      live.current.sawMotion = true;
      live.current.lastCheckAt = performance.now();
      setVerdict(null);
    },
    [n],
  );

  const ttsRef = useRef(tts);
  ttsRef.current = tts;

  /** The camera saw the step done: celebrate briefly, then move on. */
  const acceptStep = useCallback(
    (i: number, weak: boolean) => {
      const L = live.current;
      if (L.stepIndex !== i || L.advancing) return;
      L.advancing = true;
      L.flash = { kind: "complete", t0: performance.now() / 1000 };
      if (!weak) run.current.verified.add(i);
      setToast(t(weak ? "guide.autoWeak" : "guide.autoDone", { n: i + 1 }));
      setTimeout(() => {
        L.advancing = false;
        if (L.stepIndex === i) go(i + 1);
      }, 900);
    },
    [go, t],
  );
  const acceptRef = useRef(acceptStep);
  acceptRef.current = acceptStep;

  useEffect(() => {
    if (tts) speak(t("guide.say", { n: stepIndex + 1, text: step.instruction }), { lang: prefs.lang, slow: prefs.calm });
  }, [stepIndex, tts, step.instruction, t, prefs.lang, prefs.calm]);
  useEffect(() => () => stopSpeaking(), []);

  const runCheck = useCallback(
    async (auto = false) => {
      if (!ai) {
        // No AI: answer from what the tracker sees of the paper's outline.
        if (auto) return;
        const at = live.current.stepIndex;
        const m = kinds[at] === "shape" ? live.current.match : null;
        if (m === "after") acceptStep(at, false);
        else setToast(t(m === "before" ? "guide.deviceNotYet" : "guide.deviceUnsure"));
        return;
      }
      if (live.current.checking) return;
      const video = videoRef.current;
      const frame = video ? captureFrame(video, 1024, live.current.paper) : null;
      if (!frame) {
        setToast(t("guide.camNotReady"));
        return;
      }
      const i = live.current.stepIndex;
      const s = plan.steps[i];
      live.current.checking = true;
      setChecking(true);
      try {
        const res = await verifyStep({
          frame: splitDataUrl(frame).data,
          reference: crops[i] ? splitDataUrl(crops[i]!).data : undefined,
          planTitle: plan.title,
          stepIndex: i,
          totalSteps: n,
          step: { title: s.title, instruction: s.instruction, action: s.action, tip: s.tip },
          nextStep: plan.steps[i + 1] ? { title: plan.steps[i + 1].title, instruction: plan.steps[i + 1].instruction } : undefined,
          language: prefs.lang,
          simple: prefs.simple,
        });
        if (live.current.stepIndex !== i) return;
        setVerdict(res);
        if (res.status === "complete" || res.status === "mistake") {
          live.current.flash = { kind: res.status, t0: performance.now() / 1000 };
        }
        if (ttsRef.current) speak(res.feedback, sayOpts);
        if (res.status === "complete" && res.confidence >= 0.55) {
          run.current.verified.add(i);
          setTimeout(() => {
            if (live.current.stepIndex === i) go(i + 1);
          }, 1800);
        }
      } catch (e) {
        if (!auto) setToast((e as Error).message);
      } finally {
        live.current.checking = false;
        live.current.lastCheckAt = performance.now();
        setChecking(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ai, acceptStep, crops, go, kinds, n, plan, t, prefs.lang, prefs.simple, prefs.calm],
  );
  const runCheckRef = useRef(runCheck);
  runCheckRef.current = runCheck;

  // Record the fold on the player's profile once they reach the end.
  const onUserRef = useRef(onUser);
  onUserRef.current = onUser;
  useEffect(() => {
    if (!finished || run.current.submitted) return;
    run.current.submitted = true;
    setRewardState({ status: "saving" });
    recordCompletion({
      planId: plan.id,
      title: plan.title,
      origin: plan.origin,
      difficulty: plan.difficulty,
      steps: n,
      verifiedSteps: run.current.verified.size,
      durationMs: Date.now() - run.current.startedAt,
      day: localDay(),
    })
      .then((r) => {
        setRewardState({ status: "done", reward: r.reward, user: r.user });
        if (r.user) onUserRef.current(r.user);
      })
      .catch((e: Error) => setRewardState({ status: "error", error: e.message }));
  }, [finished, n, plan]);

  // Render loop.
  useEffect(() => {
    let raf = 0;
    let lastHud = 0;
    let frames = 0;
    let fpsT = performance.now();
    let fps = 0;
    let lock = 0;
    let maskTick = 0;
    const auto = new AutoAdvance();
    let autoStep = -1;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const canvas = canvasRef.current;
      const stage = stageRef.current;
      const video = videoRef.current;
      const tracker = trackerRef.current;
      if (!canvas || !stage || !video || !tracker) return;
      const L = live.current;
      const i = L.stepIndex;
      const rect = stage.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = Math.round(rect.width * dpr);
      const H = Math.round(rect.height * dpr);
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const track = video.readyState >= 2 ? tracker.process(video, String(i), hulls[i], now, hulls[i + 1] ?? null) : null;
      L.match = track?.match ?? null;
      L.paper = track?.found ? track.corners : (track?.afterCorners ?? null);
      lock += ((track?.found ? 1 : 0) - lock) * 0.15;
      const view = track?.videoW ? coverTransform(track.videoW, track.videoH, rect.width, rect.height, L.mirror) : null;
      L.view = view;

      if (track && track.motion > 0.05) L.sawMotion = true;
      let autoProgress = 0;
      if (L.autoCheck && track?.found && L.sawMotion && !L.checking && now - L.lastCheckAt > 8000) {
        autoProgress = track.stillness;
        if (track.stable) {
          L.sawMotion = false;
          runCheckRef.current(true);
        }
      }
      // Auto-advance: move on once the camera has seen the fold done.
      if (autoStep !== i) {
        autoStep = i;
        auto.reset(now, kinds[i]);
      }
      if (L.autoAdvance && track && !L.advancing && !L.checking) {
        const o = auto.update({ now, found: track.found, match: track.match, motion: track.motion, hands: track.hands });
        autoProgress = Math.max(autoProgress, o.progress);
        if (o.advance) {
          if (o.weak && L.ai) {
            // Weak proof and an AI to ask: let it decide, and wait for new activity meanwhile.
            auto.reset(now, kinds[i]);
            runCheckRef.current(true);
          } else {
            acceptRef.current(i, o.weak);
          }
        }
      }

      renderFrame({
        ctx,
        cw: rect.width,
        ch: rect.height,
        view,
        track,
        step: plan.steps[i],
        shapeReal: shapes[i],
        t: now / 1000,
        lock,
        flash: L.flash,
        checking: L.checking,
        autoCheckProgress: autoProgress,
        pal: L.pal,
        labels: tracker.cutOff ? L.cutLabels : L.labels,
        reduced: L.reduced,
      });

      frames++;
      if (now - fpsT > 1000) {
        fps = (frames * 1000) / (now - fpsT);
        frames = 0;
        fpsT = now;
      }
      if (now - lastHud > 200) {
        lastHud = now;
        setHud({
          found: Boolean(track?.found),
          quality: track?.quality ?? 0,
          stable: Boolean(track?.stable),
          fps,
          calibrated: tracker.calibrated,
        });
      }
      if (L.showMask && maskRef.current && ++maskTick % 5 === 0) {
        const { w, h } = tracker.maskSize;
        const mc = maskRef.current;
        if (w && h) {
          if (mc.width !== w || mc.height !== h) {
            mc.width = w;
            mc.height = h;
          }
          const mctx = mc.getContext("2d")!;
          const img = mctx.createImageData(w, h);
          tracker.paintMask(img);
          mctx.putImageData(img, 0, 0);
        }
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [plan, hulls, shapes, kinds]);

  // Keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        go(live.current.stepIndex + 1);
      } else if (e.key === "ArrowLeft") go(live.current.stepIndex - 1);
      else if (e.key.toLowerCase() === "c") runCheckRef.current();
      else if (e.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  // Voice commands.
  useEffect(() => {
    if (!voice) return;
    const onCommand = (c: VoiceCommand) => {
      const i = live.current.stepIndex;
      if (c === "next") go(i + 1);
      else if (c === "back") go(i - 1);
      else if (c === "repeat") speak(t("guide.say", { n: i + 1, text: plan.steps[i].instruction }), { lang: prefs.lang, slow: prefs.calm });
      else if (c === "check") runCheckRef.current();
    };
    return listenForCommands(
      onCommand,
      (msg) => {
        setToast(msg);
        setVoice(false);
      },
      prefs.lang,
      { unsupported: t("voice.unsupported"), micBlocked: t("voice.micBlocked") },
    );
  }, [voice, go, plan, t, prefs.lang, prefs.calm]);

  const onStageTap = (e: React.PointerEvent<HTMLDivElement>) => {
    const view = live.current.view;
    const video = videoRef.current;
    if (!view || !video?.videoWidth) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const p = viewToVideo(view, e.clientX - rect.left, e.clientY - rect.top);
    const nx = p.x / video.videoWidth;
    const ny = p.y / video.videoHeight;
    if (nx < 0 || ny < 0 || nx > 1 || ny > 1) return;
    trackerRef.current?.calibrate(nx, ny);
    setToast(t("guide.colorLocked"));
  };

  const assignments = Array.from(new Set(step.lines.map((l) => l.assignment)));
  const statusLabel = hud.found ? (hud.stable ? t("guide.steady") : t("guide.locked")) : t("guide.searching");

  return (
    <div className="guide">
      <div className="stage" ref={stageRef} onPointerDown={onStageTap}>
        <video ref={videoRef} playsInline muted className={mirror ? "mirror" : ""} />
        <canvas ref={canvasRef} className="overlay" />
        <div className="fx-scanlines" />
        <div className="fx-vignette" />
        {camState !== "live" && (
          <div className="cam-msg">
            {camState === "starting" ? (
              <p className="eyebrow pulse">{t("guide.init")}</p>
            ) : (
              <div className="panel cam-msg__box">
                <p className="eyebrow">{t("guide.camOffline")}</p>
                <p>{camError}</p>
                <p className="hint">{t("guide.camOfflineHint")}</p>
              </div>
            )}
          </div>
        )}
      </div>

      <header className="g-top">
        <button className="icon-btn" onClick={onExit} aria-label={t("guide.exit")}>
          ←
        </button>
        <div className="g-title">
          <span className="eyebrow">{t("guide.header")}</span>
          <b>{plan.title}</b>
        </div>
        <div className="g-status">
          <span className={`pill ${hud.found ? "ok" : "search"}`}>
            <i />
            {statusLabel}
          </span>
          {hud.found && <span className="pill dim">{t("guide.fit", { n: Math.round(hud.quality * 100) })}</span>}
          <span className="pill dim hide-sm">{t("guide.fps", { n: Math.round(hud.fps) })}</span>
        </div>
        <div className="g-actions">
          {voiceSupported() && (
            <button
              className={`icon-btn ${voice ? "on" : ""}`}
              onClick={() => setVoice((v) => !v)}
              aria-pressed={voice}
              title={t("guide.voiceTitle")}
              aria-label={t("guide.voiceTitle")}
            >
              🎙
            </button>
          )}
          <button className={`icon-btn ${tts ? "on" : ""}`} onClick={() => setTts((v) => !v)} aria-pressed={tts} title={t("guide.ttsTitle")} aria-label={t("guide.ttsTitle")}>
            🔊
          </button>
          <PrefsButton />
          <button
            className={`icon-btn ${settingsOpen ? "on" : ""}`}
            onClick={() => setSettingsOpen((v) => !v)}
            title={t("guide.settingsTitle")}
            aria-label={t("guide.settingsTitle")}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <circle cx="12" cy="12" r="7" />
              <circle cx="12" cy="12" r="2" />
              <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
            </svg>
          </button>
        </div>
      </header>

      <section className="g-step panel">
        <div className="step-head">
          <div className="step-num">
            {pad2(stepIndex + 1)}
            <small>/{pad2(n)}</small>
          </div>
          <div>
            <span className="badge">{actionText(t, step.action)}</span>
            <h2>{step.title}</h2>
          </div>
        </div>
        <p className="instruction">
          <Typewriter text={step.instruction} instant={reduced} />
        </p>
        {step.tip && <p className="tip">◆ {step.tip}</p>}
        {assignments.length > 0 && (
          <div className="legend">
            {assignments.includes("V") && (
              <span className="legend__v">
                <i /> {t("guide.valley")}
              </span>
            )}
            {assignments.includes("M") && (
              <span className="legend__m">
                <i /> {t("guide.mountain")}
              </span>
            )}
            {assignments.includes("F") && (
              <span className="legend__f">
                <i /> {t("guide.existing")}
              </span>
            )}
          </div>
        )}
        {verdict && (
          <div className={`verdict ${verdict.status}`}>
            <b>
              {verdict.status === "complete"
                ? t("verdict.complete")
                : verdict.status === "mistake"
                  ? t("verdict.mistake")
                  : verdict.status === "in_progress"
                    ? t("verdict.progress")
                    : t("verdict.cannot")}
            </b>
            <span>{verdict.feedback}</span>
          </div>
        )}
        <div className="step-controls">
          <button className="btn ghost" onClick={() => go(stepIndex - 1)} disabled={stepIndex === 0}>
            {t("guide.back")}
          </button>
          <button
            className="btn primary"
            onClick={() => runCheck()}
            disabled={checking || camState !== "live"}
            title={ai ? t("guide.checkTitle") : t("guide.checkDeviceTitle")}
          >
            {checking ? t("guide.analyzing") : t("guide.check")}
          </button>
          <button className="btn ghost" onClick={() => go(stepIndex + 1)}>
            {stepIndex === n - 1 ? t("guide.finish") : t("guide.next")}
          </button>
        </div>
        {autoAdvance && kinds[stepIndex] !== "none" && <p className="hint auto-status">{t("guide.autoStatus")}</p>}
      </section>

      <aside className={`g-diagram panel ${diagramOpen ? "" : "collapsed"}`}>
        <button className="panel-label" onClick={() => setDiagramOpen((v) => !v)}>
          {t("guide.diagram")} {diagramOpen ? "▾" : "▸"}
        </button>
        {diagramOpen && (
          <>
            <StepHologram step={step} />
            {crops[stepIndex] && (
              <figure className="source-crop">
                <img src={crops[stepIndex]!} alt={t("guide.sourceAlt", { n: stepIndex + 1 })} />
                <figcaption>{t("guide.source", { n: stepIndex + 1 })}</figcaption>
              </figure>
            )}
          </>
        )}
      </aside>

      <footer className="g-timeline">
        {plan.steps.map((s, j) => (
          <button
            key={j}
            className={j === stepIndex ? "now" : j < stepIndex ? "done" : ""}
            onClick={() => go(j)}
            title={`${j + 1}. ${s.title}`}
            aria-label={t("guide.goStep", { n: j + 1, title: s.title })}
          />
        ))}
      </footer>

      {settingsOpen && (
        <div className="settings panel">
          <p className="eyebrow">{t("guide.tracking")}</p>
          <label className="row">
            <span>{t("guide.tolerance")}</span>
            <input type="range" min={15} max={80} value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))} />
            <code>{tolerance}</code>
          </label>
          <div className="row">
            <span>{hud.calibrated ? t("guide.colorFromTap") : t("guide.autoColor")}</span>
            {hud.calibrated && (
              <button className="btn tiny" onClick={() => trackerRef.current?.resetCalibration()}>
                {t("guide.reset")}
              </button>
            )}
          </div>
          <label className="row check">
            <input type="checkbox" checked={showMask} onChange={(e) => setShowMask(e.target.checked)} />
            <span>{t("guide.showMask")}</span>
          </label>
          {showMask && <canvas ref={maskRef} className="mask-view" />}
          <label className="row check">
            <input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} />
            <span>{t("guide.mirror")}</span>
          </label>
          {devices.length > 1 && (
            <label className="row">
              <span>{t("guide.camera")}</span>
              <select value={deviceId ?? ""} onChange={(e) => setDeviceId(e.target.value || undefined)}>
                <option value="">{t("guide.default")}</option>
                {devices.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || t("guide.cameraN", { n: i + 1 })}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="eyebrow">{t("guide.autoTitle")}</p>
          <label className="row check">
            <input type="checkbox" checked={autoAdvance} onChange={(e) => setAutoAdvance(e.target.checked)} />
            <span>{t("guide.autoAdvance")}</span>
          </label>
          <p className="hint">{t("guide.autoHint")}</p>
          <p className="eyebrow">{t("guide.ai")}</p>
          <label className="row check">
            <input type="checkbox" checked={autoCheck} disabled={!ai} onChange={(e) => setAutoCheck(e.target.checked)} />
            <span>{t("guide.autoCheck")}</span>
          </label>
          <p className="hint">{t("guide.keys")}</p>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}

      {finished && (
        <Rewards
          title={plan.title}
          steps={n}
          planId={plan.id}
          state={rewardState}
          googleReady={Boolean(account.googleClientId)}
          onAgain={() => {
            run.current = { startedAt: Date.now(), verified: new Set(), submitted: false };
            setFinished(false);
            go(0);
          }}
          onAction={onAction}
          onProfile={onProfile}
          onHome={onExit}
        />
      )}
    </div>
  );
}
