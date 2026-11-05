// Text of the uploaded PDF, extracted locally at submission so the board card
// can show it. Empty string when the PDF cannot be read; never throws.
export async function pdfText(buf: Buffer, maxPages = 0): Promise<string> {
  try {
    const mod = await import("pdf-parse/lib/pdf-parse.js");
    const pdf = (mod.default || mod) as (b: Buffer, o?: { max?: number }) => Promise<{ text: string }>;
    const out = await pdf(buf, maxPages > 0 ? { max: maxPages } : undefined);
    return String(out.text || "")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
      .trim()
      .slice(0, 60000);
  } catch (err) {
    console.error("pdf extraction failed", err);
    return "";
  }
}
