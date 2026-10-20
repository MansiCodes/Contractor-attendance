import type { FullConfig } from "@playwright/test";

// Start every run from fresh demo data, even when reusing a running server.
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0].use.baseURL!;
  const res = await fetch(`${baseURL}/api/demo/reset`, { method: "POST" });
  if (!res.ok) throw new Error(`Demo reset failed (${res.status}). Is the server running in demo mode?`);
}
