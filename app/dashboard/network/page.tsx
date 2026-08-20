"use client";
// Internal-only Network page: the nightly pool matcher's output, person-first.
// The nav item renders only for Transformer Talent; the API 404s other orgs.
// ?job=<id> deep-links from a job page with the role filter preselected.
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useDash } from "@/components/dashboard/DashShell";
import NetworkTable from "@/components/dashboard/network/NetworkTable";
import CandidateDrawer from "@/components/dashboard/candidates/CandidateDrawer";

const TT_SLUG = "transformer-talent";

function NetworkPage() {
  const { org } = useDash();
  const search = useSearchParams();
  const [openKey, setOpenKey] = useState<string | null>(null);

  if (org.slug !== TT_SLUG) return <p className="dash-muted">Page not found.</p>;

  return (
    <>
      <h1 className="dash-h1">
        Network matches <span className="nw-internal">Internal — clients never see this</span>
      </h1>
      <p className="dash-sub">
        People from your talent pool matched to open roles by the nightly runs. Reach out via
        LinkedIn; when they&apos;re interested, send them to the job — they&apos;ll appear in its
        pipeline marked ⚡ Via Transformer Talent.
      </p>
      <NetworkTable jobId={search.get("job") || undefined} onOpen={setOpenKey} />
      <CandidateDrawer candKey={openKey} onClose={() => setOpenKey(null)} />
    </>
  );
}

export default function NetworkPageWrapper() {
  return (
    <Suspense fallback={<p className="dash-muted">Loading…</p>}>
      <NetworkPage />
    </Suspense>
  );
}
