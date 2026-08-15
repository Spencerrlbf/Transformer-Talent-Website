// LlamaParse (LlamaIndex Cloud) document parsing — primary extractor for
// resume and JD PDFs; callers fall back to pdf-parse when this returns null.
// Bounded: one upload + short polling window, never blocks a request forever.

const BASE = "https://api.cloud.llamaindex.ai/api/v1/parsing";

export async function llamaParsePdf(
  buf: Buffer,
  filename: string,
  maxWaitMs = 25000
): Promise<string | null> {
  const key = process.env.LLAMA_CLOUD_API_KEY;
  if (!key) return null;
  try {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(buf)], { type: "application/pdf" }),
      filename || "document.pdf"
    );
    const up = await fetch(`${BASE}/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(15000),
    });
    if (!up.ok) {
      console.error("llamaparse upload failed", up.status, await up.text().catch(() => ""));
      return null;
    }
    const { id } = (await up.json()) as { id: string };

    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      const st = await fetch(`${BASE}/job/${id}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!st.ok) continue;
      const { status } = (await st.json()) as { status: string };
      if (status === "SUCCESS") {
        const md = await fetch(`${BASE}/job/${id}/result/markdown`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(10000),
        });
        if (!md.ok) return null;
        const { markdown } = (await md.json()) as { markdown: string };
        return (markdown || "")
          .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
          .trim()
          .slice(0, 60000) || null;
      }
      if (status === "ERROR" || status === "CANCELED") return null;
    }
    return null; // timed out — caller falls back
  } catch (err) {
    console.error("llamaparse failed", err);
    return null;
  }
}
