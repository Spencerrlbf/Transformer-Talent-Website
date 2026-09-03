"use client";
import { useEffect, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";
import StageEditor, { type StageDef } from "@/components/dashboard/jobs/StageEditor";
import CompanyPageEditor from "@/components/dashboard/CompanyPageEditor";
import ReminderDefault from "@/components/dashboard/settings/ReminderDefault";
import WeeklyTargets from "@/components/dashboard/settings/WeeklyTargets";
import AttentionRulesCard from "@/components/dashboard/settings/AttentionRulesCard";

type CreditData = {
  summary: { granted: number; spent: number; held: number; balance: number; available: number };
  history: { kind: "grant" | "spend"; credits: number; label: string; at: string }[];
};

export default function SettingsPage() {
  const { org, email, token } = useDash();
  const boardUrl = `https://www.transformertalent.com/board/${org.slug}`;
  const [credits, setCredits] = useState<CreditData | null>(null);
  const [stages, setStages] = useState<StageDef[] | null>(null);
  const [canEditStages, setCanEditStages] = useState(false);
  const [editingStages, setEditingStages] = useState(false);
  const [stagesSaving, setStagesSaving] = useState(false);
  const [stagesError, setStagesError] = useState("");
  const [referralAmount, setReferralAmount] = useState<number | null>(null);
  const [amountSaving, setAmountSaving] = useState(false);
  const [amountSaved, setAmountSaved] = useState(false);
  const [amountError, setAmountError] = useState("");

  useEffect(() => {
    fetch("/api/dashboard/credits", { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => (r.ok ? r.json() : null))
      .then(setCredits)
      .catch(() => {});
    fetch("/api/dashboard/org", { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.interviewStages) {
          setStages(d.interviewStages);
          setCanEditStages(!!d.canEdit);
        }
        if (d && typeof d.referralAmount === "number") setReferralAmount(d.referralAmount);
      })
      .catch(() => {});
  }, [token]);

  async function saveReferralAmount() {
    if (referralAmount === null) return;
    setAmountSaving(true);
    setAmountSaved(false);
    setAmountError("");
    try {
      const res = await fetch("/api/dashboard/org", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ referralAmount }),
      });
      if (res.ok) setAmountSaved(true);
      else setAmountError("Couldn't save — please try again.");
    } catch {
      setAmountError("Couldn't save — please try again.");
    }
    setAmountSaving(false);
  }

  async function saveStages(next: StageDef[]) {
    setStagesSaving(true);
    setStagesError("");
    try {
      const res = await fetch("/api/dashboard/org", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ interviewStages: next }),
      });
      if (res.ok) {
        setStages(next);
        setEditingStages(false);
      } else {
        setStagesError("Couldn't save — please try again.");
      }
    } catch {
      setStagesError("Couldn't save — please try again.");
    }
    setStagesSaving(false);
  }

  return (
    <>
      <h1 className="dash-h1">Settings</h1>
      <p className="dash-sub">Your company profile, job board, and sourcing credits.</p>
      <div className="dash-settings">
        <div className="dash-setting-duo">
          <div className="dash-setting">
            <label>Company</label>
            <div className="val">{org.name}</div>
          </div>
          <div className="dash-setting">
            <label>Signed in as</label>
            <div className="val">{email}</div>
          </div>
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
          <label>Interview stages</label>
          <div>
            {stages ? (
              <>
                <ol className="stg-list">
                  {stages.map((s) => (
                    <li key={s.id}>{s.label}</li>
                  ))}
                </ol>
                {canEditStages ? (
                  <button className="stg-editbtn" onClick={() => setEditingStages(true)}>
                    Edit stages
                  </button>
                ) : (
                  <small>Set by your company&apos;s owner account.</small>
                )}
                <small>
                  The default steps between Replied and Offer for new jobs.
                  Each job can override its own on the job page.
                </small>
              </>
            ) : (
              <small>Loading…</small>
            )}
          </div>
        </div>
        <div className="dash-setting">
          <label>Reply reminders</label>
          <div>
            <ReminderDefault />
            <small>
              Your default when you send an email that expects an answer: the
              person comes back to your Inbox on that day if they haven&apos;t
              replied. Change it on any email before you send; it&apos;s off by
              default on emails that don&apos;t need an answer.
            </small>
          </div>
        </div>
        <div className="dash-setting">
          <label>Weekly targets</label>
          <div>
            <WeeklyTargets />
          </div>
        </div>
        <div className="dash-setting">
          <label>Attention rules</label>
          <div>
            <AttentionRulesCard />
          </div>
        </div>
        <div className="dash-setting">
          <label>Referral bounty</label>
          <div>
            {referralAmount === null ? (
              <small>Loading…</small>
            ) : canEditStages ? (
              <>
                <div className="dash-refamount">
                  <div className="dash-mypage-amount">
                    <span>$</span>
                    <input
                      type="number"
                      min={0}
                      max={1000000}
                      step={500}
                      value={referralAmount}
                      onChange={(e) => {
                        setReferralAmount(Math.max(0, Math.round(Number(e.target.value) || 0)));
                        setAmountSaved(false);
                      }}
                    />
                  </div>
                  <button
                    className="dash-btn dash-btn-2"
                    disabled={amountSaving}
                    onClick={saveReferralAmount}
                  >
                    {amountSaving ? "Saving…" : "Save"}
                  </button>
                  {amountSaved && !amountError && <span className="dash-saved">Saved ✓</span>}
                </div>
                {amountError && <p className="dash-error">{amountError}</p>}
                <small>
                  Shown on your job board&apos;s &ldquo;Refer an engineer&rdquo; card and paid when
                  a referred placement completes. Set to 0 to make no dollar offer.
                </small>
              </>
            ) : (
              <>
                <div className="val">
                  {referralAmount > 0 ? `$${referralAmount.toLocaleString()}` : "No dollar offer"}
                </div>
                <small>
                  Shown on your job board&apos;s &ldquo;Refer an engineer&rdquo; card. Set by your
                  company&apos;s owner account.
                </small>
              </>
            )}
          </div>
        </div>
        <CompanyPageEditor />
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
      {editingStages && stages && (
        <StageEditor
          title={`Interview stages · ${org.name}`}
          intro="The default steps between Replied and Offer. New jobs inherit these; existing jobs with their own custom stages keep them."
          initial={stages}
          saving={stagesSaving}
          error={stagesError}
          onSave={saveStages}
          onClose={() => {
            setEditingStages(false);
            setStagesError("");
          }}
        />
      )}
    </>
  );
}
