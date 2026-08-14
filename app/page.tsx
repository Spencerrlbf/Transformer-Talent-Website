import Link from "next/link";
import RotatingRoles from "@/components/RotatingRoles";
import Testimonials from "@/components/Testimonials";
import { getRoles } from "@/lib/roles";

export default async function Home() {
  const roles = await getRoles();

  return (
    <main className="main">
      <h1 className="logo">Transformer Talent</h1>
      <p className="clever-tagline">Talent is all you need</p>

      <h2 className="headline">Building teams for the future</h2>
      <p className="subheadline">
        We recruit AI/ML and software engineers for the most exciting startups
        backed by top VCs in the USA
      </p>

      <p className="vc-line">
        Y Combinator · Sequoia · a16z · General Catalyst · 8VC
      </p>

      <div className="cta-group">
        <Link href="/roles" className="cta">
          View all roles →
        </Link>
        <Link href="/companies" className="cta cta-primary">
          Hire with us →
        </Link>
      </div>

      <div className="roles-section">
        <div className="section-label">Currently Hiring</div>
        <RotatingRoles roles={roles} />
      </div>

      <Testimonials />
    </main>
  );
}
