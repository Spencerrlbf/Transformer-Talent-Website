"use client";
import Link from "next/link";
import JobForm, { EMPTY_JOB } from "@/components/dashboard/JobForm";

export default function NewJobPage() {
  return (
    <>
      <div className="dash-crumb">
        <Link href="/dashboard">Jobs</Link> / New job
      </div>
      <h1 className="dash-h1">Create a job</h1>
      <p className="dash-sub">
        Publishing puts the role live on your board with AI screening armed.
      </p>
      <JobForm initial={EMPTY_JOB} />
    </>
  );
}
