import { expect, test, type Page } from "./fixtures";

// 14. Mobile attendance controls (360px wide phone) — the core operator workflow.

async function loginAs(page: Page, userId: string) {
  await page.goto("/login");
  await page.getByTestId(`demo-login-${userId}`).click();
  await page.waitForURL("**/attendance");
}

const row = (page: Page, i: number) => page.getByTestId("worker-row").nth(i);
const count = async (page: Page, key: string) => Number(await page.getByTestId(`count-${key}`).locator("div").first().innerText());

test.describe.configure({ mode: "serial" });

test("operator sees only their sites and only operator navigation", async ({ page }) => {
  await loginAs(page, "demo-op-pune-lucknow");
  await expect(page.getByTestId("demo-banner")).toBeVisible();
  await expect(page.getByTestId("register-date")).toContainText("Today");
  const options = await page.getByTestId("project-select").locator("option").allInnerTexts();
  expect(options).toHaveLength(2);
  expect(options.join(" ")).toMatch(/Pune/);
  expect(options.join(" ")).toMatch(/Lucknow/);
  expect(options.join(" ")).not.toMatch(/Jaipur|Guwahati|Bhubaneswar/);
  const nav = page.locator("nav").last();
  await expect(nav.getByRole("link", { name: "Attendance" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "History" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Contractors" })).toHaveCount(0);

  // Admin pages are not reachable.
  await page.goto("/admin");
  await page.waitForURL("**/attendance");
  const res = await page.request.get("/api/export?from=2026-10-01&to=2026-10-31");
  expect(res.status()).toBe(403);
});

test("everyone starts pending; confirm, edit IN, mark absent, record OUT and save", async ({ page }) => {
  await loginAs(page, "demo-op-pune-lucknow");
  await page.getByTestId("contractor-select").selectOption({ label: "Pragati Manpower (Demo) (7)" });
  await page.waitForURL(/contractor=c2/);
  await expect(page.getByTestId("worker-row")).toHaveCount(7);
  expect(await count(page, "pending")).toBe(7);
  expect(await count(page, "present")).toBe(0);
  await expect(row(page, 0).getByTestId("in-button")).toContainText("09:00 AM");

  // 1) Confirm present with the suggested time.
  await row(page, 0).getByTestId("present-button").click();
  await expect(row(page, 0)).toHaveAttribute("data-status", "present");

  // 2) Set an exact IN time on the second worker (15 minutes before now, so it is never in the future).
  await row(page, 1).getByTestId("in-button").click();
  await page.getByRole("button", { name: "Now" }).click();
  await page.getByRole("button", { name: "-15 min" }).click();
  const chosenIn = await page.getByTestId("time-sheet-value").innerText();
  await page.getByRole("button", { name: /^Set IN/ }).click();
  await expect(row(page, 1)).toHaveAttribute("data-status", "present");
  await expect(row(page, 1).getByTestId("in-button")).toContainText(chosenIn);

  // 3) Record OUT now for the second worker.
  await row(page, 1).getByTestId("out-button").click();
  await page.getByRole("button", { name: "Now" }).click();
  await page.getByRole("button", { name: /^Set OUT/ }).click();
  await expect(row(page, 1).getByTestId("out-button")).not.toContainText("Record OUT");

  // 4) OUT before IN is blocked in the picker.
  await row(page, 0).getByTestId("out-button").click();
  await page.getByLabel("Exact time").fill("08:00");
  await expect(page.getByRole("alert")).toContainText(/OUT must be after IN/);
  await expect(page.getByRole("button", { name: /^Set OUT/ })).toBeDisabled();
  await page.keyboard.press("Escape");

  // 5) Mark absent.
  await row(page, 2).getByTestId("absent-button").click();
  await expect(row(page, 2)).toHaveAttribute("data-status", "absent");
  await expect(row(page, 2).getByTestId("out-button")).toBeDisabled();

  expect(await count(page, "present")).toBe(2);
  expect(await count(page, "absent")).toBe(1);
  expect(await count(page, "pending")).toBe(4);
  await expect(page.getByTestId("unsaved-count")).toHaveText("3 unsaved changes");

  await page.getByTestId("save-button").click();
  await expect(page.getByText("3 changes saved")).toBeVisible();
  await expect(page.getByTestId("unsaved-count")).toHaveCount(0);

  await page.reload();
  await expect(row(page, 0)).toHaveAttribute("data-status", "present");
  await expect(row(page, 1).getByTestId("in-button")).toContainText(chosenIn);
  await expect(row(page, 2)).toHaveAttribute("data-status", "absent");
  expect(await count(page, "pending")).toBe(4);
});

test("bulk confirmation, unsaved changes survive a reload, then save", async ({ page }) => {
  await loginAs(page, "demo-op-pune-lucknow");
  await page.getByTestId("project-select").selectOption({ label: "Smart Street Lighting Works (Demo) — Lucknow, Uttar Pradesh" });
  await page.waitForURL(/project=p3/);
  const total = await count(page, "all");
  expect(await count(page, "pending")).toBe(total);

  await page.getByTestId("bulk-present").click();
  await page.getByTestId("bulk-present-confirm").click();
  expect(await count(page, "present")).toBe(total);
  await expect(page.getByTestId("unsaved-count")).toHaveText(`${total} unsaved changes`);

  // Accidental reload: drafts are kept on the device, not silently discarded.
  await page.reload();
  await expect(page.getByTestId("unsaved-count")).toHaveText(`${total} unsaved changes`);
  await expect(page.getByText("bulk confirmed")).toHaveCount(0); // drafts are marked unsaved, not saved-bulk

  await page.getByTestId("save-button").click();
  await expect(page.getByText(`${total} changes saved`)).toBeVisible();
  await expect(page.getByText("bulk confirmed").first()).toBeVisible();
});

test("history lists past days read-only for operators", async ({ page }) => {
  await loginAs(page, "demo-op-pune-lucknow");
  await page.getByRole("link", { name: "History" }).last().click();
  await page.waitForURL("**/history");
  // The last entry is the oldest day in the list (never today).
  await page.locator('a[href*="/history/day"]').last().click();
  await page.waitForURL(/history\/day/);
  await expect(page.getByText("Past dates can only be corrected by NF head office.")).toBeVisible();
  await expect(page.getByTestId("present-button").first()).toBeDisabled();
});

test("a site without a suggested time asks for the IN time, one by one or in bulk", async ({ page }) => {
  await loginAs(page, "demo-op-east");
  await page.getByTestId("project-select").selectOption({ label: "Water Treatment Plant Fire Systems (Demo) — Guwahati, Assam" });
  await page.waitForURL(/project=p4/);
  const total = await count(page, "all");
  expect(await count(page, "pending")).toBe(total);
  // No time is assumed: the IN slot asks to be set.
  await expect(row(page, 0).getByTestId("in-button")).toContainText("Set");
  await expect(page.getByTestId("bulk-present")).toContainText("Choose one IN time");

  // P opens the time picker instead of filling in a default.
  await row(page, 0).getByTestId("present-button").click();
  await expect(page.getByRole("dialog")).toContainText("Check-in time");
  await expect(row(page, 0)).toHaveAttribute("data-status", "pending");
  await page.getByRole("button", { name: "Now" }).click();
  await page.getByRole("button", { name: /^Set IN/ }).click();
  await expect(row(page, 0)).toHaveAttribute("data-status", "present");

  // Bulk present asks for one time for everyone still pending.
  await page.getByTestId("bulk-present").click();
  await expect(page.getByRole("dialog")).toContainText(`IN time for ${total - 1} pending workers`);
  await page.getByRole("button", { name: "Now" }).click();
  await page.getByRole("button", { name: /^Mark present/ }).click();
  expect(await count(page, "present")).toBe(total);

  await page.getByTestId("save-button").click();
  await expect(page.getByText(`${total} changes saved`)).toBeVisible();
});
