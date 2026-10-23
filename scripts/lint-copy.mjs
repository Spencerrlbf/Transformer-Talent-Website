#!/usr/bin/env node
// Copy lint for the homepage. Runs before `next build` (see package.json and
// vercel.json). Plain Node, no dependencies.
//
// Scans lib/home/*.ts, app/(home)/*.tsx, components/home/*.tsx,
// app/layout.tsx, app/(site)/layout.tsx and app/opengraph-image.tsx, pulls
// every string literal out of them (single, double and template-literal text,
// with comments and import paths ignored) and fails on:
//   em-dash   U+2014 (or its entity forms) anywhere in a scanned file
//   cta-term  an inference term inside a value whose key is `label`
//   digit     a digit inside a copy string (lib/home/copy.ts, app/(home)/*.tsx,
//             components/home/*.tsx); numbers live in lib/home/placeholders.ts
//   tooling   a tooling or ranking word inside any scanned string
//   svg       an <svg> in a .tsx without a <title> child or a viewBox
//
// Exit 0 with a one-line summary when clean, exit 1 listing every violation.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `--root <dir>` scans a different tree with the same file list (used for fixtures).
const rootArg = process.argv.indexOf("--root");
const ROOT = rootArg > 0 && process.argv[rootArg + 1]
  ? path.resolve(process.argv[rootArg + 1])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCAN = [
  ["lib/home", /\.ts$/],
  ["app/(home)", /\.tsx$/],
  ["components/home", /\.tsx$/],
  ["app/layout.tsx"],
  ["app/(site)/layout.tsx"],
  ["app/opengraph-image.tsx"],
];

// Files where a digit inside a string is a violation. Numbers belong in
// lib/home/placeholders.ts; sample content belongs in lib/home/sample.ts.
const DIGIT_FILES = (rel) =>
  rel === "lib/home/copy.ts" || rel.startsWith("app/(home)/") || rel.startsWith("components/home/");

// CSS values (colours, lengths, transforms, timing) are not copy.
const CSS_NUM = `-?\\d*\\.?\\d+`;
const CSS_LEN = `${CSS_NUM}(?:px|em|rem|%|ms|s|deg|vw|vh|fr)`;
const CSS_VALUE_RE = new RegExp(
  [
    `#[0-9a-f]{3,8}`,
    `(?:rgba?|hsla?|var|url|calc|translate[xy]?|rotate|scale|cubic-bezier)\\(.*\\)`,
    CSS_LEN,
    `${CSS_NUM}(?:px|em|rem|%|ms|s|deg|vw|vh|fr)?(?:\\s*[\\s,/]\\s*${CSS_NUM}(?:px|em|rem|%|ms|s|deg|vw|vh|fr)?)+`,
  ].map((x) => `^(?:${x})$`).join("|"),
  "i",
);
// Substrings allowed to carry a digit in copy.
const DIGIT_ALLOW = ["8VC", "a16z", "p50", "p90"];

// Keys and JSX attributes whose values are never copy (class names, ids,
// font config, SVG geometry). A digit under one of these is not a violation.
const NON_COPY_KEYS = new Set([
  "className", "class", "id", "key", "htmlFor", "role", "type", "rel", "target", "lang", "dir",
  "aria-labelledby", "aria-describedby", "aria-controls", "aria-current", "aria-hidden",
  "variable", "subsets", "weight", "style", "display", "src", "sizes", "loading", "decoding",
  "viewBox", "d", "points", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry",
  "width", "height", "transform", "fill", "stroke", "strokeWidth", "strokeDasharray",
  "strokeDashoffset", "strokeLinecap", "strokeLinejoin", "pathLength", "opacity", "offset",
  "stopColor", "stopOpacity", "gradientUnits", "gradientTransform", "patternUnits",
  "markerWidth", "markerHeight", "refX", "refY", "orient", "dur", "begin", "values", "keyTimes",
  "fontSize", "fontFamily", "fontWeight", "letterSpacing", "lineHeight", "textAnchor",
  "dominantBaseline", "preserveAspectRatio", "xmlns", "version", "mask", "clipPath", "filter",
]);

const CTA_TERMS = [
  "prefill", "decode", "kv", "cache", "token", "top-k", "sampling", "temperature",
  "inference", "attention", "throughput", "latency", "stream", "layer",
];
const TOOLING_TERMS = [
  "pipeline", "tooling", "scoring", "scored", "score", "rank", "ranked", "ranking",
  "automated", "automation", "algorithm", "AI-powered", "judge", "screening",
  "machine learning model",
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
const wordRe = (terms, suffix) =>
  new RegExp(`(?<![a-z0-9])(?:${terms.map(esc).join("|")})${suffix}(?![a-z0-9])`, "gi");
const CTA_RE = wordRe(CTA_TERMS, "(?:s|d|ed|ing)?");
const TOOLING_RE = wordRe(TOOLING_TERMS, "s?");

// ---------------------------------------------------------------------------
// Tokenizer: finds string literals, blanks comments and string contents so the
// remaining code can be read for context (which key or attribute owns a string).

function tokenize(src) {
  const n = src.length;
  const code = src.split("");
  const tokens = [];
  const lineStarts = [0];
  for (let k = 0; k < n; k++) if (src[k] === "\n") lineStarts.push(k + 1);
  const lineAt = (idx) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  const blank = (a, b) => { for (let k = a; k < b && k < n; k++) if (code[k] !== "\n") code[k] = " "; };
  const prevSignificant = (idx) => {
    let k = idx - 1;
    while (k >= 0 && /\s/.test(src[k])) k--;
    return k >= 0 ? src[k] : "";
  };
  const prevWord = (idx) => {
    let k = idx - 1;
    while (k >= 0 && /\s/.test(src[k])) k--;
    let s = k;
    while (s >= 0 && /\w/.test(src[s])) s--;
    return src.slice(s + 1, k + 1);
  };

  // Scans from i. With untilBrace, returns the index of the `}` that closes
  // the template expression that started at depth 1.
  function scan(i, untilBrace) {
    let depth = untilBrace ? 1 : 0;
    while (i < n) {
      const c = src[i];
      const c2 = src[i + 1];
      if (c === "/" && c2 === "/") {
        let j = src.indexOf("\n", i); if (j < 0) j = n;
        blank(i, j); i = j; continue;
      }
      if (c === "/" && c2 === "*") {
        let j = src.indexOf("*/", i + 2); j = j < 0 ? n : j + 2;
        blank(i, j); i = j; continue;
      }
      if (c === "'" || c === '"') {
        let k = i + 1, ok = false;
        while (k < n) {
          if (src[k] === "\\") { k += 2; continue; }
          if (src[k] === c) { ok = true; break; }
          if (src[k] === "\n") break;
          k++;
        }
        if (ok) {
          tokens.push({ start: i, end: k + 1, line: lineAt(i), text: src.slice(i + 1, k), quote: c });
          blank(i + 1, k); i = k + 1; continue;
        }
        i++; continue; // an apostrophe in JSX text, not a string
      }
      if (c === "`") {
        let k = i + 1, partStart = k;
        const parts = [];
        while (k < n) {
          if (src[k] === "\\") { k += 2; continue; }
          if (src[k] === "`") break;
          if (src[k] === "$" && src[k + 1] === "{") {
            parts.push(src.slice(partStart, k));
            k = scan(k + 2, true) + 1;
            partStart = k; continue;
          }
          k++;
        }
        parts.push(src.slice(partStart, k));
        tokens.push({ start: i, end: k + 1, line: lineAt(i), text: parts.join(" "), quote: "`" });
        blank(i + 1, k); i = k + 1; continue;
      }
      if (c === "/" && c2 !== "/" && c2 !== "*") {
        // Regex literal when the previous significant token cannot end an operand.
        const p = prevSignificant(i);
        const w = prevWord(i);
        if (p === "" || "(,=:[!&|?{};".includes(p) || ["return", "typeof", "case", "in", "of"].includes(w)) {
          let k = i + 1, inClass = false, ok = false;
          while (k < n) {
            const ch = src[k];
            if (ch === "\\") { k += 2; continue; }
            if (ch === "\n") break;
            if (inClass) { if (ch === "]") inClass = false; k++; continue; }
            if (ch === "[") { inClass = true; k++; continue; }
            if (ch === "/") { ok = true; break; }
            k++;
          }
          if (ok) { blank(i + 1, k); i = k + 1; continue; }
        }
        i++; continue;
      }
      if (untilBrace) {
        if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) return i; }
      }
      i++;
    }
    return n;
  }
  scan(0, false);
  tokens.sort((a, b) => a.start - b.start);
  // codeOnly: comments and string contents blanked (for reading context).
  // noComments: comments blanked, strings kept (for the <svg> check).
  const codeOnly = code.join("");
  const kept = code.slice();
  for (const t of tokens) for (let k = t.start; k < t.end; k++) kept[k] = src[k];
  return { tokens, codeOnly, noComments: kept.join("") };
}

// What owns a string: an object key (`label: "..."`), a JSX attribute
// (`href="..."`), a call (`padStart(2, "0")`), an import path, or nothing.
function ownerOf(tok, codeOnly, endMap) {
  let j = tok.start - 1;
  const isWs = (ch) => ch === " " || ch === "\n" || ch === "\t" || ch === "\r";
  const identBefore = (k) => {
    while (k >= 0 && isWs(codeOnly[k])) k--;
    let s = k;
    while (s >= 0 && /[\w$-]/.test(codeOnly[s])) s--;
    return { id: codeOnly.slice(s + 1, k + 1), at: s };
  };
  for (;;) {
    while (j >= 0 && isWs(codeOnly[j])) j--;
    if (j < 0) return { kind: "none" };
    const ch = codeOnly[j];
    if (ch === "," || ch === "[") { j--; continue; }
    if (endMap.has(j)) { j = endMap.get(j) - 1; continue; }
    if (/[0-9.]/.test(ch)) {
      let k = j;
      while (k >= 0 && /[0-9.]/.test(codeOnly[k])) k--;
      if (k < 0 || !/[\w$]/.test(codeOnly[k])) { j = k; continue; }
    }
    break;
  }
  const ch = codeOnly[j];
  if (ch === ":") {
    const { id } = identBefore(j - 1);
    return id ? { kind: "key", name: id } : { kind: "none" };
  }
  if (ch === "=") {
    if (codeOnly[j - 1] === "=" || codeOnly[j - 1] === "!") return { kind: "none" };
    const { id } = identBefore(j - 1);
    return id ? { kind: "attr", name: id } : { kind: "none" };
  }
  if (ch === "(") {
    const { id } = identBefore(j - 1);
    if (id === "import" || id === "require") return { kind: "import" };
    return { kind: "call", name: id };
  }
  if (ch === "{") {
    let k = j - 1;
    while (k >= 0 && isWs(codeOnly[k])) k--;
    if (codeOnly[k] === "=") {
      const { id } = identBefore(k - 1);
      if (id) return { kind: "attr", name: id };
    }
    return { kind: "none" };
  }
  const { id } = identBefore(j);
  if (id === "from" || id === "import") return { kind: "import" };
  return { kind: "none" };
}

// ---------------------------------------------------------------------------

function listFiles() {
  const out = [];
  for (const [rel, re] of SCAN) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) {
      for (const f of fs.readdirSync(abs).sort()) if (re.test(f)) out.push(path.join(rel, f));
    } else out.push(rel);
  }
  return out;
}

const violations = [];
const report = (file, line, rule, msg) => violations.push({ file, line, rule, msg });
const show = (s) => JSON.stringify(s.length > 70 ? s.slice(0, 67) + "..." : s);

let stringCount = 0;
const files = listFiles();

for (const rel of files) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const lines = src.split("\n");

  // 1. Em-dash anywhere, including entity and escape forms.
  lines.forEach((ln, i) => {
    for (const m of ln.matchAll(/—|&mdash;|&#8212;|&#x2014;|\\u2014/gi)) {
      report(rel, i + 1, "em-dash", `em-dash at column ${m.index + 1}: ${show(ln.trim())}`);
    }
  });

  const { tokens, codeOnly, noComments } = tokenize(src);
  const endMap = new Map(tokens.map((t) => [t.end - 1, t.start]));

  for (const tok of tokens) {
    const owner = ownerOf(tok, codeOnly, endMap);
    if (owner.kind === "import") continue;
    stringCount++;
    const text = tok.text;
    if (!text.trim()) continue;

    // 2. Inference term inside a CTA or button label.
    if ((owner.kind === "key" || owner.kind === "attr") && owner.name === "label") {
      const hits = [...text.matchAll(CTA_RE)].map((m) => m[0]);
      if (hits.length) report(rel, tok.line, "cta-term", `label ${show(text)} contains ${hits.map((h) => `"${h}"`).join(", ")}`);
    }

    // 3. Digit inside a copy string.
    if (DIGIT_FILES(rel)) {
      const isUrl = /^(\/|https?:|http|mailto:|#)/.test(text);
      const nonCopyOwner = owner.name && NON_COPY_KEYS.has(owner.name);
      let stripped = text;
      for (const a of DIGIT_ALLOW) stripped = stripped.split(a).join("");
      const numericOnly = /^[\d\s.,:;/-]+$/.test(text) && (owner.kind === "call" || nonCopyOwner);
      const cssValue = CSS_VALUE_RE.test(text.trim());
      if (/\d/.test(stripped) && !isUrl && !nonCopyOwner && !numericOnly && !cssValue) {
        const where = owner.name ? ` (under ${owner.name})` : "";
        report(rel, tok.line, "digit", `digit in copy${where}: ${show(text)}; numbers live in lib/home/placeholders.ts`);
      }
    }

    // 4. Tooling or ranking words.
    const tool = [...text.matchAll(TOOLING_RE)].map((m) => m[0]);
    if (tool.length) report(rel, tok.line, "tooling", `${tool.map((h) => `"${h}"`).join(", ")} in ${show(text)}`);
  }

  // 5. <svg> without <title> or viewBox, in .tsx files.
  if (rel.endsWith(".tsx")) {
    for (const m of noComments.matchAll(/<svg\b/g)) {
      const open = noComments.indexOf(">", m.index);
      const openTag = noComments.slice(m.index, open < 0 ? undefined : open + 1);
      const selfClosing = /\/>$/.test(openTag);
      const close = noComments.indexOf("</svg>", open);
      const body = selfClosing || close < 0 ? "" : noComments.slice(open + 1, close);
      const line = noComments.slice(0, m.index).split("\n").length;
      const missing = [];
      if (!/\bviewBox\s*=/.test(openTag)) missing.push("viewBox attribute");
      if (!/<title[\s>]/.test(body)) missing.push("<title> child");
      if (missing.length) report(rel, line, "svg", `<svg> lacks ${missing.join(" and ")}`);
    }
  }
}

violations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));

if (violations.length === 0) {
  console.log(`lint-copy: clean. ${files.length} files, ${stringCount} strings, 0 violations.`);
  process.exit(0);
}
for (const v of violations) console.error(`${v.file}:${v.line}: [${v.rule}] ${v.msg}`);
console.error(`lint-copy: ${violations.length} violation${violations.length === 1 ? "" : "s"} in ${files.length} files.`);
process.exit(1);
