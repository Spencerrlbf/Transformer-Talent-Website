import { ImageResponse } from "next/og";
import { loadRecruiterPage } from "@/lib/server/recruiter-page";

// The link-preview card for recruiter pages. These URLs live in LinkedIn
// DMs, so the unfurled card IS the first impression: face, name, live role
// count, and the page URL, in the board's light look.

export const revalidate = 300;
export const alt = "Recruiter page";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OgImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await loadRecruiterPage(slug);

  if (!page) {
    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#ffffff",
            color: "#111418",
            fontSize: 56,
            fontWeight: 700,
          }}
        >
          Transformer Talent
        </div>
      ),
      size
    );
  }

  const initials = page.profile.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
  const roleCount = page.roles.length;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "#ffffff",
          padding: "72px 80px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 48, flex: 1 }}>
          {page.profile.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`${page.profile.photoUrl}?og`}
              alt=""
              width={220}
              height={220}
              style={{ borderRadius: 220, objectFit: "cover", border: "1px solid #e6e8ec" }}
            />
          ) : (
            <div
              style={{
                width: 220,
                height: 220,
                borderRadius: 220,
                background: "#eef2fb",
                color: "#2a5bd7",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 84,
                fontWeight: 700,
              }}
            >
              {initials}
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 64, fontWeight: 700, color: "#111418", letterSpacing: -1 }}>
              {page.profile.name}
            </div>
            <div style={{ fontSize: 30, color: "#6b7280", marginTop: 10, display: "flex" }}>
              Recruiter · {page.org.name}
            </div>
            <div style={{ display: "flex", marginTop: 30 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  background: "#ecfdf3",
                  border: "2px solid #a6f4c5",
                  color: "#067647",
                  borderRadius: 999,
                  padding: "12px 28px",
                  fontSize: 28,
                  fontWeight: 700,
                }}
              >
                {roleCount} OPEN ROLE{roleCount === 1 ? "" : "S"} · APPLY OR BOOK A CALL
              </div>
            </div>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderTop: "2px solid #e6e8ec",
            paddingTop: 28,
          }}
        >
          <div style={{ fontSize: 26, color: "#111418", fontWeight: 700, display: "flex" }}>
            Transformer Talent
          </div>
          <div style={{ fontSize: 26, color: "#6b7280", display: "flex" }}>
            transformertalent.com/r/{slug}
          </div>
        </div>
      </div>
    ),
    size
  );
}
