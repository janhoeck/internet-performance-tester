import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Classic (non-cacheComponents) model on purpose: every API route serves live
  // measurement data and must never be prerendered at build time.
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
