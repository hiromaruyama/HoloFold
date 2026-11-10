/**
 * Canvas colors for each theme. CSS handles the page; these drive the AR overlay drawn
 * over the camera. Valley and mountain lines always differ in both color and dash
 * pattern, so they stay distinguishable for color-blind folders too.
 */
import type { Theme } from "./prefs";

export interface ArPalette {
  valley: string;
  mountain: string;
  existing: string;
  unknown: string;
  /** Paper outline. */
  outline: string;
  /** Light stroke under lines, so they read on any paper color (light themes). */
  halo: string | null;
  fill0: string;
  fill1: string;
  grid: string | null;
  scanBeam: boolean;
  brackets: string | null;
  chrome: string | null;
  flapFront: string;
  flapFrontStroke: string;
  flapBack: string;
  flapBackStroke: string;
  landing: string;
  accent: string;
  ok: string;
  bad: string;
  /** Multiplier for glow blur; 0 for flat themes. */
  glow: number;
  sparks: boolean;
  tagBg: string;
  tagText: string | null;
  font: string;
  hintColor: string;
  /** Multiplier for line widths. */
  lineScale: number;
}

const HOLO: ArPalette = {
  valley: "#38f9ff",
  mountain: "#ff4fd8",
  existing: "rgba(150, 200, 255, 0.6)",
  unknown: "#ffc04d",
  outline: "#38f9ff",
  halo: null,
  fill0: "rgba(56, 249, 255, 0.14)",
  fill1: "rgba(56, 249, 255, 0.03)",
  grid: "rgba(56, 249, 255, 0.12)",
  scanBeam: true,
  brackets: "#e9feff",
  chrome: "rgba(56, 249, 255, 0.5)",
  flapFront: "rgba(56, 249, 255, 0.24)",
  flapFrontStroke: "#38f9ff",
  flapBack: "rgba(200, 170, 255, 0.36)",
  flapBackStroke: "#c4a8ff",
  landing: "rgba(255,255,255,0.35)",
  accent: "#ffc04d",
  ok: "#5dffb0",
  bad: "#ff5470",
  glow: 1,
  sparks: true,
  tagBg: "rgba(3, 10, 18, 0.82)",
  tagText: null,
  font: "Orbitron, 'Noto Sans JP', sans-serif",
  hintColor: "rgba(200, 250, 255, 0.7)",
  lineScale: 1,
};

const PAPER: ArPalette = {
  valley: "#2f7fd6",
  mountain: "#e8613c",
  existing: "rgba(120, 90, 60, 0.6)",
  unknown: "#f2a93b",
  outline: "#f2a93b",
  halo: "rgba(255, 255, 255, 0.92)",
  fill0: "rgba(255, 236, 190, 0.22)",
  fill1: "rgba(255, 236, 190, 0.08)",
  grid: null,
  scanBeam: false,
  brackets: null,
  chrome: null,
  flapFront: "rgba(255, 214, 102, 0.5)",
  flapFrontStroke: "#f2a93b",
  flapBack: "rgba(255, 150, 180, 0.5)",
  flapBackStroke: "#e0608a",
  landing: "rgba(255,255,255,0.8)",
  accent: "#8a5cd6",
  ok: "#3fae5a",
  bad: "#e8613c",
  glow: 0,
  sparks: false,
  tagBg: "rgba(255, 250, 240, 0.96)",
  tagText: "#4a2c1a",
  font: "'Baloo 2', 'M PLUS Rounded 1c', sans-serif",
  hintColor: "rgba(255, 255, 255, 0.95)",
  lineScale: 1.6,
};

const WASHI: ArPalette = {
  valley: "#2b4c8c",
  mountain: "#c0392b",
  existing: "rgba(31, 42, 68, 0.5)",
  unknown: "#b07d2b",
  outline: "#1f2a44",
  halo: "rgba(250, 246, 236, 0.9)",
  fill0: "rgba(250, 246, 236, 0.16)",
  fill1: "rgba(250, 246, 236, 0.05)",
  grid: null,
  scanBeam: false,
  brackets: null,
  chrome: null,
  flapFront: "rgba(43, 76, 140, 0.28)",
  flapFrontStroke: "#2b4c8c",
  flapBack: "rgba(192, 57, 43, 0.26)",
  flapBackStroke: "#c0392b",
  landing: "rgba(250,246,236,0.8)",
  accent: "#b07d2b",
  ok: "#3d7a4f",
  bad: "#c0392b",
  glow: 0,
  sparks: false,
  tagBg: "rgba(250, 246, 236, 0.96)",
  tagText: "#1f2a44",
  font: "'Shippori Mincho', serif",
  hintColor: "rgba(255, 255, 255, 0.95)",
  lineScale: 1.25,
};

export function arPalette(theme: Theme, contrast: boolean): ArPalette {
  const base = theme === "paper" ? PAPER : theme === "washi" ? WASHI : HOLO;
  if (!contrast) return base;
  return { ...base, lineScale: base.lineScale * 1.5, halo: base.halo ?? "rgba(0, 0, 0, 0.75)", grid: null, scanBeam: false, sparks: false };
}
