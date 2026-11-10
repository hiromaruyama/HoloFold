/**
 * Decides, from what the paper tracker sees frame by frame, when a step has been folded so
 * the guide can move on by itself. Pure logic: no camera or DOM.
 *
 * What counts as proof depends on the step:
 * - "shape": the outline changes with the fold. Proof is the finished outline, held steady.
 * - "sequence": fold and unfold. The outline has to leave its starting look and come back.
 * - "activity": the outline stays the same (turn over, reverse fold, …). All that can be seen
 *   is hands working on the paper and then letting go. This is weaker proof, flagged as such.
 * - "none": never advance (last step).
 */
export type Evidence = "none" | "shape" | "sequence" | "activity";

export interface AdvanceInput {
  now: number;
  found: boolean;
  match: "before" | "after" | "other" | null;
  /** Corner movement since the last frame, relative to paper size. */
  motion: number;
  /** Share of skin-colored pixels on and around the paper. */
  hands: number;
}

export interface AdvanceOutput {
  /** 0–1, how close the step is to being accepted. */
  progress: number;
  advance: boolean;
  /** True when the step was accepted on weak proof (hands worked, then let go). */
  weak: boolean;
  /** True while the finished outline is in view and being confirmed. */
  confirming: boolean;
}

/** Steady time showing the finished outline before the step is accepted. */
const CONFIRM_MS = 700;
/** Time everyone gets to read a new step before it can be accepted. */
const DWELL_MS = 1500;
/** How long hands have to work on the paper before letting go counts for anything. */
const ACTIVITY_MS = 1500;
/** Hands-off, steady time that ends an "activity" step. */
const REST_MS = 1600;
/** Hands-off, steady time that ends a "sequence" step. */
const RETURN_MS = 900;
/** How long the outline has to be gone for a fold-and-unfold to count as folded. */
const AWAY_MS = 350;
/** Time in view, not yet folded, after which the finished outline counts as new. */
const ARM_MS = 800;
const STILL = 0.02;
const RESTLESS = 0.06;
const HANDS_ON = 0.04;
const HANDS_OFF = 0.025;

const IDLE: AdvanceOutput = { progress: 0, advance: false, weak: false, confirming: false };

export class AutoAdvance {
  private kind: Evidence = "none";
  private startedAt = 0;
  private last = 0;
  private done = false;
  private seenBefore = false;
  /** How long the paper has been in view without showing the finished outline. */
  private notDone = 0;
  private armed = false;
  private confirm = 0;
  private activity = 0;
  private away = 0;
  private rest = 0;
  private lastFoundAt = -Infinity;
  /** Skin-colored share that is just the table or the paper itself, not hands. */
  private floor = Infinity;

  reset(now: number, kind: Evidence) {
    this.kind = kind;
    this.startedAt = now;
    this.last = now;
    this.done = false;
    this.seenBefore = false;
    this.notDone = 0;
    this.armed = false;
    this.confirm = 0;
    this.activity = 0;
    this.away = 0;
    this.rest = 0;
    this.lastFoundAt = -Infinity;
    this.floor = Infinity;
  }

  update(s: AdvanceInput): AdvanceOutput {
    // Capped so a stalled tab or a long pause doesn't count as time spent holding still.
    const dt = Math.min(250, Math.max(0, s.now - this.last));
    this.last = s.now;
    if (this.kind === "none" || this.done) return IDLE;

    const seen = s.found || s.match === "after";
    if (seen) {
      this.lastFoundAt = s.now;
      // The lowest reading so far is what the scene shows without hands; let it drift up
      // slowly so one odd frame doesn't set it for good.
      this.floor = Math.min(this.floor + dt * 0.000004, s.hands);
    }
    const hands = seen ? Math.max(0, s.hands - (Number.isFinite(this.floor) ? this.floor : 0)) : 0;
    const recentlySeen = s.now - this.lastFoundAt < 2000;
    if (s.match === "before") this.seenBefore = true;
    // Only a paper that was seen unfolded on this step can become "done": going back to a
    // step with the fold already made must not skip forward again by itself.
    if (s.found && s.match !== "after") this.notDone += dt;
    else if (s.match === "after") this.notDone = Math.max(0, this.notDone - dt * 2);
    if (s.match === "before" || this.notDone >= ARM_MS) this.armed = true;

    // Strong proof: the finished outline, steady. Corners jitter under a hand, so a slightly
    // restless outline still counts, only slower.
    // Nothing counts before the paper was seen unfolded, or an already folded paper would be
    // accepted the moment it is opened up.
    if (s.match !== "after" || !this.armed) this.confirm = Math.max(0, this.confirm - dt * 2);
    else if (s.motion < STILL) this.confirm += dt * (hands >= HANDS_ON ? 0.4 : 1);
    else if (s.motion < RESTLESS) this.confirm += dt * 0.25;
    const dwelled = s.now - this.startedAt >= DWELL_MS;
    if (this.armed && dwelled && this.confirm >= CONFIRM_MS) return this.accept(false);
    const strong = this.armed ? Math.min(1, this.confirm / CONFIRM_MS) : 0;
    if (this.kind === "shape") return { progress: strong, advance: false, weak: false, confirming: strong > 0 };

    // Weaker proof, for steps whose outline looks the same before and after.
    const working = hands >= HANDS_ON || (!seen && recentlySeen) || (s.found && s.motion > 0.03);
    if (working) this.activity += dt;
    if ((s.match === "other" || (!seen && recentlySeen)) && this.seenBefore) this.away += dt;

    const resting = s.found && s.match !== "other" && s.match !== "after" && s.motion < STILL && hands < HANDS_OFF;
    const sequence = this.kind === "sequence";
    const ready = sequence ? this.away >= AWAY_MS || this.activity >= ACTIVITY_MS : this.activity >= ACTIVITY_MS;
    const need = sequence ? RETURN_MS : REST_MS;
    if (ready && resting) this.rest += dt;
    else this.rest = Math.max(0, this.rest - dt * 2);
    if (ready && dwelled && this.seenBefore && this.rest >= need) return this.accept(!sequence);
    const weak = ready ? Math.min(1, this.rest / need) : 0;
    return { progress: Math.max(strong, weak), advance: false, weak: false, confirming: strong > 0 };
  }

  private accept(weak: boolean): AdvanceOutput {
    this.done = true;
    return { progress: 1, advance: true, weak, confirming: !weak };
  }
}
