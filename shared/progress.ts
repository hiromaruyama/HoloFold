/**
 * Player progress: XP, levels, daily streaks and badges.
 *
 * Pure functions shared by the server (the source of truth, which applies each finished
 * fold) and the client (which shows levels, badge progress and the next goal).
 * Progress is fully derived from the fold history, so merging two profiles is just
 * replaying both histories in time order.
 */

export type FoldOrigin = "library" | "scan" | "generated";
export type FoldDifficulty = "easy" | "medium" | "hard";

/** What the client reports when the player reaches the end of a model. */
export interface CompletionInput {
  planId: string;
  title: string;
  origin: FoldOrigin;
  difficulty: FoldDifficulty;
  steps: number;
  /** Steps that an AI fold check confirmed as complete. */
  verifiedSteps: number;
  durationMs: number;
  /** The player's local calendar day, YYYY-MM-DD (streaks follow the player's clock). */
  day: string;
}

export interface Completion extends CompletionInput {
  at: number;
  xp: number;
}

export interface ModelStats {
  title: string;
  origin: FoldOrigin;
  count: number;
  flawless: boolean;
}

export interface Progress {
  xp: number;
  folds: number;
  stepsFolded: number;
  models: Record<string, ModelStats>;
  origins: Record<FoldOrigin, number>;
  hardFolds: number;
  flawlessFolds: number;
  streak: { current: number; best: number; lastDay: string | null };
  /** Badge id → time it was earned (ms). */
  badges: Record<string, number>;
  /** Counted folds, oldest first. */
  history: Completion[];
}

export interface XpLine {
  label: string;
  xp: number;
  /** Translation key and values so the client can show the line in the player's language. */
  key?: string;
  vars?: Record<string, string | number>;
}

export interface Reward {
  counted: boolean;
  /** Why a fold didn't count, when it didn't. */
  reason?: string;
  reasonKey?: string;
  xp: number;
  breakdown: XpLine[];
  newBadges: string[];
  xpBefore: number;
  xpAfter: number;
  streak: number;
}

/** The built-in library, in the order a new player should try them. */
export const LIBRARY_ORDER = ["lib-shuriken", "lib-plane", "lib-cup", "lib-crane"] as const;

/** A fold faster than this per step is treated as clicking through, not folding. */
export const MIN_MS_PER_STEP = 2500;

const HISTORY_CAP = 2000;

export function emptyProgress(): Progress {
  return {
    xp: 0,
    folds: 0,
    stepsFolded: 0,
    models: {},
    origins: { library: 0, scan: 0, generated: 0 },
    hardFolds: 0,
    flawlessFolds: 0,
    streak: { current: 0, best: 0, lastDay: null },
    badges: {},
    history: [],
  };
}

// ---------- Levels ----------

export const LEVEL_TITLES = [
  "Paper Rookie",
  "Crease Cadet",
  "Fold Runner",
  "Flap Tactician",
  "Origami Adept",
  "Holo Folder",
  "Paper Architect",
  "Fold Master",
  "Grand Folder",
  "Origami Legend",
];

/** Total XP needed to reach a level: 0, 100, 300, 600, 1000, 1500, … */
export function xpForLevel(level: number): number {
  return 50 * (level - 1) * level;
}

export interface LevelInfo {
  level: number;
  title: string;
  xpInto: number;
  xpNeeded: number;
  fraction: number;
}

export function levelInfo(xp: number): LevelInfo {
  let level = 1;
  while (xp >= xpForLevel(level + 1)) level++;
  const base = xpForLevel(level);
  const needed = xpForLevel(level + 1) - base;
  return {
    level,
    title: LEVEL_TITLES[Math.min(level, LEVEL_TITLES.length) - 1],
    xpInto: xp - base,
    xpNeeded: needed,
    fraction: (xp - base) / needed,
  };
}

// ---------- Badges ----------

export type BadgeColor = "cyan" | "magenta" | "amber" | "green" | "violet";

export type BadgeAction = { kind: "fold"; planId: string } | { kind: "scan" } | { kind: "generate" } | null;

export interface BadgeDef {
  id: string;
  name: string;
  /** How to earn it, as an instruction. */
  how: string;
  glyph: string;
  color: BadgeColor;
  progress: (p: Progress) => { current: number; target: number };
  /** What the player can do next to work toward it. */
  action?: (p: Progress) => BadgeAction;
}

const folded = (p: Progress, id: string) => (p.models[id]?.count ?? 0) > 0;
const firstUnfolded = (p: Progress): BadgeAction => {
  const id = LIBRARY_ORDER.find((m) => !folded(p, m));
  return id ? { kind: "fold", planId: id } : null;
};
/** Something to fold next: a new library model, else the one folded least. */
const keepFolding = (p: Progress): BadgeAction => {
  const fresh = firstUnfolded(p);
  if (fresh) return fresh;
  const least = [...LIBRARY_ORDER].sort((a, b) => (p.models[a]?.count ?? 0) - (p.models[b]?.count ?? 0))[0];
  return { kind: "fold", planId: least };
};
const notFlawless = (p: Progress): BadgeAction => {
  const id = LIBRARY_ORDER.find((m) => !p.models[m]?.flawless);
  return id ? { kind: "fold", planId: id } : null;
};
const modelBadge = (id: string, name: string, how: string, glyph: string, color: BadgeColor): BadgeDef => ({
  id: `model:${id}`,
  name,
  how,
  glyph,
  color,
  progress: (p) => ({ current: folded(p, id) ? 1 : 0, target: 1 }),
  action: () => ({ kind: "fold", planId: id }),
});
const count = (id: string, name: string, how: string, glyph: string, color: BadgeColor, target: number, get: (p: Progress) => number, action?: BadgeDef["action"]): BadgeDef => ({
  id,
  name,
  how,
  glyph,
  color,
  progress: (p) => ({ current: Math.min(get(p), target), target }),
  action,
});

export const BADGES: BadgeDef[] = [
  count("first-fold", "First Crease", "Finish your first model", "折", "cyan", 1, (p) => p.folds, keepFolding),
  modelBadge("lib-shuriken", "Shadow Star", "Fold the Ninja Star", "星", "magenta"),
  modelBadge("lib-plane", "Lift Off", "Fold the Paper Plane", "飛", "cyan"),
  modelBadge("lib-cup", "Bottoms Up", "Fold the Paper Cup", "杯", "green"),
  modelBadge("lib-crane", "First of a Thousand", "Fold the Classic Crane", "鶴", "violet"),
  count("collector", "Library Complete", "Fold all four built-in models", "全", "amber", 4, (p) => LIBRARY_ORDER.filter((m) => folded(p, m)).length, firstUnfolded),
  count("scanner", "Diagram Decoder", "Finish a model you scanned from a photo", "読", "cyan", 1, (p) => p.origins.scan, () => ({ kind: "scan" })),
  count("generator", "Dream Weaver", "Finish a model generated from its name", "夢", "magenta", 1, (p) => p.origins.generated, () => ({ kind: "generate" })),
  count("flawless", "Flawless", "Get every step of a model confirmed by Check my fold", "✓", "green", 1, (p) => p.flawlessFolds, notFlawless),
  count("summit", "Summit", "Finish a hard model", "極", "amber", 1, (p) => p.hardFolds, () => ({ kind: "scan" })),
  count("streak-3", "On a Roll", "Fold on 3 days in a row", "連", "amber", 3, (p) => p.streak.best, keepFolding),
  count("streak-7", "Paper Week", "Fold on 7 days in a row", "週", "magenta", 7, (p) => p.streak.best, keepFolding),
  count("folds-5", "Fold Five", "Finish 5 folds", "5", "cyan", 5, (p) => p.folds, keepFolding),
  count("folds-10", "Dedicated", "Finish 10 folds", "10", "violet", 10, (p) => p.folds, keepFolding),
  count("folds-25", "Paper Flock", "Finish 25 folds", "25", "amber", 25, (p) => p.folds, keepFolding),
  count("explorer", "Explorer", "Fold 6 different models", "∞", "green", 6, (p) => Object.keys(p.models).length, (p) => firstUnfolded(p) ?? { kind: "generate" }),
  count("steps-250", "Crease Engine", "Fold 250 steps in total", "⚙︎", "violet", 250, (p) => p.stepsFolded, keepFolding),
];

export const BADGE_BY_ID: Record<string, BadgeDef> = Object.fromEntries(BADGES.map((b) => [b.id, b]));

export interface Goal {
  badge: BadgeDef;
  current: number;
  target: number;
  action: BadgeAction;
}

/**
 * Unearned badges, closest to done first. Pass the player's `today` to skip streak
 * badges once they've already folded today, since those can't move until tomorrow.
 */
export function nextGoals(p: Progress, limit = 3, today?: string): Goal[] {
  const foldedToday = today !== undefined && p.streak.lastDay === today;
  return BADGES.filter((b) => !p.badges[b.id] && !(foldedToday && b.id.startsWith("streak-")))
    .map((badge, order) => {
      const { current, target } = badge.progress(p);
      return { badge, current, target, action: badge.action?.(p) ?? null, order };
    })
    .sort((a, b) => b.current / b.target - a.current / a.target || a.order - b.order)
    .slice(0, limit)
    .map(({ order: _order, ...goal }) => goal);
}

// ---------- Applying a fold ----------

function dayNumber(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

const DIFFICULTY_MULT: Record<FoldDifficulty, number> = { easy: 1, medium: 1.5, hard: 2 };

/** Applies one finished fold. Returns new progress (the input is not modified) and the reward. */
export function applyCompletion(prev: Progress, input: CompletionInput, at = Date.now()): { progress: Progress; reward: Reward } {
  const base: Reward = { counted: false, xp: 0, breakdown: [], newBadges: [], xpBefore: prev.xp, xpAfter: prev.xp, streak: prev.streak.current };
  if (input.steps < 1) return { progress: prev, reward: { ...base, reason: "This model has no steps.", reasonKey: "reason.noSteps" } };
  if (input.durationMs < input.steps * MIN_MS_PER_STEP) {
    return {
      progress: prev,
      reward: {
        ...base,
        reason: "That was quicker than folding paper allows, so it doesn't count. Fold along for real to earn XP and badges.",
        reasonKey: "reason.tooFast",
      },
    };
  }

  const p: Progress = structuredClone(prev);
  const firstTime = !p.models[input.planId];
  const flawless = input.verifiedSteps >= input.steps;

  // Streak, by the player's calendar day.
  const today = dayNumber(input.day);
  const last = p.streak.lastDay ? dayNumber(p.streak.lastDay) : null;
  const firstToday = last === null || today > last;
  if (last === null || today - last > 1) p.streak.current = 1;
  else if (today - last === 1) p.streak.current += 1;
  if (firstToday) p.streak.lastDay = input.day;
  p.streak.best = Math.max(p.streak.best, p.streak.current);

  const breakdown: XpLine[] = [];
  const mult = DIFFICULTY_MULT[input.difficulty];
  breakdown.push({
    label: `${input.steps} steps × ${mult} (${input.difficulty})`,
    xp: Math.round(input.steps * 10 * mult),
    key: "xp.steps",
    vars: { n: input.steps, mult, difficulty: input.difficulty },
  });
  breakdown.push({ label: "Model complete", xp: 25, key: "xp.complete" });
  if (firstTime) breakdown.push({ label: "First time folding this model", xp: 50, key: "xp.firstTime" });
  if (input.verifiedSteps > 0)
    breakdown.push({
      label: `${input.verifiedSteps} step${input.verifiedSteps > 1 ? "s" : ""} confirmed by AI`,
      xp: Math.min(input.verifiedSteps, input.steps) * 5,
      key: input.verifiedSteps > 1 ? "xp.verifiedN" : "xp.verified1",
      vars: { n: input.verifiedSteps },
    });
  if (firstToday) breakdown.push({ label: "First fold today", xp: 30, key: "xp.firstToday" });
  if (firstToday && p.streak.current > 1)
    breakdown.push({ label: `${p.streak.current}-day streak`, xp: Math.min(p.streak.current - 1, 6) * 10, key: "xp.streak", vars: { n: p.streak.current } });
  const xp = breakdown.reduce((s, l) => s + l.xp, 0);

  p.xp += xp;
  p.folds += 1;
  p.stepsFolded += input.steps;
  p.origins[input.origin] += 1;
  if (input.difficulty === "hard") p.hardFolds += 1;
  if (flawless) p.flawlessFolds += 1;
  const m = p.models[input.planId] ?? { title: input.title, origin: input.origin, count: 0, flawless: false };
  p.models[input.planId] = { ...m, title: input.title, count: m.count + 1, flawless: m.flawless || flawless };
  p.history.push({ ...input, at, xp });
  if (p.history.length > HISTORY_CAP) p.history.splice(0, p.history.length - HISTORY_CAP);

  const newBadges: string[] = [];
  for (const b of BADGES) {
    if (p.badges[b.id]) continue;
    const { current, target } = b.progress(p);
    if (current >= target) {
      p.badges[b.id] = at;
      newBadges.push(b.id);
    }
  }

  return {
    progress: p,
    reward: { counted: true, xp, breakdown, newBadges, xpBefore: prev.xp, xpAfter: p.xp, streak: p.streak.current },
  };
}

/** Rebuilds progress from fold history (used to merge a guest profile into an account). */
export function replay(history: Completion[]): Progress {
  let p = emptyProgress();
  for (const c of [...history].sort((a, b) => a.at - b.at)) {
    const { at, xp: _xp, ...input } = c;
    p = applyCompletion(p, input, at).progress;
  }
  return p;
}
