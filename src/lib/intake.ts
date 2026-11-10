/**
 * Turns whatever instructions the user uploads into what the diagram reader needs:
 * page images (JPEG data URLs, long edge ≤ 1568 px, which is what Claude's vision
 * sees best) plus any written text that came with them.
 *
 * - Photos and scans: JPG, PNG, WebP, GIF, BMP, AVIF (and HEIC where the browser can decode it)
 * - PDFs: every page is rendered to an image, and the text layer is kept as context
 * - Text files (.txt, .md): passed along as written instructions
 */
import { fileToJpeg } from "./images";

/** The most pages sent in one request (the server enforces the same limit). */
export const MAX_PAGES = 20;
/** Upper bound for written text sent with a request. */
export const MAX_TEXT = 30_000;

export const ACCEPT =
  "image/*,.heic,.heif,application/pdf,.pdf,text/plain,.txt,.md,.markdown";

export interface IntakePage {
  src: string;
  /** Where the page came from, e.g. "crane.pdf · p2" or "IMG_0412.jpg". */
  label: string;
}

export type IntakeProblem =
  | { code: "full" | "heic" | "image" | "pdfLocked" | "pdf" | "empty" | "type"; file: string }
  | { code: "truncated"; file: string; total: number; kept: number };

export type IntakeStatus = { kind: "image"; file: string } | { kind: "pdf"; file: string; page: number; of: number };

export interface IntakeResult {
  pages: IntakePage[];
  /** Contents of .txt/.md files: shown to the user as written steps they can edit. */
  written: string;
  /** Text layers of PDFs, sent along as context for the diagrams. */
  pdfText: { file: string; text: string }[];
  /** One per file that couldn't be used (or was cut short). */
  problems: IntakeProblem[];
}

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i;
const TEXT_EXT = /\.(txt|md|markdown)$/i;

export function kindOf(file: File): "image" | "pdf" | "text" | null {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return "pdf";
  if (file.type.startsWith("image/") || IMAGE_EXT.test(file.name)) return "image";
  if (file.type.startsWith("text/") || TEXT_EXT.test(file.name)) return "text";
  return null;
}

/**
 * Read files in the order given. `room` is how many more pages fit; pages past it are
 * dropped and reported, so a long PDF can't push out pages the user already added.
 */
export async function readInstructionFiles(
  files: File[],
  room = MAX_PAGES,
  onStatus?: (status: IntakeStatus) => void,
): Promise<IntakeResult> {
  const pages: IntakePage[] = [];
  const written: string[] = [];
  const pdfText: IntakeResult["pdfText"] = [];
  const problems: IntakeProblem[] = [];

  for (const file of files) {
    const kind = kindOf(file);
    const left = room - pages.length;
    if ((kind === "image" || kind === "pdf") && left <= 0) {
      problems.push({ code: "full", file: file.name });
      continue;
    }
    if (kind === "image") {
      onStatus?.({ kind: "image", file: file.name });
      try {
        pages.push({ src: await fileToJpeg(file), label: file.name });
      } catch {
        problems.push({ code: /\.(heic|heif)$/i.test(file.name) ? "heic" : "image", file: file.name });
      }
    } else if (kind === "pdf") {
      try {
        const pdf = await readPdf(file, left, (page, of) => onStatus?.({ kind: "pdf", file: file.name, page, of }));
        pages.push(...pdf.pages);
        if (pdf.text) pdfText.push({ file: file.name, text: pdf.text });
        if (pdf.total > pdf.pages.length) {
          problems.push({ code: "truncated", file: file.name, total: pdf.total, kept: pdf.pages.length });
        }
      } catch (e) {
        const err = e as Error;
        problems.push({ code: err.name === "PasswordException" || /password/i.test(err.message ?? "") ? "pdfLocked" : "pdf", file: file.name });
      }
    } else if (kind === "text") {
      const body = (await file.text()).trim();
      if (body) written.push(body);
      else problems.push({ code: "empty", file: file.name });
    } else {
      problems.push({ code: "type", file: file.name });
    }
  }

  return { pages, written: written.join("\n\n").slice(0, MAX_TEXT), pdfText, problems };
}

type PdfJs = typeof import("pdfjs-dist");
let pdfjs: Promise<PdfJs> | null = null;

/** pdf.js is ~1 MB, so it loads only when someone actually drops a PDF. */
function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(
    ([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    },
  );
  return pdfjs;
}

async function readPdf(
  file: File,
  maxPages: number,
  onPage: (page: number, of: number) => void,
): Promise<{ pages: IntakePage[]; text: string; total: number }> {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  try {
    const count = Math.min(doc.numPages, maxPages);
    const pages: IntakePage[] = [];
    const text: string[] = [];
    for (let n = 1; n <= count; n++) {
      onPage(n, count);
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      // Long edge ≈ 1568 px, but never upscale past 3× (tiny pages stay sharp enough).
      const scale = Math.min(3, 1568 / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      pages.push({ src: canvas.toDataURL("image/jpeg", 0.86), label: `${file.name} · p${n}` });

      const content = await page.getTextContent();
      const words = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (words) text.push(`[p${n}] ${words}`);
      page.cleanup();
    }
    return { pages, text: text.join("\n"), total: doc.numPages };
  } finally {
    void doc.loadingTask.destroy();
  }
}
