import Link from "next/link";

// Marketing chrome for every route except the homepage, which lives in the
// (home) route group and draws its own nav and footer. Moved here from the
// root layout so the home route does not have to hide it with CSS.
export default function SiteLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <div className="topbar-outer">
        <div className="wrap">
          <div className="topbar">
            <Link href="/" className="brand">
              Transformer<b>_</b>Talent
            </Link>
            <nav>
              <Link href="/about">/about</Link>
              <Link href="/market-index">/market-index</Link>
              <Link href="/roles">/roles</Link>
              <Link href="/talent" className="run">
                UPLOAD JD →
              </Link>
            </nav>
            <span className="status">SYSTEM LIVE</span>
          </div>
        </div>
      </div>
      {children}
      <footer>
        <div className="wrap">
          <span>© 2026 TRANSFORMER TALENT. “TALENT IS ALL YOU NEED”</span>
          <a href="mailto:spencer@transformertalent.com">
            spencer@transformertalent.com
          </a>
        </div>
      </footer>
    </>
  );
}
