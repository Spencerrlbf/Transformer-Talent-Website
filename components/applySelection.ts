"use client";

// Shared apply-selection state: which roles the visitor is applying to.
// localStorage-backed so it survives navigation between /roles, role pages,
// and /apply; capped at MAX_ROLES; same-tab updates broadcast via a custom
// event so the table, sticky bar, and cart stay in sync.

export const MAX_ROLES = 3;
const KEY = "tt-apply-roles";
const EVENT = "tt-apply-roles-changed";

export function getSelection(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string").slice(0, MAX_ROLES) : [];
  } catch {
    return [];
  }
}

export function setSelection(ids: string[]): string[] {
  const next = [...new Set(ids)].slice(0, MAX_ROLES);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {}
  return next;
}

// Add/remove one role; a 4th add is a no-op (the counter shows why).
export function toggleSelection(jobId: string): string[] {
  const cur = getSelection();
  if (cur.includes(jobId)) return setSelection(cur.filter((x) => x !== jobId));
  if (cur.length >= MAX_ROLES) return cur;
  return setSelection([...cur, jobId]);
}

export function clearSelection(): void {
  setSelection([]);
}

export function onSelectionChange(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb); // cross-tab
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}
