import express, { type Request, type Response } from "express";
import http from "node:http";
import https from "node:https";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_PARSE_PAGES, MAX_PARSE_TEXT, type ParseRequest, type VerifyRequest } from "../shared/schema.js";

try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: rely on the shell environment.
}

const { MODEL, describeError, hasCredentials, parseInstructions, verifyStep } = await import("./claude.js");
const accounts = await import("./accounts.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const isProd = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT ?? 5173);
const useHttps = process.env.HTTPS === "1";

const app = express();
// Hosted behind a proxy (Render, Fly, …): trust it so req.secure is true and cookies get the Secure flag.
if (isProd) app.set("trust proxy", 1);
app.use(express.json({ limit: "40mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ai: hasCredentials(), model: MODEL });
});

// ---------- Player profiles ----------

const sendError = (res: Response, err: unknown) => {
  const e = err as { status?: number; message?: string; issues?: unknown };
  const status = e.issues ? 400 : (e.status ?? 500);
  if (status >= 500) console.error("[accounts]", err);
  res.status(status).json({ error: e.issues ? "Invalid request." : (e.message ?? "Something went wrong.") });
};

app.get("/api/me", (req, res) => {
  const user = accounts.sessionUser(req);
  res.json({ user: user && accounts.toPublic(user), googleClientId: accounts.GOOGLE_CLIENT_ID });
});

app.patch("/api/me", async (req, res) => {
  const user = accounts.sessionUser(req);
  const name = typeof req.body?.name === "string" ? req.body.name.trim().replace(/\s+/g, " ") : "";
  if (!user) return void res.status(401).json({ error: "Finish a fold first to create your profile." });
  if (name.length < 2 || name.length > 24) return void res.status(400).json({ error: "Names are 2–24 characters." });
  res.json({ user: await accounts.renameUser(user, name) });
});

app.post("/api/auth/google", async (req, res) => {
  try {
    res.json({ user: await accounts.signInWithGoogle(req, res, req.body) });
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/auth/logout", (req, res) => {
  accounts.clearSession(req, res);
  res.json({ user: null });
});

app.post("/api/progress", async (req, res) => {
  try {
    const input = accounts.CompletionSchema.parse(req.body);
    res.json(await accounts.recordCompletion(req, res, input));
  } catch (err) {
    sendError(res, err);
  }
});

/** Streams Server-Sent Events: thinking deltas, step-count progress, then the plan. */
app.post("/api/parse", async (req: Request<unknown, unknown, ParseRequest>, res: Response) => {
  const body = req.body;
  if (typeof body?.text === "string") body.text = body.text.slice(0, MAX_PARSE_TEXT);
  if (!body || !Array.isArray(body.images) || (body.images.length === 0 && !body.hint?.trim() && !body.text?.trim())) {
    res.status(400).json({ error: "Upload at least one page or some written instructions, or type a model name to generate." });
    return;
  }
  if (body.images.length > MAX_PARSE_PAGES) {
    res.status(400).json({ error: `Up to ${MAX_PARSE_PAGES} pages at a time, please.` });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const keepAlive = setInterval(() => res.write(": ping\n\n"), 15000);

  try {
    const plan = await parseInstructions(body, {
      onThinking: (text) => send("thinking", { text }),
      onProgress: (steps) => send("progress", { steps }),
    });
    send("done", { plan });
  } catch (err) {
    const { message } = describeError(err);
    console.error("[parse]", err);
    send("error", { error: message });
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
});

app.post("/api/verify", async (req: Request<unknown, unknown, VerifyRequest>, res: Response) => {
  if (!req.body?.frame || !req.body.step) {
    res.status(400).json({ error: "Missing frame or step." });
    return;
  }
  try {
    res.json(await verifyStep(req.body));
  } catch (err) {
    const { status, message } = describeError(err);
    console.error("[verify]", err);
    res.status(status).json({ error: message });
  }
});

async function createServer(): Promise<http.Server | https.Server> {
  if (!useHttps) return http.createServer(app);
  const { generate } = await import("selfsigned");
  const pems = await generate([{ name: "commonName", value: "holofold.local" }], {
    notAfterDate: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    keySize: 2048,
  });
  return https.createServer({ key: pems.private, cert: pems.cert }, app);
}

const server = await createServer();

if (isProd) {
  const dist = path.join(root, "dist");
  app.use(express.static(dist));
  app.use((_req, res) => res.sendFile(path.join(dist, "index.html")));
} else {
  const { createServer: createVite } = await import("vite");
  const vite = await createVite({
    root,
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

server.listen(port, "0.0.0.0", () => {
  const scheme = useHttps ? "https" : "http";
  console.log(`\n  HoloFold running at ${scheme}://localhost:${port}`);
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) console.log(`  On your network:   ${scheme}://${a.address}:${port}`);
    }
  }
  if (!useHttps) console.log("  (Phones need HTTPS for the camera: run `npm run dev:https`.)");
  console.log(hasCredentials() ? `  Claude: ${MODEL}` : "  Claude: no API key found — built-in models still work. Add ANTHROPIC_API_KEY to .env to scan.");
  console.log(
    accounts.GOOGLE_CLIENT_ID
      ? "  Google sign-in: on (works on localhost or a real domain, not a bare IP address)\n"
      : "  Google sign-in: off — players get guest profiles. Add GOOGLE_CLIENT_ID to .env to turn it on.\n",
  );
});
