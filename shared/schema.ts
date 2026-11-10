/**
 * The step format shared by the server (Claude structured output) and the client
 * (built-in models, the hologram renderer and the AR tracker).
 *
 * Fold-line assignments follow the FOLD file format convention
 * (github.com/edemaine/fold): V = valley, M = mountain, F = flat/existing crease,
 * U = unassigned.
 *
 * Coordinates: every point in a step is normalized to the bounding box of the paper
 * outline *at the start of that step*, as drawn in the diagram: x 0 → 1 left to right,
 * y 0 → 1 top to bottom. `aspect` = bounding-box width ÷ height restores the real
 * proportions (real x = x × aspect).
 */
import { z } from "zod";

export const PointSchema = z.object({
  x: z.number().describe("0 = left edge of the outline's bounding box, 1 = right edge"),
  y: z.number().describe("0 = top edge of the outline's bounding box, 1 = bottom edge"),
});

export const FoldLineSchema = z.object({
  from: PointSchema,
  to: PointSchema,
  assignment: z
    .enum(["V", "M", "F", "U"])
    .describe("V valley (dashed), M mountain (dash-dot), F existing crease used as a reference, U unclear"),
  flap: PointSchema.nullable().describe(
    "A point inside the part of the paper that moves when folding along this line. null for reference creases or collapse lines that don't pivot on their own.",
  ),
});

export const ActionSchema = z.enum([
  "valley",
  "mountain",
  "crease-unfold",
  "collapse",
  "squash",
  "petal",
  "inside-reverse",
  "outside-reverse",
  "rabbit-ear",
  "sink",
  "pleat",
  "turn-over",
  "rotate",
  "repeat",
  "tuck",
  "pull",
  "shape",
  "other",
]);

export const SourceBoxSchema = z.object({
  page: z.number().int().describe("0-based index of the image this diagram is on"),
  x: z.number().describe("left of the step's diagram, 0–1 of image width"),
  y: z.number().describe("top of the step's diagram, 0–1 of image height"),
  w: z.number().describe("width, 0–1 of image width"),
  h: z.number().describe("height, 0–1 of image height"),
});

export const StepSchema = z.object({
  title: z.string().describe("Short label, e.g. 'Kite fold the top layer'"),
  instruction: z
    .string()
    .describe("One or two imperative sentences a beginner can follow without seeing the diagram."),
  action: ActionSchema,
  shape: z
    .array(PointSchema)
    .describe("Outer corners of the paper outline at the START of this step, in order around the outline (3–8 points)."),
  aspect: z.number().describe("Bounding-box width ÷ height of that outline (1 for a square)."),
  lines: z.array(FoldLineSchema),
  rotateDegrees: z
    .number()
    .nullable()
    .describe("For 'rotate' steps, clockwise degrees; otherwise null."),
  tip: z.string().describe("A short helpful hint or common mistake to avoid; empty string if none."),
  source: SourceBoxSchema.nullable(),
});

export const PlanSchema = z.object({
  isOrigami: z.boolean().describe("false if the images are not origami folding instructions"),
  title: z.string(),
  summary: z.string().describe("One sentence describing the model."),
  difficulty: z.enum(["easy", "medium", "hard"]),
  sheets: z.number().int().describe("Number of sheets of paper needed"),
  paper: z.string().describe("Paper needed, e.g. '15 cm square, colored on one side'"),
  steps: z.array(StepSchema),
  notes: z.string().describe("Anything the reader could not resolve, or why this isn't origami. Empty if none."),
});

export const VerifySchema = z.object({
  status: z.enum(["complete", "in_progress", "mistake", "cannot_see"]),
  confidence: z.number().describe("0–1"),
  feedback: z.string().describe("Encouraging, concrete feedback in under 25 words."),
});

export type Point = z.infer<typeof PointSchema>;
export type FoldLine = z.infer<typeof FoldLineSchema>;
export type FoldAction = z.infer<typeof ActionSchema>;
export type SourceBox = z.infer<typeof SourceBoxSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type VerifyResult = z.infer<typeof VerifySchema>;

/** A plan as the client keeps it: the parsed plan plus where it came from. */
export interface GuidePlan extends Plan {
  id: string;
  origin: "library" | "scan" | "generated";
  /** Downscaled source pages (JPEG data URLs) for scanned plans. Saved plans keep these in IndexedDB. */
  images?: string[];
  /** Small preview of the first page, for the saved-scans list. */
  thumb?: string;
  createdAt: number;
  /** Library-only accent for the card art. */
  accent?: string;
}

/** Languages the app supports. Claude writes plans and feedback in the chosen one. */
export type Language = "en" | "ja";

/** Most pages (photos or rendered PDF pages) accepted in one parse request. */
export const MAX_PARSE_PAGES = 20;
/** Most characters of written instructions accepted in one parse request. */
export const MAX_PARSE_TEXT = 30_000;

export interface ParseRequest {
  images: {
    data: string;
    mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
    /** Where the page came from, e.g. "crane.pdf · p2". */
    label?: string;
  }[];
  /** Written instructions the user uploaded (.txt, a PDF's text layer) or pasted. */
  text?: string;
  hint?: string;
  language?: Language;
  /** Write for young children: short sentences, everyday words. */
  simple?: boolean;
}

export interface VerifyRequest {
  frame: string; // base64 JPEG (no data: prefix)
  reference?: string; // base64 JPEG crop of the step's diagram
  planTitle: string;
  stepIndex: number;
  totalSteps: number;
  step: Pick<Step, "title" | "instruction" | "action" | "tip">;
  nextStep?: Pick<Step, "title" | "instruction">;
  language?: Language;
  simple?: boolean;
}
