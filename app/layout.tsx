import type { Metadata } from "next";
import { IBM_Plex_Mono, Archivo } from "next/font/google";
import Link from "next/link";
import { Analytics } from "@vercel/analytics/react";
import "./globals.css";

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-mono",
});

const archivo = Archivo({
  subsets: ["latin"],
  weight: ["500", "700", "800", "900"],
  variable: "--font-grot",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://transformertalent.com"),
  title: {
    default: "Transformer Talent — Recruiting at Machine Speed",
    template: "%s — Transformer Talent",
  },
  description:
    "AI/ML and software engineering search, powered by a 419,000-profile matching engine and closed by a human. Placements at startups backed by Sequoia, 8VC, and Felicis.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${plexMono.variable} ${archivo.variable}`}>
      <body>
        <div className="topbar-outer">
          <div className="wrap">
            <div className="topbar">
              <Link href="/" className="brand">
                Transformer<b>_</b>Talent
              </Link>
              <nav>
                <Link href="/placements">/placements</Link>
                <Link href="/process">/process</Link>
                <Link href="/market-index">/market-index</Link>
                <Link href="/roles">/roles</Link>
                <Link href="/talent" className="run">
                  RUN MATCH →
                </Link>
              </nav>
              <span className="status">SYSTEM LIVE</span>
            </div>
          </div>
        </div>
        {children}
        <footer>
          <div className="wrap">
            <span>© 2026 TRANSFORMER TALENT — “TALENT IS ALL YOU NEED”</span>
            <a href="mailto:spencer@transformertalent.com">
              spencer@transformertalent.com
            </a>
          </div>
        </footer>
        <Analytics />
      </body>
    </html>
  );
}
