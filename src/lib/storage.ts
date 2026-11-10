import type { GuidePlan } from "../../shared/schema";

/**
 * Saved scans live on this device only.
 *
 * Plans (steps, titles) go in localStorage so the home screen can list them instantly.
 * Their page images go in IndexedDB, which has room for a 20-page PDF. localStorage
 * tops out around 5 MB, which a few photographed pages already fill. Each plan keeps a
 * small `thumb` for the list. If IndexedDB is unavailable, images stay inline as before
 * and are dropped first when the quota is hit.
 */
const KEY = "holofold.scans.v1";
const MAX_SAVED = 12;

export function loadScans(): GuidePlan[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as GuidePlan[]) : [];
  } catch {
    return [];
  }
}

function writeList(list: GuidePlan[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    try {
      localStorage.setItem(KEY, JSON.stringify(list.map((p, i) => (i === 0 ? p : { ...p, images: undefined }))));
    } catch {
      try {
        localStorage.setItem(KEY, JSON.stringify(list.map((p) => ({ ...p, images: undefined }))));
      } catch {
        /* storage unavailable */
      }
    }
  }
}

/** Saves newest first. Resolves once the plan (and, where possible, its pages) are stored. */
export async function saveScan(plan: GuidePlan): Promise<void> {
  let entry: GuidePlan = plan;
  if (plan.images?.length) {
    const thumb = await makeThumb(plan.images[0]).catch(() => undefined);
    const stored = await putImages(plan.id, plan.images).then(
      () => true,
      () => false,
    );
    entry = stored ? { ...plan, images: undefined, thumb } : { ...plan, thumb };
  }
  const list = [entry, ...loadScans().filter((p) => p.id !== plan.id)];
  for (const dropped of list.slice(MAX_SAVED)) void deleteImages(dropped.id);
  writeList(list.slice(0, MAX_SAVED));
}

export function deleteScan(id: string): void {
  writeList(loadScans().filter((p) => p.id !== id));
  void deleteImages(id);
}

/** A saved plan with its page images put back (from IndexedDB, or already inline). */
export async function withImages(plan: GuidePlan): Promise<GuidePlan> {
  if (plan.images?.length || plan.origin === "library") return plan;
  const images = await getImages(plan.id).catch(() => undefined);
  return images?.length ? { ...plan, images } : plan;
}

// ---------- IndexedDB page store ----------

const DB_NAME = "holofold";
const STORE = "scan-pages";
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB blocked"));
  }).catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const putImages = (id: string, images: string[]) => run("readwrite", (s) => s.put(images, id));
const getImages = (id: string) => run<string[] | undefined>("readonly", (s) => s.get(id));
const deleteImages = (id: string) => run("readwrite", (s) => s.delete(id)).catch(() => undefined);

/** A ~200 px JPEG of the first page for the saved-scans list. */
async function makeThumb(src: string, edge = 200): Promise<string> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const s = Math.min(1, edge / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.naturalWidth * s));
  c.height = Math.max(1, Math.round(img.naturalHeight * s));
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.7);
}
