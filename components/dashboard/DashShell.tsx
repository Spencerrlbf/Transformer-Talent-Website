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
type DashContext = { token: string; org: Org; email: string; role: string };

const Ctx = createContext<DashContext | null>(null);
export function useDash(): DashContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useDash outside DashShell");
  return ctx;
}

const NAV = [
  { href: "/dashboard/inbox", label: "Inbox" },
  { href: "/dashboard", label: "Jobs" },
  { href: "/dashboard/candidates", label: "Candidates" },
  { href: "/dashboard/my-page", label: "My page" },
  { href: "/dashboard/settings", label: "Settings" },
];

// Breadcrumb label for the top bar, from the deepest matching section.
const CRUMBS: [string, string][] = [
  ["/dashboard/inbox", "Inbox"],
  ["/dashboard/candidates", "Candidates"],
  ["/dashboard/tasks", "Inbox"],
  ["/dashboard/network", "Network"],
  ["/dashboard/my-page", "My page"],
  ["/dashboard/team", "Team"],
  ["/dashboard/settings", "Settings"],
  ["/dashboard/jobs/new", "New job"],
  ["/dashboard/jobs", "Jobs"],
  ["/dashboard", "Jobs"],
];

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");

export default function DashShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // undefined = still resolving; null = signed out
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [me, setMe] = useState<
    { org: Org; email: string; memberRole?: string; myPage?: MyPage } | null | undefined
  >(undefined);

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
    <Ctx.Provider
      value={{
        token: session.access_token,
        org: me.org,
        email: me.email,
        role: me.memberRole || "member",
      }}
    >
      <div className="dash-app">
        <aside className="dash-side">
          <div className="dash-orgrow">
            <span className="dash-orgtile" aria-hidden="true">{initials(me.org.name)}</span>
            <div className="dash-org">
              {me.org.name}
              <small>board/{me.org.slug}</small>
            </div>
          </div>
          <nav className="dash-nav">
            {NAV.map((item) => (
              <span key={item.href} style={{ display: "contents" }}>
                <Link href={item.href} className={pathname === item.href ? "on" : ""}>
                  {item.label}
                  {/* What's waiting on you today. */}
                  {item.href === "/dashboard/inbox" && <InboxBadge token={session.access_token} />}
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
                {/* Admin-only: team management. The API 404s recruiters even
                    if they guess the URL. */}
                {item.href === "/dashboard/my-page" && me.memberRole === "owner" && (
                  <Link
                    href="/dashboard/team"
                    className={pathname === "/dashboard/team" ? "on" : ""}
                  >
                    Team
                  </Link>
                )}
              </span>
            ))}
          </nav>
          <CreditsBlock token={session.access_token} />
          <div className="dash-side-foot">
            <div className="dash-foot-id">
              <span className="dash-foot-ava" aria-hidden="true">
                {me.email[0]?.toUpperCase()}
              </span>
              <div className="dash-foot-who">
                <span>{me.email}</span>
                <em>
                  {(me.memberRole || "member").charAt(0).toUpperCase() +
                    (me.memberRole || "member").slice(1)}
                </em>
              </div>
            </div>
            <button onClick={() => supabaseBrowser().auth.signOut()}>Sign out</button>
          </div>
        </aside>
        <div className="dash-col">
          <header className="dash-topbar">
            <span className="dash-crumb">
              {me.org.name} <span className="sep">/</span>{" "}
              <span className="cur">
                {CRUMBS.find(([p]) => pathname === p || pathname.startsWith(p + "/"))?.[1] ??
                  "Jobs"}
              </span>
            </span>
          </header>
          <main className="dash-main">{children}</main>
        </div>
      </div>
    </Ctx.Provider>
  );
}

// Sidebar sourcing-credits block (README §9.1 — approved). Balance from the
// existing credits endpoint; hidden until it resolves, and entirely for orgs
// that have never been granted credits.
// Count of what's waiting on this seat today. Polled gently; refetched on
// focus so coming back from the mail client shows the new reply at once.
function InboxBadge({ token }: { token: string }) {
  const [n, setN] = useState<number | null>(null);
  const [overdue, setOverdue] = useState(0);
  useEffect(() => {
    let gone = false;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      // Recomputed per poll: a tab left open across midnight moves on too.
      const today = new Date().toLocaleDateString("en-CA");
      fetch(`/api/dashboard/inbox?count=1&scope=me&today=${today}&_=${Date.now()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      })
        .then((r) => (r.ok ? (r.json() as Promise<{ today: number; overdue: number }>) : null))
        .then((j) => {
          if (j && !gone) {
            setN(j.today);
            setOverdue(j.overdue);
          }
        })
        .catch(() => {});
    };
    refresh();
    const id = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    // The Inbox page announces its own changes so the badge never lags it.
    window.addEventListener("tt-inbox-changed", refresh);
    return () => {
      gone = true;
      window.clearInterval(id);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("tt-inbox-changed", refresh);
    };
  }, [token]);
  if (n === null || n === 0) return null;
  return (
    <span className={`dash-nav-badge${overdue ? " bad" : ""}`} title={overdue ? `${overdue} overdue` : undefined}>
      {n}
    </span>
  );
}

function CreditsBlock({ token }: { token: string }) {
  const [sum, setSum] = useState<{ available: number; granted: number; held: number } | null>(
    null
  );
  useEffect(() => {
    let cancelled = false;
    fetch("/api/dashboard/credits", { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.summary) setSum(data.summary);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token]);
  if (!sum || sum.granted <= 0) return null;
  const pct = Math.max(0, Math.min(100, (sum.available / sum.granted) * 100));
  return (
    <div className="dash-credits">
      <div className="lbl">Sourcing credits</div>
      <div className="val">{sum.available.toLocaleString()}</div>
      <div className="bar" aria-hidden="true">
        <i style={{ width: `${pct}%` }} />
      </div>
      <p className="note">
        {sum.held > 0
          ? `${sum.held.toLocaleString()} reserved by runs in progress`
          : "1 credit = 1 candidate imported and reviewed"}
      </p>
    </div>
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
          <>
            <div className="dash-sent">
              <p>
                Check your email — we sent a sign-in link to <b>{email}</b>. The
                link works once and expires in an hour.
              </p>
            </div>
            <p className="dash-authnote">
              Wrong address?{" "}
              <button type="button" className="dash-authagain" onClick={() => setState("idle")}>
                Start again
              </button>
            </p>
          </>
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
            <p className="dash-authnote">
              Access is granted by your admin. Invited by email? Use that address.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
