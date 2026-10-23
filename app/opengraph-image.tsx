import { ImageResponse } from "next/og";
import { HERO, NAV, STAGES } from "@/lib/home/copy";

// Open Graph poster for the inference-layer homepage: the headline, the sub
// and a single-lane request timeline with the seven stage labels, drawn with
// positioned divs (Satori: flex and absolute positioning only, no CSS
// variables, no pseudo-elements). No numbers; nothing is measured yet.

export const alt = "Transformer Talent, the inference layer for hiring";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BLACK = "#040804";
const TEXT = "#e3e5e1";
const MUTED = "#a8aba6";
const DIM = "#7d807c";
const MARK = "#4b4d4a";
const GREEN = "#7fee64";
const LIGHT = "#9efb87";
const DEEP = "#124f11";
const HAIR = "rgba(255,255,255,0.14)";

const LANE_W = 1040;
const AXIS = 96;

type Box = { left: number; top: number; width: number; height: number; color: string; radius?: number };

function box({ left, top, width, height, color, radius = 2 }: Box) {
  return <div style={{ position: "absolute", left, top, width, height, background: color, borderRadius: radius }} />;
}

export default function OpengraphImage() {
  const labels = STAGES.map((s) => s.name);
  const labelLeft = [0, 236, 322, 410, 590, 760];
  const decodeH = [10, 16, 12, 18, 8, 14];
  const mono = { fontSize: 15, letterSpacing: 1, color: MUTED } as const;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px 64px",
          background: BLACK,
          color: TEXT,
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", fontSize: 20, color: MUTED, marginBottom: 36 }}>
            <div style={{ width: 16, height: 16, borderRadius: 4, background: GREEN, marginRight: 12 }} />
            {NAV.brand}
          </div>
          <div style={{ display: "flex", flexDirection: "column", fontSize: 72, fontWeight: 500, lineHeight: 1.08, letterSpacing: -1 }}>
            <div style={{ display: "flex" }}>
              <span>{HERO.headlineBefore.trim()}&nbsp;</span>
              <span style={{ color: GREEN }}>{HERO.headlineAccent}</span>
            </div>
            <div style={{ display: "flex" }}>{HERO.headlineAfter.trim()}</div>
          </div>
          <div style={{ fontSize: 26, color: MUTED, marginTop: 24 }}>{HERO.sub}</div>
        </div>

        <div style={{ position: "relative", width: LANE_W, height: 170, display: "flex" }}>
          {labels.slice(0, -1).map((name, i) => (
            <div key={name} style={{ position: "absolute", left: labelLeft[i], top: 0, ...mono }}>{name}</div>
          ))}
          <div style={{ position: "absolute", right: 0, top: 0, ...mono }}>{labels[labels.length - 1]}</div>

          {/* cold start: the market resident before the request */}
          {box({ left: 0, top: 40, width: 150, height: 110, color: "rgba(255,255,255,0.04)" })}
          {[20, 52, 78, 104, 128].map((x, i) => box({ left: x, top: [80, 110, 70, 120, 92][i], width: 4, height: 4, color: MARK, radius: 2 }))}

          {/* axis */}
          {box({ left: 0, top: AXIS, width: LANE_W, height: 1, color: HAIR, radius: 0 })}

          {/* kv cache under the axis, with two appended review cells */}
          {box({ left: 156, top: AXIS + 8, width: LANE_W - 156, height: 12, color: DEEP })}
          {box({ left: 800, top: AXIS + 8, width: 14, height: 12, color: GREEN })}
          {box({ left: 870, top: AXIS + 8, width: 14, height: 12, color: GREEN })}

          {/* request lands, prefill block */}
          {box({ left: 144, top: AXIS - 6, width: 12, height: 12, color: GREEN, radius: 6 })}
          {box({ left: 156, top: AXIS - 12, width: 100, height: 24, color: GREEN })}

          {/* decode ticks above the axis */}
          {Array.from({ length: 16 }, (_, i) => {
            const h = decodeH[i % decodeH.length];
            return box({ left: 410 + i * 10, top: AXIS - 6 - h, width: 2, height: h, color: GREEN, radius: 0 });
          })}

          {/* sampling: the cut, marks above, dimmer marks held back below */}
          {box({ left: 590, top: AXIS - 36, width: 140, height: 1, color: HAIR, radius: 0 })}
          {[602, 628, 654, 680, 706].map((x, i) => box({ left: x, top: AXIS - 52 - (i % 3) * 4, width: 6, height: 6, color: GREEN, radius: 3 }))}
          {[596, 614, 632, 650].map((x, i) => box({ left: x, top: AXIS - 20 - (i % 2) * 8, width: 5, height: 5, color: MARK, radius: 3 }))}

          {/* stream: larger ticks, the first is the first profile */}
          {[760, 830, 900, 970].map((x, i) => box({ left: x, top: AXIS - 40, width: 3, height: 60, color: i === 0 ? LIGHT : GREEN, radius: 0 }))}

          {/* stop token */}
          {box({ left: 1020, top: AXIS - 9, width: 18, height: 18, color: LIGHT, radius: 9 })}

          <div style={{ position: "absolute", left: 0, top: 148, fontSize: 15, letterSpacing: 1, color: DIM }}>{HERO.footnote}</div>
        </div>
      </div>
    ),
    { ...size }
  );
}
