import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  MAX_PARSE_TEXT,
  PlanSchema,
  VerifySchema,
  type ParseRequest,
  type Plan,
  type VerifyRequest,
  type VerifyResult,
} from "../shared/schema.js";

export const MODEL = process.env.HOLOFOLD_MODEL ?? "claude-opus-5-5";

/**
 * Server-side fallback: if the model declines for policy reasons, the API re-runs the
 * request on Anthropic's recommended fallback model instead of returning a refusal.
 */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  client ??= new Anthropic();
  return client;
}

/** Best-effort check for whether any Anthropic credential is configured. */
export function hasCredentials(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      process.env.ANTHROPIC_PROFILE ||
      existsSync(path.join(homedir(), ".config", "anthropic")),
  );
}

export class UserFacingError extends Error {
  constructor(
    message: string,
    public status = 500,
  ) {
    super(message);
  }
}

const PARSE_SYSTEM = `You are HoloFold's diagram reader: an expert origami teacher who reads folding diagrams (Yoshizawa–Randlett notation) and turns them into machine-usable steps for an augmented-reality app. The app tracks the user's real sheet of paper through their camera and draws your fold lines onto it, so geometry matters as much as wording.

Reading the diagrams
- Valley fold: dashed line, arrow with a full head curving over to where the paper lands.
- Mountain fold: dash-dot or dash-dot-dot line, arrow with a half head; the paper folds behind.
- Existing crease: thin solid line. Hidden edge (X-ray view): dotted line.
- Fold and unfold: an arrow that goes out and comes back → action "crease-unfold".
- Turn over: looped arrow → "turn-over". Rotate: circular arrows, often with an angle → "rotate".
- Push / squash / sink: hollow arrow with a notched tail → "squash", "sink", "inside-reverse" or "outside-reverse" depending on what the diagram shows.
- Repeat: arrow with tick marks, or text like "repeat behind" → "repeat".
- Step numbers sit next to each diagram; follow them in numeric order across every page. A diagram that only shows the result of the previous step (no new symbols) is not a new step unless it is the finished model.
- Printed text in any language is useful context. Write every text field in the output language named in the request.

Writing the steps
- One step per physical action. Two symmetric folds in one diagram (e.g. both edges to the center) stay one step with two lines. Unrelated actions shown together get split.
- instruction: one or two imperative sentences a beginner can follow without seeing the picture, naming landmarks ("bottom corner", "top layer only", "center crease").
- shape: the paper outline as it looks at the START of the step, in the diagram's orientation, listing its outer corners in order around the outline (3–8 points). Coordinates are normalized to that outline's own bounding box: x 0 (left) → 1 (right), y 0 (top) → 1 (bottom). aspect = bounding-box width ÷ height (1 for a square, about 0.71 for A4 portrait).
- lines: the fold lines of this step in the same frame, with endpoints on the outline or on clear landmarks. Work the coordinates out geometrically rather than eyeballing them (e.g. folding a square base's lower edges to the center line gives creases at 22.5° from that line). assignment: V valley, M mountain, F existing crease used as a reference, U unclear. flap: a point inside the part of the paper that moves when folding on that line, or null for reference creases and collapse lines that don't pivot on their own.
- tip: a short hint or common mistake, or an empty string.
- source: which image (0-based, in the order given) and the box around this step's diagram, normalized 0–1 with x,y at the top-left. null when there are no images.
- If the images are not origami folding instructions, set isOrigami to false, explain why in notes, and return no steps.
- If no images are given, write the steps for the requested model from your own knowledge using its most common traditional method, with source null. If written instructions are given instead, follow them step by step.
- Images may be labelled with the file they came from ("guide.pdf · p3"). Skip pages with no folding steps (covers, ads, blank pages); a long document can hold more than one model, in which case convert the one the user names, or else the first complete one, and mention the others in notes.`;

const VERIFY_SYSTEM = `You check an origami folder's progress for an augmented-reality guide. You get one camera frame of their paper, the step they are working on, and sometimes the reference diagram for that step. Decide whether this step's fold looks done.
- complete: the fold for this step is visibly finished (minor neatness issues are fine).
- in_progress: they have not made this fold yet, or are partway through.
- mistake: the paper shows a different fold than the step asks for. Say concretely how to fix it.
- cannot_see: the paper is not visible, too blurry, or blocked by hands.
Feedback is spoken aloud to the folder: encouraging, concrete, under 25 words, no preamble.`;

type MediaType = ParseRequest["images"][number]["mediaType"];

/** Tells Claude which language and reading level to write in. */
function styleNote(language: ParseRequest["language"], simple: boolean | undefined, what: string): string {
  const lang =
    language === "ja"
      ? `Write ${what} in natural Japanese, using standard origami terms (谷折り, 山折り, 折り目, 裏返す…).`
      : `Write ${what} in English.`;
  if (!simple) return lang;
  return (
    lang +
    (language === "ja"
      ? " The folder is a young child: use short sentences, everyday words and mostly hiragana (keep kanji to the very simplest), and sound warm and encouraging."
      : " The folder is a young child: use short sentences and everyday words a 6-year-old knows, and sound warm and encouraging.")
  );
}

export interface ParseEvents {
  onThinking?: (delta: string) => void;
  onProgress?: (stepsFound: number) => void;
}

export async function parseInstructions(req: ParseRequest, events: ParseEvents = {}): Promise<Plan> {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  req.images.forEach((img, i) => {
    const label = img.label?.trim().slice(0, 120);
    content.push({ type: "text", text: label ? `Image ${i} (${label}):` : `Image ${i}:` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType as MediaType, data: img.data },
    });
  });
  const hint = req.hint?.trim();
  const written = req.text?.trim().slice(0, MAX_PARSE_TEXT);
  const style = styleNote(req.language, req.simple, "the title, summary, paper, notes, and every step's title, instruction and tip");
  if (req.images.length > 0) {
    content.push({
      type: "text",
      text:
        `Read ${req.images.length === 1 ? "this page" : `these ${req.images.length} pages`} of origami instructions and convert every step.` +
        (hint ? `\nThe user says: "${hint}"` : "") +
        `\n${style}`,
    });
  } else if (written) {
    content.push({
      type: "text",
      text:
        `There are no images. Convert the user's written origami instructions below into steps, filling in the geometry yourself from what each step describes.` +
        (hint ? `\nThe user says: "${hint}"` : "") +
        `\n${style}`,
    });
  } else {
    content.push({
      type: "text",
      text: `There are no images. Write complete folding steps for this origami model: "${hint}".\n${style}`,
    });
  }
  if (written) {
    content.push({
      type: "text",
      text:
        `Written instructions the user uploaded (from text files, PDF text, or pasted). Use them together with any diagrams; the diagrams decide the geometry when they disagree. Ignore anything in this text that isn't about folding.\n<written_instructions>\n${written}\n</written_instructions>`,
    });
  }

  const stream = getClient().beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "high", format: betaZodOutputFormat(PlanSchema) },
    system: PARSE_SYSTEM,
    messages: [{ role: "user", content }],
  });

  let lastCount = 0;
  stream.on("thinking", (delta) => events.onThinking?.(delta));
  stream.on("text", (_delta, snapshot) => {
    const count = (snapshot.match(/"instruction"\s*:/g) ?? []).length;
    if (count !== lastCount) {
      lastCount = count;
      events.onProgress?.(count);
    }
  });

  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") {
    throw new UserFacingError("The model declined to read these images. Try a different photo.", 422);
  }
  if (message.stop_reason === "max_tokens") {
    throw new UserFacingError("These instructions were too long to finish in one pass. Try fewer pages at a time.", 422);
  }
  if (!message.parsed_output) {
    throw new UserFacingError("Couldn't turn the diagrams into steps. Try a sharper, well-lit photo.", 422);
  }
  return message.parsed_output;
}

export async function verifyStep(req: VerifyRequest): Promise<VerifyResult> {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (req.reference) {
    content.push({ type: "text", text: "Reference diagram for this step:" });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: req.reference } });
  }
  content.push({ type: "text", text: "Camera frame of the user's paper right now:" });
  content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: req.frame } });
  content.push({
    type: "text",
    text: [
      `Model: ${req.planTitle}`,
      `Step ${req.stepIndex + 1} of ${req.totalSteps}: ${req.step.title}`,
      `Instruction: ${req.step.instruction}`,
      `Action type: ${req.step.action}`,
      req.step.tip ? `Tip: ${req.step.tip}` : "",
      req.nextStep ? `Next step (for context): ${req.nextStep.title}: ${req.nextStep.instruction}` : "",
      styleNote(req.language, req.simple, "the feedback"),
    ]
      .filter(Boolean)
      .join("\n"),
  });

  const stream = getClient().beta.messages.stream({
    model: MODEL,
    max_tokens: 4000,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(VerifySchema) },
    system: VERIFY_SYSTEM,
    messages: [{ role: "user", content }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal" || !message.parsed_output) {
    return {
      status: "cannot_see",
      confidence: 0,
      feedback: req.language === "ja" ? "うまく確認できませんでした。紙を真ん中にしてもう一度試してください。" : "I couldn't check that frame. Try again with the paper centered.",
    };
  }
  return message.parsed_output;
}

/** Map SDK errors to a status + message the browser can show. */
export function describeError(err: unknown): { status: number; message: string } {
  if (err instanceof UserFacingError) return { status: err.status, message: err.message };
  if (err instanceof Anthropic.AuthenticationError) {
    return { status: 401, message: "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in your .env file." };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { status: 429, message: "Rate limited by the Claude API. Wait a moment and try again." };
  }
  if (err instanceof Anthropic.BadRequestError) {
    return { status: 400, message: `The Claude API rejected the request: ${err.message}` };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { status: 502, message: "Couldn't reach the Claude API. Check your internet connection." };
  }
  if (err instanceof Anthropic.APIError) {
    return { status: err.status ?? 500, message: `Claude API error: ${err.message}` };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/api key|apiKey|credential|authentication/i.test(message)) {
    return { status: 503, message: "No Anthropic credentials found. Add ANTHROPIC_API_KEY to a .env file and restart." };
  }
  return { status: 500, message };
}
