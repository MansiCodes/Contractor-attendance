import { test as base } from "@playwright/test";

export { expect, type Page } from "@playwright/test";

// The browser runs on the same shifted clock as the e2e server (playwright.config.ts).
const OFFSET = Number(process.env.E2E_CLOCK_OFFSET_MS || 0);

export const test = base.extend({
  page: async ({ page }, provide) => {
    if (OFFSET) await page.clock.setSystemTime(new Date(Date.now() + OFFSET));
    await provide(page);
  },
});
