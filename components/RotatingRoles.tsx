"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Role } from "@/lib/roles";

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export default function RotatingRoles({ roles }: { roles: Role[] }) {
  const sets = chunk(roles, 3);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (sets.length < 2) return;
    const id = setInterval(() => {
      setActive((a) => (a + 1) % sets.length);
    }, 5000);
    return () => clearInterval(id);
  }, [sets.length]);

  return (
    <div className="roles-container">
      {sets.map((set, i) => (
        <div key={i} className={`roles-set${i === active ? " active" : ""}`}>
          {set.map((role) => (
            <Link key={role.slug} href="/roles" className="role-card">
              <div className="role-title">{role.title}</div>
              <div className="role-meta">
                <span>{role.location}</span>
                <span className="role-salary">{role.salary}</span>
              </div>
            </Link>
          ))}
        </div>
      ))}
    </div>
  );
}
