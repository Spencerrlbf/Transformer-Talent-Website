// Small stroke icons for task/note kinds, shared by the Tasks page and the
// drawer timeline so a "call" looks identical everywhere.
const PATHS: Record<string, React.ReactNode> = {
  task: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M5.4 8l1.9 1.9 3.4-3.8" />
    </>
  ),
  call: (
    <path d="M3.2 2h2.4l1.2 3-1.6 1.3a9.5 9.5 0 0 0 4.5 4.5L11 9.2l3 1.2v2.4a1.2 1.2 0 0 1-1.3 1.2A12.7 12.7 0 0 1 2 3.3 1.2 1.2 0 0 1 3.2 2z" />
  ),
  email: (
    <>
      <rect x="1.8" y="3.2" width="12.4" height="9.6" rx="1.6" />
      <path d="M2.5 4.5 8 8.8l5.5-4.3" />
    </>
  ),
  message: (
    <path d="M2.5 3h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3.5 2.8V11h-1a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
  ),
  note: <path d="M10.6 2.6l2.8 2.8L5 13.8l-3.2.4.4-3.2z" />,
  // Inbox arrivals: an application (document), a resume drop, a referral.
  applied: (
    <>
      <path d="M4 1.5h5.5L13 5v9.5H4z" />
      <path d="M9.5 1.5V5H13M6 8.5h4M6 11h4" />
    </>
  ),
  drop: <path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M3 13h10" />,
  referred: (
    <>
      <circle cx="6" cy="5.5" r="2.5" />
      <path d="M1.5 13a4.5 4.5 0 0 1 9 0M11 4.5v4M9 6.5h4" />
    </>
  ),
  request: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.6V8l2.4 1.6" />
    </>
  ),
  // Reply reminder: a turn-back arrow.
  reminder: (
    <>
      <path d="M13.2 8A5.2 5.2 0 1 1 11.6 4.2" />
      <path d="M11.3 1.6l.7 2.9-2.9.6" />
    </>
  ),
};

export default function KindIcon({ kind, className }: { kind: string; className?: string }) {
  const path = PATHS[kind];
  if (!path) return null;
  return (
    <svg
      className={className || "tk-ico"}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}
