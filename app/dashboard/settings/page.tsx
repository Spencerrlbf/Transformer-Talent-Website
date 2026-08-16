"use client";
import { useDash } from "@/components/dashboard/DashShell";

export default function SettingsPage() {
  const { org, email } = useDash();
  const boardUrl = `https://www.transformertalent.com/board/${org.slug}`;
  return (
    <>
      <h1 className="dash-h1">Settings</h1>
      <p className="dash-sub">Your company profile and job board.</p>
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
      </div>
    </>
  );
}
