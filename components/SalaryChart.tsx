import { allBands } from "@/lib/market";

// Two-series categorical palette (redesign tokens, hue-distinct for CVD and
// greyscale): SF #5B4BFF, NYC #C4621B, on the light page surface.
const SF = "#5B4BFF";
const NY = "#C4621B";
const INK = "#111110";
const INK_MUTED = "rgba(17,17,16,0.45)";
const GRID = "rgba(0,0,0,0.08)";

const SHORT: Record<string, string> = {
  "Forward Deployed Engineering": "Forward Deployed",
  "ML / AI Engineering & Research": "ML / AI",
  "Infrastructure / Backend": "Infra / Backend",
  "Product / Full-Stack": "Product / Full-Stack",
};

export default function SalaryChart({ compact = false }: { compact?: boolean }) {
  const bands = allBands().filter((b) => b.city === "San Francisco" || b.city === "New York");
  const families = [...new Set(bands.map((b) => b.family))];

  const X0 = 100; // $k domain
  const X1 = 320;
  const W = 640;
  const H_LABEL = 132; // left gutter for family labels
  const plotW = W - H_LABEL - 16;
  const rowH = compact ? 16 : 20;
  const groupGap = compact ? 14 : 20;
  const topPad = 26;
  const x = (v: number) => H_LABEL + ((Math.min(Math.max(v, X0), X1) - X0) / (X1 - X0)) * plotW;
  const groups = families.map((f) => ({
    family: f,
    rows: [
      { city: "San Francisco", color: SF, b: bands.find((b) => b.family === f && b.city === "San Francisco") },
      { city: "New York", color: NY, b: bands.find((b) => b.family === f && b.city === "New York") },
    ].filter((r) => r.b),
  }));
  const height =
    topPad + groups.reduce((s, g) => s + g.rows.length * rowH, 0) + (groups.length - 1) * groupGap + 30;

  const gridVals = [100, 150, 200, 250, 300];
  let yCursor = topPad;

  return (
    <figure style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        role="img"
        aria-label="Median base salary bands by role family, San Francisco vs New York"
        style={{ width: "100%", height: "auto", display: "block" }}
      >
        {/* legend */}
        <g fontFamily="var(--font-mono), monospace" fontSize="10">
          <rect x={H_LABEL} y={4} width={10} height={10} rx={2} fill={SF} />
          <text x={H_LABEL + 15} y={13} fill={INK}>San Francisco</text>
          <rect x={H_LABEL + 110} y={4} width={10} height={10} rx={2} fill={NY} />
          <text x={H_LABEL + 125} y={13} fill={INK}>New York</text>
        </g>
        {/* grid */}
        {gridVals.map((v) => (
          <g key={v}>
            <line x1={x(v)} y1={topPad - 4} x2={x(v)} y2={height - 26} stroke={GRID} strokeWidth={1} />
            <text
              x={x(v)}
              y={height - 12}
              fill={INK_MUTED}
              fontSize="9"
              fontFamily="var(--font-mono), monospace"
              textAnchor="middle"
            >
              ${v}k
            </text>
          </g>
        ))}
        {groups.map((g) => {
          const groupY = yCursor;
          yCursor += g.rows.length * rowH + groupGap;
          return (
            <g key={g.family}>
              <text
                x={0}
                y={groupY + (g.rows.length * rowH) / 2 + 3}
                fill={INK}
                fontSize={compact ? 10 : 11}
                fontFamily="var(--font-mono), monospace"
              >
                {SHORT[g.family] || g.family}
              </text>
              {g.rows.map((r, i) => {
                const b = r.b!;
                const y = groupY + i * rowH + (rowH - 8) / 2;
                return (
                  <g key={r.city}>
                    <title>{`${g.family} — ${r.city}: median band $${b.medianMin}k–$${b.medianMax}k (from ${b.roles} searches)`}</title>
                    <rect
                      x={x(b.medianMin)}
                      y={y}
                      width={Math.max(x(b.medianMax) - x(b.medianMin), 6)}
                      height={8}
                      rx={4}
                      fill={r.color}
                    />
                    {!compact && (
                      <text
                        x={x(b.medianMax) + 6}
                        y={y + 7.5}
                        fill={INK_MUTED}
                        fontSize="9"
                        fontFamily="var(--font-mono), monospace"
                      >
                        {b.medianMin}–{b.medianMax}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      <figcaption
        style={{
          fontSize: "0.62rem",
          color: "var(--fog-30)",
          fontFamily: "var(--font-mono), monospace",
          marginTop: "0.5rem",
          letterSpacing: "0.06em",
        }}
      >
        MEDIAN AUTHORIZED BASE BANDS, $K/YEAR — FROM OUR LIVE SEARCHES, 2026
      </figcaption>
    </figure>
  );
}
