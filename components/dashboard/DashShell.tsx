"use client";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { supabaseBrowser } from "./supabaseBrowser";

type Org = { id: string; slug: string; name: string };
type MyPage = { published: boolean; slug: string } | null;
type DashContext = { token: string; org: Org; email: string };

const Ctx = createContext<DashContext | null>(null);
export function useDash(): DashContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useDash outside DashShell");
  return ctx;
}

const NAV = [
  { href: "/dashboard", label: "Jobs" },
  { href: "/dashboard/candidates", label: "Candidates" },
  { href: "/dashboard/my-page", label: "My page" },
  { href: "/dashboard/settings", label: "Settings" },
];

export default function DashShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // undefined = still resolving; null = signed out
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [me, setMe] = useState<{ org: Org; email: string; myPage?: MyPage } | null | undefined>(undefined);

  useEffect(() => {
    const supabase = supabaseBrowser();
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setMe(session === null ? null : undefined);
      return;
    }
    let cancelled = false;
    fetch("/api/dashboard/me", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setMe(data && data.org ? data : null);
      })
      .catch(() => {
        if (!cancelled) setMe(null);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  if (session === undefined || (session && me === undefined)) {
    return (
      <div className="dash-app dash-center">
        <span className="dash-muted">Loading…</span>
      </div>
    );
  }

  if (!session) return <LoginScreen />;

  if (!me) {
    return (
      <div className="dash-app dash-center">
        <div className="dash-card">
          <h1>No dashboard access</h1>
          <p className="dash-muted">
            {session.user.email} isn&apos;t linked to a company yet. If you were
            expecting access, contact{" "}
            <a href="mailto:spencer@transformertalent.com">spencer@transformertalent.com</a>.
          </p>
          <button
            className="dash-btn"
            onClick={() => supabaseBrowser().auth.signOut()}
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  return (
    <Ctx.Provider value={{ token: session.access_token, org: me.org, email: me.email }}>
      <div className="dash-app">
        <aside className="dash-side">
          <div className="dash-org">
            {me.org.name}
            <small>{me.org.slug} · board/{me.org.slug}</small>
          </div>
          <nav className="dash-nav">
            {NAV.map((item) => (
              <span key={item.href} style={{ display: "contents" }}>
                <Link href={item.href} className={pathname === item.href ? "on" : ""}>
                  {item.label}
                  {/* Nudge until the user publishes their recruiter page. */}
                  {item.href === "/dashboard/my-page" && !me.myPage?.published && (
                    <span className="dash-nav-nudge">set up</span>
                  )}
                </Link>
                {/* Internal-only, right after Candidates: the pool's nightly
                    matches. TT org only — the API 404s everyone else even if
                    they guess the URL. */}
                {item.href === "/dashboard/candidates" && me.org.slug === "transformer-talent" && (
                  <Link
                    href="/dashboard/network"
                    className={pathname === "/dashboard/network" ? "on" : ""}
                  >
                    Network <span className="nw-navlock">TT</span>
                  </Link>
                )}
              </span>
            ))}
          </nav>
          <div className="dash-side-foot">
            <span>{me.email}</span>
            <button onClick={() => supabaseBrowser().auth.signOut()}>Sign out</button>
            <em>Powered by Transformer Talent</em>
          </div>
        </aside>
        <main className="dash-main">{children}</main>
      </div>
    </Ctx.Provider>
  );
}

function LoginScreen() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    if (!email.includes("@")) return;
    setState("sending");
    const { error } = await supabaseBrowser().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/dashboard` },
    });
    setState(error ? "error" : "sent");
  }

  return (
    <div className="dash-app dash-center">
      <div className="dash-card">
        <h1>Company dashboard</h1>
        {state === "sent" ? (
          <p className="dash-muted">
            Check your email — we sent a sign-in link to <b>{email}</b>. The
            link works once and expires in an hour.
          </p>
        ) : (
          <>
            <p className="dash-muted">
              Enter your work email and we&apos;ll send you a one-time sign-in
              link. No password needed.
            </p>
            <form onSubmit={sendLink} className="dash-login-form">
              <input
                type="email"
                required
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <button className="dash-btn" disabled={state === "sending"}>
                {state === "sending" ? "Sending…" : "Send sign-in link"}
              </button>
            </form>
            {state === "error" && (
              <p className="dash-error">
                Couldn&apos;t send the link — wait a minute and try again.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
