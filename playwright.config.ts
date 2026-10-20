import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);

// Saving the 09:00 suggested IN is refused while it is still ahead of the clock (by design),
// so the run is pinned to 12:00 India time on today's date: same calendar day, any hour.
// Computed once here; workers and the server inherit it through the environment.
if (process.env.E2E_CLOCK_OFFSET_MS === undefined) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  process.env.E2E_CLOCK_OFFSET_MS = String(Date.parse(`${today}T12:00:00+05:30`) - Date.now());
}

// Browser tests run against a production build in demo mode (fresh in-memory data per run).
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
  },
  projects: [
    { name: "mobile", use: { ...devices["Pixel 5"], viewport: { width: 360, height: 780 } }, testMatch: /operator\.spec\.ts/ },
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testMatch: /admin\.spec\.ts/ },
  ],
  webServer: {
    command: `npm run build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    timeout: 300_000,
    reuseExistingServer: !!process.env.E2E_REUSE,
    // With E2E_REUSE, start that server with the same NODE_OPTIONS and E2E_CLOCK_OFFSET_MS (or set the offset to 0).
    env: { APP_MODE: "demo", NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: "--require ./tests/e2e/fake-clock.cjs" },
  },
});
