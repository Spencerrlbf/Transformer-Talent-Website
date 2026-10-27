import Link from "next/link";
import { DEMO_OPEN_NOW } from "@/lib/home/copy";
import { getRoles, roleSlug, type Role } from "@/lib/roles";
import "./open-now.css";

// The stop token stage's second demo: three open roles from the board, the
// most recently posted first, each card a link to its role page. Server
// rendered from getRoles(); no JavaScript on the client.

const OPEN_NOW_COUNT = 3;

// Most recent by posted date (YYYY-MM-DD sorts as text; a missing date sorts
// last), ties broken by jobId descending. Pure so it can be tested on the
// snapshot alone.
export function pickOpenNow<T extends Pick<Role, "jobId" | "posted">>(roles: T[], count = OPEN_NOW_COUNT): T[] {
  const byId = (a: string, b: string) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return nb - na;
    return b.localeCompare(a);
  };
  return [...roles]
    .sort((a, b) => {
      if (a.posted && b.posted && a.posted !== b.posted) return a.posted < b.posted ? 1 : -1;
      if (a.posted && !b.posted) return -1;
      if (!a.posted && b.posted) return 1;
      return byId(a.jobId, b.jobId);
    })
    .slice(0, count);
}

export default async function OpenNow() {
  const roles = pickOpenNow(await getRoles());
  if (roles.length === 0) return null;
  return (
    <div className="il-open">
      <p className="il-open-label">{DEMO_OPEN_NOW.heading}</p>
      <ul className="il-open-grid" aria-label={DEMO_OPEN_NOW.cardAria}>
        {roles.map((role) => {
          const meta = [role.locations[0], role.salary].filter(Boolean).join(" · ");
          return (
            <li key={role.jobId}>
              <Link className="il-open-card" href={"/roles/" + roleSlug(role)}>
                <span className="il-open-title">{role.title}</span>
                {meta && <span className="il-open-meta">{meta}</span>}
                <span className="il-open-desc">{role.description}</span>
                <span className="il-open-view">{DEMO_OPEN_NOW.view}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
