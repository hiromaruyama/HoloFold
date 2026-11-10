import type { CompletionInput, Progress, Reward } from "../../shared/progress";

export interface User {
  id: string;
  kind: "guest" | "google";
  email?: string;
  name: string;
  picture?: string;
  createdAt: number;
  progress: Progress;
}

export interface Account {
  user: User | null;
  /** Set when the server has Google sign-in configured. */
  googleClientId: string | null;
}

async function call<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.json !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
    credentials: "same-origin",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

export async function getAccount(): Promise<Account> {
  try {
    return await call<Account>("/api/me");
  } catch {
    return { user: null, googleClientId: null };
  }
}

export const signInWithGoogle = (credential: string) =>
  call<{ user: User }>("/api/auth/google", { method: "POST", json: { credential } }).then((r) => r.user);

export const signOut = () => call<{ user: null }>("/api/auth/logout", { method: "POST", json: {} });

export const renameUser = (name: string) => call<{ user: User }>("/api/me", { method: "PATCH", json: { name } }).then((r) => r.user);

export const recordCompletion = (input: CompletionInput) =>
  call<{ user: User | null; reward: Reward }>("/api/progress", { method: "POST", json: input });

/** Today's date on the player's own clock, YYYY-MM-DD. */
export function localDay(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Google only accepts sign-in from localhost or a real domain name, so a phone opening
 * the dev server by its LAN IP (https://192.168.x.x:5173) can't use it.
 */
export function googleAllowedHere(): boolean {
  const h = location.hostname;
  if (h === "localhost" || h === "127.0.0.1" || h === "[::1]") return true;
  return !/^\d{1,3}(\.\d{1,3}){3}$/.test(h) && !h.includes(":");
}

// ---------- Google Identity Services ----------

interface GoogleId {
  initialize(config: { client_id: string; callback: (r: { credential: string }) => void; ux_mode?: "popup" | "redirect"; auto_select?: boolean }): void;
  renderButton(el: HTMLElement, options: Record<string, unknown>): void;
  disableAutoSelect(): void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleId } };
  }
}

let gsi: Promise<GoogleId> | null = null;

/** Loads Google's sign-in script once. */
export function loadGoogle(): Promise<GoogleId> {
  gsi ??= new Promise<GoogleId>((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve(window.google.accounts.id);
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => (window.google?.accounts?.id ? resolve(window.google.accounts.id) : reject(new Error("Google sign-in failed to load.")));
    s.onerror = () => {
      gsi = null;
      reject(new Error("Couldn't reach Google. Check your connection."));
    };
    document.head.appendChild(s);
  });
  return gsi;
}
