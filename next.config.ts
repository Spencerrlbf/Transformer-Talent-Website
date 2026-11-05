import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The PDF text extractor ships its own pdf.js build; load it from
  // node_modules at runtime rather than bundling it.
  serverExternalPackages: ["unpdf"],
};

export default nextConfig;
