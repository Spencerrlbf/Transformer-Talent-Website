import { ImageResponse } from "next/og";

export const alt =
  "Transformer Talent — AI/ML & Software Engineering Recruitment";
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
          alignItems: "center",
          justifyContent: "center",
          background:
            "radial-gradient(ellipse at 50% 30%, #0d0d0d 0%, #050505 70%)",
          color: "#FAF9F6",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            fontSize: 84,
            fontWeight: 800,
            letterSpacing: "-0.04em",
            textTransform: "uppercase",
          }}
        >
          Transformer Talent
        </div>
        <div
          style={{
            fontSize: 32,
            fontStyle: "italic",
            color: "#D4A853",
            marginTop: 16,
          }}
        >
          Talent is all you need
        </div>
        <div
          style={{
            fontSize: 24,
            color: "rgba(250, 249, 246, 0.6)",
            marginTop: 48,
          }}
        >
          AI/ML &amp; software engineers for top VC-backed startups
        </div>
        <div
          style={{
            fontSize: 18,
            color: "rgba(250, 249, 246, 0.35)",
            marginTop: 24,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
          }}
        >
          Y Combinator · Sequoia · a16z · General Catalyst · 8VC
        </div>
      </div>
    ),
    { ...size }
  );
}
