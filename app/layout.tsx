import type { Metadata } from "next";
import { Syne, Space_Mono } from "next/font/google";
import Link from "next/link";
import { Analytics } from "@vercel/analytics/react";
import "./globals.css";

const syne = Syne({
  subsets: ["latin"],
  weight: ["400", "600", "700", "800"],
  variable: "--font-display",
});

const spaceMono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  style: ["normal", "italic"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://transformertalent.com"),
  title: {
    default: "Transformer Talent — AI/ML & Software Engineering Recruitment",
    template: "%s — Transformer Talent",
  },
  description:
    "We recruit AI/ML and software engineers for the most exciting startups backed by top VCs in the USA. Y Combinator, Sequoia, a16z, General Catalyst, 8VC.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${syne.variable} ${spaceMono.variable}`}>
      <body>
        <div className="noise" />
        <nav className="nav">
          <Link href="/" className="nav-logo">
            Transformer Talent
          </Link>
          <div className="nav-links">
            <Link href="/roles">Open roles</Link>
            <Link href="/companies">For companies</Link>
            <Link href="/talent" className="nav-cta">
              Instant talent match →
            </Link>
          </div>
        </nav>
        {children}
        <footer>
          <a href="mailto:spencer@transformertalent.com">
            spencer@transformertalent.com
          </a>
        </footer>
        <Analytics />
      </body>
    </html>
  );
}
