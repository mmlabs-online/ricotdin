import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Build output directory. The Dockerfile copies from dist/standalone and
  // dist/static, so Next must build into dist/ (not the default .next/).
  distDir: "dist",

  // Produces dist/standalone — a self-contained server.js + trimmed node_modules
  // required by the Dockerfile. Has no effect on `next dev` or local `next start`.
  output: "standalone",

  // The analysis pipeline reads its system prompt from disk at runtime
  // (ai-instruction/ai-gen/generate-meeting.md). Standalone output only bundles
  // traced JS, so this data file must be explicitly included or it is missing at
  // /app in the container (ENOENT). The glob is keyed by the routes/worker that
  // reach lib/gemini/analyze.ts.
  outputFileTracingIncludes: {
    "/**": ["./ai-instruction/ai-gen/**"],
  },
};

export default nextConfig;
