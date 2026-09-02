"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useDash } from "@/components/dashboard/DashShell";
import JobForm, { type JobFormValues } from "@/components/dashboard/JobForm";

export default function EditJobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { token } = useDash();
  const [initial, setInitial] = useState<JobFormValues | null | undefined>(undefined);

  useEffect(() => {
    fetch(`/api/dashboard/jobs/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.job) return setInitial(null);
        const j = d.job;
        // Stored display strings back into structured form fields.
        const yoe = String(j.yoe || "");
        const range = yoe.match(/^(\d+)\s*-\s*(\d+)/);
        const plus = yoe.match(/^(\d+)\+/);
        const upTo = yoe.match(/^Up to (\d+)/i);
        setInitial({
          title: j.title,
          roleType: j.roleType,
          salary: j.salary,
          yoeMin: range ? range[1] : plus ? plus[1] : "",
          yoeMax: range ? range[2] : upTo ? upTo[1] : "",
          visa: String(j.visa || "").split(";").map((x: string) => x.trim()).filter(Boolean),
          workplace: String(j.workplace || "").split("/").map((x: string) => x.trim()).filter(Boolean),
          locations: j.locations || [],
          about: j.jd?.about || "",
          doing: j.jd?.doing || [],
          needs: j.jd?.needs || [],
          bonus: j.jd?.bonus || [],
          skills: j.skills || [],
        });
      })
      .catch(() => setInitial(null));
  }, [id, token]);

  if (initial === undefined) return <p className="dash-muted">Loading…</p>;
  if (!initial)
    return (
      <>
        <p className="dash-muted">Job not found.</p>
        <Link href="/dashboard/jobs">← Back to jobs</Link>
      </>
    );

  return (
    <>
      <div className="dash-crumb">
        <Link href="/dashboard/jobs">Jobs</Link> /{" "}
        <Link href={`/dashboard/jobs/${id}`}>{initial.title}</Link> / Edit
      </div>
      <h1 className="dash-h1">Edit job</h1>
      <p className="dash-sub">
        Saving republishes the role and regenerates its screening.
      </p>
      <JobForm initial={initial} jobId={id} />
    </>
  );
}
