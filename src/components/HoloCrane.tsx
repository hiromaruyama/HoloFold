import { usePrefs } from "../lib/prefs";

/** Hero art: a low-poly crane over a projector (Hologram), a craft mat (Paper Craft) or a wooden stand (Washi). */
export const CRANE_FACETS: { pts: string; tone: number }[] = [
  { pts: "118,118 70,28 106,112", tone: 0.18 }, // back wing
  { pts: "100,124 38,50 96,114", tone: 0.32 }, // neck
  { pts: "38,50 24,70 46,58", tone: 0.5 }, // head
  { pts: "146,124 214,60 152,114", tone: 0.3 }, // tail
  { pts: "92,120 152,120 124,144", tone: 0.42 }, // body
  { pts: "120,120 178,22 138,116", tone: 0.26 }, // front wing
  { pts: "120,120 152,72 138,116", tone: 0.5 }, // front wing inner facet
];

export function HoloCrane() {
  const { prefs } = usePrefs();
  const holo = prefs.theme === "holo";
  // Flat themes read as solid paper: shade facets by tone instead of making them see-through.
  const solid = (tone: number) => (holo ? tone : 0.75 + tone * 0.5);
  return (
    <div className="holo-crane" aria-hidden="true">
      <div className="holo-crane__beam" />
      <svg className="holo-crane__bird" viewBox="0 0 240 180">
        <defs>
          <linearGradient id="hc-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: "var(--crane-top)" }} />
            <stop offset="1" style={{ stopColor: "var(--crane-bottom)" }} />
          </linearGradient>
          <filter id="hc-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="2.2" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g filter={holo ? "url(#hc-glow)" : undefined}>
          {CRANE_FACETS.map((f, i) => (
            <polygon
              key={i}
              points={f.pts}
              fill="url(#hc-fill)"
              fillOpacity={Math.min(1, solid(f.tone))}
              style={{ stroke: "var(--crane-stroke)" }}
              strokeWidth={holo ? 1.2 : 1.6}
              strokeLinejoin="round"
            />
          ))}
          <line x1="120" y1="120" x2="178" y2="22" style={{ stroke: "var(--crane-line-a)" }} strokeWidth="1.2" strokeDasharray="5 3 1 3" />
          <line x1="70" y1="28" x2="118" y2="118" style={{ stroke: "var(--crane-line-b)" }} strokeWidth="1" strokeDasharray="6 4" />
        </g>
      </svg>
      <div className="holo-crane__scan" />
      <div className="holo-crane__base">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}
