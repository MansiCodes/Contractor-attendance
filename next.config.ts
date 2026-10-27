import type { NextConfig } from "next";

// Amplify Hosting sets AWS_APP_ID at build time. That path cannot use
// `output: "standalone"` (that layout is for the ECS image in Dockerfile).
const isAmplify = Boolean(process.env.AWS_APP_ID);

const nextConfig: NextConfig = {
  // A self-contained server (.next/standalone) for the container image (Dockerfile).
  ...(isAmplify ? {} : { output: "standalone" as const }),
  // Amplify console env vars are injected at build; SSR compute often does not
  // receive them at runtime. Bake APP_MODE so demo/production is defined.
  ...(isAmplify && process.env.APP_MODE ? { env: { APP_MODE: process.env.APP_MODE } } : {}),
  poweredByHeader: false,
  serverExternalPackages: ["exceljs"],
  experimental: {
    serverActions: { bodySizeLimit: "4mb" },
  },
  // Plants were called "projects" before; keep old links working.
  async redirects() {
    return [
      { source: "/admin/projects", destination: "/admin/plants", permanent: false },
      { source: "/admin/projects/:id", destination: "/admin/plants/:id", permanent: false },
    ];
  },
};

export default nextConfig;
