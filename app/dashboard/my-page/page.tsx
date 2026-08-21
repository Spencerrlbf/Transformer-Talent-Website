"use client";
// My page: the signed-in recruiter's public page settings — photo, bio, slug,
// LinkedIn, which roles to show, and the publish switch. The public page
// itself (/r/[slug]) ships in the next release (G2); until then the preview
// link is shown but labeled as going live soon.
import { useEffect, useRef, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";

type ProfileView = {
  slug: string;
  displayName: string;
  photoUrl: string | null;
  linkedinUrl: string;
  bio: string;
  showAllRoles: boolean;
  showReferral: boolean;
  published: boolean;
};

type PageData = {
  profile: ProfileView | null;
  suggestedSlug: string;
  org: { website: string; referralAmount: number; canEditWebsite: boolean };
};

const ERRORS: Record<string, string> = {
  bad_slug:
    "The link name can only use lowercase letters, numbers, and hyphens (3 to 40 characters).",
  bad_linkedin: "That doesn't look like a LinkedIn profile URL (linkedin.com/in/…).",
  slug_taken: "That link name is already taken — try another.",
  incomplete_for_publish:
    "To publish, fill in your name, bio, and LinkedIn URL first.",
  save_failed: "Couldn't save — please try again.",
};

export default function MyPagePage() {
  const { token, org, email } = useDash();
  const [data, setData] = useState<PageData | null>(null);

  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [bio, setBio] = useState("");
  const [showAllRoles, setShowAllRoles] = useState(true);
  const [showReferral, setShowReferral] = useState(true);
  const [published, setPublished] = useState(false);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [photoNote, setPhotoNote] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const [website, setWebsite] = useState("");
  const [websiteSaving, setWebsiteSaving] = useState(false);
  const [websiteSaved, setWebsiteSaved] = useState(false);
  const [referralAmount, setReferralAmount] = useState(5000);
  const [amountSaving, setAmountSaving] = useState(false);
  const [amountSaved, setAmountSaved] = useState(false);

  useEffect(() => {
    fetch("/api/dashboard/my-page", { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => (r.ok ? ((await r.json()) as PageData) : null))
      .then((d) => {
        if (!d) return;
        setData(d);
        const p = d.profile;
        setDisplayName(p?.displayName || "");
        setSlug(p?.slug || d.suggestedSlug);
        setLinkedinUrl(p?.linkedinUrl || "");
        setBio(p?.bio || "");
        setShowAllRoles(p ? p.showAllRoles : true);
        setShowReferral(p ? p.showReferral : true);
        setPublished(p?.published || false);
        setPhotoUrl(p?.photoUrl || null);
        setWebsite(d.org.website);
        setReferralAmount(d.org.referralAmount);
      })
      .catch(() => {});
  }, [token]);

  async function save(nextPublished?: boolean) {
    setError("");
    setSaving(true);
    const wantPublished = nextPublished === undefined ? published : nextPublished;
    try {
      const res = await fetch("/api/dashboard/my-page", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName,
          slug,
          linkedinUrl,
          bio,
          showAllRoles,
          showReferral,
          published: wantPublished,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.profile) {
        const p = json.profile as ProfileView;
        setPublished(p.published);
        setSlug(p.slug);
        setSavedAt(Date.now());
        // First save creates the profile row — photo upload needs it.
        setData((d) => (d ? { ...d, profile: p } : d));
      } else {
        setError(ERRORS[json.error as string] || ERRORS.save_failed);
      }
    } catch {
      setError(ERRORS.save_failed);
    }
    setSaving(false);
  }

  async function uploadPhoto(file: File) {
    setPhotoNote("");
    if (!data?.profile) {
      setPhotoNote("Save your page once first, then add the photo.");
      return;
    }
    setUploading(true);
    const form = new FormData();
    form.set("photo", file);
    try {
      const res = await fetch("/api/dashboard/my-page/photo", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.photoUrl) setPhotoUrl(json.photoUrl as string);
      else
        setPhotoNote(
          json.error === "too_large"
            ? "That image is over 4MB — use a smaller one."
            : json.error === "bad_type"
              ? "Use a JPG, PNG, or WebP image."
              : "Upload failed — please try again."
        );
    } catch {
      setPhotoNote("Upload failed — please try again.");
    }
    setUploading(false);
  }

  async function saveAmount() {
    setAmountSaving(true);
    setAmountSaved(false);
    try {
      const res = await fetch("/api/dashboard/org", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ referralAmount }),
      });
      if (res.ok) setAmountSaved(true);
    } catch {}
    setAmountSaving(false);
  }

  async function saveWebsite() {
    setWebsiteSaving(true);
    setWebsiteSaved(false);
    try {
      const res = await fetch("/api/dashboard/org", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ website }),
      });
      if (res.ok) setWebsiteSaved(true);
    } catch {}
    setWebsiteSaving(false);
  }

  const initials = (displayName || email)
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
  const pageUrl = `https://www.transformertalent.com/r/${slug || "…"}`;

  if (!data) {
    return (
      <>
        <h1 className="dash-h1">My page</h1>
        <p className="dash-sub">Loading…</p>
      </>
    );
  }

  return (
    <>
      <h1 className="dash-h1">My page</h1>
      <p className="dash-sub">
        Your public recruiter page: one link with your face, your bio, and the
        roles you&apos;re recruiting — made for sharing in LinkedIn outreach.
      </p>

      <div className="dash-jobform">
        <div className="dash-mypage-photo">
          {photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl} alt="Your photo" />
          ) : (
            <span className="dash-mypage-initials">{initials || "?"}</span>
          )}
          <div>
            <button
              type="button"
              className="dash-btn dash-btn-2"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? "Uploading…" : photoUrl ? "Change photo" : "Upload photo"}
            </button>
            <small>JPG, PNG, or WebP up to 4MB. No photo shows your initials.</small>
            {photoNote && <small className="dash-error">{photoNote}</small>}
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadPhoto(f);
                e.target.value = "";
              }}
            />
          </div>
        </div>

        <div className="dash-formgrid">
          <div className="dash-field">
            <label>Name</label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name as shown on the page"
              maxLength={120}
            />
          </div>
          <div className="dash-field">
            <label>LinkedIn URL</label>
            <input
              value={linkedinUrl}
              onChange={(e) => setLinkedinUrl(e.target.value)}
              placeholder="https://linkedin.com/in/…"
              maxLength={300}
            />
          </div>
        </div>

        <div className="dash-field" style={{ marginTop: 14 }}>
          <label>Your link</label>
          <div className="dash-mypage-slug">
            <span>transformertalent.com/r/</span>
            <input
              value={slug}
              onChange={(e) =>
                setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))
              }
              maxLength={40}
              placeholder="your-name"
            />
          </div>
        </div>

        <div className="dash-field" style={{ marginTop: 14 }}>
          <label>Bio</label>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            rows={3}
            maxLength={1200}
            placeholder="A couple of sentences about who you place and how you work."
          />
        </div>

        <div className="dash-formgrid" style={{ marginTop: 14 }}>
          <div className="dash-field">
            <label>Roles on your page</label>
            <select
              value={showAllRoles ? "all" : "mine"}
              onChange={(e) => setShowAllRoles(e.target.value === "all")}
            >
              <option value="all">All of {org.name}&apos;s open roles</option>
              <option value="mine">Only roles I created</option>
            </select>
          </div>
          <div className="dash-field">
            <label>Referral offer</label>
            <select
              value={showReferral ? "show" : "hide"}
              onChange={(e) => setShowReferral(e.target.value === "show")}
            >
              <option value="show">
                Show: refer an engineer for ${referralAmount.toLocaleString()}
              </option>
              <option value="hide">Hide the referral block</option>
            </select>
          </div>
        </div>

        <div className="dash-formfoot">
          <button className="dash-btn" onClick={() => save()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
          {published ? (
            <button
              className="dash-btn dash-btn-2"
              onClick={() => save(false)}
              disabled={saving}
            >
              Unpublish
            </button>
          ) : (
            <button
              className="dash-btn dash-btn-2"
              onClick={() => save(true)}
              disabled={saving}
            >
              Save &amp; publish
            </button>
          )}
          {savedAt > 0 && !error && <span className="dash-saved">Saved ✓</span>}
        </div>
        {error && <p className="dash-error">{error}</p>}

        <div className="dash-setting" style={{ marginTop: 22 }}>
          <label>Status</label>
          <div>
            {published ? (
              <>
                <span className="dash-mypage-live">● Published</span>
                <small>
                  Your page: <a href={pageUrl} target="_blank" rel="noreferrer">{pageUrl}</a>
                  {" "}— live now. Share it in your outreach; edits here appear
                  within a few minutes.
                </small>
              </>
            ) : (
              <small>
                Not published — your page isn&apos;t visible to anyone yet. Fill in
                your name, bio, and LinkedIn, then hit Save &amp; publish.
              </small>
            )}
          </div>
        </div>

        <div className="dash-setting">
          <label>Company website</label>
          <div>
            {data.org.canEditWebsite ? (
              <>
                <div className="dash-mypage-web">
                  <input
                    value={website}
                    onChange={(e) => {
                      setWebsite(e.target.value);
                      setWebsiteSaved(false);
                    }}
                    placeholder="https://yourcompany.com"
                    maxLength={300}
                  />
                  <button
                    className="dash-btn dash-btn-2"
                    onClick={saveWebsite}
                    disabled={websiteSaving}
                  >
                    {websiteSaving ? "Saving…" : websiteSaved ? "Saved ✓" : "Save"}
                  </button>
                </div>
                <small>
                  Shown next to your LinkedIn link on every recruiter page for {org.name}.
                </small>
              </>
            ) : (
              <>
                <div>{website || "Not set"}</div>
                <small>Set by your company&apos;s owner account.</small>
              </>
            )}
          </div>
        </div>

        <div className="dash-setting">
          <label>Referral amount</label>
          <div>
            {data.org.canEditWebsite ? (
              <>
                <div className="dash-mypage-web">
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
                    onClick={saveAmount}
                    disabled={amountSaving}
                  >
                    {amountSaving ? "Saving…" : amountSaved ? "Saved ✓" : "Save"}
                  </button>
                </div>
                <small>
                  Paid to anyone whose referral leads to a placement. Shown on
                  every {org.name} recruiter page with the referral block on.
                </small>
              </>
            ) : (
              <>
                <div>${referralAmount.toLocaleString()}</div>
                <small>Set by your company&apos;s owner account.</small>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
