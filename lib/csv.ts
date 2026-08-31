// Client-side CSV download. RFC 4180 quoting, CRLF rows, and a UTF-8 BOM so
// Excel opens names with accents correctly. Exports carry exactly what the
// viewing user can already see in the table/drawer — never more.
function esc(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function downloadCsv(
  filename: string,
  header: string[],
  rows: (string | number | null | undefined)[][]
): void {
  const body = [header, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
