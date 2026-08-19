"use client";
import { useEffect, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";

type CreditData = {
  summary: { granted: number; spent: number; held: number; balance: number; available: number };
  history: { kind: "grant" | "spend"; credits: number; label: string; at: string }[];
};

export default function SettingsPage() {
  const { org, email, token } = useDash();
  const boardUrl = `https://www.transformertalent.com/board/${org.slug}`;
  const [credits, setCredits] = useState<CreditData | null>(null);

  useEffect(() => {
    fetch("/api/dashboard/credits", { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => (r.ok ? r.json() : null))
      .then(setCredits)
      .catch(() => {});
  }, [token]);

  return (
    <>
      <h1 className="dash-h1">Settings</h1>
      <p className="dash-sub">Your company profile, job board, and sourcing credits.</p>
      <div className="dash-settings">
        <div className="dash-setting">
          <label>Company</label>
          <div>{org.name}</div>
        </div>
        <div className="dash-setting">
          <label>Signed in as</label>
          <div>{email}</div>
        </div>
        <div className="dash-setting">
          <label>Your job board</label>
          <div>
            <a href={boardUrl} target="_blank" rel="noreferrer">
              {boardUrl}
            </a>
            <small>
              Your public board goes live in the next release — point your
              careers link here, or embed it on your own site with one line of
              code (coming with the board).
            </small>
          </div>
        </div>
        <div className="dash-setting">
          <label>Sourcing credits</label>
          <div>
            {credits ? (
              <>
                <span className="dash-src-balance">{credits.summary.available.toLocaleString()} available</span>
                <small>
                  1 credit = 1 candidate imported, reviewed, and ranked.
                  {credits.summary.held > 0 && ` ${credits.summary.held.toLocaleString()} reserved by runs in progress.`}
                  {" "}Contact us to top up.
                </small>
                {credits.history.length > 0 && (
                  <ul className="dash-src-history">
                    {credits.history.map((h, i) => (
                      <li key={i}>
                        <span>{new Date(h.at).toLocaleDateString([], { day: "numeric", month: "short" })}</span>
                        <span>{h.label}</span>
                        <b className={h.credits > 0 ? "pos" : "neg"}>
                          {h.credits > 0 ? "+" : ""}{h.credits.toLocaleString()}
                        </b>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <small>Loading…</small>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
