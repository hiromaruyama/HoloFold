import type { ParseRequest, Plan, VerifyRequest, VerifyResult } from "../../shared/schema";

export interface Health {
  ai: boolean;
  model: string;
}

export async function getHealth(): Promise<Health> {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) throw new Error();
    return (await res.json()) as Health;
  } catch {
    return { ai: false, model: "offline" };
  }
}

export interface ParseHandlers {
  onThinking?: (text: string) => void;
  onProgress?: (steps: number) => void;
}

/** POST /api/parse and read its Server-Sent Events until the plan arrives. */
export async function parseInstructions(req: ParseRequest, handlers: ParseHandlers, signal?: AbortSignal): Promise<Plan> {
  const res = await fetch("/api/parse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = "message";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (!data) continue;
      const payload = JSON.parse(data);
      if (event === "thinking") handlers.onThinking?.(payload.text);
      else if (event === "progress") handlers.onProgress?.(payload.steps);
      else if (event === "error") throw new Error(payload.error);
      else if (event === "done") return payload.plan as Plan;
    }
  }
  throw new Error("The connection closed before the steps arrived.");
}

export async function verifyStep(req: VerifyRequest): Promise<VerifyResult> {
  const res = await fetch("/api/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Check failed (${res.status})`);
  return body as VerifyResult;
}
