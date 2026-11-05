import { extractText } from "unpdf";

// Text of the uploaded PDF, extracted at submission so the board card can
// show it. Empty string when the PDF cannot be read; never throws.
export async function pdfText(buf: Buffer): Promise<string> {
  try {
    const { text } = await extractText(new Uint8Array(buf), { mergePages: true });
    return String(text || "")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
      .trim()
      .slice(0, 60000);
  } catch (err) {
    console.error("pdf extraction failed", err);
    return "";
  }
}
