import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
