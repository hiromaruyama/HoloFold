/**
 * Player accounts: a small JSON file store, signed session cookies, and Google sign-in.
 *
 * Everyone gets a profile. Players start as guests (a profile tied to this browser's
 * cookie) so folds count right away; signing in with Google attaches the profile to their
 * Google account, merging any guest progress into it.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { applyCompletion, emptyProgress, replay, type CompletionInput, type Progress, type Reward } from "../shared/progress.js";

export interface UserRecord {
  id: string;
  kind: "guest" | "google";
  googleSub?: string;
  email?: string;
  name: string;
  picture?: string;
  createdAt: number;
  progress: Progress;
}

/** What the browser sees: the record minus the Google subject id. */
export type PublicUser = Omit<UserRecord, "googleSub">;

interface Store {
  users: Record<string, UserRecord>;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.HOLOFOLD_DATA_DIR ? path.resolve(process.env.HOLOFOLD_DATA_DIR) : path.join(root, "data");
const storeFile = path.join(dataDir, "accounts.json");
const secretFile = path.join(dataDir, "session-secret");

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID?.trim() || null;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// ---------- Store ----------

const store: Store = existsSync(storeFile) ? (JSON.parse(readFileSync(storeFile, "utf8")) as Store) : { users: {} };

let writing: Promise<void> = Promise.resolve();
/** Writes the store atomically; writes are serialized so they never interleave. */
function persist(): Promise<void> {
  const json = JSON.stringify(store);
  writing = writing
    .then(async () => {
      await mkdir(dataDir, { recursive: true });
      const tmp = `${storeFile}.${process.pid}.tmp`;
      await writeFile(tmp, json, { mode: 0o600 });
      await rename(tmp, storeFile);
    })
    .catch((err) => console.error("[accounts] could not save", err));
  return writing;
}

export function toPublic(user: UserRecord): PublicUser {
  const { googleSub: _sub, ...rest } = user;
  return rest;
}

// ---------- Sessions ----------

const COOKIE = "hf_session";
const MAX_AGE_S = 365 * 24 * 3600;

async function loadSecret(): Promise<Buffer> {
  if (process.env.SESSION_SECRET) return Buffer.from(process.env.SESSION_SECRET);
  if (existsSync(secretFile)) return readFileSync(secretFile);
  const secret = randomBytes(32);
  await mkdir(dataDir, { recursive: true });
  await writeFile(secretFile, secret, { mode: 0o600 });
  await chmod(secretFile, 0o600);
  return secret;
}
const secret = await loadSecret();

const sign = (id: string) => createHmac("sha256", secret).update(`v1.${id}`).digest("base64url");

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** The signed-in (or guest) player for this request, if their cookie is valid. */
export function sessionUser(req: Request): UserRecord | null {
  const raw = readCookie(req, COOKIE);
  const m = raw?.match(/^v1\.([\w-]+)\.([\w-]+)$/);
  if (!m) return null;
  const [, id, sig] = m;
  const expected = Buffer.from(sign(id));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return store.users[id] ?? null;
}

function cookieAttrs(req: Request, maxAge: number) {
  const secure = req.secure ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function setSession(req: Request, res: Response, user: UserRecord): void {
  res.setHeader("Set-Cookie", `${COOKIE}=v1.${user.id}.${sign(user.id)}; ${cookieAttrs(req, MAX_AGE_S)}`);
}

export function clearSession(req: Request, res: Response): void {
  res.setHeader("Set-Cookie", `${COOKIE}=; ${cookieAttrs(req, 0)}`);
}

// ---------- Profiles ----------

function newGuest(): UserRecord {
  const id = randomUUID();
  return {
    id,
    kind: "guest",
    name: `Folder-${String(parseInt(id.slice(0, 6), 16) % 10000).padStart(4, "0")}`,
    createdAt: Date.now(),
    progress: emptyProgress(),
  };
}

export const CompletionSchema = z.object({
  planId: z.string().min(1).max(120),
  title: z.string().min(1).max(120),
  origin: z.enum(["library", "scan", "generated"]),
  difficulty: z.enum(["easy", "medium", "hard"]),
  steps: z.number().int().min(1).max(200),
  verifiedSteps: z.number().int().min(0).max(200),
  durationMs: z.number().min(0).max(30 * 24 * 3600 * 1000),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * Records a finished fold for the current player. A counted fold from someone without a
 * profile creates a guest profile for this browser.
 */
export async function recordCompletion(
  req: Request,
  res: Response,
  input: CompletionInput,
): Promise<{ user: PublicUser | null; reward: Reward }> {
  const existing = sessionUser(req);
  const user = existing ?? newGuest();
  const { progress, reward } = applyCompletion(user.progress, input);
  if (!reward.counted) return { user: existing && toPublic(existing), reward };
  user.progress = progress;
  if (!existing) {
    store.users[user.id] = user;
    setSession(req, res, user);
  }
  await persist();
  return { user: toPublic(user), reward };
}

export async function renameUser(user: UserRecord, name: string): Promise<PublicUser> {
  user.name = name;
  await persist();
  return toPublic(user);
}

const GoogleTokenSchema = z.object({ credential: z.string().min(20).max(8000) });

/**
 * Verifies a Google ID token from Sign in with Google and signs the player in.
 * A guest profile in the same browser is merged into the Google account.
 */
export async function signInWithGoogle(req: Request, res: Response, body: unknown): Promise<PublicUser> {
  if (!googleClient || !GOOGLE_CLIENT_ID) throw Object.assign(new Error("Google sign-in isn't set up on this server."), { status: 503 });
  const { credential } = GoogleTokenSchema.parse(body);
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch {
    throw Object.assign(new Error("Google sign-in couldn't be verified. Try again."), { status: 401 });
  }
  if (!payload?.sub) throw Object.assign(new Error("Google didn't return an account."), { status: 401 });

  const current = sessionUser(req);
  const guest = current?.kind === "guest" ? current : null;
  let user = Object.values(store.users).find((u) => u.googleSub === payload.sub) ?? null;

  if (!user) {
    // First sign-in: a guest profile in this browser becomes the account.
    user = guest ?? newGuest();
  } else if (guest && guest.id !== user.id) {
    // Returning account: fold the guest's progress into it.
    if (guest.progress.history.length > 0) user.progress = replay([...user.progress.history, ...guest.progress.history]);
    delete store.users[guest.id];
  }

  // Use the Google name unless the player already picked their own.
  const autoName = /^Folder-\d{4}$/.test(user.name);
  if (user.kind !== "google" && autoName) user.name = payload.name || payload.given_name || user.name;
  user.kind = "google";
  user.googleSub = payload.sub;
  user.email = payload.email_verified ? payload.email : undefined;
  user.picture = payload.picture;
  store.users[user.id] = user;
  await persist();
  setSession(req, res, user);
  return toPublic(user);
}
