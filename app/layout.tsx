import type { Metadata } from "next";
import { Instrument_Sans, Instrument_Serif } from "next/font/google";
import { Analytics } from "@vercel/analytics/react";
import "./globals.css";
import { jsonForScript } from "@/lib/server/html";

const sans = Instrument_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
});

const serif = Instrument_Serif({
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
  variable: "--font-serif",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://transformertalent.com"),
  title: {
    default: "Transformer Talent | AI/ML & Software Engineering Search",
    template: "%s | Transformer Talent",
  },
  description:
    "We place AI/ML and software engineers with startups backed by Sequoia, 8VC, and Felicis. Upload your JD and see potential matches in seconds.",
  ...(process.env.GOOGLE_SITE_VERIFICATION
    ? { verification: { google: process.env.GOOGLE_SITE_VERIFICATION } }
    : {}),
};

const ORG_LD = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Transformer Talent",
  url: "https://transformertalent.com",
  email: "spencer@transformertalent.com",
  description:
    "AI/ML and software engineering search firm placing engineers with VC-backed startups.",
  areaServed: "US",
  slogan: "Talent is all you need",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable}`}>
      <body>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonForScript(ORG_LD) }}
        />
        {children}
        <Analytics />
      </body>
    </html>
  );
}
