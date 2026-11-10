/** Text-to-speech for instructions and simple hands-free voice commands, in English or Japanese. */
import type { Language } from "../../shared/schema";

export interface SpeakOptions {
  lang?: Language;
  /** Slower, clearer speech (Easy view). */
  slow?: boolean;
}

export function speak(text: string, { lang = "en", slow = false }: SpeakOptions = {}) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const voices = window.speechSynthesis.getVoices();
  const voice =
    lang === "ja"
      ? (voices.find((v) => /Kyoko|O-ren|Google 日本語|Nanami/i.test(v.name)) ?? voices.find((v) => v.lang.toLowerCase().startsWith("ja")))
      : (voices.find((v) => /Samantha|Google US English|Aria|Jenny/i.test(v.name)) ?? voices.find((v) => v.lang.startsWith("en")));
  if (voice) u.voice = voice;
  u.lang = lang === "ja" ? "ja-JP" : "en-US";
  u.rate = slow ? 0.85 : 1.02;
  u.pitch = 1.05;
  window.speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

export type VoiceCommand = "next" | "back" | "repeat" | "check";

interface RecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}

export function voiceSupported(): boolean {
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

const COMMANDS: Record<Language, [VoiceCommand, RegExp][]> = {
  en: [
    ["next", /\b(next|forward|done|continue)\b/],
    ["back", /\b(back|previous|undo)\b/],
    ["repeat", /\b(repeat|again|what)\b/],
    ["check", /\b(check|verify|look)\b/],
  ],
  ja: [
    ["next", /(次|つぎ|進む|すすむ|できた|ネクスト)/],
    ["back", /(戻る|もどる|前|まえ|バック)/],
    ["repeat", /(もう一度|もういちど|もう1度|繰り返|くりかえ|なんて)/],
    ["check", /(チェック|確認|かくにん|見て|みて)/],
  ],
};

export interface ListenMessages {
  unsupported: string;
  micBlocked: string;
}

/** Listens continuously for next / back / repeat / check. Returns a stop function. */
export function listenForCommands(
  onCommand: (c: VoiceCommand) => void,
  onError: (msg: string) => void,
  lang: Language,
  messages: ListenMessages,
): () => void {
  const w = window as unknown as Record<string, new () => RecognitionLike>;
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) {
    onError(messages.unsupported);
    return () => {};
  }
  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = false;
  rec.lang = lang === "ja" ? "ja-JP" : "en-US";
  let active = true;
  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const said = e.results[i][0].transcript.toLowerCase();
      const hit = COMMANDS[lang].find(([, re]) => re.test(said));
      if (hit) onCommand(hit[0]);
    }
  };
  rec.onerror = (e) => {
    if (e.error === "not-allowed") {
      active = false;
      onError(messages.micBlocked);
    }
  };
  rec.onend = () => {
    if (active) {
      try {
        rec.start();
      } catch {
        /* already started */
      }
    }
  };
  rec.start();
  return () => {
    active = false;
    rec.stop();
  };
}
