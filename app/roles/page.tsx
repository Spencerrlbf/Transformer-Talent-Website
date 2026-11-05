import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Open Roles",
  description: "Transformer Talent is not taking new searches at the moment. Send a resume and we will keep it on file.",
};

export default function RolesPage() {
  return (
    <main className="page">
      <div className="wrap">
        <div className="b1" style={{ paddingTop: "1.6rem", maxWidth: 640 }}>
          <h1 className="apply-h">Open roles</h1>
          <p>
            We are not running new searches at the moment, so there are no roles listed. If you would like
            to be considered when that changes, send us your resume and we will keep it on file.
          </p>
          <div className="acts">
            <Link className="btn cold" href="/apply">
              Send a resume →
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
