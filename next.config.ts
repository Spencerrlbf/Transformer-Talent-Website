import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse loads its pdf.js build with a dynamic require; keep it out of
  // the server bundle so the file is found at runtime.
  serverExternalPackages: ["pdf-parse"],
};

export default nextConfig;
