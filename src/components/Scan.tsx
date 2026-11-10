import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_PARSE_TEXT, type GuidePlan } from "../../shared/schema";
import { parseInstructions, type Health } from "../lib/api";
import { cropSource, splitDataUrl } from "../lib/images";
import { MAX_PAGES, readInstructionFiles, type IntakePage, type IntakeProblem, type IntakeStatus } from "../lib/intake";
import { actionText, diffText, usePrefs, type Translate } from "../lib/prefs";
import { saveScan, withImages } from "../lib/storage";
import { AiChip } from "./Home";
import { PrefsButton } from "./Prefs";
import { StepHologram } from "./StepHologram";
import { UploadDrop } from "./UploadDrop";

interface Props {
  health: Health | null;
  /** A model name to generate without images. */
  generateName?: string;
  /** A saved plan to show. */
  plan?: GuidePlan;
  /** Files dropped on the home screen, to read as soon as this screen opens. */
  initialFiles?: File[];
  onBack: () => void;
  onStart: (plan: GuidePlan) => void;
}

type Phase = "idle" | "analyzing" | "done" | "error";

export function useCrops(plan: GuidePlan | null): (string | null)[] {
  const [crops, setCrops] = useState<(string | null)[]>([]);
  useEffect(() => {
    let cancelled = false;
    setCrops([]);
    if (!plan?.images?.length) return;
    Promise.all(
      plan.steps.map(async (s) => {
        const src = s.source && plan.images?.[s.source.page];
        if (!src || !s.source || s.source.w <= 0 || s.source.h <= 0) return null;
        try {
          return await cropSource(src, s.source);
        } catch {
          return null;
        }
      }),
    ).then((list) => !cancelled && setCrops(list));
    return () => {
      cancelled = true;
    };
  }, [plan]);
  return crops;
}

export function Scan({ health, generateName, plan: initialPlan, initialFiles, onBack, onStart }: Props) {
  const { t, prefs } = usePrefs();
  // Read by analyze() without rebuilding it, so switching language never cancels a running scan.
  const settings = useRef({ t, prefs });
  settings.current = { t, prefs };
  const [pages, setPages] = useState<IntakePage[]>(() => pagesOf(initialPlan));
  /** Written steps the user typed, pasted or uploaded as .txt (editable). */
  const [written, setWritten] = useState("");
  /** Text layers of uploaded PDFs, sent along as context. */
  const [pdfText, setPdfText] = useState<{ file: string; text: string }[]>([]);
  const [problems, setProblems] = useState<IntakeProblem[]>([]);
  const [reading, setReading] = useState<IntakeStatus | null>(null);
  const [hint, setHint] = useState(generateName ?? "");
  const [phase, setPhase] = useState<Phase>(initialPlan ? "done" : "idle");
  const [log, setLog] = useState("");
  const [found, setFound] = useState(0);
  const [plan, setPlan] = useState<GuidePlan | null>(initialPlan ?? null);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const crops = useCrops(plan);
  const ai = Boolean(health?.ai);

  // Files are read one batch at a time, in order, so pages keep the order they were added in.
  const queue = useRef(Promise.resolve());
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const addFiles = useCallback((files: File[]) => {
    queue.current = queue.current.then(async () => {
      setError("");
      const room = MAX_PAGES - pagesRef.current.length;
      const res = await readInstructionFiles(files, room, setReading);
      setReading(null);
      setProblems(res.problems);
      if (res.pages.length) setPages((prev) => [...prev, ...res.pages].slice(0, MAX_PAGES));
      if (res.written) setWritten((w) => (w ? `${w}\n\n${res.written}` : res.written));
      if (res.pdfText.length) setPdfText((prev) => [...prev, ...res.pdfText]);
    });
  }, []);

  // Files dropped on the home screen.
  const took = useRef(false);
  useEffect(() => {
    if (initialFiles?.length && !took.current) {
      took.current = true;
      addFiles(initialFiles);
    }
  }, [initialFiles, addFiles]);

  // Saved scans keep their pages in IndexedDB; put them back for the diagram crops.
  useEffect(() => {
    if (!initialPlan || initialPlan.images?.length) return;
    let live = true;
    withImages(initialPlan).then((full) => {
      if (!live || !full.images?.length) return;
      setPlan(full);
      setPages(pagesOf(full));
    });
    return () => {
      live = false;
    };
  }, [initialPlan]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const analyze = useCallback(
    async (pgs: IntakePage[], name: string, text = "") => {
      const imgs = pgs.map((p) => p.src);
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setPhase("analyzing");
      setLog("");
      setFound(0);
      setError("");
      setPlan(null);
      try {
        const result = await parseInstructions(
          {
            images: pgs.map((p) => ({ ...splitDataUrl(p.src), label: p.label })),
            text: text || undefined,
            hint: name || undefined,
            language: settings.current.prefs.lang,
            simple: settings.current.prefs.simple,
          },
          {
            onThinking: (t) => setLog((l) => (l + t).slice(-4000)),
            onProgress: setFound,
          },
          ctrl.signal,
        );
        if (!result.isOrigami || result.steps.length === 0) {
          setPhase("error");
          setError(result.notes || settings.current.t("scan.notOrigami"));
          return;
        }
        const full: GuidePlan = {
          ...result,
          id: `scan-${Date.now()}`,
          origin: imgs.length || text ? "scan" : "generated",
          images: imgs.length ? imgs : undefined,
          createdAt: Date.now(),
        };
        saveScan(full);
        setPlan(full);
        setPhase("done");
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setPhase("error");
        setError((e as Error).message);
      }
    },
    [],
  );

  // Generate-from-name starts immediately.
  const started = useRef(false);
  useEffect(() => {
    if (generateName && !started.current) {
      started.current = true;
      analyze([], generateName);
    }
    return () => abortRef.current?.abort();
  }, [generateName, analyze]);

  return (
    <div className="scan">
      <nav className="topbar">
        <button className="icon-btn" onClick={onBack} aria-label={t("common.back")}>
          ←
        </button>
        <div className="brand small">
          <span className="brand__mark" />
          HOLO<b>FOLD</b> <span className="crumb">/ {generateName ? t("scan.generate") : t("scan.scan")}</span>
        </div>
        <AiChip health={health} />
        <PrefsButton />
      </nav>

      {phase === "idle" || (phase === "error" && !generateName) ? (
        <div className="scan__grid">
          <UploadDrop onFiles={addFiles} paste busy={reading ? readingText(t, reading) : undefined} />

          <div className="scan__side">
            {pages.length > 0 && (
              <>
                <div className="pages-head">
                  <span>{t("upload.pages", { n: pages.length, max: MAX_PAGES })}</span>
                  <button onClick={() => (setPages([]), setPdfText([]), setProblems([]))}>{t("upload.clear")}</button>
                </div>
                <div className="thumbs">
                  {pages.map((p, i) => (
                    <figure key={`${i}-${p.label}`} className="thumb" title={p.label}>
                      <img src={p.src} alt={t("scan.page", { n: i + 1 })} />
                      <figcaption>P{i + 1}</figcaption>
                      <button className="thumb__x" onClick={() => setPages((l) => l.filter((_, j) => j !== i))} aria-label={t("scan.removePage")}>
                        ✕
                      </button>
                    </figure>
                  ))}
                </div>
              </>
            )}
            {problems.length > 0 && (
              <ul className="upload-problems">
                {problems.map((pr, i) => (
                  <li key={i}>{problemText(t, pr)}</li>
                ))}
              </ul>
            )}
            <label className="field">
              <span>{t("upload.written")}</span>
              <textarea value={written} onChange={(e) => setWritten(e.target.value)} placeholder={t("upload.writtenPlaceholder")} />
            </label>
            {pdfText.length > 0 && pages.length > 0 && (
              <p className="doc-text">{t("upload.pdfText", { names: [...new Set(pdfText.map((d) => d.file))].join(", ") })}</p>
            )}
            <label className="field">
              <span>{t("scan.what")}</span>
              <input value={hint} onChange={(e) => setHint(e.target.value)} placeholder={t("scan.whatPlaceholder")} />
            </label>
            <button
              className="btn primary wide"
              disabled={!ai || Boolean(reading) || (pages.length === 0 && !written.trim())}
              onClick={() => analyze(pages, hint, requestText(written, pages.length ? pdfText : []))}
            >
              <span className="btn__icon">⌁</span>{" "}
              {pages.length > 1
                ? t("scan.analyzePages", { n: pages.length })
                : pages.length === 1 || !written.trim()
                  ? t("scan.analyzeOne")
                  : t("upload.analyzeText")}
            </button>
            {health && !ai && (
              <div className="ai-off panel">
                <b>{t("upload.aiOffTitle")}</b>
                <ol>
                  <li>{t("upload.aiOff1")}</li>
                  <li>
                    <code>{t("upload.aiOff2")}</code>
                  </li>
                  <li>{t("upload.aiOff3")}</li>
                </ol>
              </div>
            )}
            {error && <p className="error">{error}</p>}
            <ul className="tips">
              <li>{t("scan.tip1")}</li>
              <li>{t("scan.tip2")}</li>
              <li>{t("scan.tip3")}</li>
            </ul>
          </div>
        </div>
      ) : null}

      {phase === "analyzing" && (
        <div className="analyzing">
          <div className="analyzing__viz panel">
            {pages[0] ? <img src={pages[0].src} alt="" /> : <div className="analyzing__name">{hint || written.slice(0, 80)}</div>}
            <div className="analyzing__grid" />
            <div className="analyzing__beam" />
            <div className="analyzing__brackets" />
          </div>
          <div className="analyzing__side">
            <p className="eyebrow">{pages.length ? t("scan.decoding") : t("scan.synth")}</p>
            <div className="counter">
              <span>{String(found).padStart(2, "0")}</span>
              <small>{t("scan.decoded")}</small>
            </div>
            <pre className="terminal" ref={logRef}>
              {log || t("scan.terminal")}
              <i className="caret" />
            </pre>
            <button className="btn ghost" onClick={() => (abortRef.current?.abort(), setPhase(generateName ? "error" : "idle"))}>
              {t("scan.cancel")}
            </button>
          </div>
        </div>
      )}

      {phase === "error" && generateName && (
        <div className="center-msg panel">
          <p className="error">{error}</p>
          <button className="btn primary" onClick={() => analyze([], hint)}>
            {t("scan.retry")}
          </button>
        </div>
      )}

      {phase === "done" && plan && (
        <div className="result">
          <header className="result__head panel">
            <div>
              <p className="eyebrow">{plan.origin === "generated" ? t("scan.fromName") : t("scan.fromDiagram")}</p>
              <h1>{plan.title}</h1>
              <p className="lede">{plan.summary}</p>
              <div className="card__meta">
                <span className={`diff ${plan.difficulty}`}>{diffText(t, plan.difficulty)}</span>
                <span>{t("common.steps", { n: plan.steps.length })}</span>
                <span>{plan.paper}</span>
              </div>
              {plan.notes && <p className="hint">{t("scan.note", { note: plan.notes })}</p>}
            </div>
            <div className="result__actions">
              <button className="btn primary" onClick={() => onStart(plan)}>
                <span className="btn__icon">◉</span> {t("scan.start")}
              </button>
              {plan.origin === "scan" && (
                <button className="btn ghost" onClick={() => analyze(pages, hint, requestText(written, pages.length ? pdfText : []))} disabled={!ai}>
                  {t("scan.rescan")}
                </button>
              )}
            </div>
          </header>
          <ol className="steps">
            {plan.steps.map((s, i) => (
              <li key={i} className="step-row panel">
                <span className="step-row__n">{String(i + 1).padStart(2, "0")}</span>
                <div className="step-row__holo">
                  <StepHologram step={s} />
                </div>
                {crops[i] && <img className="step-row__crop" src={crops[i]!} alt={t("scan.cropAlt", { n: i + 1 })} />}
                <div className="step-row__text">
                  <span className="badge">{actionText(t, s.action)}</span>
                  <b>{s.title}</b>
                  <p>{s.instruction}</p>
                  {s.tip && <p className="tip">◆ {s.tip}</p>}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function pagesOf(plan: GuidePlan | undefined): IntakePage[] {
  return (plan?.images ?? []).map((src, i) => ({ src, label: `P${i + 1}` }));
}

/** Written steps first (the user's own words), then any PDF text, within the server's limit. */
function requestText(written: string, pdfText: { file: string; text: string }[]): string {
  const parts = [written.trim(), ...pdfText.map((d) => `From ${d.file}:\n${d.text}`)].filter(Boolean);
  return parts.join("\n\n").slice(0, MAX_PARSE_TEXT);
}

function readingText(t: Translate, s: IntakeStatus): string {
  return s.kind === "pdf" ? t("upload.readingPdf", { name: s.file, n: s.page, total: s.of }) : t("upload.readingImage", { name: s.file });
}

function problemText(t: Translate, p: IntakeProblem): string {
  return p.code === "truncated"
    ? t("upload.err.truncated", { name: p.file, total: p.total, kept: p.kept })
    : t(`upload.err.${p.code}`, { name: p.file, max: MAX_PAGES });
}
