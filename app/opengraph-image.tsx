import { ImageResponse } from "next/og";

export const alt = "Transformer Talent — Recruiting at Machine Speed";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          justifyContent: "center",
          padding: 80,
          background: "#06080B",
          backgroundImage:
            "linear-gradient(rgba(155,175,190,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(155,175,190,0.07) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
          color: "#C7D3DB",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ fontSize: 26, color: "#FF5A1F", letterSpacing: 4, marginBottom: 28 }}>
          TRANSFORMER_TALENT
        </div>
        <div
          style={{
            fontSize: 76,
            fontWeight: 800,
            lineHeight: 1.02,
            textTransform: "uppercase",
            letterSpacing: -2,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <span>Recruiting at</span>
          <span>machine speed.</span>
          <span style={{ color: "#FF5A1F" }}>Closed by a human.</span>
        </div>
        <div style={{ fontSize: 24, color: "rgba(199,211,219,0.6)", marginTop: 36 }}>
          419,595 profiles indexed · placements at Sequoia, 8VC &amp; Felicis-backed startups
        </div>
      </div>
    ),
    { ...size }
  );
}
