"use client";
// Team (admins only): every member with their page and account status, an
// invite box with the seat picture, role changes, removal, and a per-member
// stats drawer (the same numbers My page shows, per person).
import { useCallback, useEffect, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";

type StatPair = { week: number; all: number };
type Stats = {
  events: Partial<
    Record<
      "view" | "role_open" | "booking_click" | "email_copy" | "linkedin_click" | "referral_open",
      StatPair
    >
  >;
  applications: StatPair;
  resumeDrops: StatPair;
  referrals: StatPair;
  roles: { roleId: string; title: string; opens: number; applies: number }[];
};

type Member = {
  userId: string;
  email: string;
  role: "admin" | "recruiter";
  invitedAt: string | null;
  joinedAt: string;
  status: "active" | "pending";
  isSelf: boolean;
  page: { slug: string; displayName: string; published: boolean; photoUrl: string | null } | null;
  stats: Stats | null;
};

type TeamData = { seatLimit: number | null; seatsUsed: number; members: Member[] };

const ERRORS: Record<string, string> = {
  bad_email: "That doesn't look like an email address.",
  already_member: "That person is already a member.",
  no_seats: "All seats are in use. Remove a member first, or contact us for more seats.",
  last_admin: "An organization needs at least one admin.",
  cannot_change_self: "You can't change your own role.",
  cannot_remove_self: "You can't remove yourself.",
  email_failed: "The invitation couldn't be emailed — please try again.",
  default: "Something went wrong — please try again.",
};

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("") || "?";

const ago = (iso: string | null): string => {
  if (!iso) return "";
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (d < 1) return "today";
  if (d === 1) return "yesterday";
  return `${d} days ago`;
};

export default function TeamPage() {
  const { token, role } = useDash();
  const [data, setData] = useState<TeamData | null>(null);
  const [denied, setDenied] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState("");
  const [open, setOpen] = useState<Member | null>(null);

  const load = useCallback(() => {
    fetch("/api/dashboard/team", { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        if (r.status === 404) {
          setDenied(true);
          return null;
        }
        return r.ok ? ((await r.json()) as TeamData) : null;
      })
      .then((d) => {
        if (d) setData(d);
      })
      .catch(() => {});
  }, [token]);

  useEffect(load, [load]);

  async function act(
    label: string,
    fn: () => Promise<Response>,
    doneNote: string
  ): Promise<void> {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      const res = await fn();
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        setNotice(doneNote);
        load();
      } else {
        setError(ERRORS[json.error as string] || ERRORS.default);
      }
    } catch {
      setError(ERRORS.default);
    }
    setBusy("");
  }

  const invite = () =>
    act(
      "invite",
      () =>
        fetch("/api/dashboard/team/invite", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ email: inviteEmail }),
        }),
      `Invitation sent to ${inviteEmail}.`
    ).then(() => setInviteEmail(""));

  const resend = (m: Member) =>
    act(
      `resend|${m.userId}`,
      () =>
        fetch("/api/dashboard/team/resend", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ userId: m.userId }),
        }),
      `Invitation re-sent to ${m.email}.`
    );

  const setRole = (m: Member, r: "admin" | "recruiter") =>
    act(
      `role|${m.userId}`,
      () =>
        fetch("/api/dashboard/team/member", {
          method: "PATCH",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ userId: m.userId, role: r }),
        }),
      `${m.email} is now ${r === "admin" ? "an admin" : "a recruiter"}.`
    );

  const remove = (m: Member) =>
    act(
      `remove|${m.userId}`,
      () =>
        fetch(`/api/dashboard/team/member?userId=${m.userId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        }),
      `${m.email} removed. Their page is unpublished; their candidates and history stay.`
    ).then(() => setConfirmRemove(""));

  if (denied || role !== "owner") {
    return (
      <>
        <h1 className="dash-h1">Team</h1>
        <p className="dash-sub">This area is for admins only.</p>
      </>
    );
  }

  if (!data) {
    return (
      <>
        <h1 className="dash-h1">Team</h1>
        <p className="dash-sub">Loading…</p>
      </>
    );
  }

  return (
    <>
      <h1 className="dash-h1">Team</h1>
      <p className="dash-sub">
        Everyone in your organization: their pages, their performance, and who can sign in.
        Click a member to see their stats.
      </p>

      <div className="tm-toprow">
        <div className="tm-seats">
          <b>
            {data.seatsUsed}
            {data.seatLimit != null ? ` of ${data.seatLimit}` : ""}
          </b>{" "}
          seat{data.seatsUsed === 1 && data.seatLimit == null ? "" : "s"} used
          {data.seatLimit != null && (
            <span className="tm-seatbar">
              <i style={{ width: `${Math.min(100, (data.seatsUsed / data.seatLimit) * 100)}%` }} />
            </span>
          )}
        </div>
        <div className="tm-invite">
          <input
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="colleague@company.com"
            maxLength={200}
            onKeyDown={(e) => {
              if (e.key === "Enter" && inviteEmail) invite();
            }}
          />
          <button
            className="dash-btn"
            disabled={busy === "invite" || !inviteEmail}
            onClick={invite}
          >
            {busy === "invite" ? "Sending…" : "Send invitation"}
          </button>
        </div>
      </div>
      {notice && <p className="tm-notice">{notice}</p>}
      {error && <p className="dash-error">{error}</p>}

      <div className="board-scroll">
        <table className="tm-table">
          <thead>
            <tr>
              <th>Member</th>
              <th>Role</th>
              <th>Page</th>
              <th>Status</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.members.map((m) => (
              <MemberRow
                key={m.userId}
                m={m}
                busy={busy}
                confirming={confirmRemove === m.userId}
                onOpen={() => m.stats && setOpen(m)}
                onResend={() => resend(m)}
                onRole={(r) => setRole(m, r)}
                onAskRemove={() => setConfirmRemove(m.userId)}
                onCancelRemove={() => setConfirmRemove("")}
                onRemove={() => remove(m)}
              />
            ))}
          </tbody>
        </table>
      </div>
      <p className="tm-note">
        Recruiters see Jobs, Candidates, and their own My page — this area and other members&apos;
        stats are visible to admins only. Removing a member never deletes their candidates or
        history.
      </p>

      {open && <StatsDrawer m={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function MemberRow({
  m,
  busy,
  confirming,
  onOpen,
  onResend,
  onRole,
  onAskRemove,
  onCancelRemove,
  onRemove,
}: {
  m: Member;
  busy: string;
  confirming: boolean;
  onOpen: () => void;
  onResend: () => void;
  onRole: (r: "admin" | "recruiter") => void;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
}) {
  const name = m.page?.displayName || m.email;
  return (
    <>
      <tr className={m.stats ? "tm-rowbtn" : ""} onClick={onOpen}>
        <td>
          <div className="tm-who">
            {m.page?.photoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="tm-av-img" src={m.page.photoUrl} alt="" />
            ) : (
              <span className={`tm-av${m.status === "pending" ? " pending" : ""}`}>
                {initialsOf(name)}
              </span>
            )}
            <span>
              <b>{name}</b>
              <small>
                {m.page?.displayName ? m.email : m.invitedAt ? `invited ${ago(m.invitedAt)}` : ""}
              </small>
            </span>
          </div>
        </td>
        <td>
          <span className={`tm-chip ${m.role === "admin" ? "admin" : "rec"}`}>{m.role}</span>
        </td>
        <td>
          {m.page ? (
            m.page.published ? (
              <>
                <span className="tm-chip live">live</span>{" "}
                <a
                  href={`/r/${m.page.slug}`}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  /r/{m.page.slug}
                </a>
              </>
            ) : (
              <span className="tm-chip off">not published</span>
            )
          ) : (
            <small className="tm-dim">not set up yet</small>
          )}
        </td>
        <td>
          {m.status === "pending" ? (
            <span className="tm-chip pending">invite pending</span>
          ) : (
            <small className="tm-dim">Active</small>
          )}
        </td>
        <td>
          <div className="tm-acts" onClick={(e) => e.stopPropagation()}>
            {m.isSelf ? (
              <small className="tm-dim">you</small>
            ) : (
              <>
                {m.status === "pending" && (
                  <button
                    className="tm-btn"
                    disabled={busy === `resend|${m.userId}`}
                    onClick={onResend}
                  >
                    {busy === `resend|${m.userId}` ? "Sending…" : "Resend invitation"}
                  </button>
                )}
                <button
                  className="tm-btn"
                  disabled={busy === `role|${m.userId}`}
                  onClick={() => onRole(m.role === "admin" ? "recruiter" : "admin")}
                >
                  {m.role === "admin" ? "Make recruiter" : "Make admin"}
                </button>
                <button className="tm-btn danger" onClick={onAskRemove}>
                  Remove
                </button>
              </>
            )}
          </div>
        </td>
      </tr>
      {confirming && (
        <tr className="tm-confirm">
          <td colSpan={5}>
            <div className="tm-confirm-inner">
              Remove <b>{name}</b>? Their sign-in is revoked and their page is unpublished
              immediately. Their candidates, stats, and history stay with the organization.
              <button
                className="tm-btn danger"
                disabled={busy === `remove|${m.userId}`}
                onClick={onRemove}
              >
                {busy === `remove|${m.userId}` ? "Removing…" : "Yes, remove"}
              </button>
              <button className="tm-btn" onClick={onCancelRemove}>
                Cancel
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function StatsDrawer({ m, onClose }: { m: Member; onClose: () => void }) {
  const s = m.stats;
  if (!s) return null;
  const name = m.page?.displayName || m.email;
  const cards = [
    { label: "Page views", v: s.events.view },
    { label: "Applications", v: s.applications },
    { label: "Resume drops", v: s.resumeDrops },
    { label: "Referrals", v: s.referrals },
  ];
  return (
    <div
      className="tm-dwov"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="tm-dw">
        <div className="tm-dwhead">
          <div className="tm-who">
            {m.page?.photoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="tm-av-img big" src={m.page.photoUrl} alt="" />
            ) : (
              <span className="tm-av">{initialsOf(name)}</span>
            )}
            <span>
              <b className="tm-dwname">{name}</b>
              <small>{m.email}</small>
            </span>
          </div>
          <span className={`tm-chip ${m.role === "admin" ? "admin" : "rec"}`}>{m.role}</span>
          <button className="tm-dwx" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        {m.page && (
          <p className="tm-dwsub">
            {m.page.published ? (
              <>
                <span className="tm-chip live">live</span>{" "}
                <a href={`/r/${m.page.slug}`} target="_blank" rel="noreferrer">
                  transformertalent.com/r/{m.page.slug}
                </a>
              </>
            ) : (
              <span className="tm-chip off">page not published</span>
            )}
          </p>
        )}

        <div className="tm-dwcards">
          {cards.map((c) => (
            <div className="tm-dwcard" key={c.label}>
              <b>{c.v?.week ?? 0}</b>
              <span>{c.label} this week</span>
              <small>{c.v?.all ?? 0} all time</small>
            </div>
          ))}
        </div>
        <p className="tm-note" style={{ marginTop: 12 }}>
          Clicks all time: booking {s.events.booking_click?.all ?? 0} · email{" "}
          {s.events.email_copy?.all ?? 0} · LinkedIn {s.events.linkedin_click?.all ?? 0} · referral{" "}
          {s.events.referral_open?.all ?? 0}
        </p>

        {s.roles.length > 0 && (
          <table className="tm-table" style={{ marginTop: 14 }}>
            <thead>
              <tr>
                <th>Role</th>
                <th style={{ textAlign: "right" }}>Opened</th>
                <th style={{ textAlign: "right" }}>Applied</th>
              </tr>
            </thead>
            <tbody>
              {s.roles.slice(0, 8).map((r) => (
                <tr key={r.roleId}>
                  <td>
                    {r.title} <em className="tm-dim">#{r.roleId}</em>
                  </td>
                  <td style={{ textAlign: "right" }}>{r.opens}</td>
                  <td style={{ textAlign: "right" }}>{r.applies}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </aside>
    </div>
  );
}
