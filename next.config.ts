import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The home page reads data/first-answers.json at request time (once the
  // measurement exists). Trace it into the function bundle so revalidation
  // on Vercel sees the same file the build did.
  outputFileTracingIncludes: { "/": ["./data/first-answers.json"] },
};

export default nextConfig;
