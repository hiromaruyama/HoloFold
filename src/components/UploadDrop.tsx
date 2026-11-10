import { useEffect, useRef, useState } from "react";
import { ACCEPT } from "../lib/intake";
import { usePrefs } from "../lib/prefs";
import "./upload.css";

interface Props {
  onFiles: (files: File[]) => void;
  /** "full": the big target on the upload screen. "dock": the banner on the home screen. */
  variant?: "full" | "dock";
  /** Shown instead of the prompt while files are being read (e.g. rendering a PDF). */
  busy?: string;
  /** Also take files pasted with ⌘V / Ctrl+V anywhere on the page. */
  paste?: boolean;
}

const FORMATS = ["JPG", "PNG", "HEIC", "PDF", "TXT"];

/** Drop zone for instruction files: photos, scans, PDFs, text. Click to browse; on phones, a camera button too. */
export function UploadDrop({ onFiles, variant = "full", busy, paste }: Props) {
  const { t } = usePrefs();
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;

  useEffect(() => {
    if (!paste) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      onFilesRef.current(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [paste]);

  const take = (list: FileList | null | undefined) => {
    const files = Array.from(list ?? []);
    if (files.length) onFilesRef.current(files);
  };

  return (
    <div className={`updrop-wrap updrop-wrap--${variant}`}>
      <label
        className={`updrop updrop--${variant} panel${dragging ? " drag" : ""}${busy ? " busy" : ""}`}
        onDragEnter={(e) => {
          e.preventDefault();
          depth.current += 1;
          setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          depth.current = 0;
          setDragging(false);
          take(e.dataTransfer.files);
        }}
      >
        <input
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          disabled={Boolean(busy)}
          onChange={(e) => {
            take(e.target.files);
            e.target.value = "";
          }}
        />
        <span className="updrop__icon" aria-hidden>
          <svg viewBox="0 0 64 64" fill="none" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round">
            <path className="updrop__sheet back" d="M18 10h22l10 10v30H18z" />
            <path className="updrop__sheet" d="M12 16h22l10 10v30H12z" />
            <path className="updrop__sheet" d="M34 16v10h10" />
            <path className="updrop__arrow" d="M28 48V30m-7 7 7-7 7 7" />
          </svg>
        </span>
        <span className="updrop__copy">
          <b>{busy ?? (dragging ? t("upload.release") : t("upload.drop"))}</b>
          <span>{t("upload.dropSub")}</span>
          <span className="updrop__formats">
            {FORMATS.map((f) => (
              <i key={f}>{f}</i>
            ))}
          </span>
        </span>
        {variant === "dock" && (
          <span className="btn primary updrop__cta">
            <span className="btn__icon">⇪</span> {t("upload.choose")}
          </span>
        )}
      </label>
      <label className="btn ghost updrop__cam">
        <input
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          disabled={Boolean(busy)}
          onChange={(e) => {
            take(e.target.files);
            e.target.value = "";
          }}
        />
        ◉ {t("upload.camera")}
      </label>
    </div>
  );
}
